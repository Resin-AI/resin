import {
  type InvocationFailureReason,
  type InvocationRecord,
  type InvocationUsageEstimate,
  type ResinInvocationReceipt,
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
import { reportHandledError } from "@resin/observer/error-reporting/core";
import { RecordedExecutionClock, type SafetyGateEvaluator } from "@resin/runtime";
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
import {
  invocationReceipt,
  newInvocationId,
  withErrorInvocationReceipt,
  withInvocationReceipt,
} from "./meta/invocation-receipt.js";
import { isToolOfferedHere, unavailableHereMessage } from "./meta/repository-scope.js";
import type { ToolInvocationRouter } from "./meta/router-contract.js";
import {
  GET_TOOL_SCHEMA_MANIFEST,
  SEARCH_TOOLS_MANIFEST,
  SYSTEM_META_TOOL_IDS,
} from "./meta/system-tools.js";
import { replacesStepsHint } from "./meta/tool-profile.js";
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
import { isAutomaticallyRecommended } from "./registry/recommendation.js";
import type { CatalogEntry, RegistryTool } from "./registry/types.js";
import type { WorkspaceContext } from "./workspace-resolver.js";

export interface ToolCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
  timeoutMs?: number;
  /** The benchmark run the calling connection belongs to; marks each invocation recorded for it. */
  benchmarkId?: string;
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
  /**
   * False for a learned tool whose measured invocations cost more than doing the job directly:
   * no automatic surface (instructions, command suggestions, direct listing) names it.
   */
  recommended?: false;
  /** A learned tool's purpose and call signature, for a direct listing's instructions. */
  listing?: ListedCall;
}

/** Internal metadata must never reach a harness: no unsupported output contract, no local detail. */
export function toNativeToolCatalog(tools: CatalogNoticeTool[]): McpTool[] {
  return tools.map((tool) => {
    if (
      !("catalogOutputSchema" in tool) &&
      !("localCommands" in tool) &&
      !("recommended" in tool) &&
      !("listing" in tool)
    )
      return tool;
    const {
      catalogOutputSchema: _catalogOutputSchema,
      localCommands: _localCommands,
      recommended: _recommended,
      listing: _listing,
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
 * Longest run of inputs a listed tool's signature names. Harnesses show only the start of a tool's
 * description (OMP about 200 characters), so the signature leads it and stays within that; inputs
 * past this are counted, never cut mid-name.
 */
const LISTED_SIGNATURE_CHARS = 120;

/** One input as a listed tool's signature names it: its name, JSON type and whether it is optional. */
interface SignatureInput {
  name: string;
  type: string;
  optional: boolean;
}

/** A listed learned tool's purpose and its call signature (`{}` with no inputs). */
export interface ListedCall {
  purpose: string;
  signature: string;
}

function schemaType(property: unknown): string {
  if (!isParamsObject(property)) return "any";
  const { type } = property;
  if (type === "array") {
    const items = isParamsObject(property.items) ? property.items.type : undefined;
    return typeof items === "string" ? `${items}[]` : "array";
  }
  if (typeof type === "string") return type;
  if (Array.isArray(type) && type.every((entry) => typeof entry === "string"))
    return type.join("|");
  return "any";
}

/**
 * The inputs an agent passes a listed tool, from its served schema, required ones first; `for_each`
 * is left to its docs.
 */
function signatureInputs(schema: McpToolInput): SignatureInput[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .filter(([name]) => name !== FOR_EACH_ARGUMENT)
    .map(([name, property]) => ({
      name,
      type: schemaType(property),
      optional: !required.has(name),
    }))
    .sort((a, b) => Number(a.optional) - Number(b.optional));
}

/**
 * How many of `inputs`, rendered by `render` and joined by ", ", fit {@link LISTED_SIGNATURE_CHARS}:
 * always at least one, so a signature never cuts a name.
 */
function shownInputCount(
  inputs: readonly SignatureInput[],
  render: (input: SignatureInput) => string,
): number {
  let length = 0;
  let count = 0;
  for (const input of inputs) {
    length += (count === 0 ? 0 : 2) + render(input).length;
    if (count > 0 && length > LISTED_SIGNATURE_CHARS) break;
    count += 1;
  }
  return count;
}

/** A listed tool's call signature as a direct listing names it: `{}` or `{mode: string, paths?: string[]}`. */
export function listedSignature(schema: McpToolInput): string {
  const inputs = signatureInputs(schema);
  const render = (input: SignatureInput) =>
    `${input.name}${input.optional ? "?" : ""}: ${input.type}`;
  const count = shownInputCount(inputs, render);
  const more = inputs.length - count;
  return `{${inputs.slice(0, count).map(render).join(", ")}${more === 0 ? "" : `, +${more} more`}}`;
}

/**
 * How a listed tool is called, leading its description so a harness that shows only the start of
 * it still shows what to pass: `{}` for a tool without inputs, else each input's name and type,
 * required ones first.
 */
function listedCallSentence(schema: McpToolInput): string {
  const inputs = signatureInputs(schema);
  if (inputs.length === 0) return "Call with {} (no inputs).";
  const render = (input: SignatureInput) => `${input.name} (${input.type})`;
  const shown = inputs.slice(0, shownInputCount(inputs, render));
  const required = shown.filter((input) => !input.optional).map(render);
  const optional = shown.filter((input) => input.optional).map(render);
  const groups = [
    ...(required.length === 0 ? [] : [`Inputs: ${required.join(", ")}`]),
    ...(optional.length === 0
      ? []
      : [`${required.length === 0 ? "Optional inputs" : "optional"}: ${optional.join(", ")}`]),
  ];
  const more = inputs.length - shown.length;
  const list = `${groups.join("; ")}${more === 0 ? "" : `, +${more} more`}`;
  return inputs.some((input) => input.optional)
    ? `${list}; omitted ones reuse recorded values.`
    : `${list}.`;
}

/**
 * A listed learned tool's purpose: the first sentence of its catalog description and a hint of how
 * much recorded work it replaces when that is more than one step. The full description, recorded
 * steps and input docs come from get_tool_schema.
 */
export function listedPurpose(description: string, hint?: string): string {
  const line = description.trim().split("\n")[0]!.trim();
  const sentence = /^.*?[.!?](?=\s+[A-Z`]|$)/.exec(line)?.[0] ?? line;
  const cut =
    sentence.length > LISTED_PURPOSE_CHARS
      ? `${sentence.slice(0, LISTED_PURPOSE_CHARS - 1).trimEnd()}…`
      : sentence;
  const ended = (text: string) => `${text}${/[.!?…]$/.test(text) ? "" : "."}`;
  return hint === undefined ? cut : `${ended(cut)} ${hint}`;
}

/** A listed learned tool's description: how to call it (see {@link listedCallSentence}), then its purpose. */
export function listedDescription(schema: McpToolInput, purpose: string): string {
  const call = listedCallSentence(schema);
  return purpose === "" ? call : `${call} ${purpose}`;
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
    // A tool learned for this workspace is listed by how to call it and its one-line purpose, and
    // marked so a facade that hides the rest of the catalog still offers it by name. Every listed
    // tool is re-sent with each request, so its recorded steps, input docs and `for_each` usage are
    // left to get_tool_schema.
    const listed = (tool: CatalogEntry | RegistryTool, catalog: string) => {
      const schema = toMcpInputSchema(tool.parameters ?? tool.manifest?.parameters);
      if (tool.isSystem || (tool.scope !== "workspace" && tool.scope !== "session")) {
        return {
          description: catalog,
          inputSchema: schema,
          _meta: undefined,
          localCommands: [],
          recommended: true,
          listing: undefined,
        };
      }
      const hint = replacesStepsHint(this.registry.learnedToolProfile(tool, context)?.steps);
      const served = this.registry.learnedToolInputSchema(tool, context, schema);
      const scrub = (text: string) => this.registry.scrubLearnedToolText(tool, context, text);
      const purpose = scrub(listedPurpose(catalog, hint));
      return {
        description: scrub(listedDescription(served, purpose)),
        inputSchema: listedInputSchema(served),
        _meta: { [RESIN_LEARNED_TOOL_META]: true },
        localCommands: this.registry.learnedToolCommands(tool, context),
        recommended: isAutomaticallyRecommended(tool),
        listing: { purpose, signature: scrub(listedSignature(served)) },
      };
    };
    const record = "entries" in snapshot ? snapshot : undefined;
    if (record && record.entries && Object.keys(record.entries).length > 0) {
      for (const entry of Object.values(record.entries)) {
        // A learned tool is listed only where it was learned and can run (see repository-scope).
        if (!isToolOfferedHere(this.registry, entry, context)) continue;
        const { description, inputSchema, _meta, localCommands, recommended, listing } = listed(
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
          ...(recommended ? {} : { recommended: false as const }),
          ...(listing === undefined ? {} : { listing }),
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
          if (!isToolOfferedHere(this.registry, tool, context)) continue;
          const { description, inputSchema, _meta, localCommands, recommended, listing } = listed(
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
            ...(recommended ? {} : { recommended: false as const }),
            ...(listing === undefined ? {} : { listing }),
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
    // A learned tool scoped to another repository (or unable to run from here) is not offered
    // here, so a call by name is refused rather than run against the wrong checkout.
    if (!isToolOfferedHere(this.registry, tool, context)) {
      recordDiscoveryFunnelEvent("unavailable_here");
      return { content: [{ type: "text", text: unavailableHereMessage(name) }], isError: true };
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
    // The id is fixed before the call runs: the record and the caller's receipt carry the same one.
    const recording = recorder && {
      recorder,
      receipt: invocationReceipt(newInvocationId(), options?.benchmarkId),
    };
    const startedAtMs = Date.now();
    // Times the tool's recorded calls apart from Resin's own work around them. A system tool is
    // not recorded here (invoke_tool measures the call it makes itself), so it gets no clock.
    const executionClock = recorder ? new RecordedExecutionClock() : undefined;
    let executed: CallToolResult;
    try {
      const execute = () => this.executeTool(context, tool, name, params, options);
      executed = await (executionClock ? executionClock.run(execute) : execute());
    } catch (error) {
      if (!tool.isSystem) recordDiscoveryFunnelEvent("invocation_failed");
      if (!recording) throw error;
      // A call the routing layer refused or lost is still a failed invocation of this tool,
      // and the error the caller receives is its output: estimate usage from it like a result.
      const thrown = withErrorInvocationReceipt(error, recording.receipt);
      this.recordNativeInvocation(recording, context, tool, params, startedAtMs, {
        output: jsonRpcErrorOf(error instanceof Error ? error : String(error)),
        shown: jsonRpcErrorOf(thrown instanceof Error ? thrown : String(thrown)),
        reason: failureReasonOfError(error),
        executionDurationMs: executionClock?.durationMs(),
      });
      throw thrown;
    }
    const sessionId = context.sessionId ?? `ses_standalone_${context.workspaceId}`;
    if (!tool.isSystem) {
      // A learned tool the harness called by name: the end of the discovery funnel.
      recordDiscoveryFunnelEvent(executed.isError ? "invocation_failed" : "invocation_succeeded");
    }

    if (tool.isSystem) {
      if (isDiscoveryTool(name) || isDiscoveryTool(tool.toolId)) {
        const inBytes = estimatePayloadBytes(params);
        const outBytes = estimatePayloadBytes(executed.content);
        if (inBytes !== undefined && outBytes !== undefined) {
          this.discoveryTracker.recordDiscoveryOverhead(
            sessionId,
            bytesToTokens(inBytes) + bytesToTokens(outBytes),
          );
        }
      }
    } else if (recording) {
      const shown = withInvocationReceipt(executed, recording.receipt);
      this.recordNativeInvocation(recording, context, tool, params, startedAtMs, {
        output: executed,
        shown,
        ...(executed.isError ? { reason: failureReasonOfResult(executed) } : {}),
        executionDurationMs: executionClock?.durationMs(),
      });
      return shown;
    }
    return executed;
  }

  private recordNativeInvocation(
    recording: {
      recorder: (record: InvocationRecord) => Promise<void>;
      receipt: ResinInvocationReceipt;
    },
    context: WorkspaceContext,
    tool: RegistryTool,
    params: JsonRpcParams,
    startedAtMs: number,
    outcome: {
      /** The tool's own result or error, before Resin's receipt: what the output digest covers. */
      output: CallToolResult | JsonRpcErrorObject;
      /** What the caller receives, receipt included: what output usage is estimated from. */
      shown: CallToolResult | JsonRpcErrorObject;
      reason?: InvocationFailureReason;
      /** Time the tool's recorded calls ran; undefined when none ran. */
      executionDurationMs: number | undefined;
    },
  ): void {
    const { output, shown, reason, executionDurationMs } = outcome;
    const { recorder, receipt } = recording;
    const sessionId = context.sessionId ?? `ses_standalone_${context.workspaceId}`;
    const inBytes = estimatePayloadBytes(params);
    // The caller reads a result's content, not Resin's `_meta`; an error object is read whole.
    const outBytes = estimatePayloadBytes("content" in shown ? shown.content : shown);
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
    const completedAtMs = Date.now();
    const durationMs = Math.max(0, completedAtMs - startedAtMs);
    const record: InvocationRecord = {
      invocationId: receipt.invocationId,
      sessionId,
      workspaceId: context.workspaceId,
      toolId: tool.toolId,
      toolVersion: /^\d+\.\d+\.\d+/.test(tool.version) ? tool.version : "1.0.0",
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs,
      ...(executionDurationMs === undefined
        ? {}
        : { executionDurationMs: Math.min(executionDurationMs, durationMs) }),
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
      ...(receipt.benchmarkId === undefined ? {} : { benchmarkId: receipt.benchmarkId }),
    };
    // Recording never fails the call; a failed write is reported, never dropped quietly.
    recorder(record).catch((error: unknown) => {
      reportHandledError(error, { failureClass: "tool_invocation_record" });
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
