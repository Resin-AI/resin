/**
 * Printed-value extraction on adversarial outputs of the two learned benchmark tools (triage:
 * `ops/logtool.py summary` → `errors --service` → `explain --code`; release: `tools/release.py
 * status` → `check …` → `migration show` / `license`). Each tool is recorded once from its real
 * learning run through the session recorder, its printed-value bindings are promoted, and the plan
 * then runs against outputs the recording never saw (`fixtures/adversarial-extraction.json`):
 * several candidate values, the value missing, the value on another line, and names colliding
 * with other text. A run either feeds the consuming step the right value or fails that step with a
 * binding error before it runs; a wrong value reaching the consuming step is the failure this
 * guards against.
 */
import { readFileSync } from "node:fs";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RecordedWorkflow,
  type WorkflowJsonValue,
} from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  type RecordableEvent,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
  resolvePrivateReference,
} from "@resin/observer";
import {
  RESIN_PROCESS_RUNTIME,
  RuntimeAdapterRegistry,
  applyAcceptedBindings,
  executeRecordedWorkflow,
} from "@resin/runtime";
import { describe, expect, it } from "vitest";

type Step = { command: string; output: string };
type Tool = "triage" | "release";
interface Variant {
  class: "several" | "missing" | "moved" | "collision";
  tool: Tool;
  name: string;
  description: string;
  /** Index of the step whose command takes the extracted value as its last word. */
  consumer: number;
  /** The value the consuming step should run with; null when the output names no single one. */
  expected: string | null;
  /** How the run ends: the consumer runs with `expected`, or it fails before running. */
  outcome: "correct" | "failed";
  /** Outputs by step index that replace the learning run's; other steps print as recorded. */
  outputs: Record<string, string>;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/adversarial-extraction.json", import.meta.url), "utf8"),
) as { learned: Record<Tool, Step[]>; variants: Variant[] };

const owner = "adversarial-extraction-owner";

/** Records the learning run as one session and promotes its printed-value bindings. */
function learn(tool: Tool): { plan: RecordedWorkflow; store: InMemoryPrivateValueStore } {
  const store = new InMemoryPrivateValueStore();
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const emit = (fields: Record<string, unknown>) =>
    events.push(
      projectEventToMetadataOnly(
        recorder.observe(
          NormalizedSessionEventSchema.parse({
            schemaVersion: "1.0.0",
            sessionId: `adversarial-${tool}`,
            eventId: `event-${sequence}`,
            timestamp: "2026-10-09T00:00:00.000Z",
            causalRef: { causalSequence: sequence++ },
            redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
            ...fields,
          }),
          { workspaceId: owner },
        ),
      ),
    );
  emit({ type: "message", role: "user", content: `Run the ${tool} checks` });
  FIXTURE.learned[tool].forEach((step, index) => {
    const callId = `call-${index}`;
    emit({ type: "tool_call", callId, toolName: "bash", parameters: { command: step.command } });
    emit({
      type: "tool_result",
      callId,
      toolName: "bash",
      result: step.output,
      isError: false,
      executionDurationMs: 1,
    });
  });
  const recorded = recordCallsFromEvents(`adversarial-${tool}`, events as RecordableEvent[])!;
  const extracts = (recorded.workflow.candidates ?? []).filter(
    (candidate) => candidate.proposed.kind === "extract",
  );
  return { plan: applyAcceptedBindings(recorded.workflow, extracts), store };
}

const LEARNED = { triage: learn("triage"), release: learn("release") };

/** Runs the promoted plan with each step printing the variant's output, or the recorded one. */
async function run(variant: Variant) {
  const { plan, store } = LEARNED[variant.tool];
  const learned = FIXTURE.learned[variant.tool];
  const received: string[] = [];
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({
    runtime: RESIN_PROCESS_RUNTIME,
    async call(request) {
      const index = received.length;
      received.push(String(request.arguments.command));
      return variant.outputs[String(index)] ?? learned[index]!.output;
    },
  });
  const execution = await executeRecordedWorkflow(plan, {
    inputs: {},
    adapters,
    access: { workspaceId: owner },
    resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
  });
  return { execution, received };
}

/** The consuming step's command with the value it takes as its last word replaced. */
function consumedWith(variant: Variant, value: string): string {
  const command = FIXTURE.learned[variant.tool][variant.consumer]!.command;
  return `${command.slice(0, command.lastIndexOf(" "))} ${value}`;
}

describe("printed-value extraction on adversarial outputs of the learned tools", () => {
  it("binds the steps the tools were learned with to values printed earlier", () => {
    const extracted = (tool: Tool) =>
      LEARNED[tool].plan.steps.flatMap((step) =>
        JSON.stringify(step.arguments).includes('"type":"extract"') ? [step.id] : [],
      );
    expect(extracted("triage")).toEqual(["step1", "step2"]);
    expect(extracted("release")).toEqual(["step3", "step4"]);
  });

  it.each(FIXTURE.variants.map((variant) => [variant.class, variant.name, variant] as const))(
    "%s: %s",
    async (_class, _name, variant) => {
      const { execution, received } = await run(variant);
      const consumer = `step${variant.consumer}`;
      const ran = received[variant.consumer];
      if (ran !== undefined) {
        // A consuming step that ran must have run with the right value.
        expect(variant.expected).not.toBeNull();
        expect(ran).toBe(consumedWith(variant, variant.expected!));
      }
      if (variant.outcome === "correct") {
        expect(execution.status).toBe("completed");
        expect(ran).toBe(consumedWith(variant, variant.expected!));
        return;
      }
      expect(execution.status).toBe("failed");
      // The consuming step fails on its binding and neither it nor a later step runs.
      expect(received).toHaveLength(variant.consumer);
      const failed = execution.steps.find((entry) => entry.stepId === consumer);
      expect(failed?.status).toBe("failed");
      if (failed?.status !== "failed") return;
      expect(failed.error).toMatch(
        /printed several values where this argument reads exactly one|did not print the value this argument extracts/,
      );
      // The failure names no printed text.
      for (const output of Object.values(variant.outputs)) {
        for (const line of output.split("\n").filter((text) => text.trim().length > 8)) {
          expect(failed.error).not.toContain(line.trim());
        }
      }
    },
  );
});
