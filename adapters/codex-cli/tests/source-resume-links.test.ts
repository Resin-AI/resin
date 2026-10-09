import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IntermediateSessionEvent,
  RawHarnessRecord,
  SourceCursor,
} from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_REQUEST_LINK_RESUME_KEY, CodexRecordDecoder } from "../src/decoder.js";
import { CodexSessionEventSource } from "../src/source.js";

const SESSION_ID = "codex-resume-links-session";
const THREAD = "01a0e200-0000-7000-8000-000000000001";
const TURN = "01a0e200-0000-7000-8000-0000000000a1";
const CALL_1 = "call_sample_1";
const CALL_2 = "call_sample_2";
const passthrough = { internal_chat_message_metadata_passthrough: { turn_id: TURN } };

let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 10, 0, clock++)).toISOString();

const sessionMeta = () => ({
  timestamp: at(),
  type: "session_meta",
  payload: { id: THREAD, session_id: THREAD, cwd: "/sample", model_provider: "example-provider" },
});
const taskStarted = () => ({
  timestamp: at(),
  type: "event_msg",
  payload: { type: "task_started", turn_id: TURN },
});
const turnContext = () => ({
  timestamp: at(),
  type: "turn_context",
  payload: { turn_id: TURN, cwd: "/sample", model: "example-model", effort: "low" },
});
const userPrompt = () => ({
  timestamp: at(),
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Print a greeting." }],
    ...passthrough,
  },
});
const execCall = (callId: string) => ({
  timestamp: at(),
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    id: `ctc_${callId}`,
    status: "completed",
    call_id: callId,
    name: "exec",
    input: 'text("hello");\n',
    ...passthrough,
  },
});
const execOutput = (callId: string) => ({
  timestamp: at(),
  type: "response_item",
  payload: {
    type: "custom_tool_call_output",
    id: `ctco_${callId}`,
    call_id: callId,
    output: [
      { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: "hello" },
    ],
    ...passthrough,
  },
});
const usage = (input: number) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
  total_tokens: input + 5,
});
const usageRecord = (responseId: string, input: number) => ({
  timestamp: at(),
  type: "token_usage_record",
  payload: {
    thread_id: THREAD,
    turn_id: TURN,
    session_id: THREAD,
    response_id: responseId,
    usage: usage(input),
  },
});
const tokenCount = () => ({
  timestamp: at(),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { last_token_usage: usage(200), total_token_usage: usage(300) },
  },
});
const taskComplete = () => ({
  timestamp: at(),
  type: "event_msg",
  payload: { type: "task_complete", turn_id: TURN },
});

let dir: string;
let filePath: string;

beforeEach(() => {
  clock = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-codex-resume-links-"));
  filePath = path.join(dir, "rollout.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const jsonl = (lines: object[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

const openSource = (initialCursor?: SourceCursor) =>
  new CodexSessionEventSource({
    filePath,
    sessionId: SESSION_ID,
    ...(initialCursor === undefined ? {} : { initialCursor }),
  });

/** Every record a source can emit, each with the events one decoder produced for it. */
async function decodeAll(
  source: CodexSessionEventSource,
): Promise<Array<{ record: RawHarnessRecord; events: IntermediateSessionEvent[] }>> {
  const decoder = new CodexRecordDecoder();
  const records = await source.readNext(1000);
  await source.close();
  return records.map((record) => ({ record, events: decoder.decode(record) }));
}

const isRequest = (event: IntermediateSessionEvent) =>
  event.type === "session_lifecycle" && event.providerUsage?.usageScope === "request";

/** The link and usage view of the events that carry either: what a restart must not change. */
function linkView(events: IntermediateSessionEvent[]) {
  return events
    .filter(
      (event) =>
        event.metadata?.taskId !== undefined ||
        event.metadata?.modelRequestId !== undefined ||
        event.providerUsage !== undefined,
    )
    .map((event) => ({
      type: event.type,
      callId: "callId" in event ? event.callId : undefined,
      taskId: event.metadata?.taskId,
      modelRequestId: event.metadata?.modelRequestId,
      usage:
        event.providerUsage === undefined
          ? undefined
          : {
              provider: event.providerUsage.provider,
              model: event.providerUsage.model,
              requestId: event.providerUsage.requestId,
              usageScope: event.providerUsage.usageScope,
              totalTokens: event.providerUsage.totalTokens,
            },
    }));
}

describe("Codex native link state across a daemon restart", () => {
  it("restores turn, model and provider for records after the resume cursor", async () => {
    fs.writeFileSync(
      filePath,
      jsonl([
        sessionMeta(),
        taskStarted(),
        turnContext(),
        userPrompt(),
        execCall(CALL_1),
        usageRecord("resp_sample_1", 100),
      ]),
    );
    const source1 = openSource();
    const before = await decodeAll(source1);
    const cursor = source1.getCursor() as SourceCursor;
    expect(before.flatMap(({ events }) => events).filter(isRequest)).toHaveLength(1);

    fs.appendFileSync(
      filePath,
      jsonl([
        execOutput(CALL_1),
        execCall(CALL_2),
        usageRecord("resp_sample_2", 150),
        execOutput(CALL_2),
        tokenCount(),
        taskComplete(),
      ]),
    );
    const resumedDecoded = await decodeAll(openSource(cursor));
    const resumed = resumedDecoded.flatMap(({ events }) => events);

    // Prefix records are never re-emitted; the local-only key never reaches event metadata.
    expect(resumedDecoded).toHaveLength(6);
    for (const event of resumed) {
      expect(event.metadata ?? {}).not.toHaveProperty(CODEX_REQUEST_LINK_RESUME_KEY);
    }
    for (const { record } of resumedDecoded) {
      expect(record.metadata).not.toHaveProperty(CODEX_REQUEST_LINK_RESUME_KEY);
    }

    const requests = resumed.filter(isRequest);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.providerUsage).toMatchObject({
      provider: "example-provider",
      model: "example-model",
      requestId: "resp_sample_2",
    });
    expect(requests[0]?.metadata).toMatchObject({
      taskId: TURN,
      modelRequestId: "resp_sample_2",
    });
    const outputs = resumed.filter((event) => event.type === "tool_result");
    expect(outputs.map((event) => ("callId" in event ? event.callId : undefined))).toEqual([
      CALL_1,
      CALL_2,
    ]);
    expect(outputs.map((event) => event.metadata?.taskId)).toEqual([TURN, TURN]);
    const calls = resumed.filter((event) => event.type === "tool_call");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((event) => event.metadata?.taskId === TURN)).toBe(true);
    // The first request's usage was reported before the restart; the turn end repeats none.
    expect(resumed.filter((event) => event.providerUsage !== undefined)).toEqual(requests);

    const uninterrupted = (await decodeAll(openSource()))
      .filter(({ record }) => record.cursor.offset > cursor.offset)
      .flatMap(({ events }) => events);
    // The call issued before the cursor is not paired with its output after a restart (its tool
    // state is not link state), so its output is compared by task above, not by full view.
    const withoutPrefixCall = (events: IntermediateSessionEvent[]) =>
      events.filter((event) => !("callId" in event) || event.callId !== CALL_1);
    expect(linkView(withoutPrefixCall(resumed))).toEqual(
      linkView(withoutPrefixCall(uninterrupted)),
    );
  });

  it("ignores a forged resume value and strips the key from the record", () => {
    const decoder = new CodexRecordDecoder();
    const record: RawHarnessRecord = {
      recordId: "rec_1",
      sessionId: SESSION_ID,
      harnessId: "codex-cli",
      sequenceNumber: 1,
      timestamp: "2026-10-01T10:00:00.000Z",
      recordType: "custom",
      rawPayload: usageRecord("resp_forged", 100),
      cursor: { offset: 1, line: 2, sequence: 1 },
      metadata: {
        [CODEX_REQUEST_LINK_RESUME_KEY]: {
          version: 1,
          contexts: [[THREAD, { threadId: THREAD, modelProvider: "forged-provider" }]],
          requestUsageTurns: [],
          seenSessionMeta: true,
          extra: true,
        },
      },
    };
    const [request] = decoder.decode(record).filter(isRequest);
    expect(record.metadata).not.toHaveProperty(CODEX_REQUEST_LINK_RESUME_KEY);
    expect(request?.metadata ?? {}).not.toHaveProperty(CODEX_REQUEST_LINK_RESUME_KEY);
    expect(request?.providerUsage?.provider).not.toBe("forged-provider");
  });

  it("does not prime when the rollout was truncated below the cursor", async () => {
    fs.writeFileSync(filePath, jsonl([sessionMeta(), taskStarted(), turnContext(), userPrompt()]));
    const source1 = openSource();
    await source1.readNext(1000);
    const cursor = source1.getCursor() as SourceCursor;
    await source1.close();

    fs.writeFileSync(filePath, jsonl([usageRecord("resp_sample_3", 100)]));
    const source2 = openSource(cursor);
    const records = await source2.readNext(1000);
    await source2.close();
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata).not.toHaveProperty(CODEX_REQUEST_LINK_RESUME_KEY);
  });
});
