import { beforeEach, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  BrokerSecurityError,
  CapabilityBrokerManager,
  SecretBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Secret Mediation Broker Security & Isolation", () => {
  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let brokerManager: CapabilityBrokerManager;

  const baseGrantParams = {
    grantId: "grant_secret_001",
    invocationId: "inv_secret_001",
    toolId: "secret_consumer_tool",
    toolVersion: "1.0.0",
    workspaceId: "ws_main",
    envelopeId: "env_secret",
  };

  beforeEach(async () => {
    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "test-vault-passphrase",
    });

    // Populate test secrets
    await secretBroker.addSecret("GITHUB_TOKEN", "ghp_123456789012345678901234567890123456", {
      alias: "GH_AUTH",
      workspaceId: "ws_main",
      allowedMediationModes: ["header_template", "bearer_token"],
      tags: ["git", "ci"],
    });

    await secretBroker.addSecret("API_KEY", "sk-proj-super-secret-key-12345", {
      alias: "OPENAI_KEY",
      workspaceId: "ws_main",
      allowedMediationModes: ["header_template", "query_template", "command_env"],
      tags: ["ai"],
    });

    await secretBroker.addSecret("DB_PASS", "database_password_9999", {
      workspaceId: "ws_main",
      allowedMediationModes: ["command_stdin", "command_env"],
      tags: ["database"],
    });

    await secretBroker.addSecret("ISOLATED_SECRET", "isolated_workspace_val", {
      workspaceId: "ws_isolated",
      allowedMediationModes: ["header_template"],
    });

    brokerManager = new CapabilityBrokerManager({
      auditEmitter,
      secretBroker,
      allowUnverifiedBoundaries: true,
      development: true,
    });
  });

  describe("Secret Lifecycle & Non-Disclosure Storage", () => {
    it("adds, rotates, lists metadata, and deletes secrets without disclosing plaintext", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["GITHUB_TOKEN", "API_KEY", "DB_PASS"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      // 1. List metadata - verify metadata has fingerprints but no plaintext
      const metaList = await secretBroker.listMetadata(ctx);
      expect(metaList.length).toBeGreaterThanOrEqual(3);

      const ghMeta = metaList.find((m) => m.name === "GITHUB_TOKEN");
      expect(ghMeta).toBeDefined();
      expect(ghMeta?.version).toBe(1);
      expect(ghMeta?.fingerprint).toBeDefined();
      expect(ghMeta?.alias).toBe("GH_AUTH");

      // Verify no plaintext in serialized metadata
      const serialized = JSON.stringify(metaList);
      expect(serialized).not.toContain("ghp_");
      expect(serialized).not.toContain("sk-proj-");
      expect(serialized).not.toContain("database_password");

      // 2. Rotate secret
      const rotated = await secretBroker.rotateSecret(
        "GITHUB_TOKEN",
        "ghp_newrotatedtoken98765432109876543210",
        "ws_main",
      );
      expect(rotated.version).toBe(2);

      // Verify rotation works in mediation
      const mediated = await secretBroker.mediateBearerToken("GITHUB_TOKEN", ctx);
      expect(mediated.headerValue).toBe("Bearer ghp_newrotatedtoken98765432109876543210");

      // 3. Delete secret
      const deleted = await secretBroker.deleteSecret("GITHUB_TOKEN", "ws_main");
      expect(deleted).toBe(true);

      // Subsequent mediation should fail
      await expect(secretBroker.mediateBearerToken("GITHUB_TOKEN", ctx)).rejects.toThrow(
        BrokerSecurityError,
      );
    });
  });

  describe("Capability Grant Authorization & Direct Read Denial", () => {
    it("denies direct secret read when denyDirectRead is true (default)", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["GITHUB_TOKEN", "API_KEY"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      await expect(secretBroker.getSecret("API_KEY", ctx)).rejects.toThrow(
        /Direct read of secret 'API_KEY' is denied by policy/,
      );

      // Verify audit event was recorded as denied
      const events = auditEmitter.getEvents({ action: "getSecret" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].status).toBe("denied");
      expect(events[0].error?.code).toBe("OPERATION_NOT_PERMITTED");
    });

    it("allows direct read only when denyDirectRead is false and secret is explicitly authorized", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["API_KEY"],
            allowedPrefixes: [],
            denyDirectRead: false,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      // Authorized secret read
      const res = await secretBroker.getSecret("API_KEY", ctx);
      expect(res.secret).toBe("sk-proj-super-secret-key-12345");

      // Unauthorized secret read
      await expect(secretBroker.getSecret("DB_PASS", ctx)).rejects.toThrow(BrokerSecurityError);
    });

    it("denies access when invocation grant is missing", async () => {
      const ctx = {
        invocationId: "inv_secret_001",
        workspaceId: "ws_main",
      };

      await expect(
        secretBroker.mediateHeaders({ Authorization: "Bearer {{secret:GITHUB_TOKEN}}" }, ctx),
      ).rejects.toThrow(/Invocation grant is required/);
    });
  });

  describe("HTTP Header & Bearer Token Mediation", () => {
    it("mediates headers with secret template interpolation without disclosing to worker", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["GITHUB_TOKEN", "API_KEY"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      const rawHeaders = {
        Authorization: "Bearer {{secret:GITHUB_TOKEN}}",
        "X-Custom-Key": "{{secret:API_KEY}}",
        "Content-Type": "application/json",
      };

      const mediated = await secretBroker.mediateHeaders(rawHeaders, ctx);

      expect(mediated.Authorization).toBe("Bearer ghp_123456789012345678901234567890123456");
      expect(mediated["X-Custom-Key"]).toBe("sk-proj-super-secret-key-12345");
      expect(mediated["Content-Type"]).toBe("application/json");

      // Verify audit events do not contain raw secrets
      const auditEvents = auditEmitter.getEvents({ action: "mediateSecret" });
      expect(auditEvents.length).toBeGreaterThanOrEqual(2);
      for (const ev of auditEvents) {
        expect(JSON.stringify(ev.summary)).not.toContain("ghp_");
        expect(JSON.stringify(ev.summary)).not.toContain("sk-proj-");
      }
    });

    it("mediates bearer token via mediateBearerToken", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["GITHUB_TOKEN"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      const res = await secretBroker.mediateBearerToken("GITHUB_TOKEN", ctx);
      expect(res.headerName).toBe("Authorization");
      expect(res.headerValue).toBe("Bearer ghp_123456789012345678901234567890123456");
    });

    it("denies header mediation for undeclared or unauthorized secret", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["API_KEY"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      // GITHUB_TOKEN is not in allowedSecretNames
      await expect(
        secretBroker.mediateHeaders({ Authorization: "Bearer {{secret:GITHUB_TOKEN}}" }, ctx),
      ).rejects.toThrow(/Secret 'GITHUB_TOKEN' is not authorized by capability grant/);
    });

    it("denies header mediation for secret from another workspace", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["ISOLATED_SECRET"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main", // Requesting ws_isolated secret from ws_main
      };

      await expect(
        secretBroker.mediateHeaders({ "X-Key": "{{secret:ISOLATED_SECRET}}" }, ctx),
      ).rejects.toThrow(/belongs to workspace 'ws_isolated', not 'ws_main'/);
    });
  });

  describe("URL & Query Parameter Mediation", () => {
    it("mediates URL query parameter templates", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["API_KEY"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      const rawUrl =
        "https://api.example.com/v1/search?query=test&api_key={{secret:API_KEY}}&format=json";
      const mediatedUrl = await secretBroker.mediateUrl(rawUrl, ctx);

      expect(mediatedUrl).toBe(
        "https://api.example.com/v1/search?query=test&api_key=sk-proj-super-secret-key-12345&format=json",
      );
    });
  });

  describe("Command Stdin & Environment Variable Mediation", () => {
    it("mediates command stdin safely", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["DB_PASS"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: false,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      const stdin = await secretBroker.mediateCommandStdin("{{secret:DB_PASS}}", ctx);
      expect(stdin).toBe("database_password_9999");
    });

    it("mediates environment variables and supports injectAsEnv", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["API_KEY", "DB_PASS"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      const rawEnv = {
        CUSTOM_VAR: "normal_value",
        OPENAI_SECRET: "{{secret:API_KEY}}",
      };

      const mediatedEnv = await secretBroker.mediateCommandEnv(rawEnv, ctx);

      expect(mediatedEnv.CUSTOM_VAR).toBe("normal_value");
      expect(mediatedEnv.OPENAI_SECRET).toBe("sk-proj-super-secret-key-12345");
      // Injected automatically because injectAsEnv is true and DB_PASS was not in rawEnv
      expect(mediatedEnv.DB_PASS).toBe("database_password_9999");
    });
  });

  describe("End-to-End Mediation with CapabilityBrokerManager", () => {
    it("mediates secret templates via CapabilityBrokerManager RPC dispatch", async () => {
      const grant = createInvocationGrant({
        ...baseGrantParams,
        capabilities: {
          secrets: {
            allowedSecretNames: ["GITHUB_TOKEN", "API_KEY", "DB_PASS"],
            allowedPrefixes: [],
            denyDirectRead: true,
            injectAsEnv: true,
          },
        },
      });

      const ctx = {
        invocationId: "inv_secret_001",
        grant,
        workspaceId: "ws_main",
      };

      await expect(
        brokerManager.handleRequest(
          "secret",
          "mediateHeaders",
          { headers: { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" } },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "DIRECT_READ_DENIED" });

      const trusted = await secretBroker.mediateHeaders(
        { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" },
        { ...ctx, isWorker: false, source: "host" },
      );
      expect(trusted.Authorization).toBe("Bearer ghp_123456789012345678901234567890123456");

      await expect(
        brokerManager.handleRequest("secret", "getSecret", { name: "GITHUB_TOKEN" }, ctx),
      ).rejects.toThrow(BrokerSecurityError);
    });
  });

  describe("Secret Redaction Across Logs and Diagnostics", () => {
    it("redacts all registered secrets in logs and diagnostic outputs", () => {
      const redactor = secretBroker.getRedactor();

      const logMessage =
        "Request failed with Authorization: Bearer ghp_123456789012345678901234567890123456 and token sk-proj-super-secret-key-12345";
      const sanitizedLog = redactor.redact(logMessage);

      expect(sanitizedLog).not.toContain("ghp_123456789012345678901234567890123456");
      expect(sanitizedLog).not.toContain("sk-proj-super-secret-key-12345");
      expect(sanitizedLog).toContain("[REDACTED:GITHUB_TOKEN]");
      expect(sanitizedLog).toContain("[REDACTED:API_KEY]");

      // Redacting structured diagnostic payload
      const diagnosticPayload = {
        traceId: "trace_101",
        error: new Error("Failed connecting with password database_password_9999"),
        metadata: {
          rawHeader: "Bearer ghp_123456789012345678901234567890123456",
        },
      };

      const sanitizedDiag = redactor.redactObject(diagnosticPayload);
      expect(sanitizedDiag.error.message).toBe(
        "Failed connecting with password [REDACTED:DB_PASS]",
      );
      expect(sanitizedDiag.metadata.rawHeader).toBe("Bearer [REDACTED:GITHUB_TOKEN]");
    });
  });
});
