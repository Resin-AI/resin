/**
 * A later command token that an earlier command printed (`created deployment dep-9e983a`) is offered
 * as an extract binding on the printing step, with its locator kept in the local private store.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import {
  extractPrintedValue,
  parseExtractLocator,
  programTokenPath,
  tokenizeProgram,
  validateRecordedWorkflow,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import {
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowResultCarrier,
} from "../../src/analytics/workflow-carrier.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-extract-candidates";
const ID = "dep-9e983a";
const INSTRUCTION =
  "Create a deployment of the worker app in staging, wait until it is healthy, smoke test /health and promote it to production.";
const COMMANDS: Array<[string, string]> = [
  ["./deployctl create --app worker --env staging", `created deployment ${ID}\n`],
  [`./deployctl wait ${ID}`, `deployment ${ID} healthy\n`],
  [`./deployctl smoke --check /health ${ID}`, "smoke ok\n"],
  [`./deployctl promote --to production ${ID}`, `promoted ${ID} to production\n`],
];

async function recordSession(sessionId: string) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const timestamp = "2026-09-26T12:00:00.000Z";
  const native: unknown[] = [
    { type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: "/work" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: INSTRUCTION }],
      },
    },
    ...COMMANDS.map(([command, stdout], index) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: `exec-${sessionId}-${index}`,
          command: ["/bin/bash", "-lc", command],
          cwd: "file:///work",
          status: "completed",
          stdout,
          stderr: "",
          exit_code: 0,
          duration: { secs: 0, nanos: 5_000_000 },
        },
        started_at_ms: 1_000 + index * 10,
        completed_at_ms: 1_005 + index * 10,
      },
    })),
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${sessionId}_${ordinal}`,
        sessionId,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ordinal, ...(entry as object) }),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return { store, observed };
}

describe("values printed by an earlier command", () => {
  it("offers the printed id as an extract binding on the create step and keeps output local", async () => {
    const { store, observed } = await recordSession("codex-extract-deploy");
    const recipe = recordCallsFromEvents(
      "codex-extract-deploy",
      observed.map((entry) => projectEventToMetadataOnly(entry)),
    );
    const workflow = recipe!.workflow;
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
    expect(workflow.steps).toHaveLength(4);
    const createStep = workflow.steps[0]!.id;

    const extracts = (workflow.candidates ?? []).filter(
      (candidate) => candidate.proposed.kind === "extract",
    );
    const byStep = new Map(workflow.steps.map((step, index) => [step.id, index]));
    const addressed = extracts.map((candidate) => {
      const index = byStep.get(candidate.stepId)!;
      const command = COMMANDS[index]![0];
      const token = tokenizeProgram("shell", command)[programTokenPath(candidate.path)!.token]!;
      return [
        index,
        token.value,
        candidate.proposed.kind === "extract" && candidate.proposed.stepId,
      ];
    });
    expect(addressed).toEqual([
      [1, ID, createStep],
      [2, ID, createStep],
      [3, ID, createStep],
    ]);
    for (const candidate of extracts) {
      if (candidate.proposed.kind !== "extract") throw new Error("expected an extract");
      expect(candidate.reason).toBe("printed-by-earlier-step");
      expect(workflow.privateReferences).toContain(candidate.proposed.locator);
      // The locator resolves locally and finds the id in the create step's output.
      const locator = parseExtractLocator(
        String(resolvePrivateReference(store, candidate.proposed.locator)),
      );
      expect(locator).toBeDefined();
      expect(extractPrintedValue(COMMANDS[0]![1], locator!)).toBe(ID);
    }
    // What each step's own output calls a value it ran with travels on its projected result, as a
    // label only: `deployment dep-…` for `wait`, `promoted dep-…` for `promote`.
    const labels = observed.flatMap((event) => {
      const metadata = projectEventToMetadataOnly(event).metadata;
      const carrier = readWorkflowResultCarrier(metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]);
      return (carrier?.operandLabels ?? []).map((entry) => [entry.path, entry.label]);
    });
    expect(labels).toEqual([
      [["tokens", 2], "deployment"],
      [["tokens", 4], "promoted"],
    ]);

    // `--app worker` was named by the request: it stays an input candidate, never an extract.
    const createCandidates = (workflow.candidates ?? []).filter(
      (candidate) => candidate.stepId === createStep,
    );
    const worker = createCandidates.find(
      (candidate) =>
        tokenizeProgram("shell", COMMANDS[0]![0])[programTokenPath(candidate.path)?.token ?? -1]
          ?.value === "worker",
    );
    expect(worker?.proposed).toMatchObject({ kind: "input", recordedDefault: true });

    // No output text reaches the record.
    const serialized = JSON.stringify(workflow);
    for (const text of ["created deployment", "healthy", "smoke ok", "promoted "]) {
      expect(serialized).not.toContain(text);
    }
  });
});
