/**
 * The local half of validating a recorded workflow: checking the plan against this device's own
 * recording.
 *
 * A recording's values stay on the machine that made them, so deciding whether a cloud-compiled
 * plan reproduces them is the client's job. It is decided without running anything the recording
 * ran: every recorded step is resolved exactly as an invocation would resolve it, and the resolved
 * call is compared with the call this device recorded for that step. Only model-written derivation
 * steps execute, through the sandboxed program adapter. No recorded program is spawned, no tool call
 * is dispatched and no project directory is created or copied.
 *
 * Every recorded value the check compares against or answers with is read from the private store
 * under a reference this device computes itself, from a session it discovered and a call id: the
 * baseline's calls are the plan's own `callId`s, the held-out repeat's are `heldOut.calls`. A plan
 * cannot supply the recording it is checked against.
 */

import {
  type ProgramLanguage,
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowHeldOutDemonstration,
  type WorkflowJsonValue,
  type WorkflowStep,
  type WorkflowValuePath,
  isSkippableSegment,
  recordedPosixShell,
  shellAndChainSegmentText,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  FilePrivateValueStore,
  type LocalCallIdentity,
  type LocalRecordedCall,
  type PrivateValueStore,
  RESIN_INVOKE_TOOL_RUNTIME,
  deriveNativeCalls,
  resolvePrivateReference,
} from "@resin/observer";
import {
  type CandidateValidationOutcome,
  type DemonstrationLabel,
  type RecordedCall,
  type RuntimeAdapter,
  type RuntimeAdapterRegistry,
  type WorkflowPlanVerification,
  applyConfirmedWorkflowBinding,
  createProgramAdapter,
  createRecordingCheckAdapters,
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "@resin/runtime";

/** A verdict on one proposal, in the vocabulary the generation path reads. */
export interface LocalCandidateVerdict {
  candidate: {
    stepId: string;
    argument: string;
    path: ReadonlyArray<string | number>;
    proposed: WorkflowBindingCandidate["proposed"];
  };
  confirmed: boolean;
  /** The JSON type of the values a confirmed input proposal binds; never the values. */
  confirmedType?: DemonstratedType;
  reason?: string;
}

type DemonstratedType = "string" | "number" | "boolean" | "object" | "array";

export interface LocalWorkflowValidationResult {
  verdicts: LocalCandidateVerdict[];
  /** Absent when the recording offered no demonstration to check against. */
  verification?: WorkflowPlanVerification;
  /**
   * Set when no check ran, with the reason. A caller must treat this as "not established": a
   * recording whose proposals were never tried keeps every value it was recorded with.
   */
  unavailable?: string;
  /**
   * Set when none of the calls the plan names (its own and the held-out's) is in this device's
   * recordings: the demonstration was recorded on another device, which is the one to answer.
   */
  notRecordedHere?: true;
}

export interface RecordingCheckValidatorOptions {
  /**
   * The workspace this check runs for. Only references whose recorded origin is this workspace are
   * resolved, exactly as an invocation resolves them; a check that names no workspace resolves
   * nothing.
   */
  workspaceId?: string;
  /** Store the recording is read from; defaults to the daemon's store. */
  privateValues?: PrivateValueStore;
  /** Reads this device's own recorded calls by call id. */
  localCalls: LocalCallIdentity;
  /** Runs model-written derivation steps; defaults to the sandboxed program adapter. */
  derivation?: RuntimeAdapter;
  /** Wall-clock bound for the check. */
  timeoutMs?: number;
}

/** Fixed, value-free reasons: a decision never carries recorded values, commands or outputs. */
const MISSED_DETAIL = "the recording check did not reproduce this recorded step";
const NOT_CONFIRMED = "the binding was not confirmed by the recording check";
const TYPE_DISAGREES =
  "the demonstrations' values for this input do not share one JSON type; the binding was not confirmed";
const PRIVATE_DERIVATION =
  "a derivation step of this plan reads recorded data this device redacted as secret; no recording check or parameter decision was performed";
const UNAVAILABLE =
  "this device could not identify the demonstration's recorded calls; no parameter decision was performed";

type SegmentAddress = NonNullable<WorkflowStep["segment"]>;

interface LocalDemonstration {
  recording: Map<string, RecordedCall>;
  demonstration: WorkflowHeldOutDemonstration;
}

/**
 * One demonstration as this device recorded it: one run of the plan per iteration.
 *
 * A tool invoked `for_each` runs its whole plan once per item, so each recorded step made one call
 * per item, in order. Iteration i is the run made of every step's i-th call. `mismatched` names the
 * steps whose call count differs from the item count (the first recorded step's): such a recording
 * is not one run per item, and the check misses those steps rather than guessing which call belongs
 * to which item.
 */
type LocalDemonstrationRuns =
  | { iterations: LocalDemonstration[]; mismatched?: undefined }
  | { iterations?: undefined; mismatched: string[] };

/**
 * The recorded calls of every recorded step in one demonstration, read from this device's recording,
 * and each iteration's demonstration rebuilt from the references this device computed for its calls.
 *
 * The plan chooses the call ids, so they must also belong together by this device's own record:
 * every call of one iteration was recorded in one session, in the plan's step order, and no call id
 * is named twice or by both demonstrations. A plan cannot claim a linkage the recording lacks.
 *
 * Undefined when the demonstration names a call this device cannot identify, or an iteration whose
 * calls were recorded in different sessions.
 */
async function localDemonstration(
  plan: RecordedWorkflow,
  label: DemonstrationLabel,
  localCalls: LocalCallIdentity,
): Promise<LocalDemonstrationRuns | undefined> {
  const recordedSteps = plan.steps.filter((step) => step.origin !== "derivation");
  const callIdsByStep = new Map<string, readonly string[]>();
  // Where each named call ran its step: a segment of its own chain, or `null` for the whole call.
  // The plan's own calls ran where the plan step says; another run's where its held-out entry does.
  const addressesByStep = new Map<string, ReadonlyArray<SegmentAddress | null | undefined>>();
  const baselineIds = new Set<string>();
  for (const step of recordedSteps) {
    if (step.callId !== undefined && step.callId.length > 0) baselineIds.add(step.callId);
  }
  if (label === "baseline") {
    for (const step of recordedSteps) {
      if (step.callId === undefined || step.callId.length === 0) return undefined;
      callIdsByStep.set(step.id, [step.callId]);
      addressesByStep.set(step.id, [step.segment ?? null]);
    }
  } else {
    const calls = plan.heldOut?.calls;
    if (calls === undefined) return undefined;
    for (const entry of calls) {
      callIdsByStep.set(entry.stepId, entry.callIds);
      const step = recordedSteps.find((candidate) => candidate.id === entry.stepId);
      // Without addresses every call ran a whole step; a segment step must name its addresses.
      addressesByStep.set(
        entry.stepId,
        entry.segments ?? (step?.segment === undefined ? entry.callIds.map(() => null) : []),
      );
    }
  }

  const located: Array<{
    step: WorkflowStep;
    calls: LocalRecordedCall[];
    addresses: Array<SegmentAddress | null>;
  }> = [];
  const incoherent = new Set<string>();
  const named = new Set<string>();
  // A chain's segments name its one call in turn, each a later segment of it than the one before.
  const segmentNamed = new Map<string, SegmentAddress>();
  // Each named chain's call, the segments of it the plan's steps ran, and those steps.
  const chains = new Map<
    string,
    { call: LocalRecordedCall; address: SegmentAddress; indices: Set<number>; steps: string[] }
  >();
  for (const step of recordedSteps) {
    const callIds = callIdsByStep.get(step.id);
    if (callIds === undefined) continue;
    if (callIds.length === 0) return undefined;
    const calls: LocalRecordedCall[] = [];
    const addresses: Array<SegmentAddress | null> = [];
    for (const [position, callId] of callIds.entries()) {
      const address = addressesByStep.get(step.id)?.[position];
      if (address === undefined) incoherent.add(step.id);
      // One recorded call is one step of one iteration; the held-out run is a different run.
      const earlier = segmentNamed.get(callId);
      const continuesChain =
        address !== undefined &&
        address !== null &&
        earlier !== undefined &&
        earlier.count === address.count &&
        earlier.version === address.version &&
        earlier.index < address.index;
      if (
        (named.has(callId) && !continuesChain) ||
        (label === "held-out" && baselineIds.has(callId))
      ) {
        incoherent.add(step.id);
      }
      named.add(callId);
      if (address !== undefined && address !== null) segmentNamed.set(callId, address);
      const call = await localCalls.lookup(callId);
      if (call === undefined) return undefined;
      if (address !== undefined && address !== null) {
        const chain = chains.get(callId) ?? { call, address, indices: new Set(), steps: [] };
        chain.indices.add(address.index);
        chain.steps.push(step.id);
        chains.set(callId, chain);
      }
      calls.push(call);
      addresses.push(address ?? null);
    }
    located.push({ step, calls, addresses });
  }
  // The named segments of a chain are all of it: the plan may leave out only a segment that this
  // device's own re-split shows to be skippable (`isSkippableSegment`). Leaving out anything else would let the plan
  // stand for a run that did more than the plan does.
  for (const { call, address, indices, steps } of chains.values()) {
    for (let index = 0; index < address.count; index += 1) {
      if (indices.has(index)) continue;
      const text = segmentText({ ...address, index }, call);
      const trailing = index > Math.max(...indices);
      if (text === undefined || !isSkippableSegment(text, address.version, { trailing })) {
        for (const stepId of steps) incoherent.add(stepId);
      }
    }
  }
  if (located.length === 0) return undefined;
  // Where the plan's own calls ran: what the plan's working directories stand for.
  const planRoots = new Map<string, string>();
  for (const { step } of located) {
    const own =
      step.callId === undefined || step.callId.length === 0
        ? undefined
        : await localCalls.lookup(step.callId);
    if (own?.workspaceRoot !== undefined) planRoots.set(step.id, own.workspaceRoot);
  }
  const items = located[0]!.calls.length;
  const mismatched = located
    .filter(({ step, calls }) => calls.length !== items || incoherent.has(step.id))
    .map(({ step }) => step.id);
  if (mismatched.length > 0) return { mismatched };

  const iterations: LocalDemonstration[] = [];
  const unordered = new Set<string>();
  for (let item = 0; item < items; item += 1) {
    const iteration = located.map(({ step, calls, addresses }) => ({
      step,
      call: calls[item]!,
      address: addresses[item],
    }));
    const sessionId = iteration[0]!.call.sessionId;
    if (iteration.some(({ call }) => call.sessionId !== sessionId)) return undefined;
    // Recorded order: each step's call was recorded after the previous step's, by one recorder;
    // a chain's later segment is the same call as the segment before it.
    let previous: LocalRecordedCall | undefined;
    for (const { step, call } of iteration) {
      const sequence = call.sequence;
      const sameChain = previous?.callId === call.callId;
      if (
        sequence === undefined ||
        (previous?.sequence !== undefined &&
          !sameChain &&
          (sequence.epoch !== previous.sequence.epoch || sequence.index <= previous.sequence.index))
      ) {
        unordered.add(step.id);
      }
      if (sequence !== undefined) previous = call;
    }
    iterations.push(iterationDemonstration(iteration, planRoots));
  }
  if (unordered.size > 0) {
    return { mismatched: located.map(({ step }) => step.id).filter((id) => unordered.has(id)) };
  }
  return { iterations };
}

/** One iteration's recording and demonstration: each step's call for that item, in plan order. */
function iterationDemonstration(
  located: ReadonlyArray<{
    step: WorkflowStep;
    call: LocalRecordedCall;
    address: SegmentAddress | null;
  }>,
  planRoots: ReadonlyMap<string, string>,
): LocalDemonstration {
  // A segment this device cannot re-split exactly as the plan did is not in its recording.
  const calls = located.flatMap(({ step, call, address }) => {
    const recorded = address === null ? call : segmentCall(address, call);
    return recorded === undefined ? [] : [{ step, call: recorded, address }];
  });
  // Hidden dependencies: the recorder's own relationship detection, run over this iteration's
  // calls. A token or leaf it traces to an earlier recorded output must be read by the plan. A
  // chain printed its output once, after its last segment: no earlier segment produced any of it.
  const derivation = deriveNativeCalls(
    calls.map(({ step, call, address }) => ({
      callId: call.callId,
      stepId: step.id,
      toolName: call.callable.name,
      runtime: step.callable.runtime,
      arguments: call.arguments,
      ...(call.result === undefined || (address !== null && address.index < address.count - 1)
        ? {}
        : { result: call.result.value }),
      ...(call.callable.program === undefined
        ? {}
        : {
            program: {
              kind: call.callable.program.kind as ProgramLanguage,
              argument: call.callable.program.argument,
            },
          }),
    })),
  );
  const hidden = new Map<string, Array<{ argument: string; path: WorkflowValuePath }>>();
  const addHidden = (stepId: string, argument: string, path: WorkflowValuePath): void => {
    const list = hidden.get(stepId) ?? [];
    list.push({ argument, path });
    hidden.set(stepId, list);
  };
  for (const candidate of derivation.candidates) {
    if (candidate.reason !== "equal-to-earlier-result") continue;
    addHidden(candidate.stepId, candidate.argument, candidate.path);
  }
  for (const extract of derivation.extracts)
    addHidden(extract.stepId, extract.argument, extract.path);

  const recording = new Map<string, RecordedCall>();
  const demonstration: Required<WorkflowHeldOutDemonstration> = {
    inputs: [],
    observed: [],
    calls: [],
  };
  for (const { step, call, address } of calls) {
    const stepId = step.id;
    demonstration.calls.push({
      stepId,
      callIds: [call.callId],
      ...(address === null && step.segment === undefined ? {} : { segments: [address] }),
    });
    for (const [argument, reference] of Object.entries(call.argumentReferences)) {
      demonstration.inputs.push({ stepId, argument, reference });
    }
    if (call.result === undefined) continue;
    demonstration.observed.push({
      stepId,
      reference: call.result.reference,
      ...(call.result.comparison === undefined ? {} : { comparison: call.result.comparison }),
    });
    recording.set(stepId, {
      callable: call.callable,
      arguments: call.arguments,
      result: call.result.value,
      resultRedacted: call.result.redacted,
      hiddenDependencies: hidden.get(stepId) ?? [],
      privatePositions: call.privatePositions,
      ...(call.workspaceRoot === undefined || !planRoots.has(stepId)
        ? {}
        : { roots: { recorded: call.workspaceRoot, plan: planRoots.get(stepId)! } }),
    });
  }
  return { recording, demonstration };
}

/**
 * The recorded call of one segment of a recorded `&&` chain: the chain's call with the segment's
 * text as its program. Only a chain that completed — its exit status zero, so every segment ran —
 * in a POSIX shell, re-split by this device into the address's segment count under its splitter
 * version, has segments; anything else leaves the segment unrecorded and so missed. The address is
 * where the segment sits in this call's own chain. Each segment answers with the chain's recorded
 * output, which only the last segment's readers may read.
 */
function segmentCall(
  address: SegmentAddress,
  call: LocalRecordedCall,
): LocalRecordedCall | undefined {
  const text = segmentText(address, call);
  const program = call.callable.program;
  if (text === undefined || program === undefined) return undefined;
  // Token positions of the whole chain do not address the segment: a chain with any private
  // position keeps every segment's text private as a whole.
  const textPositions = call.privatePositions.filter(
    (entry) => entry.argument === program.argument,
  );
  return {
    ...call,
    arguments: { ...call.arguments, [program.argument]: text },
    privatePositions: [
      ...call.privatePositions.filter((entry) => entry.argument !== program.argument),
      ...(textPositions.length === 0
        ? []
        : [
            {
              argument: program.argument,
              path: [],
              redacted: textPositions.some((entry) => entry.redacted),
            },
          ]),
    ],
  };
}

/** A completed POSIX chain's segment text at `address`, as this device re-splits its recording. */
function segmentText(address: SegmentAddress, call: LocalRecordedCall): string | undefined {
  const program = call.callable.program;
  if (call.exitCode !== 0 || call.result === undefined || program?.kind !== "shell")
    return undefined;
  const shell = recordedPosixShell(call.callable.name, call.arguments);
  if (shell === undefined) return undefined;
  return shellAndChainSegmentText(shell, call.arguments[program.argument], address);
}

/** The JSON type of the value at `path`; undefined when absent, null, or not a declarable type. */
function demonstratedType(
  value: WorkflowJsonValue,
  path: WorkflowValuePath,
): DemonstratedType | undefined {
  let at: WorkflowJsonValue | undefined = value;
  for (const key of path) {
    if (Array.isArray(at) && typeof key === "number") at = at[key];
    else if (at !== null && typeof at === "object" && !Array.isArray(at) && typeof key === "string")
      at = Object.hasOwn(at, key) ? at[key] : undefined;
    else return undefined;
  }
  if (at === undefined || at === null) return undefined;
  if (Array.isArray(at)) return "array";
  const type = typeof at;
  return type === "string" || type === "number" || type === "boolean" || type === "object"
    ? type
    : undefined;
}

/** What one run of the check decided. */
interface IterationDecision {
  outcomes: CandidateValidationOutcome[];
  plan: RecordedWorkflow;
  verification?: WorkflowPlanVerification;
}

/**
 * One decision over every iteration of a demonstration: a candidate is confirmed only when every
 * iteration confirms it, and the plan verifies only when every iteration reproduces its item.
 *
 * Iterations that accept different candidates are re-checked with only the ones all of them
 * accepted, until they agree, so the verified plan is the same plan in every iteration.
 */
async function acrossIterations(
  iterations: readonly LocalDemonstration[],
  candidates: readonly WorkflowBindingCandidate[],
  check: (
    iteration: LocalDemonstration,
    kept: readonly WorkflowBindingCandidate[],
  ) => Promise<IterationDecision | undefined>,
): Promise<IterationDecision | undefined> {
  let kept = [...candidates];
  for (;;) {
    const decisions: IterationDecision[] = [];
    for (const iteration of iterations) {
      const decision = await check(iteration, kept);
      if (decision === undefined) return undefined;
      decisions.push(decision);
    }
    const accepted = decisions.map((decision) =>
      kept.filter((candidate) =>
        decision.outcomes.some((outcome) => outcome.candidate === candidate && outcome.accepted),
      ),
    );
    const everywhere = kept.filter((candidate) => accepted.every((set) => set.includes(candidate)));
    if (!accepted.every((set) => set.length === everywhere.length)) {
      kept = everywhere;
      continue;
    }
    const first = decisions[0]!;
    const outcomes = candidates.map((candidate): CandidateValidationOutcome => {
      if (!kept.includes(candidate)) {
        return { candidate, accepted: false, reason: "not confirmed by every iteration" };
      }
      const refused = decisions
        .flatMap((decision) => decision.outcomes)
        .find((outcome) => outcome.candidate === candidate && !outcome.accepted);
      return (
        refused ??
        first.outcomes.find((outcome) => outcome.candidate === candidate) ?? {
          candidate,
          accepted: false,
          reason: "not decided",
        }
      );
    });
    const verifications = decisions.map((decision) => decision.verification);
    if (!verifications.every((each) => each !== undefined)) {
      return { outcomes, plan: first.plan };
    }
    const status = verifications.every((each) => each.status === "verified")
      ? "verified"
      : verifications.some((each) => each.status === "failed")
        ? "failed"
        : "incomplete";
    const missed = new Map<string, { stepId: string; detail: string }>();
    const dropped = new Map<
      WorkflowBindingCandidate,
      { candidate: WorkflowBindingCandidate; reason: string }
    >();
    for (const each of verifications) {
      for (const entry of each.missed)
        if (!missed.has(entry.stepId)) missed.set(entry.stepId, entry);
      for (const entry of each.dropped) {
        if (!dropped.has(entry.candidate)) dropped.set(entry.candidate, entry);
      }
    }
    const programIdentities = verifications[0]!.programIdentities;
    return {
      outcomes,
      plan: first.plan,
      verification: {
        status,
        reproduced: verifications[0]!.reproduced.filter((stepId) =>
          verifications.every((each) => each.reproduced.includes(stepId)),
        ),
        missed: [...missed.values()],
        dropped: [...dropped.values()],
        ...(status === "verified" && programIdentities !== undefined ? { programIdentities } : {}),
      },
    };
  }
}

/** Every `stepId` a step's argument sources read, however deeply templates nest them. */
function readStepIds(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) readStepIds(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "stepId" && typeof entry === "string") into.add(entry);
      else readStepIds(entry, into);
    }
  }
  return into;
}

/** Every input name a value source reads, however deeply templates nest it. */
function readInputNames(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) readInputNames(item, into);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ((record.type === "input" || record.kind === "input") && typeof record.name === "string") {
      into.add(record.name);
    }
    for (const entry of Object.values(record)) readInputNames(entry, into);
  }
  return into;
}

/**
 * Whether any derivation step reads secret-redacted recorded data, directly or through other steps:
 * a recorded step with a redacted position taints its result, a step reading a tainted step is
 * tainted in turn, and an input any tainted step reads is tainted.
 */
function derivationReadsPrivate(
  plan: RecordedWorkflow,
  demonstrations: readonly LocalDemonstration[],
): boolean {
  const tainted = new Set(
    plan.steps
      .filter((step) =>
        demonstrations.some(({ recording }) => {
          const recorded = recording.get(step.id);
          return (
            recorded?.resultRedacted === true ||
            recorded?.privatePositions?.some((position) => position.redacted === true) === true
          );
        }),
      )
      .map((step) => step.id),
  );
  const taintedInputs = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of plan.steps) {
      const reads = readStepIds(step.arguments, new Set());
      const inputs = readInputNames(step.arguments, new Set());
      const readsTaint =
        [...reads].some((id) => tainted.has(id)) ||
        [...inputs].some((name) => taintedInputs.has(name));
      if (!tainted.has(step.id) && readsTaint) {
        tainted.add(step.id);
        grew = true;
      }
      if (tainted.has(step.id)) {
        for (const name of inputs) {
          if (!taintedInputs.has(name)) {
            taintedInputs.add(name);
            grew = true;
          }
        }
      }
    }
  }
  return plan.steps.some((step) => step.origin === "derivation" && tainted.has(step.id));
}

/**
 * Steps whose own outcome could answer a question about a private value: model-written derivation
 * steps (their code runs over recorded data), recorded steps with a redacted position, and steps
 * that read a derivation's output.
 */
function sensitiveSteps(
  plan: RecordedWorkflow,
  demonstrations: readonly LocalDemonstration[],
): Set<string> {
  const derivations = new Set(
    plan.steps.filter((step) => step.origin === "derivation").map((step) => step.id),
  );
  const sensitive = new Set(derivations);
  for (const step of plan.steps) {
    const privateHere = demonstrations.some(
      ({ recording }) =>
        recording.get(step.id)?.privatePositions?.some((position) => position.redacted === true) ===
        true,
    );
    const readsDerivation = [...readStepIds(step.arguments, new Set())].some((id) =>
      derivations.has(id),
    );
    if (privateHere || readsDerivation) sensitive.add(step.id);
  }
  return sensitive;
}

/**
 * The validator this device runs for the cloud's validation asks. Candidates require held-out
 * evidence; with no held-out run, the baseline recording can prove the closed plan and the
 * single-recording vocabulary (recorded defaults, extracts, derivations).
 */
export function createRecordingCheckValidator(
  options: RecordingCheckValidatorOptions,
): (plan: RecordedWorkflow) => Promise<LocalWorkflowValidationResult> {
  return async (plan: RecordedWorkflow): Promise<LocalWorkflowValidationResult> => {
    const candidates = plan.candidates ?? [];
    const privateValues = options.privateValues ?? FilePrivateValueStore.default();
    const workspaceId = options.workspaceId;
    const resolveOwned = (reference: string): WorkflowJsonValue => {
      const recorded = privateValues.origin?.(reference)?.workspaceId;
      const usable = (value: unknown): value is string =>
        typeof value === "string" && value.trim().length > 0 && value !== "unknown";
      if (!usable(recorded) || !usable(workspaceId) || recorded !== workspaceId) {
        throw new Error(`private reference '${reference}' is not owned by this workspace`);
      }
      return resolvePrivateReference(privateValues, reference) as WorkflowJsonValue;
    };

    const label: DemonstrationLabel | undefined =
      plan.heldOut !== undefined
        ? "held-out"
        : plan.baseline !== undefined
          ? "baseline"
          : undefined;
    if (label === undefined) {
      return {
        verdicts: [],
        unavailable:
          "the selected workflow has no recorded demonstration; no recording check or parameter decision was performed",
      };
    }
    // A plan none of whose calls this device recorded is another device's to check.
    const namedCallIds = new Set([
      ...plan.steps.flatMap((step) =>
        step.origin !== "derivation" && step.callId !== undefined && step.callId.length > 0
          ? [step.callId]
          : [],
      ),
      ...(plan.heldOut?.calls ?? []).flatMap((entry) => entry.callIds),
    ]);
    let recordedHere = false;
    for (const callId of namedCallIds) {
      if ((await options.localCalls.lookup(callId)) !== undefined) {
        recordedHere = true;
        break;
      }
    }
    if (namedCallIds.size > 0 && !recordedHere) {
      return { verdicts: [], unavailable: UNAVAILABLE, notRecordedHere: true };
    }
    const derivation = options.derivation ?? createProgramAdapter({ timeoutMs: options.timeoutMs });
    const runs = new Map<DemonstrationLabel, LocalDemonstrationRuns>();
    for (const each of ["held-out", "baseline"] as const) {
      if ((each === "held-out" ? plan.heldOut : plan.baseline) === undefined) continue;
      const found = await localDemonstration(plan, each, options.localCalls);
      if (found !== undefined) runs.set(each, found);
    }
    const selected = runs.get(label);
    if (selected === undefined) return { verdicts: [], unavailable: UNAVAILABLE };
    if (selected.mismatched !== undefined) {
      // The steps did not run once per item alike: no iteration can be told apart, so nothing is
      // reproduced and nothing is confirmed.
      return {
        verdicts: candidates.map((candidate) => ({
          candidate: {
            stepId: candidate.stepId,
            argument: candidate.argument,
            path: candidate.path,
            proposed: candidate.proposed,
          },
          confirmed: false,
          reason: NOT_CONFIRMED,
        })),
        verification: {
          status: "failed",
          reproduced: [],
          missed: selected.mismatched.map((stepId) => ({ stepId, detail: MISSED_DETAIL })),
          dropped: [],
        },
      };
    }
    const baselineRun = runs.get("baseline")?.iterations?.[0];
    // A derivation that reads private recorded data would turn the check into a computation over it:
    // such an ask is never checked, and every such ask gets this same answer.
    if (
      derivationReadsPrivate(plan, [
        ...(baselineRun === undefined ? [] : [baselineRun]),
        ...(selected.iterations ?? []),
      ])
    ) {
      return {
        verdicts: candidates.map((candidate) => ({
          candidate: {
            stepId: candidate.stepId,
            argument: candidate.argument,
            path: candidate.path,
            proposed: candidate.proposed,
          },
          confirmed: false,
          reason: PRIVATE_DERIVATION,
        })),
        unavailable: PRIVATE_DERIVATION,
      };
    }
    const registry = (
      found: LocalDemonstration,
      checked: RecordedWorkflow,
    ): RuntimeAdapterRegistry =>
      createRecordingCheckAdapters({
        planSuppliedInputs: new Set(
          checked.inputs
            .filter((input) => Object.hasOwn(input, "default"))
            .map((input) => input.name),
        ),
        recording: found.recording,
        runtimes: [RESIN_INVOKE_TOOL_RUNTIME],
        derivation,
      });
    // The engine reads the demonstration from the plan: hand it the one this device rebuilt.
    const withIteration = (
      target: RecordedWorkflow,
      heldOut: LocalDemonstration | undefined,
    ): RecordedWorkflow => ({
      ...target,
      ...(plan.baseline === undefined
        ? {}
        : { baseline: baselineRun?.demonstration ?? plan.baseline }),
      ...(plan.heldOut === undefined ? {} : { heldOut: heldOut?.demonstration ?? plan.heldOut }),
    });
    /** One run of the check against one iteration of the selected demonstration. */
    const checkIteration = async (
      checked: RecordedWorkflow,
      heldOut: LocalDemonstration | undefined,
      decide: readonly WorkflowBindingCandidate[],
      environmentCandidates: readonly WorkflowBindingCandidate[],
    ) => {
      const registries = new Map<DemonstrationLabel, RuntimeAdapterRegistry>();
      if (baselineRun !== undefined) registries.set("baseline", registry(baselineRun, checked));
      if (heldOut !== undefined) registries.set("held-out", registry(heldOut, checked));
      const environment = await demonstrationEnvironment({
        plan: checked,
        demonstration: label,
        candidates: environmentCandidates,
        adapters: (each) => registries.get(each),
        workspaceId,
        resolvePrivate: resolveOwned,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (environment === undefined) return undefined;
      return await validateAndConfirmCandidates({ plan: checked, candidates: decide, environment });
    };

    const baselineOnly = label === "baseline";
    // Each input proposal's type, from the values this device recorded for it: the plan's own call
    // and every held-out iteration. A proposal whose type the cloud could not see (`unknown`) is
    // checked as the type those values share, and dropped when they share none.
    const typeOf = new Map<WorkflowBindingCandidate, DemonstratedType | undefined>();
    if (!baselineOnly) {
      const typeAt = (reference: string | undefined, path: WorkflowValuePath) => {
        if (reference === undefined) return undefined;
        try {
          return demonstratedType(resolveOwned(reference), path);
        } catch {
          return undefined;
        }
      };
      for (const candidate of candidates) {
        if (candidate.proposed.kind !== "input" || candidate.path[0] === "tokens") continue;
        const step = plan.steps.find((entry) => entry.id === candidate.stepId);
        const recorded =
          step === undefined ? undefined : await options.localCalls.lookup(step.callId);
        const types = [
          typeAt(recorded?.argumentReferences[candidate.argument], candidate.path),
          ...selected.iterations.map((iteration) =>
            typeAt(
              iteration.demonstration.inputs.find(
                (entry) =>
                  entry.stepId === candidate.stepId && entry.argument === candidate.argument,
              )?.reference,
              candidate.path,
            ),
          ),
        ];
        typeOf.set(candidate, types.every((type) => type === types[0]) ? types[0] : undefined);
      }
    }
    // What the engine decides: `unknown` proposals carry the type their values share; one whose
    // values share none (or whose position has no JSON type) is never offered to the engine.
    const asChecked = new Map<WorkflowBindingCandidate, WorkflowBindingCandidate>();
    const untyped = new Set<WorkflowBindingCandidate>();
    for (const candidate of candidates) {
      const proposed = candidate.proposed;
      if (proposed.kind !== "input" || proposed.type !== "unknown") {
        asChecked.set(candidate, candidate);
        continue;
      }
      const type = typeOf.get(candidate);
      if (type === undefined) untyped.add(candidate);
      else asChecked.set(candidate, { ...candidate, proposed: { ...proposed, type } });
    }
    const originalOf = new Map([...asChecked].map(([original, checked]) => [checked, original]));
    const checkedCandidates = [...asChecked.values()];
    // One recording cannot show that a value varies, but it can offer the value as an optional
    // input that keeps exactly what the recording ran when omitted. Those offers are applied first,
    // in plan order as the cloud applies confirmed ones, and checking that plan verifies the tool as
    // a caller gets it by default.
    let checked = withIteration(plan, undefined);
    const recordedDefaults: WorkflowBindingCandidate[] = [];
    if (baselineOnly) {
      for (const candidate of candidates) {
        if (candidate.proposed.kind !== "input" || candidate.proposed.recordedDefault !== true) {
          continue;
        }
        const next = applyConfirmedWorkflowBinding(checked, candidate);
        if (next === undefined) continue;
        checked = next;
        recordedDefaults.push(candidate);
      }
    }
    // A single recording can still show that a later call reads a value an earlier step printed:
    // the plan that carries it literally hides that dependency and is refused, and only the bound
    // plan verifies. Likewise a derivation must compute, from the recording's inputs, exactly the
    // tokens it claims.
    const baselineExtracts = baselineOnly
      ? candidates.filter(
          (candidate) =>
            candidate.proposed.kind === "extract" ||
            (candidate.proposed.kind === "result" &&
              candidate.reason === "derived-from-inputs" &&
              checked.steps.some(
                (step) =>
                  candidate.proposed.kind === "result" &&
                  step.id === candidate.proposed.stepId &&
                  step.origin === "derivation",
              )),
        )
      : [];
    const decided = baselineOnly
      ? await checkIteration(checked, undefined, baselineExtracts, [])
      : await acrossIterations(selected.iterations, checkedCandidates, (iteration, kept) =>
          checkIteration(withIteration(plan, iteration), iteration, kept, kept),
        );
    if (decided === undefined) return { verdicts: [], unavailable: UNAVAILABLE };
    const verification = decided.verification;
    if (verification !== undefined) {
      // The digest names the plan the cloud would publish, with the demonstrations it sent.
      const published: RecordedWorkflow = {
        ...decided.plan,
        ...(plan.baseline === undefined ? {} : { baseline: plan.baseline }),
        ...(plan.heldOut === undefined ? {} : { heldOut: plan.heldOut }),
      };
      if (verification.status === "verified") {
        verification.replay = {
          kind: "recording",
          planDigest: workflowValidationPlanDigest(published),
        };
      }
      verification.missed = verification.missed.map(({ stepId }) => ({
        stepId,
        detail: MISSED_DETAIL,
      }));
      if (verification.status !== "verified") {
        // A failed plan never says which privacy-sensitive step failed: every such step is reported
        // missed, so its outcome cannot answer a guess about a private value or a derivation's bit.
        const sensitive = sensitiveSteps(decided.plan, [
          ...(baselineRun === undefined ? [] : [baselineRun]),
          ...(selected.iterations ?? []),
        ]);
        const missed = new Set(verification.missed.map(({ stepId }) => stepId));
        for (const stepId of sensitive) missed.add(stepId);
        verification.reproduced = verification.reproduced.filter((stepId) => !missed.has(stepId));
        verification.missed = decided.plan.steps
          .filter((step) => missed.has(step.id))
          .map((step) => ({ stepId: step.id, detail: MISSED_DETAIL }));
      }
      verification.dropped = verification.dropped.map(({ candidate }) => ({
        candidate: originalOf.get(candidate) ?? candidate,
        reason: NOT_CONFIRMED,
      }));
    }
    const outcomes = baselineOnly
      ? candidates.map((candidate) => {
          const decidedHere = decided.outcomes.find((outcome) => outcome.candidate === candidate);
          if (decidedHere !== undefined) return { ...decidedHere, reason: NOT_CONFIRMED };
          const defaulted =
            recordedDefaults.includes(candidate) && verification?.status === "verified";
          return {
            candidate,
            accepted: defaulted,
            reason: recordedDefaults.includes(candidate)
              ? "the recording check without this input did not reproduce the recording"
              : "the original baseline cannot establish a binding on different inputs",
          };
        })
      : candidates.map((candidate) => {
          if (untyped.has(candidate)) return { candidate, accepted: false, reason: TYPE_DISAGREES };
          const checkedAs = asChecked.get(candidate);
          const outcome = decided.outcomes.find((entry) => entry.candidate === checkedAs);
          return { candidate, accepted: outcome?.accepted === true, reason: NOT_CONFIRMED };
        });
    return {
      verdicts: outcomes.map((outcome) => {
        const confirmedType = outcome.accepted ? typeOf.get(outcome.candidate) : undefined;
        return {
          candidate: {
            stepId: outcome.candidate.stepId,
            argument: outcome.candidate.argument,
            path: outcome.candidate.path,
            proposed: outcome.candidate.proposed,
          },
          confirmed: outcome.accepted,
          ...(confirmedType === undefined ? {} : { confirmedType }),
          ...(outcome.accepted ? {} : { reason: outcome.reason }),
        };
      }),
      ...(verification === undefined ? {} : { verification }),
    };
  };
}
