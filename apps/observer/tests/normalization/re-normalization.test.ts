import { createInMemoryStateStore } from "@resin/db";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type HarnessRecordDecoder,
  NormalizationPipeline,
  ReNormalizer,
} from "../../src/normalization/index.js";

describe("Re-Normalization & Versioned Revision Engine", () => {
  const sessionId = "01J5XYZ7890ABCDEFGHJKMNPQR";
  const timestamp = "2026-08-17T12:00:00.000Z";

  it("creates new revisions without mutating historical evidence", async () => {
    const store = await createInMemoryStateStore();
    const sessionRepo = store.sessions;
    const syncRepo = store.sync;

    await sessionRepo.saveSession({
      sessionId,
      harnessId: "v1_harness",
      status: "running",
      startedAt: timestamp,
    });

    // 1. Process initial v1 raw records through pipeline
    const pipelineV1 = new NormalizationPipeline({
      sessionRepository: sessionRepo,
      syncRepository: syncRepo,
      dbConnection: store.connection,
      redactionConfig: {
        customSecrets: [],
      },
    });

    const rawRecords: RawHarnessRecord[] = [
      {
        recordId: "rec_hist_1",
        sessionId,
        harnessId: "v1_harness",
        sequenceNumber: 1,
        timestamp,
        recordType: "transcript_line",
        rawPayload: {
          role: "user",
          content: "Hello from /Users/alice/repo with API_KEY: secret_key_v1_xyz12345678",
        },
        cursor: { offset: 0, line: 1, sequence: 1, timestamp },
        metadata: {},
      },
      {
        recordId: "rec_hist_2",
        sessionId,
        harnessId: "v1_harness",
        sequenceNumber: 2,
        timestamp,
        recordType: "tool_call",
        rawPayload: {
          toolName: "bash",
          callId: "call_001",
          parameters: { command: "ls -la /Users/alice/repo" },
        },
        cursor: { offset: 100, line: 2, sequence: 2, timestamp },
        metadata: {},
      },
    ];

    const v1Results = await pipelineV1.processBatch(rawRecords);
    expect(v1Results.length).toBe(2);
    expect(v1Results[0].status).toBe("success");
    expect(v1Results[1].status).toBe("success");

    // Check v1 persisted events
    const initialEvents = await sessionRepo.getEvents(sessionId);
    expect(initialEvents.length).toBe(2);
    const initialEvent1Id = initialEvents[0].eventId;

    // 2. Perform Re-normalization with upgraded decoder and upgraded redaction rules (v2)
    const upgradedDecoder: HarnessRecordDecoder = {
      harnessId: "v1_harness",
      decoderVersion: "2.0.0",
      canDecode: () => true,
      decode: (record) => {
        const payload = record.rawPayload;
        const parsedPayload = z.record(z.unknown()).safeParse(payload);
        if (
          record.recordType === "transcript_line" &&
          parsedPayload.success &&
          "content" in parsedPayload.data
        ) {
          return {
            type: "message",
            role: "user",
            content: String(parsedPayload.data.content),
            model: "claude-3-7-sonnet",
            sessionId: record.sessionId,
            timestamp: record.timestamp,
            causalRef: { causalSequence: record.sequenceNumber },
          };
        }
        if (
          record.recordType === "tool_call" &&
          parsedPayload.success &&
          "parameters" in parsedPayload.data
        ) {
          const safeParams =
            z.record(z.unknown()).safeParse(parsedPayload.data.parameters).data ?? {};
          return {
            type: "tool_call",
            toolName: "bash_runner",
            callId: "call_upgraded_001",
            parameters: safeParams,
            sessionId: record.sessionId,
            timestamp: record.timestamp,
            causalRef: { causalSequence: record.sequenceNumber },
          };
        }
        return null;
      },
    };

    const reNormalizer = new ReNormalizer({
      sessionRepository: sessionRepo,
      dbConnection: store.connection,
    });

    // 3. Dry-run preview
    const previewResult = await reNormalizer.preview(rawRecords, {
      decoder: upgradedDecoder,
      redactionConfig: {
        repoRoot: "/Users/alice/repo",
        customSecrets: ["secret_key_v1_xyz12345678"],
      },
      revisionNumber: 2,
    });

    expect(previewResult.dryRun).toBe(true);
    expect(previewResult.revisionNumber).toBe(2);
    expect(previewResult.stats.processedRecords).toBe(2);
    expect(previewResult.stats.generatedEvents).toBe(2);
    expect(previewResult.diffs.length).toBe(2);

    // Verify historical DB records were untouched during preview
    const afterPreviewEvents = await sessionRepo.getEvents(sessionId);
    expect(afterPreviewEvents.length).toBe(2);
    expect(afterPreviewEvents[0].eventId).toBe(initialEvent1Id);
    // 4. Execute re-normalization
    const executeResult = await reNormalizer.reNormalizeRecords(rawRecords, {
      decoder: upgradedDecoder,
      redactionConfig: {
        repoRoot: "/Users/alice/repo",
        customSecrets: ["secret_key_v1_xyz12345678"],
      },
      revisionNumber: 2,
      revisionReason: "Upgraded bash tool mapping and redaction policy",
    });

    expect(executeResult.dryRun).toBe(false);
    expect(executeResult.events.length).toBe(2);

    const revEvent1 = executeResult.events[0];
    const revEvent2 = executeResult.events[1];

    // Verify revision metadata attached
    expect(revEvent1.metadata?.revision).toMatchObject({
      revisionNumber: 2,
      decoderVersion: "2.0.0",
      reason: expect.stringContaining("Upgraded bash tool mapping"),
    });
    // Verify upgraded redaction applied
    if (revEvent1.type === "message") {
      expect(revEvent1.content).toContain("$REPO_ROOT");
      expect(revEvent1.content).toContain("[REDACTED_SECRET:");
    }

    if (revEvent2.type === "tool_call") {
      expect(revEvent2.toolName).toBe("bash_runner");
    }

    // Verify historical v1 database events were NOT mutated
    const dbEventsAfter = await sessionRepo.getEvents(sessionId);
    expect(dbEventsAfter.length).toBe(2);
    expect(dbEventsAfter[0].eventId).toBe(initialEvent1Id);
  });
});
