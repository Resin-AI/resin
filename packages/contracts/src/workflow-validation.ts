/**
 * The wire contract of a recorded workflow's local validation.
 *
 * A recording's values and the environment its steps run in live on the machine that made them, so
 * deciding whether its proposals hold is that machine's job: the cloud compiles a plan and attests
 * its bytes, but it cannot replay one. What travels is therefore an ask and an answer, both bounded
 * to identities and structure:
 *
 *   - the cloud asks the recording's own workspace to evaluate one exact plan, naming the evidence
 *     it was rebuilt from and the validation attempt the answer belongs to;
 *   - the workspace replays the plan where its values are and answers with a per-proposal verdict,
 *     the plan-wide verification the replay reached, and the environment identity it ran in.
 *
 * Neither message carries a value the recording may not carry: the plan is the recorded workflow,
 * whose values are local references, and a verdict names a candidate rather than a result. The
 * digest of the plan is what binds the answer to the exact bytes that were evaluated — a digest
 * identifies content, never its sender, so a decision is only ever accepted on the authenticated
 * connection that also matches the workspace, device, evidence, plan and attempt it names.
 */

import { z } from "zod";
import { canonicalJson, hashCanonical } from "./canonical.js";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  validateRecordedWorkflow,
} from "./recorded-workflow.js";

/** A privacy-safe identity for one replay-confirmed program template. */
export interface WorkflowProgramIdentity {
  stepId: string;
  argument: string;
  path: ReadonlyArray<string | number>;
  /** SHA-256 of the exact applied program template, including its source and holes. */
  templateDigest: string;
  /** SHA-256 of the recorded source with confirmed holes replaced by token sentinels. */
  sourceDigest: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export const WORKFLOW_VALIDATION_SCHEMA_VERSION = 2 as const;

/** One pending validation, addressed to the workspace whose recording it came from. */
export interface WorkflowValidationRequest {
  schemaVersion: typeof WORKFLOW_VALIDATION_SCHEMA_VERSION;
  requestId: string;
  /** The workspace that recorded the work; a decision from any other workspace is refused. */
  workspaceId: string;
  /** The device the request is addressed to, when the cloud knows which one recorded the work. */
  deviceId?: string;
  /** The replay is authenticated by this request's identity and its plan, evidence, and attempt
   * bindings. */
  /**
   * Identity of this validation attempt. A re-ask is a new attempt: an answer for an earlier
   * attempt never decides a later one.
   */
  attempt: string;
  /** Digest of the exact plan being asked about (`workflowValidationPlanDigest`). */
  planDigest: string;
  /** Digest of the source evidence the plan was rebuilt from. */
  evidenceDigest: string;
  createdAt: string;
  /** After this instant the ask is stale and must not be answered with a new success. */
  expiresAt?: string;
  /** The recording to evaluate, exactly as it was compiled: local references, never values. */
  plan: RecordedWorkflow;
}

/** One proposal's outcome, in the vocabulary the generation path reads. */
export interface WorkflowValidationVerdict {
  candidate: {
    stepId: string;
    argument: string;
    path: ReadonlyArray<string | number>;
    proposed: WorkflowBindingCandidate["proposed"];
  };
  confirmed: boolean;
  /** Why a proposal was not confirmed; recorded verbatim when the plan reports the refusal. */
  reason?: string;
}

/** Digest-bound proof of an actual disposable host replay; program replays use a fresh process. */
export interface WorkflowValidationReplayProof {
  kind: "fresh-process" | "host-replay";
  /** The exact plan digest that the replay executed. */
  planDigest: string;
  /** On mixed host replays, only these steps were dispatched through fresh process adapters. */
  freshProcessStepIds?: string[];
}

/** What replaying the plan as a whole concluded, as the runtime that ran it reported it. */
export interface WorkflowValidationPlanVerification {
  status: "verified" | "incomplete" | "failed";
  reproduced: string[];
  missed: Array<{ stepId: string; detail: string }>;
  dropped: Array<{ candidate: WorkflowBindingCandidate; reason: string }>;
  /** Program identities are emitted only when the whole replay was verified. */
  programIdentities?: WorkflowProgramIdentity[];
  /** Replay proof is optional for old decisions and required by publication gates. */
  replay?: WorkflowValidationReplayProof;
}

/**
 * The sanitized answer: what the workspace's own replay decided about one exact plan.
 *
 * Every field is either an identity the cloud already knows or a conclusion the replay reached, so
 * a decision can be checked against the request it answers without the workspace's values ever
 * leaving it.
 */
export interface WorkflowValidationDecision {
  schemaVersion: typeof WORKFLOW_VALIDATION_SCHEMA_VERSION;
  requestId: string;
  attempt: string;
  planDigest: string;
  evidenceDigest: string;
  /** Identity of the disposable environment the replay ran in. */
  environment: string;
  verdicts: WorkflowValidationVerdict[];
  verification?: WorkflowValidationPlanVerification;
  /** The changes the replay accepted: the candidate identities that are bindings now. */
  accepted: Array<{ stepId: string; argument: string; path: ReadonlyArray<string | number> }>;
  decidedAt: string;
}

/** Digest of the exact plan a validation is about; the same bytes hash the same on both sides. */
export function workflowValidationPlanDigest(plan: RecordedWorkflow): string {
  return hashCanonical(plan as unknown as Record<string, unknown>);
}

/**
 * Digest of a decision's substance: the attempt it answers, the plan it evaluated, and what it
 * concluded. Delivery metadata is deliberately excluded, so a retried delivery of one decision
 * hashes to one value and a different conclusion never does.
 */
export function workflowValidationDecisionDigest(
  decision: Omit<WorkflowValidationDecision, "decidedAt"> & { decidedAt?: string },
): string {
  return hashCanonical(
    JSON.parse(
      canonicalJson({
        attempt: decision.attempt,
        requestId: decision.requestId,
        planDigest: decision.planDigest,
        evidenceDigest: decision.evidenceDigest,
        environment: decision.environment,
        verdicts: decision.verdicts,
        ...(decision.verification === undefined ? {} : { verification: decision.verification }),
        accepted: decision.accepted,
      }),
    ) as Record<string, unknown>,
  );
}

const NonEmptyString = z.string().min(1);

const WorkflowValuePathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));

const ProposedBindingSchema = z.union([
  z.object({
    kind: z.literal("result"),
    stepId: NonEmptyString,
    path: WorkflowValuePathSchema,
  }),
  z.object({
    kind: z.literal("input"),
    name: NonEmptyString,
    type: z.enum(["string", "number", "boolean", "object", "array"]),
  }),
]);

const ProgramIdentitySchema = z.object({
  stepId: NonEmptyString,
  argument: NonEmptyString,
  path: WorkflowValuePathSchema,
  templateDigest: z
    .string()
    .regex(SHA256_HEX, "digest must be 64 lowercase hexadecimal characters"),
  sourceDigest: z.string().regex(SHA256_HEX, "digest must be 64 lowercase hexadecimal characters"),
});

const ReplayProofSchema = z.object({
  kind: z.enum(["fresh-process", "host-replay"]),
  planDigest: z.string().regex(SHA256_HEX, "digest must be 64 lowercase hexadecimal characters"),
  freshProcessStepIds: z.array(z.string().min(1)).optional(),
});

const PlanVerificationSchema = z.object({
  status: z.enum(["verified", "incomplete", "failed"]),
  reproduced: z.array(z.string()),
  missed: z.array(z.object({ stepId: z.string(), detail: z.string() })),
  dropped: z.array(z.object({ candidate: z.unknown(), reason: z.string() })),
  programIdentities: z.array(ProgramIdentitySchema).optional(),
  replay: ReplayProofSchema.optional(),
});

const VerdictSchema = z.object({
  candidate: z.object({
    stepId: NonEmptyString,
    argument: NonEmptyString,
    path: WorkflowValuePathSchema,
    proposed: ProposedBindingSchema,
  }),
  confirmed: z.boolean(),
  reason: z.string().optional(),
});

/**
 * Validates the envelope of a pending request, including that its plan is a valid recording.
 *
 * The plan itself is validated by the shared structural validator, so a request can never smuggle a
 * plan neither side would compile.
 */
export const WorkflowValidationRequestSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_VALIDATION_SCHEMA_VERSION),
  requestId: NonEmptyString,
  workspaceId: NonEmptyString,
  deviceId: NonEmptyString.optional(),
  attempt: NonEmptyString,
  planDigest: NonEmptyString,
  evidenceDigest: NonEmptyString,
  createdAt: NonEmptyString,
  expiresAt: NonEmptyString.optional(),
  plan: z.unknown().superRefine((plan, context) => {
    const validation = validateRecordedWorkflow(plan);
    if (!validation.valid) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: validation.errors.join("; ") });
    }
  }),
});

/** Validates the envelope of a decision before anything trusts it. */
export const WorkflowValidationDecisionSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_VALIDATION_SCHEMA_VERSION),
  requestId: NonEmptyString,
  attempt: NonEmptyString,
  planDigest: NonEmptyString,
  evidenceDigest: NonEmptyString,
  environment: NonEmptyString,
  verdicts: z.array(VerdictSchema),
  verification: PlanVerificationSchema.optional(),
  accepted: z.array(
    z.object({
      stepId: NonEmptyString,
      argument: NonEmptyString,
      path: WorkflowValuePathSchema,
    }),
  ),
  decidedAt: NonEmptyString,
});
