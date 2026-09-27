import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { MuseHarnessAdapter } from "../src/adapter.js";
import { MuseRecordDecoder } from "../src/decoder.js";
import { discoverMuseSessionLogs } from "../src/discovery.js";
import { MuseSessionEventSource } from "../src/source.js";

const RECORDED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "recorded",
  "1.4.0",
);
const FULL_ID = "01a0e32b-fc8b-7c80-a607-f243653ef38c";
const EXPLORER_ID = "01a0e32c-51c0-7143-bf90-f840deb3756d";
const VERIFY_OBSERVER_ID = "a90941e0-4df6-4edf-96e9-5ec33fd962e7";
const ABORT_ID = "01a0e32c-9aff-72c1-9dfa-b3a6610ae0cd";
const KILL_ID = "01a0e32c-eaea-7092-a1d6-709bb7abd500";

function logPath(scenario: string, sessionId: string, childId?: string): string {
  const dir = path.join(RECORDED, scenario, "sessions", "2026", "09", "27", sessionId);
  return childId
    ? path.join(dir, "subagent", childId, "session.jsonl")
    : path.join(dir, "session.jsonl");
}

async function decodeLog(filePath: string, sessionId: string): Promise<IntermediateSessionEvent[]> {
  const source = new MuseSessionEventSource({ filePath, sessionId });
  const decoder = new MuseRecordDecoder();
  const events: IntermediateSessionEvent[] = [];
  for (;;) {
    const batch = await source.readNext(25);
    if (batch.length === 0) break;
    for (const record of batch) {
      if (decoder.canDecode(record)) events.push(...decoder.decode(record));
    }
  }
  await source.close();
  return events;
}

function ofType<T extends IntermediateSessionEvent["type"]>(
  events: IntermediateSessionEvent[],
  type: T,
): Extract<IntermediateSessionEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<IntermediateSessionEvent, { type: T }> => event.type === type,
  );
}

function usageEvents(events: IntermediateSessionEvent[]) {
  return events.flatMap((event) => (event.providerUsage ? [event.providerUsage] : []));
}

describe("muse 1.4.0 recorded session: tools, MCP, subagents, observers", () => {
  it("discovers the lead log with its subagent and observer children in the recorded workspace", async () => {
    const logs = await discoverMuseSessionLogs(path.join(RECORDED, "full", "sessions"));
    const byId = new Map(logs.map((log) => [log.sessionId, log]));
    expect([...byId.keys()].sort()).toEqual([FULL_ID, EXPLORER_ID, VERIFY_OBSERVER_ID].sort());
    expect(byId.get(FULL_ID)).toMatchObject({
      workspaceRoot: "/workspace/project",
      childKind: null,
    });
    expect(byId.get(EXPLORER_ID)).toMatchObject({
      parentSessionId: FULL_ID,
      childKind: "subagent",
      workspaceRoot: "/workspace/project",
    });
    expect(byId.get(VERIFY_OBSERVER_ID)).toMatchObject({
      parentSessionId: FULL_ID,
      childKind: "observer",
      childAgentId: "verify-reminder",
    });

    const adapter = new MuseHarnessAdapter({
      sessionRoot: path.join(RECORDED, "full", "sessions"),
    });
    const [workspace] = await adapter.listWorkspaces();
    expect(workspace?.rootPath).toBe("/workspace/project");
    const sessions = await adapter.listSessions(workspace!);
    expect(sessions.map((session) => session.metadata.parentSessionId ?? null).sort()).toEqual(
      [FULL_ID, FULL_ID, null].sort(),
    );
  });

  it("decodes built-in, MCP, and delegation calls joined to their results", async () => {
    const events = await decodeLog(logPath("full", FULL_ID), FULL_ID);
    const calls = ofType(events, "tool_call");
    expect(calls.map((call) => [call.toolName, call.connection ?? null])).toEqual([
      ["bash", null],
      ["read_file", null],
      ["edit_file", null],
      ["write_file", null],
      ["add", "demo"],
      ["bash", null],
      ["subagent_spawn", null],
      ["subagent_wait", null],
    ]);
    const results = new Map(
      ofType(events, "tool_result").map((result) => [result.toolName, result]),
    );
    expect(ofType(events, "tool_result")).toHaveLength(8);
    expect(results.get("add")).toMatchObject({ result: "5.0", isError: false });
    expect(ofType(events, "tool_discovery")[0]?.tools).toEqual([{ name: "add", provider: "demo" }]);

    const failing = ofType(events, "tool_result").find((result) =>
      String(result.result).includes('"exit_code": 3'),
    );
    expect(failing?.isError).toBe(true);
    // A shell call is one step: its tool result records how the command ended.
    expect(ofType(events, "command_exec")).toEqual([]);
    expect(
      ofType(events, "file_edit").map((edit) => [
        edit.filePath,
        edit.operation,
        edit.linesAdded,
        edit.linesRemoved,
      ]),
    ).toEqual([
      ["README.md", "update", 1, 1],
      ["hello.py", "create", 1, 0],
    ]);
    expect(
      ofType(events, "message").filter((message) => message.role === "user")[0]?.content,
    ).toContain("Do these steps in order");
  });

  it("links the spawned subagent and background observers to the lead session", async () => {
    const events = await decodeLog(logPath("full", FULL_ID), FULL_ID);
    const lifecycle = ofType(events, "subagent_lifecycle");
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        subagentId: EXPLORER_ID,
        lifecycleType: "spawn",
        role: "subagent",
        parentId: FULL_ID,
      }),
    );
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        subagentId: VERIFY_OBSERVER_ID,
        lifecycleType: "spawn",
        role: "observer:verify-reminder",
      }),
    );
    expect(lifecycle.some((event) => event.role === "observer:skill-reminder")).toBe(true);
    expect(lifecycle.some((event) => event.lifecycleType === "settle")).toBe(true);
  });

  it("counts every model call once, in the lead session and in subagent and observer logs", async () => {
    for (const [filePath, sessionId, modelCalls] of [
      [logPath("full", FULL_ID), FULL_ID, 9],
      [logPath("full", FULL_ID, EXPLORER_ID), EXPLORER_ID, 2],
      [logPath("full", FULL_ID, VERIFY_OBSERVER_ID), VERIFY_OBSERVER_ID, 1],
    ] as const) {
      const usage = usageEvents(await decodeLog(filePath, sessionId));
      expect(usage).toHaveLength(modelCalls);
      for (const entry of usage) {
        expect(entry).toMatchObject({
          provider: "meta",
          model: "muse-spark-1.3-contributor",
          availability: "complete",
        });
        expect(entry.totalTokens).toBe((entry.inputTokens ?? 0) + (entry.outputTokens ?? 0));
      }
    }
  });
});

describe("muse 1.4.0 interrupted side effects are never successes", () => {
  it("a bash call cancelled mid-flight by SIGINT has no success and no command result", async () => {
    const events = await decodeLog(logPath("abort", ABORT_ID), ABORT_ID);
    const [result] = ofType(events, "tool_result");
    expect(result?.toolName).toBe("bash");
    expect(result?.isError).toBe(true);
    expect(result?.metadata?.museOutcome).toBe("unknown");
    expect(ofType(events, "command_exec")).toHaveLength(0);
  });

  it("a call in flight when the process was killed stays unresolved, then resolves to unknown on resume", async () => {
    const before = await decodeLog(
      path.join(RECORDED, "kill", "session.before-resume.jsonl"),
      KILL_ID,
    );
    expect(ofType(before, "tool_call").map((call) => call.toolName)).toEqual(["bash"]);
    expect(ofType(before, "tool_result")).toHaveLength(0);

    const after = await decodeLog(logPath("kill", KILL_ID), KILL_ID);
    const [result] = ofType(after, "tool_result");
    expect(String(result?.result)).toContain("The outcome is unknown");
    expect(result?.isError).toBe(true);
    expect(result?.metadata?.museOutcome).toBe("unknown");
    expect(ofType(after, "command_exec")).toHaveLength(0);
    expect(ofType(after, "session_lifecycle").map((event) => event.lifecycleType)).toContain(
      "resume",
    );
  });
});
