/**
 * Validating a proposed binding against a demonstration, not by similarity.
 *
 * The capture proposes candidates it cannot establish: a value that equals an earlier result, or one
 * that moved with it across executions. Similarity is never proof — an incidental equality would
 * become a dependency, and a dependency that was not there would break the next execution. So every
 * candidate is decided against the demonstration: the recorded plan with the candidate bound is
 * resolved on the demonstration's inputs through the adapters the caller supplies, and so is the
 * recorded plan as it stands, and a candidate is only promoted when its binding reproduces the
 * demonstration's observation *and* the recorded value does not. When both reproduce it, or neither
 * does, the fact the record is missing is reported instead of a promotion.
 */

import {
  type ProgramLanguage,
  type ProgramTokenAddress,
  type ProgramTokenSpanValue,
  type ProgramTokenValue,
  type RecordedWorkflow,
  type WorkflowArgument,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowObservedComparison,
  type WorkflowProgramIdentity,
  type WorkflowStep,
  type WorkflowValidationReplayProof,
  type WorkflowValuePath,
  type WorkflowValueSource,
  type WorkflowValueTemplate,
  applyProgramTokenValues,
  bindProgramToken,
  demonstratedProgramTokenSpanValue,
  extractPrintedValue,
  parseExtractLocator,
  programTokenPath,
  programTokenValueAt,
  tokenizeProgram,
} from "@resin/contracts";
import { applyAcceptedBindings, sourceAsTemplate } from "./candidate-promotion.js";
import { computeWorkflowProgramIdentities } from "./program-identity.js";
import {
  type RecordedStepOutcome,
  type RecordedWorkflowExecution,
  type RecordedWorkflowExecutionOptions,
  type RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "./recorded-workflow.js";

/** Which recorded execution a check reads: the one the plan was built from, or its repeat. */
export type DemonstrationLabel = "baseline" | "held-out";

/** The adapters that answer a plan's steps for one demonstration, or undefined when none can. */
export type DemonstrationAdapters = (
  demonstration: DemonstrationLabel,
) => RuntimeAdapterRegistry | undefined;

export interface CandidateValidationEnvironment {
  adapters: RuntimeAdapterRegistry;
  /**
   * Adapters for the other demonstration, when a decision must also be checked against it. Absent
   * means `adapters` answers every demonstration.
   */
  adaptersFor?: DemonstrationAdapters;
  /** Workspace scope for private-source identity hashing and ownership. */
  workspaceId?: string;
  /** Inputs for this replay. */
  inputs: Record<string, WorkflowJsonValue>;
  /** What the selected demonstration observed: stepId -> the value it produced. */
  observed: Record<string, WorkflowJsonValue>;
  /**
   * Explicit projections declared by the selected demonstration, keyed by observed step.
   * Absence keeps the existing exact structural comparison.
   */
  observedComparisons?: Record<string, WorkflowObservedComparison>;
  /**
   * Resolves the plan's local references for the replay.
   *
   * The values a recording kept on its own machine are what the plan's steps actually pass, so a
   * replay that cannot resolve them fails for a reason that has nothing to do with the candidate
   * under test. Only the holder of those values can run this, which is why validation is a seam
   * rather than something decided where the recording is stored.
   */
  resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  timeoutMs?: number;
}

/**
 * What replaying the plan as a whole concluded.
 *
 * `verified` is the only pass: every step the demonstration observed was reproduced by a single run
 * of the plan that would be published. `incomplete` means the plan is not disproven but the
 * demonstration could not confirm it — a step it observed is decided by nothing a proposal
 * controls. `failed` means the plan was disproven: proposals were withdrawn against the misses and
 * the plan still did not reproduce the work.
 */
export interface WorkflowPlanVerification {
  status: "verified" | "incomplete" | "failed";
  /** The observed steps one run of the plan reproduced. */
  reproduced: string[];
  /** The observed steps it did not, with why. Never empty for a status other than `verified`. */
  missed: Array<{ stepId: string; detail: string }>;
  /** Proposals withdrawn because the plan they produced did not reproduce the work. */
  dropped: Array<{ candidate: WorkflowBindingCandidate; reason: string }>;
  /** Hash-only identities for parameterized programs in the final verified plan. */
  programIdentities?: WorkflowProgramIdentity[];
  /** Digest-bound proof that the plan was checked against the recording. */
  replay?: WorkflowValidationReplayProof;
}

export interface CandidateValidationOutcome {
  candidate: WorkflowBindingCandidate;
  accepted: boolean;
  /** Why it was accepted or refused; always names the evidence. */
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON values: how a replayed result is compared with an observation. */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

/**
 * Compares one replay result with its selected demonstration. Exact matches always reproduce the
 * recording, including meaningful trailing whitespace. The optional text projection additionally
 * permits replay-only surrounding whitespace; expected text is never normalized.
 */
function matchesObservedResult(
  actual: WorkflowJsonValue,
  expected: WorkflowJsonValue,
  comparison: WorkflowObservedComparison | undefined,
): boolean {
  if (comparison === undefined) return deepEqual(actual, expected);
  if (comparison !== "text-trim") return false;
  return (
    typeof actual === "string" &&
    typeof expected === "string" &&
    (actual === expected || actual.trim() === expected)
  );
}

/** What a message calls a path: `["token", 0]` rather than a JSON dump. */
function pathText(path: WorkflowValuePath): string {
  const parts = path.map((part) =>
    typeof part === "number" ? String(part) : JSON.stringify(part),
  );
  return `[${parts.join(", ")}]`;
}

/** A leaf template is one that carries a value; `object` and `array` carry structure instead. */
function isLeafTemplate(template: WorkflowValueTemplate): boolean {
  return template.type !== "object" && template.type !== "array";
}

function proposedTemplate(candidate: WorkflowBindingCandidate): WorkflowValueTemplate {
  const proposed = candidate.proposed;
  switch (proposed.kind) {
    case "result":
      return { type: "result", stepId: proposed.stepId, path: [...proposed.path] };
    case "extract":
      return { type: "extract", stepId: proposed.stepId, locator: proposed.locator };
    default:
      return { type: "input", name: proposed.name };
  }
}

function proposedSource(candidate: WorkflowBindingCandidate): WorkflowValueSource {
  const proposed = candidate.proposed;
  switch (proposed.kind) {
    case "result":
      return { kind: "result", stepId: proposed.stepId, path: [...proposed.path] };
    case "extract":
      return { kind: "template", template: proposedTemplate(candidate) };
    default:
      return { kind: "input", name: proposed.name };
  }
}

/** Where a masked printed value stands in both compared outputs; opaque and never a real value. */
const EXTRACT_PLACEHOLDER = "\u0000resin-extracted-value\u0000";

/** A printed value extracted in the observation and in the replay, masked as one before comparing. */
type ExtractMask = { recorded: string; replayed: string };

/**
 * The values each extract binding in `plan` reads: from the producer's observed output and from its
 * output in this replay. A value is masked only when both sides extracted one of at least four
 * characters or a number, so a comparison never hides text a binding did not account for.
 */
async function extractMasks(
  plan: RecordedWorkflow,
  execution: RecordedWorkflowExecution,
  environment: CandidateValidationEnvironment,
): Promise<ExtractMask[]> {
  const bindings = new Map<string, { stepId: string; locator: string }>();
  const walk = (template: WorkflowValueTemplate): void => {
    switch (template.type) {
      case "extract":
        bindings.set(`${template.stepId}\u0000${template.locator}`, template);
        return;
      case "object":
        for (const entry of Object.values(template.entries)) walk(entry);
        return;
      case "array":
        for (const entry of template.items) walk(entry);
        return;
      case "program":
        walk(template.source);
        for (const hole of template.holes) walk(hole.binding);
        return;
      default:
        return;
    }
  };
  for (const step of plan.steps) {
    for (const argument of step.arguments) {
      if (argument.source.kind === "template") walk(argument.source.template);
    }
  }
  const masks: ExtractMask[] = [];
  if (bindings.size === 0 || environment.resolvePrivate === undefined) return masks;
  for (const binding of bindings.values()) {
    const observed = environment.observed[binding.stepId];
    const outcome = execution.steps.find((entry) => entry.stepId === binding.stepId);
    if (typeof observed !== "string" || outcome?.status !== "completed") continue;
    if (typeof outcome.result !== "string") continue;
    const locatorText = await environment.resolvePrivate(binding.locator);
    const locator = typeof locatorText === "string" ? parseExtractLocator(locatorText) : undefined;
    if (locator === undefined) continue;
    const recorded = extractPrintedValue(observed, locator);
    const replayed = extractPrintedValue(outcome.result, locator);
    if (recorded === undefined || replayed === undefined) continue;
    // Short values are too coincidence-prone to hide, except numbers, masked as whole runs only.
    const short = (value: string): boolean => value.length < 4 && !NUMBER.test(value);
    if (short(recorded) || short(replayed)) continue;
    masks.push({ recorded, replayed });
  }
  return masks;
}

/** A printed number: a decimal, or an integer of at least three digits. */
const NUMBER = /^-?(?:\d+\.\d+|\d{3,})$/;

/** Replaces every masked value in a JSON value's strings with the shared placeholder. */
function maskValue(
  value: WorkflowJsonValue,
  masks: readonly ExtractMask[],
  side: keyof ExtractMask,
): WorkflowJsonValue {
  if (masks.length === 0) return value;
  if (typeof value === "string") {
    let masked = value;
    // Longest first, so a value that contains another is masked whole.
    const ordered = [...masks].sort((left, right) => right[side].length - left[side].length);
    for (const mask of ordered) {
      const text = mask[side];
      masked = NUMBER.test(text)
        ? masked.replace(
            new RegExp(`(?<![0-9.-])${text.replace(/[.-]/g, "\\$&")}(?![0-9.-])`, "g"),
            EXTRACT_PLACEHOLDER,
          )
        : masked.split(text).join(EXTRACT_PLACEHOLDER);
    }
    return masked;
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, masks, side));
  if (value !== null && typeof value === "object") {
    const masked: Record<string, WorkflowJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) masked[key] = maskValue(entry, masks, side);
    return masked;
  }
  return value;
}

/**
 * Binds the candidate into one argument of a plan copy. The path must address a template leaf: a
 * candidate that addresses a whole structure, or a path the record does not have, cannot be
 * replayed as a leaf binding and is refused instead of approximated.
 */
function bindCandidateLeaf(
  step: WorkflowStep,
  argument: WorkflowArgument,
  candidate: WorkflowBindingCandidate,
): boolean {
  const path = candidate.path;
  // A token position is a leaf of the program text the argument holds: it addresses a token of the
  // recorded program, not a node of a value, so the recorded text is lifted into a program template
  // and the proposal is bound at that token.
  if (path[0] === "tokens") {
    const program = step.callable.program;
    const address = programTokenPath(path);
    if (program === undefined || program.argument !== candidate.argument) return false;
    if (address === undefined) return false;
    const recorded = sourceAsTemplate(argument.source);
    argument.source = {
      kind: "template",
      template: bindProgramToken(
        recorded,
        program.kind,
        address.token,
        proposedTemplate(candidate),
        address.embedded,
        address.span,
      ),
    };
    return true;
  }
  if (path.length === 0) {
    if (argument.source.kind === "template" && !isLeafTemplate(argument.source.template)) {
      return false;
    }
    argument.source = proposedSource(candidate);
    return true;
  }
  if (argument.source.kind !== "template") return false;
  const replacement = proposedTemplate(candidate);
  let node: WorkflowValueTemplate = argument.source.template;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    const last = index === path.length - 1;
    if (typeof part === "number") {
      if (node.type !== "array" || part < 0 || part >= node.items.length) return false;
      const item = node.items[part];
      if (last) {
        if (!isLeafTemplate(item)) return false;
        node.items[part] = replacement;
        return true;
      }
      node = item;
      continue;
    }
    if (node.type !== "object" || !Object.hasOwn(node.entries, part)) return false;
    const entry = node.entries[part];
    if (last) {
      if (!isLeafTemplate(entry)) return false;
      node.entries[part] = replacement;
      return true;
    }
    node = entry;
  }
  return false;
}

type CandidatePlans =
  | { kind: "plans"; bound: RecordedWorkflow; literal: RecordedWorkflow }
  | { kind: "refused"; reason: string };

/**
 * Binds every candidate the environment can actually support, reporting the ones it cannot.
 *
 * An input candidate is only bindable when the replay supplies a value for it: binding it to an
 * input nobody provides would fail the run for a reason that has nothing to do with whether the
 * binding is real, and would take every other candidate down with it. Such a candidate is therefore
 * left out of the shared plan and refused on its own.
 */
function bindEveryCandidate(
  plan: RecordedWorkflow,
  candidates: readonly WorkflowBindingCandidate[],
  environment: CandidateValidationEnvironment,
): {
  plan: RecordedWorkflow;
  unaddressable: Map<WorkflowBindingCandidate, string>;
} {
  const bound = structuredClone(plan);
  const unaddressable = new Map<WorkflowBindingCandidate, string>();
  for (const candidate of candidates) {
    const evidence = `${candidate.stepId}.${candidate.argument}${pathText(candidate.path)}`;
    const proposal = candidate.proposed;
    if (proposal.kind === "input" && !Object.hasOwn(environment.inputs, proposal.name)) {
      unaddressable.set(
        candidate,
        `the replay supplied no value for input '${proposal.name}', so it cannot decide whether a caller supplies it`,
      );
      continue;
    }
    const step = bound.steps.find((entry) => entry.id === candidate.stepId);
    if (step === undefined) {
      unaddressable.set(candidate, `the recorded plan has no step '${candidate.stepId}'`);
      continue;
    }
    const argument = step.arguments.find((entry) => entry.name === candidate.argument);
    if (argument === undefined) {
      unaddressable.set(
        candidate,
        `step '${candidate.stepId}' has no argument '${candidate.argument}' to bind`,
      );
      continue;
    }
    if (!bindCandidateLeaf(step, argument, candidate)) {
      unaddressable.set(
        candidate,
        `${evidence} does not address a template leaf in the recorded plan, so the candidate cannot be replayed as a leaf binding`,
      );
      continue;
    }
    if (proposal.kind === "input") {
      const declared = bound.inputs.some((input) => input.name === proposal.name);
      if (!declared) bound.inputs.push({ name: proposal.name, type: proposal.type });
    }
  }
  return { plan: pruneUnusedDerivations(bound), unaddressable };
}

/**
 * Builds the two plans a candidate is decided with: every usable proposal bound, and every usable
 * proposal bound except this one. The two runs therefore differ only in what this candidate asserts.
 *
 * A candidate cannot be decided in isolation. The observations a replay is checked against were
 * produced by the whole work, so a plan that binds only the candidate under test still carries the
 * recorded values everywhere else — and every one of them makes the later steps disagree with the
 * held-out run. Holding every proposal at its best hypothesis and varying exactly one at a time is
 * what makes the comparison mean what it says.
 */
function buildCandidatePlans(
  plan: RecordedWorkflow,
  candidate: WorkflowBindingCandidate,
  candidates: readonly WorkflowBindingCandidate[],
  environment: CandidateValidationEnvironment,
): CandidatePlans {
  const all = bindEveryCandidate(plan, candidates, environment);
  const unusable = all.unaddressable.get(candidate);
  if (unusable !== undefined) return { kind: "refused", reason: unusable };
  const without = bindEveryCandidate(
    plan,
    candidates.filter((entry) => entry !== candidate),
    environment,
  );
  return { kind: "plans", bound: all.plan, literal: without.plan };
}

/** Bound a replay and wait for its owned work to settle after cancelling at expiry. */
async function withDeadline(
  execute: (signal: AbortSignal) => Promise<RecordedWorkflowExecution>,
  timeoutMs: number | undefined,
): Promise<RecordedWorkflowExecution | undefined> {
  const controller = new AbortController();
  if (timeoutMs === undefined) return await execute(controller.signal);
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  try {
    const result = await execute(controller.signal);
    return expired ? undefined : result;
  } finally {
    clearTimeout(timer);
  }
}

interface StepReplay {
  /** Whether the step produced the value the held-out demonstration observed. */
  reproduced: boolean;
  /** What the replay showed — a mismatch, a failed step, a skipped step. Never the value itself. */
  detail: string;
}

function describeOutcome(
  execution: RecordedWorkflowExecution,
  outcome: RecordedStepOutcome,
): string {
  switch (outcome.status) {
    case "completed":
      return `step '${outcome.stepId}' produced a result the demonstration did not observe`;
    case "failed":
      return `step '${outcome.stepId}' failed: ${outcome.error}`;
    case "skipped": {
      // A step that was skipped is only as informative as the failure that stopped it.
      const failed = execution.steps.find((entry) => entry.status === "failed");
      return failed && failed.status === "failed"
        ? `step '${outcome.stepId}' was skipped (${outcome.reason}); step '${failed.stepId}' failed: ${failed.error}`
        : `step '${outcome.stepId}' was skipped: ${outcome.reason}`;
    }
    case "omitted":
      return `step '${outcome.stepId}' was turned off by input '${outcome.input}'`;
    default: {
      const exhaustive: never = outcome;
      return `step outcome ${JSON.stringify(exhaustive)}`;
    }
  }
}

/** Keep demonstration values scoped to the input contract of the exact plan being replayed. */
function inputsDeclaredByPlan(
  plan: RecordedWorkflow,
  supplied: Record<string, WorkflowJsonValue>,
): Record<string, WorkflowJsonValue> {
  const projected: Record<string, WorkflowJsonValue> = Object.create(null);
  for (const input of plan.inputs) {
    if (Object.hasOwn(supplied, input.name)) projected[input.name] = supplied[input.name]!;
  }
  return projected;
}

async function replayStep(
  plan: RecordedWorkflow,
  stepId: string,
  observed: WorkflowJsonValue,
  environment: CandidateValidationEnvironment,
  maskingPlan: RecordedWorkflow,
): Promise<StepReplay> {
  const replayed = replayedPlan(plan);
  const options: RecordedWorkflowExecutionOptions = {
    inputs: inputsDeclaredByPlan(replayed, environment.inputs),
    adapters: environment.adapters,
    ...(environment.workspaceId ? { access: { workspaceId: environment.workspaceId } } : {}),
    ...(environment.resolvePrivate ? { resolvePrivate: environment.resolvePrivate } : {}),
  };
  const execution = await withDeadline(
    (signal) => executeRecordedWorkflow(replayed, { ...options, signal }),
    environment.timeoutMs,
  );
  if (!execution) {
    return {
      reproduced: false,
      detail: `the replay exceeded its ${environment.timeoutMs}ms bound`,
    };
  }
  const outcome = execution.steps.find((entry) => entry.stepId === stepId);
  if (!outcome) return { reproduced: false, detail: `step '${stepId}' never ran` };
  if (outcome.status !== "completed") {
    return { reproduced: false, detail: describeOutcome(execution, outcome) };
  }
  const masks = await extractMasks(maskingPlan, execution, environment);
  const reproduced = matchesObservedResult(
    maskValue(outcome.result, masks, "replayed"),
    maskValue(observed, masks, "recorded"),
    environment.observedComparisons?.[stepId],
  );
  return {
    reproduced,
    detail: reproduced
      ? `step '${stepId}' reproduced the observed result`
      : describeOutcome(execution, outcome),
  };
}

function refused(candidate: WorkflowBindingCandidate, reason: string): CandidateValidationOutcome {
  return { candidate, accepted: false, reason };
}

async function evaluateCandidate(
  plan: RecordedWorkflow,
  candidate: WorkflowBindingCandidate,
  candidates: readonly WorkflowBindingCandidate[],
  environment: CandidateValidationEnvironment,
): Promise<CandidateValidationOutcome> {
  const evidence = `${candidate.stepId}.${candidate.argument}${pathText(candidate.path)}`;
  try {
    if (!Object.hasOwn(environment.observed, candidate.stepId)) {
      return refused(
        candidate,
        `the held-out demonstration observed no result for step '${candidate.stepId}', so the candidate cannot be checked against it`,
      );
    }
    const observed: WorkflowJsonValue | undefined = environment.observed[candidate.stepId];
    if (observed === undefined) {
      return refused(
        candidate,
        `the held-out demonstration recorded no usable value for step '${candidate.stepId}'`,
      );
    }
    const plans = buildCandidatePlans(plan, candidate, candidates, environment);
    if (plans.kind === "refused") return refused(candidate, plans.reason);
    // Two runs. The adapters must be stateless, or the caller must hand in a registry whose
    // adapters hold no per-run state: a registry that remembered the first run would decide the
    // second one for it.
    // Both runs mask the printed values the bound plan extracts, so they are compared alike.
    const bound = await replayStep(
      plans.bound,
      candidate.stepId,
      observed,
      environment,
      plans.bound,
    );
    const literal = await replayStep(
      plans.literal,
      candidate.stepId,
      observed,
      environment,
      plans.bound,
    );
    if (bound.reproduced && !literal.reproduced) {
      return {
        candidate,
        accepted: true,
        reason: `the bound plan reproduced the held-out result for ${evidence} and the recorded value did not (${literal.detail})`,
      };
    }
    if (bound.reproduced) {
      return refused(
        candidate,
        `the bound plan and the plan with this candidate reverted both reproduced the held-out result for ${evidence}, so the observation does not establish the dependency it proposes (missing: ${candidate.missing})`,
      );
    }
    if (literal.reproduced) {
      return refused(
        candidate,
        `the plan with this candidate reverted already reproduces the held-out result for ${evidence} and the bound plan does not (${bound.detail})`,
      );
    }
    return refused(
      candidate,
      `neither the bound plan nor the plan with this candidate reverted reproduced the held-out result for ${evidence}: ${bound.detail}; ${literal.detail}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(candidate, `the replay could not be completed: ${message}`);
  }
}

/**
 * The value a replay must bind for a token candidate: the token's own value, read out of the
 * whole-argument value the demonstration used, in the language the recorded step names.
 *
 * Undefined when the record cannot say where that token is — the plan has no such step, the step's
 * record names no program for that argument, the demonstration's value is not text, or the index is
 * outside it. The candidate is then left without a value and refused for exactly that reason,
 * rather than bound to a guess.
 */
async function demonstratedTokenValue(
  plan: RecordedWorkflow,
  candidate: WorkflowBindingCandidate,
  supplied: WorkflowJsonValue,
  resolve: (reference: string) => Promise<WorkflowJsonValue>,
): Promise<ProgramTokenValue | undefined> {
  const address = programTokenPath(candidate.path);
  if (address === undefined) return undefined;
  const step = plan.steps.find((entry) => entry.id === candidate.stepId);
  const program = step?.callable.program;
  if (program === undefined || program.argument !== candidate.argument) return undefined;
  if (typeof supplied !== "string") return undefined;
  if (address.span === undefined) return programTokenValueAt(program.kind, supplied, address);
  // A span is read against the recorded token: the demonstration decides it only when it keeps
  // the recorded text around the span.
  const argument = step?.arguments.find((entry) => entry.name === candidate.argument);
  const recorded =
    argument === undefined ? undefined : await recordedProgramText(argument.source, resolve);
  if (typeof recorded !== "string") return undefined;
  return demonstratedProgramTokenSpanValue(program.kind, recorded, supplied, address);
}

/** The recorded program text an argument holds, resolving private text locally. */
async function recordedProgramText(
  source: WorkflowValueSource | WorkflowValueTemplate,
  resolve: (reference: string) => Promise<WorkflowJsonValue>,
): Promise<WorkflowJsonValue | undefined> {
  if ("kind" in source) {
    if (source.kind === "literal") return source.value;
    if (source.kind === "private") return resolve(source.reference);
    if (source.kind === "template") return recordedProgramText(source.template, resolve);
    return undefined;
  }
  if (source.type === "literal") return source.value;
  if (source.type === "private") return resolve(source.reference);
  if (source.type === "program") {
    return source.sourceReference === undefined
      ? recordedProgramText(source.source, resolve)
      : resolve(source.sourceReference);
  }
  return undefined;
}

/**
 * The replay environment a recording's own demonstration supplies.
 *
 * An ordinary session repeats itself, and the capture keeps that repeat as a demonstration on the
 * plan. It is what makes a candidate decidable without anyone handing in inputs or expectations:
 * the inputs are the values the repeat actually used at the positions candidates propose, and the
 * observations are what the repeat actually produced. Both are resolved locally, because both are
 * the user's own work, so the values never have to leave the machine the work was performed on.
 *
 * Returns undefined when the recording offers no demonstration, which leaves every candidate a
 * proposal — reported, never frozen into a binding.
 */
/** Selects an own JSON leaf; malformed paths never silently collapse to the whole argument. */
function demonstratedValueAtPath(
  supplied: WorkflowJsonValue,
  path: WorkflowValuePath,
): WorkflowJsonValue | undefined {
  let value: WorkflowJsonValue = supplied;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Number.isInteger(part) || part < 0 || !Array.isArray(value) || part >= value.length) {
        return undefined;
      }
      value = value[part]!;
    } else {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.hasOwn(value, part)
      ) {
        return undefined;
      }
      value = value[part]!;
    }
  }
  return value;
}

/** The proposed input's recorded type must agree with the demonstration, without coercion. */
function matchesDemonstratedType(
  value: WorkflowJsonValue,
  type: "string" | "number" | "boolean" | "object" | "array",
): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

export async function demonstrationEnvironment(params: {
  plan: RecordedWorkflow;
  /** The demonstration to read; defaults to the held-out repeat. */
  demonstration?: DemonstrationLabel;
  candidates: readonly WorkflowBindingCandidate[];
  adapters: DemonstrationAdapters;
  workspaceId?: string;
  resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  timeoutMs?: number;
}): Promise<CandidateValidationEnvironment | undefined> {
  const label = params.demonstration ?? "held-out";
  const demonstration = label === "baseline" ? params.plan.baseline : params.plan.heldOut;
  if (demonstration === undefined) return undefined;
  const resolve = params.resolvePrivate;
  if (resolve === undefined) return undefined;
  const adapters = params.adapters(label);
  if (adapters === undefined) return undefined;
  const inputs: Record<string, WorkflowJsonValue> = Object.create(null);
  const conflictingInputs = new Set<string>();
  const values = new Map<string, Promise<WorkflowJsonValue>>();
  const resolveOnce = (reference: string): Promise<WorkflowJsonValue> => {
    let value = values.get(reference);
    if (value === undefined) {
      value = Promise.resolve().then(() => resolve(reference));
      values.set(reference, value);
    }
    return value;
  };
  for (const entry of demonstration.inputs) {
    const step = params.plan.steps.find((candidate) => candidate.id === entry.stepId);
    const argument = step?.arguments.find((candidate) => candidate.name === entry.argument);
    if (step === undefined || argument === undefined) return undefined;
    const supplied = await resolveOnce(entry.reference);
    const bindInput = (name: string, path: WorkflowValuePath): boolean => {
      const input = params.plan.inputs.find((candidate) => candidate.name === name);
      if (input === undefined) return false;
      const value = demonstratedValueAtPath(supplied, path);
      if (value === undefined || !matchesDemonstratedType(value, input.type)) return false;
      if (Object.hasOwn(inputs, name) && !deepEqual(inputs[name], value)) return false;
      inputs[name] = value;
      return true;
    };
    const bindTemplate = (template: WorkflowValueTemplate, path: WorkflowValuePath): boolean => {
      switch (template.type) {
        case "input":
          return bindInput(template.name, path);
        case "object":
          return Object.entries(template.entries).every(([key, child]) =>
            bindTemplate(child, [...path, key]),
          );
        case "array":
          return template.items.every((child, index) => bindTemplate(child, [...path, index]));
        default:
          // Program holes are token positions, not JSON paths. Their candidate-specific
          // derivation below remains authoritative; no guessed token extraction here.
          return true;
      }
    };
    const source = argument.source;
    if (source.kind === "input" && !bindInput(source.name, [])) return undefined;
    if (source.kind === "template" && !bindTemplate(source.template, [])) return undefined;
  }
  for (const candidate of params.candidates) {
    if (candidate.proposed.kind !== "input") continue;
    const entry = demonstration.inputs.find(
      (supplied) =>
        supplied.stepId === candidate.stepId && supplied.argument === candidate.argument,
    );
    if (entry === undefined) continue;
    // A token candidate is about one position of the program the argument's text holds, so the
    // value the replay must bind is the token's own value — read out of the text the repeat
    // actually ran, not out of the recorded text the candidate is proposed against.
    const supplied = await resolveOnce(entry.reference);
    const value =
      candidate.path[0] === "tokens"
        ? await demonstratedTokenValue(params.plan, candidate, supplied, resolveOnce)
        : demonstratedValueAtPath(supplied, candidate.path);
    const name = candidate.proposed.name;
    if (
      value === undefined ||
      !matchesDemonstratedType(value, candidate.proposed.type) ||
      conflictingInputs.has(name)
    ) {
      continue;
    }
    if (Object.hasOwn(inputs, name) && !deepEqual(inputs[name], value)) {
      // One input cannot simultaneously represent two different caller values. Removing the
      // ambiguous value leaves the proposals unestablished instead of choosing the last writer.
      delete inputs[name];
      conflictingInputs.add(name);
      continue;
    }
    inputs[name] = value;
  }
  const observed: Record<string, WorkflowJsonValue> = {};
  const observedComparisons: Record<string, WorkflowObservedComparison> = {};
  for (const entry of demonstration.observed) {
    observed[entry.stepId] = await resolveOnce(entry.reference);
    if (entry.comparison !== undefined) {
      observedComparisons[entry.stepId] = entry.comparison;
    }
  }
  return {
    adapters,
    adaptersFor: params.adapters,
    workspaceId: params.workspaceId,
    inputs,
    observed,
    ...(Object.keys(observedComparisons).length === 0 ? {} : { observedComparisons }),
    resolvePrivate: resolve,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  };
}

/** Whether a step is a model-written derivation rather than a recorded call. */
export function isDerivationStep(step: WorkflowStep): boolean {
  return step.origin === "derivation";
}

/** The derivation step a candidate reads, when it proposes one's output. */
function derivationProducer(
  plan: RecordedWorkflow,
  candidate: WorkflowBindingCandidate,
): WorkflowStep | undefined {
  const proposed = candidate.proposed;
  if (proposed.kind !== "result") return undefined;
  const producer = plan.steps.find((step) => step.id === proposed.stepId);
  return producer !== undefined && isDerivationStep(producer) ? producer : undefined;
}

/** Every step id a template or source reads a result or printed value from. */
function collectReadSteps(
  source: WorkflowValueSource | WorkflowValueTemplate,
  into: Set<string>,
): void {
  if ("kind" in source) {
    if (source.kind === "result") into.add(source.stepId);
    if (source.kind === "template") collectReadSteps(source.template, into);
    return;
  }
  switch (source.type) {
    case "result":
    case "extract":
      into.add(source.stepId);
      return;
    case "object":
      for (const entry of Object.values(source.entries)) collectReadSteps(entry, into);
      return;
    case "array":
      for (const entry of source.items) collectReadSteps(entry, into);
      return;
    case "program":
      collectReadSteps(source.source, into);
      for (const hole of source.holes) collectReadSteps(hole.binding, into);
      return;
    default:
      return;
  }
}

/**
 * Removes derivation steps nothing reads, with the proposals that named them. A derivation exists
 * only to feed an accepted binding; one whose bindings were all refuted must not run model-written
 * code for nothing. A plan without derivation steps is returned unchanged.
 */
export function pruneUnusedDerivations(plan: RecordedWorkflow): RecordedWorkflow {
  if (!plan.steps.some(isDerivationStep)) return plan;
  const read = new Set<string>();
  for (const step of plan.steps) {
    for (const argument of step.arguments) collectReadSteps(argument.source, read);
  }
  const removed = new Set(
    plan.steps.filter((step) => isDerivationStep(step) && !read.has(step.id)).map((s) => s.id),
  );
  if (removed.size === 0) return plan;
  const candidates = plan.candidates?.filter(
    (candidate) =>
      !removed.has(candidate.stepId) &&
      !(
        (candidate.proposed.kind === "result" || candidate.proposed.kind === "extract") &&
        removed.has(candidate.proposed.stepId)
      ),
  );
  return {
    ...plan,
    steps: plan.steps.filter((step) => !removed.has(step.id)),
    ...(candidates === undefined ? {} : { candidates }),
  };
}

/** Every input name a template or source reads. */
function collectReadInputs(
  source: WorkflowValueSource | WorkflowValueTemplate,
  into: Set<string>,
): void {
  if ("kind" in source) {
    if (source.kind === "input") into.add(source.name);
    if (source.kind === "template") collectReadInputs(source.template, into);
    return;
  }
  switch (source.type) {
    case "input":
      into.add(source.name);
      return;
    case "object":
      for (const entry of Object.values(source.entries)) collectReadInputs(entry, into);
      return;
    case "array":
      for (const entry of source.items) collectReadInputs(entry, into);
      return;
    case "program":
      collectReadInputs(source.source, into);
      for (const hole of source.holes) collectReadInputs(hole.binding, into);
      return;
    default:
      return;
  }
}

/**
 * The plan a validation replay runs: derivations no binding reads are left out (a refuted or
 * undecided derivation must neither run nor fail the replay), and so are inputs only they read,
 * which nothing in the replay needs. The validated plan itself is unchanged.
 */
function replayedPlan(plan: RecordedWorkflow): RecordedWorkflow {
  const pruned = pruneUnusedDerivations(plan);
  if (pruned === plan) return plan;
  const kept = new Set<string>();
  for (const step of pruned.steps) {
    for (const argument of step.arguments) collectReadInputs(argument.source, kept);
    if (step.optional !== undefined) kept.add(step.optional.input);
  }
  const removedReads = new Set<string>();
  for (const step of plan.steps) {
    if (pruned.steps.includes(step)) continue;
    for (const argument of step.arguments) collectReadInputs(argument.source, removedReads);
  }
  return {
    ...pruned,
    inputs: pruned.inputs.filter((input) => kept.has(input.name) || !removedReads.has(input.name)),
  };
}

/** The input names a derivation step's holes read. */
function derivationInputNames(step: WorkflowStep): string[] | undefined {
  const template = derivationTemplate(step);
  if (template === undefined) return undefined;
  const names = new Set<string>();
  for (const hole of template.holes) {
    if (hole.binding.type !== "input") return undefined;
    names.add(hole.binding.name);
  }
  return [...names];
}

/** The literal program template a derivation carries its model-written source in. */
function derivationTemplate(
  step: WorkflowStep,
): (WorkflowValueTemplate & { type: "program" }) | undefined {
  const argumentName = step.callable.program?.argument;
  const source = step.arguments.find((argument) => argument.name === argumentName)?.source;
  if (source?.kind !== "template" || source.template.type !== "program") return undefined;
  const template = source.template;
  if (template.source.type !== "literal" || typeof template.source.value !== "string") {
    return undefined;
  }
  return template;
}

/** Which demonstration an environment replays: the held-out run when there is one. */
interface DemonstrationContext {
  label: DemonstrationLabel;
  demonstration: NonNullable<RecordedWorkflow["heldOut"]>;
  environment: CandidateValidationEnvironment;
}

/**
 * The recorded program text a token address is read against in one demonstration: the text that
 * demonstration ran for the step's argument, or — for the baseline, which is the recording itself —
 * the plan's own recorded text when the demonstration keeps no copy of it.
 */
async function demonstratedProgramText(
  plan: RecordedWorkflow,
  context: DemonstrationContext,
  stepId: string,
  argumentName: string,
  resolve: (reference: string) => Promise<WorkflowJsonValue>,
): Promise<string | undefined> {
  const entry = context.demonstration.inputs.find(
    (supplied) => supplied.stepId === stepId && supplied.argument === argumentName,
  );
  if (entry !== undefined) {
    const supplied = await resolve(entry.reference);
    return typeof supplied === "string" ? supplied : undefined;
  }
  if (context.label !== "baseline") return undefined;
  const argument = plan.steps
    .find((step) => step.id === stepId)
    ?.arguments.find((each) => each.name === argumentName);
  if (argument === undefined) return undefined;
  const recorded = await recordedProgramText(argument.source, resolve);
  return typeof recorded === "string" ? recorded : undefined;
}

/** The value a token address reads in one demonstration's program text. */
async function demonstratedTokenAt(
  plan: RecordedWorkflow,
  context: DemonstrationContext,
  target: { stepId: string; argument: string; path: WorkflowValuePath },
  resolve: (reference: string) => Promise<WorkflowJsonValue>,
): Promise<{ text: string; value: ProgramTokenValue } | undefined> {
  const address = programTokenPath(target.path);
  const step = plan.steps.find((entry) => entry.id === target.stepId);
  const program = step?.callable.program;
  if (address === undefined || program === undefined || program.argument !== target.argument) {
    return undefined;
  }
  const text = await demonstratedProgramText(
    plan,
    context,
    target.stepId,
    target.argument,
    resolve,
  );
  if (text === undefined) return undefined;
  let value: ProgramTokenValue | undefined;
  if (address.span === undefined || context.label === "baseline") {
    value = programTokenValueAt(program.kind, text, address);
  } else {
    const argument = step?.arguments.find((entry) => entry.name === target.argument);
    const recorded =
      argument === undefined ? undefined : await recordedProgramText(argument.source, resolve);
    value =
      typeof recorded === "string"
        ? demonstratedProgramTokenSpanValue(program.kind, recorded, text, address)
        : undefined;
  }
  return value === undefined ? undefined : { text, value };
}

/**
 * The demonstration's values for inputs a derivation reads that the environment does not supply.
 *
 * A derivation's input usually also appears as a token of a recorded program — bound there by an
 * existing hole or proposed by an input candidate — so the demonstration's own text says what the
 * caller supplied. Values that disagree establish nothing and are left out, which later refutes
 * the derivation instead of running it on a guess.
 */
async function withDerivationInputs(
  plan: RecordedWorkflow,
  candidates: readonly WorkflowBindingCandidate[],
  context: DemonstrationContext,
): Promise<CandidateValidationEnvironment> {
  const environment = context.environment;
  const resolvePrivate = environment.resolvePrivate;
  if (resolvePrivate === undefined) return environment;
  const resolve = async (reference: string): Promise<WorkflowJsonValue> =>
    await resolvePrivate(reference);
  const wanted = new Set<string>();
  for (const step of plan.steps) {
    if (!isDerivationStep(step)) continue;
    for (const name of derivationInputNames(step) ?? []) {
      if (!Object.hasOwn(environment.inputs, name)) wanted.add(name);
    }
  }
  if (wanted.size === 0) return environment;
  const positions: Array<{
    name: string;
    stepId: string;
    argument: string;
    path: WorkflowValuePath;
  }> = [];
  // Reading a position the plan knows never promotes it: plan candidates still undecided count too.
  for (const candidate of [...candidates, ...(plan.candidates ?? [])]) {
    if (candidate.proposed.kind === "input" && candidate.path[0] === "tokens") {
      positions.push({
        name: candidate.proposed.name,
        stepId: candidate.stepId,
        argument: candidate.argument,
        path: candidate.path,
      });
    }
  }
  for (const step of plan.steps) {
    if (isDerivationStep(step)) continue;
    for (const argument of step.arguments) {
      if (argument.source.kind !== "template" || argument.source.template.type !== "program") {
        continue;
      }
      for (const hole of argument.source.template.holes) {
        // Span holes bind part of a token; the caller's whole value is not readable from them.
        if (hole.binding.type !== "input" || hole.span !== undefined) continue;
        positions.push({
          name: hole.binding.name,
          stepId: step.id,
          argument: argument.name,
          path:
            hole.embedded === undefined
              ? ["tokens", hole.token]
              : ["tokens", hole.token, "embedded", hole.embedded],
        });
      }
    }
  }
  const found = new Map<string, WorkflowJsonValue>();
  const conflicting = new Set<string>();
  for (const position of positions) {
    if (!wanted.has(position.name)) continue;
    const read = await demonstratedTokenAt(plan, context, position, resolve);
    const declared = plan.inputs.find((input) => input.name === position.name);
    if (
      read === undefined ||
      declared === undefined ||
      !matchesDemonstratedType(read.value, declared.type)
    ) {
      continue;
    }
    const previous = found.get(position.name);
    if (previous === undefined) found.set(position.name, read.value);
    else if (!deepEqual(previous, read.value)) conflicting.add(position.name);
  }
  const inputs: Record<string, WorkflowJsonValue> = Object.create(null);
  Object.assign(inputs, environment.inputs);
  for (const [name, value] of found) {
    if (!conflicting.has(name)) inputs[name] = value;
  }
  return { ...environment, inputs };
}

/** A string or number literal of model-written source equals a recorded value. */
function literalMatchesRecorded(literal: ProgramTokenValue, recorded: ProgramTokenValue): boolean {
  if (literal === recorded) return true;
  const numeric = (value: ProgramTokenValue): number | undefined => {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const left = numeric(literal);
  const right = numeric(recorded);
  return left !== undefined && right !== undefined && left === right;
}

/**
 * Whether a derived value reproduces a recorded token exactly: the same value (strings equal,
 * numbers equal numerically), and binding it into the recorded text renders that text unchanged.
 */
function derivedValueReproduces(
  language: ProgramLanguage,
  text: string,
  address: ProgramTokenAddress,
  derived: WorkflowJsonValue | undefined,
  recorded: ProgramTokenValue,
): boolean {
  if (derived === undefined || (derived !== null && typeof derived === "object")) return false;
  const sameValue =
    derived === recorded ||
    (typeof derived === "number" &&
      (typeof recorded === "number" || typeof recorded === "string") &&
      recorded !== "" &&
      Number(recorded) === derived);
  if (!sameValue) return false;
  try {
    const tokens = tokenizeProgram(language, text);
    const values = new Map<number, ProgramTokenValue>();
    const embedded = new Map<number, Map<number, ProgramTokenValue>>();
    const spans: ProgramTokenSpanValue[] = [];
    if (address.span !== undefined) {
      if (typeof derived !== "string" && typeof derived !== "number") return false;
      spans.push({
        token: address.token,
        ...(address.embedded === undefined ? {} : { embedded: address.embedded }),
        span: address.span,
        value: derived,
      });
    } else if (address.embedded === undefined) {
      values.set(address.token, derived);
    } else {
      embedded.set(address.token, new Map([[address.embedded, derived]]));
    }
    return applyProgramTokenValues(text, tokens, values, language, embedded, spans) === text;
  } catch {
    return false;
  }
}

/**
 * Decides candidates that bind recorded tokens to a derivation's output, without A/B replay.
 *
 * A derivation is model-written code, so it is held to more than reproducing the work: it must read
 * a caller input, must not contain any recorded value its bindings claim to compute (hard-coding),
 * and — run in the sandbox on each demonstration, before anything consumes it — must compute
 * exactly the token each demonstration ran. A candidate is accepted only when every one of those
 * holds for its step and its own value; the plan that carries it is then replayed as usual.
 */
async function evaluateDerivationCandidates(
  plan: RecordedWorkflow,
  derivationCandidates: readonly WorkflowBindingCandidate[],
  candidates: readonly WorkflowBindingCandidate[],
  environment: CandidateValidationEnvironment,
): Promise<Map<WorkflowBindingCandidate, CandidateValidationOutcome>> {
  const outcomes = new Map<WorkflowBindingCandidate, CandidateValidationOutcome>();
  const refuteAll = (group: readonly WorkflowBindingCandidate[], reason: string): void => {
    for (const candidate of group) {
      if (!outcomes.has(candidate)) outcomes.set(candidate, refused(candidate, reason));
    }
  };
  const resolvePrivate = environment.resolvePrivate;
  if (resolvePrivate === undefined) {
    refuteAll(derivationCandidates, "the replay cannot resolve the recorded program text");
    return outcomes;
  }
  const resolve = async (reference: string): Promise<WorkflowJsonValue> =>
    await resolvePrivate(reference);
  // The environment replays the held-out run when there is one, else the baseline recording.
  const contexts: DemonstrationContext[] = [];
  if (plan.heldOut !== undefined) {
    contexts.push({ label: "held-out", demonstration: plan.heldOut, environment });
    if (plan.baseline !== undefined) {
      const baseline = await demonstrationEnvironment({
        plan,
        demonstration: "baseline",
        candidates,
        adapters: environment.adaptersFor ?? (() => environment.adapters),
        ...(environment.workspaceId === undefined ? {} : { workspaceId: environment.workspaceId }),
        resolvePrivate,
        ...(environment.timeoutMs === undefined ? {} : { timeoutMs: environment.timeoutMs }),
      });
      if (baseline === undefined) {
        refuteAll(
          derivationCandidates,
          "the baseline recording could not be replayed to check the derivation against",
        );
        return outcomes;
      }
      contexts.push({ label: "baseline", demonstration: plan.baseline, environment: baseline });
    }
  } else if (plan.baseline !== undefined) {
    contexts.push({ label: "baseline", demonstration: plan.baseline, environment });
  }
  if (contexts.length === 0) {
    refuteAll(
      derivationCandidates,
      "the recording offers no demonstration to check the derivation",
    );
    return outcomes;
  }
  for (const context of contexts) {
    context.environment = await withDerivationInputs(plan, candidates, context);
  }
  const groups = new Map<WorkflowStep, WorkflowBindingCandidate[]>();
  for (const candidate of derivationCandidates) {
    const producer = derivationProducer(plan, candidate);
    if (producer === undefined) continue;
    groups.set(producer, [...(groups.get(producer) ?? []), candidate]);
  }
  for (const [derivation, group] of groups) {
    try {
      const template = derivationTemplate(derivation);
      const inputNames = derivationInputNames(derivation);
      // (c) A derivation that reads no caller input computes a constant: it is refuted outright.
      if (template === undefined || inputNames === undefined || inputNames.length === 0) {
        refuteAll(group, `derivation '${derivation.id}' reads no caller input`);
        continue;
      }
      const source = template.source.type === "literal" ? template.source.value : undefined;
      if (typeof source !== "string") {
        refuteAll(group, `derivation '${derivation.id}' carries no literal source`);
        continue;
      }
      // Recorded values the bindings claim to compute, in every demonstration.
      const expected = new Map<
        WorkflowBindingCandidate,
        Array<{ context: DemonstrationContext; text: string; value: ProgramTokenValue }>
      >();
      for (const candidate of group) {
        const reads: Array<{
          context: DemonstrationContext;
          text: string;
          value: ProgramTokenValue;
        }> = [];
        for (const context of contexts) {
          const read = await demonstratedTokenAt(plan, context, candidate, resolve);
          if (read === undefined) break;
          reads.push({ context, ...read });
        }
        if (reads.length === contexts.length) expected.set(candidate, reads);
      }
      // (a) No hard-coding: a string or number literal the model wrote (outside the input holes)
      // that equals a value any binding of this step claims to compute refutes the whole step.
      const holeTokens = new Set(template.holes.map((hole) => hole.token));
      const literals = tokenizeProgram("python", source).flatMap((token, index) =>
        !holeTokens.has(index) &&
        (token.kind === "string" || token.kind === "number") &&
        token.value !== undefined
          ? [token.value]
          : [],
      );
      const recordedValues = [...expected.values()].flatMap((reads) =>
        reads.map((read) => read.value),
      );
      if (
        literals.some((literal) =>
          recordedValues.some((recorded) => literalMatchesRecorded(literal, recorded)),
        )
      ) {
        refuteAll(group, `derivation '${derivation.id}' hard-codes a recorded value`);
        continue;
      }
      for (const candidate of group) {
        if (!expected.has(candidate)) {
          outcomes.set(
            candidate,
            refused(
              candidate,
              "a demonstration does not show the recorded token this candidate claims to derive",
            ),
          );
        }
      }
      // (b) Reproduction: run the derivation (after the recorded steps before it) on each
      // demonstration, and compare each derived value with the token that demonstration ran.
      const index = plan.steps.indexOf(derivation);
      const prefix: RecordedWorkflow = {
        ...plan,
        steps: plan.steps
          .slice(0, index + 1)
          .filter((step) => step === derivation || !isDerivationStep(step)),
      };
      for (const context of contexts) {
        const pending = group.filter((candidate) => !outcomes.has(candidate));
        if (pending.length === 0) break;
        const missing = inputNames.find((name) => !Object.hasOwn(context.environment.inputs, name));
        if (missing !== undefined) {
          refuteAll(
            pending,
            `the ${context.label} demonstration does not establish input '${missing}' the derivation reads`,
          );
          break;
        }
        const replay = context.environment;
        const execution = await withDeadline(
          (signal) =>
            executeRecordedWorkflow(prefix, {
              inputs: inputsDeclaredByPlan(prefix, replay.inputs),
              adapters: replay.adapters,
              ...(replay.workspaceId ? { access: { workspaceId: replay.workspaceId } } : {}),
              resolvePrivate: resolvePrivate,
              signal,
            }),
          replay.timeoutMs,
        );
        const outcome = execution?.steps.find((entry) => entry.stepId === derivation.id);
        if (outcome === undefined || outcome.status !== "completed") {
          refuteAll(
            pending,
            execution === undefined
              ? `the derivation replay exceeded its ${replay.timeoutMs}ms bound`
              : outcome === undefined
                ? `derivation '${derivation.id}' never ran`
                : describeOutcome(execution, outcome),
          );
          break;
        }
        for (const candidate of pending) {
          const read = expected.get(candidate)!.find((entry) => entry.context === context)!;
          const address = programTokenPath(candidate.path)!;
          const program = plan.steps.find((step) => step.id === candidate.stepId)!.callable
            .program!;
          if (candidate.proposed.kind !== "result") continue;
          const derived = demonstratedValueAtPath(outcome.result, candidate.proposed.path);
          if (!derivedValueReproduces(program.kind, read.text, address, derived, read.value)) {
            outcomes.set(
              candidate,
              refused(
                candidate,
                `derivation '${derivation.id}' did not compute the token the ${context.label} demonstration ran for ${candidate.stepId}.${candidate.argument}${pathText(candidate.path)}`,
              ),
            );
          }
        }
      }
      for (const candidate of group) {
        if (!outcomes.has(candidate)) {
          outcomes.set(candidate, {
            candidate,
            accepted: true,
            reason: `derivation '${derivation.id}' reads caller inputs, hard-codes no recorded value, and computed the recorded token for ${candidate.stepId}.${candidate.argument}${pathText(candidate.path)} on every demonstration`,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refuteAll(group, `the derivation could not be checked: ${message}`);
    }
  }
  refuteAll(derivationCandidates, "the candidate does not read a derivation step");
  return outcomes;
}

/**
 * Replays a plan ONCE and reports which of its observed steps it reproduced.
 *
 * The plan runs a single time per attempt. The work is a sequence — a later step reads what an
 * earlier one produced — so running it once per step would both multiply the cost and compare
 * traces that never existed: step 3 of a second run follows a first run's side effects, not the
 * recorded execution's. One run: recorded programs reproduce by completing, every other observed
 * step by matching that one trace.
 */
async function replayPlanOnce(
  validated: RecordedWorkflow,
  environment: CandidateValidationEnvironment,
): Promise<{
  reproduced: string[];
  missed: Array<{ stepId: string; detail: string }>;
}> {
  const plan = replayedPlan(validated);
  const options: RecordedWorkflowExecutionOptions = {
    inputs: inputsDeclaredByPlan(plan, environment.inputs),
    adapters: environment.adapters,
    ...(environment.workspaceId ? { access: { workspaceId: environment.workspaceId } } : {}),
    ...(environment.resolvePrivate ? { resolvePrivate: environment.resolvePrivate } : {}),
  };
  const execution = await withDeadline(
    (signal) => executeRecordedWorkflow(plan, { ...options, signal }),
    environment.timeoutMs,
  );
  const reproduced: string[] = [];
  const missed: Array<{ stepId: string; detail: string }> = [];
  const masks = execution === undefined ? [] : await extractMasks(plan, execution, environment);
  for (const step of plan.steps) {
    const stepId = step.id;
    // A derivation was never observed: it is verified by the recorded steps that consume it, and
    // here only by running to completion.
    if (isDerivationStep(step)) {
      const outcome = execution?.steps.find((entry) => entry.stepId === stepId);
      if (outcome?.status === "completed") reproduced.push(stepId);
      else {
        missed.push({
          stepId,
          detail:
            execution === undefined
              ? `the replay exceeded its ${environment.timeoutMs}ms bound`
              : outcome === undefined
                ? `step '${stepId}' never ran`
                : describeOutcome(execution, outcome),
        });
      }
      continue;
    }
    if (!Object.hasOwn(environment.observed, stepId)) {
      missed.push({
        stepId,
        detail: `the demonstration did not observe step '${stepId}', so the whole plan is unverified`,
      });
      continue;
    }
    const observed = environment.observed[stepId];
    if (execution === undefined) {
      missed.push({
        stepId,
        detail: `the replay exceeded its ${environment.timeoutMs}ms bound`,
      });
      continue;
    }
    const outcome = execution.steps.find((entry) => entry.stepId === stepId);
    if (outcome === undefined) {
      missed.push({ stepId, detail: `step '${stepId}' never ran` });
      continue;
    }
    if (outcome.status !== "completed") {
      missed.push({ stepId, detail: describeOutcome(execution, outcome) });
      continue;
    }
    if (
      matchesObservedResult(
        maskValue(outcome.result, masks, "replayed"),
        maskValue(observed, masks, "recorded"),
        environment.observedComparisons?.[stepId],
      )
    ) {
      reproduced.push(stepId);
    } else missed.push({ stepId, detail: describeOutcome(execution, outcome) });
  }
  return { reproduced, missed };
}

/**
 * Confirms the plan that results from applying accepted proposals, and drops what the combined plan
 * cannot carry.
 *
 * Deciding proposals one at a time is not enough: a plan that accepts some of them can still run on
 * a stale intermediate value, because the value it reads was produced by a step whose own proposal
 * was refused. So the combined plan is replayed as a whole — once per attempt — and when it does not
 * reproduce what the demonstration observed, the proposal that decided the earliest step the replay
 * missed is dropped and the rest are tried again. The loop is bounded, so it always terminates, and
 * it never promotes anything the demonstration does not support.
 *
 * The outcome is reported as it stands, including when it is not a pass: a proposal can be valid and
 * the plan it belongs to still unproven, and calling that verified would be a claim nothing made.
 */
export async function confirmPromotedPlan(params: {
  plan: RecordedWorkflow;
  accepted: readonly WorkflowBindingCandidate[];
  environment: CandidateValidationEnvironment;
  /** How many proposals may be withdrawn before the plan is called unestablished. */
  maxRounds?: number;
}): Promise<{
  accepted: WorkflowBindingCandidate[];
  dropped: Array<{ candidate: WorkflowBindingCandidate; reason: string }>;
  plan: RecordedWorkflow;
  verification: WorkflowPlanVerification;
}> {
  const rounds = params.maxRounds ?? Math.max(1, params.accepted.length);
  let accepted = [...params.accepted];
  const dropped: Array<{
    candidate: WorkflowBindingCandidate;
    reason: string;
  }> = [];
  let plan = pruneUnusedDerivations(applyAcceptedBindings(params.plan, accepted));
  let replay = await replayPlanOnce(plan, params.environment);
  const unobserved = (stepId: string): boolean =>
    !Object.hasOwn(params.environment.observed, stepId) &&
    !params.plan.steps.some((step) => step.id === stepId && isDerivationStep(step));
  // True when the replay missed a step no accepted proposal decided, so nothing withdrawn here
  // could change it. That is a limit of the demonstration, not evidence against the proposals.
  let unattributed = false;
  for (let round = 0; round < rounds && replay.missed.length > 0; round += 1) {
    const missedStepId = replay.missed[0]!.stepId;
    if (unobserved(missedStepId)) {
      unattributed = true;
      break;
    }
    const blamed =
      accepted.find((candidate) => candidate.stepId === missedStepId) ??
      accepted.find(
        (candidate) =>
          (candidate.proposed.kind === "result" || candidate.proposed.kind === "extract") &&
          candidate.proposed.stepId === missedStepId,
      );
    if (blamed === undefined) {
      unattributed = true;
      break;
    }
    accepted = accepted.filter((candidate) => candidate !== blamed);
    dropped.push({
      candidate: blamed,
      reason: `the plan that would have been published did not reproduce step '${missedStepId}' of the demonstration (${replay.missed[0]!.detail}), so this proposal was withdrawn with it`,
    });
    plan = pruneUnusedDerivations(applyAcceptedBindings(params.plan, accepted));
    replay = await replayPlanOnce(plan, params.environment);
  }
  const missingObservation = replay.missed.some(({ stepId }) => unobserved(stepId));
  const verification: WorkflowPlanVerification = {
    status:
      replay.missed.length === 0
        ? "verified"
        : missingObservation || (unattributed && accepted.length > 0)
          ? "incomplete"
          : "failed",
    reproduced: replay.reproduced,
    missed: replay.missed,
    dropped,
  };
  if (verification.status === "verified") {
    const programIdentities = await computeWorkflowProgramIdentities({
      plan,
      workspaceId: params.environment.workspaceId,
      resolvePrivate: params.environment.resolvePrivate,
    });
    if (programIdentities.length > 0) verification.programIdentities = programIdentities;
  }
  return { accepted, dropped, plan, verification };
}

/**
 * The whole decision, from proposals to the plan a caller will invoke.
 *
 * A proposal is decided by replay, and the plan that results from the accepted ones is confirmed by
 * replay again — once, as a whole. The two answers are returned separately: which proposals are
 * sound, and whether the plan that carries them reproduces the work. A caller that publishes on the
 * strength of the first alone would publish a plan nothing had run.
 */
export async function validateAndConfirmCandidates(params: {
  plan: RecordedWorkflow;
  candidates: readonly WorkflowBindingCandidate[];
  environment: CandidateValidationEnvironment;
  maxRounds?: number;
}): Promise<{
  outcomes: CandidateValidationOutcome[];
  plan: RecordedWorkflow;
  verification?: WorkflowPlanVerification;
}> {
  // Inputs a derivation reads are read out of the demonstration's own program text, so the
  // decision and the confirming replay run the derivation on the values that run supplied.
  const demonstration = params.plan.heldOut ?? params.plan.baseline;
  const environment =
    demonstration === undefined || !params.plan.steps.some(isDerivationStep)
      ? params.environment
      : await withDerivationInputs(params.plan, params.candidates, {
          label: params.plan.heldOut === undefined ? "baseline" : "held-out",
          demonstration,
          environment: params.environment,
        });
  const decided =
    params.candidates.length === 0
      ? []
      : await validateBindingCandidates({
          plan: params.plan,
          candidates: params.candidates,
          environment,
        });
  const accepted = decided
    .filter((outcome) => outcome.accepted)
    .map((outcome) => outcome.candidate);
  const confirmed = await confirmPromotedPlan({
    plan: params.plan,
    accepted,
    environment,
    ...(params.maxRounds === undefined ? {} : { maxRounds: params.maxRounds }),
  });
  const droppedBy = new Map(
    confirmed.dropped.map((entry) => [entry.candidate, entry.reason] as const),
  );
  return {
    outcomes: decided.map((outcome) => {
      const dropped = droppedBy.get(outcome.candidate);
      return dropped === undefined ? outcome : { ...outcome, accepted: false, reason: dropped };
    }),
    plan: confirmed.plan,
    verification: confirmed.verification,
  };
}

/**
 * Decides each candidate by replay. Every candidate is evaluated independently and a per-candidate
 * failure is reported as a refusal, never thrown: one unusable candidate must not hide the others.
 */
export async function validateBindingCandidates(params: {
  plan: RecordedWorkflow;
  candidates: readonly WorkflowBindingCandidate[];
  environment: CandidateValidationEnvironment;
}): Promise<CandidateValidationOutcome[]> {
  const { plan, candidates, environment } = params;
  // Inferred replacement of the entire executable argument proves only that another
  // program ran, not that the recorded implementation accepts varying data. Exclude
  // both input and result proposals from every A/B plan so they cannot shadow a
  // legitimate token binding. Authored argument sources are unchanged.
  const sourceCandidates = new Set(
    candidates.filter(
      (candidate) =>
        candidate.path.length === 0 &&
        plan.steps.find((step) => step.id === candidate.stepId)?.callable.program?.argument ===
          candidate.argument,
    ),
  );
  const dataCandidates = candidates.filter((candidate) => !sourceCandidates.has(candidate));
  // Derivation bindings are decided by their own checks first; only accepted ones join the A/B
  // plans of the other proposals, so model-written code nobody verified never shapes their runs.
  const derivationCandidates = dataCandidates.filter(
    (candidate) => derivationProducer(plan, candidate) !== undefined,
  );
  const derived =
    derivationCandidates.length === 0
      ? new Map<WorkflowBindingCandidate, CandidateValidationOutcome>()
      : await evaluateDerivationCandidates(plan, derivationCandidates, candidates, environment);
  const abCandidates = dataCandidates.filter(
    (candidate) => !derived.has(candidate) || derived.get(candidate)!.accepted,
  );
  const outcomes: CandidateValidationOutcome[] = [];
  for (const candidate of candidates) {
    const decided = derived.get(candidate);
    outcomes.push(
      sourceCandidates.has(candidate)
        ? refused(
            candidate,
            "the whole executable program is the recorded implementation, not an inferred binding; propose changing data positions within it instead",
          )
        : (decided ?? (await evaluateCandidate(plan, candidate, abCandidates, environment))),
    );
  }
  return outcomes;
}
