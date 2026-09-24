/** Pure recorded-workflow recipe construction shared by native and carried capture. */

import { collectWorkflowPrivateReferences } from "@resin/contracts";

import type {
  RecordedWorkflow,
  WorkflowArgumentProvenance,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
  WorkflowRecordedProgram,
  WorkflowStep,
  WorkflowValueSource,
  WorkflowValueTemplate,
} from "@resin/contracts";

/** Declared resources a captured call read and wrote. */
export interface ObservedResourceFlow {
  reads: readonly string[];
  writes: readonly string[];
}
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
  /** Private reference to this original call's successful result for baseline replay. */
  baselineReference?: string;
  /** Optional projection used only when comparing a textual baseline result. */
  baselineComparison?: "text-trim";
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
  const sortedObservations = [...observations].sort(
    (left, right) =>
      (left.causalSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.causalSequence ?? Number.MAX_SAFE_INTEGER),
  );
  // A closed Python target is a self-contained replay unit: its successful setup cells are carried
  // by private source references and must not also remain workflow steps, or the runtime would run
  // them twice and the contract would reject the overlap.
  const pythonSetupCallIds = new Set<string>();
  for (const observation of sortedObservations) {
    if (observation.callable.program?.pythonState?.status !== "closed") continue;
    for (const setup of observation.callable.program.pythonState.setup) {
      pythonSetupCallIds.add(setup.callId);
    }
  }
  const ordered = sortedObservations.filter(
    (observation) => !pythonSetupCallIds.has(observation.callId),
  );
  const privateValues = new Map<string, WorkflowJsonValue>();
  const skipped: Array<{ callId: string; reason: string }> = [];
  const steps: WorkflowStep[] = [];
  const baselineObserved: Array<{
    stepId: string;
    reference: string;
    comparison?: "text-trim";
  }> = [];
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
    if (observation.baselineReference !== undefined) {
      baselineObserved.push({
        stepId,
        reference: observation.baselineReference,
        ...(observation.baselineComparison === undefined
          ? {}
          : { comparison: observation.baselineComparison }),
      });
    }
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
      // A projected source is already secret-redacted; sweeping its placeholders would hide the
      // parser view again. The complete executable source stays behind sourceReference instead.
      case "program":
        return {
          type: "program",
          language: template.language,
          source: template.sourceReference === undefined ? sweep(template.source) : template.source,
          ...(template.sourceReference === undefined
            ? {}
            : { sourceReference: template.sourceReference }),
          ...(template.protectedTokens === undefined
            ? {}
            : { protectedTokens: [...template.protectedTokens] }),
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

  const privateReferences = new Set(privateValues.keys());
  for (const entry of baselineObserved) privateReferences.add(entry.reference);
  const workflow: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId,
    inputs: [...inputTypes.entries()].map(([name, type]) => ({ name, type })),
    steps,
    ...(baselineObserved.length === steps.length
      ? { baseline: { inputs: [], observed: baselineObserved } }
      : {}),
    ...(privateReferences.size > 0 ? { privateReferences: [...privateReferences] } : {}),
    // Candidates are reported, never executed: the steps above keep the values the record shows
    // until a replay confirms a suggestion on inputs the recording never contained.
    ...(candidates === undefined || candidates.length === 0 ? {} : { candidates: [...candidates] }),
  };
  const requiredReferences = collectWorkflowPrivateReferences(workflow);
  if (requiredReferences.length > 0) workflow.privateReferences = requiredReferences;
  return { workflow, privateValues, skipped };
}

export function recordWorkflowRecipe(
  workflowId: string,
  observations: readonly RecordedCallObservation[],
  candidates?: readonly WorkflowBindingCandidate[],
): RecordedRecipe | undefined {
  return recordWorkflowRecipeInternal(workflowId, observations, candidates);
}

export interface InputProposal {
  name: string;
  from: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  seenValues: WorkflowJsonValue[];
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
