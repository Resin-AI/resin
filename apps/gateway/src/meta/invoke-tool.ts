import { isSafetyGateBypassTool } from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { CallToolResult } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import type { ToolInvocationRouter } from "./router-contract.js";
import { isToolInScope } from "./search-tools.js";
import { validateParameters } from "./validator-helper.js";

export interface InvokeToolParams {
  toolId?: string;
  name?: string;
  tool_name?: string;
  parameters?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  version?: string;
  timeout_ms?: number;
}

function normalizeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSameLogicalTool(left: RegistryTool, right: RegistryTool): boolean {
  if (left.toolId === right.toolId) {
    return true;
  }

  const leftManifestId = left.manifest?.id;
  const rightManifestId = right.manifest?.id;
  return Boolean(leftManifestId && rightManifestId && leftManifestId === rightManifestId);
}

/**
 * Factory for creating the invoke_tool handler.
 */
export function createInvokeToolHandler(
  registry: ToolRegistry,
  invocationRouter: ToolInvocationRouter,
  safetyGateEvaluator?: SafetyGateEvaluator,
): ToolHandler {
  return async (
    context: WorkspaceContext,
    rawParams: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const params = (rawParams || {}) as InvokeToolParams;
    const publicName = normalizeIdentifier(params.name) ?? normalizeIdentifier(params.tool_name);
    const toolId = normalizeIdentifier(params.toolId);
    const displayIdentifier = publicName ?? toolId;

    if (!displayIdentifier) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Parameter 'toolId' or 'name' is required for tool invocation.",
          },
        ],
      };
    }

    const targetParams = (params.parameters ?? params.arguments ?? {}) as Record<string, unknown>;

    if (typeof targetParams !== "object" || targetParams === null || Array.isArray(targetParams)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Parameter 'parameters' must be a JSON object.",
          },
        ],
      };
    }

    // Use the canonical catalog resolver used by native invocation. It applies scope
    // precedence, active versions, pins, disables, and exposed-name collision handling.
    const byName = publicName
      ? await registry.getTool(publicName, context.workspaceId, context.sessionId)
      : undefined;
    const byId = toolId
      ? await registry.getTool(toolId, context.workspaceId, context.sessionId)
      : undefined;

    const controls = await registry.controls.getControls(context.workspaceId);
    const findDisabledScopedTool = (identifier: string | undefined): RegistryTool | undefined => {
      if (!identifier) {
        return undefined;
      }
      return registry
        .getAllRegisteredTools()
        .find(
          (tool) =>
            !tool.isSystem &&
            controls.disabledTools.includes(tool.toolId) &&
            isToolInScope(tool, context) &&
            (tool.toolId === identifier ||
              tool.name === identifier ||
              tool.exposedName === identifier),
        );
    };

    const disabledByName = byName ? undefined : findDisabledScopedTool(publicName);
    const disabledById = byId ? undefined : findDisabledScopedTool(toolId);
    const resolvedByName = byName ?? disabledByName;
    const resolvedById = byId ?? disabledById;

    if (resolvedByName && resolvedById && !isSameLogicalTool(resolvedByName, resolvedById)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Conflicting tool identifiers: name '${publicName}' and toolId '${toolId}' resolve to different tools.`,
          },
        ],
      };
    }

    let resolvedTool = byName ?? byId ?? disabledByName ?? disabledById;
    if (!resolvedTool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${displayIdentifier}' not found or not accessible in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }

    if (params.version && typeof params.version === "string") {
      const requestedVersion = params.version.trim();
      const explicitVersion =
        registry.getToolVersion(resolvedTool.toolId, requestedVersion) ??
        (publicName ? registry.getToolVersion(publicName, requestedVersion) : undefined);
      if (!explicitVersion || !isToolInScope(explicitVersion, context)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Version '${requestedVersion}' of tool '${displayIdentifier}' not found or not accessible.`,
            },
          ],
        };
      }
      resolvedTool = explicitVersion;
    }

    const isDisabled =
      controls.disabledTools.includes(resolvedTool.toolId) && !resolvedTool.isSystem;
    if (isDisabled) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${resolvedTool.name}' (${resolvedTool.toolId}) is disabled in workspace '${context.workspaceId}'.`,
          },
        ],
      };
    }

    if (
      safetyGateEvaluator &&
      !resolvedTool.isSystem &&
      !isSafetyGateBypassTool(resolvedTool.name) &&
      !isSafetyGateBypassTool(resolvedTool.toolId)
    ) {
      const gateCheck = safetyGateEvaluator.canExecuteTool(
        resolvedTool.toolId,
        resolvedTool.name,
        Boolean(resolvedTool.isSystem),
      );
      if (!gateCheck.allowed && gateCheck.refusal) {
        return {
          isError: true,
          content: gateCheck.refusal.content,
          _meta: { refusal: gateCheck.refusal },
        };
      }
    }

    const paramSchema = resolvedTool.parameters ?? resolvedTool.manifest?.parameters;
    const validation = validateParameters(paramSchema, targetParams);
    if (!validation.valid) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Parameter validation failed for tool '${resolvedTool.name}': ${validation.errors.join("; ")}`,
          },
        ],
      };
    }

    const timeoutMs =
      (typeof params.timeout_ms === "number" && params.timeout_ms > 0
        ? params.timeout_ms
        : undefined) ??
      options?.timeoutMs ??
      resolvedTool.manifest?.limits?.timeoutMs ??
      30000;

    const abortController = new AbortController();
    let timedOut = false;
    let timerId: NodeJS.Timeout | undefined;

    if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
      timerId = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const parentSignal = options?.signal;
    const onParentAbort = () => {
      abortController.abort(new Error("Tool invocation cancelled by caller"));
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        clearTimeout(timerId);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool invocation for '${resolvedTool.name}' was cancelled.`,
            },
          ],
        };
      }
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      return await invocationRouter.invoke({
        toolId: resolvedTool.toolId,
        name: resolvedTool.name,
        version: resolvedTool.version,
        parameters: targetParams,
        context,
        manifest: resolvedTool.manifest,
        signal: abortController.signal,
        onProgress: options?.onProgress,
        timeoutMs,
      });
    } catch (error) {
      if (timedOut) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool '${resolvedTool.name}' timed out after ${timeoutMs}ms.`,
            },
          ],
        };
      }
      if (abortController.signal.aborted || parentSignal?.aborted) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool invocation for '${resolvedTool.name}' was cancelled.`,
            },
          ],
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${message}`,
          },
        ],
      };
    } finally {
      clearTimeout(timerId);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    }
  };
}
