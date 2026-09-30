import { spawnSync } from "node:child_process";
import type {
  RecordedWorkflow,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { applyConfirmedWorkflowBinding } from "../../src/workflow/candidate-promotion.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
  recordedWorkflowInputSchema,
} from "../../src/workflow/recorded-workflow.js";

// Tokens: python tests/runtests.py basic fixtures force_insert_update serializers
//         --settings=test_sqlite --parallel=1
const DJANGO =
  "python tests/runtests.py basic fixtures force_insert_update serializers --settings=test_sqlite --parallel=1";
const HELD_OUT = "python tests/runtests.py aggregation --settings=test_postgres --parallel=1";

function recorded(command = DJANGO, heldOut?: string): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-list-holes",
    inputs: [],
    privateReferences:
      heldOut === undefined ? [] : ["private:held-out:cmd", "private:held-out:run"],
    steps: [
      {
        id: "run",
        callId: "call-run",
        callable: {
          runtime: "process",
          name: "command_exec",
          program: { kind: "shell", source: command, argument: "cmd" },
        },
        arguments: [{ name: "cmd", source: { kind: "literal", value: command } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
    ...(heldOut === undefined
      ? {}
      : {
          heldOut: {
            inputs: [{ stepId: "run", argument: "cmd", reference: "private:held-out:cmd" }],
            observed: [{ stepId: "run", reference: "private:held-out:run" }],
          },
        }),
  };
}

function candidate(
  path: WorkflowBindingCandidate["path"],
  proposed: WorkflowBindingCandidate["proposed"],
): WorkflowBindingCandidate {
  return {
    stepId: "run",
    argument: "cmd",
    path,
    proposed,
    reason: "native-data-argument",
    missing: "one recording does not establish that this value varies",
  };
}

const LABELS = candidate(["tokens", 2, "through", 5], {
  kind: "input",
  name: "labels",
  type: "array",
  recordedDefault: true,
  list: { minItems: 1 },
});
// `test_sqlite` is [11, 22) of `--settings=test_sqlite`, the token after the list.
const SETTINGS = candidate(["tokens", 6, "span", 11, 22], {
  kind: "input",
  name: "settings",
  type: "string",
  recordedDefault: true,
});

/** What bash hands `python`: each argument it received, one per `<…>`. */
function run(command: string): { stdout: string; exitCode: number | null } {
  const result = spawnSync("bash", ["-c", `python() { printf '<%s>' "$@"; }; ${command}`], {
    encoding: "utf8",
  });
  return { stdout: result.stdout, exitCode: result.status };
}

function shellAdapters(received: string[]): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: "process",
    async call(request) {
      const command = String(request.arguments.cmd);
      received.push(command);
      return run(command);
    },
  });
  return registry;
}

function promoted(): RecordedWorkflow {
  const plan = applyConfirmedWorkflowBinding(recorded(), LABELS);
  if (plan === undefined) throw new Error("list candidate refused");
  return plan;
}

describe("a word list at runtime", () => {
  it("runs the recorded command on one label, on four, and as recorded when omitted", async () => {
    const plan = promoted();
    expect(plan.inputs).toEqual([
      { name: "labels", type: "array", recordedDefault: true, list: { minItems: 1 } },
    ]);
    const received: string[] = [];
    const adapters = shellAdapters(received);
    const one = await executeRecordedWorkflow(plan, {
      inputs: { labels: ["aggregation"] },
      adapters,
    });
    expect(one.status).toBe("completed");
    expect(received[0]).toBe(
      "python tests/runtests.py aggregation --settings=test_sqlite --parallel=1",
    );
    expect(one.result).toEqual({
      stdout: "<tests/runtests.py><aggregation><--settings=test_sqlite><--parallel=1>",
      exitCode: 0,
    });
    const labels = ["basic", "fixtures", "force_insert_update", "serializers"];
    await executeRecordedWorkflow(plan, { inputs: { labels }, adapters });
    await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(received.slice(1)).toEqual([DJANGO, DJANGO]);
  });

  it("passes each item to the program as one argument, whatever shell syntax it holds", async () => {
    const received: string[] = [];
    const items = ["a; rm -rf ~ $(id)", "*.py", "x y"];
    const execution = await executeRecordedWorkflow(promoted(), {
      inputs: { labels: items },
      adapters: shellAdapters(received),
    });
    expect(execution.result).toEqual({
      stdout: `<tests/runtests.py>${items.map((item) => `<${item}>`).join("")}<--settings=test_sqlite><--parallel=1>`,
      exitCode: 0,
    });
  });

  it("refuses an option-like item and an empty list before running anything", async () => {
    const received: string[] = [];
    const adapters = shellAdapters(received);
    await expect(
      executeRecordedWorkflow(promoted(), { inputs: { labels: ["--pdb"] }, adapters }),
    ).rejects.toThrow("looks like an option");
    await expect(
      executeRecordedWorkflow(promoted(), { inputs: { labels: [] }, adapters }),
    ).rejects.toThrow("needs at least 1 item");
    expect(received).toEqual([]);
  });

  it("describes the list input to callers as separate string arguments", () => {
    const plan = promoted();
    expect(recordedWorkflowInputSchema(plan)).toEqual({
      type: "object",
      properties: {
        labels: {
          type: "array",
          items: { type: "string", minLength: 1, pattern: "^[^-]" },
          minItems: 1,
          description:
            "A list of words: each item is passed to the command as one separate argument. Omit to use the recorded value.",
        },
      },
      required: [],
      additionalProperties: false,
    });
    plan.inputs[0] = { ...plan.inputs[0]!, list: { minItems: 0, optionItems: true } };
    expect(recordedWorkflowInputSchema(plan).properties).toMatchObject({
      labels: { items: { type: "string", minLength: 1 }, minItems: 0 },
    });
  });
});

describe("deciding a word list against a demonstration", () => {
  const resolver =
    (heldOut: string) =>
    (reference: string): WorkflowJsonValue => {
      if (reference === "private:held-out:cmd") return heldOut;
      if (reference === "private:held-out:run") return run(heldOut);
      throw new Error(`unexpected reference '${reference}'`);
    };

  it("confirms the list from a run of one label, and reads the setting after it", async () => {
    const plan = recorded(DJANGO, HELD_OUT);
    const candidates = [LABELS, SETTINGS];
    const received: string[] = [];
    const adapters = shellAdapters(received);
    const environment = await demonstrationEnvironment({
      plan,
      candidates,
      adapters: () => adapters,
      resolvePrivate: resolver(HELD_OUT),
    });
    // The setting sits three tokens earlier in the held-out run than in the recording.
    expect(environment?.inputs).toEqual({ labels: ["aggregation"], settings: "test_postgres" });

    const decided = await validateAndConfirmCandidates({
      plan,
      candidates,
      environment: environment!,
    });
    expect(decided.outcomes.map((outcome) => outcome.accepted)).toEqual([true, true]);
    expect(decided.verification?.status).toBe("verified");
    expect(decided.plan.inputs).toEqual([
      { name: "labels", type: "array", recordedDefault: true, list: { minItems: 1 } },
      { name: "settings", type: "string", recordedDefault: true },
    ]);
    expect(received).toContain(HELD_OUT);

    const callers: string[] = [];
    await executeRecordedWorkflow(decided.plan, {
      inputs: { labels: ["basic", "queries"] },
      adapters: shellAdapters(callers),
    });
    expect(callers).toEqual([
      "python tests/runtests.py basic queries --settings=test_sqlite --parallel=1",
    ]);
  });

  it("reads a whole token after the list where the list's length moved it", async () => {
    // Tokens: python -m pytest -q a.py b.py --maxfail 3
    const pytest = "python -m pytest -q a.py b.py --maxfail 3";
    const files = candidate(["tokens", 4, "through", 5], {
      kind: "input",
      name: "files",
      type: "array",
      list: { minItems: 1 },
    });
    const maxfail = candidate(["tokens", 7], { kind: "input", name: "maxfail", type: "string" });
    const environment = (candidates: WorkflowBindingCandidate[], heldOut: string) =>
      demonstrationEnvironment({
        plan: recorded(pytest, heldOut),
        candidates,
        adapters: () => new RuntimeAdapterRegistry(),
        resolvePrivate: resolver(heldOut),
      });
    const one = "python -m pytest -q c.py --maxfail 5";
    expect((await environment([files, maxfail], one))?.inputs).toEqual({
      files: ["c.py"],
      maxfail: "5",
    });
    // Without the list, token 7 of the one-file run does not exist: nothing is read.
    expect((await environment([maxfail], one))?.inputs).toEqual({});
    // A run that slipped an option into the list does not establish the list; the token after
    // it is still found, since the run's place in the text is.
    expect(
      (await environment([files, maxfail], "python -m pytest -q --pdb c.py --maxfail 5"))?.inputs,
    ).toEqual({ maxfail: "5" });
  });
});
