/**
 * Agent argument envelopes: the shared contract between the calling program, the
 * reference-aware invocation surface, and the recorder.
 *
 * A tool call's arguments may carry small envelopes that say where a value came from:
 *
 * - `{ "value": X }` — the caller supplied X for this call; the recording keeps it as a
 *   declared input so the compiled tool can accept a new value.
 * - `{ "reference": "ref:<scope>:<callId>", "path": [...] }` — the value comes from an
 *   earlier result in the same scope, optionally addressed by a nested path. The
 *   reference may also be `{ "handle": "ref:..." }`.
 * - `{ "literal": X }` — X is a fixed value even though it looks like an envelope;
 *   this is the escape hatch for arguments that are themselves `{ "value": ... }` or
 *   `{ "reference": ... }` shaped.
 * - any other object or array — a composite whose leaves are analyzed recursively, so a
 *   single argument can mix literals, inputs, and references.
 * - a bare scalar — a fixed literal.
 *
 * Analysis is pure: it never invents an origin, and it resolves references only through
 * the caller-supplied resolver. The same analyzer feeds the dispatcher (which
 * materializes values) and the recorder (which keeps origins), so the two can never
 * disagree about what an argument meant.
 */

import type { WorkflowJsonValue, WorkflowValuePath } from "./recorded-workflow.js";

/**
 * One leaf or subtree of a recorded argument's origin, as the calling program stated it.
 * `reference` keeps the reference token rather than a step id: the recorder binds it to
 * the producing call later, and a reference that names nothing stays unbound rather than
 * being guessed. `input` deliberately carries no value: an origin record must never
 * capture what the caller supplied.
 */
export type AgentArgumentOrigin =
  | { type: "literal"; value: WorkflowJsonValue }
  | { type: "input"; name: string }
  | { type: "reference"; reference: string; path: WorkflowValuePath }
  | { type: "private"; reference: string }
  | { type: "object"; entries: Record<string, AgentArgumentOrigin> }
  | { type: "array"; items: AgentArgumentOrigin[] };

/** A caller-supplied input discovered inside the arguments, with the type it used. */
export interface AgentArgumentInput {
  name: string;
  /** The top-level argument the input was found in. */
  argument: string;
  /** Path inside the argument; empty for a top-level input. */
  path: WorkflowValuePath;
  type: "string" | "number" | "boolean" | "object" | "array";
}

/** A reference discovered inside the arguments, with the field it addressed. */
export interface AgentArgumentReference {
  /** The top-level argument the reference was found in. */
  argument: string;
  /** Path inside the argument; empty for a top-level reference. */
  path: WorkflowValuePath;
  reference: string;
  /** Path inside the referenced result. */
  referencePath: WorkflowValuePath;
}

export interface AgentArgumentAnalysis {
  /** True when at least one envelope was present; false means plain JSON arguments. */
  composed: boolean;
  /** Per top-level argument, the origin the caller stated. Input leaves carry no value. */
  origins: Record<string, AgentArgumentOrigin>;
  /** Declared inputs in first-seen order. */
  inputs: AgentArgumentInput[];
  /** References in first-seen order. */
  references: AgentArgumentReference[];
  /**
   * The concrete argument values to dispatch, present only when `resolveReference` was
   * supplied. Input leaves hold the caller-supplied value; reference leaves hold the
   * resolved value. Absent for a record-only analysis.
   */
  resolved?: Record<string, WorkflowJsonValue>;
}

export type AgentInputNamer = (argument: string, path: WorkflowValuePath) => string;

export function agentValueTypeOf(value: WorkflowJsonValue): AgentArgumentInput["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "object";
  return "string";
}

function isPlainObject(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reference token an envelope names, whether it is a string or a `{handle}` object. */
function referenceTokenOf(value: WorkflowJsonValue): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (isPlainObject(value) && typeof value.handle === "string" && value.handle.length > 0) {
    return value.handle;
  }
  return undefined;
}

function referencePathOf(value: Record<string, WorkflowJsonValue>): WorkflowValuePath {
  const raw = value.path;
  if (!Array.isArray(raw)) return [];
  const path: Array<string | number> = [];
  for (const part of raw) {
    if (typeof part !== "string" && typeof part !== "number") return [];
    path.push(part);
  }
  return path;
}

/**
 * Analyzes one argument position recursively. `path` is the position inside the
 * top-level argument, used for naming and reporting only.
 */
function analyzeValue(
  argument: string,
  path: WorkflowValuePath,
  value: WorkflowJsonValue,
  nameInput: AgentInputNamer,
  resolveReference: ((reference: string, path: WorkflowValuePath) => WorkflowJsonValue) | undefined,
  inputs: AgentArgumentInput[],
  references: AgentArgumentReference[],
  state: { composed: boolean },
): { origin: AgentArgumentOrigin; resolved: WorkflowJsonValue } {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "value") {
      state.composed = true;
      const inner = value.value as WorkflowJsonValue;
      const name = nameInput(argument, path);
      inputs.push({ name, argument, path, type: agentValueTypeOf(inner) });
      return { origin: { type: "input", name }, resolved: inner };
    }
    if (keys.length === 1 && keys[0] === "literal") {
      state.composed = true;
      const inner = value.literal as WorkflowJsonValue;
      return { origin: { type: "literal", value: inner }, resolved: inner };
    }
    if (keys.includes("reference") && keys.every((key) => key === "reference" || key === "path")) {
      const token = referenceTokenOf(value.reference as WorkflowJsonValue);
      if (token !== undefined) {
        state.composed = true;
        const referencePath = referencePathOf(value);
        references.push({ argument, path, reference: token, referencePath });
        return {
          origin: { type: "reference", reference: token, path: referencePath },
          resolved: resolveReference ? resolveReference(token, referencePath) : null,
        };
      }
      // A `reference` key that names no token is an ordinary object field, not an envelope.
    }
    const entries: Record<string, AgentArgumentOrigin> = {};
    const resolvedEntries: Record<string, WorkflowJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const child = analyzeValue(
        argument,
        [...path, key],
        entry,
        nameInput,
        resolveReference,
        inputs,
        references,
        state,
      );
      entries[key] = child.origin;
      resolvedEntries[key] = child.resolved;
    }
    return { origin: { type: "object", entries }, resolved: resolvedEntries };
  }
  if (Array.isArray(value)) {
    const items: AgentArgumentOrigin[] = [];
    const resolvedItems: WorkflowJsonValue[] = [];
    for (const [index, entry] of value.entries()) {
      const child = analyzeValue(
        argument,
        [...path, index],
        entry,
        nameInput,
        resolveReference,
        inputs,
        references,
        state,
      );
      items.push(child.origin);
      resolvedItems.push(child.resolved);
    }
    return { origin: { type: "array", items }, resolved: resolvedItems };
  }
  return { origin: { type: "literal", value }, resolved: value };
}

/**
 * Analyzes the arguments of one call. Bare values become literal origins; envelopes
 * become input/reference origins; composites recurse. When `resolveReference` is given,
 * the returned `resolved` tree is the concrete argument object to dispatch and a
 * reference that names nothing propagates the resolver's error, so the call fails rather
 * than dispatching an invented value.
 */
export function analyzeAgentArguments(
  args: Record<string, WorkflowJsonValue>,
  options: {
    nameInput?: AgentInputNamer;
    resolveReference?: (reference: string, path: WorkflowValuePath) => WorkflowJsonValue;
  } = {},
): AgentArgumentAnalysis {
  const nameInput =
    options.nameInput ??
    ((argument, path) =>
      path.length === 0 ? argument : `${argument}.${path.map(String).join(".")}`);
  const inputs: AgentArgumentInput[] = [];
  const references: AgentArgumentReference[] = [];
  const state = { composed: false };
  const origins: Record<string, AgentArgumentOrigin> = {};
  const resolved: Record<string, WorkflowJsonValue> = {};
  for (const [argument, value] of Object.entries(args)) {
    const child = analyzeValue(
      argument,
      [],
      value,
      nameInput,
      options.resolveReference,
      inputs,
      references,
      state,
    );
    origins[argument] = child.origin;
    resolved[argument] = child.resolved;
  }
  return {
    composed: state.composed,
    origins,
    inputs,
    references,
    ...(options.resolveReference ? { resolved } : {}),
  };
}
