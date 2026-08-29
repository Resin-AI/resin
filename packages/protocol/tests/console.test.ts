import {
  type V1ActivationCertificate,
  type V1LockedToolEntry,
  type V1RevocationMetadata,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  ActivationCertificateIssueRequestSchema,
  ActivationCertificateIssueResponseSchema,
  ConsoleActivationActionSchema,
  ConsoleActivationHistoryEntrySchema,
  ConsoleControlRequestSchema,
  ConsoleControlResponseSchema,
  ConsolePaginationQuerySchema,
  ConsoleProjectSchema,
  ConsoleToolSchema,
  ConsoleToolStatusSchema,
  ExactLockedArtifactResolutionResponseSchema,
  PaginatedConsoleActivationHistoryResponseSchema,
  PaginatedConsoleProjectsResponseSchema,
  PaginatedConsoleToolsResponseSchema,
  createNonEnumeratingConsoleError,
  createNonEnumeratingNotFoundError,
  createPaginatedResponseSchema,
  validateActivationCertificateIssueRequest,
  validateConsoleControlRequest,
  validateExactLockedArtifactResolutionResponse,
} from "../src/console.js";
import { ValidationError } from "../src/errors.js";

describe("Console Protocol Wire Contracts", () => {
  const validProjectId = "a0000000-0000-4000-8000-000000000001";
  const validToolId = "b0000000-0000-4000-8000-000000000002";
  const validTransitionId = "c0000000-0000-4000-8000-000000000003";
  const validCertificateId = "d0000000-0000-4000-8000-000000000004";
  const validUserId = "e0000000-0000-4000-8000-000000000005";
  const validAccountId = "f0000000-0000-4000-8000-000000000006";
  const validDeviceId = "10000000-0000-4000-8000-000000000007";
  const validRevocationListId = "70000000-0000-4000-8000-000000000008";

  const validSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const validSha256Prefixed =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const validTimestamp = "2026-08-25T00:00:00.000Z";

  // ==========================================================================
  // 1. ConsoleProjectSchema
  // ==========================================================================
  describe("ConsoleProjectSchema", () => {
    it("parses valid personal project summary", () => {
      const parsed = ConsoleProjectSchema.parse({
        projectId: validProjectId,
        name: "my-personal-project",
        visibility: "personal",
        toolCount: 3,
      });
      expect(parsed.projectId).toBe(validProjectId);
      expect(parsed.visibility).toBe("personal");
      expect(parsed.toolCount).toBe(3);
    });

    it("parses valid workspace project summary", () => {
      const parsed = ConsoleProjectSchema.parse({
        projectId: validProjectId,
        name: "team-workspace-project",
        visibility: "workspace",
        toolCount: 0,
      });
      expect(parsed.visibility).toBe("workspace");
      expect(parsed.toolCount).toBe(0);
    });

    it("rejects invalid visibility options", () => {
      expect(() =>
        ConsoleProjectSchema.parse({
          projectId: validProjectId,
          name: "test",
          visibility: "public",
          toolCount: 1,
        }),
      ).toThrow();
    });

    it("rejects negative tool counts or floats", () => {
      expect(() =>
        ConsoleProjectSchema.parse({
          projectId: validProjectId,
          name: "test",
          visibility: "personal",
          toolCount: -1,
        }),
      ).toThrow();

      expect(() =>
        ConsoleProjectSchema.parse({
          projectId: validProjectId,
          name: "test",
          visibility: "personal",
          toolCount: 2.5,
        }),
      ).toThrow();
    });

    it("rejects malformed projectId UUID", () => {
      expect(() =>
        ConsoleProjectSchema.parse({
          projectId: "not-a-uuid",
          name: "test",
          visibility: "personal",
          toolCount: 1,
        }),
      ).toThrow();
    });

    it("rejects unknown keys due to strictness", () => {
      expect(() =>
        ConsoleProjectSchema.parse({
          projectId: validProjectId,
          name: "test",
          visibility: "personal",
          toolCount: 1,
          unexpectedExtra: "forbidden",
        }),
      ).toThrow();
    });
  });

  // ==========================================================================
  // 2. ConsoleToolSchema
  // ==========================================================================
  describe("ConsoleToolSchema", () => {
    const validToolBase = {
      projectId: validProjectId,
      toolId: validToolId,
      name: "fetch-docs",
      version: "1.2.0",
      manifestDigest: validSha256,
      artifactDigest: validSha256,
      status: "active" as const,
      capabilities: ["fs:read", "net:http"],
      updatedAt: validTimestamp,
    };

    it("parses valid active tool with array capabilities", () => {
      const parsed = ConsoleToolSchema.parse(validToolBase);
      expect(parsed.status).toBe("active");
      expect(parsed.capabilities).toEqual(["fs:read", "net:http"]);
    });

    it("parses tools across all valid status enum values", () => {
      const statuses = ["active", "blocked_by_capability", "disabled", "revoked"] as const;
      for (const status of statuses) {
        const parsed = ConsoleToolSchema.parse({
          ...validToolBase,
          status,
        });
        expect(parsed.status).toBe(status);
      }
    });

    it("parses tool with capability manifest object or record map", () => {
      const withRecordCaps = ConsoleToolSchema.parse({
        ...validToolBase,
        capabilities: {
          fs: { readPaths: ["/workspace"] },
          net: { allowedHosts: ["api.example.com"] },
        },
      });
      expect(withRecordCaps.capabilities).toBeDefined();
    });

    it("rejects obsolete or invalid status values like pending/approved", () => {
      expect(() =>
        ConsoleToolSchema.parse({
          ...validToolBase,
          status: "pending_approval",
        }),
      ).toThrow();

      expect(() =>
        ConsoleToolSchema.parse({
          ...validToolBase,
          status: "approved",
        }),
      ).toThrow();
    });

    it("rejects invalid semver", () => {
      expect(() =>
        ConsoleToolSchema.parse({
          ...validToolBase,
          version: "v1.2",
        }),
      ).toThrow();

      expect(() =>
        ConsoleToolSchema.parse({
          ...validToolBase,
          version: "latest",
        }),
      ).toThrow();
    });

    it("rejects malformed SHA-256 digests", () => {
      expect(() =>
        ConsoleToolSchema.parse({
          ...validToolBase,
          artifactDigest: "not-a-hash",
        }),
      ).toThrow();
    });

    it("rejects unknown keys due to strictness", () => {
      expect(() =>
        ConsoleToolSchema.parse({
          ...validToolBase,
          extraField: true,
        }),
      ).toThrow();
    });
  });

  // ==========================================================================
  // 3. ConsoleActivationHistoryEntrySchema
  // ==========================================================================
  describe("ConsoleActivationHistoryEntrySchema", () => {
    const validHistoryBase = {
      transitionId: validTransitionId,
      projectId: validProjectId,
      toolId: validToolId,
      version: "1.0.0",
      action: "automatic_activation" as const,
      actorType: "automated" as const,
      actorId: "resin-automated-qualifier",
      evidenceDigest: validSha256,
      certificateId: validCertificateId,
      createdAt: validTimestamp,
    };

    it("parses valid automatic activation entry with certificateId", () => {
      const parsed = ConsoleActivationHistoryEntrySchema.parse(validHistoryBase);
      expect(parsed.action).toBe("automatic_activation");
      expect(parsed.actorType).toBe("automated");
      expect(parsed.certificateId).toBe(validCertificateId);
    });

    it("parses valid entries across all action variants", () => {
      const actions = [
        "automatic_activation",
        "disable",
        "enable",
        "pin",
        "update",
        "rollback",
        "revoke",
        "capability_blocked",
      ] as const;

      for (const action of actions) {
        const parsed = ConsoleActivationHistoryEntrySchema.parse({
          ...validHistoryBase,
          action,
          actorType: action === "automatic_activation" ? "automated" : "user",
          actorId: action === "automatic_activation" ? "resin" : validUserId,
          certificateId: action === "automatic_activation" ? validCertificateId : undefined,
        });
        expect(parsed.action).toBe(action);
      }
    });

    it("parses valid entries for automated, user, and system actor types", () => {
      const actors = ["automated", "user", "system"] as const;
      for (const actorType of actors) {
        const parsed = ConsoleActivationHistoryEntrySchema.parse({
          ...validHistoryBase,
          actorType,
        });
        expect(parsed.actorType).toBe(actorType);
      }
    });

    it("rejects invalid actions like approve or accept", () => {
      expect(() =>
        ConsoleActivationHistoryEntrySchema.parse({
          ...validHistoryBase,
          action: "approve",
        }),
      ).toThrow();

      expect(() =>
        ConsoleActivationHistoryEntrySchema.parse({
          ...validHistoryBase,
          action: "accept",
        }),
      ).toThrow();
    });

    it("rejects invalid actor types", () => {
      expect(() =>
        ConsoleActivationHistoryEntrySchema.parse({
          ...validHistoryBase,
          actorType: "llm_evaluator",
        }),
      ).toThrow();
    });

    it("rejects unknown keys due to strictness", () => {
      expect(() =>
        ConsoleActivationHistoryEntrySchema.parse({
          ...validHistoryBase,
          unexpectedProp: 123,
        }),
      ).toThrow();
    });
  });

  // ==========================================================================
  // 4. Pagination & Query Schemas
  // ==========================================================================
  describe("Pagination & Query Schemas", () => {
    it("parses valid pagination query parameters", () => {
      const parsed1 = ConsolePaginationQuerySchema.parse({});
      expect(parsed1.limit).toBe(50);
      expect(parsed1.cursor).toBeUndefined();

      const parsed2 = ConsolePaginationQuerySchema.parse({
        cursor: "opaque_cursor_token_12345",
        limit: "25",
      });
      expect(parsed2.cursor).toBe("opaque_cursor_token_12345");
      expect(parsed2.limit).toBe(25);
    });

    it("rejects invalid pagination limits", () => {
      expect(() => ConsolePaginationQuerySchema.parse({ limit: 0 })).toThrow();
      expect(() => ConsolePaginationQuerySchema.parse({ limit: 150 })).toThrow();
      expect(() => ConsolePaginationQuerySchema.parse({ limit: -5 })).toThrow();
    });

    it("parses paginated projects response schema", () => {
      const response = PaginatedConsoleProjectsResponseSchema.parse({
        items: [
          {
            projectId: validProjectId,
            name: "project-1",
            visibility: "personal",
            toolCount: 1,
          },
        ],
        nextCursor: "next_token_67890",
      });
      expect(response.items).toHaveLength(1);
      expect(response.nextCursor).toBe("next_token_67890");
    });

    it("parses paginated tools response schema with null nextCursor", () => {
      const response = PaginatedConsoleToolsResponseSchema.parse({
        items: [],
        nextCursor: null,
      });
      expect(response.items).toHaveLength(0);
      expect(response.nextCursor).toBeNull();
    });

    it("parses paginated activation history response schema", () => {
      const response = PaginatedConsoleActivationHistoryResponseSchema.parse({
        items: [
          {
            transitionId: validTransitionId,
            projectId: validProjectId,
            toolId: validToolId,
            version: "1.0.0",
            action: "automatic_activation",
            actorType: "automated",
            actorId: "system",
            evidenceDigest: validSha256,
            createdAt: validTimestamp,
          },
        ],
      });
      expect(response.items).toHaveLength(1);
      expect(response.nextCursor).toBeUndefined();
    });
  });

  // ==========================================================================
  // 5. Console Controls: Request & Response
  // ==========================================================================
  describe("ConsoleControlRequestSchema & validateConsoleControlRequest", () => {
    it("validates 'disable' and 'enable' requests without targetVersion or reason", () => {
      const disableReq = validateConsoleControlRequest({
        action: "disable",
        expectedArtifactDigest: validSha256,
      });
      expect(disableReq.action).toBe("disable");
      expect(disableReq.expectedArtifactDigest).toBe(validSha256);

      const enableReq = validateConsoleControlRequest({
        action: "enable",
        expectedArtifactDigest: validSha256Prefixed,
      });
      expect(enableReq.action).toBe("enable");
    });

    it("validates 'pin', 'update', and 'rollback' requests with targetVersion", () => {
      const pinReq = validateConsoleControlRequest({
        action: "pin",
        targetVersion: "1.0.0",
        expectedArtifactDigest: validSha256,
      });
      expect(pinReq.action).toBe("pin");
      expect(pinReq.targetVersion).toBe("1.0.0");

      const updateReq = validateConsoleControlRequest({
        action: "update",
        targetVersion: "1.1.0",
        expectedArtifactDigest: validSha256,
      });
      expect(updateReq.action).toBe("update");
      expect(updateReq.targetVersion).toBe("1.1.0");

      const rollbackReq = validateConsoleControlRequest({
        action: "rollback",
        targetVersion: "0.9.0",
        expectedArtifactDigest: validSha256,
      });
      expect(rollbackReq.action).toBe("rollback");
      expect(rollbackReq.targetVersion).toBe("0.9.0");
    });

    it("throws ValidationError when 'pin', 'update', or 'rollback' is missing targetVersion", () => {
      expect(() =>
        validateConsoleControlRequest({
          action: "pin",
          expectedArtifactDigest: validSha256,
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateConsoleControlRequest({
          action: "update",
          expectedArtifactDigest: validSha256,
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateConsoleControlRequest({
          action: "rollback",
          expectedArtifactDigest: validSha256,
        }),
      ).toThrow(ValidationError);
    });

    it("validates 'revoke' request when non-empty reason is provided", () => {
      const revokeReq = validateConsoleControlRequest({
        action: "revoke",
        expectedArtifactDigest: validSha256,
        reason: "Security vulnerability CVE-2026-9999 discovered",
      });
      expect(revokeReq.action).toBe("revoke");
      expect(revokeReq.reason).toBe("Security vulnerability CVE-2026-9999 discovered");
    });

    it("throws ValidationError when 'revoke' is missing reason or reason is empty", () => {
      expect(() =>
        validateConsoleControlRequest({
          action: "revoke",
          expectedArtifactDigest: validSha256,
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateConsoleControlRequest({
          action: "revoke",
          expectedArtifactDigest: validSha256,
          reason: "   ",
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when expectedArtifactDigest is missing or invalid", () => {
      expect(() =>
        validateConsoleControlRequest({
          action: "disable",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateConsoleControlRequest({
          action: "disable",
          expectedArtifactDigest: "invalid-digest",
        }),
      ).toThrow(ValidationError);
    });

    it("rejects unknown keys due to strictness", () => {
      expect(() =>
        validateConsoleControlRequest({
          action: "disable",
          expectedArtifactDigest: validSha256,
          unauthorizedExtra: "attack",
        }),
      ).toThrow(ValidationError);
    });

    it("parses valid ConsoleControlResponseSchema", () => {
      const response = ConsoleControlResponseSchema.parse({
        success: true,
        projectId: validProjectId,
        toolId: validToolId,
        action: "pin",
        status: "active",
        version: "1.0.0",
        manifestDigest: validSha256,
        artifactDigest: validSha256,
        updatedAt: validTimestamp,
        message: "Tool pinned successfully.",
      });
      expect(response.success).toBe(true);
      expect(response.action).toBe("pin");
    });
  });

  // ==========================================================================
  // 6. Activation Certificate Issuance
  // ==========================================================================
  describe("ActivationCertificateIssueRequestSchema & Validation", () => {
    const validIssueRequest = {
      userId: validUserId,
      accountId: validAccountId,
      deviceId: validDeviceId,
      projectId: validProjectId,
      toolId: validToolId,
      toolName: "repo-indexer",
      version: "1.0.0",
      manifestDigest: validSha256,
      artifactDigest: validSha256,
      envelopeDigest: validSha256,
      qualificationDigest: validSha256,
    };

    it("validates valid certificate issue request", () => {
      const parsed = validateActivationCertificateIssueRequest(validIssueRequest);
      expect(parsed.userId).toBe(validUserId);
      expect(parsed.toolName).toBe("repo-indexer");
      expect(parsed.version).toBe("1.0.0");
    });
    it("validates certificate issue request with qualificationEvidenceDigest and capabilityEnvelopeDigest", () => {
      const parsed = validateActivationCertificateIssueRequest({
        userId: validUserId,
        accountId: validAccountId,
        projectId: validProjectId,
        toolId: validToolId,
        toolName: "repo-indexer",
        version: "1.0.0",
        manifestDigest: validSha256,
        artifactDigest: validSha256,
        capabilityEnvelopeDigest: validSha256,
        qualificationEvidenceDigest: validSha256,
      });
      expect(parsed.qualificationEvidenceDigest).toBe(validSha256);
      expect(parsed.capabilityEnvelopeDigest).toBe(validSha256);
    });

    it("throws ValidationError when UUID or digest is malformed", () => {
      expect(() =>
        validateActivationCertificateIssueRequest({
          ...validIssueRequest,
          userId: "not-a-uuid",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateActivationCertificateIssueRequest({
          ...validIssueRequest,
          qualificationDigest: "invalid-hash",
        }),
      ).toThrow(ValidationError);
    });

    it("rejects unknown keys in issue request", () => {
      expect(() =>
        validateActivationCertificateIssueRequest({
          ...validIssueRequest,
          unknownPayload: 1,
        }),
      ).toThrow(ValidationError);
    });
  });

  // ==========================================================================
  // 7. Exact Locked Artifact Resolution & Cross-Tuple Invariants
  // ==========================================================================
  describe("ExactLockedArtifactResolutionResponse & validateExactLockedArtifactResolutionResponse", () => {
    const manifestDigest = "1111111111111111111111111111111111111111111111111111111111111111";
    const artifactDigest = "2222222222222222222222222222222222222222222222222222222222222222";
    const envelopeDigest = "3333333333333333333333333333333333333333333333333333333333333333";
    const qualDigest = "4444444444444444444444444444444444444444444444444444444444444444";

    const validLockedEntry: V1LockedToolEntry = {
      toolId: validToolId,
      name: "calc-tool",
      version: "1.0.0",
      manifestDigest,
      artifactDigest,
      envelopeDigest,
      status: "active",
    };

    const validCertificate: V1ActivationCertificate = {
      schemaKind: V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
      schemaVersion: V1_SCHEMA_VERSION,
      certificateId: validCertificateId,
      subject: {
        userId: validUserId,
        accountId: validAccountId,
        deviceId: validDeviceId,
      },
      projectId: validProjectId,
      toolId: validToolId,
      toolName: "calc-tool",
      version: "1.0.0",
      manifestDigest,
      artifactDigest,
      capabilityEnvelopeDigest: envelopeDigest,
      qualificationEvidenceDigest: qualDigest,
      counter: 1,
      nonce: "random-nonce-1234",
      issuedAt: validTimestamp,
      notBefore: validTimestamp,
      expiresAt: "2026-09-01T00:00:00.000Z",
      status: "active",
      signature: {
        keyId: "prod-key-1",
        algorithm: "ed25519",
        signature: "sig1234567890abcdef",
        signedAt: validTimestamp,
      },
    };

    const validRevocationMetadata: V1RevocationMetadata = {
      schemaKind: V1_SCHEMA_KINDS.REVOCATION_METADATA,
      schemaVersion: V1_SCHEMA_VERSION,
      revocationListId: validRevocationListId,
      authorityId: "resin-revocation-authority",
      accountId: validAccountId,
      sequenceNumber: 1,
      issuedAt: validTimestamp,
      expiresAt: "2026-09-25T00:00:00.000Z",
      revokedTools: [],
      revokedCertificates: [],
      revokedKeys: [],
      signature: {
        keyId: "prod-key-1",
        algorithm: "ed25519",
        signature: "sigrevocation123",
        signedAt: validTimestamp,
      },
    };

    const validDownload = {
      url: "https://artifacts.resintool.dev/v1/tools/b0000000-0000-4000-8000-000000000002/artifact.tar.gz",
      expiresAt: "2026-08-25T01:00:00.000Z",
      sha256: artifactDigest,
      contentLength: 10240,
    };

    const validResolutionTuple = {
      lockedEntry: validLockedEntry,
      certificate: validCertificate,
      revocationMetadata: validRevocationMetadata,
      download: validDownload,
    };

    it("validates a fully consistent resolution response tuple", () => {
      const validated = validateExactLockedArtifactResolutionResponse(validResolutionTuple);
      expect(validated.lockedEntry.toolId).toBe(validToolId);
      expect(validated.certificate.certificateId).toBe(validCertificateId);
      expect(validated.download.sha256).toBe(artifactDigest);
    });

    it("throws ValidationError when lockedEntry.toolId and certificate.toolId mismatch", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          lockedEntry: {
            ...validLockedEntry,
            toolId: "99999999-9999-4000-8000-999999999999",
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when lockedEntry.version and certificate.version mismatch", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          lockedEntry: {
            ...validLockedEntry,
            version: "1.1.0",
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when artifact digests mismatch between lockedEntry and certificate", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          lockedEntry: {
            ...validLockedEntry,
            artifactDigest: "5555555555555555555555555555555555555555555555555555555555555555",
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when manifest digests mismatch", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          lockedEntry: {
            ...validLockedEntry,
            manifestDigest: "5555555555555555555555555555555555555555555555555555555555555555",
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when envelope digest on locked entry mismatches certificate capability envelope", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          lockedEntry: {
            ...validLockedEntry,
            envelopeDigest: "5555555555555555555555555555555555555555555555555555555555555555",
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when download.sha256 mismatches the artifact digest", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          download: {
            ...validDownload,
            sha256: "5555555555555555555555555555555555555555555555555555555555555555",
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when certificate is revoked in revocationMetadata", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          revocationMetadata: {
            ...validRevocationMetadata,
            revokedCertificates: [
              {
                certificateId: validCertificateId,
                revokedAt: validTimestamp,
                reason: "Key compromised",
              },
            ],
          },
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError when tool is revoked in revocationMetadata", () => {
      expect(() =>
        validateExactLockedArtifactResolutionResponse({
          ...validResolutionTuple,
          revocationMetadata: {
            ...validRevocationMetadata,
            revokedTools: [
              {
                toolId: validToolId,
                version: "1.0.0",
                revokedAt: validTimestamp,
                reason: "Critical defect",
              },
            ],
          },
        }),
      ).toThrow(ValidationError);
    });
  });

  // ==========================================================================
  // 8. Non-Enumerating 404 Error Helpers
  // ==========================================================================
  describe("Non-Enumerating Error Helpers", () => {
    it("createNonEnumeratingConsoleError returns a 404 ProtocolError disclosing no metadata", () => {
      const error = createNonEnumeratingConsoleError();
      expect(error.code).toBe("not_found");
      expect(error.status).toBe(404);
      expect(error.message).toBe("Resource not found or not accessible");
      expect(error.details?.isTerminal).toBe(true);
      expect(error.details?.actionableAdvice).toBeDefined();
    });

    it("createNonEnumeratingNotFoundError is an alias returning 404", () => {
      const error = createNonEnumeratingNotFoundError("Custom not found message");
      expect(error.code).toBe("not_found");
      expect(error.status).toBe(404);
      expect(error.message).toBe("Custom not found message");
    });
  });
});
