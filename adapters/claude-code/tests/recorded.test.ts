/**
 * Real Claude Code 2.1.283 sessions (see tests/fixtures/recorded/CAPTURE.md), decoded and
 * discovered exactly as the observer does.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeHarnessAdapter } from "../src/adapter.js";
import { ClaudeRecordDecoder } from "../src/decoder.js";
import { detectClaudeWorkspaces } from "../src/discovery.js";

const RECORDED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/recorded/2.1.283/projects/-workspace-project",
);
const MAIN = "9cdec615-753c-4707-b2f9-831595b73692";
const SUBAGENT = `${MAIN}/subagents/agent-a83a4563dddcae8c8.jsonl`;
const WRITE = "b167cb7a-84a9-42dd-ad65-c356fdb2bc6c";
const COMPACT = "e1932364-9a56-4cdc-8b03-da1b498bedb9";
const ABORT = "01d6de19-d55c-4671-8141-54e696554d63";
const PROMOTE = "8ea90a99-82b6-4c6c-b8cb-4fa5f5dee9dd";

function decode(relativePath: string, sessionId = "session"): IntermediateSessionEvent[] {
  const decoder = new ClaudeRecordDecoder();
  const lines = fs.readFileSync(path.join(RECORDED, relativePath), "utf8").split("\n");
  return lines
    .filter((line) => line.trim().length > 0)
    .flatMap((line, index) =>
      decoder.decode({
        recordId: `r${index}`,
        sessionId,
        harnessId: "claude-code",
        sequenceNumber: index + 1,
        timestamp: "2026-09-26T00:00:00.000Z",
        recordType: "transcript_line",
        rawPayload: JSON.parse(line),
        cursor: { offset: 0, line: index + 1, sequence: index + 1 },
        metadata: {},
      }),
    );
}

describe("recorded Claude Code 2.1.283 sessions", () => {
  it("decodes shell, read, edit, write, MCP, and subagent calls with their usage", () => {
    const events = decode(`${MAIN}.jsonl`);
    const calls = events.flatMap((event) => (event.type === "tool_call" ? [event.toolName] : []));
    expect(calls).toEqual([
      "Bash",
      "Read",
      "Read",
      "Edit",
      "Write",
      "ToolSearch",
      "mcp__echo__echo_upper",
      "Agent",
    ]);
    const shell = events.find((event) => event.type === "tool_call" && event.toolName === "Bash");
    expect(shell?.type === "tool_call" && shell.parameters).toMatchObject({
      command: "python3 calc.py",
    });
    const mcp = events.find(
      (event) => event.type === "tool_result" && String(event.result).includes("RESIN"),
    );
    expect(mcp).toBeDefined();
    const usage = events.flatMap((event) =>
      "providerUsage" in event && event.providerUsage ? [event.providerUsage] : [],
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]?.model).toBe("claude-haiku-4-5-20251001");
    expect(usage.every((entry) => (entry.outputTokens ?? 0) > 0)).toBe(true);
  });

  it("only the typed prompt is a user instruction; the task notification is Claude's", () => {
    const messages = decode(`${MAIN}.jsonl`).filter((event) => event.type === "message");
    const user = messages.filter((event) => event.type === "message" && event.role === "user");
    expect(user).toHaveLength(1);
    expect(user[0]?.type === "message" && user[0].content).toMatch(/^Do these steps in order/);
    expect(
      messages.some(
        (event) =>
          event.type === "message" &&
          event.role === "system" &&
          event.content.startsWith("<task-notification>"),
      ),
    ).toBe(true);
  });

  it("restates an Edit as the exact patch it applied, keyed by its tool call", () => {
    const edits = decode(`${MAIN}.jsonl`).filter((event) => event.type === "file_edit");
    // The Write of "hello" has no final newline, which a unified diff cannot restate: no step.
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    expect(edit.type === "file_edit" && edit.patch).toBe(
      [
        "--- /workspace/project/calc.py",
        "+++ /workspace/project/calc.py",
        "@@ -1,4 +1,4 @@",
        " def add(a, b):",
        "     return a + b",
        " ",
        "-print(add(2, 3))",
        "+print(add(4, 5))",
        "",
      ].join("\n"),
    );
    expect(edit.metadata).toEqual({
      resinCodexCommandV1: {
        version: 1,
        kind: "file-change",
        nativeId: "toolu_01NGRLJwTd2CKUGfGPEYjsjD-patch",
      },
      claudeNative: { cwd: "/workspace/project" },
    });
  });

  it("restates a Write that created a file as a creation patch", () => {
    const events = decode(`${WRITE}.jsonl`);
    const edits = events.filter((event) => event.type === "file_edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.type === "file_edit" && edits[0].operation).toBe("create");
    expect(edits[0]?.type === "file_edit" && edits[0].patch).toBe(
      "--- /dev/null\n+++ /workspace/project/todo.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n",
    );
    // The rejected overwrite is a failed result, not an edit.
    expect(events.some((event) => event.type === "tool_result" && event.isError)).toBe(true);
  });

  it("decodes a manual /compact as a compaction, and its summary as Claude's", () => {
    const events = decode(`${COMPACT}.jsonl`);
    const compaction = events.filter((event) => event.type === "compaction");
    expect(compaction).toHaveLength(1);
    expect(compaction[0]?.type === "compaction" && compaction[0].triggerReason).toBe("manual");
    expect(compaction[0]?.type === "compaction" && compaction[0].tokensBefore).toBeGreaterThan(0);
    const user = events.filter((event) => event.type === "message" && event.role === "user");
    expect(user.map((event) => event.type === "message" && event.content)).toEqual([
      "Run the shell command 'ls' and tell me the file count.",
    ]);
  });

  it("decodes an interrupted tool call as a rejected result and Claude's notice", () => {
    const events = decode(`${ABORT}.jsonl`);
    expect(events.some((event) => event.type === "tool_result" && event.isError)).toBe(true);
    const notice = events.find(
      (event) => event.type === "message" && event.content.startsWith("[Request interrupted"),
    );
    expect(notice?.type === "message" && notice.role).toBe("system");
  });

  it("decodes the subagent's own calls under the subagent session", () => {
    const events = decode(SUBAGENT, "agent-a83a4563dddcae8c8");
    expect(events.some((event) => event.type === "tool_call" && event.toolName === "Read")).toBe(
      true,
    );
    expect(events.every((event) => event.sessionId === "agent-a83a4563dddcae8c8")).toBe(true);
  });

  describe("discovery", () => {
    let home: string;
    beforeAll(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-claude-recorded-"));
      fs.cpSync(RECORDED, path.join(home, ".claude", "projects", "-workspace-project"), {
        recursive: true,
      });
      // A stray sidechain file for another session must not be attributed to this one.
      const stray = path.join(
        home,
        ".claude/projects/-workspace-project",
        WRITE,
        "subagents/agent-a83a4563dddcae8c8.jsonl",
      );
      fs.mkdirSync(path.dirname(stray), { recursive: true });
      fs.copyFileSync(path.join(RECORDED, SUBAGENT), stray);
    });
    afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

    it("binds the subagent transcript to its parent session's project root", async () => {
      const workspaces = await detectClaudeWorkspaces(home);
      const workspace = workspaces.find((entry) => entry.rootPath === "/workspace/project");
      expect(workspace).toBeDefined();
      const sessions = await new ClaudeHarnessAdapter().listSessions(workspace!);
      const ids = sessions.map((session) => session.sessionId);
      expect(ids).toContain(MAIN);
      const agents = sessions.filter((session) => session.metadata?.sessionKind === "agent");
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        sessionId: "agent-a83a4563dddcae8c8",
        workspaceId: workspace!.workspaceId,
        transcriptPath: path.join(home, ".claude/projects/-workspace-project", SUBAGENT),
        metadata: {
          parentSessionId: MAIN,
          agentId: "a83a4563dddcae8c8",
          cwd: "/workspace/project",
          agentType: "general-purpose",
          parentToolCallId: "toolu_01XZcqwLKdzwvtkV4SCgu2d4",
        },
      });
    });
  });
});

describe("recorded Claude Code 2.1.283 one-block-per-record session", () => {
  it("pairs every tool call with its result under one call id and reports each shell command", () => {
    const events = decode(`${PROMOTE}.jsonl`);
    const calls = events.flatMap((event) => (event.type === "tool_call" ? [event] : []));
    const results = events.flatMap((event) => (event.type === "tool_result" ? [event] : []));
    expect(calls.map((call) => call.toolName)).toEqual(["Read", ...Array(9).fill("Bash"), "Read"]);
    expect(results.map((result) => [result.callId, result.toolName])).toEqual(
      calls.map((call) => [call.callId, call.toolName]),
    );
    expect(calls[1]?.parameters).toMatchObject({ command: "./deployctl --help" });
    for (const result of results) {
      expect(result.executionDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata?.executionDurationUnknown).toBeUndefined();
    }
    // Each Bash call is one step: a second, call-less command event would make the recorded
    // workflow's steps ambiguous, and the cloud defers the whole workflow.
    expect(events.some((event) => event.type === "command_exec")).toBe(false);
    const keys = events.map(
      (event) => `${event.causalRef?.causalSequence}:${event.causalRef?.stepIndex ?? 0}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("closes the turn with the assistant's end_turn and the session with the exit record", () => {
    const events = decode(`${PROMOTE}.jsonl`);
    const assistant = events.filter(
      (event) => event.type === "message" && event.role === "assistant",
    );
    expect(assistant.at(-1)?.metadata?.stopReason).toBe("end_turn");
    const toolCall = events.find((event) => event.type === "tool_call");
    expect(toolCall?.metadata?.stopReason).toBe("tool_use");
    expect(events.at(-1)).toMatchObject({
      type: "session_lifecycle",
      lifecycleType: "end",
      exitReason: "normal",
    });
  });
});
