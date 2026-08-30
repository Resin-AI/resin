import type { ToolManifest } from "@resin/contracts";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import { computeManifestDigest } from "../registry/validator.js";
import { createGetToolSchemaHandler } from "./get-tool-schema.js";
import { createInvokeToolHandler } from "./invoke-tool.js";
import { createManageToolsHandler } from "./manage-tools.js";
import { DefaultToolInvocationRouter, type ToolInvocationRouter } from "./router-contract.js";
import { createSearchToolsHandler } from "./search-tools.js";

export const SYSTEM_META_TOOL_IDS = {
  SEARCH_TOOLS: "sys_search_tools",
  GET_TOOL_SCHEMA: "sys_get_tool_schema",
  INVOKE_TOOL: "sys_invoke_tool",
  MANAGE_TOOLS: "sys_manage_tools",
} as const;

export const SYSTEM_META_TOOL_NAMES = {
  SEARCH_TOOLS: "search_tools",
  GET_TOOL_SCHEMA: "get_tool_schema",
  INVOKE_TOOL: "invoke_tool",
  MANAGE_TOOLS: "manage_tools",
} as const;

const SYSTEM_TOOL_IDENTIFIERS = {
  sys_search_tools: true,
  sys_get_tool_schema: true,
  sys_invoke_tool: true,
  sys_manage_tools: true,
  search_tools: true,
  get_tool_schema: true,
  invoke_tool: true,
  manage_tools: true,
} as const;

type SystemToolIdentifier = keyof typeof SYSTEM_TOOL_IDENTIFIERS;

function isSystemToolIdentifier(value: string): value is SystemToolIdentifier {
  return Object.prototype.hasOwnProperty.call(SYSTEM_TOOL_IDENTIFIERS, value);
}

/**
 * Returns true if the identifier refers to one of the 4 invariant system meta-tools.
 */
export function isSystemMetaTool(toolIdOrName: string): boolean {
  if (!toolIdOrName || Object.prototype.toString.call(toolIdOrName) !== "[object String]") {
    return false;
  }
  return isSystemToolIdentifier(toolIdOrName.trim().toLowerCase());
}

const DEFAULT_SYSTEM_RUNTIME = ToolRuntimeRequirementSchema.parse({
  runtime: "builtin",
});

const DEFAULT_SYSTEM_CAPABILITIES = CapabilityManifestSchema.parse({});
const DEFAULT_SYSTEM_LIMITS = ToolLimitConfigSchema.parse({});

const SEARCH_TOOLS_RAW: ToolManifest = {
  id: SYSTEM_META_TOOL_IDS.SEARCH_TOOLS,
  name: SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS,
  version: "1.0.0",
  description:
    "Discovers and searches available tools in the caller's scoped catalog by query, tags, capabilities, or scope with capability summaries and pagination.",
  parameters: ToolParameterSchema.parse({
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Optional query string for lexical search against tool names, descriptions, and tags.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter tools by tags.",
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "Filter tools by required capability types (e.g. fs, net, shell, crypto).",
      },
      scope: {
        type: "string",
        enum: ["session", "workspace", "account", "system", "global", "all"],
        description: "Filter tools by scope hierarchy level.",
      },
      status: {
        type: "string",
        enum: ["active", "draft", "deprecated", "revoked", "all"],
        description: "Filter tools by status. Defaults to active.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of tools to return (default: 20, max: 100).",
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: "integer",
        description: "Number of tools to skip for pagination (default: 0).",
        minimum: 0,
      },
    },
    required: [],
    additionalProperties: true,
  }),
  runtime: DEFAULT_SYSTEM_RUNTIME,
  capabilities: DEFAULT_SYSTEM_CAPABILITIES,
  limits: DEFAULT_SYSTEM_LIMITS,
  scope: "global" as const,
  digest: "",
  metadata: {
    isSystem: true,
    immutable: true,
    tags: ["system", "meta", "discovery", "search"],
  },
  createdAt: "2026-08-17T00:00:00.000Z",
};

export const SEARCH_TOOLS_MANIFEST: ToolManifest = {
  ...SEARCH_TOOLS_RAW,
  digest: computeManifestDigest(SEARCH_TOOLS_RAW),
};

const GET_TOOL_SCHEMA_RAW: ToolManifest = {
  id: SYSTEM_META_TOOL_IDS.GET_TOOL_SCHEMA,
  name: SYSTEM_META_TOOL_NAMES.GET_TOOL_SCHEMA,
  version: "1.0.0",
  description:
    "Retrieves complete parameter schemas, output schemas, capabilities, limits, provenance, and status for a tool without leaking source code or secrets.",
  parameters: ToolParameterSchema.parse({
    type: "object",
    properties: {
      toolId: {
        type: "string",
        description: "Unique identifier of the tool.",
      },
      name: {
        type: "string",
        description: "Exposed name of the tool (alternative to toolId).",
      },
      tool_name: {
        type: "string",
        description: "Alias for name.",
      },
      version: {
        type: "string",
        description:
          "Optional specific version to inspect. If omitted, returns active/pinned version.",
      },
    },
    required: [],
    additionalProperties: true,
  }),
  runtime: DEFAULT_SYSTEM_RUNTIME,
  capabilities: DEFAULT_SYSTEM_CAPABILITIES,
  limits: DEFAULT_SYSTEM_LIMITS,
  scope: "global" as const,
  digest: "",
  metadata: {
    isSystem: true,
    immutable: true,
    tags: ["system", "meta", "schema", "inspection"],
  },
  createdAt: "2026-08-17T00:00:00.000Z",
};

export const GET_TOOL_SCHEMA_MANIFEST: ToolManifest = {
  ...GET_TOOL_SCHEMA_RAW,
  digest: computeManifestDigest(GET_TOOL_SCHEMA_RAW),
};

const INVOKE_TOOL_RAW: ToolManifest = {
  id: SYSTEM_META_TOOL_IDS.INVOKE_TOOL,
  name: SYSTEM_META_TOOL_NAMES.INVOKE_TOOL,
  version: "1.0.0",
  description:
    "Invokes an active tool with strict parameter schema validation, context preservation, execution limits, timeout support, and cancellation.",
  parameters: ToolParameterSchema.parse({
    type: "object",
    properties: {
      toolId: {
        type: "string",
        description: "Unique identifier of the tool to invoke.",
      },
      name: {
        type: "string",
        description: "Exposed name of the tool to invoke.",
      },
      tool_name: {
        type: "string",
        description: "Alias for name.",
      },
      parameters: {
        type: "object",
        description: "Parameters/arguments passed to the tool.",
      },
      arguments: {
        type: "object",
        description: "Alias for parameters.",
      },
      version: {
        type: "string",
        description: "Optional specific version to invoke.",
      },
      timeout_ms: {
        type: "integer",
        description: "Optional timeout in milliseconds.",
        minimum: 1,
      },
    },
    required: [],
    additionalProperties: true,
  }),
  runtime: DEFAULT_SYSTEM_RUNTIME,
  capabilities: DEFAULT_SYSTEM_CAPABILITIES,
  limits: DEFAULT_SYSTEM_LIMITS,
  scope: "global" as const,
  digest: "",
  metadata: {
    isSystem: true,
    immutable: true,
    tags: ["system", "meta", "execution", "invocation"],
  },
  createdAt: "2026-08-17T00:00:00.000Z",
};

export const INVOKE_TOOL_MANIFEST: ToolManifest = {
  ...INVOKE_TOOL_RAW,
  digest: computeManifestDigest(INVOKE_TOOL_RAW),
};

const MANAGE_TOOLS_RAW: ToolManifest = {
  id: SYSTEM_META_TOOL_IDS.MANAGE_TOOLS,
  name: SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS,
  version: "1.0.0",
  description:
    "Manages tool versions, user pinning, disabling/enabling, rollbacks, and inspects tool status.",
  parameters: ToolParameterSchema.parse({
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list_versions",
          "status",
          "pin",
          "unpin",
          "disable",
          "enable",
          "rollback",
          "clear_override",
        ],
        description: "Management action to perform.",
      },
      toolId: {
        type: "string",
        description: "Tool identifier.",
      },
      name: {
        type: "string",
        description: "Exposed name of the tool.",
      },
      version: {
        type: "string",
        description: "Version string (required for pin and rollback).",
      },
      scope: {
        type: "string",
        enum: ["session", "workspace", "account", "system"],
        description: "Target scope hierarchy for the action. Defaults to workspace.",
      },
    },
    required: ["action"],
    additionalProperties: true,
  }),
  runtime: DEFAULT_SYSTEM_RUNTIME,
  capabilities: DEFAULT_SYSTEM_CAPABILITIES,
  limits: DEFAULT_SYSTEM_LIMITS,
  scope: "global" as const,
  digest: "",
  metadata: {
    isSystem: true,
    immutable: true,
    tags: ["system", "meta", "management", "control"],
  },
  createdAt: "2026-08-17T00:00:00.000Z",
};

export const MANAGE_TOOLS_MANIFEST: ToolManifest = {
  ...MANAGE_TOOLS_RAW,
  digest: computeManifestDigest(MANAGE_TOOLS_RAW),
};

/**
 * Creates the 4 invariant system meta-tools bound to a ToolRegistry and optional ToolInvocationRouter.
 */
export function createSystemMetaTools(
  registry: ToolRegistry,
  invocationRouter?: ToolInvocationRouter,
  safetyGateEvaluator?: SafetyGateEvaluator,
): RegistryTool[] {
  const router = invocationRouter ?? new DefaultToolInvocationRouter(registry);

  const searchTool: RegistryTool = {
    toolId: SYSTEM_META_TOOL_IDS.SEARCH_TOOLS,
    name: SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS,
    exposedName: SYSTEM_META_TOOL_NAMES.SEARCH_TOOLS,
    version: "1.0.0",
    scope: "system",
    status: "active",
    description: SEARCH_TOOLS_MANIFEST.description,
    // SAFETY: System tool manifest parameters conform to JSON-RPC parameter record structure.
    parameters: SEARCH_TOOLS_MANIFEST.parameters as JsonRpcParams,
    manifest: SEARCH_TOOLS_MANIFEST,
    handler: createSearchToolsHandler(registry),
    isSystem: true,
  };

  const schemaTool: RegistryTool = {
    toolId: SYSTEM_META_TOOL_IDS.GET_TOOL_SCHEMA,
    name: SYSTEM_META_TOOL_NAMES.GET_TOOL_SCHEMA,
    exposedName: SYSTEM_META_TOOL_NAMES.GET_TOOL_SCHEMA,
    version: "1.0.0",
    scope: "system",
    status: "active",
    description: GET_TOOL_SCHEMA_MANIFEST.description,
    // SAFETY: System tool manifest parameters conform to JSON-RPC parameter record structure.
    parameters: GET_TOOL_SCHEMA_MANIFEST.parameters as JsonRpcParams,
    manifest: GET_TOOL_SCHEMA_MANIFEST,
    handler: createGetToolSchemaHandler(registry),
    isSystem: true,
  };

  const invokeTool: RegistryTool = {
    toolId: SYSTEM_META_TOOL_IDS.INVOKE_TOOL,
    name: SYSTEM_META_TOOL_NAMES.INVOKE_TOOL,
    exposedName: SYSTEM_META_TOOL_NAMES.INVOKE_TOOL,
    version: "1.0.0",
    scope: "system",
    status: "active",
    description: INVOKE_TOOL_MANIFEST.description,
    // SAFETY: System tool manifest parameters conform to JSON-RPC parameter record structure.
    parameters: INVOKE_TOOL_MANIFEST.parameters as JsonRpcParams,
    manifest: INVOKE_TOOL_MANIFEST,
    handler: createInvokeToolHandler(registry, router, safetyGateEvaluator),
    isSystem: true,
  };

  const manageTool: RegistryTool = {
    toolId: SYSTEM_META_TOOL_IDS.MANAGE_TOOLS,
    name: SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS,
    exposedName: SYSTEM_META_TOOL_NAMES.MANAGE_TOOLS,
    version: "1.0.0",
    scope: "system",
    status: "active",
    description: MANAGE_TOOLS_MANIFEST.description,
    // SAFETY: System tool manifest parameters conform to JSON-RPC parameter record structure.
    parameters: MANAGE_TOOLS_MANIFEST.parameters as JsonRpcParams,
    manifest: MANAGE_TOOLS_MANIFEST,
    handler: createManageToolsHandler(registry, safetyGateEvaluator),
    isSystem: true,
  };
  return [searchTool, schemaTool, invokeTool, manageTool];
}
