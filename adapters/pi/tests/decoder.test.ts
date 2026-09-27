import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NormalizedSessionEventSchema } from "@resin/contracts";
import type {
  HarnessSession,
  IntermediateSessionEvent,
  RawHarnessRecord,
  SourceCursor,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { PiRecordDecoder } from "../src/decoder.js";
import { PiSessionEventSource } from "../src/source.js";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded", "0.87.1");

function sessionFor(transcriptPath: string, sessionId = "pi-test"): HarnessSession {
  return {
    sessionId,
    workspaceId: "pi-ws",
    harnessId: "pi",
    transcriptPath,
    status: "idle",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    metadata: {},
  };
}

async function readAll(transcriptPath: string, batchSize?: number): Promise<RawHarnessRecord[]> {
  const records: RawHarnessRecord[] = [];
  let cursor: SourceCursor | undefined;
  // A fresh source per batch proves that decoding resumes from a persisted cursor alone.
  for (;;) {
    const source = new PiSessionEventSource(sessionFor(transcriptPath), cursor);
    const batch = await source.readNext(batchSize);
    await source.close();
    if (batch.length === 0) return records;
    records.push(...batch);
    cursor = source.getCursor();
  }
}

function decodeAll(records: RawHarnessRecord[]): IntermediateSessionEvent[] {
  const decoder = new PiRecordDecoder();
  return records.flatMap((record) => decoder.decode(record) ?? []);
}

async function decodeFixture(name: string, batchSize?: number) {
  return decodeAll(await readAll(path.join(RECORDED, name), batchSize));
}

/** Tool calls and results in order, as `call:<name>` / `result:<name>` steps. */
function toolSteps(events: IntermediateSessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "tool_call") return [`call:${event.toolName}:${event.toolCallId}`];
    if (event.type === "tool_result") return [`result:${event.toolName}:${event.toolCallId}`];
    return [];
  });
}

describe("PiRecordDecoder on recorded 0.87.1 sessions", () => {
  it("decodes built-in and bridged MCP tool calls in order, each result before the next call", async () => {
    const events = await decodeFixture("tools-mcp-bridge.jsonl");
    const steps = toolSteps(events);
    expect(steps.map((step) => step.split(":").slice(0, 2).join(":"))).toEqual([
      "call:bash",
      "result:bash",
      "call:read",
      "result:read",
      "call:edit",
      "result:edit",
      "call:write",
      "result:write",
      "call:mcp__fixture__word_count",
      "result:mcp__fixture__word_count",
    ]);
    for (let index = 0; index < steps.length; index += 2) {
      expect(steps[index]?.split(":")[2]).toBe(steps[index + 1]?.split(":")[2]);
    }

    const mcpCall = events.find(
      (event) => event.type === "tool_call" && event.toolName === "mcp__fixture__word_count",
    );
    expect(mcpCall).toMatchObject({ connection: "fixture", parameters: { text: "one two three" } });
    const mcpResult = events.find(
      (event) => event.type === "tool_result" && event.toolName === "mcp__fixture__word_count",
    );
    expect(mcpResult).toMatchObject({ result: "words: 3", isError: false });

    // A bash call is one step: its result is the record of the command, not a second event.
    expect(events.filter((event) => event.type === "command_exec")).toEqual([]);
    const bashCall = events.find(
      (event) => event.type === "tool_call" && event.toolName === "bash",
    );
    expect(bashCall).toMatchObject({ parameters: { command: "./greet.sh world" } });
    expect(
      events.find(
        (event) =>
          event.type === "tool_result" &&
          bashCall?.type === "tool_call" &&
          event.callId === bashCall.callId,
      ),
    ).toMatchObject({ result: expect.stringContaining("hello, world"), isError: false });
    // Each edit is part of the call that made it.
    const callOf = (toolName: string) =>
      events.find((event) => event.type === "tool_call" && event.toolName === toolName);
    expect(
      events.flatMap((event) =>
        event.type === "file_edit"
          ? [[event.filePath, event.operation, event.producedByCallId]]
          : [],
      ),
    ).toEqual([
      ["README.md", "update", (callOf("edit") as { callId?: string } | undefined)?.callId],
      ["NOTES.md", "create", (callOf("write") as { callId?: string } | undefined)?.callId],
    ]);

    const discovery = events.find((event) => event.type === "tool_discovery");
    expect(
      discovery?.type === "tool_discovery" && discovery.tools.map((tool) => tool.name),
    ).toEqual(["read", "bash", "edit", "write", "mcp__fixture__word_count"]);
    expect(
      discovery?.type === "tool_discovery" &&
        discovery.tools.find((tool) => tool.name === "mcp__fixture__word_count")?.provider,
    ).toBe("fixture");
  });

  it("reports Pi's per-response usage once per assistant message", async () => {
    const events = await decodeFixture("tools-mcp-bridge.jsonl");
    const usages = events.flatMap((event) => (event.providerUsage ? [event.providerUsage] : []));
    // Six assistant responses: five tool-calling turns and the final answer.
    expect(usages).toHaveLength(6);
    for (const usage of usages) {
      expect(usage).toMatchObject({
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        availability: "complete",
        costProvenance: "harness_estimate",
      });
      expect(usage.totalTokens).toBe(
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
      );
    }
  });

  it("announces a /tree rewind before the new branch and keeps branches contiguous", async () => {
    const events = await decodeFixture("rpc-tree-rewind.jsonl");
    const forks = events.filter((event) => event.type === "branch_fork");
    expect(forks).toEqual([
      expect.objectContaining({
        forkReason: "tree_navigation",
        branchPointEventId: "fea3e7b2",
        parentBranchId: "3cf85d19",
      }),
    ]);
    const forkIndex = events.indexOf(forks[0]!);
    const before = toolSteps(events.slice(0, forkIndex)).map((step) => step.split(":")[0]);
    const after = toolSteps(events.slice(forkIndex)).map((step) => step.split(":")[0]);
    expect(before).toEqual(["call", "result", "call", "result"]);
    expect(after).toEqual(["call", "result"]);
    const user = events.filter((event) => event.type === "message" && event.role === "user");
    expect(user.map((event) => event.type === "message" && event.content)).toEqual([
      "Use the bash tool to run `cat README.md`. Reply with the first word only.",
      "Use the bash tool to run `wc -l greet.sh`. Reply with the number only.",
      "Use the bash tool to run `ls`. Reply with the file count only.",
    ]);
  });

  it("decodes branch summaries, model changes, user shell, aborts, and compaction", async () => {
    const events = await decodeFixture("rpc-branch-model-bash-abort-compaction.jsonl");
    const forks = events.filter((event) => event.type === "branch_fork");
    // The summarized rewind is a single fork event, not a summary plus a generic rewind.
    expect(forks).toEqual([
      expect.objectContaining({
        forkReason: "tree_navigation_summary",
        parentBranchId: "88fa7a15",
        branchPointEventId: "ef186bf2",
      }),
    ]);
    expect(forks[0]?.providerUsage?.totalTokens).toBeGreaterThan(0);

    const modelChanges = events.filter(
      (event) => event.type === "unknown_passthrough" && event.rawEventType === "model_change",
    );
    expect(
      modelChanges.map((event) => event.type === "unknown_passthrough" && event.rawPayload.modelId),
    ).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "command_exec",
        command: "echo rpc-bash",
        stdout: "rpc-bash\n",
        exitCode: 0,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "bash",
        isError: true,
        result: "Command aborted",
      }),
    );
    // Pi 0.87.1 persists an aborted request as `stopReason: "error"` with the abort message.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        errorType: "error",
        message: "This operation was aborted",
        recoverable: true,
      }),
    );

    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction).toMatchObject({
      tokensBefore: 3771,
      metadata: expect.objectContaining({ firstKeptEntryId: "716d2283" }),
    });
    expect(compaction?.providerUsage?.totalTokens).toBe(296);
    const afterCompaction = events.slice(events.indexOf(compaction!) + 1);
    expect(afterCompaction).toContainEqual(
      expect.objectContaining({ type: "message", role: "assistant", content: "OK" }),
    );
  });

  it("links a fork to its parent session and skips the copied parent history", async () => {
    const events = await decodeFixture("rpc-fork.jsonl");
    expect(events[0]).toMatchObject({ type: "session_lifecycle", lifecycleType: "start" });
    // The fork continues the copied parent entry 489d0935 (the parent's leading system prompt).
    expect(events.filter((event) => event.type === "branch_fork")).toEqual([
      expect.objectContaining({
        forkReason: "session_fork",
        sourceSessionId: "01a0dff0-d537-7747-bfb8-d1f92fceb35d",
        branchPointEventId: "489d0935",
      }),
    ]);
    expect(
      events.flatMap((event) =>
        event.type === "message" ? [`${event.role}:${event.content}`] : [],
      ),
    ).toEqual(["user:Reply with just FORKED.", "assistant:FORKED"]);
    expect(events.some((event) => event.type === "tool_discovery")).toBe(false);
  });

  it("decodes identically when read in small resumed batches", async () => {
    for (const name of [
      "tools-mcp-bridge.jsonl",
      "rpc-tree-rewind.jsonl",
      "rpc-branch-model-bash-abort-compaction.jsonl",
      "rpc-fork.jsonl",
    ]) {
      const whole = await decodeFixture(name);
      const batched = await decodeFixture(name, 2);
      expect(batched, name).toEqual(whole);
    }
  });

  it("emits events that satisfy the normalized event schema", async () => {
    for (const name of [
      "tools-mcp-bridge.jsonl",
      "resin-gateway-bridge.jsonl",
      "rpc-tree-rewind.jsonl",
      "rpc-branch-model-bash-abort-compaction.jsonl",
      "rpc-fork.jsonl",
    ]) {
      for (const [index, event] of (await decodeFixture(name)).entries()) {
        // Fields the observer pipeline adds before validating.
        const candidate = {
          ...event,
          eventId: `e${index}`,
          causalRef: { parentId: null, ...event.causalRef },
          redaction: { isRedacted: false },
        };
        const parsed = NormalizedSessionEventSchema.safeParse(candidate);
        expect(parsed.error?.issues, `${name} #${index} ${event.type}`).toBeUndefined();
      }
    }
  });

  it("records a bash failure and duration on the result of the call it answers", async () => {
    const events = await decodeFixture("rpc-branch-model-bash-abort-compaction.jsonl");
    const abortedResult = events.find(
      (event) => event.type === "tool_result" && event.result === "Command aborted",
    );
    // Written 22:58:40.738 (call) → 22:58:42.245 (result).
    expect(abortedResult).toMatchObject({ isError: true, executionDurationMs: 1507 });
  });

  it("assigns unique, increasing causal sequences", async () => {
    const events = await decodeFixture("rpc-branch-model-bash-abort-compaction.jsonl");
    const sequences = events.map((event) => event.causalRef?.causalSequence ?? -1);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!)).toBe(
      true,
    );
  });
});

describe("PiRecordDecoder on older session formats", () => {
  async function decodeLines(lines: object[]): Promise<IntermediateSessionEvent[]> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-decoder-"));
    const file = path.join(dir, "2026-01-01T00-00-00-000Z_legacy.jsonl");
    await fsp.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    try {
      return decodeAll(await readAll(file, 1));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it("treats a v1 file as one linear branch and decodes the pre-v3 hookMessage role", async () => {
    const events = await decodeLines([
      { type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/w" },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:01.000Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
          provider: "anthropic",
          model: "claude",
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [{ type: "text", text: "a" }],
          isError: false,
        },
      },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:04.000Z",
        message: { role: "hookMessage", customType: "note", content: "from a hook", display: true },
      },
    ]);
    expect(events.some((event) => event.type === "branch_fork")).toBe(false);
    expect(events.map((event) => event.metadata?.piEntryId).filter(Boolean)).toContain("v1-3");
    expect(toolSteps(events)).toEqual(["call:bash:c1", "result:bash:c1"]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", role: "user", content: "from a hook" }),
    );
  });
});
