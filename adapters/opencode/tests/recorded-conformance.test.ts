import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NormalizedSessionEventSchema,
  RESIN_ASSISTANT_STOP_REASON_METADATA_KEY,
  parseAssistantStopReason,
} from "@resin/contracts";
import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OpencodeRecordDecoder,
  OpencodeSessionEventSource,
  OpencodeSqliteStore,
} from "../src/index.js";
import { RECORDED_DIR, drain, rebuildSqliteStore } from "./helpers.js";

// A resin-bench conformance run on OpenCode 1.18.32: one prompt, a glob/read/bash tool loop,
// and a final "stop" answer.
const EXPORT = path.join(RECORDED_DIR, "1.18.32", "conformance-db.jsonl");
const SESSION = "ses_f1febf0d6ffeBBYkJUgZzsHtbx";

let dir: string;
let events: IntermediateSessionEvent[];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-opencode-conformance-"));
  const dbPath = path.join(dir, "opencode.db");
  rebuildSqliteStore(dbPath, EXPORT);
  const store = new OpencodeSqliteStore(dbPath);
  const records = await drain(
    new OpencodeSessionEventSource(store, {
      sessionId: SESSION,
      workspaceId: "w",
      harnessId: "opencode",
      transcriptPath: store.location,
      status: "idle",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: {},
    }),
  );
  const decoder = new OpencodeRecordDecoder();
  events = records.flatMap((record) => decoder.decode(record));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("OpenCode 1.18.32 conformance session", () => {
  it("decodes every event into a valid normalized event", () => {
    // The observer dead-letters anything failing the normalized schema; tool calls, results and
    // reasoning used to be dropped this way, leaving the cloud nothing to detect.
    events.forEach((event, index) => {
      const parsed = NormalizedSessionEventSchema.safeParse({
        schemaVersion: "1.0.0",
        eventId: `evt_${index}`,
        causalRef: { parentId: null, causalSequence: index + 1 },
        redaction: { isRedacted: false },
        ...event,
      });
      expect(parsed.error?.issues, `${event.type} #${index}`).toBeUndefined();
    });
    const count = (type: string) => events.filter((event) => event.type === type).length;
    expect(count("tool_call")).toBe(16);
    expect(count("tool_result")).toBe(16);
    expect(count("command_exec")).toBe(0);
    expect(count("model_reasoning")).toBe(17);
  });

  it("records a bash call that exited non-zero as a failed step", () => {
    // The bash tool result is the only record of the command, so it carries the exit status.
    const bash = events.flatMap((e) =>
      e.type === "tool_result" && e.toolName === "bash" ? [[e.isError, e.error ?? null]] : [],
    );
    expect(bash).toContainEqual([true, "exit code 2"]);
    expect(bash).toContainEqual([true, "exit code 1"]);
    expect(bash).toContainEqual([false, null]);
  });

  it("pairs every tool result with its call", () => {
    const callIds = events.flatMap((e) => (e.type === "tool_call" ? [e.callId] : []));
    const resultIds = events.flatMap((e) => (e.type === "tool_result" ? [e.callId] : []));
    expect(callIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(resultIds).toEqual(callIds);
  });

  it("marks only the final answer as a completed assistant turn", () => {
    const assistants = events.filter((e) => e.type === "message" && e.role === "assistant");
    const completed = assistants.filter(
      (e) =>
        parseAssistantStopReason(e.metadata?.[RESIN_ASSISTANT_STOP_REASON_METADATA_KEY]) !==
        undefined,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBe(assistants.at(-1));
  });
});
