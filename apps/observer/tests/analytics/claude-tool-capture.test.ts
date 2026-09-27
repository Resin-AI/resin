/**
 * A real Claude Code 2.1.283 session (adapters/claude-code/tests/fixtures/recorded, `8ea90a99-…`)
 * that writes each content block as its own record reaches the cloud as recorded tool calls with
 * results, and settles: the tool events pass normalization instead of dead-lettering.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRecordDecoder } from "@resin/adapter-claude-code";
import { parseAssistantStopReason, type NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const SESSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../adapters/claude-code/tests/fixtures/recorded/2.1.283/projects/-workspace-project/8ea90a99-82b6-4c6c-b8cb-4fa5f5dee9dd.jsonl",
);
const WORKSPACE = "workspace-claude-tool-capture";

async function capture() {
  const sessionId = "8ea90a99-82b6-4c6c-b8cb-4fa5f5dee9dd";
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new ClaudeRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const lines = fs
    .readFileSync(SESSION, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const observed: NormalizedSessionEvent[] = [];
  const rejected: string[] = [];
  for (const [index, line] of lines.entries()) {
    const ordinal = index + 1;
    const timestamp = "2026-09-26T12:00:00.000Z";
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${sessionId}_${ordinal}`,
        sessionId,
        harnessId: "claude-code",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: line,
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId, harnessId: "claude-code", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success") {
        rejected.push(`${ordinal}: ${result.errorReason}`);
        continue;
      }
      if (result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return { rejected, projected: observed.map((entry) => projectEventToMetadataOnly(entry)) };
}

describe("Claude Code tool capture", () => {
  it("uploads every tool call and result as recorded workflow calls", async () => {
    const { rejected, projected } = await capture();
    expect(rejected).toEqual([]);
    const calls = projected.filter((event) => event.type === "tool_call");
    const results = projected.filter((event) => event.type === "tool_result");
    expect(calls).toHaveLength(11);
    expect(results).toHaveLength(11);
    for (const call of calls) expect(call.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]).toBeDefined();
    for (const result of results) {
      expect(result.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]).toBeDefined();
    }
    expect(projected.filter((event) => event.type === "command_exec")).toHaveLength(9);
  });

  it("ends on a completed assistant turn followed by the session's end", async () => {
    const { projected } = await capture();
    const lastAssistant = projected.findLast(
      (event) => event.type === "message" && event.role === "assistant",
    );
    expect(parseAssistantStopReason(lastAssistant?.metadata?.stopReason)).toBe("end_turn");
    expect(projected.at(-1)).toMatchObject({ type: "session_lifecycle", lifecycleType: "end" });
  });
});
