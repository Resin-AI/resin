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
  reason?: string;
}

export interface LocalWorkflowValidationResult {
  verdicts: LocalCandidateVerdict[];
  /** Absent when the recording offered no demonstration to check against. */
  verification?: WorkflowPlanVerification;
  /**
   * Set when no check ran, with the reason. A caller must treat this as "not established": a
   * recording whose proposals were never tried keeps every value it was recorded with.
   */
  unavailable?: string;
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
const UNAVAILABLE =
  "this device could not identify the demonstration's recorded calls; no parameter decision was performed";

interface LocalDemonstration {
  recording: Map<string, RecordedCall>;
  demonstration: WorkflowHeldOutDemonstration;
}

/**
 * The recorded call of every recorded step in one demonstration, read from this device's recording,
 * and the demonstration rebuilt from the references this device computed for those calls.
 *
 * Undefined when the demonstration names no calls this device can identify.
 */
async function localDemonstration(
  plan: RecordedWorkflow,
  label: DemonstrationLabel,
  localCalls: LocalCallIdentity,
): Promise<LocalDemonstration | undefined> {
  const recordedSteps = plan.steps.filter((step) => step.origin !== "derivation");
  const callIdsByStep = new Map<string, readonly string[]>();
  if (label === "baseline") {
    for (const step of recordedSteps) {
      if (step.callId === undefined || step.callId.length === 0) return undefined;
      callIdsByStep.set(step.id, [step.callId]);
    }
  } else {
    const calls = plan.heldOut?.calls;
    if (calls === undefined) return undefined;
    for (const entry of calls) callIdsByStep.set(entry.stepId, entry.callIds);
  }

  const located: Array<{ stepId: string; step: WorkflowStep; call: LocalRecordedCall }> = [];
  for (const step of recordedSteps) {
    const callIds = callIdsByStep.get(step.id);
    if (callIds === undefined) continue;
    // One recorded call per step: the executor has no iterated steps to spread calls over.
    if (callIds.length !== 1) return undefined;
    const call = await localCalls.lookup(callIds[0]!);
    if (call === undefined) return undefined;
    located.push({ stepId: step.id, step, call });
  }
  if (located.length === 0) return undefined;

  // Hidden dependencies: the recorder's own relationship detection, run over the recorded calls.
  // A token or leaf it traces to an earlier recorded output must be read by the plan, not carried.
  const derivation = deriveNativeCalls(
    located.map(({ stepId, step, call }) => ({
      callId: call.callId,
      stepId,
      toolName: call.callable.name,
      runtime: step.callable.runtime,
      arguments: call.arguments,
      ...(call.result === undefined ? {} : { result: call.result.value }),
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
  for (const { stepId, call } of located) {
    demonstration.calls.push({ stepId, callIds: [call.callId] });
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
      hiddenDependencies: hidden.get(stepId) ?? [],
    });
  }
  return { recording, demonstration };
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
    const derivation = options.derivation ?? createProgramAdapter({ timeoutMs: options.timeoutMs });
    const local = new Map<DemonstrationLabel, LocalDemonstration>();
    for (const each of ["held-out", "baseline"] as const) {
      if ((each === "held-out" ? plan.heldOut : plan.baseline) === undefined) continue;
      const found = await localDemonstration(plan, each, options.localCalls);
      if (found !== undefined) local.set(each, found);
    }
    if (!local.has(label)) return { verdicts: [], unavailable: UNAVAILABLE };
    const registries = new Map<DemonstrationLabel, RuntimeAdapterRegistry>(
      [...local].map(([each, found]) => [
        each,
        createRecordingCheckAdapters({
          recording: found.recording,
          runtimes: [RESIN_INVOKE_TOOL_RUNTIME],
          derivation,
        }),
      ]),
    );
    // The engine reads the demonstration from the plan: hand it the one this device rebuilt.
    const checkedPlan: RecordedWorkflow = {
      ...plan,
      ...(plan.baseline === undefined
        ? {}
        : { baseline: local.get("baseline")?.demonstration ?? plan.baseline }),
      ...(plan.heldOut === undefined
        ? {}
        : { heldOut: local.get("held-out")?.demonstration ?? plan.heldOut }),
    };

    const baselineOnly = label === "baseline";
    // One recording cannot show that a value varies, but it can offer the value as an optional
    // input that keeps exactly what the recording ran when omitted. Those offers are applied first,
    // in plan order as the cloud applies confirmed ones, and checking that plan verifies the tool as
    // a caller gets it by default.
    let checked = checkedPlan;
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
    const environment = await demonstrationEnvironment({
      plan: checked,
      demonstration: label,
      candidates: baselineOnly ? [] : candidates,
      adapters: (each) => registries.get(each),
      workspaceId,
      resolvePrivate: resolveOwned,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (environment === undefined) return { verdicts: [], unavailable: UNAVAILABLE };
    const decided = await validateAndConfirmCandidates({
      plan: checked,
      candidates: baselineOnly ? baselineExtracts : candidates,
      environment,
    });
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
      verification.dropped = verification.dropped.map(({ candidate }) => ({
        candidate,
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
      : decided.outcomes.map((outcome) => ({ ...outcome, reason: NOT_CONFIRMED }));
    return {
      verdicts: outcomes.map((outcome) => ({
        candidate: {
          stepId: outcome.candidate.stepId,
          argument: outcome.candidate.argument,
          path: outcome.candidate.path,
          proposed: outcome.candidate.proposed,
        },
        confirmed: outcome.accepted,
        ...(outcome.accepted ? {} : { reason: outcome.reason }),
      })),
      ...(verification === undefined ? {} : { verification }),
    };
  };
}
