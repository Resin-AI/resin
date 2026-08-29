import { UUIDSchema, type V1MetadataPayloadValue, V1ProjectMetadataSchema } from "@resin/contracts";
import { z } from "zod";
import { PermissionDeniedError, type ProtocolError, ValidationError } from "./errors.js";

/**
 * Supported visibility options for project registration.
 */
export const ProjectVisibilitySchema = z.enum(["personal", "workspace"]);
export type ProjectVisibility = z.infer<typeof ProjectVisibilitySchema>;

/**
 * Possible registration outcomes.
 * - registered: newly registered project under the owner
 * - existing: project already registered and owned by the caller (idempotent)
 * - fork_required: project registered under another owner; caller must fork/re-identify
 * - local_only: caller/system policy dictates local-only mode
 */
export const ProjectRegistrationOutcomeSchema = z.enum([
  "registered",
  "existing",
  "fork_required",
  "local_only",
]);
export type ProjectRegistrationOutcome = z.infer<typeof ProjectRegistrationOutcomeSchema>;

/**
 * Strict wire request schema for project registration.
 * Explicitly rejects unknown fields, filesystem paths, and embedded auth data.
 */
export const ProjectRegistrationRequestSchema = z
  .object({
    project: V1ProjectMetadataSchema,
    visibility: ProjectVisibilitySchema,
  })
  .strict();

export type ProjectRegistrationRequest = z.infer<typeof ProjectRegistrationRequestSchema>;
export type ProjectRegistrationRequestInput = z.input<typeof ProjectRegistrationRequestSchema>;

/**
 * Strict wire response schema for project registration.
 */
export const ProjectRegistrationResponseSchema = z
  .object({
    outcome: ProjectRegistrationOutcomeSchema,
    projectId: UUIDSchema,
  })
  .strict();

export type ProjectRegistrationResponse = z.infer<typeof ProjectRegistrationResponseSchema>;
export type ProjectRegistrationResponseInput = z.input<typeof ProjectRegistrationResponseSchema>;

/**
 * Non-enumerating error helper for project registration / project operations.
 * Emits uniform non-enumerating error to prevent leaking existence or details of foreign projects.
 */
export function createNonEnumeratingProjectError(
  message = "Project not accessible or requires re-identification",
  options?: {
    requestId?: string;
  },
): ProtocolError {
  return new PermissionDeniedError(message, {
    details: {
      actionableAdvice:
        "Ensure you have access to this project or re-bootstrap with a new project identity.",
      isTerminal: true,
      requestId: options?.requestId,
    },
  });
}

export function validateProjectRegistrationRequest(
  data: ProjectRegistrationRequestInput | V1MetadataPayloadValue | null | undefined,
): ProjectRegistrationRequest {
  return ProjectRegistrationRequestSchema.parse(data);
}

/**
 * Validates a project registration response and asserts that the response projectId
 * matches the expected request projectId.
 */
export function validateProjectRegistrationResponse(
  data: ProjectRegistrationResponseInput | V1MetadataPayloadValue | null | undefined,
  expectedProjectId?: string,
): ProjectRegistrationResponse {
  const parsed = ProjectRegistrationResponseSchema.parse(data);
  if (expectedProjectId !== undefined && parsed.projectId !== expectedProjectId) {
    throw new ValidationError(
      `Project registration response projectId mismatch: expected '${expectedProjectId}', received '${parsed.projectId}'`,
      {
        details: {
          actionableAdvice:
            "Verify the cloud response corresponds to the requested project identity.",
          isTerminal: true,
        },
      },
    );
  }
  return parsed;
}
