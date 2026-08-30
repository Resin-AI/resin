import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CanonicalJsonRecord,
  type CanonicalJsonValue,
  type ConsequentialAction,
  type ObservedEffectProfile,
  QUALIFICATION_ERROR_CODES,
  type QualificationArtifactBundle,
  QualificationArtifactBundleSchema,
  type QualificationRunRecord,
  type QualificationSignatureVerifier,
  type ToolManifest,
  ToolManifestSchema,
  type ToolQualificationApproval,
  canonicalJson,
  computeApprovalDigest,
  computeFrozenIntentDigest,
  computeIndependentReplayDigest,
  computeObservedEffectProfileDigest,
  computeQualificationBundleDigest,
  computeQualificationRunDigest,
  computeRawEvidenceDigest,
  computeReviewerVerdictDigest,
  normalizeSha256,
  validateQualificationBundle,
} from "@resin/contracts";
import {
  type BundleFileInput,
  type ExtractedTarEntry,
  computeSha256,
  encodeDeterministicTar,
  normalizeTarPath,
  parseTarArchive,
} from "../bundle/builder.js";
import {
  type KeyStore,
  type KeyStoreEntry,
  type SignatureVerificationResult,
  createDevelopmentKeyStore,
  verifyBundleSignature,
} from "../bundle/signature.js";
import {
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_PACKAGE,
  BUNDLE_FILE_PACKAGE_LOCK,
  BUNDLE_FILE_QUALIFICATION,
  BUNDLE_FILE_SIGNATURE,
  type BundleLimits,
  type BundleSignatureData,
  BundleSignatureDataSchema,
  DEFAULT_BUNDLE_LIMITS,
} from "../bundle/spec.js";
import {
  type VerifiedQualificationData,
  type VerifiedQualificationToken,
  createVerifiedQualificationToken,
  getVerifiedQualificationData,
  registerVerifiedHostObject,
} from "../monitor/token.js";
import { ArtifactCache, type ArtifactReference, type ExtractionMetadata } from "./cache.js";
import { type BundleInspectionResult, inspectBundleDirectory } from "./inspector.js";
import { QuarantineManager, type QuarantineReason } from "./quarantine.js";
import {
  BundleResourceTracker,
  BundleSecurityError,
  resolveSafeTargetPath,
} from "./security-checks.js";

/**
 * Deeply freezes an object to make it immutable.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || !(obj instanceof Object)) {
    return obj;
  }
  for (const val of Object.values(obj)) {
    if (val !== null && val instanceof Object && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj);
}

/**
 * Derives aggregate immutable observed effect profile strictly from complete axes of qualification runs.
 */
export function deriveObservedEffectProfile(runs: QualificationRunRecord[]): ObservedEffectProfile {
  if (runs.length === 0) {
    return {
      filesRead: { observation: "complete", paths: [] },
      filesCreated: { observation: "complete", paths: [] },
      filesModified: { observation: "complete", paths: [] },
      filesDeleted: { observation: "complete", paths: [] },
      processTree: { observation: "complete", spawnedProcesses: [] },
      network: { observation: "complete", destinations: [], methods: [] },
      environmentVariables: { observation: "complete", names: [] },
      credentials: { observation: "complete", names: [] },
      dependencyChanges: { observation: "complete", changes: [] },
      artifacts: { observation: "complete", items: [] },
      validationChecks: { observation: "complete", checks: [] },
      resourceEnvelope: {
        observation: "complete",
        maxMemoryBytes: 0,
        cpuTimeMs: 0,
        wallDurationMs: 0,
      },
      consequentialActions: { observation: "complete", actions: [] },
      determinism: "deterministic",
    };
  }

  const first = runs[0]!.observedEffectProfile;

  const filesRead = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.filesRead?.paths ?? [])),
  ).sort();
  const filesCreated = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.filesCreated?.paths ?? [])),
  ).sort();
  const filesModified = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.filesModified?.paths ?? [])),
  ).sort();
  const filesDeleted = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.filesDeleted?.paths ?? [])),
  ).sort();
  const spawnedProcesses = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.processTree?.spawnedProcesses ?? [])),
  ).sort();

  const destinations = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.network?.destinations ?? [])),
  ).sort();
  const methods = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.network?.methods ?? [])),
  ).sort();

  const envNames = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.environmentVariables?.names ?? [])),
  ).sort();
  const credNames = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.credentials?.names ?? [])),
  ).sort();
  const depChanges = Array.from(
    new Set(runs.flatMap((r) => r.observedEffectProfile.dependencyChanges?.changes ?? [])),
  ).sort();

  const artifacts = Array.from(
    new Map(
      runs
        .flatMap((r) => r.observedEffectProfile.artifacts?.items ?? [])
        .map((item) => [item.name, item]),
    ).values(),
  );

  const checks = Array.from(
    new Map(
      runs
        .flatMap((r) => r.observedEffectProfile.validationChecks?.checks ?? [])
        .map((c) => [c.checkId, c]),
    ).values(),
  );

  const maxMemoryBytes = Math.max(
    ...runs.map((r) => r.observedEffectProfile.resourceEnvelope?.maxMemoryBytes ?? 0),
    0,
  );
  const cpuTimeMs = Math.max(
    ...runs.map((r) => r.observedEffectProfile.resourceEnvelope?.cpuTimeMs ?? 0),
    0,
  );
  const wallDurationMs = Math.max(
    ...runs.map((r) => r.observedEffectProfile.resourceEnvelope?.wallDurationMs ?? 0),
    0,
  );

  const actions = Array.from(
    new Map(
      runs
        .flatMap((r) => r.observedEffectProfile.consequentialActions?.actions ?? [])
        .map((a) => [
          canonicalJson({
            actionType: a.actionType,
            target: a.target,
            description: a.description,
            requiresExplicitAuthorization: a.requiresExplicitAuthorization,
          }),
          a,
        ]),
    ).values(),
  );

  return {
    filesRead: { observation: first.filesRead?.observation ?? "complete", paths: filesRead },
    filesCreated: {
      observation: first.filesCreated?.observation ?? "complete",
      paths: filesCreated,
    },
    filesModified: {
      observation: first.filesModified?.observation ?? "complete",
      paths: filesModified,
    },
    filesDeleted: {
      observation: first.filesDeleted?.observation ?? "complete",
      paths: filesDeleted,
    },
    processTree: { observation: first.processTree?.observation ?? "complete", spawnedProcesses },
    network: { observation: first.network?.observation ?? "complete", destinations, methods },
    environmentVariables: {
      observation: first.environmentVariables?.observation ?? "complete",
      names: envNames,
    },
    credentials: { observation: first.credentials?.observation ?? "complete", names: credNames },
    dependencyChanges: {
      observation: first.dependencyChanges?.observation ?? "complete",
      changes: depChanges,
    },
    artifacts: { observation: first.artifacts?.observation ?? "complete", items: artifacts },
    validationChecks: { observation: first.validationChecks?.observation ?? "complete", checks },
    resourceEnvelope: {
      observation: first.resourceEnvelope?.observation ?? "complete",
      maxMemoryBytes,
      cpuTimeMs,
      wallDurationMs,
    },
    consequentialActions: {
      observation: first.consequentialActions?.observation ?? "complete",
      actions,
    },
    // SAFETY: Verified or defaulted string value matches DeterminismLevel union.
    determinism: (first.determinism ?? "deterministic") as
      | "deterministic"
      | "non_deterministic"
      | "pseudo_deterministic",
  };
}
async function scanExtractedRegularFiles(targetDir: string): Promise<{
  fileDigests: Record<string, string>;
  files: BundleFileInput[];
  totalBytes: number;
}> {
  const fileDigests: Record<string, string> = {};
  const files: BundleFileInput[] = [];
  let totalBytes = 0;

  async function walk(currentDir: string): Promise<void> {
    const dirStat = await fs.promises.lstat(currentDir);
    if (dirStat.isSymbolicLink()) {
      throw new BundleSecurityError(
        "SYMLINK_ESCAPE",
        `Symlink detected in extracted bundle: ${currentDir}`,
        currentDir,
      );
    }

    const dirents = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name === ".extracted" || dirent.name.startsWith(".record_")) {
        continue;
      }
      const fullPath = path.join(currentDir, dirent.name);
      const stat = await fs.promises.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new BundleSecurityError(
          "SYMLINK_ESCAPE",
          `Symlink prohibited in tool bundle: ${fullPath}`,
          fullPath,
        );
      }

      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        const content = await fs.promises.readFile(fullPath);
        const relPath = normalizeTarPath(path.relative(targetDir, fullPath));
        const digest = computeSha256(content);
        fileDigests[relPath] = digest;
        totalBytes += content.length;
        const isExec = Boolean((stat.mode & 0o111) !== 0);
        files.push({
          path: relPath,
          content,
          mode: isExec ? 0o755 : 0o644,
          executable: isExec,
        });
      } else {
        throw new BundleSecurityError(
          "DEVICE_FILE_PROHIBITED",
          `Special device file prohibited in tool bundle: ${fullPath}`,
          fullPath,
        );
      }
    }
  }

  await walk(targetDir);
  return { fileDigests, files, totalBytes };
}

export class BundleValidationError extends Error {
  readonly details?: CanonicalJsonRecord;
  constructor(message: string, details?: CanonicalJsonRecord) {
    super(message);
    this.name = "BundleValidationError";
    this.details = details;
  }
}

export class BundleSignatureError extends Error {
  readonly keyId?: string;
  readonly reason?: string;
  constructor(message: string, keyId?: string, reason?: string) {
    super(message);
    this.name = "BundleSignatureError";
    this.keyId = keyId;
    this.reason = reason;
  }
}

export type KeyResolver = (
  keyId: string,
) => Promise<KeyStoreEntry | undefined> | KeyStoreEntry | undefined;

export interface ToolBundleLoaderOptions {
  cache?: ArtifactCache;
  quarantine?: QuarantineManager;
  keyStore?: KeyStore;
  qualificationVerifier?: QualificationSignatureVerifier;
  keyResolver?: KeyResolver;
  limits?: Partial<BundleLimits>;
  allowDevKeys?: boolean;
  development?: boolean;
}

export interface LoadBundleOptions {
  expectedDigest?: string;
  requireSignature?: boolean;
  allowDevKeys?: boolean;
  development?: boolean;
  qualificationVerifier?: QualificationSignatureVerifier;
  keyResolver?: KeyResolver;
  forceReExtract?: boolean;
  reference?: string;
}

/**
 * Represent an extracted, validated, and cached tool bundle ready for execution.
 */
export interface LoadedToolBundle {
  digest: string;
  artifactDir: string;
  entrypointPath: string;
  manifest: ToolManifest;
  inspection: BundleInspectionResult;
  isCached: boolean;
  approval?: Readonly<ToolQualificationApproval>;
  effectProfile?: ObservedEffectProfile;
  qualification?: Readonly<QualificationArtifactBundle>;
  qualificationToken?: VerifiedQualificationToken;
  isApproved?: boolean;
}

export type { VerifiedQualificationToken };

/**
 * Main orchestrator for verifying, safely extracting, validating, and caching tool bundles.
 */
export class ToolBundleLoader {
  readonly cache: ArtifactCache;
  readonly quarantine: QuarantineManager;
  readonly keyStore: KeyStore;
  readonly limits: BundleLimits;
  readonly allowDevKeys: boolean;
  readonly development: boolean;
  readonly qualificationVerifier?: QualificationSignatureVerifier;
  readonly keyResolver?: KeyResolver;

  constructor(options: ToolBundleLoaderOptions = {}) {
    this.cache = options.cache ?? new ArtifactCache();
    this.quarantine =
      options.quarantine ?? new QuarantineManager({ quarantineDir: this.cache.quarantineDir });
    this.keyStore = options.keyStore ?? createDevelopmentKeyStore();
    this.limits = { ...DEFAULT_BUNDLE_LIMITS, ...options.limits };
    this.allowDevKeys = options.allowDevKeys ?? false;
    this.development = options.development ?? false;
    this.qualificationVerifier = options.qualificationVerifier;
    this.keyResolver = options.keyResolver;
  }

  private isDev(options?: LoadBundleOptions): boolean {
    return options?.development ?? this.development;
  }
  private shouldRequireSignature(options?: LoadBundleOptions): boolean {
    const isDev = this.isDev(options);
    if (!isDev) {
      // In production mode, outer signature is strictly mandatory and cannot be disabled
      return true;
    }
    return Boolean(options?.requireSignature);
  }

  /**
   * Resolves a key entry by keyId.
   */
  async resolveKey(
    keyId: string,
    options: LoadBundleOptions = {},
  ): Promise<KeyStoreEntry | undefined> {
    if (options.keyResolver) {
      return options.keyResolver(keyId);
    }
    if (this.keyResolver) {
      return this.keyResolver(keyId);
    }
    if (this.keyStore) {
      const key = await this.keyStore.getKey(keyId);
      return key ?? undefined;
    }
    return undefined;
  }

  /**
   * Validates qualification artifact bundle, verifies cryptographic signature,
   * checks hash chains, and matches against actual extracted bundle contents.
   */
  async validateQualification(
    targetDir: string,
    options: LoadBundleOptions = {},
    manifest?: ToolManifest,
  ): Promise<{
    approval?: Readonly<ToolQualificationApproval>;
    effectProfile?: ObservedEffectProfile;
    qualification?: Readonly<QualificationArtifactBundle>;
    qualificationToken?: VerifiedQualificationToken;
    isApproved: boolean;
  }> {
    const qualPath = path.join(targetDir, BUNDLE_FILE_QUALIFICATION);
    const hasQual = fs.existsSync(qualPath);

    // If qualification.json is missing:
    if (!hasQual) {
      if (this.isDev(options)) {
        return { isApproved: false };
      }
      throw new BundleValidationError(
        `Production qualification required: ${BUNDLE_FILE_QUALIFICATION} is missing in non-development mode`,
        { reason: "unapproved_candidate" },
      );
    }

    // 1. Resolve and parse manifest from targetDir (or manifest parameter)
    const manifestPath = path.join(targetDir, BUNDLE_FILE_MANIFEST);
    let resolvedManifest = manifest;
    if (!resolvedManifest && fs.existsSync(manifestPath)) {
      try {
        const manifestContent = await fs.promises.readFile(manifestPath, "utf8");
        resolvedManifest = ToolManifestSchema.parse(JSON.parse(manifestContent));
      } catch (err) {
        throw new BundleValidationError(
          `Invalid manifest in tool bundle: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "manifest_invalid" },
        );
      }
    }

    if (!resolvedManifest) {
      throw new BundleValidationError(`Tool bundle is missing required ${BUNDLE_FILE_MANIFEST}`, {
        reason: "manifest_invalid",
      });
    }

    if (resolvedManifest.capabilities?.secrets?.denyDirectRead === false) {
      throw new BundleValidationError(
        `Bundle '${resolvedManifest.id}' requires direct secret reads (denyDirectRead: false), which is incompatible with protocol v1.0.0. Migrate tool to use opaque secret references (broker.secret.createReference / bearerToken) and trusted broker mediation.`,
      );
    }

    // Parse qualification.json
    let qualData: CanonicalJsonValue = null;
    try {
      const qualContent = await fs.promises.readFile(qualPath, "utf8");
      // SAFETY: JSON parse result is typed as CanonicalJsonValue for qualification validation.
      qualData = JSON.parse(qualContent) as CanonicalJsonValue;
    } catch (err) {
      throw new BundleValidationError(
        `Failed to parse ${BUNDLE_FILE_QUALIFICATION}: ${err instanceof Error ? err.message : String(err)}`,
        { reason: "corrupted_archive" },
      );
    }

    const parsedQual = QualificationArtifactBundleSchema.safeParse(qualData);
    const keyId = parsedQual.success ? parsedQual.data.approval?.signature?.keyId : undefined;

    const keyEntry = keyId ? await this.resolveKey(keyId, options) : undefined;

    let verifier = options.qualificationVerifier ?? this.qualificationVerifier;
    if (!verifier && keyEntry) {
      verifier = (params) => {
        try {
          const sigBuffer =
            /^[0-9a-fA-F]+$/.test(params.signature) && params.signature.length === 128
              ? Buffer.from(params.signature, "hex")
              : Buffer.from(params.signature, "base64");
          return crypto.verify(
            null,
            Buffer.from(params.payload, "utf8"),
            keyEntry.publicKeyPem,
            sigBuffer,
          );
        } catch {
          return false;
        }
      };
    }

    // Contract validation
    // SAFETY: qualData is parsed JSON value validated against qualification bundle schema.
    const validationResult = validateQualificationBundle(qualData as QualificationArtifactBundle, {
      verifier,
    });
    if (!validationResult.valid) {
      const isUnapproved =
        validationResult.issues.some(
          (i) =>
            i.code === QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED ||
            i.message.toLowerCase().includes("unapproved") ||
            i.message.toLowerCase().includes("rejected"),
        ) ||
        (Boolean(qualData) &&
          qualData instanceof Object &&
          "approval" in qualData &&
          qualData.approval instanceof Object &&
          "decision" in qualData.approval &&
          // SAFETY: Checked as object record with decision property.
          String((qualData.approval as CanonicalJsonRecord).decision) === "rejected");
      if (isUnapproved) {
        throw new BundleValidationError(
          `Qualification approval rejected or unapproved: ${validationResult.issues.map((i) => i.message).join("; ")}`,
          { reason: "unapproved_candidate" },
        );
      }

      const isDrift =
        validationResult.errorCodes.includes("BUNDLE_MISMATCH") ||
        validationResult.errorCodes.includes("REPLAY_MISMATCH") ||
        validationResult.errorCodes.includes("APPROVAL_MISMATCH") ||
        validationResult.issues.some(
          (i) =>
            i.message.toLowerCase().includes("mismatch") ||
            i.message.toLowerCase().includes("drift") ||
            i.message.toLowerCase().includes("hash chain") ||
            i.message.toLowerCase().includes("digest"),
        );
      if (isDrift) {
        throw new BundleValidationError(
          `Qualification bundle digest mismatch or drift: ${validationResult.issues.map((i) => i.message).join("; ")}`,
          { reason: "approval_drift" },
        );
      }

      if (validationResult.issues.some((i) => i.message.toLowerCase().includes("signature"))) {
        throw new BundleSignatureError(
          `Qualification signature verification failed: ${validationResult.issues.map((i) => i.message).join("; ")}`,
          keyId,
          "signature_mismatch",
        );
      }

      throw new BundleValidationError(
        `Qualification bundle validation failed: ${validationResult.issues.map((i) => i.message).join("; ")}`,
        { reason: "approval_drift" },
      );
    }

    const qual = validationResult.bundle!;

    // 2. Recompute and verify all digests
    const computedIntent = computeFrozenIntentDigest(qual.frozenIntent);
    if (
      normalizeSha256(computedIntent, false) !==
        normalizeSha256(qual.frozenIntent.intentDigest, false) ||
      normalizeSha256(computedIntent, false) !== normalizeSha256(qual.approval.intentDigest, false)
    ) {
      throw new BundleValidationError("Frozen intent digest mismatch against approval record", {
        reason: "approval_drift",
      });
    }

    // Recompute and verify canonical input schema digest from resolved manifest.parameters
    const recomputedSchemaDigest = normalizeSha256(
      computeSha256(canonicalJson(resolvedManifest.parameters)),
      false,
    );
    const expectedSchemaDigest = normalizeSha256(qual.frozenIntent.inputSchemaDigest, false);
    if (recomputedSchemaDigest !== expectedSchemaDigest) {
      throw new BundleValidationError(
        `Input schema digest mismatch: manifest.parameters canonical digest '${recomputedSchemaDigest}' does not match frozen intent inputSchemaDigest '${expectedSchemaDigest}'`,
        { reason: "approval_drift" },
      );
    }

    // Recompute and verify manifest identity
    if (!resolvedManifest.id || !resolvedManifest.version) {
      throw new BundleValidationError("Manifest must contain valid id and version", {
        reason: "manifest_invalid",
      });
    }

    const qualMeta = qual.metadata;
    const rawToolId = qualMeta?.toolId;
    // SAFETY: Tag check confirms metadata.toolId is a string.
    const expectedToolId =
      Object.prototype.toString.call(rawToolId) === "[object String]"
        ? (rawToolId as string)
        : undefined;
    if (expectedToolId && expectedToolId !== resolvedManifest.id) {
      throw new BundleValidationError(
        `Manifest tool id '${resolvedManifest.id}' does not match expected qualification tool id '${expectedToolId}'`,
        { reason: "approval_drift" },
      );
    }

    const rawToolVersion = qualMeta?.toolVersion;
    // SAFETY: Tag check confirms metadata.toolVersion is a string.
    const expectedToolVersion =
      Object.prototype.toString.call(rawToolVersion) === "[object String]"
        ? (rawToolVersion as string)
        : undefined;
    if (expectedToolVersion && expectedToolVersion !== resolvedManifest.version) {
      throw new BundleValidationError(
        `Manifest tool version '${resolvedManifest.version}' does not match expected qualification tool version '${expectedToolVersion}'`,
        { reason: "approval_drift" },
      );
    }

    const rawManifestDigest = qualMeta?.manifestDigest;
    // SAFETY: Tag check confirms metadata.manifestDigest is a string.
    const expectedManifestDigest =
      Object.prototype.toString.call(rawManifestDigest) === "[object String]"
        ? (rawManifestDigest as string)
        : undefined;
    if (expectedManifestDigest) {
      const computedManifestDigest = normalizeSha256(
        computeSha256(canonicalJson(resolvedManifest)),
        false,
      );
      if (computedManifestDigest !== normalizeSha256(expectedManifestDigest, false)) {
        throw new BundleValidationError(
          `Manifest digest mismatch: canonical manifest digest '${computedManifestDigest}' does not match qualification manifest digest '${expectedManifestDigest}'`,
          { reason: "approval_drift" },
        );
      }
    }
    const computedRawEvidence = computeRawEvidenceDigest(qual);
    if (
      normalizeSha256(computedRawEvidence, false) !==
        normalizeSha256(qual.rawEvidenceDigest, false) ||
      normalizeSha256(computedRawEvidence, false) !==
        normalizeSha256(qual.approval.rawEvidenceDigest, false)
    ) {
      throw new BundleValidationError("Raw evidence digest mismatch against approval record", {
        reason: "approval_drift",
      });
    }

    const computedArtifactBundleDigest = computeQualificationBundleDigest(qual);
    if (
      normalizeSha256(computedArtifactBundleDigest, false) !==
        normalizeSha256(qual.approval.artifactBundleDigest, false) ||
      normalizeSha256(computedArtifactBundleDigest, false) !==
        normalizeSha256(qual.approval.signature.signedDigest, false)
    ) {
      throw new BundleValidationError(
        "Artifact bundle digest mismatch against approval signature",
        {
          reason: "approval_drift",
        },
      );
    }

    const computedApprovalDigest = computeApprovalDigest(qual.approval);
    if (
      normalizeSha256(computedApprovalDigest, false) !==
      normalizeSha256(qual.approval.approvalDigest, false)
    ) {
      throw new BundleValidationError("Approval digest mismatch", {
        reason: "approval_drift",
      });
    }

    for (const run of qual.runs) {
      const computedRunDigest = computeQualificationRunDigest(run);
      if (normalizeSha256(computedRunDigest, false) !== normalizeSha256(run.recordDigest, false)) {
        throw new BundleValidationError(`Run record digest mismatch for run ${run.runId}`, {
          reason: "approval_drift",
        });
      }
    }

    for (const verdict of qual.reviewers ?? []) {
      const computedVerdictDigest = computeReviewerVerdictDigest(verdict);
      if (
        normalizeSha256(computedVerdictDigest, false) !==
        normalizeSha256(verdict.recordDigest, false)
      ) {
        throw new BundleValidationError(
          `Reviewer verdict record digest mismatch for verdict ${verdict.verdictId}`,
          { reason: "approval_drift" },
        );
      }
    }

    const computedReplayDigest = computeIndependentReplayDigest(qual.replay);
    if (
      normalizeSha256(computedReplayDigest, false) !==
      normalizeSha256(qual.replay.recordDigest, false)
    ) {
      throw new BundleValidationError("Independent replay recordDigest mismatch", {
        reason: "approval_drift",
      });
    }

    // 3. Recompute source digest from actual entrypoint file on disk
    const hasEntrypointTs = fs.existsSync(path.join(targetDir, BUNDLE_FILE_ENTRYPOINT_TS));
    const hasEntrypointJs = fs.existsSync(path.join(targetDir, BUNDLE_FILE_ENTRYPOINT_JS));
    if (!hasEntrypointTs && !hasEntrypointJs) {
      throw new BundleValidationError(
        "Tool bundle is missing approved entrypoint file (src/index.ts or src/index.js)",
        { reason: "approval_drift" },
      );
    }
    const entrypointFile = hasEntrypointTs ? BUNDLE_FILE_ENTRYPOINT_TS : BUNDLE_FILE_ENTRYPOINT_JS;
    const entrypointFullPath = path.join(targetDir, entrypointFile);

    const sourceCode = await fs.promises.readFile(entrypointFullPath, "utf8");
    const recomputedSourceDigest = normalizeSha256(computeSha256(sourceCode), false);
    const expectedSourceDigest = normalizeSha256(qual.approval.sourceDigest, false);

    if (recomputedSourceDigest !== expectedSourceDigest) {
      throw new BundleValidationError(
        `Source digest mismatch: extracted entrypoint source digest '${recomputedSourceDigest}' does not match approved sourceDigest '${expectedSourceDigest}'`,
        { reason: "approval_drift" },
      );
    }

    // 4. Require and hash the exact package/lock/dependency graph
    let parsedDependencies: Record<string, string> | undefined;
    const pkgPath = path.join(targetDir, BUNDLE_FILE_PACKAGE);
    const lockPath = path.join(targetDir, BUNDLE_FILE_PACKAGE_LOCK);

    if (fs.existsSync(pkgPath)) {
      const pkgContent = await fs.promises.readFile(pkgPath, "utf8");
      let pkgParsed: CanonicalJsonRecord = {};
      try {
        pkgParsed = JSON.parse(pkgContent);
      } catch (err) {
        throw new BundleValidationError(
          `Failed to parse ${BUNDLE_FILE_PACKAGE}: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "manifest_invalid" },
        );
      }
      // SAFETY: Object tag check confirms dependencies is an object record.
      const rawDeps =
        pkgParsed.dependencies !== null &&
        Object.prototype.toString.call(pkgParsed.dependencies) === "[object Object]"
          ? (pkgParsed.dependencies as CanonicalJsonRecord)
          : {};
      const deps: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawDeps)) {
        if (Object.prototype.toString.call(v) === "[object String]") {
          // SAFETY: Object tag check confirms dependency version is a string.
          deps[k] = v as string;
        }
      }
      parsedDependencies = deps;
      const canonicalDepsDigest = normalizeSha256(computeSha256(canonicalJson(deps)), false);
      const canonicalPkgDigest = normalizeSha256(computeSha256(canonicalJson(pkgParsed)), false);
      const expectedDep = normalizeSha256(qual.approval.dependencyDigest, false);

      if (fs.existsSync(lockPath)) {
        const lockContent = await fs.promises.readFile(lockPath, "utf8");
        let lockParsed: CanonicalJsonRecord = {};
        try {
          lockParsed = JSON.parse(lockContent);
        } catch (err) {
          throw new BundleValidationError(
            `Failed to parse ${BUNDLE_FILE_PACKAGE_LOCK}: ${err instanceof Error ? err.message : String(err)}`,
            { reason: "manifest_invalid" },
          );
        }
        const lockGraph = { package: pkgParsed, lock: lockParsed };
        const canonicalLockGraphDigest = normalizeSha256(
          computeSha256(canonicalJson(lockGraph)),
          false,
        );
        const canonicalLockDigest = normalizeSha256(
          computeSha256(canonicalJson(lockParsed)),
          false,
        );

        const lockMatches =
          expectedDep === canonicalLockGraphDigest ||
          expectedDep === canonicalLockDigest ||
          expectedDep === canonicalDepsDigest ||
          expectedDep === canonicalPkgDigest;

        if (!lockMatches) {
          throw new BundleValidationError(
            `Dependency and package-lock graph digest mismatch against approved dependencyDigest '${expectedDep}'`,
            { reason: "approval_drift" },
          );
        }
      } else {
        const matches = expectedDep === canonicalDepsDigest || expectedDep === canonicalPkgDigest;
        if (!matches) {
          throw new BundleValidationError(
            `Dependency digest mismatch: package dependencies digest '${canonicalDepsDigest}' does not match approved dependencyDigest '${expectedDep}'`,
            { reason: "approval_drift" },
          );
        }
      }
    } else {
      const expectedDep = normalizeSha256(qual.approval.dependencyDigest, false);
      const emptyDep = normalizeSha256(computeSha256(canonicalJson({})), false);
      if (expectedDep && expectedDep !== emptyDep) {
        throw new BundleValidationError(
          `Tool bundle is missing required package.json for dependency verification (expected dependencyDigest: ${expectedDep})`,
          { reason: "approval_drift" },
        );
      }
    }
    // Key trust check for production
    const allowDev = options.allowDevKeys ?? this.allowDevKeys;
    if (!keyEntry) {
      throw new BundleSignatureError(
        `Key ${keyId ?? "unknown"} was not found in key store`,
        keyId,
        "unapproved_candidate",
      );
    }
    if (keyEntry.trustLevel === "revoked") {
      throw new BundleSignatureError(
        `Key ${keyId ?? "unknown"} is revoked`,
        keyId,
        "unapproved_candidate",
      );
    }
    if (keyEntry.expiresAt && new Date(keyEntry.expiresAt).getTime() <= Date.now()) {
      throw new BundleSignatureError(
        `Key ${keyId ?? "unknown"} has expired (expired at ${keyEntry.expiresAt})`,
        keyId,
        "unapproved_candidate",
      );
    }
    if (!allowDev && keyEntry.trustLevel !== "production") {
      throw new BundleSignatureError(
        `Key ${keyId ?? "unknown"} is not trusted for production (trust level: ${keyEntry.trustLevel})`,
        keyId,
        "unapproved_candidate",
      );
    }
    if (this.keyStore && keyId) {
      const isTrusted = await this.keyStore.isTrusted(keyId, allowDev);
      if (!isTrusted) {
        throw new BundleSignatureError(
          `Key ${keyId} is not trusted in key store`,
          keyId,
          "unapproved_candidate",
        );
      }
    }

    if (qual.approval.decision !== "approved") {
      throw new BundleValidationError(
        `Qualification decision is '${qual.approval.decision}', expected 'approved'`,
        { reason: "unapproved_candidate" },
      );
    }

    const effectProfile = deriveObservedEffectProfile(qual.runs);
    const frozenApproval = deepFreeze(qual.approval);
    const frozenQual = deepFreeze(qual);

    // Token fields come strictly from recomputed, verified values
    const verifiedData: VerifiedQualificationData = {
      toolId: resolvedManifest.id,
      toolVersion: resolvedManifest.version,
      sourceDigest: recomputedSourceDigest,
      depDigest: qual.approval.dependencyDigest,
      schemaDigest: recomputedSchemaDigest,
      intentDigest: qual.frozenIntent.intentDigest,
      approval: frozenApproval,
      runs: qual.runs,
      effectProfile,
      manifest: resolvedManifest,
      dependencies: parsedDependencies,
      rawBundle: frozenQual,
    };

    const qualificationToken = createVerifiedQualificationToken(verifiedData);

    return {
      approval: frozenApproval,
      effectProfile,
      qualification: frozenQual,
      qualificationToken,
      isApproved: true,
    };
  }

  /**
   * Loads a tool bundle from an archive buffer, archive file path, or directory.
   */
  async loadBundle(
    bundleInput: Buffer | string,
    options: LoadBundleOptions = {},
  ): Promise<LoadedToolBundle> {
    if (!Buffer.isBuffer(bundleInput)) {
      const stats = await fs.promises.stat(bundleInput);
      if (stats.isDirectory()) {
        return this.loadFromDirectory(bundleInput, options);
      }
      const fileBuffer = await fs.promises.readFile(bundleInput);
      return this.loadFromArchiveBuffer(fileBuffer, options, bundleInput);
    }

    if (Buffer.isBuffer(bundleInput)) {
      return this.loadFromArchiveBuffer(bundleInput, options);
    }

    throw new Error("Invalid bundle input: must be a Buffer or valid file/directory path");
  }

  /**
   * Loads and extracts a bundle from a tar archive buffer.
   */
  private async loadFromArchiveBuffer(
    archiveBuffer: Buffer,
    options: LoadBundleOptions,
    sourceIdentifier?: string,
  ): Promise<LoadedToolBundle> {
    const rawDigest = computeSha256(archiveBuffer);
    const isDev = this.isDev(options);
    const requireSig = this.shouldRequireSignature(options);

    // 1. Parse tar archive safely
    let entries: ExtractedTarEntry[];
    try {
      entries = parseTarArchive(archiveBuffer);
    } catch (err) {
      await this.quarantine.quarantinePayload(
        archiveBuffer,
        "corrupted_archive",
        { error: err instanceof Error ? err.message : String(err) },
        rawDigest,
        sourceIdentifier,
      );
      throw err;
    }
    const sigEntry = entries.find((e) => e.path === BUNDLE_FILE_SIGNATURE);
    if (requireSig && !sigEntry) {
      const err = new BundleSignatureError(
        "Bundle signature is required in production but signature.json is missing",
        undefined,
        "MISSING_SIGNATURE",
      );
      await this.quarantine.quarantinePayload(
        archiveBuffer,
        "signature_mismatch",
        { error: err.message, reason: "MISSING_SIGNATURE" },
        rawDigest,
        sourceIdentifier,
      );
      throw err;
    }

    if (options.expectedDigest) {
      const normalizedExpected = normalizeSha256(options.expectedDigest, false);
      const initialCandidateDigest = (() => {
        if (sigEntry) {
          try {
            const parsed = JSON.parse(sigEntry.content.toString("utf8"));
            if (parsed.bundleDigest) return normalizeSha256(parsed.bundleDigest, false);
          } catch {}
        }
        return normalizeSha256(rawDigest, false);
      })();

      if (
        normalizedExpected !== normalizeSha256(rawDigest, false) &&
        normalizedExpected !== initialCandidateDigest
      ) {
        const err = new BundleSecurityError(
          "DIGEST_MISMATCH",
          `Archive buffer SHA-256 digest ${rawDigest} does not match expected digest ${options.expectedDigest}`,
          sourceIdentifier,
          { expectedDigest: options.expectedDigest, actualDigest: rawDigest },
        );
        await this.quarantine.quarantinePayload(
          archiveBuffer,
          "digest_mismatch",
          { error: err.message, expectedDigest: options.expectedDigest, actualDigest: rawDigest },
          rawDigest,
          sourceIdentifier,
        );
        throw err;
      }
    }

    let stagingPath: string | null = null;
    let digest = rawDigest;

    try {
      // 2. Extract entries safely into staging directory
      stagingPath = await this.cache.createStagingDirectory(rawDigest);
      const tracker = new BundleResourceTracker(archiveBuffer.length, this.limits);

      for (const entry of entries) {
        // Validate entry path against directory traversal
        const targetPath = resolveSafeTargetPath(stagingPath, entry.path);

        // Reject symlinks and unsupported entry types
        if (
          entry.typeflag &&
          entry.typeflag !== "0" &&
          entry.typeflag !== "\0" &&
          entry.typeflag !== "5"
        ) {
          throw new BundleSecurityError(
            "SYMLINK_ESCAPE",
            `Prohibited entry typeflag '${entry.typeflag}' for ${entry.path}`,
            entry.path,
          );
        }

        // Enforce resource limits & decompression bomb protection
        tracker.trackEntry(entry.path, entry.size);

        if (entry.typeflag === "5" || entry.path.endsWith("/")) {
          await fs.promises.mkdir(targetPath, { recursive: true, mode: 0o700 });
        } else {
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
          await fs.promises.writeFile(targetPath, entry.content, {
            mode: entry.mode ?? 0o644,
            flag: "w",
          });

          const stat = await fs.promises.lstat(targetPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new BundleSecurityError(
              "SYMLINK_ESCAPE",
              `Non-regular file detected during extraction: ${targetPath}`,
              targetPath,
            );
          }
        }
      }

      // 3. Recompute complete normalized file-digest map and unsigned archive digest from actual extracted regular files on disk
      const scanned = await scanExtractedRegularFiles(stagingPath);
      const unsignedFiles = scanned.files.filter((f) => f.path !== BUNDLE_FILE_SIGNATURE);
      const { archive: recomputedUnsignedArchive } = encodeDeterministicTar(unsignedFiles);
      const recomputedUnsignedArchiveDigest = computeSha256(recomputedUnsignedArchive);

      if (sigEntry) {
        let signatureData: BundleSignatureData;
        try {
          signatureData = BundleSignatureDataSchema.parse(
            JSON.parse(sigEntry.content.toString("utf8")),
          );
        } catch (err) {
          throw new BundleSignatureError(
            `Invalid signature.json schema: ${err instanceof Error ? err.message : String(err)}`,
            undefined,
            "INVALID_SIGNATURE",
          );
        }

        // Check unsigned archive digest
        if (
          normalizeSha256(signatureData.bundleDigest, false) !==
          normalizeSha256(recomputedUnsignedArchiveDigest, false)
        ) {
          throw new BundleSignatureError(
            `Bundle unsigned archive digest mismatch: signed ${signatureData.bundleDigest} does not match extracted unsigned archive ${recomputedUnsignedArchiveDigest}`,
            signatureData.keyId,
            "BUNDLE_DIGEST_MISMATCH",
          );
        }

        // Check complete normalized file-digest map: reject missing, extra, or replaced files
        const signedFileMap = signatureData.fileDigests ?? {};
        const signedKeys = Object.keys(signedFileMap).filter((k) => k !== BUNDLE_FILE_SIGNATURE);
        const extractedKeys = Object.keys(scanned.fileDigests).filter(
          (k) => k !== BUNDLE_FILE_SIGNATURE,
        );

        for (const signedFile of signedKeys) {
          if (!(signedFile in scanned.fileDigests)) {
            throw new BundleValidationError(
              `Missing signed file '${signedFile}' in extracted bundle`,
              { reason: "signature_mismatch" },
            );
          }
          if (
            normalizeSha256(scanned.fileDigests[signedFile], false) !==
            normalizeSha256(signedFileMap[signedFile], false)
          ) {
            throw new BundleValidationError(
              `File digest mismatch for '${signedFile}': signed ${signedFileMap[signedFile]}, actual extracted ${scanned.fileDigests[signedFile]}`,
              { reason: "signature_mismatch" },
            );
          }
        }

        for (const extFile of extractedKeys) {
          if (!(extFile in signedFileMap)) {
            throw new BundleValidationError(
              `Unexpected unsigned file '${extFile}' in extracted bundle`,
              { reason: "signature_mismatch" },
            );
          }
        }

        // Cryptographic signature verification
        const verifyResult = await verifyBundleSignature(signatureData, this.keyStore, {
          allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
          expectedBundleDigest: recomputedUnsignedArchiveDigest,
          expectedFileDigests: scanned.fileDigests,
        });

        if (!verifyResult.valid) {
          throw new BundleSignatureError(
            `Bundle signature verification failed: ${verifyResult.error ?? verifyResult.reason}`,
            verifyResult.keyId,
            verifyResult.reason,
          );
        }

        digest = signatureData.bundleDigest;
      } else if (requireSig) {
        throw new BundleSignatureError(
          "Bundle signature is required in production but signature.json is missing",
          undefined,
          "MISSING_SIGNATURE",
        );
      } else {
        digest = recomputedUnsignedArchiveDigest;
      }

      if (options.expectedDigest) {
        const normalizedExpected = normalizeSha256(options.expectedDigest, false);
        if (
          normalizedExpected !== normalizeSha256(digest, false) &&
          normalizedExpected !== normalizeSha256(rawDigest, false) &&
          normalizedExpected !== normalizeSha256(recomputedUnsignedArchiveDigest, false)
        ) {
          throw new BundleSecurityError(
            "DIGEST_MISMATCH",
            `Archive digest '${digest}' does not match expected digest '${options.expectedDigest}'`,
            stagingPath ?? undefined,
            { expectedDigest: options.expectedDigest, actualDigest: digest },
          );
        }
      }

      // 4. Validate manifest & layout
      const manifestPath = path.join(stagingPath, BUNDLE_FILE_MANIFEST);
      if (!fs.existsSync(manifestPath)) {
        throw new BundleValidationError(`Bundle is missing required ${BUNDLE_FILE_MANIFEST}`);
      }

      const manifestContent = await fs.promises.readFile(manifestPath, "utf8");
      let manifest: ToolManifest;
      try {
        manifest = ToolManifestSchema.parse(JSON.parse(manifestContent));
      } catch (err) {
        throw new BundleValidationError(
          `Invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (manifest.capabilities?.secrets?.denyDirectRead === false) {
        throw new BundleValidationError(
          `Bundle '${manifest.id}' requires direct secret reads (denyDirectRead: false), which is incompatible with protocol v1.0.0. Migrate tool to use opaque secret references (broker.secret.createReference / bearerToken) and trusted broker mediation.`,
        );
      }

      const hasEntrypointTs = fs.existsSync(path.join(stagingPath, BUNDLE_FILE_ENTRYPOINT_TS));
      const hasEntrypointJs = fs.existsSync(path.join(stagingPath, BUNDLE_FILE_ENTRYPOINT_JS));
      if (!hasEntrypointTs && !hasEntrypointJs) {
        throw new BundleValidationError(
          `Bundle is missing entrypoint file (${BUNDLE_FILE_ENTRYPOINT_TS} or ${BUNDLE_FILE_ENTRYPOINT_JS})`,
        );
      }

      // Check package.json / package-lock.json when signed
      if (sigEntry) {
        const sigObj = JSON.parse(sigEntry.content.toString("utf8"));
        if (
          sigObj.fileDigests?.[BUNDLE_FILE_PACKAGE] &&
          !fs.existsSync(path.join(stagingPath, BUNDLE_FILE_PACKAGE))
        ) {
          throw new BundleValidationError(
            `Signed file '${BUNDLE_FILE_PACKAGE}' is missing from extracted bundle`,
            { reason: "signature_mismatch" },
          );
        }
        if (
          sigObj.fileDigests?.[BUNDLE_FILE_PACKAGE_LOCK] &&
          !fs.existsSync(path.join(stagingPath, BUNDLE_FILE_PACKAGE_LOCK))
        ) {
          throw new BundleValidationError(
            `Signed file '${BUNDLE_FILE_PACKAGE_LOCK}' is missing from extracted bundle`,
            { reason: "signature_mismatch" },
          );
        }
      }

      // 5. Validate qualification bundle if present or required
      const qualResult = await this.validateQualification(stagingPath, options, manifest);

      // 6. Inspect bundle metadata
      const inspection = await inspectBundleDirectory(stagingPath, {
        keyStore: this.keyStore,
        allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
      });

      // 7. Commit staging directory to cache
      const metadata: ExtractionMetadata = {
        digest,
        extractedAt: new Date().toISOString(),
        fileCount: scanned.files.length,
        totalSizeBytes: scanned.totalBytes,
        entrypoint: inspection.entrypoint,
        verified: true,
      };

      // 7. Check cache / commit staging directory to cache
      if (!options.forceReExtract && this.cache.hasArtifact(digest)) {
        const artifactDir = this.cache.getArtifactPath(digest);
        try {
          const isHealthy = await this.cache.verifyArtifactIntegrity(digest);
          if (!isHealthy) {
            throw new BundleValidationError("Cached artifact integrity check failed", {
              reason: "corrupted_archive",
            });
          }

          const cachedManifest = this.cache.getArtifactManifest(digest);
          if (!cachedManifest) {
            throw new BundleValidationError(`Cached artifact missing manifest in ${artifactDir}`, {
              reason: "manifest_invalid",
            });
          }

          // 1. Re-scan and verify all regular files on disk in cache (no symlinks, no special files)
          const cachedScan = await scanExtractedRegularFiles(artifactDir);
          const cachedUnsignedFiles = cachedScan.files.filter(
            (f) => f.path !== BUNDLE_FILE_SIGNATURE,
          );
          const { archive: recomputedCachedArchive } = encodeDeterministicTar(cachedUnsignedFiles);
          const recomputedCachedDigest = computeSha256(recomputedCachedArchive);

          // 2. Re-verify signature on cached files
          const cachedSigPath = path.join(artifactDir, BUNDLE_FILE_SIGNATURE);
          const hasCachedSig = fs.existsSync(cachedSigPath);

          if (requireSig && !hasCachedSig) {
            throw new BundleSignatureError(
              "Bundle signature is required in production but signature.json is missing in cache",
              undefined,
              "MISSING_SIGNATURE",
            );
          }

          if (hasCachedSig) {
            const sigContent = await fs.promises.readFile(cachedSigPath, "utf8");
            const signatureData = BundleSignatureDataSchema.parse(JSON.parse(sigContent));

            if (
              normalizeSha256(signatureData.bundleDigest, false) !==
              normalizeSha256(recomputedCachedDigest, false)
            ) {
              throw new BundleSignatureError(
                `Cached unsigned archive digest mismatch: signed ${signatureData.bundleDigest} does not match recomputed ${recomputedCachedDigest}`,
                signatureData.keyId,
                "BUNDLE_DIGEST_MISMATCH",
              );
            }

            const signedFileMap = signatureData.fileDigests ?? {};
            const signedKeys = Object.keys(signedFileMap).filter(
              (k) => k !== BUNDLE_FILE_SIGNATURE,
            );
            const cachedKeys = Object.keys(cachedScan.fileDigests).filter(
              (k) => k !== BUNDLE_FILE_SIGNATURE,
            );

            for (const signedFile of signedKeys) {
              if (!(signedFile in cachedScan.fileDigests)) {
                throw new BundleValidationError(
                  `Missing signed file '${signedFile}' in cached bundle directory`,
                  { reason: "signature_mismatch" },
                );
              }
              if (
                normalizeSha256(cachedScan.fileDigests[signedFile], false) !==
                normalizeSha256(signedFileMap[signedFile], false)
              ) {
                throw new BundleValidationError(
                  `File digest mismatch for '${signedFile}' in cache`,
                  { reason: "signature_mismatch" },
                );
              }
            }

            for (const cachedFile of cachedKeys) {
              if (!(cachedFile in signedFileMap)) {
                throw new BundleValidationError(
                  `Unexpected unsigned file '${cachedFile}' in cached bundle directory`,
                  { reason: "signature_mismatch" },
                );
              }
            }

            const verifyResult = await verifyBundleSignature(signatureData, this.keyStore, {
              allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
              expectedBundleDigest: recomputedCachedDigest,
              expectedFileDigests: cachedScan.fileDigests,
            });

            if (!verifyResult.valid) {
              throw new BundleSignatureError(
                `Cached bundle signature verification failed: ${verifyResult.error ?? verifyResult.reason}`,
                verifyResult.keyId,
                verifyResult.reason,
              );
            }
          }

          // 3. Re-validate qualification, source digest, and dependency/lock graph on cached directory
          const cachedQualResult = await this.validateQualification(
            artifactDir,
            options,
            cachedManifest,
          );

          // Safe cache hit: clean up staging directory and return cached bundle
          await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});

          if (options.reference) {
            const refObj: ArtifactReference = {
              refId: options.reference,
              refType: "active",
              createdAt: new Date().toISOString(),
            };
            await this.cache.acquireReference(digest, refObj);
          }

          const cachedInspection = await inspectBundleDirectory(artifactDir, {
            keyStore: this.keyStore,
            allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
          });

          const entrypointPath = path.join(artifactDir, cachedInspection.entrypoint);
          const cachedBundle: LoadedToolBundle = {
            digest,
            artifactDir,
            entrypointPath,
            manifest: cachedManifest,
            inspection: cachedInspection,
            isCached: true,
            approval: cachedQualResult.approval,
            effectProfile: cachedQualResult.effectProfile,
            qualification: cachedQualResult.qualification,
            qualificationToken: cachedQualResult.qualificationToken,
            isApproved: cachedQualResult.isApproved,
          };

          if (cachedQualResult.qualificationToken) {
            const vData = getVerifiedQualificationData(cachedQualResult.qualificationToken);
            if (vData) registerVerifiedHostObject(cachedBundle, vData);
          }

          return cachedBundle;
        } catch (err) {
          // Quarantine and invalidate corrupted/tampered cache entry
          let quarantineReason: QuarantineReason = "approval_drift";
          if (err instanceof BundleSignatureError) {
            quarantineReason =
              err.reason === "unapproved_candidate"
                ? "unapproved_candidate"
                : err.reason === "approval_drift"
                  ? "approval_drift"
                  : "signature_mismatch";
          } else if (err instanceof BundleValidationError) {
            // SAFETY: BundleValidationError details are validated by constructor and reason matches QuarantineReason union
            const detailsReason = err.details?.reason as QuarantineReason | undefined;
            quarantineReason = detailsReason ?? "approval_drift";
          }
          await this.quarantine
            .quarantineDirectory(
              artifactDir,
              quarantineReason,
              { error: err instanceof Error ? err.message : String(err), cacheDrift: true, digest },
              digest,
              artifactDir,
              { preserveSource: true },
            )
            .catch(() => {});

          await this.cache.invalidateArtifact(digest).catch(() => {});
          throw err;
        }
      }

      const finalArtifactDir = await this.cache.commitStagingDirectory(
        stagingPath,
        digest,
        metadata,
      );

      if (options.reference) {
        const refObj: ArtifactReference = {
          refId: options.reference,
          refType: "active",
          createdAt: new Date().toISOString(),
        };
        await this.cache.acquireReference(digest, refObj);
      }
      const entrypointPath = path.join(finalArtifactDir, inspection.entrypoint);

      const loadedBundle: LoadedToolBundle = {
        digest,
        artifactDir: finalArtifactDir,
        entrypointPath,
        manifest,
        inspection,
        isCached: false,
        approval: qualResult.approval,
        effectProfile: qualResult.effectProfile,
        qualification: qualResult.qualification,
        qualificationToken: qualResult.qualificationToken,
        isApproved: qualResult.isApproved,
      };

      if (qualResult.qualificationToken) {
        const vData = getVerifiedQualificationData(qualResult.qualificationToken);
        if (vData) registerVerifiedHostObject(loadedBundle, vData);
      }

      return loadedBundle;
    } catch (err) {
      if (stagingPath) {
        await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      }

      let quarantineReason: QuarantineReason = "corrupted_archive";
      if (err instanceof BundleSignatureError) {
        quarantineReason =
          err.reason === "unapproved_candidate"
            ? "unapproved_candidate"
            : err.reason === "approval_drift"
              ? "approval_drift"
              : "signature_mismatch";
      } else if (err instanceof BundleSecurityError) {
        if (err.code === "DIGEST_MISMATCH") {
          quarantineReason = "digest_mismatch";
        } else if (err.code === "PATH_TRAVERSAL" || err.code === "ABSOLUTE_PATH") {
          quarantineReason = "path_traversal";
        } else if (err.code === "DECOMPRESSION_BOMB_DETECTED") {
          quarantineReason = "decompression_bomb";
        } else if (err.code === "SYMLINK_ESCAPE") {
          quarantineReason = "symlink_escape";
        } else if (
          err.code === "FILE_COUNT_EXCEEDED" ||
          err.code === "FILE_SIZE_EXCEEDED" ||
          err.code === "DECOMPRESSED_SIZE_EXCEEDED"
        ) {
          quarantineReason = "resource_limit_exceeded";
        }
      } else if (err instanceof BundleValidationError) {
        // SAFETY: BundleValidationError details are validated by constructor and reason matches QuarantineReason union
        const detailsReason = err.details?.reason as QuarantineReason | undefined;
        if (detailsReason) {
          quarantineReason = detailsReason;
        } else if (err.message.includes("qualification") || err.message.includes("approval")) {
          quarantineReason =
            err.message.includes("drift") || err.message.includes("mismatch")
              ? "approval_drift"
              : "unapproved_candidate";
        } else {
          quarantineReason = "manifest_invalid";
        }
      }

      await this.quarantine.quarantinePayload(
        archiveBuffer,
        quarantineReason,
        { error: err instanceof Error ? err.message : String(err) },
        digest,
        sourceIdentifier,
      );

      throw err;
    }
  }

  /**
   * Loads a bundle directly from a local directory (e.g. workspace or test fixture).
   */
  private async loadFromDirectory(
    dirPath: string,
    options: LoadBundleOptions,
  ): Promise<LoadedToolBundle> {
    const resolvedDir = path.resolve(dirPath);
    const isDev = this.isDev(options);
    const requireSig = this.shouldRequireSignature(options);
    const sigPath = path.join(resolvedDir, BUNDLE_FILE_SIGNATURE);
    const hasSig = fs.existsSync(sigPath);

    if (requireSig && !hasSig) {
      const err = new BundleSignatureError(
        "Bundle signature is required in production but signature.json is missing",
        undefined,
        "MISSING_SIGNATURE",
      );
      await this.quarantine.quarantineDirectory(
        resolvedDir,
        "signature_mismatch",
        { error: err.message, reason: "MISSING_SIGNATURE" },
        undefined,
        resolvedDir,
        { preserveSource: true },
      );
      throw err;
    }

    const manifestPath = path.join(resolvedDir, BUNDLE_FILE_MANIFEST);
    let stagingPath: string | null = null;

    try {
      const dirStat = await fs.promises.lstat(resolvedDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new BundleValidationError(`Invalid directory: ${dirPath}`, {
          reason: "corrupted_archive",
        });
      }

      if (!fs.existsSync(manifestPath)) {
        throw new BundleValidationError(`Directory is missing ${BUNDLE_FILE_MANIFEST}`);
      }

      const manifestContent = await fs.promises.readFile(manifestPath, "utf8");
      let manifest: ToolManifest;
      try {
        manifest = ToolManifestSchema.parse(JSON.parse(manifestContent));
      } catch (err) {
        throw new BundleValidationError(
          `Invalid manifest in directory: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "manifest_invalid" },
        );
      }

      if (manifest.capabilities?.secrets?.denyDirectRead === false) {
        throw new BundleValidationError(
          `Bundle '${manifest.id}' requires direct secret reads (denyDirectRead: false), which is incompatible with protocol v1.0.0. Migrate tool to use opaque secret references (broker.secret.createReference / bearerToken) and trusted broker mediation.`,
        );
      }

      const hasEntrypointTs = fs.existsSync(path.join(resolvedDir, BUNDLE_FILE_ENTRYPOINT_TS));
      const hasEntrypointJs = fs.existsSync(path.join(resolvedDir, BUNDLE_FILE_ENTRYPOINT_JS));
      if (!hasEntrypointTs && !hasEntrypointJs) {
        throw new BundleValidationError(
          `Directory is missing entrypoint file (${BUNDLE_FILE_ENTRYPOINT_TS} or ${BUNDLE_FILE_ENTRYPOINT_JS})`,
        );
      }

      // Scan directory regular files
      const scanned = await scanExtractedRegularFiles(resolvedDir);
      const unsignedFiles = scanned.files.filter((f) => f.path !== BUNDLE_FILE_SIGNATURE);
      const { archive: recomputedUnsignedArchive } = encodeDeterministicTar(unsignedFiles);
      const recomputedUnsignedArchiveDigest = computeSha256(recomputedUnsignedArchive);

      let digest = recomputedUnsignedArchiveDigest;

      if (hasSig) {
        const sigContent = await fs.promises.readFile(sigPath, "utf8");
        const signatureData = BundleSignatureDataSchema.parse(JSON.parse(sigContent));

        if (
          normalizeSha256(signatureData.bundleDigest, false) !==
          normalizeSha256(recomputedUnsignedArchiveDigest, false)
        ) {
          throw new BundleSignatureError(
            `Bundle unsigned archive digest mismatch: signed ${signatureData.bundleDigest} does not match recomputed ${recomputedUnsignedArchiveDigest}`,
            signatureData.keyId,
            "BUNDLE_DIGEST_MISMATCH",
          );
        }

        const signedFileMap = signatureData.fileDigests ?? {};
        const signedKeys = Object.keys(signedFileMap).filter((k) => k !== BUNDLE_FILE_SIGNATURE);
        const dirKeys = Object.keys(scanned.fileDigests).filter((k) => k !== BUNDLE_FILE_SIGNATURE);

        for (const signedFile of signedKeys) {
          if (!(signedFile in scanned.fileDigests)) {
            throw new BundleValidationError(
              `Missing signed file '${signedFile}' in bundle directory`,
              { reason: "signature_mismatch" },
            );
          }
          if (
            normalizeSha256(scanned.fileDigests[signedFile], false) !==
            normalizeSha256(signedFileMap[signedFile], false)
          ) {
            throw new BundleValidationError(`File digest mismatch for '${signedFile}'`, {
              reason: "signature_mismatch",
            });
          }
        }

        for (const dirFile of dirKeys) {
          if (!(dirFile in signedFileMap)) {
            throw new BundleValidationError(
              `Unexpected unsigned file '${dirFile}' in bundle directory`,
              { reason: "signature_mismatch" },
            );
          }
        }

        const verifyResult = await verifyBundleSignature(signatureData, this.keyStore, {
          allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
          expectedBundleDigest: recomputedUnsignedArchiveDigest,
          expectedFileDigests: scanned.fileDigests,
        });

        if (!verifyResult.valid) {
          throw new BundleSignatureError(
            `Bundle signature verification failed: ${verifyResult.error ?? verifyResult.reason}`,
            verifyResult.keyId,
            verifyResult.reason,
          );
        }

        digest = signatureData.bundleDigest;
      }

      // Stage verified regular files into a fresh loader-owned directory (no mutable caller paths returned/executed)
      stagingPath = await this.cache.createStagingDirectory(digest);

      for (const file of scanned.files) {
        const targetPath = resolveSafeTargetPath(stagingPath, file.path);
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        const isExec = Boolean((file.mode && (file.mode & 0o111) !== 0) || file.executable);
        await fs.promises.writeFile(targetPath, file.content, {
          mode: isExec ? 0o755 : 0o600,
          flag: "w",
        });
      }

      // Re-hash post-copy to ensure exact byte parity
      const postCopyScan = await scanExtractedRegularFiles(stagingPath);
      const postCopyUnsigned = postCopyScan.files.filter((f) => f.path !== BUNDLE_FILE_SIGNATURE);
      const { archive: postCopyArchive } = encodeDeterministicTar(postCopyUnsigned);
      const postCopyDigest = computeSha256(postCopyArchive);

      if (
        normalizeSha256(postCopyDigest, false) !==
        normalizeSha256(recomputedUnsignedArchiveDigest, false)
      ) {
        throw new BundleValidationError(
          "Post-copy verification digest mismatch during directory staging",
          { reason: "corrupted_archive" },
        );
      }

      const qualResult = await this.validateQualification(stagingPath, options, manifest);

      const inspection = await inspectBundleDirectory(stagingPath, {
        keyStore: this.keyStore,
        allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
      });

      const metadata: ExtractionMetadata = {
        digest,
        extractedAt: new Date().toISOString(),
        fileCount: postCopyScan.files.length,
        totalSizeBytes: postCopyScan.totalBytes,
        entrypoint: inspection.entrypoint,
        verified: true,
      };

      const finalArtifactDir = await this.cache.commitStagingDirectory(
        stagingPath,
        digest,
        metadata,
      );

      if (options.reference) {
        const refObj: ArtifactReference = {
          refId: options.reference,
          refType: "active",
          createdAt: new Date().toISOString(),
        };
        await this.cache.acquireReference(digest, refObj);
      }

      const entrypointPath = path.join(finalArtifactDir, inspection.entrypoint);

      const loadedBundle: LoadedToolBundle = {
        digest,
        artifactDir: finalArtifactDir,
        entrypointPath,
        manifest,
        inspection,
        isCached: false,
        approval: qualResult.approval,
        effectProfile: qualResult.effectProfile,
        qualification: qualResult.qualification,
        qualificationToken: qualResult.qualificationToken,
        isApproved: qualResult.isApproved,
      };

      if (qualResult.qualificationToken) {
        const vData = getVerifiedQualificationData(qualResult.qualificationToken);
        if (vData) registerVerifiedHostObject(loadedBundle, vData);
      }

      return loadedBundle;
    } catch (err) {
      if (stagingPath) {
        await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      }

      let quarantineReason: QuarantineReason = "corrupted_archive";
      if (err instanceof BundleSignatureError) {
        quarantineReason =
          err.reason === "unapproved_candidate"
            ? "unapproved_candidate"
            : err.reason === "approval_drift"
              ? "approval_drift"
              : "signature_mismatch";
      } else if (err instanceof BundleSecurityError) {
        if (err.code === "DIGEST_MISMATCH") {
          quarantineReason = "digest_mismatch";
        } else if (err.code === "PATH_TRAVERSAL" || err.code === "ABSOLUTE_PATH") {
          quarantineReason = "path_traversal";
        } else if (err.code === "DECOMPRESSION_BOMB_DETECTED") {
          quarantineReason = "decompression_bomb";
        } else if (err.code === "SYMLINK_ESCAPE") {
          quarantineReason = "symlink_escape";
        } else if (
          err.code === "FILE_COUNT_EXCEEDED" ||
          err.code === "FILE_SIZE_EXCEEDED" ||
          err.code === "DECOMPRESSED_SIZE_EXCEEDED"
        ) {
          quarantineReason = "resource_limit_exceeded";
        }
      } else if (err instanceof BundleValidationError) {
        // SAFETY: BundleValidationError details are validated by constructor and reason matches QuarantineReason union
        const detailsReason = err.details?.reason as QuarantineReason | undefined;
        if (detailsReason) {
          quarantineReason = detailsReason;
        } else if (err.message.includes("qualification") || err.message.includes("approval")) {
          quarantineReason =
            err.message.includes("drift") || err.message.includes("mismatch")
              ? "approval_drift"
              : "unapproved_candidate";
        } else {
          quarantineReason = "manifest_invalid";
        }
      }

      await this.quarantine.quarantineDirectory(
        resolvedDir,
        quarantineReason,
        { error: err instanceof Error ? err.message : String(err) },
        undefined,
        resolvedDir,
        { preserveSource: true },
      );

      throw err;
    }
  }
}
