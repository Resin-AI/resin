import { NormalizedSessionEventSchema } from "@resin/contracts";
import type {
  HarnessRecordDecoder,
  IntermediateMessageEvent,
  IntermediateSessionLifecycleEvent,
  IntermediateToolCallEvent,
  IntermediateToolResultEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  MULTI_TURN_TOOLS_ROLLOUT_PATH,
  STANDARD_SESSION_ROLLOUT_PATH,
  SUBAGENTS_AND_FORKS_ROLLOUT_PATH,
  readFixture,
} from "../fixtures/index.js";
import {
  CodexRecordDecoder,
  CodexSessionDecoder,
  decodeCodexRecord,
  decodeCodexTranscript,
} from "../src/decoder.js";
describe("Codex CLI Session Decoder", () => {
  describe("Golden Fixture: standard-session.jsonl", () => {
    it("decodes all event types and passes strict schema validation", async () => {
      const rawContent = await readFixture(STANDARD_SESSION_ROLLOUT_PATH);
      const decoder = new CodexSessionDecoder({ sessionId: "sess_golden_01" });
      const events = decoder.decodeTranscript(rawContent);

      for (const evt of events) {
        const parseResult = NormalizedSessionEventSchema.safeParse(evt);
        if (!parseResult.success) {
          throw new Error(
            `Failed validation on event: ${JSON.stringify(evt)}\n${JSON.stringify(parseResult.error, null, 2)}`,
          );
        }
      }
      // Check event types present
      const types = events.map((e) => e.type);
      expect(types).toContain("session_lifecycle");
      expect(types).toContain("message");
      expect(types).toContain("model_reasoning");
      expect(types).toContain("command_exec");
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(types).toContain("file_edit");
      expect(types).toContain("compaction");
    });
  });

  describe("Golden Fixture: subagents-and-forks.jsonl", () => {
    it("decodes subagent lifecycle and branch fork events correctly", async () => {
      const rawContent = await readFixture(SUBAGENTS_AND_FORKS_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent, { sessionId: "sess_subagents_01" });

      expect(events.length).toBeGreaterThan(0);
      for (const evt of events) {
        const parseResult = NormalizedSessionEventSchema.safeParse(evt);
        expect(parseResult.success).toBe(true);
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("subagent_lifecycle");
      expect(types).toContain("branch_fork");
    });
  });

  describe("Golden Fixture: multi-turn-tools.jsonl", () => {
    it("decodes multi-turn tool conversations faithfully", async () => {
      const rawContent = await readFixture(MULTI_TURN_TOOLS_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent);

      expect(events.length).toBeGreaterThan(0);
      for (const evt of events) {
        const parseResult = NormalizedSessionEventSchema.safeParse(evt);
        expect(parseResult.success).toBe(true);
      }
    });
  });

  describe("Individual Event Decoding & Sequence Preservation", () => {
    it("preserves sequence monotonicity and causal chain across calls", () => {
      const decoder = new CodexSessionDecoder({ sessionId: "sess_seq_01", initialSequence: 10 });
      const evts1 = decoder.decodeRecord({ type: "user_message", content: "Hello" });
      const evts2 = decoder.decodeRecord({
        type: "assistant_message",
        content: "Hi there!",
      });
      expect(evts1[0].causalRef.causalSequence).toBe(10);
      expect(evts2[0].causalRef.causalSequence).toBe(11);
      expect(evts2[0].causalRef.parentId).toBe(evts1[0].eventId);
    });

    it("decodes inline tool_calls on assistant message into distinct events", () => {
      const decoder = new CodexSessionDecoder();
      const events = decoder.decodeRecord({
        type: "assistant_message",
        content: "Let me check that file for you.",
        tool_calls: [
          {
            id: "call_read_01",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path": "src/main.rs"}',
            },
          },
        ],
      });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("message");
      expect(events[1].type).toBe("tool_call");
      expect(events[1]).toMatchObject({
        type: "tool_call",
        callId: "call_read_01",
        toolName: "read_file",
        parameters: { path: "src/main.rs" },
      });
    });

    it("parses unparseable string lines into unknown_passthrough events", () => {
      const events = decodeCodexRecord("NOT_VALID_JSON_AT_ALL");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("unknown_passthrough");
      expect(NormalizedSessionEventSchema.safeParse(events[0]).success).toBe(true);
    });

    it("ignores blank lines gracefully", () => {
      const events = decodeCodexTranscript("\n  \n\t\n");
      expect(events).toHaveLength(0);
    });
  });

  describe("Authoritative Provider Usage Extraction & Component Preservation", () => {
    it("extracts complete per-turn provider usage with all token components and details", () => {
      const rawRecord = {
        type: "assistant_message",
        content: "I analyzed the code.",
        model: "o3-mini",
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 450,
          total_tokens: 1650,
          prompt_tokens_details: {
            cached_tokens: 800,
          },
          completion_tokens_details: {
            reasoning_tokens: 250,
          },
          cost_micro_usd: 14500,
          duration_ms: 820,
        },
      };

      const events = decodeCodexRecord(rawRecord);
      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(NormalizedSessionEventSchema.safeParse(evt).success).toBe(true);
      expect(evt.providerUsage).toBeDefined();
      expect(evt.providerUsage).toEqual({
        provider: "openai",
        model: "o3-mini",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "complete",
        inputTokens: 1200,
        outputTokens: 450,
        totalTokens: 1650,
        cachedInputTokens: 800,
        reasoningTokens: 250,
        costMicroUsd: 14500,
        durationMs: 820,
      });
    });

    it("preserves explicit raw provider and raw model without fabricating missing models", () => {
      const recordWithExplicitProvider = {
        type: "assistant_message",
        content: "Azure response",
        provider: "azure-openai",
        model: "gpt-4o-2024-08-06",
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          total_tokens: 75,
        },
      };

      const events1 = decodeCodexRecord(recordWithExplicitProvider);
      expect(events1[0].providerUsage?.provider).toBe("azure-openai");
      expect(events1[0].providerUsage?.model).toBe("gpt-4o-2024-08-06");

      const recordWithoutModel = {
        type: "assistant_message",
        content: "No model response",
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          total_tokens: 75,
        },
      };

      const events2 = decodeCodexRecord(recordWithoutModel);
      expect(events2[0].providerUsage?.provider).toBe("openai");
      expect(events2[0].providerUsage?.model).toBeUndefined();
    });

    it("attaches usage to first event in a turn with message and inline tool_calls", () => {
      const record = {
        type: "assistant_message",
        content: "Calling tool now.",
        model: "gpt-4o",
        usage: {
          prompt_tokens: 300,
          completion_tokens: 60,
          total_tokens: 360,
        },
        tool_calls: [
          {
            id: "call_01",
            type: "function",
            function: { name: "test_tool", arguments: "{}" },
          },
        ],
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("message");
      expect(events[0].providerUsage).toBeDefined();
      expect(events[0].providerUsage?.totalTokens).toBe(360);

      // Tool call in same turn must not duplicate usage
      expect(events[1].type).toBe("tool_call");
      expect(events[1].providerUsage).toBeUndefined();
    });

    it("attaches usage to model_reasoning event", () => {
      const record = {
        type: "reasoning",
        content: "Thinking about the algorithmic solution...",
        model: "o1",
        turn_usage: {
          prompt_tokens: 500,
          completion_tokens: 300,
          total_tokens: 800,
          reasoning_tokens: 280,
        },
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("model_reasoning");
      expect(events[0].providerUsage).toEqual({
        provider: "openai",
        model: "o1",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "complete",
        inputTokens: 500,
        outputTokens: 300,
        totalTokens: 800,
        reasoningTokens: 280,
      });
    });
  });

  describe("Cumulative Report & Non-Double-Counting Semantics", () => {
    it("prefers per-turn usage over cumulative totals when both are present on an event", () => {
      const record = {
        type: "assistant_message",
        content: "Turn 2 output",
        model: "gpt-4o",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
        cumulative_usage: {
          prompt_tokens: 500,
          completion_tokens: 250,
          total_tokens: 750,
        },
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(1);
      expect(events[0].providerUsage).toEqual({
        provider: "openai",
        model: "gpt-4o",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "complete",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it("emits per-turn usage across turns and does not double-count cumulative totals on session end", () => {
      const transcript = [
        {
          type: "session_lifecycle",
          lifecycleType: "start",
          timestamp: "2026-08-17T12:00:00.000Z",
        },
        {
          type: "assistant_message",
          content: "Turn 1",
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          timestamp: "2026-08-17T12:00:01.000Z",
        },
        {
          type: "assistant_message",
          content: "Turn 2",
          usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
          cumulative_usage: { prompt_tokens: 220, completion_tokens: 110, total_tokens: 330 },
          timestamp: "2026-08-17T12:00:02.000Z",
        },
        {
          type: "session_lifecycle",
          lifecycleType: "end",
          cumulative_usage: { prompt_tokens: 220, completion_tokens: 110, total_tokens: 330 },
          timestamp: "2026-08-17T12:00:03.000Z",
        },
      ];

      const decoder = new CodexSessionDecoder();
      const events = decoder.decodeTranscript(transcript);

      const eventsWithUsage = events.filter((e) => e.providerUsage !== undefined);
      expect(eventsWithUsage).toHaveLength(2);

      // Turn 1
      expect(eventsWithUsage[0].providerUsage).toEqual({
        provider: "openai",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "complete",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });

      // Turn 2
      expect(eventsWithUsage[1].providerUsage).toEqual({
        provider: "openai",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "complete",
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
      });

      // Terminal event must NOT have cumulative usage attached since per-turn was emitted
      const endEvent = events.find(
        (e) => e.type === "session_lifecycle" && e.lifecycleType === "end",
      );
      expect(endEvent?.providerUsage).toBeUndefined();
    });

    it("emits cumulative usage at terminal event when session format only exposes cumulative totals", () => {
      const transcript = [
        {
          type: "session_lifecycle",
          lifecycleType: "start",
          timestamp: "2026-08-17T12:00:00.000Z",
        },
        {
          type: "assistant_message",
          content: "Turn 1",
          cumulative_usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          timestamp: "2026-08-17T12:00:01.000Z",
        },
        {
          type: "assistant_message",
          content: "Turn 2",
          cumulative_usage: { prompt_tokens: 250, completion_tokens: 100, total_tokens: 350 },
          timestamp: "2026-08-17T12:00:02.000Z",
        },
        {
          type: "session_lifecycle",
          lifecycleType: "end",
          timestamp: "2026-08-17T12:00:03.000Z",
        },
      ];

      const decoder = new CodexSessionDecoder();
      const events = decoder.decodeTranscript(transcript);

      // Intermediate turns must NOT emit cumulative usage
      const msgEvents = events.filter((e) => e.type === "message");
      for (const msg of msgEvents) {
        expect(msg.providerUsage).toBeUndefined();
      }

      // Terminal event emits cumulative usage with cumulative accounting version
      const endEvent = events.find(
        (e) => e.type === "session_lifecycle" && e.lifecycleType === "end",
      );
      expect(endEvent?.providerUsage).toEqual({
        provider: "openai",
        accountingVersion: "codex-cli-cumulative-v1",
        availability: "complete",
        inputTokens: 250,
        outputTokens: 100,
        totalTokens: 350,
      });
    });
  });

  describe("Partial, Absent, Unavailable, and Malformed Usage Handling", () => {
    it("marks usage as partial and never infers missing totalTokens", () => {
      const record = {
        type: "assistant_message",
        content: "Partial usage record",
        usage: {
          prompt_tokens: 150,
          completion_tokens: 50,
          // total_tokens omitted
        },
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(1);
      expect(NormalizedSessionEventSchema.safeParse(events[0]).success).toBe(true);
      expect(events[0].providerUsage).toEqual({
        provider: "openai",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "partial",
        inputTokens: 150,
        outputTokens: 50,
      });
      expect(events[0].providerUsage?.totalTokens).toBeUndefined();
    });

    it("handles partial usage with only reasoning tokens", () => {
      const record = {
        type: "reasoning",
        content: "Thinking...",
        usage: {
          completion_tokens_details: {
            reasoning_tokens: 75,
          },
        },
      };

      const events = decodeCodexRecord(record);
      expect(events[0].providerUsage).toEqual({
        provider: "openai",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "partial",
        reasoningTokens: 75,
      });
    });

    it("never substitutes generic tokenCount for input/output/total tokens", () => {
      const record = {
        type: "assistant_message",
        content: "Message with ambiguous token count",
        tokenCount: 120,
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(1);
      expect(events[0].providerUsage).toBeUndefined();
    });

    it("handles explicit unavailable availability state without metric fields", () => {
      const record = {
        type: "assistant_message",
        content: "Usage unavailable",
        usage: {
          availability: "unavailable",
        },
      };

      const events = decodeCodexRecord(record);
      expect(events[0].providerUsage).toEqual({
        provider: "openai",
        accountingVersion: "codex-cli-transcript-v1",
        availability: "unavailable",
      });
      expect(NormalizedSessionEventSchema.safeParse(events[0]).success).toBe(true);
    });

    it("handles malformed negative and non-numeric usage values gracefully without crashing", () => {
      const record = {
        type: "assistant_message",
        content: "Malformed usage",
        usage: {
          prompt_tokens: -100,
          completion_tokens: "not_a_number",
          total_tokens: null,
          cost_micro_usd: -50,
        },
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(1);
      expect(NormalizedSessionEventSchema.safeParse(events[0]).success).toBe(true);
      expect(events[0].providerUsage).toBeUndefined();
    });

    it("handles null or non-object usage field gracefully", () => {
      const record = {
        type: "assistant_message",
        content: "Null usage",
        usage: null,
      };

      const events = decodeCodexRecord(record);
      expect(events).toHaveLength(1);
      expect(events[0].providerUsage).toBeUndefined();
    });
  });

  describe("CodexRecordDecoder (HarnessRecordDecoder)", () => {
    it("exposes expected harnessId and decoderVersion metadata", () => {
      const decoder = new CodexRecordDecoder();
      expect(decoder.harnessId).toBe("codex-cli");
      expect(decoder.decoderVersion).toBe("1.0.0");
    });

    describe("canDecode", () => {
      it("accepts records with matching harnessId or wildcard", () => {
        const decoder = new CodexRecordDecoder();
        const baseRecord: RawHarnessRecord = {
          recordId: "rec-1",
          sessionId: "sess-1",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "session_lifecycle",
          rawPayload: { type: "session_start" },
          cursor: { sequence: 1 },
          metadata: {},
        };

        expect(decoder.canDecode(baseRecord)).toBe(true);
        expect(decoder.canDecode({ ...baseRecord, harnessId: "codex" })).toBe(true);
        expect(decoder.canDecode({ ...baseRecord, harnessId: "*" })).toBe(true);
      });

      it("inspects payload structure when harnessId is generic or absent", () => {
        const decoder = new CodexRecordDecoder();
        const recordWithHarnessField: RawHarnessRecord = {
          recordId: "rec-2",
          sessionId: "sess-1",
          harnessId: "generic",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "message",
          rawPayload: { harness: "codex-cli", type: "user_message", content: "hello" },
          cursor: { sequence: 1 },
          metadata: {},
        };
        expect(decoder.canDecode(recordWithHarnessField)).toBe(true);

        const recordWithStringPayload: RawHarnessRecord = {
          recordId: "rec-3",
          sessionId: "sess-1",
          harnessId: "generic",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "message",
          rawPayload: JSON.stringify({ harnessName: "codex-cli", type: "user_message" }),
          cursor: { sequence: 1 },
          metadata: {},
        };
        expect(decoder.canDecode(recordWithStringPayload)).toBe(true);
      });

      it("rejects non-matching records and null/empty inputs", () => {
        const decoder = new CodexRecordDecoder();
        // SAFETY: Testing runtime rejection when null record is passed.
        const invalidRecord = null as never;
        expect(decoder.canDecode(invalidRecord)).toBe(false);
        const foreignRecord: RawHarnessRecord = {
          recordId: "rec-4",
          sessionId: "sess-1",
          harnessId: "claude-code",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "message",
          rawPayload: { type: "user_prompt" },
          cursor: { sequence: 1 },
          metadata: {},
        };
        expect(decoder.canDecode(foreignRecord)).toBe(false);
      });
    });

    describe("DecoderRegistry Integration", async () => {
      it("registers with a decoder registry and routes records correctly", async () => {
        const decoders = new Map<string, HarnessRecordDecoder>();
        const codexDecoder = new CodexRecordDecoder();
        decoders.set(codexDecoder.harnessId, codexDecoder);
        const record: RawHarnessRecord = {
          recordId: "rec-reg-1",
          sessionId: "sess-reg-1",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "message",
          rawPayload: {
            type: "user_message",
            content: "Hello from registry",
          },
          cursor: { sequence: 1 },
          metadata: {},
        };

        const resolvedDecoder = decoders.get(record.harnessId);
        expect(resolvedDecoder).toBe(codexDecoder);

        const decoded = await codexDecoder.decode(record);
        const events = Array.isArray(decoded) ? decoded : decoded ? [decoded] : [];
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("message");
        expect(events[0].type === "message" ? events[0].content : null).toBe("Hello from registry");
      });
    });

    describe("Lifecycle Completion & Multi-Record Session Stream", () => {
      it("processes full multi-turn session with causal linking and tool resolution", () => {
        const decoder = new CodexRecordDecoder();
        const sessionId = "sess-lifecycle-01";

        const rawRecords: RawHarnessRecord[] = [
          {
            recordId: "rec-lc-1",
            sessionId,
            harnessId: "codex-cli",
            sequenceNumber: 1,
            timestamp: "2026-08-27T10:00:00.000Z",
            recordType: "session_lifecycle",
            rawPayload: {
              type: "session_lifecycle",
              lifecycleType: "start",
              workspaceId: "ws-test-1",
            },
            cursor: { sequence: 1 },
            metadata: {},
          },
          {
            recordId: "rec-lc-2",
            sessionId,
            harnessId: "codex-cli",
            sequenceNumber: 2,
            timestamp: "2026-08-27T10:00:01.000Z",
            recordType: "message",
            rawPayload: {
              type: "user_message",
              content: "Query database for active users",
            },
            cursor: { sequence: 2 },
            metadata: {},
          },
          {
            recordId: "rec-lc-3",
            sessionId,
            harnessId: "codex-cli",
            sequenceNumber: 3,
            timestamp: "2026-08-27T10:00:02.000Z",
            recordType: "tool_call",
            rawPayload: {
              type: "tool_call",
              callId: "call_sql_99",
              toolName: "db_query",
              parameters: { sql: "SELECT COUNT(*) FROM users WHERE active = true" },
            },
            cursor: { sequence: 3 },
            metadata: {},
          },
          {
            recordId: "rec-lc-4",
            sessionId,
            harnessId: "codex-cli",
            sequenceNumber: 4,
            timestamp: "2026-08-27T10:00:03.000Z",
            recordType: "tool_result",
            rawPayload: {
              type: "tool_result",
              callId: "call_sql_99",
              result: { count: 42 },
            },
            cursor: { sequence: 4 },
            metadata: {},
          },
          {
            recordId: "rec-lc-5",
            sessionId,
            harnessId: "codex-cli",
            sequenceNumber: 5,
            timestamp: "2026-08-27T10:00:04.000Z",
            recordType: "message",
            rawPayload: {
              type: "assistant_message",
              content: "There are currently 42 active users.",
              usage: {
                prompt_tokens: 180,
                completion_tokens: 45,
                total_tokens: 225,
              },
            },
            cursor: { sequence: 5 },
            metadata: {},
          },
          {
            recordId: "rec-lc-6",
            sessionId,
            harnessId: "codex-cli",
            sequenceNumber: 6,
            timestamp: "2026-08-27T10:00:05.000Z",
            recordType: "session_lifecycle",
            rawPayload: {
              type: "session_lifecycle",
              lifecycleType: "end",
              exitReason: "completed",
              cumulative_usage: {
                prompt_tokens: 180,
                completion_tokens: 45,
                total_tokens: 225,
              },
            },
            cursor: { sequence: 6 },
            metadata: {},
          },
        ];

        const decodedEvents = rawRecords.flatMap((r) => decoder.decode(r));
        expect(decodedEvents).toHaveLength(6);

        const [startEvt, userEvt, callEvt, resultEvt, assistantEvt, endEvt] = decodedEvents;

        // Schema validation
        for (const evt of decodedEvents) {
          expect(NormalizedSessionEventSchema.safeParse(evt).success).toBe(true);
        }

        // Sequence ordering & causal linkage
        expect(startEvt.type).toBe("session_lifecycle");
        expect(startEvt.type === "session_lifecycle" ? startEvt.lifecycleType : null).toBe("start");
        expect(startEvt.causalRef?.causalSequence).toBe(1);
        expect(startEvt.causalRef?.parentId).toBeNull();

        expect(userEvt.type).toBe("message");
        expect(userEvt.causalRef?.causalSequence).toBe(2);
        // SAFETY: Event identifier is present on decoded intermediate event.
        expect(userEvt.causalRef?.parentId).toBe((startEvt as { eventId: string }).eventId);

        expect(callEvt.type).toBe("tool_call");
        expect(callEvt.type === "tool_call" ? callEvt.toolName : null).toBe("db_query");
        expect(callEvt.causalRef?.causalSequence).toBe(3);
        // SAFETY: Event identifier is present on decoded intermediate event.
        expect(callEvt.causalRef?.parentId).toBe((userEvt as { eventId: string }).eventId);

        expect(resultEvt.type).toBe("tool_result");
        expect(resultEvt.type === "tool_result" ? resultEvt.toolName : null).toBe("db_query");
        expect(resultEvt.causalRef?.causalSequence).toBe(4);
        // SAFETY: Event identifier is present on decoded intermediate event.
        expect(resultEvt.causalRef?.parentId).toBe((callEvt as { eventId: string }).eventId);

        expect(assistantEvt.type).toBe("message");
        expect(assistantEvt.causalRef?.causalSequence).toBe(5);
        // SAFETY: Event identifier is present on decoded intermediate event.
        expect(assistantEvt.causalRef?.parentId).toBe((resultEvt as { eventId: string }).eventId);
        expect(assistantEvt.providerUsage).toEqual({
          provider: "openai",
          accountingVersion: "codex-cli-transcript-v1",
          availability: "complete",
          inputTokens: 180,
          outputTokens: 45,
          totalTokens: 225,
        });
        expect(endEvt.type).toBe("session_lifecycle");
        expect(endEvt.type === "session_lifecycle" ? endEvt.lifecycleType : null).toBe("end");
        expect(endEvt.causalRef?.causalSequence).toBe(6);
        // SAFETY: Event identifier is present on decoded intermediate event.
        expect(endEvt.causalRef?.parentId).toBe((assistantEvt as { eventId: string }).eventId);
        expect(endEvt.providerUsage).toBeUndefined();
      });
    });

    describe("Provider Usage Passthrough & Cumulative Non-Double-Counting", () => {
      it("passes through rich provider usage fields faithfully", () => {
        const decoder = new CodexRecordDecoder();
        const record: RawHarnessRecord = {
          recordId: "rec-usage-rich-1",
          sessionId: "sess-usage-1",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "message",
          rawPayload: {
            type: "assistant_message",
            content: "Response with rich usage metrics",
            provider: "azure-openai",
            model: "o3-mini",
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 350,
              total_tokens: 1550,
              prompt_tokens_details: {
                cached_tokens: 400,
              },
              completion_tokens_details: {
                reasoning_tokens: 200,
              },
              cost_micro_usd: 15400,
              duration_ms: 780,
            },
          },
          cursor: { sequence: 1 },
          metadata: {},
        };

        const events = decoder.decode(record);
        expect(events).toHaveLength(1);
        expect(events[0].providerUsage).toEqual({
          provider: "azure-openai",
          model: "o3-mini",
          accountingVersion: "codex-cli-transcript-v1",
          availability: "complete",
          inputTokens: 1200,
          outputTokens: 350,
          totalTokens: 1550,
          cachedInputTokens: 400,
          reasoningTokens: 200,
          costMicroUsd: 15400,
          durationMs: 780,
        });
      });

      it("emits cumulative usage at session end when per-turn usage is absent", () => {
        const decoder = new CodexRecordDecoder();
        const sessionId = "sess-cum-only";

        const startRecord: RawHarnessRecord = {
          recordId: "rec-cum-1",
          sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "session_lifecycle",
          rawPayload: { type: "session_lifecycle", lifecycleType: "start" },
          cursor: { sequence: 1 },
          metadata: {},
        };

        const assistantRecord: RawHarnessRecord = {
          recordId: "rec-cum-2",
          sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 2,
          timestamp: "2026-08-27T10:00:01.000Z",
          recordType: "message",
          rawPayload: {
            type: "assistant_message",
            content: "Response without per-turn usage",
            cumulative_usage: {
              prompt_tokens: 600,
              completion_tokens: 250,
              total_tokens: 850,
            },
          },
          cursor: { sequence: 2 },
          metadata: {},
        };

        const endRecord: RawHarnessRecord = {
          recordId: "rec-cum-3",
          sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 3,
          timestamp: "2026-08-27T10:00:02.000Z",
          recordType: "session_lifecycle",
          rawPayload: { type: "session_lifecycle", lifecycleType: "end" },
          cursor: { sequence: 3 },
          metadata: {},
        };

        const startEvents = decoder.decode(startRecord);
        const assistantEvents = decoder.decode(assistantRecord);
        const endEvents = decoder.decode(endRecord);

        expect(startEvents[0].providerUsage).toBeUndefined();
        expect(assistantEvents[0].providerUsage).toBeUndefined();
        expect(endEvents[0].providerUsage).toEqual({
          provider: "openai",
          accountingVersion: "codex-cli-cumulative-v1",
          availability: "complete",
          inputTokens: 600,
          outputTokens: 250,
          totalTokens: 850,
        });
      });

      it("handles partial usage without fabricating missing totalTokens", () => {
        const decoder = new CodexRecordDecoder();
        const record: RawHarnessRecord = {
          recordId: "rec-partial-1",
          sessionId: "sess-partial",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "message",
          rawPayload: {
            type: "assistant_message",
            content: "Response with partial usage",
            usage: {
              prompt_tokens: 200,
            },
          },
          cursor: { sequence: 1 },
          metadata: {},
        };

        const events = decoder.decode(record);
        expect(events).toHaveLength(1);
        expect(events[0].providerUsage).toEqual({
          provider: "openai",
          accountingVersion: "codex-cli-transcript-v1",
          availability: "partial",
          inputTokens: 200,
        });
        expect(events[0].providerUsage?.totalTokens).toBeUndefined();
      });
    });

    describe("Context Preservation & Prompt Formats", () => {
      it("preserves workspaceId, timestamp, and metadata across context and record", () => {
        const decoder = new CodexRecordDecoder();
        const record: RawHarnessRecord = {
          recordId: "rec-ctx-1",
          sessionId: "sess-ctx-preserve",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T12:34:56.789Z",
          recordType: "session_lifecycle",
          rawPayload: {
            type: "session_lifecycle",
            lifecycleType: "start",
          },
          cursor: { sequence: 1 },
          metadata: {
            workspaceId: "ws-custom-007",
            environment: "staging",
          },
        };

        const events = decoder.decode(record, {
          workspaceId: "ws-custom-007",
          metadata: { source: "observer-test" },
        });
        expect(events).toHaveLength(1);
        expect(events[0].sessionId).toBe("sess-ctx-preserve");
        expect(events[0].timestamp).toBe("2026-08-27T12:34:56.789Z");
        expect(events[0].type === "session_lifecycle" ? events[0].workspaceId : null).toBe(
          "ws-custom-007",
        );
        expect(events[0].metadata).toEqual({
          workspaceId: "ws-custom-007",
          environment: "staging",
          source: "observer-test",
        });
      });

      it("adapts diverse user message prompt formats without reserialization", () => {
        const decoder = new CodexRecordDecoder();

        const messageVariants = [
          {
            payload: { type: "user_message", prompt: "Explain AST grep" },
            expected: "Explain AST grep",
          },
          {
            payload: { type: "user_message", query: "Search pattern" },
            expected: "Search pattern",
          },
          {
            payload: { type: "user_message", input: "Execute AST rewrite" },
            expected: "Execute AST rewrite",
          },
          {
            payload: { type: "user_message", text: "Explain symbol naming" },
            expected: "Explain symbol naming",
          },
        ];

        for (const [idx, variant] of messageVariants.entries()) {
          const record: RawHarnessRecord = {
            recordId: `rec-variant-${idx}`,
            sessionId: `sess-variant-${idx}`,
            harnessId: "codex-cli",
            sequenceNumber: 1,
            timestamp: "2026-08-27T10:00:00.000Z",
            recordType: "message",
            rawPayload: variant.payload,
            cursor: { sequence: 1 },
            metadata: {},
          };

          const events = decoder.decode(record);
          expect(events).toHaveLength(1);
          expect(events[0].type).toBe("message");
          expect(events[0].type === "message" ? events[0].content : null).toBe(variant.expected);
        }
      });

      it("emits unknown_passthrough for unparseable rawPayload strings", () => {
        const decoder = new CodexRecordDecoder();
        const record: RawHarnessRecord = {
          recordId: "rec-unparseable-1",
          sessionId: "sess-unparseable",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          recordType: "unknown",
          rawPayload: "{ bad json ::::",
          cursor: { sequence: 1 },
          metadata: {},
        };

        const events = decoder.decode(record);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("unknown_passthrough");
      });
    });
  });
});
