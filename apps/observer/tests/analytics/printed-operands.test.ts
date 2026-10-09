/**
 * Operands a later command took from an earlier command's printed listing, on real tool outputs
 * (`fixtures/printed-operands.json`): the dominant service in a log summary table, the dependency a
 * license check flags, and the migration a compatibility check flags wherever it is listed. Names
 * made only of letters are read only where a listing row starts with them and one row qualifies;
 * the agent's own earlier arguments and ambiguous listings stay inputs. Each call's result carries
 * only the label its own output gives a value it ran with (`Package`), never the value.
 */
import { readFileSync } from "node:fs";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  extractPrintedValue,
  tokenizeProgram,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { deriveNativeCalls } from "../../src/analytics/native-argument-derivation.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_PROCESS_RUNTIME,
  WorkflowCallRecorder,
} from "../../src/analytics/workflow-call-recorder.js";
import {
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowResultCarrier,
} from "../../src/analytics/workflow-carrier.js";

type Step = { command: string; output: string };
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/printed-operands.json", import.meta.url), "utf8"),
) as { triage: Record<string, Step[]>; release: Record<string, Step[]> };

function calls(steps: Step[]) {
  return steps.map((step, index) => ({
    callId: `call_${index}`,
    stepId: `step${index}`,
    toolName: "bash",
    runtime: RESIN_PROCESS_RUNTIME,
    arguments: { command: step.command },
    result: step.output,
    program: { kind: "shell" as const, argument: "command" },
  }));
}

/** Each extract as [consuming step, bound text, producer], checking its locator on the recording. */
function extracted(steps: Step[]) {
  const recorded = calls(steps);
  const derivation = deriveNativeCalls(recorded);
  const described = derivation.extracts.map((extract) => {
    const call = recorded.find((entry) => entry.stepId === extract.stepId)!;
    const text = tokenizeProgram("shell", call.arguments.command)[extract.path[1] as number]!.value;
    const producer = recorded.find((entry) => entry.stepId === extract.producerStepId)!;
    expect(extractPrintedValue(producer.result, extract.locator)).toBe(text);
    return [extract.stepId, text, extract.producerStepId];
  });
  return { derivation, described };
}

/** The bound value the locator of `stepId`'s extract reads from another run's producer output. */
function replayed(learned: Step[], stepId: string, other: Step[]): string | undefined {
  const extract = deriveNativeCalls(calls(learned)).extracts.find(
    (entry) => entry.stepId === stepId,
  );
  const producer = Number(extract!.producerStepId.slice("step".length));
  return extractPrintedValue(other[producer]!.output, extract!.locator);
}

describe("an operand printed in an earlier listing", () => {
  it("reads the dominant service from the summary table's first row", () => {
    for (const variant of ["L1", "L2", "V1"]) {
      const steps = FIXTURE.triage[variant]!;
      const service = steps[1]!.command.split(" ").at(-1)!;
      const code = steps[2]!.command.split(" ").at(-1)!;
      expect(extracted(steps).described).toEqual([
        ["step1", service, "step0"],
        ["step2", code, "step1"],
      ]);
    }
    // Learned on one variant, the locator reads each other variant's dominant service.
    expect(replayed(FIXTURE.triage.L1!, "step1", FIXTURE.triage.V1!)).toBe("billing");
    expect(replayed(FIXTURE.triage.L1!, "step1", FIXTURE.triage.L2!)).toBe("search-indexer");
    expect(replayed(FIXTURE.triage.L2!, "step1", FIXTURE.triage.L1!)).toBe("checkout");
  });

  it("reads the top error code from the row under the code table's header, never the first capital", () => {
    const learned = FIXTURE.triage.L1!;
    const extract = deriveNativeCalls(calls(learned)).extracts.find(
      (entry) => entry.stepId === "step2",
    );
    // `count` names the header (`code` is also in the runbook hint); the row starts with the code.
    expect(extract?.locator).toEqual({
      only: { before: "\n", after: "", line: { marker: "count", offset: 1 } },
      charset: ["upper", "digit", "-"],
    });
    const errors = learned[1]!.output;
    const variant = (output: string) =>
      replayed(learned, "step2", [learned[0]!, { ...learned[1]!, output }, learned[2]!]);
    // A warning line above the table: the first line starting with capitals is not the code.
    expect(variant(errors.replace("\n\ncode", "\n\nWARNING: 3 lines skipped\n\ncode"))).toBe(
      "CHK-PAY-504",
    );
    // No rows: the line under the header is blank, so nothing is read (not `R` of `Runbook`).
    expect(variant(errors.replace(/\nCHK-[^\n]*/g, ""))).toBeUndefined();
    // A second code table above makes the header ambiguous.
    expect(
      variant(errors.replace("\n\ncode", "\n\ncode  count\nPAY-GW-502  30\n\ncode")),
    ).toBeUndefined();
  });

  it("reads the flagged dependency and the incompatible migration wherever it is listed", () => {
    for (const variant of ["L1", "L2", "V1", "V2", "V3"]) {
      const steps = FIXTURE.release[variant]!;
      const migration = steps[3]!.command.split(" ").at(-1)!;
      const dependency = steps[4]!.command.split(" ").at(-1)!;
      expect(extracted(steps).described).toEqual([
        ["step3", migration, "step1"],
        ["step4", dependency, "step2"],
      ]);
    }
    // L1 lists the incompatible migration second, V1 first, V3 second.
    expect(replayed(FIXTURE.release.L1!, "step3", FIXTURE.release.V1!)).toBe(
      "0027_drop_user_sessions",
    );
    expect(replayed(FIXTURE.release.V1!, "step3", FIXTURE.release.V3!)).toBe(
      "0096_payments_provider_reference",
    );
    expect(replayed(FIXTURE.release.L1!, "step4", FIXTURE.release.V2!)).toBe("geohashx");
  });

  it("labels each operand on its call's result with what that call's own output calls it", () => {
    /** The labels the recorder puts on each step's projected result, as [step, token, label]. */
    const labels = (steps: Step[]) => {
      const recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() });
      const event = (fields: Record<string, unknown>) =>
        NormalizedSessionEventSchema.parse({
          schemaVersion: "1.0.0",
          sessionId: "session-operand-labels",
          timestamp: "2026-10-09T10:00:00.000Z",
          redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
          ...fields,
        });
      const observe = (entry: NormalizedSessionEvent) =>
        projectEventToMetadataOnly(recorder.observe(entry, { workspaceId: "ws_labels" }));
      observe(
        event({
          eventId: "evt_discovery",
          type: "tool_discovery",
          tools: [{ name: "bash", provider: "omp" }],
          source: "mcp",
          causalRef: { causalSequence: 0, parentId: null },
        }),
      );
      return steps.flatMap((step, index) => {
        const causalRef = { causalSequence: index + 1, parentId: null, turnIndex: 0, stepIndex: 0 };
        const callId = `call_${index}`;
        observe(
          event({
            eventId: `evt_call_${index}`,
            type: "tool_call",
            callId,
            toolName: "bash",
            parameters: { command: step.command },
            causalRef,
          }),
        );
        const projected = observe(
          event({
            eventId: `evt_result_${index}`,
            type: "tool_result",
            callId,
            toolName: "bash",
            result: step.output,
            isError: false,
            executionDurationMs: 5,
            causalRef,
          }),
        );
        const carrier = readWorkflowResultCarrier(
          projected.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
        );
        return (carrier?.operandLabels ?? []).map((entry) => [index, entry.path, entry.label]);
      });
    };
    // The runbook prints the code after `## `, which is no label.
    expect(labels(FIXTURE.triage.V1!)).toEqual([[1, ["tokens", 4], "Errors for service"]]);
    expect(labels(FIXTURE.release.V1!)).toEqual([
      [1, ["tokens", 3], "FAIL"],
      [2, ["tokens", 3], "FAIL"],
      [3, ["tokens", 4], "Migration"],
      [4, ["tokens", 3], "Package"],
    ]);
  });

  it("keeps a name the agent gave an earlier call as an input, never an extract", () => {
    const steps = FIXTURE.triage.V1!;
    const echoed = [
      { command: "python3 ops/logtool.py summary --service billing", output: steps[0]!.output },
      steps[1]!,
    ];
    expect(extracted(echoed).described).toEqual([]);
  });

  it("keeps a name as an input when no locator singles out its row", () => {
    const license = FIXTURE.release.V1![4]!;
    // A bare listing: the first row is preceded by nothing another row lacks.
    expect(
      extracted([
        { command: "ls deps/vendor", output: "pdfweave\nbarcodely\nfuzzmatch\n" },
        license,
      ]).described,
    ).toEqual([]);
    // A name printed inside prose, not starting its line, is an echo at best.
    expect(
      extracted([
        { command: "cat NOTES", output: "Last time we inspected pdfweave by hand.\n" },
        license,
      ]).described,
    ).toEqual([]);
  });
});
