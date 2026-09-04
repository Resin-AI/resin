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
  IntermediateUnknownPassthroughEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  RESIN_PARAMETER_SHAPE_KEY,
  projectToolParameters,
} from "../../../apps/observer/src/analytics/metadata-projection.js";
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
    // SAFETY: Decoded event is an IntermediateSessionLifecycleEvent from fixture.
    const ev0 = decodedEvents[0] as IntermediateSessionLifecycleEvent;
    expect(ev0.type).toBe("session_lifecycle");
    expect(ev0.lifecycleType).toBe("start");
    expect(ev0.harnessName).toBe("omp");

    // 1: message (user)
    // SAFETY: Decoded event is an IntermediateMessageEvent from fixture.
    const ev1 = decodedEvents[1] as IntermediateMessageEvent;
    expect(ev1.type).toBe("message");
    expect(ev1.role).toBe("user");
    expect(ev1.content).toContain("Inspect the repository");

    // 2: model_reasoning
    // SAFETY: Decoded event is an IntermediateModelReasoningEvent from fixture.
    const ev2 = decodedEvents[2] as IntermediateModelReasoningEvent;
    expect(ev2.type).toBe("model_reasoning");
    expect(ev2.reasoningContent).toContain("I will start by checking");
    expect(ev2.model).toBe("gemini-3.7-flash");

    // 3: tool_call
    // SAFETY: Decoded event is an IntermediateToolCallEvent from fixture.
    const ev3 = decodedEvents[3] as IntermediateToolCallEvent;
    expect(ev3.type).toBe("tool_call");
    expect(ev3.toolName).toBe("read");
    expect(ev3.callId).toBe("call_101");
    expect(ev3.parameters).toEqual({ path: "src/auth.ts" });

    // 4: tool_result
    // SAFETY: Decoded event is an IntermediateToolResultEvent from fixture.
    const ev4 = decodedEvents[4] as IntermediateToolResultEvent;
    expect(ev4.type).toBe("tool_result");
    expect(ev4.toolName).toBe("read");
    expect(ev4.callId).toBe("call_101");
    expect(ev4.isError).toBe(false);
    expect(ev4.executionDurationMs).toBe(15);

    // 5: command_exec
    // SAFETY: Decoded event is an IntermediateCommandExecEvent from fixture.
    const ev5 = decodedEvents[5] as IntermediateCommandExecEvent;
    expect(ev5.type).toBe("command_exec");
    expect(ev5.command).toBe("pnpm test");
    expect(ev5.exitCode).toBe(0);
    expect(ev5.durationMs).toBe(340);
    expect(ev5.stdout).toContain("PASS src/auth.test.ts");

    // 6: file_edit
    // SAFETY: Decoded event is an IntermediateFileEditEvent from fixture.
    const ev6 = decodedEvents[6] as IntermediateFileEditEvent;
    expect(ev6.type).toBe("file_edit");
    expect(ev6.filePath).toBe("src/auth.ts");
    expect(ev6.operation).toBe("patch");
    expect(ev6.diffStats).toEqual({ additions: 1, deletions: 1, modifications: 0 });

    // 7: subagent_lifecycle (spawn)
    // SAFETY: Decoded event is an IntermediateSubagentLifecycleEvent from fixture.
    const ev7 = decodedEvents[7] as IntermediateSubagentLifecycleEvent;
    expect(ev7.type).toBe("subagent_lifecycle");
    expect(ev7.subagentId).toBe("subagent-scout-99");
    expect(ev7.lifecycleType).toBe("spawn");
    expect(ev7.parentId).toBe("session-golden-1");
    expect(ev7.role).toBe("scout");

    // 8: subagent_lifecycle (settle)
    // SAFETY: Decoded event is an IntermediateSubagentLifecycleEvent from fixture.
    const ev8 = decodedEvents[8] as IntermediateSubagentLifecycleEvent;
    expect(ev8.type).toBe("subagent_lifecycle");
    expect(ev8.subagentId).toBe("subagent-scout-99");
    expect(ev8.lifecycleType).toBe("settle");

    // 9: compaction
    // SAFETY: Decoded event is an IntermediateCompactionEvent from fixture.
    const ev9 = decodedEvents[9] as IntermediateCompactionEvent;
    expect(ev9.type).toBe("compaction");
    expect(ev9.triggerReason).toBe("context_limit");
    expect(ev9.tokensBefore).toBe(128000);
    expect(ev9.tokensAfter).toBe(24000);
    expect(ev9.preservedContextSummary).toContain("Summarized initial inspection");

    // 10: branch_fork
    // SAFETY: Decoded event is an IntermediateBranchForkEvent from fixture.
    const ev10 = decodedEvents[10] as IntermediateBranchForkEvent;
    expect(ev10.type).toBe("branch_fork");
    expect(ev10.sourceSessionId).toBe("session-golden-1");
    expect(ev10.branchName).toBe("alt-auth-branch");

    // 11: error
    // SAFETY: Decoded event is an IntermediateErrorEvent from fixture.
    const ev11 = decodedEvents[11] as IntermediateErrorEvent;
    expect(ev11.type).toBe("error");
    expect(ev11.errorType).toBe("ValidationError");
    expect(ev11.message).toBe("Token string cannot be empty");
    expect(ev11.recoverable).toBe(true);

    // 12: message (assistant)
    // SAFETY: Decoded event is an IntermediateMessageEvent from fixture.
    const ev12 = decodedEvents[12] as IntermediateMessageEvent;
    expect(ev12.type).toBe("message");
    expect(ev12.role).toBe("assistant");
    expect(ev12.content).toContain("Successfully refactored authenticate");

    // 13: session_lifecycle (end)
    // SAFETY: Decoded event is an IntermediateSessionLifecycleEvent from fixture.
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

    // SAFETY: Decoded event is an IntermediateToolCallEvent.
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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

    it("reads OMP's native usage shape including cacheRead", () => {
      // OMP session lines carry `usage: { input, output, cacheRead, cacheWrite, totalTokens }`;
      // cacheRead was silently dropped, so per-turn context re-send never reached the cloud.
      const record: RawHarnessRecord = {
        recordId: "rec-usage-omp-native-1",
        sessionId: "sess-usage-1",
        harnessId: "omp",
        sequenceNumber: 9,
        recordType: "transcript_line",
        timestamp: "2026-08-17T12:00:09.000Z",
        cursor: { offset: 0, line: 9, sequence: 9, timestamp: "2026-08-17T12:00:09.000Z" },
        rawPayload: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "ok",
          provider: "google-antigravity",
          model: "gemini-3.8-flash",
          usage: { input: 5978, output: 33, cacheRead: 41020, cacheWrite: 0, totalTokens: 47031 },
        }),
        metadata: {},
      };
      // SAFETY: Decoded event is an IntermediateMessageEvent.
      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      const usage = decoded.providerUsage!;
      expect(usage.inputTokens).toBe(5978);
      expect(usage.outputTokens).toBe(33);
      expect(usage.cachedInputTokens).toBe(41020);
      expect(usage.totalTokens).toBe(47031);
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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

      // SAFETY: Decoded event is an IntermediateMessageEvent.
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
          expect(decoded.type === "message" ? decoded.providerUsage : undefined).toBeUndefined();
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

      // SAFETY: Decoded event is an IntermediateModelReasoningEvent.
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

      // SAFETY: Decoded event is an IntermediateModelReasoningEvent.
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
      // SAFETY: Decoded event is an IntermediateToolCallEvent.
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
      // SAFETY: Decoded event is an IntermediateCompactionEvent.
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
      // SAFETY: Decoded event is an IntermediateErrorEvent.
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
      // SAFETY: Decoded event is an IntermediateMessageEvent.
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
      // SAFETY: Decoded event is an IntermediateMessageEvent.
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
      // SAFETY: Decoded event is an IntermediateMessageEvent.
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
      // SAFETY: Decoded event is an IntermediateMessageEvent.
      const decoded = decoder.decode(record) as IntermediateMessageEvent;
      expect(decoded.providerUsage?.accountingVersion).toBe("omp-v2-experimental");
    });
  });

  describe("OMP v18 transcript wrappers", () => {
    function v18Record(sequenceNumber: number, payload: Record<string, unknown>): RawHarnessRecord {
      return {
        recordId: `v18-${sequenceNumber}`,
        sessionId: "session-v18",
        harnessId: "omp",
        sequenceNumber,
        recordType: "transcript_line",
        timestamp: `2026-08-31T12:00:${String(sequenceNumber).padStart(2, "0")}.000Z`,
        cursor: {
          offset: sequenceNumber * 100,
          line: sequenceNumber,
          sequence: sequenceNumber,
          timestamp: `2026-08-31T12:00:${String(sequenceNumber).padStart(2, "0")}.000Z`,
        },
        rawPayload: JSON.stringify(payload),
        metadata: {},
      };
    }

    it("unwraps nested user and assistant messages without duplicating embedded tool calls", () => {
      const user = decoder.decode(
        v18Record(1, {
          type: "message",
          message: {
            role: "USER",
            content: [{ type: "text", text: "Inspect the fixture." }],
          },
        }),
      ) as IntermediateMessageEvent;
      const assistant = decoder.decode(
        v18Record(2, {
          type: "message",
          message: {
            role: "Assistant",
            content: [
              { type: "text", text: "Inspecting." },
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "input.csv" },
              },
            ],
          },
        }),
      ) as IntermediateMessageEvent;

      expect(user).toMatchObject({
        type: "message",
        role: "user",
        content: "Inspect the fixture.",
      });
      expect(assistant).not.toBeInstanceOf(Array);
      expect(assistant).toMatchObject({
        type: "message",
        role: "assistant",
        content: "Inspecting.\n",
      });
    });

    it("decodes canonical tool starts and nested tool results", () => {
      const toolCall = decoder.decode(
        v18Record(3, {
          type: "custom",
          customType: "tool_execution_start",
          data: {
            toolCallId: "call-read|fc_abc",
            toolName: "read",
            args: { path: "input.csv" },
            intent: "Inspect input",
          },
        }),
      ) as IntermediateToolCallEvent;
      const toolResult = decoder.decode(
        v18Record(4, {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-read|fc_abc",
            toolName: "read",
            content: [{ type: "text", text: "sku,quantity" }],
            isError: false,
            details: { wallTimeMs: 12.5 },
          },
        }),
      ) as IntermediateToolResultEvent;

      expect(toolCall).toMatchObject({
        type: "tool_call",
        toolName: "read",
        callId: "call-read_fc_abc",
        toolCallId: "call-read_fc_abc",
        parameters: { path: "input.csv" },
        metadata: { intent: "Inspect input" },
      });
      expect(toolResult).toMatchObject({
        type: "tool_result",
        toolName: "read",
        callId: "call-read_fc_abc",
        toolCallId: "call-read_fc_abc",
        result: "sku,quantity",
        isError: false,
        executionDurationMs: 12.5,
      });
    });

    it("emits repeated actionable calls and preserves failed results", () => {
      const payloads = [
        {
          type: "custom",
          customType: "tool_execution_start",
          data: { toolCallId: "call-read", toolName: "read", args: { path: "input.csv" } },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        },
        {
          type: "custom",
          customType: "tool_execution_start",
          data: {
            toolCallId: "call-bash",
            toolName: "bash",
            args: { command: "python report.py" },
          },
        },
        {
          type: "message",
          message: {
            role: "tool_result",
            toolCallId: "call-bash",
            toolName: "bash",
            content: [{ type: "text", text: "exit 1" }],
            isError: true,
            error: "command failed",
          },
        },
      ];
      const decoded = payloads.map((payload, index) =>
        decoder.decode(v18Record(index + 5, payload)),
      ) as Array<IntermediateToolCallEvent | IntermediateToolResultEvent>;

      expect(decoded.map((event) => event.type)).toEqual([
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
      ]);
      expect(decoded.filter((event) => event.type === "tool_call")).toHaveLength(2);
      expect(decoded[1]).toMatchObject({ executionDurationMs: 0 });
      expect(decoded[3]).toMatchObject({
        type: "tool_result",
        toolName: "bash",
        callId: "call-bash",
        isError: true,
        error: "command failed",
      });
    });
  });

  describe("OMP v18.1.1 stream normalization & read-write-read workflow", () => {
    const v18Record = (sequenceNumber: number, payload: unknown): RawHarnessRecord => ({
      recordId: `v18-${sequenceNumber}`,
      sessionId: "session-v18-rwr-1",
      harnessId: "omp",
      sequenceNumber,
      recordType: "transcript_line",
      timestamp: `2026-09-01T10:00:${String(sequenceNumber).padStart(2, "0")}.000Z`,
      cursor: {
        offset: sequenceNumber * 100,
        line: sequenceNumber,
        sequence: sequenceNumber,
        timestamp: `2026-09-01T10:00:${String(sequenceNumber).padStart(2, "0")}.000Z`,
      },
      rawPayload: JSON.stringify(payload),
      metadata: {},
    });

    it("decodes genuine OMP v18.1.1 read-write-read session fixture without noise or duplicate events", async () => {
      const fixturePath = path.join(fixturesDir, "session-v18-read-write-read.jsonl");
      const content = await fsp.readFile(fixturePath, "utf8");
      const rawLines = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      expect(rawLines.length).toBe(24);

      const decodedEvents = rawLines
        .map((line, idx) => {
          const parsed = JSON.parse(line);
          return decoder.decode(v18Record(idx + 1, parsed));
        })
        .filter((evt): evt is NonNullable<typeof evt> => evt !== null);

      // Filtered down to semantic events: start, agent_start, msg, tool_call, tool_result, msg, tool_call, tool_result, tool_call, tool_result, end
      const eventTypes = decodedEvents.map((e) => (Array.isArray(e) ? e[0].type : e.type));
      expect(eventTypes).not.toContain("unknown_passthrough");

      // Verify semantic tool operation sequence is strictly read -> write -> read
      const toolEvents = decodedEvents.filter(
        (e): e is IntermediateToolCallEvent | IntermediateToolResultEvent =>
          !Array.isArray(e) && (e.type === "tool_call" || e.type === "tool_result"),
      );

      expect(toolEvents).toHaveLength(6);
      expect(toolEvents.map((t) => `${t.type}:${t.toolName}`)).toEqual([
        "tool_call:read",
        "tool_result:read",
        "tool_call:write",
        "tool_result:write",
        "tool_call:read",
        "tool_result:read",
      ]);

      // Tool 1: read
      const call1 = toolEvents[0] as IntermediateToolCallEvent;
      const res1 = toolEvents[1] as IntermediateToolResultEvent;
      expect(call1.toolName).toBe("read");
      expect(call1.callId).toBe("call-read-1");
      expect(call1.parameters).toEqual({ path: "data/input.json" });
      expect(res1.toolName).toBe("read");
      expect(res1.callId).toBe("call-read-1");
      expect(res1.isError).toBe(false);

      // Tool 2: write (correlated tool name from callId even though tool_execution_end omitted it)
      const call2 = toolEvents[2] as IntermediateToolCallEvent;
      const res2 = toolEvents[3] as IntermediateToolResultEvent;
      expect(call2.toolName).toBe("write");
      expect(call2.callId).toBe("call-write-2");
      expect(call2.parameters).toEqual({
        path: "data/output.json",
        content: '{"totalUsers":1,"totalCount":10}',
      });
      expect(res2.toolName).toBe("write");
      expect(res2.callId).toBe("call-write-2");
      expect(res2.isError).toBe(false);

      // Tool 3: read (correlated tool name from callId even though tool_execution_end omitted it)
      const call3 = toolEvents[4] as IntermediateToolCallEvent;
      const res3 = toolEvents[5] as IntermediateToolResultEvent;
      expect(call3.toolName).toBe("read");
      expect(call3.callId).toBe("call-read-3");
      expect(call3.parameters).toEqual({ path: "data/output.json" });
      expect(res3.toolName).toBe("read");
      expect(res3.callId).toBe("call-read-3");
      expect(res3.isError).toBe(false);

      // Terminal event is session_lifecycle end
      const lastEvent = decodedEvents[
        decodedEvents.length - 1
      ] as IntermediateSessionLifecycleEvent;
      expect(lastEvent.type).toBe("session_lifecycle");
      expect(lastEvent.lifecycleType).toBe("end");
      expect(lastEvent.exitReason).toBe("task_completed");
    });

    it("filters out streaming delta and progress envelopes returning null", () => {
      expect(
        decoder.decode(
          v18Record(1, {
            type: "message_start",
            message: { role: "assistant" },
          }),
        ),
      ).toBeNull();

      expect(
        decoder.decode(
          v18Record(2, {
            type: "message_update",
            message: { role: "assistant", content: "chunk delta" },
          }),
        ),
      ).toBeNull();

      expect(
        decoder.decode(
          v18Record(3, {
            type: "tool_execution_update",
            callId: "call-1",
            progress: "running",
          }),
        ),
      ).toBeNull();

      expect(decoder.decode(v18Record(4, { type: "turn_start" }))).toBeNull();
      expect(decoder.decode(v18Record(5, { type: "turn_end" }))).toBeNull();
      expect(
        decoder.decode(
          v18Record(6, {
            type: "advisor_cost_changed",
            cost: 0.05,
            tokens: 1000,
          }),
        ),
      ).toBeNull();
      expect(decoder.decode(v18Record(7, { type: "advisor_yielded" }))).toBeNull();
    });

    it("emits closed session lifecycle on agent_end and terminal session envelopes", () => {
      const agentEnd = decoder.decode(
        v18Record(1, {
          type: "agent_end",
          status: "completed",
          exitReason: "finished_ok",
        }),
      ) as IntermediateSessionLifecycleEvent;

      expect(agentEnd.type).toBe("session_lifecycle");
      expect(agentEnd.lifecycleType).toBe("end");
      expect(agentEnd.exitReason).toBe("finished_ok");

      const sessionEnd = decoder.decode(
        v18Record(2, {
          type: "session",
          status: "completed",
          reason: "all_done",
        }),
      ) as IntermediateSessionLifecycleEvent;

      expect(sessionEnd.type).toBe("session_lifecycle");
      expect(sessionEnd.lifecycleType).toBe("end");
      expect(sessionEnd.exitReason).toBe("all_done");

      const agentCrash = decoder.decode(
        v18Record(3, {
          type: "agent_end",
          status: "failed",
          error: "out of memory",
        }),
      ) as IntermediateSessionLifecycleEvent;

      expect(agentCrash.type).toBe("session_lifecycle");
      expect(agentCrash.lifecycleType).toBe("crash");
      expect(agentCrash.exitReason).toBe("out of memory");

      const sessionCrash = decoder.decode(
        v18Record(4, {
          type: "session",
          status: "crash",
          reason: "fatal runtime error",
        }),
      ) as IntermediateSessionLifecycleEvent;

      expect(sessionCrash.type).toBe("session_lifecycle");
      expect(sessionCrash.lifecycleType).toBe("crash");
      expect(sessionCrash.exitReason).toBe("fatal runtime error");
    });

    it("retains all legacy and modern compaction event aliases", () => {
      const aliases = [
        "compaction",
        "compact",
        "context_compaction",
        "context_compact",
        "prune",
        "pruned",
        "context_prune",
        "context_pruned",
      ];

      for (let i = 0; i < aliases.length; i++) {
        const event = decoder.decode(
          v18Record(i + 1, {
            type: aliases[i],
            tokensBefore: 2000,
            tokensAfter: 500,
          }),
        ) as IntermediateCompactionEvent;

        expect(event.type).toBe("compaction");
        expect(event.tokensBefore).toBe(2000);
        expect(event.tokensAfter).toBe(500);
      }
    });

    it("clears cached tool call names on session completion and bounds orphan retention", () => {
      // Tool call without result in session-term-1
      decoder.decode({
        recordId: "r-c1",
        sessionId: "session-term-1",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "tool_call",
        timestamp: "2026-09-01T10:00:00.000Z",
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: "2026-09-01T10:00:00.000Z" },
        rawPayload: JSON.stringify({
          type: "tool_execution_start",
          toolName: "orphan_tool",
          callId: "call-orphan",
        }),
        metadata: {},
      });

      // Terminate session-term-1
      decoder.decode({
        recordId: "r-end",
        sessionId: "session-term-1",
        harnessId: "omp",
        sequenceNumber: 2,
        recordType: "transcript_line",
        timestamp: "2026-09-01T10:00:01.000Z",
        cursor: { offset: 100, line: 2, sequence: 2, timestamp: "2026-09-01T10:00:01.000Z" },
        rawPayload: JSON.stringify({ type: "agent_end", status: "completed" }),
        metadata: {},
      });

      // Tool result arriving after session termination will not find orphan name
      const lateResult = decoder.decode({
        recordId: "r-res",
        sessionId: "session-term-1",
        harnessId: "omp",
        sequenceNumber: 3,
        recordType: "tool_result",
        timestamp: "2026-09-01T10:00:02.000Z",
        cursor: { offset: 200, line: 3, sequence: 3, timestamp: "2026-09-01T10:00:02.000Z" },
        rawPayload: JSON.stringify({
          type: "tool_execution_end",
          callId: "call-orphan",
          result: "late",
        }),
        metadata: {},
      }) as IntermediateToolResultEvent;

      expect(lateResult.toolName).toBe("unknown_tool");
    });
    it("preserves forward compatibility for unrecognized event types via unknown_passthrough", () => {
      const futureEvent = decoder.decode(
        v18Record(1, {
          type: "future_unknown_omp_feature",
          payloadData: { customVal: 42 },
        }),
      ) as IntermediateUnknownPassthroughEvent;

      expect(futureEvent.type).toBe("unknown_passthrough");
      expect(futureEvent.rawEventType).toBe("future_unknown_omp_feature");
      expect(futureEvent.rawPayload).toEqual({
        type: "future_unknown_omp_feature",
        payloadData: { customVal: 42 },
      });
    });

    it("handles subagent lifecycle events without colliding with root session completion", () => {
      const subStart = decoder.decode(
        v18Record(1, {
          type: "agent_start",
          subagentId: "sub-1",
          parentId: "main-agent",
          role: "reviewer",
        }),
      ) as IntermediateSubagentLifecycleEvent;

      expect(subStart.type).toBe("subagent_lifecycle");
      expect(subStart.lifecycleType).toBe("start");
      expect(subStart.subagentId).toBe("sub-1");

      const subYield = decoder.decode(
        v18Record(2, {
          type: "advisor_yielded",
          subagentId: "sub-1",
          reason: "review_done",
        }),
      ) as IntermediateSubagentLifecycleEvent;

      expect(subYield.type).toBe("subagent_lifecycle");
      expect(subYield.lifecycleType).toBe("settle");
      expect(subYield.subagentId).toBe("sub-1");

      const subEnd = decoder.decode(
        v18Record(3, {
          type: "agent_end",
          subagentId: "sub-1",
          status: "completed",
        }),
      ) as IntermediateSubagentLifecycleEvent;

      expect(subEnd.type).toBe("subagent_lifecycle");
      expect(subEnd.lifecycleType).toBe("terminate");
      expect(subEnd.subagentId).toBe("sub-1");
    });
  });

  describe("OMP tool parameter recovery for truncated execution markers", () => {
    const decoder = new OmpRecordDecoder();

    const makeRecord = (sessionId: string, seq: number, payload: unknown): RawHarnessRecord => ({
      recordId: `rec-${sessionId}-${seq}`,
      sessionId,
      harnessId: "omp",
      sequenceNumber: seq,
      recordType: "transcript_line",
      timestamp: `2026-09-02T12:00:${String(seq).padStart(2, "0")}.000Z`,
      cursor: {
        offset: seq * 100,
        line: seq,
        sequence: seq,
        timestamp: `2026-09-02T12:00:${String(seq).padStart(2, "0")}.000Z`,
      },
      rawPayload: JSON.stringify(payload),
      metadata: {},
    });

    it("recovers nested records parameters from assistant toolCall block when start has no args and projects to safe shape", () => {
      const sessionId = "session-param-rec-1";

      // Step 1: Assistant message with canonical toolCall content block containing nested records
      const assistantRecord = makeRecord(sessionId, 1, {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_records_101",
            name: "custom_sync_tool",
            arguments: {
              records: [{ status: "ready" }],
            },
          },
        ],
      });

      const assistantEvt = decoder.decode(assistantRecord) as IntermediateMessageEvent;
      expect(assistantEvt.type).toBe("message");
      expect(assistantEvt.role).toBe("assistant");

      // Step 2: Durable tool_execution_start marker arrives with data envelope and no args
      const startRecord = makeRecord(sessionId, 2, {
        type: "custom",
        customType: "tool_execution_start",
        data: {
          toolCallId: "call_records_101",
          toolName: "custom_sync_tool",
        },
      });

      const toolCallEvt = decoder.decode(startRecord) as IntermediateToolCallEvent;
      expect(toolCallEvt.type).toBe("tool_call");
      expect(toolCallEvt.toolName).toBe("custom_sync_tool");
      expect(toolCallEvt.callId).toBe("call_records_101");
      expect(toolCallEvt.parameters).toEqual({
        records: [{ status: "ready" }],
      });

      // Step 3: Verify existing metadata projector produces safe descriptor envelope
      const projected = projectToolParameters(toolCallEvt.parameters);
      expect(projected).toEqual({
        [RESIN_PARAMETER_SHAPE_KEY]: {
          records: [{ status: "string" }],
        },
      });

      // Verify no raw values appear anywhere in projected metadata output
      const projectedStr = JSON.stringify(projected);
      expect(projectedStr).not.toContain("ready");
    });

    it("uses authoritative assistant arguments when execution start contains truncated path/command", () => {
      const sessionId = "session-param-trunc-1";

      const assistantRecord = makeRecord(sessionId, 1, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Deploying cluster configuration",
            },
            {
              type: "toolCall",
              id: "call_deploy_202",
              name: "cluster_deploy",
              arguments: {
                config: { env: "prod", replicas: 3 },
                dryRun: false,
              },
            },
          ],
        },
      });

      const msgEvt = decoder.decode(assistantRecord) as IntermediateMessageEvent;
      expect(msgEvt.type).toBe("message");
      expect(msgEvt.role).toBe("assistant");
      expect(msgEvt.content).toBe("Deploying cluster configuration\n");

      // Truncated tool_execution_start with only command/path
      const startRecord = makeRecord(sessionId, 2, {
        type: "tool_execution_start",
        toolName: "cluster_deploy",
        callId: "call_deploy_202",
        args: { command: "cluster_deploy" },
      });

      const toolCallEvt = decoder.decode(startRecord) as IntermediateToolCallEvent;
      expect(toolCallEvt.type).toBe("tool_call");
      expect(toolCallEvt.parameters).toEqual({
        config: { env: "prod", replicas: 3 },
        dryRun: false,
      });

      const projected = projectToolParameters(toolCallEvt.parameters);
      expect(projected).toEqual({
        [RESIN_PARAMETER_SHAPE_KEY]: {
          config: { env: "string", replicas: "number" },
          dryRun: "boolean",
        },
      });
      expect(JSON.stringify(projected)).not.toContain("prod");
    });

    it("isolates sessions and call IDs without cross-session/call argument collisions", () => {
      const sessionA = "session-iso-A";
      const sessionB = "session-iso-B";
      const sharedCallId = "call_shared_001";

      // Assistant message in session A
      decoder.decode(
        makeRecord(sessionA, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: sharedCallId,
              name: "scoped_tool",
              arguments: { sessionScope: "A", tenant: "alpha" },
            },
          ],
        }),
      );

      // Assistant message in session B with same call ID but different arguments
      decoder.decode(
        makeRecord(sessionB, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: sharedCallId,
              name: "scoped_tool",
              arguments: { sessionScope: "B", tenant: "beta" },
            },
          ],
        }),
      );

      // Execution start in session A recovers session A arguments
      const startA = decoder.decode(
        makeRecord(sessionA, 2, {
          type: "tool_execution_start",
          callId: sharedCallId,
          toolName: "scoped_tool",
        }),
      ) as IntermediateToolCallEvent;

      expect(startA.parameters).toEqual({ sessionScope: "A", tenant: "alpha" });

      // Execution start in session B recovers session B arguments
      const startB = decoder.decode(
        makeRecord(sessionB, 2, {
          type: "tool_execution_start",
          callId: sharedCallId,
          toolName: "scoped_tool",
        }),
      ) as IntermediateToolCallEvent;

      expect(startB.parameters).toEqual({ sessionScope: "B", tenant: "beta" });
    });

    it("bounds argument cache eviction under high volume and clears on session termination", () => {
      const boundDecoder = new OmpRecordDecoder();
      const sessionTerm = "session-term-cache";

      // Populate 5005 tool call arguments in assistant messages across distinct call IDs
      for (let i = 1; i <= 5005; i++) {
        boundDecoder.decode(
          makeRecord("session-flood", i, {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `flood_call_${i}`,
                name: "flood_tool",
                arguments: { index: i },
              },
            ],
          }),
        );
      }

      // Oldest entries (1..5) should have been evicted due to MAX_CALL_CACHE_ENTRIES = 5000
      const evictedStart = boundDecoder.decode(
        makeRecord("session-flood", 5006, {
          type: "tool_execution_start",
          callId: "flood_call_1",
          toolName: "flood_tool",
          args: { fallback: true },
        }),
      ) as IntermediateToolCallEvent;
      expect(evictedStart.parameters).toEqual({ fallback: true });

      // Recent entry (5005) should still be cached and recovered
      const recentStart = boundDecoder.decode(
        makeRecord("session-flood", 5007, {
          type: "tool_execution_start",
          callId: "flood_call_5005",
          toolName: "flood_tool",
          args: { fallback: true },
        }),
      ) as IntermediateToolCallEvent;
      expect(recentStart.parameters).toEqual({ index: 5005 });

      // Add call to sessionTerm, then terminate session
      boundDecoder.decode(
        makeRecord(sessionTerm, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_term_1",
              name: "term_tool",
              arguments: { active: true },
            },
          ],
        }),
      );

      // End session
      boundDecoder.decode(
        makeRecord(sessionTerm, 2, {
          type: "session_lifecycle",
          lifecycleType: "end",
        }),
      );

      // Start after session end will not find cached arguments
      const postEndStart = boundDecoder.decode(
        makeRecord(sessionTerm, 3, {
          type: "tool_execution_start",
          callId: "call_term_1",
          toolName: "term_tool",
          args: { fallbackAfterEnd: true },
        }),
      ) as IntermediateToolCallEvent;
      expect(postEndStart.parameters).toEqual({ fallbackAfterEnd: true });
    });

    it("preserves canonical standalone start arguments when no assistant toolCall exists", () => {
      const sessionId = "session-standalone-1";

      const standaloneStart = decoder.decode(
        makeRecord(sessionId, 1, {
          type: "tool_execution_start",
          callId: "call_standalone_99",
          toolName: "read",
          args: { path: "src/auth.ts" },
        }),
      ) as IntermediateToolCallEvent;

      expect(standaloneStart.type).toBe("tool_call");
      expect(standaloneStart.toolName).toBe("read");
      expect(standaloneStart.callId).toBe("call_standalone_99");
      expect(standaloneStart.parameters).toEqual({ path: "src/auth.ts" });

      const projected = projectToolParameters(standaloneStart.parameters);
      expect(projected).toEqual({
        [RESIN_PARAMETER_SHAPE_KEY]: {
          path: "string",
        },
      });
    });

    it("ensures assistant message remains a single message event and start remains a single tool_call event without duplicates", () => {
      const sessionId = "session-no-dups-1";

      const msgResult = decoder.decode(
        makeRecord(sessionId, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_single_1",
              name: "do_task",
              arguments: { target: "repo" },
            },
          ],
        }),
      );

      // Assistant message decodes to exactly ONE IntermediateMessageEvent (not an array, not a tool_call)
      expect(Array.isArray(msgResult)).toBe(false);
      const msgEvt = msgResult as IntermediateMessageEvent;
      expect(msgEvt.type).toBe("message");
      expect(msgEvt.role).toBe("assistant");

      const startResult = decoder.decode(
        makeRecord(sessionId, 2, {
          type: "tool_execution_start",
          callId: "call_single_1",
          toolName: "do_task",
        }),
      );

      // Execution start decodes to exactly ONE IntermediateToolCallEvent
      expect(Array.isArray(startResult)).toBe(false);
      const toolCallEvt = startResult as IntermediateToolCallEvent;
      expect(toolCallEvt.type).toBe("tool_call");
      expect(toolCallEvt.parameters).toEqual({ target: "repo" });
    });

    it("avoids retaining arguments past the matching start", () => {
      const sessionId = "session-no-retain-1";

      decoder.decode(
        makeRecord(sessionId, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_once_1",
              name: "one_time_tool",
              arguments: { secretToken: "cached-val" },
            },
          ],
        }),
      );

      // First start consumes and clears the cached arguments
      const firstStart = decoder.decode(
        makeRecord(sessionId, 2, {
          type: "tool_execution_start",
          callId: "call_once_1",
          toolName: "one_time_tool",
        }),
      ) as IntermediateToolCallEvent;
      expect(firstStart.parameters).toEqual({ secretToken: "cached-val" });

      // Subsequent start for the same call ID does not retain the previous arguments
      const secondStart = decoder.decode(
        makeRecord(sessionId, 3, {
          type: "tool_execution_start",
          callId: "call_once_1",
          toolName: "one_time_tool",
          args: { fallback: true },
        }),
      ) as IntermediateToolCallEvent;
      expect(secondStart.parameters).toEqual({ fallback: true });
    });

    it("consistently normalizes assistant tool call IDs containing pipe characters for cache insertion and lookup", () => {
      const sessionId = "session-pipe-id";
      const rawPipeCallId = "call|tool|nested|999";

      // Assistant message with pipe-delimited raw call ID
      decoder.decode(
        makeRecord(sessionId, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: rawPipeCallId,
              name: "pipe_tool",
              arguments: { recordList: [{ key: "k1", count: 42 }] },
            },
          ],
        }),
      );

      // Execution start with the same pipe-delimited call ID
      const startEvt = decoder.decode(
        makeRecord(sessionId, 2, {
          type: "custom",
          customType: "tool_execution_start",
          data: {
            toolCallId: rawPipeCallId,
            toolName: "pipe_tool",
            args: { truncated: true },
          },
        }),
      ) as IntermediateToolCallEvent;

      expect(startEvt.type).toBe("tool_call");
      expect(startEvt.callId).toBe("call_tool_nested_999");
      expect(startEvt.toolCallId).toBe("call_tool_nested_999");
      expect(startEvt.parameters).toEqual({ recordList: [{ key: "k1", count: 42 }] });

      const projected = projectToolParameters(startEvt.parameters);
      expect(projected).toEqual({
        [RESIN_PARAMETER_SHAPE_KEY]: {
          recordList: [{ key: "string", count: "number" }],
        },
      });
    });

    it("distinguishes absent argument field from explicit empty arguments object/string", () => {
      const sessionId = "session-absent-vs-empty";

      // Case 1: Absent argument field in assistant message -> preserves marker fallback
      decoder.decode(
        makeRecord(sessionId, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_absent_args",
              name: "absent_tool",
            },
          ],
        }),
      );

      const absentStart = decoder.decode(
        makeRecord(sessionId, 2, {
          type: "tool_execution_start",
          callId: "call_absent_args",
          toolName: "absent_tool",
          args: { markerFallback: "kept" },
        }),
      ) as IntermediateToolCallEvent;
      expect(absentStart.parameters).toEqual({ markerFallback: "kept" });

      // Case 2: Explicit empty object -> authoritative explicit empty arguments override marker
      decoder.decode(
        makeRecord(sessionId, 3, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_explicit_empty_obj",
              name: "empty_tool",
              arguments: {},
            },
          ],
        }),
      );

      const emptyObjStart = decoder.decode(
        makeRecord(sessionId, 4, {
          type: "tool_execution_start",
          callId: "call_explicit_empty_obj",
          toolName: "empty_tool",
          args: { markerFallback: "should_be_overridden" },
        }),
      ) as IntermediateToolCallEvent;
      expect(emptyObjStart.parameters).toEqual({});

      // Case 3: Explicit empty JSON string -> authoritative explicit empty arguments override marker
      decoder.decode(
        makeRecord(sessionId, 5, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_explicit_empty_str",
              name: "empty_str_tool",
              arguments: "{}",
            },
          ],
        }),
      );

      const emptyStrStart = decoder.decode(
        makeRecord(sessionId, 6, {
          type: "tool_execution_start",
          callId: "call_explicit_empty_str",
          toolName: "empty_str_tool",
          args: { markerFallback: "should_be_overridden" },
        }),
      ) as IntermediateToolCallEvent;
      expect(emptyStrStart.parameters).toEqual({});
    });

    it("prevents colon-concatenation collisions and ensures collision-free session lifecycle cleanup", () => {
      const collisionDecoder = new OmpRecordDecoder();

      // Subtly colliding session/call ID combinations if colon concatenation were used:
      // "session:alpha" + "beta" vs "session" + "alpha:beta" vs "session:alpha:beta" + "gamma"
      const sess1 = "session:alpha";
      const call1 = "beta";

      const sess2 = "session";
      const call2 = "alpha:beta";

      const sess3 = "session:alpha:beta";
      const call3 = "gamma";

      // Populate assistant tool calls for all 3 ambiguous session/call ID combos
      collisionDecoder.decode(
        makeRecord(sess1, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: call1,
              name: "tool_1",
              arguments: { target: "session-alpha-beta" },
            },
          ],
        }),
      );

      collisionDecoder.decode(
        makeRecord(sess2, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: call2,
              name: "tool_2",
              arguments: { target: "session-alpha-colon-beta" },
            },
          ],
        }),
      );

      collisionDecoder.decode(
        makeRecord(sess3, 1, {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: call3,
              name: "tool_3",
              arguments: { target: "session-alpha-beta-gamma" },
            },
          ],
        }),
      );

      // Terminate sess1 ("session:alpha")
      collisionDecoder.decode(
        makeRecord(sess1, 2, {
          type: "session_lifecycle",
          lifecycleType: "end",
        }),
      );

      // sess1 cache should be cleared
      const start1 = collisionDecoder.decode(
        makeRecord(sess1, 3, {
          type: "tool_execution_start",
          callId: call1,
          toolName: "tool_1",
          args: { fallbackAfterEnd: true },
        }),
      ) as IntermediateToolCallEvent;
      expect(start1.parameters).toEqual({ fallbackAfterEnd: true });

      // sess2 ("session") must NOT be affected by sess1's termination
      const start2 = collisionDecoder.decode(
        makeRecord(sess2, 2, {
          type: "tool_execution_start",
          callId: call2,
          toolName: "tool_2",
          args: { fallback: false },
        }),
      ) as IntermediateToolCallEvent;
      expect(start2.parameters).toEqual({ target: "session-alpha-colon-beta" });

      // sess3 ("session:alpha:beta") must NOT be affected by sess1's termination
      const start3 = collisionDecoder.decode(
        makeRecord(sess3, 2, {
          type: "tool_execution_start",
          callId: call3,
          toolName: "tool_3",
          args: { fallback: false },
        }),
      ) as IntermediateToolCallEvent;
      expect(start3.parameters).toEqual({ target: "session-alpha-beta-gamma" });
    });
    it("keeps authoritative arguments distinct when raw call IDs normalize identically", () => {
      const collisionDecoder = new OmpRecordDecoder();
      const sessionId = "session-normalized-id-collision";
      collisionDecoder.decode(
        makeRecord(sessionId, 1, {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call|x",
                name: "pipe_tool",
                arguments: { target: "pipe" },
              },
              {
                type: "toolCall",
                id: "call?x",
                name: "question_tool",
                arguments: { target: "question" },
              },
            ],
          },
        }),
      );

      const pipeStart = collisionDecoder.decode(
        makeRecord(sessionId, 2, {
          type: "tool_execution_start",
          callId: "call|x",
          toolName: "pipe_tool",
        }),
      ) as IntermediateToolCallEvent;
      const questionStart = collisionDecoder.decode(
        makeRecord(sessionId, 3, {
          type: "tool_execution_start",
          callId: "call?x",
          toolName: "question_tool",
        }),
      ) as IntermediateToolCallEvent;

      expect(pipeStart.parameters).toEqual({ target: "pipe" });
      expect(questionStart.parameters).toEqual({ target: "question" });
    });
  });
});
