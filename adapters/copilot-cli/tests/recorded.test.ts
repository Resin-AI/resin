import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderReportedUsageSchema } from "@resin/contracts";
import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotHarnessAdapter } from "../src/adapter.js";
import { CopilotRecordDecoder } from "../src/decoder.js";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded", "1.0.88", "session-state");
const BASIC = "4842b6bb-0529-4e1b-ba95-cb76fd815f52";
const LIST_CHANGED = "96d45076-f850-4775-8447-25e3b47da524";
const ABORTED = "aabf7bd1-e888-432f-bca8-414de2b191d2";
const KILLED = "56ef3192-776c-4782-b447-0a3701dc9dd8";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-recorded-"));
  await fs.cp(RECORDED, path.join(home, ".copilot", "session-state"), { recursive: true });
  // Recorded sessions are old: nothing is still being written.
  const old = new Date("2026-09-26T23:30:00Z");
  for (const id of [BASIC, LIST_CHANGED, ABORTED, KILLED]) {
    await fs.utimes(path.join(home, ".copilot", "session-state", id, "events.jsonl"), old, old);
  }
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function decodeSession(sessionId: string): Promise<IntermediateSessionEvent[]> {
  const adapter = new CopilotHarnessAdapter({ home, env: {} });
  const [workspace] = await adapter.listWorkspaces();
  const session = (await adapter.listSessions(workspace!)).find((s) => s.sessionId === sessionId);
  const source = await adapter.openEventSource(session!);
  const decoder = new CopilotRecordDecoder();
  const events: IntermediateSessionEvent[] = [];
  for (;;) {
    const batch = await source.readNext(7);
    if (batch.length === 0) break;
    for (const record of batch) events.push(...decoder.decode(record));
  }
  await source.close();
  return events;
}

function ofType<T extends IntermediateSessionEvent["type"]>(
  events: IntermediateSessionEvent[],
  type: T,
): Extract<IntermediateSessionEvent, { type: T }>[] {
  return events.filter((e): e is Extract<IntermediateSessionEvent, { type: T }> => e.type === type);
}

describe("Copilot CLI 1.0.88 recorded sessions", () => {
  it("discovers the recorded sessions in one workspace with lifecycle status", async () => {
    const adapter = new CopilotHarnessAdapter({
      home,
      env: {},
      now: () => Date.parse("2026-09-27T00:00:00Z"),
    });
    const workspaces = await adapter.listWorkspaces();
    expect(workspaces.map((w) => w.rootPath)).toEqual(["/workspace/project"]);
    const status = Object.fromEntries(
      (await adapter.listSessions(workspaces[0]!)).map((s) => [s.sessionId, s.status]),
    );
    expect(status).toEqual({
      [BASIC]: "completed",
      [LIST_CHANGED]: "completed",
      // Ctrl+C still shuts down cleanly; a killed process leaves the log without a shutdown.
      [ABORTED]: "completed",
      [KILLED]: "interrupted",
    });
  });

  it("captures exact built-in and MCP tool arguments and results", async () => {
    const events = await decodeSession(BASIC);
    const calls = ofType(events, "tool_call");
    expect(calls.map((c) => [c.toolName, c.connection ?? null])).toEqual([
      ["bash", null],
      ["view", null],
      ["view", null],
      ["apply_patch", null],
      ["apply_patch", null],
      ["echo_upper", "fixture"],
    ]);
    expect(calls[0]!.input).toEqual({ command: "python3 calc.py", description: "Run calc.py" });
    expect(calls[1]!.input).toEqual({ path: "/workspace/project/README.md" });
    expect(calls[3]!.rawInput).toBe(
      "*** Begin Patch\n*** Update File: calc.py\n@@\n def add(a, b):\n-    return a + b\n+    return b + a\n \n print(add(2, 3))\n*** End Patch\n",
    );
    expect(calls[5]!.input).toEqual({ text: "resin" });

    const results = ofType(events, "tool_result");
    expect(results.map((r) => [r.toolCallId, r.output, r.isError])).toEqual(
      calls.map((c, i) => [
        c.toolCallId,
        [
          "5\n<shellId: 0 completed with exit code 0>",
          "# Demo\nTiny demo project.\n",
          "def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n",
          "Modified 1 file(s): /workspace/project/calc.py",
          "Added 1 file(s): /workspace/project/notes.txt",
          "RESIN",
        ][i],
        false,
      ]),
    );

    expect(ofType(events, "command_exec")).toMatchObject([
      { command: "python3 calc.py", exitCode: 0 },
    ]);
    expect(
      ofType(events, "file_edit").map((e) => [e.filePath, e.action, e.linesAdded, e.linesRemoved]),
    ).toEqual([
      ["calc.py", "update", 1, 1],
      ["notes.txt", "create", 1, 0],
    ]);
    expect(ofType(events, "message").map((m) => [m.role, m.content])).toEqual([
      [
        "user",
        "Do these steps in order: 1) run the shell command 'python3 calc.py'; 2) read README.md; 3) edit calc.py to change 'return a + b' to 'return b + a'; 4) create notes.txt containing 'hello'; 5) call the fixture MCP tool echo_upper with text 'resin'. Then reply done.",
      ],
      ["assistant", "done"],
    ]);
  });

  it("reports the run's token usage on session end", async () => {
    const events = await decodeSession(BASIC);
    const ends = ofType(events, "session_lifecycle").filter((e) => e.lifecycleType === "end");
    expect(ends).toHaveLength(1);
    const usage = ProviderReportedUsageSchema.parse(ends[0]!.providerUsage);
    // Matches the CLI's own summary: "↑ 96.7k (82.7k cached, 14.0k written) • ↓ 252 (52 reasoning)".
    expect(usage).toMatchObject({
      provider: "github-copilot",
      model: "gpt-6-luna",
      availability: "complete",
      inputTokens: 96_733,
      cachedInputTokens: 82_695,
      outputTokens: 252,
      reasoningTokens: 52,
      totalTokens: 96_985,
    });
  });

  it("uses a tool announced by tools/list_changed in the next step of the same prompt", async () => {
    const events = await decodeSession(LIST_CHANGED);
    const calls = ofType(events, "tool_call").filter((c) => c.connection === "fixture");
    expect(calls.map((c) => c.toolName)).toEqual(["learn_tool", "count_chars"]);
    // Same user turn (interaction), consecutive assistant steps.
    expect(calls[0]!.metadata?.interactionId).toBe(calls[1]!.metadata?.interactionId);
    expect([calls[0]!.metadata?.turnId, calls[1]!.metadata?.turnId]).toEqual(["0", "1"]);
    const countResult = ofType(events, "tool_result").find(
      (r) => r.toolCallId === calls[1]!.toolCallId,
    );
    expect(countResult?.output).toBe("5");
  });

  it("attributes subagent work to the spawning task call", async () => {
    const events = await decodeSession(LIST_CHANGED);
    const lifecycle = ofType(events, "subagent_lifecycle");
    expect(lifecycle.map((e) => [e.lifecycleType, e.role])).toEqual([
      ["start", "explore"],
      ["settle", "explore"],
    ]);
    const taskCallId = lifecycle[0]!.subagentId;
    expect(ofType(events, "tool_call").find((c) => c.toolName === "task")?.toolCallId).toBe(
      taskCallId,
    );
    const childCalls = ofType(events, "tool_call").filter(
      (c) => c.metadata?.parentToolCallId === taskCallId,
    );
    expect(childCalls.map((c) => c.toolName)).toEqual(["glob", "bash", "bash"]);
    const prompt = ofType(events, "message").find((m) => m.metadata?.subagentPrompt === true);
    expect(prompt?.role).toBe("system");
  });

  it("decodes compaction and splits cumulative usage per process run", async () => {
    const events = await decodeSession(LIST_CHANGED);
    expect(ofType(events, "compaction")).toMatchObject([
      { tokensBefore: 403, tokensAfter: 551, metadata: { messagesRemoved: 9, success: true } },
    ]);
    const lifecycle = ofType(events, "session_lifecycle").map((e) => e.lifecycleType);
    expect(lifecycle).toEqual(["start", "end", "resume", "end", "resume", "end"]);

    const usages = ofType(events, "session_lifecycle")
      .filter((e) => e.lifecycleType === "end")
      .map((e) => ProviderReportedUsageSchema.parse(e.providerUsage));
    expect(usages.map((u) => [u.model, u.inputTokens, u.outputTokens])).toEqual([
      ["gpt-5.6-luna", 41_010, 79],
      // Resumed run: parent on gpt-5.6-luna plus the explore subagent on gpt-6-luna.
      [null, 46_885, 206],
      // /compact: counted only in the session-wide totals, under no model.
      [null, 9_585 + 4_224, 1_335],
    ]);
    // The deltas add up to the final cumulative session totals.
    const sum = usages.reduce((acc, u) => acc + (u.inputTokens ?? 0), 0);
    expect(sum).toBe(9_609 + 44_439 + 47_656);
  });

  it("records a Ctrl+C abort: the cancelled tool has no result, the run's usage is kept", async () => {
    const events = await decodeSession(ABORTED);
    const [call] = ofType(events, "tool_call");
    expect(call?.input?.command).toBe("sleep 40 && echo finished");
    expect(ofType(events, "tool_result")).toEqual([]);
    const lifecycle = ofType(events, "session_lifecycle");
    expect(lifecycle.map((e) => [e.lifecycleType, e.exitReason ?? null])).toEqual([
      ["start", null],
      ["pause", "abort:user_initiated"],
      ["end", "routine"],
    ]);
    expect(lifecycle[1]!.metadata?.abortedToolCallIds).toEqual([call!.toolCallId]);
    expect(ProviderReportedUsageSchema.parse(lifecycle[2]!.providerUsage)).toMatchObject({
      model: "mai-code-1.1-flash",
      inputTokens: 484 + 12_032,
      outputTokens: 44,
    });
  });

  it("keeps the in-flight call of a killed process, with no end or usage", async () => {
    const events = await decodeSession(KILLED);
    expect(ofType(events, "tool_call").map((c) => c.input?.command)).toEqual([
      "sleep 30 && echo finished",
    ]);
    expect(ofType(events, "tool_result")).toEqual([]);
    expect(
      ofType(events, "session_lifecycle").map((e) => [e.lifecycleType, e.providerUsage ?? null]),
    ).toEqual([["start", null]]);
  });
});
