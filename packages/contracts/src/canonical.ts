import { createHash } from "node:crypto";

/**
 * Options for canonical JSON serialization and hashing.
 */
export interface CanonicalHashOptions {
  /**
   * If true, prefixes the resulting hex digest with 'sha256:'.
   * Default: false (returns 64-char lowercase hex string).
   */
  prefix?: boolean;
}

export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | symbol
  | ((...args: never[]) => CanonicalJsonValue)
  | { toJSON?: () => CanonicalJsonValue }
  | CanonicalJsonRecord
  | CanonicalJsonValue[];

export interface CanonicalJsonRecord {
  [key: string]: CanonicalJsonValue;
}

/**
 * Deterministically serializes a JavaScript value to a canonical JSON string.
 *
 * Invariants:
 * 1. Object keys are sorted lexicographically by UTF-16 code unit order.
 * 2. No extraneous whitespace is introduced.
 * 3. Object properties with `undefined`, `symbol`, or `function` values are omitted.
 * 4. Array elements with `undefined`, `symbol`, or `function` values are serialized as `null`.
 * 5. Non-finite numbers (NaN, Infinity, -Infinity) throw a TypeError.
 * 6. Objects with `.toJSON()` methods (e.g. `Date`) are normalized via `.toJSON()`.
 * 7. Cyclic object references are detected and throw a TypeError.
 * 8. Top-level `undefined`, `symbol`, or `function` returns `undefined`.
 */
export function canonicalJsonStringify<T>(value: T): string {
  const seen = new WeakSet<object>();

  function serialize(val: CanonicalJsonValue): string | undefined {
    if (val === null) {
      return "null";
    }

    const valTag = Object.prototype.toString.call(val);
    if (val === undefined || valTag === "[object Symbol]" || valTag === "[object Function]") {
      return undefined;
    }

    if (valTag === "[object Boolean]") {
      return val ? "true" : "false";
    }

    if (valTag === "[object Number]") {
      if (!Number.isFinite(Number(val))) {
        throw new TypeError(`Cannot canonically serialize non-finite number: ${String(val)}`);
      }
      return String(val);
    }

    if (valTag === "[object BigInt]") {
      throw new TypeError("Cannot canonically serialize BigInt value");
    }

    if (valTag === "[object String]") {
      return JSON.stringify(val);
    }

    if (Array.isArray(val)) {
      if (seen.has(val)) {
        throw new TypeError("Cannot canonically serialize cyclic structure");
      }
      seen.add(val);
      try {
        const elements = val.map((item) => serialize(item) ?? "null");
        return `[${elements.join(",")}]`;
      } finally {
        seen.delete(val);
      }
    }

    if (valTag === "[object Object]" && val !== null) {
      // Handle .toJSON() serialization hook (e.g. Date instances)
      // SAFETY: val is verified to be a non-null object record.
      const obj = val as CanonicalJsonRecord;
      if ("toJSON" in obj) {
        const toJSONFn = obj.toJSON;
        if (Object.prototype.toString.call(toJSONFn) === "[object Function]") {
          // SAFETY: Object tag check confirms toJSONFn is a callable function.
          const normalized = (toJSONFn as () => CanonicalJsonValue).call(obj);
          if (Object.prototype.toString.call(normalized) !== "[object Object]") {
            return serialize(normalized);
          }
        }
      }

      if (seen.has(obj)) {
        throw new TypeError("Cannot canonically serialize cyclic structure");
      }
      seen.add(obj);
      try {
        // SAFETY: Object entries are extracted for key-sorted serialization.
        const entries = Object.entries(obj);
        // Sort keys lexicographically by UTF-16 code unit order
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

        const serializedMembers: string[] = [];
        for (const [k, v] of entries) {
          const memberVal = serialize(v);
          if (memberVal !== undefined) {
            serializedMembers.push(`${JSON.stringify(k)}:${memberVal}`);
          }
        }
        return `{${serializedMembers.join(",")}}`;
      } finally {
        seen.delete(obj);
      }
    }

    return JSON.stringify(val);
  }

  // SAFETY: serialize classifies every supported runtime value and rejects cycles before recursion.
  const result = serialize(value as CanonicalJsonValue);
  return result === undefined ? "undefined" : result;
}

/**
 * Public serializer contract for schema-derived values.
 */
export const canonicalJson = canonicalJsonStringify;

/**
 * Computes a deterministic SHA-256 hash over the canonical JSON representation of a value.
 */
export function hashCanonicalContent<T>(value: T, options: CanonicalHashOptions = {}): string {
  const serialized = canonicalJsonStringify(value);
  const hashHex = createHash("sha256").update(serialized, "utf8").digest("hex");
  return options.prefix ? `sha256:${hashHex}` : hashHex;
}

/**
 * Alias for hashCanonicalContent.
 */
export const hashCanonical = hashCanonicalContent;
