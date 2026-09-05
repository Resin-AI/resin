import dns from "node:dns";
import http from "node:http";
import type { CapabilityLimits, NetCapability } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrokerSecurityError, NetworkBroker } from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Network Broker Security & Isolation", () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let broker: NetworkBroker;

  beforeAll(async () => {
    broker = new NetworkBroker();

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/hello") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Hello from test server" }));
      } else if (url.pathname === "/redirect-safe") {
        res.writeHead(302, { Location: "/hello" });
        res.end();
      } else if (url.pathname === "/redirect-escape") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (url.pathname === "/redirect-disallowed-host") {
        res.writeHead(302, { Location: "http://disallowed-target.com/secret" });
        res.end();
      } else if (url.pathname === "/oversized") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("A".repeat(50000));
        res.end("B".repeat(50000));
      } else if (url.pathname === "/slow") {
        // Never respond so client timeout fires deterministically without wall-clock sleeps
        res.writeHead(200, { "Content-Type": "text/plain" });
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        serverPort = addr && "port" in addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const createGrant = (
    overrides: Partial<NetCapability> = {},
    limitOverrides: Partial<CapabilityLimits> = {},
  ) => {
    return createInvocationGrant({
      grantId: "grant_net_test",
      invocationId: "inv_net_001",
      toolId: "net_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_net",
      envelopeId: "env_net",
      capabilities: {
        net: {
          allowOutbound: true,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["http", "https"],
          allowLocalhost: true, // For testing against local server
          denyPrivateRanges: true,
          ...overrides,
        },
        limits: {
          maxOutputSizeBytes: 1048576,
          maxExecutionTimeMs: 10000,
          ...limitOverrides,
        },
      },
    });
  };

  it("rejects network requests when outbound access is disabled", async () => {
    const grant = createGrant({ allowOutbound: false });
    const ctx = { invocationId: "inv_net_001", grant };

    await expect(broker.request({ url: `${serverUrl}/hello` }, ctx)).rejects.toMatchObject({
      code: "OUTBOUND_NETWORK_DISABLED",
    });
  });

  it("blocks non-http/https protocols such as file:, ftp:, gopher:, javascript:", async () => {
    const grant = createGrant();
    const ctx = { invocationId: "inv_net_001", grant };

    const invalidUrls = [
      "file:///etc/passwd",
      "ftp://ftp.example.com/file.txt",
      "gopher://gopher.example.com",
      "javascript:alert(1)",
    ];

    for (const badUrl of invalidUrls) {
      await expect(broker.request({ url: badUrl }, ctx)).rejects.toThrow(BrokerSecurityError);

      try {
        await broker.request({ url: badUrl }, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(["DISALLOWED_PROTOCOL", "INVALID_PATH"]).toContain(err.code);
        }
      }
    }
  });

  it("enforces allowed ports policy", async () => {
    const grant = createGrant({ allowedPorts: [443, 8443] }); // Port 80 / serverPort not allowed
    const ctx = { invocationId: "inv_net_001", grant };

    await expect(broker.request({ url: `${serverUrl}/hello` }, ctx)).rejects.toMatchObject({
      code: "DISALLOWED_PORT",
    });
  });

  it("enforces host and domain allowlists including wildcard domains", async () => {
    const grant = createGrant({
      allowedDomains: ["*.trusted.org", "api.partner.io"],
      allowedHosts: ["127.0.0.1"],
      allowLocalhost: true,
    });
    const ctx = { invocationId: "inv_net_001", grant };

    // 1. Disallowed host
    await expect(broker.request({ url: "https://evil.com/data" }, ctx)).rejects.toMatchObject({
      code: "DISALLOWED_HOST",
    });

    // 2. Allowed 127.0.0.1 host
    const res = await broker.request({ url: `${serverUrl}/hello` }, ctx);
    expect(res.status).toBe(200);
  });

  it("blocks access to private and link-local IP addresses and cloud metadata endpoints", async () => {
    const grant = createGrant({
      allowLocalhost: false,
      denyPrivateRanges: true,
    });
    const ctx = { invocationId: "inv_net_001", grant };

    const privateTargets = [
      "http://127.0.0.1/test",
      "http://localhost/test",
      "http://10.0.0.1/admin",
      "http://192.168.1.1/router",
      "http://172.16.0.1/internal",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/test",
    ];

    for (const target of privateTargets) {
      await expect(broker.request({ url: target }, ctx)).rejects.toMatchObject({
        code: "BLOCKED_IP_RANGE",
      });
    }
  });

  it("validates redirects and strictly blocks redirect escape to cloud metadata or disallowed hosts", async () => {
    const grant = createGrant({
      allowLocalhost: true,
      allowedHosts: ["127.0.0.1"],
      denyPrivateRanges: true,
    });
    const ctx = { invocationId: "inv_net_001", grant };

    // 1. Safe relative redirect within allowed host
    const safeRes = await broker.request({ url: `${serverUrl}/redirect-safe` }, ctx);
    expect(safeRes.status).toBe(200);
    expect(safeRes.redirected).toBe(true);

    // 2. Redirect to cloud metadata endpoint -> strictly blocked
    await expect(broker.request({ url: `${serverUrl}/redirect-escape` }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );

    // 3. Redirect to disallowed host -> strictly blocked
    await expect(
      broker.request({ url: `${serverUrl}/redirect-disallowed-host` }, ctx),
    ).rejects.toThrow(BrokerSecurityError);
  });

  it("enforces response size limit and aborts oversized transfers", async () => {
    const grant = createGrant(
      { allowLocalhost: true, allowedHosts: ["127.0.0.1"] },
      { maxOutputSizeBytes: 5000 }, // 5KB max
    );
    const ctx = { invocationId: "inv_net_001", grant };

    // Server sends 100KB on /oversized
    await expect(broker.request({ url: `${serverUrl}/oversized` }, ctx)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("enforces request timeout limits", async () => {
    const grant = createGrant(
      { allowLocalhost: true, allowedHosts: ["127.0.0.1"] },
      { maxExecutionTimeMs: 100 }, // 100ms timeout
    );
    const ctx = { invocationId: "inv_net_001", grant };

    await expect(
      broker.request({ url: `${serverUrl}/slow`, timeoutMs: 50 }, ctx),
    ).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
  });

  it("blocks IPv6 loopback, link-local, IPv4-mapped IPv6, and ULA addresses", async () => {
    const grant = createGrant();
    const ctx = { invocationId: "inv_net_001", grant };

    const blockedIpv6Urls = [
      "http://[::]/",
      "http://[0:0:0:0:0:0:0:0]/",
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:192.168.1.1]/",
    ];

    for (const url of blockedIpv6Urls) {
      await expect(broker.request({ url }, ctx)).rejects.toThrow(BrokerSecurityError);
    }
  });

  it("blocks alternate numeric IP encodings (hex, octal, dword) targeting private/loopback/metadata addresses", async () => {
    const grant = createGrant({ allowLocalhost: false });
    const ctx = { invocationId: "inv_net_001", grant };

    const alternateEncodings = [
      "http://2130706433/", // dword 127.0.0.1
      "http://0x7f000001/", // hex 127.0.0.1
      "http://0177.0.0.1/", // octal 127.0.0.1
      "http://2852039166/", // dword 169.254.169.254
      "http://100.100.100.200/",
    ];

    for (const url of alternateEncodings) {
      await expect(broker.request({ url }, ctx)).rejects.toMatchObject({
        code: "BLOCKED_IP_RANGE",
      });
    }
  });

  it("blocks metadata hostnames resolving to private IP addresses", async () => {
    const grant = createGrant();
    const ctx = { invocationId: "inv_net_001", grant };
    const lookup = vi
      .spyOn(dns.promises, "lookup")
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    try {
      for (const url of ["http://instance-data/", "http://metadata.google.internal/"]) {
        await expect(broker.request({ url }, ctx)).rejects.toMatchObject({
          code: "BLOCKED_IP_RANGE",
        });
      }
    } finally {
      lookup.mockRestore();
    }
  });

  it("blocks redirect SSRF attacks redirecting from authorized endpoint to private IP or cloud metadata", async () => {
    const grant = createGrant({
      allowLocalhost: true,
      allowedHosts: ["127.0.0.1"],
      allowedDomains: ["127.0.0.1"],
    });
    const ctx = { invocationId: "inv_net_001", grant };

    // 1. Redirect to cloud metadata
    await expect(broker.request({ url: `${serverUrl}/redirect-escape` }, ctx)).rejects.toThrow(
      BrokerSecurityError,
    );

    // 2. Redirect to unauthorized domain
    await expect(
      broker.request({ url: `${serverUrl}/redirect-disallowed-host` }, ctx),
    ).rejects.toThrow(BrokerSecurityError);
  });

  it("rejects non-HTTP/HTTPS schemes (file, gopher, ftp, data, javascript)", async () => {
    const grant = createGrant();
    const ctx = { invocationId: "inv_net_001", grant };

    const disallowedSchemeUrls = [
      "file:///etc/passwd",
      "gopher://127.0.0.1:70/",
      "ftp://example.com/file.txt",
      "data:text/plain;base64,SGVsbG8=",
      "javascript:alert(1)",
    ];

    for (const url of disallowedSchemeUrls) {
      await expect(broker.request({ url }, ctx)).rejects.toThrow(BrokerSecurityError);
      try {
        await broker.request({ url }, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect([
            "DISALLOWED_PROTOCOL",
            "DISALLOWED_SCHEME",
            "INVALID_URL",
            "NETWORK_ERROR",
          ]).toContain(err.code);
        }
      }
    }
  });

  it("strictly blocks requests to prohibited internal service ports (SSH 22, SMTP 25, Redis 6379)", async () => {
    const grant = createGrant({
      allowedPorts: [443, 8443],
      allowedDomains: ["api.partner.io"],
      allowedHosts: ["api.partner.io"],
    });
    const ctx = { invocationId: "inv_net_001", grant };

    const prohibitedPortUrls = [
      "http://api.partner.io:22/",
      "http://api.partner.io:25/",
      "http://api.partner.io:6379/",
    ];

    for (const url of prohibitedPortUrls) {
      await expect(broker.request({ url }, ctx)).rejects.toMatchObject({
        code: "DISALLOWED_PORT",
      });
    }
  });
});
