import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessSession, IntermediateSessionEvent } from "@resin/harness-contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
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
const QUIET_SHELL = "01a0e65d-4386-71e0-998f-f657b7831b24";

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

    // A shell call is one step: its tool result records how the command ended.
    expect(events.find((e) => e.type === "command_exec")).toBeUndefined();
    const edits = events.flatMap((e) => (e.type === "file_edit" ? [e] : []));
    const callIds = new Set(calls.map((call) => call.callId));
    for (const edit of edits) expect(callIds.has(edit.producedByCallId ?? "")).toBe(true);
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
      ["settle", CHILD, undefined],
    ]);
    expect(sessions.get(CHILD)?.metadata).toMatchObject({
      sessionKind: "agent",
      parentSessionId: MAIN,
      agentId: CHILD,
      agentName: "explore",
      agentKind: "explore",
    });
    expect(sessions.get(MAIN)?.metadata.sessionKind).toBe("user");
    expect(sessions.get(MAIN)?.metadata.parentSessionId).toBeUndefined();
    expect(userPrompts(await capture(CHILD))[0]).toMatch(/^Count the number of lines/);
  });

  it("counts the child's tool calls and usage in the child only", async () => {
    const parent = await capture(MAIN);
    const child = await capture(CHILD);
    const callsOf = (events: IntermediateSessionEvent[]) =>
      events.flatMap((e) => (e.type === "tool_call" ? [e] : []));
    // The child read README.md itself; the parent only spawned and awaited it.
    expect(callsOf(child).map((c) => c.toolName)).toEqual(["read_file"]);
    const parentCallIds = new Set(callsOf(parent).map((c) => c.callId));
    for (const call of callsOf(child)) expect(parentCallIds.has(call.callId)).toBe(false);
    expect(callsOf(parent).filter((c) => c.toolName === "read_file")).toHaveLength(1);
    const parentResults = parent.flatMap((e) => (e.type === "tool_result" ? [e] : []));
    const childResultIds = child.flatMap((e) => (e.type === "tool_result" ? [e.callId] : []));
    expect(childResultIds).toHaveLength(1);
    for (const id of childResultIds) {
      expect(parentResults.some((r) => r.callId === id)).toBe(false);
    }
    // Turn usage is the sum of each session's own turn_completed; the parent's `subagent_finished`
    // token count and its awaited-output summary add nothing to it.
    const usageOf = (events: IntermediateSessionEvent[]) =>
      events.flatMap((e) =>
        e.type === "session_lifecycle" && e.providerUsage ? [e.providerUsage.totalTokens] : [],
      );
    expect(usageOf(child)).toEqual([12789]);
    expect(usageOf(parent)).toEqual([124137, 64290]);
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
    // A fresh adapter per check: Windows' CopyFile keeps the fixtures' old mtimes, so the shared
    // adapter's cache treats them as settled and would re-stat them only after a minute.
    const status = async () =>
      (await new GrokHarnessAdapter({ home, env: {} }).listSessions(workspace)).find(
        (s) => s.sessionId === HEADLESS,
      )?.status;
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

  it("records a shell command's own output, even when it printed nothing", async () => {
    // Code-stats run whose first command redirects everything into src-stats.txt: Grok shows the
    // model `exit: 0` for it, but the command printed nothing.
    const events = await capture(QUIET_SHELL);
    const results = events.flatMap((e) => (e.type === "tool_result" ? [e] : []));
    expect(results.map((r) => [r.toolName, r.result, r.isError])).toEqual([
      ["run_terminal_command", "", false],
      ["run_terminal_command", "src/a.py\t1\t5\nsrc/b.py\t1\t7\n", false],
    ]);
  });

  it("proves exit 0 only for a foreground shell run", () => {
    const decoder = new GrokRecordDecoder();
    const record = (sequenceNumber: number, update: object) => ({
      recordId: `r${sequenceNumber}`,
      sessionId: "s",
      harnessId: "grok-build",
      sequenceNumber,
      recordType: "transcript_line" as const,
      timestamp: "2026-09-28T00:00:00.000Z",
      rawPayload: { method: "session/update", params: { sessionId: "s", update } },
      cursor: {
        offset: sequenceNumber,
        line: sequenceNumber,
        sequence: sequenceNumber,
        timestamp: "",
      },
      metadata: {},
    });
    const markers = [false, true].map((background, index) => {
      const callId = `call-${index}`;
      decoder.decode(
        record(index * 2, {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: "run_terminal_command",
          rawInput: { variant: "Bash", command: "make build", is_background: background },
          _meta: { "x.ai/tool": { name: "run_terminal_command", namespace: "grok_build" } },
        }),
      );
      const [result] =
        decoder.decode(
          record(index * 2 + 1, {
            sessionUpdate: "tool_call_update",
            toolCallId: callId,
            status: "completed",
            rawOutput: { type: "Bash", output: [], exit_code: 0 },
          }),
        ) ?? [];
      return result?.type === "tool_result"
        ? result.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY]
        : "no result";
    });
    expect(markers).toEqual(["shell-exited-0", undefined]);
  });

  it("records an argument-less tool_call with the input a later update carries", () => {
    const decoder = new GrokRecordDecoder();
    let sequence = 0;
    const decode = (update: object) =>
      decoder.decode({
        recordId: `r${sequence}`,
        sessionId: "s",
        harnessId: "grok-build",
        sequenceNumber: sequence,
        recordType: "transcript_line" as const,
        timestamp: "2026-09-28T00:00:00.000Z",
        rawPayload: { method: "session/update", params: { sessionId: "s", update } },
        cursor: { offset: sequence, line: sequence, sequence: sequence++, timestamp: "" },
        metadata: {},
      }) ?? [];
    const shellMeta = { "x.ai/tool": { name: "run_terminal_command", namespace: "grok_build" } };
    const useToolMeta = { "x.ai/tool": { name: "use_tool", namespace: "grok_build" } };
    const opened = [
      decode({ sessionUpdate: "tool_call", toolCallId: "sh", title: "run_terminal_command", _meta: shellMeta }),
      decode({ sessionUpdate: "tool_call", toolCallId: "mcp", title: "use_tool", _meta: useToolMeta }),
      decode({ sessionUpdate: "tool_call", toolCallId: "bare", title: "list_dir", _meta: {} }),
    ];
    expect(opened).toEqual([[], [], []]);

    // Grok's updates restate the input with its serde tag (`variant`) and filled defaults.
    const shellCall = decode({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh",
      _meta: shellMeta,
      rawInput: { variant: "Bash", command: "ls", is_background: false },
    });
    const mcpCall = decode({
      sessionUpdate: "tool_call_update",
      toolCallId: "mcp",
      _meta: useToolMeta,
      rawInput: { variant: "UseTool", tool_name: "fixture__echo", tool_input: { text: "ping" } },
    });
    const shellDone = decode({
      sessionUpdate: "tool_call_update",
      toolCallId: "sh",
      status: "completed",
      rawOutput: { type: "Bash", output: [], exit_code: 0 },
    });
    const bareDone = decode({
      sessionUpdate: "tool_call_update",
      toolCallId: "bare",
      status: "completed",
      rawOutput: { text: "a.py" },
    });

    expect(shellCall).toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: "sh",
        toolName: "run_terminal_command",
        parameters: { command: "ls", is_background: false },
        metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "grok-shell" },
      }),
    ]);
    expect(mcpCall).toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: "mcp",
        toolName: "fixture__echo",
        connection: "fixture",
        parameters: { text: "ping" },
      }),
    ]);
    expect(shellDone.map((e) => e.type)).toEqual(["tool_result"]);
    expect(shellDone[0]).toMatchObject({
      toolName: "run_terminal_command",
      metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "shell-exited-0" },
    });
    // A call no update ever completed is still recorded, with its result, and no arguments.
    expect(bareDone).toEqual([
      expect.objectContaining({ type: "tool_call", callId: "bare", toolName: "list_dir", parameters: {} }),
      expect.objectContaining({ type: "tool_result", callId: "bare", toolName: "list_dir", result: "a.py" }),
    ]);
  });
});
