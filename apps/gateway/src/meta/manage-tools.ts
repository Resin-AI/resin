import type { ProductionSafetyGateStatus } from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { isToolInScope } from "./search-tools.js";

export type ManageToolsAction =
  | "list_versions"
  | "status"
  | "pin"
  | "unpin"
  | "disable"
  | "enable"
  | "rollback"
  | "clear_override";

export interface ManageToolsParams {
  action: ManageToolsAction;
  toolId?: string;
  name?: string;
  tool_name?: string;
  version?: string;
  scope?: "session" | "workspace" | "account" | "system";
}

/**
 * Checks if a tool identifier refers to an invariant system meta-tool.
 */
function isSystemTool(toolIdOrName: string): boolean {
  const normalized = toolIdOrName.trim().toLowerCase();
  return (
    normalized === "search_tools" ||
    normalized === "get_tool_schema" ||
    normalized === "invoke_tool" ||
    normalized === "manage_tools" ||
    normalized === "sys_search_tools" ||
    normalized === "sys_get_tool_schema" ||
    normalized === "sys_invoke_tool" ||
    normalized === "sys_manage_tools"
  );
}

/**
 * Factory for creating the manage_tools handler.
 */
export function createManageToolsHandler(
  registry: ToolRegistry,
  safetyGateEvaluator?: SafetyGateEvaluator,
): ToolHandler {
  return async (
    context: WorkspaceContext,
    params: JsonRpcParams,
    _options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const action =
      params.action && Object.prototype.toString.call(params.action) === "[object String]"
        ? String(params.action)
        : undefined;

    if (!action) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Parameter 'action' is required (e.g. list_versions, status, pin, unpin, disable, enable, rollback, clear_override).",
          },
        ],
      };
    }

    const rawId = params.toolId ?? params.name ?? params.tool_name;
    const toolId =
      params.toolId && Object.prototype.toString.call(params.toolId) === "[object String]"
        ? String(params.toolId)
        : params.name && Object.prototype.toString.call(params.name) === "[object String]"
          ? String(params.name)
          : undefined;
    const workspaceId = context.workspaceId;

    // Load controls for the workspace
    const controls = await registry.controls.getControls(workspaceId);

    switch (action) {
      case "list_versions": {
        const allInstalled = registry.getAllRegisteredTools();

        if (toolId) {
          const matching = allInstalled.filter(
            (t) =>
              (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
              isToolInScope(t, context),
          );

          if (matching.length === 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Tool '${toolId}' not found or not accessible in workspace '${workspaceId}'.`,
                },
              ],
            };
          }

          const primaryId = matching[0].toolId;
          const pinnedVer = controls.pinnedVersions[primaryId];
          const isDisabled = controls.disabledTools.includes(primaryId) && !matching[0].isSystem;

          const versions = matching.map((t) => ({
            version: t.version,
            status: t.status || "active",
            manifestDigest: t.manifest.digest,
            artifactDigest: t.artifact?.artifactDigest,
            createdAt: t.manifest.createdAt || t.createdAt,
            isPinned: pinnedVer === t.version,
            isActive: !isDisabled && (pinnedVer ? pinnedVer === t.version : true),
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    toolId: primaryId,
                    name: matching[0].exposedName || matching[0].name,
                    scope: matching[0].scope ?? "workspace",
                    pinnedVersion: pinnedVer,
                    isDisabled,
                    installedVersions: versions,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // List all tools and their installed versions
        const grouped = new Map<string, typeof allInstalled>();
        for (const t of allInstalled) {
          if (!isToolInScope(t, context)) continue;
          const list = grouped.get(t.toolId) ?? [];
          list.push(t);
          grouped.set(t.toolId, list);
        }

        const resultTools = Array.from(grouped.entries()).map(([tid, toolList]) => {
          const pinnedVer = controls.pinnedVersions[tid];
          const isDisabled = controls.disabledTools.includes(tid) && !toolList[0].isSystem;
          return {
            toolId: tid,
            name: toolList[0].exposedName || toolList[0].name,
            scope: toolList[0].scope ?? "workspace",
            pinnedVersion: pinnedVer,
            isDisabled,
            versions: toolList.map((t) => t.version),
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tools: resultTools }, null, 2),
            },
          ],
        };
      }

      case "status": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Parameter 'toolId' or 'name' is required for action 'status'.",
              },
            ],
          };
        }

        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.filter(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );

        if (matching.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Tool '${toolId}' not found or not accessible in workspace '${workspaceId}'.`,
              },
            ],
          };
        }

        const primaryTool = matching[0];
        const primaryId = primaryTool.toolId;
        const pinnedVer = controls.pinnedVersions[primaryId];
        const isDisabled = controls.disabledTools.includes(primaryId) && !primaryTool.isSystem;

        let activeVersion = pinnedVer;
        if (!activeVersion) {
          const latestVer = registry.getLatestRegisteredVersion(primaryId);
          activeVersion = latestVer ?? matching[0].version;
        }

        const gateStatus = safetyGateEvaluator ? safetyGateEvaluator.getStatus() : undefined;
        const statusPayload = gateStatus
          ? {
              toolId: primaryId,
              name: primaryTool.exposedName || primaryTool.name,
              activeVersion,
              pinnedVersion: pinnedVer,
              isDisabled,
              isSystem: Boolean(primaryTool.isSystem),
              installedVersions: matching.map((t) => t.version),
              rollbacks: controls.rollbacks ?? [],
              safetyGate: gateStatus,
            }
          : {
              toolId: primaryId,
              name: primaryTool.exposedName || primaryTool.name,
              activeVersion,
              pinnedVersion: pinnedVer,
              isDisabled,
              isSystem: Boolean(primaryTool.isSystem),
              installedVersions: matching.map((t) => t.version),
              rollbacks: controls.rollbacks ?? [],
            };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(statusPayload, null, 2),
            },
          ],
        };
      }

      case "pin": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Parameter 'toolId' or 'name' is required for action 'pin'." },
            ],
          };
        }
        if (
          !params.version ||
          Object.prototype.toString.call(params.version) !== "[object String]"
        ) {
          return {
            isError: true,
            content: [{ type: "text", text: "Parameter 'version' is required for action 'pin'." }],
          };
        }

        if (isSystemTool(toolId)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Cannot pin invariant system meta-tool '${toolId}'.` }],
          };
        }

        const versionToPin = String(params.version).trim();
        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.filter(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );

        if (matching.length === 0) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Tool '${toolId}' not found in workspace '${workspaceId}'.` },
            ],
          };
        }

        const targetId = matching[0].toolId;
        const hasVersion = matching.some((t) => t.version === versionToPin);
        if (!hasVersion) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Version '${versionToPin}' is not installed for tool '${targetId}'. Installed versions: ${matching.map((t) => t.version).join(", ")}.`,
              },
            ],
          };
        }

        await registry.pinToolVersion(targetId, versionToPin, workspaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: "pin",
                  toolId: targetId,
                  version: versionToPin,
                  workspaceId,
                  message: `Tool '${targetId}' pinned to version '${versionToPin}' in workspace '${workspaceId}'.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "unpin": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Parameter 'toolId' or 'name' is required for action 'unpin'.",
              },
            ],
          };
        }

        if (isSystemTool(toolId)) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Cannot unpin invariant system meta-tool '${toolId}'.` },
            ],
          };
        }

        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.find(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );
        const targetId = matching ? matching.toolId : toolId;

        await registry.unpinToolVersion(targetId, workspaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: "unpin",
                  toolId: targetId,
                  workspaceId,
                  message: `Pin removed for tool '${targetId}' in workspace '${workspaceId}'.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "disable": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Parameter 'toolId' or 'name' is required for action 'disable'.",
              },
            ],
          };
        }

        if (isSystemTool(toolId)) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Cannot disable invariant system meta-tool '${toolId}'.` },
            ],
          };
        }

        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.find(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );
        const targetId = matching ? matching.toolId : toolId;

        await registry.disableTool(targetId, workspaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: "disable",
                  toolId: targetId,
                  workspaceId,
                  message: `Tool '${targetId}' disabled in workspace '${workspaceId}'.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "enable": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Parameter 'toolId' or 'name' is required for action 'enable'.",
              },
            ],
          };
        }

        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.find(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );
        const targetId = matching ? matching.toolId : toolId;

        await registry.enableTool(targetId, workspaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: "enable",
                  toolId: targetId,
                  workspaceId,
                  message: `Tool '${targetId}' enabled in workspace '${workspaceId}'.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "rollback": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Parameter 'toolId' or 'name' is required for action 'rollback'.",
              },
            ],
          };
        }
        if (
          !params.version ||
          Object.prototype.toString.call(params.version) !== "[object String]"
        ) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Parameter 'version' is required for action 'rollback'." },
            ],
          };
        }

        if (isSystemTool(toolId)) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Cannot rollback invariant system meta-tool '${toolId}'.` },
            ],
          };
        }

        const versionToRollback = String(params.version).trim();
        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.filter(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );

        if (matching.length === 0) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Tool '${toolId}' not found in workspace '${workspaceId}'.` },
            ],
          };
        }

        const targetId = matching[0].toolId;
        const hasVersion = matching.some((t) => t.version === versionToRollback);
        if (!hasVersion) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Cannot rollback: version '${versionToRollback}' is not installed for tool '${targetId}'. Installed versions: ${matching.map((t) => t.version).join(", ")}.`,
              },
            ],
          };
        }

        await registry.rollbackTool(targetId, versionToRollback, workspaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: "rollback",
                  toolId: targetId,
                  targetVersion: versionToRollback,
                  workspaceId,
                  message: `Tool '${targetId}' rolled back to version '${versionToRollback}' in workspace '${workspaceId}'.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "clear_override": {
        if (!toolId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Parameter 'toolId' or 'name' is required for action 'clear_override'.",
              },
            ],
          };
        }

        if (isSystemTool(toolId)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Cannot clear overrides on invariant system meta-tool '${toolId}'.`,
              },
            ],
          };
        }

        const allInstalled = registry.getAllRegisteredTools();
        const matching = allInstalled.find(
          (t) =>
            (t.toolId === toolId || t.name === toolId || t.exposedName === toolId) &&
            isToolInScope(t, context),
        );
        const targetId = matching ? matching.toolId : toolId;

        await registry.unpinToolVersion(targetId, workspaceId);
        await registry.enableTool(targetId, workspaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  action: "clear_override",
                  toolId: targetId,
                  workspaceId,
                  message: `Overrides cleared for tool '${targetId}' in workspace '${workspaceId}'.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown management action '${action}'. Supported actions: list_versions, status, pin, unpin, disable, enable, rollback, clear_override.`,
            },
          ],
        };
    }
  };
}
