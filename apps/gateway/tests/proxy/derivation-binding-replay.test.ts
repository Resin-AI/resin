/**
 * A recorded report command hard-codes values an agent looked up for one merchant (its account type
 * and category code). A model-written derivation computes them from the merchant; one baseline
 * recording must be enough to confirm it by running it in the derivation sandbox, and anything that merely repeats
 * the recording (hard-coded values), computes something else, or ignores the inputs is refuted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowStep,
  derivationHeader,
  derivationInputTokenIndexes,
  embeddedPrograms,
  validateRecordedWorkflow,
} from "@resin/contracts";
import { InMemoryPrivateValueStore, resolvePrivateReference } from "@resin/observer";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RuntimeAdapterRegistry,
  applyAcceptedBindings,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  instantiateRecordedWorkflow,
} from "@resin/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorkflowValidator } from "../../src/proxy/workflow-validation.js";

const owner = "derivation-binding-owner";

const RECORDED_COMMAND = "printf '%s %s %s\\n' Crossfit_Hanna C 1426";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** The body a model writes after the header; the header's merchant literal is a caller-input hole. */
/**
 * Derivations see only their inputs, so the looked-up values are computed from the merchant: its
 * initial is the account type and its character-code sum the category code.
 */
const NAME = 'name = inputs["merchant"]\ncode = sum(ord(c) for c in name)\n';
const LOOKUP = `${NAME}{"account_type": name[0], "mcc": code}\n`;

function derivation(body: string, bindInput = true): WorkflowStep {
  // The cloud does not know the recorded merchant, so the header carries a placeholder.
  const source = derivationHeader([{ name: "merchant", value: "" }]) + body;
  const [merchant] = derivationInputTokenIndexes(source, ["merchant"]);
  return {
    id: "derive",
    callId: "derivation:derive",
    origin: "derivation",
    callable: {
      runtime: RESIN_PROGRAM_RUNTIME,
      name: "python",
      program: { kind: "python", sourceInterface: "python-eval", source, argument: "code" },
    },
    arguments: [
      {
        name: "code",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "python",
            source: { type: "literal", value: source },
            holes: bindInput
              ? [{ token: merchant!, binding: { type: "input", name: "merchant" } }]
              : [],
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
    observed: { outcome: "unknown" },
  };
}

function tokenCandidate(
  token: number,
  proposed: WorkflowBindingCandidate["proposed"],
  reason: WorkflowBindingCandidate["reason"],
): WorkflowBindingCandidate {
  return {
    stepId: "report",
    argument: "command",
    path: ["tokens", token],
    proposed,
    reason,
    missing: "whether the token follows the caller's merchant",
  };
}

/** The recorded report plus one derivation, as the cloud proposes it; recorded values stay local. */
function recording(store: InMemoryPrivateValueStore, body: string, bindInput = true) {
  const printed = "Crossfit_Hanna C 1426\n";
  store.set("private:report-command", RECORDED_COMMAND, { workspaceId: owner });
  store.set("private:report-output", printed, { workspaceId: owner });
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "wf_merchant_report",
    inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
    privateReferences: ["private:report-command", "private:report-output"],
    steps: [
      derivation(body, bindInput),
      {
        id: "report",
        callId: "call_report",
        callable: {
          runtime: RESIN_PROCESS_RUNTIME,
          name: "bash",
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: [
          { name: "command", source: { kind: "private", reference: "private:report-command" } },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded", output: { type: "string", hasContent: true } },
      },
    ],
    candidates: [
      tokenCandidate(
        2,
        { kind: "input", name: "merchant", type: "string", recordedDefault: true },
        "classified-source-value",
      ),
      tokenCandidate(
        3,
        { kind: "result", stepId: "derive", path: ["account_type"] },
        "derived-from-inputs",
      ),
      tokenCandidate(4, { kind: "result", stepId: "derive", path: ["mcc"] }, "derived-from-inputs"),
    ],
    baseline: {
      inputs: [{ stepId: "report", argument: "command", reference: "private:report-command" }],
      observed: [{ stepId: "report", reference: "private:report-output" }],
    },
  };
  return plan;
}

async function validate(plan: RecordedWorkflow, store: InMemoryPrivateValueStore) {
  return await createLocalWorkflowValidator({
    workspaceId: owner,
    privateValues: store,
    workspaceDir: workspace("resin-derive-replay-"),
    timeoutMs: 20_000,
  })(plan);
}

function verdictsByPath(answer: Awaited<ReturnType<typeof validate>>): Record<string, boolean> {
  return Object.fromEntries(
    answer.verdicts.map((verdict) => [String(verdict.candidate.path[1]), verdict.confirmed]),
  );
}

describe("derivation bindings confirmed by a baseline replay", { timeout: 60_000 }, () => {
  it("confirms a lookup derivation, and the promoted tool computes another merchant's values", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recording(store, LOOKUP);
    expect(validateRecordedWorkflow(plan).errors).toEqual([]);
    // No recorded value is carried by the plan the cloud sees.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("Crossfit_Hanna");
    expect(serialized).not.toContain("1426");

    const answer = await validate(plan, store);
    expect(answer.verification?.status).toBe("verified");
    expect(verdictsByPath(answer)).toEqual({ "2": true, "3": true, "4": true });

    const accepted = (plan.candidates ?? []).filter((candidate) =>
      answer.verdicts.some(
        (verdict) =>
          verdict.confirmed &&
          verdict.candidate.path[1] === candidate.path[1] &&
          verdict.candidate.stepId === candidate.stepId,
      ),
    );
    const promoted = applyAcceptedBindings(plan, accepted);
    expect(validateRecordedWorkflow(promoted).errors).toEqual([]);
    const consumerDir = workspace("resin-derive-consumer-");
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: consumerDir }));
    adapters.register(createProgramAdapter({ cwd: consumerDir }));
    const tool = instantiateRecordedWorkflow(compileRecordedWorkflow(promoted), {
      adapters,
      access: { workspaceId: owner },
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
    });
    const other = await tool.invoke({ merchant: "Golfclub_Baron_Friso" });
    expect(other.status, other.error).toBe("completed");
    expect(JSON.stringify(other.result)).toContain("Golfclub_Baron_Friso G 2017");
    const recorded = await tool.invoke({ merchant: "Crossfit_Hanna" });
    expect(JSON.stringify(recorded.result)).toContain("Crossfit_Hanna C 1426");
  });

  it("refutes a derivation that hard-codes a recorded value", async () => {
    const store = new InMemoryPrivateValueStore();
    const hardCoded = `${NAME}{"account_type": "C", "mcc": code}\n`;
    const answer = await validate(recording(store, hardCoded), store);
    // The whole derivation is refuted, including the binding it computes honestly.
    expect(verdictsByPath(answer)).toMatchObject({ "3": false, "4": false });
  });

  it("refutes a derived value that does not reproduce the recorded token", async () => {
    const store = new InMemoryPrivateValueStore();
    const wrong = `${NAME}{"account_type": name[0].lower(), "mcc": code + 1}\n`;
    const answer = await validate(recording(store, wrong), store);
    expect(verdictsByPath(answer)).toMatchObject({ "3": false, "4": false });
  });

  it("accepts only the derived values that reproduce, from a step that ran", async () => {
    const store = new InMemoryPrivateValueStore();
    const partly = `${NAME}{"account_type": name[0], "mcc": code + 1}\n`;
    const answer = await validate(recording(store, partly), store);
    expect(verdictsByPath(answer)).toEqual({ "2": true, "3": true, "4": false });
    expect(answer.verification?.status).toBe("verified");
  });

  it("refutes a derivation that reads no caller input", async () => {
    const store = new InMemoryPrivateValueStore();
    const answer = await validate(recording(store, LOOKUP, false), store);
    expect(verdictsByPath(answer)).toMatchObject({ "3": false, "4": false });
  });
});

/** A derivation step reading the named inputs, with the header literal of each bound to its input. */
function derivationReading(names: readonly string[], body: string): WorkflowStep {
  const source = derivationHeader(names.map((name) => ({ name, value: "" }))) + body;
  const indexes = derivationInputTokenIndexes(source, names);
  const step = derivation(body, false);
  step.callable.program = { ...step.callable.program!, source };
  step.arguments = [
    {
      name: "code",
      source: {
        kind: "template",
        template: {
          type: "program",
          language: "python",
          source: { type: "literal", value: source },
          holes: names.map((name, index) => ({
            token: indexes[index]!,
            binding: { type: "input" as const, name },
          })),
        },
      },
    },
  ];
  return step;
}

/** One recorded report step (its command and output kept locally) after a derivation. */
function reportPlan(
  store: InMemoryPrivateValueStore,
  params: {
    command: string;
    printed: string;
    derive: WorkflowStep;
    inputs: RecordedWorkflow["inputs"];
    candidates: WorkflowBindingCandidate[];
  },
): RecordedWorkflow {
  store.set("private:report-command", params.command, { workspaceId: owner });
  store.set("private:report-output", params.printed, { workspaceId: owner });
  const plan = recording(new InMemoryPrivateValueStore(), LOOKUP);
  return {
    ...plan,
    inputs: params.inputs,
    steps: [params.derive, plan.steps[1]!],
    candidates: params.candidates,
  };
}

function atPath(
  path: WorkflowBindingCandidate["path"],
  proposed: WorkflowBindingCandidate["proposed"],
  reason: WorkflowBindingCandidate["reason"],
): WorkflowBindingCandidate {
  return { ...tokenCandidate(0, proposed, reason), path };
}

function verdictsByFullPath(answer: Awaited<ReturnType<typeof validate>>): Record<string, boolean> {
  return Object.fromEntries(
    answer.verdicts.map((verdict) => [
      verdict.candidate.path.slice(1).join("."),
      verdict.confirmed,
    ]),
  );
}

/** The report runs Python whose literals are the merchant and its looked-up values. */
const EMBEDDED_COMMAND = `python3 -c "print('Crossfit_Hanna', 'C', 1426)"`;

/** The embedded literal addresses of the merchant, account type and category code. */
function embeddedAddresses(): { anchor: number; merchant: number; type: number; mcc: number } {
  const [program] = embeddedPrograms(EMBEDDED_COMMAND);
  const index = (text: string): number => {
    const found = program!.tokens.findIndex(
      (token) => EMBEDDED_COMMAND.slice(token.start, token.end) === text,
    );
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
  };
  return {
    anchor: program!.anchor,
    merchant: index("'Crossfit_Hanna'"),
    type: index("'C'"),
    mcc: index("1426"),
  };
}

function embeddedMerchantPlan(store: InMemoryPrivateValueStore): RecordedWorkflow {
  const at = embeddedAddresses();
  const embedded = (token: number): WorkflowBindingCandidate["path"] => [
    "tokens",
    at.anchor,
    "embedded",
    token,
  ];
  return reportPlan(store, {
    command: EMBEDDED_COMMAND,
    printed: "Crossfit_Hanna C 1426\n",
    derive: derivationReading(["merchant"], LOOKUP),
    inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
    candidates: [
      atPath(
        embedded(at.merchant),
        { kind: "input", name: "merchant", type: "string", recordedDefault: true },
        "classified-source-value",
      ),
      atPath(
        embedded(at.type),
        { kind: "result", stepId: "derive", path: ["account_type"] },
        "derived-from-inputs",
      ),
      atPath(
        embedded(at.mcc),
        { kind: "result", stepId: "derive", path: ["mcc"] },
        "derived-from-inputs",
      ),
    ],
  });
}

/** The published tool of a validated plan: its confirmed bindings applied. */
function publish(
  plan: RecordedWorkflow,
  answer: Awaited<ReturnType<typeof validate>>,
  store: InMemoryPrivateValueStore,
) {
  const accepted = (plan.candidates ?? []).filter((candidate) =>
    answer.verdicts.some(
      (verdict) =>
        verdict.confirmed &&
        JSON.stringify(verdict.candidate.path) === JSON.stringify(candidate.path) &&
        verdict.candidate.stepId === candidate.stepId,
    ),
  );
  const promoted = applyAcceptedBindings(plan, accepted);
  expect(validateRecordedWorkflow(promoted).errors).toEqual([]);
  const consumerDir = workspace("resin-derive-consumer-");
  const adapters = new RuntimeAdapterRegistry();
  adapters.register(createProcessAdapter({ cwd: consumerDir }));
  adapters.register(createProgramAdapter({ cwd: consumerDir }));
  return instantiateRecordedWorkflow(compileRecordedWorkflow(promoted), {
    adapters,
    access: { workspaceId: owner },
    resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
  });
}

/** A report whose command names the lookup table (a caller-selected input) and the merchant. */
const TABLE_COMMAND = "printf '%s %s %s %s\\n' merchants.json Crossfit_Hanna C 1426";
const TABLE_LOOKUP = `assert inputs["table"].endswith(".json")\n${LOOKUP}`;

function tablePlan(store: InMemoryPrivateValueStore, body: string): RecordedWorkflow {
  return reportPlan(store, {
    command: TABLE_COMMAND,
    printed: "merchants.json Crossfit_Hanna C 1426\n",
    derive: derivationReading(["table", "merchant"], body),
    // The table is a required input the cloud selected; only a plan candidate says where it is.
    inputs: [
      { name: "table", type: "string" },
      { name: "merchant", type: "string", recordedDefault: true },
    ],
    candidates: [
      tokenCandidate(
        2,
        { kind: "input", name: "table", type: "string" },
        "classified-source-value",
      ),
      tokenCandidate(
        3,
        { kind: "input", name: "merchant", type: "string", recordedDefault: true },
        "classified-source-value",
      ),
      tokenCandidate(
        4,
        { kind: "result", stepId: "derive", path: ["account_type"] },
        "derived-from-inputs",
      ),
      tokenCandidate(5, { kind: "result", stepId: "derive", path: ["mcc"] }, "derived-from-inputs"),
    ],
  });
}

describe("derivation inputs established by one recording", { timeout: 60_000 }, () => {
  it("confirms a derivation reading a recorded-default input seen only inside embedded code", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = embeddedMerchantPlan(store);
    expect(validateRecordedWorkflow(plan).errors).toEqual([]);
    const at = embeddedAddresses();
    const answer = await validate(plan, store);
    expect(answer.verification?.status).toBe("verified");
    expect(verdictsByFullPath(answer)).toEqual({
      [`${at.anchor}.embedded.${at.merchant}`]: true,
      [`${at.anchor}.embedded.${at.type}`]: true,
      [`${at.anchor}.embedded.${at.mcc}`]: true,
    });
  });

  it("runs a published derivation on the recorded merchant when the caller omits it", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = embeddedMerchantPlan(store);
    const tool = publish(plan, await validate(plan, store), store);
    const recorded = await tool.invoke({});
    expect(recorded.status, recorded.error).toBe("completed");
    expect(JSON.stringify(recorded.result)).toContain("Crossfit_Hanna C 1426");
    const other = await tool.invoke({ merchant: "Golfclub_Baron_Friso" });
    expect(other.status, other.error).toBe("completed");
    expect(JSON.stringify(other.result)).toContain("Golfclub_Baron_Friso G 2017");
  });

  it("decides a derivation reading a required input whose position only a plan candidate names", async () => {
    const store = new InMemoryPrivateValueStore();
    const answer = await validate(tablePlan(store, TABLE_LOOKUP), store);
    expect(answer.verification?.status).toBe("verified");
    expect(verdictsByPath(answer)).toMatchObject({ "3": true, "4": true, "5": true });
  });

  it("keeps a plan's confirmed inputs when its derivation is refuted", async () => {
    const store = new InMemoryPrivateValueStore();
    const wrong = `assert inputs["table"].endswith(".json")\n${NAME}{"account_type": name[0].lower(), "mcc": code + 1}\n`;
    const answer = await validate(tablePlan(store, wrong), store);
    expect(answer.verification?.status).toBe("verified");
    expect(verdictsByPath(answer)).toMatchObject({ "3": true, "4": false, "5": false });
  });
});
