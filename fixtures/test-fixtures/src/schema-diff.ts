import { z } from "zod";

/**
 * Semantic Schema Diff Tool
 *
 * Categorizes contract changes as additive, conditionally_compatible, or breaking.
 * Detects breaking field removals, type shifts, enum variant reassignments,
 * and constraint tightening.
 */

export type SchemaChangeCategory = "additive" | "conditionally_compatible" | "breaking";

export type SchemaChangeKind =
  | "field_added"
  | "field_removed"
  | "type_changed"
  | "required_changed"
  | "default_changed"
  | "enum_variant_added"
  | "enum_variant_removed"
  | "constraint_tightened"
  | "constraint_relaxed"
  | "union_variant_added"
  | "union_variant_removed"
  | "description_changed";

export interface SchemaChange {
  path: string;
  kind: SchemaChangeKind;
  category: SchemaChangeCategory;
  description: string;
  before?: unknown;
  after?: unknown;
}

export interface SchemaDiffResult {
  category: SchemaChangeCategory;
  isBreaking: boolean;
  changes: SchemaChange[];
  summary: {
    total: number;
    additive: number;
    conditionallyCompatible: number;
    breaking: number;
  };
}

export interface SchemaDiffOptions {
  /** Mode: 'producer' (stricter on outputs) vs 'consumer' (stricter on inputs) */
  direction?: "producer" | "consumer";
  /** Ignore description and metadata changes */
  ignoreDescriptions?: boolean;
}

export interface SchemaDescriptor {
  type:
    | "string"
    | "number"
    | "boolean"
    | "null"
    | "undefined"
    | "object"
    | "array"
    | "enum"
    | "union"
    | "discriminated_union"
    | "literal"
    | "record"
    | "any"
    | "unknown";
  isOptional?: boolean;
  isNullable?: boolean;
  hasDefault?: boolean;
  defaultValue?: unknown;
  description?: string;
  literalValue?: unknown;
  properties?: Record<string, SchemaDescriptor>;
  required?: string[];
  enumValues?: string[];
  discriminator?: string;
  unionMembers?: SchemaDescriptor[];
  arrayItem?: SchemaDescriptor;
  min?: number;
  max?: number;
  pattern?: string;
  isInt?: boolean;
}

export class IncompatibleSchemaError extends Error {
  public readonly diff: SchemaDiffResult;

  constructor(diff: SchemaDiffResult, message?: string) {
    const breakingSummary = diff.changes
      .filter((c) => c.category === "breaking")
      .map((c) => `  - [BREAKING] ${c.path}: ${c.description}`)
      .join("\n");
    super(
      message ||
        `Schema incompatibility detected with ${diff.summary.breaking} breaking change(s):\n${breakingSummary}`,
    );
    this.name = "IncompatibleSchemaError";
    this.diff = diff;
  }
}

// ============================================================================
// Zod Schema Extraction
// ============================================================================

/**
 * Recursively extract a structural descriptor from a live Zod schema instance.
 */
export function extractSchemaDescriptor(schema: z.ZodTypeAny): SchemaDescriptor {
  let current: z.ZodTypeAny = schema;
  let isOptional = false;
  let isNullable = false;
  let hasDefault = false;
  let defaultValue: unknown;
  let description = schema.description;

  // Unwrap wrapper types
  let unwrapping = true;
  while (unwrapping) {
    const typeName = current._def?.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
      isOptional = true;
      current = (current as z.ZodOptional<z.ZodTypeAny>)._def.innerType;
    } else if (typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
      isNullable = true;
      current = (current as z.ZodNullable<z.ZodTypeAny>)._def.innerType;
    } else if (typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
      hasDefault = true;
      defaultValue = (current as z.ZodDefault<z.ZodTypeAny>)._def.defaultValue();
      isOptional = true;
      current = (current as z.ZodDefault<z.ZodTypeAny>)._def.innerType;
    } else if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
      current = (current as z.ZodEffects<z.ZodTypeAny>)._def.schema;
    } else if (typeName === z.ZodFirstPartyTypeKind.ZodCatch) {
      current = (current as z.ZodCatch<z.ZodTypeAny>)._def.innerType;
    } else if (typeName === z.ZodFirstPartyTypeKind.ZodBranded) {
      current = (current as z.ZodBranded<z.ZodTypeAny, string>)._def.type;
    } else if (typeName === z.ZodFirstPartyTypeKind.ZodReadonly) {
      current = (current as z.ZodReadonly<z.ZodTypeAny>)._def.innerType;
    } else {
      unwrapping = false;
    }
  }

  if (!description && current.description) {
    description = current.description;
  }

  const base: Partial<SchemaDescriptor> = {
    isOptional: isOptional || undefined,
    isNullable: isNullable || undefined,
    hasDefault: hasDefault || undefined,
    defaultValue,
    description,
  };

  const typeName = current._def?.typeName;

  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const strDef = current as z.ZodString;
      let min: number | undefined;
      let max: number | undefined;
      let pattern: string | undefined;

      for (const check of strDef._def.checks || []) {
        if (check.kind === "min") min = check.value;
        if (check.kind === "max") max = check.value;
        if (check.kind === "regex") pattern = check.regex.source;
      }

      return {
        ...base,
        type: "string",
        min,
        max,
        pattern,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const numDef = current as z.ZodNumber;
      let min: number | undefined;
      let max: number | undefined;
      let isInt = false;

      for (const check of numDef._def.checks || []) {
        if (check.kind === "min") min = check.value;
        if (check.kind === "max") max = check.value;
        if (check.kind === "int") isInt = true;
      }

      return {
        ...base,
        type: "number",
        min,
        max,
        isInt: isInt || undefined,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { ...base, type: "boolean" };

    case z.ZodFirstPartyTypeKind.ZodNull:
      return { ...base, type: "null" };

    case z.ZodFirstPartyTypeKind.ZodUndefined:
      return { ...base, type: "undefined", isOptional: true };

    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const litDef = current as z.ZodLiteral<unknown>;
      return {
        ...base,
        type: "literal",
        literalValue: litDef._def.value,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodEnum: {
      const enumDef = current as z.ZodEnum<[string, ...string[]]>;
      return {
        ...base,
        type: "enum",
        enumValues: [...enumDef._def.values],
      };
    }

    case z.ZodFirstPartyTypeKind.ZodNativeEnum: {
      const nativeEnumDef = current as z.ZodNativeEnum<z.EnumLike>;
      const values = Object.values(nativeEnumDef._def.values).map(String);
      return {
        ...base,
        type: "enum",
        enumValues: values,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodArray: {
      const arrayDef = current as z.ZodArray<z.ZodTypeAny>;
      return {
        ...base,
        type: "array",
        arrayItem: extractSchemaDescriptor(arrayDef._def.type),
        min: arrayDef._def.minLength?.value,
        max: arrayDef._def.maxLength?.value,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodObject: {
      const objDef = current as z.ZodObject<z.ZodRawShape>;
      const shape = objDef._def.shape();
      const properties: Record<string, SchemaDescriptor> = {};
      const required: string[] = [];

      for (const [propName, propSchema] of Object.entries(shape)) {
        const propDesc = extractSchemaDescriptor(propSchema as z.ZodTypeAny);
        properties[propName] = propDesc;
        if (!propDesc.isOptional && !propDesc.hasDefault) {
          required.push(propName);
        }
      }

      return {
        ...base,
        type: "object",
        properties,
        required,
      };
    }

    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { ...base, type: "record" };

    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const unionDef = current as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>;
      return {
        ...base,
        type: "union",
        unionMembers: unionDef._def.options.map(extractSchemaDescriptor),
      };
    }

    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const discDef = current as z.ZodDiscriminatedUnion<string, z.ZodObject<z.ZodRawShape>[]>;
      return {
        ...base,
        type: "discriminated_union",
        discriminator: discDef._def.discriminator,
        unionMembers: discDef._def.options.map(extractSchemaDescriptor),
      };
    }

    case z.ZodFirstPartyTypeKind.ZodAny:
      return { ...base, type: "any" };

    default:
      return { ...base, type: "unknown" };
  }
}

// ============================================================================
// Semantic Schema Diffing Algorithm
// ============================================================================

/**
 * Compute the semantic difference between two schema descriptors.
 */
export function diffSchemaDescriptors(
  oldDesc: SchemaDescriptor,
  newDesc: SchemaDescriptor,
  options: SchemaDiffOptions = {},
): SchemaDiffResult {
  const changes: SchemaChange[] = [];
  const ignoreDescriptions = options.ignoreDescriptions ?? false;

  function compareDescriptors(
    before: SchemaDescriptor,
    after: SchemaDescriptor,
    currentPath: string,
  ): void {
    const path = currentPath || "$";

    // 1. Description
    if (!ignoreDescriptions && before.description !== after.description) {
      changes.push({
        path,
        kind: "description_changed",
        category: "additive",
        description: `Description updated from "${before.description ?? ""}" to "${after.description ?? ""}"`,
        before: before.description,
        after: after.description,
      });
    }

    // 2. Type Shift
    if (before.type !== after.type) {
      changes.push({
        path,
        kind: "type_changed",
        category: "breaking",
        description: `Type shifted from '${before.type}' to '${after.type}'`,
        before: before.type,
        after: after.type,
      });
      return; // Cannot diff further if top-level types differ
    }

    // 3. Optionality / Nullability changes
    const wasOptional = before.isOptional || before.hasDefault;
    const isNowOptional = after.isOptional || after.hasDefault;

    if (wasOptional && !isNowOptional) {
      // Optional field became required -> BREAKING
      changes.push({
        path,
        kind: "required_changed",
        category: "breaking",
        description: `Previously optional field is now required`,
        before: { isOptional: wasOptional },
        after: { isOptional: isNowOptional },
      });
    } else if (!wasOptional && isNowOptional) {
      // Required field became optional -> conditionally compatible
      changes.push({
        path,
        kind: "required_changed",
        category: "conditionally_compatible",
        description: `Previously required field is now optional`,
        before: { isOptional: wasOptional },
        after: { isOptional: isNowOptional },
      });
    }

    if (before.isNullable && !after.isNullable) {
      changes.push({
        path,
        kind: "type_changed",
        category: "breaking",
        description: `Previously nullable field is no longer nullable`,
        before: { isNullable: true },
        after: { isNullable: false },
      });
    } else if (!before.isNullable && after.isNullable) {
      changes.push({
        path,
        kind: "type_changed",
        category: "additive",
        description: `Field is now nullable`,
        before: { isNullable: false },
        after: { isNullable: true },
      });
    }

    // 4. Object Properties
    if (before.type === "object" && after.type === "object") {
      const beforeProps = before.properties || {};
      const afterProps = after.properties || {};

      const beforeKeys = Object.keys(beforeProps);
      const afterKeys = Object.keys(afterProps);

      const beforeKeySet: Record<string, true> = {};
      for (const k of beforeKeys) beforeKeySet[k] = true;

      const afterKeySet: Record<string, true> = {};
      for (const k of afterKeys) afterKeySet[k] = true;

      // Check removed properties -> BREAKING
      for (const key of beforeKeys) {
        if (!afterKeySet[key]) {
          changes.push({
            path: currentPath ? `${currentPath}.${key}` : key,
            kind: "field_removed",
            category: "breaking",
            description: `Field '${key}' was removed`,
            before: beforeProps[key],
          });
        }
      }

      // Check added properties
      for (const key of afterKeys) {
        if (!beforeKeySet[key]) {
          const prop = afterProps[key];
          const isReq = !prop.isOptional && !prop.hasDefault;
          changes.push({
            path: currentPath ? `${currentPath}.${key}` : key,
            kind: "field_added",
            category: isReq ? "breaking" : "additive",
            description: `Field '${key}' was added (${isReq ? "REQUIRED" : "optional"})`,
            after: prop,
          });
        }
      }

      // Check common properties recursively
      for (const key of beforeKeys) {
        if (afterKeySet[key]) {
          compareDescriptors(
            beforeProps[key],
            afterProps[key],
            currentPath ? `${currentPath}.${key}` : key,
          );
        }
      }
    }

    // 5. Enum Values
    if (before.type === "enum" && after.type === "enum") {
      const beforeVals = before.enumValues || [];
      const afterVals = after.enumValues || [];

      const beforeValSet: Record<string, true> = {};
      for (const v of beforeVals) beforeValSet[v] = true;

      const afterValSet: Record<string, true> = {};
      for (const v of afterVals) afterValSet[v] = true;

      // Removed enum variant -> BREAKING
      for (const v of beforeVals) {
        if (!afterValSet[v]) {
          changes.push({
            path,
            kind: "enum_variant_removed",
            category: "breaking",
            description: `Enum variant '${v}' was removed`,
            before: v,
          });
        }
      }

      // Added enum variant -> ADDITIVE / CONDITIONALLY_COMPATIBLE
      for (const v of afterVals) {
        if (!beforeValSet[v]) {
          changes.push({
            path,
            kind: "enum_variant_added",
            category: "additive",
            description: `Enum variant '${v}' was added`,
            after: v,
          });
        }
      }
    }

    // 6. Array Items
    if (before.type === "array" && after.type === "array") {
      if (before.arrayItem && after.arrayItem) {
        compareDescriptors(before.arrayItem, after.arrayItem, `${path}[]`);
      }
    }

    // 7. Numeric & String Constraints
    if (before.type === "number" || before.type === "string") {
      // Min tightened
      if (before.min !== undefined && after.min !== undefined && after.min > before.min) {
        changes.push({
          path,
          kind: "constraint_tightened",
          category: "breaking",
          description: `Minimum value tightened from ${before.min} to ${after.min}`,
          before: before.min,
          after: after.min,
        });
      } else if (before.min === undefined && after.min !== undefined) {
        changes.push({
          path,
          kind: "constraint_tightened",
          category: "breaking",
          description: `Added minimum constraint of ${after.min}`,
          after: after.min,
        });
      } else if (before.min !== undefined && after.min !== undefined && after.min < before.min) {
        changes.push({
          path,
          kind: "constraint_relaxed",
          category: "additive",
          description: `Minimum value relaxed from ${before.min} to ${after.min}`,
          before: before.min,
          after: after.min,
        });
      }

      // Max tightened
      if (before.max !== undefined && after.max !== undefined && after.max < before.max) {
        changes.push({
          path,
          kind: "constraint_tightened",
          category: "breaking",
          description: `Maximum value tightened from ${before.max} to ${after.max}`,
          before: before.max,
          after: after.max,
        });
      } else if (before.max === undefined && after.max !== undefined) {
        changes.push({
          path,
          kind: "constraint_tightened",
          category: "breaking",
          description: `Added maximum constraint of ${after.max}`,
          after: after.max,
        });
      } else if (before.max !== undefined && after.max !== undefined && after.max > before.max) {
        changes.push({
          path,
          kind: "constraint_relaxed",
          category: "additive",
          description: `Maximum value relaxed from ${before.max} to ${after.max}`,
          before: before.max,
          after: after.max,
        });
      }

      // Pattern changes
      if (before.pattern !== after.pattern) {
        if (before.pattern && !after.pattern) {
          changes.push({
            path,
            kind: "constraint_relaxed",
            category: "additive",
            description: `Regex pattern constraint removed`,
            before: before.pattern,
          });
        } else if (!before.pattern && after.pattern) {
          changes.push({
            path,
            kind: "constraint_tightened",
            category: "breaking",
            description: `Regex pattern constraint added: /${after.pattern}/`,
            after: after.pattern,
          });
        } else if (before.pattern && after.pattern) {
          changes.push({
            path,
            kind: "constraint_tightened",
            category: "breaking",
            description: `Regex pattern changed from /${before.pattern}/ to /${after.pattern}/`,
            before: before.pattern,
            after: after.pattern,
          });
        }
      }
    }
  }

  compareDescriptors(oldDesc, newDesc, "");

  let breakingCount = 0;
  let conditionallyCompatibleCount = 0;
  let additiveCount = 0;

  for (const change of changes) {
    if (change.category === "breaking") breakingCount++;
    else if (change.category === "conditionally_compatible") conditionallyCompatibleCount++;
    else additiveCount++;
  }

  const overallCategory: SchemaChangeCategory =
    breakingCount > 0
      ? "breaking"
      : conditionallyCompatibleCount > 0
        ? "conditionally_compatible"
        : "additive";

  return {
    category: overallCategory,
    isBreaking: breakingCount > 0,
    changes,
    summary: {
      total: changes.length,
      additive: additiveCount,
      conditionallyCompatible: conditionallyCompatibleCount,
      breaking: breakingCount,
    },
  };
}

/**
 * Compare two Zod schemas and categorize the changes.
 */
export function diffZodSchemas(
  oldSchema: z.ZodTypeAny,
  newSchema: z.ZodTypeAny,
  options?: SchemaDiffOptions,
): SchemaDiffResult {
  const oldDesc = extractSchemaDescriptor(oldSchema);
  const newDesc = extractSchemaDescriptor(newSchema);
  return diffSchemaDescriptors(oldDesc, newDesc, options);
}

/**
 * Compare two JSON schema objects and categorize the changes.
 */
export function diffJsonSchemas(
  oldJson: Record<string, unknown>,
  newJson: Record<string, unknown>,
  options?: SchemaDiffOptions,
): SchemaDiffResult {
  function jsonToDescriptor(json: Record<string, unknown>): SchemaDescriptor {
    const rawType = json.type;
    const typeStr = Array.isArray(rawType) ? rawType[0] : rawType;

    const properties: Record<string, SchemaDescriptor> = {};
    const requiredList = Array.isArray(json.required) ? (json.required as string[]) : [];
    const requiredSet: Record<string, true> = {};
    for (const r of requiredList) requiredSet[r] = true;

    if (json.properties && typeof json.properties === "object") {
      for (const [k, v] of Object.entries(
        json.properties as Record<string, Record<string, unknown>>,
      )) {
        const desc = jsonToDescriptor(v);
        desc.isOptional = !requiredSet[k];
        properties[k] = desc;
      }
    }

    let arrayItem: SchemaDescriptor | undefined;
    if (json.items && typeof json.items === "object") {
      arrayItem = jsonToDescriptor(json.items as Record<string, unknown>);
    }

    const enumValues = Array.isArray(json.enum) ? (json.enum as string[]).map(String) : undefined;

    return {
      type: (typeStr as SchemaDescriptor["type"]) || (enumValues ? "enum" : "object"),
      description: typeof json.description === "string" ? json.description : undefined,
      properties: Object.keys(properties).length > 0 ? properties : undefined,
      required: requiredList,
      enumValues,
      arrayItem,
      min:
        typeof json.minimum === "number"
          ? json.minimum
          : typeof json.minLength === "number"
            ? json.minLength
            : undefined,
      max:
        typeof json.maximum === "number"
          ? json.maximum
          : typeof json.maxLength === "number"
            ? json.maxLength
            : undefined,
      pattern: typeof json.pattern === "string" ? json.pattern : undefined,
    };
  }

  const oldDesc = jsonToDescriptor(oldJson);
  const newDesc = jsonToDescriptor(newJson);
  return diffSchemaDescriptors(oldDesc, newDesc, options);
}

/**
 * Assert that a schema modification does not introduce breaking changes.
 * Throws IncompatibleSchemaError if breaking changes are detected.
 */
export function assertCompatible(
  oldSchema: z.ZodTypeAny | SchemaDescriptor,
  newSchema: z.ZodTypeAny | SchemaDescriptor,
  allowConditionallyCompatible = true,
): void {
  const oldDesc =
    "type" in oldSchema && typeof oldSchema.type === "string"
      ? (oldSchema as SchemaDescriptor)
      : extractSchemaDescriptor(oldSchema as z.ZodTypeAny);
  const newDesc =
    "type" in newSchema && typeof newSchema.type === "string"
      ? (newSchema as SchemaDescriptor)
      : extractSchemaDescriptor(newSchema as z.ZodTypeAny);

  const diff = diffSchemaDescriptors(oldDesc, newDesc);
  if (diff.isBreaking) {
    throw new IncompatibleSchemaError(diff);
  }
  if (!allowConditionallyCompatible && diff.category === "conditionally_compatible") {
    throw new IncompatibleSchemaError(
      diff,
      `Schema contains conditionally compatible changes which are disallowed: ${diff.changes.map((c) => c.description).join("; ")}`,
    );
  }
}

/**
 * Format a SchemaDiffResult into a human-readable report.
 */
export function formatSchemaDiff(result: SchemaDiffResult): string {
  const lines: string[] = [
    `Schema Diff Result: [${result.category.toUpperCase()}]`,
    `Total Changes: ${result.summary.total} (Additive: ${result.summary.additive}, Conditional: ${result.summary.conditionallyCompatible}, Breaking: ${result.summary.breaking})`,
  ];

  if (result.changes.length > 0) {
    lines.push("\nDetailed Changes:");
    for (const change of result.changes) {
      const badge = `[${change.category.toUpperCase()}]`;
      lines.push(`  ${badge.padEnd(26)} ${change.path || "$"}: ${change.description}`);
    }
  }

  return lines.join("\n");
}
