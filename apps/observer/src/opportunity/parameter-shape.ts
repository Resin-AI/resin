import { hashCanonicalContent } from "@resin/contracts";

export const RESIN_PARAMETER_SHAPE_KEY = "__resinParameterShapeV1";

export type ParameterShapePrimitive =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "opaque";

export type ParameterShapeDescriptor =
  | ParameterShapePrimitive
  | [ParameterShapeDescriptor]
  | []
  | { [key: string]: ParameterShapeDescriptor };

export type ParameterShapeRecord = Record<string, ParameterShapeDescriptor>;

export interface ParameterShapeParseOptions {
  /** Maximum nesting depth for parameter shape structures (default: 4) */
  maxDepth?: number;
  /** Maximum number of keys per object level (default: 32) */
  maxKeys?: number;
  /** Maximum character length for property names (default: 64) */
  maxKeyLength?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_KEYS = 32;
const DEFAULT_MAX_KEY_LENGTH = 64;
const BLOCKED_PROPERTIES: Readonly<Record<string, true>> = Object.fromEntries(
  ["__proto__", "constructor", "prototype", RESIN_PARAMETER_SHAPE_KEY].map((key) => [
    key,
    true as const,
  ]),
);

const VALID_PRIMITIVE_KINDS: Record<string, true> = {
  string: true,
  number: true,
  boolean: true,
  null: true,
  undefined: true,
  opaque: true,
};

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

function validateDescriptor(
  desc: unknown,
  depth: number,
  ancestors: Set<object>,
  options: Required<ParameterShapeParseOptions>,
): ParameterShapeDescriptor | undefined {
  if (depth > options.maxDepth) {
    return undefined;
  }

  if (typeof desc === "string") {
    if (VALID_PRIMITIVE_KINDS[desc] === true) {
      return desc as ParameterShapePrimitive;
    }
    return undefined;
  }

  if (Array.isArray(desc)) {
    if (desc.length === 0) {
      return [];
    }
    if (desc.length === 1) {
      if (ancestors.has(desc)) {
        return undefined;
      }
      ancestors.add(desc);
      const inner = validateDescriptor(desc[0], depth + 1, ancestors, options);
      ancestors.delete(desc);
      if (inner === undefined) {
        return undefined;
      }
      return [inner];
    }
    return undefined;
  }

  if (isPlainObject(desc)) {
    if (ancestors.has(desc)) {
      return undefined;
    }
    ancestors.add(desc);
    const rawKeys = Object.keys(desc);
    if (rawKeys.length > options.maxKeys) {
      ancestors.delete(desc);
      return undefined;
    }
    const result: Record<string, ParameterShapeDescriptor> = {};
    for (const key of rawKeys) {
      if (BLOCKED_PROPERTIES[key] === true) {
        ancestors.delete(desc);
        return undefined;
      }
      if (key.length === 0 || key.length > options.maxKeyLength) {
        ancestors.delete(desc);
        return undefined;
      }
      const val = desc[key];
      const validVal = validateDescriptor(val, depth + 1, ancestors, options);
      if (validVal === undefined) {
        ancestors.delete(desc);
        return undefined;
      }
      result[key] = validVal;
    }
    ancestors.delete(desc);
    return result;
  }

  return undefined;
}

/**
 * Checks whether an object contains the reserved parameter shape envelope key.
 */
export function hasParameterShapeEnvelope(parameters: unknown): boolean {
  if (
    parameters === null ||
    parameters === undefined ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(parameters, RESIN_PARAMETER_SHAPE_KEY);
}

/**
 * Strict fail-closed parser for `__resinParameterShapeV1`.
 * Recognizes bounded descriptors only:
 * - Primitive kinds: string, number, boolean, null, undefined, opaque
 * - Arrays: length 0 or length 1 element descriptor
 * - Objects: plain records with non-blocked keys
 *
 * Rejects and returns undefined for unknown tags, circular structures,
 * blocked/prototype keys, depth violations, key count violations, or malformed shapes.
 */
export function parseParameterShapeEnvelope(
  parameters: unknown,
  options: ParameterShapeParseOptions = {},
): ParameterShapeRecord | undefined {
  if (
    parameters === null ||
    parameters === undefined ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    !isPlainObject(parameters)
  ) {
    return undefined;
  }

  if (!Object.prototype.hasOwnProperty.call(parameters, RESIN_PARAMETER_SHAPE_KEY)) {
    return undefined;
  }

  const envelope = parameters[RESIN_PARAMETER_SHAPE_KEY];
  if (
    envelope === null ||
    envelope === undefined ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    !isPlainObject(envelope)
  ) {
    return undefined;
  }

  const fullOptions: Required<ParameterShapeParseOptions> = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxKeys: options.maxKeys ?? DEFAULT_MAX_KEYS,
    maxKeyLength: options.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH,
  };

  const ancestors = new Set<object>();
  const validated = validateDescriptor(envelope, 0, ancestors, fullOptions);
  if (validated !== undefined && isPlainObject(validated)) {
    return validated as ParameterShapeRecord;
  }
  return undefined;
}

/**
 * Canonically sorts and normalizes a parameter shape descriptor.
 */
export function canonicalizeParameterShape(shape: ParameterShapeDescriptor): unknown {
  if (typeof shape === "string") {
    return shape;
  }
  if (Array.isArray(shape)) {
    if (shape.length === 0) return [];
    return [canonicalizeParameterShape(shape[0]!)];
  }
  if (typeof shape === "object" && shape !== null) {
    const sortedKeys = Object.keys(shape).sort();
    const result: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      result[k] = canonicalizeParameterShape(
        (shape as Record<string, ParameterShapeDescriptor>)[k]!,
      );
    }
    return result;
  }
  return "opaque";
}

/**
 * Computes a deterministic canonical argument profile hash for a recognized parameter shape.
 */
export function extractShapeArgumentProfile(shape: ParameterShapeRecord): string {
  const canonical = canonicalizeParameterShape(shape);
  return hashCanonicalContent({ shape: canonical });
}
