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
export function canonicalJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  function serialize(val: unknown): string | undefined {
    if (val === null) {
      return "null";
    }

    if (val === undefined || typeof val === "symbol" || typeof val === "function") {
      return undefined;
    }

    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }

    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new TypeError(`Cannot canonically serialize non-finite number: ${val}`);
      }
      return JSON.stringify(val);
    }

    if (typeof val === "string") {
      return JSON.stringify(val);
    }

    if (typeof val === "bigint") {
      throw new TypeError("Cannot canonically serialize BigInt without explicit conversion");
    }

    if (typeof val === "object") {
      // Invoke toJSON() if available (handles Date, custom wrappers)
      const toJSONObj = val as { toJSON?: () => unknown };
      if (typeof toJSONObj.toJSON === "function") {
        return serialize(toJSONObj.toJSON());
      }

      if (seen.has(val)) {
        throw new TypeError("Cyclic reference detected during canonical JSON serialization");
      }
      seen.add(val);

      try {
        if (Array.isArray(val)) {
          const serializedElements: string[] = [];
          for (let i = 0; i < val.length; i++) {
            const itemStr = serialize(val[i]);
            serializedElements.push(itemStr === undefined ? "null" : itemStr);
          }
          return `[${serializedElements.join(",")}]`;
        }

        // Plain object: sort keys lexicographically
        const keys = Object.keys(val).sort();
        const entries: string[] = [];

        for (const key of keys) {
          const propVal = (val as Record<string, unknown>)[key];
          const serializedProp = serialize(propVal);
          if (serializedProp !== undefined) {
            entries.push(`${JSON.stringify(key)}:${serializedProp}`);
          }
        }

        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(val);
      }
    }

    throw new TypeError(`Unsupported data type encountered: ${typeof val}`);
  }

  const result = serialize(value);
  return result === undefined ? "undefined" : result;
}

/**
 * Alias for canonicalJsonStringify.
 */
export const canonicalJson = canonicalJsonStringify;

/**
 * Computes a deterministic SHA-256 hash over the canonical JSON representation of a value.
 */
export function hashCanonicalContent(value: unknown, options: CanonicalHashOptions = {}): string {
  const serialized = canonicalJsonStringify(value);
  const hashHex = createHash("sha256").update(serialized, "utf8").digest("hex");
  return options.prefix ? `sha256:${hashHex}` : hashHex;
}

/**
 * Alias for hashCanonicalContent.
 */
export const hashCanonical = hashCanonicalContent;
