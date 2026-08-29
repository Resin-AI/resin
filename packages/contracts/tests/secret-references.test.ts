import { describe, expect, it } from "vitest";
import * as contractsExports from "../src/index.js";
import {
  ALL_SECRET_MEDIATION_MODES,
  type OpaqueSecretRef,
  type SecretMediationMode,
  SecretMediationModeSchema,
  SecretMediationRequestSchema,
  SecretMediationResultSchema,
  type SecretReference,
  SecretReferenceSchema,
  createOpaqueSecretRef,
  createSecretReference,
  formatSecretTemplate,
  isSecretReference,
  validateSecretReferenceScope,
} from "../src/secrets.js";

describe("Secret Reference and Broker Mediation Contracts", () => {
  describe("SecretMediationModeSchema", () => {
    it("accepts all valid mediation modes", () => {
      const modes: SecretMediationMode[] = [
        "header_template",
        "bearer_token",
        "query_template",
        "command_stdin",
        "command_env",
      ];

      for (const mode of modes) {
        expect(SecretMediationModeSchema.parse(mode)).toBe(mode);
      }
      expect(ALL_SECRET_MEDIATION_MODES).toHaveLength(5);
    });

    it("rejects invalid mediation modes", () => {
      expect(() => SecretMediationModeSchema.parse("direct_read")).toThrow();
      expect(() => SecretMediationModeSchema.parse("plaintext")).toThrow();
      expect(() => SecretMediationModeSchema.parse("raw_export")).toThrow();
      expect(() => SecretMediationModeSchema.parse("")).toThrow();
    });
  });

  describe("SecretReferenceSchema & OpaqueSecretRef", () => {
    it("parses valid opaque secret reference with default values", () => {
      const parsed = SecretReferenceSchema.parse({
        name: "GITHUB_TOKEN",
        ref: "sec_ref_gh_12345",
      });

      expect(parsed.kind).toBe("secret_reference");
      expect(parsed.name).toBe("GITHUB_TOKEN");
      expect(parsed.ref).toBe("sec_ref_gh_12345");
      expect(parsed.workspaceId).toBe("default");
      expect(parsed.permittedModes).toEqual([
        "header_template",
        "bearer_token",
        "query_template",
        "command_stdin",
        "command_env",
      ]);
      expect(parsed.metadata).toEqual({});
      expect(parsed.expiresAt).toBeUndefined();
    });

    it("parses fully scoped secret reference", () => {
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      const raw: SecretReference = {
        kind: "secret_reference",
        name: "DATABASE_PASSWORD",
        ref: "sec_ref_db_pass_abcdef",
        workspaceId: "ws_prod_01",
        permittedModes: ["command_env", "command_stdin"],
        toolId: "db_migrator_tool",
        accountId: "acc_enterprise_99",
        installationId: "inst_local_001",
        grantId: "grant_secret_xyz",
        expiresAt,
        metadata: { purpose: "migration", env: "production" },
      };

      const parsed: OpaqueSecretRef = SecretReferenceSchema.parse(raw);
      expect(parsed.workspaceId).toBe("ws_prod_01");
      expect(parsed.toolId).toBe("db_migrator_tool");
      expect(parsed.accountId).toBe("acc_enterprise_99");
      expect(parsed.installationId).toBe("inst_local_001");
      expect(parsed.grantId).toBe("grant_secret_xyz");
      expect(parsed.expiresAt).toBe(expiresAt);
      expect(parsed.permittedModes).toEqual(["command_env", "command_stdin"]);
      expect(parsed.metadata).toEqual({ purpose: "migration", env: "production" });
    });

    it("rejects invalid secret references", () => {
      // Missing name
      expect(() => SecretReferenceSchema.parse({ ref: "sec_ref_1" })).toThrow();
      // Empty name
      expect(() => SecretReferenceSchema.parse({ name: "", ref: "sec_ref_1" })).toThrow();
      // Missing ref
      expect(() => SecretReferenceSchema.parse({ name: "API_KEY" })).toThrow();
      // Empty ref
      expect(() => SecretReferenceSchema.parse({ name: "API_KEY", ref: "" })).toThrow();
      // Invalid mode
      expect(() =>
        SecretReferenceSchema.parse({
          name: "API_KEY",
          ref: "sec_ref_1",
          permittedModes: ["invalid_mode"],
        }),
      ).toThrow();
      // Invalid expiry timestamp
      expect(() =>
        SecretReferenceSchema.parse({
          name: "API_KEY",
          ref: "sec_ref_1",
          expiresAt: "not-a-timestamp",
        }),
      ).toThrow();
    });
  });

  describe("createSecretReference & isSecretReference helpers", () => {
    it("creates a well-formed opaque secret reference with generated handle", () => {
      const ref = createSecretReference({
        name: "OPENAI_API_KEY",
        workspaceId: "ws_dev",
        permittedModes: ["header_template", "bearer_token"],
      });

      expect(ref.kind).toBe("secret_reference");
      expect(ref.name).toBe("OPENAI_API_KEY");
      expect(ref.ref).toMatch(/^sec_ref_openai_api_key_[a-z0-9]+$/);
      expect(ref.workspaceId).toBe("ws_dev");
      expect(ref.permittedModes).toEqual(["header_template", "bearer_token"]);
      expect(isSecretReference(ref)).toBe(true);
    });

    it("createOpaqueSecretRef is an alias for createSecretReference", () => {
      const ref = createOpaqueSecretRef({
        name: "CUSTOM_SECRET",
        ref: "explicit_handle_123",
      });

      expect(ref.name).toBe("CUSTOM_SECRET");
      expect(ref.ref).toBe("explicit_handle_123");
      expect(isSecretReference(ref)).toBe(true);
    });

    it("isSecretReference correctly identifies references and rejects non-references", () => {
      expect(isSecretReference(createSecretReference({ name: "TEST" }))).toBe(true);
      expect(isSecretReference(null)).toBe(false);
      expect(isSecretReference(undefined)).toBe(false);
      expect(isSecretReference("string_ref")).toBe(false);
      expect(isSecretReference(12345)).toBe(false);
      expect(isSecretReference({})).toBe(false);
      expect(isSecretReference({ kind: "other", name: "TEST", ref: "r1" })).toBe(false);
      expect(isSecretReference({ kind: "secret_reference", name: "" })).toBe(false);
    });
  });

  describe("validateSecretReferenceScope", () => {
    const baseRef = createSecretReference({
      name: "TEST_SECRET",
      workspaceId: "ws_alpha",
      toolId: "tool_alpha",
      accountId: "acc_100",
      installationId: "inst_200",
      grantId: "grant_300",
    });

    it("passes when context matches all scopes", () => {
      const result = validateSecretReferenceScope(baseRef, {
        workspaceId: "ws_alpha",
        toolId: "tool_alpha",
        accountId: "acc_100",
        installationId: "inst_200",
        grantId: "grant_300",
      });
      expect(result.valid).toBe(true);
    });

    it("fails when workspace mismatches", () => {
      const result = validateSecretReferenceScope(baseRef, {
        workspaceId: "ws_beta",
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("WORKSPACE_MISMATCH");
    });

    it("fails when tool mismatches", () => {
      const result = validateSecretReferenceScope(baseRef, {
        workspaceId: "ws_alpha",
        toolId: "tool_other",
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("TOOL_MISMATCH");
    });

    it("fails when account mismatches", () => {
      const result = validateSecretReferenceScope(baseRef, {
        workspaceId: "ws_alpha",
        accountId: "acc_other",
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("ACCOUNT_MISMATCH");
    });

    it("fails when installation mismatches", () => {
      const result = validateSecretReferenceScope(baseRef, {
        workspaceId: "ws_alpha",
        installationId: "inst_other",
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("INSTALLATION_MISMATCH");
    });

    it("fails when grant ID mismatches", () => {
      const result = validateSecretReferenceScope(baseRef, {
        workspaceId: "ws_alpha",
        grantId: "grant_other",
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("GRANT_MISMATCH");
    });

    it("fails when reference is expired", () => {
      const pastTime = new Date(Date.now() - 60000).toISOString();
      const expiredRef = createSecretReference({
        name: "EXPIRED_SECRET",
        expiresAt: pastTime,
      });

      const result = validateSecretReferenceScope(expiredRef);
      expect(result.valid).toBe(false);
      expect(result.code).toBe("GRANT_EXPIRED");
    });

    it("passes when reference has not yet expired", () => {
      const futureTime = new Date(Date.now() + 60000).toISOString();
      const validRef = createSecretReference({
        name: "VALID_SECRET",
        expiresAt: futureTime,
      });

      const result = validateSecretReferenceScope(validRef);
      expect(result.valid).toBe(true);
    });
  });

  describe("SecretMediationRequestSchema & SecretMediationResultSchema", () => {
    it("parses valid SecretMediationRequest with SecretReference", () => {
      const ref = createSecretReference({ name: "API_KEY" });
      const req = SecretMediationRequestSchema.parse({
        reference: ref,
        mode: "bearer_token",
        targetKey: "Authorization",
      });

      expect(req.mode).toBe("bearer_token");
      expect(req.targetKey).toBe("Authorization");
    });

    it("parses valid SecretMediationRequest with string alias", () => {
      const req = SecretMediationRequestSchema.parse({
        reference: "GITHUB_TOKEN",
        mode: "header_template",
        template: "Bearer {{secret:GITHUB_TOKEN}}",
      });

      expect(req.reference).toBe("GITHUB_TOKEN");
      expect(req.mode).toBe("header_template");
    });

    it("parses SecretMediationResult without disclosing secret values", () => {
      const res = SecretMediationResultSchema.parse({
        success: true,
        mode: "header_template",
        secretName: "API_KEY",
        referenceId: "sec_ref_123",
        appliedTo: "headers.Authorization",
      });

      expect(res.success).toBe(true);
      expect(res.secretName).toBe("API_KEY");
      expect(res.referenceId).toBe("sec_ref_123");
      // Result schema does NOT have any secret or value field
      expect((res as Record<string, unknown>).value).toBeUndefined();
      expect((res as Record<string, unknown>).secretValue).toBeUndefined();
    });
  });

  describe("formatSecretTemplate", () => {
    it("formats template string from secret name string", () => {
      expect(formatSecretTemplate("GITHUB_TOKEN")).toBe("{{secret:GITHUB_TOKEN}}");
    });

    it("formats template string from SecretReference object", () => {
      const ref = createSecretReference({ name: "STRIPE_KEY" });
      expect(formatSecretTemplate(ref)).toBe("{{secret:STRIPE_KEY}}");
    });
  });

  describe("Protocol non-disclosure guarantee", () => {
    it("ensures no raw secret return schema exists in contracts", () => {
      const exportKeys = Object.keys(contractsExports);

      // Verify that no export names suggest raw secret responses
      const dangerousPatterns = [
        /RawSecret/i,
        /SecretValue/i,
        /PlaintextSecret/i,
        /DisclosedSecret/i,
        /GetSecretResponseSchema/i,
      ];

      for (const pattern of dangerousPatterns) {
        const found = exportKeys.filter((k) => pattern.test(k));
        expect(found).toEqual([]);
      }
    });
  });
});
