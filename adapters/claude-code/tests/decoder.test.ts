import * as fs from "node:fs";
import * as path from "node:path";
import {
  ProviderReportedUsageSchema,
  formatResinInvocationReceiptText,
  providerUsageNormalizedTotal,
  providerUsageRequestKey,
  selectProviderUsageSnapshot,
} from "@resin/contracts";
import type { IntermediateSessionEvent } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_ACCOUNTING_VERSION,
  CLAUDE_PROVIDER,
  ClaudeRecordDecoder,
  type ClaudeTranscriptPayload,
  type ClaudeTranscriptValue,
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
      expect(toolResultEvents[0].result).toBe("file1.ts\nfile2.ts");
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

    const pending = new Map();
    const events = decodeClaudeTranscriptLine(assistantLine, sessionId, 1, undefined, pending);
    expect(events.map((e) => e.type)).toEqual(["model_reasoning", "message", "tool_call"]);

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

    // The command is reported once its result says how it exited.
    const resultEvents = decodeClaudeTranscriptLine(
      {
        type: "user",
        timestamp: "2026-09-26T00:00:03.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash_99",
              content: "Exit code 2\nbuild failed",
              is_error: true,
            },
          ],
        },
        toolUseResult: "Error: Exit code 2\nbuild failed",
      },
      sessionId,
      2,
      undefined,
      pending,
    );
    // The Bash call and its result are the one recorded step; no separate command event.
    expect(resultEvents.some((e) => e.type === "command_exec")).toBe(false);
    expect(resultEvents.find((e) => e.type === "tool_result")).toMatchObject({
      toolName: "Bash",
      isError: true,
    });
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

    it("reports cache writes as their own category on request-scoped usage, never merged", () => {
      const cacheRecord = {
        type: "assistant",
        model: "claude-3-7-sonnet",
        message: {
          id: "msg_cache_1",
          content: "Cached response",
          usage: {
            input_tokens: 150,
            output_tokens: 80,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 1200,
          },
        },
      };

      const events = decodeClaudeTranscriptLine(cacheRecord, sessionId, 9);
      const messageEvent = events[0];
      expect(messageEvent.type).toBe("message");
      const usage = messageEvent.type === "message" ? messageEvent.providerUsage : undefined;
      if (!usage) throw new Error("Expected providerUsage");

      expect(usage.cachedInputTokens).toBe(400); // Exact cache-read only
      expect(usage.inputTokens).toBe(150); // NOT merged with cache reads or writes
      expect(usage.cacheWriteTokens).toBe(1200);
      expect(usage.totalTokens).toBe(150 + 400 + 1200 + 80);
      expect(usage).not.toHaveProperty("cache_creation_input_tokens");
      expect(usage).not.toHaveProperty("cacheCreationInputTokens");

      const parsed = ProviderReportedUsageSchema.parse(usage);
      expect(parsed.cacheWriteTokens).toBe(1200);
    });

    it("keeps legacy usage without a request id unchanged: cache writes unreported", () => {
      const legacy = decodeClaudeTranscriptLine(
        {
          type: "assistant",
          content: "Cached response",
          usage: {
            input_tokens: 150,
            output_tokens: 80,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 1200,
          },
        },
        sessionId,
        9,
      )[0]?.providerUsage;
      expect(legacy).toMatchObject({ availability: "partial", inputTokens: 150 });
      expect(legacy?.usageScope).toBeUndefined();
      expect(legacy?.requestId).toBeUndefined();
      expect(legacy?.cacheWriteTokens).toBeUndefined();
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
      // Events produced: model_reasoning, tool_call(Bash), tool_call(Edit), message(assistant)
      expect(events.length).toBeGreaterThanOrEqual(4);

      const messageEvents = events.filter((e) => e.type === "message");

      // message event receives providerUsage
      expect(messageEvents).toHaveLength(1);
      expect(messageEvents[0].type === "message" && messageEvents[0].providerUsage).toBeDefined();
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

  it("reports one usage snapshot per request when Claude repeats it across a message's lines", () => {
    const transcript = fs.readFileSync(
      path.join(
        __dirname,
        "fixtures/recorded/2.1.283/projects/-workspace-project/8ea90a99-82b6-4c6c-b8cb-4fa5f5dee9dd.jsonl",
      ),
      "utf8",
    );
    const records = transcript
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const usageByMessage = new Map<string, Record<string, number>>();
    let assistantLines = 0;
    for (const record of records) {
      if (record.type !== "assistant") continue;
      assistantLines += 1;
      usageByMessage.set(record.message.id, record.message.usage);
    }
    // The fixture really does repeat each message's usage on every content-block line.
    expect(assistantLines).toBeGreaterThan(usageByMessage.size);

    const decoder = new ClaudeRecordDecoder();
    const usages = records.flatMap((rawPayload, sequenceNumber) =>
      decoder
        .decode({ harnessId: "claude-code", sessionId, sequenceNumber, rawPayload })
        .flatMap((event) => (event.providerUsage ? [event.providerUsage] : [])),
    );

    // Each line of one message repeats an identical snapshot, so each request reports once.
    expect(usages).toHaveLength(usageByMessage.size);
    expect(usages.map((usage) => usage.requestId)).toEqual([...usageByMessage.keys()]);
    for (const usage of usages) {
      const raw = usageByMessage.get(usage.requestId ?? "");
      if (!raw) throw new Error("Expected recorded usage");
      expect(usage).toMatchObject({
        usageScope: "request",
        availability: "complete",
        inputTokens: raw.input_tokens,
        cachedInputTokens: raw.cache_read_input_tokens,
        cacheWriteTokens: raw.cache_creation_input_tokens,
        outputTokens: raw.output_tokens,
        totalTokens:
          raw.input_tokens +
          raw.cache_read_input_tokens +
          raw.cache_creation_input_tokens +
          raw.output_tokens,
      });
      expect(ProviderReportedUsageSchema.safeParse(usage).success).toBe(true);
    }
  });

  describe("request-scoped model usage and links", () => {
    const usage = {
      input_tokens: 9,
      cache_creation_input_tokens: 8686,
      cache_read_input_tokens: 13689,
      output_tokens: 155,
      output_tokens_details: { thinking_tokens: 71 },
      cache_creation: { ephemeral_5m_input_tokens: 8000, ephemeral_1h_input_tokens: 686 },
      service_tier: "standard",
    };
    const assistantLine = (
      fields: { uuid?: string; requestId?: string; id?: string },
      content: ClaudeTranscriptPayload,
      lineUsage: ClaudeTranscriptPayload | null = usage,
    ): ClaudeTranscriptPayload => ({
      type: "assistant",
      ...(fields.uuid ? { uuid: fields.uuid } : {}),
      ...(fields.requestId ? { requestId: fields.requestId } : {}),
      message: {
        ...(fields.id ? { id: fields.id } : {}),
        model: "claude-haiku-4-5-20251001",
        content: [content],
        stop_reason: "tool_use",
        ...(lineUsage ? { usage: lineUsage } : {}),
      },
    });
    const text = { type: "text", text: "Working." };
    const toolUse = (id: string, name: string, input: ClaudeTranscriptPayload = {}) => ({
      type: "tool_use",
      id,
      name,
      input,
    });
    const userRecord = (uuid: string | undefined, content: ClaudeTranscriptValue) => ({
      type: "user",
      ...(uuid ? { uuid } : {}),
      message: { role: "user", content },
    });

    it("identifies the request by message id, else the line's requestId, never the line uuid", () => {
      const byMessage = decodeClaudeTranscriptLine(
        assistantLine({ uuid: "line-1", requestId: "req_1", id: "msg_1" }, text),
        sessionId,
      )[0];
      expect(byMessage?.providerUsage).toMatchObject({ usageScope: "request", requestId: "msg_1" });
      expect(byMessage?.metadata?.modelRequestId).toBe("msg_1");

      const byRequest = decodeClaudeTranscriptLine(
        assistantLine({ uuid: "line-2", requestId: "req_2" }, text),
        sessionId,
      )[0];
      expect(byRequest?.providerUsage).toMatchObject({ usageScope: "request", requestId: "req_2" });

      const uuidOnly = decodeClaudeTranscriptLine(
        assistantLine({ uuid: "line-3" }, text),
        sessionId,
      )[0];
      expect(uuidOnly?.providerUsage?.usageScope).toBeUndefined();
      expect(uuidOnly?.providerUsage?.requestId).toBeUndefined();
      expect(uuidOnly?.metadata?.modelRequestId).toBeUndefined();
    });

    it("reports disjoint categories: uncached input, cache reads and writes, reasoning in output", () => {
      const reported = decodeClaudeTranscriptLine(
        assistantLine({ id: "msg_1" }, text),
        sessionId,
      )[0]?.providerUsage;
      if (!reported) throw new Error("Expected providerUsage");
      expect(reported).toMatchObject({
        availability: "complete",
        inputTokens: 9,
        cachedInputTokens: 13689,
        cacheWriteTokens: 8686,
        outputTokens: 155,
        reasoningTokens: 71,
        // The cache_creation TTL split subdivides cache writes and is never added.
        totalTokens: 9 + 13689 + 8686 + 155,
      });
      expect(providerUsageNormalizedTotal(ProviderReportedUsageSchema.parse(reported))).toBe(22539);
    });

    it("is partial, keeping every reported value, when a category is missing or counts disagree", () => {
      const decodeUsage = (lineUsage: ClaudeTranscriptPayload) =>
        decodeClaudeTranscriptLine(assistantLine({ id: "msg_1" }, text, lineUsage), sessionId)[0]
          ?.providerUsage;

      const { cache_creation_input_tokens: _omitted, ...noCacheWrite } = usage;
      const missing = decodeUsage(noCacheWrite);
      expect(missing).toMatchObject({ availability: "partial", inputTokens: 9, outputTokens: 155 });
      expect(missing?.cacheWriteTokens).toBeUndefined();
      expect(missing?.totalTokens).toBeUndefined();

      const inconsistent = decodeUsage({ ...usage, total_tokens: 999 });
      expect(inconsistent).toMatchObject({
        availability: "partial",
        totalTokens: 999,
        inputTokens: 9,
        cachedInputTokens: 13689,
        cacheWriteTokens: 8686,
        outputTokens: 155,
      });

      const excessReasoning = decodeUsage({
        ...usage,
        output_tokens_details: { thinking_tokens: 500 },
      });
      expect(excessReasoning).toMatchObject({
        availability: "partial",
        reasoningTokens: 500,
        outputTokens: 155,
      });
      expect(excessReasoning?.totalTokens).toBeUndefined();
      for (const reported of [missing, inconsistent, excessReasoning]) {
        expect(ProviderReportedUsageSchema.safeParse(reported).success).toBe(true);
      }
    });

    it("repeats a request's snapshot only when it changes, and keeps distinct requests apart", () => {
      const decoder = new ClaudeRecordDecoder();
      const decode = (rawPayload: ClaudeTranscriptPayload, sequenceNumber: number) =>
        decoder.decode({ harnessId: "claude-code", sessionId, sequenceNumber, rawPayload });
      const streaming = { ...usage, output_tokens: 12 };
      const thinking = { type: "thinking", thinking: "" };

      const first = decode(assistantLine({ id: "msg_a" }, thinking, streaming), 1);
      const same = decode(assistantLine({ id: "msg_a" }, text, streaming), 2);
      const grown = decode(assistantLine({ id: "msg_a" }, toolUse("toolu_a", "Read")), 3);
      const other = decode(assistantLine({ id: "msg_b" }, text), 4);

      const earlier = first[0]?.providerUsage;
      const later = grown[0]?.providerUsage;
      if (!earlier || !later) throw new Error("Expected both snapshots");
      expect(same[0]?.providerUsage).toBeUndefined();
      expect(earlier.outputTokens).toBe(12);
      expect(later.outputTokens).toBe(155);
      expect(providerUsageRequestKey(sessionId, earlier)).toBe(
        providerUsageRequestKey(sessionId, later),
      );
      expect(selectProviderUsageSnapshot(earlier, later)).toBe(later);

      // Identical counts on another response are another request, not a repeat.
      const distinct = other[0]?.providerUsage;
      if (!distinct) throw new Error("Expected providerUsage");
      expect(distinct).toMatchObject({ requestId: "msg_b", outputTokens: 155 });
      expect(providerUsageRequestKey(sessionId, distinct)).not.toBe(
        providerUsageRequestKey(sessionId, later),
      );
    });

    it("keeps an explicit unavailable marker request-scoped, with no metrics", () => {
      const reported = decodeClaudeTranscriptLine(
        assistantLine({ id: "msg_unavailable" }, text, { availability: "unavailable" }),
        sessionId,
      )[0]?.providerUsage;
      expect(reported).toEqual({
        provider: CLAUDE_PROVIDER,
        accountingVersion: CLAUDE_ACCOUNTING_VERSION,
        availability: "unavailable",
        usageScope: "request",
        requestId: "msg_unavailable",
        model: "claude-haiku-4-5-20251001",
      });
      expect(ProviderReportedUsageSchema.safeParse(reported).success).toBe(true);
    });

    it("reports no usage and no request for Claude's locally written synthetic messages", () => {
      const [event] = decodeClaudeTranscriptLine(
        {
          type: "assistant",
          uuid: "line-synthetic",
          message: {
            id: "00000000-0000-4000-8000-000000000001",
            model: "<synthetic>",
            content: [text],
            stop_reason: "stop_sequence",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
        sessionId,
      );
      expect(event?.type).toBe("message");
      expect(event?.providerUsage).toBeUndefined();
      expect(event?.metadata?.modelRequestId).toBeUndefined();
    });

    it("links a response without usage to its request without inventing usage", () => {
      const events = decodeClaudeTranscriptLine(
        assistantLine({ id: "msg_nousage" }, text, null),
        sessionId,
      );
      expect(events[0]?.providerUsage).toBeUndefined();
      expect(events[0]?.metadata?.modelRequestId).toBe("msg_nousage");
    });

    it("links parallel tool calls of one response, and their results, to that response", () => {
      const decoder = new ClaudeRecordDecoder();
      const decode = (rawPayload: ClaudeTranscriptPayload, sequenceNumber: number) =>
        decoder.decode({ harnessId: "claude-code", sessionId, sequenceNumber, rawPayload });
      const readA = toolUse("toolu_1", "Read", { file_path: "a" });
      const readB = toolUse("toolu_2", "Read", { file_path: "b" });
      const calls = [
        ...decode(assistantLine({ id: "msg_p" }, readA), 1),
        ...decode(assistantLine({ id: "msg_p" }, readB), 2),
      ];
      expect(calls.map((event) => [event.type, event.metadata?.modelRequestId])).toEqual([
        ["tool_call", "msg_p"],
        ["tool_call", "msg_p"],
      ]);

      const results = decode(
        userRecord("results-1", [
          { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "b" },
        ]),
        3,
      );
      expect(results.map((event) => [event.type, event.metadata?.modelRequestId])).toEqual([
        ["tool_result", "msg_p"],
        ["tool_result", "msg_p"],
      ]);
    });

    it("links events to the preceding genuine user prompt, not tool results or notices", () => {
      const decoder = new ClaudeRecordDecoder();
      let sequence = 0;
      const decode = (
        rawPayload: ClaudeTranscriptPayload,
        session = sessionId,
      ): IntermediateSessionEvent[] =>
        decoder.decode({
          harnessId: "claude-code",
          sessionId: session,
          sequenceNumber: ++sequence,
          rawPayload,
        });
      const taskIds = (events: IntermediateSessionEvent[]) =>
        events.map((event) => event.metadata?.taskId);

      // Unknown until a prompt is seen.
      expect(taskIds(decode(assistantLine({ id: "msg_0" }, text)))).toEqual([undefined]);

      expect(taskIds(decode(userRecord("prompt-1", "Do it.")))).toEqual(["prompt-1"]);
      decode(assistantLine({ id: "msg_1" }, toolUse("toolu_t", "Read")));
      const result = decode(
        userRecord("result-1", [{ type: "tool_result", tool_use_id: "toolu_t", content: "ok" }]),
      );
      expect(taskIds(result)).toEqual(["prompt-1"]);
      decode(userRecord("notice-1", [{ type: "text", text: "[Request interrupted by user]" }]));
      decode({ ...userRecord("meta-1", "<local-command-stdout>"), isMeta: true });
      expect(taskIds(decode(assistantLine({ id: "msg_2" }, text)))).toEqual(["prompt-1"]);

      const prompt2 = decode(userRecord("prompt-2", [{ type: "text", text: "Next." }]));
      expect(taskIds(prompt2)).toEqual(["prompt-2"]);
      expect(taskIds(decode(assistantLine({ id: "msg_3" }, text)))).toEqual(["prompt-2"]);

      // Tasks are per session.
      expect(taskIds(decode(assistantLine({ id: "msg_4" }, text), "other-session"))).toEqual([
        undefined,
      ]);
    });

    it("reads invocation receipts only from Resin gateway tool results", () => {
      const invocationId = `inv_${"a".repeat(32)}`;
      const receipt = formatResinInvocationReceiptText({ invocationId, benchmarkId: "bench-1" });
      const receiptContent = [
        { type: "text", text: '{"ok":true}' },
        { type: "text", text: receipt },
      ];
      const resultFor = (toolName: string, toolUseId: string) => {
        const decoder = new ClaudeRecordDecoder();
        decoder.decode({
          harnessId: "claude-code",
          sessionId,
          sequenceNumber: 1,
          rawPayload: assistantLine({ id: "msg_r" }, toolUse(toolUseId, toolName)),
        });
        return decoder.decode({
          harnessId: "claude-code",
          sessionId,
          sequenceNumber: 2,
          rawPayload: {
            ...userRecord(undefined, [
              { type: "tool_result", tool_use_id: toolUseId, content: receiptContent },
            ]),
            toolUseResult: receiptContent,
          },
        })[0];
      };

      expect(resultFor("mcp__resin__invoke_tool", "toolu_resin")?.metadata).toMatchObject({
        resinInvocationId: invocationId,
        benchmarkId: "bench-1",
        modelRequestId: "msg_r",
      });
      const other = resultFor("mcp__other__invoke_tool", "toolu_other")?.metadata;
      expect(other?.resinInvocationId).toBeUndefined();
      expect(other?.benchmarkId).toBeUndefined();
      expect(other?.modelRequestId).toBe("msg_r");
    });
  });
});
