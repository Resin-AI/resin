import { randomUUID } from "node:crypto";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../../src/index.js";

function rec(sessionId: string, seq: number, isoTs: string): RawHarnessRecord {
  return {
    recordId: `rec_${seq}_${randomUUID().slice(0, 8)}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber: seq,
    timestamp: isoTs,
    recordType: "prompt",
    rawPayload: { role: "user", content: `msg ${seq}`, timestamp: isoTs },
    cursor: { offset: seq * 100, line: seq, sequence: seq, timestamp: isoTs },
    metadata: {},
  };
}
function lifecycle(sessionId: string, seq: number, isoTs: string): RawHarnessRecord {
  return {
    recordId: `rec_life_${seq}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber: seq,
    timestamp: isoTs,
    recordType: "transcript_line",
    rawPayload: {
      type: "session_lifecycle",
      lifecycleType: "end",
      exitReason: "completed",
      timestamp: isoTs,
    },
    cursor: { offset: seq * 100, line: seq, sequence: seq, timestamp: isoTs },
    metadata: {},
  };
}
function session(sessionId: string) {
  const t = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws",
    harnessId: "open-code",
    transcriptPath: `/t/${sessionId}.jsonl`,
    status: "active" as const,
    createdAt: t,
    updatedAt: t,
    metadata: undefined,
  };
}
function mockClient(capture: { obs: any[] }) {
  const c = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  return Object.assign(c, {
    sendTrajectoryObservationBatch: vi.fn(),
    sendObservationBatch: vi.fn(async (input: { observations: any[] }) => {
      capture.obs.push(...input.observations);
      return {
        batchId: "b",
        status: "accepted",
        acceptedCount: input.observations.length,
        rejectedCount: 0,
        errors: [],
      };
    }),
  });
}

describe("out-of-order timestamp sort", () => {
  it("sorts projected events by timestamp before sendObservationBatch", async () => {
    const capture = { obs: [] as any[] };
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline: new NormalizationPipeline(),
      observationClient: mockClient(capture),
      attributionResolver: async () => null,
    });
    const s = session("sess_ooo_1");
    const base = Date.parse("2026-08-30T21:00:00.000Z");
    // deliberately out of order: +30s, +0s, +10s, then terminal +40s
    const records = [
      rec(s.sessionId, 1, new Date(base + 30000).toISOString()),
      rec(s.sessionId, 2, new Date(base + 0).toISOString()),
      rec(s.sessionId, 3, new Date(base + 10000).toISOString()),
      lifecycle(s.sessionId, 4, new Date(base + 40000).toISOString()),
    ];
    await coordinator.handleRecords(
      s as any,
      records,
      vi.fn(async () => {}),
    );
    expect(capture.obs.length).toBeGreaterThan(1);
    const ts = capture.obs.map((o) => Date.parse(o.timestamp));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1] - 1000);
    }
    // and confirm it is actually non-decreasing now
    const sorted = [...ts].sort((a, b) => a - b);
    expect(ts).toEqual(sorted);
  });
});
