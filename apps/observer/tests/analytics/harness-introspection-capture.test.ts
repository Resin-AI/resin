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
const VERIFY_COMMAND = "./dbtool verify backups/resin_orders.sql";

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

async function capture(sessionId: string, native: readonly object[]) {
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
  const timestamp = "2026-09-27T12:00:00.000Z";
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
  return submitted;
}

function preamble(sessionId: string) {
  return [
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
  ];
}

const callIdsOf = (events: readonly NormalizedSessionEvent[]) =>
  events.flatMap((event) =>
    event.type === "tool_call" || event.type === "tool_result" ? [event.callId] : [],
  );

function carrierOf(events: readonly NormalizedSessionEvent[], callId: string) {
  const call = events.find((event) => event.type === "tool_call" && event.callId === callId);
  return readWorkflowCallCarrier(call?.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
}

describe("harness introspection capture", () => {
  it("drops a Resin tool listing between two project calls and keeps their workflow intact", async () => {
    const sessionId = "codex-harness-introspection";
    const submitted = await capture(sessionId, [
      ...preamble(sessionId),
      ...execCall("call-dump", PROJECT_COMMAND, "resin_orders -> backups/resin_orders.sql"),
      ...execCall("call-listing", RESIN_TOOL_LISTING, "mcp__resin__invoke_tool"),
      ...execCall("call-verify", VERIFY_COMMAND, "backups/resin_orders.sql: ok"),
    ]);

    expect(JSON.stringify(submitted)).not.toContain("mcp__resin__");
    expect(callIdsOf(submitted)).toEqual(["call-dump", "call-dump", "call-verify", "call-verify"]);
    const dump = carrierOf(submitted, "call-dump");
    const verify = carrierOf(submitted, "call-verify");
    expect(dump?.origins.cmd).toMatchObject({
      type: "program",
      source: { type: "literal", value: PROJECT_COMMAND },
    });
    expect(verify?.origins.cmd).toMatchObject({
      type: "program",
      source: { type: "literal", value: VERIFY_COMMAND },
    });
    // The surviving calls are consecutive steps of one execution, as if the listing never ran.
    expect(verify?.executionIndex).toBe(dump?.executionIndex);
    expect(verify?.executionPosition).toBe((dump?.executionPosition ?? -1) + 1);
    expect(verify?.dependsOnCallIds ?? []).not.toContain("call-listing");
  });

  it("drops a resumed result whose call it never saw when the output names Resin's tools", async () => {
    const sessionId = "codex-harness-introspection-resumed";
    const [, listingResult] = execCall(
      "call-listing",
      RESIN_TOOL_LISTING,
      "mcp__resin__invoke_tool",
    );
    const [, projectResult] = execCall("call-dump", PROJECT_COMMAND, "resin_orders -> ok");
    const submitted = await capture(sessionId, [
      ...preamble(sessionId),
      listingResult!,
      projectResult!,
    ]);
    expect(callIdsOf(submitted)).toEqual(["call-dump"]);
  });
});
