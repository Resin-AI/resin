/**
 * Native capture: an ordinary conversation with ordinary tools must produce the recording the
 * compiler consumes, without the caller changing anything about how it calls.
 */

import { CodexRecordDecoder, decodeCodexTranscript } from "@resin/adapter-codex";
import { OmpRecordDecoder, RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY } from "@resin/adapter-omp";
import type { NormalizedSessionEvent } from "@resin/contracts";
import {
  NormalizedSessionEventSchema,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
  validateRecordedWorkflow,
} from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { createComputationEvidenceRecorder } from "../../src/analytics/computation/recorder.js";
import { extractComputationSourceFrames } from "../../src/analytics/computation/source-frames.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { deriveNativeCalls } from "../../src/analytics/native-argument-derivation.js";
import {
  FilePrivateValueStore,
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_INVOKE_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import {
  RESIN_LOCAL_WORKFLOW_RESULT_SUPPRESSED_METADATA_KEY,
  isLocalWorkflowResultSuppressed,
} from "../../src/normalization/local-workflow-payload.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const SESSION = "session-native-capture";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: SESSION,
    timestamp: "2026-09-18T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}

function call(
  sequence: number,
  toolName: string,
  parameters: Record<string, unknown>,
  turnIndex = 0,
  sessionId = SESSION,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${sequence}`,
    sessionId,
    type: "tool_call",
    callId: `call_${sequence}`,
    toolName,
    parameters,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex, stepIndex: 0 },
  });
}

function result(
  sequence: number,
  toolName: string,
  value: unknown,
  turnIndex = 0,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_result_${sequence}`,
    type: "tool_result",
    callId: `call_${sequence}`,
    toolName,
    result: value,
    isError: false,
    executionDurationMs: 12,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex, stepIndex: 0 },
  });
}

/** The instruction that starts a new piece of work. */
function userTurn(sequence: number): NormalizedSessionEvent {
  return event({
    eventId: `evt_user_${sequence}`,
    type: "message",
    role: "user",
    content: "do the same thing again with a different name",
    causalRef: { causalSequence: sequence, parentId: null },
  });
}

function discovery(
  tools: Array<{ name: string; provider?: string; inputSchema?: unknown }>,
  sessionId = SESSION,
) {
  return event({
    eventId: "evt_discovery",
    sessionId,
    type: "tool_discovery",
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.provider === undefined ? {} : { provider: tool.provider }),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    })),
    source: "mcp",
    causalRef: { causalSequence: 0, parentId: null },
  });
}

function carrierOf(observed: NormalizedSessionEvent) {
  return readWorkflowCallCarrier(observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
}

/** The events one execution of a session produced, by the index its carriers name. */
function executionOf(events: readonly NormalizedSessionEvent[], index: number) {
  const callIds = new Set(
    events
      .filter((event) => {
        const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
        return carrier?.executionIndex === index;
      })
      .map((event) => event.callId ?? event.toolCallId)
      .filter((callId): callId is string => callId !== undefined),
  );
  return events.filter((event) => {
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    return (
      carrier?.executionIndex === index ||
      (event.type === "tool_result" && event.callId !== undefined && callIds.has(event.callId))
    );
  });
}

/** Drives the recorder exactly as the capture coordinator does, in recorded order. */
function record(events: NormalizedSessionEvent[], store = new InMemoryPrivateValueStore()) {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  return {
    store,
    events: events.map((entry) => recorder.observe(entry, { workspaceId: "ws_native" })),
  };
}

describe("native capture of ordinary calls", () => {
  it("records a tool call the caller made normally, keeping its values local", () => {
    const { events, store } = record([
      discovery([
        { name: "vendor.fetch", provider: "vendor-srv", inputSchema: { type: "object" } },
      ]),
      call(1, "vendor.fetch", { source: "alpha-feed", page: 2 }),
      result(1, "vendor.fetch", { rows: [{ id: "row-7" }] }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier).toBeDefined();
    expect(carrier!.runtime).toBe(RESIN_TOOL_PROTOCOL_RUNTIME);
    expect(carrier!.name).toBe("vendor.fetch");
    expect(carrier!.connection).toBe("vendor-srv");
    expect(carrier!.inputSchema).toEqual({ type: "object" });
    expect(carrier!.provenance).toEqual({
      source: { standing: "derived", rule: "single-observation" },
      page: { standing: "derived", rule: "single-observation" },
    });

    // The values stay on the machine: every leaf is a local reference the executor resolves.
    expect(carrier!.origins.source).toEqual({ type: "private", reference: expect.any(String) });
    expect(
      resolvePrivateReference(store, (carrier!.origins.source as { reference: string }).reference),
    ).toBe("alpha-feed");

    // Nothing about the ordinary call's own values reaches the caller's record.
    expect(JSON.stringify(events[1]!.parameters)).toBe(
      JSON.stringify({ source: "alpha-feed", page: 2 }),
    );
  });

  it("retains a zero-input composed call's meaningful result as an owned baseline", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({
      privateValues: store,
      privateValueOwnerWorkspaceId: "ws_owned",
    });
    const observedCall = recorder.observe(
      call(1, "invoke_tool", { toolName: "local.render_result", parameters: {} }),
      { workspaceId: "ws_native" },
    );
    const observedResult = recorder.observe(
      result(1, "invoke_tool", { result: "meaningful-observed-private" }),
      { workspaceId: "ws_native" },
    );
    expect(carrierOf(observedCall)).toMatchObject({
      runtime: RESIN_INVOKE_TOOL_RUNTIME,
      name: "local.render_result",
      executionIndex: 0,
    });
    const projected = projectEventToMetadataOnly(observedResult);
    const carrier = readWorkflowResultCarrier(
      projected.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
    );
    expect(carrier?.output).toEqual({ type: "object", hasContent: true });
    expect(carrier?.baselineReference).toEqual(expect.any(String));
    expect(resolvePrivateReference(store, carrier!.baselineReference!)).toEqual({
      result: "meaningful-observed-private",
    });
    const recipe = recordCallsFromEvents("composed-zero-input", [observedCall, observedResult]);
    expect(recipe?.workflow.steps[0]?.observed.output).toEqual({
      type: "object",
      hasContent: true,
    });
    expect(recipe?.workflow.baseline?.observed).toMatchObject([
      { stepId: "step0", reference: carrier!.baselineReference },
    ]);
    expect(store.origin(carrier!.baselineReference!)?.workspaceId).toBe("ws_owned");
    expect(JSON.stringify(projected.metadata)).not.toContain("meaningful-observed-private");
  });

  it("records original explicit arguments for baseline replay without independent evidence", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({
      privateValues: store,
      privateValueOwnerWorkspaceId: "ws_owned",
    });
    const events = [
      recorder.observe(
        call(1, "invoke_tool", {
          toolName: "local.fetch",
          parameters: { source: { value: "original-private-source" } },
        }),
        { workspaceId: "ws_native" },
      ),
      recorder.observe(
        result(1, "invoke_tool", {
          handle: "ref:session-native-capture:call_1",
          result: { source: "original-private-source" },
        }),
        { workspaceId: "ws_native" },
      ),
    ];
    const recipe = recordCallsFromEvents("original-input-baseline", events);
    expect(recipe?.workflow.inputs).toEqual([{ name: "step0_source", type: "string" }]);
    expect(recipe?.workflow.heldOut).toBeUndefined();
    const baseline = recipe!.workflow.baseline!;
    expect(baseline.observed).toHaveLength(1);
    expect(resolvePrivateReference(store, baseline.observed[0]!.reference)).toEqual({
      source: "original-private-source",
    });
    const source = baseline.inputs.find(
      (entry) => entry.stepId === "step0" && entry.argument === "source",
    );
    expect(source).toBeDefined();
    expect(resolvePrivateReference(store, source!.reference)).toBe("original-private-source");
    expect(store.origin(source!.reference)?.workspaceId).toBe("ws_owned");
    expect(JSON.stringify(events.map((entry) => entry.metadata))).not.toContain(
      "original-private-source",
    );
  });

  it("distinguishes two caller inputs named echo across independent complete executions", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({
      privateValues: store,
      privateValueOwnerWorkspaceId: "ws_owned",
    });
    const captured = [
      call(1, "invoke_tool", {
        name: "local.publish",
        parameters: { echo: { value: "release-7" } },
      }),
      result(1, "invoke_tool", { handle: "ref:scope:call_1", result: { echo: "release-7" } }),
      call(2, "invoke_tool", { name: "local.probe", parameters: { echo: { value: "ping-1" } } }),
      result(2, "invoke_tool", { handle: "ref:scope:call_2", result: { echo: "ping-1" } }),
      userTurn(3),
      call(3, "invoke_tool", {
        name: "local.publish",
        parameters: { echo: { value: "release-9" } },
      }),
      result(3, "invoke_tool", { handle: "ref:scope:call_3", result: { echo: "release-9" } }),
      call(4, "invoke_tool", { name: "local.probe", parameters: { echo: { value: "ping-2" } } }),
      result(4, "invoke_tool", { handle: "ref:scope:call_4", result: { echo: "ping-2" } }),
    ].map((entry) => recorder.observe(entry, { workspaceId: "ws_native" }));
    const recipe = recordCallsFromEvents("two-echo-inputs", captured);
    expect(recipe?.workflow.inputs).toEqual([
      { name: "step0_echo", type: "string" },
      { name: "step1_echo", type: "string" },
    ]);
    expect(recipe?.workflow.heldOut?.observed).toHaveLength(2);
    expect(
      recipe?.workflow.heldOut?.inputs.map((entry) =>
        resolvePrivateReference(store, entry.reference),
      ),
    ).toEqual(["release-9", "ping-2"]);
    expect(
      recipe?.workflow.baseline?.inputs.map((entry) =>
        resolvePrivateReference(store, entry.reference),
      ),
    ).toEqual(["release-7", "ping-1"]);
  });

  it("never puts a recorded value into the projected metadata of an ordinary call", () => {
    const { events } = record([
      discovery([{ name: "vendor.fetch", provider: "vendor-srv" }]),
      call(1, "vendor.fetch", {
        token: "SENSITIVE_VALUE_9f21",
        nested: { deep: "SENSITIVE_DEEP_4a11" },
      }),
    ]);

    const projected = projectEventToMetadataOnly(events[1]!);
    const serialized = JSON.stringify(projected.metadata ?? {});
    expect(serialized).not.toContain("SENSITIVE_VALUE_9f21");
    expect(serialized).not.toContain("SENSITIVE_DEEP_4a11");
  });

  it("records a multi-operation shell program whole, and the argument that holds it", () => {
    const command = "printf 'a\\n' | sort > /tmp/native-out.txt && wc -l < /tmp/native-out.txt";
    const { events, store } = record([
      discovery([{ name: "bash", provider: "omp" }]),
      call(1, "bash", { command, cwd: "/tmp/project" }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier!.runtime).toBe(RESIN_PROCESS_RUNTIME);
    expect(carrier!.program).toEqual({ kind: "shell", source: "", argument: "command" });
    expect(resolvePrivateReference(store, referenceOf(carrier!.origins.command!))).toBe(command);
  });

  it("records a program call through its interpreter family", () => {
    const source = "import json\nprint(json.dumps({'rows': [1, 2, 3]}))\n";
    const { events } = record([
      discovery([{ name: "eval", provider: "omp" }]),
      call(1, "eval", { language: "python", code: source }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier!.runtime).toBe(RESIN_PROGRAM_RUNTIME);
    expect(carrier!.program).toEqual({ kind: "python", source: "", argument: "code" });
  });

  it.each([
    { language: "python", path: "tools/helper.py", source: "values = [2, 4]\nprint(values)\n" },
    {
      language: "javascript",
      path: "tools/helper.mjs",
      source: "const values = [2, 4]; console.log(values);\n",
    },
    {
      language: "typescript",
      path: "tools/helper.ts",
      source: "const values: number[] = [2, 4]; console.log(values);\n",
    },
  ])(
    "keeps an authored $language file write as a file operation through privacy projection",
    ({ language, path, source }) => {
      const store = new InMemoryPrivateValueStore();
      const workflowRecorder = new WorkflowCallRecorder({ privateValues: store });
      const computationRecorder = createComputationEvidenceRecorder();
      const observed = [
        call(1, "write", { path, content: source }),
        result(1, "write", "file written"),
      ].map((entry) =>
        computationRecorder.observe(workflowRecorder.observe(entry, { workspaceId: "ws_native" })),
      );
      const projected = observed.map(projectEventToMetadataOnly);

      const carrier = carrierOf(projected[0]!);
      expect(carrier?.runtime).toBe(RESIN_HARNESS_TOOL_RUNTIME);
      expect(carrier?.name).toBe("write");
      expect(carrier?.program).toBeUndefined();
      expect(resolvePrivateReference(store, referenceOf(carrier!.origins.content!))).toBe(source);
      expect(JSON.stringify(projected)).not.toContain(JSON.stringify(source).slice(1, -1));
      expect(
        readComputationEvidence(projected[1]?.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
      ).toMatchObject({
        origin: { kind: "authored_file" },
        program: { language },
        observation: { kind: "definition", status: "success" },
      });

      const recipe = recordCallsFromEvents("wf_authored_file", projected);
      expect(recipe?.workflow.steps).toHaveLength(1);
      expect(recipe?.workflow.steps[0]?.callable).toEqual({
        runtime: RESIN_HARNESS_TOOL_RUNTIME,
        name: "write",
      });
      expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
    },
  );

  it("keeps reading a Python source file distinct from its later execution", () => {
    const source = "print([2, 4])\n";
    const store = new InMemoryPrivateValueStore();
    const workflowRecorder = new WorkflowCallRecorder({ privateValues: store });
    const computationRecorder = createComputationEvidenceRecorder();
    const projected = [
      call(1, "read", { path: "tools/helper.py" }),
      result(1, "read", source),
      call(2, "bash", { command: "python3 tools/helper.py" }),
      result(2, "bash", "[2, 4]\n"),
    ].map((entry) =>
      projectEventToMetadataOnly(
        computationRecorder.observe(workflowRecorder.observe(entry, { workspaceId: "ws_native" })),
      ),
    );

    expect(carrierOf(projected[0]!)?.runtime).toBe(RESIN_HARNESS_TOOL_RUNTIME);
    expect(carrierOf(projected[0]!)?.program).toBeUndefined();
    expect(
      readComputationEvidence(projected[1]?.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
    ).toMatchObject({
      origin: { kind: "referenced_file" },
      observation: { kind: "definition", status: "success" },
    });
    expect(
      readComputationEvidence(projected[3]?.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
    ).toMatchObject({
      origin: { kind: "referenced_file" },
      observation: { kind: "invocation", status: "success" },
    });
    expect(JSON.stringify(projected)).not.toContain(source.trim());

    const recipe = recordCallsFromEvents("wf_read_then_execute", projected);
    expect(recipe?.workflow.steps.map((step) => step.callable)).toEqual([
      { runtime: RESIN_HARNESS_TOOL_RUNTIME, name: "read" },
      {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source: "", argument: "command" },
      },
    ]);
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("captures a closed Python setup chain and successful baseline references", () => {
    const store = new InMemoryPrivateValueStore();
    const workflowRecorder = new WorkflowCallRecorder({ privateValues: store });
    const computationRecorder = createComputationEvidenceRecorder();
    const observed = [
      call(1, "eval", { language: "python", code: "import json" }),
      result(1, "eval", "setup-ok"),
      call(2, "eval", { language: "python", code: "print(json.dumps({'ok': True}))" }),
      result(2, "eval", "target-ok"),
    ].map((entry) =>
      computationRecorder.observe(workflowRecorder.observe(entry, { workspaceId: "ws_native" })),
    );

    const recipe = recordCallsFromEvents("wf_python_state", observed);
    const targetCarrier = carrierOf(observed[2]!);
    expect(targetCarrier?.program?.pythonState?.status).toBe("closed");
    expect(targetCarrier?.program?.pythonState?.setup).toEqual([
      expect.objectContaining({ callId: "call_1", reference: expect.stringContaining("private:") }),
    ]);

    expect(recipe?.workflow.steps).toHaveLength(1);
    expect(recipe?.workflow.baseline?.observed.map((entry) => entry.stepId)).toEqual(["step0"]);
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });
  it("marks a successful Python target unresolved when its predecessor was not captured", () => {
    const workflowRecorder = new WorkflowCallRecorder({
      privateValues: new InMemoryPrivateValueStore(),
    });
    const computationRecorder = createComputationEvidenceRecorder();
    const observed = [
      call(11, "eval", { language: "python", code: "print(json.dumps({'ok': True}))" }),
      result(11, "eval", "target-ok"),
    ].map((entry) =>
      computationRecorder.observe(workflowRecorder.observe(entry, { workspaceId: "ws_native" })),
    );
    expect(carrierOf(observed[0]!)?.program?.pythonState).toMatchObject({
      status: "unresolved",
      unresolvedReadCount: expect.any(Number),
      setup: [],
    });
  });
  it("carries only decoder-proven OMP Python Eval semantics into the recorded program", async () => {
    const sessionId = "session-native-python-eval-interface";
    const pipeline = new NormalizationPipeline();
    pipeline.registerDecoder(new OmpRecordDecoder());
    const record: RawHarnessRecord = {
      recordId: "rec-native-python-eval-interface",
      sessionId,
      harnessId: "omp",
      sequenceNumber: 1,
      recordType: "transcript_line",
      timestamp: "2026-09-18T10:00:00.000Z",
      cursor: {
        offset: 10,
        line: 1,
        sequence: 1,
        timestamp: "2026-09-18T10:00:00.000Z",
      },
      rawPayload: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-native-python-eval-interface",
              name: "eval",
              arguments: { language: "py", code: "import json; print(json.dumps({'ok': True}))" },
            },
          ],
        },
      }),
      metadata: { [RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]: "forged" },
    };
    const results = await pipeline.processRecord(record, {
      sessionId,
      harnessId: "omp",
      workspaceId: "ws_native",
    });
    const decoded = results.find(
      (entry) => entry.status === "success" && entry.event.type === "tool_call",
    );
    if (
      decoded === undefined ||
      decoded.status !== "success" ||
      decoded.event.type !== "tool_call"
    ) {
      throw new Error("expected normalized Python Eval tool call");
    }

    expect(decoded.event.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]).toBe("python-eval");

    const workflowRecorder = new WorkflowCallRecorder({
      privateValues: new InMemoryPrivateValueStore(),
    });
    const observed = workflowRecorder.observe(decoded.event, { workspaceId: "ws_native" });
    expect(observed.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]).toBeUndefined();
    expect(carrierOf(observed)?.program).toMatchObject({
      kind: "python",
      argument: "code",
      sourceInterface: "python-eval",
    });

    const computationObserved = createComputationEvidenceRecorder().observe(observed);
    expect(computationObserved.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]).toBeUndefined();
    expect(carrierOf(computationObserved)?.program?.sourceInterface).toBe("python-eval");
  });

  it("carries only decoder-proven OMP JavaScript Eval semantics into the recorded program", async () => {
    const sessionId = "session-native-javascript-eval-interface";
    const pipeline = new NormalizationPipeline();
    pipeline.registerDecoder(new OmpRecordDecoder());
    const record: RawHarnessRecord = {
      recordId: "rec-native-javascript-eval-interface",
      sessionId,
      harnessId: "omp",
      sequenceNumber: 1,
      recordType: "transcript_line",
      timestamp: "2026-09-18T10:00:00.000Z",
      cursor: {
        offset: 10,
        line: 1,
        sequence: 1,
        timestamp: "2026-09-18T10:00:00.000Z",
      },
      rawPayload: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-native-javascript-eval-interface",
              name: "eval",
              arguments: {
                language: "js",
                code: "const value = 40; JSON.stringify({ value: value + 2 });",
              },
            },
          ],
        },
      }),
      metadata: { [RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]: "forged" },
    };
    const results = await pipeline.processRecord(record, {
      sessionId,
      harnessId: "omp",
      workspaceId: "ws_native",
    });
    const decoded = results.find(
      (entry) => entry.status === "success" && entry.event.type === "tool_call",
    );
    if (
      decoded === undefined ||
      decoded.status !== "success" ||
      decoded.event.type !== "tool_call"
    ) {
      throw new Error("expected normalized JavaScript Eval tool call");
    }

    expect(decoded.event.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]).toBe("javascript-eval");

    const workflowRecorder = new WorkflowCallRecorder({
      privateValues: new InMemoryPrivateValueStore(),
    });
    const observed = workflowRecorder.observe(decoded.event, { workspaceId: "ws_native" });
    expect(observed.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]).toBeUndefined();
    expect(carrierOf(observed)?.program).toMatchObject({
      kind: "javascript",
      argument: "code",
      sourceInterface: "javascript-eval",
    });

    const computationObserved = createComputationEvidenceRecorder().observe(observed);
    expect(computationObserved.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]).toBeUndefined();
    expect(carrierOf(computationObserved)?.program?.sourceInterface).toBe("javascript-eval");
  });

  it("keeps intermediate native exec output pending until both recorders observe the final result", () => {
    const sessionId = "session-native-codex-exec";
    const source = "text(JSON.stringify({ answer: 42 }));\n";
    const intermediate = [
      {
        type: "input_text",
        text: "Script running with cell ID cell_123\nWall time 0.1 seconds\nOutput:\n",
      },
      { type: "input_text", text: "intermediate output" },
    ];
    const output = [
      {
        type: "input_text",
        text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
      },
      { type: "input_text", text: "authored item one" },
      { type: "input_text", text: "authored item two" },
    ];
    const decoded = decodeCodexTranscript(
      [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call-native-codex-exec",
            name: "exec",
            input: source,
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "custom_tool_call_output",
              call_id: "call-native-codex-exec",
              output: intermediate,
            },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-native-codex-exec",
            output: intermediate,
            turn_usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-native-codex-exec",
            output,
          },
        },
      ],
      { sessionId },
    );
    const nativeCall = decoded.find((entry) => entry.type === "tool_call");
    const nativeResult = decoded.find((entry) => entry.type === "tool_result");
    if (nativeCall?.type !== "tool_call" || nativeResult?.type !== "tool_result") {
      throw new Error("expected paired native exec call and final result");
    }

    expect(decoded.filter((entry) => entry.type === "tool_result")).toHaveLength(1);
    expect(nativeCall.parameters).toEqual({ raw: source });
    expect(nativeCall.metadata?.codexNative).toMatchObject({
      type: "response_item",
      itemType: "custom_tool_call",
      sourceInterface: "codex-exec",
    });
    expect(nativeResult.result).toEqual(output.slice(1));
    expect(nativeResult.metadata?.codexNative).toMatchObject({
      outcome: "completed",
      sourceInterface: "codex-exec",
    });
    expect(nativeResult.providerUsage).toMatchObject({
      inputTokens: 11,
      outputTokens: 2,
      totalTokens: 13,
    });

    const store = new InMemoryPrivateValueStore();
    const workflowRecorder = new WorkflowCallRecorder({ privateValues: store });
    const computationRecorder = createComputationEvidenceRecorder();
    const observed = decoded.map((entry) =>
      computationRecorder.observe(workflowRecorder.observe(entry, { workspaceId: "ws_native" })),
    );
    const recordedCall = observed.find((entry) => entry.type === "tool_call");
    const recordedResult = observed.find((entry) => entry.type === "tool_result");
    if (recordedCall?.type !== "tool_call" || recordedResult?.type !== "tool_result") {
      throw new Error("both recorders must see the paired native exec result");
    }

    const carrier = carrierOf(recordedCall);
    expect(carrier?.runtime).toBe(RESIN_PROGRAM_RUNTIME);
    expect(carrier?.program).toEqual({
      kind: "javascript",
      source: "",
      argument: "raw",
      sourceInterface: "codex-exec",
    });
    expect(resolvePrivateReference(store, referenceOf(carrier!.origins.raw!))).toBe(source);
    expect(JSON.stringify(projectEventToMetadataOnly(recordedCall))).not.toContain(source);
    expect(
      readComputationEvidence(recordedCall.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY])?.observation
        .status,
    ).toBe("pending");
    expect(
      readComputationEvidence(recordedResult.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY])
        ?.observation,
    ).toMatchObject({
      callId: nativeCall.callId,
      status: "success",
      resultEventId: recordedResult.eventId,
    });
    const recipe = recordCallsFromEvents(sessionId, observed);
    expect(recipe?.workflow.baseline?.observed).toHaveLength(1);
    expect(
      resolvePrivateReference(store, recipe!.workflow.baseline!.observed[0]!.reference),
    ).toEqual(output.slice(1));
  });

  it("does not establish workflow or computation success from a terminal truncated exec result", () => {
    const sessionId = "session-native-codex-exec-truncated";
    const decoded = decodeCodexTranscript(
      [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call-native-codex-exec-truncated",
            name: "exec",
            input: "text('partial');",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-native-codex-exec-truncated",
            output: [
              { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
              { type: "input_text", text: "partial output" },
            ],
            output_truncated: true,
          },
        },
      ],
      { sessionId },
    );
    const store = new InMemoryPrivateValueStore();
    const workflowRecorder = new WorkflowCallRecorder({ privateValues: store });
    const computationRecorder = createComputationEvidenceRecorder();
    const observed = decoded.map((entry) =>
      computationRecorder.observe(workflowRecorder.observe(entry, { workspaceId: "ws_native" })),
    );
    const result = observed.find((entry) => entry.type === "tool_result");
    if (result?.type !== "tool_result") {
      throw new Error("expected an explicit terminal truncated result");
    }

    expect(result.isError).toBe(false);
    expect(result.metadata?.codexNative).toMatchObject({ outcome: "truncated" });
    expect(isLocalWorkflowResultSuppressed(result)).toBe(true);
    expect(
      isSubstantiveComputationEvidence(
        readComputationEvidence(result.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
      ),
    ).toBe(false);
    expect(recordCallsFromEvents(sessionId, observed)?.workflow.baseline).toBeUndefined();
  });
});

describe("what the derivation offers, and what it refuses to offer", () => {
  it("offers a value that first appeared in an earlier result, and only as a candidate", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.fetch",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { source: "alpha-feed" },
        result: { entry: { handle: "entry-alpha-feed-001" } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.use",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { entry: "entry-alpha-feed-001" },
      },
    ]);

    expect(derivation.candidates.filter((entry) => entry.proposed.kind === "result")).toHaveLength(
      1,
    );
    const candidate = derivation.candidates.find((entry) => entry.proposed.kind === "result")!;
    expect(candidate.stepId).toBe("step1");
    expect(candidate.argument).toBe("entry");
    expect(candidate.proposed).toEqual({
      kind: "result",
      stepId: "step0",
      path: ["entry", "handle"],
    });
    expect(candidate.missing).toContain("does not show this call read its result");
  });

  it("refuses an incidental equal value that the record already contained", () => {
    // The producer returns a value the record had already seen before it ran. Equality here is a
    // coincidence: the later call may have taken it from anywhere, so nothing is offered.
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.list",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { filter: "shared-token-42" },
        result: { echoes: ["shared-token-42"] },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.use",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { token: "shared-token-42" },
      },
    ]);

    expect(derivation.candidates.every((entry) => entry.proposed.kind === "input")).toBe(true);
  });

  it("refuses a short token that collides with unrelated arguments", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.fetch",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: {},
        result: { status: "ok" },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.use",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { status: "ok" },
      },
    ]);

    expect(derivation.candidates.every((entry) => entry.proposed.kind === "input")).toBe(true);
  });

  it("proves a producer-to-consumer edge from the calls' own declared resource use", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "write_file",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { path: "/tmp/a.json" },
        flow: { reads: [], writes: ["file:/tmp/a.json"] },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "read_file",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { path: "/tmp/a.json" },
        flow: { reads: ["file:/tmp/a.json"], writes: [] },
      },
    ]);

    expect(derivation.calls[1]!.dependsOn).toEqual(["step0"]);
    // The shared path is a resource identity, not a value: equality alone never created this edge.
    expect(derivation.calls[0]!.dependsOn).toEqual([]);
  });

  it("retains the result candidate when a later call consumes the minted value", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.fetch",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { source: "alpha-feed" },
        result: { entry: { handle: "entry-alpha-feed-001" } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.score",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { handle: "entry-alpha-feed-001" },
      },
    ]);

    // It is offered as a result binding instead, which is what the record actually supports.
    expect(
      derivation.candidates
        .filter((entry) => entry.stepId === "step1" && entry.argument === "handle")
        .map((entry) => entry.reason),
    ).toEqual(["equal-to-earlier-result"]);
  });
  it("proposes private nested primitive inputs, including false and zero, without displacing results", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "first",
        stepId: "step0",
        toolName: "vendor.measure",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { payload: { count: 0, enabled: false, label: "private-label" } },
        result: { count: 0 },
      },
      {
        callId: "second",
        stepId: "step1",
        toolName: "vendor.render",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { count: 0, enabled: false },
      },
    ]);
    const inputs = derivation.candidates.filter((entry) => entry.proposed.kind === "input");
    expect(
      inputs.map((entry) => [
        entry.stepId,
        entry.argument,
        entry.path,
        entry.proposed.kind === "input" && entry.proposed.type,
      ]),
    ).toEqual([
      ["step0", "payload", ["count"], "number"],
      ["step0", "payload", ["enabled"], "boolean"],
      ["step0", "payload", ["label"], "string"],
      ["step1", "count", [], "number"],
      ["step1", "enabled", [], "boolean"],
    ]);
    expect(JSON.stringify(inputs)).not.toContain("private-label");
    expect(inputs.every((entry) => entry.missing.length > 0)).toBe(true);
  });
  it("bounds weak input proposals without starving a later producer-to-consumer binding", () => {
    const firstArguments = Object.fromEntries(
      Array.from({ length: 300 }, (_, position) => [`field${position}`, position]),
    );
    const derivation = deriveNativeCalls([
      {
        callId: "producer",
        stepId: "step0",
        toolName: "vendor.produce",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: firstArguments,
        result: { id: "minted-late-result" },
      },
      {
        callId: "consumer",
        stepId: "step1",
        toolName: "vendor.consume",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { id: "minted-late-result" },
      },
    ]);
    expect(derivation.candidates.length).toBeLessThanOrEqual(256);
    expect(
      derivation.candidates.filter(
        (candidate) => candidate.stepId === "step1" && candidate.argument === "id",
      ),
    ).toEqual([
      expect.objectContaining({
        proposed: { kind: "result", stepId: "step0", path: ["id"] },
      }),
    ]);
    expect(
      derivation.candidates.some(
        (candidate) =>
          candidate.stepId === "step0" &&
          candidate.argument === "field0" &&
          candidate.proposed.kind === "input",
      ),
    ).toBe(true);
  });
});

describe("the recording an ordinary session produces", () => {
  it("compiles into a plan whose values resolve locally, with candidates kept out of it", () => {
    const store = new InMemoryPrivateValueStore();
    const observed = record(
      [
        discovery([
          { name: "vendor.fetch", provider: "vendor-srv", inputSchema: { type: "object" } },
          { name: "vendor.store", provider: "vendor-srv" },
        ]),
        call(1, "vendor.fetch", { source: "alpha-feed" }),
        result(1, "vendor.fetch", { entry: { handle: "entry-alpha-feed-001" } }),
        call(2, "vendor.store", { token: "entry-alpha-feed-001" }),
        result(2, "vendor.store", { stored: { artifactId: "art-1" } }),
      ],
      store,
    ).events;

    const recipe = recordCallsFromEvents("wf_native", observed);
    expect(recipe).toBeDefined();
    const workflow = recipe!.workflow;
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps.map((step) => step.callable.runtime)).toEqual([
      RESIN_TOOL_PROTOCOL_RUNTIME,
      RESIN_TOOL_PROTOCOL_RUNTIME,
    ]);

    // The suggestion is reported and not executed: the step still carries the recorded value.
    expect(workflow.candidates).toContainEqual(
      expect.objectContaining({
        stepId: "step1",
        proposed: { kind: "result", stepId: "step0", path: ["entry", "handle"] },
      }),
    );
    const storedArgument = workflow.steps[1]!.arguments.find((entry) => entry.name === "token")!;
    expect(storedArgument.source.kind).toBe("template");

    expect(workflow.baseline?.observed.map((entry) => entry.stepId)).toEqual(["step0", "step1"]);
    expect(
      workflow.baseline?.observed.every((entry) =>
        workflow.privateReferences?.includes(entry.reference),
      ),
    ).toBe(true);
    // Every local reference the plan resolves is declared, so the plan is structurally sound.
    expect(workflow.privateReferences?.length).toBeGreaterThanOrEqual(4);
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("survives redelivery of the same execution as one step, not two", () => {
    const events = record([
      discovery([{ name: "vendor.fetch", provider: "vendor-srv" }]),
      call(1, "vendor.fetch", { source: "alpha-feed" }),
      result(1, "vendor.fetch", { entry: { handle: "entry-alpha-feed-001" } }),
      call(1, "vendor.fetch", { source: "alpha-feed" }),
      result(1, "vendor.fetch", { entry: { handle: "entry-alpha-feed-001" } }),
    ]).events;

    const recipe = recordCallsFromEvents("wf_native_redelivery", events);
    expect(recipe!.workflow.steps).toHaveLength(1);
  });
});

describe("a value embedded in a program an ordinary session ran", () => {
  /** A shell command that writes a value an earlier call's result minted. */
  const command = "printf '%s\\n' 'alpha-7f3c' > f";

  function session() {
    return record([
      discovery([{ name: "bash", provider: "omp" }]),
      call(1, "bash", { command: "printf '%s\\n' 'placeholder' > f" }),
      result(1, "bash", { stdout: "alpha-7f3c" }),
      call(2, "bash", { command }),
    ]);
  }

  it("offers the token an earlier result produced, at its position in the program", () => {
    const { events } = session();
    const carrier = carrierOf(events[3]!)!;
    // The record still says the call was a program, and which argument held its text.
    expect(carrier.program).toEqual({ kind: "shell", source: "", argument: "command" });

    expect(carrier.candidates).toHaveLength(1);
    const candidate = carrier.candidates![0]!;
    expect(candidate.argument).toBe("command");
    expect(candidate.path).toEqual(["tokens", 2]);
    expect(candidate.proposed).toEqual({ kind: "result", callId: "call_1", path: ["stdout"] });
    expect(candidate.reason).toBe("equal-to-earlier-result");
    expect(candidate.evidence).toEqual({ tokens: 5, token: 2, producers: 1 });

    // A candidate is a reason, never the value: nothing the record carries names the token's text.
    expect(JSON.stringify(projectEventToMetadataOnly(events[3]!).metadata ?? {})).not.toContain(
      "alpha-7f3c",
    );
  });

  it("carries the token candidate's path into the plan unchanged, and does not apply it", () => {
    const { events, store } = session();
    const recipe = recordCallsFromEvents("wf_program_token", events);
    expect(recipe).toBeDefined();
    const workflow = recipe!.workflow;
    expect(workflow.steps).toHaveLength(2);

    // The call the capture numbered `step1` keeps the position the capture gave the token: the
    // recording renumbers calls, and a token index is not a step identity.
    expect(workflow.candidates).toHaveLength(1);
    expect(workflow.candidates![0]).toMatchObject({
      stepId: "step1",
      argument: "command",
      path: ["tokens", 2],
      proposed: { kind: "result", stepId: "step0", path: ["stdout"] },
      reason: "equal-to-earlier-result",
    });

    // The suggestion is reported and not executed: the step still carries the recorded program.
    const argument = workflow.steps[1]!.arguments.find((entry) => entry.name === "command")!;
    expect(argument.source.kind).toBe("template");
    const template = argument.source.kind === "template" ? argument.source.template : undefined;
    expect(template?.type).toBe("private");
    const reference = template?.type === "private" ? template.reference : undefined;
    expect(reference).toBeDefined();
    expect(resolvePrivateReference(store, reference!)).toBe(command);
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
  });
});

describe("the demonstration an ordinary session offers", () => {
  /** Two executions of the same work: the same callables in the same order, on different values. */
  function repeated(): NormalizedSessionEvent[] {
    return [
      discovery([
        {
          name: "vendor.score",
          provider: "vendor-srv",
          inputSchema: { type: "object", properties: { dataset: { type: "string" } } },
        },
      ]),
      call(1, "vendor.score", { dataset: "alpha-set", tag: "ops-run" }),
      result(1, "vendor.score", { scored: { label: "alpha-set:42" } }),
      userTurn(2),
      call(3, "vendor.score", { dataset: "bravo-set", tag: "ops-run" }),
      result(3, "vendor.score", { scored: { label: "bravo-set:84" } }),
    ];
  }

  it("records a repeat of earlier work as a demonstration, kept by reference", () => {
    const { events, store } = record(repeated());
    const repeat = carrierOf(events[4]!)!;
    expect(repeat.executionIndex).toBe(1);
    // The demonstration is the repeat's own values: the inputs the earlier recording never used,
    // and what those inputs actually produced.
    expect(repeat.heldOut?.repeats).toBe(0);
    expect(repeat.heldOut?.inputs.map((entry) => entry.argument).sort()).toEqual([
      "dataset",
      "tag",
    ]);
    expect(repeat.heldOut?.observed.map((entry) => entry.position)).toEqual([0]);
    for (const entry of repeat.heldOut?.inputs ?? []) {
      expect(entry.reference.startsWith("private:")).toBe(true);
    }
    const dataset = (repeat.heldOut?.inputs ?? []).find((entry) => entry.argument === "dataset")!;
    expect(resolvePrivateReference(store, dataset.reference)).toBe("bravo-set");
    const produced = repeat.heldOut!.observed[0]!;
    expect(resolvePrivateReference(store, produced.reference)).toEqual({
      scored: { label: "bravo-set:84" },
    });
  });

  it("compiles the work once, with the demonstration declared and resolvable", () => {
    const observed = record(repeated()).events;
    const recipe = recordCallsFromEvents("wf_repeat", observed);
    // One execution is the plan; performing it twice is not two tools' worth of steps.
    expect(recipe!.workflow.steps).toHaveLength(1);
    expect(recipe!.workflow.steps[0]!.callable.name).toBe("vendor.score");
    const heldOut = recipe!.workflow.heldOut;
    expect(heldOut?.inputs).toHaveLength(2);
    expect(heldOut?.observed).toHaveLength(1);
    expect(heldOut?.inputs.every((entry) => entry.stepId === "step0")).toBe(true);
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("does not declare inputs from discovered schema, shared values, or repeated calls", () => {
    const observed = record([
      discovery([
        {
          name: "vendor.intake",
          provider: "vendor-srv",
          inputSchema: { type: "object", properties: { feed: { type: "string" } } },
        },
      ]),
      call(1, "vendor.intake", { feed: "alpha-feed", note: "alpha-feed" }),
      userTurn(2),
      call(3, "vendor.intake", { feed: "bravo-feed", note: "bravo-feed" }),
    ]).events;
    const recipe = recordCallsFromEvents("wf_no_inferred_inputs", observed)!;
    expect(recipe.workflow.inputs).toEqual([]);
    expect(
      recipe.workflow.steps[0]!.arguments.every((argument) => argument.source.kind === "template"),
    ).toBe(true);
    expect(
      recipe.workflow.candidates?.every(
        (candidate) => candidate.proposed.kind === "input" && candidate.missing.length > 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(recipe.workflow.candidates)).not.toContain("alpha-feed");
    expect(JSON.stringify(recipe.workflow.candidates)).not.toContain("bravo-feed");
  });
});

describe("a recording and the demonstrations read beside it", () => {
  /** Two unrelated tasks, then a repeat of the first one only. */
  function session(): NormalizedSessionEvent[] {
    return record([
      discovery([
        {
          name: "alpha_step",
          provider: "srv",
          inputSchema: { type: "object", properties: { seed: { type: "string" } } },
        },
        { name: "alpha_finish", provider: "srv" },
      ]),
      call(1, "alpha_step", { seed: "alpha-seed" }),
      result(1, "alpha_step", { minted: { id: "alpha-1" } }),
      call(2, "alpha_finish", { token: "alpha-1" }),
      result(2, "alpha_finish", { done: true }),
      userTurn(3),
      call(4, "beta_sweep", { scope: "everything" }),
      result(4, "beta_sweep", { swept: 12 }),
      call(5, "beta_report", { rows: 12 }),
      result(5, "beta_report", { reported: true }),
      userTurn(6),
      call(7, "alpha_step", { seed: "bravo-seed" }),
      result(7, "alpha_step", { minted: { id: "alpha-2" } }),
      call(8, "alpha_finish", { token: "alpha-2" }),
      result(8, "alpha_finish", { done: true }),
    ]).events;
  }

  it("keeps the selected work's own calls and never adds the session's other tasks", () => {
    const events = session();
    const recipe = recordCallsFromEvents("wf_selected", executionOf(events, 0), {
      supportingEvents: executionOf(events, 2),
    });

    // The compiled workflow is the task's two calls — not the unrelated task, and not the repeat.
    expect(recipe!.workflow.steps).toHaveLength(2);
    expect(recipe!.workflow.steps.map((step) => step.callable.name)).toEqual([
      "alpha_step",
      "alpha_finish",
    ]);
    // The repeat is present as evidence for a replay, addressed by the steps it repeats: the values
    // it used sit beside the steps they were used at, and a candidate is only decided by the one
    // that lands on its own position.
    expect(recipe!.workflow.heldOut?.inputs.map((entry) => entry.stepId)).toEqual([
      "step0",
      "step1",
    ]);
    expect(recipe!.workflow.heldOut?.inputs.map((entry) => entry.argument).sort()).toEqual([
      "seed",
      "token",
    ]);
    expect(recipe!.workflow.heldOut?.observed.map((entry) => entry.stepId).sort()).toEqual([
      "step0",
      "step1",
    ]);
    expect(recipe!.workflow.baseline?.observed.map((entry) => entry.stepId)).toEqual([
      "step0",
      "step1",
    ]);
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("compiles each task to its own calls, and a repeat supports it without joining it", () => {
    const events = session();
    const second = recordCallsFromEvents("wf_selected_beta", executionOf(events, 1));
    // The unrelated task stands on its own, with no demonstration borrowed from anywhere.
    expect(second!.workflow.steps.map((step) => step.callable.name)).toEqual([
      "beta_sweep",
      "beta_report",
    ]);
    expect(second!.workflow.heldOut).toBeUndefined();
  });
});

describe("what a repeat's own calls demonstrate", () => {
  /** The same work performed twice on different values, retained as distinct executions. */
  function repeatedOnDifferentDatasets() {
    return record([
      discovery([{ name: "vendor.score", provider: "vendor-srv" }]),
      call(1, "vendor.score", { dataset: "alpha-set", tag: "ops-run" }),
      result(1, "vendor.score", { scored: { label: "alpha-set:42" } }),
      userTurn(2),
      call(3, "vendor.score", { dataset: "bravo-set", tag: "ops-run" }),
      result(3, "vendor.score", { scored: { label: "bravo-set:84" } }),
    ]);
  }

  it("carries the repeat's demonstration by reference at the same step", () => {
    const { events, store } = repeatedOnDifferentDatasets();
    const recipe = recordCallsFromEvents("wf_repeat_demo", executionOf(events, 0), {
      supportingEvents: executionOf(events, 1),
    });
    const heldOut = recipe!.workflow.heldOut;
    expect(heldOut?.inputs.map((entry) => [entry.stepId, entry.argument]).sort()).toEqual([
      ["step0", "dataset"],
      ["step0", "tag"],
    ]);
    expect(heldOut?.observed.map((entry) => entry.stepId)).toEqual(["step0"]);
    const dataset = heldOut!.inputs.find((entry) => entry.argument === "dataset")!;
    // The demonstration is the user's own second run, kept where it was performed.
    expect(dataset.reference.startsWith("private:")).toBe(true);
    expect(resolvePrivateReference(store, dataset.reference)).toBe("bravo-set");
    expect(resolvePrivateReference(store, heldOut!.observed[0]!.reference)).toEqual({
      scored: { label: "bravo-set:84" },
    });
  });

  it("maps a nested proposal onto the step the repeat's producing call is", () => {
    // The earlier execution's first step reported no result, so the recording's own calls propose
    // nothing about the second step's nested argument. The repeat establishes it: its second call
    // passed the value its first call returned, at a path inside that argument.
    const { events } = record([
      discovery([
        { name: "alpha_step", provider: "srv" },
        { name: "alpha_finish", provider: "srv" },
      ]),
      call(1, "alpha_step", { seed: "alpha-seed" }),
      call(2, "alpha_finish", { meta: { note: "alpha-1" } }),
      result(2, "alpha_finish", { done: true }),
      userTurn(3),
      call(4, "alpha_step", { seed: "bravo-seed" }),
      result(4, "alpha_step", { minted: { id: "alpha-2" } }),
      call(5, "alpha_finish", { meta: { note: "alpha-2" } }),
      result(5, "alpha_finish", { done: true }),
    ]);

    const recipe = recordCallsFromEvents("wf_repeat_nested", executionOf(events, 0), {
      supportingEvents: executionOf(events, 1),
    });
    expect(recipe!.workflow.steps.map((step) => step.callable.name)).toEqual([
      "alpha_step",
      "alpha_finish",
    ]);
    expect(recipe!.workflow.candidates).toContainEqual({
      stepId: "step1",
      argument: "meta",
      path: ["note"],
      proposed: { kind: "result", stepId: "step0", path: ["minted", "id"] },
      reason: "equal-to-earlier-result",
      evidence: { producers: 1 },
      missing: expect.any(String),
    });
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("keeps a varied primitive produced by an earlier call as data flow", () => {
    const { events } = record([
      discovery([
        { name: "measure", provider: "srv" },
        { name: "render", provider: "srv" },
      ]),
      call(1, "measure", { text: "red blue" }),
      result(1, "measure", { stats: { count: 2 } }),
      call(2, "render", { count: 2 }),
      result(2, "render", { text: "Words: 2\n" }),
      userTurn(3),
      call(4, "measure", { text: "amber green blue silver white" }),
      result(4, "measure", { stats: { count: 5 } }),
      call(5, "render", { count: 5 }),
      result(5, "render", { text: "Words: 5\n" }),
    ]);

    const recipe = recordCallsFromEvents("wf_repeat_number", executionOf(events, 0), {
      supportingEvents: executionOf(events, 1),
    });
    const countCandidates = recipe!.workflow.candidates?.filter(
      (candidate) => candidate.stepId === "step1" && candidate.argument === "count",
    );
    expect(countCandidates).toEqual([
      expect.objectContaining({
        path: [],
        proposed: { kind: "result", stepId: "step0", path: ["stats", "count"] },
        reason: "equal-to-earlier-result",
      }),
    ]);
  });
});

describe("the private value store the recorder writes to", () => {
  it("refuses a foreign workspace the way every other local reference does", () => {
    const store = new FilePrivateValueStore(
      `${process.env.HOME ?? "/tmp"}/.resin-test-native/private-values.json`,
    );
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const observed = recorder.observe(call(1, "vendor.fetch", { source: "alpha-feed" }), {
      workspaceId: "ws_native",
    });
    const carrier = carrierOf(observed)!;
    const reference = referenceOf(carrier.origins.source!);
    expect(store.origin?.(reference)?.workspaceId).toBe("ws_native");
  });
});

/**
 * Drives one session of OMP transcript records through the real pipeline: each invocation is the
 * transport `write` plus a device path, with the invocation's own arguments in the assistant record
 * that follows it. The server names are the harness's own registry, which is what the paths are
 * resolved against.
 */
async function captureDeviceSurface(
  invocations: Array<[string, string]>,
  servers: readonly string[],
  recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() }),
): Promise<NormalizedSessionEvent[]> {
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(new OmpRecordDecoder({ deviceSurfaceServers: () => servers }));
  const sessionId = "session_device_surface_capture";
  const observed: NormalizedSessionEvent[] = [];
  let sequence = 0;
  for (const [callId, path] of invocations) {
    const payloads = [
      {
        type: "custom",
        customType: "tool_execution_start",
        data: { toolCallId: callId, toolName: "write", args: { path } },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: callId,
              name: "write",
              arguments: { path, content: '{"query":"rows"}' },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "write",
          content: [{ type: "text", text: "{}" }],
        },
      },
    ];
    for (const payload of payloads) {
      sequence += 1;
      const results = await pipeline.processRecord(
        {
          recordId: `rec_${sequence}`,
          sessionId,
          harnessId: "omp",
          sequenceNumber: sequence,
          timestamp: "2026-09-18T10:00:00.000Z",
          recordType: "transcript_line",
          rawPayload: payload,
          cursor: {
            offset: sequence * 10,
            line: sequence,
            sequence,
            timestamp: "2026-09-18T10:00:00.000Z",
          },
          metadata: {},
        },
        { sessionId, harnessId: "omp", workspaceId: "ws_native" },
      );
      for (const result of results) {
        if (result.status !== "success" || result.isDuplicate) continue;
        observed.push(recorder.observe(result.event, { workspaceId: "ws_native" }));
      }
    }
  }
  return observed;
}

/** The carrier recorded for each call of an observed session, in order. */
function carriersOf(events: NormalizedSessionEvent[]) {
  return events.filter((entry) => entry.type === "tool_call").map((entry) => carrierOf(entry)!);
}

describe("the connection a callable was reached over", () => {
  it("records the tool and the connection behind each device path, never a split of the path", async () => {
    // `alpha` and `alpha_beta` both expose `run`, and `alpha` also exposes a name containing
    // underscores. A naive split of the paths would record the middle call as `beta_run`.
    const observed = await captureDeviceSurface(
      [
        ["call_alpha", "xd://mcp__alpha_run"],
        ["call_alpha_beta", "xd://mcp__alpha_beta_run"],
        ["call_deep", "xd://mcp__alpha_deep_tool_name"],
      ],
      ["alpha", "alpha_beta"],
    );

    const carriers = carriersOf(observed);
    expect(carriers.map((carrier) => [carrier.name, carrier.connection])).toEqual([
      ["run", "alpha"],
      ["run", "alpha_beta"],
      ["deep_tool_name", "alpha"],
    ]);
    // The invocation's own arguments are what was recorded — not the transport's device path.
    expect(carriers[0]!.origins).toHaveProperty("query");
    expect(carriers[0]!.origins).not.toHaveProperty("path");
  });

  it("keeps the harness-exposed name opaque when no configured server owns the path", async () => {
    const observed = await captureDeviceSurface(
      [["call_unknown", "xd://mcp__unconfigured_run"]],
      ["alpha", "alpha_beta"],
    );

    const carriers = carriersOf(observed);
    expect(carriers).toHaveLength(1);
    // The call is still captured, exactly as the harness spelled it, and with no connection: an
    // unidentified path is not turned into a guess.
    expect(carriers[0]!.name).toBe("write");
    expect(carriers[0]!.connection).toBeUndefined();
    expect(observed.some((entry) => entry.type === "tool_discovery")).toBe(false);
  });

  it("leaves the connection absent when discovery reported none, and still records the call", () => {
    const { events } = record([
      discovery([{ name: "vendor.fetch", inputSchema: { type: "object" } }]),
      call(1, "vendor.fetch", { source: "alpha-feed" }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier!.name).toBe("vendor.fetch");
    expect(carrier!.runtime).toBe(RESIN_HARNESS_TOOL_RUNTIME);
    expect(carrier!.connection).toBeUndefined();
    expect(carrier!.inputSchema).toEqual({ type: "object" });
  });

  it("keeps the connection a call itself records when no discovery reported one", () => {
    // A device-surface invocation whose start marker never arrived still resolved its path: the
    // call carries the connection, and the carrier keeps it.
    const recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() });
    const observed = recorder.observe(
      event({
        eventId: "evt_call_connection",
        type: "tool_call",
        callId: "call_connection",
        toolName: "run",
        connection: "alpha",
        parameters: { query: "rows" },
        causalRef: { causalSequence: 1, parentId: null },
      }),
      { workspaceId: "ws_native" },
    );

    const carrier = carrierOf(observed)!;
    expect(carrier.name).toBe("run");
    expect(carrier.connection).toBe("alpha");
  });

  it("never lets one session's discovery supply another session's connection", () => {
    const { events } = record([
      discovery([{ name: "run", provider: "alpha" }], "session_a"),
      call(1, "run", { query: "rows" }, 0, "session_a"),
      discovery([{ name: "run", provider: "alpha_beta" }], "session_b"),
      call(2, "run", { query: "rows" }, 0, "session_b"),
      // A session that saw no discovery at all keeps no connection, even though another did.
      call(3, "run", { query: "rows" }, 0, "session_c"),
    ]);

    expect(carrierOf(events[1]!)!.connection).toBe("alpha");
    expect(carrierOf(events[3]!)!.connection).toBe("alpha_beta");
    expect(carrierOf(events[4]!)!.connection).toBeUndefined();
  });
});

function referenceOf(origin: { type: string; reference?: string }): string {
  if (origin.type !== "private" || origin.reference === undefined) {
    throw new Error(`expected a local reference, got ${origin.type}`);
  }
  return origin.reference;
}

async function captureCodexNativeCall(
  sessionId: string,
  callId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  nativeOutput: unknown,
  nativeOutputStatus?: string,
): Promise<{ events: NormalizedSessionEvent[]; store: InMemoryPrivateValueStore }> {
  const timestamp = "2026-09-23T12:00:00.000Z";
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(new CodexRecordDecoder());
  const store = new InMemoryPrivateValueStore();
  const workflowRecorder = new WorkflowCallRecorder({ privateValues: store });
  const computationRecorder = createComputationEvidenceRecorder();
  const events = [
    computationRecorder.observe(
      workflowRecorder.observe(
        event({
          eventId: `evt_${callId}_user`,
          sessionId,
          type: "message",
          role: "user",
          content: "run this process and capture its output",
          causalRef: { causalSequence: 1, parentId: null },
        }),
        { workspaceId: "ws_codex_native" },
      ),
    ),
  ];
  const nativeRecords = [
    {
      type: "session_meta",
      payload: {
        session_id: `native_session_${callId}`,
        id: `native_root_${callId}`,
        cwd: "/workspace/demo",
      },
    },
    {
      type: "turn_context",
      payload: {
        turn_id: `turn_${callId}`,
        cwd: "/workspace/demo",
        model: "gpt-6-luna",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        id: `item_${callId}`,
        call_id: callId,
        name: toolName,
        arguments: JSON.stringify(parameters),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: nativeOutput,
        ...(nativeOutputStatus === undefined ? {} : { status: nativeOutputStatus }),
      },
    },
  ] as const;

  for (const [index, native] of nativeRecords.entries()) {
    const ordinal = index + 1;
    const record: RawHarnessRecord = {
      recordId: `rec_${sessionId}_${ordinal}`,
      sessionId,
      harnessId: "codex-cli",
      sequenceNumber: ordinal,
      recordType: "transcript_line",
      timestamp,
      rawPayload: JSON.stringify({ timestamp, ordinal, ...native }),
      cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
      metadata: {},
    };
    const normalized = await pipeline.processRecord(record, {
      sessionId,
      harnessId: "codex-cli",
      workspaceId: "ws_codex_native",
    });
    for (const result of normalized) {
      if (result.status !== "success" || result.isDuplicate) continue;
      events.push(
        computationRecorder.observe(
          workflowRecorder.observe(result.event, { workspaceId: "ws_codex_native" }),
        ),
      );
    }
  }
  return { events, store };
}

describe("native Codex rollout workflow and computation capture", () => {
  it("records generic and Codex shell calls through normalization with honest output and outcomes", async () => {
    const command = "python3 -c 'print(6)'";
    const stdout = "6\n";
    const display = `Chunk ID: smoke\nWall time: 0.01s\nProcess exited with code 0\nFinal output:\n${stdout}`;
    const completedCalls = [
      {
        sessionId: "codex-exec-command-capture",
        callId: "codex_exec_command",
        toolName: "exec_command",
        parameters: { cmd: command },
      },
    ];

    for (const turn of completedCalls) {
      const captured = await captureCodexNativeCall(
        turn.sessionId,
        turn.callId,
        turn.toolName,
        turn.parameters,
        display,
      );
      const callEvent = captured.events.find((entry) => entry.type === "tool_call");
      const resultEvent = captured.events.find((entry) => entry.type === "tool_result");
      if (callEvent?.type !== "tool_call" || resultEvent?.type !== "tool_result") {
        throw new Error("Codex rollout did not produce a matched tool call and result");
      }
      expect(callEvent.sessionId).toBe(turn.sessionId);
      expect(callEvent.timestamp).toBe("2026-09-23T12:00:00.000Z");
      expect(callEvent.callId).toBe(turn.callId);
      expect(callEvent.toolName).toBe(turn.toolName);
      expect(callEvent.parameters).toEqual(turn.parameters);
      expect((callEvent.metadata?.codexNative as Record<string, unknown> | undefined)?.cwd).toBe(
        "/workspace/demo",
      );
      expect(resultEvent.sessionId).toBe(turn.sessionId);
      expect(resultEvent.timestamp).toBe("2026-09-23T12:00:00.000Z");
      expect(resultEvent.callId).toBe(callEvent.callId);
      expect(resultEvent.toolName).toBe(callEvent.toolName);
      expect(resultEvent.result).toBe(stdout);
      expect(resultEvent.isError).toBe(false);
      expect(
        (resultEvent.metadata?.codexNative as Record<string, unknown> | undefined)?.outcome,
      ).toBe("completed");

      const carrier = carrierOf(callEvent);
      expect(carrier?.program).toMatchObject({ kind: "shell" });
      expect(carrier?.program?.argument).toBe(Object.keys(turn.parameters)[0]);
      const evidence = readComputationEvidence(
        resultEvent.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
      );
      expect(evidence?.observation).toMatchObject({
        callId: turn.callId,
        status: "success",
        resultEventId: resultEvent.eventId,
      });
      // Print-only source is captured successfully but is not substantive computation.
      expect(isSubstantiveComputationEvidence(evidence)).toBe(false);

      const recipe = recordCallsFromEvents(turn.sessionId, captured.events);
      expect(recipe?.workflow.baseline?.observed).toHaveLength(1);
      expect(
        resolvePrivateReference(captured.store, recipe!.workflow.baseline!.observed[0]!.reference),
      ).toBe(stdout);
      const projected = captured.events.map((entry) => projectEventToMetadataOnly(entry));
      const metadataOnlyResult = projected.find((entry) => entry.type === "tool_result");
      expect(
        metadataOnlyResult?.metadata?.[RESIN_LOCAL_WORKFLOW_RESULT_SUPPRESSED_METADATA_KEY],
      ).toBeUndefined();
      const projectedRecipe = recordCallsFromEvents(turn.sessionId, projected);
      expect(projectedRecipe?.workflow.baseline?.observed).toHaveLength(1);
      expect(
        resolvePrivateReference(
          captured.store,
          projectedRecipe!.workflow.baseline!.observed[0]!.reference,
        ),
      ).toBe(stdout);
    }

    const genericSession = "codex-generic-command-capture";
    const generic = await captureCodexNativeCall(
      genericSession,
      "codex_generic_command",
      "custom_process_runner",
      { commandLine: command },
      "unframed generic process output",
    );
    const genericCall = generic.events.find((entry) => entry.type === "tool_call");
    const genericResult = generic.events.find((entry) => entry.type === "tool_result");
    if (genericCall?.type !== "tool_call" || genericResult?.type !== "tool_result") {
      throw new Error("Generic native command did not produce a matched call and result");
    }
    expect(genericCall.parameters).toEqual({ commandLine: command });
    expect(carrierOf(genericCall)?.program).toMatchObject({
      kind: "shell",
      argument: "commandLine",
    });
    const genericEvidence = readComputationEvidence(
      genericCall.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
    );
    expect(genericEvidence?.observation).toMatchObject({
      callId: "codex_generic_command",
      kind: "invocation",
      status: "pending",
    });
    expect(genericEvidence?.program.complete).toBe(true);
    expect(isSubstantiveComputationEvidence(genericEvidence)).toBe(false);
    expect(genericResult.isError).toBe(false);
    expect(genericResult.result).toBe("unframed generic process output");
    expect(
      (genericResult.metadata?.codexNative as Record<string, unknown> | undefined)?.outcome,
    ).toBe("completed");
    expect(
      isSubstantiveComputationEvidence(
        readComputationEvidence(genericResult.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
      ),
    ).toBe(false);
    const genericRecipe = recordCallsFromEvents(genericSession, generic.events);
    expect(genericRecipe?.workflow.baseline?.observed).toHaveLength(1);
    expect(
      resolvePrivateReference(
        generic.store,
        genericRecipe!.workflow.baseline!.observed[0]!.reference,
      ),
    ).toBe("unframed generic process output");

    for (const [suffix, nativeOutput, expectedOutcome, expectedPublicResult] of [
      [
        "unknown",
        "volatile execution display without a terminal status",
        "unknown",
        "volatile execution display without a terminal status",
      ],
      [
        "running",
        "Chunk ID: smoke\nWall time: 0.01s\nProcess running with session ID 123\n",
        "running",
        "",
      ],
    ] as const) {
      const sessionId = `codex-${suffix}-capture`;
      const captured = await captureCodexNativeCall(
        sessionId,
        `codex_${suffix}_call`,
        "exec_command",
        { cmd: command },
        nativeOutput,
      );
      const resultEvent = captured.events.find((entry) => entry.type === "tool_result");
      if (resultEvent?.type !== "tool_result") {
        throw new Error("Codex rollout did not produce its terminal result");
      }
      expect(resultEvent.isError).toBe(false);
      expect(resultEvent.result).toBe(expectedPublicResult);
      expect(
        (resultEvent.metadata?.codexNative as Record<string, unknown> | undefined)?.outcome,
      ).toBe(expectedOutcome);
      expect(
        isSubstantiveComputationEvidence(
          readComputationEvidence(resultEvent.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
        ),
      ).toBe(false);
      expect(recordCallsFromEvents(sessionId, captured.events)?.workflow.baseline).toBeUndefined();

      const replayRecorder = new WorkflowCallRecorder({
        privateValues: new InMemoryPrivateValueStore(),
      });
      const replayed = structuredClone(captured.events).map((entry) =>
        replayRecorder.observe(entry, { workspaceId: "ws_codex_native" }),
      );
      expect(recordCallsFromEvents(sessionId, replayed)?.workflow.baseline).toBeUndefined();

      const projected = captured.events.map((entry) => projectEventToMetadataOnly(entry));
      const projectedResult = projected.find((entry) => entry.type === "tool_result");
      expect(projectedResult?.type === "tool_result" ? projectedResult.result : undefined).toBe(
        undefined,
      );
      expect(
        isSubstantiveComputationEvidence(
          projectedResult?.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
        ),
      ).toBe(false);
      expect(recordCallsFromEvents(sessionId, projected)?.workflow.baseline).toBeUndefined();
    }

    const failed = await captureCodexNativeCall(
      "codex-nonzero-capture",
      "codex_nonzero_call",
      "exec_command",
      { cmd: command },
      "Chunk ID: smoke\nWall time: 0.01s\nProcess exited with code 7\nFinal output:\nprogram error\n",
    );
    const failedResult = failed.events.find((entry) => entry.type === "tool_result");
    if (failedResult?.type !== "tool_result") {
      throw new Error("Codex rollout did not produce its failed result");
    }
    expect(failedResult.isError).toBe(true);
    expect(failedResult.result).toBe("program error\n");
    expect(
      (failedResult.metadata?.codexNative as Record<string, unknown> | undefined)?.outcome,
    ).toBe("failed");
    expect(
      readComputationEvidence(failedResult.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY])?.observation
        .status,
    ).toBe("error");
    expect(
      recordCallsFromEvents("codex-nonzero-capture", failed.events)?.workflow.baseline,
    ).toBeUndefined();
    const projectedFailure = projectEventToMetadataOnly(failedResult);
    if (projectedFailure.type !== "tool_result") {
      throw new Error("Projected Codex result lost its tool-result identity");
    }
    expect(projectedFailure.isError).toBe(true);
    expect(
      projectedFailure.metadata?.[RESIN_LOCAL_WORKFLOW_RESULT_SUPPRESSED_METADATA_KEY],
    ).toBeUndefined();
    expect(
      readComputationEvidence(projectedFailure.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY])
        ?.observation.status,
    ).toBe("error");

    for (const [suffix, parameters] of [
      ["ambiguous-aliases", { command: "python3 -c 'print(1)'", cmd: "python3 -c 'print(2)'" }],
      ["structured-argv", { args: ["python3", "-c", "print(1 + 1)"] }],
    ] as const) {
      const sessionId = `codex-${suffix}-capture`;
      const captured = await captureCodexNativeCall(
        sessionId,
        `codex_${suffix}_call`,
        "custom_process_runner",
        parameters,
        "result without command evidence",
      );
      const callEvent = captured.events.find((entry) => entry.type === "tool_call");
      if (callEvent?.type !== "tool_call") {
        throw new Error("Codex rollout did not produce its native tool call");
      }
      expect(carrierOf(callEvent)?.program).toBeUndefined();
      expect(extractComputationSourceFrames(callEvent)).toEqual([]);
    }
  });

  it("suppresses an explicit structured truncated-result status flag", async () => {
    const sessionId = "codex-explicit-truncated-flag-capture";
    const captured = await captureCodexNativeCall(
      sessionId,
      "codex_explicit_truncated_flag_call",
      "exec_command",
      { cmd: "python3 -c 'print(1)'" },
      "partial stdout",
      "truncated",
    );
    const resultEvent = captured.events.find((entry) => entry.type === "tool_result");
    if (resultEvent?.type !== "tool_result") {
      throw new Error("Codex rollout did not produce its structured truncated result");
    }
    expect(resultEvent.result).toBe("partial stdout");
    expect(resultEvent.isError).toBe(false);
    expect(
      (resultEvent.metadata?.codexNative as Record<string, unknown> | undefined)?.outcome,
    ).toBe("truncated");
    expect(
      isSubstantiveComputationEvidence(
        readComputationEvidence(resultEvent.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
      ),
    ).toBe(false);
    expect(recordCallsFromEvents(sessionId, captured.events)?.workflow.baseline).toBeUndefined();

    const projected = captured.events.map((entry) => projectEventToMetadataOnly(entry));
    expect(recordCallsFromEvents(sessionId, projected)?.workflow.baseline).toBeUndefined();
  });

  it("keeps unknown native-result suppression through metadata projection and JSON reload", async () => {
    const sessionId = "codex-unknown-projection-capture";
    const captured = await captureCodexNativeCall(
      sessionId,
      "codex_unknown_projection_call",
      "exec_command",
      { cmd: "python3 -c 'print(1)'" },
      "unclassified rollout result display",
    );
    const sourceResult = captured.events.find((entry) => entry.type === "tool_result");
    if (sourceResult?.type !== "tool_result") {
      throw new Error("Codex rollout did not produce its unknown result");
    }
    expect(
      (sourceResult.metadata?.codexNative as Record<string, unknown> | undefined)?.outcome,
    ).toBe("unknown");

    const projected = captured.events.map((entry) => projectEventToMetadataOnly(entry));
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("codexNative");
    expect(serialized).not.toContain("unclassified rollout result display");
    const reloaded = JSON.parse(serialized) as NormalizedSessionEvent[];
    const reloadedResult = reloaded.find((entry) => entry.type === "tool_result");
    if (reloadedResult?.type !== "tool_result") {
      throw new Error("Metadata-only reload lost the unknown result event");
    }
    expect(reloadedResult.result).toBeUndefined();
    expect(reloadedResult.metadata?.[RESIN_LOCAL_WORKFLOW_RESULT_SUPPRESSED_METADATA_KEY]).toBe(
      true,
    );
    expect(isLocalWorkflowResultSuppressed(reloadedResult)).toBe(true);

    const workflowRecorder = new WorkflowCallRecorder({
      privateValues: new InMemoryPrivateValueStore(),
    });
    const computationRecorder = createComputationEvidenceRecorder();
    const replayed = reloaded.map((entry) =>
      workflowRecorder.observe(computationRecorder.observe(entry), {
        workspaceId: "ws_codex_native",
      }),
    );
    const replayedResult = replayed.find((entry) => entry.type === "tool_result");
    if (replayedResult?.type !== "tool_result") {
      throw new Error("Fresh recorders did not preserve the unknown result event");
    }
    expect(isLocalWorkflowResultSuppressed(replayedResult)).toBe(true);
    expect(
      isSubstantiveComputationEvidence(
        readComputationEvidence(replayedResult.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]),
      ),
    ).toBe(false);
    expect(recordCallsFromEvents(sessionId, replayed)?.workflow.baseline).toBeUndefined();
  });
});
