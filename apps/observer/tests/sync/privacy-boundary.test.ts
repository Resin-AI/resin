import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
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
          content: "xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx",
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
        fetchFn: mockFetch as unknown as typeof fetch,
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
        fetchFn: mockFetch as unknown as typeof fetch,
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
        fetchFn: mockFetch as unknown as typeof fetch,
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
  });
});
