/**
 * A real headless Grok Build 1.0.13 run (adapters/grok-build/tests/fixtures/recorded) that follows a
 * runbook with shell commands must reach the recorder as calls and results it can compile, and end
 * on a boundary that settles the run.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokRecordDecoder, GrokSessionEventSource } from "@resin/adapter-grok-build";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const UPDATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../adapters/grok-build/tests/fixtures/recorded/1.0.13/sessions/44444444-4444-4444-8444-444444444444/updates.jsonl",
);
const SESSION = "44444444-4444-4444-8444-444444444444";
const WORKSPACE = "workspace-grok-build-capture";

async function capture() {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new GrokRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const source = new GrokSessionEventSource({ filePath: UPDATES, sessionId: SESSION });
  const deadLetters: string[] = [];
  const projected: NormalizedSessionEvent[] = [];
  for (let batch = await source.readNext(50); batch.length > 0; batch = await source.readNext(50)) {
    for (const record of batch) {
      const results = await pipeline.processRecord(record, {
        sessionId: SESSION,
        harnessId: "grok-build",
        workspaceId: WORKSPACE,
      });
      for (const result of results) {
        if (result.status !== "success" || !result.event) {
          deadLetters.push(result.status === "dead_letter" ? result.errorReason : result.status);
          continue;
        }
        projected.push(
          projectEventToMetadataOnly(recorder.observe(result.event, { workspaceId: WORKSPACE })),
        );
      }
    }
  }
  await source.close();
  return { deadLetters, projected };
}

describe("Grok Build headless capture", () => {
  it("normalizes every call, result and reasoning step", async () => {
    const { deadLetters, projected } = await capture();
    expect(deadLetters).toEqual([]);
    const calls = projected.filter((event) => event.type === "tool_call");
    const results = projected.filter((event) => event.type === "tool_result");
    expect(calls).toHaveLength(13);
    expect(results.map((event) => event.callId).sort()).toEqual(
      calls.map((event) => event.callId).sort(),
    );
    for (const call of calls) {
      expect(
        readWorkflowCallCarrier(call.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]),
      ).toBeDefined();
    }
    for (const result of results) {
      expect(
        readWorkflowResultCarrier(result.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]),
      ).toBeDefined();
    }
    // Shell calls are single steps: no call-less command_exec accompanies them.
    expect(projected.filter((event) => event.type === "command_exec")).toEqual([]);
    expect(projected.some((event) => event.type === "model_reasoning")).toBe(true);
  });

  it("ends the prompt after its final answer so the run settles", async () => {
    const { projected } = await capture();
    const last = projected.at(-1);
    expect(last).toMatchObject({
      type: "session_lifecycle",
      lifecycleType: "end",
      exitReason: "end_turn",
    });
    expect(projected.at(-2)).toMatchObject({ type: "message", role: "assistant" });
  });
});
