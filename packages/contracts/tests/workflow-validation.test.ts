import { expect, it } from "vitest";
import {
  type WorkflowProgramIdentity,
  type WorkflowValidationDecision,
  WorkflowValidationDecisionSchema,
  workflowValidationDecisionDigest,
} from "../src/workflow-validation.js";

const identity = {
  stepId: "run",
  argument: "payload",
  path: ["commands", 1],
  templateDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
};

function decision(programIdentities?: WorkflowProgramIdentity[]): WorkflowValidationDecision {
  return {
    schemaVersion: 2,
    requestId: "request-1",
    attempt: "attempt-1",
    planDigest: "plan-digest",
    evidenceDigest: "evidence-digest",
    environment: "environment-1",
    verdicts: [],
    verification: {
      status: "verified",
      reproduced: ["run"],
      missed: [],
      dropped: [],
      ...(programIdentities === undefined ? {} : { programIdentities }),
    },
    accepted: [],
    decidedAt: "2026-01-01T00:00:00.000Z",
  };
}

it("accepts hash-only program identities while retaining conservative absence", () => {
  expect(WorkflowValidationDecisionSchema.safeParse(decision([identity])).success).toBe(true);
  expect(WorkflowValidationDecisionSchema.safeParse(decision(undefined)).success).toBe(true);
});

it("keeps a word-list proposal's shape, which is part of the candidate it reports on", () => {
  const candidate = {
    stepId: "step4",
    argument: "cmd",
    path: ["tokens", 3, "through", 5],
    proposed: {
      kind: "input" as const,
      name: "labels",
      type: "array" as const,
      list: { minItems: 1 as const, optionItems: true as const },
    },
  };
  const { proposed: _proposed, ...position } = candidate;
  const parsed = WorkflowValidationDecisionSchema.parse({
    ...decision(),
    verdicts: [{ candidate, confirmed: true, confirmedType: "array" }],
    accepted: [position],
  });
  expect(parsed.verdicts[0]!.candidate).toEqual(candidate);
});

it("carries an input form only as a relative directory below the working directory", () => {
  const candidate = {
    stepId: "build",
    argument: "command",
    path: ["tokens", 2],
    proposed: { kind: "input" as const, name: "service", type: "string" as const },
  };
  const withForm = (form: unknown) =>
    WorkflowValidationDecisionSchema.safeParse({
      ...decision(),
      verdicts: [{ candidate, confirmed: true, form }],
      accepted: [{ stepId: "build", argument: "command", path: ["tokens", 2] }],
    });
  const kept = withForm({ value: "name", directory: "services", entry: "directory" });
  expect(kept.success && kept.data.verdicts[0]!.form).toEqual({
    value: "name",
    directory: "services",
    entry: "directory",
  });
  expect(withForm({ value: "path", directory: "data/sources" }).success).toBe(true);
  for (const directory of ["../services", "/home/user/services", "a/../b", "", "a b", "a//b"]) {
    expect(withForm({ value: "name", directory }).success).toBe(false);
  }
  expect(withForm({ value: "path", directory: "." }).success).toBe(false);
  expect(withForm({ value: "name", directory: "services", values: ["billing"] }).success).toBe(
    false,
  );
});

it("rejects non-SHA256 identity fields", () => {
  expect(
    WorkflowValidationDecisionSchema.safeParse(
      decision([{ ...identity, sourceDigest: "not-a-digest" }]),
    ).success,
  ).toBe(false);
});

it("binds program identity proofs into the existing decision digest", () => {
  const original = decision([identity]);
  const changed = decision([{ ...identity, sourceDigest: "c".repeat(64) }]);
  expect(workflowValidationDecisionDigest(original)).not.toBe(
    workflowValidationDecisionDigest(changed),
  );
  expect(workflowValidationDecisionDigest(original)).not.toBe(
    workflowValidationDecisionDigest(decision(undefined)),
  );
});

it("accepts only digest-bound recording proofs", () => {
  const verified = decision(undefined);
  verified.verification = {
    ...verified.verification!,
    replay: { kind: "recording", planDigest: "c".repeat(64) },
  };
  expect(WorkflowValidationDecisionSchema.safeParse(verified).success).toBe(true);
  for (const replay of [
    { kind: "recording", planDigest: "not-a-digest" },
    { kind: "fresh-process", planDigest: "c".repeat(64) },
    { kind: "host-replay", planDigest: "c".repeat(64) },
  ]) {
    expect(
      WorkflowValidationDecisionSchema.safeParse({
        ...verified,
        verification: { ...verified.verification, replay },
      }).success,
    ).toBe(false);
  }
});
