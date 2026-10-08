import { randomUUID } from "node:crypto";
import {
  type InvocationFailureReason,
  type InvocationRecord,
  type InvocationUsageEstimate,
  type SafetyGateRefusal,
  TOOL_IO_UTF8_METHOD,
  type ToolParameterSchema,
  bytesToTokens,
  createUsageEstimate,
  estimatePayloadBytes,
  hashCanonicalContent,
  isSafetyGateBypassTool,
} from "@resin/contracts";
import { recordDiscoveryFunnelEvent } from "@resin/observer/discovery-funnel";
import type { SafetyGateEvaluator } from "@resin/runtime";
import {
  FOR_EACH_ARGUMENT,
  invalidForEachResult,
  offersForEach,
  planForEach,
  runForEach,
} from "./for-each.js";
import {
  SessionDiscoveryTracker as DefaultSessionDiscoveryTracker,
  type SessionDiscoveryTracker,
  isDiscoveryTool,
} from "./meta/discovery-tracker.js";
import {
  failureReasonOfError,
  failureReasonOfResult,
  invocationStatusFor,
} from "./meta/invocation-failure.js";
import type { ToolInvocationRouter } from "./meta/router-contract.js";
import {
  GET_TOOL_SCHEMA_MANIFEST,
  SEARCH_TOOLS_MANIFEST,
  SYSTEM_META_TOOL_IDS,
} from "./meta/system-tools.js";
import {
  type JsonRpcErrorObject,
  MCP_ERROR_CODES,
  McpProtocolError,
  jsonRpcErrorOf,
} from "./protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcParamValue,
  JsonRpcParams,
  McpTool,
  McpToolAnnotations,
  McpToolInput,
} from "./protocol/types.js";
import { RESIN_LEARNED_TOOL_META, withDisplayText } from "./protocol/types.js";
import { CanaryRouter } from "./registry/canary-router.js";
import {
  type CatalogSnapshotRecord,
  type ToolRegistry,
  type ToolRepoLike,
  createEvolvedToolHandler,
  extractToolRepo,
} from "./registry/index.js";
import type { CatalogEntry, RegistryTool } from "./registry/types.js";
import type { WorkspaceContext } from "./workspace-resolver.js";

export interface ToolCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
  timeoutMs?: number;
}

export type ToolHandler = (
  context: WorkspaceContext,
  params: JsonRpcParams,
  options?: ToolCallOptions,
) => Promise<CallToolResult>;

/** Same active native catalog, with internal-only metadata for notice comparison. */
export interface CatalogNoticeTool extends McpTool {
  catalogOutputSchema?: McpTool["outputSchema"];
  /** The commands a learned tool's recorded programs run, resolved on this machine. */
  localCommands?: string[];
}

/** Internal metadata must never reach a harness: no unsupported output contract, no local detail. */
export function toNativeToolCatalog(tools: CatalogNoticeTool[]): McpTool[] {
  return tools.map((tool) => {
    if (!("catalogOutputSchema" in tool) && !("localCommands" in tool)) return tool;
    const {
      catalogOutputSchema: _catalogOutputSchema,
      localCommands: _localCommands,
      ...nativeTool
    } = tool;
    return nativeTool;
  });
}

export interface GatewayRouter {
  listTools(context: WorkspaceContext): Promise<McpTool[]>;
  listCatalogNoticeTools?(context: WorkspaceContext): Promise<CatalogNoticeTool[]>;
  getCatalogGeneration?(): number;
  callTool(
    context: WorkspaceContext,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult>;
  onToolListChanged?(listener: () => void): () => void;
}
function isParamsObject<TInput>(value: TInput): value is TInput & JsonRpcParams {
  return Boolean(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function formatRefusalMeta(refusal: SafetyGateRefusal): JsonRpcParams {
  const contentList: readonly JsonRpcParamValue[] = refusal.content.map((c) => ({
    type: c.type,
    text: c.text,
  }));
  const unmetList: readonly JsonRpcParamValue[] = refusal.unmetGates;
  const result: JsonRpcParams = {
    isError: refusal.isError,
    refusalCode: refusal.refusalCode,
    refusalReason: refusal.refusalReason,
    remediation: refusal.remediation,
    unmetGates: unmetList,
    evaluatedAt: refusal.evaluatedAt,
    content: contentList,
  };
  if (refusal.details) {
    const detailsRecord: Record<string, JsonRpcParamValue> = {};
    for (const [key, value] of Object.entries(refusal.details)) {
      if (
        Object.prototype.toString.call(value) === "[object String]" ||
        Object.prototype.toString.call(value) === "[object Number]" ||
        Object.prototype.toString.call(value) === "[object Boolean]" ||
        value === null ||
        value === undefined
      ) {
        detailsRecord[key] = String(value);
      }
    }
    result.details = detailsRecord;
  }
  return result;
}

function toMcpInputSchema(rawSchema?: JsonRpcParams | ToolParameterSchema): McpToolInput {
  if (!rawSchema || Object.prototype.toString.call(rawSchema) !== "[object Object]") {
    return { type: "object", properties: {} };
  }
  const properties = isParamsObject(rawSchema.properties) ? rawSchema.properties : undefined;
  const required = Array.isArray(rawSchema.required)
    ? rawSchema.required.filter(
        (item): item is string => Object.prototype.toString.call(item) === "[object String]",
      )
    : undefined;
  const additionalProperties =
    rawSchema.additionalProperties === true || rawSchema.additionalProperties === false
      ? rawSchema.additionalProperties
      : isParamsObject(rawSchema.additionalProperties)
        ? rawSchema.additionalProperties
        : undefined;
  const result: McpToolInput = {
    type: "object",
    properties: properties ?? {},
  };
  if (required !== undefined) {
    result.required = required;
  }
  if (additionalProperties !== undefined) {
    result.additionalProperties = additionalProperties;
  }
  return result;
}

/** Longest purpose a listed learned tool carries. */
const LISTED_PURPOSE_CHARS = 160;

/**
 * A listed learned tool's description: the first sentence of its catalog description and the names
 * of its inputs. The full description, recorded steps and input docs come from get_tool_schema.
 */
export function listedPurpose(description: string, inputs: readonly string[]): string {
  const line = description.trim().split("\n")[0]!.trim();
  const sentence = /^.*?[.!?](?=\s+[A-Z`]|$)/.exec(line)?.[0] ?? line;
  const purpose =
    sentence.length > LISTED_PURPOSE_CHARS
      ? `${sentence.slice(0, LISTED_PURPOSE_CHARS - 1).trimEnd()}…`
      : sentence;
  if (inputs.length === 0) return purpose;
  return `${purpose}${/[.!?…]$/.test(purpose) ? "" : "."} Inputs: ${inputs.join(", ")}.`;
}

/**
 * A listed learned tool's input schema: each input's name, type and constraints, not its docs, and
 * a bare `for_each` object when the tool takes one. A `for_each` call is validated where it runs,
 * and get_tool_schema documents its shape.
 */
export function listedInputSchema(schema: McpToolInput): McpToolInput {
  const properties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!isParamsObject(property)) {
      properties[name] = property;
      continue;
    }
    const { description: _description, title: _title, examples: _examples, ...kept } = property;
    properties[name] = kept;
  }
  if (offersForEach(schema)) properties[FOR_EACH_ARGUMENT] = { type: "object" };
  return { ...schema, properties };
}

const READ_ONLY_DISCOVERY_ANNOTATIONS: Readonly<McpToolAnnotations> = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

function discoveryAnnotations(tool: CatalogEntry | RegistryTool): McpToolAnnotations | undefined {
  // Require the reserved ID and canonical built-in manifest digest, never a
  // generated name or self-declared metadata. Digests survive snapshot decoding.
  // Hosts interpret these advisory hints; authorization and runtime gates do not.
  if (
    (tool.toolId === SYSTEM_META_TOOL_IDS.SEARCH_TOOLS &&
      tool.manifest.id === SYSTEM_META_TOOL_IDS.SEARCH_TOOLS &&
      tool.manifest.digest === SEARCH_TOOLS_MANIFEST.digest) ||
    (tool.toolId === SYSTEM_META_TOOL_IDS.GET_TOOL_SCHEMA &&
      tool.manifest.id === SYSTEM_META_TOOL_IDS.GET_TOOL_SCHEMA &&
      tool.manifest.digest === GET_TOOL_SCHEMA_MANIFEST.digest)
  ) {
    return READ_ONLY_DISCOVERY_ANNOTATIONS;
  }
  return undefined;
}

/**
 * Dynamic GatewayRouter implementation backed by a ToolRegistry.
 */
export class RegistryGatewayRouter implements GatewayRouter {
  private readonly registry: ToolRegistry;
  private readonly canaryRouter: CanaryRouter;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeEvents?: () => void;
  private safetyGateEvaluator?: SafetyGateEvaluator;
  private readonly invocationRouter?: ToolInvocationRouter;
  private readonly discoveryTracker: SessionDiscoveryTracker;

  constructor(
    registry: ToolRegistry,
    invocationRouter?: ToolInvocationRouter,
    safetyGateEvaluator?: SafetyGateEvaluator,
    canaryRouter?: CanaryRouter,
    discoveryTracker?: SessionDiscoveryTracker,
  ) {
    this.registry = registry;
    this.invocationRouter = invocationRouter;
    this.discoveryTracker = discoveryTracker ?? DefaultSessionDiscoveryTracker.getInstance();
    this.canaryRouter =
      canaryRouter ??
      new CanaryRouter({
        registry: this.registry,
        userControls: this.registry.controls,
      });
    this.safetyGateEvaluator = safetyGateEvaluator ?? registry.getSafetyGateEvaluator();
    if (safetyGateEvaluator) {
      this.registry.setSafetyGateEvaluator(safetyGateEvaluator);
    }

    if (invocationRouter) {
      this.registry.setInvocationRouter(invocationRouter);
    }
    this.unsubscribeEvents = this.registry.events.onCatalogChanged(() => {
      this.triggerToolListChanged();
    });
  }

  setSafetyGateEvaluator(evaluator: SafetyGateEvaluator): void {
    this.safetyGateEvaluator = evaluator;
    this.registry.setSafetyGateEvaluator(evaluator);
  }
  getSafetyGateEvaluator(): SafetyGateEvaluator | undefined {
    return this.safetyGateEvaluator;
  }
  async listTools(context: WorkspaceContext): Promise<McpTool[]> {
    return toNativeToolCatalog(await this.listCatalogNoticeTools(context));
  }

  getCatalogGeneration(): number {
    return this.registry.getCatalogGeneration();
  }

  async listCatalogNoticeTools(context: WorkspaceContext): Promise<CatalogNoticeTool[]> {
    const snapshot = await this.registry.resolveCatalog(context.workspaceId, context.sessionId);
    const mcpTools: CatalogNoticeTool[] = [];
    // A tool learned for this workspace is listed by its one-line purpose and input names, and
    // marked so a facade that hides the rest of the catalog still offers it by name. Every listed
    // tool is re-sent with each request, so its recorded steps, input docs and `for_each` usage are
    // left to get_tool_schema.
    const listed = (tool: CatalogEntry | RegistryTool, catalog: string) => {
      const schema = toMcpInputSchema(tool.parameters ?? tool.manifest?.parameters);
      if (tool.isSystem || (tool.scope !== "workspace" && tool.scope !== "session")) {
        return { description: catalog, inputSchema: schema, _meta: undefined, localCommands: [] };
      }
      return {
        description: this.registry.scrubLearnedToolText(
          tool,
          context,
          listedPurpose(catalog, Object.keys(schema.properties ?? {})),
        ),
        inputSchema: listedInputSchema(this.registry.learnedToolInputSchema(tool, context, schema)),
        _meta: { [RESIN_LEARNED_TOOL_META]: true },
        localCommands: this.registry.learnedToolCommands(tool, context),
      };
    };
    const record = "entries" in snapshot ? snapshot : undefined;
    if (record && record.entries && Object.keys(record.entries).length > 0) {
      for (const entry of Object.values(record.entries)) {
        const { description, inputSchema, _meta, localCommands } = listed(
          entry,
          entry.description || entry.manifest?.description || `Tool ${entry.name}`,
        );
        mcpTools.push({
          name: entry.exposedName,
          description,
          inputSchema,
          catalogOutputSchema: entry.outputSchema ?? entry.manifest?.outputSchema,
          annotations: discoveryAnnotations(entry),
          ...(_meta === undefined ? {} : { _meta }),
          ...(localCommands.length === 0 ? {} : { localCommands }),
        });
      }
    } else {
      for (const summary of Object.values(snapshot.tools)) {
        const tool = await this.registry.getTool(
          summary.toolId,
          context.workspaceId,
          context.sessionId,
        );
        if (tool) {
          const { description, inputSchema, _meta, localCommands } = listed(
            tool,
            tool.description || tool.manifest?.description || `Tool ${tool.name}`,
          );
          mcpTools.push({
            name: tool.exposedName || tool.name,
            description,
            inputSchema,
            catalogOutputSchema: tool.outputSchema ?? tool.manifest?.outputSchema,
            annotations: discoveryAnnotations(tool),
            ...(_meta === undefined ? {} : { _meta }),
            ...(localCommands.length === 0 ? {} : { localCommands }),
          });
        }
      }
    }
    return mcpTools;
  }
  async callTool(
    context: WorkspaceContext,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    const tool = await this.registry.getTool(name, context.workspaceId, context.sessionId);

    if (!tool) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        this.registry.retiredToolMessage(name, context.workspaceId) ?? `Tool '${name}' not found`,
      );
    }
    // `for_each` on a learned tool is one ordinary call per value: each run is gated,
    // executed, and recorded exactly as if the caller had made it alone.
    if (!tool.isSystem && (tool.scope === "workspace" || tool.scope === "session")) {
      const plan = planForEach(tool.parameters ?? tool.manifest?.parameters, params);
      if (plan.kind === "invalid") return invalidForEachResult(plan.message);
      if (plan.kind === "runs") {
        return await runForEach(plan, (args) =>
          this.callResolvedTool(context, tool, name, args, options),
        );
      }
    }
    return await this.callResolvedTool(context, tool, name, params, options);
  }

  private async callResolvedTool(
    context: WorkspaceContext,
    tool: RegistryTool,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    // Harnesses call evolved tools by name, not through invoke_tool. Record those
    // calls the same way, or the invocation ledger (and every saving computed
    // from it) only ever sees the meta-tool path.
    const recorder = tool.isSystem ? undefined : this.registry.getInvocationRecorder();
    const startedAtMs = Date.now();
    let executed: CallToolResult;
    try {
      executed = await this.executeTool(context, tool, name, params, options);
    } catch (error) {
      if (!tool.isSystem) recordDiscoveryFunnelEvent("invocation_failed");
      // A call the routing layer refused or lost is still a failed invocation of this tool,
      // and the error the caller receives is its output: estimate usage from it like a result.
      if (recorder) {
        this.recordNativeInvocation(recorder, context, tool, params, startedAtMs, {
          output: jsonRpcErrorOf(error instanceof Error ? error : String(error)),
          reason: failureReasonOfError(error),
        });
      }
      throw error;
    }
    const sessionId = context.sessionId ?? `ses_standalone_${context.workspaceId}`;
    if (!tool.isSystem) {
      // A learned tool the harness called by name: the end of the discovery funnel.
      recordDiscoveryFunnelEvent(executed.isError ? "invocation_failed" : "invocation_succeeded");
    }

    if (tool.isSystem) {
      if (isDiscoveryTool(name) || isDiscoveryTool(tool.toolId)) {
        const inBytes = estimatePayloadBytes(params);
        const outBytes = estimatePayloadBytes(executed);
        if (inBytes !== undefined && outBytes !== undefined) {
          this.discoveryTracker.recordDiscoveryOverhead(
            sessionId,
            bytesToTokens(inBytes) + bytesToTokens(outBytes),
          );
        }
      }
    } else if (recorder) {
      this.recordNativeInvocation(recorder, context, tool, params, startedAtMs, {
        output: executed,
        ...(executed.isError ? { reason: failureReasonOfResult(executed) } : {}),
      });
    }
    return executed;
  }

  private recordNativeInvocation(
    recorder: (record: InvocationRecord) => Promise<void>,
    context: WorkspaceContext,
    tool: RegistryTool,
    params: JsonRpcParams,
    startedAtMs: number,
    outcome: { output: CallToolResult | JsonRpcErrorObject; reason?: InvocationFailureReason },
  ): void {
    const { output, reason } = outcome;
    const sessionId = context.sessionId ?? `ses_standalone_${context.workspaceId}`;
    const inBytes = estimatePayloadBytes(params);
    const outBytes = estimatePayloadBytes(output);
    let usageEstimate: InvocationUsageEstimate | undefined;
    if (inBytes !== undefined && outBytes !== undefined) {
      const inputTokens = bytesToTokens(inBytes);
      const outputTokens = bytesToTokens(outBytes);
      const discoveryTokens = this.discoveryTracker.consumeDiscoveryTokens(sessionId);
      usageEstimate = createUsageEstimate({
        inputTokens,
        outputTokens,
        discoveryTokens,
      });
    }
    const status = reason === undefined ? "success" : invocationStatusFor(reason);
    const record: InvocationRecord = {
      invocationId: `inv_${randomUUID().replace(/-/g, "")}`,
      sessionId,
      workspaceId: context.workspaceId,
      toolId: tool.toolId,
      toolVersion: /^\d+\.\d+\.\d+/.test(tool.version) ? tool.version : "1.0.0",
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      status,
      inputDigest: hashCanonicalContent(params),
      outputDigest: hashCanonicalContent(output),
      // The reason, never the error text: native calls record no message.
      ...(reason === undefined
        ? {}
        : {
            errorDetails: {
              errorType:
                status === "timeout"
                  ? "TimeoutError"
                  : status === "rejected_capability"
                    ? "SafetyGateRefusal"
                    : "ToolExecutionError",
              message: "",
              reason,
            },
          }),
      ...(usageEstimate ? { usageEstimate } : {}),
    };
    void recorder(record).catch(() => {
      // Recording never fails the call; the uploader reconciles from what was written.
    });
  }

  private async executeTool(
    context: WorkspaceContext,
    tool: NonNullable<Awaited<ReturnType<ToolRegistry["getTool"]>>>,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    const isToolDisabled = await this.registry.controls.isToolDisabled(
      context.workspaceId,
      tool.toolId,
    );
    if (tool.isDisabled || isToolDisabled) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `Tool '${name}' is disabled in this workspace`,
      );
    }
    // Enforce production safety gate on non-system tools
    if (
      this.safetyGateEvaluator &&
      !tool.isSystem &&
      !isSafetyGateBypassTool(name) &&
      !isSafetyGateBypassTool(tool.toolId)
    ) {
      const gateCheck = this.safetyGateEvaluator.canExecuteTool(
        tool.toolId,
        tool.name,
        Boolean(tool.isSystem),
      );
      if (!gateCheck.allowed && gateCheck.refusal) {
        return {
          isError: true,
          content: gateCheck.refusal.content,
          _meta: { refusal: formatRefusalMeta(gateCheck.refusal) },
        };
      }
    }

    // Enforce canary execution if candidate active on non-system tools
    const canary = this.canaryRouter.getCanary(tool.toolId, context.workspaceId);
    if (canary && !tool.isSystem) {
      const invocationRequest = {
        toolId: tool.toolId,
        name: tool.name,
        version: tool.version,
        parameters: params,
        context,
        manifest: tool.manifest,
        signal: options?.signal,
        onProgress: options?.onProgress,
        timeoutMs: options?.timeoutMs,
      };

      return await this.canaryRouter.executeWithCanary(
        invocationRequest,
        async (targetVersion: string) => {
          const targetTool =
            this.registry.getToolVersion(tool.toolId, targetVersion) ??
            this.registry.getToolVersion(name, targetVersion) ??
            (targetVersion === tool.version ? tool : undefined);

          if (targetTool?.handler) {
            return await targetTool.handler(context, params, options);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "executed",
                  tool: targetTool?.name ?? tool.name,
                  version: targetVersion,
                  params,
                }),
              },
            ],
          };
        },
      );
    }

    // Published tools must use the verified local artifact executor, which
    // supplies capability grants and brokers. The raw-source compatibility
    // handler has no authority to perform filesystem/command/network effects.
    // The caller sees a result's display text when it carries one.
    if (!tool.isSystem && this.invocationRouter) {
      return withDisplayText(
        await this.invocationRouter.invoke({
          toolId: tool.toolId,
          name: tool.name,
          version: tool.version,
          manifest: tool.manifest,
          parameters: params,
          context,
          signal: options?.signal,
          onProgress: options?.onProgress,
          timeoutMs: options?.timeoutMs,
        }),
      );
    }

    if (tool.handler) {
      return tool.handler(context, params, options);
    }

    // Default fallback output
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "executed",
            tool: tool.name,
            version: tool.version,
            params,
          }),
        },
      ],
    };
  }

  onToolListChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  triggerToolListChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  getCanaryRouter(): CanaryRouter {
    return this.canaryRouter;
  }

  destroy(): void {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
    }
    this.listeners.clear();
  }
  async refresh(workspaceId?: string): Promise<number> {
    const count = await this.registry.refresh(workspaceId);
    this.triggerToolListChanged();
    return count;
  }
}

/**
 * Creates a GatewayRouter backed by a ToolRegistry.
 */
export function createRegistryGatewayRouter(
  registry: ToolRegistry,
  invocationRouter?: ToolInvocationRouter,
  safetyGateEvaluator?: SafetyGateEvaluator,
  canaryRouter?: CanaryRouter,
): RegistryGatewayRouter {
  return new RegistryGatewayRouter(registry, invocationRouter, safetyGateEvaluator, canaryRouter);
}
