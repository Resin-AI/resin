import { type RecordedWorkflow, validateRecordedWorkflow } from "@resin/contracts";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  type RecordedCallObservation,
  acceptInputProposals,
  proposeInputsFromVariation,
  recordCallsFromEvents,
  recordWorkflowRecipe,
} from "../../src/analytics/workflow-recipe.js";

function leaf(value: RecordedWorkflow["steps"][number]["arguments"][number]["source"]) {
  if (value.kind !== "template") throw new Error(`expected a template, got ${value.kind}`);
  return value.template;
}

/** Four calls that exist nowhere in the repository, with the origins the record establishes. */
function session(): RecordedCallObservation[] {
  return [
    {
      callId: "call_fetch",
      causalSequence: 1,
      callable: { runtime: "unfamiliar-protocol", name: "vendor.fetch", connection: "srv_9" },
      arguments: { source: "alpha", page: 2 },
      argumentOrigins: {
        source: { type: "input", name: "source" },
        page: { type: "literal", value: 2 },
      },
      argumentTypes: { source: "string", page: "number" },
      result: { body: { rows: [{ id: "row-7" }] } },
      observed: "succeeded",
      recordedFailureControl: "abort",
    },
    {
      callId: "call_transform",
      causalSequence: 2,
      callable: { runtime: "unfamiliar-program", name: "local-transform" },
      arguments: { request: { id: "row-7", options: { mode: "full" } } },
      argumentOrigins: {
        request: {
          type: "object",
          entries: {
            id: { type: "result", stepId: "step0", path: ["body", "rows", 0, "id"] },
            options: { type: "object", entries: { mode: { type: "literal", value: "full" } } },
          },
        },
      },
      result: { stdout: "ROW-7" },
      observed: "succeeded",
    },
    {
      callId: "call_write",
      causalSequence: 3,
      callable: { runtime: "unfamiliar-program", name: "local-write" },
      arguments: { content: "ROW-7", directory: "/tmp/out" },
      argumentOrigins: {
        content: { type: "result", stepId: "step1", path: ["stdout"] },
        directory: { type: "input", name: "target" },
      },
      argumentTypes: { directory: "string" },
      result: { path: "/tmp/out/report.txt" },
      observed: "succeeded",
    },
    {
      callId: "call_upload",
      causalSequence: 4,
      callable: { runtime: "unfamiliar-protocol", name: "vendor.upload", connection: "srv_9" },
      arguments: {
        envelope: { file: "/tmp/out/report.txt", auth: "Bearer ghp_secret_value" },
        note: "plain",
      },
      argumentOrigins: {
        envelope: {
          type: "object",
          entries: {
            file: { type: "result", stepId: "step2", path: ["path"] },
            auth: { type: "literal", value: "Bearer ghp_secret_value" },
          },
        },
        note: { type: "literal", value: "plain" },
      },
      isPrivateValue: (value) => value.includes("ghp_secret_value"),
      result: { uploaded: true },
      observed: "succeeded",
    },
  ];
}

describe("workflow recipe recording", () => {
  it("keeps recorded origins, nested leaves included, and declares typed inputs", () => {
    const recipe = recordWorkflowRecipe("wf_unfamiliar", session())!;
    const [fetch, transform, write] = recipe.workflow.steps;

    expect(leaf(fetch!.arguments[0]!.source)).toEqual({ type: "input", name: "source" });
    expect(leaf(fetch!.arguments[1]!.source)).toEqual({ type: "literal", value: 2 });

    // A recursively constructed argument keeps each leaf's own origin.
    expect(leaf(transform!.arguments[0]!.source)).toEqual({
      type: "object",
      entries: {
        id: { type: "result", stepId: "step0", path: ["body", "rows", 0, "id"] },
        options: { type: "object", entries: { mode: { type: "literal", value: "full" } } },
      },
    });
    expect(transform!.dependsOn).toEqual(["step0"]);
    expect(leaf(write!.arguments[0]!.source)).toEqual({
      type: "result",
      stepId: "step1",
      path: ["stdout"],
    });

    // Inputs are captured, with the types the record shows rather than "string" for everything.
    expect(recipe.workflow.inputs).toEqual([
      { name: "source", type: "string" },
      { name: "target", type: "string" },
    ]);
  });

  it("keeps a secret inside a larger string or a nested object as a private leaf", () => {
    const recipe = recordWorkflowRecipe("wf_unfamiliar", session())!;
    const upload = recipe.workflow.steps[3]!;
    const envelope = leaf(upload.arguments[0]!.source);
    expect(envelope).toMatchObject({
      type: "object",
      entries: { file: { type: "result", stepId: "step2", path: ["path"] } },
    });
    const auth = (envelope as { entries: Record<string, { type: string; reference?: string }> })
      .entries.auth!;
    expect(auth.type).toBe("private");
    expect(recipe.privateValues.get(auth.reference!)).toBe("Bearer ghp_secret_value");
    // The call is recorded, not discarded, and no private text reaches the workflow.
    expect(recipe.skipped).toEqual([]);
    expect(JSON.stringify(recipe.workflow)).not.toContain("ghp_secret_value");
  });

  it("preserves an argument whose origin the record does not establish as unresolved", () => {
    const unknownOrigin = session();
    unknownOrigin[1]!.argumentOrigins = {};
    const recipe = recordWorkflowRecipe("wf_unknown", unknownOrigin)!;
    const transform = recipe.workflow.steps[1]!;
    // Not a guessed dependency, and not a frozen value either.
    expect(leaf(transform.arguments[0]!.source)).toMatchObject({ type: "object" });
    expect(JSON.stringify(leaf(transform.arguments[0]!.source))).toContain("unresolved");
    expect(transform.dependsOn).toEqual([]);
  });

  it("separates recorded control flow from the observed outcome", () => {
    const failed = session();
    failed[1]!.observed = "failed";
    const recipe = recordWorkflowRecipe("wf_failure", failed)!;
    const transform = recipe.workflow.steps[1]!;
    expect(transform.observed).toEqual({ outcome: "failed" });
    // The record did not say how failure was handled, so the choice is labelled as policy.
    expect(transform.failurePolicy).toEqual({ onError: "abort", policy: "default" });

    const recorded = session();
    recorded[1]!.observed = "failed";
    recorded[1]!.recordedFailureControl = "continue";
    const recordedRecipe = recordWorkflowRecipe("wf_failure_recorded", recorded)!;
    expect(recordedRecipe.workflow.steps[1]!.failurePolicy).toEqual({
      onError: "continue",
      policy: "recorded",
    });
  });

  it("applies a later privacy classification to values captured earlier", () => {
    const late: RecordedCallObservation[] = [
      {
        callId: "call_early",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-echo" },
        // Recorded as a plain literal: nothing marked it private at this point.
        arguments: { text: "tok_late_999" },
        argumentOrigins: { text: { type: "literal", value: "tok_late_999" } },
        result: { ok: true },
        observed: "succeeded",
      },
      {
        callId: "call_later",
        causalSequence: 2,
        callable: { runtime: "unfamiliar-program", name: "local-check" },
        arguments: { probe: "tok_late_999" },
        argumentOrigins: { probe: { type: "literal", value: "tok_late_999" } },
        // Only this later call's processing classifies the value as private.
        isPrivateValue: (value) => value.includes("tok_late_999"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];

    const recipe = recordWorkflowRecipe("wf_late_private", late)!;
    // The earlier step no longer carries it as a literal.
    const early = recipe.workflow.steps[0]!;
    const earlyTemplate = leaf(early.arguments[0]!.source);
    expect(earlyTemplate.type).toBe("private");
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_late_999");
    expect([...recipe.privateValues.values()]).toContain("tok_late_999");
  });

  it("keeps a binding even when the value it names is private", () => {
    const bound: RecordedCallObservation[] = [
      {
        callId: "call_source",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-read" },
        arguments: { path: "in.txt" },
        argumentOrigins: { path: { type: "literal", value: "in.txt" } },
        result: { secret: "tok_bound_1" },
        observed: "succeeded",
      },
      {
        callId: "call_uses",
        causalSequence: 2,
        callable: { runtime: "unfamiliar-program", name: "local-send" },
        arguments: { token: "tok_bound_1" },
        // The record establishes where it came from, and it is private.
        argumentOrigins: { token: { type: "result", stepId: "step0", path: ["secret"] } },
        isPrivateValue: (value) => value.includes("tok_bound_1"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];
    const recipe = recordWorkflowRecipe("wf_bound_private", bound)!;
    const send = recipe.workflow.steps[1]!;
    // The connection survives privacy: still the earlier result, resolved fresh at execution time.
    expect(leaf(send.arguments[0]!.source)).toEqual({
      type: "result",
      stepId: "step0",
      path: ["secret"],
    });
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_bound_1");
  });

  it("applies privacy inside a literal object and array, recursively", () => {
    const nestedLiteral: RecordedCallObservation[] = [
      {
        callId: "call_literal_composite",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-call" },
        arguments: { payload: { auth: { tokens: ["plain", "tok_inner_7"] } } },
        argumentOrigins: {
          payload: { type: "literal", value: { auth: { tokens: ["plain", "tok_inner_7"] } } },
        },
        isPrivateValue: (value) => value.includes("tok_inner_7"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];
    const recipe = recordWorkflowRecipe("wf_literal_composite", nestedLiteral)!;
    const payload = leaf(recipe.workflow.steps[0]!.arguments[0]!.source) as {
      type: string;
      entries: { auth: { entries: { tokens: { type: string; items: Array<{ type: string }> } } } };
    };
    expect(payload.type).toBe("object");
    expect(payload.entries.auth.entries.tokens.type).toBe("array");
    expect(payload.entries.auth.entries.tokens.items).toEqual([
      { type: "literal", value: "plain" },
      { type: "private", reference: expect.any(String) },
    ]);
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_inner_7");
    expect([...recipe.privateValues.values()]).toContain("tok_inner_7");
  });

  it("keeps a program's text and its holes, and depends on the step a hole reads", () => {
    const programRun: RecordedCallObservation[] = [
      {
        callId: "call_mint",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.mint", connection: "srv_9" },
        arguments: { seed: "alpha" },
        argumentOrigins: { seed: { type: "literal", value: "alpha" } },
        result: { id: "alpha-7f3c" },
        observed: "succeeded",
      },
      {
        callId: "call_run",
        causalSequence: 2,
        callable: {
          runtime: "unfamiliar-process",
          name: "bash",
          // The record says this call ran a program, and which argument held its text.
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: { command: "printf '%s\\n' 'alpha-7f3c' > f" },
        argumentOrigins: {
          command: {
            type: "program",
            language: "shell",
            // The text is the user's own work, so it stays local behind a reference.
            source: { type: "private", reference: "private:wf_program:0" },
            // The token a value the replay confirmed is rendered into.
            holes: [{ token: 2, binding: { type: "result", stepId: "step0", path: ["id"] } }],
          },
        },
        result: { stdout: "" },
        observed: "succeeded",
      },
    ];
    const recipe = recordWorkflowRecipe("wf_program", programRun, [
      {
        stepId: "step1",
        argument: "command",
        path: ["tokens", 2],
        proposed: { kind: "result", stepId: "step0", path: ["id"] },
        reason: "equal-to-earlier-result",
        evidence: { tokens: 5, token: 2, producers: 1 },
        missing: "the record does not show this token was rendered from its result",
      },
    ])!;
    const run = recipe.workflow.steps[1]!;

    // The program survives whole: its language, the text it resolves, and the token a bound value
    // is rendered into are all still there.
    expect(leaf(run.arguments[0]!.source)).toEqual({
      type: "program",
      language: "shell",
      source: { type: "private", reference: "private:wf_program:0" },
      holes: [{ token: 2, binding: { type: "result", stepId: "step0", path: ["id"] } }],
    });
    // A hole that reads a step makes that step a dependency of the program's step.
    expect(run.dependsOn).toEqual(["step0"]);
    // The candidate addresses the token of the program the step's own record holds.
    expect(recipe.workflow.candidates![0]!.path).toEqual(["tokens", 2]);
  });

  it("redacts a private literal inside a program, wherever the program sits", () => {
    const programRun: RecordedCallObservation[] = [
      {
        callId: "call_run",
        causalSequence: 1,
        callable: {
          runtime: "unfamiliar-process",
          name: "bash",
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: { command: "printf '%s\\n' 'ghp_secret_value' > f" },
        argumentOrigins: {
          command: {
            type: "program",
            language: "shell",
            source: { type: "literal", value: "printf '%s\\n' 'ghp_secret_value' > f" },
            holes: [{ token: 2, binding: { type: "literal", value: "ghp_secret_value" } }],
          },
        },
        isPrivateValue: (value) => value.includes("ghp_secret_value"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];
    const recipe = recordWorkflowRecipe("wf_program_private", programRun, [
      {
        stepId: "step0",
        argument: "command",
        path: ["tokens", 2],
        proposed: { kind: "result", stepId: "step0", path: ["ok"] },
        reason: "equal-to-earlier-result",
        evidence: { tokens: 5, token: 2, producers: 1 },
        missing: "the record does not show this token was rendered from its result",
      },
    ])!;
    const program = leaf(recipe.workflow.steps[0]!.arguments[0]!.source) as {
      type: string;
      source: { type: string; reference?: string };
      holes: Array<{ token: number; binding: { type: string; reference?: string } }>;
    };

    expect(program.type).toBe("program");
    // The text and the value a hole renders are both leaves of the plan, so both are replaced by a
    // local reference rather than carried.
    expect(program.source.type).toBe("private");
    expect(recipe.privateValues.get(program.source.reference!)).toBe(
      "printf '%s\\n' 'ghp_secret_value' > f",
    );
    expect(program.holes[0]!.token).toBe(2);
    expect(program.holes[0]!.binding.type).toBe("private");
    expect(recipe.privateValues.get(program.holes[0]!.binding.reference!)).toBe("ghp_secret_value");
    expect(JSON.stringify(recipe.workflow)).not.toContain("ghp_secret_value");
    // Both references are declared, so the plan is structurally sound as well as silent.
    expect(validateRecordedWorkflow(recipe.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("proposes inputs from variation without changing the executable workflow", () => {
    const demonstration = (source: string, retries: number): RecordedCallObservation[] => [
      {
        callId: `call_${source}`,
        causalSequence: 1,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.fetch" },
        arguments: { source, retries, mode: "full" },
        argumentOrigins: {
          source: { type: "literal", value: source },
          retries: { type: "literal", value: retries },
          mode: { type: "literal", value: "full" },
        },
        result: { body: { text: `text-${source}` } },
        observed: "succeeded",
      },
    ];

    const first = recordWorkflowRecipe("wf_variation", demonstration("alpha", 1))!;
    const second = recordWorkflowRecipe("wf_variation", demonstration("beta", 5))!;
    const proposalSet = proposeInputsFromVariation([first, second])!;

    // The workflow is exactly as recorded until a proposal is accepted.
    expect(proposalSet.workflow.inputs).toEqual([]);
    expect(leaf(proposalSet.workflow.steps[0]!.arguments[0]!.source)).toEqual({
      type: "literal",
      value: "alpha",
    });
    expect(proposalSet.proposals).toEqual([
      { name: "step0_source", from: "step0.source", type: "string", seenValues: ["alpha", "beta"] },
      { name: "step0_retries", from: "step0.retries", type: "number", seenValues: [1, 5] },
    ]);

    // Accepting is deliberate and is the only step that changes the executable workflow.
    const accepted = acceptInputProposals(proposalSet.workflow, proposalSet.proposals);
    expect(leaf(accepted.steps[0]!.arguments[0]!.source)).toEqual({
      type: "input",
      name: "step0_source",
    });
    expect(accepted.inputs).toEqual([
      { name: "step0_source", type: "string" },
      { name: "step0_retries", type: "number" },
    ]);
    // A constant that never varied is not proposed.
    expect(proposalSet.proposals.map((proposal) => proposal.name)).not.toContain("step0_mode");
  });

  it("never proposes replacing an established binding", () => {
    const demonstration = (source: string): RecordedCallObservation[] => [
      {
        callId: `call_source_${source}`,
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-read" },
        arguments: { path: source },
        argumentOrigins: { path: { type: "literal", value: source } },
        result: { id: `row-${source}` },
        observed: "succeeded",
      },
      {
        callId: `call_use_${source}`,
        causalSequence: 2,
        callable: { runtime: "unfamiliar-program", name: "local-send" },
        arguments: { id: `row-${source}` },
        argumentOrigins: { id: { type: "result", stepId: "step0", path: ["id"] } },
        result: { ok: true },
        observed: "succeeded",
      },
    ];

    const proposalSet = proposeInputsFromVariation([
      recordWorkflowRecipe("wf_binding", demonstration("alpha"))!,
      recordWorkflowRecipe("wf_binding", demonstration("beta"))!,
    ])!;

    // The changing intermediate stays a dependency: nothing about it is proposed.
    expect(proposalSet.proposals.map((proposal) => proposal.from)).toEqual(["step0.path"]);
    const accepted = acceptInputProposals(proposalSet.workflow, proposalSet.proposals);
    expect(leaf(accepted.steps[1]!.arguments[0]!.source)).toEqual({
      type: "result",
      stepId: "step0",
      path: ["id"],
    });
  });

  it("records a workflow from captured events, pairing results by call identity", () => {
    const events = [
      {
        type: "tool_call",
        eventId: "evt_1",
        sessionId: "sess",
        causalRef: { causalSequence: 1 },
        toolName: "vendor_search",
        callId: "call_1",
        parameters: { query: "alpha" },
      },
      {
        type: "tool_result",
        eventId: "evt_2",
        sessionId: "sess",
        causalRef: { causalSequence: 2 },
        callId: "call_1",
        result: { hits: [{ id: "row-9" }] },
      },
      {
        type: "tool_call",
        eventId: "evt_3",
        sessionId: "sess",
        causalRef: { causalSequence: 3 },
        toolName: "vendor_store",
        callId: "call_2",
        parameters: { id: "row-9" },
      },
      {
        type: "tool_result",
        eventId: "evt_4",
        sessionId: "sess",
        causalRef: { causalSequence: 4 },
        callId: "call_2",
        result: { stored: true },
      },
    ];

    const recipe = recordCallsFromEvents("wf_captured", events)!;
    expect(recipe.workflow.steps.map((step) => step.callable.name)).toEqual([
      "vendor_search",
      "vendor_store",
    ]);
    // The result is attached to the call it answers, but having a result is not success: the record
    // reported no outcome, so the observed outcome is unknown. The argument's origin stays
    // unresolved too — the record does not say where "row-9" came from.
    expect(recipe.workflow.steps[1]!.observed).toEqual({ outcome: "unknown" });
    expect(leaf(recipe.workflow.steps[1]!.arguments[0]!.source)).toMatchObject({
      type: "unresolved",
    });
  });

  it("records the outcome the result reported, including failure", () => {
    const events = [
      {
        type: "tool_call",
        eventId: "evt_f1",
        sessionId: "sess",
        causalRef: { causalSequence: 1 },
        toolName: "vendor_check",
        callId: "call_ok",
        parameters: { id: "row-1" },
      },
      {
        type: "tool_result",
        eventId: "evt_f2",
        sessionId: "sess",
        causalRef: { causalSequence: 2 },
        callId: "call_ok",
        result: { ok: true },
        isError: false,
      },
      {
        type: "tool_call",
        eventId: "evt_f3",
        sessionId: "sess",
        causalRef: { causalSequence: 3 },
        toolName: "vendor_check",
        callId: "call_bad",
        parameters: { id: "row-2" },
      },
      {
        type: "tool_result",
        eventId: "evt_f4",
        sessionId: "sess",
        causalRef: { causalSequence: 4 },
        callId: "call_bad",
        result: { ok: false },
        isError: true,
      },
    ];
    const recipe = recordCallsFromEvents("wf_outcomes", events)!;
    expect(recipe.workflow.steps[0]!.observed).toEqual({ outcome: "succeeded" });
    expect(recipe.workflow.steps[1]!.observed).toEqual({ outcome: "failed" });
  });

  it("turns an observed reference into a recorded binding", () => {
    const events = [
      {
        type: "tool_call",
        eventId: "evt_r1",
        sessionId: "sess",
        causalRef: { causalSequence: 1 },
        toolName: "vendor_search",
        callId: "call_1",
        parameters: { query: "alpha" },
      },
      {
        type: "tool_result",
        eventId: "evt_r2",
        sessionId: "sess",
        causalRef: { causalSequence: 2 },
        callId: "call_1",
        result: { hits: [{ id: "row-9" }] },
        isError: false,
      },
      {
        type: "tool_call",
        eventId: "evt_r3",
        sessionId: "sess",
        causalRef: { causalSequence: 3 },
        toolName: "vendor_store",
        callId: "call_2",
        parameters: { id: "row-9" },
        // The calling program used the reference-aware interface: this is the connection the
        // plain-JSON recording never carried.
        metadata: {
          references: { id: { reference: "ref:wf_referenced:call_1", path: ["hits", 0, "id"] } },
        },
      },
      {
        type: "tool_result",
        eventId: "evt_r4",
        sessionId: "sess",
        causalRef: { causalSequence: 4 },
        callId: "call_2",
        result: { stored: true },
        isError: false,
      },
    ];

    const recipe = recordCallsFromEvents("wf_referenced", events)!;
    const store = recipe.workflow.steps[1]!;
    // The connection is recorded as the dependency it is, with the nested field it used.
    expect(leaf(store.arguments[0]!.source)).toEqual({
      type: "result",
      stepId: "step0",
      path: ["hits", 0, "id"],
    });
    expect(store.dependsOn).toEqual(["step0"]);
    // The recorded outcome is what the result reported.
    expect(recipe.workflow.steps[0]!.observed).toEqual({ outcome: "succeeded" });

    // A reference to a call this recording never observed stays unestablished.
    const withUnknown = events.map((event) =>
      event.eventId === "evt_r3"
        ? {
            ...event,
            metadata: {
              references: {
                id: { reference: "ref:sess:call_never_seen", path: ["hits", 0, "id"] },
              },
            },
          }
        : event,
    );
    const unresolvedRecipe = recordCallsFromEvents("wf_referenced_unknown", withUnknown)!;
    expect(
      JSON.stringify(leaf(unresolvedRecipe.workflow.steps[1]!.arguments[0]!.source)),
    ).toContain("unresolved");
  });

  it("never binds a reference from another scope that reuses a local call id", () => {
    const events = [
      {
        type: "tool_call",
        eventId: "evt_s1",
        sessionId: "sess",
        causalRef: { causalSequence: 1 },
        toolName: "vendor_search",
        callId: "call_1",
        parameters: { query: "alpha" },
      },
      {
        type: "tool_result",
        eventId: "evt_s2",
        sessionId: "sess",
        causalRef: { causalSequence: 2 },
        callId: "call_1",
        result: { hits: [{ id: "row-9" }] },
        isError: false,
      },
      {
        type: "tool_call",
        eventId: "evt_s3",
        sessionId: "sess",
        causalRef: { causalSequence: 3 },
        toolName: "vendor_store",
        callId: "call_2",
        parameters: { id: "row-9" },
        // Same call id, different scope: it names a result this recording never saw.
        metadata: {
          references: {
            id: { reference: "ref:another_recording:call_1", path: ["hits", 0, "id"] },
          },
        },
      },
    ];

    const recipe = recordCallsFromEvents("wf_scope_check", events)!;
    expect(JSON.stringify(leaf(recipe.workflow.steps[1]!.arguments[0]!.source))).toContain(
      "unresolved",
    );
    expect(recipe.workflow.steps[1]!.dependsOn).toEqual([]);
  });

  it("drops malformed entries from a caller's reference record", () => {
    // The record the projection carries is identifiers and index/key paths only. Malformed entries
    // are dropped rather than guessed at. (Preservation itself is asserted end to end: the importer
    // test records a binding from a caller-supplied reference record.)
    const malformed = projectEventToMetadataOnly(
      {
        eventId: "evt_refs_bad",
        sessionId: "sess_agent",
        type: "tool_call",
        toolName: "vendor_store",
        callId: "call_4",
        parameters: { id: "row-9" },
        metadata: {
          references: {
            good: { reference: "ref:sess_agent:call_1", path: ["a", 1] },
            missing: {},
            badPath: { reference: "ref:sess_agent:call_1", path: [{ nested: true }] },
            empty: { reference: "" },
          },
        },
      } as never,
      {},
    );
    const references = (malformed.metadata as Record<string, unknown>).references as
      | Record<string, unknown>
      | undefined;
    if (references) {
      expect(references).toEqual({ good: { reference: "ref:sess_agent:call_1", path: ["a", 1] } });
    }
  });

  it("never binds a reference from another scope that reuses a local call id", () => {
    const events = [
      {
        type: "tool_call",
        eventId: "evt_s1",
        sessionId: "sess",
        causalRef: { causalSequence: 1 },
        toolName: "vendor_search",
        callId: "call_1",
        parameters: { query: "alpha" },
      },
      {
        type: "tool_result",
        eventId: "evt_s2",
        sessionId: "sess",
        causalRef: { causalSequence: 2 },
        callId: "call_1",
        result: { hits: [{ id: "row-9" }] },
        isError: false,
      },
      {
        type: "tool_call",
        eventId: "evt_s3",
        sessionId: "sess",
        causalRef: { causalSequence: 3 },
        toolName: "vendor_store",
        callId: "call_2",
        parameters: { id: "row-9" },
        // Same call id, different scope: it names a result this recording never saw.
        metadata: {
          references: {
            id: { reference: "ref:another_recording:call_1", path: ["hits", 0, "id"] },
          },
        },
      },
    ];

    const recipe = recordCallsFromEvents("wf_scope_check", events)!;
    expect(JSON.stringify(leaf(recipe.workflow.steps[1]!.arguments[0]!.source))).toContain(
      "unresolved",
    );
    expect(recipe.workflow.steps[1]!.dependsOn).toEqual([]);
  });
});
