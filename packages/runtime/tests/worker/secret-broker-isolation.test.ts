import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  BrokerAuditEmitter,
  BrokerSecurityError,
  CapabilityBrokerManager,
  CommandBroker,
  NetworkBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { type CreateInvocationGrantParams, createInvocationGrant } from "../../src/policy/grant.js";
import { ToolRuntime } from "../../src/worker/runner.js";
import { type ToolContext, bearerToken, defineTool } from "../../src/worker/sdk.js";

describe("Worker Secret Broker Isolation & Trusted Mediation Integration", () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let serverAuthHeader: string | undefined;

  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let netBroker: NetworkBroker;
  let cmdBroker: CommandBroker;
  let brokerManager: CapabilityBrokerManager;
  let runtime: ToolRuntime;

  const TEST_SECRET_VAL = "sk_live_synthetic_token_xyz987654321";
  const TEST_DB_SECRET = "db_pass_synthetic_val_123456789";

  beforeAll(async () => {
    // 1. HTTP Server for authenticated synthetic test
    server = http.createServer((req, res) => {
      serverAuthHeader = req.headers.authorization;

      if (req.url === "/api/protected-resource") {
        if (req.headers.authorization === `Bearer ${TEST_SECRET_VAL}`) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              data: ["item-1", "item-2", "item-3"],
              authenticatedAs: "worker-client",
            }),
          );
          return;
        }

        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid credentials" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        serverPort = addr && "port" in addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // 2. Secret Vault & Capability Brokers
    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "worker-isolation-vault-key",
    });

    await secretBroker.addSecret("API_AUTH_TOKEN", TEST_SECRET_VAL, {
      workspaceId: "ws_worker_test",
      allowedMediationModes: ["header_template", "bearer_token"],
    });

    await secretBroker.addSecret("DB_SECRET", TEST_DB_SECRET, {
      workspaceId: "ws_worker_test",
      allowedMediationModes: ["command_env", "command_stdin"],
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

    runtime = new ToolRuntime(
      { allowUnverifiedBoundaries: true, development: true, allowUnsafeVmFallback: true },
      brokerManager,
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const createGrant = (overrides: Partial<CreateInvocationGrantParams> = {}) => {
    return createInvocationGrant({
      grantId: "grant_worker_iso_001",
      invocationId: "inv_worker_iso_001",
      toolId: "authenticated_data_fetcher",
      toolVersion: "1.0.0",
      workspaceId: "ws_worker_test",
      envelopeId: "env_worker_test",
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
          allowedSecretNames: ["API_AUTH_TOKEN", "DB_SECRET"],
          allowedPrefixes: [],
          denyDirectRead: false, // Even when envelope has false, worker context must be denied
          injectAsEnv: true,
        },
      },
      ...overrides,
    });
  };

  it("strictly denies generated code calling legacy direct-read operations", async () => {
    const grant = createGrant({ toolId: "malicious_tool" });

    const maliciousTool = defineTool(async (ctx: ToolContext) => {
      // 1. Direct read attempt via SDK secret client is absent, raw RPC is denied
      expect("getSecret" in ctx.broker.secret).toBe(false);
      await ctx.broker.request("secret", "getSecret", { name: "API_AUTH_TOKEN" });
      return { success: true };
    });

    const manifest = {
      id: "malicious_tool",
      name: "malicious_tool",
      version: "1.0.0",
      entrypoint: "index.js",
    };

    const result = await runtime.executeTool(
      manifest,
      maliciousTool,
      {},
      {
        invocationId: "inv_worker_iso_001",
        grant,
        workspaceId: "ws_worker_test",
      },
    );
    expect(result.error?.message).toContain("Direct reading of secrets is strictly prohibited");
  });

  it("strictly denies generated code calling direct-read via raw broker RPC request", async () => {
    const grant = createGrant({ toolId: "malicious_rpc_tool" });

    const maliciousRpcTool = defineTool(async (ctx: ToolContext) => {
      // Direct raw RPC attempt
      await ctx.broker.request("secret", "getSecret", { name: "API_AUTH_TOKEN" });
      return { success: true };
    });

    const manifest = {
      id: "malicious_rpc_tool",
      name: "malicious_rpc_tool",
      version: "1.0.0",
      entrypoint: "index.js",
    };

    const result = await runtime.executeTool(
      manifest,
      maliciousRpcTool,
      {},
      {
        invocationId: "inv_worker_iso_001",
        grant,
        workspaceId: "ws_worker_test",
      },
    );
    expect(result.error?.message).toContain("Direct reading of secrets is strictly prohibited");
  });
  it("executes authenticated network fetch with opaque SecretReference without disclosing secret to worker", async () => {
    const grant = createGrant({ toolId: "authenticated_data_fetcher" });

    const fetcherTool = defineTool(async (ctx: ToolContext) => {
      // Create opaque secret reference
      const tokenRef = ctx.broker.secret.createReference("API_AUTH_TOKEN");

      // Verify the reference object is opaque and has no secret value
      const hasSecretProperty = "secret" in tokenRef || "value" in tokenRef;
      if (hasSecretProperty) {
        throw new Error("Secret reference object contained a raw value property");
      }

      // Execute brokered fetch using the opaque reference
      const response = await ctx.broker.net.fetch(`${serverUrl}/api/protected-resource`, {
        headers: {
          Authorization: tokenRef,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP fetch failed with status ${response.status}`);
      }

      const body = await response.json<{ data: string[]; authenticatedAs: string }>();

      // Record logs and progress
      await ctx.log("info", "Fetched protected items successfully");
      await ctx.progress(100, "Fetch complete");

      return {
        itemsCount: body.data.length,
        authenticatedAs: body.authenticatedAs,
        tokenRefHandle: tokenRef.ref,
      };
    });

    const manifest = {
      id: "authenticated_data_fetcher",
      name: "authenticated_data_fetcher",
      version: "1.0.0",
      entrypoint: "index.js",
    };
    const result = await runtime.executeTool(
      manifest,
      fetcherTool,
      {},
      {
        invocationId: "inv_worker_iso_001",
        grant,
        workspaceId: "ws_worker_test",
      },
    );

    expect(result.status).toBe("success");
    expect(result.output).toEqual(
      expect.objectContaining({
        itemsCount: 3,
        authenticatedAs: "worker-client",
        tokenRefHandle: expect.stringMatching(/^sec_ref_/),
      }),
    );

    // Verify synthetic server received the real Bearer token
    expect(serverAuthHeader).toBe(`Bearer ${TEST_SECRET_VAL}`);

    // Verify result, progress messages, and execution traces contain ZERO raw secret bytes
    const serializedExecution = JSON.stringify(result);
    expect(serializedExecution).not.toContain(TEST_SECRET_VAL);
  });

  it("executes command with mediated secret environment without disclosing secret to worker", async () => {
    const tempWs = fs.mkdtempSync(path.join(os.tmpdir(), "worker_iso_ws_"));
    const scriptPath = path.join(tempWs, "inspect_env.js");
    fs.writeFileSync(
      scriptPath,
      "console.log('ENV_LEN:' + (process.env.DB_PASS ? process.env.DB_PASS.length : 0));",
    );

    const grant = createGrant({ toolId: "authenticated_cmd_runner" });
    const cmdTool = defineTool(async (ctx: ToolContext) => {
      const dbRef = ctx.broker.secret.createReference("DB_SECRET", {
        modes: ["command_env"],
      });

      // Execute command that inspects environment length
      const cmdResult = await ctx.broker.cmd.exec("node", [scriptPath], {
        env: {
          DB_PASS: dbRef,
        },
      });

      return {
        exitCode: cmdResult.exitCode,
        stdout: cmdResult.stdout.trim(),
      };
    });
    const manifest = {
      id: "authenticated_cmd_runner",
      name: "authenticated_cmd_runner",
      version: "1.0.0",
      entrypoint: "index.js",
    };
    const result = await runtime.executeTool(
      manifest,
      cmdTool,
      {},
      {
        invocationId: "inv_worker_iso_001",
        grant,
        workspaceId: "ws_worker_test",
        workspaceRoot: tempWs,
      },
    );

    if (result.status === "error") {
      console.error("DEBUG result error:", result.error);
    }

    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      exitCode: 0,
      stdout: `ENV_LEN:${TEST_DB_SECRET.length}`,
    });
    expect(JSON.stringify(result)).not.toContain(TEST_DB_SECRET);
  });

  it("prevents cross-workspace replay of secret references", async () => {
    // 1. Create reference in workspace ws_worker_test
    const grantAlpha = createGrant();
    const tokenRef = secretBroker.createSecretReference("API_AUTH_TOKEN", {
      invocationId: "inv_worker_iso_001",
      grant: grantAlpha,
      workspaceId: "ws_worker_test",
    });

    // 2. Tool in workspace ws_worker_other attempts to use the reference
    const grantBeta = createGrant({
      workspaceId: "ws_worker_other",
      grantId: "grant_worker_iso_002",
      invocationId: "inv_worker_iso_002",
      toolId: "replay_tool",
    });

    const replayTool = defineTool(async (ctx: ToolContext) => {
      // Attempt to use tokenRef from ws_worker_test in ws_worker_other
      await ctx.broker.net.fetch(`${serverUrl}/api/protected-resource`, {
        headers: {
          Authorization: tokenRef,
        },
      });
      return { success: true };
    });

    const manifest = {
      id: "replay_tool",
      name: "replay_tool",
      version: "1.0.0",
      entrypoint: "index.js",
    };
    const result = await runtime.executeTool(
      manifest,
      replayTool,
      {},
      {
        invocationId: "inv_worker_iso_002",
        grant: grantBeta,
        workspaceId: "ws_worker_other",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("WORKSPACE_MISMATCH");
  });
});
