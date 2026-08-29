import { describe, expect, it } from "vitest";
import {
  CURRENT_V1_CONTRACTS_VERSION,
  CommittedMetadataSecurityError,
  RevocationFreshnessError,
  SchemaMigrationError,
  UnsupportedSchemaVersionError,
  V1ExactSemVerSchema,
  V1OwnerAuthorizationSchema,
  type V1RevocationMetadata,
  V1Sha256DigestSchema,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
  assertSafeCommittedMetadata,
  computeSignableHash,
  migrateV1ActivationCertificate,
  migrateV1ProjectMetadata,
  migrateV1RevocationMetadata,
  migrateV1ToolLock,
  projectSignableActivationCertificate,
  projectSignableRevocationMetadata,
  validateV1ActivationCertificate,
  validateV1ProjectMetadata,
  validateV1RevocationMetadata,
  validateV1ToolLock,
  verifyOfflineRevocationFreshness,
} from "../src/v1.js";

// Common fixtures
const SAMPLE_UUID_1 = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
const SAMPLE_UUID_2 = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const SAMPLE_UUID_3 = "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f";
const SAMPLE_UUID_4 = "d4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a";
const SAMPLE_SHA256 = "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";
const SAMPLE_SHA256_ALT = "aaaabbbbccccddddeeeeffff1111222233334444555566667777888899990000";
const SAMPLE_TIMESTAMP = "2026-08-24T12:00:00.000Z";
const SAMPLE_TIMESTAMP_FUTURE = "2026-08-31T12:00:00.000Z";
const SAMPLE_SIGNATURE = {
  signature: "dGVzdC1zaWduYXR1cmUtYnl0ZXM=",
  keyId: "key-v1-prod-01",
  algorithm: "ed25519" as const,
  signedAt: SAMPLE_TIMESTAMP,
};

describe("V1 Canonical Contracts & Schemas", () => {
  describe("Constants & Versions", () => {
    it("exports current contract version 1.0.0", () => {
      expect(CURRENT_V1_CONTRACTS_VERSION).toBe("1.0.0");
      expect(V1_SCHEMA_VERSION).toBe("1.0.0");
    });

    it("exports all defined schema kinds", () => {
      expect(V1_SCHEMA_KINDS.OWNER_AUTHORIZATION).toBe("owner_authorization");
      expect(V1_SCHEMA_KINDS.PROJECT_METADATA).toBe("project_metadata");
      expect(V1_SCHEMA_KINDS.TOOL_LOCK).toBe("tool_lock");
      expect(V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE).toBe("activation_certificate");
      expect(V1_SCHEMA_KINDS.REVOCATION_METADATA).toBe("revocation_metadata");
      expect(V1_SCHEMA_KINDS.SAVINGS_EVIDENCE).toBe("savings_evidence");
    });
  });

  describe("Exact SemVer & Normalized SHA-256 Digest Schemas", () => {
    it("accepts exact semantic version numbers", () => {
      expect(V1ExactSemVerSchema.parse("1.0.0")).toBe("1.0.0");
      expect(V1ExactSemVerSchema.parse("2.14.3")).toBe("2.14.3");
      expect(V1ExactSemVerSchema.parse("1.0.0-beta.1")).toBe("1.0.0-beta.1");
    });

    it("rejects version ranges and wildcards", () => {
      expect(() => V1ExactSemVerSchema.parse("^1.0.0")).toThrow();
      expect(() => V1ExactSemVerSchema.parse("~1.0.0")).toThrow();
      expect(() => V1ExactSemVerSchema.parse("*")).toThrow();
      expect(() => V1ExactSemVerSchema.parse(">=1.0.0")).toThrow();
      expect(() => V1ExactSemVerSchema.parse("1.x")).toThrow();
    });

    it("normalizes SHA-256 digests with or without prefix", () => {
      const rawHex = "AABBCCDD11223344AABBCCDD11223344AABBCCDD11223344AABBCCDD11223344";
      const normalized = V1Sha256DigestSchema.parse(rawHex);
      expect(normalized).toBe(rawHex.toLowerCase());

      const withPrefix = `sha256:${rawHex}`;
      const normalizedFromPrefix = V1Sha256DigestSchema.parse(withPrefix);
      expect(normalizedFromPrefix).toBe(rawHex.toLowerCase());
    });

    it("rejects malformed SHA-256 digests", () => {
      expect(() => V1Sha256DigestSchema.parse("not-a-hash")).toThrow();
      expect(() => V1Sha256DigestSchema.parse("12345")).toThrow();
      expect(() => V1Sha256DigestSchema.parse("sha256:12345")).toThrow();
    });
  });

  describe("Committed Metadata Security Restrictions", () => {
    it("permits safe metadata without paths or secrets", () => {
      const safeData = {
        name: "my-project",
        version: "1.0.0",
        tags: ["frontend", "analytics"],
        count: 42,
        active: true,
      };
      expect(() => assertSafeCommittedMetadata(safeData)).not.toThrow();
    });

    it("rejects absolute Unix paths", () => {
      const unsafe = { projectRoot: "/Users/alice/Projects/resin" };
      expect(() => assertSafeCommittedMetadata(unsafe)).toThrow(CommittedMetadataSecurityError);
    });

    it("rejects absolute Windows paths", () => {
      const unsafe = { projectRoot: "C:\\Users\\alice\\Projects\\resin" };
      expect(() => assertSafeCommittedMetadata(unsafe)).toThrow(CommittedMetadataSecurityError);
    });

    it("rejects path traversal indicators", () => {
      const unsafe = { relativeDir: "../../secret-folder" };
      expect(() => assertSafeCommittedMetadata(unsafe)).toThrow(CommittedMetadataSecurityError);
    });

    it("rejects API keys and Bearer tokens", () => {
      const unsafeKey = { config: "sk-1234567890abcdef1234567890abcdef" };
      expect(() => assertSafeCommittedMetadata(unsafeKey)).toThrow(CommittedMetadataSecurityError);

      const unsafeBearer = { auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" };
      expect(() => assertSafeCommittedMetadata(unsafeBearer)).toThrow(
        CommittedMetadataSecurityError,
      );
    });

    it("rejects private keys and certificates", () => {
      const unsafeKey = { key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA..." };
      expect(() => assertSafeCommittedMetadata(unsafeKey)).toThrow(CommittedMetadataSecurityError);
    });

    it("rejects forbidden credential field names", () => {
      const unsafeField = { password: "plaintext-password" };
      expect(() => assertSafeCommittedMetadata(unsafeField)).toThrow(
        CommittedMetadataSecurityError,
      );

      const unsafeSecret = { apiKey: "custom-api-key" };
      expect(() => assertSafeCommittedMetadata(unsafeSecret)).toThrow(
        CommittedMetadataSecurityError,
      );
    });

    it("rejects executable payloads and scripts", () => {
      const unsafeScript = { hook: "<script>alert('xss')</script>" };
      expect(() => assertSafeCommittedMetadata(unsafeScript)).toThrow(
        CommittedMetadataSecurityError,
      );

      const unsafeEval = { hook: "eval('malicious code')" };
      expect(() => assertSafeCommittedMetadata(unsafeEval)).toThrow(CommittedMetadataSecurityError);

      const unsafeShebang = { run: "#!/bin/bash\nrm -rf /" };
      expect(() => assertSafeCommittedMetadata(unsafeShebang)).toThrow(
        CommittedMetadataSecurityError,
      );
    });
  });

  describe("Area 1: Owner & Scope Authorization", () => {
    it("validates valid personal owner authorization", () => {
      const auth = {
        schemaKind: "owner_authorization",
        schemaVersion: "1.0.0",
        authorizationId: SAMPLE_UUID_1,
        subjectId: SAMPLE_UUID_2,
        subjectType: "user" as const,
        owner: {
          ownerType: "user" as const,
          ownerId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
        },
        scope: {
          scopeType: "personal" as const,
          userId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
        },
        roles: ["owner" as const],
        permissions: ["tools:execute", "tools:read"],
        issuedAt: SAMPLE_TIMESTAMP,
      };

      const parsed = V1OwnerAuthorizationSchema.parse(auth);
      expect(parsed.authorizationId).toBe(SAMPLE_UUID_1);
      expect(parsed.owner.ownerType).toBe("user");
      expect(parsed.scope.scopeType).toBe("personal");
    });

    it("validates workspace-shared authorization", () => {
      const auth = {
        schemaKind: "owner_authorization",
        schemaVersion: "1.0.0",
        authorizationId: SAMPLE_UUID_1,
        subjectId: SAMPLE_UUID_2,
        subjectType: "user" as const,
        owner: {
          ownerType: "workspace" as const,
          ownerId: SAMPLE_UUID_4,
          accountId: SAMPLE_UUID_3,
        },
        scope: {
          scopeType: "workspace" as const,
          workspaceId: SAMPLE_UUID_4,
          accountId: SAMPLE_UUID_3,
        },
        roles: ["member" as const],
        permissions: ["tools:execute"],
        issuedAt: SAMPLE_TIMESTAMP,
      };

      const parsed = V1OwnerAuthorizationSchema.parse(auth);
      expect(parsed.scope.scopeType).toBe("workspace");
    });

    it("rejects unknown fields on authorization object", () => {
      const invalid = {
        schemaKind: "owner_authorization",
        schemaVersion: "1.0.0",
        authorizationId: SAMPLE_UUID_1,
        subjectId: SAMPLE_UUID_2,
        subjectType: "user",
        owner: {
          ownerType: "user",
          ownerId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
        },
        scope: {
          scopeType: "personal",
          userId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
        },
        roles: ["owner"],
        permissions: ["tools:read"],
        issuedAt: SAMPLE_TIMESTAMP,
        injectedField: "attacker_payload",
      };

      expect(() => V1OwnerAuthorizationSchema.parse(invalid)).toThrow();
    });
  });

  describe("Area 2: .resin/project.json (Project Metadata)", () => {
    it("accepts valid portable project metadata", () => {
      const validMeta = {
        schemaKind: "project_metadata",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        name: "my-resin-app",
        settings: {
          defaultRuntimeVersion: "1.0.0",
          environment: "development",
          tags: ["core", "tools"],
        },
        createdAt: SAMPLE_TIMESTAMP,
      };

      const validated = validateV1ProjectMetadata(validMeta);
      expect(validated.projectId).toBe(SAMPLE_UUID_1);
      expect(validated.name).toBe("my-resin-app");
    });

    it("rejects project metadata containing absolute system paths", () => {
      const invalid = {
        schemaKind: "project_metadata",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        name: "leaky-project",
        settings: {
          environment: "/home/dvitash/Projects/secret",
        },
        createdAt: SAMPLE_TIMESTAMP,
      };

      expect(() => validateV1ProjectMetadata(invalid)).toThrow(CommittedMetadataSecurityError);
    });

    it("rejects project metadata with unknown fields", () => {
      const invalid = {
        schemaKind: "project_metadata",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        name: "my-app",
        createdAt: SAMPLE_TIMESTAMP,
        extraUnauthorizedField: "rejected",
      };

      expect(() => validateV1ProjectMetadata(invalid)).toThrow();
    });
  });

  describe("Area 3: .resin/resin.lock (Tool Lock)", () => {
    it("validates exact pinned version lock entries", () => {
      const lockData = {
        schemaKind: "tool_lock",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        updatedAt: SAMPLE_TIMESTAMP,
        tools: {
          calculator: {
            toolId: SAMPLE_UUID_2,
            name: "calculator",
            version: "1.2.0",
            manifestDigest: SAMPLE_SHA256,
            artifactDigest: SAMPLE_SHA256_ALT,
            status: "active" as const,
          },
        },
      };

      const validated = validateV1ToolLock(lockData);
      expect(validated.tools.calculator.version).toBe("1.2.0");
      expect(validated.tools.calculator.manifestDigest).toBe(SAMPLE_SHA256);
    });

    it("rejects lock entries with wildcard or range versions", () => {
      const invalidLock = {
        schemaKind: "tool_lock",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        updatedAt: SAMPLE_TIMESTAMP,
        tools: {
          calculator: {
            toolId: SAMPLE_UUID_2,
            name: "calculator",
            version: "^1.2.0",
            manifestDigest: SAMPLE_SHA256,
            artifactDigest: SAMPLE_SHA256_ALT,
            status: "active" as const,
          },
        },
      };

      expect(() => validateV1ToolLock(invalidLock)).toThrow();
    });

    it("rejects tool key mismatch with entry name", () => {
      const mismatchedKey = {
        schemaKind: "tool_lock",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        updatedAt: SAMPLE_TIMESTAMP,
        tools: {
          calculatorAlias: {
            toolId: SAMPLE_UUID_2,
            name: "calculator",
            version: "1.2.0",
            manifestDigest: SAMPLE_SHA256,
            artifactDigest: SAMPLE_SHA256_ALT,
            status: "active" as const,
          },
        },
      };

      expect(() => validateV1ToolLock(mismatchedKey)).toThrow(/Tool entry key mismatch/);
    });

    it("rejects lockfile containing secrets or paths", () => {
      const unsafeLock = {
        schemaKind: "tool_lock",
        schemaVersion: "1.0.0",
        projectId: SAMPLE_UUID_1,
        updatedAt: SAMPLE_TIMESTAMP,
        tools: {
          calculator: {
            toolId: SAMPLE_UUID_2,
            name: "calculator",
            version: "1.2.0",
            manifestDigest: SAMPLE_SHA256,
            artifactDigest: SAMPLE_SHA256_ALT,
            envelopeDigest: "/var/run/secrets/token",
            status: "active" as const,
          },
        },
      };

      expect(() => validateV1ToolLock(unsafeLock)).toThrow(CommittedMetadataSecurityError);
    });
  });

  describe("Area 4: Signed Activation Certificates", () => {
    it("validates complete signed activation certificate and signable projection", () => {
      const cert = {
        schemaKind: "activation_certificate",
        schemaVersion: "1.0.0",
        certificateId: SAMPLE_UUID_1,
        subject: {
          userId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
          deviceId: SAMPLE_UUID_4,
        },
        projectId: SAMPLE_UUID_1,
        toolId: SAMPLE_UUID_2,
        toolName: "database_query",
        version: "1.0.0",
        manifestDigest: SAMPLE_SHA256,
        artifactDigest: SAMPLE_SHA256_ALT,
        capabilityEnvelopeDigest: SAMPLE_SHA256,
        qualificationEvidenceDigest: SAMPLE_SHA256_ALT,
        counter: 1,
        nonce: "random-nonce-123456",
        issuedAt: SAMPLE_TIMESTAMP,
        notBefore: SAMPLE_TIMESTAMP,
        expiresAt: SAMPLE_TIMESTAMP_FUTURE,
        status: "active" as const,
        signature: SAMPLE_SIGNATURE,
      };

      const validated = validateV1ActivationCertificate(cert);
      expect(validated.certificateId).toBe(SAMPLE_UUID_1);

      const signable = projectSignableActivationCertificate(cert);
      expect(signable).not.toHaveProperty("signature");
      expect(signable.toolName).toBe("database_query");

      const hash = computeSignableHash(signable);
      expect(hash).toHaveLength(64);
    });

    it("rejects certificates with invalid expiry (issued after expiry)", () => {
      const invalidCert = {
        schemaKind: "activation_certificate",
        schemaVersion: "1.0.0",
        certificateId: SAMPLE_UUID_1,
        subject: {
          userId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
        },
        projectId: SAMPLE_UUID_1,
        toolId: SAMPLE_UUID_2,
        toolName: "database_query",
        version: "1.0.0",
        manifestDigest: SAMPLE_SHA256,
        artifactDigest: SAMPLE_SHA256_ALT,
        capabilityEnvelopeDigest: SAMPLE_SHA256,
        qualificationEvidenceDigest: SAMPLE_SHA256_ALT,
        counter: 1,
        nonce: "random-nonce-123456",
        issuedAt: SAMPLE_TIMESTAMP_FUTURE,
        notBefore: SAMPLE_TIMESTAMP_FUTURE,
        expiresAt: SAMPLE_TIMESTAMP, // expires in the past relative to issuedAt
        status: "active" as const,
        signature: SAMPLE_SIGNATURE,
      };

      expect(() => validateV1ActivationCertificate(invalidCert)).toThrow(
        /Certificate validity window invalid/,
      );
    });

    it("rejects certificates with negative counters or short nonces", () => {
      const invalidCounter = {
        schemaKind: "activation_certificate",
        schemaVersion: "1.0.0",
        certificateId: SAMPLE_UUID_1,
        subject: {
          userId: SAMPLE_UUID_2,
          accountId: SAMPLE_UUID_3,
        },
        projectId: SAMPLE_UUID_1,
        toolId: SAMPLE_UUID_2,
        toolName: "database_query",
        version: "1.0.0",
        manifestDigest: SAMPLE_SHA256,
        artifactDigest: SAMPLE_SHA256_ALT,
        capabilityEnvelopeDigest: SAMPLE_SHA256,
        qualificationEvidenceDigest: SAMPLE_SHA256_ALT,
        counter: -1, // invalid
        nonce: "short", // invalid (< 8 chars)
        issuedAt: SAMPLE_TIMESTAMP,
        notBefore: SAMPLE_TIMESTAMP,
        expiresAt: SAMPLE_TIMESTAMP_FUTURE,
        status: "active" as const,
        signature: SAMPLE_SIGNATURE,
      };

      expect(() => validateV1ActivationCertificate(invalidCounter)).toThrow();
    });
  });

  describe("Area 5: Signed Revocation & Offline Freshness", () => {
    const validRevocation: V1RevocationMetadata = {
      schemaKind: "revocation_metadata",
      schemaVersion: "1.0.0",
      revocationListId: SAMPLE_UUID_1,
      authorityId: "authority-root-01",
      accountId: SAMPLE_UUID_2,
      sequenceNumber: 42,
      issuedAt: "2026-08-24T10:00:00.000Z",
      expiresAt: "2026-08-31T10:00:00.000Z",
      revokedTools: [
        {
          toolId: SAMPLE_UUID_3,
          version: "0.9.0",
          revokedAt: "2026-08-24T11:00:00.000Z",
          reason: "Security vulnerability discovered in candidate bundle",
        },
      ],
      revokedCertificates: [
        {
          certificateId: SAMPLE_UUID_4,
          revokedAt: "2026-08-24T11:00:00.000Z",
          reason: "Key compromised",
        },
      ],
      revokedKeys: ["key-compromised-01"],
      signature: SAMPLE_SIGNATURE,
    };

    it("validates revocation metadata and signable projection", () => {
      const validated = validateV1RevocationMetadata(validRevocation);
      expect(validated.sequenceNumber).toBe(42);

      const signable = projectSignableRevocationMetadata(validRevocation);
      expect(signable).not.toHaveProperty("signature");
      expect(signable.sequenceNumber).toBe(42);
    });

    it("verifies fresh offline revocation metadata successfully", () => {
      const res = verifyOfflineRevocationFreshness(validRevocation, {
        currentDeviceTime: "2026-08-24T12:00:00.000Z",
        lastKnownSequenceNumber: 40,
        maxOfflineLeaseMs: 14 * 24 * 60 * 60 * 1000,
      });
      expect(res.valid).toBe(true);
    });

    it("rejects offline metadata when lease has expired", () => {
      expect(() =>
        verifyOfflineRevocationFreshness(validRevocation, {
          currentDeviceTime: "2026-09-05T00:00:00.000Z", // Past expiresAt
        }),
      ).toThrow(RevocationFreshnessError);
    });

    it("rejects offline metadata when clock rollback is detected", () => {
      expect(() =>
        verifyOfflineRevocationFreshness(validRevocation, {
          currentDeviceTime: "2026-08-20T00:00:00.000Z", // Before issuedAt
        }),
      ).toThrow(RevocationFreshnessError);
    });

    it("rejects sequence rollback", () => {
      expect(() =>
        verifyOfflineRevocationFreshness(validRevocation, {
          currentDeviceTime: "2026-08-24T12:00:00.000Z",
          lastKnownSequenceNumber: 50, // Higher than metadata sequence 42
        }),
      ).toThrow(RevocationFreshnessError);
    });

    it("rejects lease duration exceeding maximum window", () => {
      expect(() =>
        verifyOfflineRevocationFreshness(validRevocation, {
          currentDeviceTime: "2026-08-24T12:00:00.000Z",
          maxOfflineLeaseMs: 1000, // 1 second max, but lease is 7 days
        }),
      ).toThrow(RevocationFreshnessError);
    });
  });

  describe("Area 7: Deterministic Migration Hooks & Unsupported Version Errors", () => {
    it("migrates legacy project metadata payload to v1 deterministically", () => {
      const legacy = {
        id: SAMPLE_UUID_1,
        name: "legacy-project",
        createdAt: SAMPLE_TIMESTAMP,
      };
      const migrated = migrateV1ProjectMetadata(legacy);
      expect(migrated.schemaKind).toBe("project_metadata");
      expect(migrated.schemaVersion).toBe("1.0.0");
      expect(migrated.projectId).toBe(SAMPLE_UUID_1);
    });

    it("rejects unsupported schema version on project metadata migration", () => {
      const future = {
        schemaVersion: "2.0.0",
        projectId: SAMPLE_UUID_1,
        name: "future-project",
        createdAt: SAMPLE_TIMESTAMP,
      };

      expect(() => migrateV1ProjectMetadata(future)).toThrow(UnsupportedSchemaVersionError);
    });

    it("migrates legacy tool lockfile payload deterministically", () => {
      const legacyLock = {
        id: SAMPLE_UUID_1,
        updatedAt: SAMPLE_TIMESTAMP,
        tools: {
          parser: {
            id: SAMPLE_UUID_2,
            name: "parser",
            version: "1.0.0",
            digest: SAMPLE_SHA256,
            hash: SAMPLE_SHA256_ALT,
          },
        },
      };

      const migrated = migrateV1ToolLock(legacyLock);
      expect(migrated.schemaKind).toBe("tool_lock");
      expect(migrated.schemaVersion).toBe("1.0.0");
      expect(migrated.tools.parser.manifestDigest).toBe(SAMPLE_SHA256);
      expect(migrated.tools.parser.artifactDigest).toBe(SAMPLE_SHA256_ALT);
    });

    it("rejects unsupported schema version on tool lock migration", () => {
      const futureLock = {
        schemaVersion: "0.9.0",
        projectId: SAMPLE_UUID_1,
        updatedAt: SAMPLE_TIMESTAMP,
        tools: {},
      };

      expect(() => migrateV1ToolLock(futureLock)).toThrow(UnsupportedSchemaVersionError);
    });

    it("rejects non-object or invalid inputs in migration hooks", () => {
      expect(() => migrateV1ProjectMetadata(null)).toThrow(SchemaMigrationError);
      expect(() => migrateV1ToolLock("string")).toThrow(SchemaMigrationError);
      expect(() => migrateV1ActivationCertificate(123)).toThrow(SchemaMigrationError);
      expect(() => migrateV1RevocationMetadata(undefined)).toThrow(SchemaMigrationError);
    });
  });
});
