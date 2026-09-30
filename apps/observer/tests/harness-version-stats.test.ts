import { LocalDatabaseConnection } from "@resin/db";
import type { HarnessDefinition, HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_FAILED_SESSION_MAX_RATIO,
  HARNESS_PROBLEM_MIN_EVENTS,
  HARNESS_PROBLEM_MIN_TOOL_INTERACTIONS,
  HARNESS_STATS_SESSION_IDLE_MS,
  HARNESS_UNEXPECTED_PASSTHROUGH_MAX_RATIO,
  HARNESS_VERIFIED_MIN_EVENTS,
  HARNESS_VERIFIED_MIN_SESSIONS,
  type HarnessVersionStats,
  HarnessVersionStatsRecorder,
  classifyHarnessVersionEvidence,
  createInstalledVersionResolver,
  readHarnessVersionStats,
} from "../src/harness-version-stats.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../src/index.js";
import type { PipelineProcessResult } from "../src/normalization/pipeline.js";

let conn: LocalDatabaseConnection;
let nowMs: number;

beforeEach(() => {
  conn = new LocalDatabaseConnection({ inMemory: true }).open();
  nowMs = Date.parse("2026-09-29T12:00:00.000Z");
});
afterEach(() => conn.close());

function session(sessionId: string, harnessId = "omp", metadata = {}): HarnessSession {
  return {
    sessionId,
    workspaceId: "ws",
    harnessId,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    status: "active",
    createdAt: "2026-09-29T12:00:00.000Z",
    updatedAt: "2026-09-29T12:00:00.000Z",
    metadata,
  };
}

function ok(event: Record<string, unknown>, isDuplicate = false): PipelineProcessResult {
  // SAFETY: the recorder only reads `type`, `callId` and `rawEventType`.
  return { status: "success", event, isDuplicate } as unknown as PipelineProcessResult;
}
const message = () => ok({ type: "message" });
const call = (callId: string) => ok({ type: "tool_call", callId });
const result = (callId: string) => ok({ type: "tool_result", callId });
const passthrough = (rawEventType: string) => ok({ type: "unknown_passthrough", rawEventType });
const deadLetter = (): PipelineProcessResult =>
  // SAFETY: the recorder only reads `status`.
  ({ status: "dead_letter", errorReason: "boom" }) as unknown as PipelineProcessResult;

function recorder(resolveVersion = async () => "18.4.0") {
  return new HarnessVersionStatsRecorder({ conn, resolveVersion, now: () => nowMs });
}

describe("HarnessVersionStatsRecorder", () => {
  it("counts decoded events, passthrough, and tool pairing per session and persists them per version", async () => {
    const stats = recorder();
    const s = session("s1");
    stats.record(s, [message(), call("c1"), result("c1"), call("c2")]);
    stats.record(s, [
      // Deliberate OMP bookkeeping is unknown_passthrough but expected; an unheard-of type is not.
      passthrough("title"),
      passthrough("mystery_record"),
      passthrough("mystery_record"),
      result("never-called"),
      // Redelivered records are not counted twice.
      ok({ type: "message" }, true),
    ]);
    await stats.flush();

    expect(readHarnessVersionStats(conn, "omp", "18.4.0")).toMatchObject({
      eventsDecoded: 8,
      eventsUnknownPassthrough: 3,
      eventsUnexpectedPassthrough: 2,
      eventsDeadLettered: 0,
      toolCalls: 2,
      toolResultsPaired: 1,
      toolResultsOrphan: 1,
      toolCallsUnpaired: 0,
      sessionsOk: 1,
      sessionsFailed: 0,
      unexpectedTypes: { mystery_record: 2 },
    });
    // The call still awaiting its result is only unpaired once its session goes idle.
    nowMs += HARNESS_STATS_SESSION_IDLE_MS + 1;
    await stats.flush();
    expect(readHarnessVersionStats(conn, "omp", "18.4.0")?.toolCallsUnpaired).toBe(1);
  });

  it("accumulates across flushes without recounting the session", async () => {
    const stats = recorder();
    const s = session("s1");
    stats.record(s, [message(), message()]);
    await stats.flush();
    stats.record(s, [message()]);
    await stats.flush();
    await stats.flush();
    expect(readHarnessVersionStats(conn, "omp", "18.4.0")).toMatchObject({
      eventsDecoded: 3,
      sessionsOk: 1,
    });
  });

  it("moves a session from ok to failed once, when a record dead-letters", async () => {
    const stats = recorder();
    const s = session("s1");
    stats.record(s, [message()]);
    await stats.flush();
    stats.record(s, [deadLetter(), deadLetter()]);
    await stats.flush();
    stats.record(s, [deadLetter()]);
    await stats.flush();
    expect(readHarnessVersionStats(conn, "omp", "18.4.0")).toMatchObject({
      eventsDecoded: 1,
      eventsDeadLettered: 3,
      sessionsOk: 0,
      sessionsFailed: 1,
    });
  });

  it("keeps a session under its first version and does not recount it after a daemon restart", async () => {
    const first = recorder(async () => "18.4.0");
    first.record(session("s1"), [message()]);
    await first.flush();

    // A new daemon process, and the harness has auto-updated in the meantime.
    const restarted = recorder(async () => "18.5.0");
    restarted.record(session("s1"), [message(), message()]);
    restarted.record(session("s2"), [message()]);
    await restarted.flush();

    expect(readHarnessVersionStats(conn, "omp", "18.4.0")).toMatchObject({
      eventsDecoded: 3,
      sessionsOk: 1,
    });
    expect(readHarnessVersionStats(conn, "omp", "18.5.0")).toMatchObject({
      eventsDecoded: 1,
      sessionsOk: 1,
    });
  });

  it("prefers the version an adapter reports on the session and buckets unresolvable versions as 0.0.0", async () => {
    const resolve = vi.fn(async () => null);
    const stats = recorder(resolve);
    stats.record(session("s1", "opencode", { harnessVersion: "1.20.0" }), [message()]);
    stats.record(session("s2", "pi"), [message()]);
    await stats.flush();
    expect(readHarnessVersionStats(conn, "opencode", "1.20.0")?.sessionsOk).toBe(1);
    expect(readHarnessVersionStats(conn, "pi", "0.0.0")?.sessionsOk).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("retries a failed write instead of dropping the counters", async () => {
    const stats = recorder();
    stats.record(session("s1"), [message()]);
    const run = vi.spyOn(conn, "run").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await stats.flush();
    expect(readHarnessVersionStats(conn, "omp", "18.4.0")).toBeNull();
    run.mockRestore();
    await stats.flush();
    expect(readHarnessVersionStats(conn, "omp", "18.4.0")?.eventsDecoded).toBe(1);
  });

  it("reports no stats for a store that has none", () => {
    expect(readHarnessVersionStats(conn, "omp", "18.4.0")).toBeNull();
  });
});

function stats(overrides: Partial<HarnessVersionStats>): HarnessVersionStats {
  return {
    harnessId: "omp",
    harnessVersion: "18.4.0",
    eventsDecoded: 0,
    eventsUnknownPassthrough: 0,
    eventsUnexpectedPassthrough: 0,
    eventsDeadLettered: 0,
    toolCalls: 0,
    toolResultsPaired: 0,
    toolResultsOrphan: 0,
    toolCallsUnpaired: 0,
    sessionsOk: 0,
    sessionsFailed: 0,
    unexpectedTypes: {},
    firstSeenAt: "2026-09-29T12:00:00.000Z",
    updatedAt: "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

const CLEAN = {
  sessionsOk: HARNESS_VERIFIED_MIN_SESSIONS,
  eventsDecoded: HARNESS_VERIFIED_MIN_EVENTS,
  toolCalls: HARNESS_PROBLEM_MIN_TOOL_INTERACTIONS,
  toolResultsPaired: HARNESS_PROBLEM_MIN_TOOL_INTERACTIONS,
} satisfies Partial<HarnessVersionStats>;

describe("classifyHarnessVersionEvidence", () => {
  it("has no evidence without stats", () => {
    expect(classifyHarnessVersionEvidence(null)).toEqual({ kind: "none" });
    expect(classifyHarnessVersionEvidence(stats({}))).toEqual({ kind: "none" });
  });

  it("verifies a version that decoded enough sessions and events cleanly", () => {
    expect(classifyHarnessVersionEvidence(stats(CLEAN))).toEqual({
      kind: "verified",
      sessions: HARNESS_VERIFIED_MIN_SESSIONS,
      events: HARNESS_VERIFIED_MIN_EVENTS,
    });
  });

  it("tolerates unexpected passthrough up to the ratio threshold", () => {
    const events = HARNESS_VERIFIED_MIN_EVENTS * 2;
    const atLimit = Math.floor(events * HARNESS_UNEXPECTED_PASSTHROUGH_MAX_RATIO);
    expect(
      classifyHarnessVersionEvidence(
        stats({ ...CLEAN, eventsDecoded: events, eventsUnexpectedPassthrough: atLimit }),
      ).kind,
    ).toBe("verified");
  });

  it("flags a high unexpected-passthrough ratio and names the record types", () => {
    const evidence = classifyHarnessVersionEvidence(
      stats({
        ...CLEAN,
        eventsDecoded: HARNESS_VERIFIED_MIN_EVENTS,
        eventsUnexpectedPassthrough: 26,
        unexpectedTypes: { cost_state: 20, other: 5 },
      }),
    );
    expect(evidence).toMatchObject({ kind: "problems" });
    expect(evidence.kind === "problems" && evidence.problems).toEqual([
      "26% of events are unrecognized records (cost_state x20, other x5)",
    ]);
  });

  it("flags unpaired tool calls and orphan results", () => {
    const evidence = classifyHarnessVersionEvidence(
      stats({
        ...CLEAN,
        toolCalls: 20,
        toolResultsPaired: 15,
        toolCallsUnpaired: 3,
        toolResultsOrphan: 2,
      }),
    );
    expect(evidence.kind === "problems" && evidence.problems).toEqual([
      "5 of 22 tool calls are unpaired with their result",
    ]);
  });

  it("flags failed sessions", () => {
    const sessionsFailed = Math.ceil(CLEAN.sessionsOk * HARNESS_FAILED_SESSION_MAX_RATIO) + 1;
    const evidence = classifyHarnessVersionEvidence(stats({ ...CLEAN, sessionsFailed }));
    expect(evidence.kind === "problems" && evidence.problems).toEqual([
      `${sessionsFailed} of ${CLEAN.sessionsOk + sessionsFailed} sessions failed to decode`,
    ]);
  });

  it("reports every problem at once", () => {
    const evidence = classifyHarnessVersionEvidence(
      stats({
        ...CLEAN,
        eventsUnexpectedPassthrough: CLEAN.eventsDecoded,
        toolCallsUnpaired: CLEAN.toolCalls,
        sessionsFailed: CLEAN.sessionsOk,
      }),
    );
    expect(evidence.kind === "problems" && evidence.problems).toHaveLength(3);
  });

  it("does not judge ratios on too little volume", () => {
    const evidence = classifyHarnessVersionEvidence(
      stats({
        sessionsOk: 1,
        eventsDecoded: HARNESS_PROBLEM_MIN_EVENTS - 1,
        eventsUnexpectedPassthrough: HARNESS_PROBLEM_MIN_EVENTS - 1,
        toolCalls: 2,
        toolCallsUnpaired: 2,
      }),
    );
    expect(evidence).toEqual({
      kind: "insufficient",
      sessions: 1,
      events: HARNESS_PROBLEM_MIN_EVENTS - 1,
    });
  });

  it("stays insufficient until both session and event thresholds are met", () => {
    expect(
      classifyHarnessVersionEvidence(
        stats({ ...CLEAN, sessionsOk: HARNESS_VERIFIED_MIN_SESSIONS - 1 }),
      ).kind,
    ).toBe("insufficient");
    expect(
      classifyHarnessVersionEvidence(
        stats({ ...CLEAN, eventsDecoded: HARNESS_VERIFIED_MIN_EVENTS - 1 }),
      ).kind,
    ).toBe("insufficient");
  });
});

describe("createInstalledVersionResolver", () => {
  function definition(probe: () => Promise<{ version: string } | null>): HarnessDefinition {
    // SAFETY: the resolver only reads `id`, `mcpConfig.resolvePath` and `probeInstallation`.
    return {
      id: "omp",
      mcpConfig: { resolvePath: () => "/home/u/.omp/config.json" },
      probeInstallation: probe,
    } as unknown as HarnessDefinition;
  }

  it("probes once per ttl, shares in-flight probes, and treats the unknown version as unresolved", async () => {
    const probe = vi.fn(async () => ({ version: "18.4.0" }));
    const resolve = createInstalledVersionResolver({
      definitions: [definition(probe)],
      home: "/home/u",
      env: {},
      ttlMs: 1_000,
      now: () => nowMs,
    });
    expect(await Promise.all([resolve("omp"), resolve("omp")])).toEqual(["18.4.0", "18.4.0"]);
    expect(await resolve("omp")).toBe("18.4.0");
    expect(probe).toHaveBeenCalledTimes(1);

    nowMs += 1_001;
    probe.mockResolvedValueOnce({ version: "0.0.0" });
    expect(await resolve("omp")).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await resolve("not-a-harness")).toBeNull();
  });

  it("resolves to null when the probe throws", async () => {
    const resolve = createInstalledVersionResolver({
      definitions: [
        definition(async () => {
          throw new Error("no binary");
        }),
      ],
      home: "/home/u",
      env: {},
    });
    expect(await resolve("omp")).toBeNull();
  });
});

describe("capture path integration", () => {
  it("counts what the real normalization pipeline decoded for a live session", async () => {
    const pipeline = new NormalizationPipeline();
    const stats = recorder();
    const client = Object.assign(Object.create(CloudObservationClient.prototype), {
      sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => ({
        batchId: "b",
        status: "accepted",
        acceptedCount: input.observations.length,
        rejectedCount: 0,
        errors: [],
      })),
    }) as CloudObservationClient;
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: client,
      attributionResolver: async () => null,
      coalesceDwellMs: 0,
      onPipelineResults: (s, results) => stats.record(s, results),
    });
    const s = session("s-int", "open-code");
    const timestamp = new Date().toISOString();
    const records: RawHarnessRecord[] = [1, 2].map((sequenceNumber) => ({
      recordId: `rec-${sequenceNumber}`,
      sessionId: s.sessionId,
      harnessId: "open-code",
      sequenceNumber,
      timestamp,
      recordType: "prompt",
      rawPayload: { role: "user", content: `prompt ${sequenceNumber}` },
      cursor: {
        offset: sequenceNumber * 10,
        line: sequenceNumber,
        sequence: sequenceNumber,
        timestamp,
      },
      metadata: {},
    }));

    await coordinator.handleRecords(s, records, async () => {});
    await stats.flush();
    const decoded = readHarnessVersionStats(conn, "open-code", "18.4.0")?.eventsDecoded;
    expect(decoded).toBe(2);
    expect(readHarnessVersionStats(conn, "open-code", "18.4.0")?.sessionsOk).toBe(1);
  });
});
