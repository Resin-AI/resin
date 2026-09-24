import {
  type RecordedWorkflow,
  type WorkflowJsonValue,
  type WorkflowValueTemplate,
  tokenizeProgram,
} from "@resin/contracts";
import { expect, it } from "vitest";
import {
  type CandidateValidationEnvironment,
  confirmPromotedPlan,
} from "../../src/workflow/binding-validation.js";
import { computeWorkflowProgramIdentities } from "../../src/workflow/program-identity.js";
import { RuntimeAdapterRegistry } from "../../src/workflow/recorded-workflow.js";

const hole = (token: number): { token: number; binding: WorkflowValueTemplate } => ({
  token,
  binding: { type: "literal", value: "alpha" },
});

function program(
  reference: string,
  _source: string,
  holes: Array<{ token: number; binding: WorkflowValueTemplate }>,
): WorkflowValueTemplate {
  return {
    type: "program",
    language: "shell",
    source: { type: "private", reference },
    holes,
  };
}

function numericProgram(reference: string, source: string, binding: number): WorkflowValueTemplate {
  const token = tokenizeProgram("javascript", source).findIndex((entry) => entry.kind === "number");
  if (token < 0) throw new Error("test program has no numeric token");
  return {
    type: "program",
    language: "javascript",
    source: { type: "private", reference },
    holes: [{ token, binding: { type: "literal", value: binding } }],
  };
}

function projectedProgram(
  reference: string,
  holes: Array<{ token: number; binding: WorkflowValueTemplate }>,
): WorkflowValueTemplate {
  return {
    type: "program",
    language: "javascript",
    source: { type: "literal", value: 'const secret = "REDACTED"; console.log("alpha");' },
    sourceReference: reference,
    protectedTokens: [1],
    holes,
  };
}
function workflow(
  template: WorkflowValueTemplate,
  privateReferences: string[] = [],
): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-program-identity",
    inputs: [],
    privateReferences,
    steps: [
      {
        id: "run",
        callId: "call-run",
        callable: { runtime: "identity-test", name: "run" },
        arguments: [{ name: "payload", source: { kind: "template", template } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

function resolveSources(sources: Record<string, string>) {
  return (reference: string): string => {
    const source = sources[reference];
    if (source === undefined) throw new Error(`unknown source ${reference}`);
    return source;
  };
}

it("converges only hole text while retaining code, private-reference, and workspace boundaries", async () => {
  const alpha = await computeWorkflowProgramIdentities({
    plan: workflow(program("private-alpha", "printf '/recorded/alpha'", [hole(1)])),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({ "private-alpha": "printf '/recorded/alpha'" }),
  });
  const beta = await computeWorkflowProgramIdentities({
    plan: workflow(program("private-beta", "printf '/recorded/beta'", [hole(1)])),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({ "private-beta": "printf '/recorded/beta'" }),
  });
  const changedCode = await computeWorkflowProgramIdentities({
    plan: workflow(program("private-code", "printf '/recorded/alpha' && printf stable", [hole(1)])),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({
      "private-code": "printf '/recorded/alpha' && printf stable",
    }),
  });
  const otherWorkspace = await computeWorkflowProgramIdentities({
    plan: workflow(program("private-alpha", "printf '/recorded/alpha'", [hole(1)])),
    workspaceId: "workspace-b",
    resolvePrivate: resolveSources({ "private-alpha": "printf '/recorded/alpha'" }),
  });

  expect(alpha).toHaveLength(1);
  expect(beta).toHaveLength(1);
  expect(alpha[0]!.sourceDigest).toBe(beta[0]!.sourceDigest);
  expect(alpha[0]!.templateDigest).not.toBe(beta[0]!.templateDigest);
  expect(changedCode[0]!.sourceDigest).not.toBe(alpha[0]!.sourceDigest);
  expect(otherWorkspace[0]!.sourceDigest).not.toBe(alpha[0]!.sourceDigest);
  expect(alpha[0]!.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(alpha[0]!.templateDigest).toMatch(/^[a-f0-9]{64}$/);

  const serialized = JSON.stringify(alpha);
  expect(serialized).not.toContain("/recorded/alpha");
  expect(serialized).not.toContain("private-alpha");
  expect(serialized).not.toContain("__resin_program_hole_");
});

it("finds executable templates at runtime-value paths and never invents identities for unapplied or dynamic holes", async () => {
  const nested = await computeWorkflowProgramIdentities({
    plan: workflow({
      type: "object",
      entries: {
        metadata: { type: "literal", value: "unchanged" },
        commands: {
          type: "array",
          items: [
            { type: "literal", value: "before" },
            program("nested-source", "printf nested", [hole(1)]),
          ],
        },
      },
    }),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({ "nested-source": "printf nested" }),
  });
  expect(nested).toHaveLength(1);
  expect(nested[0]!.path).toEqual(["commands", 1]);

  const unapplied = await computeWorkflowProgramIdentities({
    plan: workflow(program("unapplied-source", "printf never-attested", [])),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({ "unapplied-source": "printf never-attested" }),
  });
  const dynamicSource = await computeWorkflowProgramIdentities({
    plan: workflow({
      type: "program",
      language: "shell",
      source: { type: "input", name: "source" },
      holes: [hole(1)],
    }),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({}),
  });

  expect(unapplied).toEqual([]);
  expect(dynamicSource).toEqual([]);
});

it("propagates private resolver failures instead of turning them into equivalence", async () => {
  await expect(
    computeWorkflowProgramIdentities({
      plan: workflow(program("private-failure", "printf failure", [hole(1)])),
      workspaceId: "workspace-a",
      resolvePrivate: () => {
        throw new Error("resolver failed");
      },
    }),
  ).rejects.toThrow("resolver failed");
});

it("propagates malformed applied-hole positions instead of suppressing a proof", async () => {
  await expect(
    computeWorkflowProgramIdentities({
      plan: workflow(program("private-malformed", "printf failure", [hole(99)])),
      workspaceId: "workspace-a",
      resolvePrivate: resolveSources({ "private-malformed": "printf failure" }),
    }),
  ).rejects.toThrow("no token 99");
});

it("bases projected identities on the locally resolved original source", async () => {
  const first = await computeWorkflowProgramIdentities({
    plan: workflow(projectedProgram("private-projected-a", [hole(4)]), ["private-projected-a"]),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({
      "private-projected-a": 'const secret = "original-secret-a"; console.log("alpha");',
    }),
  });
  const second = await computeWorkflowProgramIdentities({
    plan: workflow(projectedProgram("private-projected-b", [hole(4)]), ["private-projected-b"]),
    workspaceId: "workspace-a",
    resolvePrivate: resolveSources({
      "private-projected-b": 'const secret = "original-secret-b"; console.log("alpha");',
    }),
  });
  const missing = await computeWorkflowProgramIdentities({
    plan: workflow(projectedProgram("private-projected-missing", [hole(4)]), [
      "private-projected-missing",
    ]),
  });
  const nonString = await computeWorkflowProgramIdentities({
    plan: workflow(projectedProgram("private-projected-non-string", [hole(4)]), [
      "private-projected-non-string",
    ]),
    resolvePrivate: () => ({ text: "not program text" }),
  });

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]!.sourceDigest).not.toBe(second[0]!.sourceDigest);
  expect(missing).toEqual([]);
  expect(nonString).toEqual([]);
  expect(JSON.stringify([first, second])).not.toContain("original-secret");
});

it("normalizes numeric holes with type-compatible identity values", async () => {
  const firstSource = 'const amount = 1; const label = "stable";';
  const secondSource = 'const amount = 987; const label = "stable";';
  const changedNonHoleSource = 'const amount = 987; const label = "changed";';

  const first = await computeWorkflowProgramIdentities({
    plan: workflow(numericProgram("private-numeric", firstSource, 1), ["private-numeric"]),
    resolvePrivate: () => firstSource,
  });
  const second = await computeWorkflowProgramIdentities({
    plan: workflow(numericProgram("private-numeric", secondSource, 987), ["private-numeric"]),
    resolvePrivate: () => secondSource,
  });
  const changedNonHole = await computeWorkflowProgramIdentities({
    plan: workflow(numericProgram("private-numeric", changedNonHoleSource, 987), [
      "private-numeric",
    ]),
    resolvePrivate: () => changedNonHoleSource,
  });

  expect(first[0]!.sourceDigest).toBe(second[0]!.sourceDigest);
  expect(second[0]!.sourceDigest).not.toBe(changedNonHole[0]!.sourceDigest);
});

function executablePlan(): RecordedWorkflow {
  const plan = workflow({
    type: "program",
    language: "shell",
    source: { type: "private", reference: "private-executable" },
    holes: [{ token: 1, binding: { type: "literal", value: "alpha" } }],
  });
  plan.steps[0]!.callable = {
    runtime: "identity-test",
    name: "run",
    program: { kind: "shell", source: "", argument: "payload" },
  };
  return plan;
}

function executableEnvironment(observed: WorkflowJsonValue): CandidateValidationEnvironment {
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({
    runtime: "identity-test",
    async call(request) {
      return { received: request.arguments.payload ?? null };
    },
  });
  return {
    adapters,
    workspaceId: "workspace-a",
    workspaceDir: "/tmp/resin-program-identity-test",
    inputs: {},
    observed: { run: observed },
    resolvePrivate: () => "printf alpha",
  };
}

it("attaches identities only after the final whole-plan replay is verified", async () => {
  const verified = await confirmPromotedPlan({
    plan: executablePlan(),
    accepted: [],
    environment: executableEnvironment({ received: "printf alpha" }),
  });
  expect(verified.verification.status).toBe("verified");
  expect(verified.verification.programIdentities).toHaveLength(1);
  const incomplete = await confirmPromotedPlan({
    plan: executablePlan(),
    accepted: [],
    environment: executableEnvironment({ received: "not-the-recorded-result" }),
  });
  expect(incomplete.verification.status).toBe("incomplete");
  expect(incomplete.verification.programIdentities).toBeUndefined();
});
