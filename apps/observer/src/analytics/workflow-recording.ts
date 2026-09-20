import { compareRecordedEvents } from "./recorded-event-order.js";
/**
 * Recording the recipe of a session's executable work.
 *
 * This runs on the pre-privacy record, locally. Where the record establishes where an argument came
 * from, that origin is kept; where it does not, the argument is preserved as unresolved — the
 * recorder never infers a dependency from a matching value and never freezes a value it cannot
 * explain.
 *
 * Private values are decided per leaf, recursively: a secret inside a larger string or inside a
 * nested object becomes a private reference for that leaf, so a call that carries one remains
 * executable instead of being discarded.
 */

import type {
  AgentArgumentOrigin,
  RecordedWorkflow,
  WorkflowArgumentProvenance,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
  WorkflowRecordedProgram,
  WorkflowStep,
  WorkflowValuePath,
  WorkflowValueSource,
  WorkflowValueTemplate,
} from "@resin/contracts";
import { RESIN_TOOL_LINK_EVIDENCE_KEY, readToolLinkEvidence } from "@resin/contracts";
import {
  type DerivationCall,
  type ObservedResourceFlow,
  deriveNativeCalls,
} from "./native-argument-derivation.js";
import { containsRedactionPlaceholder } from "./private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  type WorkflowCallCandidate,
  type WorkflowCallCarrier,
  type WorkflowCallHeldOut,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-call-recorder.js";

/** Where a recorded argument's value came from, as the record establishes it. */
export type RecordedArgumentOrigin = WorkflowValueTemplate;

export interface RecordedCallObservation {
  callId: string;
  /** Position in the session, for ordering the calls. */
  causalSequence?: number;
  callable: {
    runtime: string;
    name: string;
    connection?: string;
    /** The schema discovery recorded for this callable, when the record carries one. */
    inputSchema?: WorkflowJsonValue;
    /** The recorded program this callable runs, when the call was a program execution. */
    program?: WorkflowRecordedProgram;
  };
  /** Values the call was made with, exactly as recorded. */
  arguments: Record<string, WorkflowJsonValue>;
  /**
   * Origins the record establishes, per argument name. An argument without one is recorded as
   * unresolved.
   */
  argumentOrigins?: Record<string, RecordedArgumentOrigin>;
  /** What the record says about each argument's origin, where it says anything. */
  argumentProvenance?: Record<string, WorkflowArgumentProvenance>;
  /** Recorded types of the arguments, used for the workflow's input schema. */
  argumentTypes?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
  /** The declared data flow the capture recorded for this call, when it recorded one. */
  flow?: ObservedResourceFlow;
  /** Steps the record established this call must follow, from the calls' own declared resource use. */
  establishedDependsOn?: readonly string[];
  result?: WorkflowJsonValue;
  /**
   * Whether this value is private, decided by the privacy layer. It may match a whole value or a
   * substring of one, which is how a secret inside a larger string is caught.
   */
  isPrivateValue?: (value: string) => boolean;
  /** The recorded control flow when this call failed. Absent when the record does not say. */
  recordedFailureControl?: "abort" | "continue";
  /** What the recording observed; never treated as the workflow's behavior. */
  observed?: "succeeded" | "failed" | "unknown";
  permissions?: WorkflowJsonValue;
}

export interface RecordedRecipe {
  workflow: RecordedWorkflow;
  /**
   * Inputs proposed by comparing demonstrations, with the argument each came from. They are a
   * proposal: an established binding is never replaced by a caller input, and an input that a caller
   * declines to supply leaves the workflow refusing rather than inventing a value.
   */
  proposedInputs?: Array<{ name: string; from: string }>;
  /** Values the workflow needs locally at execution time, addressed by reference only. */
  privateValues: Map<string, WorkflowJsonValue>;
  /** Calls the recorder could not represent, with the reason. Never silently dropped. */
  skipped: Array<{ callId: string; reason: string }>;
}

function isPlainObjectValue(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(
  value: WorkflowJsonValue,
): "string" | "number" | "boolean" | "object" | "array" {
  if (Array.isArray(value)) return "array";
  if (value === null) return "object";
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function recordWorkflowRecipeInternal(
  workflowId: string,
  observations: readonly RecordedCallObservation[],
  candidates?: readonly WorkflowBindingCandidate[],
): RecordedRecipe | undefined {
  const ordered = [...observations].sort(
    (left, right) =>
      (left.causalSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.causalSequence ?? Number.MAX_SAFE_INTEGER),
  );
  const privateValues = new Map<string, WorkflowJsonValue>();
  const skipped: Array<{ callId: string; reason: string }> = [];
  const steps: WorkflowStep[] = [];
  const inputTypes = new Map<string, "string" | "number" | "boolean" | "object" | "array">();
  // A value may be classified private only after a later call is processed, so the union of every
  // predicate seen is applied to the finished workflow as well.
  const privatePredicates: Array<(value: string) => boolean> = [];
  let privateCounter = 0;

  const makePrivate = (value: WorkflowJsonValue): WorkflowValueTemplate => {
    const reference = `private:${workflowId}:${privateCounter++}`;
    privateValues.set(reference, value);
    return { type: "private", reference };
  };

  /** Builds a template for one value, deciding privacy per leaf and keeping recorded origins. */
  const templateFor = (
    value: WorkflowJsonValue,
    origin: RecordedArgumentOrigin | undefined,
    isPrivate: ((value: string) => boolean) | undefined,
  ): WorkflowValueTemplate => {
    const privateHere = (leaf: WorkflowJsonValue): WorkflowValueTemplate | undefined => {
      if (typeof leaf === "string" && isPrivate?.(leaf) === true) return makePrivate(leaf);
      return undefined;
    };
    /**
     * A recorded literal is rebuilt so privacy applies inside it too: a composite literal becomes an
     * object/array template whose leaves are literals, except the private ones.
     */
    const literalTemplate = (value: WorkflowJsonValue): WorkflowValueTemplate => {
      const privateLeaf = privateHere(value);
      if (privateLeaf) return privateLeaf;
      if (Array.isArray(value)) return { type: "array", items: value.map(literalTemplate) };
      if (isPlainObjectValue(value)) {
        const entries: Record<string, WorkflowValueTemplate> = {};
        for (const [key, entry] of Object.entries(value)) entries[key] = literalTemplate(entry);
        return { type: "object", entries };
      }
      return { type: "literal", value };
    };
    switch (origin?.type) {
      case "literal":
        // The recorded literal is rebuilt from the origin's own value so privacy applies
        // inside it too: a composite literal becomes an object/array template whose
        // leaves are literals, except the private ones. The origin's value is the record;
        // the observed argument may be a projected shape that no longer carries it.
        return literalTemplate(origin.value);
      case "input":
      case "result":
      case "private":
      case "unresolved":
      // A program origin already says everything the plan needs — the language, the text it
      // resolves, and the tokens a bound value is rendered into — so it is kept as it is rather
      // than re-read from the argument's value.
      case "program":
        return origin;
      case "object":
        // A recorded origin may describe only part of the value; keep its leaves, and decide the rest
        // from the record.
        if (isPlainObjectValue(value)) {
          const entries: Record<string, WorkflowValueTemplate> = {};
          for (const [key, entry] of Object.entries(value)) {
            entries[key] = templateFor(entry, origin.entries[key], isPrivate);
          }
          return { type: "object", entries };
        }
        return privateHere(value) ?? origin;
      case "array":
        if (Array.isArray(value)) {
          return {
            type: "array",
            items: value.map((entry, index) => templateFor(entry, origin.items[index], isPrivate)),
          };
        }
        return privateHere(value) ?? origin;
      default: {
        const privateLeaf = privateHere(value);
        if (privateLeaf) return privateLeaf;
        if (Array.isArray(value)) {
          return {
            type: "array",
            items: value.map((entry) => templateFor(entry, undefined, isPrivate)),
          };
        }
        if (isPlainObjectValue(value)) {
          const entries: Record<string, WorkflowValueTemplate> = {};
          for (const [key, entry] of Object.entries(value)) {
            entries[key] = templateFor(entry, undefined, isPrivate);
          }
          return { type: "object", entries };
        }
        // The origin is not established by the record: it is preserved as unknown, never guessed
        // from a matching value and never frozen as a constant.
        return {
          type: "unresolved",
          reason: "the record does not establish this argument's origin",
        };
      }
    }
  };

  for (const observation of ordered) {
    if (steps.some((step) => step.callId === observation.callId)) {
      // Repeated delivery of one execution is not a second step.
      continue;
    }
    const stepId = `step${steps.length}`;
    if (observation.isPrivateValue) privatePredicates.push(observation.isPrivateValue);
    const sources: Record<string, WorkflowValueTemplate> = {};
    for (const [name, value] of Object.entries(observation.arguments)) {
      const origin = observation.argumentOrigins?.[name];
      if (origin?.type === "input") {
        const recorded = observation.argumentTypes?.[name] ?? jsonTypeOf(value);
        const existing = inputTypes.get(origin.name);
        inputTypes.set(origin.name, existing ?? recorded);
      }
      sources[name] = templateFor(value, origin, observation.isPrivateValue);
    }

    const bound = Object.values(sources)
      .flatMap(function collect(template: WorkflowValueTemplate): string[] {
        switch (template.type) {
          case "result":
            return [template.stepId];
          case "object":
            return Object.values(template.entries).flatMap(collect);
          case "array":
            return template.items.flatMap(collect);
          // A program's text is a leaf, but a hole renders a binding into the program: when that
          // binding reads a step, the step runs before the program does.
          case "program":
            return [template.source, ...template.holes.map((hole) => hole.binding)].flatMap(
              collect,
            );
          default:
            return [];
        }
      })
      .filter((dependency) => steps.some((step) => step.id === dependency));
    // A dependency the recording established (the call that declared the write the producer's
    // reader declared) is kept as firmly as one a binding implies: both are facts of the record.
    const dependsOn = [...new Set([...bound, ...(observation.establishedDependsOn ?? [])])].filter(
      (dependency) => steps.some((step) => step.id === dependency),
    );

    steps.push({
      id: stepId,
      callId: observation.callId,
      callable: {
        runtime: observation.callable.runtime,
        name: observation.callable.name,
        ...(observation.callable.connection ? { connection: observation.callable.connection } : {}),
        ...(observation.callable.inputSchema === undefined
          ? {}
          : { inputSchema: observation.callable.inputSchema }),
        ...(observation.callable.program === undefined
          ? {}
          : { program: observation.callable.program }),
      },
      arguments: Object.entries(sources).map(([name, template]) => {
        const provenance = observation.argumentProvenance?.[name];
        return {
          name,
          source: { kind: "template" as const, template },
          ...(provenance === undefined ? {} : { provenance }),
        };
      }),
      dependsOn,
      failurePolicy:
        observation.recordedFailureControl === undefined
          ? { onError: "abort", policy: "default" as const }
          : { onError: observation.recordedFailureControl, policy: "recorded" as const },
      observed: { outcome: observation.observed ?? "unknown" },
      ...(observation.permissions === undefined ? {} : { permissions: observation.permissions }),
    });
  }

  if (steps.length === 0) return undefined;

  // Final privacy sweep: any literal leaf the record classifies as private becomes a private
  // reference, wherever it ended up in the workflow.
  const sweep = (template: WorkflowValueTemplate): WorkflowValueTemplate => {
    switch (template.type) {
      case "literal": {
        const expand = (value: WorkflowJsonValue): WorkflowValueTemplate => {
          if (
            typeof value === "string" &&
            privatePredicates.some((predicate) => predicate(value))
          ) {
            return makePrivate(value);
          }
          if (Array.isArray(value)) return { type: "array", items: value.map(expand) };
          if (isPlainObjectValue(value)) {
            const entries: Record<string, WorkflowValueTemplate> = {};
            for (const [key, entry] of Object.entries(value)) entries[key] = expand(entry);
            return { type: "object", entries };
          }
          return { type: "literal", value };
        };
        return expand(template.value);
      }
      case "object": {
        const entries: Record<string, WorkflowValueTemplate> = {};
        for (const [key, entry] of Object.entries(template.entries)) entries[key] = sweep(entry);
        return { type: "object", entries };
      }
      case "array":
        return { type: "array", items: template.items.map(sweep) };
      // A program's text and every hole binding are swept like any other leaf: a private value inside
      // a program is replaced by its reference wherever it sits.
      case "program":
        return {
          type: "program",
          language: template.language,
          source: sweep(template.source),
          holes: template.holes.map((hole) => ({
            token: hole.token,
            binding: sweep(hole.binding),
          })),
        };
      default:
        return template;
    }
  };
  for (const step of steps) {
    step.arguments = step.arguments.map((argument) =>
      argument.source.kind === "template"
        ? {
            ...argument,
            source: { kind: "template" as const, template: sweep(argument.source.template) },
          }
        : argument,
    );
  }

  const workflow: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId,
    inputs: [...inputTypes.entries()].map(([name, type]) => ({ name, type })),
    steps,
    ...(privateValues.size > 0 ? { privateReferences: [...privateValues.keys()] } : {}),
    // Candidates are reported, never executed: the steps above keep the values the record shows
    // until a replay confirms a suggestion on inputs the recording never contained.
    ...(candidates === undefined || candidates.length === 0 ? {} : { candidates: [...candidates] }),
  };
  return { workflow, privateValues, skipped };
}

export function recordWorkflowRecipe(
  workflowId: string,
  observations: readonly RecordedCallObservation[],
  candidates?: readonly WorkflowBindingCandidate[],
): RecordedRecipe | undefined {
  return recordWorkflowRecipeInternal(workflowId, observations, candidates);
}

/**
 * Proposes parameterization from what varied between demonstrations.
 *
 * A proposal is not the workflow: nothing executable changes here. The proposal names the arguments
 * that took different values across recorded executions, with the values seen and the type they had,
 * so a caller (or an operator) can accept it deliberately. An established binding is never proposed
 * for replacement, and nothing the record marked private is ever proposed.
 */
export interface InputProposal {
  name: string;
  from: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  seenValues: WorkflowJsonValue[];
}

export interface InputProposalSet {
  /** The recorded workflow, unchanged: accepting the proposals is a separate, deliberate step. */
  workflow: RecordedWorkflow;
  proposals: InputProposal[];
}

export function proposeInputsFromVariation(
  recipes: readonly RecordedRecipe[],
): InputProposalSet | undefined {
  if (recipes.length === 0) return undefined;
  const base = recipes[0]!;
  const proposals: InputProposal[] = [];
  if (recipes.length < 2) return { workflow: base.workflow, proposals };

  const templateAt = (
    recipe: RecordedRecipe,
    stepIndex: number,
    argumentName: string,
  ): WorkflowValueTemplate | undefined => {
    const argument = recipe.workflow.steps[stepIndex]?.arguments.find(
      (entry) => entry.name === argumentName,
    );
    return argument?.source.kind === "template" ? argument.source.template : undefined;
  };

  for (let stepIndex = 0; stepIndex < base.workflow.steps.length; stepIndex += 1) {
    const step = base.workflow.steps[stepIndex]!;
    for (const argument of step.arguments) {
      const first = templateAt(base, stepIndex, argument.name);
      // Only a constant can be proposed as an input; a recorded binding stays a binding.
      if (!first || first.type !== "literal") continue;
      const values = recipes.map((recipe) => {
        const candidate = templateAt(recipe, stepIndex, argument.name);
        return candidate?.type === "literal" ? candidate.value : undefined;
      });
      if (values.some((entry) => entry === undefined)) continue;
      if (new Set(values.map((entry) => JSON.stringify(entry))).size < 2) continue;
      const seen = values as WorkflowJsonValue[];
      const type: InputProposal["type"] = seen.every((entry) => typeof entry === "number")
        ? "number"
        : seen.every((entry) => typeof entry === "boolean")
          ? "boolean"
          : seen.every((entry) => Array.isArray(entry))
            ? "array"
            : seen.every(
                  (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
                )
              ? "object"
              : "string";
      proposals.push({
        name: `${step.id}_${argument.name}`,
        from: `${step.id}.${argument.name}`,
        type,
        seenValues: seen,
      });
    }
  }
  return { workflow: base.workflow, proposals };
}

/**
 * Applies accepted proposals. Only this step changes the executable workflow, and it is the caller's
 * decision: a proposal that was not accepted leaves the workflow exactly as recorded.
 */
export function acceptInputProposals(
  workflow: RecordedWorkflow,
  proposals: readonly InputProposal[],
): RecordedWorkflow {
  const accepted: RecordedWorkflow = JSON.parse(JSON.stringify(workflow)) as RecordedWorkflow;
  const inputs = new Map(accepted.inputs.map((input) => [input.name, input]));
  for (const proposal of proposals) {
    const [stepId, argumentName] = proposal.from.split(".");
    const step = accepted.steps.find((entry) => entry.id === stepId);
    const argument = step?.arguments.find((entry) => entry.name === argumentName);
    if (!argument || argument.source.kind !== "template") continue;
    inputs.set(proposal.name, { name: proposal.name, type: proposal.type });
    argument.source = { kind: "template", template: { type: "input", name: proposal.name } };
  }
  accepted.inputs = [...inputs.values()];
  return accepted;
}

/** A normalized event, as much of it as recording calls needs. */
export interface RecordableEvent {
  type: string;
  eventId: string;
  sessionId: string;
  timestamp?: string;
  causalRef?: { causalSequence?: number; stepIndex?: number };
  /** Tool calls carry the name and arguments; results carry the value and the call they answer. */
  toolName?: string;
  callId?: string;
  toolCallId?: string;
  parameters?: Record<string, WorkflowJsonValue>;
  result?: WorkflowJsonValue;
  content?: unknown;
  /** Whether the recorded result reported an error; absent means the record does not say. */
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * A connection the capture actually observed: the call consumed a reference the scope assigned to an
 * earlier result, at an optional nested field. Present only when the calling program used the
 * reference-aware interface; a plain-JSON recording has none.
 */
export interface RecordedReferenceUse {
  reference: string;
  path?: Array<string | number>;
}

/**
 * Binds a carrier origin's references to the steps this recording observed. The
 * reference token carries its own scope; the producing call's recorded handle maps the
 * invocation surface's call id onto this recording's call id. A reference that names
 * nothing stays unresolved rather than being guessed from a matching value.
 */
function bindCarrierOrigin(
  origin: AgentArgumentOrigin,
  aliasByScopeCall: Map<string, string>,
  stepIdByCallId: Map<string, string>,
  eventSessionId: string,
): WorkflowValueTemplate {
  switch (origin.type) {
    case "reference": {
      const parts = origin.reference.split(":");
      if (parts.length >= 3 && parts[0] === "ref") {
        const scope = parts[1]!;
        const refCallId = parts.slice(2).join(":");
        const producingKey =
          aliasByScopeCall.get(`${scope}${refCallId}`) ?? `${eventSessionId}${refCallId}`;
        const stepId = stepIdByCallId.get(producingKey);
        if (stepId !== undefined) {
          return { type: "result", stepId, path: origin.path };
        }
      }
      return {
        type: "unresolved",
        reason: `reference '${origin.reference}' does not name a recorded call in this session`,
      };
    }
    case "object": {
      const entries: Record<string, WorkflowValueTemplate> = {};
      for (const [key, entry] of Object.entries(origin.entries)) {
        entries[key] = bindCarrierOrigin(entry, aliasByScopeCall, stepIdByCallId, eventSessionId);
      }
      return { type: "object", entries };
    }
    case "array":
      return {
        type: "array",
        items: origin.items.map((item) =>
          bindCarrierOrigin(item, aliasByScopeCall, stepIdByCallId, eventSessionId),
        ),
      };
    default:
      // literal / input / private carry through verbatim.
      return origin;
  }
}

/**
 * The display value a carrier origin stands for: literals keep their recorded value;
 * inputs, references and private leaves have no uploadable value, so they read as null.
 * The executable template comes from the origin itself, never from this value.
 */
function carrierArgumentValue(origin: AgentArgumentOrigin): WorkflowJsonValue {
  switch (origin.type) {
    case "literal":
      return origin.value;
    case "object": {
      const out: Record<string, WorkflowJsonValue> = {};
      for (const [key, entry] of Object.entries(origin.entries)) {
        out[key] = carrierArgumentValue(entry);
      }
      return out;
    }
    case "array":
      return origin.items.map(carrierArgumentValue);
    default:
      return null;
  }
}

/**
 * One call of an execution other than the recording's own, kept only as far as re-targeting what it
 * suggested at a step of this recording needs: the callable it reached and what it proposed.
 */
interface RepeatCall {
  /** The id this call was recorded under, which a result proposal from that execution names. */
  callId: string;
  runtime: string;
  name: string;
  connection?: string;
  candidates: readonly WorkflowCallCandidate[];
}

export function recordCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: {
    /**
     * Runtime and connection as discovery/dispatch recorded them. A callable the record only names
     * keeps an unknown runtime: the runtime is not guessed from the tool's name.
     */
    discoveryFor?: (toolName: string) => { runtime?: string; connection?: string } | undefined;
    /**
     * The reference scope the calling program used for this session. A reference from another scope
     * never binds, so the scope must be stated rather than assumed from the workflow's name.
     */
    referenceScopeId?: string;
    /**
     * Events read from elsewhere in the recording's session, for validation evidence only.
     *
     * A demonstration is a second execution of the same work, which lives beside the work being
     * compiled rather than inside it. These events may supply such a demonstration; they never
     * become steps, never select a different execution, and never change what the workflow does.
     */
    supportingEvents?: readonly RecordableEvent[];
  } = {},
): RecordedRecipe | undefined {
  const ordered = [...events].sort(compareRecordedEvents);
  const resultsByCallId = new Map<
    string,
    { value: WorkflowJsonValue | undefined; isError: boolean | undefined }
  >();
  /**
   * The handle a composed call returned for its result, keyed by scope: it maps the
   * invocation surface's call id onto this recording's call id, so a later reference
   * token binds to the call that produced the value it names.
   */
  const resultAliasByCallId = new Map<string, string>();
  const scopedKey = (sessionId: string, callId: string): string => `${sessionId}${callId}`;
  for (const event of ordered) {
    if (event.type !== "tool_result") continue;
    const callId = event.callId ?? event.toolCallId;
    if (!callId) continue;
    resultsByCallId.set(scopedKey(event.sessionId, callId), {
      value: event.result ?? extractResultValue(event.content),
      isError: event.isError,
    });
    const carrier = readWorkflowResultCarrier(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]);
    const handle = carrier?.handle;
    if (handle !== undefined) {
      const parts = handle.split(":");
      if (parts.length >= 3 && parts[0] === "ref") {
        const scope = parts[1]!;
        const gatewayCallId = parts.slice(2).join(":");
        resultAliasByCallId.set(`${scope}${gatewayCallId}`, scopedKey(event.sessionId, callId));
      }
    }
  }

  const stepIdByCallId = new Map<string, string>();
  /** Inputs the calling program supplied, with the types it used. */
  const recordedInputTypes = new Map<string, string>();
  /**
   * A reference is only usable when it names this recording's scope. Call ids are not unique across
   * scopes, so a reference from another recording must never bind to a local call sharing its id.
   */
  const localCallIdOf = (reference: string, scopeId: string): string | undefined => {
    const parts = reference.split(":");
    if (parts.length < 3 || parts[0] !== "ref") return undefined;
    if (parts[1] !== scopeId) return undefined;
    return parts.slice(2).join(":");
  };
  const scopeId = options.referenceScopeId ?? workflowId;
  const supporting = options.supportingEvents ?? [];

  // One piece of work is one execution. When the capture recorded which execution each call belongs
  // to, the recording is built from the one a later, matching execution demonstrates: the calls of
  // the other executions are the same work performed again, and running them as extra steps of one
  // tool would make the tool do the job twice.
  const selectedExecutionIndex = selectedExecution(ordered);
  const observations: RecordedCallObservation[] = [];
  const stepIdByPosition = new Map<number, string>();
  const seenCallIds = new Set<string>();
  /** Suggestions the capture made, related to the steps of this recording. */
  const carrierCandidates: WorkflowBindingCandidate[] = [];
  /**
   * The other executions of this session, kept only as far as one of their calls can be about a
   * step of this recording: the callable each call reached, in order, and what that call proposed.
   */
  const repeats = new Map<number, RepeatCall[]>();
  /** The id a call is read under, whatever the transport called it. */
  const callIdOf = (event: RecordableEvent): string =>
    event.callId ?? event.toolCallId ?? event.eventId;
  /**
   * The callable an event reached, exactly as a step of this recording would state it: the name the
   * carrier gives, the connection it was reached through, and the runtime discovery recorded. One
   * resolution for the recording's own calls and for a repeat's, so the two are comparable.
   */
  const callableOf = (
    event: RecordableEvent,
    carrier: WorkflowCallCarrier | undefined,
  ): { runtime: string; name: string; connection?: string } => {
    const name = carrier?.name ?? event.toolName ?? "unknown";
    const discovery = options.discoveryFor?.(name);
    const connection =
      carrier?.connection ??
      discovery?.connection ??
      (event.metadata?.connection as string | undefined);
    return {
      runtime:
        carrier?.runtime ??
        discovery?.runtime ??
        (event.metadata?.runtime as string | undefined) ??
        "unknown",
      name,
      ...(connection === undefined ? {} : { connection }),
    };
  };
  /**
   * Records one call of an execution other than the recording's own.
   *
   * A repeat is not part of this recording, and its calls never become steps of it, but a candidate
   * the capture minted on one of its calls can still be about a step of it: the same argument of the
   * same callable, reached at the same ordinal. Which candidates those are is decided where the
   * recording's own callables are known, so the call is kept whole here.
   */
  const noteRepeatCall = (
    event: RecordableEvent,
    carrier: WorkflowCallCarrier | undefined,
    executionIndex: number,
  ): void => {
    let calls = repeats.get(executionIndex);
    if (calls === undefined) {
      calls = [];
      repeats.set(executionIndex, calls);
    }
    const callable = callableOf(event, carrier);
    calls.push({
      callId: callIdOf(event),
      runtime: callable.runtime,
      name: callable.name,
      ...(callable.connection === undefined ? {} : { connection: callable.connection }),
      candidates: carrier?.candidates ?? [],
    });
  };
  /**
   * Claims a call for reading, once: the key it is read under, or undefined when the event is not a
   * call or its call was already read. A call is classified by the execution its carrier names,
   * never by the set of events it arrived in, and a redelivered call is the same execution rather
   * than a second step of it.
   */
  const claimCall = (event: RecordableEvent): string | undefined => {
    if (event.type !== "tool_call") return undefined;
    const callId = event.callId ?? event.toolCallId ?? event.eventId;
    const scopedCallKey = scopedKey(event.sessionId, callId);
    if (seenCallIds.has(scopedCallKey)) return undefined;
    seenCallIds.add(scopedCallKey);
    return scopedCallKey;
  };
  for (const event of ordered) {
    if (event.type !== "tool_call") continue;
    const callId = event.callId ?? event.toolCallId ?? event.eventId;
    const scopedCallKey = claimCall(event);
    if (scopedCallKey === undefined) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const executionIndex = carrier?.executionIndex;
    if (executionIndex !== undefined && executionIndex !== selectedExecutionIndex) {
      noteRepeatCall(event, carrier, executionIndex);
      continue;
    }
    const declaredFlow = declaredResourceFlowOf(event);
    const recordedReferences =
      (event.metadata?.references as Record<string, RecordedReferenceUse> | undefined) ?? {};
    const recordedInputs =
      (event.metadata?.inputs as
        | Array<{ name: string; argument: string; type: string }>
        | undefined) ?? [];
    const argumentOrigins: Record<string, RecordedArgumentOrigin> = {};
    const argumentTypes: Record<string, "string" | "number" | "boolean" | "object" | "array"> = {};
    const callArguments: Record<string, WorkflowJsonValue> = {};

    if (carrier !== undefined) {
      // The carrier is the caller's own statement of every argument's origin. A
      // reference binds through the producing call's recorded handle; one that names
      // nothing this session recorded stays unbound rather than being guessed.
      for (const input of carrier.inputs) {
        recordedInputTypes.set(input.name, input.type);
        argumentTypes[input.argument] = input.type as (typeof argumentTypes)[string];
      }
      for (const [argumentName, origin] of Object.entries(carrier.origins)) {
        argumentOrigins[argumentName] = bindCarrierOrigin(
          origin,
          resultAliasByCallId,
          stepIdByCallId,
          event.sessionId,
        );
        callArguments[argumentName] = carrierArgumentValue(origin);
      }
    }

    for (const input of recordedInputs) {
      argumentOrigins[input.argument] = { type: "input", name: input.name };
      recordedInputTypes.set(input.name, input.type);
    }
    for (const [argumentName, use] of Object.entries(recordedReferences)) {
      const producingCallId = localCallIdOf(use.reference, scopeId);
      const producingStepId = producingCallId
        ? stepIdByCallId.get(scopedKey(event.sessionId, producingCallId))
        : undefined;
      // rather than being guessed from the value that happens to be there.
      if (producingStepId) {
        argumentOrigins[argumentName] = {
          type: "result",
          stepId: producingStepId,
          path: (use.path ?? []) as WorkflowValuePath,
        };
      }
    }
    const recordedResult = resultsByCallId.get(scopedCallKey);
    const callable = callableOf(event, carrier);
    const privateValues = (event.metadata?.maskedValues as string[] | undefined) ?? [];
    const isPrivateValue =
      privateValues.length > 0
        ? (value: string) => privateValues.includes(value)
        : carrier !== undefined
          ? containsRedactionPlaceholder
          : undefined;
    observations.push({
      callId,
      ...(event.causalRef?.causalSequence === undefined
        ? {}
        : { causalSequence: event.causalRef.causalSequence }),
      callable: {
        runtime: callable.runtime,
        name: callable.name,
        ...(callable.connection === undefined ? {} : { connection: callable.connection }),
        ...(carrier?.inputSchema === undefined ? {} : { inputSchema: carrier.inputSchema }),
        ...(carrier?.program === undefined ? {} : { program: carrier.program }),
      },
      arguments: carrier !== undefined ? callArguments : (event.parameters ?? {}),
      ...(Object.keys(argumentOrigins).length > 0 ? { argumentOrigins } : {}),
      ...(Object.keys(argumentTypes).length > 0 ? { argumentTypes } : {}),
      ...(carrier?.provenance === undefined ? {} : { argumentProvenance: carrier.provenance }),
      ...(declaredFlow === undefined ? {} : { flow: declaredFlow }),
      ...(recordedResult?.value === undefined ? {} : { result: recordedResult.value }),
      ...(isPrivateValue ? { isPrivateValue } : {}),
      observed:
        recordedResult === undefined
          ? "unknown"
          : recordedResult.isError === true
            ? "failed"
            : recordedResult.isError === false
              ? "succeeded"
              : "unknown",
    });
    // The observation was just pushed, so this call's step is the last one.
    const ownStepId = `step${observations.length - 1}`;
    stepIdByCallId.set(scopedCallKey, ownStepId);
    // Steps are numbered in the order the calls arrived, which is the order the demonstration used.
    if (executionIndex !== undefined) stepIdByPosition.set(observations.length - 1, ownStepId);
    if (carrier?.candidates !== undefined) {
      for (const candidate of carrier.candidates) {
        if (candidate.proposed.kind !== "result") {
          carrierCandidates.push({
            stepId: ownStepId,
            argument: candidate.argument,
            path: candidate.path,
            proposed: candidate.proposed,
            reason: candidate.reason,
            ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
            missing: candidate.missing,
          });
          continue;
        }
        // The suggestion names the call that produced the value; the recording numbers that call as
        // a step, so the two are related here and only here.
        const producingStepId = stepIdByCallId.get(
          scopedKey(event.sessionId, candidate.proposed.callId),
        );
        if (producingStepId === undefined) continue;
        carrierCandidates.push({
          stepId: ownStepId,
          argument: candidate.argument,
          path: candidate.path,
          proposed: { kind: "result", stepId: producingStepId, path: candidate.proposed.path },
          reason: candidate.reason,
          ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
          missing: candidate.missing,
        });
      }
    }
  }
  if (observations.length === 0) return undefined;

  // The recording's own calls are the evidence's, and the session read beside it is where its other
  // executions live. A repeat is the same work performed again wherever it was read, so the calls of
  // the executions the evidence did not name are read here for exactly what they minted — never as
  // steps: only the selected execution's calls are numbered.
  for (const event of [...supporting].sort(compareRecordedEvents)) {
    if (claimCall(event) === undefined) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const executionIndex = carrier?.executionIndex;
    if (executionIndex === undefined || executionIndex === selectedExecutionIndex) continue;
    noteRepeatCall(event, carrier, executionIndex);
  }

  // A selected workflow can be a slice of a larger execution. Match repetitions against the
  // complete original execution, then map only the selected call ids to steps. Unselected calls
  // remain supporting evidence; their proposals and effects never become extra executable steps.
  const selectedSession = ordered.find((event) => event.type === "tool_call")?.sessionId;
  const baselineCalls = new Map<string, RepeatCall>();
  for (const event of [...ordered, ...supporting].sort(compareRecordedEvents)) {
    if (event.type !== "tool_call" || event.sessionId !== selectedSession) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (carrier?.executionIndex !== selectedExecutionIndex) continue;
    const id = callIdOf(event);
    if (!baselineCalls.has(id))
      baselineCalls.set(id, {
        callId: id,
        ...callableOf(event, carrier),
        candidates: carrier?.candidates ?? [],
      });
  }
  const baseline = [...baselineCalls.values()];
  for (const calls of repeats.values()) {
    if (calls.length !== baseline.length) continue;
    if (
      calls.some((call, ordinal) => {
        const original = baseline[ordinal]!;
        return (
          call.name !== original.name ||
          call.runtime !== original.runtime ||
          call.connection !== original.connection
        );
      })
    )
      continue;
    const stepIdByRepeatCallId = new Map<string, string>();
    for (const [ordinal, call] of calls.entries()) {
      const original = baseline[ordinal]!;
      const stepId = stepIdByCallId.get(scopedKey(selectedSession!, original.callId));
      if (stepId !== undefined) stepIdByRepeatCallId.set(call.callId, stepId);
    }
    for (const call of calls) {
      const stepId = stepIdByRepeatCallId.get(call.callId);
      if (stepId === undefined) continue;
      for (const candidate of call.candidates) {
        const producingStepId =
          candidate.proposed.kind === "result"
            ? stepIdByRepeatCallId.get(candidate.proposed.callId)
            : undefined;
        if (candidate.proposed.kind === "result" && producingStepId === undefined) continue;
        if (
          carrierCandidates.some(
            (entry) =>
              entry.stepId === stepId &&
              entry.argument === candidate.argument &&
              entry.path.length === candidate.path.length &&
              entry.path.every((part, index) => part === candidate.path[index]),
          )
        )
          continue;
        carrierCandidates.push({
          stepId,
          argument: candidate.argument,
          path: candidate.path,
          proposed:
            candidate.proposed.kind === "result"
              ? { kind: "result", stepId: producingStepId!, path: candidate.proposed.path }
              : candidate.proposed,
          reason: candidate.reason,
          ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
          missing: candidate.missing,
        });
      }
    }
  }

  // What the calls themselves establish about their own arguments: the dependencies their declared
  // resource use proves, and the bindings their values only suggest. A suggestion never becomes
  // executable here — it is reported so a replay can confirm or refuse it.
  const derivationCalls: DerivationCall[] = observations.map((observation, index) => ({
    callId: observation.callId,
    stepId: `step${index}`,
    toolName: observation.callable.name,
    runtime: observation.callable.runtime,
    arguments: observation.arguments,
    ...(observation.result === undefined ? {} : { result: observation.result }),
    ...(observation.flow === undefined ? {} : { flow: observation.flow }),
  }));
  const derivation = deriveNativeCalls(derivationCalls);
  const dependsOnByStep = new Map(derivation.calls.map((call) => [call.stepId, call.dependsOn]));
  for (const [index, observation] of observations.entries()) {
    const established = dependsOnByStep.get(`step${index}`);
    if (established !== undefined && established.length > 0) {
      observation.establishedDependsOn = established;
    }
  }

  const recipe = recordWorkflowRecipe(workflowId, observations, derivation.candidates);
  if (!recipe) return undefined;
  const heldOut = demonstratedWorkflow(
    demonstrationOf([...ordered, ...supporting], selectedExecutionIndex),
    stepIdByPosition,
  );
  if (heldOut !== undefined) recipe.workflow.heldOut = heldOut;
  if (carrierCandidates.length > 0) {
    // A suggestion the capture itself made, expressed against the calls it observed. It is carried
    // through as a suggestion: the steps keep the values the record shows.
    recipe.workflow.candidates = [...(recipe.workflow.candidates ?? []), ...carrierCandidates];
  }
  // Every local reference the plan can resolve must be declared, because a private reference is a
  // name the executor checks against the plan rather than a capability the plan implies.
  const declaredPrivateReferences = new Set(recipe.workflow.privateReferences ?? []);
  for (const step of recipe.workflow.steps) {
    for (const argument of step.arguments) {
      collectPrivateReferences(argument.source, declaredPrivateReferences);
    }
  }
  // The demonstration is kept the same way its leaves are: the plan names it, and the host resolves
  // it locally, so a recording never carries the user's own second run as data.
  for (const entry of recipe.workflow.heldOut?.inputs ?? []) {
    declaredPrivateReferences.add(entry.reference);
  }
  for (const entry of recipe.workflow.heldOut?.observed ?? []) {
    declaredPrivateReferences.add(entry.reference);
  }
  if (declaredPrivateReferences.size > 0) {
    recipe.workflow.privateReferences = [...declaredPrivateReferences];
  }
  const declared = new Map(recipe.workflow.inputs.map((input) => [input.name, input]));
  for (const [name, type] of recordedInputTypes) {
    declared.set(name, { name, type: type as RecordedWorkflow["inputs"][number]["type"] });
  }
  recipe.workflow.inputs = [...declared.values()];
  return recipe;
}

/** The execution a recording is built from, and the demonstration a later one offers for it. */
/**
 * The execution a recording is built from: the earliest piece of work the events themselves name.
 *
 * Only the events of the work being compiled decide this. Evidence read from elsewhere in the
 * session says what a replay may be checked against; it never chooses, replaces or extends the
 * executable workflow, because a recording is one piece of work and a session is not.
 */
function selectedExecution(events: readonly RecordableEvent[]): number | undefined {
  const indices = new Set<number>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (carrier?.executionIndex === undefined) continue;
    indices.add(carrier.executionIndex);
  }
  return indices.size === 0 ? undefined : Math.min(...indices);
}

/**
 * The most complete demonstration that repeats the selected execution, from anywhere it was read.
 *
 * A repeat reports itself one call at a time and its observations arrive on the result side, so the
 * last carrier that names it is the fullest. A demonstration of any other execution is not a
 * demonstration of this work and is ignored.
 */
function demonstrationOf(
  events: readonly RecordableEvent[],
  target: number | undefined,
): WorkflowCallHeldOut | undefined {
  if (target === undefined) return undefined;
  let demonstration: WorkflowCallHeldOut | undefined;
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const candidate = carrier?.heldOut;
    if (candidate === undefined || candidate.repeats !== target) continue;
    if (
      demonstration === undefined ||
      candidate.inputs.length + candidate.observed.length >
        demonstration.inputs.length + demonstration.observed.length
    ) {
      demonstration = candidate;
    }
  }
  return demonstration;
}

/** The demonstration, addressed by the steps this recording gave the work it demonstrates. */
function demonstratedWorkflow(
  demonstration: WorkflowCallHeldOut | undefined,
  stepIdByPosition: ReadonlyMap<number, string>,
): RecordedWorkflow["heldOut"] | undefined {
  if (demonstration === undefined) return undefined;
  const inputs: NonNullable<RecordedWorkflow["heldOut"]>["inputs"] = [];
  const observed: NonNullable<RecordedWorkflow["heldOut"]>["observed"] = [];
  for (const entry of demonstration.inputs) {
    const stepId = stepIdByPosition.get(entry.position);
    if (stepId === undefined) continue;
    inputs.push({ stepId, argument: entry.argument, reference: entry.reference });
  }
  for (const entry of demonstration.observed) {
    const stepId = stepIdByPosition.get(entry.position);
    if (stepId === undefined) continue;
    observed.push({ stepId, reference: entry.reference });
  }
  if (inputs.length === 0 && observed.length === 0) return undefined;
  return { inputs, observed };
}

/** Collects every local reference a value source can resolve, so the plan can declare them. */
function collectPrivateReferences(source: WorkflowValueSource, into: Set<string>): void {
  switch (source.kind) {
    case "private":
      into.add(source.reference);
      return;
    case "template":
      collectTemplateReferences(source.template, into);
      return;
    default:
      return;
  }
}

function collectTemplateReferences(template: WorkflowValueTemplate, into: Set<string>): void {
  switch (template.type) {
    case "private":
      into.add(template.reference);
      return;
    case "object":
      for (const entry of Object.values(template.entries)) collectTemplateReferences(entry, into);
      return;
    case "array":
      for (const entry of template.items) collectTemplateReferences(entry, into);
      return;
    // A program resolves its text like any other leaf — usually a private reference — and each hole
    // resolves the binding rendered into its token.
    case "program":
      collectTemplateReferences(template.source, into);
      for (const hole of template.holes) collectTemplateReferences(hole.binding, into);
      return;
    default:
      return;
  }
}

/**
 * The declared resources a call read and wrote, as the capture recorded them.
 *
 * The carrier names resources by a per-scope ordinal and never by their value, so two calls share a
 * resource exactly when the capture held the same value for both. The scope is part of the identity:
 * two sessions number their resources independently, and an ordinal alone would make one session's
 * file look like another's.
 */
function declaredResourceFlowOf(event: RecordableEvent): ObservedResourceFlow | undefined {
  const evidence = readToolLinkEvidence(event.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]);
  if (evidence === undefined) return undefined;
  if (evidence.reads.length === 0 && evidence.writes.length === 0) return undefined;
  const identityOf = (ref: { kind: string; ref: string }): string =>
    `${evidence.scopeId}|${ref.kind}:${ref.ref}`;
  return {
    reads: evidence.reads.map(identityOf),
    writes: evidence.writes.map(identityOf),
  };
}

function extractResultValue(content: unknown): WorkflowJsonValue | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string" || typeof content === "number" || typeof content === "boolean") {
    return content;
  }
  if (Array.isArray(content)) return content as WorkflowJsonValue;
  if (typeof content === "object" && content !== null) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
    return content as WorkflowJsonValue;
  }
  return undefined;
}
