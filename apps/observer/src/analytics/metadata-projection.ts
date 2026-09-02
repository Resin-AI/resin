import {
  type DiscoveredToolEntry,
  type NormalizedBranchForkEvent,
  type NormalizedCommandExecEvent,
  type NormalizedCompactionEvent,
  type NormalizedErrorEvent,
  type NormalizedFileEditEvent,
  type NormalizedMessageEvent,
  type NormalizedModelReasoningEvent,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type NormalizedSessionLifecycleEvent,
  type NormalizedSubagentLifecycleEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolDiscoveryEvent,
  type NormalizedToolResultEvent,
  type NormalizedUnknownPassthroughEvent,
  type RedactionMeta,
  nowIso,
} from "@resin/contracts";

export type ParameterPrimitiveKind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "opaque";

export type ParameterShapeDescriptor =
  | ParameterPrimitiveKind
  | ParameterShapeDescriptor[]
  | { [key: string]: ParameterShapeDescriptor };

export interface ParameterShapeOptions {
  /** Maximum nesting depth for objects and arrays (default: 4, hard max: 8) */
  maxDepth?: number;
  /** Maximum number of keys extracted per object (default: 32, hard max: 64) */
  maxKeys?: number;
  /** Maximum character length for property names (default: 64, hard max: 128) */
  maxKeyLength?: number;
  /** Maximum total descriptor nodes across the entire tree (default: 256, hard max: 1024) */
  maxNodes?: number;
}

export const DEFAULT_MAX_DEPTH = 4;
export const HARD_MAX_DEPTH = 8;
export const DEFAULT_MAX_KEYS = 32;
export const HARD_MAX_KEYS = 64;
export const DEFAULT_MAX_KEY_LENGTH = 64;
export const HARD_MAX_KEY_LENGTH = 128;
export const DEFAULT_MAX_NODES = 256;
export const HARD_MAX_NODES = 1024;

export const RESIN_PARAMETER_SHAPE_KEY = "__resinParameterShapeV1";

export const ALLOWED_PRIMITIVE_KINDS: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "undefined",
  "opaque",
]);

const BLOCKED_PROPERTIES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  RESIN_PARAMETER_SHAPE_KEY,
]);

function normalizeBound(val: unknown, defaultVal: number, hardMax: number): number {
  if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val <= 0) {
    return defaultVal;
  }
  const intVal = Math.floor(val);
  if (intVal <= 0) {
    return defaultVal;
  }
  return Math.min(intVal, hardMax);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

interface BoundedKey {
  raw: string;
  projected: string;
}

function compareBoundedKeys(a: BoundedKey, b: BoundedKey): number {
  return a.projected < b.projected
    ? -1
    : a.projected > b.projected
      ? 1
      : a.raw < b.raw
        ? -1
        : a.raw > b.raw
          ? 1
          : 0;
}

function getBoundedSortedOwnKeys(
  obj: Record<string, unknown>,
  maxKeys: number,
  maxKeyLength: number,
): BoundedKey[] {
  const boundedKeys: BoundedKey[] = [];
  for (const raw in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, raw)) continue;
    if (BLOCKED_PROPERTIES.has(raw)) continue;
    const projected = raw.length > maxKeyLength ? raw.slice(0, maxKeyLength) : raw;
    if (BLOCKED_PROPERTIES.has(projected)) continue;

    const entry = { raw, projected };
    let low = 0;
    let high = boundedKeys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareBoundedKeys(boundedKeys[mid], entry) < 0) low = mid + 1;
      else high = mid;
    }
    if (boundedKeys.length < maxKeys) {
      boundedKeys.splice(low, 0, entry);
    } else if (compareBoundedKeys(entry, boundedKeys[boundedKeys.length - 1]) < 0) {
      boundedKeys.pop();
      boundedKeys.splice(low, 0, entry);
    }
  }
  return boundedKeys;
}
type OwnDataProperty = { ok: true; value: unknown } | { ok: false };

function readOwnDataProperty(value: object, key: string): OwnDataProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? { ok: true, value: descriptor.value }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function areShapesEquivalent(a: ParameterShapeDescriptor, b: ParameterShapeDescriptor): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    const aArr = a as ParameterShapeDescriptor[];
    const bArr = b as ParameterShapeDescriptor[];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (!areShapesEquivalent(aArr[i], bArr[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, ParameterShapeDescriptor>;
  const bObj = b as Record<string, ParameterShapeDescriptor>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!areShapesEquivalent(aObj[k], bObj[k])) return false;
  }
  return true;
}

interface TraversalBudget {
  nodesRemaining: number;
}

function countDescriptorNodes(shape: ParameterShapeDescriptor): number {
  if (typeof shape === "string") {
    return 1;
  }
  if (Array.isArray(shape)) {
    let count = 1;
    for (const elem of shape) {
      count += countDescriptorNodes(elem);
    }
    return count;
  }
  if (typeof shape === "object" && shape !== null) {
    let count = 1;
    for (const k of Object.keys(shape)) {
      count += countDescriptorNodes((shape as Record<string, ParameterShapeDescriptor>)[k]);
    }
    return count;
  }
  return 1;
}

function extractValueShape(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  options: Required<ParameterShapeOptions>,
  budget: TraversalBudget,
): ParameterShapeDescriptor {
  if (budget.nodesRemaining <= 0) {
    return "opaque";
  }

  if (value === null) {
    budget.nodesRemaining--;
    return "null";
  }
  if (value === undefined) {
    budget.nodesRemaining--;
    return "undefined";
  }

  const valType = typeof value;
  if (valType === "string") {
    budget.nodesRemaining--;
    return "string";
  }
  if (valType === "number") {
    budget.nodesRemaining--;
    return "number";
  }
  if (valType === "boolean") {
    budget.nodesRemaining--;
    return "boolean";
  }
  if (valType === "bigint" || valType === "symbol" || valType === "function") {
    budget.nodesRemaining--;
    return "opaque";
  }

  if (typeof value !== "object") {
    budget.nodesRemaining--;
    return "opaque";
  }

  if (depth >= options.maxDepth) {
    budget.nodesRemaining--;
    return "opaque";
  }

  if (ancestors.has(value)) {
    budget.nodesRemaining--;
    return "opaque";
  }

  if (Array.isArray(value)) {
    budget.nodesRemaining--;
    if (budget.nodesRemaining <= 0) {
      return "opaque";
    }
    if (value.length === 0) {
      budget.nodesRemaining--;
      return ["opaque"];
    }

    ancestors.add(value);
    const sampleLimit = Math.min(value.length, options.maxKeys);
    const elementShapes: ParameterShapeDescriptor[] = [];
    for (let i = 0; i < sampleLimit && budget.nodesRemaining > 0; i++) {
      const property = readOwnDataProperty(value, String(i));
      if (!property.ok) {
        budget.nodesRemaining--;
        elementShapes.push("opaque");
        continue;
      }
      elementShapes.push(extractValueShape(property.value, depth + 1, ancestors, options, budget));
    }
    ancestors.delete(value);

    const first = elementShapes[0] ?? "opaque";
    for (let i = 1; i < elementShapes.length; i++) {
      if (!areShapesEquivalent(first, elementShapes[i])) {
        return ["opaque"];
      }
    }
    return [first];
  }

  if (!isPlainObject(value)) {
    budget.nodesRemaining--;
    return "opaque";
  }

  budget.nodesRemaining--;
  ancestors.add(value);
  const boundedKeys = getBoundedSortedOwnKeys(
    value as Record<string, unknown>,
    options.maxKeys,
    options.maxKeyLength,
  );
  const result: Record<string, ParameterShapeDescriptor> = {};
  for (const { raw, projected } of boundedKeys) {
    if (budget.nodesRemaining <= 0) {
      break;
    }
    const property = readOwnDataProperty(value, raw);
    if (!property.ok) {
      budget.nodesRemaining--;
      result[projected] = "opaque";
      continue;
    }
    result[projected] = extractValueShape(property.value, depth + 1, ancestors, options, budget);
  }
  ancestors.delete(value);
  return result;
}

/**
 * Pure deterministic bounded extractor over raw parameter values.
 * Represents object property names plus primitive/container kind metadata only.
 * Never retains literal values, paths, prompts, or secrets.
 *
 * Arrays reveal element shape only, never length or values; empty or mixed arrays collapse safely to ['opaque'].
 * Object keys are deterministically sorted and bounded by depth, key count, key length, and total node budget.
 * Unhandled, circular, or budget-exhausted structures fail closed to 'opaque'.
 */
export function extractParameterShape(
  rawParams: unknown,
  options: ParameterShapeOptions = {},
): Record<string, unknown> {
  if (
    rawParams === null ||
    rawParams === undefined ||
    typeof rawParams !== "object" ||
    Array.isArray(rawParams) ||
    !isPlainObject(rawParams)
  ) {
    return {};
  }

  const fullOptions: Required<ParameterShapeOptions> = {
    maxDepth: normalizeBound(options.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
    maxKeys: normalizeBound(options.maxKeys, DEFAULT_MAX_KEYS, HARD_MAX_KEYS),
    maxKeyLength: normalizeBound(options.maxKeyLength, DEFAULT_MAX_KEY_LENGTH, HARD_MAX_KEY_LENGTH),
    maxNodes: normalizeBound(options.maxNodes, DEFAULT_MAX_NODES, HARD_MAX_NODES),
  };

  const budget: TraversalBudget = {
    nodesRemaining: fullOptions.maxNodes,
  };

  budget.nodesRemaining--;
  if (budget.nodesRemaining <= 0) {
    return {};
  }

  const ancestors = new Set<object>();
  ancestors.add(rawParams);

  const boundedKeys = getBoundedSortedOwnKeys(
    rawParams as Record<string, unknown>,
    fullOptions.maxKeys,
    fullOptions.maxKeyLength,
  );
  const result: Record<string, unknown> = {};

  for (const { raw, projected } of boundedKeys) {
    if (budget.nodesRemaining <= 0) {
      break;
    }
    const property = readOwnDataProperty(rawParams, raw);
    if (!property.ok) {
      budget.nodesRemaining--;
      result[projected] = "opaque";
      continue;
    }
    result[projected] = extractValueShape(property.value, 1, ancestors, fullOptions, budget);
  }
  ancestors.delete(rawParams);
  return result;
}

export { extractParameterShape as extractParameterTypeShape };

/**
 * Strict bounded recursive validator and canonicalizer for pre-projected safe shape descriptors.
 * Ensures the descriptor strictly contains only allowed primitive kind strings,
 * zero or one-element arrays, and bounded plain objects.
 * Rejects arbitrary literal strings, getters/accessors, prototype pollution keys,
 * circular references, multi-element arrays, and budget/depth/key/length violations.
 * Returns null if the descriptor fails any safety check.
 */
function validateAndCanonicalizeDescriptor(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  options: Required<ParameterShapeOptions>,
  budget: TraversalBudget,
): ParameterShapeDescriptor | null {
  if (budget.nodesRemaining <= 0) {
    return null;
  }

  if (typeof value === "string") {
    if (!ALLOWED_PRIMITIVE_KINDS.has(value)) {
      return null;
    }
    budget.nodesRemaining--;
    return value as ParameterPrimitiveKind;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (depth >= options.maxDepth) {
    return null;
  }

  if (ancestors.has(value)) {
    return null;
  }

  if (Array.isArray(value)) {
    budget.nodesRemaining--;
    if (value.length === 0) {
      return [];
    }
    if (budget.nodesRemaining <= 0) {
      return null;
    }
    if (value.length !== 1) {
      return null;
    }

    const elemProp = readOwnDataProperty(value, "0");
    if (!elemProp.ok) {
      return null;
    }

    ancestors.add(value);
    const elemDescriptor = validateAndCanonicalizeDescriptor(
      elemProp.value,
      depth + 1,
      ancestors,
      options,
      budget,
    );
    ancestors.delete(value);

    if (elemDescriptor === null) {
      return null;
    }
    return [elemDescriptor];
  }

  if (!isPlainObject(value)) {
    return null;
  }

  budget.nodesRemaining--;

  const ownSymbols = Object.getOwnPropertySymbols(value);
  if (ownSymbols.length > 0) {
    return null;
  }

  const ownNames = Object.getOwnPropertyNames(value);
  if (ownNames.length > options.maxKeys) {
    return null;
  }

  for (const name of ownNames) {
    if (BLOCKED_PROPERTIES.has(name)) {
      return null;
    }
    if (name.length > options.maxKeyLength) {
      return null;
    }
  }

  // Deterministic sorting
  const sortedNames = [...ownNames].sort();
  const result: Record<string, ParameterShapeDescriptor> = {};

  ancestors.add(value);
  for (const name of sortedNames) {
    if (budget.nodesRemaining <= 0) {
      ancestors.delete(value);
      return null;
    }
    const prop = readOwnDataProperty(value, name);
    if (!prop.ok) {
      ancestors.delete(value);
      return null;
    }
    const child = validateAndCanonicalizeDescriptor(
      prop.value,
      depth + 1,
      ancestors,
      options,
      budget,
    );
    if (child === null) {
      ancestors.delete(value);
      return null;
    }
    result[name] = child;
  }
  ancestors.delete(value);

  return result;
}

/**
 * Validates and canonicalizes an already-projected `__resinParameterShapeV1` envelope.
 * Returns `{ [RESIN_PARAMETER_SHAPE_KEY]: canonicalDescriptor }` if valid and safe, or `null` otherwise.
 */
export function tryPreserveSafeParameterShapeEnvelope(
  parameters: unknown,
  options: ParameterShapeOptions = {},
): Record<string, unknown> | null {
  if (
    parameters === null ||
    parameters === undefined ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    !isPlainObject(parameters)
  ) {
    return null;
  }

  const ownSymbols = Object.getOwnPropertySymbols(parameters);
  if (ownSymbols.length > 0) {
    return null;
  }

  const ownNames = Object.getOwnPropertyNames(parameters);
  if (ownNames.length !== 1 || ownNames[0] !== RESIN_PARAMETER_SHAPE_KEY) {
    return null;
  }

  const shapeProp = readOwnDataProperty(parameters, RESIN_PARAMETER_SHAPE_KEY);
  if (!shapeProp.ok) {
    return null;
  }

  const rawDescriptor = shapeProp.value;
  if (
    rawDescriptor === null ||
    rawDescriptor === undefined ||
    typeof rawDescriptor !== "object" ||
    Array.isArray(rawDescriptor) ||
    !isPlainObject(rawDescriptor)
  ) {
    return null;
  }

  const fullOptions: Required<ParameterShapeOptions> = {
    maxDepth: normalizeBound(options.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
    maxKeys: normalizeBound(options.maxKeys, DEFAULT_MAX_KEYS, HARD_MAX_KEYS),
    maxKeyLength: normalizeBound(options.maxKeyLength, DEFAULT_MAX_KEY_LENGTH, HARD_MAX_KEY_LENGTH),
    maxNodes: normalizeBound(options.maxNodes, DEFAULT_MAX_NODES, HARD_MAX_NODES),
  };

  const budget: TraversalBudget = {
    nodesRemaining: fullOptions.maxNodes,
  };

  const ancestors = new Set<object>();
  ancestors.add(parameters);

  const canonicalDescriptor = validateAndCanonicalizeDescriptor(
    rawDescriptor,
    0,
    ancestors,
    fullOptions,
    budget,
  );

  if (
    canonicalDescriptor === null ||
    typeof canonicalDescriptor !== "object" ||
    Array.isArray(canonicalDescriptor)
  ) {
    return null;
  }

  return {
    [RESIN_PARAMETER_SHAPE_KEY]: canonicalDescriptor,
  };
}

/**
 * Projects tool parameters with idempotent safe-descriptor envelope preservation.
 * If the parameters already form a valid bounded __resinParameterShapeV1 envelope,
 * preserves its canonical form; otherwise, extracts parameter shapes deterministically.
 */
export function projectToolParameters(
  rawParams: unknown,
  options: ParameterShapeOptions = {},
): Record<string, unknown> {
  const preserved = tryPreserveSafeParameterShapeEnvelope(rawParams, options);
  if (preserved !== null) {
    return preserved;
  }
  return {
    [RESIN_PARAMETER_SHAPE_KEY]: extractParameterShape(rawParams, options),
  };
}

/**
 * Exhaustive metadata-only projection for normalized session events.
 *
 * Strips all prompt/response text, reasoning tokens, tool parameters/results,
 * command strings/arguments/output, diff patches, error messages/stacks/details,
 * and unknown payload contents while remaining 100% schema-valid.
 *
 * Operational fields (event identity, lifecycle transitions, tool/model names,
 * token/usage metrics, exit codes, durations) are strictly preserved.
 *
 * Redaction metadata is enriched to reflect synthetic redaction across all stripped fields.
 */
export function projectEventToMetadataOnly(
  event: NormalizedSessionEvent,
  options: { validate?: boolean; parameterShapeOptions?: ParameterShapeOptions } = {},
): NormalizedSessionEvent {
  const { validate = false, parameterShapeOptions } = options;

  const buildRedaction = (fieldsToRedact: readonly string[]): RedactionMeta => {
    const existingFields = event.redaction?.redactedFields ?? [];
    const fieldsSet = new Set<string>(existingFields);
    for (const field of fieldsToRedact) {
      fieldsSet.add(field);
    }
    return {
      isRedacted: true,
      redactedFields: Array.from(fieldsSet).sort(),
      redactionStrategy: "drop",
      scrubbedPatterns: event.redaction?.scrubbedPatterns ?? [],
      redactedAt: event.redaction?.redactedAt || nowIso(),
    };
  };

  const rawScenarioId = event.metadata?.scenarioId;
  const scenarioId =
    typeof rawScenarioId === "string" && rawScenarioId.length > 0 ? rawScenarioId : event.sessionId;

  const baseHeaders = {
    eventId: event.eventId,
    schemaVersion: event.schemaVersion,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    causalRef: event.causalRef,
    metadata: { scenarioId },
    providerUsage: event.providerUsage,
  };

  let projected: NormalizedSessionEvent;

  switch (event.type) {
    case "message": {
      const msgEvent: NormalizedMessageEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["content", "contentParts"]),
        type: "message",
        role: event.role,
        content: "",
      };
      if (event.model !== undefined) {
        msgEvent.model = event.model;
      }
      projected = msgEvent;
      break;
    }

    case "model_reasoning": {
      const reasonEvent: NormalizedModelReasoningEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["reasoningContent", "signature"]),
        type: "model_reasoning",
        reasoningContent: "",
      };
      if (event.tokenCount !== undefined) reasonEvent.tokenCount = event.tokenCount;
      if (event.model !== undefined) reasonEvent.model = event.model;
      if (event.durationMs !== undefined) reasonEvent.durationMs = event.durationMs;
      projected = reasonEvent;
      break;
    }

    case "tool_discovery": {
      const tools: DiscoveredToolEntry[] = event.tools.map((t) => {
        const item: DiscoveredToolEntry = {
          name: t.name,
        };
        if (t.provider !== undefined) item.provider = t.provider;
        return item;
      });
      const discEvent: NormalizedToolDiscoveryEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["tools[].description", "tools[].inputSchema"]),
        type: "tool_discovery",
        tools,
        source: event.source,
      };
      if (event.provider !== undefined) discEvent.provider = event.provider;
      projected = discEvent;
      break;
    }

    case "tool_call": {
      const callEvent: NormalizedToolCallEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["parameters"]),
        type: "tool_call",
        callId: event.callId,
        toolName: event.toolName,
        parameters: projectToolParameters(event.parameters, parameterShapeOptions),
        isShadow: event.isShadow,
      };
      if (event.candidateRef !== undefined) callEvent.candidateRef = event.candidateRef;
      projected = callEvent;
      break;
    }

    case "tool_result": {
      const resEvent: NormalizedToolResultEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["result"]),
        type: "tool_result",
        callId: event.callId,
        toolName: event.toolName,
        result: undefined,
        isError: event.isError,
        executionDurationMs: event.executionDurationMs,
        isShadow: event.isShadow,
      };
      if (event.outputSizeBytes !== undefined) resEvent.outputSizeBytes = event.outputSizeBytes;
      projected = resEvent;
      break;
    }

    case "command_exec": {
      const cmdEvent: NormalizedCommandExecEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["command", "args", "cwd", "stdout", "stderr"]),
        type: "command_exec",
        command: "",
        args: [],
        exitCode: event.exitCode,
        durationMs: event.durationMs,
      };
      projected = cmdEvent;
      break;
    }

    case "file_edit": {
      const editEvent: NormalizedFileEditEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["patch"]),
        type: "file_edit",
        filePath: event.filePath,
        operation: event.operation,
      };
      if (event.beforeHash !== undefined) editEvent.beforeHash = event.beforeHash;
      if (event.afterHash !== undefined) editEvent.afterHash = event.afterHash;
      if (event.diffStats !== undefined) editEvent.diffStats = event.diffStats;
      projected = editEvent;
      break;
    }

    case "error": {
      const errEvent: NormalizedErrorEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["message", "stack", "details"]),
        type: "error",
        errorType: event.errorType,
        message: "",
        recoverable: event.recoverable,
      };
      projected = errEvent;
      break;
    }

    case "compaction": {
      const compEvent: NormalizedCompactionEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["preservedContextSummary"]),
        type: "compaction",
        triggerReason: event.triggerReason,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      };
      projected = compEvent;
      break;
    }

    case "branch_fork": {
      const forkEvent: NormalizedBranchForkEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["forkReason"]),
        type: "branch_fork",
        sourceSessionId: event.sourceSessionId,
        branchPointEventId: event.branchPointEventId,
      };
      if (event.branchName !== undefined) forkEvent.branchName = event.branchName;
      projected = forkEvent;
      break;
    }

    case "subagent_lifecycle": {
      const subagentEvent: NormalizedSubagentLifecycleEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["reason"]),
        type: "subagent_lifecycle",
        subagentId: event.subagentId,
        lifecycleType: event.lifecycleType,
      };
      if (event.parentId !== undefined) subagentEvent.parentId = event.parentId;
      if (event.role !== undefined) subagentEvent.role = event.role;
      projected = subagentEvent;
      break;
    }

    case "session_lifecycle": {
      const lifeEvent: NormalizedSessionLifecycleEvent = {
        ...baseHeaders,
        redaction: buildRedaction([]),
        type: "session_lifecycle",
        lifecycleType: event.lifecycleType,
      };
      if (event.exitReason !== undefined) lifeEvent.exitReason = event.exitReason;
      if (event.harnessName !== undefined) lifeEvent.harnessName = event.harnessName;
      if (event.workspaceId !== undefined) lifeEvent.workspaceId = event.workspaceId;
      projected = lifeEvent;
      break;
    }

    case "unknown_passthrough": {
      const passEvent: NormalizedUnknownPassthroughEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["rawPayload"]),
        type: "unknown_passthrough",
        rawEventType: event.rawEventType,
        rawPayload: {},
      };
      projected = passEvent;
      break;
    }

    default: {
      const exhaustiveCheck: never = event;
      throw new Error(`Unhandled event type: ${String(exhaustiveCheck)}`);
    }
  }

  if (validate) {
    return NormalizedSessionEventSchema.parse(projected);
  }
  return projected;
}

export { projectEventToMetadataOnly as projectEventMetadataOnly };
