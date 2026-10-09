import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowJsonValue,
  type WorkflowStep,
  validateRecordedWorkflow,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";
import { createRecordingCheckAdapters } from "../../src/workflow/recording-check.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

/** A recorded chain of checks: each segment only reads files, so any of them may be turned off. */
const SEGMENTS = ["cat a.txt", "grep -q needle b.txt", "cat c.txt"];
const CHAIN = SEGMENTS.join(" && ");

function segmentStep(index: number, text: string): WorkflowStep {
  return {
    id: `s${index}`,
    callId: "chain",
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source: text, argument: "command", dialect: "bash" },
    },
    arguments: [
      {
        name: "command",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "shell",
            source: { type: "literal", value: text },
            sourceReference: "private:chain",
            protectedTokens: [],
            holes: [],
          },
        },
      },
    ],
    dependsOn: index === 0 ? [] : [`s${index - 1}`],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
    segment: { index, count: SEGMENTS.length, version: 4 },
    ...(index === 1 ? { optional: { input: "run_grep" } } : {}),
  };
}

const PLAN: RecordedWorkflow = {
  schemaVersion: 1,
  workflowId: "wf-checks",
  inputs: [{ name: "run_grep", type: "boolean", default: true }],
  privateReferences: ["private:chain"],
  steps: SEGMENTS.map((text, index) => segmentStep(index, text)),
};

const resolvePrivate = (reference: string): WorkflowJsonValue => {
  if (reference === "private:chain") return CHAIN;
  throw new Error(`unexpected reference '${reference}'`);
};

/** Runs each segment's rendered text with `sh` in `directory`; a non-zero exit fails the step. */
function shell(directory: string, received: string[]): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: RESIN_PROCESS_RUNTIME,
    async call(request) {
      const command = String(request.arguments.command);
      received.push(command);
      const result = spawnSync("sh", ["-c", command], { cwd: directory, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`exited with code ${String(result.status)}`);
      return result.stdout;
    },
  });
  return registry;
}

describe("an optional check segment", () => {
  it("is a valid plan step", () => {
    expect(validateRecordedWorkflow(PLAN).errors).toEqual([]);
  });

  it("runs the chain as recorded by default, and without the turned-off check when asked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "resin-optional-check-"));
    writeFileSync(join(directory, "a.txt"), "A\n");
    writeFileSync(join(directory, "b.txt"), "no match here\n");
    writeFileSync(join(directory, "c.txt"), "C\n");

    const received: string[] = [];
    const recorded = await executeRecordedWorkflow(PLAN, {
      inputs: {},
      adapters: shell(directory, received),
      resolvePrivate,
    });
    // `a && b && c`: the check fails, so the last segment never runs.
    expect(recorded.status).toBe("failed");
    expect(recorded.steps.map((outcome) => outcome.status)).toEqual([
      "completed",
      "failed",
      "skipped",
    ]);
    expect(received).toEqual(SEGMENTS.slice(0, 2));

    const withoutCheck: string[] = [];
    const omitted = await executeRecordedWorkflow(PLAN, {
      inputs: { run_grep: false },
      adapters: shell(directory, withoutCheck),
      resolvePrivate,
    });
    // `a && c`: the other checks do exactly what they did in the chain.
    expect(omitted.status).toBe("completed");
    expect(omitted.steps.map((outcome) => outcome.status)).toEqual([
      "completed",
      "omitted",
      "completed",
    ]);
    expect(withoutCheck).toEqual([SEGMENTS[0], SEGMENTS[2]]);
    // The chain answers with its last segment's output, as the recording observed it.
    expect(omitted.result).toBe("C\n");
  });

  it("still verifies against the recording, with the check on and off", async () => {
    const recording = new Map(
      SEGMENTS.map((text, index) => [
        `s${index}`,
        {
          callable: { name: "bash", program: { kind: "shell", argument: "command" } },
          arguments: { command: text },
          result: index === 1 ? "" : `${"AC"[index / 2]}\n`,
          hiddenDependencies: [],
        },
      ]),
    );
    for (const inputs of [{}, { run_grep: false }]) {
      const execution = await executeRecordedWorkflow(PLAN, {
        inputs,
        adapters: createRecordingCheckAdapters({ recording }),
        resolvePrivate,
      });
      expect(execution.status).toBe("completed");
    }
  });
});
