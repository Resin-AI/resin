import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type V1ActivationCertificate,
  type V1RevocationMetadata,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
} from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GeneratedKeyPair,
  InMemoryKeyStore,
  generateBundleKeyPair,
} from "../src/bundle/signature.js";
import {
  type ExpectedToolBinding,
  RuntimeTrustStore,
  type TrustIdentity,
  TrustStoreCorruptStateError,
  TrustStoreSecurityError,
  TrustStoreVerificationError,
  signActivationCertificate,
  signRevocationMetadata,
} from "../src/trust/store.js";

describe("RuntimeTrustStore", () => {
  let tempDir: string;
  let keyStore: InMemoryKeyStore;
  let rootKeyPair: GeneratedKeyPair;
  const SAMPLE_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const SAMPLE_USER_ID = "22222222-2222-4222-8222-222222222222";
  const SAMPLE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
  const SAMPLE_DEVICE_ID = "44444444-4444-4444-8444-444444444444";
  const SAMPLE_TOOL_ID = "55555555-5555-4555-8555-555555555555";
  const SAMPLE_CERT_ID = "66666666-6666-4666-8666-666666666666";
  const SAMPLE_REVOCATION_ID = "77777777-7777-4777-8777-777777777777";

  const defaultIdentity: TrustIdentity = {
    accountId: SAMPLE_ACCOUNT_ID,
    userId: SAMPLE_USER_ID,
    projectId: SAMPLE_PROJECT_ID,
    deviceId: SAMPLE_DEVICE_ID,
  };

  const defaultTool: ExpectedToolBinding = {
    toolId: SAMPLE_TOOL_ID,
    toolName: "web-search-helper",
    version: "1.0.0",
    manifestDigest: "a".repeat(64),
    artifactDigest: "b".repeat(64),
    capabilityEnvelopeDigest: "c".repeat(64),
    qualificationEvidenceDigest: "d".repeat(64),
  };

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "trust-store-test-"));
    rootKeyPair = generateBundleKeyPair("ed25519", "root-trust-key-01");
    keyStore = new InMemoryKeyStore([
      {
        keyId: rootKeyPair.keyId,
        algorithm: "ed25519",
        publicKeyPem: rootKeyPair.publicKeyPem,
        trustLevel: "production",
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function createValidCertificate(
    overrides: Partial<V1ActivationCertificate> = {},
  ): V1ActivationCertificate {
    const now = new Date("2026-08-25T10:00:00.000Z");
    const issuedAt = now.toISOString();
    const notBefore = new Date(now.getTime() - 60_000).toISOString();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const unsigned: Omit<V1ActivationCertificate, "signature"> = {
      schemaKind: V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
      schemaVersion: V1_SCHEMA_VERSION,
      certificateId: SAMPLE_CERT_ID,
      subject: {
        accountId: SAMPLE_ACCOUNT_ID,
        userId: SAMPLE_USER_ID,
        deviceId: SAMPLE_DEVICE_ID,
      },
      projectId: SAMPLE_PROJECT_ID,
      toolId: SAMPLE_TOOL_ID,
      toolName: "web-search-helper",
      version: "1.0.0",
      manifestDigest: "a".repeat(64),
      artifactDigest: "b".repeat(64),
      capabilityEnvelopeDigest: "c".repeat(64),
      qualificationEvidenceDigest: "d".repeat(64),
      counter: 1,
      nonce: "secure-random-nonce-12345",
      issuedAt,
      notBefore,
      expiresAt,
      status: "active",
      ...overrides,
    };

    return signActivationCertificate(unsigned, {
      keyId: rootKeyPair.keyId,
      privateKeyPem: rootKeyPair.privateKeyPem,
      algorithm: "ed25519",
    });
  }

  function createValidRevocationMetadata(
    overrides: Partial<V1RevocationMetadata> = {},
  ): V1RevocationMetadata {
    const now = new Date("2026-08-25T10:00:00.000Z");
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const unsigned: Omit<V1RevocationMetadata, "signature"> = {
      schemaKind: V1_SCHEMA_KINDS.REVOCATION_METADATA,
      schemaVersion: V1_SCHEMA_VERSION,
      revocationListId: SAMPLE_REVOCATION_ID,
      authorityId: "resin-root-authority",
      accountId: SAMPLE_ACCOUNT_ID,
      sequenceNumber: 1,
      issuedAt,
      expiresAt,
      revokedTools: [],
      revokedCertificates: [],
      revokedKeys: [],
      ...overrides,
    };

    return signRevocationMetadata(unsigned, {
      keyId: rootKeyPair.keyId,
      privateKeyPem: rootKeyPair.privateKeyPem,
      algorithm: "ed25519",
    });
  }

  // --------------------------------------------------------------------------
  // Online Install & Offline Reload
  // --------------------------------------------------------------------------

  it("successfully installs certificate online and reloads/verifies offline", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const cert = createValidCertificate();
    await store.recordActivationCertificate(defaultIdentity, cert);

    // Verify stored certificate
    const loaded = await store.getActivationCertificate(
      defaultIdentity,
      defaultTool.toolId,
      defaultTool.version,
    );
    expect(loaded).toBeDefined();
    expect(loaded?.certificateId).toBe(cert.certificateId);
    expect(loaded?.toolId).toBe(defaultTool.toolId);

    // Verify tool trust
    const trustResult = await store.verifyToolTrust(defaultIdentity, defaultTool);
    expect(trustResult.trusted).toBe(true);
    expect(trustResult.certificate?.certificateId).toBe(cert.certificateId);

    // Assert tool trust returns valid cert
    const assertedCert = await store.assertToolTrust(defaultIdentity, defaultTool);
    expect(assertedCert.certificateId).toBe(cert.certificateId);

    // List activation certificates
    const allCerts = await store.listActivationCertificates(defaultIdentity);
    expect(allCerts).toHaveLength(1);
    expect(allCerts[0].certificateId).toBe(cert.certificateId);
  });

  // --------------------------------------------------------------------------
  // Expiry
  // --------------------------------------------------------------------------

  it("rejects expired certificates during recording and offline verification", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    // Create cert expired yesterday
    const expiredCert = createValidCertificate({
      issuedAt: "2026-08-20T00:00:00.000Z",
      notBefore: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-24T00:00:00.000Z",
    });

    await expect(store.recordActivationCertificate(defaultIdentity, expiredCert)).rejects.toThrow(
      /expired/i,
    );

    // Record valid cert, then advance time past expiry
    const validCert = createValidCertificate({
      issuedAt: "2026-08-25T09:00:00.000Z",
      notBefore: "2026-08-25T09:00:00.000Z",
      expiresAt: "2026-08-25T11:00:00.000Z",
    });
    await store.recordActivationCertificate(defaultIdentity, validCert);

    // Verify with time in future past expiration
    const verifyFuture = await store.verifyToolTrust(defaultIdentity, defaultTool, {
      now: new Date("2026-08-25T12:00:00.000Z"),
    });
    expect(verifyFuture.trusted).toBe(false);
    expect(verifyFuture.errorCode).toBe("EXPIRED_CERTIFICATE");
  });

  // --------------------------------------------------------------------------
  // Clock Rollback Detection
  // --------------------------------------------------------------------------

  it("detects clock rollback and fails closed", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      clockToleranceMs: 5000,
    });

    const cert = createValidCertificate({
      issuedAt: "2026-08-25T10:00:00.000Z",
      notBefore: "2026-08-25T10:00:00.000Z",
      expiresAt: "2026-08-27T10:00:00.000Z",
    });

    // Record at 12:00, advancing high-water wall time to 12:00
    await store.recordActivationCertificate(defaultIdentity, cert);

    // System clock rolled back to 10:00
    const rollbackResult = await store.verifyToolTrust(defaultIdentity, defaultTool, {
      now: new Date("2026-08-25T10:00:00.000Z"),
    });
    expect(rollbackResult.trusted).toBe(false);
    expect(rollbackResult.errorCode).toBe("CLOCK_ROLLBACK");

    // Attempting to record revocation during clock rollback also throws
    const revMetadata = createValidRevocationMetadata({
      issuedAt: "2026-08-25T09:00:00.000Z",
      expiresAt: "2026-08-28T09:00:00.000Z",
    });
    await expect(
      store.recordRevocationMetadata(defaultIdentity, revMetadata, {
        now: new Date("2026-08-25T10:00:00.000Z"),
      }),
    ).rejects.toThrow(/clock rollback/i);
  });

  // --------------------------------------------------------------------------
  // Anti-Rollback Counters & Nonce Replay
  // --------------------------------------------------------------------------

  it("blocks certificate counter rollback and nonce replay", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    // Install cert with counter = 5
    const certV1 = createValidCertificate({
      counter: 5,
      nonce: "initial-nonce-1111",
      certificateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await store.recordActivationCertificate(defaultIdentity, certV1);

    // Attempt to downgrade with counter = 4 -> counter rollback rejected
    const certDowngrade = createValidCertificate({
      counter: 4,
      nonce: "new-nonce-2222",
      certificateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await expect(store.recordActivationCertificate(defaultIdentity, certDowngrade)).rejects.toThrow(
      /counter rollback/i,
    );

    // Attempt to replay same nonce for a different certificateId -> nonce replay rejected
    const certNonceReplay = createValidCertificate({
      counter: 6,
      nonce: "initial-nonce-1111", // reused
      certificateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    await expect(
      store.recordActivationCertificate(defaultIdentity, certNonceReplay),
    ).rejects.toThrow(/nonce replay/i);
  });

  // --------------------------------------------------------------------------
  // Revocation Metadata & Freshness & Replay
  // --------------------------------------------------------------------------

  it("enforces signed revocation lists and rejects sequence rollbacks", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      maxOfflineLeaseMs: 7 * 24 * 60 * 60 * 1000,
    });

    // Record revocation sequence = 10
    const rev10 = createValidRevocationMetadata({
      sequenceNumber: 10,
    });
    await store.recordRevocationMetadata(defaultIdentity, rev10);

    // Replay stale revocation sequence = 9 -> rejected
    const revStale = createValidRevocationMetadata({
      sequenceNumber: 9,
    });
    await expect(store.recordRevocationMetadata(defaultIdentity, revStale)).rejects.toThrow(
      /sequence/i,
    );
  });

  // --------------------------------------------------------------------------
  // Revoked Tool, Key, and Certificate
  // --------------------------------------------------------------------------

  it("fails closed when tool, key, or certificate is revoked", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const cert = createValidCertificate();
    await store.recordActivationCertificate(defaultIdentity, cert);

    // 1. Revoke Certificate ID
    const revCert = createValidRevocationMetadata({
      sequenceNumber: 1,
      revokedCertificates: [
        {
          certificateId: cert.certificateId,
          revokedAt: new Date("2026-08-25T10:05:00.000Z").toISOString(),
          reason: "Security audit invalidation",
        },
      ],
    });
    await store.recordRevocationMetadata(defaultIdentity, revCert);

    const trustAfterCertRevoke = await store.verifyToolTrust(defaultIdentity, defaultTool);
    expect(trustAfterCertRevoke.trusted).toBe(false);
    expect(trustAfterCertRevoke.errorCode).toBe("REVOKED_CERTIFICATE");

    // 2. Revoke Tool ID
    const revTool = createValidRevocationMetadata({
      sequenceNumber: 2,
      revokedTools: [
        {
          toolId: defaultTool.toolId,
          version: defaultTool.version,
          revokedAt: new Date("2026-08-25T10:10:00.000Z").toISOString(),
          reason: "Critical vulnerability",
        },
      ],
    });
    await store.recordRevocationMetadata(defaultIdentity, revTool);

    const trustAfterToolRevoke = await store.verifyToolTrust(defaultIdentity, defaultTool);
    expect(trustAfterToolRevoke.trusted).toBe(false);
    expect(trustAfterToolRevoke.errorCode).toBe("REVOKED_TOOL");

    // 3. Revoke Signing Key
    const revKey = createValidRevocationMetadata({
      sequenceNumber: 3,
      revokedKeys: [rootKeyPair.keyId],
    });
    await store.recordRevocationMetadata(defaultIdentity, revKey);

    const trustAfterKeyRevoke = await store.verifyToolTrust(defaultIdentity, defaultTool);
    expect(trustAfterKeyRevoke.trusted).toBe(false);
    expect(trustAfterKeyRevoke.errorCode).toBe("REVOKED_KEY");
  });

  // --------------------------------------------------------------------------
  // Tuple, Digest & Capability Mismatch
  // --------------------------------------------------------------------------

  it("rejects mismatched tool tuple, version, digests, and capabilities", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const cert = createValidCertificate();
    await store.recordActivationCertificate(defaultIdentity, cert);

    // Mismatched version
    const resVersion = await store.verifyToolTrust(defaultIdentity, {
      ...defaultTool,
      version: "2.0.0",
    });
    expect(resVersion.trusted).toBe(false);

    // Mismatched manifest digest
    const resManifest = await store.verifyToolTrust(defaultIdentity, {
      ...defaultTool,
      manifestDigest: "9".repeat(64),
    });
    expect(resManifest.trusted).toBe(false);
    expect(resManifest.errorCode).toBe("MANIFEST_DIGEST_MISMATCH");

    // Mismatched artifact digest
    const resArtifact = await store.verifyToolTrust(defaultIdentity, {
      ...defaultTool,
      artifactDigest: "8".repeat(64),
    });
    expect(resArtifact.trusted).toBe(false);
    expect(resArtifact.errorCode).toBe("ARTIFACT_DIGEST_MISMATCH");

    // Mismatched capability envelope
    const resCapability = await store.verifyToolTrust(defaultIdentity, {
      ...defaultTool,
      capabilityEnvelopeDigest: "7".repeat(64),
    });
    expect(resCapability.trusted).toBe(false);
    expect(resCapability.errorCode).toBe("CAPABILITY_ENVELOPE_MISMATCH");

    // Mismatched qualification evidence
    const resEvidence = await store.verifyToolTrust(defaultIdentity, {
      ...defaultTool,
      qualificationEvidenceDigest: "6".repeat(64),
    });
    expect(resEvidence.trusted).toBe(false);
    expect(resEvidence.errorCode).toBe("QUALIFICATION_EVIDENCE_MISMATCH");
  });

  // --------------------------------------------------------------------------
  // Identity Switch & Partition Isolation
  // --------------------------------------------------------------------------

  it("strictly isolates partitions and prevents authorization reuse across accounts/users/projects", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const cert = createValidCertificate();
    await store.recordActivationCertificate(defaultIdentity, cert);

    // Different account
    const otherAccount: TrustIdentity = {
      ...defaultIdentity,
      accountId: "99999999-9999-4999-8999-999999999999",
    };
    const resAccount = await store.verifyToolTrust(otherAccount, defaultTool);
    expect(resAccount.trusted).toBe(false);
    expect(resAccount.errorCode).toBe("MISSING_CERTIFICATE");

    // Different user
    const otherUser: TrustIdentity = {
      ...defaultIdentity,
      userId: "88888888-8888-4888-8888-888888888888",
    };
    const resUser = await store.verifyToolTrust(otherUser, defaultTool);
    expect(resUser.trusted).toBe(false);
    expect(resUser.errorCode).toBe("MISSING_CERTIFICATE");

    // Different project
    const otherProject: TrustIdentity = {
      ...defaultIdentity,
      projectId: "77777777-7777-4777-8777-777777777777",
    };
    const resProject = await store.verifyToolTrust(otherProject, defaultTool);
    expect(resProject.trusted).toBe(false);
    expect(resProject.errorCode).toBe("MISSING_CERTIFICATE");

    // Recording cert with mismatched subject account fails security check
    await expect(store.recordActivationCertificate(otherAccount, cert)).rejects.toThrow(
      TrustStoreSecurityError,
    );
  });

  // --------------------------------------------------------------------------
  // Filesystem Permissions (0700 directories, 0600 files)
  // --------------------------------------------------------------------------

  it("enforces 0700 permissions on directories and 0600 on files", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const cert = createValidCertificate();
    await store.recordActivationCertificate(defaultIdentity, cert);

    const partitionDir = store.getPartitionDir(defaultIdentity);
    const certsDir = store.getCertificatesDir(defaultIdentity);
    const stateFile = store.getStateFilePath(defaultIdentity);
    const certFile = store.getCertificateFilePath(
      defaultIdentity,
      defaultTool.toolId,
      defaultTool.version,
    );

    const partitionStat = await fs.promises.stat(partitionDir);
    const certsDirStat = await fs.promises.stat(certsDir);
    const stateStat = await fs.promises.stat(stateFile);
    const certStat = await fs.promises.stat(certFile);

    // In POSIX systems, check lower 9 permission bits
    if (process.platform !== "win32") {
      expect(partitionStat.mode & 0o777).toBe(0o700);
      expect(certsDirStat.mode & 0o777).toBe(0o700);
      expect(stateStat.mode & 0o777).toBe(0o600);
      expect(certStat.mode & 0o777).toBe(0o600);
    }
  });

  // --------------------------------------------------------------------------
  // Corrupt / Partial State & Fail-Closed
  // --------------------------------------------------------------------------

  it("fails closed on corrupt state, invalid JSON, or partial writes", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const cert = createValidCertificate();
    await store.recordActivationCertificate(defaultIdentity, cert);

    // Corrupt certificate file
    const certFile = store.getCertificateFilePath(
      defaultIdentity,
      defaultTool.toolId,
      defaultTool.version,
    );
    await fs.promises.writeFile(certFile, "{ invalid json corrupt content");

    await expect(
      store.getActivationCertificate(defaultIdentity, defaultTool.toolId, defaultTool.version),
    ).rejects.toThrow(TrustStoreCorruptStateError);

    // Corrupt state file
    const stateFile = store.getStateFilePath(defaultIdentity);
    await fs.promises.writeFile(stateFile, "");

    await expect(store.getHighWaterState(defaultIdentity)).rejects.toThrow(
      TrustStoreCorruptStateError,
    );
  });

  // --------------------------------------------------------------------------
  // Atomic Failure Preservation
  // --------------------------------------------------------------------------

  it("preserves previous state on atomic write failure and leaves no temporary files", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });

    const certV1 = createValidCertificate({ counter: 1 });
    await store.recordActivationCertificate(defaultIdentity, certV1);

    // Initial cert is intact
    const loadedBefore = await store.getActivationCertificate(defaultIdentity, defaultTool.toolId);
    expect(loadedBefore?.certificateId).toBe(certV1.certificateId);

    // Attempt invalid write (counter rollback)
    const certInvalid = createValidCertificate({ counter: 0 });
    await expect(store.recordActivationCertificate(defaultIdentity, certInvalid)).rejects.toThrow(
      TrustStoreVerificationError,
    );

    // Check that original certificate is unchanged
    const loadedAfter = await store.getActivationCertificate(defaultIdentity, defaultTool.toolId);
    expect(loadedAfter?.certificateId).toBe(certV1.certificateId);

    // Verify no temporary files remain in directory
    const certsDir = store.getCertificatesDir(defaultIdentity);
    const files = await fs.promises.readdir(certsDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Path Traversal and Security Sanitization
  // --------------------------------------------------------------------------

  it("rejects path traversal attempts and invalid UUIDs in identity parameters", async () => {
    const store = new RuntimeTrustStore({
      dataDir: tempDir,
      keyStore,
    });

    const maliciousIdentity: TrustIdentity = {
      accountId: "../../../etc",
      userId: SAMPLE_USER_ID,
      projectId: SAMPLE_PROJECT_ID,
    };

    expect(() => store.getPartitionDir(maliciousIdentity)).toThrow(TrustStoreSecurityError);

    const nullByteIdentity: TrustIdentity = {
      accountId: `${SAMPLE_ACCOUNT_ID}\0evil`,
      userId: SAMPLE_USER_ID,
      projectId: SAMPLE_PROJECT_ID,
    };

    expect(() => store.getPartitionDir(nullByteIdentity)).toThrow(TrustStoreSecurityError);
  });
});
