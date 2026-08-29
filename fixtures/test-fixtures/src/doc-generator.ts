import {
  CapabilityEnvelopeSchema,
  CatalogSnapshotSchema,
  DeploymentRecordSchema,
  NormalizedSessionEventSchema,
  ToolManifestSchema,
  ToolVersionSchema,
} from "@resin/contracts";
import {
  AdapterCapabilitiesSchema,
  ConfigMutationPlanSchema,
  HarnessInstallationSchema,
  HarnessSessionSchema,
  RefreshResultSchema,
} from "@resin/harness-contracts";
import {
  DeviceAuthBootstrapRequestSchema,
  DeviceAuthBootstrapResponseSchema,
  ObservationBatchRequestSchema,
  ObservationBatchResponseSchema,
  ProtocolMessageEnvelopeSchema,
  StreamMessageSchema,
} from "@resin/protocol";
import type { z } from "zod";
import { type SchemaDescriptor, extractSchemaDescriptor } from "./schema-diff.js";

/**
 * Contract Documentation and JSON Schema Generator
 *
 * Generates human-readable Markdown documentation and compliant JSON Schema definitions
 * directly from live Zod schemas.
 */

export interface DocGenOptions {
  includeExamples?: boolean;
  title?: string;
  description?: string;
}

export interface JsonSchemaOptions {
  targetSpec?: "draft-07" | "2020-12" | "openapi-3.1";
  includeExamples?: boolean;
}

export interface ExampleOptions {
  seed?: number;
  depth?: number;
}

// ============================================================================
// 1. JSON Schema Converter
// ============================================================================

/**
 * Convert a Zod schema or SchemaDescriptor to a JSON Schema object.
 */
export function generateJsonSchema(
  schema: z.ZodTypeAny | SchemaDescriptor,
  options: JsonSchemaOptions = {},
): Record<string, unknown> {
  const desc: SchemaDescriptor =
    "type" in schema && typeof schema.type === "string"
      ? (schema as SchemaDescriptor)
      : extractSchemaDescriptor(schema as z.ZodTypeAny);

  function descriptorToJsonSchema(d: SchemaDescriptor): Record<string, unknown> {
    const json: Record<string, unknown> = {};

    if (d.description) {
      json.description = d.description;
    }

    if (d.hasDefault && d.defaultValue !== undefined) {
      json.default = d.defaultValue;
    }

    switch (d.type) {
      case "string":
        json.type = d.isNullable ? ["string", "null"] : "string";
        if (d.min !== undefined) json.minLength = d.min;
        if (d.max !== undefined) json.maxLength = d.max;
        if (d.pattern !== undefined) json.pattern = d.pattern;
        break;

      case "number":
        json.type = d.isInt
          ? d.isNullable
            ? ["integer", "null"]
            : "integer"
          : d.isNullable
            ? ["number", "null"]
            : "number";
        if (d.min !== undefined) json.minimum = d.min;
        if (d.max !== undefined) json.maximum = d.max;
        break;

      case "boolean":
        json.type = d.isNullable ? ["boolean", "null"] : "boolean";
        break;

      case "null":
        json.type = "null";
        break;

      case "literal":
        json.const = d.literalValue;
        break;

      case "enum":
        json.type = "string";
        json.enum = d.enumValues || [];
        break;

      case "array":
        json.type = "array";
        if (d.arrayItem) {
          json.items = descriptorToJsonSchema(d.arrayItem);
        }
        if (d.min !== undefined) json.minItems = d.min;
        if (d.max !== undefined) json.maxItems = d.max;
        break;

      case "object": {
        json.type = d.isNullable ? ["object", "null"] : "object";
        const props: Record<string, unknown> = {};
        if (d.properties) {
          for (const [key, propDesc] of Object.entries(d.properties)) {
            props[key] = descriptorToJsonSchema(propDesc);
          }
        }
        json.properties = props;
        if (d.required && d.required.length > 0) {
          json.required = d.required;
        }
        json.additionalProperties = false;
        break;
      }

      case "union":
      case "discriminated_union":
        if (d.unionMembers) {
          json.oneOf = d.unionMembers.map(descriptorToJsonSchema);
        }
        break;

      case "record":
        json.type = "object";
        json.additionalProperties = true;
        break;
      default:
        break;
    }

    return json;
  }

  const result = descriptorToJsonSchema(desc);
  if (options.targetSpec === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (options.targetSpec === "2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  }

  if (options.includeExamples) {
    result.examples = [generateSchemaExample(desc)];
  }

  return result;
}

// ============================================================================
// 2. Schema Example Generator
// ============================================================================

/**
 * Generate a realistic representative sample from a Zod schema or SchemaDescriptor.
 */
export function generateSchemaExample(
  schema: z.ZodTypeAny | SchemaDescriptor,
  _options: ExampleOptions = {},
): unknown {
  const desc: SchemaDescriptor =
    "type" in schema && typeof schema.type === "string"
      ? (schema as SchemaDescriptor)
      : extractSchemaDescriptor(schema as z.ZodTypeAny);

  function makeExample(d: SchemaDescriptor, fieldName = ""): unknown {
    if (d.defaultValue !== undefined) {
      return d.defaultValue;
    }

    const lowerField = fieldName.toLowerCase();

    switch (d.type) {
      case "string": {
        if (
          d.pattern?.includes("^[0-9a-f]{64}$") ||
          lowerField.includes("digest") ||
          lowerField.includes("hash")
        ) {
          return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        }
        if (
          lowerField.includes("timestamp") ||
          lowerField.includes("at") ||
          lowerField.includes("date")
        ) {
          return "2026-08-17T12:00:00.000Z";
        }
        if (lowerField.includes("version") || lowerField.includes("semver")) {
          return "1.0.0";
        }
        if (lowerField.includes("id")) {
          return `${fieldName.replace(/id$/i, "") || "id"}_sample_001`;
        }
        if (lowerField.includes("path") || lowerField.includes("file")) {
          return "src/index.ts";
        }
        return `sample_${fieldName || "string"}`;
      }

      case "number": {
        if (d.isInt) return d.min !== undefined ? Math.max(1, d.min) : 42;
        return d.min !== undefined && d.max !== undefined ? (d.min + d.max) / 2 : 3.14;
      }

      case "boolean":
        return true;

      case "null":
        return null;

      case "literal":
        return d.literalValue;

      case "enum":
        return d.enumValues && d.enumValues.length > 0 ? d.enumValues[0] : "ENUM_VALUE";

      case "array":
        return d.arrayItem ? [makeExample(d.arrayItem, fieldName)] : [];

      case "object": {
        const obj: Record<string, unknown> = {};
        if (d.properties) {
          for (const [key, propDesc] of Object.entries(d.properties)) {
            obj[key] = makeExample(propDesc, key);
          }
        }
        return obj;
      }

      case "union":
      case "discriminated_union":
        if (d.unionMembers && d.unionMembers.length > 0) {
          return makeExample(d.unionMembers[0], fieldName);
        }
        return {};

      case "record":
        return { key: "value" };
      default:
        return "sample_data";
    }
  }

  return makeExample(desc);
}

// ============================================================================
// 3. Markdown Documentation Generator
// ============================================================================

/**
 * Generate comprehensive GitHub-flavored Markdown contract documentation.
 */
export function generateMarkdownDocs(
  schemas: Record<string, z.ZodTypeAny>,
  options: DocGenOptions = {},
): string {
  const lines: string[] = [];

  const title = options.title || "Resin Contract Specifications";
  lines.push(`# ${title}\n`);

  if (options.description) {
    lines.push(`${options.description}\n`);
  }

  lines.push(`Auto-generated from live Zod schema definitions on 2026-08-17.\n`);
  lines.push("## Table of Contents\n");

  const schemaNames = Object.keys(schemas).sort();
  for (const name of schemaNames) {
    lines.push(`- [${name}](#${name.toLowerCase()})`);
  }
  lines.push("\n---\n");

  for (const name of schemaNames) {
    const schema = schemas[name];
    const desc = extractSchemaDescriptor(schema);

    lines.push(`## ${name}\n`);
    if (desc.description) {
      lines.push(`${desc.description}\n`);
    }

    lines.push(`- **Type**: \`${desc.type}\``);
    if (desc.isOptional) lines.push(`- **Optional**: \`true\``);
    if (desc.isNullable) lines.push(`- **Nullable**: \`true\``);
    lines.push("");

    if (desc.type === "object" && desc.properties) {
      lines.push("### Fields\n");
      lines.push("| Field | Type | Required | Default | Description |");
      lines.push("| :--- | :--- | :--- | :--- | :--- |");

      const requiredSet: Record<string, true> = {};
      if (desc.required) {
        for (const r of desc.required) requiredSet[r] = true;
      }

      for (const [fieldName, fieldDesc] of Object.entries(desc.properties)) {
        const isReq = requiredSet[fieldName] ? "Yes" : "No";
        const defVal = fieldDesc.hasDefault ? `\`${JSON.stringify(fieldDesc.defaultValue)}\`` : "-";
        const fieldType = `\`${fieldDesc.type}${fieldDesc.isNullable ? " | null" : ""}\``;
        const fieldDoc = fieldDesc.description || "-";

        lines.push(`| \`${fieldName}\` | ${fieldType} | ${isReq} | ${defVal} | ${fieldDoc} |`);
      }
      lines.push("");
    } else if (desc.type === "enum" && desc.enumValues) {
      lines.push("### Allowed Values\n");
      for (const val of desc.enumValues) {
        lines.push(`- \`"${val}"\``);
      }
      lines.push("");
    }

    if (options.includeExamples !== false) {
      const example = generateSchemaExample(desc);
      lines.push("### Example Payload\n");
      lines.push("```json");
      lines.push(JSON.stringify(example, null, 2));
      lines.push("```\n");
    }

    lines.push("---\n");
  }

  return lines.join("\n");
}

/**
 * Generate full catalog documentation for all core contracts across domain, protocol, and harness.
 */
export function generateFullContractCatalogDoc(): string {
  const allSchemas: Record<string, z.ZodTypeAny> = {
    // Domain Schemas
    NormalizedSessionEvent: NormalizedSessionEventSchema,
    ToolManifest: ToolManifestSchema,
    ToolVersion: ToolVersionSchema,
    CapabilityEnvelope: CapabilityEnvelopeSchema,
    DeploymentRecord: DeploymentRecordSchema,
    CatalogSnapshot: CatalogSnapshotSchema,

    // Protocol Schemas
    ProtocolMessageEnvelope: ProtocolMessageEnvelopeSchema,
    DeviceAuthBootstrapResponse: DeviceAuthBootstrapResponseSchema,
    ObservationBatchRequest: ObservationBatchRequestSchema,
    ObservationBatchResponse: ObservationBatchResponseSchema,
    StreamMessage: StreamMessageSchema,
    // Harness Schemas
    HarnessInstallation: HarnessInstallationSchema,
    HarnessSession: HarnessSessionSchema,
    ConfigMutationPlan: ConfigMutationPlanSchema,
    AdapterCapabilities: AdapterCapabilitiesSchema,
    RefreshResult: RefreshResultSchema,
  };

  return generateMarkdownDocs(allSchemas, {
    title: "Resin Core Schema & Contract Catalog",
    description:
      "Comprehensive specification of all domain models, wire protocols, and harness adapter contracts.",
    includeExamples: true,
  });
}
