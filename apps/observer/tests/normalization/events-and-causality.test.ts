import { NormalizedSessionEventSchema, type SessionEventType } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  NormalizationPipeline,
  generateDeterministicEventId,
} from "../../src/normalization/index.js";

describe("Deterministic Normalized Event IDs & Causal Lineage", () => {
  const sessionId = "01J5XYZ7890ABCDEFGHJKMNPQR";
  const timestamp = "2026-08-17T12:00:00.000Z";

  it("generates deterministic event IDs consistently for identical content", () => {
    const content = {
      role: "user",
      content: "Hello world, analyze the repo.",
    };

    const id1 = generateDeterministicEventId(sessionId, 1, content);
    const id2 = generateDeterministicEventId(sessionId, 1, content);
    const idDiffSeq = generateDeterministicEventId(sessionId, 2, content);
    const idDiffContent = generateDeterministicEventId(sessionId, 1, {
      ...content,
      content: "Different content",
    });

    expect(id1).toBe(id2);
    expect(id1.startsWith("evt_")).toBe(true);
    expect(id1).not.toBe(idDiffSeq);
    expect(id1).not.toBe(idDiffContent);
  });

  it("normalizes and establishes causal lineage across all 13 event variants", async () => {
    const pipeline = new NormalizationPipeline();

    const variants: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [
      // 1. message
      {
        type: "message",
        payload: {
          type: "message",
          role: "user",
          content: "Please search for occurrences of UserAccount.",
          model: "claude-3-7-sonnet",
        },
      },
      // 2. model_reasoning
      {
        type: "model_reasoning",
        payload: {
          type: "model_reasoning",
          reasoningContent: "The user is asking to search the repository for UserAccount.",
          model: "claude-3-7-sonnet",
          signature: "sig_abc123",
          tokenCount: 15,
          durationMs: 120,
        },
      },
      // 3. tool_discovery
      {
        type: "tool_discovery",
        payload: {
          type: "tool_discovery",
          tools: [
            {
              name: "ast_grep",
              description: "AST-based grep tool",
              inputSchema: { type: "object" },
              provider: "builtin",
            },
          ],
          source: "builtin",
        },
      },
      // 4. tool_call
      {
        type: "tool_call",
        payload: {
          type: "tool_call",
          toolName: "ast_grep",
          callId: "call_001",
          parameters: { pattern: "interface UserAccount { $$$ }" },
        },
      },
      // 5. tool_result
      {
        type: "tool_result",
        payload: {
          type: "tool_result",
          toolName: "ast_grep",
          callId: "call_001",
          result: { matches: ["src/user.ts:12"] },
          isError: false,
          executionDurationMs: 42,
          isShadow: false,
        },
      },
      // 6. command_exec
      {
        type: "command_exec",
        payload: {
          type: "command_exec",
          command: "git status",
          args: ["--porcelain"],
          cwd: "/repo",
          exitCode: 0,
          stdout: "clean",
          stderr: "",
          durationMs: 15,
        },
      },
      // 7. file_edit
      {
        type: "file_edit",
        payload: {
          type: "file_edit",
          filePath: "src/user.ts",
          operation: "update",
          patch: "--- a/src/user.ts\n+++ b/src/user.ts\n@@ -1 +1 @@\n-old\n+new",
          beforeHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          afterHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          diffStats: { linesAdded: 1, linesRemoved: 1 },
        },
      },
      // 8. error
      {
        type: "error",
        payload: {
          type: "error",
          errorType: "FileNotFoundError",
          message: "Could not locate src/missing.ts",
          recoverable: true,
        },
      },
      // 9. compaction
      {
        type: "compaction",
        payload: {
          type: "compaction",
          triggerReason: "context_limit",
          tokensBefore: 5000,
          tokensAfter: 500,
          preservedContextSummary: "Compacted previous 50 conversation turns.",
        },
      },
      // 10. branch_fork
      {
        type: "branch_fork",
        payload: {
          type: "branch_fork",
          sourceSessionId: sessionId,
          branchPointEventId: "evt_fork_point_01",
          forkReason: "exploring_alternative_plan",
          branchName: "feature_branch",
        },
      },
      // 11. subagent_lifecycle
      {
        type: "subagent_lifecycle",
        payload: {
          type: "subagent_lifecycle",
          subagentId: "subagent_scout_01",
          lifecycleType: "spawn",
          role: "scout",
          reason: "Spawned scout subagent for directory analysis",
        },
      },
      // 12. session_lifecycle
      {
        type: "session_lifecycle",
        payload: {
          type: "session_lifecycle",
          lifecycleType: "start",
          exitReason: undefined,
          harnessName: "resin-agent",
        },
      },
      // 13. unknown_passthrough
      {
        type: "unknown_passthrough",
        payload: {
          type: "unknown_passthrough",
          rawEventType: "experimental_telemetry",
          rawPayload: { metric: "token_usage", value: 1250 },
        },
      },
    ];

    expect(variants.length).toBe(13);

    let priorEventId: string | null = null;

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const rawRecord: RawHarnessRecord = {
        recordId: `rec_${i + 1}`,
        sessionId,
        harnessId: "test_harness",
        sequenceNumber: i + 1,
        timestamp,
        recordType: "custom",
        rawPayload: v.payload,
        cursor: {
          offset: i * 100,
          line: i + 1,
          sequence: i + 1,
          timestamp,
        },
        metadata: {},
      };

      const results = await pipeline.processRecord(rawRecord);
      expect(results.length).toBe(1);
      expect(
        results[0].status,
        results[0].status === "dead_letter" ? `${v.type} failed: ${results[0].errorReason}` : "",
      ).toBe("success");

      if (results[0].status === "success") {
        const event = results[0].event;
        expect(event.type).toBe(v.type);
        expect(event.sessionId).toBe(sessionId);
        expect(event.causalRef.causalSequence).toBe(i + 1);

        // Verify causal parent linking
        if (i === 0) {
          expect(event.causalRef.parentId).toBeNull();
        } else {
          expect(event.causalRef.parentId).toBe(priorEventId);
        }

        // Verify schema validation passes strictly
        const validated = NormalizedSessionEventSchema.parse(event);
        expect(validated.eventId).toBe(event.eventId);
        expect(validated.eventId.startsWith("evt_")).toBe(true);

        priorEventId = event.eventId;
      }
    }
  });

  it("handles recordType mapping from raw transcripts", async () => {
    const pipeline = new NormalizationPipeline();

    // 1. Raw prompt
    const promptRecord: RawHarnessRecord = {
      recordId: "rec_prompt_1",
      sessionId: "sess_transcript_test",
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "prompt",
      rawPayload: "Explain TypeScript generics.",
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const promptResults = await pipeline.processRecord(promptRecord);
    expect(promptResults.length).toBe(1);
    expect(promptResults[0].status).toBe("success");
    if (promptResults[0].status === "success") {
      expect(promptResults[0].event.type).toBe("message");
      if (promptResults[0].event.type === "message") {
        expect(promptResults[0].event.role).toBe("user");
        expect(promptResults[0].event.content).toBe("Explain TypeScript generics.");
      }
    }

    // 2. Raw completion
    const completionRecord: RawHarnessRecord = {
      recordId: "rec_comp_1",
      sessionId: "sess_transcript_test",
      harnessId: "test_harness",
      sequenceNumber: 2,
      timestamp,
      recordType: "completion",
      rawPayload: "Generics allow parameterized types in TypeScript.",
      cursor: { offset: 100, line: 2, sequence: 2, timestamp },
      metadata: {},
    };

    const compResults = await pipeline.processRecord(completionRecord);
    expect(compResults.length).toBe(1);
    expect(compResults[0].status).toBe("success");
    if (compResults[0].status === "success") {
      expect(compResults[0].event.type).toBe("message");
      if (compResults[0].event.type === "message") {
        expect(compResults[0].event.role).toBe("assistant");
        expect(compResults[0].event.content).toContain("Generics allow parameterized types");
      }
    }

    // 3. Raw tool call
    const toolCallRecord: RawHarnessRecord = {
      recordId: "rec_tool_1",
      sessionId: "sess_transcript_test",
      harnessId: "test_harness",
      sequenceNumber: 3,
      timestamp,
      recordType: "tool_call",
      rawPayload: {
        toolName: "read_file",
        callId: "call_read_1",
        parameters: { path: "src/index.ts" },
      },
      cursor: { offset: 200, line: 3, sequence: 3, timestamp },
      metadata: {},
    };

    const toolCallResults = await pipeline.processRecord(toolCallRecord);
    expect(toolCallResults.length).toBe(1);
    expect(toolCallResults[0].status).toBe("success");
    if (toolCallResults[0].status === "success") {
      expect(toolCallResults[0].event.type).toBe("tool_call");
      if (toolCallResults[0].event.type === "tool_call") {
        expect(toolCallResults[0].event.toolName).toBe("read_file");
        expect(toolCallResults[0].event.callId).toBe("call_read_1");
      }
    }
  });
});
