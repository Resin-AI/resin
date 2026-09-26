import { spawnSync } from "node:child_process";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  embeddedPrograms,
  tokenizeProgram,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { applyConfirmedWorkflowBinding } from "../../src/workflow/candidate-promotion.js";
import { computeWorkflowProgramIdentities } from "../../src/workflow/program-identity.js";
import {
  type RecordedCallRequest,
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const HEREDOC = `python3 - <<'PY'
merchant='Belles_cookbook_store'
day='12'
print(merchant + ':' + day)
PY`;

function recorded(command: string): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-embedded-program",
    inputs: [],
    privateReferences: [],
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
  };
}

function candidate(path: WorkflowBindingCandidate["path"], name: string): WorkflowBindingCandidate {
  return {
    stepId: "run",
    argument: "cmd",
    path,
    proposed: { kind: "input", name, type: "string", recordedDefault: true },
    reason: "native-data-argument",
    missing: "one recording does not establish that this value varies",
  };
}

function embeddedPath(command: string, raw: string): WorkflowBindingCandidate["path"] {
  const program = embeddedPrograms(command)[0]!;
  const index = program.tokens.findIndex((token) => token.raw === raw);
  if (index < 0) throw new Error(`no embedded token ${raw}`);
  return ["tokens", program.anchor, "embedded", index];
}

function promote(command: string, candidates: WorkflowBindingCandidate[]): RecordedWorkflow {
  let plan = recorded(command);
  for (const entry of candidates) {
    const next = applyConfirmedWorkflowBinding(plan, entry);
    if (next === undefined) throw new Error(`candidate ${entry.path.join(".")} was refused`);
    plan = next;
  }
  return plan;
}

/** Runs the plan and returns the program text the process adapter received. */
async function commandFor(plan: RecordedWorkflow, inputs: Record<string, string>) {
  const received: RecordedCallRequest[] = [];
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: "process",
    async call(request) {
      received.push(request);
      return { stdout: "" };
    },
  });
  const result = await executeRecordedWorkflow(plan, { inputs, adapters: registry });
  expect(result.status).toBe("completed");
  return String(received[0]!.arguments.cmd);
}

const bash = (program: string) => spawnSync("bash", ["-c", program], { encoding: "utf8" });

describe("embedded program holes", () => {
  it("binds heredoc literals and hands the process adapter a program python3 runs", async () => {
    const plan = promote(HEREDOC, [
      candidate(embeddedPath(HEREDOC, "'Belles_cookbook_store'"), "merchant"),
      candidate(embeddedPath(HEREDOC, "'12'"), "day"),
    ]);
    const command = await commandFor(plan, { merchant: "Martinis_Fine_Steakhouse", day: "10" });
    expect(command).toBe(
      HEREDOC.replace("'Belles_cookbook_store'", "'Martinis_Fine_Steakhouse'").replace(
        "'12'",
        "'10'",
      ),
    );
    // An omitted recorded-default input keeps the recorded literal.
    expect(await commandFor(plan, { day: "10" })).toContain("merchant='Belles_cookbook_store'");
    if (hasPython) expect(bash(command).stdout).toBe("Martinis_Fine_Steakhouse:10\n");
  });

  it("renders a quote inside a single-quoted python -c string as valid shell and python", async () => {
    const source = `python3 -c 'print("alpha")'`;
    const plan = promote(source, [candidate(embeddedPath(source, '"alpha"'), "text")]);
    const value = `it's a "test" of $HOME and \\ too`;
    const command = await commandFor(plan, { text: value });
    expect(command).not.toBe(source);
    if (hasPython) expect(bash(command)).toMatchObject({ status: 0, stdout: `${value}\n` });
  });

  it("keeps binding the same top-level token after a -c string, beside an embedded hole", async () => {
    const source = `python3 -c 'import sys; print("alpha", file=open(sys.argv[1], "w"))' out.txt`;
    const topLevel = tokenizeProgram("shell", source);
    const out = topLevel.findIndex((token) => token.raw === "out.txt");
    // The code string stays one top-level token, so `out.txt` keeps the index it always had.
    expect(topLevel.map((token) => token.raw)).toEqual([
      "python3",
      "-c",
      `'import sys; print("alpha", file=open(sys.argv[1], "w"))'`,
      "out.txt",
    ]);
    expect(out).toBe(3);
    const plan = promote(source, [
      candidate(["tokens", out], "path"),
      candidate(embeddedPath(source, '"alpha"'), "text"),
    ]);
    expect(await commandFor(plan, { path: "next.txt", text: "beta" })).toBe(
      `python3 -c 'import sys; print("beta", file=open(sys.argv[1], "w"))' next.txt`,
    );
    expect(await commandFor(plan, { path: "next.txt" })).toBe(
      source.replace("out.txt", "next.txt"),
    );
  });

  it("refuses a candidate addressing a program the command does not embed", () => {
    for (const path of [
      ["tokens", 0, "embedded", 0],
      ["tokens", embeddedPrograms(HEREDOC)[0]!.anchor, "embedded", 9999],
    ]) {
      expect(() =>
        applyConfirmedWorkflowBinding(recorded(HEREDOC), candidate(path, "text")),
      ).toThrow();
    }
  });

  it("makes the embedded index part of the program identity", async () => {
    const identity = async (raw: string) => {
      const [entry] = await computeWorkflowProgramIdentities({
        plan: promote(HEREDOC, [candidate(embeddedPath(HEREDOC, raw), "value")]),
      });
      return entry;
    };
    const merchant = await identity("'Belles_cookbook_store'");
    const day = await identity("'12'");
    expect(merchant?.sourceDigest).toBeDefined();
    expect(merchant?.sourceDigest).not.toBe(day?.sourceDigest);
    expect(merchant?.templateDigest).not.toBe(day?.templateDigest);
  });
});
