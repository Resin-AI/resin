import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type SecretMediationMode,
  createSecretReference,
  formatSecretTemplate,
} from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  BrokerSecurityError,
  CapabilityBrokerManager,
  CommandBroker,
  NetworkBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { type CreateInvocationGrantParams, createInvocationGrant } from "../../src/policy/grant.js";

describe("Secret Reference Mediation and Trusted Broker Host Isolation", () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let lastReceivedHeaders: http.IncomingHttpHeaders = {};
  let lastReceivedUrl: string | undefined;

  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let netBroker: NetworkBroker;
  let cmdBroker: CommandBroker;
  let brokerManager: CapabilityBrokerManager;

  const baseGrantParams = {
    grantId: "grant_secret_ref_001",
    invocationId: "inv_sec_ref_001",
    toolId: "test_secret_consumer_tool",
    toolVersion: "1.0.0",
    workspaceId: "ws_secure_main",
    envelopeId: "env_secure_main",
  };

  beforeAll(async () => {
    // 1. Set up synthetic HTTP test server
    server = http.createServer((req, res) => {
      lastReceivedHeaders = req.headers;
      lastReceivedUrl = req.url;

      if (req.url?.startsWith("/auth-check")) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.includes("ghp_super_secret_token_12345")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ authenticated: true, user: "resin" }));
          return;
        }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (req.url?.startsWith("/query-check")) {
        const urlObj = new URL(req.url, "http://127.0.0.1");
        const apiKey = urlObj.searchParams.get("api_key");
        if (apiKey === "sk_live_synthetic_api_key_67890") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ verified: true }));
          return;
        }
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
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

    // 2. Initialize brokers and seed encrypted vault
    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "test-vault-passphrase-secure",
    });

    await secretBroker.addSecret("GITHUB_TOKEN", "ghp_super_secret_token_12345", {
      alias: "GH_TOKEN",
      workspaceId: "ws_secure_main",
      allowedMediationModes: ["header_template", "bearer_token"],
    });

    await secretBroker.addSecret("API_KEY", "sk_live_synthetic_api_key_67890", {
      alias: "QUERY_KEY",
      workspaceId: "ws_secure_main",
      allowedMediationModes: ["query_template", "header_template"],
    });

    await secretBroker.addSecret("DB_PASSWORD", "postgres_super_secret_pass_112233", {
      alias: "DB_PASS",
      workspaceId: "ws_secure_main",
      allowedMediationModes: ["command_stdin", "command_env"],
    });

    await secretBroker.addSecret("ISOLATED_OTHER_WS", "other_workspace_secret_val", {
      workspaceId: "ws_other_tenant",
      allowedMediationModes: ["header_template", "bearer_token"],
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
      allowUnverifiedBoundaries: true,
      development: true,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const createGrant = (
    secretNames = ["GITHUB_TOKEN", "API_KEY", "DB_PASSWORD"],
    overrides: Partial<CreateInvocationGrantParams> = {},
  ) => {
    return createInvocationGrant({
      ...baseGrantParams,
      ...overrides,
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
          allowedSecretNames: secretNames,
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
      },
    });
  };

  describe("Network Broker Secret Reference Mediation", () => {
    it("mediates Authorization header via SecretReference object", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const secretRef = secretBroker.createSecretReference("GITHUB_TOKEN", ctx, {
        modes: ["bearer_token", "header_template"],
      });

      const response = await netBroker.request(
        {
          url: `${serverUrl}/auth-check`,
          headers: {
            Authorization: secretRef,
          },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      const parsedBody = JSON.parse(response.body);
      expect(parsedBody.authenticated).toBe(true);

      // Verify the received header on test server had the plaintext
      expect(lastReceivedHeaders.authorization).toBe("Bearer ghp_super_secret_token_12345");
      // But the returned response object headers NEVER expose the secret
      expect(JSON.stringify(response)).not.toContain("ghp_super_secret_token_12345");
    });

    it("mediates Authorization header via auth: { bearer: secretRef } helper", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const secretRef = secretBroker.createSecretReference("GITHUB_TOKEN", ctx);

      const response = await netBroker.request(
        {
          url: `${serverUrl}/auth-check`,
          auth: { bearer: secretRef },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(lastReceivedHeaders.authorization).toBe("Bearer ghp_super_secret_token_12345");
    });

    it("mediates URL query parameter template host-side", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const response = await netBroker.request(
        {
          url: `${serverUrl}/query-check?api_key={{secret:API_KEY}}&format=json`,
        },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(lastReceivedUrl).toBe(
        "/query-check?api_key=sk_live_synthetic_api_key_67890&format=json",
      );
      expect(JSON.stringify(response)).not.toContain("sk_live_synthetic_api_key_67890");
    });

    it("mediates URL query parameters using explicit secretReferences mapping", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const apiKeyRef = secretBroker.createSecretReference("API_KEY", ctx, {
        modes: ["query_template"],
      });

      const response = await netBroker.request(
        {
          url: `${serverUrl}/query-check`,
          secretReferences: {
            api_key: apiKeyRef,
          },
        },
        ctx,
      );

      expect(response.status).toBe(200);
      expect(lastReceivedUrl).toContain("api_key=sk_live_synthetic_api_key_67890");
    });
  });

  describe("Command Broker Secret Reference Mediation", () => {
    it("mediates command stdin from SecretReference without leaking to output", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const dbPassRef = secretBroker.createSecretReference("DB_PASSWORD", ctx, {
        modes: ["command_stdin"],
      });
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cmd-test-"));
      const scriptPath = path.join(tempDir, "stdin_test.js");
      fs.writeFileSync(
        scriptPath,
        "const crypto = require('crypto');\nlet input = '';\nprocess.stdin.on('data', c => { input += c; });\nprocess.stdin.on('end', () => {\n  const hash = crypto.createHash('sha256').update(input.trim()).digest('hex');\n  console.log('HASH:' + hash);\n});\n",
      );

      try {
        const result = await cmdBroker.execute(
          {
            executable: "node",
            args: [scriptPath],
            stdin: dbPassRef,
          },
          { ...ctx, workspaceRoot: tempDir },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("HASH:");
        // Plaintext secret value is NOT in stdout
        expect(result.stdout).not.toContain("postgres_super_secret_pass_112233");
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it("mediates command environment variable slots host-side", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const passRef = secretBroker.createSecretReference("DB_PASSWORD", ctx, {
        modes: ["command_env"],
      });

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cmd-test-env-"));
      const scriptPath = path.join(tempDir, "env_test.js");
      fs.writeFileSync(
        scriptPath,
        "const pass = process.env.DATABASE_SECRET;\nif (pass && pass.length === 33) {\n  console.log('SECRET_ENV_MATCH_OK');\n} else {\n  console.error('SECRET_ENV_MISMATCH: len=' + (pass ? pass.length : 0));\n  process.exit(1);\n}\n",
      );

      try {
        const result = await cmdBroker.execute(
          {
            executable: "node",
            args: [scriptPath],
            env: {
              DATABASE_SECRET: passRef,
            },
          },
          { ...ctx, workspaceRoot: tempDir },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("SECRET_ENV_MATCH_OK");
        expect(result.stdout).not.toContain("postgres_super_secret_pass_112233");
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  describe("Scope Enforcement, Replay Prevention & Structured Errors", () => {
    it("fails with WORKSPACE_MISMATCH when secret reference is replayed in a different workspace", async () => {
      const grant = createGrant();
      const validCtx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      // Create reference strictly bound to ws_secure_main
      const secretRef = secretBroker.createSecretReference("GITHUB_TOKEN", validCtx);

      // Attempt to resolve in another workspace context
      const otherWsGrant = createGrant(["GITHUB_TOKEN"], {
        workspaceId: "ws_unauthorized_tenant",
      });
      const maliciousCtx = {
        invocationId: "inv_malicious_001",
        grant: otherWsGrant,
        workspaceId: "ws_unauthorized_tenant",
        secretBroker,
      };

      await expect(
        secretBroker.resolveSecretReference(secretRef, maliciousCtx, "bearer_token"),
      ).rejects.toMatchObject({
        code: "WORKSPACE_MISMATCH",
      });
    });

    it("fails with TOOL_MISMATCH when secret reference is replayed by another tool", async () => {
      const grant = createGrant(["GITHUB_TOKEN"], { toolId: "authorized_tool_alpha" });
      const validCtx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        toolId: "authorized_tool_alpha",
        secretBroker,
      };

      const secretRef = secretBroker.createSecretReference("GITHUB_TOKEN", validCtx, {
        toolId: "authorized_tool_alpha",
      });

      const otherToolGrant = createGrant(["GITHUB_TOKEN"], {
        toolId: "rogue_tool_beta",
      });
      const otherToolCtx = {
        invocationId: "inv_rogue_002",
        grant: otherToolGrant,
        workspaceId: "ws_secure_main",
        toolId: "rogue_tool_beta",
        secretBroker,
      };

      await expect(
        secretBroker.resolveSecretReference(secretRef, otherToolCtx, "bearer_token"),
      ).rejects.toMatchObject({
        code: "TOOL_MISMATCH",
      });
    });

    it("fails with GRANT_EXPIRED when secret reference lifetime has elapsed", async () => {
      const grant = createGrant();
      const expiredTimestamp = new Date(Date.now() - 30000).toISOString();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      const expiredRef = secretBroker.createSecretReference("GITHUB_TOKEN", ctx, {
        expiresAt: expiredTimestamp,
      });

      await expect(
        secretBroker.resolveSecretReference(expiredRef, ctx, "bearer_token"),
      ).rejects.toMatchObject({
        code: "GRANT_EXPIRED",
      });
    });

    it("fails with OPERATION_NOT_PERMITTED when reference is used with an unpermitted mediation mode", async () => {
      const grant = createGrant();
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      // Reference only permits header_template
      const restrictedRef = secretBroker.createSecretReference("GITHUB_TOKEN", ctx, {
        modes: ["header_template"],
      });

      // Attempt command_stdin mediation mode
      await expect(
        secretBroker.resolveSecretReference(restrictedRef, ctx, "command_stdin"),
      ).rejects.toMatchObject({
        code: "OPERATION_NOT_PERMITTED",
      });
    });

    it("fails with SECRET_NOT_AUTHORIZED when secret name is not granted in capability envelope", async () => {
      // Grant only authorizes GITHUB_TOKEN
      const grant = createGrant(["GITHUB_TOKEN"]);
      const ctx = {
        invocationId: "inv_sec_ref_001",
        grant,
        workspaceId: "ws_secure_main",
        secretBroker,
      };

      // Attempt to create reference for unauthorized secret DB_PASSWORD
      expect(() => secretBroker.createSecretReference("DB_PASSWORD", ctx)).toThrowError(
        expect.objectContaining({
          code: "SECRET_NOT_AUTHORIZED",
        }),
      );
    });

    it("fails with DIRECT_READ_DENIED when worker RPC calls legacy direct-read", async () => {
      const grant = createGrant(["GITHUB_TOKEN"], {
        // Even with direct read allowed on envelope, worker RPC must fail closed
        denyDirectRead: false,
      });

      const workerCtx = {
        invocationId: "inv_worker_001",
        grant,
        workspaceId: "ws_secure_main",
        isWorker: true,
        source: "worker",
      };

      await expect(
        brokerManager.handleRequest("secret", "getSecret", { name: "GITHUB_TOKEN" }, workerCtx),
      ).rejects.toMatchObject({
        code: "DIRECT_READ_DENIED",
      });
    });
  });
});
