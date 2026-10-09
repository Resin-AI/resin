/**
 * A restarted daemon resumes an OMP transcript from its persisted cursor with a new decoder. The
 * source recovers the request links of the prefix it skips, once, so events after the cursor keep
 * the task of the latest prompt and the request that issued each earlier call, exactly as an
 * uninterrupted capture links them, and no prefix usage is emitted again.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatResinInvocationReceiptText, resinInvocationReceiptMeta } from "@resin/contracts";
import type {
  HarnessSession,
  IntermediateSessionEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpRecordDecoder, RESIN_LOCAL_OMP_REQUEST_LINK_RESUME_KEY } from "../src/decoder.js";
import { OmpSessionEventSource } from "../src/source.js";

const SESSION_ID = "resume-links-session";
const INVOCATION = "inv_00112233445566778899aabbccddeeff";
const BENCHMARK = "bench-resume-1";

const text = (value: string) => ({ type: "text", text: value });
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + output,
  cost: { total: 0.001 },
});

/** Before the restart: a prompt, a judge side call, and a response that starts a Resin call. */
const beforeRestart = [
  { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" },
  {
    type: "message",
    id: "prompt01",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [text("Lint the sources.")] },
  },
  {
    type: "model_usage",
    id: "aux0001a",
    timestamp: "2026-01-01T00:00:02.000Z",
    purpose: "auto-thinking",
    provider: "example-judge",
    model: "judge-mini",
    usage: usage(20, 0, 0, 5),
    stopReason: "stop",
  },
  {
    type: "message",
    id: "rec0001a",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      responseId: "msg_first",
      stopReason: "toolUse",
      usage: usage(2, 1_000, 100, 40),
      content: [
        {
          type: "toolCall",
          id: "call_resin",
          name: "write",
          arguments: {
            path: "xd://mcp__resin_invoke_tool",
            content: JSON.stringify({ name: "lint_sources", parameters: {} }),
          },
        },
      ],
    },
  },
];

/**
 * After the restart: OMP's execution start marker for the call the prefix already announced (it names
 * only the device path), the call's result with its receipt, then the final response.
 */
const afterRestart = [
  {
    type: "custom",
    customType: "tool_execution_start",
    id: "start01",
    timestamp: "2026-01-01T00:00:03.500Z",
    data: {
      toolCallId: "call_resin",
      toolName: "write",
      startedAt: "2026-01-01T00:00:03.500Z",
      args: { path: "xd://mcp__resin_invoke_tool" },
      intent: "Running the learned lint",
    },
  },
  {
    type: "message",
    id: "result01",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_resin",
      toolName: "write",
      isError: false,
      content: [
        text(
          `lint passed\n\n${formatResinInvocationReceiptText({ invocationId: INVOCATION, benchmarkId: BENCHMARK })}`,
        ),
      ],
      details: {
        xdev: {
          tool: "mcp__resin_invoke_tool",
          mode: "execute",
          tier: "write",
          args: { name: "lint_sources", parameters: {} },
          inner: {
            serverName: "resin",
            mcpToolName: "invoke_tool",
            isError: false,
            rawContent: [
              text("lint passed"),
              text(
                formatResinInvocationReceiptText({
                  invocationId: INVOCATION,
                  benchmarkId: BENCHMARK,
                }),
              ),
            ],
            mcpMeta: {
              "resin/invocation": resinInvocationReceiptMeta({
                invocationId: INVOCATION,
                benchmarkId: BENCHMARK,
              }),
            },
          },
        },
      },
    },
  },
  {
    type: "message",
    id: "rec0002b",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      responseId: "msg_final",
      stopReason: "stop",
      usage: usage(3, 1_140, 50, 20),
      content: [text("Lint passed.")],
    },
  },
];

const jsonl = (records: unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

function session(transcriptPath: string): HarnessSession {
  return {
    sessionId: SESSION_ID,
    workspaceId: "ws-resume",
    harnessId: "omp",
    transcriptPath,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

function decodeRecords(
  decoder: OmpRecordDecoder,
  records: RawHarnessRecord[],
): IntermediateSessionEvent[] {
  return records.flatMap((record) => {
    const decoded = decoder.decode(record);
    return decoded === null ? [] : Array.isArray(decoded) ? decoded : [decoded];
  });
}

/** The identity and usage view of events that the cloud joins on. */
function linkView(events: IntermediateSessionEvent[]) {
  return events.map((event) => ({
    type: event.type,
    taskId: event.metadata?.taskId,
    modelRequestId: event.metadata?.modelRequestId,
    resinInvocationId: event.metadata?.resinInvocationId,
    benchmarkId: event.metadata?.benchmarkId,
    requestId: event.providerUsage?.requestId,
    totalTokens: event.providerUsage?.totalTokens,
  }));
}

async function readAll(source: OmpSessionEventSource): Promise<RawHarnessRecord[]> {
  const records: RawHarnessRecord[] = [];
  for (;;) {
    const batch = await source.readNext(50);
    if (batch.length === 0) return records;
    records.push(...batch);
  }
}

describe("OMP request links across a restart", () => {
  it("links events after a resumed cursor exactly as an uninterrupted capture does", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-resume-links-"));
    try {
      const transcriptPath = path.join(dir, "session.jsonl");

      // Uninterrupted capture of the whole transcript.
      await fsp.writeFile(transcriptPath, jsonl([...beforeRestart, ...afterRestart]));
      const whole = decodeRecords(
        new OmpRecordDecoder(),
        await readAll(new OmpSessionEventSource(session(transcriptPath))),
      );

      // The same transcript captured in two runs: the first stops at the restart point.
      await fsp.writeFile(transcriptPath, jsonl(beforeRestart));
      const firstSource = new OmpSessionEventSource(session(transcriptPath));
      const first = decodeRecords(new OmpRecordDecoder(), await readAll(firstSource));
      const savedCursor = firstSource.getCursor();

      await fsp.appendFile(transcriptPath, jsonl(afterRestart));
      const resumedSource = new OmpSessionEventSource(session(transcriptPath), savedCursor);
      const resumedRecords = await readAll(resumedSource);
      const resumed = decodeRecords(new OmpRecordDecoder(), resumedRecords);

      // The handoff rides only on the first record after the cursor and never reaches events.
      expect(resumedRecords[0]?.metadata).toHaveProperty(RESIN_LOCAL_OMP_REQUEST_LINK_RESUME_KEY);
      expect(resumedRecords.slice(1).map((record) => record.metadata)).not.toContainEqual(
        expect.objectContaining({ [RESIN_LOCAL_OMP_REQUEST_LINK_RESUME_KEY]: expect.anything() }),
      );
      for (const event of resumed) {
        expect(event.metadata).not.toHaveProperty(RESIN_LOCAL_OMP_REQUEST_LINK_RESUME_KEY);
      }

      expect(linkView([...first, ...resumed])).toEqual(linkView(whole));
      const result = resumed.find((event) => event.type === "tool_result");
      expect(result?.metadata).toMatchObject({
        taskId: "prompt01",
        modelRequestId: "msg_first",
        resinInvocationId: INVOCATION,
        benchmarkId: BENCHMARK,
      });
      expect(
        resumed.find((event) => event.type === "message" && event.providerUsage)?.metadata,
      ).toMatchObject({ taskId: "prompt01", modelRequestId: "msg_final" });

      // Every request's usage is emitted exactly once across both runs.
      const requestIds = [...first, ...resumed].flatMap((event) =>
        event.providerUsage?.requestId === undefined ? [] : [event.providerUsage.requestId],
      );
      expect(requestIds.sort()).toEqual(["aux0001a", "msg_final", "msg_first"]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers nothing after a session exit and keeps links a live decoder already holds", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-resume-links-exit-"));
    try {
      const transcriptPath = path.join(dir, "session.jsonl");
      const exit = {
        type: "custom",
        customType: "session_exit",
        id: "exit01",
        timestamp: "2026-01-01T00:00:03.500Z",
        data: { reason: "dispose", kind: "normal" },
      };
      await fsp.writeFile(transcriptPath, jsonl([...beforeRestart, exit]));
      const firstSource = new OmpSessionEventSource(session(transcriptPath));
      await readAll(firstSource);
      const cursor = firstSource.getCursor();

      // OMP resumes the session in the same file with a new prompt.
      await fsp.appendFile(
        transcriptPath,
        jsonl([
          {
            type: "message",
            id: "prompt02",
            timestamp: "2026-01-01T00:00:06.000Z",
            message: { role: "user", content: [text("Again.")] },
          },
        ]),
      );
      const resumedRecords = await readAll(
        new OmpSessionEventSource(session(transcriptPath), cursor),
      );
      // The exit cleared every link, so there is nothing to hand over.
      expect(resumedRecords[0]?.metadata).not.toHaveProperty(
        RESIN_LOCAL_OMP_REQUEST_LINK_RESUME_KEY,
      );

      // A decoder that already holds a newer task keeps it over a recovered one.
      const live = new OmpRecordDecoder();
      decodeRecords(live, [
        {
          ...resumedRecords[0]!,
          rawPayload: { type: "message", id: "prompt03", message: { role: "user", content: "x" } },
        },
      ]);
      const [event] = decodeRecords(live, [
        {
          ...resumedRecords[0]!,
          metadata: {
            [RESIN_LOCAL_OMP_REQUEST_LINK_RESUME_KEY]: {
              version: 1,
              taskId: "prompt01",
              calls: [],
              announced: [],
              names: [],
              surfaces: [],
            },
          },
          rawPayload: {
            type: "message",
            id: "rec9",
            message: { role: "assistant", content: "ok" },
          },
        },
      ]);
      expect(event?.metadata?.taskId).toBe("prompt03");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
