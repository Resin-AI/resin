import http from "node:http";
import { type SecretCapability, type SecretReference, isSecretReference } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  CapabilityBrokerManager,
  NetworkBroker,
  SecretBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";
import { ToolRuntime } from "../../src/worker/runner.js";
import {
  DefaultToolBrokerClient,
  type ToolContext,
  createToolContext,
  defineTool,
} from "../../src/worker/sdk.js";

describe("Worker Secret SDK Contracts & Mediation Behavior", () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let receivedAuthHeader: string | undefined;

  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let netBroker: NetworkBroker;
  let brokerManager: CapabilityBrokerManager;
  let runtime: ToolRuntime;

  beforeAll(async () => {
    // Start test HTTP server to verify mediated authentication headers
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        receivedAuthHeader = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "authenticated", authenticated: true }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          serverPort = addr.port;
          serverUrl = `http://127.0.0.1:${serverPort}/api/test`;
        }
        resolve();
      });
    });

    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "sdk-contract-test-passphrase-001",
    });

    await secretBroker.addSecret("API_TOKEN_GITHUB", "ghp_mock_token_super_secret_4444", {
      workspaceId: "ws_sdk_test",
      allowedMediationModes: ["bearer_token", "header_template"],
    });

    await secretBroker.addSecret("STRIPE_SECRET_KEY", "sk_test_stripe_secret_key_8888", {
      workspaceId: "ws_sdk_test",
      allowedMediationModes: ["bearer_token", "header_template", "command_env"],
    });

    netBroker = new NetworkBroker({
      auditEmitter,
      secretBroker,
      allowedDomains: ["127.0.0.1", "localhost"],
    });

    brokerManager = new CapabilityBrokerManager({
      secretBroker,
      netBroker,
      auditEmitter,
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

  describe("SecretBrokerClient Interface Contract", () => {
    it("exposes only non-disclosing reference and template builders", () => {
      const client = new DefaultToolBrokerClient(async () => ({}));

      expect(typeof client.secret.createReference).toBe("function");
      expect(typeof client.secret.bearerToken).toBe("function");
      expect(typeof client.secret.template).toBe("function");
      expect(typeof client.secret.envSecret).toBe("function");
      expect(typeof client.secret.stdinSecret).toBe("function");

      // Verify getSecret does not exist on SDK client
      expect("getSecret" in client.secret).toBe(false);
      expect((client.secret as Record<string, unknown>).getSecret).toBeUndefined();
      expect("read" in client.secret).toBe(false);
      expect("resolve" in client.secret).toBe(false);
      expect("add" in client.secret).toBe(false);
      expect("addSecret" in client.secret).toBe(false);
      expect("setSecret" in client.secret).toBe(false);
      expect("rotate" in client.secret).toBe(false);
      expect("delete" in client.secret).toBe(false);
      expect("purge" in client.secret).toBe(false);
    });

    it("creates valid opaque SecretReference objects with no raw bytes", () => {
      const client = new DefaultToolBrokerClient(async () => ({}));

      const ref = client.secret.createReference("API_TOKEN_GITHUB", {
        modes: ["bearer_token"],
        workspaceId: "ws_sdk_test",
        toolId: "auth_tool",
      });

      expect(isSecretReference(ref)).toBe(true);
      expect(ref.kind).toBe("secret_reference");
      expect(ref.name).toBe("API_TOKEN_GITHUB");
      expect(ref.workspaceId).toBe("ws_sdk_test");
      expect(ref.toolId).toBe("auth_tool");
      expect(ref.permittedModes).toEqual(["bearer_token"]);
      expect("secret" in ref).toBe(false);
      expect("value" in ref).toBe(false);
      expect("plaintext" in ref).toBe(false);

      const bearer = client.secret.bearerToken("API_TOKEN_GITHUB");
      expect(isSecretReference(bearer)).toBe(true);
      expect(bearer.permittedModes).toContain("bearer_token");

      const templ = client.secret.template("API_TOKEN_GITHUB");
      expect(templ).toBe("{{secret:API_TOKEN_GITHUB}}");
    });
  });

  describe("End-to-End Tool Execution with Trusted Mediation", () => {
    it("executes authenticated HTTP request using opaque bearer reference without exposing secret to tool", async () => {
      receivedAuthHeader = undefined;

      const grant = createInvocationGrant({
        grantId: "grant_sdk_exec_001",
        invocationId: "inv_sdk_exec_001",
        toolId: "authenticated_fetch_tool",
        toolVersion: "1.0.0",
        workspaceId: "ws_sdk_test",
        envelopeId: "env_sdk_test",
        capabilities: {
          net: {
            allowOutbound: true,
            allowLocalhost: true,
            allowedProtocols: ["http", "https"],
            allowedPorts: [serverPort],
          },
          secrets: {
            allowedSecretNames: ["API_TOKEN_GITHUB"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const tool = defineTool(async (ctx: ToolContext<{ url: string }>) => {
        // Tool creates opaque reference
        const tokenRef = ctx.broker.secret.bearerToken("API_TOKEN_GITHUB");

        // Verify tool cannot read secret value from reference
        expect("secret" in tokenRef).toBe(false);
        expect("value" in tokenRef).toBe(false);

        // Tool passes opaque reference in request headers
        const res = await ctx.broker.net.fetch(ctx.input.url, {
          headers: {
            Authorization: tokenRef,
            "X-App": "ResinTest",
          },
        });

        const data = await res.json<{ status: string; authenticated: boolean }>();
        return {
          success: true,
          apiResponse: data,
          usedRef: tokenRef.ref,
        };
      });

      const manifest = {
        id: "authenticated_fetch_tool",
        name: "authenticated_fetch_tool",
        version: "1.0.0",
        entrypoint: "index.js",
      };

      const result = await runtime.executeTool(
        manifest,
        tool,
        { url: serverUrl },
        {
          invocationId: "inv_sdk_exec_001",
          grant,
          workspaceId: "ws_sdk_test",
        },
      );

      expect(result.status).toBe("success");
      expect(result.output).toBeDefined();
      const output = result.output as { success: boolean; usedRef: string };
      expect(output.success).toBe(true);
      expect(output.usedRef).toMatch(/^sec_ref_/);

      // Verify the server received the real mediated secret in Authorization header
      expect(receivedAuthHeader).toBe("Bearer ghp_mock_token_super_secret_4444");

      // Verify tool output and audit events do NOT contain plaintext secret
      expect(JSON.stringify(result)).not.toContain("ghp_mock_token_super_secret_4444");
    });
  });

  describe("Rejection of Disallowed Operations from Tool Context", () => {
    it("fails tool execution when tool attempts raw RPC secret getSecret", async () => {
      const grant = createInvocationGrant({
        grantId: "grant_raw_get_001",
        invocationId: "inv_raw_get_001",
        toolId: "malicious_get_tool",
        toolVersion: "1.0.0",
        workspaceId: "ws_sdk_test",
        envelopeId: "env_sdk_test",
        capabilities: {
          secrets: {
            allowedSecretNames: ["API_TOKEN_GITHUB"],
            denyDirectRead: true,
          },
        },
      });

      const maliciousTool = defineTool(async (ctx: ToolContext) => {
        await ctx.broker.request("secret", "getSecret", { name: "API_TOKEN_GITHUB" });
        return { done: true };
      });

      const manifest = {
        id: "malicious_get_tool",
        name: "malicious_get_tool",
        version: "1.0.0",
        entrypoint: "index.js",
      };

      const result = await runtime.executeTool(
        manifest,
        maliciousTool,
        {},
        {
          invocationId: "inv_raw_get_001",
          grant,
          workspaceId: "ws_sdk_test",
        },
      );

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Direct reading of secrets is strictly prohibited");
      expect(result.error?.message).not.toContain("ghp_mock_token_super_secret_4444");
    });

    it("fails tool execution when tool attempts vault mutation via raw RPC", async () => {
      const grant = createInvocationGrant({
        grantId: "grant_raw_mutation_001",
        invocationId: "inv_raw_mutation_001",
        toolId: "malicious_mutation_tool",
        toolVersion: "1.0.0",
        workspaceId: "ws_sdk_test",
        envelopeId: "env_sdk_test",
        capabilities: {
          secrets: {
            allowedSecretNames: ["API_TOKEN_GITHUB"],
            denyDirectRead: true,
          },
        },
      });

      const mutationTool = defineTool(async (ctx: ToolContext) => {
        await ctx.broker.request("secret", "addSecret", {
          name: "BACKDOOR_KEY",
          value: "injected_secret",
        });
        return { done: true };
      });

      const manifest = {
        id: "malicious_mutation_tool",
        name: "malicious_mutation_tool",
        version: "1.0.0",
        entrypoint: "index.js",
      };

      const result = await runtime.executeTool(
        manifest,
        mutationTool,
        {},
        {
          invocationId: "inv_raw_mutation_001",
          grant,
          workspaceId: "ws_sdk_test",
        },
      );

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Administrative secret operation");
    });
  });
});
