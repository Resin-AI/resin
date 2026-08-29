import crypto from "node:crypto";

export const RELEASE_SIGNING_ALGORITHM = "Ed25519";
export const REVOKED_RELEASE_KEY_IDS = Object.freeze(["resin-release-v1"]);
export const DEFAULT_MANIFEST_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function normalizePem(value) {
  return Object.prototype.toString.call(value) === "[object String]"
    ? value.replace(/\\n/g, "\n").trim()
    : "";
}

function fingerprintPublicKey(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function rawEd25519PublicKeyHex(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(-32).toString("hex");
}
export function isDigitOnlyKeyId(keyId) {
  return Object.prototype.toString.call(keyId) === "[object String]" && /^\d+$/.test(keyId);
}

export function isTestOnlyKey(keyId) {
  return (
    Object.prototype.toString.call(keyId) === "[object String]" &&
    (keyId.startsWith("test-only-") || keyId.includes("test-only"))
  );
}
export const isExplicitTestOnlyKeyId = isTestOnlyKey;

export function assertProductionKey(key) {
  if (!key || Object.prototype.toString.call(key) !== "[object Object]") {
    throw new Error("Invalid release key object.");
  }
  if (isDigitOnlyKeyId(key.keyId)) {
    throw new Error(
      `Release key ID '${key.keyId}' cannot be digit-only; semantic key ID is required.`,
    );
  }
  if (isTestOnlyKey(key.keyId)) {
    throw new Error(
      `Test-only release key '${key.keyId}' cannot be used for production operations.`,
    );
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(key.keyId)) {
    throw new Error(`Revoked release key '${key.keyId}' cannot be used.`);
  }
  if (key.trustDomain && key.trustDomain !== "production") {
    throw new Error(
      `Release key '${key.keyId}' belongs to '${key.trustDomain}' trust domain, not 'production'.`,
    );
  }
  return key;
}
export const validateLoadedReleaseKeyRecord = assertProductionKey;

export function createReleaseSigningKey(input, options = {}) {
  const keyId =
    Object.prototype.toString.call(input?.keyId) === "[object String]" ? input.keyId.trim() : "";
  const privateKeyPkcs8Pem = normalizePem(input?.privateKeyPkcs8Pem || input?.privateKeyPem);
  const publicKeyPemInput = normalizePem(input?.publicKeyPem);
  const allowTestOnly = options.allowTestOnly === true;

  if (!keyId) {
    throw new Error("Release signing key ID is required.");
  }
  if (isDigitOnlyKeyId(keyId)) {
    throw new Error(
      `Release signing key ID '${keyId}' cannot be digit-only; semantic key ID is required.`,
    );
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
    throw new Error(`Revoked release signing key '${keyId}' cannot be used.`);
  }
  if (isTestOnlyKey(keyId) && !allowTestOnly) {
    throw new Error("Test-only release signing keys cannot be used for production releases.");
  }
  if (!privateKeyPkcs8Pem) {
    throw new Error("Release signing private key is required from the external secret boundary.");
  }
  if (!publicKeyPemInput) {
    throw new Error(
      "Release signing public key is required so the private key can be cross-checked.",
    );
  }

  const privateKey = crypto.createPrivateKey(privateKeyPkcs8Pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing private key must be Ed25519.");
  }
  const derivedPublicKey = crypto.createPublicKey(privateKey);
  const suppliedPublicKey = crypto.createPublicKey(publicKeyPemInput);
  if (suppliedPublicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing public key must be Ed25519.");
  }

  const derivedDer = derivedPublicKey.export({ type: "spki", format: "der" });
  const suppliedDer = suppliedPublicKey.export({ type: "spki", format: "der" });
  if (!derivedDer.equals(suppliedDer)) {
    throw new Error("Supplied release public key does not match the configured private key pair.");
  }

  const publicKeyPem = derivedPublicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeyHex = rawEd25519PublicKeyHex(derivedPublicKey);
  const publicKeyFingerprintSha256 = fingerprintPublicKey(derivedPublicKey);
  const trustDomain = allowTestOnly || isTestOnlyKey(keyId) ? "test-only" : "production";

  return Object.freeze({
    keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    trustDomain,
    isTestOnly: trustDomain === "test-only",
    publicKeyPem,
    publicKeyHex,
    publicKeyFingerprintSha256,
    privateKey,
  });
}

export function createTestReleaseSigningKey() {
  const generated = crypto.generateKeyPairSync("ed25519");
  return createReleaseSigningKey(
    {
      keyId: `test-only-${crypto.randomUUID()}`,
      privateKeyPkcs8Pem: generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    { allowTestOnly: true },
  );
}

export function loadReleaseSigningKeyFromEnv(env = process.env, options = {}) {
  const allowTestOnly = options.allowTestOnly ?? env.RESIN_RELEASE_TEST_ONLY === "1";
  return createReleaseSigningKey(
    {
      keyId: env.RESIN_RELEASE_KEY_ID,
      privateKeyPkcs8Pem: env.RESIN_RELEASE_PRIVATE_KEY_PEM,
      publicKeyPem: env.RESIN_RELEASE_PUBLIC_KEY_PEM,
    },
    { allowTestOnly },
  );
}

export function publicTrustRecord(key) {
  if (!key) throw new Error("Release signing key is required to build a public trust record.");
  return Object.freeze({
    keyId: key.keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    trustDomain: key.trustDomain,
    publicKeyPem: key.publicKeyPem,
    publicKeyHex: key.publicKeyHex,
    publicKeyFingerprintSha256: key.publicKeyFingerprintSha256,
  });
}

export function trustedKeysFromSigningKey(key) {
  return Object.freeze({ [key.keyId]: publicTrustRecord(key) });
}

export function loadTrustedReleaseKeysFromEnv(env = process.env, options = {}) {
  const keyId =
    Object.prototype.toString.call(env.RESIN_RELEASE_KEY_ID) === "[object String]"
      ? env.RESIN_RELEASE_KEY_ID.trim()
      : "";
  const publicKeyPem = normalizePem(env.RESIN_RELEASE_PUBLIC_KEY_PEM);
  const allowTestOnly = options.allowTestOnly ?? env.RESIN_RELEASE_TEST_ONLY === "1";

  if (!keyId || !publicKeyPem) {
    throw new Error(
      "Trusted release key ID and public key are required (RESIN_RELEASE_KEY_ID / RESIN_RELEASE_PUBLIC_KEY_PEM).",
    );
  }
  if (isDigitOnlyKeyId(keyId)) {
    throw new Error(
      `Trusted release key ID '${keyId}' cannot be digit-only; semantic key ID is required.`,
    );
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
    throw new Error(`Trusted release key '${keyId}' is revoked.`);
  }
  if (isTestOnlyKey(keyId) && !allowTestOnly) {
    throw new Error(
      `Test-only release key '${keyId}' cannot be loaded into production trust store.`,
    );
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch {
    throw new Error("Trusted release public key must be valid Ed25519 PEM.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Trusted release public key must be Ed25519.");
  }
  const trustDomain = allowTestOnly || isTestOnlyKey(keyId) ? "test-only" : "production";
  const activeRecord = Object.freeze({
    keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    trustDomain,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeyHex: rawEd25519PublicKeyHex(publicKey),
    publicKeyFingerprintSha256: fingerprintPublicKey(publicKey),
  });

  const result = Object.create(null);
  result[keyId] = activeRecord;

  const seenKeyIds = new Set([keyId]);
  const seenPublicRoots = new Set([activeRecord.publicKeyHex.toLowerCase()]);

  let additionalEntries;
  if (Array.isArray(options.additionalKeys)) {
    additionalEntries = options.additionalKeys;
  } else {
    const additionalRaw =
      Object.prototype.toString.call(options.additionalTrustedKeysJson) === "[object String]"
        ? options.additionalTrustedKeysJson
        : env.RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON;
    if (
      Object.prototype.toString.call(additionalRaw) === "[object String]" &&
      additionalRaw.trim().length > 0
    ) {
      try {
        additionalEntries = JSON.parse(additionalRaw);
      } catch (err) {
        throw new Error(
          `Failed to parse RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (additionalEntries !== undefined) {
    if (!Array.isArray(additionalEntries)) {
      throw new Error(
        "RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON must be a JSON array of key records.",
      );
    }
    for (let i = 0; i < additionalEntries.length; i++) {
      const entry = additionalEntries[i];
      if (
        !entry ||
        Array.isArray(entry) ||
        Object.prototype.toString.call(entry) !== "[object Object]"
      ) {
        throw new Error(`Invalid additional trusted key record at index ${i}: expected an object.`);
      }
      const addKeyId =
        Object.prototype.toString.call(entry.keyId) === "[object String]" ? entry.keyId.trim() : "";
      const addPem = normalizePem(entry.publicKeyPem);
      if (!addKeyId || !addPem) {
        throw new Error(
          `Additional trusted key record at index ${i} requires 'keyId' and 'publicKeyPem'.`,
        );
      }
      if (isDigitOnlyKeyId(addKeyId)) {
        throw new Error(
          `Additional trusted key ID '${addKeyId}' cannot be digit-only; semantic key ID is required.`,
        );
      }
      if (REVOKED_RELEASE_KEY_IDS.includes(addKeyId)) {
        throw new Error(`Additional trusted release key '${addKeyId}' is revoked.`);
      }
      if (isTestOnlyKey(addKeyId) && !allowTestOnly) {
        throw new Error(
          `Test-only additional release key '${addKeyId}' cannot be loaded into production trust store.`,
        );
      }
      if (seenKeyIds.has(addKeyId)) {
        throw new Error(`Duplicate key ID '${addKeyId}' in trusted release keys.`);
      }

      let addPublicKey;
      try {
        addPublicKey = crypto.createPublicKey(addPem);
      } catch {
        throw new Error(
          `Additional trusted release key '${addKeyId}' has invalid Ed25519 public key PEM.`,
        );
      }
      if (addPublicKey.asymmetricKeyType !== "ed25519") {
        throw new Error(`Additional trusted release key '${addKeyId}' must be Ed25519.`);
      }

      const addPublicKeyHex = rawEd25519PublicKeyHex(addPublicKey).toLowerCase();
      if (seenPublicRoots.has(addPublicKeyHex)) {
        throw new Error(
          `Duplicate public root key hex '${addPublicKeyHex}' for key '${addKeyId}'.`,
        );
      }

      const addTrustDomain = allowTestOnly || isTestOnlyKey(addKeyId) ? "test-only" : "production";
      const addRecord = Object.freeze({
        keyId: addKeyId,
        algorithm: RELEASE_SIGNING_ALGORITHM,
        trustDomain: addTrustDomain,
        publicKeyPem: addPublicKey.export({ type: "spki", format: "pem" }).toString(),
        publicKeyHex: addPublicKeyHex,
        publicKeyFingerprintSha256: fingerprintPublicKey(addPublicKey),
      });

      seenKeyIds.add(addKeyId);
      seenPublicRoots.add(addPublicKeyHex);
      result[addKeyId] = addRecord;
    }
  }

  return Object.freeze(result);
}

export function isManifestExpired(manifest, currentTime = new Date()) {
  const now = currentTime instanceof Date ? currentTime.getTime() : new Date(currentTime).getTime();
  if (manifest?.expiresAt) {
    const expires = new Date(manifest.expiresAt).getTime();
    if (!Number.isNaN(expires) && now >= expires) {
      return { expired: true, expiresAt: manifest.expiresAt, reason: "manifest_expired" };
    }
  }
  return { expired: false, expiresAt: manifest?.expiresAt || null };
}

export function verifyReleaseManifestExpiry(manifest, options = {}) {
  const check = isManifestExpired(manifest, options.currentTime || new Date());
  if (check.expired) {
    return { valid: false, reason: "manifest_expired", expiresAt: check.expiresAt };
  }
  return { valid: true };
}

export function signReleasePayload(payload, key) {
  if (!key?.privateKey) {
    throw new Error("Release signing requires an externally provisioned private key.");
  }
  const canonical = canonicalJson(payload);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), key.privateKey);
  return Object.freeze({
    keyId: key.keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    publicKeyPem: key.publicKeyPem,
    publicKeyHex: key.publicKeyHex,
    publicKeyFingerprintSha256: key.publicKeyFingerprintSha256,
    signatureHex: signature.toString("hex"),
  });
}

export function verifyReleasePayloadSignature(payload, signature, trustedKeys, options = {}) {
  if (!signature || signature.algorithm !== RELEASE_SIGNING_ALGORITHM) {
    return { valid: false, reason: "unsupported_or_missing_signature" };
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(signature.keyId)) {
    return { valid: false, reason: "revoked_key" };
  }
  const trusted = trustedKeys?.[signature.keyId];
  if (!trusted) {
    return { valid: false, reason: "unknown_key" };
  }
  if (
    (signature.publicKeyHex && signature.publicKeyHex !== trusted.publicKeyHex) ||
    (signature.publicKeyFingerprintSha256 &&
      signature.publicKeyFingerprintSha256 !== trusted.publicKeyFingerprintSha256)
  ) {
    return { valid: false, reason: "embedded_key_mismatch" };
  }
  if (payload?.expiresAt) {
    const expiryCheck = isManifestExpired(payload, options.currentTime);
    if (expiryCheck.expired) {
      return { valid: false, reason: "manifest_expired" };
    }
  }
  try {
    const publicKey = crypto.createPublicKey(trusted.publicKeyPem);
    const valid = crypto.verify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      publicKey,
      Buffer.from(signature.signatureHex || signature.signature || "", "hex"),
    );
    return { valid, reason: valid ? undefined : "signature_mismatch" };
  } catch {
    return { valid: false, reason: "signature_verification_error" };
  }
}

export function createSignedFreezeNotice(params, key) {
  if (!key?.privateKey) {
    throw new Error("Signing a freeze notice requires a valid signing key.");
  }
  const payload = {
    schemaVersion: "1.0.0",
    type: "RELEASE_FREEZE",
    incidentId: params.incidentId || `INC-FREEZE-${Date.now()}`,
    targetVersion: params.targetVersion,
    targetReleaseTag: params.targetReleaseTag || `v${params.targetVersion}`,
    targetCommitSha: params.targetCommitSha || "",
    targetManifestSha256: params.targetManifestSha256 || null,
    action: "FREEZE_AND_DEPRECATE",
    reason: params.reason || "Post-promotion smoke verification failure or incident response.",
    failureEvidence: params.failureEvidence || null,
    rollbackTargetVersion: params.rollbackTargetVersion || "0.1.0",
    deprecationNotice:
      params.deprecationNotice ||
      `Release v${params.targetVersion} is frozen and deprecated. Do not install or deploy.`,
    rebuildAllowed: false,
    createdAt: params.createdAt || new Date().toISOString(),
  };
  const signature = signReleasePayload(payload, key);
  return Object.freeze({
    ...payload,
    signatures: [signature],
  });
}

export function verifySignedFreezeNotice(notice, trustedKeys) {
  if (
    !notice ||
    notice.type !== "RELEASE_FREEZE" ||
    !Array.isArray(notice.signatures) ||
    notice.signatures.length === 0
  ) {
    return { valid: false, reason: "invalid_freeze_notice_format" };
  }
  const { signatures, ...payload } = notice;
  return verifyReleasePayloadSignature(payload, signatures[0], trustedKeys);
}

export function createSignedRollbackPlan(params, key) {
  if (!key?.privateKey) {
    throw new Error("Signing a rollback plan requires a valid signing key.");
  }
  const payload = {
    schemaVersion: "1.0.0",
    type: "RELEASE_ROLLBACK",
    incidentId: params.incidentId || `INC-ROLLBACK-${Date.now()}`,
    failedVersion: params.failedVersion,
    targetRollbackVersion: params.targetRollbackVersion || "0.1.0",
    targetRollbackDigest: params.targetRollbackDigest || null,
    channelsToUpdate: params.channelsToUpdate || ["stable", "latest"],
    action: "RESTORE_PRIOR_IMMUTABLE_DIGEST",
    reason: params.reason || "Automatic rollback to prior immutable qualified release.",
    rebuildAllowed: false,
    createdAt: params.createdAt || new Date().toISOString(),
  };
  const signature = signReleasePayload(payload, key);
  return Object.freeze({
    ...payload,
    signatures: [signature],
  });
}

export function verifySignedRollbackPlan(plan, trustedKeys) {
  if (
    !plan ||
    plan.type !== "RELEASE_ROLLBACK" ||
    !Array.isArray(plan.signatures) ||
    plan.signatures.length === 0
  ) {
    return { valid: false, reason: "invalid_rollback_plan_format" };
  }
  const { signatures, ...payload } = plan;
  return verifyReleasePayloadSignature(payload, signatures[0], trustedKeys);
}

export function createSignedRevocationNotice(params, key) {
  if (!key?.privateKey) {
    throw new Error("Signing a revocation notice requires a valid signing key.");
  }
  const payload = {
    schemaVersion: "1.0.0",
    type: "KEY_REVOCATION",
    keyId: params.keyId,
    reason: params.reason || "Key compromised or rotated.",
    revokedAt: params.revokedAt || new Date().toISOString(),
    supersededByKeyId: params.supersededByKeyId || null,
  };
  const signature = signReleasePayload(payload, key);
  return Object.freeze({
    ...payload,
    signatures: [signature],
  });
}

export function verifySignedRevocationNotice(notice, trustedKeys) {
  if (
    !notice ||
    notice.type !== "KEY_REVOCATION" ||
    !Array.isArray(notice.signatures) ||
    notice.signatures.length === 0
  ) {
    return { valid: false, reason: "invalid_revocation_notice_format" };
  }
  const { signatures, ...payload } = notice;
  return verifyReleasePayloadSignature(payload, signatures[0], trustedKeys);
}

export function canonicalJson(value) {
  if (value === null || Object.prototype.toString.call(value) !== "[object Object]") {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    return JSON.stringify(value);
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}
