import { type NormalizedSessionEvent, NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { retainLocalWorkflowPayload } from "../../src/normalization/local-workflow-payload.js";

const SESSION = "native-output-fixture-session";
const WORKSPACE = "native-output-fixture-workspace";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: SESSION,
    timestamp: "2026-09-20T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}

function user(sequence: number): NormalizedSessionEvent {
  return event({
    eventId: `evt_user_${sequence}`,
    type: "message",
    role: "user",
    content: "repeat the fixture work",
    causalRef: { causalSequence: sequence, parentId: null },
  });
}

function call(sequence: number, callId: string): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${callId}`,
    type: "tool_call",
    callId,
    toolName: "eval",
    parameters: { language: "python", code: "print('fixture')" },
    causalRef: { causalSequence: sequence, parentId: null },
  });
}

function nativeResult(
  sequence: number,
  callId: string,
  display: string,
  canonical: string,
  comparison?: "text-trim",
): NormalizedSessionEvent {
  const result = event({
    eventId: `evt_result_${callId}`,
    type: "tool_result",
    callId,
    toolName: "eval",
    result: display,
    isError: false,
    executionDurationMs: 1,
    causalRef: { causalSequence: sequence, parentId: null },
  });
  retainLocalWorkflowPayload(
    result,
    { result: display },
    {
      resultObservation: {
        result: canonical,
        ...(comparison === undefined ? {} : { comparison }),
      },
    },
  );
  return result;
}

describe("source-native output observation", () => {
  it("keeps public display output unchanged while baseline and held-out refs retain their modes", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const exact = "fixture-full-artifact-output\n";
    const projected = "fixture-projected-output";
    const observed = [
      user(1),
      call(2, "call-exact"),
      nativeResult(3, "call-exact", "fixture-display-output", exact),
      user(4),
      call(5, "call-projected"),
      nativeResult(6, "call-projected", "fixture-display-output", projected, "text-trim"),
    ].map((entry) => recorder.observe(entry, { workspaceId: WORKSPACE }));

    const exactPublic = observed.find(
      (entry) => entry.type === "tool_result" && entry.callId === "call-exact",
    );
    const projectedPublic = observed.find(
      (entry) => entry.type === "tool_result" && entry.callId === "call-projected",
    );
    expect(exactPublic?.type === "tool_result" ? exactPublic.result : undefined).toBe(
      "fixture-display-output",
    );
    expect(projectedPublic?.type === "tool_result" ? projectedPublic.result : undefined).toBe(
      "fixture-display-output",
    );
    expect(JSON.stringify(observed)).not.toContain(exact);
    expect(JSON.stringify(observed)).not.toContain(projected);

    const recipe = recordCallsFromEvents("native-output-fixture", observed);
    expect(recipe?.workflow.baseline?.observed).toHaveLength(1);
    expect(recipe?.workflow.heldOut?.observed).toHaveLength(1);
    const baseline = recipe!.workflow.baseline!.observed[0]!;
    const heldOut = recipe!.workflow.heldOut!.observed[0]!;
    expect(baseline.comparison).toBeUndefined();
    expect(heldOut.comparison).toBe("text-trim");
    expect(resolvePrivateReference(store, baseline.reference)).toBe(exact);
    expect(resolvePrivateReference(store, heldOut.reference)).toBe(projected);
    expect(JSON.stringify(recipe!.workflow)).not.toContain(exact);
    expect(JSON.stringify(recipe!.workflow)).not.toContain(projected);
  });

  it("preserves legacy private observations when the same source gains authoritative output", () => {
    const store = new InMemoryPrivateValueStore();
    const authoritative = nativeResult(3, "call-upgrade", "clipped display", "full output\n");
    const capture = (result: NormalizedSessionEvent) => {
      const recorder = new WorkflowCallRecorder({ privateValues: store });
      const events = [user(1), call(2, "call-upgrade"), result].map((entry) =>
        recorder.observe(entry, { workspaceId: WORKSPACE }),
      );
      return recordCallsFromEvents("native-output-upgrade", events)!.workflow.baseline!.observed[0]!
        .reference;
    };
    const legacyReference = capture(structuredClone(authoritative));
    const nativeReference = capture(authoritative);
    expect(resolvePrivateReference(store, legacyReference)).toBe("clipped display");
    expect(resolvePrivateReference(store, nativeReference)).toBe("full output\n");
  });

  it("does not turn an unavailable native artifact into a baseline from clipped display text", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const result = event({
      eventId: "evt_result-unavailable",
      type: "tool_result",
      callId: "call-unavailable",
      toolName: "eval",
      result: "fixture-clipped-display",
      isError: false,
      executionDurationMs: 1,
      causalRef: { causalSequence: 3, parentId: null },
    });
    retainLocalWorkflowPayload(
      result,
      { result: "fixture-clipped-display" },
      { suppressResult: true },
    );
    const observed = [user(1), call(2, "call-unavailable"), result].map((entry) =>
      recorder.observe(entry, { workspaceId: WORKSPACE }),
    );
    const publicResult = observed[2]!;
    expect(publicResult.type === "tool_result" ? publicResult.result : undefined).toBe(
      "fixture-clipped-display",
    );
    const recipe = recordCallsFromEvents("native-output-unavailable", observed);
    expect(recipe?.workflow.baseline).toBeUndefined();
  });
  it("retains actual native output when completion precedes or follows the outer result", () => {
    for (const late of [false, true]) {
      const store = new InMemoryPrivateValueStore();
      const recorder = new WorkflowCallRecorder({ privateValues: store });
      const association = {
        kind: "derived",
        rule: "codex-single-command-start-window-v1",
        callId: "native-call",
        nativeCommandId: "native-1",
        startedAtMs: 2,
        callStartedAtMs: 1,
        callCompletedAtMs: 3,
      };
      const command = event({
        eventId: `native-command-${late}`,
        type: "command_exec",
        command: "/bin/bash",
        args: ["-lc", "printf actual"],
        exitCode: 0,
        stdout: "redacted-display",
        stderr: "",
        cwd: ".",
        durationMs: 1,
        metadata: {
          resinCodexCommandV1: {
            version: 1,
            kind: "command",
            nativeId: "native-1",
            ...(late ? { association } : {}),
          },
        },
        causalRef: { causalSequence: late ? 4 : 2, parentId: null },
      });
      retainLocalWorkflowPayload(command, { stdout: "actual\n", stderr: "" });
      const result = event({
        eventId: `native-result-${late}`,
        type: "tool_result",
        callId: "native-call",
        toolName: "exec",
        result: [{ text: "Script completed" }],
        isError: false,
        executionDurationMs: 1,
        metadata: {
          resinCodexCommandV1: {
            version: 1,
            kind: "result",
            form: "single-command-output",
            status: "completed",
            ...(!late ? { association } : {}),
          },
        },
        causalRef: { causalSequence: late ? 3 : 4, parentId: null },
      });
      const recorded = [
        user(1),
        call(2, "native-call"),
        ...(late ? [result, command] : [command, result]),
      ].map((entry) => recorder.observe(entry, { workspaceId: WORKSPACE }));
      const carrierEvent = recorded.find(
        (entry) =>
          entry.type === (late ? "command_exec" : "tool_result") &&
          (late || entry.type !== "tool_result" || entry.callId === "native-call"),
      );
      const carrier = carrierEvent?.metadata?.workflowResult as
        | { baselineReference?: string; output?: { type: string; hasContent: boolean } }
        | undefined;
      expect(carrier?.output).toEqual({ type: "string", hasContent: true });
      expect(resolvePrivateReference(store, carrier!.baselineReference!)).toBe("actual\n");
      expect(JSON.stringify(recorded)).not.toContain("actual\n");
      if (late) {
        expect(recorded[2]?.metadata?.workflowResult).toBeUndefined();
      }
    }
  });

  it("never turns an unverified or failed native command into a successful baseline", () => {
    for (const exitCode of [1, 0]) {
      const store = new InMemoryPrivateValueStore();
      const recorder = new WorkflowCallRecorder({ privateValues: store });
      const command = event({
        eventId: `native-failure-${exitCode}`,
        type: "command_exec",
        command: "/bin/bash",
        args: ["-lc", "false"],
        exitCode,
        stdout: "",
        stderr: "",
        cwd: ".",
        durationMs: 1,
        metadata: {
          resinCodexCommandV1: {
            version: 1,
            kind: "command",
            nativeId: "other-native",
          },
        },
        causalRef: { causalSequence: 3, parentId: null },
      });
      retainLocalWorkflowPayload(command, { stdout: "", stderr: "" });
      const result = event({
        eventId: `outer-failure-${exitCode}`,
        type: "tool_result",
        callId: "native-call",
        toolName: "exec",
        result: [{ text: "Script completed" }],
        isError: exitCode !== 0,
        executionDurationMs: 1,
        metadata: {
          resinCodexCommandV1: {
            version: 1,
            kind: "result",
            form: "single-command-output",
            status: "completed",
            association: {
              kind: "derived",
              rule: "codex-single-command-start-window-v1",
              callId: "native-call",
              nativeCommandId: exitCode === 1 ? "other-native" : "different-native",
              startedAtMs: 2,
              callStartedAtMs: 1,
              callCompletedAtMs: 4,
            },
          },
        },
        causalRef: { causalSequence: 4, parentId: null },
      });
      const recorded = [user(1), call(2, "native-call"), command, result].map((entry) =>
        recorder.observe(entry, { workspaceId: WORKSPACE }),
      );
      expect(recorded[3]?.metadata?.workflowResult).toBeUndefined();
    }
  });
});
