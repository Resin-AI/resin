import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderReportedUsageSchema } from "@resin/contracts";
import type {
  IntermediateBranchForkEvent,
  IntermediateCommandExecEvent,
  IntermediateCompactionEvent,
  IntermediateErrorEvent,
  IntermediateFileEditEvent,
  IntermediateMessageEvent,
  IntermediateModelReasoningEvent,
  IntermediateSessionLifecycleEvent,
  IntermediateSubagentLifecycleEvent,
  IntermediateToolCallEvent,
  IntermediateToolResultEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpRecordDecoder } from "../src/decoder.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../fixtures");

describe("OMP JSONL Session Decoder & Normalization", () => {
  const decoder = new OmpRecordDecoder();

  it("has correct decoder metadata and identification", () => {
    expect(decoder.harnessId).toBe("omp");
    expect(decoder.decoderVersion).toBe("1.0.0");
  });

  it("canDecode recognizes OMP records and typical JSON structures", () => {
    expect(
      decoder.canDecode({
        recordId: "r1",
        sessionId: "s1",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: new Date().toISOString(),
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
        rawPayload: "{}",
        metadata: {},
      }),
    ).toBe(true);

    expect(
      decoder.canDecode({
        recordId: "r2",
        sessionId: "s1",
        harnessId: "other",
        sequenceNumber: 1,
        recordType: "prompt",
        timestamp: new Date().toISOString(),
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
        rawPayload: JSON.stringify({ type: "message", role: "user", content: "hi" }),
        metadata: {},
      }),
    ).toBe(true);
  });

  it("decodes entire golden session-full.jsonl fixture into typed intermediate events", async () => {
    const filePath = path.join(fixturesDir, "session-full.jsonl");
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const decodedEvents = lines.map((line, idx) => {
      const record: RawHarnessRecord = {
        recordId: `rec-${idx + 1}`,
        sessionId: "session-golden-1",
        harnessId: "omp",
        sequenceNumber: idx + 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T10:00:00.000Z",
        cursor: {
          offset: idx * 100,
          line: idx + 1,
          sequence: idx + 1,
          timestamp: "2026-08-17T10:00:00.000Z",
        },
        rawPayload: line,
        metadata: {},
      };
      return decoder.decode(record);
    });

    expect(decodedEvents.length).toBe(14);

    // 0: session_lifecycle (start)
    const ev0 = decodedEvents[0] as IntermediateSessionLifecycleEvent;
    expect(ev0.type).toBe("session_lifecycle");
    expect(ev0.lifecycleType).toBe("start");
    expect(ev0.harnessName).toBe("omp");

    // 1: message (user)
    const ev1 = decodedEvents[1] as IntermediateMessageEvent;
    expect(ev1.type).toBe("message");
    expect(ev1.role).toBe("user");
    expect(ev1.content).toContain("Inspect the repository");

    // 2: model_reasoning
    const ev2 = decodedEvents[2] as IntermediateModelReasoningEvent;
    expect(ev2.type).toBe("model_reasoning");
    expect(ev2.reasoningContent).toContain("I will start by checking");
    expect(ev2.model).toBe("gemini-3.7-flash");

    // 3: tool_call
    const ev3 = decodedEvents[3] as IntermediateToolCallEvent;
    expect(ev3.type).toBe("tool_call");
    expect(ev3.toolName).toBe("read");
    expect(ev3.callId).toBe("call_101");
    expect(ev3.parameters).toEqual({ path: "src/auth.ts" });

    // 4: tool_result
    const ev4 = decodedEvents[4] as IntermediateToolResultEvent;
    expect(ev4.type).toBe("tool_result");
    expect(ev4.toolName).toBe("read");
    expect(ev4.callId).toBe("call_101");
    expect(ev4.isError).toBe(false);
    expect(ev4.executionDurationMs).toBe(15);

    // 5: command_exec
    const ev5 = decodedEvents[5] as IntermediateCommandExecEvent;
    expect(ev5.type).toBe("command_exec");
    expect(ev5.command).toBe("pnpm test");
    expect(ev5.exitCode).toBe(0);
    expect(ev5.durationMs).toBe(340);
    expect(ev5.stdout).toContain("PASS src/auth.test.ts");

    // 6: file_edit
    const ev6 = decodedEvents[6] as IntermediateFileEditEvent;
    expect(ev6.type).toBe("file_edit");
    expect(ev6.filePath).toBe("src/auth.ts");
    expect(ev6.operation).toBe("patch");
    expect(ev6.diffStats).toEqual({ additions: 1, deletions: 1, modifications: 0 });

    // 7: subagent_lifecycle (spawn)
    const ev7 = decodedEvents[7] as IntermediateSubagentLifecycleEvent;
    expect(ev7.type).toBe("subagent_lifecycle");
    expect(ev7.subagentId).toBe("subagent-scout-99");
    expect(ev7.lifecycleType).toBe("spawn");
    expect(ev7.parentId).toBe("session-golden-1");
    expect(ev7.role).toBe("scout");

    // 8: subagent_lifecycle (settle)
    const ev8 = decodedEvents[8] as IntermediateSubagentLifecycleEvent;
    expect(ev8.type).toBe("subagent_lifecycle");
    expect(ev8.subagentId).toBe("subagent-scout-99");
    expect(ev8.lifecycleType).toBe("settle");

    // 9: compaction
    const ev9 = decodedEvents[9] as IntermediateCompactionEvent;
    expect(ev9.type).toBe("compaction");
    expect(ev9.triggerReason).toBe("context_limit");
    expect(ev9.tokensBefore).toBe(128000);
    expect(ev9.tokensAfter).toBe(24000);
    expect(ev9.preservedContextSummary).toContain("Summarized initial inspection");

    // 10: branch_fork
    const ev10 = decodedEvents[10] as IntermediateBranchForkEvent;
    expect(ev10.type).toBe("branch_fork");
    expect(ev10.sourceSessionId).toBe("session-golden-1");
    expect(ev10.branchName).toBe("alt-auth-branch");

    // 11: error
    const ev11 = decodedEvents[11] as IntermediateErrorEvent;
    expect(ev11.type).toBe("error");
    expect(ev11.errorType).toBe("ValidationError");
    expect(ev11.message).toBe("Token string cannot be empty");
    expect(ev11.recoverable).toBe(true);

    // 12: message (assistant)
    const ev12 = decodedEvents[12] as IntermediateMessageEvent;
    expect(ev12.type).toBe("message");
    expect(ev12.role).toBe("assistant");
    expect(ev12.content).toContain("Successfully refactored authenticate");

    // 13: session_lifecycle (end)
    const ev13 = decodedEvents[13] as IntermediateSessionLifecycleEvent;
    expect(ev13.type).toBe("session_lifecycle");
    expect(ev13.lifecycleType).toBe("end");
    expect(ev13.exitReason).toBe("task_completed");
  });

  it("decodes subagents session fixture with hierarchical parentId and roles", async () => {
    const filePath = path.join(fixturesDir, "session-subagents.jsonl");
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const subagentEvents = lines
      .map((line, idx) => {
        return decoder.decode({
          recordId: `r-${idx}`,
          sessionId: "session-subagents-1",
          harnessId: "omp",
          sequenceNumber: idx + 1,
          recordType: "transcript_line",
          timestamp: new Date().toISOString(),
          cursor: {
            offset: 0,
            line: idx + 1,
            sequence: idx + 1,
            timestamp: new Date().toISOString(),
          },
          rawPayload: line,
          metadata: {},
        });
      })
      .filter((ev): ev is IntermediateSubagentLifecycleEvent => ev?.type === "subagent_lifecycle");

    expect(subagentEvents.length).toBe(6);
    expect(subagentEvents.map((s) => s.subagentId)).toEqual([
      "scout-01",
      "scout-01",
      "scout-01",
      "writer-01",
      "writer-01",
      "writer-01",
    ]);
    expect(subagentEvents.map((s) => s.lifecycleType)).toEqual([
      "spawn",
      "start",
      "settle",
      "spawn",
      "start",
      "settle",
    ]);
  });

  it("decodes compaction session fixture with token differential", async () => {
    const filePath = path.join(fixturesDir, "session-compaction.jsonl");
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const events = lines.map((line, idx) =>
      decoder.decode({
        recordId: `r-${idx}`,
        sessionId: "session-compaction-1",
        harnessId: "omp",
        sequenceNumber: idx + 1,
        recordType: "transcript_line",
        timestamp: new Date().toISOString(),
        cursor: {
          offset: 0,
          line: idx + 1,
          sequence: idx + 1,
          timestamp: new Date().toISOString(),
        },
        rawPayload: line,
        metadata: {},
      }),
    );

    const compaction = events.find(
      (e): e is IntermediateCompactionEvent => e?.type === "compaction",
    );
    expect(compaction).toBeDefined();
    expect(compaction?.tokensBefore).toBe(195000);
    expect(compaction?.tokensAfter).toBe(15000);
    expect(compaction?.preservedContextSummary).toContain("Log contained 4 error lines");
  });

  it("handles snake_case and alternative field names gracefully", () => {
    const toolCallRecord: RawHarnessRecord = {
      recordId: "tc1",
      sessionId: "s1",
      harnessId: "omp",
      sequenceNumber: 1,
      recordType: "tool_call",
      timestamp: new Date().toISOString(),
      cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
      rawPayload: JSON.stringify({
        type: "tool_call",
        tool_name: "custom_grep",
        call_id: "call_999",
        args: { pattern: "regex" },
      }),
      metadata: {},
    };

    const decoded = decoder.decode(toolCallRecord) as IntermediateToolCallEvent;
    expect(decoded.type).toBe("tool_call");
    expect(decoded.toolName).toBe("custom_grep");
    expect(decoded.callId).toBe("call_999");
    expect(decoded.parameters).toEqual({ pattern: "regex" });
  });

  it("falls back to unknown_passthrough for unrecognized event structures", () => {
    const unknownRecord: RawHarnessRecord = {
      recordId: "u1",
      sessionId: "s1",
      harnessId: "omp",
      sequenceNumber: 1,
      recordType: "custom",
      timestamp: new Date().toISOString(),
      cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
      rawPayload: JSON.stringify({
        type: "custom_telemetry_event",
        metricName: "cpu_usage",
        value: 42,
      }),
      metadata: {},
    };

    const decoded = decoder.decode(unknownRecord);
    expect(decoded?.type).toBe("unknown_passthrough");
  });

  describe("OMP Provider-Reported Usage Extraction", () => {
    it("decodes complete providerUsage with explicit totals and optional metrics", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-complete-1",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:00.000Z",
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: "2026-08-17T12:00:00.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Here is the refactored code.",
          provider: "openai",
          model: "gpt-4o-2024-08-06",
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 450,
            total_tokens: 1950,
            prompt_tokens_details: {
              cached_tokens: 500,
            },
            completion_tokens_details: {
              reasoning_tokens: 120,
            },
            cost_micro_usd: 12500,
            duration_ms: 1840,
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.type).toBe("message");
      expect(decoded.providerUsage).toBeDefined();

      const usage = decoded.providerUsage!;
      expect(usage.availability).toBe("complete");
      expect(usage.provider).toBe("openai");
      expect(usage.model).toBe("gpt-4o-2024-08-06");
      expect(usage.accountingVersion).toBe("omp-v1");
      expect(usage.inputTokens).toBe(1500);
      expect(usage.outputTokens).toBe(450);
      expect(usage.totalTokens).toBe(1950);
      expect(usage.cachedInputTokens).toBe(500);
      expect(usage.reasoningTokens).toBe(120);
      expect(usage.costMicroUsd).toBe(12500);
      expect(usage.durationMs).toBe(1840);

      // Validate against shared schema
      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("defaults provider to 'omp' and leaves model undefined when omitted in raw record", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-defaults-1",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 2,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:01.000Z",
        cursor: { offset: 0, line: 2, sequence: 2, timestamp: "2026-08-17T12:00:01.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Done.",
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            total_tokens: 280,
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage).toBeDefined();
      const usage = decoded.providerUsage!;
      expect(usage.provider).toBe("omp");
      expect(usage.model).toBeUndefined();
      expect(usage.accountingVersion).toBe("omp-v1");
      expect(usage.availability).toBe("complete");
      expect(usage.inputTokens).toBe(200);
      expect(usage.outputTokens).toBe(80);
      expect(usage.totalTokens).toBe(280);

      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("marks availability as partial when totalTokens is absent and NEVER sums input/output", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-partial-1",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 3,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:02.000Z",
        cursor: { offset: 0, line: 3, sequence: 3, timestamp: "2026-08-17T12:00:02.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Partial usage without total.",
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          usage: {
            input_tokens: 600,
            output_tokens: 300,
            // Notice: total_tokens is omitted!
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage).toBeDefined();
      const usage = decoded.providerUsage!;
      expect(usage.availability).toBe("partial");
      expect(usage.inputTokens).toBe(600);
      expect(usage.outputTokens).toBe(300);
      expect(usage.totalTokens).toBeUndefined(); // NEVER derived as 900
      expect(usage.provider).toBe("anthropic");
      expect(usage.model).toBe("claude-3-7-sonnet");

      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("marks availability as partial when explicit availability is complete but totalTokens is absent", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-partial-2",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 4,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:03.000Z",
        cursor: { offset: 0, line: 4, sequence: 4, timestamp: "2026-08-17T12:00:03.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Reported complete but missing total.",
          usage: {
            availability: "complete",
            input_tokens: 50,
            output_tokens: 25,
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage).toBeDefined();
      const usage = decoded.providerUsage!;
      // Schema requires complete to have totalTokens; decoder safely downgrades to partial
      expect(usage.availability).toBe("partial");
      expect(usage.totalTokens).toBeUndefined();
      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("extracts partial usage when only a subset of metrics or costs are provided", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-partial-subset",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 5,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:04.000Z",
        cursor: { offset: 0, line: 5, sequence: 5, timestamp: "2026-08-17T12:00:04.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Cost only report.",
          usage: {
            cost_micro_usd: 5000,
            duration_ms: 450,
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage).toBeDefined();
      const usage = decoded.providerUsage!;
      expect(usage.availability).toBe("partial");
      expect(usage.inputTokens).toBeUndefined();
      expect(usage.outputTokens).toBeUndefined();
      expect(usage.totalTokens).toBeUndefined();
      expect(usage.costMicroUsd).toBe(5000);
      expect(usage.durationMs).toBe(450);
      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("returns undefined providerUsage when usage fields are absent", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-absent-1",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 6,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:05.000Z",
        cursor: { offset: 0, line: 6, sequence: 6, timestamp: "2026-08-17T12:00:05.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "user",
          content: "Hello world without usage metrics.",
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.type).toBe("message");
      expect(decoded.providerUsage).toBeUndefined();
    });

    it("decodes unavailable providerUsage with no metric fields when flagged unavailable", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-usage-unavail-1",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 7,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:06.000Z",
        cursor: { offset: 0, line: 7, sequence: 7, timestamp: "2026-08-17T12:00:06.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Provider does not report tokens.",
          provider: "custom-local",
          model: "local-llama",
          usage: {
            availability: "unavailable",
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage).toBeDefined();
      const usage = decoded.providerUsage!;
      expect(usage.availability).toBe("unavailable");
      expect(usage.provider).toBe("custom-local");
      expect(usage.model).toBe("local-llama");
      expect(usage.accountingVersion).toBe("omp-v1");
      expect(usage.inputTokens).toBeUndefined();
      expect(usage.outputTokens).toBeUndefined();
      expect(usage.totalTokens).toBeUndefined();
      expect(usage.cachedInputTokens).toBeUndefined();
      expect(usage.reasoningTokens).toBeUndefined();
      expect(usage.costMicroUsd).toBeUndefined();
      expect(usage.durationMs).toBeUndefined();

      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("handles malformed usage payloads gracefully without crashing and returns undefined", () => {
      const malformedCases = [
        { usage: "not-an-object" },
        { usage: 12345 },
        { usage: true },
        { usage: [] },
        { usage: null },
        { usage: { input_tokens: -100 } },
        { usage: { total_tokens: "invalid_non_numeric" } },
        { usage: { total_tokens: -1, input_tokens: -5 } },
      ];

      for (const [idx, malformed] of malformedCases.entries()) {
        const record: RawHarnessRecord = {
          recordId: `rec-malformed-${idx}`,
          sessionId: "sess-usage-malformed",
          harnessId: "omp",
          sequenceNumber: idx + 1,
          recordType: "transcript_line",
          timestamp: "2026-08-17T12:00:07.000Z",
          cursor: {
            offset: 0,
            line: idx + 1,
            sequence: idx + 1,
            timestamp: "2026-08-17T12:00:07.000Z",
          },
          rawPayload: JSON.stringify({
            type: "message",
            role: "assistant",
            content: "Malformed usage response.",
            ...malformed,
          }),
          metadata: {},
        };

        expect(() => {
          const decoded = decoder.decode(record);
          expect(decoded).toBeDefined();
          // Malformed usage should safely yield undefined providerUsage without throwing
          expect((decoded as IntermediateMessageEvent)?.providerUsage).toBeUndefined();
        }).not.toThrow();
      }
    });

    it("never uses model_reasoning tokenCount as total usage or providerUsage", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-reasoning-token-count-1",
        sessionId: "sess-usage-reasoning",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:08.000Z",
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: "2026-08-17T12:00:08.000Z" },
        rawPayload: JSON.stringify({
          type: "model_reasoning",
          reasoningContent: "Thinking through the auth algorithm...",
          tokenCount: 350,
          model: "gemini-3.7-flash",
          durationMs: 800,
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateModelReasoningEvent;
      expect(decoded.type).toBe("model_reasoning");
      expect(decoded.reasoningContent).toBe("Thinking through the auth algorithm...");
      expect(decoded.tokenCount).toBe(350);
      expect(decoded.model).toBe("gemini-3.7-flash");
      expect(decoded.durationMs).toBe(800);
      // tokenCount is NOT converted into providerUsage
      expect(decoded.providerUsage).toBeUndefined();
    });

    it("extracts providerUsage on model_reasoning when explicit usage is present alongside tokenCount without collision", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-reasoning-with-usage-1",
        sessionId: "sess-usage-reasoning",
        harnessId: "omp",
        sequenceNumber: 2,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:09.000Z",
        cursor: { offset: 0, line: 2, sequence: 2, timestamp: "2026-08-17T12:00:09.000Z" },
        rawPayload: JSON.stringify({
          type: "model_reasoning",
          reasoningContent: "Detailed planning steps...",
          tokenCount: 180, // Thought block token count
          model: "deepseek-r1",
          provider: "deepseek",
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 180,
            total_tokens: 1380,
            completion_tokens_details: {
              reasoning_tokens: 180,
            },
          },
        }),
        metadata: {},
      };

      const decoded = decoder.decode(record) as IntermediateModelReasoningEvent;
      expect(decoded.type).toBe("model_reasoning");
      expect(decoded.tokenCount).toBe(180);
      expect(decoded.providerUsage).toBeDefined();

      const usage = decoded.providerUsage!;
      expect(usage.availability).toBe("complete");
      expect(usage.provider).toBe("deepseek");
      expect(usage.model).toBe("deepseek-r1");
      expect(usage.inputTokens).toBe(1200);
      expect(usage.outputTokens).toBe(180);
      expect(usage.totalTokens).toBe(1380);
      expect(usage.reasoningTokens).toBe(180);
      expect(() => ProviderReportedUsageSchema.parse(usage)).not.toThrow();
    });

    it("extracts providerUsage across tool calls, tool results, compactions, and errors", () => {
      // Tool call with usage
      const toolCallRecord: RawHarnessRecord = {
        recordId: "rec-tool-usage-1",
        sessionId: "sess-multi-event",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:10.000Z",
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: "2026-08-17T12:00:10.000Z" },
        rawPayload: JSON.stringify({
          type: "tool_call",
          toolName: "bash",
          parameters: { command: "git status" },
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        metadata: {},
      };
      const decodedToolCall = decoder.decode(toolCallRecord) as IntermediateToolCallEvent;
      expect(decodedToolCall.type).toBe("tool_call");
      expect(decodedToolCall.providerUsage?.totalTokens).toBe(120);

      // Compaction with usage
      const compactionRecord: RawHarnessRecord = {
        recordId: "rec-compact-usage-1",
        sessionId: "sess-multi-event",
        harnessId: "omp",
        sequenceNumber: 2,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:11.000Z",
        cursor: { offset: 0, line: 2, sequence: 2, timestamp: "2026-08-17T12:00:11.000Z" },
        rawPayload: JSON.stringify({
          type: "compaction",
          triggerReason: "context_limit",
          tokensBefore: 120000,
          tokensAfter: 20000,
          usage: { prompt_tokens: 120000, completion_tokens: 2000, total_tokens: 122000 },
        }),
        metadata: {},
      };
      const decodedCompact = decoder.decode(compactionRecord) as IntermediateCompactionEvent;
      expect(decodedCompact.type).toBe("compaction");
      expect(decodedCompact.providerUsage?.totalTokens).toBe(122000);

      // Error with partial usage
      const errorRecord: RawHarnessRecord = {
        recordId: "rec-err-usage-1",
        sessionId: "sess-multi-event",
        harnessId: "omp",
        sequenceNumber: 3,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:12.000Z",
        cursor: { offset: 0, line: 3, sequence: 3, timestamp: "2026-08-17T12:00:12.000Z" },
        rawPayload: JSON.stringify({
          type: "error",
          errorType: "RateLimitError",
          message: "Provider rate limit reached",
          usage: { input_tokens: 500 },
        }),
        metadata: {},
      };
      const decodedError = decoder.decode(errorRecord) as IntermediateErrorEvent;
      expect(decodedError.type).toBe("error");
      expect(decodedError.providerUsage?.availability).toBe("partial");
      expect(decodedError.providerUsage?.inputTokens).toBe(500);
    });

    it("extracts tokens and costs from diverse payload formats (tokens obj, float usd, top level fields)", () => {
      // 1. Nested tokens object
      const tokensObjRecord: RawHarnessRecord = {
        recordId: "rec-tokens-obj",
        sessionId: "sess-formats",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:13.000Z",
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: "2026-08-17T12:00:13.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Tokens object test.",
          tokens: {
            input: 80,
            output: 40,
            cached: 20,
            reasoning: 10,
            total: 120,
          },
        }),
        metadata: {},
      };
      const decodedTokensObj = decoder.decode(tokensObjRecord) as IntermediateMessageEvent;
      expect(decodedTokensObj.providerUsage).toBeDefined();
      expect(decodedTokensObj.providerUsage?.inputTokens).toBe(80);
      expect(decodedTokensObj.providerUsage?.outputTokens).toBe(40);
      expect(decodedTokensObj.providerUsage?.cachedInputTokens).toBe(20);
      expect(decodedTokensObj.providerUsage?.reasoningTokens).toBe(10);
      expect(decodedTokensObj.providerUsage?.totalTokens).toBe(120);

      // 2. Cost as USD float converted to micro USD
      const costUsdRecord: RawHarnessRecord = {
        recordId: "rec-cost-usd",
        sessionId: "sess-formats",
        harnessId: "omp",
        sequenceNumber: 2,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:14.000Z",
        cursor: { offset: 0, line: 2, sequence: 2, timestamp: "2026-08-17T12:00:14.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "USD cost conversion test.",
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            total_tokens: 1200,
            cost_usd: 0.0035, // $0.0035 = 3500 micro USD
          },
        }),
        metadata: {},
      };
      const decodedCostUsd = decoder.decode(costUsdRecord) as IntermediateMessageEvent;
      expect(decodedCostUsd.providerUsage?.costMicroUsd).toBe(3500);

      // 3. Top-level token fields
      const topLevelRecord: RawHarnessRecord = {
        recordId: "rec-top-level",
        sessionId: "sess-formats",
        harnessId: "omp",
        sequenceNumber: 3,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:15.000Z",
        cursor: { offset: 0, line: 3, sequence: 3, timestamp: "2026-08-17T12:00:15.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Top level token fields.",
          inputTokens: 500,
          outputTokens: 250,
          totalTokens: 750,
        }),
        metadata: {},
      };
      const decodedTopLevel = decoder.decode(topLevelRecord) as IntermediateMessageEvent;
      expect(decodedTopLevel.providerUsage?.inputTokens).toBe(500);
      expect(decodedTopLevel.providerUsage?.outputTokens).toBe(250);
      expect(decodedTopLevel.providerUsage?.totalTokens).toBe(750);
      expect(decodedTopLevel.providerUsage?.availability).toBe("complete");
    });

    it("preserves explicit custom accountingVersion when provided", () => {
      const record: RawHarnessRecord = {
        recordId: "rec-custom-accounting",
        sessionId: "sess-accounting",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:16.000Z",
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: "2026-08-17T12:00:16.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Custom accounting version test.",
          accountingVersion: "omp-v2-experimental",
          usage: {
            input_tokens: 100,
            total_tokens: 150,
          },
        }),
        metadata: {},
      };
      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage?.accountingVersion).toBe("omp-v2-experimental");
    });
  });
});
