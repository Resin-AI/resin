/**
 * Codex's direct terminal tool (`exec_command`, the Codex 0.141 default) runs a shell program. The
 * cloud compares recordings of the same job only through a scrubbed program view, so the recorder
 * must expose one for the harness's own call and never for an MCP tool that shares the name.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-codex-exec-command";
const COMMAND = "./dbtool dump --date 2025-06-01 inventory";

async function recordExecCommand(callFields: Record<string, unknown>) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const sessionId = "codex-exec-command";
  const timestamp = "2026-09-27T12:00:00.000Z";
  const native = [
    { type: "session_meta", payload: { id: sessionId, cwd: "/work", cli_version: "0.141.0" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-5.5" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Back up the inventory database for 2025-06-01." }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({ cmd: COMMAND, workdir: "/work" }),
        ...callFields,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output:
          "Chunk ID: c1\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\ninventory -> backups/inventory-2025-06-01.sql\n",
      },
    },
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${ordinal}`,
        sessionId,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ordinal, ...entry }),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  const call = observed.find((entry) => entry.type === "tool_call");
  const carrier = readWorkflowCallCarrier(call?.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
  if (carrier === undefined) throw new Error("expected a call carrier");
  return carrier;
}

describe("Codex exec_command programs", () => {
  it("exposes the native command as a scrubbed shell program", async () => {
    const carrier = await recordExecCommand({});
    expect(carrier.origins.cmd).toMatchObject({
      type: "program",
      language: "shell",
      source: { type: "literal", value: COMMAND },
    });
  });

  it("keeps an MCP tool named exec_command private", async () => {
    const carrier = await recordExecCommand({ namespace: "mcp__other" });
    expect(carrier.origins.cmd?.type).toBe("private");
  });
});
