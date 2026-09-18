/**
 * The local half of validating a recorded workflow: running the plan where its values are.
 *
 * A recording's values stay on the machine that made them, and so does the environment its steps
 * run in — the workspace, its tools, its connections. Deciding whether the recording's proposals
 * hold is therefore the client's job, not the cloud's: the cloud can compile a plan and attest its
 * bytes, but it cannot run one.
 *
 * This is the service that does run one. It builds the same runtime families the artifact executor
 * builds, points them at a disposable directory rather than the user's project, resolves the plan's
 * local references from the private store that recorded them, and replays the plan against the
 * demonstration the recording's own repeat supplied. It returns the per-proposal verdicts and the
 * verdict on the plan as a whole, in the shape the generation path consumes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RecordedWorkflow,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
} from "@resin/contracts";
import {
  FilePrivateValueStore,
  type PrivateValueStore,
  resolvePrivateReference,
} from "@resin/observer";
import {
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
   * The authorization the replay runs under.
   *
   * A replay executes the recording's own programs and re-makes its own calls, so it runs under the
   * workspace's grant or not at all. Validation is not a way around the capability envelope, and a
   * caller that has no authorized envelope gets a recording whose proposals stay proposals.
   */
  authorization?: () => { envelopeId: string; workspaceId: string } | undefined;
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
  /** Directory the replay's programs run in. Defaults to a fresh disposable directory. */
  workspaceDir?: string;
  /** Dispatches a tool-protocol step through the host's own routing. */
  dispatch?: (request: ToolProtocolDispatchRequest) => Promise<WorkflowJsonValue>;
  /** Wall-clock bound for the replay. */
  timeoutMs?: number;
}

/**
 * The validator the local half of the product runs.
 *
 * It takes no inputs and no expectations from its caller: the demonstration inside the recording
 * supplies both, and nothing else is consulted. A recording that carries no demonstration is
 * reported as having no verification rather than as verified, and a caller that receives no
 * verification must not treat the plan as established.
 */
export function createLocalWorkflowValidator(
  options: LocalWorkflowValidatorOptions = {},
): (plan: RecordedWorkflow) => Promise<LocalWorkflowValidationResult> {
  return async (plan: RecordedWorkflow): Promise<LocalWorkflowValidationResult> => {
    const candidates = plan.candidates ?? [];
    if (candidates.length === 0) return { verdicts: [] };
    // Read when the work is replayed, not when the service is built: a grant is in force for a
    // while, not forever, and a recording made while one was is not evidence of a later one.
    if (options.authorization?.() === undefined) {
      return {
        verdicts: [],
        unavailable:
          "the workspace has no authorization in force, so its recorded work was not replayed",
      };
    }
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
      // The replay's programs run in the disposable directory and see only what this service hands
      // them. A temporary directory is not a sandbox for an outside process, so what the process may
      // reach is bounded by its environment and by the grant the work was authorized under.
      const programOptions = {
        cwd: workspaceDir,
        isolateEnvironment: true,
        ...(options.environment === undefined ? {} : { env: options.environment }),
      };
      adapters.register(createProcessAdapter(programOptions));
      adapters.register(createProgramAdapter(programOptions));
      adapters.register(
        createToolProtocolAdapter({
          ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
        }),
      );
      const environment = await demonstrationEnvironment({
        plan,
        candidates,
        adapters,
        workspaceDir,
        resolvePrivate: resolveOwned,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (environment === undefined) return { verdicts: [] };
      const decided = await validateAndConfirmCandidates({ plan, candidates, environment });
      return {
        verdicts: decided.outcomes.map((outcome) => ({
          candidate: {
            stepId: outcome.candidate.stepId,
            argument: outcome.candidate.argument,
            path: outcome.candidate.path,
            proposed: outcome.candidate.proposed,
          },
          confirmed: outcome.accepted,
          ...(outcome.accepted ? {} : { reason: outcome.reason }),
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
