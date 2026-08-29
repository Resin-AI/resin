import { describe, expect, it } from "vitest";
import { canonicalJsonStringify, hashCanonical } from "../src/canonical.js";
import { ISOTimestampSchema, IdentifierSchema } from "../src/common.js";

describe("fuzz and boundary tests", () => {
  type FuzzObjectValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | FuzzObjectRecord
    | FuzzObjectValue[];

  interface FuzzObjectRecord {
    [key: string]: FuzzObjectValue;
  }

  // Helper to shuffle object keys
  function shuffleKeys(obj: FuzzObjectRecord): FuzzObjectRecord {
    const keys = Object.keys(obj);
    const shuffled: FuzzObjectRecord = {};
    const randomizedKeys = [...keys].sort(() => Math.random() - 0.5);
    for (const key of randomizedKeys) {
      const val = obj[key];
      if (
        val !== null &&
        Object.prototype.toString.call(val) === "[object Object]" &&
        !Array.isArray(val)
      ) {
        // SAFETY: Nested object is confirmed to be an object dictionary before recursion.
        shuffled[key] = shuffleKeys(val as FuzzObjectRecord);
      } else {
        shuffled[key] = val;
      }
    }
    return shuffled;
  }

  describe("Canonical Hash Determinism under Key Permutations", () => {
    it("produces invariant hash across 100 randomized key permutations", () => {
      const complexObject = {
        zeta: 100,
        alpha: "first",
        nested: {
          gamma: true,
          beta: [1, 2, { deepB: "y", deepA: "x" }],
          delta: { x: 10, a: 20, m: 30 },
        },
        payload: {
          str: "hello\nworld\t\u0000 special chars",
          num: 123456.789,
          flag: false,
          emptyArr: [],
          emptyObj: {},
        },
      };

      const baselineHash = hashCanonical(complexObject);
      const baselineJson = canonicalJsonStringify(complexObject);

      for (let i = 0; i < 100; i++) {
        const shuffled = shuffleKeys(complexObject);
        const shuffledJson = canonicalJsonStringify(shuffled);
        const shuffledHash = hashCanonical(shuffled);

        expect(shuffledJson).toBe(baselineJson);
        expect(shuffledHash).toBe(baselineHash);
      }
    });
  });

  describe("Boundary Strings & Characters", () => {
    it("handles Unicode characters and escape sequences properly", () => {
      const sample = {
        emoji: "🚀🔍🛠️",
        crlf: "line1\r\nline2\nline3",
        quotes: 'He said "Hello" and \\ backslashes',
        nullByte: "zero\u0000byte",
      };

      const str = canonicalJsonStringify(sample);
      const parsed = JSON.parse(str);
      expect(parsed).toEqual(sample);
    });

    it("validates boundary identifiers", () => {
      // 1 char valid
      expect(IdentifierSchema.parse("a")).toBe("a");
      // 128 chars valid
      const maxId = "a".repeat(128);
      expect(IdentifierSchema.parse(maxId)).toBe(maxId);
      // 129 chars invalid
      expect(() => IdentifierSchema.parse("a".repeat(129))).toThrow();
    });

    it("handles ISO-8601 with fractional seconds and timezone offsets", () => {
      expect(ISOTimestampSchema.parse("2026-08-17T12:00:00Z")).toBe("2026-08-17T12:00:00Z");
      expect(ISOTimestampSchema.parse("2026-08-17T12:00:00.123456Z")).toBe(
        "2026-08-17T12:00:00.123456Z",
      );
      expect(ISOTimestampSchema.parse("2026-08-17T14:00:00+02:00")).toBe(
        "2026-08-17T14:00:00+02:00",
      );
    });
  });
});
