import {
  COMPUTATION_IR_LIMITS,
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  readComputationEvidence,
} from "@resin/contracts";
import {
  type CollectedOmpFixtureToolResult,
  type ComputationFixtureVariant,
  buildComputationFixtureFamilies,
  collectOmpFixtureToolCalls,
  collectOmpFixtureToolResults,
} from "@resin/test-fixtures";
import { describe, expect, it } from "vitest";
import { createComputationEvidenceRecorder } from "../../../src/analytics/computation/recorder.js";
import type { ComputationEvidenceRecorder } from "../../../src/analytics/computation/recorder.js";

const SCHEMA_VERSION = "1.0.0" as const;

function causal(sequence: number): NormalizedSessionEvent["causalRef"] {
  return { parentId: null, causalSequence: sequence };
}

function redaction(fields: string[] = []): NormalizedSessionEvent["redaction"] {
  return {
    isRedacted: fields.length > 0,
    redactedFields: fields,
    redactionStrategy: fields.length > 0 ? "drop" : "none",
    scrubbedPatterns: [],
  };
}

function toolCall(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  sequence: number;
}): NormalizedSessionEvent {
  return {
    eventId: `evt_call_${options.callId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["parameters"]),
    metadata: { scenarioId: options.sessionId },
    type: "tool_call",
    callId: options.callId,
    toolName: options.toolName,
    parameters: options.parameters,
    isShadow: false,
  } as NormalizedSessionEvent;
}

function toolResult(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  sequence: number;
  result?: unknown;
  isError?: boolean;
}): NormalizedSessionEvent {
  return {
    eventId: `evt_result_${options.callId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["result"]),
    metadata: { scenarioId: options.sessionId },
    type: "tool_result",
    callId: options.callId,
    toolName: options.toolName,
    result: options.result ?? "",
    isError: options.isError ?? false,
    executionDurationMs: 5,
    isShadow: false,
  } as NormalizedSessionEvent;
}

function commandExec(options: {
  sessionId: string;
  command: string;
  sequence: number;
  exitCode?: number;
}): NormalizedCommandExecEvent {
  return {
    eventId: `evt_cmd_${options.sessionId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 2, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["command", "args", "stdout"]),
    metadata: { scenarioId: options.sessionId },
    type: "command_exec",
    command: options.command,
    args: [],
    exitCode: options.exitCode ?? 0,
    durationMs: 5,
  };
}

function evidenceOf(event: NormalizedSessionEvent): unknown {
  return event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
}

function readOf(event: NormalizedSessionEvent) {
  return readComputationEvidence(evidenceOf(event));
}

function variantOf(familyId: string, kind: string): ComputationFixtureVariant {
  const family = buildComputationFixtureFamilies().find((entry) => entry.familyId === familyId);
  if (family === undefined) {
    throw new Error(`unknown fixture family ${familyId}`);
  }
  const variant = family.variants.find((entry) => entry.kind === kind);
  if (variant === undefined) {
    throw new Error(`no ${kind} variant in ${familyId}`);
  }
  return variant;
}

function argsOf(variant: ComputationFixtureVariant, callId: string): Record<string, unknown> {
  const calls = collectOmpFixtureToolCalls(variant.records);
  const call = calls.find((candidate) => candidate.callId === callId);
  if (call === undefined) {
    throw new Error(`no fixture call ${callId}`);
  }
  return call.toolArguments as Record<string, unknown>;
}

function toolNameOf(variant: ComputationFixtureVariant, callId: string): string {
  const calls = collectOmpFixtureToolCalls(variant.records);
  const call = calls.find((candidate) => candidate.callId === callId);
  if (call === undefined) {
    throw new Error(`no fixture call ${callId}`);
  }
  return call.toolName;
}

function byCallIdFromToolResults(
  results: CollectedOmpFixtureToolResult[],
): Record<string, CollectedOmpFixtureToolResult> {
  const record: Record<string, CollectedOmpFixtureToolResult> = {};
  for (const result of results) {
    record[result.callId] = result;
  }
  return record;
}

function evalCall(options: {
  sessionId: string;
  callId: string;
  code: string;
  sequence: number;
  reset?: boolean;
}): NormalizedSessionEvent {
  return toolCall({
    sessionId: options.sessionId,
    callId: options.callId,
    toolName: "eval",
    parameters: {
      language: "python",
      code: options.code,
      ...(options.reset === true ? { reset: true } : {}),
    },
    sequence: options.sequence,
  });
}

function observeEval(options: {
  recorder: ComputationEvidenceRecorder;
  sessionId: string;
  callId: string;
  code: string;
  sequence: number;
  reset?: boolean;
}) {
  const call = options.recorder.observe(
    evalCall({
      sessionId: options.sessionId,
      callId: options.callId,
      code: options.code,
      sequence: options.sequence,
      ...(options.reset === true ? { reset: true } : {}),
    }),
  );
  const result = options.recorder.observe(
    toolResult({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "eval",
      sequence: options.sequence + 1,
    }),
  );
  return { call, result, evidence: readOf(result) };
}

function observeReadFile(options: {
  recorder: ComputationEvidenceRecorder;
  sessionId: string;
  callId: string;
  path: string;
  source: string;
  sequence: number;
}) {
  options.recorder.observe(
    toolCall({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "read",
      parameters: { path: options.path },
      sequence: options.sequence,
    }),
  );
  return options.recorder.observe(
    toolResult({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "read",
      result: options.source,
      sequence: options.sequence + 1,
    }),
  );
}

function sourceFor(name: string, bytes: number): string {
  const prefix = `def ${name}(value):\n    total = value + 1\n`;
  const fillerLine = `    # ${name} private padding\n`;
  let body = "";
  while (Buffer.byteLength(`${prefix}${body}    return total\n`, "utf8") < bytes) {
    body += fillerLine;
  }
  return `${prefix}${body}    return total\n`;
}

function strongStateContains(root: unknown, needle: string): boolean {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes(needle)) {
        return true;
      }
      continue;
    }
    if (typeof value !== "object" || value === null) {
      continue;
    }
    if (value instanceof WeakRef || seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        stack.push(key, entry);
      }
      continue;
    }
    if (value instanceof Set) {
      for (const entry of value) {
        stack.push(entry);
      }
      continue;
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) {
        stack.push(descriptor.value);
      }
    }
  }

  return false;
}

describe("ComputationEvidenceRecorder retention", () => {
  it("keeps strong evidence graphs free of WeakRef state, settled invocation source, and raw results", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "strong-graph-privacy";
    const sourceSecret = "SOURCE_ONLY_SECRET_DO_NOT_RETAIN";
    const resultSecret = "RAW_RESULT_SECRET_DO_NOT_RETAIN";

    recorder.observe(
      evalCall({
        sessionId,
        callId: "private-invocation",
        code: `print(21 * 2)\n# ${sourceSecret}\n`,
        sequence: 1,
      }),
    );
    const observed = recorder.observe(
      toolResult({
        sessionId,
        callId: "private-invocation",
        toolName: "eval",
        result: { stdout: resultSecret, nested: { arbitrary: sourceSecret } },
        sequence: 2,
      }),
    );
    const evidence = readOf(observed);
    expect(evidence?.observation.status).toBe("success");
    expect(evidence?.observation.kind).toBe("invocation");
    expect(evidence?.program.complete).toBe(true);
    const serializedEvidence = JSON.stringify(evidence);
    expect(serializedEvidence).not.toContain(sourceSecret);
    expect(serializedEvidence).not.toContain(resultSecret);
    expect(strongStateContains(recorder, sourceSecret)).toBe(false);
    expect(strongStateContains(recorder, resultSecret)).toBe(false);
  });

  it("evicts persisted file source when the private source cap is exceeded", () => {
    const sourceA = `${sourceFor("cached_helper", 2_048)}print(cached_helper(1))\n`;
    const sourceB = `${sourceFor("expiring_helper", 2_048)}print(expiring_helper(1))\n`;
    const maxRetainedSourceBytes = Math.max(
      1,
      Buffer.byteLength(sourceA, "utf8") + Buffer.byteLength(sourceB, "utf8") - 1,
    );
    const recorder = createComputationEvidenceRecorder({ maxRetainedSourceBytes });
    const sessionId = "persisted-file-eviction";

    const readOne = observeReadFile({
      recorder,
      sessionId,
      callId: "call-read-one",
      path: "cached_helper.py",
      source: sourceA,
      sequence: 1,
    });
    expect(readOf(readOne)?.observation.status).toBe("success");

    const executeCachedBeforeEviction = recorder.observe(
      commandExec({
        sessionId,
        command: "python3 cached_helper.py",
        sequence: 3,
      }),
    );
    const cachedBeforeEviction = readOf(executeCachedBeforeEviction);
    expect(cachedBeforeEviction?.observation.status).toBe("success");
    expect(cachedBeforeEviction?.observation.kind).toBe("invocation");

    const readTwo = observeReadFile({
      recorder,
      sessionId,
      callId: "call-read-two",
      path: "expiring_helper.py",
      source: sourceB,
      sequence: 5,
    });
    expect(readOf(readTwo)?.observation.status).toBe("success");

    const executeCachedAfterEviction = recorder.observe(
      commandExec({
        sessionId,
        command: "python3 cached_helper.py",
        sequence: 7,
      }),
    );
    expect(evidenceOf(executeCachedAfterEviction)).toBeUndefined();

    const executeExpiringAfterEviction = recorder.observe(
      commandExec({
        sessionId,
        command: "python3 expiring_helper.py",
        sequence: 8,
      }),
    );
    const expiringAfterEviction = readOf(executeExpiringAfterEviction);
    expect(expiringAfterEviction?.observation.status).toBe("success");
    expect(expiringAfterEviction?.observation.kind).toBe("invocation");
  });

  it("enforces the retained-source cap globally across read-result file caches in separate sessions", () => {
    const sourceA = sourceFor("older_cached_helper", 2_048);
    const sourceB = sourceFor("newer_cached_helper", 2_048);
    const recorder = createComputationEvidenceRecorder({ maxRetainedSourceBytes: 3_000 });

    const readA = observeReadFile({
      recorder,
      sessionId: "global-cap-a",
      callId: "read-a",
      path: "older_cached_helper.py",
      source: sourceA,
      sequence: 1,
    });
    expect(readOf(readA)?.observation.status).toBe("success");

    const executeA = recorder.observe(
      commandExec({
        sessionId: "global-cap-a",
        command: "python3 older_cached_helper.py",
        sequence: 3,
      }),
    );
    expect(readOf(executeA)?.observation.status).toBe("success");

    const readB = observeReadFile({
      recorder,
      sessionId: "global-cap-b",
      callId: "read-b",
      path: "newer_cached_helper.py",
      source: sourceB,
      sequence: 1,
    });
    expect(readOf(readB)?.observation.status).toBe("success");

    const useOldAfterEviction = observeEval({
      recorder,
      sessionId: "global-cap-a",
      callId: "use-older-after-eviction",
      code: "from older_cached_helper import older_cached_helper\nanswer = older_cached_helper(1)\n",
      sequence: 5,
    });
    expect(useOldAfterEviction.evidence?.observation.status).toBe("success");
    expect(useOldAfterEviction.evidence?.dependencies).toHaveLength(0);

    const useNewAfterEviction = observeEval({
      recorder,
      sessionId: "global-cap-b",
      callId: "use-newer-after-eviction",
      code: "from newer_cached_helper import newer_cached_helper\nanswer = newer_cached_helper(1)\n",
      sequence: 3,
    });
    expect(useNewAfterEviction.evidence?.observation.status).toBe("success");
    expect(useNewAfterEviction.evidence?.dependencies).toHaveLength(1);
  });

  it("does not let oversized maxFrameBytes overrides enlarge the pinned private frame cap", () => {
    const recorder = createComputationEvidenceRecorder({ maxFrameBytes: Number.MAX_SAFE_INTEGER });
    const sessionId = "invalid-override-cap";
    const oversizeSource = `def oversized(value):\n    return value\n${"# private padding\n".repeat(20_000)}`;

    const call = recorder.observe(
      evalCall({
        sessionId,
        callId: "oversize-cell",
        code: oversizeSource,
        sequence: 1,
      }),
    );
    expect(evidenceOf(call)).toBeUndefined();

    const result = recorder.observe(
      toolResult({ sessionId, callId: "oversize-cell", toolName: "eval", sequence: 2 }),
    );
    expect(evidenceOf(result)).toBeUndefined();
  });

  it("releases persistent definition accounting on reset before retaining later helpers", () => {
    const sourceA = sourceFor("released_helper", 2_000);
    const sourceB = sourceFor("retained_after_reset", 2_000);
    const maxRetainedSourceBytes =
      Buffer.byteLength(sourceA, "utf8") + Buffer.byteLength(sourceB, "utf8") + 1_000;
    const recorder = createComputationEvidenceRecorder({ maxRetainedSourceBytes });
    const sessionId = "reset-accounting";

    const first = observeEval({
      recorder,
      sessionId,
      callId: "define-released",
      code: sourceA,
      sequence: 1,
    });
    expect(first.evidence?.observation.status).toBe("success");
    expect(first.evidence?.observation.kind).toBe("definition");

    recorder.observe(
      evalCall({
        sessionId,
        callId: "reset-kernel",
        code: "pass\n",
        reset: true,
        sequence: 3,
      }),
    );
    recorder.observe(
      toolResult({ sessionId, callId: "reset-kernel", toolName: "eval", sequence: 4 }),
    );

    const second = observeEval({
      recorder,
      sessionId,
      callId: "define-retained-after-reset",
      code: sourceB,
      sequence: 5,
    });
    expect(second.evidence?.observation.status).toBe("success");

    const useSecond = observeEval({
      recorder,
      sessionId,
      callId: "use-retained-after-reset",
      code: "answer = retained_after_reset(41)\n",
      sequence: 7,
    });
    expect(useSecond.evidence?.observation.status).toBe("success");
    expect(useSecond.evidence?.dependencies).toHaveLength(1);
  });

  it("keeps every fixture-produced evidence carrier within the wire cap", () => {
    expect(COMPUTATION_IR_LIMITS.serializedBytes).toBe(65_536);
    const recorder = createComputationEvidenceRecorder();

    const families = buildComputationFixtureFamilies();
    for (const family of families) {
      for (const variant of family.variants) {
        const calls = collectOmpFixtureToolCalls(variant.records);
        const resultLookup = byCallIdFromToolResults(collectOmpFixtureToolResults(variant.records));

        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index];
          const result = resultLookup[call.callId];
          if (result === undefined) {
            continue;
          }

          recorder.observe(
            toolCall({
              sessionId: variant.sessionId,
              callId: call.callId,
              toolName: call.toolName,
              parameters: call.toolArguments as Record<string, unknown>,
              sequence: 2 * index + 1,
            }),
          );
          const observed = recorder.observe(
            toolResult({
              sessionId: variant.sessionId,
              callId: call.callId,
              toolName: call.toolName,
              sequence: 2 * index + 2,
              isError: result.isError,
              result: result.result,
            }),
          );
          const evidence = evidenceOf(observed);
          if (evidence === undefined) {
            continue;
          }

          const bytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
          expect(bytes).toBeLessThanOrEqual(COMPUTATION_IR_LIMITS.serializedBytes);
          expect(readOf(observed)).toBeDefined();
        }
        recorder.clear();
      }
    }
  });
});
