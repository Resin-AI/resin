import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IntermediateSessionEvent, SourceCursor } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotHarnessAdapter } from "../src/adapter.js";
import { CopilotRecordDecoder } from "../src/decoder.js";

const ROOT = "11111111-2222-4333-8444-555555555555";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const A_SESSION = `${ROOT}:agent:${A}`;
const B_SESSION = `${ROOT}:agent:${B}`;

let home: string;
let eventsPath: string;
let lines: string[];

function event(type: string, n: number, data: Record<string, unknown>, agentId?: string): string {
  return JSON.stringify({
    type,
    data,
    id: `evt-${n}`,
    timestamp: `2026-09-28T10:00:${String(n).padStart(2, "0")}.000Z`,
    parentId: n === 0 ? null : `evt-${n - 1}`,
    ...(agentId ? { agentId } : {}),
  });
}

const toolStart = (n: number, id: string, name: string, args: unknown, agentId?: string) =>
  event(
    "tool.execution_start",
    n,
    { toolCallId: id, toolName: name, arguments: args, turnId: "0" },
    agentId,
  );
const toolDone = (n: number, id: string, output: string, agentId?: string) =>
  event(
    "tool.execution_complete",
    n,
    { toolCallId: id, success: true, result: { content: output } },
    agentId,
  );

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-subagents-"));
  const dir = path.join(home, ".copilot", "session-state", ROOT);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "workspace.yaml"), `id: ${ROOT}\ncwd: /work/demo\n`);
  eventsPath = path.join(dir, "events.jsonl");
  // The main agent runs `task` t1, which starts A; A runs `task` t2, which starts B; B runs bash.
  lines = [
    event("session.start", 0, { context: { cwd: "/work/demo" } }),
    toolStart(1, "t1", "task", { prompt: "outer" }),
    event(
      "subagent.started",
      2,
      { toolCallId: "t1", agentName: "general", agentDescription: "outer" },
      A,
    ),
    toolStart(3, "t2", "task", { prompt: "inner" }, A),
    event(
      "subagent.started",
      4,
      { toolCallId: "t2", agentName: "explore", agentType: "explore" },
      B,
    ),
    toolStart(5, "t3", "bash", { command: "echo inner" }, B),
    toolDone(6, "t3", "inner", B),
    event("subagent.completed", 7, { toolCallId: "t2", agentName: "explore" }, B),
    toolDone(8, "t2", "inner done", A),
    event("subagent.completed", 9, { toolCallId: "t1", agentName: "general" }, A),
    toolDone(10, "t1", "outer done"),
    event("session.shutdown", 11, { shutdownType: "routine" }),
  ];
  await fs.writeFile(eventsPath, `${lines.join("\n")}\n`);
  const old = new Date("2026-09-28T11:00:00Z");
  await fs.utimes(eventsPath, old, old);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function open(sessionId: string, cursor?: SourceCursor) {
  const adapter = new CopilotHarnessAdapter({ home, env: {} });
  const [workspace] = await adapter.listWorkspaces();
  const session = (await adapter.listSessions(workspace!)).find((s) => s.sessionId === sessionId);
  return { adapter, session: session!, source: await adapter.openEventSource(session!, cursor) };
}

async function decode(
  sessionId: string,
  cursor?: SourceCursor,
): Promise<IntermediateSessionEvent[]> {
  const { source } = await open(sessionId, cursor);
  const decoder = new CopilotRecordDecoder();
  const events = (await source.readNext(1000)).flatMap((record) => decoder.decode(record));
  await source.close();
  return events;
}

const toolNames = (events: IntermediateSessionEvent[]) =>
  events.flatMap((e) => (e.type === "tool_call" ? [e.toolName] : []));

describe("copilot nested subagent sessions", () => {
  it("links each subagent to the agent that ran its task call", async () => {
    const adapter = new CopilotHarnessAdapter({ home, env: {} });
    const [workspace] = await adapter.listWorkspaces();
    const byId = new Map((await adapter.listSessions(workspace!)).map((s) => [s.sessionId, s]));
    expect([...byId.keys()].sort()).toEqual([ROOT, A_SESSION, B_SESSION].sort());
    expect(byId.get(ROOT)?.metadata.sessionKind).toBe("user");
    expect(byId.get(A_SESSION)?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: ROOT,
      agentId: A,
      agentName: "general",
      parentToolCallId: "t1",
    });
    expect(byId.get(B_SESSION)?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: A_SESSION,
      agentId: B,
      agentKind: "explore",
      parentToolCallId: "t2",
    });
    // Ids are unique and stable across polls.
    const again = await adapter.listSessions(workspace!);
    expect(again.map((s) => s.sessionId).sort()).toEqual([...byId.keys()].sort());
  });

  it("gives every tool call to exactly one session", async () => {
    const root = await decode(ROOT);
    const a = await decode(A_SESSION);
    const b = await decode(B_SESSION);
    expect(toolNames(root)).toEqual(["task"]);
    expect(toolNames(a)).toEqual(["task"]);
    expect(toolNames(b)).toEqual(["bash"]);
    const callIds = [root, a, b].flatMap((events) =>
      events.flatMap((e) => (e.type === "tool_call" ? [e.callId] : [])),
    );
    expect(new Set(callIds).size).toBe(3);
    // Lifecycle lines go to the spawner: root sees A's, A sees B's, B sees none.
    const lifecycleIds = (events: IntermediateSessionEvent[]) =>
      events.flatMap((e) => (e.type === "subagent_lifecycle" ? [e.producedByCallId] : []));
    expect(lifecycleIds(root)).toEqual(["t1", "t1"]);
    expect(lifecycleIds(a)).toEqual(["t2", "t2"]);
    expect(lifecycleIds(b)).toEqual([]);
  });

  it("routes correctly when a source resumes mid-file", async () => {
    // Cursor just after B's `subagent.started` line: A's own source must still hand B's
    // `subagent.completed` to A, which needs the spawner learned from earlier lines.
    const offset = Buffer.byteLength(`${lines.slice(0, 5).join("\n")}\n`);
    const cursor: SourceCursor = {
      offset,
      line: 5,
      sequence: 5,
      timestamp: "2026-09-28T10:00:04.000Z",
    };
    const resumed = await decode(A_SESSION, cursor);
    expect(
      resumed.flatMap((e) => (e.type === "subagent_lifecycle" ? [e.lifecycleType] : [])),
    ).toEqual(["settle"]);
    expect(toolNames(resumed)).toEqual([]);
    expect(toolNames(await decode(ROOT, cursor))).toEqual([]);
    expect(
      (await decode(ROOT, cursor)).flatMap((e) =>
        e.type === "subagent_lifecycle" ? [e.lifecycleType] : [],
      ),
    ).toEqual(["settle"]);
  });
});
