import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { type NetCapability, type SecretReference, isSecretReference } from "@resin/contracts";
import {
  canonicalizeHost,
  isPrivateOrReservedIp,
  matchesHostPattern,
} from "../policy/canonicalizers.js";
import { withResolvers } from "../worker/protocol.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import type { SecretBroker } from "./secret-broker.js";

/**
 * Standard parameters for brokered network requests.
 */
export interface NetRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string | SecretReference>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxRedirects?: number;
  redirect?: "follow" | "error" | "manual";
  auth?: SecretReference | { bearer: SecretReference | string };
  secretReferences?: Record<string, SecretReference>;
}

/**
 * Result of a brokered network request.
 */
export interface NetResponseResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bytesReceived: number;
  redirected: boolean;
  finalUrl: string;
  durationMs: number;
}

/**
 * Options for configuring NetworkBroker.
 */
export interface NetworkBrokerOptions extends BaseCapabilityBrokerOptions {
  secretBroker?: SecretBroker;
}

/**
 * Helper to check if a hostname or IP is loopback/localhost.
 */
function isLoopbackHost(host: string): boolean {
  const norm = host.toLowerCase();
  return (
    norm === "localhost" ||
    norm === "127.0.0.1" ||
    norm === "::1" ||
    norm.startsWith("127.") ||
    norm === "0.0.0.0"
  );
}

/**
 * Capability broker for outbound network operations.
 * Enforces allowed protocols, ports, domain/host allowlists, private/loopback IP blocking,
 * DNS pre-resolution against rebinding, redirect containment, and response size limits.
 * Integrates with SecretBroker to mediate Authorization headers and URL templates host-side.
 */
export class NetworkBroker extends BaseCapabilityBroker {
  readonly serviceName = "net" as const;
  private secretBroker?: SecretBroker;

  constructor(options: NetworkBrokerOptions = {}) {
    super(options);
    this.secretBroker = options.secretBroker;
  }

  /**
   * Sets or updates the secret broker for credential mediation.
   */
  setSecretBroker(broker: SecretBroker): void {
    this.secretBroker = broker;
  }

  /**
   * Validates a target URL against the granted network capability and resolves DNS to detect private IP ranges.
   */
  private async validateAndAuthorizeUrl(targetUrl: string, netCap: NetCapability): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new BrokerSecurityError("INVALID_PATH", `Invalid URL format: ${targetUrl}`);
    }
    // 0. Outbound access check
    if (netCap.allowOutbound === false) {
      throw new BrokerSecurityError(
        "OUTBOUND_NETWORK_DISABLED",
        "Outbound network access is disabled by capability grant",
        { allowOutbound: false },
      );
    }

    // 1. Protocol check
    const protocol = parsed.protocol.replace(":", "").toLowerCase();
    const allowedProtocols = netCap.allowedProtocols ?? ["https"];
    if (!allowedProtocols.includes(protocol as "http" | "https" | "ws" | "wss")) {
      throw new BrokerSecurityError(
        "DISALLOWED_PROTOCOL",
        `Protocol '${protocol}' is not permitted by capability policy (allowed: ${allowedProtocols.join(", ")})`,
        { protocol, allowedProtocols },
      );
    }

    // 2. Port check
    const defaultPort = protocol === "https" || protocol === "wss" ? 443 : 80;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
    if (netCap.allowedPorts && netCap.allowedPorts.length > 0) {
      if (!netCap.allowedPorts.includes(port)) {
        throw new BrokerSecurityError(
          "DISALLOWED_PORT",
          `Port '${port}' is not permitted by capability policy (allowed: ${netCap.allowedPorts.join(", ")})`,
          { port, allowedPorts: netCap.allowedPorts },
        );
      }
    }

    // 3. Domain / Host allowlist
    const rawHostname = parsed.hostname;
    const normHostname = canonicalizeHost(rawHostname);

    const allowedDomains = netCap.allowedDomains ?? [];
    const allowedHosts = netCap.allowedHosts ?? [];

    if (allowedDomains.length > 0 || allowedHosts.length > 0) {
      let isAllowed = false;

      // Exact host match or wildcard pattern match
      for (const pattern of allowedHosts) {
        if (matchesHostPattern(normHostname, pattern)) {
          isAllowed = true;
          break;
        }
      }

      // Domain match (exact or suffix match on .domain.com)
      if (!isAllowed) {
        for (const dom of allowedDomains) {
          const normDom = canonicalizeHost(dom);
          if (normHostname === normDom || normHostname.endsWith(`.${normDom}`)) {
            isAllowed = true;
            break;
          }
        }
      }
      if (!isAllowed) {
        throw new BrokerSecurityError(
          "DISALLOWED_HOST",
          `Domain/Host '${rawHostname}' is not permitted by capability policy`,
          { host: rawHostname, allowedDomains, allowedHosts },
        );
      }
    }

    // 4. Localhost check
    if (!netCap.allowLocalhost) {
      if (isLoopbackHost(normHostname)) {
        throw new BrokerSecurityError(
          "BLOCKED_IP_RANGE",
          `Access to localhost is denied: ${rawHostname}`,
          { host: rawHostname },
        );
      }
    }

    // 5. Private / Reserved IP Range and DNS Rebinding Defense
    const denyPrivate = netCap.denyPrivateRanges ?? true;
    if (denyPrivate) {
      const isBlocked = (ip: string) => {
        if (netCap.allowLocalhost && isLoopbackHost(ip)) {
          return false;
        }
        return isPrivateOrReservedIp(ip);
      };

      // If hostname is directly an IP address
      if (isBlocked(normHostname)) {
        throw new BrokerSecurityError(
          "BLOCKED_IP_RANGE",
          `Access to private/reserved IP address '${normHostname}' is prohibited`,
          { host: rawHostname },
        );
      }

      // Resolve DNS pre-flight to prevent DNS rebinding attacks to private IPs
      try {
        const addresses = await dns.promises.lookup(rawHostname, { all: true });
        for (const addr of addresses) {
          if (isBlocked(addr.address)) {
            throw new BrokerSecurityError(
              "BLOCKED_IP_RANGE",
              `Host '${rawHostname}' resolved to blocked private/reserved IP: ${addr.address}`,
              { host: rawHostname, resolvedIp: addr.address },
            );
          }
        }
      } catch (dnsErr) {
        if (dnsErr instanceof BrokerSecurityError) throw dnsErr;
        // If hostname fails to resolve and is not an IP, reject as DNS failure
        throw new BrokerSecurityError(
          "DNS_RESOLUTION_FAILED",
          `Failed to resolve DNS for host '${rawHostname}': ${(dnsErr as Error).message}`,
          { host: rawHostname },
        );
      }
    }

    return parsed;
  }

  /**
   * Executes a brokered network request with redirect validation, size limits, and timeout enforcement.
   * Mediates secret references for Authorization headers and URL parameters host-side.
   */
  async request(params: NetRequestParams, context: BrokerContext): Promise<NetResponseResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const netCap = grant.capabilities.net ?? {};
    const limits = grant.capabilities.limits;

    const method = (params.method ?? "GET").toUpperCase();
    const redirectMode = params.redirect ?? "follow";
    const maxRedirects = params.maxRedirects ?? 5;
    const maxResponseBytes = limits?.maxOutputSizeBytes ?? 10485760; // 10MB default
    const timeoutMs = Math.min(
      params.timeoutMs ?? limits?.maxExecutionTimeMs ?? 30000,
      limits?.maxExecutionTimeMs ?? 30000,
    );

    const secretBroker = this.secretBroker ?? (context.secretBroker as SecretBroker | undefined);
    const redactor = secretBroker?.getRedactor();

    let currentUrl = params.url;

    // 1. Host-side URL mediation
    if (secretBroker) {
      try {
        currentUrl = await secretBroker.mediateUrl(currentUrl, context, params.secretReferences);
      } catch (err) {
        const errMsg = redactor ? redactor.redact((err as Error).message) : (err as Error).message;
        throw new BrokerSecurityError("MEDIATION_FAILED", `URL secret mediation failed: ${errMsg}`);
      }
    }

    // 2. Host-side header and auth mediation
    let outgoingHeaders: Record<string, string> = {};
    const rawHeaders: Record<string, string | SecretReference> = { ...(params.headers ?? {}) };

    if (params.auth) {
      if (isSecretReference(params.auth) || typeof params.auth === "string") {
        rawHeaders.Authorization = params.auth;
      } else if (typeof params.auth === "object" && "bearer" in params.auth) {
        rawHeaders.Authorization = params.auth.bearer;
      }
    }

    if (secretBroker) {
      try {
        outgoingHeaders = await secretBroker.mediateHeaders(rawHeaders, context);
      } catch (err) {
        const errMsg = redactor ? redactor.redact((err as Error).message) : (err as Error).message;
        throw new BrokerSecurityError(
          "MEDIATION_FAILED",
          `Header secret mediation failed: ${errMsg}`,
        );
      }
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === "string") {
          outgoingHeaders[k] = v;
        }
      }
    }

    let redirectCount = 0;
    let redirected = false;

    while (true) {
      try {
        const parsedUrl = await this.validateAndAuthorizeUrl(currentUrl, netCap);

        const response = await this.executeHttpRequest({
          url: parsedUrl,
          method,
          headers: outgoingHeaders,
          body: typeof params.body === "string" ? params.body : undefined,
          timeoutMs,
          maxResponseBytes,
        });

        // Handle Redirects
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
        const locationHeader = response.headers.location;

        if (isRedirect && locationHeader && redirectMode === "follow") {
          redirectCount++;
          redirected = true;

          if (redirectCount > maxRedirects) {
            throw new BrokerSecurityError(
              "TOO_MANY_REDIRECTS",
              `Maximum redirect limit of ${maxRedirects} exceeded`,
              { redirectCount, maxRedirects },
            );
          }

          // Resolve relative redirect URL
          const nextUrl = new URL(locationHeader, currentUrl).toString();

          // Re-validate target redirect destination
          await this.validateAndAuthorizeUrl(nextUrl, netCap);
          currentUrl = nextUrl;
          continue;
        }

        // Track Output Budget
        this.trackOutputBytes(context.invocationId, response.bytesReceived, limits);
        this.recordAudit(
          "request",
          context,
          "allowed",
          {
            url: redactor ? redactor.redact(currentUrl) : currentUrl,
            method,
            status: response.status,
            bytesReceived: response.bytesReceived,
            redirectCount,
          },
          { durationMs: Date.now() - startTime },
        );

        return {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: response.body,
          bytesReceived: response.bytesReceived,
          redirected,
          finalUrl: redactor ? redactor.redact(currentUrl) : currentUrl,
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        const isSecErr = err instanceof BrokerSecurityError;
        const errCode = isSecErr ? err.code : "NETWORK_ERROR";
        const rawErrMsg = (err as Error).message;
        const errMsg = redactor ? redactor.redact(rawErrMsg) : rawErrMsg;
        this.recordAudit(
          "request",
          context,
          "denied",
          {
            url: redactor ? redactor.redact(currentUrl) : currentUrl,
            method,
            reason: errMsg,
          },
          {
            error: { code: errCode, message: errMsg },
            durationMs: Date.now() - startTime,
          },
        );

        if (isSecErr) {
          throw new BrokerSecurityError(
            err.code,
            errMsg,
            redactor && err.details ? redactor.redactObject(err.details) : err.details,
          );
        }
        throw new BrokerSecurityError("NETWORK_ERROR", errMsg);
      }
    }
  }

  /**
   * Low-level HTTP/HTTPS execution helper with timeout and response size bounds.
   */
  private executeHttpRequest(options: {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytesReceived: number;
  }> {
    const { promise, resolve, reject } = withResolvers<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      bytesReceived: number;
    }>();

    const isHttps = options.url.protocol === "https:";
    const transport = isHttps ? https : http;

    const reqOptions: http.RequestOptions = {
      method: options.method,
      hostname: options.url.hostname,
      port: options.url.port || (isHttps ? 443 : 80),
      path: `${options.url.pathname}${options.url.search}`,
      headers: options.headers,
      timeout: options.timeoutMs,
    };

    let bytesReceived = 0;
    let responseBody = "";
    let timedOut = false;

    const req = transport.request(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      const statusText = res.statusMessage ?? "";
      const resHeaders: Record<string, string> = {};

      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) {
          resHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
        }
      }

      res.setEncoding("utf-8");

      res.on("data", (chunk: string) => {
        bytesReceived += Buffer.byteLength(chunk, "utf-8");
        if (bytesReceived > options.maxResponseBytes) {
          res.destroy();
          req.destroy();
          reject(
            new BrokerSecurityError(
              "RESPONSE_TOO_LARGE",
              `Response size exceeded maximum allowed limit of ${options.maxResponseBytes} bytes`,
              { bytesReceived, maxResponseBytes: options.maxResponseBytes },
            ),
          );
          return;
        }
        responseBody += chunk;
      });

      res.on("end", () => {
        if (!timedOut) {
          resolve({
            status,
            statusText,
            headers: resHeaders,
            body: responseBody,
            bytesReceived,
          });
        }
      });

      res.on("error", (err) => {
        reject(new BrokerSecurityError("NETWORK_ERROR", `HTTP stream error: ${err.message}`));
      });
    });

    req.on("socket", (socket) => {
      socket.on("error", () => {
        // Handled through req error or timeout
      });
    });

    req.on("timeout", () => {
      timedOut = true;
      req.destroy();
      reject(
        new BrokerSecurityError(
          "REQUEST_TIMEOUT",
          `Network request timed out after ${options.timeoutMs}ms`,
          { timeoutMs: options.timeoutMs },
        ),
      );
    });

    req.on("error", (err) => {
      if (!timedOut) {
        reject(new BrokerSecurityError("NETWORK_ERROR", `Network request failed: ${err.message}`));
      }
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();

    return promise;
  }

  /**
   * Fetch-compatible interface for convenience.
   */
  async fetch(
    url: string,
    init: Partial<NetRequestParams>,
    context: BrokerContext,
  ): Promise<NetResponseResult> {
    return this.request({ ...init, url }, context);
  }
}
