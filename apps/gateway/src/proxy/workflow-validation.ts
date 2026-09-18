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
}

export interface LocalWorkflowValidatorOptions {
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
export function createLocalWorkflowValidator(options: LocalWorkflowValidatorOptions = {}) {
  return async (plan: RecordedWorkflow): Promise<LocalWorkflowValidationResult> => {
    const candidates = plan.candidates ?? [];
    if (candidates.length === 0) return { verdicts: [] };
    const privateValues = options.privateValues ?? FilePrivateValueStore.default();

    // A replay may write files, so it never runs in the project the user is working in. The
    // directory lives only as long as the replay does.
    const owned = options.workspaceDir === undefined;
    const workspaceDir = options.workspaceDir ?? mkdtempSync(path.join(os.tmpdir(), "resin-replay-"));
    try {
      const adapters = new RuntimeAdapterRegistry();
      adapters.register(createProcessAdapter({ cwd: workspaceDir }));
      adapters.register(createProgramAdapter({ cwd: workspaceDir }));
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
        resolvePrivate: (reference: string) =>
          resolvePrivateReference(privateValues, reference) as WorkflowJsonValue,
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
