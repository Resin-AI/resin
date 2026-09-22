import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowObservedComparison,
  type WorkflowValueTemplate,
  tokenizeProgram,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CandidateValidationEnvironment,
  validateBindingCandidates,
} from "../../src/workflow/binding-validation.js";
import {
  confirmPromotedPlan,
  demonstrationEnvironment,
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
function projectedTransformAdapters(
  projection: "trailing" | "significant" | "nonstring",
): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: TEST_RUNTIME,
    async call(request) {
      const { arguments: args, step } = request;
      switch (step.callable.name) {
        case "derive":
          return { token: `tok(${String(args.seed ?? "")})` };
        case "consume": {
          const text = String(args.text ?? "");
          if (projection === "trailing") return ` \t${text}\t\n`;
          if (projection === "significant") return `${text}\nextra`;
          return { text };
        }
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
  observedComparisons?: Record<string, WorkflowObservedComparison>;
  adapters?: RuntimeAdapterRegistry;
}): Promise<CandidateValidationEnvironment> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "resin-replay-"));
  workspaces.push(workspaceDir);
  return {
    adapters: options.adapters ?? transformAdapters(),
    workspaceDir,
    inputs: options.inputs,
    observed: options.observed,
    ...(options.observedComparisons === undefined
      ? {}
      : { observedComparisons: options.observedComparisons }),
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
  it("keeps exact results by default and limits whitespace projection to strings", async () => {
    const candidate = tracksEarlierResult();
    const plan = recordedPlan({ type: "literal", value: "frozen" });
    const observed = { consume: "tok(replay-seed)" };

    const exact = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        adapters: projectedTransformAdapters("trailing"),
        inputs: { seed: "replay-seed" },
        observed,
      }),
    });
    expect(exact[0]?.accepted).toBe(false);

    const projected = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        adapters: projectedTransformAdapters("trailing"),
        inputs: { seed: "replay-seed" },
        observed,
        observedComparisons: { consume: "text-trim" },
      }),
    });
    expect(projected[0]?.accepted).toBe(true);

    const significant = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        adapters: projectedTransformAdapters("significant"),
        inputs: { seed: "replay-seed" },
        observed,
        observedComparisons: { consume: "text-trim" },
      }),
    });
    expect(significant[0]?.accepted).toBe(false);

    const nonstring = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        adapters: projectedTransformAdapters("nonstring"),
        inputs: { seed: "replay-seed" },
        observed: { consume: { text: "tok(replay-seed)" } },
        observedComparisons: { consume: "text-trim" },
      }),
    });
    expect(nonstring[0]?.accepted).toBe(false);

    const expectedTrailing = await validateBindingCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentOf({
        adapters: projectedTransformAdapters("trailing"),
        inputs: { seed: "replay-seed" },
        observed: { consume: "tok(replay-seed) " },
        observedComparisons: { consume: "text-trim" },
      }),
    });
    expect(expectedTrailing[0]?.accepted).toBe(false);
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

describe("selected demonstration comparison projections", () => {
  it("uses the held-out result projection during whole-plan replay", async () => {
    const plan: RecordedWorkflow = {
      ...recordedPlan({ type: "literal", value: "tok(replay-seed)" }),
      privateReferences: ["private:derive-observed", "private:consume-observed"],
      heldOut: {
        inputs: [],
        observed: [
          { stepId: "derive", reference: "private:derive-observed" },
          {
            stepId: "consume",
            reference: "private:consume-observed",
            comparison: "text-trim",
          },
        ],
      },
    };
    const workspaceDir = await mkdtemp(join(tmpdir(), "resin-heldout-projection-"));
    workspaces.push(workspaceDir);
    const environment = await demonstrationEnvironment({
      plan,
      candidates: [],
      adapters: projectedTransformAdapters("trailing"),
      workspaceDir,
      resolvePrivate: (reference) => {
        if (reference === "private:derive-observed") return { token: "tok(replay-seed)" };
        if (reference === "private:consume-observed") return "tok(replay-seed)";
        throw new Error(`unexpected reference '${reference}'`);
      },
    });
    if (environment === undefined) throw new Error("missing replay environment");
    environment.inputs.seed = "replay-seed";
    const confirmed = await confirmPromotedPlan({ plan, accepted: [], environment });
    expect(confirmed.verification.status).toBe("verified");
    expect(confirmed.verification.reproduced).toEqual(["derive", "consume"]);
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
            {
              name: "text",
              source: { kind: "template", template: { type: "literal", value: "tok(alpha)" } },
            },
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
            {
              name: "text",
              source: { kind: "template", template: { type: "literal", value: "tok(alpha)" } },
            },
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

/**
 * A recorded program whose text was written with a value inside it.
 *
 * The program is the job's own step, so it is recorded whole: only the text is local, and the token
 * the earlier result produced is a position inside it. These tests pin that the replay binds that
 * position and nothing else.
 */
const PROGRAM_RUNTIME = "program";

/** The recorded job: name the release the earlier step returned in a file, and nothing else. */
const RECORDED_PROGRAM =
  "printf '%s\\n' 'tok(recorded-seed)' > release.txt && printf '%s\\n' 'keep-me' >> release.txt";

/** A host that runs a program by reading the two values the program names, in order. */
function programAdapters(seen: string[]): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: TEST_RUNTIME,
    async call(request) {
      return { token: `tok(${String(request.arguments.seed ?? "")})` };
    },
  });
  registry.register({
    runtime: PROGRAM_RUNTIME,
    async call(request) {
      const command = String(request.arguments.command ?? "");
      seen.push(command);
      // Every single-quoted value the program names, in order, so a rendering that changed one of
      // them or moved another is visible in the result.
      return { named: [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]) };
    },
  });
  return registry;
}

function programPlan(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-program-token",
    inputs: [{ name: "seed", type: "string" }],
    privateReferences: ["private:recorded-program"],
    steps: [
      {
        id: "open",
        callId: "call-open",
        callable: { runtime: TEST_RUNTIME, name: "open" },
        arguments: [{ name: "seed", source: { kind: "input", name: "seed" } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "seal",
        callId: "call-seal",
        callable: {
          runtime: PROGRAM_RUNTIME,
          name: "sh",
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: [
          { name: "command", source: { kind: "private", reference: "private:recorded-program" } },
        ],
        dependsOn: ["open"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

function embeddedTokenCandidate(): WorkflowBindingCandidate {
  const tokens = tokenizeProgram("shell", RECORDED_PROGRAM);
  const token = tokens.findIndex((entry) => entry.value === "tok(recorded-seed)");
  if (token < 0) throw new Error("the recorded program does not carry the expected token");
  return {
    stepId: "seal",
    argument: "command",
    path: ["tokens", token],
    proposed: { kind: "result", stepId: "open", path: ["token"] },
    reason: "equal-to-earlier-result",
    missing: "the record does not establish that this token's origin is that result",
  };
}

describe("a value embedded in a recorded program", () => {
  it("binds the token the earlier result produced and replays the program with the replay's value", async () => {
    const seen: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "resin-program-token-"));
    workspaces.push(directory);
    const outcomes = await validateBindingCandidates({
      plan: programPlan(),
      candidates: [embeddedTokenCandidate()],
      environment: {
        adapters: programAdapters(seen),
        workspaceDir: directory,
        inputs: { seed: "replay-seed" },
        observed: {
          seal: { named: ["%s\\n", "tok(replay-seed)", "%s\\n", "keep-me"] },
        },
        resolvePrivate: (reference) =>
          reference === "private:recorded-program" ? RECORDED_PROGRAM : null,
      },
    });

    const [outcome] = outcomes;
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toContain("seal.command");
    // The bound replay rendered the replay's value into the recorded token and left the rest of the
    // program exactly as it was; the run with the candidate reverted is the recorded text.
    const boundRun = seen.find((command) => command.includes("tok(replay-seed)"));
    expect(boundRun).toBeDefined();
    expect(boundRun).toContain("'keep-me'");
    expect(boundRun).toContain("release.txt");
    expect(seen.some((command) => command.includes("'tok(recorded-seed)'"))).toBe(true);
  });

  it("refuses a token position the recorded program does not have", async () => {
    const candidate = { ...embeddedTokenCandidate(), path: ["tokens", 999] };
    const outcomes = await validateBindingCandidates({
      plan: programPlan(),
      candidates: [candidate],
      environment: {
        adapters: programAdapters([]),
        workspaceDir: await mkdtemp(join(tmpdir(), "resin-program-token-miss-")).then(
          (directory) => {
            workspaces.push(directory);
            return directory;
          },
        ),
        inputs: { seed: "replay-seed" },
        observed: {
          seal: { named: ["%s\\n", "tok(replay-seed)", "%s\\n", "keep-me"] },
        },
        resolvePrivate: () => RECORDED_PROGRAM,
      },
    });

    // The binding is placed (the replay renders token 999 into the program), so the run fails where
    // the program is rendered rather than being silently replayed with the recorded text. Either way
    // the proposal is never accepted on evidence that does not exist.
    expect(outcomes[0]?.accepted).toBe(false);
  });
});

/**
 * A program whose recorded text was written with one token the two executions disagreed about.
 *
 * The token is a position inside the program, so the value a replay must bind is the token's own
 * value read out of the demonstration's text — the same index, the other execution's program. These
 * tests pin that the demonstration supplies exactly that value, that the plan a caller receives
 * declares it at that token, and that a token the demonstration has no value for is refused rather
 * than guessed at.
 */
const REPEAT_PROGRAM =
  "printf '%s\\n' 'tok(bravo-seed)' > release.txt && printf '%s\\n' 'keep-me' >> release.txt";

/** The recording, with the demonstration its own repeat offered: another run, on another seed. */
function demonstratedProgramPlan(): RecordedWorkflow {
  const plan = programPlan();
  plan.heldOut = {
    inputs: [{ stepId: "seal", argument: "command", reference: "private:demonstration:command" }],
    observed: [{ stepId: "seal", reference: "private:demonstration:result" }],
  };
  plan.privateReferences = [
    ...(plan.privateReferences ?? []),
    "private:demonstration:command",
    "private:demonstration:result",
  ];
  return plan;
}

/** The recording's own references, resolved by the host that kept those values. */
function demonstrationResolver(reference: string): WorkflowJsonValue {
  if (reference === "private:recorded-program") return RECORDED_PROGRAM;
  if (reference === "private:demonstration:command") return REPEAT_PROGRAM;
  if (reference === "private:demonstration:result") {
    return { named: ["%s\\n", "tok(bravo-seed)", "%s\\n", "keep-me"] };
  }
  throw new Error(`unexpected reference '${reference}'`);
}

describe("a token of a recorded program a caller may supply", () => {
  const tokenCandidate: WorkflowBindingCandidate = {
    stepId: "seal",
    argument: "command",
    path: ["tokens", 2],
    proposed: { kind: "input", name: "sh_command_2", type: "string" },
    reason: "varies-across-executions",
    missing:
      "no execution used a value the record had never seen, so the record does not establish that a caller supplies this token",
  };

  /** The environment the recording's demonstration supplies, plus the work's own input. */
  async function environmentFor(
    plan: RecordedWorkflow,
    candidate: WorkflowBindingCandidate,
    seen: string[],
  ): Promise<CandidateValidationEnvironment> {
    const directory = await mkdtemp(join(tmpdir(), "resin-program-input-"));
    workspaces.push(directory);
    const environment = await demonstrationEnvironment({
      plan,
      candidates: [candidate],
      adapters: programAdapters(seen),
      workspaceDir: directory,
      resolvePrivate: demonstrationResolver,
    });
    if (environment === undefined) throw new Error("the plan carries no demonstration");
    // The demonstration supplies what the recording only suggests; the work's own inputs are the
    // caller's and are handed to the replay as they are.
    environment.inputs.seed = "replay-seed";
    return environment;
  }

  it("binds the token to the demonstration's own value, and declares it at that token", async () => {
    // The candidate names the same token in both texts: the recorded one holds the recording's seed,
    // the demonstration's holds the value the replay never used.
    expect(tokenizeProgram("shell", RECORDED_PROGRAM)[2]!.value).toBe("tok(recorded-seed)");
    expect(tokenizeProgram("shell", REPEAT_PROGRAM)[2]!.value).toBe("tok(bravo-seed)");

    const seen: string[] = [];
    const plan = demonstratedProgramPlan();
    const decided = await validateAndConfirmCandidates({
      plan,
      candidates: [tokenCandidate],
      environment: await environmentFor(plan, tokenCandidate, seen),
    });

    const [outcome] = decided.outcomes;
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toContain("seal.command");

    // The plan a caller receives declares the input and carries it at the token it was proposed for.
    expect(decided.plan.inputs).toContainEqual({ name: "sh_command_2", type: "string" });
    const argument = decided.plan.steps[1]!.arguments[0]!;
    const template = argument.source.kind === "template" ? argument.source.template : undefined;
    expect(template).toMatchObject({
      type: "program",
      language: "shell",
      holes: [{ token: 2, binding: { type: "input", name: "sh_command_2" } }],
    });

    // The bound run rendered the demonstration's value into that token and left the rest of the
    // program as recorded; the run with the candidate reverted is the recorded text.
    const bound = seen.find((command) => command.includes("tok(bravo-seed)"));
    expect(bound).toBeDefined();
    expect(bound).toContain("'keep-me'");
    expect(bound).toContain("release.txt");
    expect(seen.some((command) => command.includes("'tok(recorded-seed)'"))).toBe(true);
    // The demonstration observed only the program step, so the plan reproduces that step but is not
    // a whole-plan verification: the step it never observed is named instead of being assumed.
    expect(decided.verification).toMatchObject({
      status: "incomplete",
      reproduced: ["seal"],
      missed: [{ stepId: "open" }],
    });
  });

  it("refuses it when the demonstration's program has no such token", async () => {
    // The missing fact: the demonstration ran a program with no token at that index, so nothing
    // shows what a caller's value there would produce. The candidate is refused for want of a
    // value rather than replayed against a guess.
    const plan = demonstratedProgramPlan();
    const candidate: WorkflowBindingCandidate = { ...tokenCandidate, path: ["tokens", 999] };
    const decided = await validateAndConfirmCandidates({
      plan,
      candidates: [candidate],
      environment: await environmentFor(plan, candidate, []),
    });

    expect(decided.outcomes[0]!.accepted).toBe(false);
    expect(decided.outcomes[0]!.reason).toContain("supplied no value for input 'sh_command_2'");
  });
});
