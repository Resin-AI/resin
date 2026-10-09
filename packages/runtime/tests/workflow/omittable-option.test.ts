import { spawnSync } from "node:child_process";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  validateRecordedWorkflow,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { applyConfirmedWorkflowBinding } from "../../src/workflow/candidate-promotion.js";
import {
  OMITTED_OPTION_NOTE,
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
  recordedWorkflowInputSchema,
} from "../../src/workflow/recorded-workflow.js";

// Tokens: gh(0) pr(1) merge(2) 18(3) --squash(4) --subject(5) "Add parser (#18)"(6) --delete-branch(7)
const MERGE = 'gh pr merge 18 --squash --subject "Add parser (#18)" --delete-branch';

function recorded(
  command = MERGE,
  demonstration?: { label: "heldOut" | "baseline"; command: string },
) {
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "wf-merge",
    inputs: [],
    privateReferences: demonstration === undefined ? [] : ["private:demo:cmd", "private:demo:run"],
    steps: [
      {
        id: "merge",
        callId: "call-merge",
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
  if (demonstration !== undefined) {
    plan[demonstration.label] = {
      inputs: [{ stepId: "merge", argument: "cmd", reference: "private:demo:cmd" }],
      observed: [{ stepId: "merge", reference: "private:demo:run" }],
    };
  }
  return plan;
}

function candidate(path: WorkflowBindingCandidate["path"]): WorkflowBindingCandidate {
  return {
    stepId: "merge",
    argument: "cmd",
    path,
    proposed: { kind: "input", name: "subject", type: "string", omitOptionWhenAbsent: true },
    reason: "varies-across-executions",
    missing: "one recording does not establish that this value varies",
  };
}

const SUBJECT = candidate(["tokens", 6]);

/** What `sh` hands `gh`: each argument it received, one per `<…>`. */
function run(command: string): { stdout: string; exitCode: number | null } {
  const result = spawnSync("sh", ["-c", `gh() { printf '<%s>' "$@"; }; ${command}`], {
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
  const plan = applyConfirmedWorkflowBinding(recorded(), SUBJECT);
  if (plan === undefined) throw new Error("omittable option candidate refused");
  return plan;
}

describe("an omittable option at runtime", () => {
  it("promotes the value into an optional input whose hole names its option word", () => {
    const plan = promoted();
    expect(plan.inputs).toEqual([{ name: "subject", type: "string", omitOptionWhenAbsent: true }]);
    const source = plan.steps[0]!.arguments[0]!.source;
    expect(
      source.kind === "template" && source.template.type === "program" && source.template.holes,
    ).toEqual([{ token: 6, option: 5, binding: { type: "input", name: "subject" } }]);
    expect(validateRecordedWorkflow(plan).errors).toEqual([]);
  });

  it("runs the command with the caller's subject, and without --subject when it is omitted", async () => {
    const received: string[] = [];
    const adapters = shellAdapters(received);
    const supplied = await executeRecordedWorkflow(promoted(), {
      inputs: { subject: "Release 2.0: $(id) `x`" },
      adapters,
    });
    expect(supplied.status).toBe("completed");
    expect(supplied.result).toEqual({
      stdout: "<pr><merge><18><--squash><--subject><Release 2.0: $(id) `x`><--delete-branch>",
      exitCode: 0,
    });
    const omitted = await executeRecordedWorkflow(promoted(), { inputs: {}, adapters });
    expect(omitted.status).toBe("completed");
    expect(received[1]).toBe("gh pr merge 18 --squash --delete-branch");
    expect(omitted.result).toEqual({
      stdout: "<pr><merge><18><--squash><--delete-branch>",
      exitCode: 0,
    });
  });

  it("removes an attached option and a field value the same way", async () => {
    const attached = 'gh release create v1 --notes="First cut" --draft';
    const field = "gh api repos/o/r/pulls -f title=Draft -f base=main";
    const notes = applyConfirmedWorkflowBinding(
      recorded(attached),
      candidate(["tokens", 4, "span", 8, 17]),
    );
    const title = applyConfirmedWorkflowBinding(
      recorded(field),
      candidate(["tokens", 4, "span", 6, 11]),
    );
    expect(notes).toBeDefined();
    expect(title).toBeDefined();
    const received: string[] = [];
    const adapters = shellAdapters(received);
    const outputs = [];
    for (const [plan, inputs] of [
      [notes!, { subject: "Second cut" }],
      [notes!, {}],
      [title!, { subject: "Ready" }],
      [title!, {}],
    ] as const) {
      outputs.push((await executeRecordedWorkflow(plan, { inputs, adapters })).result);
    }
    expect(outputs).toEqual([
      { stdout: "<release><create><v1><--notes=Second cut><--draft>", exitCode: 0 },
      { stdout: "<release><create><v1><--draft>", exitCode: 0 },
      { stdout: "<api><repos/o/r/pulls><-f><title=Ready><-f><base=main>", exitCode: 0 },
      { stdout: "<api><repos/o/r/pulls><-f><base=main>", exitCode: 0 },
    ]);
  });

  it("refuses to promote a value that is not an omittable option site", () => {
    expect(
      applyConfirmedWorkflowBinding(
        recorded("git commit -m first file.txt"),
        candidate(["tokens", 3]),
      ),
    ).toBeUndefined();
    expect(applyConfirmedWorkflowBinding(recorded(), candidate(["tokens", 3]))).toBeUndefined();
  });

  it("fails the step, running nothing, when the recorded text no longer holds the option", async () => {
    const plan = promoted();
    const source = plan.steps[0]!.arguments[0]!.source;
    if (source.kind !== "template" || source.template.type !== "program") throw new Error("shape");
    source.template.holes[0] = { ...source.template.holes[0]!, option: 4 };
    const received: string[] = [];
    const execution = await executeRecordedWorkflow(plan, {
      inputs: {},
      adapters: shellAdapters(received),
    });
    expect(execution.status).toBe("failed");
    expect(execution.error).toMatch(/cannot be removed/);
    expect(received).toEqual([]);
  });

  it("describes the input to callers as optional", () => {
    expect(recordedWorkflowInputSchema(promoted())).toEqual({
      type: "object",
      properties: { subject: { type: "string", description: OMITTED_OPTION_NOTE } },
      required: [],
      additionalProperties: false,
    });
  });
});

describe("checking an omittable option against a demonstration", () => {
  const resolver =
    (command: string) =>
    (reference: string): WorkflowJsonValue => {
      if (reference === "private:demo:cmd") return command;
      if (reference === "private:demo:run") return run(command);
      throw new Error(`unexpected reference '${reference}'`);
    };

  async function check(
    plan: RecordedWorkflow,
    command: string,
    candidates: WorkflowBindingCandidate[],
  ) {
    const received: string[] = [];
    const adapters = shellAdapters(received);
    const environment = await demonstrationEnvironment({
      plan,
      candidates,
      ...(plan.baseline === undefined ? {} : { demonstration: "baseline" as const }),
      adapters: () => adapters,
      resolvePrivate: resolver(command),
    });
    const decided = await validateAndConfirmCandidates({
      plan,
      candidates,
      environment: environment!,
    });
    return { environment: environment!, decided, received };
  }

  it("confirms the proposal from a held-out merge with another subject", async () => {
    const other = 'gh pr merge 21 --squash --subject "Fix lexer (#21)" --delete-branch';
    const plan = recorded(MERGE, { label: "heldOut", command: other });
    // The pull request number is a plain input proposal beside it.
    const number: WorkflowBindingCandidate = {
      ...SUBJECT,
      path: ["tokens", 3],
      proposed: { kind: "input", name: "number", type: "string" },
    };
    const { environment, decided } = await check(plan, other, [SUBJECT, number]);
    expect(environment.inputs).toEqual({ subject: "Fix lexer (#21)", number: "21" });
    expect(decided.outcomes.map((outcome) => outcome.accepted)).toEqual([true, true]);
    expect(decided.verification?.status).toBe("verified");
    expect(decided.plan.inputs).toContainEqual({
      name: "subject",
      type: "string",
      omitOptionWhenAbsent: true,
    });
  });

  it("verifies a plan that binds it with the recorded value, and one whose held-out run left the option out", async () => {
    const applied = promoted();
    // The plan's own recording: the value it ran is bound at the hole.
    const baseline = {
      ...applied,
      baseline: recorded(MERGE, { label: "baseline", command: MERGE }).baseline,
    };
    baseline.privateReferences = ["private:demo:cmd", "private:demo:run"];
    const own = await check(baseline, MERGE, []);
    expect(own.environment.inputs).toEqual({ subject: "Add parser (#18)" });
    expect(own.decided.verification?.status).toBe("verified");
    expect(own.received).toEqual([MERGE]);

    // A held-out merge that used gh's default subject: the input stays omitted, and the replay
    // without --subject is what that run ran.
    const without = "gh pr merge 18 --squash --delete-branch";
    const heldOut = {
      ...applied,
      heldOut: recorded(MERGE, { label: "heldOut", command: without }).heldOut,
    };
    heldOut.privateReferences = ["private:demo:cmd", "private:demo:run"];
    const omitted = await check(heldOut, without, []);
    expect(omitted.environment.inputs).toEqual({});
    expect(omitted.decided.verification?.status).toBe("verified");
    expect(omitted.received).toEqual([without]);
  });
});
