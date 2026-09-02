import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  type InvocationRecord,
  hashCanonicalContent,
  isSafetyGateBypassTool,
} from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { CallToolResult, JsonRpcParamValue, JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import type { ToolInvocationRouter } from "./router-contract.js";
import { isToolInScope } from "./search-tools.js";
import { isSystemMetaTool } from "./system-tools.js";
import { validateParameters } from "./validator-helper.js";

export interface InvokeToolParams {
  toolId?: string;
  name?: string;
  tool_name?: string;
  parameters?: JsonRpcParams;
  arguments?: JsonRpcParams;
  version?: string;
  timeout_ms?: number;
}

export interface CreateInvokeToolHandlerOptions {
  safetyGateEvaluator?: SafetyGateEvaluator;
  onInvocationRecorded?: (record: InvocationRecord) => Promise<void>;
}

function normalizeIdentifier(value: JsonRpcParamValue | undefined): string | undefined {
  return value &&
    Object.prototype.toString.call(value) === "[object String]" &&
    String(value).trim()
    ? String(value).trim()
    : undefined;
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
  safetyGateEvaluatorOrOptions?: SafetyGateEvaluator | CreateInvokeToolHandlerOptions,
  onInvocationRecordedHook?: (record: InvocationRecord) => Promise<void>,
): ToolHandler {
  let safetyGateEvaluator: SafetyGateEvaluator | undefined;
  let onInvocationRecorded: ((record: InvocationRecord) => Promise<void>) | undefined =
    onInvocationRecordedHook;

  if (safetyGateEvaluatorOrOptions) {
    if ("canExecuteTool" in safetyGateEvaluatorOrOptions) {
      safetyGateEvaluator = safetyGateEvaluatorOrOptions;
    } else {
      safetyGateEvaluator = safetyGateEvaluatorOrOptions.safetyGateEvaluator;
      if (!onInvocationRecorded) {
        onInvocationRecorded = safetyGateEvaluatorOrOptions.onInvocationRecorded;
      }
    }
  }

  return async (
    context: WorkspaceContext,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
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
    const rawTargetParams = params.parameters ?? params.arguments ?? {};
    if (
      !rawTargetParams ||
      !(rawTargetParams instanceof Object) ||
      Array.isArray(rawTargetParams)
    ) {
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
    // SAFETY: Verified rawTargetParams is a non-null, non-array object record.
    const targetParams = rawTargetParams as JsonRpcParams;

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
    const isMetaTool = Boolean(
      resolvedTool.isSystem ||
        resolvedTool.scope === "system" ||
        isSystemMetaTool(resolvedTool.toolId) ||
        isSystemMetaTool(resolvedTool.name),
    );
    const recordedToolId = resolvedTool.toolId;
    const recordedToolVersion = resolvedTool.version;

    const recordInvocation = (
      status: "success" | "error" | "timeout" | "rejected_capability",
      result?: CallToolResult,
      errorMessage?: string,
    ) => {
      if (!onInvocationRecorded || isMetaTool) {
        return;
      }
      try {
        const completedTime = Date.now();
        const completedAt = new Date(completedTime).toISOString();
        const durationMs = Math.max(0, completedTime - startTime);
        const semVerRegex =
          /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
        const toolVersion =
          recordedToolVersion && semVerRegex.test(recordedToolVersion)
            ? recordedToolVersion
            : "1.0.0";
        const sessionId = context.sessionId ?? `ses_standalone_${context.workspaceId}`;
        const inputDigest = hashCanonicalContent(targetParams);
        const outputDigest = result ? hashCanonicalContent(result) : undefined;
        const invocationId = `inv_${randomUUID().replace(/-/g, "")}`;

        const record: InvocationRecord = {
          invocationId,
          sessionId,
          workspaceId: context.workspaceId,
          toolId: recordedToolId,
          toolVersion,
          startedAt,
          completedAt,
          durationMs,
          status,
          inputDigest,
          ...(outputDigest ? { outputDigest } : {}),
          ...(errorMessage
            ? {
                errorDetails: {
                  errorType:
                    status === "timeout"
                      ? "TimeoutError"
                      : status === "rejected_capability"
                        ? "SafetyGateRefusal"
                        : "ToolExecutionError",
                  message: errorMessage,
                },
              }
            : {}),
        };

        Promise.resolve()
          .then(() => onInvocationRecorded(record))
          .catch((err) => {
            try {
              process.stderr.write(
                `[invoke-tool] Failed to record invocation: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
              );
            } catch {
              // Ignore write errors to closed stderr
            }
          });
      } catch (err) {
        try {
          process.stderr.write(
            `[invoke-tool] Failed to construct invocation record: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
          );
        } catch {
          // Ignore write errors to closed stderr
        }
      }
    };

    const requestedVersion = normalizeIdentifier(params.version);
    if (requestedVersion) {
      const explicitVersion =
        registry.getToolVersion(resolvedTool.toolId, requestedVersion) ??
        (publicName ? registry.getToolVersion(publicName, requestedVersion) : undefined);
      if (!explicitVersion || !isToolInScope(explicitVersion, context)) {
        const res: CallToolResult = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Version '${requestedVersion}' of tool '${displayIdentifier}' not found or not accessible.`,
            },
          ],
        };
        recordInvocation(
          "error",
          res,
          `Version '${requestedVersion}' of tool '${displayIdentifier}' not found or not accessible.`,
        );
        return res;
      }
      resolvedTool = explicitVersion;
    }

    const isDisabled =
      controls.disabledTools.includes(resolvedTool.toolId) && !resolvedTool.isSystem;
    if (isDisabled) {
      const res: CallToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool '${resolvedTool.name}' (${resolvedTool.toolId}) is disabled in workspace '${context.workspaceId}'.`,
          },
        ],
      };
      recordInvocation("error", res, `Tool '${resolvedTool.name}' is disabled.`);
      return res;
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
        const refusal = {
          isError: gateCheck.refusal.isError,
          refusalCode: gateCheck.refusal.refusalCode,
          refusalReason: gateCheck.refusal.refusalReason,
          remediation: gateCheck.refusal.remediation,
          unmetGates: gateCheck.refusal.unmetGates,
          evaluatedAt: gateCheck.refusal.evaluatedAt,
          content: gateCheck.refusal.content,
        };
        const res: CallToolResult = {
          isError: true,
          content: gateCheck.refusal.content,
          _meta: { refusal },
        };
        recordInvocation("rejected_capability", res, gateCheck.refusal.refusalReason);
        return res;
      }
    }

    const paramSchema = resolvedTool.parameters ?? resolvedTool.manifest?.parameters;
    const validation = validateParameters(paramSchema, targetParams);
    if (!validation.valid) {
      const res: CallToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: `Parameter validation failed for tool '${resolvedTool.name}': ${validation.errors.join("; ")}`,
          },
        ],
      };
      recordInvocation("error", res, validation.errors.join("; "));
      return res;
    }

    const timeoutMs =
      (Number.isFinite(params.timeout_ms) && Number(params.timeout_ms) > 0
        ? Number(params.timeout_ms)
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
        const res: CallToolResult = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool invocation for '${resolvedTool.name}' was cancelled.`,
            },
          ],
        };
        recordInvocation("error", res, "Tool invocation was cancelled.");
        return res;
      }
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const result = await invocationRouter.invoke({
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
      const status = result.isError
        ? result._meta?.refusal
          ? "rejected_capability"
          : "error"
        : "success";
      recordInvocation(status, result);
      return result;
    } catch (error) {
      if (timedOut) {
        const res: CallToolResult = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool '${resolvedTool.name}' timed out after ${timeoutMs}ms.`,
            },
          ],
        };
        recordInvocation(
          "timeout",
          res,
          `Tool '${resolvedTool.name}' timed out after ${timeoutMs}ms.`,
        );
        return res;
      }
      if (abortController.signal.aborted || parentSignal?.aborted) {
        const res: CallToolResult = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool invocation for '${resolvedTool.name}' was cancelled.`,
            },
          ],
        };
        recordInvocation("error", res, "Tool invocation was cancelled.");
        return res;
      }
      const message = error instanceof Error ? error.message : String(error);
      const res: CallToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${message}`,
          },
        ],
      };
      recordInvocation("error", res, message);
      return res;
    } finally {
      clearTimeout(timerId);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onParentAbort);
      }
    }
  };
}
