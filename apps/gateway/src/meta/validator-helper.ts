/**
 * Helper to validate tool parameters against manifest JSON Schema strictly.
 */
export interface ParameterValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateParameters(
  schema: Record<string, unknown> | undefined,
  params: unknown,
): ParameterValidationResult {
  const errors: string[] = [];

  if (!schema || typeof schema !== "object") {
    return { valid: true, errors: [] };
  }

  // Parameter root must be an object
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {
      valid: false,
      errors: ["Parameters must be a JSON object"],
    };
  }

  const p = params as Record<string, unknown>;

  // Check required properties
  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (typeof req === "string") {
        if (p[req] === undefined) {
          errors.push(`Missing required parameter '${req}'`);
        }
      }
    }
  }

  // Check defined properties
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : undefined;

  if (properties) {
    for (const [key, value] of Object.entries(p)) {
      if (value === undefined) {
        continue;
      }

      const propSchema = properties[key];
      if (propSchema && typeof propSchema === "object") {
        const subSchema = propSchema as Record<string, unknown>;
        const type = subSchema.type;

        if (typeof type === "string") {
          switch (type) {
            case "string":
              if (typeof value !== "string") {
                errors.push(`Parameter '${key}' must be a string (got ${typeof value})`);
              } else {
                if (typeof subSchema.minLength === "number" && value.length < subSchema.minLength) {
                  errors.push(
                    `Parameter '${key}' must be at least ${subSchema.minLength} characters`,
                  );
                }
                if (typeof subSchema.maxLength === "number" && value.length > subSchema.maxLength) {
                  errors.push(
                    `Parameter '${key}' must be at most ${subSchema.maxLength} characters`,
                  );
                }
                if (typeof subSchema.pattern === "string") {
                  try {
                    const regex = new RegExp(subSchema.pattern);
                    if (!regex.test(value)) {
                      errors.push(
                        `Parameter '${key}' does not match pattern '${subSchema.pattern}'`,
                      );
                    }
                  } catch {
                    // Ignore regex syntax errors
                  }
                }
              }
              break;

            case "number":
              if (typeof value !== "number" || Number.isNaN(value)) {
                errors.push(`Parameter '${key}' must be a number (got ${typeof value})`);
              } else {
                if (typeof subSchema.minimum === "number" && value < subSchema.minimum) {
                  errors.push(`Parameter '${key}' must be >= ${subSchema.minimum}`);
                }
                if (typeof subSchema.maximum === "number" && value > subSchema.maximum) {
                  errors.push(`Parameter '${key}' must be <= ${subSchema.maximum}`);
                }
              }
              break;

            case "integer":
              if (typeof value !== "number" || !Number.isInteger(value)) {
                errors.push(`Parameter '${key}' must be an integer`);
              } else {
                if (typeof subSchema.minimum === "number" && value < subSchema.minimum) {
                  errors.push(`Parameter '${key}' must be >= ${subSchema.minimum}`);
                }
                if (typeof subSchema.maximum === "number" && value > subSchema.maximum) {
                  errors.push(`Parameter '${key}' must be <= ${subSchema.maximum}`);
                }
              }
              break;

            case "boolean":
              if (typeof value !== "boolean") {
                errors.push(`Parameter '${key}' must be a boolean (got ${typeof value})`);
              }
              break;

            case "array":
              if (!Array.isArray(value)) {
                errors.push(`Parameter '${key}' must be an array`);
              } else {
                if (typeof subSchema.minItems === "number" && value.length < subSchema.minItems) {
                  errors.push(
                    `Parameter '${key}' must contain at least ${subSchema.minItems} items`,
                  );
                }
                if (typeof subSchema.maxItems === "number" && value.length > subSchema.maxItems) {
                  errors.push(
                    `Parameter '${key}' must contain at most ${subSchema.maxItems} items`,
                  );
                }
                if (subSchema.items && typeof subSchema.items === "object") {
                  const itemSchema = subSchema.items as Record<string, unknown>;
                  const itemType = itemSchema.type;
                  if (typeof itemType === "string") {
                    for (let i = 0; i < value.length; i++) {
                      const item = value[i];
                      if (itemType === "string" && typeof item !== "string") {
                        errors.push(`Parameter '${key}[${i}]' must be a string`);
                      } else if (
                        itemType === "number" &&
                        (typeof item !== "number" || Number.isNaN(item))
                      ) {
                        errors.push(`Parameter '${key}[${i}]' must be a number`);
                      } else if (
                        itemType === "integer" &&
                        (typeof item !== "number" || !Number.isInteger(item))
                      ) {
                        errors.push(`Parameter '${key}[${i}]' must be an integer`);
                      } else if (itemType === "boolean" && typeof item !== "boolean") {
                        errors.push(`Parameter '${key}[${i}]' must be a boolean`);
                      }
                    }
                  }
                }
              }
              break;

            case "object":
              if (typeof value !== "object" || value === null || Array.isArray(value)) {
                errors.push(`Parameter '${key}' must be an object`);
              }
              break;
          }
        }

        // Enum check
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
