import { describe, expect, it } from "vitest";
import {
  type InvocationRecord,
  InvocationRecordSchema,
  InvocationUsageEstimateSchema,
  TOOL_IO_UTF8_METHOD,
  bytesToTokens,
  createUsageEstimate,
  estimatePayloadBytes,
  estimatePayloadTokens,
} from "../src/records.js";

describe("Deterministic Tool-I/O Usage Estimator (UTF-8)", () => {
  describe("estimatePayloadBytes & bytesToTokens", () => {
    it("computes accurate UTF-8 bytes for ASCII strings", () => {
      expect(estimatePayloadBytes("")).toBe(0);
      expect(bytesToTokens(0)).toBe(0);

      expect(estimatePayloadBytes("a")).toBe(1);
      expect(bytesToTokens(1)).toBe(1); // ceil(1/4) = 1

      expect(estimatePayloadBytes("1234")).toBe(4);
      expect(bytesToTokens(4)).toBe(1); // ceil(4/4) = 1

      expect(estimatePayloadBytes("12345")).toBe(5);
      expect(bytesToTokens(5)).toBe(2); // ceil(5/4) = 2
    });

    it("computes accurate UTF-8 bytes for multi-byte Unicode (Japanese, Cyrillic, Emoji)", () => {
      // Greek 2-byte characters: αβγ = 6 bytes
      const greek = "αβγ";
      expect(estimatePayloadBytes(greek)).toBe(6);
      expect(bytesToTokens(6)).toBe(2); // ceil(6/4) = 2

      // Japanese 3-byte characters: こんにちは = 5 * 3 = 15 bytes
      const japanese = "こんにちは";
      expect(estimatePayloadBytes(japanese)).toBe(15);
      expect(bytesToTokens(15)).toBe(4); // ceil(15/4) = 4

      // Emojis 4-byte characters: 🚀 = 4 bytes, 🚀🛸 = 8 bytes
      const emojis = "🚀🛸";
      expect(estimatePayloadBytes(emojis)).toBe(8);
      expect(bytesToTokens(8)).toBe(2); // ceil(8/4) = 2
    });

    it("computes canonical JSON UTF-8 byte lengths for objects and arrays", () => {
      // Empty object: "{}" = 2 bytes => 1 token
      expect(estimatePayloadBytes({})).toBe(2);
      expect(estimatePayloadTokens({})).toBe(1);

      // Empty array: "[]" = 2 bytes => 1 token
      expect(estimatePayloadBytes([])).toBe(2);
      expect(estimatePayloadTokens([])).toBe(1);

      // Canonical key sorting: { b: 2, a: 1 } => '{"a":1,"b":2}' = 13 bytes => 4 tokens
      const obj = { b: 2, a: 1 };
      expect(estimatePayloadBytes(obj)).toBe(13);
      expect(estimatePayloadTokens(obj)).toBe(4); // ceil(13/4) = 4
    });

    it("distinguishes missing undefined from valid JSON null (null is 4 bytes => 1 token)", () => {
      expect(estimatePayloadBytes(undefined)).toBeUndefined();
      expect(estimatePayloadTokens(undefined)).toBeUndefined();

      // JSON null is valid serializable value: "null" = 4 UTF-8 bytes => 1 token
      expect(estimatePayloadBytes(null)).toBe(4);
      expect(estimatePayloadTokens(null)).toBe(1);

      // Circular reference throws in serialization => returns undefined
      const circular: Record<string, unknown> = { key: "value" };
      circular.self = circular;
      expect(estimatePayloadBytes(circular)).toBeUndefined();
      expect(estimatePayloadTokens(circular)).toBeUndefined();

      // BigInt throws TypeError in JSON serialization => returns undefined
      expect(estimatePayloadBytes({ val: BigInt(999999999) })).toBeUndefined();
      expect(estimatePayloadTokens({ val: BigInt(999999999) })).toBeUndefined();

      // Functions serialize to undefined top-level
      expect(estimatePayloadBytes(() => {})).toBeUndefined();
      expect(estimatePayloadTokens(() => {})).toBeUndefined();
    });

    it("rejects invalid inputs to bytesToTokens instead of faking zero", () => {
      expect(() => bytesToTokens(-1)).toThrow(TypeError);
      expect(() => bytesToTokens(-0.5)).toThrow(TypeError);
      expect(() => bytesToTokens(Number.NaN)).toThrow(TypeError);
      expect(() => bytesToTokens(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => bytesToTokens(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
      expect(() => bytesToTokens(2.5)).toThrow(TypeError);
      expect(() => bytesToTokens(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
      expect(() => bytesToTokens("4" as unknown as number)).toThrow(TypeError);
    });
  });

  describe("createUsageEstimate", () => {
    it("creates valid estimate when input and output tokens are finite nonnegative integers", () => {
      const estimate = createUsageEstimate({
        inputTokens: 10,
        outputTokens: 25,
        discoveryTokens: 5,
      });
      expect(estimate).toEqual({
        method: "tool_io_utf8_v1",
        inputTokens: 10,
        outputTokens: 25,
        discoveryTokens: 5,
        totalTokens: 40,
      });

      // Validates against Zod schema
      expect(InvocationUsageEstimateSchema.parse(estimate)).toEqual(estimate);
    });

    it("defaults discoveryTokens to 0 when omitted", () => {
      const estimate = createUsageEstimate({
        inputTokens: 12,
        outputTokens: 8,
      });
      expect(estimate).toEqual({
        method: "tool_io_utf8_v1",
        inputTokens: 12,
        outputTokens: 8,
        discoveryTokens: 0,
        totalTokens: 20,
      });
    });

    it("returns undefined if inputTokens or outputTokens are undefined (missing payload => absent)", () => {
      expect(createUsageEstimate({ inputTokens: undefined, outputTokens: 10 })).toBeUndefined();
      expect(createUsageEstimate({ inputTokens: 10, outputTokens: undefined })).toBeUndefined();
      expect(
        createUsageEstimate({ inputTokens: undefined, outputTokens: undefined }),
      ).toBeUndefined();
    });

    it("returns undefined for negative or non-finite token numbers", () => {
      expect(createUsageEstimate({ inputTokens: -1, outputTokens: 10 })).toBeUndefined();
      expect(createUsageEstimate({ inputTokens: 10, outputTokens: -5 })).toBeUndefined();
      expect(
        createUsageEstimate({ inputTokens: 10, outputTokens: 10, discoveryTokens: -2 }),
      ).toBeUndefined();
      expect(createUsageEstimate({ inputTokens: Number.NaN, outputTokens: 10 })).toBeUndefined();
      expect(
        createUsageEstimate({ inputTokens: 10, outputTokens: Number.POSITIVE_INFINITY }),
      ).toBeUndefined();
    });

    it("rejects invalid fractional tokens rather than flooring them", () => {
      expect(createUsageEstimate({ inputTokens: 10.5, outputTokens: 20 })).toBeUndefined();
      expect(createUsageEstimate({ inputTokens: 10, outputTokens: 20.25 })).toBeUndefined();
      expect(
        createUsageEstimate({ inputTokens: 10, outputTokens: 20, discoveryTokens: 5.5 }),
      ).toBeUndefined();
    });

    it("rejects numbers exceeding safe integer bounds", () => {
      expect(
        createUsageEstimate({
          inputTokens: Number.MAX_SAFE_INTEGER + 1,
          outputTokens: 10,
        }),
      ).toBeUndefined();
      expect(
        createUsageEstimate({
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 1,
        }),
      ).toBeUndefined();
    });
  });

  describe("InvocationUsageEstimateSchema validation", () => {
    it("accepts strictly conforming objects", () => {
      const valid = {
        method: TOOL_IO_UTF8_METHOD,
        inputTokens: 100,
        outputTokens: 200,
        discoveryTokens: 50,
        totalTokens: 350,
      };
      expect(InvocationUsageEstimateSchema.parse(valid)).toEqual(valid);
    });

    it("rejects mismatched totalTokens (total !== sum)", () => {
      const invalid = {
        method: TOOL_IO_UTF8_METHOD,
        inputTokens: 10,
        outputTokens: 20,
        discoveryTokens: 0,
        totalTokens: 999, // Mismatched
      };
      expect(() => InvocationUsageEstimateSchema.parse(invalid)).toThrow(
        /totalTokens must equal sum/,
      );
    });

    it("rejects non-integer or negative numbers", () => {
      expect(() =>
        InvocationUsageEstimateSchema.parse({
          method: TOOL_IO_UTF8_METHOD,
          inputTokens: 10.5,
          outputTokens: 20,
          discoveryTokens: 0,
          totalTokens: 30.5,
        }),
      ).toThrow();

      expect(() =>
        InvocationUsageEstimateSchema.parse({
          method: TOOL_IO_UTF8_METHOD,
          inputTokens: -1,
          outputTokens: 10,
          discoveryTokens: 0,
          totalTokens: 9,
        }),
      ).toThrow();
    });

    it("rejects numbers exceeding Number.MAX_SAFE_INTEGER (safe bounds)", () => {
      const outOfBounds = Number.MAX_SAFE_INTEGER + 1000;
      expect(() =>
        InvocationUsageEstimateSchema.parse({
          method: TOOL_IO_UTF8_METHOD,
          inputTokens: outOfBounds,
          outputTokens: 0,
          discoveryTokens: 0,
          totalTokens: outOfBounds,
        }),
      ).toThrow();
    });

    it("rejects unexpected method tag", () => {
      expect(() =>
        InvocationUsageEstimateSchema.parse({
          method: "model_billed_v1",
          inputTokens: 10,
          outputTokens: 20,
          discoveryTokens: 0,
          totalTokens: 30,
        }),
      ).toThrow();
    });
  });

  describe("InvocationRecordSchema backward compatibility", () => {
    const baseRecord = {
      invocationId: "inv_01j7db4n000000000000000001",
      sessionId: "ses_01j7db4n000000000000000001",
      workspaceId: "ws_01j7db4n000000000000000001",
      toolId: "tool_test",
      toolVersion: "1.0.0",
      startedAt: "2026-08-17T14:05:00.000Z",
      completedAt: "2026-08-17T14:05:01.000Z",
      durationMs: 1000,
      status: "success" as const,
      inputDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      outputDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    };

    it("parses older records without usageEstimate as undefined (clean compatibility)", () => {
      const parsed = InvocationRecordSchema.parse(baseRecord);
      expect(parsed.usageEstimate).toBeUndefined();
    });

    it("parses records with valid usageEstimate", () => {
      const recordWithUsage: InvocationRecord = {
        ...baseRecord,
        usageEstimate: {
          method: "tool_io_utf8_v1",
          inputTokens: 15,
          outputTokens: 40,
          discoveryTokens: 10,
          totalTokens: 65,
        },
      };
      const parsed = InvocationRecordSchema.parse(recordWithUsage);
      expect(parsed.usageEstimate).toEqual({
        method: "tool_io_utf8_v1",
        inputTokens: 15,
        outputTokens: 40,
        discoveryTokens: 10,
        totalTokens: 65,
      });
    });
  });
});
