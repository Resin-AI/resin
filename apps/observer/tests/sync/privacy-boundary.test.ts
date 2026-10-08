import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  RESIN_REPOSITORY_METADATA_KEY,
  RESIN_WORKING_DIRECTORY_METADATA_KEY,
  readRepositoryLocationMetadata,
  readWorkingDirectoryIdentity,
} from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { FilePrivateValueStore } from "../../src/analytics/private-value-store.js";
import { RepositoryLocationAnnotator } from "../../src/analytics/repository-location.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { WorkingDirectoryIdentifier } from "../../src/analytics/working-directory-identity.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";
import { resolvePaths } from "../../src/paths.js";
import {
  InvalidSanitizedObservationError,
  ObservationSyncClient,
  PROHIBITED_RAW_DATA_KEYS,
  RawDataExfiltrationError,
  RawUploadProhibitedError,
  SanitizedObservationBrandSymbol,
  assertNoProhibitedRawData,
  createSanitizedObservationBatchDto,
  createSanitizedObservationDto,
  isSanitizedObservationDto,
} from "../../src/sync/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const syncSrcDir = path.resolve(__dirname, "../../src/sync");
function createSampleSanitizedEvent(
  overrides: Partial<NormalizedSessionEvent> = {},
): NormalizedSessionEvent {
  return {
    eventId: "evt_01j7db4n000000000000000001",
    sessionId: "ses_01j7db4n000000000000000001",
    schemaVersion: "1.0.0",
    timestamp: "2026-08-28T12:00:00.000Z",
    causalRef: {
      causalSequence: 1,
    },
    type: "message",
    role: "user",
    content: "Synthesize tool for file parsing",
    redaction: {
      isRedacted: true,
      redactedFields: ["rawInput"],
      redactionStrategy: "mask",
      scrubbedPatterns: ["credential_pattern"],
      redactedAt: "2026-08-28T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("Privacy and Data Residency Boundary Enforcement", () => {
  describe("1. Architectural Source-Boundary Verification", () => {
    it("ensures sync modules never import raw transcript repositories or raw session stores", () => {
      const syncFiles = fs.readdirSync(syncSrcDir).filter((f) => f.endsWith(".ts"));
      expect(syncFiles.length).toBeGreaterThan(0);

      const prohibitedImports = [
        "SessionRepository",
        "raw_record_refs",
        "raw_sessions",
        "raw_transcripts",
        "RawHarnessRecord",
        "harness-contracts",
      ];

      for (const file of syncFiles) {
        const filePath = path.join(syncSrcDir, file);
        const sourceCode = fs.readFileSync(filePath, "utf8");

        for (const prohibited of prohibitedImports) {
          const importPattern = new RegExp(`import[\\s\\S]*?['\"].*?${prohibited}.*?['\"]`, "g");
          const typeImportPattern = new RegExp(`import\\s+type[\\s\\S]*?${prohibited}`, "g");
          const fromPattern = new RegExp(`from\\s+['\"].*?${prohibited}.*?['\"]`, "g");

          expect(importPattern.test(sourceCode)).toBe(false);
          expect(typeImportPattern.test(sourceCode)).toBe(false);
          expect(fromPattern.test(sourceCode)).toBe(false);
        }
      }
    });

    it("ensures no sync module defines raw-upload config toggles or alternative upload paths", () => {
      const syncFiles = fs.readdirSync(syncSrcDir).filter((f) => f.endsWith(".ts"));

      for (const file of syncFiles) {
        const filePath = path.join(syncSrcDir, file);
        const sourceCode = fs.readFileSync(filePath, "utf8");

        // Disallow opt-in flags or config toggles like sync.upload_raw_traces
        expect(sourceCode.includes("upload_raw_traces")).toBe(false);
        expect(sourceCode.includes("uploadRawTraces")).toBe(false);
        expect(sourceCode.includes("allowRawUpload")).toBe(false);
      }
    });
  });

  describe("2. Adversarial Runtime Payload & Exfiltration Rejection", () => {
    it("rejects raw session / transcript objects with RawDataExfiltrationError", () => {
      const rawSessionPayload = {
        ...createSampleSanitizedEvent(),
        rawTranscript: "User: please look at this API key: sk-proj-12345678901234567890",
      };

      expect(() => createSanitizedObservationDto(rawSessionPayload)).toThrow(
        RawDataExfiltrationError,
      );
    });

    it("rejects objects containing any prohibited raw keys (case-insensitive & nested)", () => {
      for (const key of PROHIBITED_RAW_DATA_KEYS) {
        const maliciousPayload = {
          ...createSampleSanitizedEvent(),
          [key]: "arbitrary raw content that should never cross the boundary",
        };

        expect(() => createSanitizedObservationDto(maliciousPayload)).toThrow(
          RawDataExfiltrationError,
        );
      }
    });

    it("detects deep-nested raw fields and reports the field path", () => {
      const deeplyNestedPayload = {
        ...createSampleSanitizedEvent(),
        metadata: {
          nested: {
            deep: {
              sourceCode: "const internalSecret = 'confidential';",
            },
          },
        },
      };

      expect(() => assertNoProhibitedRawData(deeplyNestedPayload)).toThrow(
        RawDataExfiltrationError,
      );
    });

    it("detects and fails closed on sensitive secret tokens in strings", () => {
      const secretPayloads = [
        { ...createSampleSanitizedEvent(), content: "AKIAIOSFODNN7EXAMPLE" }, // AWS Key
        { ...createSampleSanitizedEvent(), content: "ghp_123456789012345678901234567890123456" }, // GitHub PAT
        {
          ...createSampleSanitizedEvent(),
          // Assembled at runtime so GitHub secret scanning never sees a literal token shape.
          content: ["xoxb", "1234567890", "1234567890123", "abcdefghijklmnopqrstuvwx"].join("-"),
        }, // Slack token
        {
          ...createSampleSanitizedEvent(),
          content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...",
        }, // Private Key
      ];

      for (const payload of secretPayloads) {
        expect(() => createSanitizedObservationDto(payload)).toThrow(RawDataExfiltrationError);
      }
    });

    it("rejects repository or database connection instances", () => {
      class MockSessionRepository {
        query() {
          return [];
        }
      }

      const invalidPayload = {
        ...createSampleSanitizedEvent(),
        repo: new MockSessionRepository(),
      };

      expect(() => createSanitizedObservationDto(invalidPayload)).toThrow(RawDataExfiltrationError);
    });

    it("rejects malformed or un-redacted events", () => {
      const unredactedEvent = {
        eventId: "evt_01j7db4n000000000000000001",
        sessionId: "ses_01j7db4n000000000000000001",
        sequenceNumber: 1,
        schemaVersion: "1.0.0",
        timestamp: "2026-08-28T12:00:00.000Z",
        type: "message",
        role: "user",
        content: "Hello",
        // Missing redaction metadata
      };

      expect(() => createSanitizedObservationDto(unredactedEvent)).toThrow(
        InvalidSanitizedObservationError,
      );
    });
  });

  describe("3. Hostile Remote Directives & Banned APIs Rejection", () => {
    it("rejects cloud responses attempting to remotely enable raw upload", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          accepted: 1,
          enableRawUpload: true, // Hostile cloud command
        }),
      });

      const client = new ObservationSyncClient({
        // SAFETY: Mock fetch satisfies fetchFn test contract.
        fetchFn: mockFetch as typeof fetch,
      });

      const validDto = createSanitizedObservationDto(createSampleSanitizedEvent());

      await expect(client.syncObservations([validDto])).rejects.toThrow(RawUploadProhibitedError);
    });

    it("rejects cloud responses attempting to request raw transcripts or bypass sanitization", async () => {
      const hostileResponses = [
        { rawTranscriptUploadEnabled: true },
        { uploadRawTranscripts: true },
        { requestRawTranscripts: true },
        { uploadMode: "raw" },
        { bypassSanitizer: true },
        { disableRedaction: true },
      ];

      const client = new ObservationSyncClient();

      for (const hostileResp of hostileResponses) {
        expect(() => client.assertNoHostileRemoteDirectives(hostileResp)).toThrow(
          RawUploadProhibitedError,
        );
      }
    });

    it("banned raw-upload methods throw RawUploadProhibitedError", () => {
      const client = new ObservationSyncClient();

      expect(() => client.uploadRawTranscript()).toThrow(RawUploadProhibitedError);
      expect(() => client.setRawUploadEnabled()).toThrow(RawUploadProhibitedError);
    });
  });

  describe("4. Sanitizer-First Verified Flow", () => {
    it("brands validated sanitized observations and allows batch creation", () => {
      const rawEvent = createSampleSanitizedEvent();
      const dto = createSanitizedObservationDto(rawEvent);

      expect(isSanitizedObservationDto(dto)).toBe(true);
      expect(dto[SanitizedObservationBrandSymbol]).toBe(true);
      expect(Object.isFrozen(dto)).toBe(true);

      const batch = createSanitizedObservationBatchDto({
        batchId: "batch_01j7db4n000000000000000001",
        workspaceId: "ws_01j7db4n000000000000000001",
        observations: [rawEvent],
      });

      expect(batch[SanitizedObservationBrandSymbol]).toBe(true);
      expect(batch.observations).toHaveLength(1);
      expect(batch.observations[0][SanitizedObservationBrandSymbol]).toBe(true);
    });

    it("syncObservations transmits sanitized batches without raw fields or brand symbols", async () => {
      let transmittedBody = "";

      const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
        transmittedBody = options.body;
        return {
          ok: true,
          json: async () => ({
            accepted: 1,
            rejected: 0,
            batchId: "batch_01j7db4n000000000000000001",
          }),
        };
      });

      const client = new ObservationSyncClient({
        baseUrl: "https://api.resin.cloud",
        // SAFETY: Mock fetch satisfies fetchFn test contract.
        fetchFn: mockFetch as typeof fetch,
        identityProvider: async () => ({
          tenantId: "tenant_01j7db4n000000000000000001",
          token: "valid-auth-token",
        }),
      });

      const event = createSampleSanitizedEvent();
      const dto = createSanitizedObservationDto(event);

      const result = await client.syncObservations([dto], {
        batchId: "batch_01j7db4n000000000000000001",
        workspaceId: "ws_01j7db4n000000000000000001",
      });

      expect(result.accepted).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the transmitted payload
      const parsedBody = JSON.parse(transmittedBody);
      expect(parsedBody.batchId).toBe("batch_01j7db4n000000000000000001");
      expect(parsedBody.workspaceId).toBe("ws_01j7db4n000000000000000001");
      expect(parsedBody.observations).toHaveLength(1);
      expect(parsedBody.observations[0].content).toBe("Synthesize tool for file parsing");
      expect(parsedBody.observations[0].redaction.isRedacted).toBe(true);

      // Verify no raw or prohibited keys in transmitted payload
      for (const obs of parsedBody.observations) {
        for (const prohibited of PROHIBITED_RAW_DATA_KEYS) {
          expect(prohibited in obs).toBe(false);
        }
      }
    });

    it("fails closed before network request if an unbranded raw object is passed into syncObservations", async () => {
      const mockFetch = vi.fn();
      const client = new ObservationSyncClient({
        // SAFETY: Mock fetch satisfies fetchFn test contract.
        fetchFn: mockFetch as typeof fetch,
      });

      const unbrandedRawEvent = {
        ...createSampleSanitizedEvent(),
        rawPrompt: "Tell me the secret admin password",
      };

      await expect(client.syncObservations([unbrandedRawEvent])).rejects.toThrow(
        RawDataExfiltrationError,
      );

      // Verify that fetch was never called
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("transmits a call's working directory only as a keyed identity, never its path or the device secret", async () => {
      const resinHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-privacy-boundary-"));
      try {
        const store = new FilePrivateValueStore(resolvePaths({ resinHome, env: {} }).dataDir);
        const pipeline = new NormalizationPipeline({ privateValueStore: store });
        pipeline.registerDecoder(new OmpRecordDecoder());
        const sessionId = "ses_01j7db4n000000000000000002";
        const [result] = await pipeline.processRecord(
          {
            recordId: "rec_working_directory",
            sessionId,
            harnessId: "omp",
            sequenceNumber: 1,
            timestamp: "2026-08-28T12:00:00.000Z",
            recordType: "custom",
            rawPayload: JSON.stringify({
              type: "custom",
              customType: "tool_execution_start",
              data: {
                toolCallId: "call_working_directory",
                toolName: "bash",
                args: { command: "pnpm test", cwd: "/synthetic/zq-private-checkout" },
              },
            }),
            cursor: { offset: 1, line: 1, sequence: 1, timestamp: "2026-08-28T12:00:00.000Z" },
            metadata: {},
          },
          { sessionId, harnessId: "omp", workspaceId: "ws_01j7db4n000000000000000001" },
        );
        if (result?.status !== "success") throw new Error("the synthetic call did not normalize");
        const identifier = new WorkingDirectoryIdentifier({
          deviceKey: () => store.redactionKey(),
        });
        identifier.annotate(result.event, result.event, "/synthetic/zq-session-root");
        const projected = projectEventToMetadataOnly(result.event);

        let transmittedBody = "";
        const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
          transmittedBody = options.body;
          return {
            ok: true,
            json: async () => ({ accepted: 1, rejected: 0, batchId: "batch_wd" }),
          };
        });
        const client = new ObservationSyncClient({
          baseUrl: "https://api.resin.cloud",
          // SAFETY: Mock fetch satisfies fetchFn test contract.
          fetchFn: mockFetch as typeof fetch,
          identityProvider: async () => ({ tenantId: "tenant_wd", token: "valid-auth-token" }),
        });
        await client.syncObservations([createSanitizedObservationDto(projected)], {
          batchId: "batch_01j7db4n000000000000000002",
          workspaceId: "ws_01j7db4n000000000000000001",
        });

        const sent = JSON.parse(transmittedBody).observations[0];
        expect(
          readWorkingDirectoryIdentity(sent.metadata[RESIN_WORKING_DIRECTORY_METADATA_KEY]),
        ).toEqual(sent.metadata[RESIN_WORKING_DIRECTORY_METADATA_KEY]);
        expect(sent.metadata[RESIN_WORKING_DIRECTORY_METADATA_KEY].directory).toMatch(
          /^[0-9a-f]{32}$/,
        );
        expect(transmittedBody).not.toContain("/synthetic");
        expect(transmittedBody).not.toContain("zq-private-checkout");
        const keyFile = path.join(resinHome, "data", "private-values", "redaction-key");
        const secret = fs.readFileSync(keyFile);
        if (process.platform !== "win32") {
          expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
        }
        for (const encoding of ["hex", "base64", "base64url"] as const) {
          expect(transmittedBody).not.toContain(secret.toString(encoding));
        }
      } finally {
        fs.rmSync(resinHome, { recursive: true, force: true });
      }
    });
    it("transmits a call's repository only as a root-commit hash and a repository-relative directory", async () => {
      const scratch = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "resin-privacy-repository-")),
      );
      const checkout = path.join(scratch, "zq-private-checkout");
      const gitEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_AUTHOR_NAME: "Synthetic",
        GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
        GIT_COMMITTER_NAME: "Synthetic",
        GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
      };
      try {
        fs.mkdirSync(path.join(checkout, "pkg"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "pkg", "README"), "synthetic\n");
        execFileSync("git", ["init", "-q"], { cwd: checkout, env: gitEnv });
        execFileSync("git", ["add", "."], { cwd: checkout, env: gitEnv });
        execFileSync("git", ["commit", "-q", "-m", "synthetic"], { cwd: checkout, env: gitEnv });
        const resinHome = path.join(scratch, "resin-home");
        const store = new FilePrivateValueStore(resolvePaths({ resinHome, env: {} }).dataDir);
        const pipeline = new NormalizationPipeline({ privateValueStore: store });
        pipeline.registerDecoder(new OmpRecordDecoder());
        const sessionId = "ses_01j7db4n000000000000000003";
        const workspaceId = "ws_01j7db4n000000000000000001";
        const [result] = await pipeline.processRecord(
          {
            recordId: "rec_repository_location",
            sessionId,
            harnessId: "omp",
            sequenceNumber: 1,
            timestamp: "2026-08-28T12:00:00.000Z",
            recordType: "custom",
            rawPayload: JSON.stringify({
              type: "custom",
              customType: "tool_execution_start",
              data: {
                toolCallId: "call_repository_location",
                toolName: "bash",
                args: { command: `cd ${checkout}/pkg && pnpm test` },
              },
            }),
            cursor: { offset: 1, line: 1, sequence: 1, timestamp: "2026-08-28T12:00:00.000Z" },
            metadata: {},
          },
          { sessionId, harnessId: "omp", workspaceId },
        );
        if (result?.status !== "success") throw new Error("the synthetic call did not normalize");
        const observed = new WorkflowCallRecorder({
          privateValues: store,
          privateValueOwnerWorkspaceId: workspaceId,
        }).observe(result.event, { workspaceId });
        new RepositoryLocationAnnotator().annotate(result.event, observed, checkout);
        const projected = projectEventToMetadataOnly(observed);

        let transmittedBody = "";
        const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
          transmittedBody = options.body;
          return {
            ok: true,
            json: async () => ({ accepted: 1, rejected: 0, batchId: "batch_repo" }),
          };
        });
        const client = new ObservationSyncClient({
          baseUrl: "https://api.resin.cloud",
          // SAFETY: Mock fetch satisfies fetchFn test contract.
          fetchFn: mockFetch as typeof fetch,
          identityProvider: async () => ({ tenantId: "tenant_repo", token: "valid-auth-token" }),
        });
        await client.syncObservations([createSanitizedObservationDto(projected)], {
          batchId: "batch_01j7db4n000000000000000003",
          workspaceId,
        });

        const sent = JSON.parse(transmittedBody).observations[0];
        const carrier = sent.metadata[RESIN_REPOSITORY_METADATA_KEY];
        expect(readRepositoryLocationMetadata(carrier)).toEqual(carrier);
        expect(carrier).toEqual({
          id: expect.stringMatching(/^[0-9a-f]{64}$/),
          path: "pkg",
          leadingCd: true,
        });
        // The checkout's own location appears only where the upload already carried the command
        // text (redacted by its own rules); the carrier never adds it.
        expect(JSON.stringify(carrier)).not.toContain(scratch);
        expect(JSON.stringify(carrier)).not.toContain("zq-private-checkout");
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
});
