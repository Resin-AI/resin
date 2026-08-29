import { z } from "zod";
import { canonicalJsonStringify, hashCanonical } from "./canonical.js";
import { ISOTimestampSchema, IdentifierSchema, normalizeSha256 } from "./common.js";

/**
 * Standard literal version string for qualification contracts.
 */
export const CURRENT_QUALIFICATION_VERSION = "1.0.0";

/**
 * Normalized SHA-256 Digest Schema.
 * Accepts 64-hex strings with or without 'sha256:' prefix and normalizes to lowercase 64-hex string.
 */
export const NormalizedSha256DigestSchema = z
  .string()
  .regex(
    /^(sha256:)?[a-f0-9]{64}$/i,
    "Invalid SHA-256 digest format (expected 64 hex characters or sha256:<hex>)",
  )
  .transform((val) => normalizeSha256(val, false));

/**
 * Error codes for qualification validation failures.
 */
export const QUALIFICATION_ERROR_CODES = {
  INSUFFICIENT_ENVIRONMENTS: "INSUFFICIENT_ENVIRONMENTS",
  MIXED_REVISIONS: "MIXED_REVISIONS",
  MISSING_REVIEWERS: "MISSING_REVIEWERS",
  REVIEWER_VERDICT_FAILED: "REVIEWER_VERDICT_FAILED",
  HISTORY_LEAKAGE: "HISTORY_LEAKAGE",
  BUNDLE_MISMATCH: "BUNDLE_MISMATCH",
  REPLAY_MISMATCH: "REPLAY_MISMATCH",
  APPROVAL_MISMATCH: "APPROVAL_MISMATCH",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
} as const;

export type QualificationErrorCode =
  (typeof QUALIFICATION_ERROR_CODES)[keyof typeof QUALIFICATION_ERROR_CODES];

/**
 * 1. FrozenToolIntent
 * Frozen intent specification captured before candidate generation.
 * Pure pre-generation contract independent of candidate source, dependencies, or candidate identity.
 */
export const FrozenToolIntentSchema = z
  .object({
    intentId: IdentifierSchema,
    schemaVersion: z.literal(CURRENT_QUALIFICATION_VERSION),
    goal: z.string().min(1, "Goal cannot be empty"),
    successCriteria: z
      .array(z.string().min(1, "Success criterion cannot be empty"))
      .min(1, "successCriteria cannot be empty"),
    inputSchemaDigest: NormalizedSha256DigestSchema,
    constraints: z.array(z.string()),
    createdAt: ISOTimestampSchema,
    createdBy: z.string().min(1, "CreatedBy cannot be empty"),
    intentDigest: NormalizedSha256DigestSchema,
  })
  .strict();

export type FrozenToolIntent = z.infer<typeof FrozenToolIntentSchema>;

/**
 * Computes deterministic canonical digest for FrozenToolIntent excluding intentDigest.
 */
export function computeFrozenIntentDigest(
  intent: Omit<FrozenToolIntent, "intentDigest"> | FrozenToolIntent,
  options: { prefix?: boolean } = {},
): string {
  const { intentDigest: _, ...projection } = intent as FrozenToolIntent;
  return hashCanonical(
    {
      domain: "resin/frozen-intent/v1",
      constraints: projection.constraints,
      createdAt: projection.createdAt,
      createdBy: projection.createdBy,
      goal: projection.goal,
      inputSchemaDigest: normalizeSha256(projection.inputSchemaDigest, false),
      intentId: projection.intentId,
      schemaVersion: projection.schemaVersion,
      successCriteria: projection.successCriteria,
    },
    options,
  );
}

/**
 * Observation status enum for effect profile axes.
 */
export const EffectObservationStatusSchema = z.enum(["complete", "unknown"]);
export type EffectObservationStatus = z.infer<typeof EffectObservationStatusSchema>;

/**
 * Consequential Action Schema.
 */
export const ConsequentialActionSchema = z
  .object({
    actionType: z.string().min(1, "actionType cannot be empty"),
    target: z.string().min(1, "target cannot be empty"),
    description: z.string().min(1, "description cannot be empty"),
    requiresExplicitAuthorization: z.literal(true),
    authorizationEvidence: z.string().min(1, "authorizationEvidence cannot be empty").optional(),
  })
  .strict();

export type ConsequentialAction = z.infer<typeof ConsequentialActionSchema>;

/**
 * 2. ObservedEffectProfile
 * Observed effect profile declaring strictly observed capabilities, side-effects,
 * and complete/unknown observation states across all consequential axes.
 */
export const ObservedEffectProfileSchema = z
  .object({
    filesRead: z
      .object({
        observation: EffectObservationStatusSchema,
        paths: z.array(z.string()),
      })
      .strict(),
    filesCreated: z
      .object({
        observation: EffectObservationStatusSchema,
        paths: z.array(z.string()),
      })
      .strict(),
    filesModified: z
      .object({
        observation: EffectObservationStatusSchema,
        paths: z.array(z.string()),
      })
      .strict(),
    filesDeleted: z
      .object({
        observation: EffectObservationStatusSchema,
        paths: z.array(z.string()),
      })
      .strict(),
    processTree: z
      .object({
        observation: EffectObservationStatusSchema,
        spawnedProcesses: z.array(z.string()),
      })
      .strict(),
    network: z
      .object({
        observation: EffectObservationStatusSchema,
        destinations: z.array(z.string()),
        methods: z.array(z.string()),
      })
      .strict(),
    environmentVariables: z
      .object({
        observation: EffectObservationStatusSchema,
        names: z.array(z.string()),
      })
      .strict(),
    credentials: z
      .object({
        observation: EffectObservationStatusSchema,
        names: z.array(z.string()),
      })
      .strict(),
    dependencyChanges: z
      .object({
        observation: EffectObservationStatusSchema,
        changes: z.array(z.string()),
      })
      .strict(),
    artifacts: z
      .object({
        observation: EffectObservationStatusSchema,
        items: z.array(
          z
            .object({
              name: z.string().min(1),
              digest: NormalizedSha256DigestSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    validationChecks: z
      .object({
        observation: EffectObservationStatusSchema,
        checks: z.array(
          z
            .object({
              checkId: z.string().min(1),
              name: z.string().min(1),
              passed: z.boolean(),
              details: z.string().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    resourceEnvelope: z
      .object({
        observation: EffectObservationStatusSchema,
        maxMemoryBytes: z.number().int().nonnegative(),
        cpuTimeMs: z.number().nonnegative(),
        wallDurationMs: z.number().nonnegative(),
      })
      .strict(),
    consequentialActions: z
      .object({
        observation: EffectObservationStatusSchema,
        actions: z.array(ConsequentialActionSchema),
      })
      .strict(),
    determinism: z.enum(["deterministic", "non_deterministic", "pseudo_deterministic"]),
    profileDigest: NormalizedSha256DigestSchema.optional(),
  })
  .strict();

export type ObservedEffectProfile = z.infer<typeof ObservedEffectProfileSchema>;

/**
 * Computes deterministic canonical digest for ObservedEffectProfile excluding profileDigest.
 */
export function computeObservedEffectProfileDigest(
  profile: Omit<ObservedEffectProfile, "profileDigest"> | ObservedEffectProfile,
  options: { prefix?: boolean } = {},
): string {
  const { profileDigest: _, ...projection } = profile as ObservedEffectProfile;
  return hashCanonical(
    {
      domain: "resin/observed-effect-profile/v1",
      ...projection,
    },
    options,
  );
}

/**
 * Structured Check Schema for qualification runs.
 */
export const StructuredCheckSchema = z
  .object({
    checkId: z.string().min(1, "checkId cannot be empty"),
    name: z.string().min(1, "name cannot be empty"),
    status: z.enum(["passed", "failed", "error"]),
    message: z.string().optional(),
    actualDigest: NormalizedSha256DigestSchema.optional(),
    expectedDigest: NormalizedSha256DigestSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.status === "passed") {
      if (data.expectedDigest !== undefined && data.actualDigest === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Check with status 'passed' specifying expectedDigest must also bind actualDigest",
          path: ["actualDigest"],
        });
      }
      if (data.actualDigest !== undefined && data.expectedDigest === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Check with status 'passed' specifying actualDigest must also bind expectedDigest",
          path: ["expectedDigest"],
        });
      }
      if (
        data.actualDigest !== undefined &&
        data.expectedDigest !== undefined &&
        normalizeSha256(data.actualDigest, false) !== normalizeSha256(data.expectedDigest, false)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Check with status 'passed' has mismatched actualDigest '${data.actualDigest}' and expectedDigest '${data.expectedDigest}'`,
          path: ["actualDigest"],
        });
      }
    }
  });

/**
 * Computes deterministic canonical digest for an array of StructuredCheck items.
 */
export function computeStructuredChecksDigest(
  checks: StructuredCheck[],
  options: { prefix?: boolean } = {},
): string {
  return hashCanonical(checks, options);
}

/**
 * Alias for computeStructuredChecksDigest.
 */
export const computeCheckDigest = computeStructuredChecksDigest;

export type StructuredCheck = z.infer<typeof StructuredCheckSchema>;

/**
 * Structured Cost Schema for qualification runs.
 */
export const QualificationCostsSchema = z
  .object({
    modelUsageObservation: z.enum(["complete", "not-applicable", "unknown"]),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.modelUsageObservation === "complete") {
      if (data.inputTokens === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputTokens is required when modelUsageObservation is 'complete'",
          path: ["inputTokens"],
        });
      }
      if (data.outputTokens === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "outputTokens is required when modelUsageObservation is 'complete'",
          path: ["outputTokens"],
        });
      }
      if (data.cacheReadTokens === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cacheReadTokens is required when modelUsageObservation is 'complete'",
          path: ["cacheReadTokens"],
        });
      }
      if (data.costUsd === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "costUsd is required when modelUsageObservation is 'complete'",
          path: ["costUsd"],
        });
      }
    } else if (data.modelUsageObservation === "not-applicable") {
      if (data.inputTokens !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "inputTokens must be absent when modelUsageObservation is 'not-applicable'",
          path: ["inputTokens"],
        });
      }
      if (data.outputTokens !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "outputTokens must be absent when modelUsageObservation is 'not-applicable'",
          path: ["outputTokens"],
        });
      }
      if (data.cacheReadTokens !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cacheReadTokens must be absent when modelUsageObservation is 'not-applicable'",
          path: ["cacheReadTokens"],
        });
      }
      if (data.costUsd !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "costUsd must be absent when modelUsageObservation is 'not-applicable'",
          path: ["costUsd"],
        });
      }
    }
  });

export type QualificationCosts = z.infer<typeof QualificationCostsSchema>;

/**
 * 3. QualificationRunRecord
 * Append-only qualification run record in a specific test environment.
 * Includes sequence, recordDigest, previousRecordDigest hash links and globally unique runId.
 */
export const QualificationRunRecordBaseSchema = z
  .object({
    runId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    candidateId: IdentifierSchema,
    environment: z.string().min(1, "Environment identifier cannot be empty"),
    status: z.enum(["passed", "failed", "error"]),
    sourceDigest: NormalizedSha256DigestSchema,
    dependencyDigest: NormalizedSha256DigestSchema,
    intentDigest: NormalizedSha256DigestSchema,
    environmentDigest: NormalizedSha256DigestSchema,
    inputDigest: NormalizedSha256DigestSchema,
    traceDigest: NormalizedSha256DigestSchema,
    beforeStateDigest: NormalizedSha256DigestSchema,
    afterStateDigest: NormalizedSha256DigestSchema,
    outputDigest: NormalizedSha256DigestSchema,
    checkDigest: NormalizedSha256DigestSchema,
    effectDigest: NormalizedSha256DigestSchema,
    observedEffectProfile: ObservedEffectProfileSchema,
    structuredChecks: z.array(StructuredCheckSchema),
    costs: QualificationCostsSchema,
    previousRecordDigest: NormalizedSha256DigestSchema.nullable().optional(),
    recordDigest: NormalizedSha256DigestSchema,
    startedAt: ISOTimestampSchema,
    completedAt: ISOTimestampSchema,
    logsUri: z.string().optional(),
  })
  .strict();

export const QualificationRunRecordSchema = QualificationRunRecordBaseSchema.superRefine(
  (data, ctx) => {
    if (data.status === "passed") {
      // 1. Every ObservedEffectProfile axis must be complete
      const profile = data.observedEffectProfile;
      const axes: Array<keyof Omit<ObservedEffectProfile, "profileDigest" | "determinism">> = [
        "filesRead",
        "filesCreated",
        "filesModified",
        "filesDeleted",
        "processTree",
        "network",
        "environmentVariables",
        "credentials",
        "dependencyChanges",
        "artifacts",
        "validationChecks",
        "resourceEnvelope",
        "consequentialActions",
      ];
      for (const axis of axes) {
        const section = profile[axis];
        if (section && section.observation !== "complete") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Run with status 'passed' requires axis '${axis}' observation to be 'complete', found '${section.observation}'`,
            path: ["observedEffectProfile", axis, "observation"],
          });
        }
      }

      // 2. validationChecks inside observedEffectProfile must all pass
      if (profile.validationChecks && profile.validationChecks.checks) {
        for (let i = 0; i < profile.validationChecks.checks.length; i++) {
          const check = profile.validationChecks.checks[i];
          if (!check.passed) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Run with status 'passed' has failing validationCheck '${check.checkId}'`,
              path: ["observedEffectProfile", "validationChecks", "checks", i, "passed"],
            });
          }
        }
      }

      // 3. Costs model usage observation cannot be unknown
      if (data.costs.modelUsageObservation === "unknown") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Run with status 'passed' cannot have unknown modelUsageObservation",
          path: ["costs", "modelUsageObservation"],
        });
      }

      // 4. Structured checks must be non-empty and all passed
      if (data.structuredChecks.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Run with status 'passed' must contain at least one structured check",
          path: ["structuredChecks"],
        });
      }
      for (let i = 0; i < data.structuredChecks.length; i++) {
        const check = data.structuredChecks[i];
        if (check.status !== "passed") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Run with status 'passed' contains non-passed structured check '${check.checkId}' with status '${check.status}'`,
            path: ["structuredChecks", i, "status"],
          });
        }
        if (
          check.actualDigest !== undefined &&
          check.expectedDigest !== undefined &&
          normalizeSha256(check.actualDigest, false) !==
            normalizeSha256(check.expectedDigest, false)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Run with status 'passed' structured check '${check.checkId}' actualDigest '${check.actualDigest}' does not match expectedDigest '${check.expectedDigest}'`,
            path: ["structuredChecks", i, "actualDigest"],
          });
        }
      }

      // 5. Consequential actions must all have exact authorization evidence
      if (profile.consequentialActions && profile.consequentialActions.actions) {
        for (let i = 0; i < profile.consequentialActions.actions.length; i++) {
          const action = profile.consequentialActions.actions[i];
          if (!action.authorizationEvidence || action.authorizationEvidence.trim() === "") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Run with status 'passed' contains unauthorized consequential action '${action.actionType}' on '${action.target}' (missing authorizationEvidence)`,
              path: [
                "observedEffectProfile",
                "consequentialActions",
                "actions",
                i,
                "authorizationEvidence",
              ],
            });
          }
        }
      }
    }
  },
);

export type QualificationRunRecord = z.infer<typeof QualificationRunRecordSchema>;

/**
 * Computes deterministic canonical digest for QualificationRunRecord excluding recordDigest.
 */
export function computeQualificationRunDigest(
  run: Omit<QualificationRunRecord, "recordDigest"> | QualificationRunRecord,
  options: { prefix?: boolean } = {},
): string {
  const { recordDigest: _, ...projection } = run as QualificationRunRecord;
  return hashCanonical(
    {
      domain: "resin/qualification-run-record/v1",
      afterStateDigest: normalizeSha256(projection.afterStateDigest, false),
      beforeStateDigest: normalizeSha256(projection.beforeStateDigest, false),
      candidateId: projection.candidateId,
      checkDigest: normalizeSha256(projection.checkDigest, false),
      completedAt: projection.completedAt,
      costs: projection.costs,
      dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
      effectDigest: normalizeSha256(projection.effectDigest, false),
      environment: projection.environment,
      environmentDigest: normalizeSha256(projection.environmentDigest, false),
      inputDigest: normalizeSha256(projection.inputDigest, false),
      intentDigest: normalizeSha256(projection.intentDigest, false),
      logsUri: projection.logsUri,
      observedEffectProfile: projection.observedEffectProfile,
      outputDigest: normalizeSha256(projection.outputDigest, false),
      previousRecordDigest: projection.previousRecordDigest
        ? normalizeSha256(projection.previousRecordDigest, false)
        : null,
      runId: projection.runId,
      sequence: projection.sequence,
      sourceDigest: normalizeSha256(projection.sourceDigest, false),
      startedAt: projection.startedAt,
      status: projection.status,
      structuredChecks: projection.structuredChecks,
      traceDigest: normalizeSha256(projection.traceDigest, false),
    },
    options,
  );
}

/**
 * 4. ReviewerVerdict
 * Reviewer verdict record from an independent reviewer role without generator history.
 * Includes sequence, recordDigest, previousRecordDigest hash links and globally unique verdictId.
 */
export const ReviewerVerdictSchema = z
  .object({
    verdictId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    sessionId: IdentifierSchema,
    reviewerId: z.string().min(1, "ReviewerId cannot be empty"),
    reviewerRole: z.enum(["correctness-usefulness", "adversarial-safety"]),
    verdict: z.enum(["approved", "rejected"]),
    noGeneratorHistory: z.literal(true),
    sourceDigest: NormalizedSha256DigestSchema,
    dependencyDigest: NormalizedSha256DigestSchema,
    intentDigest: NormalizedSha256DigestSchema,
    rawEvidenceDigest: NormalizedSha256DigestSchema,
    findings: z.array(z.string()),
    comments: z.string().optional(),
    previousRecordDigest: NormalizedSha256DigestSchema.nullable().optional(),
    recordDigest: NormalizedSha256DigestSchema,
    reviewedAt: ISOTimestampSchema,
  })
  .strict();

export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

/**
 * Computes deterministic canonical digest for ReviewerVerdict excluding recordDigest.
 */
export function computeReviewerVerdictDigest(
  verdict: Omit<ReviewerVerdict, "recordDigest"> | ReviewerVerdict,
  options: { prefix?: boolean } = {},
): string {
  const { recordDigest: _, ...projection } = verdict as ReviewerVerdict;
  return hashCanonical(
    {
      domain: "resin/reviewer-verdict/v1",
      comments: projection.comments,
      dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
      findings: projection.findings,
      intentDigest: normalizeSha256(projection.intentDigest, false),
      noGeneratorHistory: projection.noGeneratorHistory,
      previousRecordDigest: projection.previousRecordDigest
        ? normalizeSha256(projection.previousRecordDigest, false)
        : null,
      rawEvidenceDigest: normalizeSha256(projection.rawEvidenceDigest, false),
      reviewedAt: projection.reviewedAt,
      reviewerId: projection.reviewerId,
      reviewerRole: projection.reviewerRole,
      sequence: projection.sequence,
      sessionId: projection.sessionId,
      sourceDigest: normalizeSha256(projection.sourceDigest, false),
      verdict: projection.verdict,
      verdictId: projection.verdictId,
    },
    options,
  );
}

/**
 * 5. IndependentReplayRecord
 * Independent replay verification asserting reproduction of committed run evidence in a fresh environment.
 */
export const IndependentReplayRecordSchema = z
  .object({
    replayId: IdentifierSchema,
    candidateId: IdentifierSchema,
    targetRunId: IdentifierSchema,
    replayEnvironment: z.string().min(1, "Replay environment cannot be empty"),
    status: z.enum(["passed", "failed"]),
    sourceDigest: NormalizedSha256DigestSchema,
    dependencyDigest: NormalizedSha256DigestSchema,
    intentDigest: NormalizedSha256DigestSchema,
    rawEvidenceDigest: NormalizedSha256DigestSchema,
    outputDigest: NormalizedSha256DigestSchema,
    checkDigest: NormalizedSha256DigestSchema,
    recordDigest: NormalizedSha256DigestSchema,
    durationMs: z.number().nonnegative(),
    completedAt: ISOTimestampSchema,
  })
  .strict();

export type IndependentReplayRecord = z.infer<typeof IndependentReplayRecordSchema>;

/**
 * Computes deterministic canonical digest for IndependentReplayRecord excluding recordDigest.
 */
export function computeIndependentReplayDigest(
  replay: Omit<IndependentReplayRecord, "recordDigest"> | IndependentReplayRecord,
  options: { prefix?: boolean } = {},
): string {
  const { recordDigest: _, ...projection } = replay as IndependentReplayRecord;
  return hashCanonical(
    {
      domain: "resin/independent-replay-record/v1",
      candidateId: projection.candidateId,
      checkDigest: normalizeSha256(projection.checkDigest, false),
      completedAt: projection.completedAt,
      dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
      durationMs: projection.durationMs,
      intentDigest: normalizeSha256(projection.intentDigest, false),
      outputDigest: normalizeSha256(projection.outputDigest, false),
      rawEvidenceDigest: normalizeSha256(projection.rawEvidenceDigest, false),
      replayEnvironment: projection.replayEnvironment,
      replayId: projection.replayId,
      sourceDigest: normalizeSha256(projection.sourceDigest, false),
      status: projection.status,
      targetRunId: projection.targetRunId,
    },
    options,
  );
}

/**
 * Approval Signature Schema.
 */
export const ApprovalSignatureSchema = z
  .object({
    keyId: z.string().min(1, "keyId cannot be empty"),
    algorithm: z.literal("ed25519"),
    signature: z.string().min(1, "signature cannot be empty"),
    signedDigest: NormalizedSha256DigestSchema,
  })
  .strict();

export type ApprovalSignature = z.infer<typeof ApprovalSignatureSchema>;

/**
 * 6. ToolQualificationApproval
 * Signed approval record binding the bundle digests and cryptographic ed25519 signature.
 */
export const ToolQualificationApprovalSchema = z
  .object({
    approvalId: IdentifierSchema,
    approverId: z.string().min(1, "approverId cannot be empty"),
    decision: z.enum(["approved", "rejected"]),
    sourceDigest: NormalizedSha256DigestSchema,
    dependencyDigest: NormalizedSha256DigestSchema,
    intentDigest: NormalizedSha256DigestSchema,
    rawEvidenceDigest: NormalizedSha256DigestSchema,
    artifactBundleDigest: NormalizedSha256DigestSchema,
    approvalDigest: NormalizedSha256DigestSchema,
    signature: ApprovalSignatureSchema,
    signedAt: ISOTimestampSchema,
    comments: z.string().optional(),
  })
  .strict();

export type ToolQualificationApproval = z.infer<typeof ToolQualificationApprovalSchema>;

/**
 * Computes deterministic canonical digest for unsigned ToolQualificationApproval.
 * Excludes approvalDigest and signature.
 */
export function computeApprovalDigest(
  approval:
    | Omit<ToolQualificationApproval, "approvalDigest" | "signature">
    | ToolQualificationApproval,
  options: { prefix?: boolean } = {},
): string {
  const { approvalDigest: _, signature: __, ...projection } = approval as ToolQualificationApproval;
  return hashCanonical(
    {
      domain: "resin/qualification-approval/v1",
      approvalId: projection.approvalId,
      approverId: projection.approverId,
      artifactBundleDigest: normalizeSha256(projection.artifactBundleDigest, false),
      comments: projection.comments,
      decision: projection.decision,
      dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
      intentDigest: normalizeSha256(projection.intentDigest, false),
      rawEvidenceDigest: normalizeSha256(projection.rawEvidenceDigest, false),
      signedAt: projection.signedAt,
      sourceDigest: normalizeSha256(projection.sourceDigest, false),
    },
    options,
  );
}

/**
 * Computes the domain-separated signing payload string that must be signed for ToolQualificationApproval.
 */
export function computeApprovalSigningPayload(
  artifactBundleDigest: string,
  approvalDigest: string,
): string {
  return canonicalJsonStringify({
    domain: "resin/qualification-approval-signature/v1",
    approvalDigest: normalizeSha256(approvalDigest, false),
    artifactBundleDigest: normalizeSha256(artifactBundleDigest, false),
  });
}

/**
 * Raw Bundle Descriptor Schema.
 */
export const RawBundleDescriptorSchema = z
  .object({
    rawBundleDigest: NormalizedSha256DigestSchema,
    uri: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    format: z
      .enum(["js_bundle", "zip", "tar_gz", "embedded", "wasm", "directory"])
      .default("js_bundle"),
  })
  .strict();

export type RawBundleDescriptor = z.infer<typeof RawBundleDescriptorSchema>;

/**
 * Base schema for qualification artifact bundle.
 */
const QualificationArtifactBundleBaseSchema = z
  .object({
    bundleId: IdentifierSchema,
    schemaVersion: z.literal(CURRENT_QUALIFICATION_VERSION),
    candidateId: IdentifierSchema,
    previousBundleDigest: NormalizedSha256DigestSchema.nullable().optional(),
    frozenIntent: FrozenToolIntentSchema,
    rawEvidenceDigest: NormalizedSha256DigestSchema,
    rawBundle: RawBundleDescriptorSchema.optional(),
    runs: z
      .array(QualificationRunRecordSchema)
      .min(2, "Qualification requires at least two qualification runs"),
    reviewers: z
      .array(ReviewerVerdictSchema)
      .min(2, "Qualification requires at least two reviewer verdicts"),
    replay: IndependentReplayRecordSchema,
    approval: ToolQualificationApprovalSchema,
    createdAt: ISOTimestampSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

type QualificationArtifactBundleBase = z.infer<typeof QualificationArtifactBundleBaseSchema>;

/**
 * Computes the deterministic canonical digest for raw evidence
 * (excluding reviewers, replay, and approval to avoid circularity).
 */
export function computeRawEvidenceDigest(
  bundle: {
    schemaVersion: string;
    candidateId: string;
    frozenIntent: FrozenToolIntent;
    runs: QualificationRunRecord[];
    rawBundle?: RawBundleDescriptor;
  },
  options: { prefix?: boolean } = {},
): string {
  return hashCanonical(
    {
      domain: "resin/raw-evidence/v1",
      candidateId: bundle.candidateId,
      frozenIntent: bundle.frozenIntent,
      ...(bundle.rawBundle ? { rawBundle: bundle.rawBundle } : {}),
      runs: bundle.runs,
      schemaVersion: bundle.schemaVersion,
    },
    options,
  );
}

/**
 * Computes the deterministic canonical digest for a qualification bundle content.
 * Excludes the approval object so the bundle can be verified and signed.
 */
export function computeQualificationBundleDigest(
  bundle: Omit<QualificationArtifactBundleBase, "approval"> | QualificationArtifactBundleBase,
  options: { prefix?: boolean } = {},
): string {
  const { approval: _, ...unsignedBundle } = bundle as QualificationArtifactBundleBase;
  return hashCanonical(
    {
      domain: "resin/qualification-bundle/v1",
      bundleId: unsignedBundle.bundleId,
      candidateId: unsignedBundle.candidateId,
      createdAt: unsignedBundle.createdAt,
      frozenIntent: unsignedBundle.frozenIntent,
      metadata: unsignedBundle.metadata,
      previousBundleDigest: unsignedBundle.previousBundleDigest
        ? normalizeSha256(unsignedBundle.previousBundleDigest, false)
        : null,
      rawBundle: unsignedBundle.rawBundle,
      rawEvidenceDigest: normalizeSha256(unsignedBundle.rawEvidenceDigest, false),
      replay: unsignedBundle.replay,
      reviewers: unsignedBundle.reviewers,
      runs: unsignedBundle.runs,
      schemaVersion: unsignedBundle.schemaVersion,
    },
    options,
  );
}

/**
 * Verification issue description for qualification bundle checks.
 */
export interface QualificationIssue {
  code: QualificationErrorCode;
  message: string;
  path?: string[];
}

/**
 * Synchronous key-aware signature verifier function interface.
 */
export type QualificationSignatureVerifier = (params: {
  keyId: string;
  algorithm: "ed25519";
  signature: string;
  payload: string;
  signedDigest: string;
}) => boolean;

/**
 * Options for bundle validation.
 */
export interface ValidateQualificationOptions {
  verifier?: QualificationSignatureVerifier;
}

/**
 * Internal helper to run all qualification invariant checks against bundle data.
 */
export function checkQualificationBundleInvariants(
  bundle: QualificationArtifactBundleBase,
  options?: ValidateQualificationOptions,
): QualificationIssue[] {
  const issues: QualificationIssue[] = [];

  // 1. Schema version and candidate identity binding
  if (bundle.schemaVersion !== CURRENT_QUALIFICATION_VERSION) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Bundle schemaVersion '${bundle.schemaVersion}' does not match expected '${CURRENT_QUALIFICATION_VERSION}'`,
      path: ["schemaVersion"],
    });
  }

  if (bundle.frozenIntent.schemaVersion !== CURRENT_QUALIFICATION_VERSION) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Frozen intent schemaVersion '${bundle.frozenIntent.schemaVersion}' does not match expected '${CURRENT_QUALIFICATION_VERSION}'`,
      path: ["frozenIntent", "schemaVersion"],
    });
  }

  bundle.runs.forEach((run, index) => {
    if (run.candidateId !== bundle.candidateId) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] candidateId '${run.candidateId}' does not match bundle candidateId '${bundle.candidateId}'`,
        path: ["runs", index.toString(), "candidateId"],
      });
    }
  });

  if (bundle.replay.candidateId !== bundle.candidateId) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Replay candidateId '${bundle.replay.candidateId}' does not match bundle candidateId '${bundle.candidateId}'`,
      path: ["replay", "candidateId"],
    });
  }

  // 2. Frozen Intent Digest verification
  const computedIntentDigest = computeFrozenIntentDigest(bundle.frozenIntent);
  if (normalizeSha256(bundle.frozenIntent.intentDigest, false) !== computedIntentDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Frozen intent digest '${bundle.frozenIntent.intentDigest}' does not match computed digest '${computedIntentDigest}'`,
      path: ["frozenIntent", "intentDigest"],
    });
  }

  // 3. Common source, dependency, and intent revisions across all records
  const expectedIntent = normalizeSha256(bundle.frozenIntent.intentDigest, false);
  const expectedSource =
    bundle.runs.length > 0 ? normalizeSha256(bundle.runs[0].sourceDigest, false) : "";
  const expectedDep =
    bundle.runs.length > 0 ? normalizeSha256(bundle.runs[0].dependencyDigest, false) : "";

  bundle.runs.forEach((run, index) => {
    if (normalizeSha256(run.sourceDigest, false) !== expectedSource) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Run[${index}] sourceDigest '${run.sourceDigest}' does not match expected '${expectedSource}'`,
        path: ["runs", index.toString(), "sourceDigest"],
      });
    }
    if (normalizeSha256(run.dependencyDigest, false) !== expectedDep) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Run[${index}] dependencyDigest '${run.dependencyDigest}' does not match expected '${expectedDep}'`,
        path: ["runs", index.toString(), "dependencyDigest"],
      });
    }
    if (normalizeSha256(run.intentDigest, false) !== expectedIntent) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Run[${index}] intentDigest '${run.intentDigest}' does not match frozen intent '${expectedIntent}'`,
        path: ["runs", index.toString(), "intentDigest"],
      });
    }
  });

  bundle.reviewers.forEach((reviewer, index) => {
    if (normalizeSha256(reviewer.sourceDigest, false) !== expectedSource) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Reviewer[${index}] sourceDigest '${reviewer.sourceDigest}' does not match expected '${expectedSource}'`,
        path: ["reviewers", index.toString(), "sourceDigest"],
      });
    }
    if (normalizeSha256(reviewer.dependencyDigest, false) !== expectedDep) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Reviewer[${index}] dependencyDigest '${reviewer.dependencyDigest}' does not match expected '${expectedDep}'`,
        path: ["reviewers", index.toString(), "dependencyDigest"],
      });
    }
    if (normalizeSha256(reviewer.intentDigest, false) !== expectedIntent) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Reviewer[${index}] intentDigest '${reviewer.intentDigest}' does not match frozen intent '${expectedIntent}'`,
        path: ["reviewers", index.toString(), "intentDigest"],
      });
    }
  });

  if (normalizeSha256(bundle.replay.sourceDigest, false) !== expectedSource) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Replay sourceDigest '${bundle.replay.sourceDigest}' does not match expected '${expectedSource}'`,
      path: ["replay", "sourceDigest"],
    });
  }
  if (normalizeSha256(bundle.replay.dependencyDigest, false) !== expectedDep) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Replay dependencyDigest '${bundle.replay.dependencyDigest}' does not match expected '${expectedDep}'`,
      path: ["replay", "dependencyDigest"],
    });
  }
  if (normalizeSha256(bundle.replay.intentDigest, false) !== expectedIntent) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Replay intentDigest '${bundle.replay.intentDigest}' does not match frozen intent '${expectedIntent}'`,
      path: ["replay", "intentDigest"],
    });
  }

  if (normalizeSha256(bundle.approval.sourceDigest, false) !== expectedSource) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Approval sourceDigest '${bundle.approval.sourceDigest}' does not match expected '${expectedSource}'`,
      path: ["approval", "sourceDigest"],
    });
  }
  if (normalizeSha256(bundle.approval.dependencyDigest, false) !== expectedDep) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Approval dependencyDigest '${bundle.approval.dependencyDigest}' does not match expected '${expectedDep}'`,
      path: ["approval", "dependencyDigest"],
    });
  }
  if (normalizeSha256(bundle.approval.intentDigest, false) !== expectedIntent) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Approval intentDigest '${bundle.approval.intentDigest}' does not match frozen intent '${expectedIntent}'`,
      path: ["approval", "intentDigest"],
    });
  }

  // 4. Raw Evidence Digest verification & component consistency
  const computedRawEvidenceDigest = computeRawEvidenceDigest(bundle);
  const expectedRawEvidence = normalizeSha256(bundle.rawEvidenceDigest, false);

  if (expectedRawEvidence !== computedRawEvidenceDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Bundle rawEvidenceDigest '${expectedRawEvidence}' does not match computed raw evidence digest '${computedRawEvidenceDigest}'`,
      path: ["rawEvidenceDigest"],
    });
  }

  bundle.reviewers.forEach((reviewer, index) => {
    if (normalizeSha256(reviewer.rawEvidenceDigest, false) !== expectedRawEvidence) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] rawEvidenceDigest '${reviewer.rawEvidenceDigest}' does not match expected '${expectedRawEvidence}'`,
        path: ["reviewers", index.toString(), "rawEvidenceDigest"],
      });
    }
  });

  if (normalizeSha256(bundle.replay.rawEvidenceDigest, false) !== expectedRawEvidence) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Replay rawEvidenceDigest '${bundle.replay.rawEvidenceDigest}' does not match expected '${expectedRawEvidence}'`,
      path: ["replay", "rawEvidenceDigest"],
    });
  }

  if (normalizeSha256(bundle.approval.rawEvidenceDigest, false) !== expectedRawEvidence) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Approval rawEvidenceDigest '${bundle.approval.rawEvidenceDigest}' does not match expected '${expectedRawEvidence}'`,
      path: ["approval", "rawEvidenceDigest"],
    });
  }

  // 5. Qualification Runs Lineage & Environment Invariants
  const seenRunIds = new Set<string>();
  bundle.runs.forEach((run, index) => {
    if (seenRunIds.has(run.runId)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Duplicate runId '${run.runId}' found at index ${index}`,
        path: ["runs", index.toString(), "runId"],
      });
    }
    seenRunIds.add(run.runId);

    if (run.sequence !== index) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] sequence '${run.sequence}' must be '${index}'`,
        path: ["runs", index.toString(), "sequence"],
      });
    }

    const computedRunDigest = computeQualificationRunDigest(run);
    if (normalizeSha256(run.recordDigest, false) !== computedRunDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] recordDigest '${run.recordDigest}' does not match computed digest '${computedRunDigest}'`,
        path: ["runs", index.toString(), "recordDigest"],
      });
    }

    const expectedPrevDigest =
      index === 0 ? null : normalizeSha256(bundle.runs[index - 1].recordDigest, false);
    const actualPrevDigest = run.previousRecordDigest
      ? normalizeSha256(run.previousRecordDigest, false)
      : null;

    if (actualPrevDigest !== expectedPrevDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] previousRecordDigest '${actualPrevDigest}' does not match prior run digest '${expectedPrevDigest}'`,
        path: ["runs", index.toString(), "previousRecordDigest"],
      });
    }

    const computedProfileDigest = computeObservedEffectProfileDigest(run.observedEffectProfile);
    if (run.observedEffectProfile.profileDigest) {
      if (
        normalizeSha256(run.observedEffectProfile.profileDigest, false) !== computedProfileDigest
      ) {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
          message: `Run[${index}] observedEffectProfile.profileDigest '${run.observedEffectProfile.profileDigest}' does not match computed digest '${computedProfileDigest}'`,
          path: ["runs", index.toString(), "observedEffectProfile", "profileDigest"],
        });
      }
    }

    const expectedEffectDigest = run.observedEffectProfile.profileDigest
      ? normalizeSha256(run.observedEffectProfile.profileDigest, false)
      : computedProfileDigest;
    if (normalizeSha256(run.effectDigest, false) !== expectedEffectDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] effectDigest '${run.effectDigest}' does not match observedEffectProfile.profileDigest '${run.observedEffectProfile.profileDigest ?? computedProfileDigest}'`,
        path: ["runs", index.toString(), "effectDigest"],
      });
    }

    if (run.status === "passed") {
      const axes: Array<keyof Omit<ObservedEffectProfile, "profileDigest" | "determinism">> = [
        "filesRead",
        "filesCreated",
        "filesModified",
        "filesDeleted",
        "processTree",
        "network",
        "environmentVariables",
        "credentials",
        "dependencyChanges",
        "artifacts",
        "validationChecks",
        "resourceEnvelope",
        "consequentialActions",
      ];
      for (const axis of axes) {
        const section = run.observedEffectProfile[axis];
        if (section && section.observation !== "complete") {
          issues.push({
            code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
            message: `Run[${index}] has status 'passed' but observedEffectProfile axis '${axis}' observation is '${section.observation}' (must be 'complete')`,
            path: ["runs", index.toString(), "observedEffectProfile", axis, "observation"],
          });
        }
      }

      if (
        run.observedEffectProfile.validationChecks &&
        run.observedEffectProfile.validationChecks.checks
      ) {
        run.observedEffectProfile.validationChecks.checks.forEach((check, checkIdx) => {
          if (!check.passed) {
            issues.push({
              code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
              message: `Run[${index}] has status 'passed' but validationCheck[${checkIdx}] '${check.checkId}' has passed=false`,
              path: [
                "runs",
                index.toString(),
                "observedEffectProfile",
                "validationChecks",
                "checks",
                checkIdx.toString(),
                "passed",
              ],
            });
          }
        });
      }

      if (run.costs.modelUsageObservation === "unknown") {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
          message: `Run[${index}] has status 'passed' but costs.modelUsageObservation is 'unknown'`,
          path: ["runs", index.toString(), "costs", "modelUsageObservation"],
        });
      }

      if (run.structuredChecks.length === 0) {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
          message: `Run[${index}] has status 'passed' but contains no structured checks`,
          path: ["runs", index.toString(), "structuredChecks"],
        });
      }
      run.structuredChecks.forEach((check, checkIdx) => {
        if (check.status !== "passed") {
          issues.push({
            code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
            message: `Run[${index}] has status 'passed' but structuredCheck[${checkIdx}] '${check.checkId}' has status '${check.status}'`,
            path: ["runs", index.toString(), "structuredChecks", checkIdx.toString(), "status"],
          });
        }
        if (
          check.actualDigest !== undefined &&
          check.expectedDigest !== undefined &&
          normalizeSha256(check.actualDigest, false) !==
            normalizeSha256(check.expectedDigest, false)
        ) {
          issues.push({
            code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
            message: `Run[${index}] structuredCheck[${checkIdx}] '${check.checkId}' actualDigest '${check.actualDigest}' does not match expectedDigest '${check.expectedDigest}'`,
            path: [
              "runs",
              index.toString(),
              "structuredChecks",
              checkIdx.toString(),
              "actualDigest",
            ],
          });
        }
      });

      if (
        run.observedEffectProfile.consequentialActions &&
        run.observedEffectProfile.consequentialActions.actions
      ) {
        run.observedEffectProfile.consequentialActions.actions.forEach((action, actionIdx) => {
          if (!action.authorizationEvidence || action.authorizationEvidence.trim() === "") {
            issues.push({
              code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
              message: `Run[${index}] has status 'passed' but contains unauthorized consequential action '${action.actionType}' on '${action.target}' (missing authorizationEvidence)`,
              path: [
                "runs",
                index.toString(),
                "observedEffectProfile",
                "consequentialActions",
                "actions",
                actionIdx.toString(),
                "authorizationEvidence",
              ],
            });
          }
        });
      }
    }
  });

  const passedRuns = bundle.runs.filter((r) => r.status === "passed");
  if (passedRuns.length < 2) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS,
      message: `Qualification requires at least 2 passed runs, found ${passedRuns.length}`,
      path: ["runs"],
    });
  }

  const distinctEnvs = new Set(passedRuns.map((r) => r.environment));
  if (distinctEnvs.size < 2) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS,
      message: `Qualification requires at least 2 distinct passed environments, found ${distinctEnvs.size} (${Array.from(distinctEnvs).join(", ")})`,
      path: ["runs"],
    });
  }

  // 6. Reviewers Lineage, Independence, Roles & Verdict Invariants
  const seenVerdictIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  const creatorId = bundle.frozenIntent.createdBy;

  bundle.reviewers.forEach((reviewer, index) => {
    if (seenVerdictIds.has(reviewer.verdictId)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Duplicate verdictId '${reviewer.verdictId}' found at index ${index}`,
        path: ["reviewers", index.toString(), "verdictId"],
      });
    }
    seenVerdictIds.add(reviewer.verdictId);

    if (seenSessionIds.has(reviewer.sessionId)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer sessionId '${reviewer.sessionId}' is reused at index ${index}; reviewer sessions must be globally unique`,
        path: ["reviewers", index.toString(), "sessionId"],
      });
    }
    seenSessionIds.add(reviewer.sessionId);

    if (reviewer.sequence !== index) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] sequence '${reviewer.sequence}' must be '${index}'`,
        path: ["reviewers", index.toString(), "sequence"],
      });
    }

    const computedVerdictDigest = computeReviewerVerdictDigest(reviewer);
    if (normalizeSha256(reviewer.recordDigest, false) !== computedVerdictDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] recordDigest '${reviewer.recordDigest}' does not match computed digest '${computedVerdictDigest}'`,
        path: ["reviewers", index.toString(), "recordDigest"],
      });
    }

    const expectedPrevDigest =
      index === 0 ? null : normalizeSha256(bundle.reviewers[index - 1].recordDigest, false);
    const actualPrevDigest = reviewer.previousRecordDigest
      ? normalizeSha256(reviewer.previousRecordDigest, false)
      : null;

    if (actualPrevDigest !== expectedPrevDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] previousRecordDigest '${actualPrevDigest}' does not match prior reviewer digest '${expectedPrevDigest}'`,
        path: ["reviewers", index.toString(), "previousRecordDigest"],
      });
    }

    if (reviewer.reviewerId === creatorId) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer[${index}] reviewerId '${reviewer.reviewerId}' cannot equal frozenIntent createdBy '${creatorId}'`,
        path: ["reviewers", index.toString(), "reviewerId"],
      });
    }

    if (reviewer.noGeneratorHistory !== true) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer[${index}] must explicitly declare noGeneratorHistory: true`,
        path: ["reviewers", index.toString(), "noGeneratorHistory"],
      });
    }
  });

  const correctnessReviews = bundle.reviewers.filter(
    (r) => r.reviewerRole === "correctness-usefulness",
  );
  if (correctnessReviews.length === 0) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS,
      message: "Qualification requires at least one correctness-usefulness reviewer verdict",
      path: ["reviewers"],
    });
  } else {
    const passedCorrectness = correctnessReviews.some((r) => r.verdict === "approved");
    if (!passedCorrectness) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED,
        message: "correctness-usefulness reviewer verdict must be approved",
        path: ["reviewers"],
      });
    }
  }

  const adversarialReviews = bundle.reviewers.filter(
    (r) => r.reviewerRole === "adversarial-safety",
  );
  if (adversarialReviews.length === 0) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS,
      message: "Qualification requires at least one adversarial-safety reviewer verdict",
      path: ["reviewers"],
    });
  } else {
    const passedAdversarial = adversarialReviews.some((r) => r.verdict === "approved");
    if (!passedAdversarial) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED,
        message: "adversarial-safety reviewer verdict must be approved",
        path: ["reviewers"],
      });
    }
  }

  // Ensure reviewer identities and sessions across required roles are independent
  if (correctnessReviews.length > 0 && adversarialReviews.length > 0) {
    const correctnessReviewerIds = new Set(correctnessReviews.map((r) => r.reviewerId));
    const adversarialReviewerIds = new Set(adversarialReviews.map((r) => r.reviewerId));

    const reviewerIntersection = [...correctnessReviewerIds].filter((id) =>
      adversarialReviewerIds.has(id),
    );
    if (reviewerIntersection.length > 0) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer identity '${reviewerIntersection.join(", ")}' cannot serve as both correctness-usefulness and adversarial-safety reviewer`,
        path: ["reviewers"],
      });
    }

    const correctnessSessionIds = new Set(correctnessReviews.map((r) => r.sessionId));
    const adversarialSessionIds = new Set(adversarialReviews.map((r) => r.sessionId));

    const sessionIntersection = [...correctnessSessionIds].filter((id) =>
      adversarialSessionIds.has(id),
    );
    if (sessionIntersection.length > 0) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer session '${sessionIntersection.join(", ")}' cannot be reused across correctness-usefulness and adversarial-safety reviewer roles`,
        path: ["reviewers"],
      });
    }
  }

  // 7. Independent Replay Verification
  const computedReplayDigest = computeIndependentReplayDigest(bundle.replay);
  if (normalizeSha256(bundle.replay.recordDigest, false) !== computedReplayDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Replay recordDigest '${bundle.replay.recordDigest}' does not match computed digest '${computedReplayDigest}'`,
      path: ["replay", "recordDigest"],
    });
  }

  if (bundle.replay.status !== "passed") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
      message: `Independent replay status must be 'passed', found '${bundle.replay.status}'`,
      path: ["replay", "status"],
    });
  }

  const targetRun = bundle.runs.find((r) => r.runId === bundle.replay.targetRunId);
  if (!targetRun) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
      message: `Independent replay targetRunId '${bundle.replay.targetRunId}' not found in bundle runs`,
      path: ["replay", "targetRunId"],
    });
  } else {
    if (targetRun.status !== "passed") {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Independent replay target run '${targetRun.runId}' did not pass (status: '${targetRun.status}')`,
        path: ["replay", "targetRunId"],
      });
    }

    if (bundle.replay.replayEnvironment === targetRun.environment) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS,
        message: `Independent replay environment '${bundle.replay.replayEnvironment}' must be fresh and distinct from target run environment '${targetRun.environment}'`,
        path: ["replay", "replayEnvironment"],
      });
    }

    if (
      normalizeSha256(bundle.replay.outputDigest, false) !==
      normalizeSha256(targetRun.outputDigest, false)
    ) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Independent replay output digest '${bundle.replay.outputDigest}' does not match target run output digest '${targetRun.outputDigest}'`,
        path: ["replay", "outputDigest"],
      });
    }

    if (
      normalizeSha256(bundle.replay.checkDigest, false) !==
      normalizeSha256(targetRun.checkDigest, false)
    ) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Independent replay check digest '${bundle.replay.checkDigest}' does not match target run check digest '${targetRun.checkDigest}'`,
        path: ["replay", "checkDigest"],
      });
    }
  }

  // 8. Tool Qualification Approval & Cryptographic Signature
  if (bundle.approval.decision !== "approved") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval decision must be 'approved', found '${bundle.approval.decision}'`,
      path: ["approval", "decision"],
    });
  } else {
    bundle.runs.forEach((run, index) => {
      if (run.status !== "passed") {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
          message: `Bundle approval decision is 'approved' but run[${index}] has status '${run.status}' (failed/incomplete runs cannot be approved)`,
          path: ["approval", "decision"],
        });
      }
    });
    if (bundle.replay.status !== "passed") {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Bundle approval decision is 'approved' but replay status is '${bundle.replay.status}'`,
        path: ["replay", "status"],
      });
    }
  }
  const computedArtifactBundleDigest = computeQualificationBundleDigest(bundle);
  if (
    normalizeSha256(bundle.approval.artifactBundleDigest, false) !== computedArtifactBundleDigest
  ) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval artifactBundleDigest '${bundle.approval.artifactBundleDigest}' does not match computed bundle digest '${computedArtifactBundleDigest}'`,
      path: ["approval", "artifactBundleDigest"],
    });
  }

  const computedApprovalDigest = computeApprovalDigest(bundle.approval);
  if (normalizeSha256(bundle.approval.approvalDigest, false) !== computedApprovalDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval approvalDigest '${bundle.approval.approvalDigest}' does not match computed approval digest '${computedApprovalDigest}'`,
      path: ["approval", "approvalDigest"],
    });
  }

  const normalizedSignedDigest = normalizeSha256(bundle.approval.signature.signedDigest, false);
  if (
    normalizedSignedDigest !== computedArtifactBundleDigest &&
    normalizedSignedDigest !== computedApprovalDigest
  ) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval signature signedDigest '${bundle.approval.signature.signedDigest}' must bind to artifactBundleDigest '${computedArtifactBundleDigest}' or approvalDigest '${computedApprovalDigest}'`,
      path: ["approval", "signature", "signedDigest"],
    });
  }

  if (bundle.approval.signature.algorithm !== "ed25519") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
      message: `Unsupported signature algorithm '${bundle.approval.signature.algorithm}', only 'ed25519' is supported`,
      path: ["approval", "signature", "algorithm"],
    });
  }

  if (!bundle.approval.signature.signature || bundle.approval.signature.signature.trim() === "") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
      message: "Approval signature is empty or whitespace",
      path: ["approval", "signature", "signature"],
    });
  }

  if (!bundle.approval.signature.keyId || bundle.approval.signature.keyId.trim() === "") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
      message: "Approval keyId is empty or whitespace",
      path: ["approval", "signature", "keyId"],
    });
  }

  // Cryptographic signature verification with injected verifier
  if (options?.verifier) {
    try {
      const signingPayload = computeApprovalSigningPayload(
        computedArtifactBundleDigest,
        computedApprovalDigest,
      );
      const isSigValid = options.verifier({
        keyId: bundle.approval.signature.keyId,
        algorithm: bundle.approval.signature.algorithm,
        signature: bundle.approval.signature.signature,
        payload: signingPayload,
        signedDigest: normalizedSignedDigest,
      });

      if (!isSigValid) {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
          message: "Cryptographic signature verification failed for approval",
          path: ["approval", "signature"],
        });
      }
    } catch (err) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
        message: `Signature verification threw an error: ${err instanceof Error ? err.message : String(err)}`,
        path: ["approval", "signature"],
      });
    }
  }

  return issues;
}

/**
 * 7. QualificationArtifactBundle
 * Strict refined schema for complete qualification artifact bundle.
 * Enforces all creation-time qualification contracts and invariant relationships.
 */
export const QualificationArtifactBundleSchema = QualificationArtifactBundleBaseSchema.superRefine(
  (data, ctx) => {
    const issues = checkQualificationBundleInvariants(data);
    for (const issue of issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `[${issue.code}] ${issue.message}`,
        params: { code: issue.code },
        path: issue.path ?? [],
      });
    }
  },
);

export type QualificationArtifactBundle = z.infer<typeof QualificationArtifactBundleSchema>;

/**
 * Detailed validation result from validateQualificationBundle.
 */
export interface QualificationValidationResult {
  valid: boolean;
  bundle?: QualificationArtifactBundle;
  issues: QualificationIssue[];
  errorCodes: QualificationErrorCode[];
}

/**
 * Validates any candidate qualification artifact bundle structure and invariants.
 */
export function validateQualificationBundle(
  data: unknown,
  options?: ValidateQualificationOptions,
): QualificationValidationResult {
  const parseResult = QualificationArtifactBundleBaseSchema.safeParse(data);
  if (!parseResult.success) {
    const issues: QualificationIssue[] = parseResult.error.issues.map((issue) => {
      let code: QualificationErrorCode = QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH;
      const messageLower = issue.message.toLowerCase();

      if (
        issue.path.includes("noGeneratorHistory") ||
        messageLower.includes("generator") ||
        messageLower.includes("nogeneratorhistory")
      ) {
        code = QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE;
      } else if (issue.path.includes("reviewers")) {
        if (issue.path.includes("verdict")) {
          code = QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED;
        } else if (
          issue.path.includes("sourceDigest") ||
          issue.path.includes("dependencyDigest") ||
          issue.path.includes("intentDigest")
        ) {
          code = QUALIFICATION_ERROR_CODES.MIXED_REVISIONS;
        } else if (issue.path.includes("reviewerRole")) {
          code = QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS;
        } else {
          code = QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH;
        }
      } else if (issue.path.includes("runs")) {
        if (
          issue.path.length === 1 &&
          (issue.code === "too_small" || messageLower.includes("at least two"))
        ) {
          code = QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS;
        } else if (
          issue.path.includes("sourceDigest") ||
          issue.path.includes("dependencyDigest") ||
          issue.path.includes("intentDigest")
        ) {
          code = QUALIFICATION_ERROR_CODES.MIXED_REVISIONS;
        } else {
          code = QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH;
        }
      } else if (issue.path.includes("replay")) {
        if (
          issue.path.includes("sourceDigest") ||
          issue.path.includes("dependencyDigest") ||
          issue.path.includes("intentDigest")
        ) {
          code = QUALIFICATION_ERROR_CODES.MIXED_REVISIONS;
        } else {
          code = QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH;
        }
      } else if (issue.path.includes("signature")) {
        if (issue.path.includes("signedDigest")) {
          code = QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH;
        } else {
          code = QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE;
        }
      } else if (issue.path.includes("approval")) {
        if (
          issue.path.includes("sourceDigest") ||
          issue.path.includes("dependencyDigest") ||
          issue.path.includes("intentDigest")
        ) {
          code = QUALIFICATION_ERROR_CODES.MIXED_REVISIONS;
        } else {
          code = QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH;
        }
      } else if (issue.path.includes("schemaVersion")) {
        code = QUALIFICATION_ERROR_CODES.MIXED_REVISIONS;
      } else {
        code = QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH;
      }

      return {
        code,
        message: issue.message,
        path: issue.path.map(String),
      };
    });

    return {
      valid: false,
      issues,
      errorCodes: Array.from(new Set(issues.map((i) => i.code))),
    };
  }

  const invariantIssues = checkQualificationBundleInvariants(parseResult.data, options);
  if (invariantIssues.length > 0) {
    return {
      valid: false,
      issues: invariantIssues,
      errorCodes: Array.from(new Set(invariantIssues.map((i) => i.code))),
    };
  }

  return {
    valid: true,
    bundle: parseResult.data as QualificationArtifactBundle,
    issues: [],
    errorCodes: [],
  };
}

/**
 * Asserts that a value is a valid QualificationArtifactBundle, throwing an error if invalid.
 */
export function assertValidQualificationBundle(
  data: unknown,
  options?: ValidateQualificationOptions,
): asserts data is QualificationArtifactBundle {
  const result = validateQualificationBundle(data, options);
  if (!result.valid) {
    const errorDetails = result.issues.map((i) => `[${i.code}] ${i.message}`).join("; ");
    throw new Error(`Qualification bundle validation failed: ${errorDetails}`);
  }
}

/**
 * Type guard for QualificationArtifactBundle.
 */
export function isQualificationArtifactBundle(
  data: unknown,
  options?: ValidateQualificationOptions,
): data is QualificationArtifactBundle {
  return validateQualificationBundle(data, options).valid;
}
