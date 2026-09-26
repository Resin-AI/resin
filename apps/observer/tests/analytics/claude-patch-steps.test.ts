/**
 * A real Claude Code 2.1.283 session (adapters/claude-code/tests/fixtures/recorded) that edits one
 * file and creates another records each edit as a private patch step, like a Codex apply_patch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRecordDecoder } from "@resin/adapter-claude-code";
import type { NormalizedSessionEvent, WorkflowStep } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { type RecordedRecipe, recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const RECORDED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../adapters/claude-code/tests/fixtures/recorded/2.1.283/projects/-workspace-project",
);
const WORKSPACE = "workspace-claude-patch-steps";

async function record(sessionFile: string) {
  const sessionId = path.basename(sessionFile, ".jsonl");
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new ClaudeRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const lines = fs
    .readFileSync(path.join(RECORDED, sessionFile), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const observed: NormalizedSessionEvent[] = [];
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
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  const projected = observed.map((entry) => projectEventToMetadataOnly(entry));
  return { store, projected, recipe: recordCallsFromEvents(sessionId, projected) };
}

function patchSteps(recipe: RecordedRecipe | undefined): WorkflowStep[] {
  return (recipe?.workflow.steps ?? []).filter((step) => step.callable.name === "apply_patch");
}

function privatePatch(
  step: WorkflowStep,
  store: InMemoryPrivateValueStore,
): unknown {
  const argument = step.arguments.find((entry) => entry.name === "patch");
  if (argument?.source.kind !== "template" || argument.source.template.type !== "program") {
    return undefined;
  }
  const source = argument.source.template.source;
  return source.type === "private" ? store.get(source.reference) : undefined;
}

describe("Claude Code patch steps", () => {
  it("records the Edit as a private patch step confined to the session's directory", async () => {
    const { store, projected, recipe } = await record("9cdec615-753c-4707-b2f9-831595b73692.jsonl");
    const steps = patchSteps(recipe);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.callable).toEqual({
      runtime: "resin-process",
      name: "apply_patch",
      program: { kind: "patch", source: "", argument: "patch" },
    });
    expect(privatePatch(steps[0]!, store)).toBe(
      "--- /workspace/project/calc.py\n+++ /workspace/project/calc.py\n@@ -1,4 +1,4 @@\n def add(a, b):\n     return a + b\n \n-print(add(2, 3))\n+print(add(4, 5))\n",
    );
    const workdir = steps[0]!.arguments.find((entry) => entry.name === "workdir");
    expect(workdir).toBeDefined();
    // The edited source never reaches the record or its cloud projection.
    for (const text of [JSON.stringify(recipe), JSON.stringify(projected)]) {
      expect(text).not.toContain("print(add(4, 5))");
    }
  });

  it("records a Write that created a file as a creation patch step", async () => {
    const { store, recipe } = await record("b167cb7a-84a9-42dd-ad65-c356fdb2bc6c.jsonl");
    const steps = patchSteps(recipe);
    expect(steps).toHaveLength(1);
    expect(privatePatch(steps[0]!, store)).toBe(
      "--- /dev/null\n+++ /workspace/project/todo.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n",
    );
  });
});
