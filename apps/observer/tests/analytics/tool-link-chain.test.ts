import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  RESIN_TOOL_LINK_EVIDENCE_KEY,
  readComputationEvidence,
  readToolLinkEvidence,
} from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
} from "../../src/index.js";

/**
 * End-to-end proof, through the REAL capture path (decoder -> pipeline -> coordinator -> both
 * recorders -> local sink and cloud batch), that the local native-call handoff is consumed by BOTH
 * recorders and stripped exactly once: the call is announced without arguments, the arguments reach
 * the result as that handoff, and both the computation carrier and the tool link carrier are derived
 * from them before anything is projected.
 *
 * The regression this defends: whichever recorder runs first must not remove the handoff, or the
 * companion recorder silently loses its evidence for the same call.
 */

function sessionFor(sessionId: string): HarnessSession {
  const timestamp = "2026-06-30T00:00:00.000Z";
  return {
    sessionId,
    workspaceId: "ws_tool_link_chain",
    harnessId: "omp",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { tool: "omp" },
  };
}

function fakeCloudClient(): { client: CloudObservationClient; batches: unknown[] } {
  const batches: unknown[] = [];
  // SAFETY: the fake implements the submission methods the coordinator calls.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendTrajectoryObservationBatch = vi.fn(
    async (_input: { observations: TrajectoryObservation[] }) => ({
      batchId: "tool_link_traj_batch",
      accepted: 0,
      rejected: 0,
      errors: [],
    }),
  );
  client.sendObservationBatch = vi.fn(async (input: { observations: unknown[] }) => {
    batches.push(...input.observations);
    return {
      batchId: "tool_link_obs_batch",
      status: "accepted",
      acceptedCount: input.observations.length,
      rejectedCount: 0,
      errors: [],
    };
  });
  return { client, batches };
}

describe("tool link capture through the real coordinator", () => {
  it("consumes the embedded native call in both recorders and strips it exactly once", async () => {
    const sessionId = "sess_tool_link_chain";
    const callId = "chain-eval-call|fc-chain";
    const timestamp = "2026-06-30T00:00:00.000Z";
    const code = [
      "from pathlib import Path",
      "body = Path('/tmp/tl-chain-scratch/draft.md').read_text(encoding='utf-8')",
      "Path('/tmp/tl-chain-scratch/next.md').write_text(body.replace('- [ ] chain task', '- [x] chain task'), encoding='utf-8')",
      "print('chain')",
    ].join("\n");
    const rows = [
      {
        type: "custom",
        customType: "tool_execution_start",
        sessionId,
        timestamp,
        data: { toolCallId: callId, toolName: "eval" },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: callId, name: "eval", arguments: { language: "py", code } },
          ],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "eval",
          content: [{ type: "text", text: "chain" }],
          isError: false,
        },
      },
    ];
    const records: RawHarnessRecord[] = rows.map((row, index) => ({
      recordId: `tl-chain-record-${index}`,
      sessionId,
      harnessId: "omp",
      sequenceNumber: index + 1,
      timestamp,
      recordType: row.type === "custom" ? "custom" : "transcript_line",
      rawPayload: JSON.stringify(row),
      cursor: { offset: index * 100, line: index + 1, sequence: index + 1, timestamp },
      metadata: {},
    }));

    const pipeline = new NormalizationPipeline();
    pipeline.registerDecoder(new OmpRecordDecoder());
    const cloud = fakeCloudClient();
    const localEvents: NormalizedSessionEvent[] = [];
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: cloud.client,
      attributionResolver: async () => null,
      coalesceDwellMs: 0,
    });
    coordinator.setSessionEventSink((_session, events) => {
      localEvents.push(...events);
    });

    const session = sessionFor(sessionId);
    for (const record of records) {
      await coordinator.handleRecords(session, [record], async () => {});
    }
    await coordinator.handleRecords({ ...session, status: "completed" }, [], async () => {});
    await coordinator.waitForIdle();

    const calls = localEvents.filter((event) => event.type === "tool_call");
    const results = localEvents.filter((event) => event.type === "tool_result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    const call = calls[0]!;
    const result = results[0]!;

    // The announcement carried no arguments, so the computation recorder can only have produced this
    // carrier from the handoff that the tool link recorder left for it.
    const computation = readComputationEvidence(result.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]);
    expect(computation?.observation).toMatchObject({
      callId: call.type === "tool_call" ? call.callId : "",
      status: "success",
      callEventId: call.eventId,
      resultEventId: result.eventId,
    });

    // The tool link carrier is derived from those same embedded arguments.
    const toolLink = readToolLinkEvidence(result.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]);
    expect(toolLink).toMatchObject({
      operation: "file.transform",
      contentKinds: ["markdown_checklist"],
      observation: { callEventId: call.eventId, resultEventId: result.eventId, status: "success" },
    });
    // The call side announced no arguments at all, so it carries no pending carrier: the proof came
    // from the result's embedded copy.
    expect(call.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]).toBeUndefined();

    // Exactly one strip, and it happens before anything is projected: the local sink events and the
    // cloud rows carry the carriers but never the handoff or the authored source.
    const cloudRows = cloud.batches as NormalizedSessionEvent[];
    expect(cloudRows.length).toBeGreaterThan(0);
    for (const surface of [localEvents, cloudRows]) {
      const json = JSON.stringify(surface);
      expect(json).not.toContain("__resinLocalOmpNativeCallV1");
      expect(json).not.toContain(code);
    }
    const projectedResult = projectEventToMetadataOnly(result);
    expect(projectedResult.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]).toEqual(toolLink);
    expect(projectedResult.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]).toBeDefined();
  });
});
