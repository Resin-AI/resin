import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  type InvocationRecord,
  type InvocationUsageEstimate,
  TOOL_IO_UTF8_METHOD,
  type WorkflowJsonValue,
  analyzeAgentArguments,
  bytesToTokens,
  createUsageEstimate,
  estimatePayloadBytes,
  hashCanonicalContent,
  isSafetyGateBypassTool,
} from "@resin/contracts";
import { type SafetyGateEvaluator, WorkflowReferenceScope } from "@resin/runtime";
import type { CallToolResult, JsonRpcParamValue, JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import {
  SessionDiscoveryTracker as DefaultSessionDiscoveryTracker,
  type SessionDiscoveryTracker,
  isDiscoveryTool,
} from "./discovery-tracker.js";
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
  discoveryTracker?: SessionDiscoveryTracker;
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
 * Per-session reference scopes for composed invoke_tool calls. A session that passes
 * `{reference}` envelopes gets one scope holding that session's registered results;
 * references from another scope never resolve here. Bounded like the discovery tracker.
 */
interface ComposedSessionScope {
  scope: WorkflowReferenceScope;
  callCounter: number;
}

const MAX_COMPOSED_SCOPES = 512;

/**
 * The value a composed call's result is registered under and reported back to the
 * caller: the tool's own result, not the transport wrapper. A single text payload is
 * parsed as JSON when it is one; otherwise the raw text stands.
 */
export function composedResultValue(result: CallToolResult): WorkflowJsonValue {
  const content = result.content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
    const text = content[0].text;
    try {
      return JSON.parse(text) as WorkflowJsonValue;
    } catch {
      return text;
    }
  }
  return content === undefined ? null : (content as unknown as WorkflowJsonValue);
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
  let discoveryTracker: SessionDiscoveryTracker = DefaultSessionDiscoveryTracker.getInstance();

  if (safetyGateEvaluatorOrOptions) {
    if ("canExecuteTool" in safetyGateEvaluatorOrOptions) {
      safetyGateEvaluator = safetyGateEvaluatorOrOptions;
    } else {
      safetyGateEvaluator = safetyGateEvaluatorOrOptions.safetyGateEvaluator;
      if (!onInvocationRecorded) {
        onInvocationRecorded = safetyGateEvaluatorOrOptions.onInvocationRecorded;
      }
      if (safetyGateEvaluatorOrOptions.discoveryTracker) {
        discoveryTracker = safetyGateEvaluatorOrOptions.discoveryTracker;
      }
    }
  }
  const composedScopes = new Map<string, ComposedSessionScope>();
  const composedScopeFor = (sessionId: string): ComposedSessionScope => {
    let entry = composedScopes.get(sessionId);
    if (!entry) {
      if (composedScopes.size >= MAX_COMPOSED_SCOPES) {
        const oldest = composedScopes.keys().next().value;
        if (oldest !== undefined) composedScopes.delete(oldest);
      }
      entry = { scope: new WorkflowReferenceScope(sessionId), callCounter: 0 };
      composedScopes.set(sessionId, entry);
    }
    return entry;
  };

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
    const isRecordedDiscoveryTool =
      isDiscoveryTool(resolvedTool.toolId) || isDiscoveryTool(resolvedTool.name);

    const recordInvocation = (
      status: "success" | "error" | "timeout" | "rejected_capability",
      result?: CallToolResult,
      errorMessage?: string,
    ) => {
      const sessionId = context.sessionId ?? `ses_standalone_${context.workspaceId}`;
      if (isMetaTool) {
        if (isRecordedDiscoveryTool) {
          const inBytes = estimatePayloadBytes(params);
          const outBytes = result !== undefined ? estimatePayloadBytes(result) : undefined;
          if (inBytes !== undefined && outBytes !== undefined) {
            discoveryTracker.recordDiscoveryOverhead(
              sessionId,
              bytesToTokens(inBytes) + bytesToTokens(outBytes),
            );
          }
        }
        return;
      }
      if (!onInvocationRecorded) {
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
        const inputDigest = hashCanonicalContent(targetParams);
        const outputDigest = result ? hashCanonicalContent(result) : undefined;
        const invocationId = `inv_${randomUUID().replace(/-/g, "")}`;

        const inputBytes = estimatePayloadBytes(params);
        const outputBytes = result !== undefined ? estimatePayloadBytes(result) : undefined;
        let usageEstimate: InvocationUsageEstimate | undefined;
        if (inputBytes !== undefined && outputBytes !== undefined) {
          const inputTokens = bytesToTokens(inputBytes);
          const outputTokens = bytesToTokens(outputBytes);
          const discoveryTokens = discoveryTracker.consumeDiscoveryTokens(sessionId);
          usageEstimate = createUsageEstimate({
            inputTokens,
            outputTokens,
            discoveryTokens,
          });
        }

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
          ...(usageEstimate ? { usageEstimate } : {}),
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
    // Composed calls carry argument envelopes ({value}, {reference}, {literal}, nested
    // composites). They are analyzed once here: the transcript records the envelope form
    // the caller sent, while validation and dispatch see the resolved values. A
    // reference that names nothing in this session's scope fails the call explicitly.
    let composed: { entry: ComposedSessionScope; callId: string } | undefined;
    let dispatchParams = targetParams as Record<string, WorkflowJsonValue>;
    const preliminary = analyzeAgentArguments(dispatchParams);
    if (preliminary.composed) {
      if (!context.sessionId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Composed invocation arguments require a session scope; none is bound to this context.",
            },
          ],
        };
      }
      const entry = composedScopeFor(context.sessionId);
      const callId = `call_${++entry.callCounter}`;
      let resolvedArgs: Record<string, WorkflowJsonValue>;
      try {
        resolvedArgs =
          analyzeAgentArguments(dispatchParams, {
            nameInput: (argument, path) =>
              path.length === 0
                ? `${callId}_${argument}`
                : `${callId}_${argument}.${path.map(String).join(".")}`,
            resolveReference: (reference, path) => entry.scope.resolve(reference, path),
          }).resolved ?? {};
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const res: CallToolResult = {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to resolve composed arguments for '${displayIdentifier}': ${message}`,
            },
          ],
        };
        recordInvocation("error", res, message);
        return res;
      }
      composed = { entry, callId };
      dispatchParams = resolvedArgs;
    }

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
    const validation = validateParameters(paramSchema, dispatchParams as JsonRpcParams);
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
        parameters: dispatchParams as JsonRpcParams,
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
      if (composed && !result.isError) {
        // The caller composed this call, so it gets a handle to the result rather than
        // the bare payload: later calls in the same session can name the handle instead
        // of copying the value, and the record keeps the connection.
        const value = composedResultValue(result);
        const handle = composed.entry.scope.registerResult(composed.callId, value);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ result: value, handle }),
            },
          ],
        };
      }
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
