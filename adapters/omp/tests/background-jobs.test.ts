import type {
  IntermediateSessionEvent,
  IntermediateToolCallEvent,
  IntermediateToolResultEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  isOmpJobReportOnly,
  ompAsyncResultCompletions,
  ompJobReportCompletions,
} from "../src/background-jobs.js";
import { OmpRecordDecoder } from "../src/decoder.js";

// Synthetic records shaped like the lines OMP persists for background jobs; no recorded values.

function record(sessionId: string, seq: number, payload: unknown): RawHarnessRecord {
  const timestamp = `2026-10-05T10:${String(seq).padStart(2, "0")}:00.000Z`;
  return {
    recordId: `rec-${sessionId}-${seq}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: seq,
    recordType: "transcript_line",
    timestamp,
    cursor: { offset: seq * 100, line: seq, sequence: seq, timestamp },
    rawPayload: JSON.stringify(payload),
    metadata: {},
  };
}

function decodeAll(sessionId: string, lines: readonly unknown[]): IntermediateSessionEvent[] {
  const decoder = new OmpRecordDecoder();
  return lines.flatMap((line, index) => {
    const decoded = decoder.decode(record(sessionId, index + 1, line));
    return decoded === null ? [] : Array.isArray(decoded) ? decoded : [decoded];
  });
}

const calls = (events: readonly IntermediateSessionEvent[]) =>
  events.filter((event): event is IntermediateToolCallEvent => event.type === "tool_call");
const results = (events: readonly IntermediateSessionEvent[]) =>
  events.filter((event): event is IntermediateToolResultEvent => event.type === "tool_result");

/** The assistant request and execution start of one call. */
function request(id: string, name: string, args: Record<string, unknown>): unknown[] {
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: { i: "intent", ...args } }],
      },
    },
    {
      type: "custom",
      customType: "tool_execution_start",
      data: { toolCallId: id, toolName: name },
    },
  ];
}

function toolResult(
  id: string,
  name: string,
  text: string,
  details: Record<string, unknown>,
  isError = false,
): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      details,
      isError,
    },
  };
}

/** An async bash call and its launch acknowledgement. */
function asyncBash(id: string, jobId: string, command: string): unknown[] {
  return [
    ...request(id, "bash", { command, async: true }),
    toolResult(
      id,
      "bash",
      `Backgrounded as job ${jobId}; result will be delivered automatically.`,
      {
        async: { state: "running", jobId, type: "bash" },
        timeoutSeconds: 600,
      },
    ),
  ];
}

/** A `wait` call whose result reports the given jobs. */
function waitFor(id: string, jobs: Record<string, unknown>[]): unknown[] {
  return [
    ...request(id, "wait", {}),
    toolResult(id, "wait", "## Completed", {
      op: "wait",
      meta: { source: { type: "report", value: "background jobs snapshot" } },
      jobs,
    }),
  ];
}

describe("OMP background jobs", () => {
  it("records a joined job's output as its launching call's single result, and no wait", () => {
    const events = decodeAll("session-wait", [
      ...asyncBash("call-watch", "bg_1", "make watch"),
      ...request("call-ls", "bash", { command: "ls" }),
      toolResult("call-ls", "bash", "a\nb", { wallTimeMs: 3 }),
      ...waitFor("call-wait", [
        {
          id: "bg_1",
          type: "bash",
          status: "completed",
          label: "make watch",
          durationMs: 650_000,
          resultText: "done\n\nWall time: 650.00 seconds",
        },
      ]),
    ]);

    expect(calls(events).map((call) => [call.toolName, call.callId])).toEqual([
      ["bash", "call-watch"],
      ["bash", "call-ls"],
    ]);
    const [ls, watch] = results(events);
    expect(ls?.callId).toBe("call-ls");
    expect(watch).toMatchObject({
      callId: "call-watch",
      toolName: "bash",
      result: "done\n\nWall time: 650.00 seconds",
      isError: false,
      executionDurationMs: 650_000,
      timestamp: "2026-10-05T10:09:00.000Z",
    });
    // A job the report stated completed exited 0, like a foreground run.
    expect(watch?.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY]).toBe("omp-bash-completed");
    expect(JSON.stringify(events)).not.toContain("Backgrounded as job");
  });

  it("records a failed job as a failed result with its error text", () => {
    const events = decodeAll("session-failed", [
      ...asyncBash("call-release", "bg_2", "make release"),
      ...waitFor("call-wait", [
        {
          id: "bg_2",
          type: "bash",
          status: "failed",
          durationMs: 1200,
          exitCode: 1,
          errorText: "boom\n\nCommand exited with code 1",
        },
      ]),
    ]);
    expect(results(events)).toEqual([
      expect.objectContaining({
        callId: "call-release",
        isError: true,
        error: "boom\n\nCommand exited with code 1",
        result: "boom\n\nCommand exited with code 1",
      }),
    ]);
    expect(results(events)[0]?.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY]).toBeUndefined();
  });

  it("joins jobs an auto-delivered notice reports, one or several", () => {
    const single = decodeAll("session-notice", [
      ...asyncBash("call-test", "bg_3", "npm test"),
      {
        type: "custom_message",
        customType: "async-result",
        content:
          "<system-notice>\nBackground job bg_3 has completed. Resume your work using the result below.\n12 passed\nWall time: 3.10 seconds\n</system-notice>",
        display: true,
        details: { jobs: [{ jobId: "bg_3", type: "bash", label: "npm test", durationMs: 3100 }] },
      },
    ]);
    const [testResult] = results(single);
    expect(testResult).toMatchObject({
      callId: "call-test",
      result: "12 passed\nWall time: 3.10 seconds",
      isError: false,
      executionDurationMs: 3100,
    });
    // The notice states no status: the run is not proven to have exited 0.
    expect(testResult?.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY]).toBeUndefined();
    // The notice itself still passes through.
    expect(single.some((event) => event.type === "unknown_passthrough")).toBe(true);

    const several = decodeAll("session-notices", [
      ...asyncBash("call-a", "bg_4", "make a"),
      ...asyncBash("call-b", "bg_5", "make b"),
      {
        type: "custom_message",
        customType: "async-result",
        content:
          "<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job bg_4 (make a) ──\nbuilt a\n── Job bg_5 (make b) ──\nb broke\n\nCommand exited with code 2\n</system-notice>",
        details: {
          jobs: [
            { jobId: "bg_4", type: "bash", label: "make a", durationMs: 10 },
            { jobId: "bg_5", type: "bash", label: "make b", durationMs: 20 },
          ],
        },
      },
    ]);
    expect(
      results(several).map((result) => [result.callId, result.result, result.isError]),
    ).toEqual([
      ["call-a", "built a", false],
      ["call-b", "b broke\n\nCommand exited with code 2", true],
    ]);
  });

  it("joins each job once, whichever record reports it first", () => {
    const events = decodeAll("session-twice", [
      ...asyncBash("call-x", "bg_6", "make x"),
      {
        type: "custom_message",
        customType: "async-result",
        content:
          "<system-notice>\nBackground job bg_6 has completed. Resume your work using the result below.\nx\n</system-notice>",
        details: { jobs: [{ jobId: "bg_6", type: "bash", label: "make x" }] },
      },
      ...waitFor("call-wait", [
        { id: "bg_6", type: "bash", status: "completed", resultText: "x", durationMs: 1 },
      ]),
    ]);
    expect(results(events).map((result) => result.callId)).toEqual(["call-x"]);
    expect(calls(events).map((call) => call.callId)).toEqual(["call-x"]);
  });

  it("leaves a job never seen completing without a result, and a still-running report changes nothing", () => {
    const events = decodeAll("session-running", [
      ...asyncBash("call-long", "bg_7", "sleep 9999"),
      ...waitFor("call-wait", [{ id: "bg_7", type: "bash", status: "running", durationMs: 5 }]),
    ]);
    expect(calls(events).map((call) => call.callId)).toEqual(["call-long"]);
    expect(results(events)).toEqual([]);
  });

  it("keeps a wait that returned something other than a job report, with its result", () => {
    const events = decodeAll("session-message-wait", [
      ...request("call-wait", "wait", {}),
      toolResult("call-wait", "wait", "message from peer", { op: "wait", from: "peer", waited: 1 }),
      ...request("call-interrupted", "wait", {}),
      toolResult("call-interrupted", "wait", "interrupted", {
        op: "wait",
        interrupted: true,
        jobs: [],
      }),
    ]);
    expect(calls(events).map((call) => [call.callId, call.toolName])).toEqual([
      ["call-wait", "wait"],
      ["call-interrupted", "wait"],
    ]);
    expect(results(events).map((result) => result.callId)).toEqual([
      "call-wait",
      "call-interrupted",
    ]);
    // The held call keeps its own timestamp, before its result's.
    expect(calls(events)[0]?.timestamp).toBe("2026-10-05T10:01:00.000Z");
  });

  it("treats a hub job wait like a wait, and keeps other hub calls and foreground bash as they were", () => {
    const events = decodeAll("session-hub", [
      ...asyncBash("call-job", "bg_8", "make job"),
      ...request("call-hub-wait", "hub", { op: "wait" }),
      toolResult("call-hub-wait", "hub", "## Completed", {
        op: "wait",
        jobs: [{ id: "bg_8", type: "bash", status: "completed", resultText: "ok", durationMs: 2 }],
      }),
      ...request("call-hub-send", "hub", { op: "send", to: "peer", message: "hi" }),
      toolResult("call-hub-send", "hub", "sent", { op: "send", to: "peer", receipts: [] }),
      ...request("call-fg", "bash", { command: "echo hi" }),
      toolResult("call-fg", "bash", "hi", { wallTimeMs: 1 }),
    ]);
    expect(calls(events).map((call) => call.callId)).toEqual([
      "call-job",
      "call-hub-send",
      "call-fg",
    ]);
    expect(results(events).map((result) => [result.callId, result.result])).toEqual([
      ["call-job", "ok"],
      ["call-hub-send", "sent"],
      ["call-fg", "hi"],
    ]);
  });

  it("drops a repeated record of a dropped wait's result", () => {
    const [assistant, start, result] = waitFor("call-wait", []);
    const end = {
      type: "custom",
      customType: "tool_execution_end",
      data: {
        toolCallId: "call-wait",
        toolName: "wait",
        result: "## Completed",
        details: { op: "wait", jobs: [] },
      },
    };
    const events = decodeAll("session-repeat", [assistant, start, result, end]);
    expect(calls(events)).toEqual([]);
    expect(results(events)).toEqual([]);
  });
});

describe("OMP background-job record readers", () => {
  it("reads only bash jobs a report finished, with the text it kept", () => {
    expect(
      ompJobReportCompletions({
        jobs: [
          { id: "bg_1", type: "bash", status: "completed", resultText: "ok", durationMs: 4 },
          { id: "bg_2", type: "bash", status: "completed", durationMs: 4 },
          { id: "bg_3", type: "bash", status: "cancelled" },
          { id: "bg_4", type: "bash", status: "running" },
          { id: "Scout", type: "task", status: "completed", resultText: "done" },
        ],
      }),
    ).toEqual([
      { jobId: "bg_1", output: "ok", failed: false, statusStated: true, durationMs: 4 },
      { jobId: "bg_3", output: "", failed: true, statusStated: true, durationMs: undefined },
    ]);
  });

  it("recognizes a report-only result", () => {
    expect(isOmpJobReportOnly({ op: "wait", meta: {}, jobs: [] }, false)).toBe(true);
    expect(isOmpJobReportOnly({ op: "wait", jobs: [] }, true)).toBe(false);
    expect(isOmpJobReportOnly({ op: "wait", from: "peer" }, false)).toBe(false);
    expect(isOmpJobReportOnly({ op: "wait", daemon: {}, jobs: [] }, false)).toBe(false);
    expect(isOmpJobReportOnly(undefined, false)).toBe(false);
  });

  it("reads failure trailers from a notice, and nothing from one whose sections cannot be located", () => {
    const content =
      "<system-notice>\n3 background jobs have completed. Resume your work using the results below.\n\n── Job bg_1 (a) ──\nslow\n\n[Command timed out after 5 seconds]\n── Job bg_2 ──\n\n── Job bg_3 (c) ──\ncancel\n[Command aborted]\n</system-notice>";
    const jobs = [
      { jobId: "bg_1", type: "bash", label: "a" },
      { jobId: "bg_2", type: "bash" },
      { jobId: "bg_3", type: "bash", label: "c" },
    ];
    expect(
      ompAsyncResultCompletions(content, { jobs }).map((completion) => [
        completion.jobId,
        completion.output,
        completion.failed,
      ]),
    ).toEqual([
      ["bg_1", "slow\n\n[Command timed out after 5 seconds]", true],
      ["bg_2", "", false],
      ["bg_3", "cancel\n[Command aborted]", true],
    ]);
    const relabeled = [jobs[0]!, { ...jobs[1]!, label: "not as rendered" }, jobs[2]!];
    expect(ompAsyncResultCompletions(content, { jobs: relabeled })).toEqual([]);
  });
});
