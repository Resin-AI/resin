import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ChannelMetadata,
  type ManifestAsset,
  REVOKED_RELEASE_KEY_IDS,
  type SignedManifest,
  type TrustedReleaseKey,
  canonicalJson,
  compareSemver,
  isVersionAtLeast,
  isVersionRevoked,
  selectPlatformAsset,
  verifyChannelMetadata,
  verifyEd25519Signature,
  verifyManifest,
} from "../../src/installer/channel-verifier.js";

// Test-only key material is generated at runtime and is never a production trust root.
const generatedTestKeyPair = crypto.generateKeyPairSync("ed25519");
const TEST_KEYPAIR = {
  keyId: "test-only-runtime-key",
  publicKeyHex: generatedTestKeyPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex"),
  privateKeyPkcs8Pem: generatedTestKeyPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};
const TRUSTED_TEST_KEY: TrustedReleaseKey = {
  keyId: TEST_KEYPAIR.keyId,
  publicKeyHex: TEST_KEYPAIR.publicKeyHex,
};

function signPayload(payload: unknown, privateKeyPem = TEST_KEYPAIR.privateKeyPkcs8Pem): string {
  const canonical = canonicalJson(payload);
  const dataBuf = Buffer.from(canonical, "utf8");
  const privKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, dataBuf, privKey).toString("hex");
}

describe("signed-channel-verifier: Release channel metadata & cryptographic integrity", () => {
  describe("Ed25519 signature verification", () => {
    it("verifies valid signatures over canonical JSON payloads", () => {
      const payload = {
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        channel: "stable",
      };

      const signatureHex = signPayload(payload);
      const valid = verifyEd25519Signature(payload, signatureHex, TEST_KEYPAIR.publicKeyHex);
      expect(valid).toBe(true);
    });

    it("rejects tampered payloads with signature verification failure", () => {
      const payload = {
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        channel: "stable",
      };

      const signatureHex = signPayload(payload);

      // Tampered payload
      const tamperedPayload = {
        version: "1.0.1-malicious",
        releaseDate: "2026-08-17T00:00:00.000Z",
        channel: "stable",
      };

      const valid = verifyEd25519Signature(
        tamperedPayload,
        signatureHex,
        TEST_KEYPAIR.publicKeyHex,
      );
      expect(valid).toBe(false);
    });

    it("rejects corrupted or malformed signature hex strings", () => {
      const payload = { foo: "bar" };
      const valid = verifyEd25519Signature(
        payload,
        "invalid_hex_signature",
        TEST_KEYPAIR.publicKeyHex,
      );
      expect(valid).toBe(false);
    });
  });

  describe("SemVer comparison and policy enforcement", () => {
    it("compares semver strings correctly", () => {
      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("1.1.0", "1.0.0")).toBe(1);
      expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
      expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
      expect(compareSemver("1.0.0", "1.0.0-alpha.1")).toBe(1);
      expect(compareSemver("1.0.0-alpha.1", "1.0.0")).toBe(-1);
    });

    it("enforces minimum supported version constraints", () => {
      expect(isVersionAtLeast("1.0.0", "0.1.0")).toBe(true);
      expect(isVersionAtLeast("0.1.0", "0.1.0")).toBe(true);
      expect(isVersionAtLeast("0.0.9", "0.1.0")).toBe(false);
    });

    it("checks revocation lists accurately", () => {
      const revoked = ["0.0.9", "v1.0.0-rc.1", "0.1.0-compromised"];
      expect(isVersionRevoked("0.0.9", revoked)).toBe(true);
      expect(isVersionRevoked("v0.0.9", revoked)).toBe(true);
      expect(isVersionRevoked("1.0.0-rc.1", revoked)).toBe(true);
      expect(isVersionRevoked("1.0.0", revoked)).toBe(false);
      expect(isVersionRevoked("1.0.0", undefined)).toBe(false);
    });
  });

  describe("Channel metadata verification", () => {
    it("verifies valid channel metadata and extracts channel details", () => {
      const metadataPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        minSupportedVersion: "0.1.0",
        currentVersion: "1.0.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
            manifestUrl: "https://dist.resin.sh/releases/v1/manifest.json",
            manifestDigest: "abc123def456",
            isLatest: true,
          },
          prerelease: {
            version: "1.1.0-alpha.1",
            releaseDate: "2026-08-17T00:00:00.000Z",
            minSupportedVersion: "1.0.0",
            isLatest: false,
          },
        },
        rollbackReferences: {
          targetVersion: "0.1.0",
          minSafeVersion: "0.1.0",
          rollbackTarball: "resin-v0.1.0-rollback.tar.gz",
          rollbackSha256: "fedcba987654",
        },
        revokedVersions: ["0.0.8", "0.0.9"],
      };

      const signature = signPayload(metadataPayload);
      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: signature,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedReleaseKeys: [TRUSTED_TEST_KEY],
      });

      expect(result.valid).toBe(true);
      expect(result.channel).toBe("stable");
      expect(result.targetVersion).toBe("1.0.0");
      expect(result.manifestDigest).toBe("abc123def456");
      expect(result.rollbackReference?.targetVersion).toBe("0.1.0");
      expect(result.errors).toHaveLength(0);
      expect(result.signingKeyIds).toEqual([TEST_KEYPAIR.keyId]);
    });

    it("rejects revoked versions in channel metadata", () => {
      const channelData: ChannelMetadata = {
        schemaVersion: "1.0.0",
        currentVersion: "0.0.9",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "0.0.9",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
        revokedVersions: ["0.0.9"],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("revoked"))).toBe(true);
    });

    it("rejects versions below minimum supported version", () => {
      const channelData: ChannelMetadata = {
        schemaVersion: "1.0.0",
        minSupportedVersion: "1.0.0",
        currentVersion: "0.9.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "0.9.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("minimum supported version"))).toBe(true);
    });

    it("rejects channel metadata signature when an untrusted key claims a trusted keyId (key-ID spoofing)", () => {
      const untrustedPair = crypto.generateKeyPairSync("ed25519");
      const metadataPayload = {
        schemaVersion: "1.0.0",
        currentVersion: "1.0.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };
      const untrustedCanonical = canonicalJson(metadataPayload);
      const untrustedSig = crypto
        .sign(null, Buffer.from(untrustedCanonical, "utf8"), untrustedPair.privateKey)
        .toString("hex");

      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: untrustedSig,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedReleaseKeys: [TRUSTED_TEST_KEY],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects channel metadata signature when signature publicKeyHex does not match trusted key root", () => {
      const untrustedPair = crypto.generateKeyPairSync("ed25519");
      const untrustedHex = untrustedPair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");
      const metadataPayload = {
        schemaVersion: "1.0.0",
        currentVersion: "1.0.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };
      const untrustedCanonical = canonicalJson(metadataPayload);
      const untrustedSig = crypto
        .sign(null, Buffer.from(untrustedCanonical, "utf8"), untrustedPair.privateKey)
        .toString("hex");

      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: untrustedHex,
            signatureHex: untrustedSig,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedReleaseKeys: [TRUSTED_TEST_KEY],
      });
      expect(result.valid).toBe(false);
    });

    it("rejects channel metadata signed by permanently revoked key ID", () => {
      const metadataPayload = {
        schemaVersion: "1.0.0",
        currentVersion: "1.0.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };
      const sig = signPayload(metadataPayload);
      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: REVOKED_RELEASE_KEY_IDS[0] || "resin-release-v1",
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: sig,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedReleaseKeys: [
          {
            keyId: REVOKED_RELEASE_KEY_IDS[0] || "resin-release-v1",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
          },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("revoked"))).toBe(true);
    });

    it("extracts verified revokedKeyIds from valid channel metadata", () => {
      const metadataPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        revokedKeyIds: ["resin-release-root-2026a"],
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };
      const sig = signPayload(metadataPayload);
      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: sig,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedReleaseKeys: [TRUSTED_TEST_KEY],
      });
      expect(result.valid).toBe(true);
      expect(result.revokedKeyIds).toEqual(["resin-release-root-2026a"]);
      expect(result.signingKeyIds).toEqual([TEST_KEYPAIR.keyId]);
    });

    it("preserves active-first order for numeric key IDs during channel verification", () => {
      const key10Pair = crypto.generateKeyPairSync("ed25519");
      const key2Pair = crypto.generateKeyPairSync("ed25519");
      const key10Hex = key10Pair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");
      const key2Hex = key2Pair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");

      const key10: TrustedReleaseKey = { keyId: "10", publicKeyHex: key10Hex };
      const key2: TrustedReleaseKey = { keyId: "2", publicKeyHex: key2Hex };

      const metadataPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };
      const sig10 = crypto
        .sign(null, Buffer.from(canonicalJson(metadataPayload), "utf8"), key10Pair.privateKey)
        .toString("hex");

      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: "10",
            algorithm: "Ed25519",
            publicKeyHex: key10Hex,
            signatureHex: sig10,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedReleaseKeys: [key10, key2],
      });
      expect(result.valid).toBe(true);
      expect(result.signingKeyIds).toEqual(["10"]);
    });
  });

  describe("Signed manifest verification", () => {
    it("verifies signed release manifest and checks SHA-256 digest", () => {
      const manifest: SignedManifest = {
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        schemaVersion: "2.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        assets: {
          "linux-x64": {
            filename: "resin-v1.0.0-linux-x64.tar.gz",
            platform: "linux",
            arch: "x64",
            isWsl: false,
            sizeBytes: 1048576,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            path: "dist/release/v1.0.0/resin-v1.0.0-linux-x64.tar.gz",
          },
        },
      };

      const rawCanonical = canonicalJson(manifest);
      const expectedDigest = crypto.createHash("sha256").update(rawCanonical).digest("hex");

      const result = verifyManifest(manifest, {
        expectedDigest,
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(true);
      expect(result.version).toBe("1.0.0");
      expect(result.assets["linux-x64"]).toBeDefined();
    });

    it("rejects manifest with digest mismatch", () => {
      const manifest: SignedManifest = {
        schemaVersion: "1.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        assets: {},
      };

      const result = verifyManifest(manifest, {
        expectedDigest: "tampered_digest_value_12345",
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("digest mismatch"))).toBe(true);
    });

    it("verifies signed release manifest with trustedReleaseKeys and records signingKeyIds", () => {
      const manifestPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        assets: {
          "linux-x64": {
            filename: "resin-v1.0.0-linux-x64.tar.gz",
            platform: "linux",
            arch: "x64",
            isWsl: false,
            sizeBytes: 1048576,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            path: "dist/release/v1.0.0/resin-v1.0.0-linux-x64.tar.gz",
          },
        },
      };

      const sig = signPayload(manifestPayload);
      const manifest: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: sig,
          },
        ],
      };

      const rawCanonical = canonicalJson(manifest);
      const expectedDigest = crypto.createHash("sha256").update(rawCanonical).digest("hex");

      const result = verifyManifest(manifest, {
        expectedDigest,
        trustedReleaseKeys: [TRUSTED_TEST_KEY],
      });

      expect(result.valid).toBe(true);
      expect(result.version).toBe("1.0.0");
      expect(result.assets["linux-x64"]).toBeDefined();
      expect(result.signingKeyIds).toEqual([TEST_KEYPAIR.keyId]);
    });

    it("rejects manifest signature when an untrusted key claims a trusted keyId (key-ID spoofing)", () => {
      const untrustedPair = crypto.generateKeyPairSync("ed25519");
      const manifestPayload = {
        schemaVersion: "2.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        packages: {},
        assets: {},
      };
      const untrustedSig = crypto
        .sign(null, Buffer.from(canonicalJson(manifestPayload), "utf8"), untrustedPair.privateKey)
        .toString("hex");

      const manifest: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: untrustedSig,
          },
        ],
      };

      const result = verifyManifest(manifest, {
        trustedReleaseKeys: [TRUSTED_TEST_KEY],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects manifest signed by rotated key A when verified channel declares key A revoked", () => {
      const keyAPair = crypto.generateKeyPairSync("ed25519");
      const keyBPair = crypto.generateKeyPairSync("ed25519");
      const keyAHex = keyAPair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");
      const keyBHex = keyBPair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");

      const keyA: TrustedReleaseKey = { keyId: "resin-release-root-2026a", publicKeyHex: keyAHex };
      const keyB: TrustedReleaseKey = { keyId: "resin-release-root-2026b", publicKeyHex: keyBHex };
      const trustedKeys = [keyB, keyA];

      const manifestPayload = {
        schemaVersion: "2.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        assets: {},
      };
      const manifestASig = crypto
        .sign(null, Buffer.from(canonicalJson(manifestPayload), "utf8"), keyAPair.privateKey)
        .toString("hex");
      const manifestBSig = crypto
        .sign(null, Buffer.from(canonicalJson(manifestPayload), "utf8"), keyBPair.privateKey)
        .toString("hex");

      const manifestSignedByA: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: keyA.keyId,
            algorithm: "Ed25519",
            publicKeyHex: keyA.publicKeyHex,
            signatureHex: manifestASig,
          },
        ],
      };

      const manifestSignedByB: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: keyB.keyId,
            algorithm: "Ed25519",
            publicKeyHex: keyB.publicKeyHex,
            signatureHex: manifestBSig,
          },
        ],
      };

      // When keyA is dynamically revoked by verified channel
      const resultA = verifyManifest(manifestSignedByA, {
        trustedReleaseKeys: trustedKeys,
        revokedKeyIds: [keyA.keyId],
      });
      expect(resultA.valid).toBe(false);
      expect(resultA.errors.some((e) => e.includes("revoked"))).toBe(true);

      // Manifest signed by active unrevoked keyB succeeds
      const resultB = verifyManifest(manifestSignedByB, {
        trustedReleaseKeys: trustedKeys,
        revokedKeyIds: [keyA.keyId],
      });
      expect(resultB.valid).toBe(true);
      expect(resultB.signingKeyIds).toEqual([keyB.keyId]);
    });

    it("rejects manifest signed by permanently revoked key ID", () => {
      const manifestPayload = {
        schemaVersion: "1.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        packages: {},
        assets: {},
      };
      const sig = signPayload(manifestPayload);
      const manifest: SignedManifest = {
        ...manifestPayload,
        signatures: [
          {
            keyId: REVOKED_RELEASE_KEY_IDS[0] || "resin-release-v1",
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: sig,
          },
        ],
      };

      const result = verifyManifest(manifest, {
        trustedReleaseKeys: [
          {
            keyId: REVOKED_RELEASE_KEY_IDS[0] || "resin-release-v1",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
          },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("revoked"))).toBe(true);
    });
  });

  describe("Exact OS/Architecture artifact selection", () => {
    const fullManifest: SignedManifest = {
      schemaVersion: "1.0.0",
      version: "1.0.0",
      releaseDate: "2026-08-17T00:00:00.000Z",
      assets: {
        "linux-x64": {
          filename: "resin-v1.0.0-linux-x64.tar.gz",
          platform: "linux",
          arch: "x64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_linux_x64",
          path: "dist/release/v1.0.0/resin-v1.0.0-linux-x64.tar.gz",
        },
        "linux-arm64": {
          filename: "resin-v1.0.0-linux-arm64.tar.gz",
          platform: "linux",
          arch: "arm64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_linux_arm64",
          path: "dist/release/v1.0.0/resin-v1.0.0-linux-arm64.tar.gz",
        },
        "darwin-x64": {
          filename: "resin-v1.0.0-darwin-x64.tar.gz",
          platform: "darwin",
          arch: "x64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_darwin_x64",
          path: "dist/release/v1.0.0/resin-v1.0.0-darwin-x64.tar.gz",
        },
        "darwin-arm64": {
          filename: "resin-v1.0.0-darwin-arm64.tar.gz",
          platform: "darwin",
          arch: "arm64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_darwin_arm64",
          path: "dist/release/v1.0.0/resin-v1.0.0-darwin-arm64.tar.gz",
        },
        "wsl-x64": {
          filename: "resin-v1.0.0-wsl-x64.tar.gz",
          platform: "wsl",
          arch: "x64",
          isWsl: true,
          sizeBytes: 1000,
          sha256: "sha_wsl_x64",
          path: "dist/release/v1.0.0/resin-v1.0.0-wsl-x64.tar.gz",
        },
      },
    };

    it("selects linux-x64 for Linux x64 host", () => {
      const asset = selectPlatformAsset(fullManifest, { os: "linux", arch: "x64", isWsl: false });
      expect(asset.filename).toBe("resin-v1.0.0-linux-x64.tar.gz");
      expect(asset.sha256).toBe("sha_linux_x64");
    });

    it("selects linux-arm64 for Linux ARM64 host", () => {
      const asset = selectPlatformAsset(fullManifest, { os: "linux", arch: "arm64", isWsl: false });
      expect(asset.filename).toBe("resin-v1.0.0-linux-arm64.tar.gz");
      expect(asset.sha256).toBe("sha_linux_arm64");
    });

    it("selects darwin-arm64 for macOS Apple Silicon host", () => {
      const asset = selectPlatformAsset(fullManifest, {
        os: "darwin",
        arch: "arm64",
        isWsl: false,
      });
      expect(asset.filename).toBe("resin-v1.0.0-darwin-arm64.tar.gz");
      expect(asset.sha256).toBe("sha_darwin_arm64");
    });

    it("selects exact wsl-x64 for WSL host when both wsl-x64 and linux-x64 exist", () => {
      const asset = selectPlatformAsset(fullManifest, { os: "wsl", arch: "x64", isWsl: true });
      expect(asset.filename).toBe("resin-v1.0.0-wsl-x64.tar.gz");
      expect(asset.sha256).toBe("sha_wsl_x64");
    });

    it("selects exact wsl-arm64 for WSL ARM64 host when explicit wsl-arm64 exists", () => {
      const manifestWithWslArm64: SignedManifest = {
        ...fullManifest,
        assets: {
          ...fullManifest.assets,
          "wsl-arm64": {
            filename: "resin-v1.0.0-wsl-arm64.tar.gz",
            platform: "wsl",
            arch: "arm64",
            isWsl: true,
            sizeBytes: 1000,
            sha256: "sha_wsl_arm64",
            path: "dist/release/v1.0.0/resin-v1.0.0-wsl-arm64.tar.gz",
          },
        },
      };
      const asset = selectPlatformAsset(manifestWithWslArm64, {
        os: "wsl",
        arch: "arm64",
        isWsl: true,
      });
      expect(asset.filename).toBe("resin-v1.0.0-wsl-arm64.tar.gz");
      expect(asset.sha256).toBe("sha_wsl_arm64");
    });

    it("falls back to architecture-matched linux-x64 for WSL x64 when no wsl-x64 asset exists", () => {
      const noWslManifest: SignedManifest = {
        ...fullManifest,
        assets: {
          "linux-x64": fullManifest.assets["linux-x64"],
          "linux-arm64": fullManifest.assets["linux-arm64"],
          "darwin-arm64": fullManifest.assets["darwin-arm64"],
        },
      };
      const asset = selectPlatformAsset(noWslManifest, { os: "wsl", arch: "x64", isWsl: true });
      expect(asset.filename).toBe("resin-v1.0.0-linux-x64.tar.gz");
      expect(asset.sha256).toBe("sha_linux_x64");
    });

    it("falls back to architecture-matched linux-arm64 for WSL ARM64 when no wsl-arm64 asset exists", () => {
      const noWslManifest: SignedManifest = {
        ...fullManifest,
        assets: {
          "linux-x64": fullManifest.assets["linux-x64"],
          "linux-arm64": fullManifest.assets["linux-arm64"],
          "darwin-arm64": fullManifest.assets["darwin-arm64"],
        },
      };
      const asset = selectPlatformAsset(noWslManifest, {
        os: "linux",
        arch: "aarch64",
        isWsl: true,
      });
      expect(asset.filename).toBe("resin-v1.0.0-linux-arm64.tar.gz");
      expect(asset.sha256).toBe("sha_linux_arm64");
    });

    it("never selects WSL asset for native Linux host even if linux asset is missing", () => {
      const wslOnlyManifest: SignedManifest = {
        ...fullManifest,
        assets: {
          "wsl-x64": fullManifest.assets["wsl-x64"],
          "linux-arm64": fullManifest.assets["linux-arm64"],
        },
      };
      expect(() => {
        selectPlatformAsset(wslOnlyManifest, { os: "linux", arch: "x64", isWsl: false });
      }).toThrow(/No compatible release asset found/);
    });

    it("fails immediately with clear error for unsupported WSL architecture", () => {
      expect(() => {
        selectPlatformAsset(fullManifest, { os: "wsl", arch: "riscv64", isWsl: true });
      }).toThrow(/Unsupported WSL architecture 'riscv64'/);

      expect(() => {
        selectPlatformAsset(fullManifest, { os: "linux", arch: "mips64", isWsl: true });
      }).toThrow(/Unsupported WSL architecture 'mips64'/);
    });

    it("throws clear error when no compatible platform asset exists", () => {
      expect(() => {
        selectPlatformAsset(fullManifest, { os: "freebsd", arch: "riscv64", isWsl: false });
      }).toThrow(/No compatible release asset found/);
    });
  });

  describe("Metadata freshness and downgrade prevention", () => {
    const validChannelPayload = {
      schemaVersion: "2.0.0",
      metadataVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      currentVersion: "1.0.0",
      updatedAt: "2026-08-25T00:00:00.000Z",
      channels: {
        stable: {
          version: "1.0.0",
          releaseDate: "2026-08-25T00:00:00.000Z",
          manifestUrl: "https://dist.resin.sh/releases/v1/manifest.json",
          manifestDigest: "abc123def456",
          isLatest: true,
        },
      },
    };

    it("rejects channel metadata missing metadataVersion", () => {
      const invalid = { ...validChannelPayload, metadataVersion: undefined };
      const sig = signPayload(invalid);
      const result = verifyChannelMetadata(
        {
          ...invalid,
          signatures: [
            {
              keyId: TEST_KEYPAIR.keyId,
              algorithm: "Ed25519",
              publicKeyHex: TEST_KEYPAIR.publicKeyHex,
              signatureHex: sig,
            },
          ],
        },
        { trustedReleaseKeys: [TRUSTED_TEST_KEY], now: "2026-08-25T12:00:00.000Z" },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("missing required 'metadataVersion'"))).toBe(
        true,
      );
    });

    it("rejects channel metadata with unsupported future metadataVersion", () => {
      const invalid = { ...validChannelPayload, metadataVersion: 2 };
      const sig = signPayload(invalid);
      const result = verifyChannelMetadata(
        {
          ...invalid,
          signatures: [
            {
              keyId: TEST_KEYPAIR.keyId,
              algorithm: "Ed25519",
              publicKeyHex: TEST_KEYPAIR.publicKeyHex,
              signatureHex: sig,
            },
          ],
        },
        { trustedReleaseKeys: [TRUSTED_TEST_KEY], now: "2026-08-25T12:00:00.000Z" },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Unsupported channel metadataVersion"))).toBe(
        true,
      );
    });
    it("rejects expired channel metadata", () => {
      const expiredPayload = {
        ...validChannelPayload,
        expiresAt: "2026-08-20T00:00:00.000Z",
      };
      const sig = signPayload(expiredPayload);
      const result = verifyChannelMetadata(
        {
          ...expiredPayload,
          signatures: [
            {
              keyId: TEST_KEYPAIR.keyId,
              algorithm: "Ed25519",
              publicKeyHex: TEST_KEYPAIR.publicKeyHex,
              signatureHex: sig,
            },
          ],
        },
        { trustedReleaseKeys: [TRUSTED_TEST_KEY], now: "2026-08-25T12:00:00.000Z" },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Channel metadata has expired"))).toBe(true);
    });
    it("rejects downgrade replay when target version is below currentInstalledVersion", () => {
      const downgradePayload = {
        ...validChannelPayload,
        currentVersion: "0.9.0",
        channels: {
          stable: {
            version: "0.9.0",
            releaseDate: "2026-08-25T00:00:00.000Z",
          },
        },
      };
      const sig = signPayload(downgradePayload);
      const result = verifyChannelMetadata(
        {
          ...downgradePayload,
          signatures: [
            {
              keyId: TEST_KEYPAIR.keyId,
              algorithm: "Ed25519",
              publicKeyHex: TEST_KEYPAIR.publicKeyHex,
              signatureHex: sig,
            },
          ],
        },
        {
          trustedReleaseKeys: [TRUSTED_TEST_KEY],
          currentInstalledVersion: "1.0.0",
          now: "2026-08-25T12:00:00.000Z",
        },
      );
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("cannot downgrade currently installed version")),
      ).toBe(true);
    });

    it("permits same-version valid refresh when target version equals currentInstalledVersion", () => {
      const sig = signPayload(validChannelPayload);
      const result = verifyChannelMetadata(
        {
          ...validChannelPayload,
          signatures: [
            {
              keyId: TEST_KEYPAIR.keyId,
              algorithm: "Ed25519",
              publicKeyHex: TEST_KEYPAIR.publicKeyHex,
              signatureHex: sig,
            },
          ],
        },
        {
          trustedReleaseKeys: [TRUSTED_TEST_KEY],
          currentInstalledVersion: "1.0.0",
          now: "2026-08-25T12:00:00.000Z",
        },
      );
      expect(result.valid).toBe(true);
    });

    it("rejects release manifest with asset exceeding 2 GiB limit", () => {
      const manifestPayload = {
        schemaVersion: "2.0.0",
        metadataVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        version: "1.0.0",
        releaseDate: "2026-08-25T00:00:00.000Z",
        assets: {
          "linux-x64": {
            filename: "resin-v1.0.0-linux-x64.tar.gz",
            platform: "linux",
            arch: "x64",
            sizeBytes: 3 * 1024 * 1024 * 1024, // 3 GiB > 2 GiB
            sha256: "a".repeat(64),
            path: "dist/release/v1.0.0/resin-v1.0.0-linux-x64.tar.gz",
          },
        },
      };
      const sig = signPayload(manifestPayload);
      const result = verifyManifest(
        {
          ...manifestPayload,
          signatures: [
            {
              keyId: TEST_KEYPAIR.keyId,
              algorithm: "Ed25519",
              publicKeyHex: TEST_KEYPAIR.publicKeyHex,
              signatureHex: sig,
            },
          ],
        },
        { trustedReleaseKeys: [TRUSTED_TEST_KEY], now: "2026-08-25T12:00:00.000Z" },
      );
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("exceeds maximum allowed release size of 2 GiB")),
      ).toBe(true);
    });
  });
});
