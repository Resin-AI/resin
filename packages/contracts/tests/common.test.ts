import { describe, expect, it } from "vitest";
import {
  CausalRefSchema,
  EpochMsSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  RedactionMetaSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  ULIDSchema,
  UUIDSchema,
  isValidSha256,
  normalizeSha256,
  nowIso,
} from "../src/common.js";

describe("common primitives", () => {
  describe("SchemaVersionSchema", () => {
    it("accepts valid semantic version strings", () => {
      expect(SchemaVersionSchema.parse("0.1.0")).toBe("0.1.0");
      expect(SchemaVersionSchema.parse("1.0.0-alpha.1")).toBe("1.0.0-alpha.1");
      expect(SchemaVersionSchema.parse("2.3.4+build.42")).toBe("2.3.4+build.42");
    });

    it("rejects invalid semantic version strings", () => {
      expect(() => SchemaVersionSchema.parse("1.0")).toThrow();
      expect(() => SchemaVersionSchema.parse("v1.0.0")).toThrow();
      expect(() => SchemaVersionSchema.parse("1.0.0.0")).toThrow();
      expect(() => SchemaVersionSchema.parse("")).toThrow();
    });
  });

  describe("UUIDSchema & ULIDSchema", () => {
    it("accepts valid UUIDs", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";
      expect(UUIDSchema.parse(validUuid)).toBe(validUuid);
    });

    it("rejects invalid UUIDs", () => {
      expect(() => UUIDSchema.parse("invalid-uuid")).toThrow();
      expect(() => UUIDSchema.parse("123e4567-e89b-12d3-a456")).toThrow();
    });

    it("accepts valid ULIDs", () => {
      const validUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      expect(ULIDSchema.parse(validUlid)).toBe(validUlid);
    });

    it("rejects invalid ULIDs", () => {
      expect(() => ULIDSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FA")).toThrow(); // length 25
      expect(() => ULIDSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FAVI")).toThrow(); // invalid Crockford char 'I'
    });
  });

  describe("IdentifierSchema", () => {
    it("accepts valid identifier strings", () => {
      expect(IdentifierSchema.parse("evt_01J5XYZ")).toBe("evt_01J5XYZ");
      expect(IdentifierSchema.parse("fast_ast_grep")).toBe("fast_ast_grep");
      expect(IdentifierSchema.parse("tool.my-subtool:v1")).toBe("tool.my-subtool:v1");
    });

    it("rejects empty or overly long identifiers", () => {
      expect(() => IdentifierSchema.parse("")).toThrow();
      expect(() => IdentifierSchema.parse("a".repeat(129))).toThrow();
    });
  });

  describe("ISOTimestampSchema & EpochMsSchema", () => {
    it("accepts valid ISO-8601 timestamps", () => {
      const ts = "2026-08-17T12:00:00.000Z";
      expect(ISOTimestampSchema.parse(ts)).toBe(ts);
    });

    it("rejects malformed timestamps", () => {
      expect(() => ISOTimestampSchema.parse("2026/08/17")).toThrow();
      expect(() => ISOTimestampSchema.parse("yesterday")).toThrow();
    });

    it("generates valid ISO timestamps via nowIso", () => {
      const now = nowIso();
      expect(ISOTimestampSchema.safeParse(now).success).toBe(true);
    });

    it("accepts valid EpochMs integers", () => {
      expect(EpochMsSchema.parse(1786968000000)).toBe(1786968000000);
    });

    it("rejects negative or floating EpochMs", () => {
      expect(() => EpochMsSchema.parse(-1)).toThrow();
      expect(() => EpochMsSchema.parse(1234.56)).toThrow();
    });
  });

  describe("Sha256DigestSchema & Helpers", () => {
    const rawHex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const prefixed = `sha256:${rawHex}`;

    it("accepts raw 64-hex and sha256:<hex>", () => {
      expect(Sha256DigestSchema.parse(rawHex)).toBe(rawHex);
      expect(Sha256DigestSchema.parse(prefixed)).toBe(prefixed);
    });

    it("rejects invalid hex digests", () => {
      expect(() => Sha256DigestSchema.parse("not-a-hash")).toThrow();
      expect(() => Sha256DigestSchema.parse(rawHex.slice(0, 63))).toThrow();
    });

    it("isValidSha256 returns correct boolean", () => {
      expect(isValidSha256(rawHex)).toBe(true);
      expect(isValidSha256(prefixed)).toBe(true);
      expect(isValidSha256("xyz")).toBe(false);
    });

    it("normalizeSha256 normalizes digests correctly", () => {
      expect(normalizeSha256(prefixed, false)).toBe(rawHex);
      expect(normalizeSha256(rawHex, true)).toBe(prefixed);
      expect(() => normalizeSha256("invalid")).toThrow();
    });
  });

  describe("CausalRefSchema & RedactionMetaSchema", () => {
    it("validates causal references", () => {
      const parsed = CausalRefSchema.parse({
        parentId: "evt_001",
        rootId: "evt_root",
        causalSequence: 10,
        turnIndex: 2,
        stepIndex: 1,
        traceId: "tr_abc123",
      });
      expect(parsed.causalSequence).toBe(10);
      expect(parsed.turnIndex).toBe(2);
    });

    it("rejects negative sequence numbers", () => {
      expect(() =>
        CausalRefSchema.parse({
          causalSequence: -1,
        }),
      ).toThrow();
    });

    it("validates redaction metadata", () => {
      const parsed = RedactionMetaSchema.parse({
        isRedacted: true,
        redactedFields: ["parameters.apiKey", "content.bearerToken"],
        redactionStrategy: "mask",
        scrubbedPatterns: ["[REDACTED_API_KEY]"],
      });
      expect(parsed.isRedacted).toBe(true);
      expect(parsed.redactedFields).toHaveLength(2);
    });
  });
});
