import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  IncompatibleSchemaError,
  assertCompatible,
  diffJsonSchemas,
  diffSchemaDescriptors,
  diffZodSchemas,
  extractSchemaDescriptor,
  formatSchemaDiff,
} from "../src/schema-diff.js";

describe("Semantic Schema Diff Tool", () => {
  describe("Schema Descriptor Extraction", () => {
    it("extracts descriptors from simple Zod primitives", () => {
      const strSchema = z.string().min(3).max(10).describe("Username");
      const desc = extractSchemaDescriptor(strSchema);

      expect(desc.type).toBe("string");
      expect(desc.min).toBe(3);
      expect(desc.max).toBe(10);
      expect(desc.description).toBe("Username");
    });

    it("extracts descriptors from complex Zod objects with optionals and defaults", () => {
      const objSchema = z.object({
        id: z.string(),
        count: z.number().int().default(1),
        tags: z.array(z.string()).optional(),
        role: z.enum(["admin", "member", "guest"]),
      });
      const desc = extractSchemaDescriptor(objSchema);

      expect(desc.type).toBe("object");
      expect(desc.properties?.id.type).toBe("string");
      expect(desc.properties?.count.hasDefault).toBe(true);
      expect(desc.properties?.tags.isOptional).toBe(true);
      expect(desc.properties?.role.enumValues).toEqual(["admin", "member", "guest"]);
      expect(desc.required).toEqual(["id", "role"]);
    });
  });

  describe("Additive Changes (Non-breaking)", () => {
    it("detects adding an optional field as additive", () => {
      const v1 = z.object({ id: z.string(), name: z.string() });
      const v2 = z.object({ id: z.string(), name: z.string(), bio: z.string().optional() });

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("additive");
      expect(diff.isBreaking).toBe(false);
      expect(diff.summary.additive).toBe(1);
      expect(diff.changes[0].kind).toBe("field_added");
    });

    it("detects adding an enum variant as additive", () => {
      const v1 = z.enum(["read", "write"]);
      const v2 = z.enum(["read", "write", "admin"]);

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("additive");
      expect(diff.isBreaking).toBe(false);
      expect(diff.changes[0].kind).toBe("enum_variant_added");
    });

    it("detects relaxed constraint as additive", () => {
      const v1 = z.string().min(5);
      const v2 = z.string().min(2);

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("additive");
      expect(diff.isBreaking).toBe(false);
      expect(diff.changes[0].kind).toBe("constraint_relaxed");
    });

    it("detects description change as additive", () => {
      const v1 = z.string().describe("old description");
      const v2 = z.string().describe("new improved description");

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("additive");
      expect(diff.isBreaking).toBe(false);
    });
  });

  describe("Conditionally Compatible Changes", () => {
    it("detects required field becoming optional as conditionally compatible", () => {
      const v1 = z.object({ id: z.string(), code: z.string() });
      const v2 = z.object({ id: z.string(), code: z.string().optional() });

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("conditionally_compatible");
      expect(diff.isBreaking).toBe(false);
      expect(diff.summary.conditionallyCompatible).toBe(1);
    });
  });

  describe("Breaking Changes", () => {
    it("detects field removal as breaking", () => {
      const v1 = z.object({ id: z.string(), title: z.string(), author: z.string() });
      const v2 = z.object({ id: z.string(), title: z.string() });

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("breaking");
      expect(diff.isBreaking).toBe(true);
      expect(diff.changes[0].kind).toBe("field_removed");
      expect(diff.changes[0].path).toBe("author");
    });

    it("detects type shifts as breaking", () => {
      const v1 = z.object({ id: z.string(), count: z.number() });
      const v2 = z.object({ id: z.string(), count: z.string() });

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("breaking");
      expect(diff.isBreaking).toBe(true);
      expect(diff.changes[0].kind).toBe("type_changed");
    });

    it("detects adding a required field as breaking", () => {
      const v1 = z.object({ id: z.string() });
      const v2 = z.object({ id: z.string(), requiredSecret: z.string() });

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("breaking");
      expect(diff.isBreaking).toBe(true);
      expect(diff.changes[0].kind).toBe("field_added");
    });

    it("detects removing an enum variant as breaking", () => {
      const v1 = z.enum(["active", "pending", "legacy"]);
      const v2 = z.enum(["active", "pending"]);

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("breaking");
      expect(diff.isBreaking).toBe(true);
      expect(diff.changes[0].kind).toBe("enum_variant_removed");
    });

    it("detects tightened numeric constraints as breaking", () => {
      const v1 = z.number().min(0).max(100);
      const v2 = z.number().min(10).max(80);

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("breaking");
      expect(diff.isBreaking).toBe(true);
      expect(diff.summary.breaking).toBe(2);
    });

    it("detects optional field becoming required as breaking", () => {
      const v1 = z.object({ id: z.string(), note: z.string().optional() });
      const v2 = z.object({ id: z.string(), note: z.string() });

      const diff = diffZodSchemas(v1, v2);
      expect(diff.category).toBe("breaking");
      expect(diff.isBreaking).toBe(true);
      expect(diff.changes[0].kind).toBe("required_changed");
    });
  });

  describe("JSON Schema Diffing", () => {
    it("diffs raw JSON schema objects", () => {
      const json1 = {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["open", "closed"] },
        },
        required: ["id", "status"],
      };

      const json2 = {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["open", "closed", "archived"] },
          score: { type: "number" },
        },
        required: ["id", "status"],
      };

      const diff = diffJsonSchemas(json1, json2);
      expect(diff.category).toBe("additive");
      expect(diff.isBreaking).toBe(false);
    });
  });

  describe("assertCompatible & formatSchemaDiff", () => {
    it("passes assertion for additive changes", () => {
      const v1 = z.object({ name: z.string() });
      const v2 = z.object({ name: z.string(), age: z.number().optional() });

      expect(() => assertCompatible(v1, v2)).not.toThrow();
    });

    it("throws IncompatibleSchemaError for breaking changes", () => {
      const v1 = z.object({ name: z.string(), score: z.number() });
      const v2 = z.object({ name: z.string() });

      expect(() => assertCompatible(v1, v2)).toThrow(IncompatibleSchemaError);
    });

    it("formats human-readable diff reports", () => {
      const v1 = z.object({ a: z.string(), b: z.number() });
      const v2 = z.object({ a: z.string(), b: z.string(), c: z.boolean().optional() });

      const diff = diffZodSchemas(v1, v2);
      const formatted = formatSchemaDiff(diff);

      expect(formatted).toContain("Schema Diff Result: [BREAKING]");
      expect(formatted).toContain("Type shifted from 'number' to 'string'");
      expect(formatted).toContain("Field 'c' was added");
    });
  });
});
