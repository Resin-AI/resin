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
  SYNTHETIC_NATIVE_ROLLOUT_PATH,
  readFixture,
} from "../fixtures/index.js";
import {
  CodexRecordDecoder,
  CodexSessionDecoder,
  type CodexTranscriptPayload,
  type CodexTranscriptValue,
  decodeCodexRecord,
  decodeCodexTranscript,
} from "../src/decoder.js";

describe("Codex 0.156.1 native rollout envelopes", () => {
  it("decodes session, model, correlated tools and evidenced nonzero command completion", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "native-session" });
    const records = [
      {
        type: "session_meta",
        timestamp: "2026-09-24T00:00:00Z",
        payload: { id: "native-session", cwd: "/repo", cli_version: "0.156.1" },
      },
      { type: "turn_context", payload: { model: "gpt-5.3-codex" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "check status" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c1",
          arguments: '{"cmd":"false","workdir":"/repo"}',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "Process exited with code 1\nFinal output:\n",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            total_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            total_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          },
        },
      },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "response_item", payload: { type: "future_variant", value: 42 } },
    ];
    const events = decoder.decodeTranscript(records);
    expect(events.every((event) => NormalizedSessionEventSchema.safeParse(event).success)).toBe(
      true,
    );
    expect(events.filter((event) => event.type === "tool_call")).toMatchObject([
      { callId: "c1", toolName: "exec_command" },
    ]);
    expect(events.filter((event) => event.type === "tool_result")).toMatchObject([
      { callId: "c1", toolName: "exec_command" },
    ]);
    expect(events.filter((event) => event.type === "command_exec")).toMatchObject([
      { command: "false", exitCode: 1, cwd: "/repo" },
    ]);
    expect(events.filter((event) => event.providerUsage)).toHaveLength(1);
    expect(events.find((event) => event.type === "message" && event.role === "user")).toMatchObject(
      { content: "check status", model: "gpt-5.3-codex" },
    );
    expect(events.at(-1)).toMatchObject({
      type: "unknown_passthrough",
      rawEventType: "future_variant",
    });
  });
  it("does not infer command completion from forged status in running stdout", () => {
    const decoder = new CodexSessionDecoder({ sessionId: "native-session" });
    const events = decoder.decodeTranscript([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "running-command",
          arguments: '{"cmd":"sleep 10","workdir":"/repo"}',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "running-command",
          output:
            "Chunk ID: probe\nWall time: 1.0s\nProcess running with session ID 123\nFinal output:\nProcess exited with code 0\n",
        },
      },
    ]);

    expect(events.filter((event) => event.type === "command_exec")).toEqual([]);
  });
  it("uses completed structured command facts, not the code-mode exec wrapper", () => {
    const decoder = new CodexSessionDecoder();
    const events = decoder.decodeTranscript([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "wrapper",
          input: "await tool.exec()",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "cmd-1",
            status: "completed",
            command: ["sh", "-c", "printf ok"],
            cwd: "/work",
            exit_code: 0,
            stdout: "ok",
            stderr: "",
            duration: { secs: 0, nanos: 250_000_000 },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "cmd-2",
            status: "failed",
            command: ["sh", "-c", "exit 127"],
            cwd: "/work",
            exit_code: 127,
            stdout: "",
            stderr: "missing",
            duration: { secs: 1, nanos: 500_000_000 },
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            command: ["false"],
            status: "in_progress",
            exit_code: 0,
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            command: ["false"],
            status: "completed",
          },
        },
      },
    ]);
    expect(events.filter((event) => event.type === "command_exec")).toMatchObject([
      {
        command: "sh",
        args: ["-c", "printf ok"],
        cwd: "/work",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 250,
      },
      {
        command: "sh",
        args: ["-c", "exit 127"],
        cwd: "/work",
        exitCode: 127,
        stdout: "",
        stderr: "missing",
        durationMs: 1500,
      },
    ]);
  });

  it.each(["function-first", "item-first"])(
    "deduplicates command completion in %s order",
    (order) => {
      const decoder = new CodexSessionDecoder();
      const functionResult = {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "Process exited with code 1\nFinal output:\n",
        },
      };
      const itemResult = {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "c1",
            status: "completed",
            command: ["false"],
            cwd: "/work",
            exit_code: 1,
          },
        },
      };
      const events = decoder.decodeTranscript([
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "c1",
            arguments: '{"cmd":"false","cwd":"/work"}',
          },
        },
        ...(order === "function-first"
          ? [functionResult, itemResult]
          : [itemResult, functionResult]),
      ]);
      expect(events.filter((event) => event.type === "command_exec")).toMatchObject([
        { command: "false", exitCode: 1 },
      ]);
    },
  );
  it("preserves separate executions with identical argv and cwd", () => {
    const decoder = new CodexSessionDecoder();
    const events = decoder.decodeTranscript([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "first",
          arguments: '{"cmd":"pwd","cwd":"/work"}',
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "first",
            status: "completed",
            command: ["pwd"],
            cwd: "/work",
            exit_code: 0,
            stdout: "/work\n",
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "second",
            status: "completed",
            command: ["pwd"],
            cwd: "/work",
            exit_code: 0,
            stdout: "/work\n",
          },
        },
      },
    ]);
    expect(events.filter((event) => event.type === "command_exec")).toMatchObject([
      { command: "pwd", cwd: "/work", exitCode: 0 },
      { command: "pwd", cwd: "/work", exitCode: 0 },
    ]);
  });
});
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
  describe("Native Codex rollouts", () => {
    it("normalizes a representative native envelope fixture and its usage once", async () => {
      const rawContent = await readFixture(SYNTHETIC_NATIVE_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent, { sessionId: "sess_native_observer" });

      for (const event of events) {
        expect(NormalizedSessionEventSchema.safeParse(event).success).toBe(true);
      }
      expect(events.every((event) => event.sessionId === "sess_native_observer")).toBe(true);
      expect(
        events.filter((event) => event.type === "message" && event.role === "user"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "message" && event.role === "assistant"),
      ).toHaveLength(1);

      const userMessage = events.find((event) => event.type === "message" && event.role === "user");
      expect(userMessage?.timestamp).toBe("2026-06-05T10:00:03.000Z");
      expect(userMessage?.metadata?.codexNative).toMatchObject({
        ordinal: 4,
        threadId: "thread-native-smoke",
        rootThreadId: "root-native-session",
        nativeSessionId: "root-native-session",
        turnId: "turn-native-1",
        rootTurnId: "root-turn-1",
        cwd: "/workspace/codex-project",
        model: "gpt-6-luna",
        modelProvider: "openai",
        effort: "high",
        contextWindow: 32768,
      });

      const toolCall = events.find((event) => event.type === "tool_call");
      expect(toolCall).toMatchObject({
        callId: "call-native-1",
        toolName: "exec_command",
        parameters: { cmd: "printf '{\"total\":6}\\n'", yield_time_ms: 1000 },
      });
      const toolResult = events.find((event) => event.type === "tool_result");
      expect(toolResult).toMatchObject({
        callId: "call-native-1",
        result: '{"total":6}\n',
        isError: false,
        metadata: { codexNative: { outcome: "completed" } },
      });

      const lifecycles = events.filter((event) => event.type === "session_lifecycle");
      expect(
        lifecycles.map((event) =>
          event.type === "session_lifecycle" ? event.lifecycleType : undefined,
        ),
      ).toEqual(["start", "end"]);
      const end = lifecycles.find(
        (event) => event.type === "session_lifecycle" && event.lifecycleType === "end",
      );
      if (!end || end.type !== "session_lifecycle") {
        throw new Error("Expected a native turn end lifecycle");
      }
      expect(end.providerUsage).toMatchObject({
        provider: "openai",
        model: "gpt-6-luna",
        accountingVersion: "codex-cli-native-rollout-v1",
        availability: "complete",
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 10,
        cachedInputTokens: 40,
        totalTokens: 150,
      });
      expect(end.providerUsage?.costMicroUsd).toBeUndefined();
      expect(end.metadata?.codexNative).toMatchObject({
        cacheWriteInputTokens: 8,
        threadTokenUsage: { input_tokens: 220, total_tokens: 250 },
      });
    });

    it("uses the explicit turn total across multiple native responses", () => {
      const events = decodeCodexTranscript(
        [
          { type: "session_meta", payload: { id: "thread-usage", session_id: "root-usage" } },
          { type: "turn_context", payload: { turn_id: "turn-usage-1" } },
          {
            type: "token_usage_record",
            payload: {
              thread_id: "thread-usage",
              turn_id: "turn-usage-1",
              response_id: "response-usage-1",
              usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              turn_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            },
          },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              },
            },
          },
          {
            type: "token_usage_record",
            payload: {
              thread_id: "thread-usage",
              turn_id: "turn-usage-1",
              response_id: "response-usage-2",
              usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
              turn_token_usage: { input_tokens: 250, output_tokens: 30, total_tokens: 280 },
            },
          },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
                total_token_usage: { input_tokens: 250, output_tokens: 30, total_tokens: 280 },
              },
            },
          },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-usage-1" } },
        ],
        { sessionId: "sess_native_multi_response_usage" },
      );
      const end = events.find(
        (event) => event.type === "session_lifecycle" && event.lifecycleType === "end",
      );
      if (!end || end.type !== "session_lifecycle") {
        throw new Error("Expected the native usage turn to end");
      }
      expect(end.providerUsage).toMatchObject({
        availability: "complete",
        inputTokens: 250,
        outputTokens: 30,
        totalTokens: 280,
      });
    });

    it("keeps duplicate token-count snapshots subordinate in either record order", () => {
      const countRecord: CodexTranscriptPayload = {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        },
      };
      const usageRecord: CodexTranscriptPayload = {
        type: "token_usage_record",
        payload: {
          thread_id: "thread-usage-order",
          turn_id: "turn-usage-order",
          response_id: "response-usage-order",
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          turn_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      };
      const prefix: CodexTranscriptPayload[] = [
        {
          type: "session_meta",
          payload: { id: "thread-usage-order", session_id: "root-usage-order" },
        },
        { type: "turn_context", payload: { turn_id: "turn-usage-order" } },
      ];
      const terminal: CodexTranscriptPayload = {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-usage-order" },
      };
      const orders: CodexTranscriptPayload[][] = [
        [countRecord, countRecord, usageRecord],
        [usageRecord, countRecord, countRecord],
      ];

      for (const order of orders) {
        const events = decodeCodexTranscript([...prefix, ...order, terminal], {
          sessionId: "sess_native_usage_order",
        });
        const end = events.find(
          (event) => event.type === "session_lifecycle" && event.lifecycleType === "end",
        );
        if (!end || end.type !== "session_lifecycle") {
          throw new Error("Expected the native usage turn to end");
        }
        expect(end.providerUsage).toMatchObject({
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
        });
      }
    });

    it("sums unique response usage records when per-turn totals are absent", () => {
      const first: CodexTranscriptPayload = {
        type: "token_usage_record",
        payload: {
          thread_id: "thread-response-usage",
          turn_id: "turn-response-usage",
          response_id: "response-usage-1",
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      };
      const duplicateFirst: CodexTranscriptPayload = {
        type: "token_usage_record",
        payload: {
          thread_id: "thread-response-usage",
          turn_id: "turn-response-usage",
          response_id: "response-usage-1",
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      };
      const second: CodexTranscriptPayload = {
        type: "token_usage_record",
        payload: {
          thread_id: "thread-response-usage",
          turn_id: "turn-response-usage",
          response_id: "response-usage-2",
          usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
        },
      };
      const events = decodeCodexTranscript(
        [
          {
            type: "session_meta",
            payload: { id: "thread-response-usage", session_id: "root-response-usage" },
          },
          { type: "turn_context", payload: { turn_id: "turn-response-usage" } },
          first,
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              },
            },
          },
          duplicateFirst,
          second,
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
                total_token_usage: { input_tokens: 250, output_tokens: 30, total_tokens: 280 },
              },
            },
          },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-response-usage" } },
        ],
        { sessionId: "sess_native_response_only_usage" },
      );
      const end = events.find(
        (event) => event.type === "session_lifecycle" && event.lifecycleType === "end",
      );
      if (!end || end.type !== "session_lifecycle") {
        throw new Error("Expected the response-only native usage turn to end");
      }
      expect(end.providerUsage).toMatchObject({
        availability: "complete",
        inputTokens: 250,
        outputTokens: 30,
        totalTokens: 280,
      });
    });

    it("keeps consecutive turn usage separate from cumulative token counts", () => {
      const events = decodeCodexTranscript(
        [
          {
            type: "session_meta",
            payload: { id: "thread-two-turns", session_id: "root-two-turns" },
          },
          { type: "turn_context", payload: { turn_id: "turn-one" } },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              },
            },
          },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-one" } },
          { type: "turn_context", payload: { turn_id: "turn-two" } },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
                total_token_usage: { input_tokens: 510, output_tokens: 210, total_tokens: 720 },
              },
            },
          },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-two" } },
        ],
        { sessionId: "sess_native_two_turn_usage" },
      );
      const ends = events.filter(
        (event) => event.type === "session_lifecycle" && event.lifecycleType === "end",
      );
      expect(ends).toHaveLength(2);
      const firstEnd = ends[0];
      const secondEnd = ends[1];
      if (firstEnd?.type !== "session_lifecycle" || secondEnd?.type !== "session_lifecycle") {
        throw new Error("Expected both native turns to end");
      }
      expect(firstEnd.providerUsage).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      });
      expect(secondEnd.providerUsage).toMatchObject({
        availability: "partial",
        inputTokens: 150,
        outputTokens: 20,
        totalTokens: 170,
      });
      expect(secondEnd.providerUsage?.costMicroUsd).toBeUndefined();
      expect(secondEnd.metadata?.codexNative).toMatchObject({
        threadTokenUsage: { input_tokens: 510, output_tokens: 210, total_tokens: 720 },
      });
    });

    it("preserves unavailable status on a last-response usage snapshot", () => {
      const events = decodeCodexTranscript(
        [
          {
            type: "session_meta",
            payload: { id: "thread-unavailable-usage", session_id: "root-unavailable-usage" },
          },
          { type: "turn_context", payload: { turn_id: "turn-unavailable-usage" } },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { availability: "unavailable" },
                total_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
              },
            },
          },
          {
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-unavailable-usage" },
          },
        ],
        { sessionId: "sess_native_unavailable_usage" },
      );
      const end = events.find(
        (event) => event.type === "session_lifecycle" && event.lifecycleType === "end",
      );
      if (!end || end.type !== "session_lifecycle") {
        throw new Error("Expected the native usage turn to end");
      }
      expect(end.providerUsage).toMatchObject({ availability: "unavailable" });
      expect(end.providerUsage?.inputTokens).toBeUndefined();
      expect(end.providerUsage?.totalTokens).toBeUndefined();
    });

    it("keeps observer identity while retaining native root and thread IDs", () => {
      const decoder = new CodexRecordDecoder();
      const records: RawHarnessRecord[] = [
        {
          recordId: "native-record-meta",
          sessionId: "sess_native_record",
          harnessId: "codex-cli",
          sequenceNumber: 1,
          timestamp: "2026-06-05T11:00:00.000Z",
          recordType: "message",
          rawPayload: {
            type: "session_meta",
            payload: {
              id: "thread-native-record",
              session_id: "root-native-record",
              cwd: "/workspace/record-project",
            },
          },
          cursor: { sequence: 1 },
          metadata: {},
        },
        {
          recordId: "native-record-context",
          sessionId: "sess_native_record",
          harnessId: "codex-cli",
          sequenceNumber: 2,
          timestamp: "2026-06-05T11:00:01.000Z",
          recordType: "message",
          rawPayload: {
            type: "turn_context",
            payload: { turn_id: "turn-native-record", model: "gpt-6-luna" },
          },
          cursor: { sequence: 2 },
          metadata: {},
        },
        {
          recordId: "native-record-user",
          sessionId: "sess_native_record",
          harnessId: "codex-cli",
          sequenceNumber: 3,
          timestamp: "2026-06-05T11:00:02.000Z",
          recordType: "message",
          rawPayload: {
            type: "response_item",
            payload: { type: "message", role: "user", content: "Stable observer identity." },
          },
          cursor: { sequence: 3 },
          metadata: {},
        },
      ];
      const events = records.flatMap((record) => decoder.decode(record));
      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("sess_native_record");
      expect(events[0].metadata?.codexNative).toMatchObject({
        threadId: "thread-native-record",
        rootThreadId: "root-native-record",
        nativeSessionId: "root-native-record",
        turnId: "turn-native-record",
        cwd: "/workspace/record-project",
        model: "gpt-6-luna",
      });
    });

    it("does not infer an MCP connection from the function namespace", () => {
      const events = decodeCodexTranscript(
        [
          { type: "session_meta", payload: { id: "thread-mcp", session_id: "root-mcp" } },
          {
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "mcp-call-1",
              namespace: "mcp__filesystem",
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
          },
        ],
        { sessionId: "sess_native_mcp" },
      );
      const call = events.find((event) => event.type === "tool_call");
      if (!call || call.type !== "tool_call") throw new Error("Expected native tool_call");
      expect(call.connection).toBeUndefined();
      expect(call.metadata?.codexNative).toMatchObject({ namespace: "mcp__filesystem" });
    });

    const decodeNativeShellResult = (
      toolName: string,
      output: CodexTranscriptValue,
      fields: CodexTranscriptPayload = {},
    ) =>
      decodeCodexTranscript(
        [
          {
            type: "session_meta",
            payload: { id: "thread-shell", session_id: "root-shell" },
          },
          {
            type: "turn_context",
            payload: { turn_id: "turn-shell" },
          },
          {
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "call-shell",
              name: toolName,
              arguments: "{}",
            },
          },
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "call-shell",
              output,
              ...fields,
            },
          },
        ],
        { sessionId: "sess_native_shell" },
      );

    const decodeNativeCodeModeExec = (
      input: string,
      output: CodexTranscriptValue,
      callFields: CodexTranscriptPayload = {},
      resultFields: CodexTranscriptPayload = {},
    ) =>
      decodeCodexTranscript(
        [
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              call_id: "call-native-codex-exec",
              name: "exec",
              input,
              ...callFields,
            },
          },
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-native-codex-exec",
              output,
              ...resultFields,
            },
          },
        ],
        { sessionId: "sess_native_codex_exec" },
      );

    it.each([
      {
        name: "strips a representative exec formatter and reports its nonzero status",
        toolName: "exec_command",
        output:
          "Chunk ID: failed-native-call\nWall time: 0.01 seconds\nProcess exited with code 7\nFinal output:\npermission denied\n",
        fields: {},
        result: "permission denied\n",
        outcome: "failed",
        isError: true,
      },
      {
        name: "does not infer success from unrecognized process-looking output",
        toolName: "exec_command",
        output: "Process exited with code 0\nprogram output",
        fields: { exit_code: 0, status: "unknown" },
        result: "Process exited with code 0\nprogram output",
        outcome: "unknown",
        isError: false,
      },
      {
        name: "recognizes a representative running shell formatter without completion",
        toolName: "write_stdin",
        output:
          "Chunk ID: running-native-call\nWall time: 0.05 seconds\nProcess running with session ID: 12345\n",
        fields: {},
        result: "",
        outcome: "running",
        isError: false,
      },
      {
        name: "preserves explicit truncation metadata",
        toolName: "exec_command",
        output: { output: "partial output", metadata: { exit_code: 0, truncated: true } },
        fields: {},
        result: "partial output",
        outcome: "truncated",
        isError: false,
      },
      {
        name: "parses the representative shell_command result formatter",
        toolName: "shell_command",
        output: "Exit code: 2\nWall time: 0.2 seconds\nOutput:\nnot found\n",
        fields: {},
        result: "not found\n",
        outcome: "failed",
        isError: true,
      },
      {
        name: "keeps a native result without output unknown",
        toolName: "read_text",
        output: undefined,
        fields: {},
        result: {},
        outcome: "unknown",
        isError: false,
      },
    ])("$name", ({ toolName, output, fields, result, outcome, isError }) => {
      const events = decodeNativeShellResult(toolName, output, fields);
      const toolResult = events.find((event) => event.type === "tool_result");
      if (!toolResult || toolResult.type !== "tool_result") {
        throw new Error("Expected native shell tool_result");
      }
      expect(toolResult.result).toEqual(result);
      expect(toolResult.isError).toBe(isError);
      expect(toolResult.metadata?.codexNative).toMatchObject({ outcome });
    });

    const authoredOne = { type: "input_text", text: "first authored item" };
    const authoredTwo = { type: "input_text", text: "second authored item" };
    it.each([
      {
        name: "strips exactly the validated completion header and preserves authored item boundaries",
        output: [
          {
            type: "input_text",
            text: "Script completed\nWall time 0.100 seconds (code-mode 0.080 seconds; overhead 0.020 seconds)\nOutput:\n",
          },
          authoredOne,
          authoredTwo,
          {
            type: "input_text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
        ],
        fields: {},
        result: [
          authoredOne,
          authoredTwo,
          {
            type: "input_text",
            text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
          },
        ],
        outcome: "completed",
        isError: false,
      },
      {
        name: "treats a native failed header as failure",
        output: [
          { type: "input_text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
          authoredOne,
        ],
        fields: {},
        result: [authoredOne],
        outcome: "failed",
        isError: true,
      },
      {
        name: "treats a native terminated header as failure",
        output: [
          { type: "input_text", text: "Script terminated\nWall time 0.1 seconds\nOutput:\n" },
          authoredOne,
        ],
        fields: {},
        result: [authoredOne],
        outcome: "failed",
        isError: true,
      },
      {
        name: "does not complete an explicitly truncated exec result",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          authoredOne,
        ],
        fields: { output_truncated: true },
        result: [authoredOne],
        outcome: "truncated",
        isError: false,
      },
    ])("$name", ({ output, fields, result, outcome, isError }) => {
      const events = decodeNativeCodeModeExec("{}", output, {}, fields);
      const call = events.find((event) => event.type === "tool_call");
      const toolResult = events.find((event) => event.type === "tool_result");
      if (call?.type !== "tool_call" || toolResult?.type !== "tool_result") {
        throw new Error("Expected native Code Mode exec call and result");
      }
      expect(call.parameters).toEqual({ raw: "{}" });
      expect(call.metadata?.codexNative).toMatchObject({
        type: "response_item",
        itemType: "custom_tool_call",
        sourceInterface: "codex-exec",
      });
      expect(toolResult.result).toEqual(result);
      expect(toolResult.isError).toBe(isError);
      expect(toolResult.metadata?.codexNative).toMatchObject({
        outcome,
        sourceInterface: "codex-exec",
      });
    });

    it.each([
      {
        name: "withholds a running native exec response item",
        output: [
          {
            type: "input_text",
            text: "Script running with cell ID cell_123\nWall time 0.1 seconds\nOutput:\n",
          },
          authoredOne,
        ],
        fields: {},
      },
      {
        name: "withholds an unclassified native exec output",
        output: [authoredOne, authoredTwo],
        fields: {},
      },
      {
        name: "withholds a completion header contradicted by unknown status",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          authoredOne,
        ],
        fields: { status: "unknown" },
      },
    ])("$name", ({ output, fields }) => {
      const events = decodeNativeCodeModeExec("{}", output, {}, fields);
      expect(events.some((event) => event.type === "tool_call")).toBe(true);
      expect(events.some((event) => event.type === "tool_result")).toBe(false);
    });

    it("keeps intermediate exec outputs from consuming the later complete result", () => {
      const intermediate = [
        {
          type: "input_text",
          text: "Script running with cell ID cell_123\nWall time 0.1 seconds\nOutput:\n",
        },
        { type: "input_text", text: "intermediate notification" },
      ];
      const authored = [{ type: "input_text", text: "final authored result" }];
      const events = decodeCodexTranscript(
        [
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              call_id: "call-native-codex-exec",
              name: "exec",
              input: "{}",
            },
          },
          {
            type: "event_msg",
            payload: {
              type: "item_completed",
              item: {
                type: "custom_tool_call_output",
                call_id: "call-native-codex-exec",
                output: intermediate,
              },
            },
          },
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-native-codex-exec",
              output: intermediate,
            },
          },
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-native-codex-exec",
              output: [
                { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
                ...authored,
              ],
            },
          },
        ],
        { sessionId: "sess_native_codex_exec_notifications" },
      );
      const results = events.filter((event) => event.type === "tool_result");
      expect(results).toHaveLength(1);
      expect(results[0]?.type === "tool_result" ? results[0].result : undefined).toEqual(authored);
      expect(results[0]?.metadata?.codexNative).toMatchObject({
        outcome: "completed",
        sourceInterface: "codex-exec",
      });
    });

    it("does not tag generic, shell, connected, or foreign-namespace exec calls as native Code Mode", () => {
      const generic = decodeCodexTranscript(
        [
          {
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "call-generic-exec",
              name: "exec",
              arguments: "{}",
            },
          },
        ],
        { sessionId: "sess_generic_exec" },
      ).find((event) => event.type === "tool_call");
      const foreign = decodeCodexTranscript(
        [
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              call_id: "call-foreign-exec",
              name: "exec",
              namespace: "mcp__filesystem",
              input: "{}",
            },
          },
        ],
        { sessionId: "sess_foreign_exec" },
      ).find((event) => event.type === "tool_call");
      const connected = decodeCodexTranscript(
        [
          {
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              call_id: "call-connected-exec",
              name: "exec",
              connection: "filesystem",
              input: "{}",
            },
          },
        ],
        { sessionId: "sess_connected_exec" },
      ).find((event) => event.type === "tool_call");
      const shell = decodeCodexTranscript(
        [{ type: "command_exec", command: "exec node -e 'text(42)'" }],
        { sessionId: "sess_shell_exec" },
      ).find((event) => event.type === "command_exec");
      const mcp = decodeCodexTranscript(
        [
          {
            type: "event_msg",
            payload: {
              type: "mcp_tool_call_begin",
              call_id: "call-mcp-exec",
              invocation: {
                tool: "exec",
                server: "filesystem",
                arguments: { raw: "{}" },
              },
            },
          },
        ],
        { sessionId: "sess_mcp_exec" },
      ).find((event) => event.type === "tool_call");
      expect(
        (generic?.metadata?.codexNative as Record<string, unknown> | undefined)?.sourceInterface,
      ).toBeUndefined();
      expect(
        (connected?.metadata?.codexNative as Record<string, unknown> | undefined)?.sourceInterface,
      ).toBeUndefined();
      expect(
        (foreign?.metadata?.codexNative as Record<string, unknown> | undefined)?.sourceInterface,
      ).toBeUndefined();
      expect(
        (shell?.metadata?.codexNative as Record<string, unknown> | undefined)?.sourceInterface,
      ).toBeUndefined();
      expect(
        (mcp?.metadata?.codexNative as Record<string, unknown> | undefined)?.sourceInterface,
      ).toBeUndefined();
    });

    it("represents a failed native task as an error and crash, not a successful end", () => {
      const events = decodeCodexTranscript(
        [
          { type: "session_meta", payload: { id: "thread-failed", session_id: "root-failed" } },
          { type: "turn_context", payload: { turn_id: "turn-failed" } },
          {
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-failed" },
          },
          {
            type: "event_msg",
            payload: {
              type: "task_failed",
              turn_id: "turn-failed",
              error: { code: "execution_failed", message: "Command failed" },
            },
          },
        ],
        { sessionId: "sess_native_failure" },
      );

      expect(events.find((event) => event.type === "error")).toMatchObject({
        type: "error",
        message: "Command failed",
      });
      expect(
        events
          .filter((event) => event.type === "session_lifecycle")
          .map((event) => (event.type === "session_lifecycle" ? event.lifecycleType : undefined)),
      ).toEqual(["start", "crash"]);
      const eventIds = events.map((event) => event.eventId);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    });
  });
});
