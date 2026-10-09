import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatResinInvocationReceiptText } from "@resin/contracts";
import type {
  HarnessSession,
  IntermediateSessionEvent,
  RawHarnessRecord,
  SourceCursor,
} from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_REQUEST_LINK_RESUME_KEY, ClaudeRecordDecoder } from "../src/decoder.js";
import { ClaudeSessionEventSource } from "../src/source.js";

const SESSION_ID = "resume-links-session";
const INVOCATION_ID = `inv_${"0".repeat(31)}1`;
const MODEL = "claude-test-model";

const promptLine = {
  type: "user",
  uuid: "prompt-uuid-1",
  timestamp: "2026-10-01T10:00:00.000Z",
  message: { role: "user", content: "Summarize the sample notes." },
};
const toolUseLine = {
  type: "assistant",
  uuid: "line-uuid-2",
  requestId: "req_test_1",
  timestamp: "2026-10-01T10:00:01.000Z",
  message: {
    id: "msg_test_1",
    model: MODEL,
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_test_1",
        name: "mcp__resin__invoke_tool",
        input: { name: "sample_tool" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 12, output_tokens: 4 },
  },
};
const toolResultLine = {
  type: "user",
  uuid: "line-uuid-3",
  timestamp: "2026-10-01T10:00:02.000Z",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_test_1",
        content: [
          { type: "text", text: '{"ok":true}' },
          { type: "text", text: formatResinInvocationReceiptText({ invocationId: INVOCATION_ID }) },
        ],
      },
    ],
  },
};
const finalLine = {
  type: "assistant",
  uuid: "line-uuid-4",
  requestId: "req_test_2",
  timestamp: "2026-10-01T10:00:03.000Z",
  message: {
    id: "msg_test_2",
    model: MODEL,
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 3 },
  },
};

let dir: string;
let transcriptPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-claude-resume-links-"));
  transcriptPath = path.join(dir, "transcript.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(): HarnessSession {
  return {
    sessionId: SESSION_ID,
    workspaceId: "ws-resume",
    harnessId: "claude-code",
    transcriptPath,
    status: "active",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    metadata: {},
  };
}

const jsonl = (lines: object[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

/** Reads every record a source can emit and decodes them in order with one decoder. */
async function decodeAll(
  source: ClaudeSessionEventSource,
  decoder: ClaudeRecordDecoder,
): Promise<{ records: RawHarnessRecord[]; events: IntermediateSessionEvent[] }> {
  const records = await source.readNext(100);
  const events = records.flatMap((record) => decoder.decode(record));
  return { records, events };
}

/** The request-link view of an event: what a restart must not change. */
function links(event: IntermediateSessionEvent) {
  return {
    type: event.type,
    taskId: event.metadata?.taskId,
    modelRequestId: event.metadata?.modelRequestId,
    resinInvocationId: event.metadata?.resinInvocationId,
    requestUsage: event.providerUsage === undefined ? undefined : event.metadata?.modelRequestId,
  };
}

describe("Claude request links across a daemon restart", () => {
  it("restores the task and issuing request of calls made before the resume cursor", async () => {
    fs.writeFileSync(transcriptPath, jsonl([promptLine, toolUseLine]));
    const source1 = new ClaudeSessionEventSource(session());
    const before = await decodeAll(source1, new ClaudeRecordDecoder());
    expect(before.events.some((event) => event.providerUsage !== undefined)).toBe(true);
    const cursor = source1.getCursor() as SourceCursor;
    await source1.close();

    fs.appendFileSync(transcriptPath, jsonl([toolResultLine, finalLine]));
    const source2 = new ClaudeSessionEventSource(session(), cursor);
    const resumed = await decodeAll(source2, new ClaudeRecordDecoder());
    await source2.close();

    // Prefix records are never re-emitted, and the local-only key never reaches event metadata.
    expect(resumed.records).toHaveLength(2);
    for (const event of resumed.events) {
      expect(event.metadata ?? {}).not.toHaveProperty(CLAUDE_REQUEST_LINK_RESUME_KEY);
    }

    const toolResult = resumed.events.find((event) => event.type === "tool_result");
    expect(toolResult?.metadata).toMatchObject({
      taskId: "prompt-uuid-1",
      modelRequestId: "msg_test_1",
      resinInvocationId: INVOCATION_ID,
    });
    expect(toolResult).toMatchObject({ toolName: "mcp__resin__invoke_tool" });
    const finalMessage = resumed.events.find(
      (event) => event.type === "message" && event.metadata?.modelRequestId === "msg_test_2",
    );
    expect(finalMessage?.metadata?.taskId).toBe("prompt-uuid-1");
    // The first request's usage was reported before the restart and is not reported again.
    expect(
      resumed.events
        .filter((event) => event.providerUsage !== undefined)
        .map((event) => event.metadata?.modelRequestId),
    ).toEqual(["msg_test_2"]);

    const uninterrupted = await decodeAll(
      new ClaudeSessionEventSource(session()),
      new ClaudeRecordDecoder(),
    );
    expect(resumed.events.map(links)).toEqual(
      uninterrupted.events.slice(-resumed.events.length).map(links),
    );
  });

  it("ignores a forged resume value and strips the key from the record", () => {
    const decoder = new ClaudeRecordDecoder();
    const record = {
      recordId: "forged-1",
      sessionId: SESSION_ID,
      harnessId: "claude-code",
      sequenceNumber: 1,
      timestamp: "2026-10-01T10:00:02.000Z",
      recordType: "transcript_line" as const,
      rawPayload: toolResultLine,
      cursor: { offset: 1, line: 1, sequence: 1 },
      metadata: {
        [CLAUDE_REQUEST_LINK_RESUME_KEY]: {
          version: 1,
          taskId: "forged-task",
          calls: [["toolu_test_1", "msg_forged", "mcp__resin__invoke_tool"]],
          extra: true,
        },
      },
    };
    const [event] = decoder.decode(record);
    expect(record.metadata).not.toHaveProperty(CLAUDE_REQUEST_LINK_RESUME_KEY);
    expect(event?.metadata?.taskId).toBeUndefined();
    expect(event?.metadata?.modelRequestId).toBeUndefined();
  });

  it("does not prime when the transcript was truncated below the cursor", async () => {
    fs.writeFileSync(transcriptPath, jsonl([promptLine, toolUseLine]));
    const source1 = new ClaudeSessionEventSource(session());
    await source1.readNext(100);
    const cursor = source1.getCursor() as SourceCursor;
    await source1.close();

    fs.writeFileSync(transcriptPath, jsonl([toolResultLine]));
    const source2 = new ClaudeSessionEventSource(session(), cursor);
    const records = await source2.readNext(100);
    await source2.close();
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata).not.toHaveProperty(CLAUDE_REQUEST_LINK_RESUME_KEY);
  });
});
