import crypto from "node:crypto";
import type { PlatformInfo } from "./platform.js";

/**
 * The original V1 release key is permanently revoked because its private half
 * was committed historically. Callers must supply a pinned public trust root.
 */
export const REVOKED_RELEASE_KEY_IDS = Object.freeze(["resin-release-v1"]);

// Ed25519 SPKI DER prefix (12 bytes)
const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type ReleaseChannel = "stable" | "prerelease" | "nightly" | "beta" | string;
export interface TrustedReleaseKey {
  readonly keyId: string;
  readonly publicKeyHex: string;
}

export interface SignatureEntry {
  readonly keyId: string;
  readonly algorithm: "Ed25519" | string;
  readonly publicKeyHex?: string;
  readonly signatureHex: string;
}

export interface ChannelInfo {
  readonly version: string;
  readonly releaseDate: string;
  readonly manifestUrl?: string;
  readonly manifestDigest?: string;
  readonly releaseNotesUrl?: string;
  readonly minSupportedVersion?: string;
  readonly isLatest?: boolean;
}

export interface RollbackReferences {
  readonly targetVersion: string;
  readonly minSafeVersion: string;
  readonly rollbackTarball?: string;
  readonly rollbackSha256?: string;
  readonly instructionsUrl?: string;
}

export interface ChannelMetadata {
  readonly schemaVersion: string;
  readonly metadataVersion?: number;
  readonly expiresAt?: string;
  readonly releaseIdentity?: unknown;
  readonly revokedKeyIds?: string[];
  readonly minSupportedVersion?: string;
  readonly currentVersion: string;
  readonly updatedAt: string;
  readonly channels: Record<string, ChannelInfo>;
  readonly rollbackReferences?: RollbackReferences;
  readonly revokedVersions?: string[];
  readonly signatures?: SignatureEntry[];
}

export interface ManifestAsset {
  readonly filename: string;
  readonly platform: string;
  readonly arch: string;
  readonly isWsl?: boolean;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly path: string;
  readonly url?: string;
}

export interface ManifestPackage {
  readonly version: string;
  readonly path: string;
  readonly type: string;
  readonly entry?: string;
  readonly entrySha256?: string;
  readonly packageSha256: string;
  readonly filesCount?: number;
}

export interface SignedManifest {
  readonly schemaVersion: string;
  readonly metadataVersion?: number;
  readonly expiresAt?: string;
  readonly releaseIdentity?: unknown;
  readonly evidence?: unknown;
  readonly version: string;
  readonly releaseDate: string;
  readonly packages?: Record<string, ManifestPackage>;
  readonly assets: Record<string, ManifestAsset>;
  readonly runtimes?: Record<string, unknown>;
  readonly signatures?: SignatureEntry[];
}

export interface ChannelVerificationOptions {
  readonly channel?: ReleaseChannel;
  readonly minSupportedVersion?: string;
  readonly currentInstalledVersion?: string;
  readonly currentActiveVersion?: string;
  readonly trustedReleaseKeys?: readonly TrustedReleaseKey[];
  readonly revokedKeyIds?: readonly string[];
  readonly skipSignatureVerification?: boolean;
  readonly now?: Date | string | number;
}

export interface ChannelVerificationResult {
  readonly valid: boolean;
  readonly channel: ReleaseChannel;
  readonly targetVersion?: string;
  readonly manifestUrl?: string;
  readonly manifestDigest?: string;
  readonly rollbackReference?: RollbackReferences;
  readonly errors: string[];
  readonly warnings: string[];
  readonly signingKeyIds?: string[];
  readonly revokedKeyIds?: string[];
}
export interface ManifestVerificationOptions {
  readonly expectedDigest?: string;
  readonly rawManifestBytes?: string | Uint8Array;
  readonly currentInstalledVersion?: string;
  readonly currentActiveVersion?: string;
  readonly minSupportedVersion?: string;
  readonly trustedReleaseKeys?: readonly TrustedReleaseKey[];
  readonly revokedKeyIds?: readonly string[];
  readonly skipSignatureVerification?: boolean;
  readonly now?: Date | string | number;
}

export interface ManifestVerificationResult {
  readonly valid: boolean;
  readonly version?: string;
  readonly assets: Record<string, ManifestAsset>;
  readonly errors: string[];
  readonly warnings: string[];
  readonly signingKeyIds?: string[];
}

/**
 * Deterministically serialize any JavaScript object into canonical JSON format.
 */
export function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Creates a Node.js crypto.KeyObject from an Ed25519 public key (hex or PEM).
 */
export function createPublicKeyFromInput(key: string | crypto.KeyObject): crypto.KeyObject {
  if (typeof key !== "string") {
    return key;
  }
  const trimmed = key.trim();
  if (trimmed.startsWith("-----BEGIN PUBLIC KEY-----")) {
    return crypto.createPublicKey(trimmed);
  }
  // Hex-encoded 32-byte Ed25519 public key
  const rawKeyBuffer = Buffer.from(trimmed, "hex");
  if (rawKeyBuffer.length !== 32) {
    throw new Error(
      `Invalid Ed25519 public key hex length: ${rawKeyBuffer.length} bytes (expected 32 bytes).`,
    );
  }
  const spkiDer = Buffer.concat([ED25519_SPKI_DER_PREFIX, rawKeyBuffer]);
  return crypto.createPublicKey({
    key: spkiDer,
    format: "der",
    type: "spki",
  });
}

/**
 * Verifies an Ed25519 digital signature over a canonical JSON payload.
 */
export function verifyEd25519Signature(
  payload: unknown,
  signatureHex: string,
  publicKey: string | crypto.KeyObject,
): boolean {
  try {
    const keyObject = createPublicKeyFromInput(publicKey);
    const canonicalString = canonicalJson(payload);
    const dataBuffer = Buffer.from(canonicalString, "utf8");
    const signatureBuffer = Buffer.from(signatureHex, "hex");

    return crypto.verify(null, dataBuffer, keyObject, signatureBuffer);
  } catch {
    return false;
  }
}

/**
 * Compares two SemVer versions (e.g. "1.0.0", "1.1.0-alpha.1").
 * Returns:
 *  -1 if v1 < v2
 *   0 if v1 === v2
 *   1 if v1 > v2
 */
export function compareSemver(v1: string, v2: string): number {
  const parseSemver = (v: string) => {
    const clean = v.replace(/^v/, "").trim();
    const [main, prerelease] = clean.split("-");
    const parts = (main || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      prerelease: prerelease ?? null,
    };
  };

  const a = parseSemver(v1);
  const b = parseSemver(v2);

  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  // Prerelease comparison: regular release > prerelease
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease !== null && b.prerelease !== null) {
    return a.prerelease.localeCompare(b.prerelease);
  }

  return 0;
}

/**
 * Checks if a version satisfies a minimum version requirement.
 */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  return compareSemver(version, minVersion) >= 0;
}

/**
 * Checks if a version is in the revoked versions list.
 */
export function isVersionRevoked(version: string, revokedVersions?: string[]): boolean {
  if (!revokedVersions || !Array.isArray(revokedVersions)) return false;
  const clean = version.replace(/^v/, "").trim();
  return revokedVersions.some((revoked) => revoked.replace(/^v/, "").trim() === clean);
}

/**
 * Verifies release channel metadata against security and versioning policies.
 */
export function verifyChannelMetadata(
  channelData: unknown,
  options: ChannelVerificationOptions = {},
): ChannelVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requestedChannel = options.channel || "stable";

  if (!channelData || typeof channelData !== "object") {
    return {
      valid: false,
      channel: requestedChannel,
      errors: ["Invalid channel metadata format: expected a JSON object."],
      warnings,
    };
  }

  const meta = channelData as ChannelMetadata;

  // Validate Schema Version
  if (!meta.schemaVersion) {
    errors.push("Channel metadata is missing required 'schemaVersion'.");
  }

  // Validate Metadata Version
  if (meta.metadataVersion === undefined || meta.metadataVersion === null) {
    errors.push("Channel metadata is missing required 'metadataVersion'.");
  } else if (
    typeof meta.metadataVersion !== "number" ||
    !Number.isInteger(meta.metadataVersion) ||
    meta.metadataVersion < 1
  ) {
    errors.push(`Invalid channel metadataVersion '${String(meta.metadataVersion)}'.`);
  } else if (meta.metadataVersion > 1) {
    errors.push(
      `Unsupported channel metadataVersion ${meta.metadataVersion}. Expected metadataVersion 1.`,
    );
  }

  // Validate Expiration (expiresAt)
  if (!meta.expiresAt || typeof meta.expiresAt !== "string") {
    errors.push("Channel metadata is missing required 'expiresAt'.");
  } else {
    const expiresAtMs = Date.parse(meta.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      errors.push(
        `Channel metadata 'expiresAt' is not a valid ISO timestamp: '${meta.expiresAt}'.`,
      );
    } else {
      const nowMs =
        typeof options.now === "number"
          ? options.now
          : options.now instanceof Date
            ? options.now.getTime()
            : typeof options.now === "string"
              ? Date.parse(options.now)
              : Date.now();
      if (!Number.isNaN(nowMs) && nowMs > expiresAtMs) {
        errors.push(
          `Channel metadata has expired (expiresAt: '${meta.expiresAt}', current: '${new Date(nowMs).toISOString()}').`,
        );
      }
    }
  }

  // Validate Channels Map
  if (!meta.channels || typeof meta.channels !== "object") {
    errors.push("Channel metadata is missing required 'channels' mapping.");
  } else {
    const channelInfo = meta.channels[requestedChannel];
    if (!channelInfo) {
      errors.push(
        `Requested release channel '${requestedChannel}' was not found in channel metadata.`,
      );
    } else {
      if (!channelInfo.version) {
        errors.push(`Release channel '${requestedChannel}' is missing required 'version'.`);
      }

      // Check Revocation
      if (channelInfo.version && isVersionRevoked(channelInfo.version, meta.revokedVersions)) {
        errors.push(
          `Target version '${channelInfo.version}' in channel '${requestedChannel}' has been revoked. Installation aborted.`,
        );
      }

      // Check minSupportedVersion constraint
      const minVersion =
        channelInfo.minSupportedVersion || meta.minSupportedVersion || options.minSupportedVersion;
      if (minVersion && channelInfo.version && !isVersionAtLeast(channelInfo.version, minVersion)) {
        errors.push(
          `Target version '${channelInfo.version}' is below the required minimum supported version '${minVersion}'.`,
        );
      }

      // Check currentInstalledVersion downgrade constraint
      const currentInstalled = options.currentInstalledVersion || options.currentActiveVersion;
      if (currentInstalled && channelInfo.version) {
        if (compareSemver(channelInfo.version, currentInstalled) < 0) {
          errors.push(
            `Target version '${channelInfo.version}' cannot downgrade currently installed version '${currentInstalled}'.`,
          );
        }
      }
    }
  }

  // Validate Rollback References
  if (meta.rollbackReferences) {
    if (!meta.rollbackReferences.targetVersion) {
      warnings.push("Rollback references present but missing 'targetVersion'.");
    }
    if (!meta.rollbackReferences.minSafeVersion) {
      warnings.push("Rollback references present but missing 'minSafeVersion'.");
    }
  }

  const signingKeyIds: string[] = [];

  // Release metadata is unsafe unless signed by a caller-pinned trust root.
  if (!options.skipSignatureVerification) {
    if (!meta.signatures || meta.signatures.length === 0) {
      errors.push("Cryptographic verification failed: channel metadata is unsigned.");
    }
    const trustedKeys = options.trustedReleaseKeys || [];
    if (trustedKeys.length === 0) {
      errors.push(
        "Cryptographic verification failed: no trusted release public keys are configured.",
      );
    }
    if (meta.signatures && meta.signatures.length > 0 && trustedKeys.length > 0) {
      const payloadToVerify = {
        schemaVersion: meta.schemaVersion,
        ...(meta.metadataVersion !== undefined ? { metadataVersion: meta.metadataVersion } : {}),
        ...(meta.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
        ...(meta.minSupportedVersion !== undefined
          ? { minSupportedVersion: meta.minSupportedVersion }
          : {}),
        currentVersion: meta.currentVersion,
        updatedAt: meta.updatedAt,
        ...(meta.releaseIdentity !== undefined ? { releaseIdentity: meta.releaseIdentity } : {}),
        channels: meta.channels,
        ...(meta.rollbackReferences !== undefined
          ? { rollbackReferences: meta.rollbackReferences }
          : {}),
        ...(meta.revokedVersions !== undefined ? { revokedVersions: meta.revokedVersions } : {}),
        ...(meta.revokedKeyIds !== undefined ? { revokedKeyIds: meta.revokedKeyIds } : {}),
      };

      const revokedSet = new Set<string>([
        ...REVOKED_RELEASE_KEY_IDS,
        ...(options.revokedKeyIds || []),
      ]);

      let signatureMatched = false;
      let hasRevokedSignature = false;
      let hasKeyMismatch = false;

      for (const sig of meta.signatures) {
        if (sig.algorithm !== "Ed25519") {
          warnings.push(`Ignoring unsupported signature algorithm: ${sig.algorithm}`);
          continue;
        }
        if (revokedSet.has(sig.keyId)) {
          hasRevokedSignature = true;
          errors.push(`Signature key '${sig.keyId}' is revoked.`);
          continue;
        }

        const trustedKey = trustedKeys.find((k) => k.keyId === sig.keyId);
        if (!trustedKey) {
          warnings.push(`Signature key '${sig.keyId}' is not in trusted release keys list.`);
          continue;
        }

        const expectedHex = trustedKey.publicKeyHex.trim().toLowerCase();
        if (sig.publicKeyHex) {
          const sigHex = sig.publicKeyHex.trim().toLowerCase();
          if (sigHex !== expectedHex) {
            hasKeyMismatch = true;
            errors.push(
              `Signature key '${sig.keyId}' public key hex mismatch (expected ${expectedHex}, got ${sigHex}).`,
            );
            continue;
          }
        }

        if (verifyEd25519Signature(payloadToVerify, sig.signatureHex, expectedHex)) {
          signatureMatched = true;
          signingKeyIds.push(sig.keyId);
        } else {
          warnings.push(`Signature verification failed for key '${sig.keyId}'.`);
        }
      }

      if (!signatureMatched) {
        if (!hasRevokedSignature && !hasKeyMismatch) {
          errors.push(
            "Cryptographic verification failed: no valid Ed25519 signature matched channel metadata payload.",
          );
        }
      }
    }
  }

  const selectedChannelInfo = meta.channels ? meta.channels[requestedChannel] : undefined;

  return {
    valid: errors.length === 0,
    channel: requestedChannel,
    targetVersion: selectedChannelInfo?.version,
    manifestUrl: selectedChannelInfo?.manifestUrl,
    manifestDigest: selectedChannelInfo?.manifestDigest,
    rollbackReference: meta.rollbackReferences,
    errors,
    warnings,
    signingKeyIds: signingKeyIds.length > 0 ? signingKeyIds : undefined,
    revokedKeyIds: meta.revokedKeyIds && errors.length === 0 ? [...meta.revokedKeyIds] : undefined,
  };
}

/**
 * Verifies a signed release manifest.
 */
export function verifyManifest(
  manifestData: unknown,
  options: ManifestVerificationOptions = {},
): ManifestVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifestData || typeof manifestData !== "object") {
    return {
      valid: false,
      assets: {},
      errors: ["Invalid manifest format: expected a JSON object."],
      warnings,
    };
  }

  const manifest = manifestData as SignedManifest;

  if (!manifest.schemaVersion) {
    errors.push("Manifest missing required 'schemaVersion'.");
  }
  if (manifest.metadataVersion === undefined || manifest.metadataVersion === null) {
    errors.push("Manifest missing required 'metadataVersion'.");
  } else if (
    typeof manifest.metadataVersion !== "number" ||
    !Number.isInteger(manifest.metadataVersion) ||
    manifest.metadataVersion < 1
  ) {
    errors.push(`Invalid manifest metadataVersion '${String(manifest.metadataVersion)}'.`);
  } else if (manifest.metadataVersion > 1) {
    errors.push(
      `Unsupported manifest metadataVersion ${manifest.metadataVersion}. Expected metadataVersion 1.`,
    );
  }
  if (!manifest.expiresAt || typeof manifest.expiresAt !== "string") {
    errors.push("Manifest missing required 'expiresAt'.");
  } else {
    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      errors.push(`Manifest 'expiresAt' is not a valid ISO timestamp: '${manifest.expiresAt}'.`);
    } else {
      const nowMs =
        typeof options.now === "number"
          ? options.now
          : options.now instanceof Date
            ? options.now.getTime()
            : typeof options.now === "string"
              ? Date.parse(options.now)
              : Date.now();
      if (!Number.isNaN(nowMs) && nowMs > expiresAtMs) {
        errors.push(
          `Manifest has expired (expiresAt: '${manifest.expiresAt}', current: '${new Date(nowMs).toISOString()}').`,
        );
      }
    }
  }
  if (!manifest.version) {
    errors.push("Manifest missing required 'version'.");
  } else {
    const currentInstalled = options.currentInstalledVersion || options.currentActiveVersion;
    if (currentInstalled && compareSemver(manifest.version, currentInstalled) < 0) {
      errors.push(
        `Manifest version '${manifest.version}' cannot downgrade currently installed version '${currentInstalled}'.`,
      );
    }
    const minVersion = options.minSupportedVersion;
    if (minVersion && !isVersionAtLeast(manifest.version, minVersion)) {
      errors.push(
        `Manifest version '${manifest.version}' is below minimum supported version '${minVersion}'.`,
      );
    }
  }
  if (!manifest.assets || typeof manifest.assets !== "object") {
    errors.push("Manifest missing required 'assets' object.");
  } else {
    for (const [key, asset] of Object.entries(manifest.assets)) {
      if (!asset || typeof asset !== "object") {
        errors.push(`Manifest asset '${key}' is invalid.`);
        continue;
      }
      if (
        typeof asset.sizeBytes !== "number" ||
        !Number.isSafeInteger(asset.sizeBytes) ||
        asset.sizeBytes <= 0
      ) {
        errors.push(`Manifest asset '${key}' has invalid sizeBytes.`);
      } else if (asset.sizeBytes > 2 * 1024 * 1024 * 1024) {
        errors.push(`Manifest asset '${key}' exceeds maximum allowed release size of 2 GiB.`);
      }
      if (!asset.sha256 || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
        errors.push(`Manifest asset '${key}' has invalid sha256 digest.`);
      }
    }
  }

  // Digest verification uses the exact downloaded bytes when available.
  if (options.expectedDigest) {
    const digestInput = options.rawManifestBytes ?? canonicalJson(manifest);
    const actualDigest = crypto.createHash("sha256").update(digestInput).digest("hex");
    if (actualDigest !== options.expectedDigest) {
      errors.push(
        `Release manifest digest mismatch: expected ${options.expectedDigest}, got ${actualDigest}.`,
      );
    }
  }

  const signingKeyIds: string[] = [];

  // Ed25519 Signature Verification
  if (!options.skipSignatureVerification) {
    if (!manifest.signatures || manifest.signatures.length === 0) {
      errors.push("Cryptographic verification failed: release manifest is unsigned.");
    }
    const trustedKeys = options.trustedReleaseKeys || [];
    if (trustedKeys.length === 0) {
      errors.push(
        "Cryptographic verification failed: no trusted release public keys are configured.",
      );
    }
    if (manifest.signatures && manifest.signatures.length > 0 && trustedKeys.length > 0) {
      const payloadToVerify = {
        schemaVersion: manifest.schemaVersion,
        ...(manifest.metadataVersion !== undefined
          ? { metadataVersion: manifest.metadataVersion }
          : {}),
        ...(manifest.expiresAt !== undefined ? { expiresAt: manifest.expiresAt } : {}),
        version: manifest.version,
        releaseDate: manifest.releaseDate,
        ...(manifest.releaseIdentity !== undefined
          ? { releaseIdentity: manifest.releaseIdentity }
          : {}),
        ...(manifest.packages !== undefined ? { packages: manifest.packages } : {}),
        assets: manifest.assets,
        ...(manifest.runtimes !== undefined ? { runtimes: manifest.runtimes } : {}),
        ...(manifest.evidence !== undefined ? { evidence: manifest.evidence } : {}),
      };

      const revokedSet = new Set<string>([
        ...REVOKED_RELEASE_KEY_IDS,
        ...(options.revokedKeyIds || []),
      ]);

      let signatureMatched = false;
      let hasRevokedSignature = false;
      let hasKeyMismatch = false;

      for (const sig of manifest.signatures) {
        if (sig.algorithm !== "Ed25519") {
          warnings.push(`Ignoring unsupported signature algorithm: ${sig.algorithm}`);
          continue;
        }
        if (revokedSet.has(sig.keyId)) {
          hasRevokedSignature = true;
          errors.push(`Signature key '${sig.keyId}' is revoked.`);
          continue;
        }

        const trustedKey = trustedKeys.find((k) => k.keyId === sig.keyId);
        if (!trustedKey) {
          warnings.push(`Signature key '${sig.keyId}' is not in trusted release keys list.`);
          continue;
        }

        const expectedHex = trustedKey.publicKeyHex.trim().toLowerCase();
        if (sig.publicKeyHex) {
          const sigHex = sig.publicKeyHex.trim().toLowerCase();
          if (sigHex !== expectedHex) {
            hasKeyMismatch = true;
            errors.push(
              `Signature key '${sig.keyId}' public key hex mismatch (expected ${expectedHex}, got ${sigHex}).`,
            );
            continue;
          }
        }

        if (verifyEd25519Signature(payloadToVerify, sig.signatureHex, expectedHex)) {
          signatureMatched = true;
          signingKeyIds.push(sig.keyId);
        } else {
          warnings.push(`Signature verification failed for key '${sig.keyId}'.`);
        }
      }

      if (!signatureMatched) {
        if (!hasRevokedSignature && !hasKeyMismatch) {
          errors.push(
            "Cryptographic verification failed: no valid Ed25519 signature matched manifest payload.",
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    version: manifest.version,
    assets: manifest.assets || {},
    errors,
    warnings,
    signingKeyIds: signingKeyIds.length > 0 ? signingKeyIds : undefined,
  };
}

/**
 * Selects the exact platform asset from a signed release manifest.
 */
export function selectPlatformAsset(
  manifest: SignedManifest,
  platform: PlatformInfo | { os: string; arch: string; isWsl?: boolean },
): ManifestAsset {
  if (!manifest.assets || typeof manifest.assets !== "object") {
    throw new Error("Release manifest has no assets available.");
  }

  // Determine platform ID (e.g. linux-x64, linux-arm64, darwin-x64, darwin-arm64, wsl-x64, wsl-arm64)
  const isWsl = Boolean(platform.isWsl) || platform.os === "wsl";
  const arch =
    platform.arch === "x86_64" ? "x64" : platform.arch === "aarch64" ? "arm64" : platform.arch;
  const osName = isWsl ? "wsl" : platform.os;

  if (isWsl && arch !== "x64" && arch !== "arm64") {
    throw new Error(
      `Unsupported WSL architecture '${platform.arch}'. Only x64 and arm64 are supported.`,
    );
  }

  let platformId: string;
  if (isWsl) {
    platformId = `wsl-${arch}`;
  } else {
    platformId = `${osName}-${arch}`;
  }

  // Try exact key match first (e.g. wsl-x64, wsl-arm64, linux-x64, linux-arm64, darwin-arm64)
  let asset: ManifestAsset | undefined = manifest.assets[platformId];

  // If WSL host and no explicit WSL asset key, try property match for WSL asset first
  if (!asset && isWsl) {
    asset = Object.values(manifest.assets).find(
      (a) => a.arch === arch && (a.platform === "wsl" || a.isWsl === true),
    );
  }

  // Fallback: If no explicit WSL asset exists, fall back to architecture-matched Linux asset
  if (!asset && isWsl) {
    asset = manifest.assets[`linux-${arch}`];
    if (!asset) {
      asset = Object.values(manifest.assets).find(
        (a) => a.arch === arch && a.platform === "linux" && !a.isWsl,
      );
    }
  }

  // Native (non-WSL) property search if not found by exact key: never match WSL assets
  if (!asset && !isWsl) {
    asset = Object.values(manifest.assets).find(
      (a) => a.arch === arch && a.platform === osName && !a.isWsl,
    );
  }
  if (!asset) {
    const available = Object.keys(manifest.assets).join(", ");
    throw new Error(
      `No compatible release asset found for platform '${platformId}' (os: ${osName}, arch: ${arch}, isWsl: ${isWsl}). Available assets: ${available}`,
    );
  }

  return asset;
}
