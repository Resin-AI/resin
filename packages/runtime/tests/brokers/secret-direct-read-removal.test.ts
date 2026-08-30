import {
  type SecretCapability,
  type SecretReference,
  createSecretReference,
  isSecretReference,
} from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  BrokerSecurityError,
  CapabilityBrokerManager,
  SecretBroker,
} from "../../src/brokers/index.js";
import { createInvocationGrant } from "../../src/policy/grant.js";

describe("Secret Direct-Read Removal & Mediation Broker Contracts", () => {
  let auditEmitter: BrokerAuditEmitter;
  let secretBroker: SecretBroker;
  let brokerManager: CapabilityBrokerManager;

  const validGrant = createInvocationGrant({
    grantId: "grant_direct_read_removal_001",
    invocationId: "inv_direct_read_removal_001",
    toolId: "test_tool",
    toolVersion: "1.0.0",
    workspaceId: "ws_test_01",
    envelopeId: "env_direct_read_001",
    capabilities: {
      secrets: {
        allowedSecretNames: ["API_KEY_ALPHA", "AUTH_BEARER_TOKEN"],
        allowedPrefixes: ["SERVICE_"],
        denyDirectRead: true,
        injectAsEnv: true,
      },
    },
  });

  const workerContext = {
    grant: validGrant,
    invocationId: "inv_direct_read_removal_001",
    workspaceId: "ws_test_01",
    isWorker: true,
    source: "worker" as const,
  };

  beforeAll(async () => {
    auditEmitter = new BrokerAuditEmitter();
    secretBroker = new SecretBroker({
      auditEmitter,
      vaultPath: ":memory:",
      passphrase: "test-direct-read-removal-vault-passphrase",
    });

    await secretBroker.addSecret("API_KEY_ALPHA", "super_secret_alpha_value_9999", {
      workspaceId: "ws_test_01",
      allowedMediationModes: ["header_template", "bearer_token", "command_env"],
    });

    await secretBroker.addSecret("AUTH_BEARER_TOKEN", "bearer_token_xyz_8888", {
      workspaceId: "ws_test_01",
      allowedMediationModes: ["bearer_token", "header_template"],
    });

    await secretBroker.addSecret("OTHER_WS_SECRET", "isolated_other_workspace_value", {
      workspaceId: "ws_other_tenant",
      allowedMediationModes: ["bearer_token"],
    });

    brokerManager = new CapabilityBrokerManager({
      secretBroker,
      auditEmitter,
    });
  });

  describe("Structured Denial for Worker Direct-Read Operations", () => {
    const directReadActions = [
      "getSecret",
      "read",
      "resolve",
      "resolveSecret",
      "resolveReference",
      "resolveSecretReference",
      "raw",
      "getRawSecret",
      "getValue",
      "getSecretValue",
    ];

    for (const action of directReadActions) {
      it(`strictly denies worker dispatch for '${action}' with structured DIRECT_READ_DENIED error`, async () => {
        const eventsBefore = auditEmitter.getEvents().length;

        await expect(
          secretBroker.handleRequest(action, { name: "API_KEY_ALPHA" }, workerContext),
        ).rejects.toThrowError(BrokerSecurityError);

        try {
          await secretBroker.handleRequest(action, { name: "API_KEY_ALPHA" }, workerContext);
        } catch (err) {
          expect(err).toBeInstanceOf(BrokerSecurityError);
          if (err instanceof BrokerSecurityError) {
            expect(err.code).toBe("DIRECT_READ_DENIED");
            expect(err.message).toContain("Direct reading of secrets is strictly prohibited");
            expect(err.message).not.toContain("super_secret_alpha_value_9999");
          }
        }

        const eventsAfter = auditEmitter.getEvents();
        expect(eventsAfter.length).toBeGreaterThan(eventsBefore);
        const lastEvent = eventsAfter[eventsAfter.length - 1]!;
        expect(lastEvent.service).toBe("secret");
        expect(lastEvent.status).toBe("denied");
      });
    }

    it("denies direct secret read via broker manager request dispatch", async () => {
      const handler = brokerManager.createRequestHandler(workerContext);
      await expect(handler("secret", "getSecret", { name: "API_KEY_ALPHA" })).rejects.toThrowError(
        BrokerSecurityError,
      );
    });

    it("denies direct secret read even if called on broker directly with worker context", async () => {
      await expect(secretBroker.getSecret("API_KEY_ALPHA", workerContext)).rejects.toThrow(
        "Direct reading of secrets is strictly prohibited from worker contexts",
      );
    });
  });

  describe("Structured Denial for Administrative Secret Operations from Worker", () => {
    const adminActions = [
      "add",
      "addSecret",
      "setSecret",
      "rotate",
      "rotateSecret",
      "delete",
      "deleteSecret",
      "purge",
      "purgeSecrets",
    ];

    for (const action of adminActions) {
      it(`strictly denies worker dispatch for administrative action '${action}'`, async () => {
        await expect(
          secretBroker.handleRequest(
            action,
            { name: "NEW_SECRET", value: "injected_value" },
            workerContext,
          ),
        ).rejects.toThrowError(BrokerSecurityError);

        try {
          await secretBroker.handleRequest(
            action,
            { name: "NEW_SECRET", value: "injected_value" },
            workerContext,
          );
        } catch (err) {
          expect(err).toBeInstanceOf(BrokerSecurityError);
          if (err instanceof BrokerSecurityError) {
            expect(err.code).toBe("OPERATION_NOT_PERMITTED");
            expect(err.message).toContain("Administrative secret operation");
          }
        }
      });
    }
  });

  describe("Opaque Secret Reference Mediation without Disclosing Bytes", () => {
    it("creates opaque SecretReference with metadata and no plaintext secret values", async () => {
      const ref = await secretBroker.handleRequest(
        "createReference",
        { name: "API_KEY_ALPHA" },
        workerContext,
      );

      expect(isSecretReference(ref)).toBe(true);
      if (isSecretReference(ref)) {
        expect(ref.kind).toBe("secret_reference");
        expect(ref.name).toBe("API_KEY_ALPHA");
        expect(ref.ref).toMatch(/^sec_ref_[A-Za-z0-9_]+$/);
        expect("secret" in ref).toBe(false);
        expect("value" in ref).toBe(false);
        expect(JSON.stringify(ref)).not.toContain("super_secret_alpha_value_9999");
      }
    });
    it("lists only authorized secret references for the caller's grant", async () => {
      const rawRefs = await secretBroker.handleRequest("listReferences", {}, workerContext);

      expect(Array.isArray(rawRefs)).toBe(true);
      if (Array.isArray(rawRefs)) {
        expect(rawRefs.length).toBe(2);
        const refs = rawRefs.filter(isSecretReference);
        expect(refs.length).toBe(2);
        const names = refs.map((r) => r.name);
        expect(names).toContain("API_KEY_ALPHA");
        expect(names).toContain("AUTH_BEARER_TOKEN");
        expect(names).not.toContain("OTHER_WS_SECRET");

        for (const r of refs) {
          expect(r.kind).toBe("secret_reference");
          expect(r.ref).toMatch(/^sec_ref_[A-Za-z0-9_]+$/);
          expect("value" in r).toBe(false);
        }
      }
    });

    it("denies worker requests that would return mediated plaintext", async () => {
      await expect(
        secretBroker.handleRequest(
          "mediateHeaders",
          {
            headers: {
              Authorization: "Bearer {{secret:AUTH_BEARER_TOKEN}}",
            },
          },
          workerContext,
        ),
      ).rejects.toMatchObject({ code: "DIRECT_READ_DENIED" });

      const trustedResult = await secretBroker.mediateHeaders(
        { Authorization: "Bearer {{secret:AUTH_BEARER_TOKEN}}" },
        { ...workerContext, isWorker: false, source: "host" },
      );
      expect(trustedResult.Authorization).toBe("Bearer bearer_token_xyz_8888");
    });

    it("rejects unauthorized secret reference resolution across workspaces", async () => {
      const crossWsRef = createSecretReference({
        name: "OTHER_WS_SECRET",
        workspaceId: "ws_other_tenant",
        permittedModes: ["bearer_token"],
      });

      await expect(
        secretBroker.resolveSecretReference(crossWsRef, workerContext, "bearer_token"),
      ).rejects.toThrow(/WORKSPACE_MISMATCH|workspaceId/i);
    });

    it("rejects secret mediation when requested mode is not permitted", async () => {
      await expect(
        secretBroker.resolveSecretReference("AUTH_BEARER_TOKEN", workerContext, "command_env"),
      ).rejects.toThrow(/not permitted/i);
    });
  });
  describe("Audit Trail and Error Channel Non-Disclosure", () => {
    it("ensures audit log never records secret values during mediation", async () => {
      auditEmitter.clear();

      await secretBroker.mediateBearerToken("AUTH_BEARER_TOKEN", workerContext);

      const events = auditEmitter.getEvents();
      expect(events.length).toBeGreaterThan(0);

      for (const evt of events) {
        const json = JSON.stringify(evt);
        expect(json).not.toContain("bearer_token_xyz_8888");
        expect(json).not.toContain("super_secret_alpha_value_9999");
      }
    });

    it("does not disclose secret existence or values in error messages", async () => {
      try {
        await secretBroker.resolveSecretReference(
          "NON_EXISTENT_SECRET_123",
          workerContext,
          "bearer_token",
        );
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerSecurityError);
        if (err instanceof BrokerSecurityError) {
          expect(err.message).toContain("not authorized");
          expect(err.message).not.toContain("value");
        }
      }
    });
  });
});
