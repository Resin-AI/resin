/**
 * A recorded backup job whose dump command carries a database password, captured through the real
 * normalization pipeline (the upload redacts the password) and recorder. Checked against its own
 * recording, the plan as recorded verifies. A cloud-edited plan that spells a guessed password where
 * the upload kept it private is missed the same way whether the guess is right or wrong, and a
 * derivation that reads the private step makes the whole ask unavailable without any check.
 */
import { OmpRecordDecoder } from "@resin/adapter-omp";
import type { NormalizedSessionEvent, RecordedWorkflow, WorkflowStep } from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  NormalizationPipeline,
  type PrivateValueStore,
  type RecordableEvent,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
} from "@resin/observer";
import { describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor } from "./recorded-sessions.js";

const owner = "private-oracle-owner";
const SESSION = "private-oracle-session";
const PASSWORD = "Tr0ub4dorPw9x";
const DUMP = `pg_dump --password ${PASSWORD} inventory > backups/inventory.sql`;
const TIMESTAMP = "2026-09-26T00:00:00.000Z";

function record(sequence: number, message: unknown) {
  return {
    recordId: `rec_${sequence}`,
    sessionId: SESSION,
    harnessId: "omp",
    sequenceNumber: sequence,
    recordType: "transcript_line",
    timestamp: TIMESTAMP,
    rawPayload: JSON.stringify({ type: "message_end", message }),
    cursor: { offset: sequence, line: sequence, sequence, timestamp: TIMESTAMP },
    metadata: {},
  };
}

async function recordJob(store: InMemoryPrivateValueStore): Promise<RecordedWorkflow> {
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new OmpRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const feed = async (message: unknown) => {
    for (const outcome of await pipeline.processRecord(record(++sequence, message), {
      sessionId: SESSION,
      harnessId: "omp",
      workspaceId: owner,
    })) {
      if (outcome.status === "success" && !outcome.isDuplicate) {
        events.push(
          projectEventToMetadataOnly(recorder.observe(outcome.event, { workspaceId: owner })),
        );
      }
    }
  };
  await feed({ role: "user", content: [{ type: "text", text: "Back up the inventory database" }] });
  for (const [id, command, output] of [
    ["dump", DUMP, "dumped 42 rows"],
    ["check", "wc -l backups/inventory.sql", "42 backups/inventory.sql"],
  ] as const) {
    await feed({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
    });
    await feed({
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      content: [{ type: "text", text: output }],
    });
  }
  const workflow = recordCallsFromEvents("inventory-backup", events as RecordableEvent[])!.workflow;
  expect(JSON.stringify(workflow)).not.toContain(PASSWORD);
  return workflow;
}

async function validate(plan: RecordedWorkflow, store: PrivateValueStore) {
  return await createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [SESSION]),
    derivation: {
      runtime: "resin.program",
      call: async () => {
        throw new Error("no derivation may run in these checks");
      },
    },
  })({ ...plan, candidates: [] });
}

function withDumpCommand(plan: RecordedWorkflow, command: string): RecordedWorkflow {
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
                : { ...argument, source: { kind: "literal" as const, value: command } },
            ),
          },
    ),
  };
}

describe("a validation ask over a private recorded value", () => {
  it("verifies the plan as recorded", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await recordJob(store);
    expect((await validate(plan, store)).verification?.status).toBe("verified");
  });

  it("answers a right and a wrong password guess identically", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await recordJob(store);
    const right = await validate(withDumpCommand(plan, DUMP), store);
    const wrong = await validate(withDumpCommand(plan, DUMP.replace(PASSWORD, "hunter22")), store);
    expect(right.verification?.status).toBe("failed");
    expect(right).toEqual(wrong);
    const dump = plan.steps.find((step) => step.callId === "dump")!.id;
    expect(right.verification?.missed.map((entry) => entry.stepId)).toContain(dump);
  });

  it("answers any plan whose derivation reads the private step with the same unavailable answer", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await recordJob(store);
    const dump = plan.steps.find((step) => step.callId === "dump")!;
    const derive = (code: string): RecordedWorkflow => ({
      ...plan,
      steps: [
        ...plan.steps,
        {
          id: "derive",
          origin: "derivation",
          callable: {
            runtime: "resin.program",
            name: "derive",
            program: { kind: "python", source: code, argument: "code" },
          },
          arguments: [
            { name: "code", source: { kind: "literal", value: code } },
            { name: "input", source: { kind: "result", stepId: dump.id, path: [] } },
          ],
          dependsOn: [dump.id],
          failurePolicy: { onError: "abort", policy: "default" },
        } as unknown as WorkflowStep,
      ],
    });
    const one = await validate(derive("print(1 if 'Tr0' in input else 0)"), store);
    const other = await validate(derive("print(0)"), store);
    expect(one.unavailable).toMatch(/derivation step of this plan reads recorded data/);
    expect(one.verification).toBeUndefined();
    expect(one).toEqual(other);
  });

  it("treats a call recorded without its upload's private positions as private throughout", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await recordJob(store);
    // An older recording: the stored positions are absent.
    const legacy: PrivateValueStore = {
      get: (key) => {
        const value = store.get(key);
        return Array.isArray(value) &&
          value.every((entry) => typeof entry === "object" && entry !== null && "path" in entry)
          ? undefined
          : value;
      },
      set: (...args) => store.set(...args),
      origin: (key) => store.origin(key),
      representation: (key) => store.representation(key),
    };
    const check = plan.steps.find((step) => step.callId === "check")!.id;
    const literalCheck: RecordedWorkflow = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.id !== check
          ? step
          : {
              ...step,
              arguments: step.arguments.map((argument) =>
                argument.name !== "command"
                  ? argument
                  : {
                      ...argument,
                      source: { kind: "literal" as const, value: "wc -l backups/inventory.sql" },
                    },
              ),
            },
      ),
    };
    expect((await validate(literalCheck, store)).verification?.status).toBe("verified");
    const answer = await validate(literalCheck, legacy);
    expect(answer.verification?.status).toBe("failed");
    expect(answer.verification?.missed.map((entry) => entry.stepId)).toContain(check);
  });
});
