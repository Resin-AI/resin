import { describe, expect, it } from "vitest";
import { validToolManifest } from "../fixtures/index.js";
import {
  ToolLimitConfigSchema,
  ToolManifestSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
  ToolScopeSchema,
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
