import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonStringify,
  hashCanonical,
  hashCanonicalContent,
} from "../src/canonical.js";

describe("canonical serialization and hashing", () => {
  describe("canonicalJsonStringify / canonicalJson", () => {
    it("sorts object keys lexicographically", () => {
      const obj1 = { z: 1, a: 2, m: 3 };
      const obj2 = { a: 2, m: 3, z: 1 };
      const obj3 = { m: 3, z: 1, a: 2 };

      const serialized1 = canonicalJsonStringify(obj1);
      const serialized2 = canonicalJsonStringify(obj2);
      const serialized3 = canonicalJsonStringify(obj3);

      expect(serialized1).toBe('{"a":2,"m":3,"z":1}');
      expect(serialized1).toBe(serialized2);
      expect(serialized2).toBe(serialized3);
    });

    it("sorts deeply nested object keys", () => {
      const deep1 = {
        outerB: { innerZ: "test", innerA: 42 },
        outerA: [{ key2: "y", key1: "x" }],
      };
      const deep2 = {
        outerA: [{ key1: "x", key2: "y" }],
        outerB: { innerA: 42, innerZ: "test" },
      };

      expect(canonicalJsonStringify(deep1)).toBe(
        '{"outerA":[{"key1":"x","key2":"y"}],"outerB":{"innerA":42,"innerZ":"test"}}',
      );
      expect(canonicalJsonStringify(deep1)).toBe(canonicalJsonStringify(deep2));
    });

    it("preserves array ordering while sorting nested objects inside arrays", () => {
      const arr = [
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ];
      expect(canonicalJsonStringify(arr)).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
    });

    it("omits undefined properties in objects", () => {
      const obj = { a: 1, b: undefined, c: 3 };
      expect(canonicalJsonStringify(obj)).toBe('{"a":1,"c":3}');
    });

    it("converts undefined elements in arrays to null", () => {
      const arr = [1, undefined, 3];
      expect(canonicalJsonStringify(arr)).toBe("[1,null,3]");
    });

    it("handles primitives correctly", () => {
      expect(canonicalJsonStringify("hello")).toBe('"hello"');
      expect(canonicalJsonStringify(42)).toBe("42");
      expect(canonicalJsonStringify(true)).toBe("true");
      expect(canonicalJsonStringify(false)).toBe("false");
      expect(canonicalJsonStringify(null)).toBe("null");
      expect(canonicalJsonStringify(undefined)).toBe("undefined");
    });

    it("handles Date objects via toJSON", () => {
      const date = new Date("2026-08-17T12:00:00.000Z");
      expect(canonicalJsonStringify({ date })).toBe('{"date":"2026-08-17T12:00:00.000Z"}');
    });

    it("throws TypeError on non-finite numbers", () => {
      expect(() => canonicalJsonStringify(Number.NaN)).toThrow(TypeError);
      expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => canonicalJsonStringify({ val: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
    });

    it("throws TypeError on BigInt", () => {
      expect(() => canonicalJsonStringify({ num: BigInt(42) })).toThrow(TypeError);
    });

    it("throws TypeError on cyclic references", () => {
      type CyclicPayload = { a: number; self?: CyclicPayload };
      const cyclic: CyclicPayload = { a: 1 };
      cyclic.self = cyclic;
      expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);
    });

    it("canonicalJson is an alias of canonicalJsonStringify", () => {
      expect(canonicalJson).toBe(canonicalJsonStringify);
    });
  });

  describe("hashCanonicalContent / hashCanonical", () => {
    it("produces identical SHA-256 hashes regardless of object key order", () => {
      const a = { first: "hello", second: "world", count: 42 };
      const b = { count: 42, second: "world", first: "hello" };

      const hashA = hashCanonical(a);
      const hashB = hashCanonical(b);

      expect(hashA).toHaveLength(64);
      expect(hashA).toBe(hashB);
    });

    it("supports prefix: true option", () => {
      const obj = { key: "value" };
      const hashWithPrefix = hashCanonical(obj, { prefix: true });
      const hashWithoutPrefix = hashCanonical(obj, { prefix: false });

      expect(hashWithPrefix).toBe(`sha256:${hashWithoutPrefix}`);
    });

    it("hashCanonical is an alias of hashCanonicalContent", () => {
      expect(hashCanonical).toBe(hashCanonicalContent);
    });
  });
});
