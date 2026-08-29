import crypto from "node:crypto";
import {
  CURRENT_SAFETY_GATE_VERSION,
  type NormalizedSessionEvent,
  REQUIRED_SAFETY_CHECKS,
  SAFETY_GATE_ERROR_CODES,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
  type ToolManifest,
  ToolManifestSchema,
  canonicalJson,
  normalizeSha256,
} from "@resin/contracts";
import {
  type ArtifactFileEntry,
  type ArtifactInspectionResult,
  InvalidSanitizedObservationError,
  RawDataExfiltrationError,
  RawUploadProhibitedError,
  SENSITIVE_PATTERN_REGEXES,
  type SanitizedObservationBatchDto,
  SanitizedObservationBrandSymbol,
  type SanitizedObservationDto,
  type SigningKeyEntry,
  type SigningKeyStore,
  assertNoProhibitedRawData,
  createSanitizedObservationBatchDto,
  createSanitizedObservationDto,
  isSanitizedObservationBatchDto,
  isSanitizedObservationDto,
} from "./types.js";

/**
 * Computes canonical payload buffer for signing.
 */
export function createCanonicalSignPayload(
  bundleDigest: string,
  fileDigests: Record<string, string>,
  keyId: string,
  algorithm: string,
  signedAt: string,
): Buffer {
  const canonicalString = canonicalJson({
    algorithm,
    bundleDigest,
    fileDigests,
    keyId,
    signedAt,
  });
  return Buffer.from(canonicalString, "utf8");
}

/**
 * Verifies safety attestation record against required checks and version invariants.
 */
export function verifySafetyAttestation(record: SafetyAttestationRecord): {
  valid: boolean;
  error?: string;
  errorCode?: string;
} {
  if (!record || typeof record !== "object") {
    return {
      valid: false,
      errorCode: SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION,
      error: "Safety attestation record is missing or invalid",
    };
  }
  const parseResult = SafetyAttestationRecordSchema.safeParse(record);
  if (!parseResult.success) {
    return {
      valid: false,
      errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
      error: `Invalid attestation schema: ${parseResult.error.message}`,
    };
  }
  const checks = record.checks as Record<string, boolean>;
  for (const reqCheck of REQUIRED_SAFETY_CHECKS) {
    if (checks[reqCheck] !== true) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.UNMET_SAFETY_CHECK,
        error: `Required safety check '${reqCheck}' failed or is missing`,
      };
    }
  }
  return { valid: true };
}

/**
 * Computes canonical manifest digest, stripping existing digest.
 */
export function computeManifestDigest(manifest: ToolManifest | Record<string, unknown>): string {
  const withEmptyDigest = { ...manifest, digest: "" };
  return crypto.createHash("sha256").update(canonicalJson(withEmptyDigest)).digest("hex");
}
/**
 * Error thrown when an artifact digest does not match the expected SHA-256.
 */
export class DigestMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Artifact digest mismatch: expected ${expected}, got ${actual}`);
    this.name = "DigestMismatchError";
  }
}

/**
 * Error thrown when an artifact exceeds maximum size limits.
 */
export class DecompressionBombError extends Error {
  constructor(
    public readonly actualSizeBytes: number,
    public readonly limitSizeBytes: number,
  ) {
    super(
      `Artifact size ${actualSizeBytes} bytes exceeds maximum allowed limit ${limitSizeBytes} bytes`,
    );
    this.name = "DecompressionBombError";
  }
}

/**
 * Error thrown when an artifact signature key is revoked.
 */
export class RevokedSigningKeyError extends Error {
  constructor(public readonly keyId: string) {
    super(`Signing key '${keyId}' has been revoked`);
    this.name = "RevokedSigningKeyError";
  }
}

/**
 * Error thrown when an artifact signature key is unknown.
 */
export class UnknownSigningKeyError extends Error {
  constructor(public readonly keyId: string) {
    super(`Signing key '${keyId}' is not found in trusted key store`);
    this.name = "UnknownSigningKeyError";
  }
}

/**
 * Error thrown when an artifact signature key is untrusted.
 */
export class UntrustedSigningKeyError extends Error {
  constructor(
    public readonly keyId: string,
    public readonly trustLevel: string,
  ) {
    super(`Signing key '${keyId}' is untrusted (trust level: ${trustLevel})`);
    this.name = "UntrustedSigningKeyError";
  }
}

/**
 * Error thrown when an artifact signature is invalid.
 */
export class InvalidSignatureError extends Error {
  constructor(
    public readonly keyId: string,
    public readonly reason: string,
  ) {
    super(`Invalid bundle signature for key '${keyId}': ${reason}`);
    this.name = "InvalidSignatureError";
  }
}

/**
 * Error thrown when bundle structure or inspection fails.
 */
export class ArtifactInspectionError extends Error {
  constructor(
    message: string,
    public readonly code: string = "INSPECTION_FAILED",
  ) {
    super(`Artifact inspection failed: ${message}`);
    this.name = "ArtifactInspectionError";
  }
}
/**
 * Error thrown when an artifact requires an unsupported runtime engine or SDK version.
 */
export class IncompatibleRuntimeError extends Error {
  constructor(
    public readonly engine: string,
    public readonly sdkVersion?: string,
    message?: string,
  ) {
    super(
      message ??
        `Incompatible runtime or SDK version: engine=${engine}, sdkVersion=${sdkVersion ?? "unspecified"}`,
    );
    this.name = "IncompatibleRuntimeError";
  }
}

/**
 * Error thrown when an artifact production-safety attestation fails verification.
 */
export class AttestationVerificationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly errorCode?: string,
  ) {
    super(`Safety attestation verification failed: ${reason}${errorCode ? ` (${errorCode})` : ""}`);
    this.name = "AttestationVerificationError";
  }
}

/**
 * Error thrown when an artifact candidate capability violates the local envelope.
 */
export class EnvelopeViolationError extends Error {
  constructor(
    public readonly violation: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`Candidate capability violates local envelope: ${violation}`);
    this.name = "EnvelopeViolationError";
  }
}

/**
 * Downloaded and verified artifact result.
 */
export interface ArtifactDownloadResult {
  bytes: Buffer;
  digest: string;
  manifest: ToolManifest;
  inspection: ArtifactInspectionResult;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

/**
 * In-memory signing key store implementation.
 */
export class InMemoryKeyStore implements SigningKeyStore {
  private readonly keys = new Map<string, SigningKeyEntry>();

  constructor(initialKeys: SigningKeyEntry[] = []) {
    for (const key of initialKeys) {
      this.keys.set(key.keyId, key);
    }
  }

  async getKey(keyId: string): Promise<SigningKeyEntry | null> {
    return this.keys.get(keyId) ?? null;
  }

  async hasKey(keyId: string): Promise<boolean> {
    return this.keys.has(keyId);
  }

  async isTrusted(keyId: string, allowDevKeys = false): Promise<boolean> {
    const key = this.keys.get(keyId);
    if (!key) return false;
    if (key.trustLevel === "revoked") return false;
    if (key.trustLevel === "production") return true;
    if (key.trustLevel === "development" && allowDevKeys) return true;
    return false;
  }

  async addKey(entry: SigningKeyEntry): Promise<void> {
    this.keys.set(entry.keyId, entry);
  }

  async revokeKey(keyId: string): Promise<void> {
    const key = this.keys.get(keyId);
    if (key) {
      this.keys.set(keyId, { ...key, trustLevel: "revoked" });
    } else {
      this.keys.set(keyId, {
        keyId,
        algorithm: "ed25519",
        publicKeyPem: "",
        trustLevel: "revoked",
        createdAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Options for ArtifactTransferClient.
 */
export interface ArtifactTransferClientOptions {
  maxArtifactSizeBytes?: number;
  keyStore?: SigningKeyStore;
  allowDevKeys?: boolean;
  verifySignature?: boolean;
  requireSignature?: boolean;
  downloadHandler?: (
    digest: string,
    metadata?: Record<string, unknown>,
  ) => Promise<Uint8Array | Buffer> | Uint8Array | Buffer;
}

/**
 * Internal parsed tar entry.
 */
interface ParsedTarEntry {
  name: string;
  size: number;
  type: string;
  data: Buffer;
}

/**
 * Parse standard POSIX / USTAR tar buffer into file entries.
 */
export function parseTarBuffer(buffer: Buffer): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);

    // Check for two consecutive empty blocks (end of archive)
    if (header.every((b) => b === 0)) {
      break;
    }

    // Name: bytes 0..99
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();

    // Size: bytes 124..135 (octal ascii)
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    // Typeflag: byte 156
    const typeflag = header.subarray(156, 157).toString("utf8") || "0";

    // Prefix: bytes 345..499 (USTAR format)
    const ustar = header.subarray(257, 262).toString("utf8");
    if (ustar === "ustar") {
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
      if (prefix.length > 0) {
        name = `${prefix}/${name}`;
      }
    }

    offset += 512;

    const data = buffer.subarray(offset, offset + size);
    // Pad to 512 bytes
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (name.length > 0) {
      entries.push({
        name,
        size,
        type: typeflag,
        data: Buffer.from(data),
      });
    }
  }

  return entries;
}

/**
 * Artifact transfer client for downloading exact immutable artifacts by digest,
 * verifying SHA-256 digests, signatures, trust chains, and non-executing structure.
 */
export class ArtifactTransferClient {
  private readonly maxArtifactSizeBytes: number;
  private readonly keyStore: SigningKeyStore;
  private readonly allowDevKeys: boolean;
  private readonly verifySignature: boolean;
  private readonly requireSignature: boolean;
  private readonly downloadHandler?: (
    digest: string,
    metadata?: Record<string, unknown>,
  ) => Promise<Uint8Array | Buffer> | Uint8Array | Buffer;

  // Content-addressed cache: digest -> ArtifactDownloadResult
  private readonly cache = new Map<string, ArtifactDownloadResult>();

  constructor(options: ArtifactTransferClientOptions = {}) {
    this.maxArtifactSizeBytes = options.maxArtifactSizeBytes ?? 50 * 1024 * 1024; // 50MB
    this.keyStore = options.keyStore ?? new InMemoryKeyStore();
    this.allowDevKeys = options.allowDevKeys ?? true;
    this.verifySignature = options.verifySignature ?? false;
    this.requireSignature = options.requireSignature ?? false;
    this.downloadHandler = options.downloadHandler;
  }

  /**
   * Access the key store.
   */
  getKeyStore(): SigningKeyStore {
    return this.keyStore;
  }

  /**
   * Pre-cache an artifact buffer directly under its digest.
   */
  async cacheArtifact(
    digest: string,
    rawBytes: Buffer | Uint8Array,
    metadata: Record<string, unknown> = {},
  ): Promise<ArtifactDownloadResult> {
    const normExpected = normalizeSha256(digest);
    const buffer = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);

    const computedDigest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (computedDigest !== normExpected) {
      throw new DigestMismatchError(normExpected, computedDigest);
    }

    const inspection = await this.inspectArtifactBytes(buffer, {
      expectedDigest: normExpected,
      allowDevKeys: this.allowDevKeys,
      verifySignature: this.verifySignature,
      requireSignature: this.requireSignature,
    });

    const result: ArtifactDownloadResult = {
      bytes: buffer,
      digest: normExpected,
      manifest: inspection.manifest,
      inspection,
      sizeBytes: buffer.length,
      metadata,
    };

    this.cache.set(normExpected, result);
    return result;
  }

  /**
   * Downloads an exact immutable artifact by digest, validating SHA-256 and signatures.
   */
  async downloadArtifact(
    digest: string,
    options: {
      metadata?: Record<string, unknown>;
      allowDevKeys?: boolean;
      verifySignature?: boolean;
      requireSignature?: boolean;
      expectedSizeLimitBytes?: number;
    } = {},
  ): Promise<ArtifactDownloadResult> {
    const normExpected = normalizeSha256(digest);

    // 1. Check cache first
    const cached = this.cache.get(normExpected);
    if (cached) {
      return cached;
    }

    // 2. Fetch raw artifact bytes
    if (!this.downloadHandler) {
      throw new ArtifactInspectionError(
        `No download handler configured to fetch artifact with digest ${digest}`,
        "DOWNLOAD_HANDLER_MISSING",
      );
    }

    const rawResult = await this.downloadHandler(digest, options.metadata);
    const buffer = Buffer.isBuffer(rawResult) ? rawResult : Buffer.from(rawResult);

    // 3. Check decompression bomb / size limits
    const sizeLimit = options.expectedSizeLimitBytes ?? this.maxArtifactSizeBytes;
    if (buffer.length > sizeLimit) {
      throw new DecompressionBombError(buffer.length, sizeLimit);
    }

    // 4. Verify exact SHA-256 digest
    const computedDigest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (computedDigest !== normExpected) {
      throw new DigestMismatchError(normExpected, computedDigest);
    }

    // 5. Inspect bundle archive and verify signature
    const inspection = await this.inspectArtifactBytes(buffer, {
      expectedDigest: normExpected,
      allowDevKeys: options.allowDevKeys ?? this.allowDevKeys,
      verifySignature: options.verifySignature ?? this.verifySignature,
      requireSignature: options.requireSignature ?? this.requireSignature,
    });

    const result: ArtifactDownloadResult = {
      bytes: buffer,
      digest: normExpected,
      manifest: inspection.manifest,
      inspection,
      sizeBytes: buffer.length,
      metadata: options.metadata ?? {},
    };

    this.cache.set(normExpected, result);
    return result;
  }

  /**
   * Non-executing loader inspection of raw artifact buffer.
   */
  async inspectArtifactBytes(
    buffer: Buffer,
    options: {
      expectedDigest?: string;
      allowDevKeys?: boolean;
      verifySignature?: boolean;
      requireSignature?: boolean;
      requireAttestation?: boolean;
      supportedEngines?: string[];
      supportedSdkVersions?: string[];
    } = {},
  ): Promise<ArtifactInspectionResult> {
    const bundleDigest =
      options.expectedDigest ?? crypto.createHash("sha256").update(buffer).digest("hex");
    const rawEntries = parseTarBuffer(buffer);

    if (rawEntries.length === 0) {
      throw new ArtifactInspectionError("Tar archive is empty", "EMPTY_ARCHIVE");
    }

    const files: ArtifactFileEntry[] = [];
    const fileMap = new Map<string, Buffer>();

    for (const entry of rawEntries) {
      const normalizedPath = entry.name.replace(/^\.\//, "").replace(/\/+/g, "/");

      // Check path traversal
      if (
        normalizedPath.startsWith("/") ||
        normalizedPath.startsWith("../") ||
        normalizedPath.includes("/../") ||
        normalizedPath === ".."
      ) {
        throw new ArtifactInspectionError(
          `Archive contains unsafe path traversal entry: ${entry.name}`,
          "PATH_TRAVERSAL_DETECTED",
        );
      }

      // Check for forbidden special files (directories or symlinks pointing outside)
      if (entry.type === "2" || entry.type === "1") {
        throw new ArtifactInspectionError(
          `Archive contains forbidden link entry: ${entry.name}`,
          "UNSAFE_LINK_DETECTED",
        );
      }

      // Store regular files
      fileMap.set(normalizedPath, entry.data);
      if (entry.type === "0" || entry.type === "" || entry.type === "\0") {
        files.push({
          path: normalizedPath,
          sizeBytes: entry.size,
          digest: crypto.createHash("sha256").update(entry.data).digest("hex"),
        });
      }
    }

    // Locate manifest.json
    const manifestBuffer = fileMap.get("manifest.json") ?? fileMap.get("manifest.json5");
    if (!manifestBuffer) {
      throw new ArtifactInspectionError(
        "Archive does not contain manifest.json",
        "MISSING_MANIFEST",
      );
    }

    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(manifestBuffer.toString("utf-8"));
    } catch (err) {
      throw new ArtifactInspectionError(
        `Failed to parse manifest.json as JSON: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_MANIFEST_JSON",
      );
    }

    let manifest: ToolManifest;
    try {
      manifest = ToolManifestSchema.parse(manifestRaw);
    } catch (err) {
      throw new ArtifactInspectionError(
        `Manifest schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_MANIFEST_SCHEMA",
      );
    }

    // Check runtime & SDK engine compatibility
    const supportedEngines = new Set(
      options.supportedEngines ?? ["deno", "node", "bun", "wasm", "process", "builtin"],
    );
    const rawRuntime = (manifestRaw as Record<string, unknown>)?.runtime as
      | Record<string, unknown>
      | undefined;
    const runtimeObj = manifest.runtime as unknown as {
      runtime?: string;
      engine?: string;
      sdkVersion?: string;
    };
    const engine =
      (rawRuntime?.engine as string | undefined) ??
      (rawRuntime?.runtime as string | undefined) ??
      runtimeObj.engine ??
      runtimeObj.runtime ??
      "deno";
    const sdkVersion = (rawRuntime?.sdkVersion as string | undefined) ?? runtimeObj.sdkVersion;
    if (!supportedEngines.has(engine)) {
      throw new IncompatibleRuntimeError(
        engine,
        sdkVersion,
        `Engine '${engine}' is not supported by local runtime (supported: ${Array.from(supportedEngines).join(", ")})`,
      );
    }

    // Check manifest self-digest if present
    const rawManifestJsonDigest = crypto
      .createHash("sha256")
      .update(canonicalJson(manifestRaw as Record<string, unknown>))
      .digest("hex");
    const rawWithEmptyDigest = crypto
      .createHash("sha256")
      .update(canonicalJson({ ...(manifestRaw as Record<string, unknown>), digest: "" }))
      .digest("hex");
    const computedManifestDigest = computeManifestDigest(manifest);
    const rawManifestDigest = crypto
      .createHash("sha256")
      .update(canonicalJson(manifest))
      .digest("hex");
    const { digest: _digest, ...restOfManifest } = manifest as Record<string, unknown>;
    const strippedManifestDigest = crypto
      .createHash("sha256")
      .update(canonicalJson(restOfManifest))
      .digest("hex");

    const validManifestDigests = new Set([
      rawManifestJsonDigest,
      rawWithEmptyDigest,
      computedManifestDigest,
      rawManifestDigest,
      strippedManifestDigest,
    ]);

    if (manifest.digest && !validManifestDigests.has(manifest.digest)) {
      throw new DigestMismatchError(manifest.digest, computedManifestDigest);
    }
    // Locate signature.json
    const signatureBuffer = fileMap.get("signature.json");
    let rawSignature: Record<string, unknown> | undefined;
    let signatureResult: ArtifactInspectionResult["signature"];

    if (signatureBuffer) {
      try {
        rawSignature = JSON.parse(signatureBuffer.toString("utf-8")) as Record<string, unknown>;
      } catch (err) {
        throw new ArtifactInspectionError(
          `Failed to parse signature.json: ${err instanceof Error ? err.message : String(err)}`,
          "INVALID_SIGNATURE_JSON",
        );
      }
    }

    if (options.requireSignature && !rawSignature) {
      throw new InvalidSignatureError("unknown", "Artifact is missing required signature.json");
    }

    if (rawSignature && (options.verifySignature || options.requireSignature)) {
      const keyId = typeof rawSignature.keyId === "string" ? rawSignature.keyId : undefined;
      const algorithm =
        typeof rawSignature.algorithm === "string" ? rawSignature.algorithm : "ed25519";
      const signatureHex =
        typeof rawSignature.signature === "string"
          ? rawSignature.signature
          : typeof rawSignature.sig === "string"
            ? rawSignature.sig
            : undefined;

      if (!keyId) {
        throw new InvalidSignatureError("unknown", "Missing keyId in signature.json");
      }
      if (!signatureHex) {
        throw new InvalidSignatureError(keyId, "Missing signature in signature.json");
      }

      const keyEntry = await this.keyStore.getKey(keyId);
      if (!keyEntry) {
        throw new UnknownSigningKeyError(keyId);
      }

      if (keyEntry.trustLevel === "revoked") {
        throw new RevokedSigningKeyError(keyId);
      }

      const isTrusted = await this.keyStore.isTrusted(
        keyId,
        options.allowDevKeys ?? this.allowDevKeys,
      );
      if (!isTrusted) {
        throw new UntrustedSigningKeyError(keyId, keyEntry.trustLevel);
      }

      // Verify manifest digest in signature matches computed manifest digest
      if (
        typeof rawSignature.manifestDigest === "string" &&
        rawSignature.manifestDigest !== computedManifestDigest &&
        rawSignature.manifestDigest !== rawManifestDigest &&
        rawSignature.manifestDigest !== manifest.digest
      ) {
        throw new InvalidSignatureError(
          keyId,
          `Manifest digest mismatch in signature: signature has ${rawSignature.manifestDigest}, computed ${computedManifestDigest}`,
        );
      }

      // Check fileDigests in signature if present
      const rawFileDigests =
        rawSignature.fileDigests && typeof rawSignature.fileDigests === "object"
          ? (rawSignature.fileDigests as Record<string, string>)
          : {};

      const fileDigestsRecord: Record<string, string> = { ...rawFileDigests };
      if (Object.keys(fileDigestsRecord).length === 0) {
        for (const f of files) {
          if (f.path !== "signature.json") {
            fileDigestsRecord[f.path] = f.digest;
          }
        }
      } else {
        // 1. Verify all files in archive match signature.fileDigests
        for (const f of files) {
          if (f.path !== "signature.json") {
            const expectedFileDigest = fileDigestsRecord[f.path];
            if (!expectedFileDigest || expectedFileDigest !== f.digest) {
              throw new InvalidSignatureError(
                keyId,
                `File digest mismatch or unknown file '${f.path}' in signature (expected=${expectedFileDigest ?? "none"}, actual=${f.digest})`,
              );
            }
          }
        }
        // 2. Verify all files in signature.fileDigests exist in archive
        for (const expectedPath of Object.keys(fileDigestsRecord)) {
          const found = files.some((f) => f.path === expectedPath);
          if (!found) {
            throw new InvalidSignatureError(
              keyId,
              `File '${expectedPath}' listed in signature is missing from archive`,
            );
          }
        }
      }

      // Recreate canonical payload
      const signedAt =
        typeof rawSignature.signedAt === "string"
          ? rawSignature.signedAt
          : typeof rawSignature.timestamp === "string"
            ? rawSignature.timestamp
            : "";

      const rawBundleDigest =
        typeof rawSignature.bundleDigest === "string"
          ? rawSignature.bundleDigest
          : typeof rawSignature.digest === "string"
            ? rawSignature.digest
            : bundleDigest;

      const signPayload = createCanonicalSignPayload(
        rawBundleDigest,
        fileDigestsRecord,
        keyId,
        algorithm,
        signedAt,
      );

      let isValidSig = false;
      try {
        const sigBuf = Buffer.from(signatureHex, "hex");
        isValidSig = crypto.verify(null, signPayload, keyEntry.publicKeyPem, sigBuf);
      } catch (err) {
        throw new InvalidSignatureError(
          keyId,
          `Cryptographic signature verification error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!isValidSig) {
        throw new InvalidSignatureError(
          keyId,
          "Cryptographic signature verification failed: signature does not match payload",
        );
      }

      signatureResult = {
        keyId,
        algorithm,
        valid: true,
        trustLevel: keyEntry.trustLevel,
      };
    }

    // Production-Safety Attestation Check
    let attestationRecord: SafetyAttestationRecord | undefined;
    let rawAttestation: Record<string, unknown> | undefined;
    const attestationBuffer = fileMap.get("attestation.json");
    if (attestationBuffer) {
      try {
        rawAttestation = JSON.parse(attestationBuffer.toString("utf-8")) as Record<string, unknown>;
        attestationRecord = SafetyAttestationRecordSchema.parse(rawAttestation);
      } catch (err) {
        throw new AttestationVerificationError(
          `Failed to parse attestation.json: ${err instanceof Error ? err.message : String(err)}`,
          "INVALID_ATTESTATION_SCHEMA",
        );
      }
    } else {
      const customManifest = manifest as unknown as { safetyAttestation?: unknown };
      if (
        customManifest.safetyAttestation &&
        typeof customManifest.safetyAttestation === "object"
      ) {
        attestationRecord = customManifest.safetyAttestation as SafetyAttestationRecord;
      }
    }

    if (options.requireAttestation && !attestationRecord) {
      throw new AttestationVerificationError(
        "Safety attestation is required for production activation",
        "MISSING_ATTESTATION",
      );
    }

    if (attestationRecord) {
      const attestationCheck = verifySafetyAttestation(attestationRecord);
      if (!attestationCheck.valid) {
        throw new AttestationVerificationError(
          attestationCheck.error ?? "Safety attestation verification failed",
          attestationCheck.errorCode,
        );
      }
    }

    return {
      manifest,
      bundleDigest,
      files,
      rawSignature,
      signature: signatureResult,
      attestation: attestationRecord,
      rawAttestation,
    };
  }
}

export interface ObservationSyncClientOptions {
  baseUrl?: string;
  identityProvider?: () => Promise<{ tenantId?: string; token?: string; workspaceId?: string }>;
  fetchFn?: typeof fetch;
  maxBatchSize?: number;
}

export interface ObservationSyncResponse {
  accepted: number;
  rejected: number;
  batchId: string;
  cursor?: string;
}

/**
 * Client for synchronizing sanitized observation batches to the cloud coordination plane.
 * Enforces strict V1 privacy boundaries:
 * - Accepts ONLY validated and branded SanitizedObservationDto / SanitizedObservationBatchDto
 * - Never accepts raw transcript repositories or arbitrary local session objects
 * - Fails closed before serialization or network transmission on any raw/sensitive field
 * - Rejects any remote config or response that attempts to enable raw transcript/source upload
 */
export class ObservationSyncClient {
  private readonly baseUrl: string;
  private readonly identityProvider?: () => Promise<{
    tenantId?: string;
    token?: string;
    workspaceId?: string;
  }>;
  private readonly fetchFn: typeof fetch;
  private readonly maxBatchSize: number;

  constructor(options: ObservationSyncClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.resin.cloud";
    this.identityProvider = options.identityProvider;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.maxBatchSize = options.maxBatchSize ?? 500;
  }

  /**
   * Transmits a validated sanitized observation batch.
   * Rejects any raw repositories, raw transcripts, or unbranded inputs before fetch or serialization.
   */
  async syncObservations(
    batchOrObservations: SanitizedObservationBatchDto | SanitizedObservationDto[] | unknown[],
    batchMetadata?: { batchId?: string; workspaceId?: string; projectId?: string; cursor?: string },
  ): Promise<ObservationSyncResponse> {
    // 1. Convert to validated branded batch DTO (or verify existing branded batch)
    let batch: SanitizedObservationBatchDto;
    if (isSanitizedObservationBatchDto(batchOrObservations)) {
      batch = batchOrObservations;
      assertNoProhibitedRawData(batch);
    } else if (Array.isArray(batchOrObservations)) {
      const batchId = batchMetadata?.batchId ?? crypto.randomUUID();
      batch = createSanitizedObservationBatchDto({
        batchId,
        workspaceId: batchMetadata?.workspaceId,
        projectId: batchMetadata?.projectId,
        cursor: batchMetadata?.cursor,
        observations: batchOrObservations,
      });
    } else {
      throw new InvalidSanitizedObservationError(
        "Observation sync requires a validated SanitizedObservationBatchDto or array of SanitizedObservationDto",
      );
    }

    if (batch.observations.length > this.maxBatchSize) {
      throw new InvalidSanitizedObservationError(
        `Batch size ${batch.observations.length} exceeds maximum allowed (${this.maxBatchSize})`,
      );
    }

    // 2. Pre-serialization deep verification
    assertNoProhibitedRawData(batch);

    // 3. Serialize strictly sanitized payload
    const payload = {
      batchId: batch.batchId,
      workspaceId: batch.workspaceId,
      projectId: batch.projectId,
      clientTimestamp: batch.clientTimestamp,
      cursor: batch.cursor,
      observations: batch.observations.map((obs) => {
        const { [SanitizedObservationBrandSymbol]: _, ...cleanObs } = obs as unknown as Record<
          string | symbol,
          unknown
        >;
        return cleanObs;
      }),
    };

    assertNoProhibitedRawData(payload);
    const bodyString = JSON.stringify(payload);

    // Scan serialized string for sensitive leaks
    for (const pattern of SENSITIVE_PATTERN_REGEXES) {
      if (pattern.test(bodyString)) {
        throw new RawDataExfiltrationError(
          `Detected sensitive pattern in serialized payload: matches ${pattern.toString()}`,
        );
      }
    }

    // 4. Resolve auth headers if available
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Resin-Observer/0.1.0",
    };

    if (this.identityProvider) {
      const identity = await this.identityProvider();
      if (identity.token) {
        headers.Authorization = `Bearer ${identity.token}`;
      }
      if (identity.tenantId) {
        headers["X-Resin-Tenant-Id"] = identity.tenantId;
      }
    }

    // 5. Transmit
    const response = await this.fetchFn(`${this.baseUrl}/v1/observations/batch`, {
      method: "POST",
      headers,
      body: bodyString,
    });

    if (!response.ok) {
      throw new Error(
        `Observation sync failed with status ${response.status}: ${response.statusText}`,
      );
    }

    const responseData = (await response.json()) as Record<string, unknown>;

    // 6. Check response for any hostile remote commands attempting to enable raw upload
    this.assertNoHostileRemoteDirectives(responseData);

    return {
      accepted:
        typeof responseData.accepted === "number"
          ? responseData.accepted
          : batch.observations.length,
      rejected: typeof responseData.rejected === "number" ? responseData.rejected : 0,
      batchId: batch.batchId,
      cursor: typeof responseData.cursor === "string" ? responseData.cursor : batch.cursor,
    };
  }

  /**
   * Asserts that a cloud response or configuration does not attempt to enable raw uploads
   * or weaken local privacy boundaries. Fails closed if any remote raw-upload directive is present.
   */
  assertNoHostileRemoteDirectives(configOrResponse: unknown): void {
    if (!configOrResponse || typeof configOrResponse !== "object") return;
    const obj = configOrResponse as Record<string, unknown>;

    const hostileKeys = [
      "enableRawUpload",
      "rawTranscriptUploadEnabled",
      "uploadRawTranscripts",
      "requestRawTranscripts",
      "includePrompts",
      "includeSourceCode",
      "uploadMode",
      "disableRedaction",
      "bypassSanitizer",
    ];

    for (const key of hostileKeys) {
      if (key in obj) {
        const val = obj[key];
        if (val === true || val === "raw" || val === "all" || val === "enabled") {
          throw new RawUploadProhibitedError(
            `Cloud response/configuration directive '${key}=${String(val)}' rejected. Remote directives cannot enable raw upload or bypass local sanitization.`,
          );
        }
      }
    }
  }

  /**
   * Explicitly forbidden V1 raw upload method - always fails closed.
   */
  uploadRawTranscript(): never {
    throw new RawUploadProhibitedError(
      "uploadRawTranscript is strictly prohibited in Resin V1 architecture. Raw transcripts never leave local storage.",
    );
  }

  /**
   * Explicitly forbidden V1 raw upload toggle - always fails closed.
   */
  setRawUploadEnabled(): never {
    throw new RawUploadProhibitedError(
      "Raw upload cannot be enabled. Resin V1 operates exclusively in no-raw-upload mode.",
    );
  }
}
