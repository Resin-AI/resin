/**
 * A recorded backup job whose dump command carries a database password. Checked against its own
 * recording, the plan as recorded verifies; a cloud-edited plan that spells a guessed password
 * where the recording kept it private is missed the same way whether the guess is right or wrong,
 * and the failed answer does not single out which private step failed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { afterEach, describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor } from "./recorded-sessions.js";

const owner = "private-oracle-owner";
const SESSION = "private-oracle-session";
const PASSWORD = "Tr0ub4dorPw9x";

const DBTOOL = `#!/bin/sh
echo "dumped $# args"
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function recordJob(store: InMemoryPrivateValueStore): RecordedWorkflow {
  const directory = mkdtempSync(path.join(tmpdir(), "resin-private-oracle-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "dbtool"), DBTOOL);
  chmodSync(path.join(directory, "dbtool"), 0o755);
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const emit = (fields: Record<string, unknown>) =>
    events.push(
      projectEventToMetadataOnly(
        recorder.observe(
          NormalizedSessionEventSchema.parse({
            schemaVersion: "1.0.0",
            sessionId: SESSION,
            eventId: `event-${sequence}`,
            timestamp: "2026-09-26T00:00:00.000Z",
            causalRef: { causalSequence: sequence++ },
            redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
            ...fields,
          }),
          { workspaceId: owner },
        ),
      ),
    );
  emit({ type: "message", role: "user", content: "Back up the inventory database" });
  const run = (callId: string, command: string) => {
    const printed = execFileSync("/bin/sh", ["-c", command], { cwd: directory, encoding: "utf8" });
    emit({ type: "tool_call", callId, toolName: "bash", parameters: { command } });
    emit({
      type: "tool_result",
      callId,
      toolName: "bash",
      result: printed,
      isError: false,
      executionDurationMs: 1,
    });
  };
  run("dump", `./dbtool dump --password ${PASSWORD} inventory`);
  run("list", "ls");
  return recordCallsFromEvents("inventory-backup", events as RecordableEvent[])!.workflow;
}

async function validate(plan: RecordedWorkflow, store: InMemoryPrivateValueStore) {
  return await createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [SESSION]),
  })({ ...plan, candidates: [] });
}

/** The plan with the dump step's command spelled out as literal text holding `password`. */
function guessing(plan: RecordedWorkflow, password: string): RecordedWorkflow {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.callId !== "dump"
        ? step
        : {
            ...step,
            arguments: step.arguments.map((argument) =>
              argument.name !== "command"
                ? argument
                : {
                    ...argument,
                    source: {
                      kind: "literal" as const,
                      value: `./dbtool dump --password ${password} inventory`,
                    },
                  },
            ),
          },
    ),
  };
}

describe("a validation ask over a private recorded value", () => {
  it("verifies the plan as recorded", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recordJob(store);
    expect(JSON.stringify(plan)).not.toContain(PASSWORD);
    expect((await validate(plan, store)).verification?.status).toBe("verified");
  });

  it("answers a right and a wrong password guess identically, without naming the private step", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recordJob(store);
    const right = await validate(guessing(plan, PASSWORD), store);
    const wrong = await validate(guessing(plan, "hunter22hunter"), store);
    expect(right.verification?.status).toBe("failed");
    expect(right.verification).toEqual(wrong.verification);
    const dump = plan.steps.find((step) => step.callId === "dump")!.id;
    expect(right.verification?.missed.map((entry) => entry.stepId)).toContain(dump);
  });
});
