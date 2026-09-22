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

it("preserves an optional fresh-process replay proof and validates its plan digest", () => {
  const verified = decision(undefined);
  verified.verification = {
    ...verified.verification!,
    replay: { kind: "fresh-process", planDigest: "c".repeat(64) },
  };
  expect(WorkflowValidationDecisionSchema.safeParse(verified).success).toBe(true);
  expect(
    WorkflowValidationDecisionSchema.safeParse({
      ...verified,
      verification: {
        ...verified.verification,
        replay: { kind: "fresh-process", planDigest: "not-a-digest" },
      },
    }).success,
  ).toBe(false);
});
