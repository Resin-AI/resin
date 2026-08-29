import crypto from "node:crypto";
import { canonicalJson } from "@resin/contracts";
import type { BundleSignatureAlgorithm, BundleSignatureData } from "./spec.js";

export type { BundleSignatureAlgorithm, BundleSignatureData };

/**
 * Key store entry representing a trusted or known public key.
 */
export interface KeyStoreEntry {
  keyId: string;
  algorithm: BundleSignatureAlgorithm;
  publicKeyPem: string;
  trustLevel: "production" | "development" | "revoked";
  description?: string;
  expiresAt?: string;
  createdAt: string;
}

/**
 * Abstract KeyStore interface for validating bundle signatures.
 */
export interface KeyStore {
  getKey(keyId: string): Promise<KeyStoreEntry | null>;
  hasKey(keyId: string): Promise<boolean>;
  isTrusted(keyId: string, allowDevKeys?: boolean): Promise<boolean>;
  addKey(entry: KeyStoreEntry): Promise<void>;
  revokeKey(keyId: string): Promise<void>;
}

/**
 * In-memory key store implementation.
 */
export class InMemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, KeyStoreEntry>();

  constructor(initialEntries: KeyStoreEntry[] = []) {
    for (const entry of initialEntries) {
      this.keys.set(entry.keyId, entry);
    }
  }

  async getKey(keyId: string): Promise<KeyStoreEntry | null> {
    return this.keys.get(keyId) ?? null;
  }

  async hasKey(keyId: string): Promise<boolean> {
    return this.keys.has(keyId);
  }

  async isTrusted(keyId: string, allowDevKeys = false): Promise<boolean> {
    const entry = this.keys.get(keyId);
    if (!entry) return false;
    if (entry.trustLevel === "revoked") return false;
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) return false;
    if (entry.trustLevel === "development" && !allowDevKeys) return false;
    return true;
  }

  async addKey(entry: KeyStoreEntry): Promise<void> {
    this.keys.set(entry.keyId, entry);
  }

  async revokeKey(keyId: string): Promise<void> {
    const entry = this.keys.get(keyId);
    if (entry) {
      this.keys.set(keyId, { ...entry, trustLevel: "revoked" });
    }
  }
}

export interface GeneratedKeyPair {
  keyId: string;
  algorithm: BundleSignatureAlgorithm;
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * Generate a new cryptographic key pair for tool bundle signing.
 */
export function generateBundleKeyPair(
  algorithm: BundleSignatureAlgorithm = "ed25519",
  keyId?: string,
): GeneratedKeyPair {
  const resolvedKeyId = keyId ?? `key-${algorithm}-${crypto.randomUUID()}`;

  if (algorithm === "ed25519") {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return {
      keyId: resolvedKeyId,
      algorithm,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }

  if (algorithm === "ecdsa_p256_sha256") {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    return {
      keyId: resolvedKeyId,
      algorithm,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }

  if (algorithm === "rsa_pss_sha256") {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    return {
      keyId: resolvedKeyId,
      algorithm,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }

  throw new Error(`Unsupported signature algorithm: ${algorithm}`);
}

/**
 * Constant development key identifier.
 */
export const DEV_KEY_ID = "resin-dev-key-01";

let cachedDevKeyPair: GeneratedKeyPair | null = null;

/**
 * Returns a deterministic development key pair for local evolution and testing.
 */
export function getDevelopmentKeyPair(): GeneratedKeyPair {
  if (cachedDevKeyPair) {
    return cachedDevKeyPair;
  }
  // Generate ed25519 key pair with stable id
  cachedDevKeyPair = generateBundleKeyPair("ed25519", DEV_KEY_ID);
  return cachedDevKeyPair;
}

/**
 * Creates a default KeyStore pre-populated with the development key.
 */
export function createDevelopmentKeyStore(): InMemoryKeyStore {
  const devKey = getDevelopmentKeyPair();
  return new InMemoryKeyStore([
    {
      keyId: devKey.keyId,
      algorithm: devKey.algorithm,
      publicKeyPem: devKey.publicKeyPem,
      trustLevel: "development",
      description: "Default development signing key for Resin runtime",
      createdAt: new Date().toISOString(),
    },
  ]);
}

/**
 * Options for signing a bundle.
 */
export interface SignBundleOptions {
  keyId: string;
  privateKeyPem: string;
  algorithm?: BundleSignatureAlgorithm;
  signedAt?: string;
  certificateChain?: string[];
  publicKeyPem?: string;
}

/**
 * Computes canonical payload buffer for signing.
 */
export function createCanonicalSignPayload(
  bundleDigest: string,
  fileDigests: Record<string, string>,
  keyId: string,
  algorithm: BundleSignatureAlgorithm,
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
 * Signs bundle digests and metadata deterministically.
 */
export function signBundlePayload(
  bundleDigest: string,
  fileDigests: Record<string, string>,
  options: SignBundleOptions,
): BundleSignatureData {
  const algorithm = options.algorithm ?? "ed25519";
  const signedAt = options.signedAt ?? new Date().toISOString();
  const payloadBuffer = createCanonicalSignPayload(
    bundleDigest,
    fileDigests,
    options.keyId,
    algorithm,
    signedAt,
  );

  let signatureHex: string;

  if (algorithm === "ed25519") {
    const signature = crypto.sign(null, payloadBuffer, options.privateKeyPem);
    signatureHex = signature.toString("hex");
  } else if (algorithm === "ecdsa_p256_sha256") {
    const signer = crypto.createSign("SHA256");
    signer.update(payloadBuffer);
    signer.end();
    const signature = signer.sign(options.privateKeyPem);
    signatureHex = signature.toString("hex");
  } else if (algorithm === "rsa_pss_sha256") {
    const signature = crypto.sign("SHA256", payloadBuffer, {
      key: options.privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    signatureHex = signature.toString("hex");
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  return {
    keyId: options.keyId,
    algorithm,
    signature: signatureHex,
    bundleDigest,
    signedAt,
    fileDigests,
    certificateChain: options.certificateChain,
    publicKey: options.publicKeyPem,
  };
}

/**
 * Result of signature verification.
 */
export interface SignatureVerificationResult {
  valid: boolean;
  keyId: string;
  algorithm: BundleSignatureAlgorithm;
  trustLevel?: "production" | "development" | "revoked";
  reason?: string;
  error?: string;
}

export interface VerifySignatureOptions {
  allowDevKeys?: boolean;
  expectedBundleDigest?: string;
  expectedFileDigests?: Record<string, string>;
}

/**
 * Verifies a bundle signature against a KeyStore.
 */
export async function verifyBundleSignature(
  signatureData: BundleSignatureData,
  keyStore: KeyStore,
  options: VerifySignatureOptions = {},
): Promise<SignatureVerificationResult> {
  const { keyId, algorithm, signature, bundleDigest, signedAt, fileDigests } = signatureData;

  if (options.expectedBundleDigest && options.expectedBundleDigest !== bundleDigest) {
    return {
      valid: false,
      keyId,
      algorithm,
      reason: "BUNDLE_DIGEST_MISMATCH",
      error: `Signature bundle digest ${bundleDigest} does not match expected digest ${options.expectedBundleDigest}`,
    };
  }

  if (options.expectedFileDigests) {
    const signedDigests = fileDigests ?? {};
    const signedFiles = Object.keys(signedDigests).filter((f) => f !== "signature.json");
    const expectedFiles = Object.keys(options.expectedFileDigests).filter(
      (f) => f !== "signature.json",
    );
    const missingFiles = signedFiles.filter((f) => !(f in options.expectedFileDigests!));
    if (missingFiles.length > 0) {
      return {
        valid: false,
        keyId,
        algorithm,
        reason: "FILE_DIGEST_MISMATCH",
        error: `Missing signed files in bundle: ${missingFiles.join(", ")}`,
      };
    }
    const extraFiles = expectedFiles.filter((f) => !(f in signedDigests));
    if (extraFiles.length > 0) {
      return {
        valid: false,
        keyId,
        algorithm,
        reason: "FILE_DIGEST_MISMATCH",
        error: `Unexpected unsigned files in bundle: ${extraFiles.join(", ")}`,
      };
    }
    for (const file of signedFiles) {
      if (signedDigests[file] !== options.expectedFileDigests[file]) {
        return {
          valid: false,
          keyId,
          algorithm,
          reason: "FILE_DIGEST_MISMATCH",
          error: `File digest mismatch for '${file}': expected ${signedDigests[file]}, got ${options.expectedFileDigests[file]}`,
        };
      }
    }
  }
  const keyEntry = await keyStore.getKey(keyId);
  if (!keyEntry) {
    // If not found in keyStore, check if embedded public key was provided and valid
    if (signatureData.publicKey) {
      // Unregistered public key
      return {
        valid: false,
        keyId,
        algorithm,
        reason: "UNKNOWN_SIGNING_KEY",
        error: `Signing key ${keyId} is not present in trusted key store`,
      };
    }
    return {
      valid: false,
      keyId,
      algorithm,
      reason: "KEY_NOT_FOUND",
      error: `Key ${keyId} was not found in key store`,
    };
  }

  const isTrusted = await keyStore.isTrusted(keyId, options.allowDevKeys);
  if (!isTrusted) {
    return {
      valid: false,
      keyId,
      algorithm,
      trustLevel: keyEntry.trustLevel,
      reason: "UNTRUSTED_KEY",
      error: `Key ${keyId} is not trusted (trust level: ${keyEntry.trustLevel})`,
    };
  }

  const payloadBuffer = createCanonicalSignPayload(
    bundleDigest,
    fileDigests,
    keyId,
    algorithm,
    signedAt,
  );

  const signatureBuffer = Buffer.from(signature, "hex");

  let isValid = false;
  try {
    if (algorithm === "ed25519") {
      isValid = crypto.verify(null, payloadBuffer, keyEntry.publicKeyPem, signatureBuffer);
    } else if (algorithm === "ecdsa_p256_sha256") {
      const verifier = crypto.createVerify("SHA256");
      verifier.update(payloadBuffer);
      verifier.end();
      isValid = verifier.verify(keyEntry.publicKeyPem, signatureBuffer);
    } else if (algorithm === "rsa_pss_sha256") {
      isValid = crypto.verify(
        "SHA256",
        payloadBuffer,
        {
          key: keyEntry.publicKeyPem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signatureBuffer,
      );
    }
  } catch (err) {
    return {
      valid: false,
      keyId,
      algorithm,
      trustLevel: keyEntry.trustLevel,
      reason: "CRYPTOGRAPHIC_VERIFICATION_ERROR",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!isValid) {
    return {
      valid: false,
      keyId,
      algorithm,
      trustLevel: keyEntry.trustLevel,
      reason: "INVALID_SIGNATURE",
      error: "Cryptographic signature verification failed: signature is invalid",
    };
  }

  return {
    valid: true,
    keyId,
    algorithm,
    trustLevel: keyEntry.trustLevel,
  };
}
