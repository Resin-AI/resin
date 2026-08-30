import type {
  CapabilityManifest,
  ToolLimitConfig,
  ToolOutputSchema,
  ToolParameterSchema,
} from "@resin/contracts";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { isToolInScope } from "./search-tools.js";

export interface ToolProvenance {
  manifestDigest: string;
  artifactDigest?: string;
  createdAt: string;
  updatedAt?: string;
  author?: string;
  evolutionCycle?: number;
}

export interface GetToolSchemaResponse {
  toolId: string;
  name: string;
  version: string;
  scope: string;
  status: string;
  description: string;
  inputSchema: ToolParameterSchema | JsonRpcParams;
  outputSchema?: ToolOutputSchema | JsonRpcParams;
  capabilities: CapabilityManifest;
  limits: ToolLimitConfig;
  provenance: ToolProvenance;
  isPinned: boolean;
  isDisabled: boolean;
}

export interface GetToolSchemaParams {
  toolId?: string;
  name?: string;
  tool_name?: string;
  version?: string;
}

/**
 * Factory for creating the get_tool_schema handler.
 */
export function createGetToolSchemaHandler(registry: ToolRegistry): ToolHandler {
  return async (context: WorkspaceContext, params: JsonRpcParams): Promise<CallToolResult> => {
    const toolIdOrName =
      (params.toolId && Object.prototype.toString.call(params.toolId) === "[object String]"
        ? String(params.toolId)
        : undefined) ??
      (params.tool_name && Object.prototype.toString.call(params.tool_name) === "[object String]"
        ? String(params.tool_name)
        : undefined) ??
      (params.name && Object.prototype.toString.call(params.name) === "[object String]"
        ? String(params.name)
        : undefined);

    if (!toolIdOrName) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Parameter 'toolId' or 'name' is required for schema lookup.",
          },
        ],
      };
    }
    const trimmedId = toolIdOrName.trim();
    const requestedVersion =
      params.version && Object.prototype.toString.call(params.version) === "[object String]"
        ? String(params.version)
        : undefined;

    const controls = await registry.controls.getControls(context.workspaceId);

    // Look up installed tools matching the identifier
    const allInstalled = registry.getAllRegisteredTools();
    const matchingTools = allInstalled.filter(
      (t) =>
        (t.toolId === trimmedId || t.name === trimmedId || t.exposedName === trimmedId) &&
        isToolInScope(t, context),
    );

    if (matchingTools.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${trimmedId}' not found or not accessible in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }

    // Resolve target version
    let resolvedTool = matchingTools[0];
    if (requestedVersion) {
      const byVersion = matchingTools.find((t) => t.version === requestedVersion);
      if (!byVersion) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Version '${requestedVersion}' of tool '${trimmedId}' not found. Available versions: ${matchingTools.map((t) => t.version).join(", ")}.`,
            },
          ],
        };
      }
      resolvedTool = byVersion;
    } else {
      // Check if pinned
      const pinnedVer = controls.pinnedVersions[resolvedTool.toolId];
      if (pinnedVer) {
        const pinnedTool = matchingTools.find((t) => t.version === pinnedVer);
        if (pinnedTool) {
          resolvedTool = pinnedTool;
        }
      } else {
        // Pick latest version in matching set
        const latestVer = registry.getLatestRegisteredVersion(resolvedTool.toolId);
        if (latestVer) {
          const latestTool = matchingTools.find((t) => t.version === latestVer);
          if (latestTool) {
            resolvedTool = latestTool;
          }
        }
      }
    }

    const isPinned = controls.pinnedVersions[resolvedTool.toolId] === resolvedTool.version;
    const isDisabled =
      controls.disabledTools.includes(resolvedTool.toolId) && !resolvedTool.isSystem;

    // Extract input schema safely
    const inputSchema: ToolParameterSchema | JsonRpcParams = resolvedTool.parameters ??
      resolvedTool.manifest?.parameters ?? {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      };

    // Extract output schema if available in metadata
    const outputSchema: ToolOutputSchema | JsonRpcParams | undefined =
      resolvedTool.outputSchema ?? resolvedTool.manifest?.outputSchema;
    // Extract capabilities safely
    const capabilities: CapabilityManifest = resolvedTool.manifest?.capabilities ?? {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowedHosts: [],
        allowedPorts: [],
        allowAll: false,
      },
      command: {
        allowedCommands: [],
        allowShell: false,
        timeoutMs: 30000,
      },
      secrets: {
        allowedKeys: [],
        allowAll: false,
      },
      limits: {
        maxExecutionTimeMs: 30000,
        maxMemoryMb: 128,
        maxDiskMb: 0,
        maxNetworkPayloadMb: 0,
      },
    };

    // Extract limits
    const limits: ToolLimitConfig = resolvedTool.manifest?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    };

    // Extract provenance
    const artifactDigest = resolvedTool.artifact?.artifactDigest;

    const manifestMetadata = resolvedTool.manifest?.metadata;
    const toolMetadata = resolvedTool.metadata;
    const authorRaw = manifestMetadata?.author ?? toolMetadata?.author;
    const evolutionCycleRaw = manifestMetadata?.evolutionCycle ?? toolMetadata?.evolutionCycle;

    const provenance: ToolProvenance = {
      manifestDigest: resolvedTool.manifest?.digest ?? "",
      artifactDigest,
      createdAt:
        resolvedTool.manifest?.createdAt ?? resolvedTool.createdAt ?? new Date().toISOString(),
      updatedAt: resolvedTool.manifest?.updatedAt ?? resolvedTool.updatedAt,
      author:
        authorRaw && Object.prototype.toString.call(authorRaw) === "[object String]"
          ? String(authorRaw)
          : undefined,
      evolutionCycle: Number.isFinite(evolutionCycleRaw) ? Number(evolutionCycleRaw) : undefined,
    };
    const response: GetToolSchemaResponse = {
      toolId: resolvedTool.toolId,
      name: resolvedTool.exposedName || resolvedTool.name,
      version: resolvedTool.version,
      scope: resolvedTool.scope ?? "workspace",
      status: isDisabled ? "disabled" : resolvedTool.status || "active",
      description: resolvedTool.description || resolvedTool.manifest?.description || "",
      inputSchema,
      outputSchema,
      capabilities,
      limits,
      provenance,
      isPinned,
      isDisabled,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  };
}
