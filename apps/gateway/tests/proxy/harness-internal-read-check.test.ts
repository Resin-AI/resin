/**
 * A plan recorded before capture stopped recording harness-internal reads can carry a step that
 * pages the harness's own session state (OMP's `read` of `artifact://1`). No later session can read
 * that URI back, so the recording check refuses such a plan instead of confirming it.
 */
import type { RecordedWorkflow } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { RESIN_HARNESS_TOOL_RUNTIME } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { type RecordedTurn, localCallsFor, recordSession } from "./recorded-sessions.js";

const owner = "harness-internal-read-owner";
const SESSION = "harness-internal-read-session";

function recording(store: InMemoryPrivateValueStore, readPath: string): RecordedWorkflow {
  const turns: RecordedTurn[] = [
    { user: "Summarize yesterday's spend" },
    {
      callId: "call-cost",
      toolName: "echo",
      connection: "cost-server",
      parameters: { value: "hourly" },
      result: "[raw output: artifact://1]",
    },
    { callId: "call-read", toolName: "read", parameters: { path: readPath }, result: "{}" },
    {
      callId: "call-daily",
      toolName: "echo",
      connection: "cost-server",
      parameters: { value: "daily" },
      result: "daily",
    },
  ];
  return recordSession(
    store,
    { workspaceId: owner, sessionId: SESSION, workflowId: "spend" },
    turns,
  );
}

const validate = (store: InMemoryPrivateValueStore, plan: RecordedWorkflow) =>
  createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [SESSION]),
  })(plan);

describe("the recording check refuses harness-internal reads", () => {
  it("does not confirm a plan with a harness read of an artifact:// path", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recording(store, "artifact://1");
    const read = plan.steps.find((step) => step.callable.name === "read");
    expect(read?.callable.runtime).toBe(RESIN_HARNESS_TOOL_RUNTIME);
    // The path the cloud sees is only a private reference, never the URI itself.
    expect(JSON.stringify(read?.arguments)).not.toContain("artifact://");

    const withCandidate: RecordedWorkflow = {
      ...plan,
      candidates: [
        {
          stepId: read!.id,
          argument: "path",
          path: [],
          proposed: { kind: "input", name: "read_path", type: "string" },
          reason: "native-data-argument",
          missing: "requires another recorded execution",
        },
      ],
    };
    const result = await validate(store, withCandidate);
    expect(result.unavailable).toMatch(/harness-internal session URI/);
    expect(result.verdicts).toMatchObject([
      { confirmed: false, reason: expect.stringMatching(/cannot be replayed/) },
    ]);
    expect(result.verification).toMatchObject({
      status: "failed",
      reproduced: [],
      missed: [{ stepId: read!.id, detail: result.unavailable }],
    });
  });

  it("refuses a literal harness-internal path the plan itself spells", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recording(store, "src/report.json");
    const literal: RecordedWorkflow = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.callable.name === "read"
          ? {
              ...step,
              arguments: [
                { name: "path", source: { kind: "literal" as const, value: "local://plan.md" } },
              ],
            }
          : step,
      ),
    };
    const result = await validate(store, literal);
    expect(result.unavailable).toMatch(/harness-internal session URI/);
  });

  it("still checks a plan whose harness read names an ordinary file", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recording(store, "src/report.json");
    const result = await validate(store, plan);
    expect(result.unavailable).toBeUndefined();
    expect(result.verification).toMatchObject({ status: "verified", missed: [] });
  });
});
