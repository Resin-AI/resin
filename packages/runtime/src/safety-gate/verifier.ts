import crypto from "node:crypto";
import fs from "node:fs";
import {
  CURRENT_SAFETY_GATE_VERSION,
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  REQUIRED_SAFETY_CHECKS,
  SAFETY_GATE_ERROR_CODES,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
  type SafetyGateErrorCode,
  canonicalJson,
} from "@resin/contracts";

export interface AttestationVerificationResult {
  valid: boolean;
  errorCode?: SafetyGateErrorCode;
  error?: string;
  remediation?: string;
  record?: SafetyAttestationRecord;
}

export interface AttestationVerifierOptions {
  expectedRuntimeVersion?: string;
  expectedBrokerProtocolVersion?: string;
  expectedBundleVerifierVersion?: string;
  expectedPolicyVersion?: string;
  trustedPublicKeys?: Map<string, string>;
  allowUnsigned?: boolean;
  allowUnsignedTestAttestations?: boolean;
}

export interface SafetyCertificationEvidence {
  evidenceVersion: "1.0.0";
  generatedAt: string;
  componentDigests: Record<string, string>;
  deno: {
    executable: string;
    version: string;
    digest?: string;
  };
  probes: Record<string, { passed: boolean; details?: string }>;
}

export interface SignedSafetyAttestationOptions {
  environment: "production" | "staging" | "development" | "test";
  evidence: SafetyCertificationEvidence;
  privateKeyPem: string;
  keyId: string;
  validityMs?: number;
  now?: Date;
  compatibility?: Partial<SafetyAttestationRecord["compatibility"]>;
  metadata?: Record<string, unknown>;
}

function decodeSignature(signature: string): Buffer {
  if (/^[0-9a-f]+$/i.test(signature) && signature.length % 2 === 0) {
    return Buffer.from(signature, "hex");
  }
  return Buffer.from(signature, "base64");
}

function buildUnsignedPayload(
  record: SafetyAttestationRecord,
): Omit<SafetyAttestationRecord, "signature"> {
  return {
    attestationId: record.attestationId,
    schemaVersion: record.schemaVersion,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    environment: record.environment,
    compatibility: record.compatibility,
    checks: record.checks,
    metadata: record.metadata,
  };
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/i.test(value);
}

/**
 * Verifies production safety attestations against explicitly trusted keys and
 * evidence bound to exact Runtime components. Unknown keys and unsigned
 * production/staging records always fail closed.
 */
export class AttestationVerifier {
  private readonly expectedRuntimeVersion: string;
  private readonly expectedBrokerProtocolVersion: string;
  private readonly expectedBundleVerifierVersion: string;
  private readonly expectedPolicyVersion: string;
  private readonly trustedPublicKeys: Map<string, string>;
  private readonly allowUnsigned: boolean;
  private readonly allowUnsignedTestAttestations: boolean;

  constructor(options: AttestationVerifierOptions = {}) {
    this.expectedRuntimeVersion = options.expectedRuntimeVersion ?? REQUIRED_RUNTIME_VERSION;
    this.expectedBrokerProtocolVersion =
      options.expectedBrokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION;
    this.expectedBundleVerifierVersion =
      options.expectedBundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION;
    this.expectedPolicyVersion = options.expectedPolicyVersion ?? REQUIRED_POLICY_VERSION;
    this.trustedPublicKeys = options.trustedPublicKeys ?? new Map();
    this.allowUnsigned = options.allowUnsigned ?? false;
    this.allowUnsignedTestAttestations =
      options.allowUnsignedTestAttestations ??
      Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
  }

  verify(input: unknown, now = new Date()): AttestationVerificationResult {
    if (!input || typeof input !== "object") {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION,
        error: "Safety attestation record is missing or not an object.",
        remediation: "Run 'resin repair' to execute local safety certification.",
      };
    }

    const parseResult = SafetyAttestationRecordSchema.safeParse(input);
    if (!parseResult.success) {
      const issueSummary = parseResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
        error: `Safety attestation record is malformed or corrupted: ${issueSummary}`,
        remediation: "Re-run local safety certification with 'resin repair'.",
      };
    }

    const record = parseResult.data;
    const issuedAtTime = Date.parse(record.issuedAt);
    const expiresAtTime = Date.parse(record.expiresAt);
    const nowTime = now.getTime();
    if (
      Number.isNaN(issuedAtTime) ||
      Number.isNaN(expiresAtTime) ||
      issuedAtTime > nowTime + 300_000
    ) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
        error: "Attestation contains invalid or future-dated timestamps.",
        remediation: "Re-run local safety certification.",
        record,
      };
    }
    if (expiresAtTime <= nowTime) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION,
        error: `Safety attestation expired on ${record.expiresAt}.`,
        remediation: "Renew the safety attestation with 'resin repair'.",
        record,
      };
    }

    const { compatibility } = record;
    const mismatches = [
      ["Runtime version", compatibility.runtimeVersion, this.expectedRuntimeVersion],
      ["Broker protocol", compatibility.brokerProtocolVersion, this.expectedBrokerProtocolVersion],
      ["Bundle verifier", compatibility.bundleVerifierVersion, this.expectedBundleVerifierVersion],
      ["Policy", compatibility.policyVersion, this.expectedPolicyVersion],
    ] as const;
    for (const [label, actual, expected] of mismatches) {
      if (actual !== expected) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION,
          error: `${label} mismatch: attestation has ${actual}, expected ${expected}.`,
          remediation: "Re-run local safety certification after the installation update.",
          record,
        };
      }
    }

    for (const checkName of REQUIRED_SAFETY_CHECKS) {
      if (record.checks[checkName] !== true) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.UNMET_SAFETY_CHECK,
          error: `Mandatory safety check '${checkName}' is not satisfied in attestation.`,
          remediation: `Resolve and re-run safety probe '${checkName}'.`,
          record,
        };
      }
    }

    const isProductionLike =
      record.environment === "production" || record.environment === "staging";
    if (isProductionLike) {
      const evidenceDigest = record.metadata?.evidenceDigest;
      const componentDigests = record.metadata?.componentDigests;
      if (!validSha256(evidenceDigest)) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
          error: "Production attestation is not bound to certification evidence.",
          remediation: "Run evidence-backed local safety certification.",
          record,
        };
      }
      if (!componentDigests || typeof componentDigests !== "object") {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
          error: "Production attestation is missing component digests.",
          remediation: "Run evidence-backed local safety certification.",
          record,
        };
      }
      const requiredComponents = [
        "runtime",
        "worker",
        "bootstrap",
        "commandBroker",
        "secretBroker",
      ];
      for (const component of requiredComponents) {
        if (!validSha256((componentDigests as Record<string, unknown>)[component])) {
          return {
            valid: false,
            errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
            error: `Production attestation is missing a valid '${component}' component digest.`,
            remediation: "Run evidence-backed local safety certification.",
            record,
          };
        }
      }
    }

    if (record.signature) {
      if (!this.verifySignature(record)) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INVALID_SIGNATURE,
          error: "Attestation signature is invalid or its key is not trusted.",
          remediation: "Re-certify with the installation's trusted safety key.",
          record,
        };
      }
    } else {
      const testOnlyAllowed = record.environment === "test" && this.allowUnsignedTestAttestations;
      if (!this.allowUnsigned && !testOnlyAllowed) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INVALID_SIGNATURE,
          error: "Unsigned attestation rejected by fail-closed policy.",
          remediation: "Run signed local safety certification.",
          record,
        };
      }
    }

    return { valid: true, record };
  }

  private verifySignature(record: SafetyAttestationRecord): boolean {
    if (!record.signature) return false;
    const publicKey = this.trustedPublicKeys.get(record.signature.keyId);
    if (!publicKey) return false;
    const canonical = Buffer.from(canonicalJson(buildUnsignedPayload(record)), "utf8");
    const signature = decodeSignature(record.signature.signature);
    try {
      if (record.signature.algorithm === "ed25519") {
        return crypto.verify(null, canonical, publicKey, signature);
      }
      const verifier = crypto.createVerify("sha256");
      verifier.update(canonical);
      verifier.end();
      return verifier.verify(publicKey, signature);
    } catch {
      return false;
    }
  }
}

export function createSignedSafetyAttestation(
  options: SignedSafetyAttestationOptions,
): SafetyAttestationRecord {
  const failedProbe = Object.entries(options.evidence.probes).find(([, probe]) => !probe.passed);
  if (failedProbe) {
    throw new Error(
      `Cannot certify failed safety probe '${failedProbe[0]}': ${failedProbe[1].details ?? "failed"}`,
    );
  }
  const now = options.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (options.validityMs ?? 30 * 24 * 60 * 60 * 1000),
  ).toISOString();
  const evidenceDigest = crypto
    .createHash("sha256")
    .update(canonicalJson(options.evidence))
    .digest("hex");
  const recordWithoutSignature: Omit<SafetyAttestationRecord, "signature"> = {
    attestationId: `att_${crypto.randomUUID().replace(/-/g, "")}`,
    schemaVersion: CURRENT_SAFETY_GATE_VERSION,
    issuedAt,
    expiresAt,
    environment: options.environment,
    compatibility: {
      runtimeVersion: options.compatibility?.runtimeVersion ?? REQUIRED_RUNTIME_VERSION,
      brokerProtocolVersion:
        options.compatibility?.brokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION,
      bundleVerifierVersion:
        options.compatibility?.bundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION,
      policyVersion: options.compatibility?.policyVersion ?? REQUIRED_POLICY_VERSION,
    },
    checks: {
      sandboxIsolation: true,
      networkIsolation: true,
      filesystemMediation: true,
      secretRedaction: true,
      secretNonDisclosure: true,
      signatureVerification: true,
      bundleVerification: true,
      commandIdentity: true,
      resourceLimits: true,
    },
    metadata: {
      generatedBy: "resin-safety-certifier",
      evidenceDigest,
      componentDigests: options.evidence.componentDigests,
      deno: options.evidence.deno,
      probes: options.evidence.probes,
      ...options.metadata,
    },
  };
  const canonical = Buffer.from(canonicalJson(recordWithoutSignature), "utf8");
  const signature = crypto.sign(null, canonical, options.privateKeyPem).toString("base64");
  return SafetyAttestationRecordSchema.parse({
    ...recordWithoutSignature,
    signature: {
      keyId: options.keyId,
      algorithm: "ed25519",
      signature,
      signedAt: issuedAt,
    },
  });
}

/**
 * Test-only helper. It cannot mint a production/staging record and is unsigned
 * by design so tests must opt into unsigned test attestations explicitly.
 */
export function createSafetyAttestation(
  overrides: Partial<SafetyAttestationRecord> = {},
): SafetyAttestationRecord {
  const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
  const environment = overrides.environment ?? "test";
  if (!isTestRuntime || environment !== "test") {
    throw new Error(
      "createSafetyAttestation is test-only. Use createSignedSafetyAttestation with executed evidence.",
    );
  }
  const now = new Date();
  const componentDigests = {
    runtime: "1".repeat(64),
    worker: "2".repeat(64),
    bootstrap: "3".repeat(64),
    commandBroker: "4".repeat(64),
    secretBroker: "5".repeat(64),
  };
  return SafetyAttestationRecordSchema.parse({
    attestationId: overrides.attestationId ?? `att_test_${crypto.randomUUID().replace(/-/g, "")}`,
    schemaVersion: overrides.schemaVersion ?? CURRENT_SAFETY_GATE_VERSION,
    issuedAt: overrides.issuedAt ?? now.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    environment: "test",
    compatibility: {
      runtimeVersion: overrides.compatibility?.runtimeVersion ?? REQUIRED_RUNTIME_VERSION,
      brokerProtocolVersion:
        overrides.compatibility?.brokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION,
      bundleVerifierVersion:
        overrides.compatibility?.bundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION,
      policyVersion: overrides.compatibility?.policyVersion ?? REQUIRED_POLICY_VERSION,
    },
    checks: {
      sandboxIsolation: true,
      networkIsolation: true,
      filesystemMediation: true,
      secretRedaction: true,
      secretNonDisclosure: true,
      signatureVerification: true,
      bundleVerification: true,
      commandIdentity: true,
      resourceLimits: true,
      ...overrides.checks,
    },
    metadata: {
      generatedBy: "resin-test-helper",
      evidenceDigest: "a".repeat(64),
      componentDigests,
      ...overrides.metadata,
    },
    signature: overrides.signature,
  });
}

export function loadTrustedAttestationKey(
  keyId: string,
  publicKeyPath: string,
): Map<string, string> {
  const keys = new Map<string, string>();
  if (fs.existsSync(publicKeyPath)) {
    keys.set(keyId, fs.readFileSync(publicKeyPath, "utf8"));
  }
  return keys;
}
