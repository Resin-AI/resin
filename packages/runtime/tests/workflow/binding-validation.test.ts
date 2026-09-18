import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RecordedWorkflow,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
  WorkflowValueTemplate,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CandidateValidationEnvironment,
  validateBindingCandidates,
} from "../../src/workflow/binding-validation.js";
import {
  confirmPromotedPlan,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { RuntimeAdapterRegistry } from "../../src/workflow/recorded-workflow.js";

const TEST_RUNTIME = "test-transform";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * The two tools the recording calls: `derive` turns the caller's seed into a token, `consume` acts
 * on the text it is handed. Both are deterministic, so a replay's outcome depends only on what the
 * plan bound.
 */
function transformAdapters(): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: TEST_RUNTIME,
    async call(request) {
      const { arguments: args, step } = request;
      switch (step.callable.name) {
        case "derive":
          return { token: `tok(${String(args.seed ?? "")})` };
        case "consume":
          return { echoed: args.text ?? null };
        default:
          throw new Error(`unexpected callable '${step.callable.name}'`);
      }
    },
  });
  return registry;
}

/**
 * The recording as it stands: `consume` was observed acting on text, and the record froze that text
 * as the literal it saw, because nothing in the recording showed the text moving with the earlier
 * result.
 */
function recordedPlan(frozenText: WorkflowValueTemplate): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-binding-validation",
    inputs: [{ name: "seed", type: "string" }],
    steps: [
      {
        id: "derive",
        callId: "call-derive",
        callable: { runtime: TEST_RUNTIME, name: "derive" },
        arguments: [{ name: "seed", source: { kind: "input", name: "seed" } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "consume",
        callId: "call-consume",
        callable: { runtime: TEST_RUNTIME, name: "consume" },
        arguments: [{ name: "text", source: { kind: "template", template: frozenText } }],
        dependsOn: ["derive"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

/** The candidate the capture proposes: the text was really the token the earlier step returned. */
function tracksEarlierResult(): WorkflowBindingCandidate {
  return {
    stepId: "consume",
    argument: "text",
    path: [],
    proposed: { kind: "result", stepId: "derive", path: ["token"] },
    reason: "tracks-earlier-result-across-executions",
    missing: "the recording never showed the text moving with the earlier result",
  };
}

async function environmentOf(options: {
  inputs: Record<string, WorkflowJsonValue>;
  observed: Record<string, WorkflowJsonValue>;
  adapters?: RuntimeAdapterRegistry;
}): Promise<CandidateValidationEnvironment> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "resin-replay-"));
  workspaces.push(workspaceDir);
  return {
    adapters: options.adapters ?? transformAdapters(),
    workspaceDir,
    inputs: options.inputs,
    observed: options.observed,
    timeoutMs: 10_000,
  };
}

describe("binding candidate validation by replay", () => {
  it("accepts a candidate that tracks the earlier result where the recorded text cannot", async () => {
    const outcomes = await validateBindingCandidates({
      plan: recordedPlan({ type: "literal", value: "tok(recorded-seed)" }),
      candidates: [tracksEarlierResult()],
      environment: await environmentOf({
        inputs: { seed: "replay-seed" },
        observed: { consume: { echoed: "tok(replay-seed)" } },
      }),
    });

    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toContain("consume.text[]");
    expect(outcome.reason).toContain("reproduced the held-out result");
    expect(outcome.reason).toContain("recorded value did not");
  });

  it("refuses a value that merely happened to equal the earlier result", async () => {
    const outcomes = await validateBindingCandidates({
      plan: recordedPlan({ type: "literal", value: "tok(recorded-seed)" }),
      candidates: [tracksEarlierResult()],
      environment: await environmentOf({
        // This replay ran with the seed the recording saw, so the literal reproduces the held-out
        // observation as well: nothing here shows that the text came from the earlier result.
        inputs: { seed: "recorded-seed" },
        observed: { consume: { echoed: "tok(recorded-seed)" } },
      }),
    });

    const [outcome] = outcomes;
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toContain("does not establish the dependency");
    expect(outcome.reason).toContain("never showed the text moving with the earlier result");
  });

  it("refuses a candidate whose path does not address a template leaf", async () => {
    const outcomes = await validateBindingCandidates({
      plan: recordedPlan({
        type: "object",
        entries: {
          query: { type: "literal", value: "frozen-query" },
          options: { type: "object", entries: { limit: { type: "literal", value: 5 } } },
        },
      }),
      candidates: [
        { ...tracksEarlierResult(), path: ["token"] },
        { ...tracksEarlierResult(), path: ["options"] },
      ],
      environment: await environmentOf({
        inputs: { seed: "replay-seed" },
        observed: { consume: { echoed: null } },
      }),
    });

    expect(outcomes).toHaveLength(2);
    const [missingPath, structuralPath] = outcomes;
    expect(missingPath.accepted).toBe(false);
    expect(missingPath.reason).toContain("does not address a template leaf");
    expect(missingPath.reason).toContain('consume.text["token"]');
    expect(structuralPath.accepted).toBe(false);
    expect(structuralPath.reason).toContain("does not address a template leaf");
    expect(structuralPath.reason).toContain('consume.text["options"]');
  });

  it("promotes an input candidate and refuses it when the replay cannot supply that input", async () => {
    const plan = recordedPlan({ type: "literal", value: "frozen-greeting" });
    const candidate: WorkflowBindingCandidate = {
      stepId: "consume",
      argument: "text",
      path: [],
      proposed: { kind: "input", name: "greeting", type: "string" },
      reason: "varies-across-executions",
      missing: "the recording never showed which caller-supplied value reached the call",
    };

    const promoted = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        inputs: { seed: "replay-seed", greeting: "hello" },
        observed: { consume: { echoed: "hello" } },
      }),
    });
    const [accepted] = promoted;
    expect(accepted.accepted).toBe(true);

    const unsupplied = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        inputs: { seed: "replay-seed" },
        observed: { consume: { echoed: "hello" } },
      }),
    });
    const [refused] = unsupplied;
    expect(refused.accepted).toBe(false);
    // The bound plan addressed the proposed input, so the run failed on it rather than on the tool.
    expect(refused.reason).toContain("supplied no value for input 'greeting'");
  });

  it("reports each unusable candidate as a refusal instead of throwing", async () => {
    const outcomes = await validateBindingCandidates({
      plan: recordedPlan({ type: "literal", value: "tok(recorded-seed)" }),
      candidates: [
        tracksEarlierResult(),
        { ...tracksEarlierResult(), stepId: "absent" },
        { ...tracksEarlierResult(), stepId: "derive", argument: "absent" },
        { ...tracksEarlierResult(), stepId: "unobserved" },
      ],
      environment: await environmentOf({
        // Nothing can run here: the plan's runtime family has no adapter in this environment.
        adapters: new RuntimeAdapterRegistry(),
        inputs: { seed: "replay-seed" },
        observed: {
          consume: { echoed: "tok(replay-seed)" },
          absent: null,
          derive: { token: "tok(replay-seed)" },
        },
      }),
    });

    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) expect(outcome.accepted).toBe(false);
    const [unrunnable, unknownStep, unknownArgument, unobserved] = outcomes;
    expect(unrunnable.reason).toContain("no adapter for runtime");
    expect(unknownStep.reason).toContain("no step 'absent'");
    expect(unknownArgument.reason).toContain("no argument 'absent'");
    expect(unobserved.reason).toContain("observed no result for step 'unobserved'");
  });
});

describe("the plan that results from accepting proposals", () => {
  /** A plan whose second step reads the first one's token as a frozen literal. */
  function plan(): RecordedWorkflow {
    return recordedPlan({ type: "literal", value: "tok(alpha)" });
  }

  /** The demonstration: the same work, run on another seed, as the replay must see it. */
  async function environment(missedConsume = false) {
    const directory = await mkdtemp(join(tmpdir(), "resin-confirm-"));
    workspaces.push(directory);
    return {
      adapters: transformAdapters(),
      workspaceDir: directory,
      inputs: { seed: "bravo" },
      observed: {
        derive: { token: "tok(bravo)" },
        consume: missedConsume
          ? { echoed: "something no binding produces" }
          : { echoed: "tok(bravo)" },
      },
    };
  }

  const candidates: WorkflowBindingCandidate[] = [
    {
      stepId: "consume",
      argument: "text",
      path: [],
      proposed: { kind: "result", stepId: "derive", path: ["token"] },
      reason: "equal-to-earlier-result",
      missing: "the value appeared after that call returned",
    },
  ];

  it("keeps a proposal the combined plan reproduces", async () => {
    const confirmed = await confirmPromotedPlan({
      plan: plan(),
      accepted: candidates,
      environment: await environment(),
    });
    expect(confirmed.accepted).toEqual(candidates);
    expect(confirmed.dropped).toEqual([]);
    expect(confirmed.verification.status).toBe("verified");
    expect(confirmed.verification.missed).toEqual([]);
  });

  it("decides proposals and confirms the combined plan in one step", async () => {
    const decided = await validateAndConfirmCandidates({
      plan: plan(),
      candidates,
      environment: await environment(),
    });
    expect(decided.outcomes).toHaveLength(1);
    expect(decided.outcomes[0]!.accepted).toBe(true);
    expect(decided.verification?.status).toBe("verified");
  });

  it("withdraws a proposal when the plan it would publish cannot reproduce the work", async () => {
    const confirmed = await confirmPromotedPlan({
      plan: plan(),
      accepted: candidates,
      environment: await environment(true),
    });
    // The proposal was withdrawn rather than published on the strength of its own check alone.
    expect(confirmed.accepted).toEqual([]);
    expect(confirmed.dropped).toHaveLength(1);
    expect(confirmed.dropped[0]!.reason).toContain("consume");
    // A plan that was disproven says so, rather than being reported as verified on the strength of
    // the proposals that survived.
    expect(confirmed.verification.status).toBe("failed");
    // What is left is the recording, which is what the user actually ran.
    expect(confirmed.plan.steps[1]!.arguments[0]!.source).toEqual({
      kind: "template",
      template: { type: "literal", value: "tok(alpha)" },
    });
  });
});

describe("a plan is run once per attempt, as the work it is", () => {
  /** Every step invocation, in order, so a run can be told from a step. */
  function countingAdapters(invocations: string[]): RuntimeAdapterRegistry {
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      runtime: TEST_RUNTIME,
      async call(request) {
        invocations.push(request.step.id);
        const args = request.arguments;
        switch (request.step.callable.name) {
          case "derive":
            return { token: `tok(${String(args.seed ?? "")})` };
          case "consume":
            return { echoed: args.text ?? null };
          case "finish":
            return { finished: args.text ?? null };
          default:
            throw new Error(`unexpected callable '${request.step.callable.name}'`);
        }
      },
    });
    return registry;
  }

  /** derive -> consume -> finish, with the last two reading what the step before them produced. */
  function chainPlan(): RecordedWorkflow {
    return {
      schemaVersion: 1,
      workflowId: "wf-one-run",
      inputs: [{ name: "seed", type: "string" }],
      steps: [
        {
          id: "step0",
          callId: "call-0",
          callable: { runtime: TEST_RUNTIME, name: "derive" },
          arguments: [{ name: "seed", source: { kind: "input", name: "seed" } }],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
        {
          id: "step1",
          callId: "call-1",
          callable: { runtime: TEST_RUNTIME, name: "consume" },
          arguments: [
            { name: "text", source: { kind: "template", template: { type: "literal", value: "tok(alpha)" } } },
          ],
          dependsOn: ["step0"],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
        {
          id: "step2",
          callId: "call-2",
          callable: { runtime: TEST_RUNTIME, name: "finish" },
          arguments: [
            { name: "text", source: { kind: "template", template: { type: "literal", value: "tok(alpha)" } } },
          ],
          dependsOn: ["step1"],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
  }

  const binding: WorkflowBindingCandidate = {
    stepId: "step1",
    argument: "text",
    path: [],
    proposed: { kind: "result", stepId: "step0", path: ["token"] },
    reason: "equal-to-earlier-result",
    missing: "the value appeared after that call returned",
  };

  /** The second link of the chain reads what the first one produced. */
  const secondBinding: WorkflowBindingCandidate = {
    stepId: "step2",
    argument: "text",
    path: [],
    proposed: { kind: "result", stepId: "step1", path: ["echoed"] },
    reason: "equal-to-earlier-result",
    missing: "the value appeared after that call returned",
  };

  it("runs the whole plan once per attempt and compares every step against that one run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resin-one-run-"));
    workspaces.push(directory);
    const invocations: string[] = [];
    const confirmed = await confirmPromotedPlan({
      plan: chainPlan(),
      accepted: [binding, secondBinding],
      environment: {
        adapters: countingAdapters(invocations),
        workspaceDir: directory,
        inputs: { seed: "bravo" },
        observed: {
          step0: { token: "tok(bravo)" },
          step1: { echoed: "tok(bravo)" },
          step2: { finished: "tok(bravo)" },
        },
      },
    });

    expect(confirmed.verification.status).toBe("verified");
    // One run: every step of the work executed exactly once. Running it once per observed step
    // would show each of them three times.
    expect(invocations).toEqual(["step0", "step1", "step2"]);
  });

  it("keeps a valid proposal when a step no proposal decided does not reproduce", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resin-unblamed-"));
    workspaces.push(directory);
    const invocations: string[] = [];
    const decided = await validateAndConfirmCandidates({
      plan: chainPlan(),
      candidates: [binding],
      environment: {
        adapters: countingAdapters(invocations),
        workspaceDir: directory,
        inputs: { seed: "bravo" },
        observed: {
          step0: { token: "tok(bravo)" },
          step1: { echoed: "tok(bravo)" },
          // The last step was observed producing something no binding of this plan produces.
          step2: { finished: "unreachable" },
        },
      },
    });

    // The proposal is sound and stays: the miss is not something withdrawing it could fix.
    expect(decided.outcomes.find((outcome) => outcome.accepted)?.candidate).toEqual(binding);
    expect(decided.verification?.status).toBe("incomplete");
    // And the miss survives to the caller rather than being swallowed as a pass.
    expect(decided.verification?.missed.map((entry) => entry.stepId)).toEqual(["step2"]);
    expect(decided.verification?.reproduced.sort()).toEqual(["step0", "step1"]);
    expect(decided.verification?.dropped).toEqual([]);
  });
});
