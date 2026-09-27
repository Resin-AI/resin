import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  IntermediateSessionEvent,
  IntermediateToolCallEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OpencodeHarnessAdapter,
  OpencodeRecordDecoder,
  OpencodeSessionEventSource,
  OpencodeSqliteStore,
  type OpencodeStore,
} from "../src/index.js";
import { drain, rebuildSqliteStore } from "./helpers.js";

const MAIN = "ses_f20121796ffe0LyoT0UzbCFSJ8";
const CHILD = "ses_f20117079ffeyLocki3mfAX4VJ";
const ABORTED = "ses_f2010d9f6ffeDZuibuNQm7Ly7E";

let dir: string;
let store: OpencodeSqliteStore;
const decoder = new OpencodeRecordDecoder({ mcpServers: ["echo"] });

function decodeAll(records: RawHarnessRecord[]): IntermediateSessionEvent[] {
  return records.flatMap((record) => decoder.decode(record));
}

function session(sessionId: string) {
  return {
    sessionId,
    workspaceId: "w",
    harnessId: "opencode",
    transcriptPath: store.location,
    status: "idle" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    metadata: {},
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-opencode-sqlite-"));
  const dbPath = path.join(dir, "opencode.db");
  rebuildSqliteStore(dbPath);
  store = new OpencodeSqliteStore(dbPath);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("OpenCode 1.18.32 recorded SQLite store", () => {
  it("groups sessions by directory and links the subagent session to its parent", async () => {
    const adapter = new OpencodeHarnessAdapter({
      store,
      now: () => Date.parse("2030-01-01T00:00:00Z"),
    });
    const [workspace, ...rest] = await adapter.listWorkspaces();
    expect(rest).toEqual([]);
    expect(workspace!.rootPath).toBe("/workspace/project");
    const sessions = await adapter.listSessions(workspace!);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      [MAIN, CHILD, ABORTED, "ses_f20139019ffeCPb33d7bfYO7Rb"].sort(),
    );
    expect(sessions.find((s) => s.sessionId === CHILD)!.metadata.parentSessionId).toBe(MAIN);
    expect(sessions.every((s) => s.status === "idle")).toBe(true);
  });

  it("decodes shell, read, edit, write, MCP, and subagent tool calls with results", async () => {
    const events = decodeAll(await drain(new OpencodeSessionEventSource(store, session(MAIN))));
    const calls = events.filter((e): e is IntermediateToolCallEvent => e.type === "tool_call");
    expect(calls.map((c) => c.toolName)).toEqual([
      "bash",
      "read",
      "read",
      "edit",
      "write",
      "echo_echo",
      "task",
    ]);
    expect(calls.find((c) => c.toolName === "echo_echo")!.connection).toBe("echo");
    expect(calls.find((c) => c.toolName === "bash")!.connection).toBeUndefined();

    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
    expect(results.find((r) => r.toolName === "echo_echo")).toMatchObject({
      result: "echo: ping",
      isError: false,
    });

    expect(events.find((e) => e.type === "command_exec")).toMatchObject({
      command: "node greet.js",
      exitCode: 0,
      stdout: "hello from greet\n",
      workingDirectory: "/workspace/project",
    });
    const edits = events.filter((e) => e.type === "file_edit");
    expect(edits.map((e) => [e.filePath, e.operation])).toEqual([
      ["/workspace/project/README.md", "update"],
      ["/workspace/project/notes.txt", "create"],
    ]);
    expect(edits[0]).toMatchObject({ diffStats: { linesAdded: 1, linesRemoved: 1 } });
    expect(edits[0]!.diff).toContain("+A tiny demo project for fixtures.");

    const subagent = events.filter((e) => e.type === "subagent_lifecycle");
    expect(subagent.map((e) => [e.lifecycleType, e.subagentId, e.parentId])).toEqual([
      ["spawn", CHILD, MAIN],
      ["settle", CHILD, MAIN],
    ]);
  });

  it("reports per-step provider usage and the manual compaction", async () => {
    const events = decodeAll(await drain(new OpencodeSessionEventSource(store, session(MAIN))));
    const assistant = events.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistant).toHaveLength(8);
    expect(assistant[1]!.providerUsage).toEqual({
      provider: "opencode",
      model: "nemotron-3.5-lightning-free",
      accountingVersion: "opencode-message-tokens-v1",
      availability: "complete",
      inputTokens: 2271,
      outputTokens: 37,
      reasoningTokens: 18,
      cachedInputTokens: 8704,
      totalTokens: 11030,
      costMicroUsd: 0,
      costProvenance: "harness_estimate",
      durationMs: 711,
    });
    const compactionIndex = events.findIndex((e) => e.type === "compaction");
    expect(events[compactionIndex]).toMatchObject({ triggerReason: "manual" });
    const summary = assistant.at(-1)!;
    expect(summary.metadata?.compactionSummary).toBe(true);
    expect(events.indexOf(summary)).toBeGreaterThan(compactionIndex);
  });

  it("marks the child session as a subagent of its parent", async () => {
    const events = decodeAll(await drain(new OpencodeSessionEventSource(store, session(CHILD))));
    expect(events[0]).toMatchObject({
      type: "session_lifecycle",
      lifecycleType: "start",
      metadata: { parentSessionId: MAIN, harnessVersion: "1.18.32" },
    });
    expect(events[1]).toMatchObject({
      type: "subagent_lifecycle",
      subagentId: CHILD,
      parentId: MAIN,
    });
    expect(events.at(-1)).toMatchObject({
      role: "assistant",
      content: 'console.log("hello from greet");',
    });
  });

  it("emits the call of a tool interrupted by killing opencode, without a result", async () => {
    const events = decodeAll(await drain(new OpencodeSessionEventSource(store, session(ABORTED))));
    expect(events.map((e) => e.type)).toEqual([
      "session_lifecycle",
      "message",
      "model_reasoning",
      "tool_call",
    ]);
    expect(events[3]).toMatchObject({ toolName: "bash", input: { command: "sleep 120" } });
  });

  it("resumes from a checkpoint cursor without repeating or skipping records", async () => {
    const all = await drain(new OpencodeSessionEventSource(store, session(MAIN)));
    const first = new OpencodeSessionEventSource(store, session(MAIN));
    const head = await first.readNext(10);
    const resumed = await drain(
      new OpencodeSessionEventSource(store, session(MAIN), head.at(-1)!.cursor),
    );
    expect([...head, ...resumed].map((r) => r.recordId)).toEqual(all.map((r) => r.recordId));
    expect(new Set(all.map((r) => r.recordId)).size).toBe(all.length);
  });

  it("decodes the same events from table snapshots when no event log is available", async () => {
    const snapshotOnly: OpencodeStore = {
      kind: "sqlite",
      location: store.location,
      listSessions: () => store.listSessions(),
      readSession: (id) => store.readSession(id),
      readEvents: () => null,
    };
    for (const id of [MAIN, CHILD]) {
      const fromEvents = decodeAll(await drain(new OpencodeSessionEventSource(store, session(id))));
      const fromSnapshot = decodeAll(
        await drain(new OpencodeSessionEventSource(snapshotOnly, session(id))),
      );
      expect(fromSnapshot).toEqual(fromEvents);
    }
  });
});
