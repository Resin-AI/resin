import type { ToolManifest } from "@resin/contracts";
import type { ManifestSchemaValidationResult } from "./types.js";

/**
 * Common format validators for string types.
 */
const FORMAT_VALIDATORS: Record<string, (val: string) => boolean> = {
  email: (val) => /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/.test(val),
  uri: (val) => {
    try {
      new URL(val);
      return true;
    } catch {
      return false;
    }
  },
  url: (val) => {
    try {
      new URL(val);
      return true;
    } catch {
      return false;
    }
  },
  "date-time": (val) => !Number.isNaN(Date.parse(val)) && val.includes("T"),
  date: (val) => /^\d{4}-\d{2}-\d{2}$/.test(val) && !Number.isNaN(Date.parse(val)),
  uuid: (val) =>
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      val,
    ),
  ipv4: (val) => {
    const parts = val.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => {
      const num = Number(p);
      return Number.isInteger(num) && num >= 0 && num <= 255 && p === String(num);
    });
  },
  ipv6: (val) =>
    /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(val) ||
    /^(([0-9a-fA-F]{1,4}:){1,7}|:):((:[0-9a-fA-F]{1,4}){1,7}|:)$/.test(val),
  hostname: (val) =>
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(val) ||
    val === "localhost",
};

/**
 * Resolves a JSON Schema reference within root document.
 */
function resolveRef(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    const rec = current as Record<string, unknown>;
    current = rec[part];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : undefined;
}

/**
 * Validates payload against a JSON schema.
 */
export function validatePayloadAgainstSchema(
  schema: unknown,
  payload: unknown,
  direction: "input" | "output" = "input",
  rootSchema?: unknown,
  currentPath = "",
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (schema === undefined || schema === null || schema === true) {
    return { valid: true, errors: [] };
  }

  if (schema === false) {
    return {
      valid: false,
      errors: [`${direction} value at '${currentPath || "root"}' rejected by schema (false)`],
    };
  }

  if (typeof schema !== "object" || schema === null) {
    return { valid: true, errors: [] };
  }

  const s = schema as Record<string, unknown>;
  const root = (rootSchema && typeof rootSchema === "object" ? rootSchema : s) as Record<
    string,
    unknown
  >;

  // Handle $ref
  if (typeof s.$ref === "string") {
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

  // Handle oneOf
  if (Array.isArray(s.oneOf)) {
    let matchCount = 0;
    const subErrors: string[] = [];
    for (const sub of s.oneOf) {
      const subRes = validatePayloadAgainstSchema(sub, payload, direction, root, currentPath);
      if (subRes.valid) {
        matchCount++;
      } else {
        subErrors.push(subRes.errors.join("; "));
      }
    }
    if (matchCount !== 1) {
      errors.push(
        `Expected exactly one sub-schema in oneOf to match at '${currentPath || "root"}', but matched ${matchCount}. Errors: [${subErrors.join(", ")}]`,
      );
      return { valid: false, errors };
    }
  }

  // Handle anyOf
  if (Array.isArray(s.anyOf)) {
    const anyMatches = s.anyOf.some(
      (sub) => validatePayloadAgainstSchema(sub, payload, direction, root, currentPath).valid,
    );
    if (!anyMatches) {
      errors.push(`No sub-schema in anyOf matched at '${currentPath || "root"}'`);
      return { valid: false, errors };
    }
  }

  // Handle enum
  if (Array.isArray(s.enum)) {
    const matchesEnum = s.enum.some((val) => JSON.stringify(val) === JSON.stringify(payload));
    if (!matchesEnum) {
      errors.push(
        `Value at '${currentPath || "root"}' must be one of [${s.enum.map((e) => JSON.stringify(e)).join(", ")}]`,
      );
      return { valid: false, errors };
    }
  }

  // Handle const
  if ("const" in s) {
    if (JSON.stringify(s.const) !== JSON.stringify(payload)) {
      errors.push(
        `Value at '${currentPath || "root"}' must equal constant ${JSON.stringify(s.const)}`,
      );
      return { valid: false, errors };
    }
  }

  // Type validation
  const expectedType = s.type;
  if (expectedType !== undefined) {
    const types = Array.isArray(expectedType) ? expectedType : [expectedType];
    const actualType =
      payload === null
        ? "null"
        : Array.isArray(payload)
          ? "array"
          : typeof payload === "number"
            ? Number.isInteger(payload)
              ? "integer"
              : "number"
            : typeof payload;

    const matchesType = types.some((t) => {
      if (t === "number" && actualType === "integer") return true;
      if (t === "integer" && typeof payload === "number" && Number.isInteger(payload)) return true;
      return t === actualType;
    });

    if (!matchesType) {
      errors.push(
        `Expected type '${types.join(" | ")}' at '${currentPath || "root"}', received '${actualType}'`,
      );
      return { valid: false, errors };
    }
  }

  // String bounds & formats
  if (typeof payload === "string") {
    if (typeof s.minLength === "number" && payload.length < s.minLength) {
      errors.push(
        `String at '${currentPath || "root"}' must have length >= ${s.minLength} (length: ${payload.length})`,
      );
    }
    if (typeof s.maxLength === "number" && payload.length > s.maxLength) {
      errors.push(
        `String at '${currentPath || "root"}' must have length <= ${s.maxLength} (length: ${payload.length})`,
      );
    }
    if (typeof s.pattern === "string") {
      try {
        const regex = new RegExp(s.pattern);
        if (!regex.test(payload)) {
          errors.push(`String at '${currentPath || "root"}' does not match pattern '${s.pattern}'`);
        }
      } catch {
        errors.push(`Invalid pattern '${s.pattern}' in schema definition`);
      }
    }
    if (typeof s.format === "string") {
      const validator = FORMAT_VALIDATORS[s.format];
      if (validator && !validator(payload)) {
        errors.push(
          `String at '${currentPath || "root"}' does not conform to format '${s.format}'`,
        );
      }
    }
  }

  // Number bounds
  if (typeof payload === "number") {
    if (typeof s.minimum === "number" && payload < s.minimum) {
      errors.push(`Number at '${currentPath || "root"}' must be >= ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && payload > s.maximum) {
      errors.push(`Number at '${currentPath || "root"}' must be <= ${s.maximum}`);
    }
    if (typeof s.exclusiveMinimum === "number" && payload <= s.exclusiveMinimum) {
      errors.push(`Number at '${currentPath || "root"}' must be > ${s.exclusiveMinimum}`);
    }
    if (typeof s.exclusiveMaximum === "number" && payload >= s.exclusiveMaximum) {
      errors.push(`Number at '${currentPath || "root"}' must be < ${s.exclusiveMaximum}`);
    }
    if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
      const remainder = payload % s.multipleOf;
      if (Math.abs(remainder) > 1e-9 && Math.abs(remainder - s.multipleOf) > 1e-9) {
        errors.push(`Number at '${currentPath || "root"}' must be multiple of ${s.multipleOf}`);
      }
    }
  }

  // Array validation
  if (Array.isArray(payload)) {
    if (typeof s.minItems === "number" && payload.length < s.minItems) {
      errors.push(
        `Array at '${currentPath || "root"}' must have >= ${s.minItems} items (received ${payload.length})`,
      );
    }
    if (typeof s.maxItems === "number" && payload.length > s.maxItems) {
      errors.push(
        `Array at '${currentPath || "root"}' must have <= ${s.maxItems} items (received ${payload.length})`,
      );
    }
    if (s.uniqueItems === true) {
      const serialized = payload.map((item) => JSON.stringify(item));
      const uniqueCount = new Set(serialized).size;
      if (uniqueCount !== payload.length) {
        errors.push(`Array at '${currentPath || "root"}' contains duplicate items`);
      }
    }
    if (s.items !== undefined) {
      for (let i = 0; i < payload.length; i++) {
        const itemPath = currentPath ? `${currentPath}[${i}]` : `[${i}]`;
        const itemRes = validatePayloadAgainstSchema(
          s.items,
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
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const payloadObj = payload as Record<string, unknown>;
    const properties = (
      typeof s.properties === "object" && s.properties !== null ? s.properties : {}
    ) as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];

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
            `Unexpected property '${key}' at '${currentPath || "root"}' (additionalProperties: false)`,
          );
        }
      }
    } else if (typeof s.additionalProperties === "object" && s.additionalProperties !== null) {
      for (const [key, val] of Object.entries(payloadObj)) {
        if (!(key in properties)) {
          const propPath = currentPath ? `${currentPath}.${key}` : key;
          const addRes = validatePayloadAgainstSchema(
            s.additionalProperties,
            val,
            direction,
            root,
            propPath,
          );
          if (!addRes.valid) {
            errors.push(...addRes.errors);
          }
        }
      }
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

  const inputSchema =
    manifest.parameters ??
    (typeof (manifest as Record<string, unknown>).inputSchema === "object"
      ? (manifest as Record<string, unknown>).inputSchema
      : undefined);

  if (inputSchema && typeof inputSchema === "object") {
    const s = inputSchema as Record<string, unknown>;
    if (s.type !== "object" && s.type !== undefined && !Array.isArray(s.type)) {
      warnings.push("Tool input schema should define 'type: object' at root level.");
    }
    if (s.type === "object" && s.properties !== undefined && typeof s.properties !== "object") {
      errors.push("Tool input schema 'properties' must be an object.");
    }
    if (s.required !== undefined && !Array.isArray(s.required)) {
      errors.push("Tool input schema 'required' must be an array of property names.");
    }
  }

  const outputSchema = manifest.outputSchema;
  if (outputSchema && typeof outputSchema === "object") {
    const s = outputSchema as Record<string, unknown>;
    if (s.type === "object" && s.properties !== undefined && typeof s.properties !== "object") {
      errors.push("Tool output schema 'properties' must be an object.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
