import {
  CapabilityManifestSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  Sha256DigestSchema,
  UUIDSchema,
  V1ActivationCertificateSchema,
  V1ExactSemVerSchema,
  V1LockedToolEntrySchema,
  type V1MetadataPayloadValue,
  V1RevocationMetadataSchema,
  normalizeSha256,
} from "@resin/contracts";
import { z } from "zod";
import { ProtocolError, type ProtocolErrorDetailRecord, ValidationError } from "./errors.js";

const ZodIssuePathSegmentSchema = z.union([z.string(), z.number()]);
const ZodIssueDetailPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.undefined(),
]);

function serializeZodIssues(issues: readonly z.ZodIssue[]): ProtocolErrorDetailRecord[] {
  return issues.map((issue) => {
    const record: ProtocolErrorDetailRecord = {
      code: issue.code,
      message: issue.message,
      path: issue.path.map((segment) => ZodIssuePathSegmentSchema.parse(segment)),
    };
    for (const [key, value] of Object.entries(issue)) {
      if (key !== "code" && key !== "message" && key !== "path") {
        const parsed = ZodIssueDetailPrimitiveSchema.safeParse(value);
        if (parsed.success) {
          record[key] = parsed.data;
        }
      }
    }
    return record;
  });
}
import { type ProjectVisibility, ProjectVisibilitySchema } from "./projects.js";

// ============================================================================
// 1. Console Project Models
// ============================================================================

export const ConsoleProjectVisibilitySchema = ProjectVisibilitySchema;
export type ConsoleProjectVisibility = ProjectVisibility;

/**
 * Strict wire schema for Console Project summary.
 */
export const ConsoleProjectSchema = z
  .object({
    projectId: UUIDSchema,
    name: z.string().min(1).max(128),
    visibility: ConsoleProjectVisibilitySchema,
    toolCount: z.number().int().nonnegative(),
  })
  .strict();

export type ConsoleProject = z.infer<typeof ConsoleProjectSchema>;

// ============================================================================
// 2. Console Tool Models & Capabilities
// ============================================================================

export const ConsoleToolStatusSchema = z.enum([
  "active",
  "blocked_by_capability",
  "disabled",
  "revoked",
]);
export type ConsoleToolStatus = z.infer<typeof ConsoleToolStatusSchema>;

/**
 * Flexible capabilities schema supporting capability manifest objects,
 * string identifiers array, or custom capability record maps.
 */
export const ConsoleToolCapabilitiesSchema = z.union([
  z.array(z.string().min(1)),
  CapabilityManifestSchema,
  z.record(z.string(), z.unknown()),
]);
export type ConsoleToolCapabilities = z.infer<typeof ConsoleToolCapabilitiesSchema>;

/**
 * Strict wire schema for Console Tool catalog view.
 */
export const ConsoleToolSchema = z
  .object({
    projectId: UUIDSchema,
    toolId: UUIDSchema,
    name: IdentifierSchema,
    version: V1ExactSemVerSchema,
    manifestDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    status: ConsoleToolStatusSchema,
    capabilities: ConsoleToolCapabilitiesSchema,
    updatedAt: ISOTimestampSchema,
  })
  .strict();

export type ConsoleTool = z.infer<typeof ConsoleToolSchema>;

// ============================================================================
// 3. Activation History Models
// ============================================================================

export const ConsoleActivationActionSchema = z.enum([
  "automatic_activation",
  "disable",
  "enable",
  "pin",
  "update",
  "rollback",
  "revoke",
  "capability_blocked",
]);
export type ConsoleActivationAction = z.infer<typeof ConsoleActivationActionSchema>;

export const ConsoleActorTypeSchema = z.enum(["automated", "user", "system"]);
export type ConsoleActorType = z.infer<typeof ConsoleActorTypeSchema>;

/**
 * Strict wire schema for an entry in the tool activation history log.
 */
export const ConsoleActivationHistoryEntrySchema = z
  .object({
    transitionId: UUIDSchema,
    projectId: UUIDSchema,
    toolId: UUIDSchema,
    version: V1ExactSemVerSchema,
    action: ConsoleActivationActionSchema,
    actorType: ConsoleActorTypeSchema,
    actorId: z.string().min(1).max(256),
    evidenceDigest: Sha256DigestSchema,
    certificateId: UUIDSchema.optional(),
    createdAt: ISOTimestampSchema,
  })
  .strict();

export type ConsoleActivationHistoryEntry = z.infer<typeof ConsoleActivationHistoryEntrySchema>;

// Aliases for compatibility
export const ActivationHistoryEntrySchema = ConsoleActivationHistoryEntrySchema;
export type ActivationHistoryEntry = ConsoleActivationHistoryEntry;
export const ConsoleActivationHistorySchema = z.array(ConsoleActivationHistoryEntrySchema);
export type ConsoleActivationHistory = z.infer<typeof ConsoleActivationHistorySchema>;

// ============================================================================
// 4. Pagination Schemas & Helpers
// ============================================================================

/**
 * Standard query parameters for paginated console requests.
 */
export const ConsolePaginationQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ConsolePaginationQuery = z.infer<typeof ConsolePaginationQuerySchema>;

/**
 * Generic creator for strict paginated wire responses.
 */
export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable().optional(),
    })
    .strict();
}

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor?: string | null;
};

export const PaginatedConsoleProjectsResponseSchema =
  createPaginatedResponseSchema(ConsoleProjectSchema);
export type PaginatedConsoleProjectsResponse = z.infer<
  typeof PaginatedConsoleProjectsResponseSchema
>;

export const PaginatedConsoleToolsResponseSchema = createPaginatedResponseSchema(ConsoleToolSchema);
export type PaginatedConsoleToolsResponse = z.infer<typeof PaginatedConsoleToolsResponseSchema>;

export const PaginatedConsoleActivationHistoryResponseSchema = createPaginatedResponseSchema(
  ConsoleActivationHistoryEntrySchema,
);
export type PaginatedConsoleActivationHistoryResponse = z.infer<
  typeof PaginatedConsoleActivationHistoryResponseSchema
>;

// ============================================================================
// 5. Tool Operational Controls
// ============================================================================

export const ConsoleControlActionSchema = z.enum([
  "disable",
  "enable",
  "pin",
  "update",
  "rollback",
  "revoke",
]);
export type ConsoleControlAction = z.infer<typeof ConsoleControlActionSchema>;

/**
 * Strict wire schema for tool control mutation requests.
 * Action-dependent constraints:
 * - "pin", "update", "rollback" REQUIRE exact targetVersion.
 * - "revoke" REQUIRES a non-empty reason.
 * - "expectedArtifactDigest" is required for all control mutations.
 */
export const ConsoleControlRequestSchema = z
  .object({
    action: ConsoleControlActionSchema,
    targetVersion: V1ExactSemVerSchema.optional(),
    expectedArtifactDigest: Sha256DigestSchema,
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      (data.action === "pin" || data.action === "update" || data.action === "rollback") &&
      !data.targetVersion
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetVersion"],
        message: `Action '${data.action}' requires a valid targetVersion (exact SemVer).`,
      });
    }

    if (data.action === "revoke" && (!data.reason || data.reason.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Action 'revoke' requires a non-empty reason.",
      });
    }
  });

export type ConsoleControlRequest = z.infer<typeof ConsoleControlRequestSchema>;
export type ConsoleControlRequestInput = z.input<typeof ConsoleControlRequestSchema>;

/**
 * Validates a console control request and returns the validated object.
 * Throws a ValidationError if invalid.
 */
export function validateConsoleControlRequest(
  raw: ConsoleControlRequestInput | V1MetadataPayloadValue | null | undefined,
): ConsoleControlRequest {
  const result = ConsoleControlRequestSchema.safeParse(raw);
  if (!result.success) {
    const errorMsg = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new ValidationError(`Invalid console control request: ${errorMsg}`, {
      details: {
        errors: serializeZodIssues(result.error.errors),
        actionableAdvice:
          "Ensure action matches valid controls, required fields (targetVersion for pin/update/rollback, reason for revoke) are provided, and expectedArtifactDigest is a valid SHA-256.",
        isTerminal: true,
      },
    });
  }
  return result.data;
}

/**
 * Strict wire schema for tool control mutation responses.
 */
export const ConsoleControlResponseSchema = z
  .object({
    success: z.boolean(),
    projectId: UUIDSchema,
    toolId: UUIDSchema,
    action: ConsoleControlActionSchema,
    status: ConsoleToolStatusSchema,
    version: V1ExactSemVerSchema,
    manifestDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    updatedAt: ISOTimestampSchema,
    message: z.string().optional(),
  })
  .strict();

export type ConsoleControlResponse = z.infer<typeof ConsoleControlResponseSchema>;

// ============================================================================
// 6. Activation Certificate Issuance
// ============================================================================

/**
 * Strict wire schema for requesting an immutable signed activation certificate.
 */
export const ActivationCertificateIssueRequestSchema = z
  .object({
    userId: UUIDSchema,
    accountId: UUIDSchema,
    deviceId: UUIDSchema.optional(),
    projectId: UUIDSchema,
    toolId: UUIDSchema,
    toolName: IdentifierSchema,
    version: V1ExactSemVerSchema,
    manifestDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    envelopeDigest: Sha256DigestSchema.optional(),
    capabilityEnvelopeDigest: Sha256DigestSchema.optional(),
    qualificationDigest: Sha256DigestSchema.optional(),
    qualificationEvidenceDigest: Sha256DigestSchema.optional(),
  })
  .strict()
  .refine((data) => Boolean(data.envelopeDigest || data.capabilityEnvelopeDigest), {
    message: "Either envelopeDigest or capabilityEnvelopeDigest must be provided.",
    path: ["envelopeDigest"],
  })
  .refine((data) => Boolean(data.qualificationDigest || data.qualificationEvidenceDigest), {
    message: "Either qualificationDigest or qualificationEvidenceDigest must be provided.",
    path: ["qualificationEvidenceDigest"],
  });

export type ActivationCertificateIssueRequest = z.infer<
  typeof ActivationCertificateIssueRequestSchema
>;
export type ActivationCertificateIssueRequestInput = z.input<
  typeof ActivationCertificateIssueRequestSchema
>;

export function validateActivationCertificateIssueRequest(
  raw: ActivationCertificateIssueRequestInput | V1MetadataPayloadValue | null | undefined,
): ActivationCertificateIssueRequest {
  const result = ActivationCertificateIssueRequestSchema.safeParse(raw);
  if (!result.success) {
    const errorMsg = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new ValidationError(`Invalid activation certificate issue request: ${errorMsg}`, {
      details: {
        errors: serializeZodIssues(result.error.errors),
        actionableAdvice:
          "Verify user/account/project/tool UUIDs, exact semver, and SHA-256 digests.",
        isTerminal: true,
      },
    });
  }
  return result.data;
}

/**
 * Strict wire schema for the activation certificate issue response.
 */
export const ActivationCertificateIssueResponseSchema = z
  .object({
    certificate: V1ActivationCertificateSchema,
    issuedAt: ISOTimestampSchema.optional(),
  })
  .strict();

export type ActivationCertificateIssueResponse = z.infer<
  typeof ActivationCertificateIssueResponseSchema
>;

// ============================================================================
// 7. Exact Locked Artifact Resolution
// ============================================================================

/**
 * Strict schema for authenticated download metadata.
 */
export const AuthenticatedDownloadMetadataSchema = z
  .object({
    url: z.string().min(1),
    downloadUrl: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    expiresAt: ISOTimestampSchema,
    contentLength: z.number().int().positive().optional(),
    sha256: Sha256DigestSchema,
  })
  .strict();

export type AuthenticatedDownloadMetadata = z.infer<typeof AuthenticatedDownloadMetadataSchema>;

/**
 * Strict wire schema for exact locked artifact resolution response.
 * Contains:
 * - V1LockedToolEntry
 * - V1ActivationCertificate
 * - V1RevocationMetadata
 * - Authenticated download metadata
 */
export const ExactLockedArtifactResolutionResponseSchema = z
  .object({
    lockedEntry: V1LockedToolEntrySchema,
    certificate: V1ActivationCertificateSchema,
    revocationMetadata: V1RevocationMetadataSchema,
    download: AuthenticatedDownloadMetadataSchema,
  })
  .strict();

export type ExactLockedArtifactResolutionResponse = z.infer<
  typeof ExactLockedArtifactResolutionResponseSchema
>;

/**
 * Validates cross-tuple consistency across lockedEntry, certificate,
 * revocationMetadata, and download metadata.
 *
 * Invariants checked:
 * 1. lockedEntry.toolId === certificate.toolId
 * 2. lockedEntry.version === certificate.version
 * 3. lockedEntry.artifactDigest === certificate.artifactDigest
 * 4. lockedEntry.manifestDigest === certificate.manifestDigest
 * 5. lockedEntry.envelopeDigest === certificate.capabilityEnvelopeDigest (if envelopeDigest present)
 * 6. download.sha256 matches normalized certificate.artifactDigest / lockedEntry.artifactDigest
 * 7. Rejects if certificate or tool is marked revoked in revocationMetadata
 */
export type ExactLockedArtifactResolutionResponseInput = z.input<
  typeof ExactLockedArtifactResolutionResponseSchema
>;
export function validateExactLockedArtifactResolutionResponse(
  raw: ExactLockedArtifactResolutionResponseInput | V1MetadataPayloadValue | null | undefined,
): ExactLockedArtifactResolutionResponse {
  const result = ExactLockedArtifactResolutionResponseSchema.safeParse(raw);
  if (!result.success) {
    const errorMsg = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new ValidationError(`Invalid exact locked artifact resolution response: ${errorMsg}`, {
      details: {
        errors: serializeZodIssues(result.error.errors),
        actionableAdvice:
          "Ensure lockedEntry, certificate, revocationMetadata, and download comply with strict wire schema.",
        isTerminal: true,
      },
    });
  }

  const { lockedEntry, certificate, revocationMetadata, download } = result.data;

  // Cross-tuple invariant 1: Tool ID match
  if (lockedEntry.toolId !== certificate.toolId) {
    throw new ValidationError(
      `Cross-tuple mismatch: lockedEntry.toolId (${lockedEntry.toolId}) does not match certificate.toolId (${certificate.toolId})`,
      {
        details: {
          field: "toolId",
          lockedEntryToolId: lockedEntry.toolId,
          certificateToolId: certificate.toolId,
          isTerminal: true,
        },
      },
    );
  }

  // Cross-tuple invariant 2: Exact SemVer match
  if (lockedEntry.version !== certificate.version) {
    throw new ValidationError(
      `Cross-tuple mismatch: lockedEntry.version (${lockedEntry.version}) does not match certificate.version (${certificate.version})`,
      {
        details: {
          field: "version",
          lockedEntryVersion: lockedEntry.version,
          certificateVersion: certificate.version,
          isTerminal: true,
        },
      },
    );
  }

  // Cross-tuple invariant 3: Normalized Artifact Digest match
  const lockedArtifactNorm = normalizeSha256(lockedEntry.artifactDigest, false);
  const certArtifactNorm = normalizeSha256(certificate.artifactDigest, false);
  if (lockedArtifactNorm !== certArtifactNorm) {
    throw new ValidationError(
      `Cross-tuple mismatch: lockedEntry.artifactDigest (${lockedEntry.artifactDigest}) does not match certificate.artifactDigest (${certificate.artifactDigest})`,
      {
        details: {
          field: "artifactDigest",
          lockedEntryArtifactDigest: lockedEntry.artifactDigest,
          certificateArtifactDigest: certificate.artifactDigest,
          isTerminal: true,
        },
      },
    );
  }

  // Cross-tuple invariant 4: Normalized Manifest Digest match
  const lockedManifestNorm = normalizeSha256(lockedEntry.manifestDigest, false);
  const certManifestNorm = normalizeSha256(certificate.manifestDigest, false);
  if (lockedManifestNorm !== certManifestNorm) {
    throw new ValidationError(
      `Cross-tuple mismatch: lockedEntry.manifestDigest (${lockedEntry.manifestDigest}) does not match certificate.manifestDigest (${certificate.manifestDigest})`,
      {
        details: {
          field: "manifestDigest",
          lockedEntryManifestDigest: lockedEntry.manifestDigest,
          certificateManifestDigest: certificate.manifestDigest,
          isTerminal: true,
        },
      },
    );
  }

  // Cross-tuple invariant 5: Envelope digest match (if present on lockedEntry)
  if (lockedEntry.envelopeDigest) {
    const lockedEnvelopeNorm = normalizeSha256(lockedEntry.envelopeDigest, false);
    const certEnvelopeNorm = normalizeSha256(certificate.capabilityEnvelopeDigest, false);
    if (lockedEnvelopeNorm !== certEnvelopeNorm) {
      throw new ValidationError(
        `Cross-tuple mismatch: lockedEntry.envelopeDigest (${lockedEntry.envelopeDigest}) does not match certificate.capabilityEnvelopeDigest (${certificate.capabilityEnvelopeDigest})`,
        {
          details: {
            field: "envelopeDigest",
            lockedEntryEnvelopeDigest: lockedEntry.envelopeDigest,
            certificateCapabilityEnvelopeDigest: certificate.capabilityEnvelopeDigest,
            isTerminal: true,
          },
        },
      );
    }
  }

  // Cross-tuple invariant 6: Download SHA256 digest match
  const downloadShaNorm = normalizeSha256(download.sha256, false);
  if (downloadShaNorm !== certArtifactNorm) {
    throw new ValidationError(
      `Cross-tuple mismatch: download.sha256 (${download.sha256}) does not match certificate.artifactDigest (${certificate.artifactDigest})`,
      {
        details: {
          field: "download.sha256",
          downloadSha256: download.sha256,
          certificateArtifactDigest: certificate.artifactDigest,
          isTerminal: true,
        },
      },
    );
  }

  // Cross-tuple invariant 7: Revocation check
  const isCertRevoked = revocationMetadata.revokedCertificates.some(
    (rc) => rc.certificateId === certificate.certificateId,
  );
  if (isCertRevoked) {
    throw new ValidationError(
      `Resolution rejected: activation certificate '${certificate.certificateId}' has been revoked.`,
      {
        details: {
          certificateId: certificate.certificateId,
          isTerminal: true,
        },
      },
    );
  }

  const isToolRevoked = revocationMetadata.revokedTools.some(
    (rt) =>
      rt.toolId === lockedEntry.toolId &&
      (rt.version === undefined || rt.version === lockedEntry.version),
  );
  if (isToolRevoked) {
    throw new ValidationError(
      `Resolution rejected: tool '${lockedEntry.toolId}' (version ${lockedEntry.version}) has been revoked.`,
      {
        details: {
          toolId: lockedEntry.toolId,
          version: lockedEntry.version,
          isTerminal: true,
        },
      },
    );
  }

  return result.data;
}

// ============================================================================
// 8. Non-Enumerating Error Helpers
// ============================================================================

/**
 * Creates a generic non-enumerating 404 ProtocolError for missing, deleted,
 * or unauthorized console resources to prevent tenant metadata disclosure.
 */
export function createNonEnumeratingConsoleError(
  message = "Resource not found or not accessible",
): ProtocolError {
  return new ProtocolError("not_found", message, {
    status: 404,
    details: {
      actionableAdvice:
        "Verify the requested resource identity and ensure your session has appropriate permissions.",
      isTerminal: true,
    },
  });
}

/**
 * Alias for creating non-enumerating 404 errors.
 */
export const createNonEnumeratingNotFoundError = createNonEnumeratingConsoleError;
