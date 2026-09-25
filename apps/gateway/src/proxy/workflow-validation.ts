/**
 * The local half of validating a recorded workflow: running the plan where its values are.
 *
 * A recording's values stay on the machine that made them, and so does the environment its steps
 * run in — the workspace, its tools, its connections. Deciding whether the recording's proposals
 * hold is therefore the client's job, not the cloud's: the cloud can compile a plan and attest its
 * bytes, but it cannot run one.
 *
 * This is the service that does run one. It builds the same runtime families the artifact executor
 * builds, points them at a disposable directory rather than the user's live project, resolves the
 * plan's local references from the private store that recorded them, and replays the plan against
 * the demonstration the recording's own repeat supplied. Production validation may seed that
 * directory from a bounded copy of safe inputs in its trusted ready workspace. It returns the
 * per-proposal verdicts and the verdict on the plan as a whole, in the shape the generation path
 * consumes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  FilePrivateValueStore,
  type PrivateValueStore,
  resolvePrivateReference,
} from "@resin/observer";
import {
  type McpToolConnection,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  type RuntimeAdapter,
  RuntimeAdapterRegistry,
  type ToolProtocolDispatchRequest,
  type WorkflowPlanVerification,
  createProcessAdapter,
  createProgramAdapter,
  createToolProtocolAdapter,
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
  /** Absent when the recording offered no demonstration to replay against. */
  verification?: WorkflowPlanVerification;
  /**
   * Set when no replay ran, with the reason. A caller must treat this as "not established": a
   * recording whose proposals were never tried keeps every value it was recorded with.
   */
  unavailable?: string;
}

export interface LocalWorkflowValidatorOptions {
  /**
   * Environment the replayed programs may see. Nothing else is inherited: a program recorded by
   * somebody else's session must not be able to read this operator's credentials.
   */
  environment?: Record<string, string>;
  /**
   * The workspace this replay runs for.
   *
   * A private reference is a name, not a capability. The replay resolves only references whose
   * recorded origin is this workspace, exactly as an invocation through the artifact executor does,
   * so a plan that names a value another workspace recorded is refused here rather than served. A
   * replay that names no workspace resolves nothing.
   */
  workspaceId?: string;
  /** Store the plan's local references resolve from; defaults to the daemon's store. */
  privateValues?: PrivateValueStore;
  /**
   * Replay cwd; defaults to a fresh disposable directory. Explicitly supplied paths remain
   * caller-owned.
   */
  workspaceDir?: string;
  /** Dispatches a tool-protocol step through the host's own routing. */
  dispatch?: (request: ToolProtocolDispatchRequest) => Promise<WorkflowJsonValue>;
  /**
   * Protocol connections already open, by the name a plan's callable carries. A replay that names
   * a connection asks that connection, exactly as the invocation path does, so two servers
   * exposing the same tool name are told apart here too.
   */
  connections?: Record<string, McpToolConnection>;
  /** Dial a connection on first use, for a host that does not keep them open already. */
  openConnection?: (name: string, signal?: AbortSignal) => Promise<McpToolConnection | undefined>;
  /** Additional host-owned runtime families, built for the replay's disposable workspace. */
  runtimeAdapters?: (workspaceDir: string) => readonly RuntimeAdapter[];
  /** Wall-clock bound for the replay. */
  timeoutMs?: number;
}

/**
 * The validator the local half of the product runs. Candidates require held-out evidence.
 * With no held-out run, captured baseline output can prove only the original closed plan.
 */
export function createLocalWorkflowValidator(
  options: LocalWorkflowValidatorOptions = {},
): (plan: RecordedWorkflow) => Promise<LocalWorkflowValidationResult> {
  return async (plan: RecordedWorkflow): Promise<LocalWorkflowValidationResult> => {
    const candidates = plan.candidates ?? [];
    const privateValues = options.privateValues ?? FilePrivateValueStore.default();
    // Read once per replay: the plan's references are resolved through the same ownership rule the
    // executor applies, so a workflow that merely knows another recording's exact reference string
    // is refused by the replay as firmly as it is refused at invocation time.
    const replayWorkspaceId = options.workspaceId;
    const resolveOwned = (reference: string): WorkflowJsonValue => {
      const recorded = privateValues.origin?.(reference)?.workspaceId;
      const usable = (value: unknown): value is string =>
        typeof value === "string" && value.trim().length > 0 && value !== "unknown";
      if (!usable(recorded)) {
        throw new Error(
          `private reference '${reference}' has no usable recorded workspace origin and cannot be resolved by a replay`,
        );
      }
      if (!usable(replayWorkspaceId)) {
        throw new Error(
          `private reference '${reference}' cannot be resolved without the workspace this replay runs for`,
        );
      }
      if (recorded !== replayWorkspaceId) {
        throw new Error(
          `private reference '${reference}' was recorded for another workspace and cannot be resolved by this replay`,
        );
      }
      return resolvePrivateReference(privateValues, reference) as WorkflowJsonValue;
    };

    // A replay may write files, so it never runs in the project the user is working in. The
    // directory lives only as long as the replay does.
    const owned = options.workspaceDir === undefined;
    const workspaceDir =
      options.workspaceDir ?? mkdtempSync(path.join(os.tmpdir(), "resin-replay-"));
    try {
      const adapters = new RuntimeAdapterRegistry();
      // The replay runs in a disposable directory and sees only what this service hands it. A
      // temporary directory is not a sandbox for an outside process, so what the process may reach
      // is bounded by its isolated environment and the host routing used for tool calls.
      const programOptions = {
        cwd: workspaceDir,
        isolateEnvironment: true,
        ...(options.environment === undefined ? {} : { env: options.environment }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      };
      adapters.register(createProcessAdapter(programOptions));
      adapters.register(createProgramAdapter(programOptions));
      for (const adapter of options.runtimeAdapters?.(workspaceDir) ?? []) {
        if (!adapters.has(adapter.runtime)) adapters.register(adapter);
      }
      adapters.register(
        createToolProtocolAdapter({
          ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
          ...(options.connections === undefined ? {} : { connections: options.connections }),
          ...(options.openConnection === undefined
            ? {}
            : { openConnection: options.openConnection }),
        }),
      );
      const hasRecordedProgram = plan.steps.some(
        (step) =>
          step.callable.program !== undefined &&
          (step.callable.runtime === RESIN_PROGRAM_RUNTIME ||
            step.callable.runtime === RESIN_PROCESS_RUNTIME),
      );
      const entirelyFreshProcess =
        plan.steps.length > 0 &&
        plan.steps.every(
          (step) =>
            step.callable.program !== undefined &&
            (step.callable.runtime === RESIN_PROGRAM_RUNTIME ||
              step.callable.runtime === RESIN_PROCESS_RUNTIME),
        );
      const baselineOnly = plan.heldOut === undefined && plan.baseline !== undefined;
      const environment = await demonstrationEnvironment({
        plan: baselineOnly ? { ...plan, heldOut: plan.baseline } : plan,
        candidates: baselineOnly ? [] : candidates,
        adapters,
        workspaceId: replayWorkspaceId,
        workspaceDir,
        resolvePrivate: resolveOwned,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (environment === undefined)
        return {
          verdicts: [],
          unavailable:
            "the selected workflow has no matching recorded demonstration; no replay or parameter decision was performed",
        };
      const decided = await validateAndConfirmCandidates({
        plan,
        candidates: baselineOnly ? [] : candidates,
        environment,
      });
      if (decided.verification?.status === "verified") {
        decided.verification.replay = {
          kind: entirelyFreshProcess ? "fresh-process" : "host-replay",
          planDigest: workflowValidationPlanDigest(decided.plan),
          ...(!entirelyFreshProcess && hasRecordedProgram
            ? {
                freshProcessStepIds: decided.plan.steps
                  .filter(
                    (step) =>
                      step.callable.program !== undefined &&
                      (step.callable.runtime === RESIN_PROGRAM_RUNTIME ||
                        step.callable.runtime === RESIN_PROCESS_RUNTIME),
                  )
                  .map((step) => step.id),
              }
            : {}),
        };
      }
      if (hasRecordedProgram && decided.verification !== undefined) {
        // Interpreter errors may contain private source or values. Only the failed step identity
        // and the replay verdict cross the local/cloud boundary.
        decided.verification.missed = decided.verification.missed.map(({ stepId }) => ({
          stepId,
          detail: "the fresh-process replay did not reproduce this recorded step",
        }));
        decided.verification.dropped = decided.verification.dropped.map(({ candidate }) => ({
          candidate,
          reason: "the binding was not confirmed by fresh-process replay",
        }));
      }
      return {
        verdicts: (baselineOnly
          ? candidates.map((candidate) => ({
              candidate,
              accepted: false,
              reason: "the original baseline cannot establish a binding on different inputs",
            }))
          : decided.outcomes
        ).map((outcome) => ({
          candidate: {
            stepId: outcome.candidate.stepId,
            argument: outcome.candidate.argument,
            path: outcome.candidate.path,
            proposed: outcome.candidate.proposed,
          },
          confirmed: outcome.accepted,
          ...(outcome.accepted
            ? {}
            : {
                reason: hasRecordedProgram
                  ? "the binding was not confirmed by fresh-process replay"
                  : outcome.reason,
              }),
        })),
        ...(decided.verification === undefined ? {} : { verification: decided.verification }),
      };
    } finally {
      if (owned) {
        try {
          rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          // The replay directory is disposable; failing to remove it is not the caller's problem.
        }
      }
    }
  };
}
