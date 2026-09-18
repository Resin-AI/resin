/**
 * Workflow call recorder: attaches the per-call carrier the general compiler consumes.
 *
 * A call routed through the reference-aware invocation surface (`invoke_tool`) arrives
 * in the transcript with its argument envelopes verbatim. This recorder reads those
 * envelopes with the same shared analyzer the dispatcher used, so the recorded origin
 * of every argument is exactly what the caller stated — a literal, a declared input,
 * or a reference to an earlier result — never a guess from a matching value.
 *
 * The carrier is attached to the normalized event BEFORE privacy projection, as
 * `metadata.workflowCall`, so the live path and the import path produce identical
 * records. Projection re-reads it through `readWorkflowCallCarrier` and copies it
 * through by value; literal values ride along (they are what the workflow is made of)
 * while private leaves were already replaced by `private:` references whose originals
 * stay in the local value store.
 */

import {
  analyzeAgentArguments,
  type AgentArgumentOrigin,
  type NormalizedSessionEvent,
  type WorkflowJsonValue,
} from "@resin/contracts";
import {
  type PrivateValueStore,
  FilePrivateValueStore,
  containsRedactionPlaceholder,
} from "./private-value-store.js";

export const RESIN_WORKFLOW_CALL_METADATA_KEY = "workflowCall";
export const RESIN_WORKFLOW_RESULT_METADATA_KEY = "workflowResult";

/** The runtime family every invoke_tool-routed callable belongs to. */
export const RESIN_INVOKE_TOOL_RUNTIME = "resin-invoke-tool";

/** The carrier attached to a tool_call event: how to call the callable again. */
export interface WorkflowCallCarrier {
  runtime: string;
  /** The effective callable: the tool the call was routed to, not the router. */
  name: string;
  /** The provider or connection the call was reached through, when discovery recorded one. */
  connection?: string;
  /** Per top-level argument, the origin the caller stated, swept for private values. */
  origins: Record<string, AgentArgumentOrigin>;
  /** Declared caller inputs, with the types the caller used. */
  inputs: Array<{
    name: string;
    argument: string;
    path: ReadonlyArray<string | number>;
    type: string;
  }>;
}

function isPlainObject(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * The reference-aware invocation surface, however the harness spelled it: bare
 * `invoke_tool`/`sys_invoke_tool`, or an MCP-prefixed `mcp__<server>__invoke_tool`.
 */
function isInvokeToolCallName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "invoke_tool" || value === "sys_invoke_tool") return true;
  return value.endsWith("__invoke_tool") && value.startsWith("mcp__");
}

function isWorkflowCallCarrier(value: unknown): value is WorkflowCallCarrier {
  if (!isPlainObject(value)) return false;
  if (typeof value.runtime !== "string" || typeof value.name !== "string") return false;
  if (!isPlainObject(value.origins)) return false;
  if (value.connection !== undefined && typeof value.connection !== "string") return false;
  if (!Array.isArray(value.inputs)) return false;
  return true;
}

/**
 * Re-reads a carrier for projection: only the frozen carrier vocabulary survives, so a
 * malformed or smuggled field is dropped rather than carried upstream.
 */
export function readWorkflowCallCarrier(value: unknown): WorkflowCallCarrier | undefined {
  if (!isWorkflowCallCarrier(value)) return undefined;
  const carrier: WorkflowCallCarrier = {
    runtime: value.runtime,
    name: value.name,
    origins: JSON.parse(JSON.stringify(value.origins)) as Record<string, AgentArgumentOrigin>,
    inputs: JSON.parse(JSON.stringify(value.inputs)) as WorkflowCallCarrier["inputs"],
  };
  if (value.connection !== undefined) carrier.connection = value.connection;
  return carrier;
}

/** Re-reads a result carrier for projection: the handle token only. */
export function readWorkflowResultCarrier(value: unknown): { handle: string } | undefined {
  if (!isPlainObject(value) || typeof value.handle !== "string" || value.handle.length === 0) {
    return undefined;
  }
  return { handle: value.handle };
}

export interface WorkflowCallRecorderOptions {
  /** The local store private leaves are written to; defaults to the daemon's store. */
  privateValues?: PrivateValueStore;
}

export class WorkflowCallRecorder {
  private readonly privateValues: PrivateValueStore;
  /** Tool name → provider, as the session's discovery events reported it. */
  private readonly providers = new Map<string, string>();
  private privateCounter = 0;

  constructor(options: WorkflowCallRecorderOptions = {}) {
    this.privateValues = options.privateValues ?? FilePrivateValueStore.default();
  }

  /** Drops per-session state; the coordinator calls this between sessions. */
  clear(): void {
    this.providers.clear();
    this.privateCounter = 0;
  }

  observe(event: NormalizedSessionEvent): NormalizedSessionEvent {
    if (event.type === "tool_discovery") {
      const tools = (event as { tools?: Array<{ name?: unknown; provider?: unknown }> }).tools;
      if (Array.isArray(tools)) {
        for (const tool of tools) {
          if (typeof tool?.name === "string" && typeof tool.provider === "string") {
            this.providers.set(tool.name, tool.provider);
          }
        }
      }
      return event;
    }
    if (event.type === "tool_call") return this.observeCall(event);
    if (event.type === "tool_result") return this.observeResult(event);
    return event;
  }

  /**
   * Replaces literal leaves that still carry a redaction placeholder with `private:`
   * references, writing the redacted leaf to the local store so the executor can
   * reconstruct the original at invocation time.
   */
  private sweepOrigin(
    origin: AgentArgumentOrigin,
    sessionId: string,
  ): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (value: WorkflowJsonValue): AgentArgumentOrigin => {
          if (typeof value === "string" && containsRedactionPlaceholder(value)) {
            const reference = `private:${sessionId}:${this.privateCounter++}`;
            this.privateValues.set(reference, value);
            return { type: "private", reference };
          }
          if (Array.isArray(value)) {
            return { type: "array", items: value.map(expand) };
          }
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) entries[key] = expand(entry);
            return { type: "object", entries };
          }
          return { type: "literal", value };
        };
        return expand(origin.value);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.sweepOrigin(entry, sessionId);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item) => this.sweepOrigin(item, sessionId)),
        };
      default:
        return origin;
    }
  }

  private observeCall(event: NormalizedSessionEvent): NormalizedSessionEvent {
    const parameters = (event as { parameters?: unknown }).parameters;
    // Only a call routed through the reference-aware surface gets a carrier: the outer
    // tool must be invoke_tool itself, and the routed callable is named by its params.
    if (!isInvokeToolCallName((event as { toolName?: unknown }).toolName)) return event;
    if (!isPlainObject(parameters)) return event;
    const routedName =
      typeof parameters.toolName === "string"
        ? parameters.toolName
        : typeof parameters.name === "string"
          ? parameters.name
          : typeof parameters.toolId === "string"
            ? parameters.toolId
            : undefined;
    if (routedName === undefined) return event;
    const inner = parameters.parameters ?? parameters.arguments;
    const analysis = analyzeAgentArguments(isPlainObject(inner) ? inner : {});
    const origins: Record<string, AgentArgumentOrigin> = {};
    for (const [argument, origin] of Object.entries(analysis.origins)) {
      origins[argument] = this.sweepOrigin(origin, event.sessionId);
    }
    const carrier: WorkflowCallCarrier = {
      runtime: RESIN_INVOKE_TOOL_RUNTIME,
      name: routedName,
      origins,
      inputs: analysis.inputs.map((input) => ({
        name: input.name,
        argument: input.argument,
        path: input.path,
        type: input.type,
      })),
    };
    const provider = this.providers.get(routedName);
    if (provider !== undefined) carrier.connection = provider;
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_CALL_METADATA_KEY] = carrier;
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  private observeResult(event: NormalizedSessionEvent): NormalizedSessionEvent {
    const handle = this.resultHandle(event);
    if (handle === undefined) return event;
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_RESULT_METADATA_KEY] = { handle };
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  /**
   * The handle a composed call returned for its result, when the record carries one.
   * A tool that happens to return a `ref:`-shaped handle field is indistinguishable
   * from a real one — and harmless, since the value genuinely came from that call.
   */
  private resultHandle(event: NormalizedSessionEvent): string | undefined {
    const fromValue = (value: unknown): string | undefined => {
      if (!isPlainObject(value)) return undefined;
      const handle = value.handle;
      return typeof handle === "string" && handle.startsWith("ref:") ? handle : undefined;
    };
    const direct = fromValue((event as { result?: unknown }).result);
    if (direct !== undefined) return direct;
    const content = (event as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!isPlainObject(item) || typeof item.text !== "string") continue;
        try {
          const parsed = fromValue(JSON.parse(item.text));
          if (parsed !== undefined) return parsed;
        } catch {
          // Not a JSON payload; keep looking.
        }
      }
    }
    return undefined;
  }
}
