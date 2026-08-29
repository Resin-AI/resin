import { describe, expect, it } from "vitest";
import {
  CURRENT_QUALIFICATION_VERSION,
  type FrozenToolIntent,
  FrozenToolIntentSchema,
  type IndependentReplayRecord,
  IndependentReplayRecordSchema,
  NormalizedSha256DigestSchema,
  type ObservedEffectProfile,
  ObservedEffectProfileSchema,
  QUALIFICATION_ERROR_CODES,
  type QualificationArtifactBundle,
  QualificationArtifactBundleSchema,
  type QualificationCosts,
  QualificationCostsSchema,
  type QualificationRunRecord,
  QualificationRunRecordSchema,
  type QualificationSignatureVerifier,
  type ReviewerVerdict,
  ReviewerVerdictSchema,
  type ToolQualificationApproval,
  ToolQualificationApprovalSchema,
  assertValidQualificationBundle,
  computeApprovalDigest,
  computeApprovalSigningPayload,
  computeFrozenIntentDigest,
  computeIndependentReplayDigest,
  computeObservedEffectProfileDigest,
  computeQualificationBundleDigest,
  computeQualificationRunDigest,
  computeRawEvidenceDigest,
  computeReviewerVerdictDigest,
  isQualificationArtifactBundle,
  validateQualificationBundle,
} from "../src/index.js";

// Canonical SHA-256 fixture digests
const VALID_SOURCE_DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_DEP_DIGEST = "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_SCHEMA_DIGEST = "c0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_ENV_DIGEST_1 = "c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_ENV_DIGEST_2 = "c2b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_INPUT_DIGEST = "d1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_TRACE_DIGEST = "e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_STATE_DIGEST_1 = "f1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_STATE_DIGEST_2 = "f2b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_OUTPUT_DIGEST = "11b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_CHECK_DIGEST = "21b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_ARTIFACT_DIGEST = "41b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VALID_INTENT_DIGEST = "31b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/**
 * Creates a deterministic, strictly valid ObservedEffectProfile.
 */
function createValidObservedEffectProfile(
  overrides: Partial<ObservedEffectProfile> = {},
): ObservedEffectProfile {
  const baseProfile = {
    filesRead: { observation: "complete" as const, paths: ["/tmp/input.txt"] },
    filesCreated: { observation: "complete" as const, paths: ["/tmp/output.txt"] },
    filesModified: { observation: "complete" as const, paths: [] },
    filesDeleted: { observation: "complete" as const, paths: [] },
    processTree: { observation: "complete" as const, spawnedProcesses: [] },
    network: { observation: "complete" as const, destinations: [], methods: [] },
    environmentVariables: { observation: "complete" as const, names: [] },
    credentials: { observation: "complete" as const, names: [] },
    dependencyChanges: { observation: "complete" as const, changes: [] },
    artifacts: {
      observation: "complete" as const,
      items: [{ name: "output.bin", digest: VALID_ARTIFACT_DIGEST }],
    },
    validationChecks: {
      observation: "complete" as const,
      checks: [{ checkId: "chk-1", name: "syntax-check", passed: true }],
    },
    resourceEnvelope: {
      observation: "complete" as const,
      maxMemoryBytes: 1048576,
      cpuTimeMs: 120,
      wallDurationMs: 150,
    },
    consequentialActions: { observation: "complete" as const, actions: [] },
    determinism: "deterministic" as const,
    ...overrides,
  };

  // SAFETY: baseProfile fulfills all required ObservedEffectProfile fields before computing digest.
  const profileDigest = computeObservedEffectProfileDigest(baseProfile as ObservedEffectProfile);
  return {
    // SAFETY: baseProfile combined with computed digest conforms to ObservedEffectProfile.
    ...(baseProfile as ObservedEffectProfile),
    profileDigest,
  };
}

/**
 * Creates a deterministic injected ed25519 signature verifier stub.
 */
function createDeterministicMockVerifier(
  expectedKeyId = "ed25519-key-01",
  expectedSignature = "deterministic-mock-signature-base64",
): QualificationSignatureVerifier {
  return ({ keyId, algorithm, signature, payload, signedDigest }) => {
    if (algorithm !== "ed25519") return false;
    if (keyId !== expectedKeyId) return false;
    if (signature !== expectedSignature) return false;
    if (!payload || !signedDigest) return false;
    return true;
  };
}

/**
 * Creates a deterministic, 100% valid QualificationArtifactBundle.
 */
function createValidQualificationBundle(
  customizer?: (builder: Omit<QualificationArtifactBundle, "approval">) => void,
): QualificationArtifactBundle {
  const candidateId = "cand-evolution-001";
  const schemaVersion: typeof CURRENT_QUALIFICATION_VERSION = CURRENT_QUALIFICATION_VERSION;

  // 1. Frozen Tool Intent (pre-generation specification only)
  const rawIntent: Omit<FrozenToolIntent, "intentDigest"> = {
    intentId: "intent-001",
    schemaVersion,
    goal: "Implement deterministic text transformation tool",
    successCriteria: [
      "Must normalize whitespace deterministically",
      "Must reject invalid UTF-8 without crashing",
    ],
    inputSchemaDigest: VALID_SCHEMA_DIGEST,
    constraints: ["No network access", "No subprocess execution"],
    createdAt: "2026-08-20T10:00:00.000Z",
    createdBy: "generator-agent-01",
  };
  const intentDigest = computeFrozenIntentDigest(rawIntent);
  const frozenIntent: FrozenToolIntent = {
    ...rawIntent,
    intentDigest,
  };

  const effectProfile = createValidObservedEffectProfile();

  // 2. Finalized run records and chain digests in forward order (no rawEvidenceDigest in runs)
  const run0Raw: Omit<QualificationRunRecord, "recordDigest"> = {
    runId: "run-001",
    sequence: 0,
    candidateId,
    environment: "linux-x64-node20",
    status: "passed",
    sourceDigest: VALID_SOURCE_DIGEST,
    dependencyDigest: VALID_DEP_DIGEST,
    intentDigest,
    environmentDigest: VALID_ENV_DIGEST_1,
    inputDigest: VALID_INPUT_DIGEST,
    traceDigest: VALID_TRACE_DIGEST,
    beforeStateDigest: VALID_STATE_DIGEST_1,
    afterStateDigest: VALID_STATE_DIGEST_2,
    outputDigest: VALID_OUTPUT_DIGEST,
    checkDigest: VALID_CHECK_DIGEST,
    effectDigest: effectProfile.profileDigest!,
    observedEffectProfile: effectProfile,
    structuredChecks: [
      {
        checkId: "chk-1",
        name: "unit-tests",
        status: "passed",
        message: "12/12 passed",
      },
      {
        checkId: "chk-2",
        name: "property-tests",
        status: "passed",
        message: "100/100 passed",
      },
    ],
    costs: {
      modelUsageObservation: "complete" as const,
      inputTokens: 1200,
      outputTokens: 450,
      cacheReadTokens: 0,
      costUsd: 0.0045,
    },
    previousRecordDigest: null,
    logsUri: "file:///evidence/runs/run-001.log",
    startedAt: "2026-08-20T10:01:00.000Z",
    completedAt: "2026-08-20T10:01:02.000Z",
  };
  const run0Digest = computeQualificationRunDigest(run0Raw);
  const finalRun0: QualificationRunRecord = {
    ...run0Raw,
    recordDigest: run0Digest,
  };

  const run1Raw: Omit<QualificationRunRecord, "recordDigest"> = {
    runId: "run-002",
    sequence: 1,
    candidateId,
    environment: "darwin-arm64-node20",
    status: "passed",
    sourceDigest: VALID_SOURCE_DIGEST,
    dependencyDigest: VALID_DEP_DIGEST,
    intentDigest,
    environmentDigest: VALID_ENV_DIGEST_2,
    inputDigest: VALID_INPUT_DIGEST,
    traceDigest: VALID_TRACE_DIGEST,
    beforeStateDigest: VALID_STATE_DIGEST_1,
    afterStateDigest: VALID_STATE_DIGEST_2,
    outputDigest: VALID_OUTPUT_DIGEST,
    checkDigest: VALID_CHECK_DIGEST,
    effectDigest: effectProfile.profileDigest!,
    observedEffectProfile: effectProfile,
    structuredChecks: [
      {
        checkId: "chk-1",
        name: "unit-tests",
        status: "passed",
        message: "12/12 passed",
      },
      {
        checkId: "chk-2",
        name: "property-tests",
        status: "passed",
        message: "100/100 passed",
      },
    ],
    costs: {
      modelUsageObservation: "complete" as const,
      inputTokens: 1100,
      outputTokens: 420,
      cacheReadTokens: 0,
      costUsd: 0.0041,
    },
    previousRecordDigest: run0Digest,
    logsUri: "file:///evidence/runs/run-002.log",
    startedAt: "2026-08-20T10:01:05.000Z",
    completedAt: "2026-08-20T10:01:07.000Z",
  };
  const run1Digest = computeQualificationRunDigest(run1Raw);
  const finalRun1: QualificationRunRecord = {
    ...run1Raw,
    recordDigest: run1Digest,
  };

  const runs: QualificationRunRecord[] = [finalRun0, finalRun1];

  // 3. Compute raw evidence digest from finalized runs, frozenIntent, and candidate
  const rawEvidenceDigest = computeRawEvidenceDigest({
    schemaVersion,
    candidateId,
    frozenIntent,
    runs,
  });
  // 4. Reviewer verdicts
  const reviewer0Raw: Omit<ReviewerVerdict, "recordDigest"> = {
    verdictId: "verdict-001",
    sequence: 0,
    sessionId: "sess-review-001",
    reviewerId: "reviewer-correctness-agent",
    reviewerRole: "correctness-usefulness",
    verdict: "approved",
    noGeneratorHistory: true,
    sourceDigest: VALID_SOURCE_DIGEST,
    dependencyDigest: VALID_DEP_DIGEST,
    intentDigest,
    rawEvidenceDigest,
    findings: [],
    comments: "Correctness verified against specification",
    previousRecordDigest: null,
    reviewedAt: "2026-08-20T10:05:00.000Z",
  };
  const reviewer0Digest = computeReviewerVerdictDigest(reviewer0Raw);
  const reviewer0: ReviewerVerdict = { ...reviewer0Raw, recordDigest: reviewer0Digest };

  const reviewer1Raw: Omit<ReviewerVerdict, "recordDigest"> = {
    verdictId: "verdict-002",
    sequence: 1,
    sessionId: "sess-review-002",
    reviewerId: "reviewer-safety-agent",
    reviewerRole: "adversarial-safety",
    verdict: "approved",
    noGeneratorHistory: true,
    sourceDigest: VALID_SOURCE_DIGEST,
    dependencyDigest: VALID_DEP_DIGEST,
    intentDigest,
    rawEvidenceDigest,
    findings: [],
    comments: "Adversarial safety audit passed without issues",
    previousRecordDigest: reviewer0Digest,
    reviewedAt: "2026-08-20T10:06:00.000Z",
  };
  const reviewer1Digest = computeReviewerVerdictDigest(reviewer1Raw);
  const reviewer1: ReviewerVerdict = { ...reviewer1Raw, recordDigest: reviewer1Digest };

  const reviewers: ReviewerVerdict[] = [reviewer0, reviewer1];

  // 5. Independent Replay Record
  const replayRaw: Omit<IndependentReplayRecord, "recordDigest"> = {
    replayId: "replay-001",
    candidateId,
    targetRunId: "run-001",
    replayEnvironment: "isolated-replay-sandbox-node20",
    status: "passed",
    sourceDigest: VALID_SOURCE_DIGEST,
    dependencyDigest: VALID_DEP_DIGEST,
    intentDigest,
    rawEvidenceDigest,
    outputDigest: VALID_OUTPUT_DIGEST,
    checkDigest: VALID_CHECK_DIGEST,
    durationMs: 1250,
    completedAt: "2026-08-20T10:07:00.000Z",
  };
  const replayDigest = computeIndependentReplayDigest(replayRaw);
  const replay: IndependentReplayRecord = { ...replayRaw, recordDigest: replayDigest };

  if (customizer) {
    customizer({
      bundleId: "bundle-001",
      schemaVersion,
      candidateId,
      previousBundleDigest: null,
      frozenIntent,
      rawEvidenceDigest,
      runs,
      reviewers,
      replay,
      createdAt: "2026-08-20T10:08:00.000Z",
    });
  }
  // 6. Qualification Artifact Bundle (unsigned part)
  const unsignedBundle: Omit<QualificationArtifactBundle, "approval"> = {
    bundleId: "bundle-001",
    schemaVersion,
    candidateId,
    previousBundleDigest: null,
    frozenIntent,
    rawEvidenceDigest,
    runs,
    reviewers,
    replay,
    createdAt: "2026-08-20T10:08:00.000Z",
  };

  const artifactBundleDigest = computeQualificationBundleDigest(unsignedBundle);

  // 7. Tool Qualification Approval
  const approvalRaw: Omit<ToolQualificationApproval, "approvalDigest" | "signature"> = {
    approvalId: "approval-001",
    approverId: "qualification-authority-admin",
    decision: "approved",
    sourceDigest: VALID_SOURCE_DIGEST,
    dependencyDigest: VALID_DEP_DIGEST,
    intentDigest,
    rawEvidenceDigest,
    artifactBundleDigest,
    signedAt: "2026-08-20T10:09:00.000Z",
    comments: "Bundle approved for staging deployment",
  };
  const approvalDigest = computeApprovalDigest(approvalRaw);

  const signature = {
    keyId: "ed25519-key-01",
    algorithm: "ed25519" as const,
    signature: "deterministic-mock-signature-base64",
    signedDigest: artifactBundleDigest,
  };

  const approval: ToolQualificationApproval = {
    ...approvalRaw,
    approvalDigest,
    signature,
  };

  return {
    ...unsignedBundle,
    approval,
  };
}

describe("Hardened Qualification Contracts", () => {
  describe("1. Canonical Public Records & Strict Schemas", () => {
    it("parses valid FrozenToolIntent and rejects unknown/extra properties", () => {
      const intent = createValidQualificationBundle().frozenIntent;
      const parsed = FrozenToolIntentSchema.parse(intent);
      expect(parsed.intentId).toBe("intent-001");
      expect(parsed.schemaVersion).toBe(CURRENT_QUALIFICATION_VERSION);
      expect(parsed.goal).toBe("Implement deterministic text transformation tool");
      expect(parsed.successCriteria.length).toBe(2);

      // Strictness: unknown keys must be rejected
      expect(() =>
        FrozenToolIntentSchema.parse({
          ...intent,
          unknownField: "forbidden",
        }),
      ).toThrow();
    });

    it("forbids post-generation fields in FrozenToolIntent", () => {
      const intent = createValidQualificationBundle().frozenIntent;

      // candidateId is forbidden in FrozenToolIntent
      expect(() =>
        FrozenToolIntentSchema.parse({
          ...intent,
          candidateId: "cand-42",
        }),
      ).toThrow();

      // sourceDigest is forbidden in FrozenToolIntent
      expect(() =>
        FrozenToolIntentSchema.parse({
          ...intent,
          sourceDigest: VALID_SOURCE_DIGEST,
        }),
      ).toThrow();

      // dependencyDigest is forbidden in FrozenToolIntent
      expect(() =>
        FrozenToolIntentSchema.parse({
          ...intent,
          dependencyDigest: VALID_DEP_DIGEST,
        }),
      ).toThrow();

      // prompt / specification aliases are forbidden in FrozenToolIntent
      expect(() =>
        FrozenToolIntentSchema.parse({
          ...intent,
          prompt: "Legacy prompt field",
        }),
      ).toThrow();
      expect(() =>
        FrozenToolIntentSchema.parse({
          ...intent,
          specification: {},
        }),
      ).toThrow();
    });

    it("proves source, dependency, and candidate do not influence or appear in frozen intent", () => {
      const intent = createValidQualificationBundle().frozenIntent;

      // Intent digest only depends on pre-generation fields
      const digest1 = computeFrozenIntentDigest(intent);

      // Mutating external candidate or source fields on bundle does not alter intent digest
      const bundle = createValidQualificationBundle();
      bundle.candidateId = "cand-mutated-999";
      bundle.runs[0].sourceDigest =
        "9999999999999999999999999999999999999999999999999999999999999999";
      bundle.runs[0].dependencyDigest =
        "8888888888888888888888888888888888888888888888888888888888888888";

      const digest2 = computeFrozenIntentDigest(bundle.frozenIntent);
      expect(digest1).toBe(digest2);
      expect(bundle.frozenIntent).not.toHaveProperty("candidateId");
      expect(bundle.frozenIntent).not.toHaveProperty("sourceDigest");
      expect(bundle.frozenIntent).not.toHaveProperty("dependencyDigest");
    });

    it("parses valid ObservedEffectProfile and rejects misspelled effect axes", () => {
      const profile = createValidObservedEffectProfile();
      const parsed = ObservedEffectProfileSchema.parse(profile);
      expect(parsed.determinism).toBe("deterministic");
      expect(parsed.filesRead.observation).toBe("complete");

      // Strictness: misspelled axis must throw, not be silently stripped
      expect(() =>
        ObservedEffectProfileSchema.parse({
          ...profile,
          subprocessExecuton: true,
        }),
      ).toThrow();
    });

    it("parses valid QualificationRunRecord and rejects unknown keys", () => {
      const run = createValidQualificationBundle().runs[0];
      const parsed = QualificationRunRecordSchema.parse(run);
      expect(parsed.runId).toBe("run-001");
      expect(parsed.status).toBe("passed");

      expect(() =>
        QualificationRunRecordSchema.parse({
          ...run,
          extraField: "not-allowed",
        }),
      ).toThrow();
    });

    it("parses valid QualificationCosts and enforces cost field constraints", () => {
      // Complete model usage observation
      const validComplete: QualificationCosts = {
        modelUsageObservation: "complete",
        inputTokens: 1200,
        outputTokens: 450,
        cacheReadTokens: 0,
        costUsd: 0.0045,
      };
      const parsedComplete = QualificationCostsSchema.parse(validComplete);
      expect(parsedComplete.modelUsageObservation).toBe("complete");
      expect(parsedComplete.inputTokens).toBe(1200);

      // Non-model / not-applicable usage observation
      const validNotApplicable: QualificationCosts = {
        modelUsageObservation: "not-applicable",
      };
      const parsedNotApplicable = QualificationCostsSchema.parse(validNotApplicable);
      expect(parsedNotApplicable.modelUsageObservation).toBe("not-applicable");

      // Strictness: rejects resource envelope fields under costs
      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          wallDurationMs: 1500,
        }),
      ).toThrow();

      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          cpuTimeMs: 120,
        }),
      ).toThrow();

      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          peakMemoryBytes: 1048576,
        }),
      ).toThrow();

      // Strictness: rejects legacy / forbidden fields
      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          totalTokens: 1650,
        }),
      ).toThrow();

      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          modelId: "model-test-v1",
        }),
      ).toThrow();

      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          durationMs: 1500,
        }),
      ).toThrow();

      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          tokenCostUsd: 0.0045,
        }),
      ).toThrow();

      expect(() =>
        QualificationCostsSchema.parse({
          ...validComplete,
          memoryBytes: 1048576,
        }),
      ).toThrow();
    });

    it("parses valid ReviewerVerdict and rejects non-canonical status words", () => {
      const reviewer = createValidQualificationBundle().reviewers[0];
      const parsed = ReviewerVerdictSchema.parse(reviewer);
      expect(parsed.verdict).toBe("approved");
      expect(parsed.noGeneratorHistory).toBe(true);

      // Rejects "passed" as a verdict synonym
      expect(() =>
        ReviewerVerdictSchema.parse({
          ...reviewer,
          verdict: "passed",
        }),
      ).toThrow();

      // Rejects missing or false noGeneratorHistory
      expect(() =>
        ReviewerVerdictSchema.parse({
          ...reviewer,
          noGeneratorHistory: false,
        }),
      ).toThrow();
    });

    it("parses valid IndependentReplayRecord and rejects unknown keys", () => {
      const replay = createValidQualificationBundle().replay;
      const parsed = IndependentReplayRecordSchema.parse(replay);
      expect(parsed.replayId).toBe("replay-001");
      expect(parsed.candidateId).toBe("cand-evolution-001");
      expect(parsed.targetRunId).toBe("run-001");

      expect(() =>
        IndependentReplayRecordSchema.parse({
          ...replay,
          extraKey: 123,
        }),
      ).toThrow();
    });

    it("parses valid ToolQualificationApproval and rejects unsupported algorithms", () => {
      const approval = createValidQualificationBundle().approval;
      const parsed = ToolQualificationApprovalSchema.parse(approval);
      expect(parsed.decision).toBe("approved");
      expect(parsed.signature.algorithm).toBe("ed25519");

      // Algorithm must strictly be ed25519
      expect(() =>
        ToolQualificationApprovalSchema.parse({
          ...approval,
          signature: {
            ...approval.signature,
            algorithm: "none",
          },
        }),
      ).toThrow();
    });

    it("parses valid QualificationArtifactBundle and validates without issues", () => {
      const bundle = createValidQualificationBundle();
      const parsed = QualificationArtifactBundleSchema.parse(bundle);
      expect(parsed.bundleId).toBe("bundle-001");

      const verifier = createDeterministicMockVerifier();
      const result = validateQualificationBundle(bundle, { verifier });
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.errorCodes).toEqual([]);
    });
  });

  describe("Finding 1: Tampered Bundle Digest & Approval Binding", () => {
    it("rejects bundle when run effect profile is tampered but approval.artifactBundleDigest is unchanged", () => {
      const bundle = createValidQualificationBundle();
      // Tamper an internal run property without re-signing or updating artifactBundleDigest
      bundle.runs[0].observedEffectProfile.filesRead.paths.push("/etc/shadow");

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH);
    });

    it("rejects bundle when reviewer findings are tampered", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[0].findings.push("tampered finding");

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH);
    });

    it("rejects bundle when replay record is tampered", () => {
      const bundle = createValidQualificationBundle();
      bundle.replay.durationMs = 999999;

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH);
    });

    it("rejects bundle when passed run has unknown model usage observation", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[0].costs.modelUsageObservation = "unknown";
      bundle.runs[0].recordDigest = computeQualificationRunDigest(bundle.runs[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle when approval.artifactBundleDigest is forged", () => {
      const bundle = createValidQualificationBundle();
      bundle.approval.artifactBundleDigest =
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH);
    });

    it("rejects bundle when approval.approvalDigest is forged", () => {
      const bundle = createValidQualificationBundle();
      bundle.approval.approvalDigest =
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH);
    });

    it("rejects bundle when signature.signedDigest binds to an unverified digest", () => {
      const bundle = createValidQualificationBundle();
      bundle.approval.signature.signedDigest =
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH);
    });
  });

  describe("Finding 2: Replay Binding to Committed Run Evidence", () => {
    it("rejects replay with non-existent targetRunId", () => {
      const bundle = createValidQualificationBundle();
      bundle.replay.targetRunId = "run-nonexistent";
      // Recompute replay digest so recordDigest matches
      bundle.replay.recordDigest = computeIndependentReplayDigest(bundle.replay);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH);
    });

    it("rejects replay targeting a failed run", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[0].status = "failed";
      bundle.runs[0].recordDigest = computeQualificationRunDigest(bundle.runs[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH);
    });

    it("rejects replay when outputDigest does not match target run outputDigest", () => {
      const bundle = createValidQualificationBundle();
      bundle.replay.outputDigest =
        "9999999999999999999999999999999999999999999999999999999999999999";
      bundle.replay.recordDigest = computeIndependentReplayDigest(bundle.replay);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH);
    });

    it("rejects replay when checkDigest does not match target run checkDigest", () => {
      const bundle = createValidQualificationBundle();
      bundle.replay.checkDigest =
        "8888888888888888888888888888888888888888888888888888888888888888";
      bundle.replay.recordDigest = computeIndependentReplayDigest(bundle.replay);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH);
    });

    it("rejects replay with status 'failed'", () => {
      const bundle = createValidQualificationBundle();
      bundle.replay.status = "failed";
      bundle.replay.recordDigest = computeIndependentReplayDigest(bundle.replay);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH);
    });

    it("rejects replay when replayEnvironment is not fresh/distinct from target run environment", () => {
      const bundle = createValidQualificationBundle();
      bundle.replay.replayEnvironment = bundle.runs[0].environment;
      bundle.replay.recordDigest = computeIndependentReplayDigest(bundle.replay);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS);
    });
  });

  describe("Finding 3: Strict Unknown & Misspelled Effect Axes", () => {
    it("rejects misspelled effect axes through schema strictness", () => {
      const profile = createValidObservedEffectProfile();
      const malformedProfile = {
        ...profile,
        filesCreatedd: { observation: "complete", paths: [] },
      };

      expect(() => ObservedEffectProfileSchema.parse(malformedProfile)).toThrow();
    });

    it("rejects omitted effect axes without defaults", () => {
      const profile = createValidObservedEffectProfile();
      const { processTree: _, ...omittedProfile } = profile;

      expect(() => ObservedEffectProfileSchema.parse(omittedProfile)).toThrow();
    });

    it("accepts explicit unknown observation status on unobserved axes", () => {
      const profile = createValidObservedEffectProfile({
        processTree: { observation: "unknown", spawnedProcesses: [] },
        network: { observation: "unknown", destinations: [], methods: [] },
      });

      const parsed = ObservedEffectProfileSchema.parse(profile);
      expect(parsed.processTree.observation).toBe("unknown");
      expect(parsed.network.observation).toBe("unknown");
    });
  });

  describe("Finding 4: Mandatory Blind-Review Literal & Alias Removal", () => {
    it("rejects reviewer verdict with noGeneratorHistory: false", () => {
      const reviewer = createValidQualificationBundle().reviewers[0];
      const invalid = {
        ...reviewer,
        noGeneratorHistory: false,
      };

      const result = validateQualificationBundle({
        ...createValidQualificationBundle(),
        reviewers: [invalid, createValidQualificationBundle().reviewers[1]],
      });
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE);
    });

    it("rejects prohibited compatibility aliases like historyContext", () => {
      const reviewer = createValidQualificationBundle().reviewers[0];
      const withAlias = {
        ...reviewer,
        historyContext: "blind",
      };

      expect(() => ReviewerVerdictSchema.parse(withAlias)).toThrow();
    });
  });

  describe("Finding 5: Recomputed Frozen Intent & Profile Digests", () => {
    it("rejects bundle when frozen intent goal is tampered with unchanged intentDigest", () => {
      const bundle = createValidQualificationBundle();
      bundle.frozenIntent.goal = "Malicious altered goal";

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle when frozen intent successCriteria are tampered", () => {
      const bundle = createValidQualificationBundle();
      bundle.frozenIntent.successCriteria = ["Altered success criteria"];

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle when run observedEffectProfile.profileDigest is mismatched", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[0].observedEffectProfile.profileDigest =
        "7777777777777777777777777777777777777777777777777777777777777777";
      bundle.runs[0].recordDigest = computeQualificationRunDigest(bundle.runs[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });
  });

  describe("Finding 6: Candidate & Schema Version Revision Mismatches", () => {
    it("rejects bundle when run.candidateId does not match bundle.candidateId", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[0].candidateId = "cand-different-42";
      bundle.runs[0].recordDigest = computeQualificationRunDigest(bundle.runs[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle when bundle schemaVersion does not match current version literal", () => {
      const bundle = createValidQualificationBundle();
      const invalidVersionBundle = {
        ...bundle,
        schemaVersion: "2.0.0",
      };

      const result = validateQualificationBundle(invalidVersionBundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.MIXED_REVISIONS);
    });

    it("rejects bundle when frozenIntent schemaVersion does not match current version literal", () => {
      const bundle = createValidQualificationBundle();
      const invalidVersionBundle = {
        ...bundle,
        frozenIntent: {
          ...bundle.frozenIntent,
          schemaVersion: "0.9.0",
        },
      };

      const result = validateQualificationBundle(invalidVersionBundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.MIXED_REVISIONS);
    });
  });

  describe("Finding 7: Distinct Reviewer Identities & Generator Exclusion", () => {
    it("rejects bundle when same reviewerId performs both correctness and safety reviews", () => {
      const bundle = createValidQualificationBundle();
      const sharedReviewerId = "reviewer-single-agent";
      bundle.reviewers[0].reviewerId = sharedReviewerId;
      bundle.reviewers[0].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[0]);

      bundle.reviewers[1].reviewerId = sharedReviewerId;
      bundle.reviewers[1].previousRecordDigest = bundle.reviewers[0].recordDigest;
      bundle.reviewers[1].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE);
    });

    it("rejects bundle when correctness and safety reviews share the same sessionId", () => {
      const bundle = createValidQualificationBundle();
      const sharedSessionId = "sess-shared-review";
      bundle.reviewers[0].sessionId = sharedSessionId;
      bundle.reviewers[0].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[0]);

      bundle.reviewers[1].sessionId = sharedSessionId;
      bundle.reviewers[1].previousRecordDigest = bundle.reviewers[0].recordDigest;
      bundle.reviewers[1].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(
        result.errorCodes.includes(QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE) ||
          result.errorCodes.includes(QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS),
      ).toBe(true);
    });

    it("rejects bundle when reviewerId equals frozenIntent.createdBy", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[0].reviewerId = bundle.frozenIntent.createdBy;
      bundle.reviewers[0].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE);
    });

    it("rejects bundle missing correctness-usefulness reviewer role", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[0].reviewerRole = "adversarial-safety";
      bundle.reviewers[0].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS);
    });

    it("rejects bundle missing adversarial-safety reviewer role", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[1].reviewerRole = "correctness-usefulness";
      bundle.reviewers[1].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS);
    });

    it("rejects bundle when reviewer verdict is rejected", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[0].verdict = "rejected";
      bundle.reviewers[0].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED);
    });
  });

  describe("Finding 8: Unique & Hash-Linked Append-Only Evidence", () => {
    it("rejects bundle with duplicate runId values", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[1].runId = bundle.runs[0].runId;
      bundle.runs[1].recordDigest = computeQualificationRunDigest(bundle.runs[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle with invalid run sequence order", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[1].sequence = 5;
      bundle.runs[1].recordDigest = computeQualificationRunDigest(bundle.runs[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle with broken run previousRecordDigest chain", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[1].previousRecordDigest =
        "1234567890123456789012345678901234567890123456789012345678901234";
      bundle.runs[1].recordDigest = computeQualificationRunDigest(bundle.runs[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle with duplicate reviewer verdictId values", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[1].verdictId = bundle.reviewers[0].verdictId;
      bundle.reviewers[1].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });

    it("rejects bundle with broken reviewer previousRecordDigest chain", () => {
      const bundle = createValidQualificationBundle();
      bundle.reviewers[1].previousRecordDigest =
        "0000000000000000000000000000000000000000000000000000000000000000";
      bundle.reviewers[1].recordDigest = computeReviewerVerdictDigest(bundle.reviewers[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
    });
  });

  describe("Finding 9: No Duplicate Outcome Representations", () => {
    it("rejects redundant passed boolean and synonym status words in ReviewerVerdict", () => {
      const reviewer = createValidQualificationBundle().reviewers[0];

      // Redundant boolean should be rejected by strict schema
      expect(() =>
        ReviewerVerdictSchema.parse({
          ...reviewer,
          passed: true,
        }),
      ).toThrow();

      // Synonym status word should be rejected
      expect(() =>
        ReviewerVerdictSchema.parse({
          ...reviewer,
          verdict: "passed",
        }),
      ).toThrow();
    });

    it("rejects redundant passed boolean in QualificationRunRecord", () => {
      const run = createValidQualificationBundle().runs[0];

      expect(() =>
        QualificationRunRecordSchema.parse({
          ...run,
          passed: true,
        }),
      ).toThrow();
    });

    it("rejects redundant replayMatches boolean in IndependentReplayRecord", () => {
      const replay = createValidQualificationBundle().replay;

      expect(() =>
        IndependentReplayRecordSchema.parse({
          ...replay,
          replayMatches: true,
        }),
      ).toThrow();
    });
  });

  describe("Finding 10: SHA-256 Digest Normalization", () => {
    it("normalizes uppercase and prefixed hex digests at schema boundaries", () => {
      const upperDigest = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";
      const prefixedDigest = `sha256:${VALID_SOURCE_DIGEST}`;

      const parsedUpper = NormalizedSha256DigestSchema.parse(upperDigest);
      const parsedPrefixed = NormalizedSha256DigestSchema.parse(prefixedDigest);

      expect(parsedUpper).toBe(VALID_SOURCE_DIGEST);
      expect(parsedPrefixed).toBe(VALID_SOURCE_DIGEST);
    });

    it("validates bundle with uppercase / prefixed digests without spurious errors", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[0].sourceDigest = VALID_SOURCE_DIGEST.toUpperCase();
      bundle.runs[1].sourceDigest = `sha256:${VALID_SOURCE_DIGEST}`;
      bundle.reviewers[0].sourceDigest = VALID_SOURCE_DIGEST.toUpperCase();
      bundle.reviewers[1].sourceDigest = `sha256:${VALID_SOURCE_DIGEST}`;
      bundle.replay.sourceDigest = VALID_SOURCE_DIGEST.toUpperCase();
      bundle.approval.sourceDigest = `sha256:${VALID_SOURCE_DIGEST.toUpperCase()}`;

      const verifier = createDeterministicMockVerifier();
      const result = validateQualificationBundle(bundle, { verifier });
      expect(result.valid).toBe(true);
      expect(result.errorCodes).toEqual([]);
    });
  });

  describe("Finding 11: Precise Error Code Mapping for Structural Failures", () => {
    it("maps malformed run timestamp to BUNDLE_MISMATCH, not INSUFFICIENT_ENVIRONMENTS", () => {
      const bundle = createValidQualificationBundle();
      const malformedRunBundle = {
        ...bundle,
        runs: [
          {
            ...bundle.runs[0],
            startedAt: "not-a-timestamp",
          },
          bundle.runs[1],
        ],
      };

      const result = validateQualificationBundle(malformedRunBundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
      expect(result.errorCodes).not.toContain(QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS);
    });

    it("maps empty candidateId in run to BUNDLE_MISMATCH", () => {
      const bundle = createValidQualificationBundle();
      const malformedRunBundle = {
        ...bundle,
        runs: [
          {
            ...bundle.runs[0],
            candidateId: "",
          },
          bundle.runs[1],
        ],
      };

      const result = validateQualificationBundle(malformedRunBundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH);
      expect(result.errorCodes).not.toContain(QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS);
    });
  });

  describe("Finding 12: Injected Ed25519 Cryptographic Signature Verification", () => {
    it("validates successfully when injected verifier confirms valid ed25519 signature", () => {
      const bundle = createValidQualificationBundle();
      const verifier = createDeterministicMockVerifier(
        "ed25519-key-01",
        "deterministic-mock-signature-base64",
      );

      const result = validateQualificationBundle(bundle, { verifier });
      expect(result.valid).toBe(true);
      expect(result.errorCodes).toEqual([]);
    });

    it("rejects approval with unsupported algorithm", () => {
      const bundle = createValidQualificationBundle();
      const invalidSigBundle = {
        ...bundle,
        approval: {
          ...bundle.approval,
          signature: {
            ...bundle.approval.signature,
            algorithm: "rsa-sha256" as const,
          },
        },
      };

      const result = validateQualificationBundle(invalidSigBundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE);
    });

    it("rejects approval with empty signature string", () => {
      const bundle = createValidQualificationBundle();
      bundle.approval.signature.signature = "   ";

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE);
    });

    it("rejects approval with empty keyId string", () => {
      const bundle = createValidQualificationBundle();
      bundle.approval.signature.keyId = "";

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE);
    });

    it("rejects approval when injected verifier returns false", () => {
      const bundle = createValidQualificationBundle();
      const failingVerifier: QualificationSignatureVerifier = () => false;

      const result = validateQualificationBundle(bundle, { verifier: failingVerifier });
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE);
    });

    it("rejects approval when injected verifier throws an exception", () => {
      const bundle = createValidQualificationBundle();
      const throwingVerifier: QualificationSignatureVerifier = () => {
        throw new Error("Key store connection error");
      };

      const result = validateQualificationBundle(bundle, { verifier: throwingVerifier });
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE);
    });

    it("passes expected signing payload to the injected verifier", () => {
      const bundle = createValidQualificationBundle();
      let capturedKeyId: string | null = null;
      let capturedAlgorithm: string | null = null;
      let capturedSignature: string | null = null;
      let capturedPayload: string | null = null;

      const capturingVerifier: QualificationSignatureVerifier = (params) => {
        capturedKeyId = params.keyId;
        capturedAlgorithm = params.algorithm;
        capturedSignature = params.signature;
        capturedPayload = params.payload;
        return true;
      };

      const result = validateQualificationBundle(bundle, {
        verifier: capturingVerifier,
      });
      expect(result.valid).toBe(true);
      expect(capturedKeyId).toBe("ed25519-key-01");
      expect(capturedAlgorithm).toBe("ed25519");
      expect(capturedSignature).toBe("deterministic-mock-signature-base64");

      const expectedPayload = computeApprovalSigningPayload(
        bundle.approval.artifactBundleDigest,
        bundle.approval.approvalDigest,
      );
      expect(capturedPayload).toBe(expectedPayload);
    });
  });

  describe("Multi-Environment Coverage & Preserving Failed Attempts", () => {
    it("rejects bundle with fewer than 2 passed runs", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[0].status = "failed";
      bundle.runs[0].recordDigest = computeQualificationRunDigest(bundle.runs[0]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS);
    });

    it("rejects bundle with 2 passed runs on the same environment", () => {
      const bundle = createValidQualificationBundle();
      bundle.runs[1].environment = bundle.runs[0].environment;
      bundle.runs[1].recordDigest = computeQualificationRunDigest(bundle.runs[1]);

      const result = validateQualificationBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.errorCodes).toContain(QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS);
    });

    it("rejects approval attempt over bundle preserving earlier failed runs in sequence lineage", () => {
      const candidateId = "cand-with-failed-attempt";
      const schemaVersion = CURRENT_QUALIFICATION_VERSION;

      const rawIntent: Omit<FrozenToolIntent, "intentDigest"> = {
        intentId: "intent-002",
        schemaVersion,
        goal: "Implement resilient tool",
        successCriteria: ["Must survive and log initial failure"],
        inputSchemaDigest: VALID_SCHEMA_DIGEST,
        constraints: ["Must maintain valid sequence links"],
        createdAt: "2026-08-20T10:00:00.000Z",
        createdBy: "generator-agent-01",
      };
      const intentDigest = computeFrozenIntentDigest(rawIntent);
      const frozenIntent: FrozenToolIntent = { ...rawIntent, intentDigest };

      const effectProfile = createValidObservedEffectProfile();

      // 3 runs: run0 (failed attempt), run1 (passed in env1), run2 (passed in env2)
      const run0Raw: Omit<QualificationRunRecord, "recordDigest"> = {
        runId: "run-failed-001",
        sequence: 0,
        candidateId,
        environment: "linux-x64-node20",
        status: "failed",
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: effectProfile.profileDigest!,
        observedEffectProfile: effectProfile,
        structuredChecks: [
          {
            checkId: "chk-1",
            name: "unit-tests",
            status: "failed",
            message: "Syntax error on line 42",
          },
        ],
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 0,
          costUsd: 0.003,
        },
        previousRecordDigest: null,
        logsUri: "file:///evidence/runs/run-failed-001.log",
        startedAt: "2026-08-20T10:00:10.000Z",
        completedAt: "2026-08-20T10:00:40.000Z",
      };
      const run0Digest = computeQualificationRunDigest(run0Raw);
      const finalRun0: QualificationRunRecord = {
        ...run0Raw,
        recordDigest: run0Digest,
      };

      const run1Raw: Omit<QualificationRunRecord, "recordDigest"> = {
        runId: "run-passed-002",
        sequence: 1,
        candidateId,
        environment: "linux-x64-node20",
        status: "passed",
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: effectProfile.profileDigest!,
        observedEffectProfile: effectProfile,
        structuredChecks: [
          {
            checkId: "chk-1",
            name: "unit-tests",
            status: "passed",
            message: "10/10 passed",
          },
        ],
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 1200,
          outputTokens: 400,
          cacheReadTokens: 0,
          costUsd: 0.0045,
        },
        previousRecordDigest: run0Digest,
        logsUri: "file:///evidence/runs/run-passed-002.log",
        startedAt: "2026-08-20T10:01:00.000Z",
        completedAt: "2026-08-20T10:01:30.000Z",
      };
      const run1Digest = computeQualificationRunDigest(run1Raw);
      const finalRun1: QualificationRunRecord = {
        ...run1Raw,
        recordDigest: run1Digest,
      };

      const run2Raw: Omit<QualificationRunRecord, "recordDigest"> = {
        runId: "run-passed-003",
        sequence: 2,
        candidateId,
        environment: "darwin-arm64-node20",
        status: "passed",
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        environmentDigest: VALID_ENV_DIGEST_2,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: effectProfile.profileDigest!,
        observedEffectProfile: effectProfile,
        structuredChecks: [
          {
            checkId: "chk-1",
            name: "unit-tests",
            status: "passed",
            message: "10/10 passed",
          },
        ],
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 1100,
          outputTokens: 380,
          cacheReadTokens: 0,
          costUsd: 0.0041,
        },
        previousRecordDigest: run1Digest,
        logsUri: "file:///evidence/runs/run-passed-003.log",
        startedAt: "2026-08-20T10:02:00.000Z",
        completedAt: "2026-08-20T10:02:30.000Z",
      };
      const run2Digest = computeQualificationRunDigest(run2Raw);
      const finalRun2: QualificationRunRecord = {
        ...run2Raw,
        recordDigest: run2Digest,
      };

      const runs: QualificationRunRecord[] = [finalRun0, finalRun1, finalRun2];

      const rawEvidenceDigest = computeRawEvidenceDigest({
        candidateId,
        frozenIntent,
        runs,
        schemaVersion: CURRENT_QUALIFICATION_VERSION,
      });

      const reviewer0Raw: Omit<ReviewerVerdict, "recordDigest"> = {
        verdictId: "verdict-001",
        sequence: 0,
        sessionId: "sess-review-001",
        reviewerId: "reviewer-correctness-agent",
        reviewerRole: "correctness-usefulness",
        verdict: "approved",
        noGeneratorHistory: true,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        rawEvidenceDigest,
        findings: [],
        comments: "Passes after initial fix",
        previousRecordDigest: null,
        reviewedAt: "2026-08-20T10:05:00.000Z",
      };
      const reviewer0Digest = computeReviewerVerdictDigest(reviewer0Raw);
      const reviewer0: ReviewerVerdict = { ...reviewer0Raw, recordDigest: reviewer0Digest };

      const reviewer1Raw: Omit<ReviewerVerdict, "recordDigest"> = {
        verdictId: "verdict-002",
        sequence: 1,
        sessionId: "sess-review-002",
        reviewerId: "reviewer-safety-agent",
        reviewerRole: "adversarial-safety",
        verdict: "approved",
        noGeneratorHistory: true,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        rawEvidenceDigest,
        findings: [],
        comments: "Safety check passed",
        previousRecordDigest: reviewer0Digest,
        reviewedAt: "2026-08-20T10:06:00.000Z",
      };
      const reviewer1Digest = computeReviewerVerdictDigest(reviewer1Raw);
      const reviewer1: ReviewerVerdict = { ...reviewer1Raw, recordDigest: reviewer1Digest };

      const reviewers: ReviewerVerdict[] = [reviewer0, reviewer1];

      const replayRaw: Omit<IndependentReplayRecord, "recordDigest"> = {
        replayId: "replay-002",
        candidateId,
        targetRunId: "run-passed-002",
        replayEnvironment: "isolated-replay-sandbox",
        status: "passed",
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        rawEvidenceDigest,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        durationMs: 1100,
        completedAt: "2026-08-20T10:07:00.000Z",
      };
      const replayDigest = computeIndependentReplayDigest(replayRaw);
      const replay: IndependentReplayRecord = { ...replayRaw, recordDigest: replayDigest };

      const unsignedBundle: Omit<QualificationArtifactBundle, "approval"> = {
        bundleId: "bundle-002",
        schemaVersion,
        candidateId,
        previousBundleDigest: null,
        frozenIntent,
        rawEvidenceDigest,
        runs,
        reviewers,
        replay,
        createdAt: "2026-08-20T10:08:00.000Z",
      };

      const artifactBundleDigest = computeQualificationBundleDigest(unsignedBundle);

      const approvalRaw: Omit<ToolQualificationApproval, "approvalDigest" | "signature"> = {
        approvalId: "approval-002",
        approverId: "qualification-authority-admin",
        decision: "approved",
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest,
        rawEvidenceDigest,
        artifactBundleDigest,
        signedAt: "2026-08-20T10:09:00.000Z",
        comments: "Approved with complete lineage",
      };
      const approvalDigest = computeApprovalDigest(approvalRaw);

      const signature = {
        keyId: "ed25519-key-01",
        algorithm: "ed25519" as const,
        signature: "deterministic-mock-signature-base64",
        signedDigest: artifactBundleDigest,
      };

      const bundle: QualificationArtifactBundle = {
        ...unsignedBundle,
        approval: {
          ...approvalRaw,
          approvalDigest,
          signature,
        },
      };

      const verifier = createDeterministicMockVerifier();
      const result = validateQualificationBundle(bundle, { verifier });
      expect(result.valid).toBe(false);
      expect(
        result.issues.some((i) => i.code === QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH),
      ).toBe(true);
    });
  });

  describe("Validation Helpers & Type Guards", () => {
    it("assertValidQualificationBundle succeeds on valid bundle", () => {
      const bundle = createValidQualificationBundle();
      const verifier = createDeterministicMockVerifier();
      expect(() => assertValidQualificationBundle(bundle, { verifier })).not.toThrow();
    });

    it("assertValidQualificationBundle throws informative error on invalid bundle", () => {
      expect(() => assertValidQualificationBundle({ invalid: true })).toThrowError(
        /Qualification bundle validation failed/,
      );
    });

    it("isQualificationArtifactBundle returns true for valid and false for invalid data", () => {
      const bundle = createValidQualificationBundle();
      const verifier = createDeterministicMockVerifier();
      expect(isQualificationArtifactBundle(bundle, { verifier })).toBe(true);
      expect(isQualificationArtifactBundle({ invalid: true })).toBe(false);
    });
  });

  describe("Passed-Run Invariant Enforcement & Security Hardening (Blocker f)", () => {
    it("rejects run with status 'passed' when any ObservedEffectProfile axis is incomplete / unknown", () => {
      const axes = [
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
      ] as const;

      for (const axis of axes) {
        const validProfile = createValidObservedEffectProfile();
        const invalidProfile = {
          ...validProfile,
          [axis]: {
            ...validProfile[axis],
            observation: "unknown" as const,
          },
        };
        invalidProfile.profileDigest = computeObservedEffectProfileDigest(invalidProfile);

        const runData = {
          runId: "run-passed-incomplete-axis",
          sequence: 0,
          candidateId: "candidate-001",
          environment: "linux-x64-node20",
          status: "passed" as const,
          sourceDigest: VALID_SOURCE_DIGEST,
          dependencyDigest: VALID_DEP_DIGEST,
          intentDigest: VALID_INTENT_DIGEST,
          environmentDigest: VALID_ENV_DIGEST_1,
          inputDigest: VALID_INPUT_DIGEST,
          traceDigest: VALID_TRACE_DIGEST,
          beforeStateDigest: VALID_STATE_DIGEST_1,
          afterStateDigest: VALID_STATE_DIGEST_2,
          outputDigest: VALID_OUTPUT_DIGEST,
          checkDigest: VALID_CHECK_DIGEST,
          effectDigest: invalidProfile.profileDigest,
          observedEffectProfile: invalidProfile,
          structuredChecks: [{ checkId: "chk-1", name: "unit-tests", status: "passed" as const }],
          costs: {
            modelUsageObservation: "complete" as const,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            costUsd: 0.001,
          },
          previousRecordDigest: null,
          recordDigest: "0".repeat(64),
          startedAt: "2026-08-20T10:00:00.000Z",
          completedAt: "2026-08-20T10:00:05.000Z",
        };

        const parseRes = QualificationRunRecordSchema.safeParse(runData);
        expect(parseRes.success).toBe(false);
      }
    });

    it("rejects run with status 'passed' when costs.modelUsageObservation is 'unknown'", () => {
      const validProfile = createValidObservedEffectProfile();
      const runData = {
        runId: "run-unknown-cost-obs",
        sequence: 0,
        candidateId: "candidate-001",
        environment: "linux-x64-node20",
        status: "passed" as const,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest: VALID_INTENT_DIGEST,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: validProfile.profileDigest!,
        observedEffectProfile: validProfile,
        structuredChecks: [{ checkId: "chk-1", name: "unit-tests", status: "passed" as const }],
        costs: { modelUsageObservation: "unknown" as const },
        previousRecordDigest: null,
        recordDigest: "0".repeat(64),
        startedAt: "2026-08-20T10:00:00.000Z",
        completedAt: "2026-08-20T10:00:05.000Z",
      };

      const parseRes = QualificationRunRecordSchema.safeParse(runData);
      expect(parseRes.success).toBe(false);
    });

    it("rejects run with status 'passed' when structuredChecks is empty or contains non-passed checks", () => {
      const validProfile = createValidObservedEffectProfile();
      const runBase = {
        runId: "run-chk-test",
        sequence: 0,
        candidateId: "candidate-001",
        environment: "linux-x64-node20",
        status: "passed" as const,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest: VALID_INTENT_DIGEST,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: validProfile.profileDigest!,
        observedEffectProfile: validProfile,
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        previousRecordDigest: null,
        recordDigest: "0".repeat(64),
        startedAt: "2026-08-20T10:00:00.000Z",
        completedAt: "2026-08-20T10:00:05.000Z",
      };

      // Empty checks
      const emptyRes = QualificationRunRecordSchema.safeParse({
        ...runBase,
        structuredChecks: [],
      });
      expect(emptyRes.success).toBe(false);

      // Failed check
      const failedRes = QualificationRunRecordSchema.safeParse({
        ...runBase,
        structuredChecks: [
          { checkId: "chk-1", name: "syntax-check", status: "passed" as const },
          {
            checkId: "chk-2",
            name: "regression-check",
            status: "failed" as const,
            message: "assertion error",
          },
        ],
      });
      expect(failedRes.success).toBe(false);

      // Error check
      const errorRes = QualificationRunRecordSchema.safeParse({
        ...runBase,
        structuredChecks: [
          {
            checkId: "chk-1",
            name: "syntax-check",
            status: "error" as const,
            message: "process crashed",
          },
        ],
      });
      expect(errorRes.success).toBe(false);
    });

    it("rejects run with status 'passed' when structuredCheck has mismatched actualDigest and expectedDigest", () => {
      const validProfile = createValidObservedEffectProfile();
      const runBase = {
        runId: "run-chk-digest-mismatch",
        sequence: 0,
        candidateId: "candidate-001",
        environment: "linux-x64-node20",
        status: "passed" as const,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest: VALID_INTENT_DIGEST,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: validProfile.profileDigest!,
        observedEffectProfile: validProfile,
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        previousRecordDigest: null,
        recordDigest: "0".repeat(64),
        startedAt: "2026-08-20T10:00:00.000Z",
        completedAt: "2026-08-20T10:00:05.000Z",
      };

      const mismatchRes = QualificationRunRecordSchema.safeParse({
        ...runBase,
        structuredChecks: [
          {
            checkId: "chk-1",
            name: "digest-binding-check",
            status: "passed" as const,
            actualDigest: "1".repeat(64),
            expectedDigest: "2".repeat(64),
          },
        ],
      });
      expect(mismatchRes.success).toBe(false);

      const matchRes = QualificationRunRecordSchema.safeParse({
        ...runBase,
        structuredChecks: [
          {
            checkId: "chk-1",
            name: "digest-binding-check",
            status: "passed" as const,
            actualDigest: "1".repeat(64),
            expectedDigest: "1".repeat(64),
          },
        ],
      });
      expect(matchRes.success).toBe(true);
    });

    it("rejects run with status 'passed' when validationChecks has failing checks (passed: false)", () => {
      const profileWithFailingValidation = createValidObservedEffectProfile({
        validationChecks: {
          observation: "complete" as const,
          checks: [
            { checkId: "chk-1", name: "syntax-check", passed: true },
            { checkId: "chk-2", name: "boundary-check", passed: false, details: "out of bounds" },
          ],
        },
      });

      const runData = {
        runId: "run-failing-val-check",
        sequence: 0,
        candidateId: "candidate-001",
        environment: "linux-x64-node20",
        status: "passed" as const,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest: VALID_INTENT_DIGEST,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: profileWithFailingValidation.profileDigest!,
        observedEffectProfile: profileWithFailingValidation,
        structuredChecks: [{ checkId: "chk-1", name: "unit-tests", status: "passed" as const }],
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        previousRecordDigest: null,
        recordDigest: "0".repeat(64),
        startedAt: "2026-08-20T10:00:00.000Z",
        completedAt: "2026-08-20T10:00:05.000Z",
      };

      const parseRes = QualificationRunRecordSchema.safeParse(runData);
      expect(parseRes.success).toBe(false);
    });

    it("rejects run with status 'passed' when consequentialAction has missing or empty authorizationEvidence", () => {
      const unauthorizedProfile = createValidObservedEffectProfile({
        consequentialActions: {
          observation: "complete" as const,
          actions: [
            {
              actionType: "filesystem_write",
              target: "/etc/passwd",
              description: "Modify user permissions",
              requiresExplicitAuthorization: true,
            },
          ],
        },
      });

      const runBase = {
        runId: "run-unauth-action",
        sequence: 0,
        candidateId: "candidate-001",
        environment: "linux-x64-node20",
        status: "passed" as const,
        sourceDigest: VALID_SOURCE_DIGEST,
        dependencyDigest: VALID_DEP_DIGEST,
        intentDigest: VALID_INTENT_DIGEST,
        environmentDigest: VALID_ENV_DIGEST_1,
        inputDigest: VALID_INPUT_DIGEST,
        traceDigest: VALID_TRACE_DIGEST,
        beforeStateDigest: VALID_STATE_DIGEST_1,
        afterStateDigest: VALID_STATE_DIGEST_2,
        outputDigest: VALID_OUTPUT_DIGEST,
        checkDigest: VALID_CHECK_DIGEST,
        effectDigest: unauthorizedProfile.profileDigest!,
        observedEffectProfile: unauthorizedProfile,
        structuredChecks: [{ checkId: "chk-1", name: "unit-tests", status: "passed" as const }],
        costs: {
          modelUsageObservation: "complete" as const,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        previousRecordDigest: null,
        recordDigest: "0".repeat(64),
        startedAt: "2026-08-20T10:00:00.000Z",
        completedAt: "2026-08-20T10:00:05.000Z",
      };

      const unauthRes = QualificationRunRecordSchema.safeParse(runBase);
      expect(unauthRes.success).toBe(false);

      const authorizedProfile = createValidObservedEffectProfile({
        consequentialActions: {
          observation: "complete" as const,
          actions: [
            {
              actionType: "filesystem_write",
              target: "/etc/passwd",
              description: "Modify user permissions",
              requiresExplicitAuthorization: true,
              authorizationEvidence: "grant:admin-sec-override-2026",
            },
          ],
        },
      });

      const authRes = QualificationRunRecordSchema.safeParse({
        ...runBase,
        effectDigest: authorizedProfile.profileDigest!,
        observedEffectProfile: authorizedProfile,
      });
      expect(authRes.success).toBe(true);
    });

    it("rejects approval attempt over bundle containing incomplete axis run or failed check", () => {
      const verifier = createDeterministicMockVerifier();
      const bundle = createValidQualificationBundle((builder) => {
        const incompleteProfile = {
          ...builder.runs[0].observedEffectProfile,
          filesRead: {
            observation: "unknown" as const,
            paths: [],
          },
        };
        incompleteProfile.profileDigest = computeObservedEffectProfileDigest(incompleteProfile);
        builder.runs[0] = {
          ...builder.runs[0],
          observedEffectProfile: incompleteProfile,
          effectDigest: incompleteProfile.profileDigest,
        };
        builder.runs[0].recordDigest = computeQualificationRunDigest(builder.runs[0]);
      });

      const result = validateQualificationBundle(bundle, { verifier });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH)).toBe(
        true,
      );
    });

    it("rejects approval attempt over bundle containing unauthorized consequential action", () => {
      const verifier = createDeterministicMockVerifier();
      const bundle = createValidQualificationBundle((builder) => {
        const unauthProfile = {
          ...builder.runs[0].observedEffectProfile,
          consequentialActions: {
            observation: "complete" as const,
            actions: [
              {
                actionType: "cloud_mutation",
                target: "arn:aws:s3:::prod-bucket/delete",
                description: "Delete prod bucket",
                requiresExplicitAuthorization: true as const,
              },
            ],
          },
        };
        unauthProfile.profileDigest = computeObservedEffectProfileDigest(unauthProfile);
        builder.runs[0] = {
          ...builder.runs[0],
          observedEffectProfile: unauthProfile,
          effectDigest: unauthProfile.profileDigest,
        };
        builder.runs[0].recordDigest = computeQualificationRunDigest(builder.runs[0]);
      });

      const result = validateQualificationBundle(bundle, { verifier });
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH)).toBe(
        true,
      );
    });
  });
});
