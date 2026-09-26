import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedWorkflow, WorkflowBindingCandidate } from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { demonstrationEnvironment } from "../../src/workflow/binding-validation.js";
import { applyConfirmedWorkflowBinding } from "../../src/workflow/candidate-promotion.js";
import { computeWorkflowProgramIdentities } from "../../src/workflow/program-identity.js";
import {
  type RecordedCallRequest,
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const COMMAND = "mkdir -p out/emea-2025-03 && printf ok > out/emea-2025-03/summary.csv";
// Tokens: mkdir -p out/emea-2025-03 && printf ok > out/emea-2025-03/summary.csv
const DIR = 2;
const FILE = 7;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function recorded(heldOut?: RecordedWorkflow["heldOut"]): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-span-holes",
    inputs: [],
    privateReferences: heldOut === undefined ? [] : ["private:held-out"],
    steps: [
      {
        id: "run",
        callId: "call-run",
        callable: {
          runtime: "process",
          name: "command_exec",
          program: { kind: "shell", source: COMMAND, argument: "cmd" },
        },
        arguments: [{ name: "cmd", source: { kind: "literal", value: COMMAND } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
    ...(heldOut === undefined ? {} : { heldOut }),
  };
}

function span(token: number, start: number, end: number, name: string): WorkflowBindingCandidate {
  return {
    stepId: "run",
    argument: "cmd",
    path: ["tokens", token, "span", start, end],
    proposed: { kind: "input", name, type: "string", recordedDefault: true },
    reason: "native-data-argument",
    missing: "one recording does not establish that this value varies",
  };
}

// `emea` is [4, 8) and `2025-03` is [9, 16) of both path tokens.
const CANDIDATES = [
  span(DIR, 4, 8, "region"),
  span(DIR, 9, 16, "month"),
  span(FILE, 4, 8, "region"),
  span(FILE, 9, 16, "month"),
];

function promote(): RecordedWorkflow {
  let plan = recorded();
  for (const candidate of CANDIDATES) {
    const next = applyConfirmedWorkflowBinding(plan, candidate);
    if (next === undefined) throw new Error("candidate refused");
    plan = next;
  }
  return plan;
}

describe("span holes at runtime", () => {
  it("hands the process adapter the composite command, which bash runs", async () => {
    const plan = promote();
    const work = await mkdtemp(join(tmpdir(), "resin-span-"));
    directories.push(work);
    const received: RecordedCallRequest[] = [];
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      runtime: "process",
      async call(request) {
        received.push(request);
        const run = spawnSync("bash", ["-c", String(request.arguments.cmd)], {
          cwd: work,
          encoding: "utf8",
        });
        return { stdout: run.stdout, exitCode: run.status };
      },
    });
    const inputs = { region: "north america", month: "2026-11" };
    const result = await executeRecordedWorkflow(plan, { inputs, adapters: registry });
    expect(result.status).toBe("completed");
    expect(await readFile(join(work, "out/north america-2026-11/summary.csv"), "utf8")).toBe("ok");
    // An omitted recorded-default input keeps its part of the recorded token.
    await executeRecordedWorkflow(plan, { inputs: { month: "2027-01" }, adapters: registry });
    expect(String(received[1]!.arguments.cmd)).toBe(COMMAND.replaceAll("2025-03", "2027-01"));
  });

  it("makes each span part of the program identity", async () => {
    const identity = async (candidate: WorkflowBindingCandidate) =>
      (
        await computeWorkflowProgramIdentities({
          plan: applyConfirmedWorkflowBinding(recorded(), candidate)!,
        })
      )[0];
    const region = await identity(span(DIR, 4, 8, "value"));
    const month = await identity(span(DIR, 9, 16, "value"));
    expect(region?.sourceDigest).toBeDefined();
    expect(region?.sourceDigest).not.toBe(month?.sourceDigest);
  });

  it("reads a demonstrated span only where the held-out token keeps the recorded surroundings", async () => {
    const environment = async (heldOutCommand: string) =>
      demonstrationEnvironment({
        plan: recorded({
          inputs: [{ stepId: "run", argument: "cmd", reference: "private:held-out" }],
          observed: [],
        }),
        candidates: [span(FILE, 4, 8, "region")],
        adapters: new RuntimeAdapterRegistry(),
        workspaceDir: tmpdir(),
        resolvePrivate: () => heldOutCommand,
      });
    const decidable = await environment(COMMAND.replaceAll("emea", "apac"));
    expect(decidable?.inputs).toEqual({ region: "apac" });
    // The month moved as well: the region span's surroundings differ, so nothing is decided.
    const undecidable = await environment(COMMAND.replaceAll("emea-2025-03", "apac-2026-01"));
    expect(undecidable?.inputs).toEqual({});
  });
});
