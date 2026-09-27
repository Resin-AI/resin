/**
 * A program that introspects Resin or the harness is never learned: the capture coordinator keeps
 * its call and result out of the recorders and the upload, while ordinary project work that merely
 * mentions "resin" in its data still learns.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../../src/index.js";

/** The recorded program behind the published `list_resin_tools` (production, 2026-09-27). */
const RESIN_TOOL_LISTING = `node -e 'const ALL_TOOLS=[]; console.log(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"))'`;
const PROJECT_COMMAND = "./dbtool dump --date 2025-06-01 resin_orders";

function execCall(callId: string, cmd: string, output: string) {
  return [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: callId,
        arguments: JSON.stringify({ cmd, workdir: "/work" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: `Chunk ID: ${callId}\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\n${output}\n`,
      },
    },
  ];
}

describe("harness introspection capture", () => {
  it("never records or uploads a Resin tool listing, and still learns project work mentioning resin", async () => {
    const pipeline = new NormalizationPipeline({
      redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
    });
    pipeline.registerDecoder(new CodexRecordDecoder());
    const submitted: NormalizedSessionEvent[] = [];
    const client = Object.assign(Object.create(CloudObservationClient.prototype), {
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        submitted.push(...input.observations);
        return { batchId: "batch", acceptedCount: input.observations.length, rejectedCount: 0 };
      }),
    }) as CloudObservationClient;
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: client,
      coalesceDwellMs: 0,
    });
    const sessionId = "codex-harness-introspection";
    const timestamp = "2026-09-27T12:00:00.000Z";
    const native = [
      { type: "session_meta", payload: { id: sessionId, cwd: "/work", cli_version: "0.141.0" } },
      { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-5.5" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Back up the resin_orders table." }],
        },
      },
      ...execCall("call-listing", RESIN_TOOL_LISTING, ""),
      ...execCall("call-project", PROJECT_COMMAND, "resin_orders -> backups/resin_orders.sql"),
    ];
    await coordinator.handleRecords(
      {
        sessionId,
        workspaceId: "ws_introspection",
        harnessId: "codex-cli",
        transcriptPath: `/tmp/${sessionId}.jsonl`,
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      },
      native.map((entry, index) => ({
        recordId: `rec_${index + 1}`,
        sessionId,
        harnessId: "codex-cli",
        sequenceNumber: index + 1,
        recordType: "transcript_line" as const,
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ordinal: index + 1, ...entry }),
        cursor: { offset: index + 1, line: index + 1, sequence: index + 1, timestamp },
        metadata: {},
      })),
      async () => {},
    );
    coordinator.dispose();

    const callIds = submitted.flatMap((event) =>
      event.type === "tool_call" || event.type === "tool_result" ? [event.callId] : [],
    );
    expect(callIds).not.toContain("call-listing");
    expect(JSON.stringify(submitted)).not.toContain("mcp__resin__");
    expect(callIds).toEqual(["call-project", "call-project"]);
    const projectCall = submitted.find((event) => event.type === "tool_call");
    const carrier = readWorkflowCallCarrier(
      projectCall?.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY],
    );
    expect(carrier?.origins.cmd).toMatchObject({
      type: "program",
      source: { type: "literal", value: PROJECT_COMMAND },
    });
  });
});
