/**
 * A real Grok Build 1.0.13 headless session (adapters/grok-build/tests/fixtures/recorded/1.0.13/
 * sessions/01a0e63f-…): per-file `grep -c TODO` and `wc -l` counts written to src-stats.txt.
 * Its built-in `run_terminal_command` calls reach the cloud as scrubbed program views.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokHarnessAdapter, GrokRecordDecoder } from "@resin/adapter-grok-build";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import { readWorkflowCallCarrier } from "../../src/analytics/workflow-carrier.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const SESSION = "01a0e63f-2542-7502-8b1a-42dca17f7d77";
const WORKSPACE = "workspace-grok-tool-capture";
const RECORDED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../adapters/grok-build/tests/fixtures/recorded/1.0.13/sessions",
  SESSION,
);

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-grok-capture-"));
  fs.cpSync(
    RECORDED,
    path.join(home, ".grok", "sessions", encodeURIComponent("/workspace/project"), SESSION),
    { recursive: true },
  );
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function capture(): Promise<NormalizedSessionEvent[]> {
  const adapter = new GrokHarnessAdapter({ home, env: {} });
  const [workspace] = await adapter.listWorkspaces();
  const [session] = await adapter.listSessions(workspace!);
  const source = await adapter.openEventSource(session!);
  const records = await source.readNext(1000);
  await source.close();
  const privateValues = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: privateValues });
  pipeline.registerDecoder(new GrokRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues });
  const observed: NormalizedSessionEvent[] = [];
  for (const record of records) {
    for (const result of await pipeline.processRecord(record, {
      sessionId: SESSION,
      harnessId: "grok-build",
      workspaceId: WORKSPACE,
    })) {
      expect(result.status).toBe("success");
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return observed;
}

describe("Grok Build tool capture", () => {
  it("shares each built-in run_terminal_command as a program view", async () => {
    const carriers = (await capture()).flatMap((event) =>
      event.type === "tool_call" && event.toolName === "run_terminal_command"
        ? [readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])]
        : [],
    );
    const sources = carriers.map((carrier) => {
      const origin = carrier?.origins?.command;
      return origin?.type === "program" && origin.source.type === "literal"
        ? origin.source.value
        : origin?.type;
    });
    expect(sources).toHaveLength(3);
    expect(sources[1]).toContain("grep -c TODO");
    expect(sources[1]).toContain("} > src-stats.txt");
    expect(sources[2]).toBe("cat -A src-stats.txt");
  });
});
