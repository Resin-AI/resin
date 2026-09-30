import * as fs from "node:fs/promises";
import * as os from "node:os";
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
      childAgentName: "verify-reminder",
    });
    expect(byId.get(EXPLORER_ID)).toMatchObject({ childAgentName: "explorer" });

    const adapter = new MuseHarnessAdapter({
      sessionRoot: path.join(RECORDED, "full", "sessions"),
    });
    const [workspace] = await adapter.listWorkspaces();
    expect(workspace?.rootPath).toBe("/workspace/project");
    const sessions = await adapter.listSessions(workspace!);
    const meta = new Map(sessions.map((session) => [session.sessionId, session.metadata]));
    expect(meta.get(FULL_ID)).toMatchObject({ sessionKind: "user" });
    expect(meta.get(FULL_ID)?.parentSessionId).toBeUndefined();
    expect(meta.get(EXPLORER_ID)).toMatchObject({
      sessionKind: "agent",
      parentSessionId: FULL_ID,
      agentName: "explorer",
      agentKind: "subagent",
      agentId: "01a0e32c-51a2-7eb2-bb4a-9d7fe3898afc",
    });
    expect(meta.get(VERIFY_OBSERVER_ID)).toMatchObject({
      sessionKind: "agent",
      parentSessionId: FULL_ID,
      agentName: "verify-reminder",
      agentKind: "observer",
    });
  });

  it("counts a subagent's tool calls once, in the child log and not in the lead's", async () => {
    const lead = await decodeLog(logPath("full", FULL_ID), FULL_ID);
    const child = await decodeLog(logPath("full", FULL_ID, EXPLORER_ID), EXPLORER_ID);
    const childCalls = ofType(child, "tool_call");
    expect(childCalls.map((call) => call.toolName)).toEqual(["bash"]);
    expect(ofType(child, "tool_result").map((result) => result.callId)).toEqual(
      childCalls.map((call) => call.callId),
    );
    const leadIds = new Set(
      [...ofType(lead, "tool_call"), ...ofType(lead, "tool_result")].map((event) => event.callId),
    );
    for (const call of childCalls) expect(leadIds.has(call.callId)).toBe(false);
    // The lead only records the delegation and the wait, plus its own steps.
    expect(
      ofType(lead, "tool_call").filter((call) => call.toolName === "subagent_spawn"),
    ).toHaveLength(1);
    // The aggregate usage muse embeds in the lead (runtime_observed) is not counted on the lead.
    expect(usageEvents(lead)).toHaveLength(9);
  });

  it("links a subagent's own child to the subagent, not to the lead", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-nested-"));
    try {
      const dir = path.join(root, "2026", "09", "27", "lead-1");
      const record = (payloadType: string, body: Record<string, unknown>) =>
        `${JSON.stringify({ payload_type: payloadType, payload: { record: body } })}\n`;
      await fs.mkdir(path.join(dir, "subagent", "child-1", "subagent", "grand-1"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dir, "session.jsonl"),
        record("subagent.control.resume_context_recorded", {
          subagent_id: "sa-1",
          role: "explorer",
        }) +
          record("subagent.control.child_session_bound", {
            child_session_id: "child-1",
            subagent_id: "sa-1",
          }),
      );
      await fs.writeFile(
        path.join(dir, "subagent", "child-1", "session.jsonl"),
        record("subagent.control.resume_context_recorded", {
          subagent_id: "sa-2",
          role: "worker",
        }) +
          record("subagent.control.child_session_bound", {
            child_session_id: "grand-1",
            subagent_id: "sa-2",
          }),
      );
      await fs.writeFile(
        path.join(dir, "subagent", "child-1", "subagent", "grand-1", "session.jsonl"),
        "",
      );
      const logs = await discoverMuseSessionLogs(root);
      const byId = new Map(logs.map((log) => [log.sessionId, log]));
      expect(byId.get("child-1")).toMatchObject({
        parentSessionId: "lead-1",
        childAgentName: "explorer",
      });
      expect(byId.get("grand-1")).toMatchObject({
        parentSessionId: "child-1",
        childAgentName: "worker",
      });
      expect(byId.get("lead-1")?.parentSessionId).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

  it("links the spawned subagent to the lead session and keeps background observers out of it", async () => {
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
    expect(lifecycle.some((event) => event.lifecycleType === "settle")).toBe(true);
    expect(lifecycle.map((event) => event.subagentId)).not.toContain(VERIFY_OBSERVER_ID);
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

describe("muse 1.4.0 recorded text-normalization run: only the agent's own steps", () => {
  const NORMALIZE_ID = "01a0e645-0cc9-78d0-a3ae-016e8021d2b6";
  const normalizeLog = path.join(
    RECORDED,
    "normalize",
    "sessions",
    "2026",
    "09",
    "28",
    NORMALIZE_ID,
    "session.jsonl",
  );

  // Muse links a skill-reminder observer before most model turns and a verify-reminder at the end.
  // Decoded as spawns, each became a standalone step of the learned workflow with no call behind it,
  // so no muse run could reconcile with its recording and nothing was ever learned from muse.
  it("decodes the bash steps with their results and no observer spawns between them", async () => {
    const events = await decodeLog(normalizeLog, NORMALIZE_ID);
    expect(ofType(events, "subagent_lifecycle")).toEqual([]);
    const calls = ofType(events, "tool_call");
    expect(calls.map((call) => call.toolName)).toEqual(["bash", "bash"]);
    expect(String(calls[1]?.parameters.command)).toMatch(/^tr .* \| sed .* > out1\.txt/);
    const results = ofType(events, "tool_result");
    expect(results.map((result) => [result.callId, result.isError])).toEqual(
      calls.map((call) => [call.callId, false]),
    );
    expect(String(results[1]?.result)).toContain('"exit_code": 0');
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
