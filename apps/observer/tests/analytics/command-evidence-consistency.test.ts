/**
 * One event, several outputs: the local sink, the cloud batch, and the batch a retry re-projects
 * after a failed upload. They must all carry the SAME command evidence.
 *
 * The command evidence is derived once, before redaction, from the pipeline's pre-redaction carrier
 * and retained as the sanitized sequence. A consumer that ran first must not be able to take it away
 * from the others, and a retry must not fall back to the redacted event (where a masked argument
 * means the command has no representable evidence at all).
 */

import { describe, expect, it, vi } from "vitest";
import { ResourceForbiddenError } from "../../src/auth-recovery.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  type TrajectoryAttributionResolver,
  TrajectoryCaptureCoordinator,
} from "../../src/index.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let recordSequence = 0;

function nextSequence(): number {
  recordSequence += 1;
  return recordSequence;
}

function commandRecord(sessionId: string): never {
  const sequence = nextSequence();
  return {
    recordId: `rec_${sequence}`,
    sessionId,
    harnessId: "consistency_test",
    sequenceNumber: sequence,
    timestamp: new Date(Date.UTC(2026, 8, 17, 0, 0, sequence)).toISOString(),
    recordType: "transcript_line",
    rawPayload: { command: `deploy --token ${SECRET} ./dist/app.tar` },
    cursor: { offset: sequence, line: sequence, sequence, timestamp: new Date().toISOString() },
    metadata: {},
  } as never;
}

function lifecycleRecord(sessionId: string): never {
  const sequence = nextSequence();
  return {
    recordId: `rec_${sequence}`,
    sessionId,
    harnessId: "consistency_test",
    sequenceNumber: sequence,
    timestamp: new Date(Date.UTC(2026, 8, 17, 0, 0, sequence)).toISOString(),
    recordType: "session_lifecycle",
    rawPayload: { type: "session_lifecycle", lifecycleType: "end", exitReason: "completed" },
    cursor: { offset: sequence, line: sequence, sequence, timestamp: new Date().toISOString() },
    metadata: {},
  } as never;
}

const decoder = {
  harnessId: "consistency_test",
  decoderVersion: "1.0.0",
  canDecode: () => true,
  decode: (record: { rawPayload?: unknown; sequenceNumber?: number }) => {
    const payload = record.rawPayload as Record<string, unknown>;
    if (payload.type === "session_lifecycle") {
      return {
        type: "session_lifecycle" as const,
        sessionId: "sess_consistency",
        timestamp: new Date(Date.UTC(2026, 8, 17, 0, 0, record.sequenceNumber ?? 1)).toISOString(),
        schemaVersion: "1.0.0" as const,
        causalRef: { causalSequence: record.sequenceNumber ?? 1 },
        lifecycleType: "end" as const,
        exitReason: "completed",
      };
    }
    return {
      type: "tool_call" as const,
      sessionId: "sess_consistency",
      timestamp: new Date(Date.UTC(2026, 8, 17, 0, 0, record.sequenceNumber ?? 1)).toISOString(),
      schemaVersion: "1.0.0" as const,
      causalRef: { causalSequence: record.sequenceNumber ?? 1 },
      toolName: "bash",
      callId: `call_${record.sequenceNumber ?? 1}`,
      parameters: { command: payload.command },
    };
  },
};

function session(sessionId: string) {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws_consistency",
    harnessId: "consistency_test",
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { environment: "production", runner: "local" },
  };
}

function evidenceByEvent(observations: readonly unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const observation of observations) {
    const event = observation as {
      eventId?: string;
      metadata?: Record<string, unknown>;
    };
    if (typeof event.eventId !== "string") continue;
    map.set(event.eventId, event.metadata?.resinCommandSequence ?? null);
  }
  return map;
}

describe("command evidence consistency across consumers", () => {
  it("carries identical command evidence to the local sink, the first upload, and the retry", async () => {
    const pipeline = new NormalizationPipeline({
      redactionConfig: { enabled: true, strategy: "mask" },
    });
    pipeline.registerDecoder(decoder as never);

    const attempts: unknown[][] = [];
    const observationClient = Object.create(
      CloudObservationClient.prototype,
    ) as CloudObservationClient;
    Object.assign(observationClient, {
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => {
        attempts.push([...input.observations]);
        if (attempts.length === 1) {
          throw new ResourceForbiddenError("ws_consistency", "cloud_observation_submission");
        }
        return {
          batchId: "batch_retry",
          status: "accepted",
          acceptedCount: input.observations.length,
          rejectedCount: 0,
          errors: [],
        };
      }),
    });

    const attributionResolver: TrajectoryAttributionResolver = async () => null;
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient,
      attributionResolver,
      coalesceDwellMs: 0,
    });

    const localEvents: unknown[] = [];
    coordinator.setSessionEventSink(async (_session, events) => {
      localEvents.push(...events);
    });

    const sessionId = `sess_consistency_${Math.random().toString(36).slice(2, 8)}`;
    const harnessSession = session(sessionId);

    // A flush may happen on either call (dwell 0 flushes immediately); the first upload fails and
    // the buffered events stay for a retry.
    const handle = async (record: never) => {
      try {
        await coordinator.handleRecords(
          harnessSession,
          [record],
          vi.fn(async () => {}),
        );
        return null;
      } catch (error) {
        return error;
      }
    };

    const firstError = await handle(commandRecord(sessionId));
    expect(firstError).toBeInstanceOf(ResourceForbiddenError);
    expect(attempts).toHaveLength(1);

    // Retry: a later batch re-projects the same buffered events.
    await handle(lifecycleRecord(sessionId));
    expect(attempts.length).toBeGreaterThanOrEqual(2);

    const local = evidenceByEvent(localEvents);
    const first = evidenceByEvent(attempts[0] ?? []);
    const retry = evidenceByEvent(attempts[1] ?? []);

    // Outputs flush at different points, so they need not hold the same event set — but every event
    // that appears in more than one output must carry identical command evidence in each of them.
    const shared = [...local.keys()].filter((eventId) => first.has(eventId) && retry.has(eventId));
    expect(shared.length).toBeGreaterThan(0);

    let evidenceChecked = 0;
    for (const eventId of shared) {
      const localEvidence = local.get(eventId);
      expect(first.get(eventId)).toEqual(localEvidence);
      expect(retry.get(eventId)).toEqual(localEvidence);
      if (localEvidence !== null) evidenceChecked += 1;
    }
    expect(evidenceChecked).toBeGreaterThan(0);

    // And the evidence is the sanitized sequence, not the argument values.
    const serialized = JSON.stringify(shared.map((eventId) => local.get(eventId)));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("REDACTED");

    coordinator.dispose();
  });
});
