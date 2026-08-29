import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createSecretReference } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  type BrokerAuditEvent,
  BrokerSecurityError,
  CapabilityBrokerManager,
  CommandBroker,
  NetworkBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { type CreateInvocationGrantParams, createInvocationGrant } from "../../src/policy/grant.js";

describe("Secret Canary Leak Detection & Full Output Redaction", () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;

  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let netBroker: NetworkBroker;
  let cmdBroker: CommandBroker;
  let brokerManager: CapabilityBrokerManager;

  // Unique high-entropy canary values
  const CANARIES = {
    HTTP_BEARER: "CANARY_BEARER_TOKEN_9a8b7c6d5e4f3a2b1c0d",
    QUERY_PARAM: "CANARY_QUERY_PARAM_11223344556677889900",
    STDIN_DATA: "CANARY_STDIN_SECRET_aabbccddeeff00112233",
    ENV_VAR: "CANARY_ENV_PASS_ffeeddccbbaa998877665544",
    ERROR_TRIGGER: "CANARY_ERROR_SECRET_deadbeefcafebabef00d",
  };

  const allCapturedArtifacts: string[] = [];

  function recordArtifact(data: string): void {
    allCapturedArtifacts.push(data);
  }

  beforeAll(async () => {
    // 1. Synthetic HTTP server
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/echo-auth")) {
        // Echo back authorization status without echoing token itself
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
        return;
      }

      if (req.url?.startsWith("/echo-query")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queryReceived: true }));
        return;
      }

      if (req.url?.startsWith("/error-endpoint")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server fault" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        serverPort = addr && "port" in addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // 2. Set up brokers with audit emitter
    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "canary-leak-detection-passphrase",
    });

    // Register each canary in the encrypted vault
    await secretBroker.addSecret("CANARY_HTTP_BEARER", CANARIES.HTTP_BEARER, {
      workspaceId: "ws_canary",
      allowedMediationModes: ["header_template", "bearer_token"],
    });

    await secretBroker.addSecret("CANARY_QUERY_PARAM", CANARIES.QUERY_PARAM, {
      workspaceId: "ws_canary",
      allowedMediationModes: ["query_template"],
    });

    await secretBroker.addSecret("CANARY_STDIN_DATA", CANARIES.STDIN_DATA, {
      workspaceId: "ws_canary",
      allowedMediationModes: ["command_stdin"],
    });

    await secretBroker.addSecret("CANARY_ENV_VAR", CANARIES.ENV_VAR, {
      workspaceId: "ws_canary",
      allowedMediationModes: ["command_env"],
    });

    await secretBroker.addSecret("CANARY_ERROR_TRIGGER", CANARIES.ERROR_TRIGGER, {
      workspaceId: "ws_canary",
      allowedMediationModes: ["header_template", "query_template", "command_env"],
    });

    netBroker = new NetworkBroker({
      auditEmitter,
      secretBroker,
    });

    cmdBroker = new CommandBroker({
      auditEmitter,
      secretBroker,
    });

    brokerManager = new CapabilityBrokerManager({
      auditEmitter,
      secretBroker,
      netBroker,
      cmdBroker,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const createCanaryGrant = (
    invocationId = "inv_canary_001",
    overrides: Partial<CreateInvocationGrantParams> = {},
  ) => {
    return createInvocationGrant({
      grantId: `grant_${invocationId}`,
      invocationId,
      toolId: "canary_scanner_tool",
      toolVersion: "1.0.0",
      workspaceId: "ws_canary",
      envelopeId: "env_canary",
      capabilities: {
        fs: {
          readPaths: ["**"],
          writePaths: ["**"],
          allowWorkspaceRoot: true,
          allowTemp: true,
        },
        net: {
          allowOutbound: true,
          allowedProtocols: ["http", "https"],
          allowLocalhost: true,
          allowedPorts: [serverPort],
        },
        command: {
          allowShellExecution: false,
          allowedBinaries: ["node"],
          allowEnvPassthrough: ["PATH"],
        },
        secrets: {
          allowedSecretNames: [
            "CANARY_HTTP_BEARER",
            "CANARY_QUERY_PARAM",
            "CANARY_STDIN_DATA",
            "CANARY_ENV_VAR",
            "CANARY_ERROR_TRIGGER",
          ],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
      },
      ...overrides,
    });
  };

  it("proves zero canary occurrence in network request responses and audit events", async () => {
    const grant = createCanaryGrant("inv_canary_net");
    const ctx = {
      invocationId: "inv_canary_net",
      grant,
      workspaceId: "ws_canary",
      secretBroker,
    };

    const bearerRef = secretBroker.createSecretReference("CANARY_HTTP_BEARER", ctx);

    // 1. Brokered request with Authorization header
    const authResponse = await netBroker.request(
      {
        url: `${serverUrl}/echo-auth`,
        headers: {
          Authorization: bearerRef,
        },
      },
      ctx,
    );
    recordArtifact(JSON.stringify(authResponse));

    // 2. Brokered request with URL query parameter template
    const queryResponse = await netBroker.request(
      {
        url: `${serverUrl}/echo-query?api_key={{secret:CANARY_QUERY_PARAM}}&format=json`,
      },
      ctx,
    );
    recordArtifact(JSON.stringify(queryResponse));

    // Verify response objects do NOT contain canaries
    const serializedAuth = JSON.stringify(authResponse);
    const serializedQuery = JSON.stringify(queryResponse);

    expect(serializedAuth).not.toContain(CANARIES.HTTP_BEARER);
    expect(serializedQuery).not.toContain(CANARIES.QUERY_PARAM);
  });

  it("proves zero canary occurrence in command execution stdout/stderr when child process attempts to leak secrets", async () => {
    const grant = createCanaryGrant("inv_canary_cmd");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-leak-cmd-"));
    const scriptPath = path.join(tempDir, "leak_attempt.js");

    // Hostile child process that maliciously tries to echo out everything from stdin and env
    fs.writeFileSync(
      scriptPath,
      "let stdinData = '';\nprocess.stdin.on('data', d => { stdinData += d; });\nprocess.stdin.on('end', () => {\n  console.log('STDOUT_LEAK_TRY_STDIN:' + stdinData);\n  console.error('STDERR_LEAK_TRY_ENV:' + process.env.LEAK_ENV);\n});\n",
    );

    const ctx = {
      invocationId: "inv_canary_cmd",
      grant,
      workspaceId: "ws_canary",
      workspaceRoot: tempDir,
      secretBroker,
    };

    const stdinRef = secretBroker.createSecretReference("CANARY_STDIN_DATA", ctx, {
      modes: ["command_stdin"],
    });
    const envRef = secretBroker.createSecretReference("CANARY_ENV_VAR", ctx, {
      modes: ["command_env"],
    });

    try {
      const result = await cmdBroker.execute(
        {
          executable: "node",
          args: [scriptPath],
          stdin: stdinRef,
          env: {
            LEAK_ENV: envRef,
          },
        },
        ctx,
      );

      recordArtifact(JSON.stringify(result));

      // The redactor automatically intercepts stdout and stderr, replacing registered secrets
      expect(result.stdout).not.toContain(CANARIES.STDIN_DATA);
      expect(result.stderr).not.toContain(CANARIES.ENV_VAR);
      expect(result.stdout).toContain("[REDACTED");
      expect(result.stderr).toContain("[REDACTED");
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("proves zero canary occurrence in broker error messages and diagnostic payloads", async () => {
    const grant = createCanaryGrant("inv_canary_err");
    const ctx = {
      invocationId: "inv_canary_err",
      grant,
      workspaceId: "ws_canary",
      secretBroker,
    };

    // Trigger failure by requesting invalid/disallowed domain with error canary
    try {
      await netBroker.request(
        {
          url: `https://disallowed-leak-host.com/endpoint?token={{secret:CANARY_ERROR_TRIGGER}}`,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof BrokerSecurityError) {
        recordArtifact(err.message);
        if (err.details) {
          recordArtifact(JSON.stringify(err.details));
        }
        expect(err.message).not.toContain(CANARIES.ERROR_TRIGGER);
      } else if (err instanceof Error) {
        recordArtifact(err.message);
        expect(err.message).not.toContain(CANARIES.ERROR_TRIGGER);
      }
      expect(JSON.stringify(err)).not.toContain(CANARIES.ERROR_TRIGGER);
    }

    // Trigger failure via direct read denial
    try {
      await secretBroker.getSecret("CANARY_ERROR_TRIGGER", {
        ...ctx,
        isWorker: true,
      });
    } catch (err) {
      if (err instanceof Error) {
        recordArtifact(err.message);
        expect(err.message).not.toContain(CANARIES.ERROR_TRIGGER);
      }
    }
  });

  it("proves zero canary occurrence across all emitted audit events", () => {
    const allEvents: BrokerAuditEvent[] = auditEmitter.getEvents();
    expect(allEvents.length).toBeGreaterThan(0);

    const serializedEvents = JSON.stringify(allEvents);
    recordArtifact(serializedEvents);

    for (const [name, canaryVal] of Object.entries(CANARIES)) {
      expect(
        serializedEvents.includes(canaryVal),
        `Audit trail must not contain canary ${name}`,
      ).toBe(false);
    }
  });

  it("comprehensive scan: asserts zero occurrence across all collected test artifacts", () => {
    expect(allCapturedArtifacts.length).toBeGreaterThan(5);

    for (const artifact of allCapturedArtifacts) {
      for (const [name, canaryVal] of Object.entries(CANARIES)) {
        expect(
          artifact.includes(canaryVal),
          `Captured artifact leaked canary ${name}: ${artifact.substring(0, 100)}...`,
        ).toBe(false);
      }
    }
  });
});
