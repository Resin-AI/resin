/**
 * Two real Pi 0.87.1 sessions (adapters/pi/tests/fixtures/recorded/0.87.1/du-report-*.jsonl): the
 * same disk-usage report job (`du -sh <dir>/* | sort -h > <file>`) run for two directories. Pi's
 * built-in `bash` calls reach the cloud as scrubbed program views, so the two runs can pair into
 * one tool instead of each shell step staying an opaque command.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PiRecordDecoder, PiSessionEventSource } from "@resin/adapter-pi";
import type { NormalizedSessionEvent } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import { readWorkflowCallCarrier } from "../../src/analytics/workflow-carrier.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const RECORDED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../adapters/pi/tests/fixtures/recorded/0.87.1",
);
const WORKSPACE = "workspace-pi-tool-capture";

async function capture(fixture: string): Promise<NormalizedSessionEvent[]> {
  const sessionId = `pi-${fixture}`;
  const source = new PiSessionEventSource({
    sessionId,
    workspaceId: WORKSPACE,
    harnessId: "pi",
    transcriptPath: path.join(RECORDED, fixture),
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    metadata: {},
  });
  const records: RawHarnessRecord[] = [];
  for (let batch = await source.readNext(); batch.length > 0; batch = await source.readNext()) {
    records.push(...batch);
  }
  await source.close();
  const privateValues = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: privateValues });
  pipeline.registerDecoder(new PiRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues });
  const observed: NormalizedSessionEvent[] = [];
  for (const record of records) {
    for (const result of await pipeline.processRecord(record, {
      sessionId,
      harnessId: "pi",
      workspaceId: WORKSPACE,
    })) {
      expect(result.status).toBe("success");
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return observed;
}

/** Each built-in bash call's shared program text, or its origin type when it has none. */
async function bashPrograms(fixture: string) {
  return (await capture(fixture)).flatMap((event) => {
    if (event.type !== "tool_call" || event.toolName !== "bash") return [];
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const origin = carrier?.origins?.command;
    return [
      origin?.type === "program" && origin.source.type === "literal"
        ? origin.source.value
        : origin?.type,
    ];
  });
}

describe("Pi tool capture", () => {
  it("shares each built-in bash command of both runs as a program view", async () => {
    const assets = await bashPrograms("du-report-assets.jsonl");
    const builds = await bashPrograms("du-report-builds.jsonl");
    expect(assets).toEqual([
      "printf '%s\\n' 'Resin tools available: none exposed in this session'; pwd; find . -maxdepth 2 -type d -name assets -print",
      "find . -maxdepth 1 -type f -printf '%f\\n' | sort",
      "du -sh assets/* | sort -h > du-assets.txt",
    ]);
    expect(builds).toEqual([
      "du -sh builds/* | sort -h > du-builds.txt && printf '%s\\n' '--- du-builds.txt ---' && cat du-builds.txt",
    ]);
  });
});
