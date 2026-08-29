import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generateFullContractCatalogDoc,
  generateJsonSchema,
  generateMarkdownDocs,
  generateSchemaExample,
} from "../src/doc-generator.js";

describe("Documentation and JSON Schema Generator", () => {
  describe("JSON Schema Generator", () => {
    it("generates Draft-07 compliant JSON Schema for complex objects", () => {
      const schema = z.object({
        userId: z.string().min(3).max(50).describe("User identifier"),
        age: z.number().int().min(18).max(120),
        role: z.enum(["admin", "user", "guest"]),
        tags: z.array(z.string()).min(1),
        isActive: z.boolean().default(true),
      });

      const jsonSchema = generateJsonSchema(schema, { targetSpec: "draft-07" });

      expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(jsonSchema.type).toBe("object");

      const props = jsonSchema.properties as Record<string, Record<string, unknown>>;
      expect(props.userId.type).toBe("string");
      expect(props.userId.minLength).toBe(3);
      expect(props.userId.maxLength).toBe(50);
      expect(props.userId.description).toBe("User identifier");

      expect(props.age.type).toBe("integer");
      expect(props.age.minimum).toBe(18);

      expect(props.role.enum).toEqual(["admin", "user", "guest"]);
      expect(props.tags.type).toBe("array");
      expect(props.isActive.default).toBe(true);

      expect(jsonSchema.required).toEqual(["userId", "age", "role", "tags"]);
    });

    it("generates 2020-12 target schema with embedded examples", () => {
      const schema = z.object({
        id: z.string(),
        score: z.number(),
      });

      const jsonSchema = generateJsonSchema(schema, {
        targetSpec: "2020-12",
        includeExamples: true,
      });

      expect(jsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(Array.isArray(jsonSchema.examples)).toBe(true);
      expect((jsonSchema.examples as unknown[])[0]).toHaveProperty("id");
    });
  });

  describe("Schema Example Generator", () => {
    it("generates realistic samples for strings, dates, digests, and numbers", () => {
      const schema = z.object({
        sessionId: z.string(),
        createdAt: z.string(),
        manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
        retryCount: z.number().int().min(0),
        ratio: z.number().min(0).max(1),
        enabled: z.boolean(),
        status: z.enum(["active", "inactive"]),
      });

      const example = generateSchemaExample(schema) as Record<string, unknown>;

      expect(example.sessionId).toContain("session");
      expect(example.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(example.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof example.retryCount).toBe("number");
      expect(example.enabled).toBe(true);
      expect(["active", "inactive"]).toContain(example.status);
    });
  });

  describe("Markdown Documentation Generator", () => {
    it("generates structured markdown with table of contents, property tables, and code blocks", () => {
      const schemas = {
        UserProfile: z
          .object({
            id: z.string().describe("Unique user identifier"),
            name: z.string().describe("User display name"),
            role: z.enum(["admin", "user"]).describe("Authorization level"),
          })
          .describe("Represents an active platform user."),
      };

      const markdown = generateMarkdownDocs(schemas, {
        title: "Test API Specifications",
        includeExamples: true,
      });

      expect(markdown).toContain("# Test API Specifications");
      expect(markdown).toContain("## Table of Contents");
      expect(markdown).toContain("- [UserProfile](#userprofile)");
      expect(markdown).toContain("Represents an active platform user.");
      expect(markdown).toContain("| `id` | `string` | Yes | - | Unique user identifier |");
      expect(markdown).toContain("| `role` | `enum` | Yes | - | Authorization level |");
      expect(markdown).toContain("```json");
    });

    it("generates the full contract catalog doc across all packages", () => {
      const catalogDoc = generateFullContractCatalogDoc();

      expect(catalogDoc).toContain("Resin Core Schema & Contract Catalog");
      expect(catalogDoc).toContain("NormalizedSessionEvent");
      expect(catalogDoc).toContain("ToolManifest");
      expect(catalogDoc).toContain("CapabilityEnvelope");
      expect(catalogDoc).toContain("DeploymentRecord");
      expect(catalogDoc).toContain("ProtocolMessageEnvelope");
      expect(catalogDoc).toContain("StreamMessage");
      expect(catalogDoc).toContain("HarnessInstallation");
    });
  });
});
