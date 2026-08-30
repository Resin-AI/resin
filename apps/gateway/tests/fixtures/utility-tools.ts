import type { ToolManifest } from "@resin/contracts";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import type { JsonRpcParams } from "../../src/protocol/types.js";
import type { RegistryTool } from "../../src/registry/types.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { withResolvers } from "../../src/utils/deferred.js";

const UTILITY_RUNTIME = ToolRuntimeRequirementSchema.parse({ runtime: "builtin" });
const UTILITY_CAPABILITIES = CapabilityManifestSchema.parse({});
const UTILITY_LIMITS = ToolLimitConfigSchema.parse({});

function utilityManifest(raw: {
  id: string;
  name: string;
  description: string;
  parameters?: JsonRpcParams;
}): ToolManifest {
  const parameters = ToolParameterSchema.parse(raw.parameters);
  const digest = computeManifestDigest({
    id: raw.id,
    name: raw.name,
    version: "1.0.0",
    description: raw.description,
    parameters,
    runtime: UTILITY_RUNTIME,
    capabilities: UTILITY_CAPABILITIES,
    limits: UTILITY_LIMITS,
  });

  return {
    id: raw.id,
    name: raw.name,
    version: "1.0.0",
    description: raw.description,
    parameters,
    runtime: UTILITY_RUNTIME,
    capabilities: UTILITY_CAPABILITIES,
    limits: UTILITY_LIMITS,
    digest,
  };
}

/**
 * Creates default test utility tools (echo, workspace_info, fail_tool, slow_tool)
 * for testing and developer harnesses.
 */
export function createDefaultUtilityTools(): RegistryTool[] {
  const echoManifest = utilityManifest({
    id: "tool_utility_echo",
    name: "echo",
    description: "Echoes back provided parameters",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
    },
  });

  const echo: RegistryTool = {
    toolId: "tool_utility_echo",
    name: "echo",
    exposedName: "echo",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: echoManifest.description,
    // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
    parameters: echoManifest.parameters as JsonRpcParams,
    manifest: echoManifest,
    handler: async (_context, params) => {
      const text =
        Object.prototype.toString.call(params.message) === "[object String]"
          ? `Echo: ${String(params.message)}`
          : `Echo: ${JSON.stringify(params)}`;
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    },
  };

  const workspaceInfoManifest = utilityManifest({
    id: "tool_utility_workspace_info",
    name: "workspace_info",
    description: "Returns active workspace context info",
    parameters: {
      type: "object",
      properties: {},
    },
  });

  const workspaceInfo: RegistryTool = {
    toolId: "tool_utility_workspace_info",
    name: "workspace_info",
    exposedName: "workspace_info",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: workspaceInfoManifest.description,
    // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
    parameters: workspaceInfoManifest.parameters as JsonRpcParams,
    manifest: workspaceInfoManifest,
    handler: async (context) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            workspaceId: context.workspaceId,
            rootPath: context.rootPath,
            canonicalPath: context.canonicalPath,
            repoName: context.repoName,
            isSymlink: context.isSymlink,
            readOnly: context.readOnly,
          }),
        },
      ],
    }),
  };

  const failManifest = utilityManifest({
    id: "tool_utility_fail_tool",
    name: "fail_tool",
    description: "Intentionally throws an error with provided message",
    parameters: {
      type: "object",
      properties: {
        errorMessage: { type: "string" },
        isToolResultError: { type: "boolean" },
      },
    },
  });

  const failTool: RegistryTool = {
    toolId: "tool_utility_fail_tool",
    name: "fail_tool",
    exposedName: "fail_tool",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: failManifest.description,
    // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
    parameters: failManifest.parameters as JsonRpcParams,
    manifest: failManifest,
    handler: async (_context, params) => {
      const msg =
        Object.prototype.toString.call(params.errorMessage) === "[object String]"
          ? String(params.errorMessage)
          : "Intentional tool failure";
      if (params.isToolResultError) {
        return {
          isError: true,
          content: [{ type: "text", text: msg }],
        };
      }
      throw new McpProtocolError(MCP_ERROR_CODES.INTERNAL_ERROR, msg);
    },
  };

  const slowManifest = utilityManifest({
    id: "tool_utility_slow_tool",
    name: "slow_tool",
    description: "Asynchronous tool that delays and supports progress and cancellation",
    parameters: {
      type: "object",
      properties: {
        durationMs: { type: "number" },
        steps: { type: "number" },
      },
    },
  });

  const slowTool: RegistryTool = {
    toolId: "tool_utility_slow_tool",
    name: "slow_tool",
    exposedName: "slow_tool",
    version: "1.0.0",
    scope: "global",
    status: "active",
    description: slowManifest.description,
    // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
    parameters: slowManifest.parameters as JsonRpcParams,
    manifest: slowManifest,
    handler: async (_context, params, options) => {
      const durationMs = Number.isFinite(params.durationMs) ? Number(params.durationMs) : 100;
      const steps = Number.isFinite(params.steps) ? Number(params.steps) : 2;

      for (let i = 1; i <= steps; i++) {
        if (options?.signal?.aborted) {
          throw new McpProtocolError(MCP_ERROR_CODES.INTERNAL_ERROR, "Operation cancelled");
        }

        if (options?.onProgress) {
          options.onProgress(i, steps);
        }

        if (stepDuration > 0) {
          const { promise, resolve, reject } = withResolvers<void>();
          const timer = setTimeout(resolve, stepDuration);

          const abortHandler = () => {
            clearTimeout(timer);
            reject(new McpProtocolError(MCP_ERROR_CODES.INTERNAL_ERROR, "Operation cancelled"));
          };

          if (options?.signal) {
            options.signal.addEventListener("abort", abortHandler, { once: true });
          }

          try {
            await promise;
          } finally {
            if (options?.signal) {
              options.signal.removeEventListener("abort", abortHandler);
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Completed ${steps} steps in ${durationMs}ms`,
          },
        ],
      };
    },
  };

  return [echo, workspaceInfo, failTool, slowTool];
}
