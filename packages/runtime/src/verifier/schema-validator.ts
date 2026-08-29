import type { CanonicalJsonRecord, CanonicalJsonValue, ToolManifest } from "@resin/contracts";
import type { ManifestSchemaValidationResult } from "./types.js";

/**
 * Common format validators for string types.
 */
const FORMAT_VALIDATORS = {
  email: (val: string) => /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/.test(val),
  uri: (val: string) => {
    try {
      new URL(val);
      return true;
    } catch {
      return false;
    }
  },
  url: (val: string) => {
    try {
      new URL(val);
      return true;
    } catch {
      return false;
    }
  },
  uuid: (val: string) =>
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val),
  "date-time": (val: string) => !Number.isNaN(Date.parse(val)),
  ipv4: (val: string) =>
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
      val,
    ),
  ipv6: (val: string) =>
    /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(val) ||
    /^(([0-9a-fA-F]{1,4}:){1,7}|:):((:[0-9a-fA-F]{1,4}){1,7}|:)$/.test(val),
  hostname: (val: string) =>
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(val) ||
    val === "localhost",
} as const;

/**
 * Resolves a JSON Schema reference within root document.
 */
function resolveRef(root: CanonicalJsonRecord, ref: string): CanonicalJsonRecord | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let current: CanonicalJsonValue = root;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      !(current instanceof Object) ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    // SAFETY: Checked as non-null, non-array object for record field lookup.
    const rec = current as CanonicalJsonRecord;
    current = rec[part];
  }
  // SAFETY: Checked as object record for resolved reference.
  return current instanceof Object && !Array.isArray(current)
    ? (current as CanonicalJsonRecord)
    : undefined;
}
function isFiniteNumber(val: CanonicalJsonValue | undefined): val is number {
  return Number.isFinite(val);
}

function isString(val: CanonicalJsonValue | undefined): val is string {
  return Object.prototype.toString.call(val) === "[object String]";
}

export interface PayloadValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a payload against a JSON Schema document.
 */
export function validatePayloadAgainstSchema(
  schema: CanonicalJsonValue,
  payload: CanonicalJsonValue,
  direction: "input" | "output" = "input",
  rootSchema?: CanonicalJsonValue,
  currentPath = "",
): PayloadValidationResult {
  const errors: string[] = [];

  if (schema === true || schema === undefined || schema === null) {
    return { valid: true, errors: [] };
  }
  if (schema === false) {
    errors.push(`Schema at '${currentPath || "root"}' is 'false' (rejects all payloads)`);
    return { valid: false, errors };
  }

  if (!(schema instanceof Object) || Array.isArray(schema)) {
    return { valid: true, errors: [] };
  }
  // SAFETY: Checked as non-array object for JSON schema record traversal.
  const s = schema as CanonicalJsonRecord;
  // SAFETY: Checked as object record for root schema fallback.
  const root: CanonicalJsonRecord =
    rootSchema && rootSchema instanceof Object && !Array.isArray(rootSchema)
      ? (rootSchema as CanonicalJsonRecord)
      : s;
  // Handle $ref
  if (isString(s.$ref)) {
    const resolved = resolveRef(root, s.$ref);
    if (!resolved) {
      errors.push(`Unresolvable $ref '${s.$ref}' at '${currentPath || "root"}'`);
      return { valid: false, errors };
    }
    return validatePayloadAgainstSchema(resolved, payload, direction, root, currentPath);
  }

  // Handle allOf
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      const subRes = validatePayloadAgainstSchema(sub, payload, direction, root, currentPath);
      if (!subRes.valid) {
        errors.push(...subRes.errors);
      }
    }
    if (errors.length > 0) {
      return { valid: false, errors };
    }
  }

  // Handle anyOf
  if (Array.isArray(s.anyOf)) {
    const anyOfErrors: string[][] = [];
    let anyPassed = false;
    for (const sub of s.anyOf) {
      const subRes = validatePayloadAgainstSchema(sub, payload, direction, root, currentPath);
      if (subRes.valid) {
        anyPassed = true;
        break;
      }
      anyOfErrors.push(subRes.errors);
    }
    if (!anyPassed) {
      errors.push(
        `Payload at '${currentPath || "root"}' failed all anyOf schemas: ${anyOfErrors.flat().join("; ")}`,
      );
      return { valid: false, errors };
    }
  }

  // Handle oneOf
  if (Array.isArray(s.oneOf)) {
    let matchCount = 0;
    const oneOfErrors: string[][] = [];
    for (const sub of s.oneOf) {
      const subRes = validatePayloadAgainstSchema(sub, payload, direction, root, currentPath);
      if (subRes.valid) {
        matchCount++;
      } else {
        oneOfErrors.push(subRes.errors);
      }
    }
    if (matchCount !== 1) {
      errors.push(
        `Payload at '${currentPath || "root"}' matched ${matchCount} schemas in oneOf (expected exactly 1)`,
      );
      return { valid: false, errors };
    }
  }

  // Handle not
  if (s.not !== undefined && s.not !== null && s.not instanceof Object) {
    // SAFETY: s.not is validated as non-null object for schema validation.
    const notRes = validatePayloadAgainstSchema(
      s.not as CanonicalJsonValue,
      payload,
      direction,
      root,
      currentPath,
    );
    if (notRes.valid) {
      errors.push(`Payload at '${currentPath || "root"}' matched forbidden 'not' schema`);
      return { valid: false, errors };
    }
  }

  // Handle enum
  if (Array.isArray(s.enum)) {
    const match = s.enum.some((val) => JSON.stringify(val) === JSON.stringify(payload));
    if (!match) {
      errors.push(
        `Value at '${currentPath || "root"}' is not in enum [${s.enum.map((e) => JSON.stringify(e)).join(", ")}]`,
      );
    }
  }

  // Handle const
  if (s.const !== undefined) {
    if (JSON.stringify(s.const) !== JSON.stringify(payload)) {
      errors.push(
        `Value at '${currentPath || "root"}' must equal const ${JSON.stringify(s.const)}`,
      );
    }
  }

  // Type validation
  if (s.type) {
    const allowedTypes: string[] = Array.isArray(s.type)
      ? s.type.filter(isString)
      : isString(s.type)
        ? [s.type]
        : [];
    let matchesType = false;

    for (const t of allowedTypes) {
      if (t === "null" && payload === null) matchesType = true;
      if (t === "boolean" && (payload === true || payload === false)) matchesType = true;
      if (t === "number" && Number.isFinite(payload)) matchesType = true;
      if (t === "integer" && Number.isInteger(payload)) matchesType = true;
      if (t === "string" && isString(payload)) matchesType = true;
      if (t === "array" && Array.isArray(payload)) matchesType = true;
      if (
        t === "object" &&
        payload !== null &&
        payload instanceof Object &&
        !Array.isArray(payload)
      ) {
        matchesType = true;
      }
    }

    if (allowedTypes.length > 0 && !matchesType) {
      errors.push(
        `Expected type '${allowedTypes.join(" | ")}' at '${currentPath || "root"}', got ${
          payload === null
            ? "null"
            : Array.isArray(payload)
              ? "array"
              : Number.isFinite(payload)
                ? "number"
                : isString(payload)
                  ? "string"
                  : payload === true || payload === false
                    ? "boolean"
                    : payload instanceof Object
                      ? "object"
                      : "unknown"
        }`,
      );
      return { valid: false, errors };
    }
  }

  // String validation
  if (isString(payload)) {
    if (isFiniteNumber(s.minLength) && payload.length < s.minLength) {
      errors.push(`String at '${currentPath || "root"}' is shorter than minLength ${s.minLength}`);
    }
    if (isFiniteNumber(s.maxLength) && payload.length > s.maxLength) {
      errors.push(`String at '${currentPath || "root"}' is longer than maxLength ${s.maxLength}`);
    }
    if (isString(s.pattern)) {
      try {
        const regex = new RegExp(s.pattern);
        if (!regex.test(payload)) {
          errors.push(`String at '${currentPath || "root"}' does not match pattern '${s.pattern}'`);
        }
      } catch {
        // Invalid regex in schema is ignored during runtime validation
      }
    }
    if (isString(s.format) && s.format in FORMAT_VALIDATORS) {
      // SAFETY: s.format is checked against FORMAT_VALIDATORS keys.
      const validator = FORMAT_VALIDATORS[s.format as keyof typeof FORMAT_VALIDATORS];
      if (!validator(payload)) {
        errors.push(`String at '${currentPath || "root"}' is not a valid format '${s.format}'`);
      }
    }
  }

  // Number validation
  if (isFiniteNumber(payload)) {
    const num = payload;
    if (isFiniteNumber(s.minimum) && num < s.minimum) {
      errors.push(`Number at '${currentPath || "root"}' must be >= ${s.minimum}`);
    }
    if (isFiniteNumber(s.maximum) && num > s.maximum) {
      errors.push(`Number at '${currentPath || "root"}' must be <= ${s.maximum}`);
    }
    if (isFiniteNumber(s.exclusiveMinimum) && num <= s.exclusiveMinimum) {
      errors.push(`Number at '${currentPath || "root"}' must be > ${s.exclusiveMinimum}`);
    }
    if (isFiniteNumber(s.exclusiveMaximum) && num >= s.exclusiveMaximum) {
      errors.push(`Number at '${currentPath || "root"}' must be < ${s.exclusiveMaximum}`);
    }
    if (isFiniteNumber(s.multipleOf) && s.multipleOf > 0) {
      const quotient = num / s.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-10) {
        errors.push(`Number at '${currentPath || "root"}' must be a multiple of ${s.multipleOf}`);
      }
    }
  }

  // Array validation
  if (Array.isArray(payload)) {
    if (isFiniteNumber(s.minItems) && payload.length < s.minItems) {
      errors.push(
        `Array at '${currentPath || "root"}' has fewer items than minItems ${s.minItems}`,
      );
    }
    if (isFiniteNumber(s.maxItems) && payload.length > s.maxItems) {
      errors.push(`Array at '${currentPath || "root"}' has more items than maxItems ${s.maxItems}`);
    }
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of payload) {
        const repr = JSON.stringify(item);
        if (seen.has(repr)) {
          errors.push(
            `Array at '${currentPath || "root"}' contains duplicate items (uniqueItems: true)`,
          );
          break;
        }
      }
    }
    if (s.items !== undefined) {
      for (let i = 0; i < payload.length; i++) {
        const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
        // SAFETY: s.items is defined JSON schema value.
        const itemRes = validatePayloadAgainstSchema(
          s.items as CanonicalJsonValue,
          payload[i],
          direction,
          root,
          itemPath,
        );
        if (!itemRes.valid) {
          errors.push(...itemRes.errors);
        }
      }
    }
  }

  // Object validation
  if (payload !== null && payload instanceof Object && !Array.isArray(payload)) {
    // SAFETY: Verified non-null, non-array object for payload record fields.
    const payloadObj = payload as CanonicalJsonRecord;
    // SAFETY: Checked as object record for properties definition map.
    const properties: CanonicalJsonRecord =
      s.properties !== null && s.properties instanceof Object && !Array.isArray(s.properties)
        ? (s.properties as CanonicalJsonRecord)
        : {};
    const required: string[] = Array.isArray(s.required) ? s.required.filter(isString) : [];

    // Check required properties
    for (const reqKey of required) {
      if (!(reqKey in payloadObj) || payloadObj[reqKey] === undefined) {
        errors.push(`Missing required property '${reqKey}' at '${currentPath || "root"}'`);
      }
    }

    // Check declared properties
    for (const [propKey, propSchema] of Object.entries(properties)) {
      if (propKey in payloadObj && payloadObj[propKey] !== undefined) {
        const propPath = currentPath ? `${currentPath}.${propKey}` : propKey;
        const propRes = validatePayloadAgainstSchema(
          propSchema,
          payloadObj[propKey],
          direction,
          root,
          propPath,
        );
        if (!propRes.valid) {
          errors.push(...propRes.errors);
        }
      }
    }

    // Check additionalProperties
    if (s.additionalProperties === false) {
      for (const key of Object.keys(payloadObj)) {
        if (!(key in properties)) {
          errors.push(
            `Unexpected additional property '${key}' at '${currentPath || "root"}' (additionalProperties: false)`,
          );
        }
      }
    } else if (
      s.additionalProperties !== undefined &&
      s.additionalProperties !== null &&
      s.additionalProperties instanceof Object
    ) {
      for (const [key, val] of Object.entries(payloadObj)) {
        if (!(key in properties)) {
          const addPath = currentPath ? `${currentPath}.${key}` : key;
          // SAFETY: s.additionalProperties is defined schema value.
          const addRes = validatePayloadAgainstSchema(
            s.additionalProperties as CanonicalJsonValue,
            val,
            direction,
            root,
            addPath,
          );
          if (!addRes.valid) {
            errors.push(...addRes.errors);
          }
        }
      }
    }

    if (isFiniteNumber(s.minProperties) && Object.keys(payloadObj).length < s.minProperties) {
      errors.push(
        `Object at '${currentPath || "root"}' has fewer properties than minProperties ${s.minProperties}`,
      );
    }
    if (isFiniteNumber(s.maxProperties) && Object.keys(payloadObj).length > s.maxProperties) {
      errors.push(
        `Object at '${currentPath || "root"}' has more properties than maxProperties ${s.maxProperties}`,
      );
    }
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates manifest schemas (parameters/inputSchema and outputSchema).
 */
export function validateManifestSchemas(manifest: ToolManifest): ManifestSchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const inputSchema = manifest.parameters;
  if (inputSchema && inputSchema instanceof Object && !Array.isArray(inputSchema)) {
    if (inputSchema.type !== undefined && inputSchema.type !== "object") {
      errors.push("Tool input schema must be of type 'object'.");
    }
    if (
      inputSchema.type === "object" &&
      inputSchema.properties !== undefined &&
      (inputSchema.properties === null ||
        !(inputSchema.properties instanceof Object) ||
        Array.isArray(inputSchema.properties))
    ) {
      errors.push("Tool input schema 'properties' must be an object.");
    }
  }

  if (
    manifest.outputSchema &&
    manifest.outputSchema instanceof Object &&
    !Array.isArray(manifest.outputSchema)
  ) {
    if (manifest.outputSchema.type !== undefined && manifest.outputSchema.type !== "object") {
      errors.push("Tool output schema must be of type 'object'.");
    }
    if (
      manifest.outputSchema.type === "object" &&
      manifest.outputSchema.properties !== undefined &&
      (manifest.outputSchema.properties === null ||
        !(manifest.outputSchema.properties instanceof Object) ||
        Array.isArray(manifest.outputSchema.properties))
    ) {
      errors.push("Tool output schema 'properties' must be an object.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
