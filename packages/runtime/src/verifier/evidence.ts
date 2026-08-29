import crypto from "node:crypto";
import {
  CURRENT_SAFETY_GATE_VERSION,
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  type ToolManifest,
  type VerificationChecks,
  type VerificationDigests,
  type VerificationEvidenceRecord,
  VerificationEvidenceRecordSchema,
  canonicalJson,
  hashCanonical,
} from "@resin/contracts";
import { computeSha256 } from "../bundle/builder.js";
import { PINNED_SDK_DECLARATIONS } from "./compiler.js";
import type {
  CreateEvidenceParams,
  EvidenceVerificationResult,
  ExpectedVerificationContext,
} from "./types.js";

/**
 * Computes SHA-256 digest of a string in "sha256:<hex>" format.
 */
export function sha256Hex(content: string | Buffer | Uint8Array): string {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Computes deterministic composite evidence digest over all verified components.
 */
export function computeCompositeEvidenceDigest(params: {
  toolId: string;
  version: string;
  digests: Omit<VerificationDigests, "compositeEvidenceDigest">;
  checks: VerificationChecks;
  probePassCount: number;
}): string {
  const payload = {
    toolId: params.toolId,
    version: params.version,
    sourceDigest: params.digests.sourceDigest,
    manifestDigest: params.digests.manifestDigest,
    testsDigest: params.digests.testsDigest,
    sdkDigest: params.digests.sdkDigest,
    runtimeDigest: params.digests.runtimeDigest,
    policyDigest: params.digests.policyDigest,
    denoDigest: params.digests.denoDigest,
    artifactDigest: params.digests.artifactDigest,
    checks: params.checks,
    probePassCount: params.probePassCount,
  };

  return sha256Hex(canonicalJson(payload));
}

/**
 * Computes standard SDK, Runtime, Policy, and Deno component digests.
 */
export function computeStandardComponentDigests(
  options: {
    sdkVersion?: string;
    runtimeVersion?: string;
    brokerProtocolVersion?: string;
    policyVersion?: string;
    denoVersion?: string;
  } = {},
): {
  sdkDigest: string;
  runtimeDigest: string;
  policyDigest: string;
  denoDigest: string;
} {
  const sdkVer = options.sdkVersion ?? CURRENT_SAFETY_GATE_VERSION;
  const runtimeVer = options.runtimeVersion ?? REQUIRED_RUNTIME_VERSION;
  const protocolVer = options.brokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION;
  const policyVer = options.policyVersion ?? REQUIRED_POLICY_VERSION;
  const denoVer = options.denoVersion ?? "1.45.0";

  const sdkDigest = sha256Hex(`sdk:${sdkVer}:${PINNED_SDK_DECLARATIONS}`);
  const runtimeDigest = sha256Hex(`runtime:${runtimeVer}:protocol:${protocolVer}`);
  const policyDigest = sha256Hex(`policy:${policyVer}`);
  const denoDigest = sha256Hex(`deno:${denoVer}:bootstrap:1.0.0`);

  return {
    sdkDigest,
    runtimeDigest,
    policyDigest,
    denoDigest,
  };
}

/**
 * Generates a persisted, content-addressed VerificationEvidenceRecord.
 */
export function createVerificationEvidence(
  params: CreateEvidenceParams,
): VerificationEvidenceRecord {
  const now = new Date();
  const ttl = params.ttlSeconds ?? 90 * 24 * 60 * 60; // 90 days default
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

  const sourceDigest = sha256Hex(params.sourceCode);
  const manifestDigest = sha256Hex(canonicalJson(params.manifest));
  const testsDigest = sha256Hex(params.testsCode ?? "");
  const artifactDigest = params.artifactDigest ?? computeSha256(params.artifactBuffer);

  const standardDigests = computeStandardComponentDigests({
    sdkVersion: params.sdkVersion,
    runtimeVersion: params.runtimeVersion,
    brokerProtocolVersion: params.brokerProtocolVersion,
    policyVersion: params.policyVersion,
    denoVersion: params.denoVersion,
  });

  const probeResults = (params.probeResults ?? []).map((p) => ({
    probeId: p.probeId,
    name: p.name,
    passed: p.passed,
    details: p.error,
  }));

  const partialDigests = {
    sourceDigest,
    manifestDigest,
    testsDigest,
    sdkDigest: standardDigests.sdkDigest,
    runtimeDigest: standardDigests.runtimeDigest,
    policyDigest: standardDigests.policyDigest,
    denoDigest: standardDigests.denoDigest,
    artifactDigest,
  };

  const probePassCount = probeResults.filter((p) => p.passed).length;
  const compositeEvidenceDigest = computeCompositeEvidenceDigest({
    toolId: params.toolId,
    version: params.version,
    digests: partialDigests,
    checks: params.checkResults,
    probePassCount,
  });

  const digests: VerificationDigests = {
    ...partialDigests,
    compositeEvidenceDigest,
  };

  const allChecksPassed = Object.values(params.checkResults).every((v) => v === true);
  const allProbesPassed = probeResults.every((p) => p.passed);
  const status: "passed" | "failed" = allChecksPassed && allProbesPassed ? "passed" : "failed";

  const record: VerificationEvidenceRecord = {
    evidenceId: `evi_${crypto.randomUUID().replace(/-/g, "")}`,
    toolId: params.toolId,
    version: params.version,
    status,
    verifiedAt: now.toISOString(),
    expiresAt,
    digests,
    checks: params.checkResults,
    probeResults,
    metadata: {
      generatedBy: "resin-runtime-verifier",
      ...params.metadata,
    },
    signature: params.signature,
  };

  // Validate with Zod schema
  return VerificationEvidenceRecordSchema.parse(record);
}

/**
 * Validates that candidate verification evidence is present, valid, unexpired,
 * and matches all content digests.
 */
export function verifyVerificationEvidence(
  record: VerificationEvidenceRecord | unknown,
  context: ExpectedVerificationContext = {},
): EvidenceVerificationResult {
  if (!record || typeof record !== "object") {
    return {
      valid: false,
      errorCode: "MISSING_EVIDENCE",
      error: "Verification evidence record is missing or undefined.",
    };
  }

  const parsed = VerificationEvidenceRecordSchema.safeParse(record);
  if (!parsed.success) {
    return {
      valid: false,
      errorCode: "CORRUPTED_EVIDENCE",
      error: `Verification evidence record schema validation failed: ${parsed.error.message}`,
    };
  }

  const evidence = parsed.data;
  const now = context.now ?? new Date();

  // 1. Status check
  if (evidence.status !== "passed") {
    return {
      valid: false,
      errorCode: "FAILED_EVIDENCE",
      error: `Candidate verification evidence has status '${evidence.status}' and cannot advance.`,
    };
  }

  // 2. Expiration check
  const expiresAtDate = new Date(evidence.expiresAt);
  if (expiresAtDate <= now) {
    return {
      valid: false,
      errorCode: "EXPIRED_EVIDENCE",
      error: `Verification evidence expired at '${evidence.expiresAt}'. Re-verification required.`,
    };
  }

  // 3. Artifact digest check
  if (context.artifactDigest && evidence.digests.artifactDigest !== context.artifactDigest) {
    return {
      valid: false,
      errorCode: "DIGEST_MISMATCH",
      error: `Evidence artifact digest '${evidence.digests.artifactDigest}' does not match target artifact digest '${context.artifactDigest}'.`,
    };
  }

  // 4. Source digest check
  if (context.sourceCode) {
    const expectedSourceDigest = sha256Hex(context.sourceCode);
    if (evidence.digests.sourceDigest !== expectedSourceDigest) {
      return {
        valid: false,
        errorCode: "SOURCE_DIGEST_MISMATCH",
        error: `Evidence source digest '${evidence.digests.sourceDigest}' does not match target source digest '${expectedSourceDigest}'.`,
      };
    }
  }

  // 5. Manifest digest check
  if (context.manifest) {
    const expectedManifestDigest = sha256Hex(canonicalJson(context.manifest));
    if (evidence.digests.manifestDigest !== expectedManifestDigest) {
      return {
        valid: false,
        errorCode: "MANIFEST_DIGEST_MISMATCH",
        error: `Evidence manifest digest '${evidence.digests.manifestDigest}' does not match target manifest digest '${expectedManifestDigest}'.`,
      };
    }
  }

  // 6. Runtime digest check
  if (context.runtimeVersion) {
    const standardDigests = computeStandardComponentDigests({
      runtimeVersion: context.runtimeVersion,
      policyVersion: context.policyVersion,
    });
    if (evidence.digests.runtimeDigest !== standardDigests.runtimeDigest) {
      return {
        valid: false,
        errorCode: "RUNTIME_VERSION_MISMATCH",
        error: `Evidence was generated against a different runtime digest '${evidence.digests.runtimeDigest}', expected '${standardDigests.runtimeDigest}'.`,
      };
    }
  }

  // 7. Recompute composite evidence digest
  const probePassCount = evidence.probeResults.filter((p) => p.passed).length;
  const recomputedComposite = computeCompositeEvidenceDigest({
    toolId: evidence.toolId,
    version: evidence.version,
    digests: evidence.digests,
    checks: evidence.checks,
    probePassCount,
  });

  if (evidence.digests.compositeEvidenceDigest !== recomputedComposite) {
    return {
      valid: false,
      errorCode: "COMPOSITE_DIGEST_MISMATCH",
      error: "Verification evidence composite digest failed cryptographic recomputation check.",
    };
  }

  // 8. Check all checks passed
  const failedChecks = Object.entries(evidence.checks).filter(([, passed]) => !passed);
  if (failedChecks.length > 0) {
    return {
      valid: false,
      errorCode: "UNMET_CHECK",
      error: `Verification evidence contains unmet checks: ${failedChecks.map(([c]) => c).join(", ")}.`,
    };
  }

  return { valid: true };
}
