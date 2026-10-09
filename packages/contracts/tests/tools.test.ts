import { describe, expect, it } from "vitest";
import { validToolManifest } from "../fixtures/index.js";
import {
  ToolLimitConfigSchema,
  ToolManifestSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
  ToolScopeSchema,
  toolOpportunities,
} from "../src/tools.js";

describe("tools contracts", () => {
  describe("ToolManifestSchema", () => {
    it("parses valid tool manifest", () => {
      const parsed = ToolManifestSchema.parse(validToolManifest);
      expect(parsed.id).toBe("fast_ast_grep");
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.runtime.runtime).toBe("deno");
      expect(parsed.capabilities.fs.allowWorkspaceRoot).toBe(true);
    });

    it("rejects manifest with invalid semver", () => {
      const invalid = {
        ...validToolManifest,
        version: "v1.0",
      };
      expect(() => ToolManifestSchema.parse(invalid)).toThrow();
    });

    it("rejects manifest with invalid digest", () => {
      const invalid = {
        ...validToolManifest,
        digest: "invalid_digest_here",
      };
      expect(() => ToolManifestSchema.parse(invalid)).toThrow();
    });

    it("rejects manifest with empty id or name", () => {
      expect(() => ToolManifestSchema.parse({ ...validToolManifest, id: "" })).toThrow();
      expect(() => ToolManifestSchema.parse({ ...validToolManifest, name: "" })).toThrow();
    });
  });

  describe("recommendation opportunities", () => {
    const REPO = "c".repeat(64);
    const opportunities = { runs: 2, avoidableRequests: 5, sessions: 9, repositories: [REPO] };
    const recommended = (value: unknown) => ({
      automatic: true,
      reason: "expected_net_value",
      tasks: 0,
      invocations: 0,
      savedTokens: 0,
      opportunities: value,
    });

    it("reads well-formed opportunities from a parsed manifest", () => {
      const parsed = ToolManifestSchema.parse({
        ...validToolManifest,
        recommendation: recommended(opportunities),
      });
      expect(toolOpportunities(parsed.recommendation)).toEqual(opportunities);
      expect(toolOpportunities(ToolManifestSchema.parse(validToolManifest).recommendation)).toBe(
        undefined,
      );
    });

    it.each([
      ["a negative count", { ...opportunities, runs: -1 }],
      ["a fractional count", { ...opportunities, avoidableRequests: 1.5 }],
      ["a missing count", { runs: 1, avoidableRequests: 1, repositories: [REPO] }],
      ["a malformed repository id", { ...opportunities, repositories: [REPO.toUpperCase()] }],
      ["too many repositories", { ...opportunities, repositories: Array(65).fill(REPO) }],
      ["a non-object", "many"],
    ])("keeps a manifest with %s, as sent, and ignores the field", (_case, value) => {
      const parsed = ToolManifestSchema.parse({
        ...validToolManifest,
        recommendation: recommended(value),
      });
      // Passthrough keeps the value verbatim, so a snapshot checksum over parsed tools still holds.
      expect(parsed.recommendation?.opportunities).toEqual(value);
      expect(toolOpportunities(parsed.recommendation)).toBeUndefined();
    });
  });

  describe("ToolParameterSchema", () => {
    it("parses valid tool parameters with JSON Schema", () => {
      const params = {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      };
      const parsed = ToolParameterSchema.parse(params);
      expect(parsed.required).toContain("query");
      expect(parsed.additionalProperties).toBe(false);
    });
  });

  describe("ToolRuntimeRequirementSchema & ToolLimitConfigSchema", () => {
    it("parses runtime requirements with defaults", () => {
      const req = ToolRuntimeRequirementSchema.parse({
        runtime: "deno",
      });
      expect(req.memoryLimitMb).toBe(128);
      expect(req.timeoutMs).toBe(30000);
      expect(req.cpuLimitPercent).toBe(100);
    });

    it("parses limit config with defaults", () => {
      const limits = ToolLimitConfigSchema.parse({});
      expect(limits.timeoutMs).toBe(30000);
      expect(limits.maxOutputBytes).toBe(1048576);
    });

    it("validates tool scopes", () => {
      expect(ToolScopeSchema.parse("workspace")).toBe("workspace");
      expect(ToolScopeSchema.parse("user")).toBe("user");
      expect(ToolScopeSchema.parse("global")).toBe("global");
      expect(ToolScopeSchema.parse("session")).toBe("session");
      expect(() => ToolScopeSchema.parse("unrestricted")).toThrow();
    });
  });
});
