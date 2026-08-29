import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CanonicalJsonRecord,
  type CanonicalJsonValue,
  RevocationFreshnessError,
  type V1ActivationCertificate,
  type V1ActivationCertificateInput,
  type V1RevocationMetadata,
  type V1RevocationMetadataInput,
  canonicalJson,
  normalizeSha256,
  projectSignableActivationCertificate,
  projectSignableRevocationMetadata,
  validateV1ActivationCertificate,
  validateV1RevocationMetadata,
  verifyOfflineRevocationFreshness,
} from "@resin/contracts";
import type { BundleSignatureAlgorithm, KeyStore } from "../bundle/signature.js";

// ============================================================================
// Errors
// ============================================================================

export class TrustStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustStoreError";
  }
}

export class TrustStoreSecurityError extends TrustStoreError {
  constructor(
    message: string,
    public readonly violationPath?: string,
  ) {
    super(`TrustStore security violation: ${message}`);
    this.name = "TrustStoreSecurityError";
  }
}

export class TrustStoreVerificationError extends TrustStoreError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: CanonicalJsonRecord,
  ) {
    super(`TrustStore verification failed (${code}): ${message}`);
    this.name = "TrustStoreVerificationError";
  }
}

export class TrustStoreCorruptStateError extends TrustStoreError {
  constructor(
    message: string,
    public readonly filePath?: string,
    public readonly cause?: unknown,
  ) {
    super(`TrustStore corrupt state at ${filePath ?? "unknown"}: ${message}`);
    this.name = "TrustStoreCorruptStateError";
  }
}

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface TrustIdentity {
  accountId: string;
  userId: string;
  projectId: string;
  deviceId?: string;
}

export interface ExpectedToolBinding {
  toolId: string;
  toolName?: string;
  version: string;
  manifestDigest: string;
  artifactDigest: string;
  capabilityEnvelopeDigest: string;
  qualificationEvidenceDigest?: string;
}

export type HighWaterState = {
  lastKnownWallTime: string;
  highestRevocationSequence: number;
  highestCertificateCounters: Record<string, number>;
  seenNonces: Record<string, string>;
  seenCertificateIds: string[];
};

export interface RuntimeTrustStoreOptions {
  dataDir: string;
  keyStore: KeyStore;
  clockToleranceMs?: number;
  maxOfflineLeaseMs?: number;
  allowDevKeys?: boolean;
  now?: () => Date | string | number;
}

export interface VerifyTrustOptions {
  allowDevKeys?: boolean;
  now?: Date | string | number;
  clockToleranceMs?: number;
  maxOfflineLeaseMs?: number;
}

export interface TrustVerificationResult {
  trusted: boolean;
  certificate?: V1ActivationCertificate;
  revocationMetadata?: V1RevocationMetadata;
  reason?: string;
  errorCode?: string;
}

export interface SignOptions {
  privateKeyPem: string;
  keyId: string;
  algorithm?: BundleSignatureAlgorithm;
  signedAt?: string;
  certificateChain?: string[];
}

// ============================================================================
// Cryptographic Signing & Verification Helpers
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function decodeSignatureBuffer(signature: string): Buffer {
  if (/^[0-9a-f]+$/i.test(signature) && signature.length % 2 === 0) {
    return Buffer.from(signature, "hex");
  }
  return Buffer.from(signature, "base64");
}

export function signPayloadBuffer(
  payloadBuffer: Buffer,
  privateKeyPem: string,
  algorithm: BundleSignatureAlgorithm = "ed25519",
): string {
  if (algorithm === "ed25519") {
    const signature = crypto.sign(null, payloadBuffer, privateKeyPem);
    return signature.toString("hex");
  }

  if (algorithm === "ecdsa_p256_sha256") {
    const signer = crypto.createSign("SHA256");
    signer.update(payloadBuffer);
    signer.end();
    const signature = signer.sign(privateKeyPem);
    return signature.toString("hex");
  }

  if (algorithm === "rsa_pss_sha256") {
    const signature = crypto.sign("SHA256", payloadBuffer, {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return signature.toString("hex");
  }

  throw new Error(`Unsupported signature algorithm: ${algorithm}`);
}

export function verifySignaturePayload(
  payloadBuffer: Buffer,
  signature: string,
  algorithm: BundleSignatureAlgorithm,
  publicKeyPem: string,
): boolean {
  const signatureBuffer = decodeSignatureBuffer(signature);
  try {
    if (algorithm === "ed25519") {
      return crypto.verify(null, payloadBuffer, publicKeyPem, signatureBuffer);
    }
    if (algorithm === "ecdsa_p256_sha256") {
      const verifier = crypto.createVerify("SHA256");
      verifier.update(payloadBuffer);
      verifier.end();
      return verifier.verify(publicKeyPem, signatureBuffer);
    }
    if (algorithm === "rsa_pss_sha256") {
      return crypto.verify(
        "SHA256",
        payloadBuffer,
        {
          key: publicKeyPem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signatureBuffer,
      );
    }
  } catch {
    return false;
  }
  return false;
}

export function signActivationCertificate(
  certData: Omit<V1ActivationCertificate, "signature">,
  signingOptions: SignOptions,
): V1ActivationCertificate {
  const algorithm = signingOptions.algorithm ?? "ed25519";
  const signedAt = signingOptions.signedAt ?? new Date().toISOString();

  // Create temporary cert object to project signable payload
  const signable = projectSignableActivationCertificate({
    ...certData,
    signature: {
      signature: "placeholder",
      keyId: signingOptions.keyId,
      algorithm,
      signedAt,
    },
  });

  const payloadBuffer = Buffer.from(canonicalJson(signable), "utf8");
  const signatureHex = signPayloadBuffer(payloadBuffer, signingOptions.privateKeyPem, algorithm);

  const fullCert: V1ActivationCertificate = {
    ...certData,
    signature: {
      signature: signatureHex,
      keyId: signingOptions.keyId,
      algorithm,
      signedAt,
      certificateChain: signingOptions.certificateChain,
    },
  };

  return validateV1ActivationCertificate(fullCert);
}

export function signRevocationMetadata(
  metadataData: Omit<V1RevocationMetadata, "signature">,
  signingOptions: SignOptions,
): V1RevocationMetadata {
  const algorithm = signingOptions.algorithm ?? "ed25519";
  const signedAt = signingOptions.signedAt ?? new Date().toISOString();

  const signable = projectSignableRevocationMetadata({
    ...metadataData,
    signature: {
      signature: "placeholder",
      keyId: signingOptions.keyId,
      algorithm,
      signedAt,
    },
  });

  const payloadBuffer = Buffer.from(canonicalJson(signable), "utf8");
  const signatureHex = signPayloadBuffer(payloadBuffer, signingOptions.privateKeyPem, algorithm);

  const fullMetadata: V1RevocationMetadata = {
    ...metadataData,
    signature: {
      signature: signatureHex,
      keyId: signingOptions.keyId,
      algorithm,
      signedAt,
    },
  };

  return validateV1RevocationMetadata(fullMetadata);
}

// ============================================================================
// Sanitization & Filesystem Helpers
// ============================================================================

export function sanitizeUuidSegment(name: string, segment: string): string {
  if (Object.prototype.toString.call(segment) !== "[object String]" || !segment.trim()) {
    throw new TrustStoreSecurityError(`${name} must be a non-empty string`);
  }
  if (
    segment.includes("..") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new TrustStoreSecurityError(`Path traversal attempt in ${name}: ${segment}`, segment);
  }
  if (!UUID_REGEX.test(segment)) {
    throw new TrustStoreSecurityError(
      `Invalid canonical UUID format in ${name}: ${segment}`,
      segment,
    );
  }
  return segment.toLowerCase();
}

export function sanitizeSemVerSegment(version: string): string {
  if (Object.prototype.toString.call(version) !== "[object String]" || !version.trim()) {
    throw new TrustStoreSecurityError("version must be a non-empty string");
  }
  if (
    version.includes("..") ||
    version.includes("/") ||
    version.includes("\\") ||
    version.includes("\0")
  ) {
    throw new TrustStoreSecurityError(`Path traversal attempt in version: ${version}`, version);
  }
  if (!EXACT_SEMVER_REGEX.test(version)) {
    throw new TrustStoreSecurityError(`Invalid exact SemVer in version: ${version}`, version);
  }
  return version;
}

async function ensureDir0700(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.chmod(dirPath, 0o700);
  } catch {
    // In environments where chmod fails on already-created directories, proceed
  }
}

async function atomicWriteJson(
  filePath: string,
  data: CanonicalJsonValue | HighWaterState | V1ActivationCertificate | V1RevocationMetadata,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir0700(dir);

  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const serialized = JSON.stringify(data, null, 2);

  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    fileHandle = await fs.promises.open(tempPath, "w", 0o600);
    await fileHandle.writeFile(serialized, { encoding: "utf8" });
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;

    try {
      await fs.promises.chmod(tempPath, 0o600);
    } catch {}

    await fs.promises.rename(tempPath, filePath);

    try {
      await fs.promises.chmod(filePath, 0o600);
    } catch {}
  } catch (err) {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {}
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch {}
    throw err;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    if (!content.trim()) {
      throw new TrustStoreCorruptStateError("Empty state file", filePath);
    }
    // SAFETY: State file is loaded from disk and parsed to expected schema T.
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (err instanceof Object && "code" in err && err.code === "ENOENT") {
      return null;
    }
    if (err instanceof TrustStoreCorruptStateError) {
      throw err;
    }
    throw new TrustStoreCorruptStateError(
      `Failed to parse JSON file: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
      err,
    );
  }
}

// ============================================================================
// RuntimeTrustStore
// ============================================================================

export class RuntimeTrustStore {
  public readonly dataDir: string;
  public readonly keyStore: KeyStore;
  public readonly clockToleranceMs: number;
  public readonly maxOfflineLeaseMs: number;
  public readonly allowDevKeys: boolean;
  private readonly nowProvider: () => Date | string | number;

  constructor(options: RuntimeTrustStoreOptions) {
    if (!options.dataDir || Object.prototype.toString.call(options.dataDir) !== "[object String]") {
      throw new TrustStoreSecurityError("dataDir must be a non-empty string path");
    }
    if (!options.keyStore) {
      throw new TrustStoreError("keyStore is required");
    }

    this.dataDir = path.resolve(options.dataDir);
    this.keyStore = options.keyStore;
    this.clockToleranceMs = options.clockToleranceMs ?? 60_000; // 1 minute default tolerance
    this.maxOfflineLeaseMs = options.maxOfflineLeaseMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days max lease
    this.allowDevKeys = options.allowDevKeys ?? true;
    this.nowProvider = options.now ?? (() => Date.now());
  }

  private getCurrentTimeMs(customNow?: Date | string | number): number {
    const raw = customNow ?? this.nowProvider();
    const time = new Date(raw).getTime();
    if (Number.isNaN(time)) {
      throw new TrustStoreVerificationError("Invalid current time value", "CLOCK_ERROR");
    }
    return time;
  }

  // --------------------------------------------------------------------------
  // Partition & Path Resolution
  // --------------------------------------------------------------------------

  public getPartitionDir(identity: TrustIdentity): string {
    const accountId = sanitizeUuidSegment("accountId", identity.accountId);
    const userId = sanitizeUuidSegment("userId", identity.userId);
    const projectId = sanitizeUuidSegment("projectId", identity.projectId);

    return path.join(this.dataDir, "identities", accountId, userId, projectId);
  }

  public getStateFilePath(identity: TrustIdentity): string {
    return path.join(this.getPartitionDir(identity), "state.json");
  }

  public getRevocationFilePath(identity: TrustIdentity): string {
    return path.join(this.getPartitionDir(identity), "revocation.json");
  }

  public getCertificatesDir(identity: TrustIdentity): string {
    return path.join(this.getPartitionDir(identity), "certificates");
  }

  public getCertificateFilePath(identity: TrustIdentity, toolId: string, version?: string): string {
    const sanitizedToolId = sanitizeUuidSegment("toolId", toolId);
    const certDir = this.getCertificatesDir(identity);
    if (version) {
      const sanitizedVersion = sanitizeSemVerSegment(version);
      return path.join(certDir, `${sanitizedToolId}@${sanitizedVersion}.json`);
    }
    return path.join(certDir, `${sanitizedToolId}.json`);
  }

  // --------------------------------------------------------------------------
  // High-Water Mark State
  // --------------------------------------------------------------------------

  public async getHighWaterState(identity: TrustIdentity): Promise<HighWaterState> {
    const statePath = this.getStateFilePath(identity);
    const loaded = await readJsonFile<HighWaterState>(statePath);
    if (!loaded) {
      return {
        lastKnownWallTime: new Date(0).toISOString(),
        highestRevocationSequence: 0,
        highestCertificateCounters: {},
        seenNonces: {},
        seenCertificateIds: [],
      };
    }

    if (
      !loaded ||
      Object.prototype.toString.call(loaded) !== "[object Object]" ||
      Object.prototype.toString.call(loaded.lastKnownWallTime) !== "[object String]" ||
      !Number.isFinite(loaded.highestRevocationSequence) ||
      Object.prototype.toString.call(loaded.highestCertificateCounters) !== "[object Object]" ||
      Object.prototype.toString.call(loaded.seenNonces) !== "[object Object]" ||
      !Array.isArray(loaded.seenCertificateIds)
    ) {
      throw new TrustStoreCorruptStateError("Invalid high-water state schema", statePath);
    }

    return loaded;
  }

  private async saveHighWaterState(identity: TrustIdentity, state: HighWaterState): Promise<void> {
    const statePath = this.getStateFilePath(identity);
    await atomicWriteJson(statePath, state);
  }

  // --------------------------------------------------------------------------
  // Revocation Metadata Recording & Verification
  // --------------------------------------------------------------------------

  public async recordRevocationMetadata(
    identity: TrustIdentity,
    rawMetadata: V1RevocationMetadataInput,
    options: VerifyTrustOptions = {},
  ): Promise<void> {
    const accountId = sanitizeUuidSegment("accountId", identity.accountId);
    const metadata = validateV1RevocationMetadata(rawMetadata);

    if (metadata.accountId.toLowerCase() !== accountId) {
      throw new TrustStoreSecurityError(
        `Revocation metadata accountId (${metadata.accountId}) does not match partition accountId (${accountId})`,
        accountId,
      );
    }

    // Cryptographic signature check
    const keyEntry = await this.keyStore.getKey(metadata.signature.keyId);
    if (!keyEntry) {
      throw new TrustStoreVerificationError(
        `Unknown signing key '${metadata.signature.keyId}' for revocation metadata`,
        "UNKNOWN_SIGNING_KEY",
      );
    }

    const allowDevKeys = options.allowDevKeys ?? this.allowDevKeys;
    const isTrusted = await this.keyStore.isTrusted(metadata.signature.keyId, allowDevKeys);
    if (!isTrusted || keyEntry.trustLevel === "revoked") {
      throw new TrustStoreVerificationError(
        `Signing key '${metadata.signature.keyId}' is not trusted (level: ${keyEntry.trustLevel})`,
        "UNTRUSTED_KEY",
      );
    }

    const signable = projectSignableRevocationMetadata(metadata);
    const payloadBuffer = Buffer.from(canonicalJson(signable), "utf8");
    const sigValid = verifySignaturePayload(
      payloadBuffer,
      metadata.signature.signature,
      metadata.signature.algorithm,
      keyEntry.publicKeyPem,
    );

    if (!sigValid) {
      throw new TrustStoreVerificationError(
        "Cryptographic signature verification failed for revocation metadata",
        "INVALID_SIGNATURE",
      );
    }

    // High water state & freshness check
    const state = await this.getHighWaterState(identity);
    const currentMs = this.getCurrentTimeMs(options.now);
    const clockTolerance = options.clockToleranceMs ?? this.clockToleranceMs;
    const maxOfflineLease = options.maxOfflineLeaseMs ?? this.maxOfflineLeaseMs;

    // Clock rollback check against persisted wall time
    const lastKnownWallMs = new Date(state.lastKnownWallTime).getTime();
    if (currentMs < lastKnownWallMs - clockTolerance) {
      throw new TrustStoreVerificationError(
        `Clock rollback detected: current time (${new Date(currentMs).toISOString()}) is before last known persisted wall time (${state.lastKnownWallTime})`,
        "CLOCK_ROLLBACK",
      );
    }

    // Freshness & Lease checks
    try {
      verifyOfflineRevocationFreshness(metadata, {
        currentDeviceTime: new Date(currentMs),
        lastKnownSequenceNumber: state.highestRevocationSequence,
        maxOfflineLeaseMs: maxOfflineLease,
      });
    } catch (err) {
      if (err instanceof RevocationFreshnessError) {
        throw new TrustStoreVerificationError(err.message, err.code, {
          code: err.code,
          message: err.message,
        });
      }
      throw err;
    }

    // Update state
    state.highestRevocationSequence = Math.max(
      state.highestRevocationSequence,
      metadata.sequenceNumber,
    );
    state.lastKnownWallTime = new Date(Math.max(lastKnownWallMs, currentMs)).toISOString();

    const revocationPath = this.getRevocationFilePath(identity);
    await atomicWriteJson(revocationPath, metadata);
    await this.saveHighWaterState(identity, state);
  }

  public async getRevocationMetadata(
    identity: TrustIdentity,
  ): Promise<V1RevocationMetadata | null> {
    const revocationPath = this.getRevocationFilePath(identity);
    const loaded = await readJsonFile<V1RevocationMetadataInput>(revocationPath);
    if (loaded === null) {
      return null;
    }

    try {
      return validateV1RevocationMetadata(loaded);
    } catch (err) {
      throw new TrustStoreCorruptStateError(
        `Invalid revocation metadata schema: ${err instanceof Error ? err.message : String(err)}`,
        revocationPath,
        err,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Activation Certificate Recording & Retrieval
  // --------------------------------------------------------------------------

  public async recordActivationCertificate(
    identity: TrustIdentity,
    rawCert: V1ActivationCertificateInput,
    options: VerifyTrustOptions = {},
  ): Promise<void> {
    const accountId = sanitizeUuidSegment("accountId", identity.accountId);
    const userId = sanitizeUuidSegment("userId", identity.userId);
    const projectId = sanitizeUuidSegment("projectId", identity.projectId);

    const cert = validateV1ActivationCertificate(rawCert);

    // Subject and project binding checks
    if (cert.subject.accountId.toLowerCase() !== accountId) {
      throw new TrustStoreSecurityError(
        `Certificate accountId (${cert.subject.accountId}) does not match partition (${accountId})`,
        accountId,
      );
    }
    if (cert.subject.userId.toLowerCase() !== userId) {
      throw new TrustStoreSecurityError(
        `Certificate userId (${cert.subject.userId}) does not match partition (${userId})`,
        userId,
      );
    }
    if (cert.projectId.toLowerCase() !== projectId) {
      throw new TrustStoreSecurityError(
        `Certificate projectId (${cert.projectId}) does not match partition (${projectId})`,
        projectId,
      );
    }
    if (
      identity.deviceId &&
      cert.subject.deviceId &&
      cert.subject.deviceId.toLowerCase() !== identity.deviceId.toLowerCase()
    ) {
      throw new TrustStoreSecurityError(
        `Certificate deviceId (${cert.subject.deviceId}) does not match identity (${identity.deviceId})`,
        identity.deviceId,
      );
    }

    if (cert.status !== "active") {
      throw new TrustStoreVerificationError(
        `Certificate status '${cert.status}' is not active`,
        "INACTIVE_CERTIFICATE",
      );
    }

    // Cryptographic signature check
    const keyEntry = await this.keyStore.getKey(cert.signature.keyId);
    if (!keyEntry) {
      throw new TrustStoreVerificationError(
        `Unknown signing key '${cert.signature.keyId}' for activation certificate`,
        "UNKNOWN_SIGNING_KEY",
      );
    }

    const allowDevKeys = options.allowDevKeys ?? this.allowDevKeys;
    const isTrusted = await this.keyStore.isTrusted(cert.signature.keyId, allowDevKeys);
    if (!isTrusted || keyEntry.trustLevel === "revoked") {
      throw new TrustStoreVerificationError(
        `Signing key '${cert.signature.keyId}' is not trusted (level: ${keyEntry.trustLevel})`,
        "UNTRUSTED_KEY",
      );
    }

    const signable = projectSignableActivationCertificate(cert);
    const payloadBuffer = Buffer.from(canonicalJson(signable), "utf8");
    const sigValid = verifySignaturePayload(
      payloadBuffer,
      cert.signature.signature,
      cert.signature.algorithm,
      keyEntry.publicKeyPem,
    );

    if (!sigValid) {
      throw new TrustStoreVerificationError(
        "Cryptographic signature verification failed for activation certificate",
        "INVALID_SIGNATURE",
      );
    }

    // Check revocation list if present
    const revocation = await this.getRevocationMetadata(identity);
    if (revocation) {
      if (revocation.revokedKeys.includes(cert.signature.keyId)) {
        throw new TrustStoreVerificationError(
          `Certificate signing key '${cert.signature.keyId}' is revoked in local revocation metadata`,
          "REVOKED_KEY",
        );
      }
      if (
        revocation.revokedCertificates.some(
          (c) => c.certificateId.toLowerCase() === cert.certificateId.toLowerCase(),
        )
      ) {
        throw new TrustStoreVerificationError(
          `Activation certificate '${cert.certificateId}' has been revoked`,
          "REVOKED_CERTIFICATE",
        );
      }
      if (
        revocation.revokedTools.some(
          (t) =>
            t.toolId.toLowerCase() === cert.toolId.toLowerCase() &&
            (!t.version || t.version === cert.version),
        )
      ) {
        throw new TrustStoreVerificationError(
          `Tool '${cert.toolId}' (version ${cert.version}) has been revoked`,
          "REVOKED_TOOL",
        );
      }
    }

    // High water state checks (clock rollback, counter rollback, nonce replay)
    const state = await this.getHighWaterState(identity);
    const currentMs = this.getCurrentTimeMs(options.now);
    const clockTolerance = options.clockToleranceMs ?? this.clockToleranceMs;

    const lastKnownWallMs = new Date(state.lastKnownWallTime).getTime();
    if (currentMs < lastKnownWallMs - clockTolerance) {
      throw new TrustStoreVerificationError(
        `Clock rollback detected: current time (${new Date(currentMs).toISOString()}) is before last known wall time (${state.lastKnownWallTime})`,
        "CLOCK_ROLLBACK",
      );
    }

    // Time window validity
    const notBeforeMs = new Date(cert.notBefore).getTime();
    const expiresAtMs = new Date(cert.expiresAt).getTime();

    if (currentMs < notBeforeMs - clockTolerance) {
      throw new TrustStoreVerificationError(
        `Activation certificate is not yet valid (notBefore: ${cert.notBefore})`,
        "NOT_YET_VALID",
      );
    }

    if (currentMs > expiresAtMs) {
      throw new TrustStoreVerificationError(
        `Activation certificate has expired (expiresAt: ${cert.expiresAt})`,
        "EXPIRED_CERTIFICATE",
      );
    }

    // Counter anti-rollback check
    const toolIdNormalized = cert.toolId.toLowerCase();
    const recordedCounter = state.highestCertificateCounters[toolIdNormalized] ?? -1;
    if (cert.counter < recordedCounter) {
      throw new TrustStoreVerificationError(
        `Certificate counter rollback detected: received counter ${cert.counter} is lower than recorded counter ${recordedCounter}`,
        "COUNTER_ROLLBACK",
      );
    }

    // Nonce replay check
    if (
      state.seenNonces[cert.nonce] &&
      state.seenNonces[cert.nonce].toLowerCase() !== cert.certificateId.toLowerCase()
    ) {
      throw new TrustStoreVerificationError(
        `Certificate nonce replay detected: nonce '${cert.nonce}' already used by certificate '${state.seenNonces[cert.nonce]}'`,
        "NONCE_REPLAY",
      );
    }

    // Persist certificate
    const certPathExact = this.getCertificateFilePath(identity, cert.toolId, cert.version);
    const certPathLatest = this.getCertificateFilePath(identity, cert.toolId);

    await atomicWriteJson(certPathExact, cert);
    await atomicWriteJson(certPathLatest, cert);

    // Advance high-water state
    state.highestCertificateCounters[toolIdNormalized] = Math.max(recordedCounter, cert.counter);
    state.seenNonces[cert.nonce] = cert.certificateId;
    if (!state.seenCertificateIds.includes(cert.certificateId)) {
      state.seenCertificateIds.push(cert.certificateId);
    }
    state.lastKnownWallTime = new Date(Math.max(lastKnownWallMs, currentMs)).toISOString();

    await this.saveHighWaterState(identity, state);
  }

  public async getActivationCertificate(
    identity: TrustIdentity,
    toolId: string,
    version?: string,
  ): Promise<V1ActivationCertificate | null> {
    const certPath = this.getCertificateFilePath(identity, toolId, version);
    const loaded = await readJsonFile<V1ActivationCertificateInput>(certPath);
    if (!loaded) {
      // If requested with version and exact not found, check if latest matches version
      if (version) {
        const latestPath = this.getCertificateFilePath(identity, toolId);
        const latest = await readJsonFile<V1ActivationCertificateInput>(latestPath);
        if (latest) {
          try {
            const parsed = validateV1ActivationCertificate(latest);
            if (parsed.version === version) return parsed;
          } catch (err) {
            throw new TrustStoreCorruptStateError(
              `Corrupt certificate in ${latestPath}`,
              latestPath,
              err,
            );
          }
        }
      }
      return null;
    }

    try {
      const parsed = validateV1ActivationCertificate(loaded);
      if (version && parsed.version !== version) {
        return null;
      }
      return parsed;
    } catch (err) {
      throw new TrustStoreCorruptStateError(
        `Invalid certificate schema in ${certPath}: ${err instanceof Error ? err.message : String(err)}`,
        certPath,
        err,
      );
    }
  }

  public async listActivationCertificates(
    identity: TrustIdentity,
  ): Promise<V1ActivationCertificate[]> {
    const certsDir = this.getCertificatesDir(identity);
    try {
      const files = await fs.promises.readdir(certsDir);
      const results: V1ActivationCertificate[] = [];
      const seen = new Set<string>();

      for (const file of files) {
        if (!file.endsWith(".json") || file.includes(".tmp")) continue;
        const filePath = path.join(certsDir, file);
        const cert = await readJsonFile<V1ActivationCertificateInput>(filePath);
        if (!cert) continue;
        try {
          const parsed = validateV1ActivationCertificate(cert);
          if (!seen.has(parsed.certificateId)) {
            seen.add(parsed.certificateId);
            results.push(parsed);
          }
        } catch (err) {
          throw new TrustStoreCorruptStateError(
            `Invalid certificate in ${filePath}`,
            filePath,
            err,
          );
        }
      }
      return results;
    } catch (err: unknown) {
      if (err instanceof Object && "code" in err && err.code === "ENOENT") {
        return [];
      }
      if (err instanceof TrustStoreCorruptStateError) throw err;
      throw new TrustStoreError(
        `Failed to list activation certificates: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async deleteActivationCertificate(
    identity: TrustIdentity,
    toolId: string,
    version?: string,
  ): Promise<boolean> {
    const certPath = this.getCertificateFilePath(identity, toolId, version);
    try {
      await fs.promises.unlink(certPath);
      return true;
    } catch (err: unknown) {
      if (err instanceof Object && "code" in err && err.code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  public async clearPartition(identity: TrustIdentity): Promise<void> {
    const partitionDir = this.getPartitionDir(identity);
    try {
      await fs.promises.rm(partitionDir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (!err || !(err instanceof Object) || !("code" in err) || err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Verification & Trust Assertion
  // --------------------------------------------------------------------------

  public async verifyToolTrust(
    identity: TrustIdentity,
    expectedTool: ExpectedToolBinding,
    options: VerifyTrustOptions = {},
  ): Promise<TrustVerificationResult> {
    // 1. Retrieve stored activation certificate
    const cert = await this.getActivationCertificate(
      identity,
      expectedTool.toolId,
      expectedTool.version,
    );

    if (!cert) {
      return {
        trusted: false,
        reason: `No activation certificate found for tool '${expectedTool.toolId}' (version ${expectedTool.version})`,
        errorCode: "MISSING_CERTIFICATE",
      };
    }

    // 2. Verify identity & subject binding
    const accountId = sanitizeUuidSegment("accountId", identity.accountId);
    const userId = sanitizeUuidSegment("userId", identity.userId);
    const projectId = sanitizeUuidSegment("projectId", identity.projectId);

    if (cert.subject.accountId.toLowerCase() !== accountId) {
      return {
        trusted: false,
        reason: `Certificate accountId (${cert.subject.accountId}) does not match partition (${accountId})`,
        errorCode: "ACCOUNT_MISMATCH",
      };
    }
    if (cert.subject.userId.toLowerCase() !== userId) {
      return {
        trusted: false,
        reason: `Certificate userId (${cert.subject.userId}) does not match partition (${userId})`,
        errorCode: "USER_MISMATCH",
      };
    }
    if (cert.projectId.toLowerCase() !== projectId) {
      return {
        trusted: false,
        reason: `Certificate projectId (${cert.projectId}) does not match partition (${projectId})`,
        errorCode: "PROJECT_MISMATCH",
      };
    }
    if (
      identity.deviceId &&
      cert.subject.deviceId &&
      cert.subject.deviceId.toLowerCase() !== identity.deviceId.toLowerCase()
    ) {
      return {
        trusted: false,
        reason: `Certificate deviceId (${cert.subject.deviceId}) does not match expected deviceId (${identity.deviceId})`,
        errorCode: "DEVICE_MISMATCH",
      };
    }

    // 3. Verify tool binding, exact version, and digests
    if (cert.toolId.toLowerCase() !== expectedTool.toolId.toLowerCase()) {
      return {
        trusted: false,
        reason: `Certificate toolId (${cert.toolId}) does not match expected (${expectedTool.toolId})`,
        errorCode: "TOOL_ID_MISMATCH",
      };
    }

    if (expectedTool.toolName && cert.toolName !== expectedTool.toolName) {
      return {
        trusted: false,
        reason: `Certificate toolName (${cert.toolName}) does not match expected (${expectedTool.toolName})`,
        errorCode: "TOOL_NAME_MISMATCH",
      };
    }

    if (cert.version !== expectedTool.version) {
      return {
        trusted: false,
        reason: `Certificate version (${cert.version}) does not match exact locked version (${expectedTool.version})`,
        errorCode: "VERSION_MISMATCH",
      };
    }

    if (normalizeSha256(cert.manifestDigest) !== normalizeSha256(expectedTool.manifestDigest)) {
      return {
        trusted: false,
        reason: `Certificate manifestDigest (${cert.manifestDigest}) does not match locked manifestDigest (${expectedTool.manifestDigest})`,
        errorCode: "MANIFEST_DIGEST_MISMATCH",
      };
    }

    if (normalizeSha256(cert.artifactDigest) !== normalizeSha256(expectedTool.artifactDigest)) {
      return {
        trusted: false,
        reason: `Certificate artifactDigest (${cert.artifactDigest}) does not match locked artifactDigest (${expectedTool.artifactDigest})`,
        errorCode: "ARTIFACT_DIGEST_MISMATCH",
      };
    }

    if (
      normalizeSha256(cert.capabilityEnvelopeDigest) !==
      normalizeSha256(expectedTool.capabilityEnvelopeDigest)
    ) {
      return {
        trusted: false,
        reason: `Certificate capabilityEnvelopeDigest (${cert.capabilityEnvelopeDigest}) does not match locked capabilityEnvelopeDigest (${expectedTool.capabilityEnvelopeDigest})`,
        errorCode: "CAPABILITY_ENVELOPE_MISMATCH",
      };
    }

    if (
      expectedTool.qualificationEvidenceDigest &&
      normalizeSha256(cert.qualificationEvidenceDigest) !==
        normalizeSha256(expectedTool.qualificationEvidenceDigest)
    ) {
      return {
        trusted: false,
        reason: `Certificate qualificationEvidenceDigest (${cert.qualificationEvidenceDigest}) does not match expected (${expectedTool.qualificationEvidenceDigest})`,
        errorCode: "QUALIFICATION_EVIDENCE_MISMATCH",
      };
    }

    if (cert.status !== "active") {
      return {
        trusted: false,
        reason: `Certificate status is '${cert.status}' (expected 'active')`,
        errorCode: "INACTIVE_CERTIFICATE",
      };
    }

    // 4. Verify certificate cryptographic signature
    const keyEntry = await this.keyStore.getKey(cert.signature.keyId);
    if (!keyEntry) {
      return {
        trusted: false,
        reason: `Unknown signing key '${cert.signature.keyId}'`,
        errorCode: "UNKNOWN_SIGNING_KEY",
      };
    }

    const allowDevKeys = options.allowDevKeys ?? this.allowDevKeys;
    const isTrusted = await this.keyStore.isTrusted(cert.signature.keyId, allowDevKeys);
    if (!isTrusted || keyEntry.trustLevel === "revoked") {
      return {
        trusted: false,
        reason: `Signing key '${cert.signature.keyId}' is not trusted (level: ${keyEntry.trustLevel})`,
        errorCode: "UNTRUSTED_KEY",
      };
    }

    const signable = projectSignableActivationCertificate(cert);
    const payloadBuffer = Buffer.from(canonicalJson(signable), "utf8");
    const sigValid = verifySignaturePayload(
      payloadBuffer,
      cert.signature.signature,
      cert.signature.algorithm,
      keyEntry.publicKeyPem,
    );

    if (!sigValid) {
      return {
        trusted: false,
        reason: "Cryptographic signature verification failed for activation certificate",
        errorCode: "INVALID_SIGNATURE",
      };
    }

    // 5. Verify against Revocation Metadata
    const revocation = await this.getRevocationMetadata(identity);
    if (revocation) {
      // Check revocation metadata signature & freshness
      const revKeyEntry = await this.keyStore.getKey(revocation.signature.keyId);
      if (!revKeyEntry) {
        return {
          trusted: false,
          reason: `Unknown signing key '${revocation.signature.keyId}' on revocation metadata`,
          errorCode: "UNKNOWN_REVOCATION_KEY",
        };
      }

      const revSignable = projectSignableRevocationMetadata(revocation);
      const revPayloadBuffer = Buffer.from(canonicalJson(revSignable), "utf8");
      const revSigValid = verifySignaturePayload(
        revPayloadBuffer,
        revocation.signature.signature,
        revocation.signature.algorithm,
        revKeyEntry.publicKeyPem,
      );

      if (!revSigValid) {
        return {
          trusted: false,
          reason: "Revocation metadata signature is invalid",
          errorCode: "INVALID_REVOCATION_SIGNATURE",
        };
      }

      const currentMs = this.getCurrentTimeMs(options.now);
      const maxOfflineLease = options.maxOfflineLeaseMs ?? this.maxOfflineLeaseMs;

      try {
        verifyOfflineRevocationFreshness(revocation, {
          currentDeviceTime: new Date(currentMs),
          maxOfflineLeaseMs: maxOfflineLease,
        });
      } catch (err) {
        if (err instanceof RevocationFreshnessError) {
          return {
            trusted: false,
            reason: `Revocation freshness check failed: ${err.message}`,
            errorCode: err.code,
          };
        }
        return {
          trusted: false,
          reason: `Revocation freshness check error: ${err instanceof Error ? err.message : String(err)}`,
          errorCode: "REVOCATION_FRESHNESS_ERROR",
        };
      }

      // Check revoked keys
      if (revocation.revokedKeys.includes(cert.signature.keyId)) {
        return {
          trusted: false,
          reason: `Signing key '${cert.signature.keyId}' has been revoked`,
          errorCode: "REVOKED_KEY",
        };
      }

      // Check revoked certificates
      if (
        revocation.revokedCertificates.some(
          (c) => c.certificateId.toLowerCase() === cert.certificateId.toLowerCase(),
        )
      ) {
        return {
          trusted: false,
          reason: `Activation certificate '${cert.certificateId}' has been revoked`,
          errorCode: "REVOKED_CERTIFICATE",
        };
      }

      // Check revoked tools
      if (
        revocation.revokedTools.some(
          (t) =>
            t.toolId.toLowerCase() === cert.toolId.toLowerCase() &&
            (!t.version || t.version === cert.version),
        )
      ) {
        return {
          trusted: false,
          reason: `Tool '${cert.toolId}' (version ${cert.version}) has been revoked`,
          errorCode: "REVOKED_TOOL",
        };
      }
    }

    // 6. Clock Rollback & High-Water Mark Validation
    const state = await this.getHighWaterState(identity);
    const currentMs = this.getCurrentTimeMs(options.now);
    const clockTolerance = options.clockToleranceMs ?? this.clockToleranceMs;

    const lastKnownWallMs = new Date(state.lastKnownWallTime).getTime();
    if (currentMs < lastKnownWallMs - clockTolerance) {
      return {
        trusted: false,
        reason: `Clock rollback detected: current time (${new Date(currentMs).toISOString()}) is before last known persisted wall time (${state.lastKnownWallTime})`,
        errorCode: "CLOCK_ROLLBACK",
      };
    }

    // Time window validity
    const notBeforeMs = new Date(cert.notBefore).getTime();
    const expiresAtMs = new Date(cert.expiresAt).getTime();

    if (currentMs < notBeforeMs - clockTolerance) {
      return {
        trusted: false,
        reason: `Activation certificate is not yet valid (notBefore: ${cert.notBefore})`,
        errorCode: "NOT_YET_VALID",
      };
    }

    if (currentMs > expiresAtMs) {
      return {
        trusted: false,
        reason: `Activation certificate has expired (expiresAt: ${cert.expiresAt})`,
        errorCode: "EXPIRED_CERTIFICATE",
      };
    }

    // Advance high-water wall time if current is strictly newer
    if (currentMs > lastKnownWallMs) {
      state.lastKnownWallTime = new Date(currentMs).toISOString();
      await this.saveHighWaterState(identity, state);
    }

    return {
      trusted: true,
      certificate: cert,
      revocationMetadata: revocation ?? undefined,
    };
  }

  public async assertToolTrust(
    identity: TrustIdentity,
    expectedTool: ExpectedToolBinding,
    options: VerifyTrustOptions = {},
  ): Promise<V1ActivationCertificate> {
    const result = await this.verifyToolTrust(identity, expectedTool, options);
    if (!result.trusted || !result.certificate) {
      throw new TrustStoreVerificationError(
        result.reason ?? "Tool trust verification failed",
        result.errorCode ?? "UNTRUSTED_TOOL",
      );
    }
    return result.certificate;
  }
}
