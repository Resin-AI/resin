/**
 * A plan cut from a longer execution is checked against the recorder's own judgement of which
 * values an earlier call printed. A script a `write` made names two job ids; the next call runs it
 * and prints them; the call after loops over them. Cut to [run, loop], the ids look printed by the
 * run step, but the session held them before it: the recorder proposed no binding, and the check
 * must not demand one. A value the run step printed first is still a hidden dependency.
 */
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RecordedWorkflow,
} from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  type RecordableEvent,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
} from "@resin/observer";
import { describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor } from "./recorded-sessions.js";

const owner = "slice-hidden-dependency-owner";
const session = "slice-hidden-dependency-session";
const LOOP = "for j in J1-alpha J6-beta; do python3 report.py --job $j; done";
const PRINTED = "unresolved <J1-alpha>\ncalls <J6-beta>\n";

/**
 * Records one execution: optionally a `write` of the script naming both ids, then the run that
 * prints them and the loop over them. Returns the plan cut to the run and the loop.
 */
function recordSlice(store: InMemoryPrivateValueStore, withWrite: boolean): RecordedWorkflow {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const emit = (fields: Record<string, unknown>) =>
    events.push(
      projectEventToMetadataOnly(
        recorder.observe(
          NormalizedSessionEventSchema.parse({
            schemaVersion: "1.0.0",
            sessionId: session,
            eventId: `event-${sequence}`,
            timestamp: "2026-10-06T00:00:00.000Z",
            causalRef: { causalSequence: sequence++ },
            redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
            ...fields,
          }),
          { workspaceId: owner },
        ),
      ),
    );
  const call = (
    callId: string,
    toolName: string,
    parameters: Record<string, unknown>,
    result: string,
  ) => {
    emit({ type: "tool_call", callId, toolName, parameters });
    emit({ type: "tool_result", callId, toolName, result, isError: false, executionDurationMs: 1 });
  };
  emit({ type: "message", role: "user", content: "Report the open jobs" });
  if (withWrite) {
    call(
      "write",
      "write",
      {
        path: "report.py",
        content: 'JOBS = ["J1-alpha", "J6-beta"]\nfor job in JOBS:\n    print(job)\n',
      },
      "wrote report.py",
    );
  }
  call("run", "bash", { command: "python3 report.py" }, PRINTED);
  call("loop", "bash", { command: LOOP }, "J1-alpha: 3 calls\nJ6-beta: 1 call\n");
  const slice = events.filter(
    (event) => "callId" in event && (event.callId === "run" || event.callId === "loop"),
  );
  return recordCallsFromEvents("slice", slice as RecordableEvent[])!.workflow;
}

async function validate(plan: RecordedWorkflow, store: InMemoryPrivateValueStore) {
  return await createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [session]),
  })(plan);
}

describe("hidden dependencies of a plan cut from a longer execution", () => {
  it("does not demand a binding for values the session held before the plan's first step", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recordSlice(store, true);
    expect(plan.steps.map((step) => step.callId)).toEqual(["run", "loop"]);
    // The recorder saw the ids in the script before the run printed them: no extract proposed.
    expect((plan.candidates ?? []).filter((c) => c.proposed.kind === "extract")).toEqual([]);

    const answer = await validate(plan, store);

    expect(answer.verification?.status).toBe("verified");
    expect(answer.verification?.reproduced).toEqual(["step0", "step1"]);
  });

  it("still demands a binding for values the plan's earlier step printed first", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recordSlice(store, false);
    const extracts = (plan.candidates ?? []).filter((c) => c.proposed.kind === "extract");
    expect(extracts.map((candidate) => [candidate.stepId, candidate.path])).toEqual([
      ["step1", ["tokens", 3]],
      ["step1", ["tokens", 4]],
    ]);

    // The plan carrying the printed ids literally hides that the loop reads the run's output.
    const answer = await validate({ ...plan, candidates: [] }, store);

    expect(answer.verification?.status).not.toBe("verified");
    expect(answer.verification?.missed.map((entry) => entry.stepId)).toContain("step1");
  });
});
