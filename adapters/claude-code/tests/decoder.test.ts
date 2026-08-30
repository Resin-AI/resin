import * as fs from "node:fs";
import * as path from "node:path";
import { ProviderReportedUsageSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_ACCOUNTING_VERSION,
  CLAUDE_PROVIDER,
  ClaudeRecordDecoder,
  decodeClaudeTranscriptLine,
  extractClaudeProviderUsage,
} from "../src/decoder.js";

describe("Claude Code Transcript Decoder", () => {
  const sessionId = "test-session-123";

  it("decodes session start and end lifecycle events", () => {
    const startLine = JSON.stringify({
      type: "session_start",
      harness: "claude-code",
      workspaceId: "ws-1",
      timestamp: "2026-08-17T12:00:00.000Z",
    });

    const startEvents = decodeClaudeTranscriptLine(startLine, sessionId, 1);
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].type).toBe("session_lifecycle");
    if (startEvents[0].type === "session_lifecycle") {
      expect(startEvents[0].lifecycleType).toBe("start");
      expect(startEvents[0].harnessName).toBe("claude-code");
      expect(startEvents[0].workspaceId).toBe("ws-1");
    }

    const endLine = JSON.stringify({
      type: "session_end",
      exitReason: "user_completed",
      timestamp: "2026-08-17T12:05:00.000Z",
    });

    const endEvents = decodeClaudeTranscriptLine(endLine, sessionId, 2);
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].type).toBe("session_lifecycle");
    if (endEvents[0].type === "session_lifecycle") {
      expect(endEvents[0].lifecycleType).toBe("end");
      expect(endEvents[0].exitReason).toBe("user_completed");
    }
  });

  it("decodes subagents and branch fork events", () => {
    const subagentLine = JSON.stringify({
      type: "subagent_spawn",
      subagentId: "sub-123",
      parentId: "session-root",
      role: "code_reviewer",
    });

    const subEvents = decodeClaudeTranscriptLine(subagentLine, sessionId, 1);
    expect(subEvents).toHaveLength(1);
    expect(subEvents[0].type).toBe("subagent_lifecycle");
    if (subEvents[0].type === "subagent_lifecycle") {
      expect(subEvents[0].subagentId).toBe("sub-123");
      expect(subEvents[0].lifecycleType).toBe("spawn");
      expect(subEvents[0].role).toBe("code_reviewer");
    }

    const forkLine = JSON.stringify({
      type: "branch_fork",
      sourceSessionId: sessionId,
      branchPointEventId: "ev-5",
      branchName: "experiment-1",
      forkReason: "testing alternate prompt",
    });

    const forkEvents = decodeClaudeTranscriptLine(forkLine, sessionId, 2);
    expect(forkEvents).toHaveLength(1);
    expect(forkEvents[0].type).toBe("branch_fork");
    if (forkEvents[0].type === "branch_fork") {
      expect(forkEvents[0].branchPointEventId).toBe("ev-5");
      expect(forkEvents[0].branchName).toBe("experiment-1");
    }
  });

  it("decodes user messages and tool results", () => {
    const userLine = JSON.stringify({
      type: "user",
      content: "Please check all TypeScript files.",
      model: "claude-3-7-sonnet",
    });

    const userEvents = decodeClaudeTranscriptLine(userLine, sessionId, 1);
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].type).toBe("message");
    if (userEvents[0].type === "message") {
      expect(userEvents[0].role).toBe("user");
      expect(userEvents[0].content).toBe("Please check all TypeScript files.");
    }

    const toolResultLine = JSON.stringify({
      type: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_123",
          name: "grep",
          content: "file1.ts\nfile2.ts",
          is_error: false,
        },
      ],
    });

    const toolResultEvents = decodeClaudeTranscriptLine(toolResultLine, sessionId, 2);
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0].type).toBe("tool_result");
    if (toolResultEvents[0].type === "tool_result") {
      expect(toolResultEvents[0].toolCallId).toBe("toolu_123");
      expect(toolResultEvents[0].toolName).toBe("grep");
      expect(toolResultEvents[0].output).toBe("file1.ts\nfile2.ts");
      expect(toolResultEvents[0].isError).toBe(false);
    }
  });

  it("decodes assistant messages with text, reasoning, and tool calls", () => {
    const assistantLine = JSON.stringify({
      type: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "I will check the build status first using Bash.",
          signature: "sig_abc",
        },
        {
          type: "text",
          text: "Running build check now...",
        },
        {
          type: "tool_use",
          id: "toolu_bash_99",
          name: "Bash",
          input: { command: "pnpm build", cwd: "/root" },
        },
      ],
      model: "claude-3-7-sonnet",
    });

    const events = decodeClaudeTranscriptLine(assistantLine, sessionId, 1);
    // Should emit reasoning, text message, tool call, and specialized command exec
    expect(events.length).toBeGreaterThanOrEqual(3);

    const reasoning = events.find((e) => e.type === "model_reasoning");
    expect(reasoning).toBeDefined();
    if (reasoning && reasoning.type === "model_reasoning") {
      expect(reasoning.reasoningText).toBe("I will check the build status first using Bash.");
      expect(reasoning.signature).toBe("sig_abc");
    }

    const message = events.find((e) => e.type === "message");
    expect(message).toBeDefined();
    if (message && message.type === "message") {
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("Running build check now...");
    }

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === "tool_call") {
      expect(toolCall.toolCallId).toBe("toolu_bash_99");
      expect(toolCall.toolName).toBe("Bash");
    }

    const commandExec = events.find((e) => e.type === "command_exec");
    expect(commandExec).toBeDefined();
    if (commandExec && commandExec.type === "command_exec") {
      expect(commandExec.command).toBe("pnpm build");
      expect(commandExec.workingDirectory).toBe("/root");
    }
  });

  it("decodes file edits with modify and create types", () => {
    const editLine = JSON.stringify({
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_edit_1",
          name: "Edit",
          input: {
            file_path: "src/index.ts",
            command: "modify",
            old_str: "const a = 1;",
            new_str: "const a = 2;",
          },
        },
      ],
    });

    const events = decodeClaudeTranscriptLine(editLine, sessionId, 1);
    const fileEdit = events.find((e) => e.type === "file_edit");
    expect(fileEdit).toBeDefined();
    if (fileEdit && fileEdit.type === "file_edit") {
      expect(fileEdit.filePath).toBe("src/index.ts");
      expect(fileEdit.operation).toBe("update");
      expect(fileEdit.diff).toContain("-const a = 1;");
      expect(fileEdit.diff).toContain("+const a = 2;");
    }
  });

  it("decodes compaction events and errors", () => {
    const compactionLine = JSON.stringify({
      type: "compaction",
      originalTokenCount: 100000,
      compactedTokenCount: 15000,
      summary: "Summary of earlier discussion",
      rangeStart: "event-1",
      rangeEnd: "event-50",
    });

    const compEvents = decodeClaudeTranscriptLine(compactionLine, sessionId, 1);
    expect(compEvents).toHaveLength(1);
    expect(compEvents[0].type).toBe("compaction");
    if (compEvents[0].type === "compaction") {
      expect(compEvents[0].originalTokenCount).toBe(100000);
      expect(compEvents[0].compactedTokenCount).toBe(15000);
      expect(compEvents[0].summary).toBe("Summary of earlier discussion");
    }

    const errorLine = JSON.stringify({
      type: "error",
      code: "API_TIMEOUT",
      message: "Gateway connection timed out",
      fatal: true,
    });

    const errorEvents = decodeClaudeTranscriptLine(errorLine, sessionId, 2);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].type).toBe("error");
    if (errorEvents[0].type === "error") {
      expect(errorEvents[0].errorType).toBe("API_TIMEOUT");
      expect(errorEvents[0].message).toBe("Gateway connection timed out");
      expect(errorEvents[0].fatal).toBe(true);
    }
  });

  it("emits unknown passthrough on unrecognized records", () => {
    const unknownLine = JSON.stringify({
      type: "custom_unsupported_claude_event",
      foo: "bar",
    });

    const events = decodeClaudeTranscriptLine(unknownLine, sessionId, 1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("unknown_passthrough");
    if (events[0].type === "unknown_passthrough") {
      expect(events[0].rawEventType).toBe("custom_unsupported_claude_event");
      expect(events[0].rawPayload).toEqual({
        type: "custom_unsupported_claude_event",
        foo: "bar",
      });
    }
  });

  it("decodes all golden fixture files successfully via ClaudeRecordDecoder", () => {
    const decoder = new ClaudeRecordDecoder();
    const fixturesDir = path.join(__dirname, "..", "fixtures");
    const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".jsonl"));

    expect(fixtureFiles.length).toBeGreaterThanOrEqual(5);

    for (const file of fixtureFiles) {
      const filePath = path.join(fixturesDir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      expect(lines.length).toBeGreaterThan(0);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const record = {
          recordId: `rec-${i}`,
          sessionId: "session-golden-test",
          harnessId: "claude-code",
          sequenceNumber: i + 1,
          timestamp: new Date().toISOString(),
          recordType: "transcript_line" as const,
          rawPayload: line,
          cursor: {
            offset: i * 100,
            line: i + 1,
            sequence: i + 1,
            timestamp: new Date().toISOString(),
          },
          metadata: {},
        };

        expect(decoder.canDecode(record)).toBe(true);
        const decoded = decoder.decode(record);
        expect(decoded.length).toBeGreaterThan(0);
        for (const ev of decoded) {
          expect(ev.sessionId).toBeTruthy();
          expect(ev.type).toBeTruthy();
          expect(ev.timestamp).toBeTruthy();
        }
      }
    }
  });

  describe("authoritative providerUsage decoding", () => {
    it("decodes full provider usage with all components and complete availability", () => {
      const rawRecord = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        message: {
          content: "Here is the solution to your issue.",
          usage: {
            input_tokens: 1200,
            output_tokens: 450,
            reasoning_tokens: 150,
            cache_read_input_tokens: 300,
            total_tokens: 1950,
            cost_micro_usd: 12500,
            duration_ms: 850,
          },
        },
      };

      const events = decodeClaudeTranscriptLine(rawRecord, sessionId, 1);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message");

      const messageEvent = events[0];
      expect(messageEvent.type).toBe("message");
      const usage = messageEvent.type === "message" ? messageEvent.providerUsage : undefined;
      expect(usage).toBeDefined();
      if (!usage) throw new Error("Expected providerUsage");

      expect(usage.provider).toBe(CLAUDE_PROVIDER);
      expect(usage.model).toBe("claude-3-7-sonnet");
      expect(usage.accountingVersion).toBe(CLAUDE_ACCOUNTING_VERSION);
      expect(usage.availability).toBe("complete");
      expect(usage.inputTokens).toBe(1200);
      expect(usage.outputTokens).toBe(450);
      expect(usage.reasoningTokens).toBe(150);
      expect(usage.cachedInputTokens).toBe(300);
      expect(usage.totalTokens).toBe(1950);
      expect(usage.costMicroUsd).toBe(12500);
      expect(usage.durationMs).toBe(850);

      const validated = ProviderReportedUsageSchema.parse(usage);
      expect(validated.availability).toBe("complete");
      expect(validated.totalTokens).toBe(1950);
    });

    it("decodes partial provider usage when total_tokens is omitted, without inferring totals", () => {
      const rawRecord = {
        type: "assistant",
        model: "claude-3-5-sonnet",
        usage: {
          input_tokens: 800,
          output_tokens: 200,
          cache_read_input_tokens: 100,
        },
        content: "Refactoring complete.",
      };

      const events = decodeClaudeTranscriptLine(rawRecord, sessionId, 2);
      expect(events).toHaveLength(1);

      const messageEvent = events[0];
      expect(messageEvent.type).toBe("message");
      const usage = messageEvent.type === "message" ? messageEvent.providerUsage : undefined;
      expect(usage).toBeDefined();
      if (!usage) throw new Error("Expected providerUsage");

      expect(usage.provider).toBe("anthropic");
      expect(usage.model).toBe("claude-3-5-sonnet");
      expect(usage.accountingVersion).toBe("claude-code-transcript-v1");
      expect(usage.availability).toBe("partial");
      expect(usage.inputTokens).toBe(800);
      expect(usage.outputTokens).toBe(200);
      expect(usage.cachedInputTokens).toBe(100);
      expect(usage.totalTokens).toBeUndefined(); // MUST NOT sum input + output!

      const validated = ProviderReportedUsageSchema.parse(usage);
      expect(validated.availability).toBe("partial");
      expect(validated.totalTokens).toBeUndefined();
    });

    it("preserves absent usage when raw record does not report usage", () => {
      const rawRecord = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        content: "Plain message without usage metadata.",
      };

      const events = decodeClaudeTranscriptLine(rawRecord, sessionId, 3);
      expect(events).toHaveLength(1);
      const messageEvent = events[0];
      expect(
        messageEvent.type === "message" ? messageEvent.providerUsage : undefined,
      ).toBeUndefined();
    });

    it("handles malformed usage objects safely without crashing or attaching invalid metrics", () => {
      // String instead of object
      const stringUsageRecord = {
        type: "assistant",
        content: "Test message",
        usage: "1500 tokens used",
      };
      const events1 = decodeClaudeTranscriptLine(stringUsageRecord, sessionId, 4);
      expect(events1[0].type === "message" ? events1[0].providerUsage : undefined).toBeUndefined();

      // Null usage
      const nullUsageRecord = {
        type: "assistant",
        content: "Test message",
        usage: null,
      };
      const events2 = decodeClaudeTranscriptLine(nullUsageRecord, sessionId, 5);
      expect(events2[0].type === "message" ? events2[0].providerUsage : undefined).toBeUndefined();

      // Negative numbers
      const negativeUsageRecord = {
        type: "assistant",
        content: "Test message",
        usage: { input_tokens: -100, output_tokens: -50 },
      };
      const events3 = decodeClaudeTranscriptLine(negativeUsageRecord, sessionId, 6);
      expect(events3[0].type === "message" ? events3[0].providerUsage : undefined).toBeUndefined();

      // Non-numeric garbage
      const garbageUsageRecord = {
        type: "assistant",
        content: "Test message",
        usage: { input_tokens: "garbage", output_tokens: {} },
      };
      const events4 = decodeClaudeTranscriptLine(garbageUsageRecord, sessionId, 7);
      expect(events4[0].type === "message" ? events4[0].providerUsage : undefined).toBeUndefined();

      // Partial valid fields with invalid ones
      const mixedUsageRecord = {
        type: "assistant",
        content: "Test message",
        usage: { input_tokens: 500, output_tokens: -20 },
      };
      const events5 = decodeClaudeTranscriptLine(mixedUsageRecord, sessionId, 8);
      const message5 = events5[0];
      const usage5 = message5.type === "message" ? message5.providerUsage : undefined;
      expect(usage5).toBeDefined();
      expect(usage5.inputTokens).toBe(500);
      expect(usage5.outputTokens).toBeUndefined();
      expect(usage5.availability).toBe("partial");
      expect(ProviderReportedUsageSchema.safeParse(usage5).success).toBe(true);
    });

    it("extracts exact cache-read tokens and leaves cache-creation unsupported rather than merging", () => {
      const cacheRecord = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        content: "Cached response",
        usage: {
          input_tokens: 150,
          output_tokens: 80,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 1200,
        },
      };

      const events = decodeClaudeTranscriptLine(cacheRecord, sessionId, 9);
      const messageEvent = events[0];
      expect(messageEvent.type).toBe("message");
      const usage = messageEvent.type === "message" ? messageEvent.providerUsage : undefined;
      expect(usage).toBeDefined();
      if (!usage) throw new Error("Expected providerUsage");

      expect(usage).toBeDefined();
      expect(usage.cachedInputTokens).toBe(400); // Exact cache-read only
      expect(usage.inputTokens).toBe(150); // NOT merged with cache_creation
      expect(usage.cachedInputTokens).not.toBe(1600); // NOT merged with cache_creation
      expect(usage).not.toHaveProperty("cache_creation_input_tokens");
      expect(usage).not.toHaveProperty("cacheCreationInputTokens");
      expect(usage).not.toHaveProperty("cacheCreationTokens");

      // Schema strictness check passes
      const parsed = ProviderReportedUsageSchema.parse(usage);
      expect(parsed.cachedInputTokens).toBe(400);
    });

    it("does not leak prompt, command, file path, or transcript content into providerUsage", () => {
      const sensitiveRecord = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        content: "CONFIDENTIAL_API_KEY_SECRET_98765",
        command: "rm -rf /sensitive/system/path",
        file_path: "/etc/shadow",
        prompt: "System secret prompt text",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      };

      const events = decodeClaudeTranscriptLine(sensitiveRecord, sessionId, 10);
      const messageEvent = events[0];
      expect(messageEvent.type).toBe("message");
      const usage = messageEvent.type === "message" ? messageEvent.providerUsage : undefined;
      expect(usage).toBeDefined();
      if (!usage) throw new Error("Expected providerUsage");

      expect(usage).toBeDefined();
      const usageJson = JSON.stringify(usage);

      expect(usageJson).not.toContain("CONFIDENTIAL");
      expect(usageJson).not.toContain("SECRET");
      expect(usageJson).not.toContain("sensitive");
      expect(usageJson).not.toContain("shadow");
      expect(usageJson).not.toContain("prompt");

      const allowedKeys = {
        provider: true,
        model: true,
        accountingVersion: true,
        availability: true,
        inputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        cachedInputTokens: true,
        totalTokens: true,
        costMicroUsd: true,
        durationMs: true,
      } satisfies Record<string, true>;

      for (const key of Object.keys(usage)) {
        expect(allowedKeys[key]).toBe(true);
      }
    });

    it("attaches providerUsage to primary model event and NOT to synthetic tool or lifecycle events", () => {
      const turnWithBashAndEdit = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        content: [
          {
            type: "thinking",
            thinking: "Let me check the files first.",
          },
          {
            type: "tool_use",
            id: "tool_bash_1",
            name: "Bash",
            input: { command: "ls -la" },
          },
          {
            type: "tool_use",
            id: "tool_edit_2",
            name: "Edit",
            input: { file_path: "src/index.ts", command: "modify", old_str: "a", new_str: "b" },
          },
          {
            type: "text",
            text: "I have reviewed and modified the file.",
          },
        ],
        usage: {
          input_tokens: 2000,
          output_tokens: 500,
          total_tokens: 2500,
        },
      };

      const events = decodeClaudeTranscriptLine(turnWithBashAndEdit, sessionId, 11);
      // Events produced: model_reasoning, tool_call(Bash), command_exec(synthetic), tool_call(Edit), file_edit(synthetic), message(assistant)
      expect(events.length).toBeGreaterThanOrEqual(5);

      const messageEvents = events.filter((e) => e.type === "message");
      const commandExecEvents = events.filter((e) => e.type === "command_exec");
      const fileEditEvents = events.filter((e) => e.type === "file_edit");

      // message event receives providerUsage
      expect(messageEvents).toHaveLength(1);
      expect(messageEvents[0].type === "message" && messageEvents[0].providerUsage).toBeDefined();

      // synthetic command_exec MUST NOT have providerUsage
      for (const cmd of commandExecEvents) {
        expect("providerUsage" in cmd && cmd.providerUsage).toBeFalsy();
      }

      // synthetic file_edit MUST NOT have providerUsage
      for (const edit of fileEditEvents) {
        expect("providerUsage" in edit && edit.providerUsage).toBeFalsy();
      }
    });

    it("decodes explicit unavailable state cleanly", () => {
      const unavailableRecord = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        content: "Some response",
        usage: {
          availability: "unavailable",
        },
      };

      const events = decodeClaudeTranscriptLine(unavailableRecord, sessionId, 12);
      const messageEvent = events[0];
      expect(messageEvent.type).toBe("message");
      const usage = messageEvent.type === "message" ? messageEvent.providerUsage : undefined;
      expect(usage).toBeDefined();
      if (!usage) throw new Error("Expected providerUsage");

      expect(usage).toBeDefined();
      expect(usage.provider).toBe("anthropic");
      expect(usage.availability).toBe("unavailable");
      expect(usage.accountingVersion).toBe("claude-code-transcript-v1");
      expect(usage.inputTokens).toBeUndefined();
      expect(usage.outputTokens).toBeUndefined();
      expect(usage.totalTokens).toBeUndefined();

      const parsed = ProviderReportedUsageSchema.parse(usage);
      expect(parsed.availability).toBe("unavailable");
    });
  });
});
