import type { ToolParameterSchema } from "@resin/contracts";
import type { JsonRpcParamValue, JsonRpcParams } from "../protocol/types.js";

/**
 * Helper to validate tool parameters against manifest JSON Schema strictly.
 */
export interface ParameterValidationResult {
  valid: boolean;
  errors: string[];
}

function isJsonRpcParams<TInput>(val: TInput): val is TInput & JsonRpcParams {
  return Object.prototype.toString.call(val) === "[object Object]";
}

function describeValueType<TInput>(v: TInput): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  if (Object.prototype.toString.call(v) === "[object String]") return "string";
  if (Object.prototype.toString.call(v) === "[object Number]") return "number";
  if (Object.prototype.toString.call(v) === "[object Boolean]") return "boolean";
  if (v instanceof Function) return "function";
  return "object";
}

export function validateParameters(
  schema: ToolParameterSchema | JsonRpcParams | null | undefined,
  params: JsonRpcParams | null | undefined,
): ParameterValidationResult {
  const errors: string[] = [];

  if (!schema || !(schema instanceof Object)) {
    return { valid: true, errors: [] };
  }

  // Parameter root must be an object
  if (!params || !isJsonRpcParams(params)) {
    return {
      valid: false,
      errors: ["Parameters must be a JSON object"],
    };
  }

  const p: JsonRpcParams = params;

  // Check required properties
  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (req && Object.prototype.toString.call(req) === "[object String]") {
        const reqKey = String(req);
        if (p[reqKey] === undefined) {
          errors.push(`Missing required parameter '${reqKey}'`);
        }
      }
    }
  }

  // Check defined properties
  const properties = isJsonRpcParams(schema.properties) ? schema.properties : undefined;

  if (properties) {
    for (const [key, value] of Object.entries(p)) {
      if (value === undefined) {
        continue;
      }

      const propSchema = properties[key];
      if (isJsonRpcParams(propSchema)) {
        const subSchema = propSchema;
        const type = subSchema.type;

        if (type && Object.prototype.toString.call(type) === "[object String]") {
          switch (String(type)) {
            case "string":
              if (Object.prototype.toString.call(value) !== "[object String]") {
                errors.push(
                  `Parameter '${key}' must be a string (got ${describeValueType(value)})`,
                );
              } else {
                const strVal = String(value);
                if (
                  Number.isFinite(subSchema.minLength) &&
                  strVal.length < Number(subSchema.minLength)
                ) {
                  errors.push(
                    `Parameter '${key}' must be at least ${Number(subSchema.minLength)} characters`,
                  );
                }
                if (
                  Number.isFinite(subSchema.maxLength) &&
                  strVal.length > Number(subSchema.maxLength)
                ) {
                  errors.push(
                    `Parameter '${key}' must be at most ${Number(subSchema.maxLength)} characters`,
                  );
                }
                if (
                  subSchema.pattern &&
                  Object.prototype.toString.call(subSchema.pattern) === "[object String]"
                ) {
                  try {
                    const regex = new RegExp(String(subSchema.pattern));
                    if (!regex.test(strVal)) {
                      errors.push(
                        `Parameter '${key}' does not match required pattern '${String(subSchema.pattern)}'`,
                      );
                    }
                  } catch {
                    // Ignore invalid regex in schema
                  }
                }
              }
              break;

            case "number":
              if (!Number.isFinite(value)) {
                errors.push(
                  `Parameter '${key}' must be a number (got ${describeValueType(value)})`,
                );
              } else {
                const numVal = Number(value);
                if (Number.isFinite(subSchema.minimum) && numVal < Number(subSchema.minimum)) {
                  errors.push(`Parameter '${key}' must be >= ${Number(subSchema.minimum)}`);
                }
                if (Number.isFinite(subSchema.maximum) && numVal > Number(subSchema.maximum)) {
                  errors.push(`Parameter '${key}' must be <= ${Number(subSchema.maximum)}`);
                }
              }
              break;

            case "integer":
              if (!Number.isInteger(value)) {
                errors.push(
                  `Parameter '${key}' must be an integer (got ${describeValueType(value)})`,
                );
              } else {
                const numVal = Number(value);
                if (Number.isFinite(subSchema.minimum) && numVal < Number(subSchema.minimum)) {
                  errors.push(`Parameter '${key}' must be >= ${Number(subSchema.minimum)}`);
                }
                if (Number.isFinite(subSchema.maximum) && numVal > Number(subSchema.maximum)) {
                  errors.push(`Parameter '${key}' must be <= ${Number(subSchema.maximum)}`);
                }
              }
              break;

            case "boolean":
              if (value !== true && value !== false) {
                errors.push(
                  `Parameter '${key}' must be a boolean (got ${describeValueType(value)})`,
                );
              }
              break;

            case "array":
              if (!Array.isArray(value)) {
                errors.push(
                  `Parameter '${key}' must be an array (got ${describeValueType(value)})`,
                );
              } else {
                if (
                  Number.isFinite(subSchema.minItems) &&
                  value.length < Number(subSchema.minItems)
                ) {
                  errors.push(
                    `Parameter '${key}' must have at least ${Number(subSchema.minItems)} items`,
                  );
                }
                if (
                  Number.isFinite(subSchema.maxItems) &&
                  value.length > Number(subSchema.maxItems)
                ) {
                  errors.push(
                    `Parameter '${key}' must have at most ${Number(subSchema.maxItems)} items`,
                  );
                }
                if (isJsonRpcParams(subSchema.items)) {
                  const itemSchema = subSchema.items;
                  const itemType = itemSchema.type;
                  if (itemType && Object.prototype.toString.call(itemType) === "[object String]") {
                    for (let i = 0; i < value.length; i++) {
                      const itemVal = value[i];
                      if (
                        String(itemType) === "string" &&
                        Object.prototype.toString.call(itemVal) !== "[object String]"
                      ) {
                        errors.push(
                          `Parameter '${key}[${i}]' must be a string (got ${describeValueType(itemVal)})`,
                        );
                      } else if (String(itemType) === "number" && !Number.isFinite(itemVal)) {
                        errors.push(
                          `Parameter '${key}[${i}]' must be a number (got ${describeValueType(itemVal)})`,
                        );
                      }
                    }
                  }
                }
              }
              break;

            case "object":
              if (!value || !(value instanceof Object) || Array.isArray(value)) {
                errors.push(
                  `Parameter '${key}' must be an object (got ${describeValueType(value)})`,
                );
              }
              break;
          }
        }

        // Check enum constraint
        if (Array.isArray(subSchema.enum)) {
          if (!subSchema.enum.includes(value)) {
            errors.push(
              `Parameter '${key}' must be one of: ${subSchema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
            );
          }
        }
      }
    }
  }

  // Check additionalProperties === false
  if (schema.additionalProperties === false && properties) {
    for (const key of Object.keys(p)) {
      if (!(key in properties)) {
        errors.push(`Unrecognized parameter '${key}' (additional properties not allowed)`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
