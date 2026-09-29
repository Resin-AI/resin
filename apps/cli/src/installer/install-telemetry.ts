import path from "node:path";
import process from "node:process";
import {
  type EventProperties,
  type ReportingTransport,
  createUnrefTransport,
  isCancellableTransport,
  readCloudIdentity,
  readDeviceReportingConfig,
  readOrCreateAnonymousId,
  resolveErrorReportingConsent,
  resolveReportingHost,
  resolveReportingKey,
  sanitizeText,
  withProcessTestMarker,
} from "@resin/observer/error-reporting/core";

/**
 * Install events from the standalone install helper. The helper is a small bundle, so it posts
 * PostHog's capture endpoint directly with `fetch` instead of loading posthog-node. Every send is
 * best-effort: 3 s timeout, failures dropped, nothing written to stdout, never throws.
 */

const SEND_TIMEOUT_MS = 3_000;
const REASON_MAX_LENGTH = 200;

/** Set by install.sh / install.ps1, which then own `install_started` and `install_completed`. */
export const INSTALL_TELEMETRY_OWNER_ENV = "RESIN_INSTALL_TELEMETRY_OWNER";
/** The anonymous id the shell installer minted, adopted so later CLI events join it. */
export const INSTALL_ANALYTICS_ID_ENV = "RESIN_INSTALL_ANALYTICS_ID";

export type InstallEvent = "install_started" | "install_completed" | "install_failed";

export interface InstallTelemetryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly resinHome: string;
  readonly version?: string;
  /** A test install (`--allow-insecure-loopback`); silent unless `RESIN_ERROR_REPORTING=1`. */
  readonly testMode?: boolean;
  /** Defaults to an unref'd `node:https` transport, so a dead host cannot hold the process. */
  readonly transport?: ReportingTransport;
}

export interface InstallTelemetry {
  /** True when the shell wrapper reports start/completion itself. */
  readonly ownedByShell: boolean;
  send(event: InstallEvent, properties?: EventProperties): Promise<void>;
}

/** A short, sanitized failure reason for install events. */
export function installFailureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(`${name}: ${message}`, {}, REASON_MAX_LENGTH);
}

export function createInstallTelemetry(options: InstallTelemetryOptions): InstallTelemetry {
  const env = options.env ?? process.env;
  const ownedByShell = env[INSTALL_TELEMETRY_OWNER_ENV] === "bootstrap";
  // Test installs (install.sh / install.ps1 test mode, --allow-insecure-loopback) stay silent
  // unless RESIN_ERROR_REPORTING=1 forces reporting, matching the shell installers.
  const silencedForTest = Boolean(options.testMode) && env.RESIN_ERROR_REPORTING?.trim() !== "1";
  const transport = options.transport ?? createUnrefTransport(SEND_TIMEOUT_MS);
  const stateDir = path.join(options.resinHome, "state");
  const configFile = path.join(options.resinHome, "config", "config.json");

  const send = async (event: InstallEvent, properties: EventProperties = {}): Promise<void> => {
    try {
      if (silencedForTest) return;
      const apiKey = resolveReportingKey(env);
      if (!apiKey) return;
      const consent = resolveErrorReportingConsent({
        env: withProcessTestMarker(env),
        config: readDeviceReportingConfig(configFile),
      });
      if (!consent.enabled) return;
      const cloud = readCloudIdentity(stateDir);
      const distinctId =
        cloud?.userId ?? readOrCreateAnonymousId(stateDir, env[INSTALL_ANALYTICS_ID_ENV]);
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        if (value === undefined) continue;
        payload[key] =
          typeof value === "string" ? sanitizeText(value, {}, REASON_MAX_LENGTH) : value;
      }
      const body = JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: distinctId,
        timestamp: new Date().toISOString(),
        properties: {
          ...payload,
          resin_surface: "installer",
          resin_version: options.version ?? "unknown",
          environment: env.RESIN_ENVIRONMENT === "staging" ? "staging" : "production",
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          installer: "install-helper",
          $geoip_disable: true,
          $lib: "resin-install-helper",
        },
      });
      const request = transport(`${resolveReportingHost(env)}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }).then(
        () => undefined,
        () => undefined,
      );
      // The transport's sockets are unref'd, so while a request is pending nothing else may keep
      // the event loop alive: without this referenced timer the process can exit (code 0) in the
      // middle of `await send(...)`, before the caller writes its result. The timer bounds the wait
      // and keeps the process alive for exactly that long; `finally` then drops the request.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SEND_TIMEOUT_MS);
      });
      try {
        await Promise.race([request, deadline]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Install telemetry never affects the install.
    } finally {
      if (isCancellableTransport(transport)) transport.cancelPending();
    }
  };

  return { ownedByShell, send };
}
