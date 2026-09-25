/**
 * Validating a proposed binding by replay, not by similarity.
 *
 * The capture proposes candidates it cannot establish: a value that equals an earlier result, or one
 * that moved with it across executions. Similarity is never proof — an incidental equality would
 * become a dependency, and a dependency that was not there would break the next execution. So every
 * candidate is decided by running it: the recorded plan with the candidate bound is executed in a
 * disposable environment on different inputs, and the recorded plan as it stands is executed too,
 * and a candidate is only promoted when its binding reproduces the held-out observation *and* the
 * recorded value does not. When both reproduce it, or neither does, the fact the record is missing
 * is reported instead of a promotion.
 */

import { mkdir } from "node:fs/promises";
import {
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
  bindProgramToken,
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

export interface CandidateValidationEnvironment {
  adapters: RuntimeAdapterRegistry;
  /** Workspace scope for private-source identity hashing and replay ownership. */
  workspaceId?: string;
  /** A disposable directory the workflow may write to; it is never the user's project. */
  workspaceDir: string;
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
  /** Fresh-process proof attached only after a real replay. */
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
 * Compares one replay result with its selected demonstration. The only non-exact mode is the
 * explicitly declared textual whitespace projection; expected text is never normalized.
 */
function matchesObservedResult(
  actual: WorkflowJsonValue,
  expected: WorkflowJsonValue,
  comparison: WorkflowObservedComparison | undefined,
): boolean {
  if (comparison === undefined) return deepEqual(actual, expected);
  if (comparison !== "text-trim") return false;
  return typeof actual === "string" && typeof expected === "string" && actual.trim() === expected;
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
  return candidate.proposed.kind === "result"
    ? { type: "result", stepId: candidate.proposed.stepId, path: [...candidate.proposed.path] }
    : { type: "input", name: candidate.proposed.name };
}

function proposedSource(candidate: WorkflowBindingCandidate): WorkflowValueSource {
  return candidate.proposed.kind === "result"
    ? { kind: "result", stepId: candidate.proposed.stepId, path: [...candidate.proposed.path] }
    : { kind: "input", name: candidate.proposed.name };
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
    const token = path[1];
    if (program === undefined || program.argument !== candidate.argument) return false;
    if (typeof token !== "number" || !Number.isInteger(token) || token < 0) return false;
    if (path.length !== 2) return false;
    const recorded = sourceAsTemplate(argument.source);
    argument.source = {
      kind: "template",
      template: bindProgramToken(recorded, program.kind, token, proposedTemplate(candidate)),
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
): { plan: RecordedWorkflow; unaddressable: Map<WorkflowBindingCandidate, string> } {
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
  return { plan: bound, unaddressable };
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
    default: {
      const exhaustive: never = outcome;
      return `step outcome ${JSON.stringify(exhaustive)}`;
    }
  }
}

async function replayStep(
  plan: RecordedWorkflow,
  stepId: string,
  observed: WorkflowJsonValue,
  environment: CandidateValidationEnvironment,
): Promise<StepReplay> {
  const options: RecordedWorkflowExecutionOptions = {
    inputs: environment.inputs,
    adapters: environment.adapters,
    ...(environment.workspaceId ? { access: { workspaceId: environment.workspaceId } } : {}),
    ...(environment.resolvePrivate ? { resolvePrivate: environment.resolvePrivate } : {}),
  };
  const execution = await withDeadline(
    (signal) => executeRecordedWorkflow(plan, { ...options, signal }),
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
  const reproduced = matchesObservedResult(
    outcome.result,
    observed,
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
    const bound = await replayStep(plans.bound, candidate.stepId, observed, environment);
    const literal = await replayStep(plans.literal, candidate.stepId, observed, environment);
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
function demonstratedTokenValue(
  plan: RecordedWorkflow,
  candidate: WorkflowBindingCandidate,
  supplied: WorkflowJsonValue,
): string | undefined {
  const index = candidate.path[1];
  if (candidate.path.length !== 2) return undefined;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
  const program = plan.steps.find((entry) => entry.id === candidate.stepId)?.callable.program;
  if (program === undefined || program.argument !== candidate.argument) return undefined;
  if (typeof supplied !== "string") return undefined;
  return tokenizeProgram(program.kind, supplied)[index]?.value;
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
  candidates: readonly WorkflowBindingCandidate[];
  adapters: RuntimeAdapterRegistry;
  workspaceId?: string;
  workspaceDir: string;
  resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  timeoutMs?: number;
}): Promise<CandidateValidationEnvironment | undefined> {
  const demonstration = params.plan.heldOut;
  if (demonstration === undefined) return undefined;
  const resolve = params.resolvePrivate;
  if (resolve === undefined) return undefined;
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
    const source = argument.source;
    if (source.kind !== "input") continue;
    const input = params.plan.inputs.find((candidate) => candidate.name === source.name);
    if (input === undefined) return undefined;
    const value = await resolveOnce(entry.reference);
    if (!matchesDemonstratedType(value, input.type)) return undefined;
    const name = input.name;
    if (Object.hasOwn(inputs, name) && !deepEqual(inputs[name], value)) return undefined;
    inputs[name] = value;
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
        ? demonstratedTokenValue(params.plan, candidate, supplied)
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
    adapters: params.adapters,
    workspaceId: params.workspaceId,
    workspaceDir: params.workspaceDir,
    inputs,
    observed,
    ...(Object.keys(observedComparisons).length === 0 ? {} : { observedComparisons }),
    resolvePrivate: resolve,
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  };
}

/**
 * Replays a plan ONCE and reports which of its observed steps it reproduced.
 *
 * The plan runs a single time per attempt. The work is a sequence — a later step reads what an
 * earlier one produced — so running it once per step would both multiply the cost and compare
 * traces that never existed: step 3 of a second run follows a first run's side effects, not the
 * recorded execution's. One run, every observed step compared against that one trace.
 */
async function replayPlanOnce(
  plan: RecordedWorkflow,
  environment: CandidateValidationEnvironment,
): Promise<{
  reproduced: string[];
  missed: Array<{ stepId: string; detail: string }>;
}> {
  const options: RecordedWorkflowExecutionOptions = {
    inputs: environment.inputs,
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
  for (const step of plan.steps) {
    const stepId = step.id;
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
      matchesObservedResult(outcome.result, observed, environment.observedComparisons?.[stepId])
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
  const dropped: Array<{ candidate: WorkflowBindingCandidate; reason: string }> = [];
  let plan = applyAcceptedBindings(params.plan, accepted);
  let replay = await replayPlanOnce(plan, params.environment);
  // True when the replay missed a step no accepted proposal decided, so nothing withdrawn here
  // could change it. That is a limit of the demonstration, not evidence against the proposals.
  let unattributed = false;
  for (let round = 0; round < rounds && replay.missed.length > 0; round += 1) {
    const missedStepId = replay.missed[0]!.stepId;
    if (!Object.hasOwn(params.environment.observed, missedStepId)) {
      unattributed = true;
      break;
    }
    const blamed =
      accepted.find((candidate) => candidate.stepId === missedStepId) ??
      accepted.find(
        (candidate) =>
          candidate.proposed.kind === "result" && candidate.proposed.stepId === missedStepId,
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
    plan = applyAcceptedBindings(params.plan, accepted);
    replay = await replayPlanOnce(plan, params.environment);
  }
  const verification: WorkflowPlanVerification = {
    status:
      replay.missed.length === 0
        ? "verified"
        : unattributed && accepted.length > 0
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
  const decided =
    params.candidates.length === 0
      ? []
      : await validateBindingCandidates({
          plan: params.plan,
          candidates: params.candidates,
          environment: params.environment,
        });
  const accepted = decided
    .filter((outcome) => outcome.accepted)
    .map((outcome) => outcome.candidate);
  const confirmed = await confirmPromotedPlan({
    plan: params.plan,
    accepted,
    environment: params.environment,
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
  if (environment.workspaceDir.length === 0) {
    throw new Error("the replay environment needs a disposable workspace directory");
  }
  // Replays may write files. The workspace is guaranteed to exist before any run, and the adapters
  // handed in are expected to execute there — never in the caller's project.
  await mkdir(environment.workspaceDir, { recursive: true });
  // Older capture versions proposed the entire executable argument from discovery's schema.
  // Replacing it proves only that another program ran, not that the recorded program accepts new
  // data. Exclude such proposals from ALL A/B plans too: otherwise a whole-source replacement can
  // shadow a legitimate token binding and make its evidence appear inconclusive. Explicit inputs
  // already present in an authored plan and result-to-program dependencies are unaffected.
  const sourceInputs = new Set(
    candidates.filter(
      (candidate) =>
        candidate.proposed.kind === "input" &&
        candidate.path.length === 0 &&
        plan.steps.find((step) => step.id === candidate.stepId)?.callable.program?.argument ===
          candidate.argument,
    ),
  );
  const dataCandidates = candidates.filter((candidate) => !sourceInputs.has(candidate));
  const outcomes: CandidateValidationOutcome[] = [];
  for (const candidate of candidates) {
    outcomes.push(
      sourceInputs.has(candidate)
        ? refused(
            candidate,
            "the whole executable program is the recorded implementation, not an inferred caller input; propose the changing data positions within it instead",
          )
        : await evaluateCandidate(plan, candidate, dataCandidates, environment),
    );
  }
  return outcomes;
}
