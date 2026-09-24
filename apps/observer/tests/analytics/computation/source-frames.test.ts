import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type NormalizedToolCallEvent,
  nowIso,
} from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { extractComputationSourceFrames } from "../../../src/analytics/computation/source-frames.js";
import type { LocalComputationModule } from "../../../src/analytics/computation/types.js";

const PY_DEFINITION =
  'def normalize(rows):\n    return [row for row in rows if row["score"] > 0]\n';
const JS_HELPER = "export function stable(value) {\n  return JSON.stringify(value);\n}\n";

function baseHeaders(sequence: number) {
  return {
    eventId: `evt_frame_${sequence.toString().padStart(6, "0")}`,
    schemaVersion: "1.0.0",
    sessionId: "sess_frame_test",
    timestamp: nowIso(),
    causalRef: { causalSequence: sequence },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      redactionStrategy: "none" as const,
      scrubbedPatterns: [] as string[],
    },
  };
}

function asToolCall(event: NormalizedSessionEvent): NormalizedToolCallEvent {
  if (event.type !== "tool_call") {
    throw new Error(`expected tool_call, received ${event.type}`);
  }
  return event;
}

function toolCall(
  sequence: number,
  toolName: string,
  parameters: Record<string, unknown>,
  callId = `call-${sequence}`,
): NormalizedToolCallEvent {
  return asToolCall(
    NormalizedSessionEventSchema.parse({
      ...baseHeaders(sequence),
      type: "tool_call",
      callId,
      toolName,
      parameters,
    }),
  );
}

function shellCall(sequence: number, command: string): NormalizedToolCallEvent {
  return toolCall(sequence, "bash", { command });
}

function fileEdit(sequence: number, filePath: string, operation: "create" | "update" | "patch") {
  return NormalizedSessionEventSchema.parse({
    ...baseHeaders(sequence),
    type: "file_edit",
    filePath,
    operation,
    patch: "@@ -1,2 +1,3 @@",
  });
}

function commandExec(sequence: number, command: string) {
  return NormalizedSessionEventSchema.parse({
    ...baseHeaders(sequence),
    type: "command_exec",
    command,
    args: [],
    exitCode: 0,
    durationMs: 5,
  });
}

function readResult(sequence: number, call: NormalizedToolCallEvent, body: string) {
  return NormalizedSessionEventSchema.parse({
    ...baseHeaders(sequence),
    type: "tool_result",
    callId: call.callId,
    toolName: call.toolName,
    result: body,
    isError: false,
    executionDurationMs: 3,
  });
}

function knownFile(path: string, source: string, language: LocalComputationModule["language"]) {
  return new Map<string, LocalComputationModule>([[path, { path, source, language }]]);
}

describe("extractComputationSourceFrames", () => {
  it("frames an inline eval kernel as persistent source", () => {
    const call = toolCall(1, "eval", { language: "python", code: PY_DEFINITION });
    const frames = extractComputationSourceFrames(call);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      language: "python",
      source: PY_DEFINITION,
      originKind: "inline",
      executionScope: "persistent",
      sourceEventId: call.eventId,
    });
    expect(frames[0]?.rejectionReason).toBeUndefined();
    expect(frames[0]?.fileAction).toBeUndefined();
  });

  it("frames only an adapter-qualified native Codex exec as isolated JavaScript", () => {
    const source = "const value = 42;\ntext(value);\n";
    const nativeExec = asToolCall(
      NormalizedSessionEventSchema.parse({
        ...baseHeaders(36),
        type: "tool_call",
        callId: "call-native-exec",
        toolName: "exec",
        parameters: { raw: source },
        metadata: {
          codexNative: {
            type: "response_item",
            itemType: "custom_tool_call",
            sourceInterface: "codex-exec",
          },
        },
      }),
    );
    expect(extractComputationSourceFrames(nativeExec)).toMatchObject([
      {
        language: "javascript",
        source,
        originKind: "inline",
        executionScope: "isolated",
        sourceInterface: "codex-exec",
      },
    ]);

    const genericExec = toolCall(37, "exec", { raw: source });
    expect(extractComputationSourceFrames(genericExec)).toEqual([]);

    const foreignNamespace = asToolCall(
      NormalizedSessionEventSchema.parse({
        ...nativeExec,
        eventId: "evt_frame_000038",
        callId: "call-38",
        metadata: {
          codexNative: {
            type: "response_item",
            itemType: "custom_tool_call",
            sourceInterface: "codex-exec",
            namespace: "mcp__filesystem",
          },
        },
      }),
    );
    expect(extractComputationSourceFrames(foreignNamespace)).toEqual([]);

    const truncatedExec = asToolCall(
      NormalizedSessionEventSchema.parse({
        ...nativeExec,
        eventId: "evt_frame_000039",
        callId: "call-39",
        parameters: { raw: "const value = 42; ... [TRUNCATED 12 chars]" },
      }),
    );
    expect(extractComputationSourceFrames(truncatedExec)[0]).toMatchObject({
      language: "javascript",
      source: "",
      executionScope: "isolated",
      sourceInterface: "codex-exec",
      rejectionReason: "truncated_source",
    });
  });

  it("carries a persistent kernel reset for the selected language only", () => {
    const pythonReset = extractComputationSourceFrames(
      toolCall(28, "eval", { language: "python", code: "rows = []", reset: true }),
    );
    expect(pythonReset[0]).toMatchObject({
      language: "python",
      source: "rows = []",
      originKind: "inline",
      executionScope: "persistent",
      reset: true,
    });

    const jsReset = extractComputationSourceFrames(
      toolCall(29, "eval", { language: "js", code: "const rows = [];", reset: true }),
    );
    expect(jsReset[0]?.language).toBe("javascript");
    expect(jsReset[0]?.reset).toBe(true);

    // A reset-only cell has no body, but the state boundary is still observed.
    const resetOnly = extractComputationSourceFrames(
      toolCall(30, "eval", { language: "python", reset: true }),
    );
    expect(resetOnly).toHaveLength(1);
    expect(resetOnly[0]).toMatchObject({
      language: "python",
      source: "",
      executionScope: "persistent",
      reset: true,
    });

    // An ordinary cell is not a reset, and an isolated shell/heredoc/file observation never resets.
    expect(
      extractComputationSourceFrames(toolCall(31, "eval", { language: "python", code: "x = 1" }))[0]
        ?.reset,
    ).toBeUndefined();
    for (const frame of extractComputationSourceFrames(shellCall(32, "python3 -c 'x = 1'"))) {
      expect(frame.reset).toBeUndefined();
      expect(frame.executionScope).toBe("isolated");
    }
    const heredoc = extractComputationSourceFrames(shellCall(33, "python3 - <<'PY'\nx = 1\nPY"));
    expect(heredoc[0]?.reset).toBeUndefined();
    const written = extractComputationSourceFrames(
      toolCall(34, "write", { path: "tools/helper.mjs", content: JS_HELPER }),
    );
    expect(written[0]?.reset).toBeUndefined();

    // A rejected truncated body still observes the announced reset boundary.
    const truncatedReset = extractComputationSourceFrames(
      NormalizedSessionEventSchema.parse({
        ...baseHeaders(35),
        type: "tool_call",
        callId: "call-35",
        toolName: "eval",
        parameters: {
          language: "python",
          code: "rows = []... [TRUNCATED 9 chars]",
          reset: true,
        },
      }),
    );
    expect(truncatedReset[0]?.rejectionReason).toBe("truncated_source");
    expect(truncatedReset[0]?.source).toBe("");
    expect(truncatedReset[0]?.reset).toBe(true);
  });

  it("reads the dialect from the language field and never guesses one", () => {
    const js = extractComputationSourceFrames(
      toolCall(2, "eval", { language: "js", code: "const rows = [1, 2];" }),
    );
    expect(js[0]?.language).toBe("javascript");
    expect(js[0]?.executionScope).toBe("persistent");

    const unknown = extractComputationSourceFrames(toolCall(3, "eval", { code: "puts 1" }));
    expect(unknown[0]?.rejectionReason).toBe("unknown_dialect");
    expect(unknown[0]?.source).toBe("");

    const absent = extractComputationSourceFrames(toolCall(4, "eval", { language: "python" }));
    expect(absent).toEqual([]);
  });

  it("treats an isolated interpreter invocation as isolated and never persistent", () => {
    const inline = extractComputationSourceFrames(
      shellCall(5, `python3 -c '${PY_DEFINITION.trimEnd()}'`),
    );
    expect(inline[0]).toMatchObject({
      language: "python",
      originKind: "inline",
      executionScope: "isolated",
    });
    expect(inline[0]?.source).toBe(PY_DEFINITION.trimEnd());

    const nodeEval = extractComputationSourceFrames(shellCall(6, 'node -e "console.log(1 + 1)"'));
    expect(nodeEval[0]).toMatchObject({
      language: "javascript",
      source: "console.log(1 + 1)",
      originKind: "inline",
      executionScope: "isolated",
    });

    const heredoc = extractComputationSourceFrames(
      shellCall(7, "python3 - <<'PY'\nimport json\nprint(json.dumps({}))\nPY"),
    );
    expect(heredoc[0]).toMatchObject({
      language: "python",
      source: "import json\nprint(json.dumps({}))\n",
      originKind: "heredoc",
      executionScope: "isolated",
    });
  });

  it("frames command-bearing calls structurally without a shell-tool name list", () => {
    for (const call of [
      toolCall(80, "exec_command", { cmd: "python3 -c 'print(1 + 1)'" }),
      toolCall(81, "shell_command", { command: "python3 -c 'print(1 + 1)'" }),
      toolCall(82, "custom_process_runner", {
        commandLine: "python3 -c 'print(1 + 1)'",
      }),
    ]) {
      expect(extractComputationSourceFrames(call)[0]).toMatchObject({
        source: "print(1 + 1)",
        language: "python",
        originKind: "inline",
        executionScope: "isolated",
      });
    }

    expect(
      extractComputationSourceFrames(
        toolCall(83, "custom_process_runner", {
          command: "python3 -c 'print(1)'",
          cmd: "python3 -c 'print(2)'",
        }),
      ),
    ).toEqual([]);
    expect(
      extractComputationSourceFrames(
        toolCall(84, "custom_process_runner", {
          args: ["python3", "-c", "print(1 + 1)"],
        }),
      ),
    ).toEqual([]);
  });

  it("fails closed on shell framing it cannot delimit", () => {
    const piped = extractComputationSourceFrames(
      shellCall(8, "python3 -c 'print(1)' | tee out.log"),
    );
    expect(piped[0]?.rejectionReason).toBe("ambiguous_shell");
    expect(piped[0]?.source).toBe("");
    expect(piped[0]?.executionScope).toBe("isolated");

    const redirected = extractComputationSourceFrames(shellCall(9, "python3 - < script.py"));
    expect(redirected[0]?.rejectionReason).toBe("ambiguous_shell");

    const unterminated = extractComputationSourceFrames(
      shellCall(10, "python3 - <<'PY'\nimport json\nprint(1)"),
    );
    expect(unterminated[0]?.rejectionReason).toBe("ambiguous_shell");

    const module = extractComputationSourceFrames(shellCall(11, "python3 -m json.tool data.json"));
    expect(module[0]?.rejectionReason).toBe("ambiguous_shell");

    const shell = extractComputationSourceFrames(shellCall(12, 'sh -c "echo hi"'));
    expect(shell).toEqual([]);
  });

  it("executes a known file as an isolated referenced program and rejects an unknown one", () => {
    const known = knownFile("tools/run.py", PY_DEFINITION, "python");
    const executed = extractComputationSourceFrames(
      shellCall(13, "python3 tools/run.py data.json"),
      {
        knownFiles: known,
      },
    );
    expect(executed[0]).toMatchObject({
      language: "python",
      source: PY_DEFINITION,
      originKind: "referenced_file",
      executionScope: "isolated",
      path: "tools/run.py",
      fileAction: "execute",
    });

    const missing = extractComputationSourceFrames(shellCall(14, "python3 tools/missing.py"), {
      knownFiles: known,
    });
    expect(missing[0]?.rejectionReason).toBe("unresolved_file");
    expect(missing[0]?.fileAction).toBe("execute");
  });

  it("frames an authored file write as a file observation", () => {
    const frames = extractComputationSourceFrames(
      toolCall(15, "write", { path: "tools/helper.mjs", content: JS_HELPER }),
    );
    expect(frames[0]).toMatchObject({
      language: "javascript",
      source: JS_HELPER,
      originKind: "authored_file",
      executionScope: "file_observation",
      path: "tools/helper.mjs",
      fileAction: "write",
    });

    expect(
      extractComputationSourceFrames(
        toolCall(16, "write", { path: "data/rows.json", content: "[]" }),
      ),
    ).toEqual([]);
    // A write whose body was truncated by normalization is rejected, not partially analyzed.
    const truncated = extractComputationSourceFrames(
      NormalizedSessionEventSchema.parse({
        ...baseHeaders(17),
        type: "tool_call",
        callId: "call-17",
        toolName: "write",
        parameters: {
          path: "tools/helper.mjs",
          content:
            "export function stable(value) { return JSON.stringify(value); }... [TRUNCATED 900 chars]",
        },
      }),
    );
    expect(truncated[0]?.rejectionReason).toBe("truncated_source");
    expect(truncated[0]?.source).toBe("");
  });

  it("rejects a body whose field was truncated even when the prefix parses", () => {
    const truncated = NormalizedSessionEventSchema.parse({
      ...baseHeaders(18),
      type: "tool_call",
      callId: "call-18",
      toolName: "eval",
      parameters: { language: "python", code: "value = 1\n" },
      redaction: {
        isRedacted: true,
        redactedFields: ["code"],
        redactionStrategy: "mask",
        scrubbedPatterns: ["truncation:code"],
      },
    });
    const frames = extractComputationSourceFrames(truncated);
    expect(frames[0]?.rejectionReason).toBe("truncated_source");
    expect(frames[0]?.source).toBe("");
  });

  it("frames a read result from the matching call and ignores an unmatched result", () => {
    const call = toolCall(19, "read", { path: "tools/run.py" });
    const result = readResult(20, call, PY_DEFINITION);
    const frames = extractComputationSourceFrames(result, { relatedCall: call });
    expect(frames[0]).toMatchObject({
      language: "python",
      source: PY_DEFINITION,
      originKind: "referenced_file",
      executionScope: "file_observation",
      path: "tools/run.py",
      fileAction: "read",
      sourceEventId: result.eventId,
    });
    expect(extractComputationSourceFrames(result)).toEqual([]);

    const failed = NormalizedSessionEventSchema.parse({
      ...baseHeaders(21),
      type: "tool_result",
      callId: call.callId,
      toolName: call.toolName,
      result: PY_DEFINITION,
      isError: true,
      executionDurationMs: 1,
    });
    expect(extractComputationSourceFrames(failed, { relatedCall: call })).toEqual([]);
  });

  it("invalidates a partial file edit instead of rebuilding a file from a patch", () => {
    const frames = extractComputationSourceFrames(fileEdit(22, "tools/run.py", "update"));
    expect(frames[0]?.rejectionReason).toBe("partial_edit");
    expect(frames[0]?.source).toBe("");
    expect(frames[0]?.executionScope).toBe("file_observation");
    expect(frames[0]?.fileAction).toBe("write");
    expect(extractComputationSourceFrames(fileEdit(23, "README.md", "update"))).toEqual([]);
  });

  it("frames a command_exec event directly and never treats a shell process as a kernel", () => {
    const frames = extractComputationSourceFrames(commandExec(24, 'node -e "console.log(1)"'));
    expect(frames[0]?.executionScope).toBe("isolated");
    expect(frames[0]?.originKind).toBe("inline");
    for (const frame of extractComputationSourceFrames(commandExec(25, "python3 -c 'print(1)'"))) {
      expect(frame.executionScope).not.toBe("persistent");
    }
  });

  it("ignores events that cannot carry authored source", () => {
    const lifecycle = NormalizedSessionEventSchema.parse({
      ...baseHeaders(26),
      type: "session_lifecycle",
      lifecycleType: "end",
    });
    expect(extractComputationSourceFrames(lifecycle)).toEqual([]);
    const message = NormalizedSessionEventSchema.parse({
      ...baseHeaders(27),
      type: "message",
      role: "assistant",
      content: "I will write a helper.",
    });
    expect(extractComputationSourceFrames(message)).toEqual([]);
  });
});

// ============================================================================
// Native OMP records through the real decoder
// ============================================================================

interface NativeToolTurn {
  readonly callId: string;
  readonly toolName: "eval" | "read" | "write" | "bash";
  readonly toolArguments: Record<string, unknown>;
  readonly result: string;
}

/**
 * Decode native OMP transcript records — an assistant message whose `content[]` carries the
 * `toolCall` block, plus the identity-only execution envelopes — exactly as the adapter does. The
 * tool arguments never leave the assistant block, so a frame that depends on hand-attached metadata
 * could not be recovered here.
 */
function decodeNativeTurn(sequence: number, turn: NativeToolTurn): NormalizedSessionEvent[] {
  const decoder = new OmpRecordDecoder();
  const sessionId = "omp-native-frames";
  const timestamp = nowIso();
  const payloads: unknown[] = [
    {
      type: "message",
      role: "assistant",
      sessionId,
      timestamp,
      model: "synthetic-native-model",
      content: [
        { type: "text", text: `Call ${turn.toolName}.` },
        {
          type: "toolCall",
          id: turn.callId,
          name: turn.toolName,
          arguments: turn.toolArguments,
        },
      ],
    },
    {
      type: "custom",
      customType: "tool_execution_start",
      sessionId,
      timestamp,
      data: { toolCallId: turn.callId, toolName: turn.toolName },
    },
    {
      type: "custom",
      customType: "tool_execution_end",
      sessionId,
      timestamp,
      data: {
        toolCallId: turn.callId,
        toolName: turn.toolName,
        result: turn.result,
        isError: false,
      },
    },
  ];

  const events: NormalizedSessionEvent[] = [];
  payloads.forEach((payload, index) => {
    const record: RawHarnessRecord = {
      recordId: `rec-${sequence}-${index}`,
      sessionId,
      harnessId: "omp",
      sequenceNumber: sequence * 10 + index,
      recordType: "transcript_line",
      timestamp,
      cursor: { offset: 0, line: index + 1, sequence: sequence * 10 + index, timestamp },
      rawPayload: JSON.stringify(payload),
      metadata: {},
    };
    const decoded = decoder.decode(record);
    if (decoded === null) {
      return;
    }
    for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
      events.push(
        NormalizedSessionEventSchema.parse({
          ...event,
          eventId: `evt_native_${sequence}_${index}`,
          redaction: {
            isRedacted: false,
            redactedFields: [],
            redactionStrategy: "none",
            scrubbedPatterns: [],
          },
        }),
      );
    }
  });
  return events;
}

describe("native OMP fixture framing", () => {
  it("recovers an eval definition from native records without attached metadata", () => {
    const events = decodeNativeTurn(1, {
      callId: "call-native-eval",
      toolName: "eval",
      toolArguments: { language: "python", code: PY_DEFINITION },
      result: "",
    });
    const calls = events.filter((event) => event.type === "tool_call");
    expect(calls).toHaveLength(1);
    const frames = extractComputationSourceFrames(calls[0]!);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      language: "python",
      source: PY_DEFINITION,
      originKind: "inline",
      executionScope: "persistent",
    });
  });

  it("recovers a written module and the later isolated execution of that exact file", () => {
    const writeEvents = decodeNativeTurn(2, {
      callId: "call-native-write",
      toolName: "write",
      toolArguments: { path: "tools/helper.mjs", content: JS_HELPER },
      result: "Wrote tools/helper.mjs",
    });
    const writeCall = writeEvents.find((event) => event.type === "tool_call");
    expect(writeCall).toBeDefined();
    const writeFrames = extractComputationSourceFrames(writeCall!);
    expect(writeFrames[0]).toMatchObject({
      source: JS_HELPER,
      originKind: "authored_file",
      fileAction: "write",
      executionScope: "file_observation",
      path: "tools/helper.mjs",
    });

    const runEvents = decodeNativeTurn(3, {
      callId: "call-native-run",
      toolName: "bash",
      toolArguments: { command: "node tools/helper.mjs" },
      result: "1",
    });
    const runCall = runEvents.find((event) => event.type === "tool_call");
    expect(runCall).toBeDefined();
    const knownFiles = new Map<string, LocalComputationModule>([
      [
        writeFrames[0]!.path ?? "",
        {
          path: writeFrames[0]!.path ?? "",
          source: writeFrames[0]!.source,
          language: writeFrames[0]!.language,
        },
      ],
    ]);
    const runFrames = extractComputationSourceFrames(runCall!, { knownFiles });
    expect(runFrames[0]).toMatchObject({
      source: JS_HELPER,
      originKind: "referenced_file",
      executionScope: "isolated",
      fileAction: "execute",
      path: "tools/helper.mjs",
    });
  });
});
