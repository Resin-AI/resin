import { V1_SCHEMA_KINDS, V1_SCHEMA_VERSION } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  ProjectRegistrationRequestSchema,
  ProjectRegistrationResponseSchema,
  createNonEnumeratingProjectError,
  validateProjectRegistrationRequest,
  validateProjectRegistrationResponse,
} from "../src/projects.js";

describe("ProjectRegistration Protocol Contracts", () => {
  const validProjectId = "a0000000-0000-4000-8000-000000000001";
  const validTimestamp = "2026-08-25T00:00:00.000Z";

  const validProjectMetadata = {
    schemaKind: V1_SCHEMA_KINDS.PROJECT_METADATA,
    schemaVersion: V1_SCHEMA_VERSION,
    projectId: validProjectId,
    name: "test-project",
    createdAt: validTimestamp,
  };

  describe("ProjectRegistrationRequestSchema", () => {
    it("accepts valid personal and workspace registration requests", () => {
      const personalReq = {
        project: validProjectMetadata,
        visibility: "personal" as const,
      };
      const parsedPersonal = ProjectRegistrationRequestSchema.parse(personalReq);
      expect(parsedPersonal.visibility).toBe("personal");
      expect(parsedPersonal.project.projectId).toBe(validProjectId);

      const workspaceReq = {
        project: validProjectMetadata,
        visibility: "workspace" as const,
      };
      const parsedWorkspace = validateProjectRegistrationRequest(workspaceReq);
      expect(parsedWorkspace.visibility).toBe("workspace");
    });

    it("rejects invalid visibility options", () => {
      const invalidReq = {
        project: validProjectMetadata,
        visibility: "public",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(invalidReq)).toThrow();
    });

    it("rejects unsupported project schema versions or schema kinds", () => {
      const wrongVersionReq = {
        project: {
          ...validProjectMetadata,
          schemaVersion: "2.0.0",
        },
        visibility: "personal",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(wrongVersionReq)).toThrow();

      const wrongKindReq = {
        project: {
          ...validProjectMetadata,
          schemaKind: "v1_other_kind",
        },
        visibility: "personal",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(wrongKindReq)).toThrow();
    });

    it("rejects malformed project UUIDs", () => {
      const malformedUuidReq = {
        project: {
          ...validProjectMetadata,
          projectId: "not-a-uuid",
        },
        visibility: "personal",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(malformedUuidReq)).toThrow();
    });

    it("rejects unknown top-level fields", () => {
      const unknownTopReq = {
        project: validProjectMetadata,
        visibility: "personal",
        extraField: "unexpected",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(unknownTopReq)).toThrow();
    });

    it("rejects embedded paths or auth fields in metadata", () => {
      const pathInProjectReq = {
        project: {
          ...validProjectMetadata,
          rootPath: "/Users/dev/project",
        },
        visibility: "personal",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(pathInProjectReq)).toThrow();

      const authInProjectReq = {
        project: {
          ...validProjectMetadata,
          token: "secret-token",
        },
        visibility: "personal",
      };
      expect(() => ProjectRegistrationRequestSchema.parse(authInProjectReq)).toThrow();
    });
  });

  describe("ProjectRegistrationResponseSchema", () => {
    it.each(["registered", "existing", "fork_required", "local_only"] as const)(
      "accepts valid outcome '%s'",
      (outcome) => {
        const response = {
          outcome,
          projectId: validProjectId,
        };
        const parsed = ProjectRegistrationResponseSchema.parse(response);
        expect(parsed.outcome).toBe(outcome);
        expect(parsed.projectId).toBe(validProjectId);
      },
    );

    it("rejects invalid outcomes", () => {
      const invalidOutcome = {
        outcome: "forbidden_outcome",
        projectId: validProjectId,
      };
      expect(() => ProjectRegistrationResponseSchema.parse(invalidOutcome)).toThrow();
    });

    it("rejects malformed response UUIDs", () => {
      const malformedUuid = {
        outcome: "registered",
        projectId: "invalid-uuid",
      };
      expect(() => ProjectRegistrationResponseSchema.parse(malformedUuid)).toThrow();
    });

    it("rejects unknown fields in response", () => {
      const unknownField = {
        outcome: "registered",
        projectId: validProjectId,
        token: "unexpected",
      };
      expect(() => ProjectRegistrationResponseSchema.parse(unknownField)).toThrow();
    });
  });

  describe("validateProjectRegistrationResponse helper", () => {
    it("validates successfully when expectedProjectId matches", () => {
      const response = {
        outcome: "registered" as const,
        projectId: validProjectId,
      };
      const parsed = validateProjectRegistrationResponse(response, validProjectId);
      expect(parsed.outcome).toBe("registered");
    });

    it("throws ProtocolError on response projectId mismatch", () => {
      const otherProjectId = "b0000000-0000-4000-8000-000000000002";
      const response = {
        outcome: "registered" as const,
        projectId: otherProjectId,
      };
      expect(() => validateProjectRegistrationResponse(response, validProjectId)).toThrowError(
        /mismatch/,
      );
    });
  });

  describe("createNonEnumeratingProjectError", () => {
    it("creates standard non-enumerating ProtocolError with PERMISSION_DENIED", () => {
      const error = createNonEnumeratingProjectError();
      expect(error.code).toBe("permission_denied");
      expect(error.details?.isTerminal).toBe(true);
      expect(error.message).toContain("Project not accessible");
    });
  });
});
