import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessSession, IntermediateSessionEvent } from "@resin/harness-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrokHarnessAdapter } from "../src/adapter.js";
import { GrokRecordDecoder } from "../src/decoder.js";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded", "1.0.13", "sessions");
const PROJECT = "/workspace/project";
const MAIN = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const REWIND = "33333333-3333-4333-8333-333333333333";
const CHILD = "01a0dfee-1b9f-7c33-9932-c0ca2035569f";
const HEADLESS = "44444444-4444-4444-8444-444444444444";

let home: string;
let sessions: Map<string, HarnessSession>;
let adapter: GrokHarnessAdapter;

/** Reads a session through the adapter's own source and decodes it with a fresh decoder. */
async function capture(sessionId: string): Promise<IntermediateSessionEvent[]> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`missing session ${sessionId}`);
  const source = await adapter.openEventSource(session);
  const decoder = new GrokRecordDecoder();
  const events: IntermediateSessionEvent[] = [];
  for (let batch = await source.readNext(50); batch.length > 0; batch = await source.readNext(50)) {
    for (const record of batch) {
      expect(decoder.canDecode(record)).toBe(true);
      events.push(...(decoder.decode(record) ?? []));
    }
  }
  await source.close();
  return events;
}

function userPrompts(events: IntermediateSessionEvent[]): string[] {
  return events.flatMap((e) => (e.type === "message" && e.role === "user" ? [e.content] : []));
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-grok-recorded-"));
  const projectDir = path.join(home, ".grok", "sessions", encodeURIComponent(PROJECT));
  await fs.cp(RECORDED, projectDir, { recursive: true });
  adapter = new GrokHarnessAdapter({ home, env: {} });
  const [workspace] = await adapter.listWorkspaces();
  if (!workspace) throw new Error("no workspace");
  expect(workspace.rootPath).toBe(PROJECT);
  sessions = new Map((await adapter.listSessions(workspace)).map((s) => [s.sessionId, s]));
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("recorded grok 1.0.13 sessions", () => {
  it("decodes headless shell, read, edit, write and MCP steps in order", async () => {
    const events = await capture(MAIN);
    const calls = events.flatMap((e) => (e.type === "tool_call" ? [e] : []));
    expect(calls.map((c) => c.toolName).slice(0, 8)).toEqual([
      "run_terminal_command",
      "read_file",
      "search_replace",
      "write",
      "search_tool",
      "fixture__echo",
      "search_tool",
      "resin__manage_tools",
    ]);
    const echo = calls.find((c) => c.toolName === "fixture__echo");
    expect(echo?.connection).toBe("fixture");
    expect(echo?.parameters).toEqual({ text: "ping" });
    expect(calls.find((c) => c.toolName === "resin__manage_tools")?.connection).toBe("resin");
    expect(calls.find((c) => c.toolName === "read_file")?.connection).toBeUndefined();

    const echoResult = events.find((e) => e.type === "tool_result" && e.callId === echo?.callId);
    expect(echoResult).toMatchObject({
      toolName: "fixture__echo",
      result: "echo: ping",
      isError: false,
    });

    expect(events.find((e) => e.type === "command_exec")).toMatchObject({
      command: "ls",
      exitCode: 0,
      cwd: PROJECT,
    });
    const edits = events.flatMap((e) => (e.type === "file_edit" ? [e] : []));
    expect(edits.map((e) => [path.basename(e.filePath), e.operation])).toEqual([
      ["calc.py", "update"],
      ["NOTES.md", "create"],
    ]);
    // Every result follows its call.
    const order = new Map(events.map((e, i) => [e, i]));
    for (const call of calls) {
      const result = events.find((e) => e.type === "tool_result" && e.callId === call.callId);
      expect(order.get(result as IntermediateSessionEvent)).toBeGreaterThan(order.get(call) ?? -1);
    }
  });

  it("reports each turn's provider usage once", async () => {
    const turns = (await capture(MAIN)).flatMap((e) => (e.type === "session_lifecycle" ? [e] : []));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.providerUsage).toMatchObject({
      provider: "xai",
      model: "grok-4.7",
      availability: "complete",
      inputTokens: 122899,
      outputTokens: 1238,
      totalTokens: 124137,
      cachedInputTokens: 86912,
      reasoningTokens: 995,
      costMicroUsd: 122858,
    });
    // Both turns stopped with `end_turn`, which ends each prompt's execution.
    expect(turns.map((t) => [t.lifecycleType, t.exitReason])).toEqual([
      ["end", "end_turn"],
      ["end", "end_turn"],
    ]);
  });

  it("links the background subagent to its child session", async () => {
    const lifecycle = (await capture(MAIN)).flatMap((e) =>
      e.type === "subagent_lifecycle" ? [[e.lifecycleType, e.subagentId, e.role]] : [],
    );
    expect(lifecycle).toEqual([
      ["spawn", CHILD, "explore"],
      ["end", CHILD, undefined],
    ]);
    expect(sessions.get(CHILD)?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: MAIN,
    });
    expect(userPrompts(await capture(CHILD))[0]).toMatch(/^Count the number of lines/);
  });

  it("captures a --fork-session fork without re-emitting the parent's turns", async () => {
    expect(sessions.get(FORK)?.metadata).toMatchObject({ forkedFromSessionId: MAIN });
    const parent = await capture(MAIN);
    const fork = await capture(FORK);
    expect(fork[0]).toMatchObject({
      type: "branch_fork",
      sourceSessionId: MAIN,
      forkReason: "fork_session",
    });
    expect(userPrompts(fork)).toEqual([
      "Append a new line 'forked' to NOTES.md, then reply 'done'.",
      "/compact",
    ]);
    const parentCallIds = new Set(
      parent.flatMap((e) => (e.type === "tool_call" ? [e.callId] : [])),
    );
    const forkCalls = fork.flatMap((e) => (e.type === "tool_call" ? [e.callId] : []));
    expect(forkCalls).toHaveLength(2);
    expect(forkCalls.filter((id) => parentCallIds.has(id))).toEqual([]);
    expect(fork.find((e) => e.type === "compaction")).toMatchObject({
      tokensBefore: 8838,
      tokensAfter: 6083,
    });
    const compactPrompt = fork.find((e) => e.type === "message" && e.content === "/compact");
    expect(compactPrompt?.metadata).toMatchObject({ hostTurn: true });
  });

  it("resumes a fork from a checkpoint without repeating the fork marker", async () => {
    const session = sessions.get(FORK);
    if (!session) throw new Error("missing fork");
    const first = await adapter.openEventSource(session);
    const head = await first.readNext(3);
    await first.close();
    const resumed = await adapter.openEventSource(session, head[2]?.cursor);
    const rest = await resumed.readNext(500);
    await resumed.close();
    const decoder = new GrokRecordDecoder();
    const types = rest.flatMap((r) => decoder.decode(r) ?? []).map((e) => e.type);
    expect(types).not.toContain("branch_fork");
    expect(rest[0]?.sequenceNumber).toBe(4);
  });

  it("orders an ACP rewind as a branch point between the abandoned and replacement turns", async () => {
    const events = await capture(REWIND);
    const timeline = events.flatMap((e) =>
      e.type === "branch_fork"
        ? [`rewind->${e.divergenceSequence}`]
        : e.type === "message" && e.role === "user"
          ? [e.content.split(" ")[0]]
          : [],
    );
    expect(timeline).toEqual(["Create", "Append", "rewind->1", "Read"]);
    expect(events.find((e) => e.type === "branch_fork")).toMatchObject({ forkReason: "rewind" });
  });

  it("reports a headless run as active until its prompt completes", async () => {
    const running = sessions.get(HEADLESS);
    if (!running) throw new Error("missing headless session");
    const updatesPath = running.transcriptPath;
    const full = await fs.readFile(updatesPath, "utf8");
    const [workspace] = await adapter.listWorkspaces();
    if (!workspace) throw new Error("no workspace");
    const status = async () =>
      (await adapter.listSessions(workspace)).find((s) => s.sessionId === HEADLESS)?.status;
    try {
      // Mid-run: the last prompt has no `turn_completed` yet, and nothing lists it as active.
      await fs.writeFile(
        updatesPath,
        full.slice(0, full.lastIndexOf('"turn_completed"')).replace(/[^\n]*$/, ""),
      );
      expect(await status()).toBe("active");
      await fs.writeFile(updatesPath, full);
      expect(await status()).toBe("completed");
    } finally {
      await fs.writeFile(updatesPath, full);
    }
  });
});
