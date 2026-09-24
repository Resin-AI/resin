import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_WORKFLOW_PYTHON_REPLAY_BYTES,
  MAX_WORKFLOW_PYTHON_SOURCE_BYTES,
  type RecordedWorkflow,
  type WorkflowArgument,
  type WorkflowJsonValue,
  type WorkflowRecordedProgram,
  type WorkflowStep,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type McpToolConnection, connectMcpServer } from "../../src/workflow/mcp-connection.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import { createProgramAdapter } from "../../src/workflow/program-adapter.js";
import { runRecordedCall, runRecordedProgram } from "../../src/workflow/program-runner.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";
import {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
} from "../../src/workflow/runtime-families.js";
import { createToolProtocolAdapter } from "../../src/workflow/tool-protocol-adapter.js";

const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "resin-adapters-"));
  workspaces.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A step as the observer records one: the callable it was reached through, and nothing else. */
function recordedStep(options: {
  id: string;
  runtime: string;
  name: string;
  program?: WorkflowRecordedProgram;
  connection?: string;
  arguments?: WorkflowArgument[];
}): WorkflowStep {
  return {
    id: options.id,
    callId: `call-${options.id}`,
    callable: {
      runtime: options.runtime,
      name: options.name,
      ...(options.connection === undefined ? {} : { connection: options.connection }),
      ...(options.program === undefined ? {} : { program: options.program }),
    },
    arguments: options.arguments ?? [],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  };
}

function literalArgument(name: string, value: WorkflowJsonValue): WorkflowArgument {
  return { name, source: { kind: "literal", value } };
}

/** The failure message of a call that must not succeed. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the call was expected to fail, and it did not");
}

/**
 * The observer stamps `callable.runtime` with the family names; a package consumer can only read
 * them from the observer's built module. A static import cannot be used here: this cross-check must
 * not take the runtime's own tests down when the observer app is not built to a revision that
 * declares the vocabulary.
 */
async function readObserverModule(): Promise<object | undefined> {
  try {
    return await import("@resin/observer");
  } catch {
    return undefined;
  }
}

/**
 * A minimal MCP server: line-delimited JSON-RPC over stdio, which is what `connectMcpServer` has to
 * speak. It answers the handshake, lists one tool, echoes the arguments it was given — reporting
 * whether the initialized notification had arrived — refuses one tool, and errors on the rest.
 */
const STDIO_MCP_SERVER = `
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, terminal: false });
let initialized = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
    return;
  }
  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] } });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params.name === "fail") {
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "refused by the tool" }] } });
      return;
    }
    if (message.params.name === "raw") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "  exact output\\n" }] } });
      return;
    }
    if (message.params.name === "broken") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "the tool blew up" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ initialized, called: message.params.name, args: message.params.arguments }) }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
});
`;

describe("recorded program adapters", () => {
  it("runs a recorded shell program whole: its pipe, its operator and its redirect all happen", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });

    const value = await adapter.call({
      step: recordedStep({
        id: "compose",
        runtime: RESIN_PROCESS_RUNTIME,
        name: "compose-report",
        program: {
          kind: "shell",
          source: "printf 'beta\\nalpha\\n' | sort -r && echo done > redirect.txt",
        },
      }),
      arguments: {},
    });

    // The pipe decided the order; the `&&` branch wrote the redirect file.
    // The program's result is its standard output, byte for byte: the trailing newline of the last
    // line is part of what the program printed and part of what the recorded call returned.
    expect(value).toBe("beta\nalpha\n");
    expect(await readFile(join(workspace, "redirect.txt"), "utf8")).toBe("done\n");
  });

  it("refuses a program that failed, naming the step, the exit code and the stderr", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });

    const message = await failureOf(() =>
      adapter.call({
        step: recordedStep({
          id: "explode",
          runtime: RESIN_PROCESS_RUNTIME,
          name: "explode",
          program: { kind: "shell", source: "printf 'boom' >&2; exit 7" },
        }),
        arguments: {},
      }),
    );

    expect(message).toContain("step 'explode'");
    expect(message).toContain("exited with code 7");
    expect(message).toContain("boom");
  });

  it("returns a program's answer exactly as the program printed it", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProgramAdapter({ cwd: workspace });

    const value = await adapter.call({
      step: recordedStep({
        id: "count",
        runtime: RESIN_PROGRAM_RUNTIME,
        name: "count-words",
        program: {
          kind: "python",
          source: "import json\nprint(json.dumps({'count': 3, 'label': 'ok'}))",
        },
      }),
      arguments: {},
    });

    // The tool the caller ran answered with text; a replay that returned an object would answer
    // differently from the recording, and would do so only for programs that happen to print JSON.
    expect(value).toBe('{"count": 3, "label": "ok"}\n');
  });

  it("replays only the final expression for the explicit Python Eval interface", async () => {
    const workspace = await makeWorkspace();
    const bare = await runRecordedProgram(
      { kind: "python", source: "{'count': 2}", sourceInterface: "python-eval" },
      { cwd: workspace },
    );
    const semicolon = await runRecordedProgram(
      { kind: "python", source: "42;", sourceInterface: "python-eval" },
      { cwd: workspace },
    );
    const printed = await runRecordedProgram(
      { kind: "python", source: "print('prefix')\n42;", sourceInterface: "python-eval" },
      { cwd: workspace },
    );
    const none = await runRecordedProgram(
      { kind: "python", source: "None", sourceInterface: "python-eval" },
      { cwd: workspace },
    );

    const whitespace = await runRecordedProgram(
      { kind: "python", source: "print('  output  ')", sourceInterface: "python-eval" },
      { cwd: workspace },
    );
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe("");
    expect(bare.value).toBe("{'count': 2}");
    expect(semicolon.value).toBe("42");
    expect(printed.stdout).toBe("prefix\n");
    expect(printed.value).toBe("prefix\n42");
    expect(none.value).toBe("");
    expect(whitespace.stdout).toBe("  output  \n");
    expect(whitespace.value).toBe("output");
  });

  it("replays native JavaScript Eval completion values and structured display text", async () => {
    const workspace = await makeWorkspace();
    const branch = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'if (true) { "branch"; }',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const retained = await runRecordedProgram(
      {
        kind: "javascript",
        source: '"discarded"; var fidelityProbeLocal = 1;',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const serialized = await runRecordedProgram(
      {
        kind: "javascript",
        source: "console.log('line'); JSON.stringify({ answer: 42 })",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const object = await runRecordedProgram(
      {
        kind: "javascript",
        source: "({ answer: 42 })",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const none = await runRecordedProgram(
      { kind: "javascript", source: "undefined", sourceInterface: "javascript-eval" },
      { cwd: workspace },
    );
    const scopeCollision = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'const __resin_payload = "user value"; __resin_payload;',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );

    expect(branch.value).toBe("branch");
    expect(retained.value).toBe("discarded");
    expect(serialized.stdout).toBe("line\n");
    expect(serialized.value).toBe('line\n{"answer":42}');
    expect(object.value).toBe('display[1]:\n{\n  "answer": 42\n}');
    expect(none.value).toBe("");
    expect(scopeCollision.value).toBe("user value");
  });

  it("matches JavaScript Eval text trimming and structured-clone fallback rules", async () => {
    const workspace = await makeWorkspace();
    const consoleOnly = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'console.log("only");',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const whitespaceString = await runRecordedProgram(
      {
        kind: "javascript",
        source: '"  result  ";',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const consoleAndEmpty = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'console.log("line"); "";',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const uncloneable = await runRecordedProgram(
      {
        kind: "javascript",
        source: "({ answer: 42, fn: () => 1 });",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const cloneableButNotSerializable = await runRecordedProgram(
      {
        kind: "javascript",
        source: "const cycle = {}; cycle.self = cycle; cycle;",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );

    expect(consoleOnly.value).toBe("only");
    expect(whitespaceString.value).toBe("result");
    expect(consoleAndEmpty.value).toBe("line");
    expect(uncloneable.value).toBe("[object Object]");
    expect(cloneableButNotSerializable.value).toBe("display[1]:\n[object Object]");
  });

  it("replays static JavaScript imports and their original bindings", async () => {
    const workspace = await makeWorkspace();
    const namedAlias = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'import { basename as base } from "node:path"; base("/tmp/file.txt");',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const defaultImport = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'import path from "node:path"; path.basename("/tmp/file.txt");',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const namespaceImport = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'import * as path from "node:path"; path.extname("/tmp/file.txt");',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const combinedDefaultAndNamespace = await runRecordedProgram(
      {
        kind: "javascript",
        source:
          'import path, * as pathNamespace from "node:path"; path.basename("/tmp/file.txt") + pathNamespace.extname("/tmp/file.txt");',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const sideEffectImport = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'import "node:path"; "imported";',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const importWithBlockCompletion = await runRecordedProgram(
      {
        kind: "javascript",
        source:
          'import { basename } from "node:path"; if (basename("/tmp/file.txt") === "file.txt") { "discarded"; }',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );

    expect(namedAlias.value).toBe("file.txt");
    expect(defaultImport.value).toBe("file.txt");
    expect(namespaceImport.value).toBe(".txt");
    expect(combinedDefaultAndNamespace.value).toBe("file.txt.txt");
    expect(sideEffectImport.value).toBe("imported");
    expect(importWithBlockCompletion.value).toBe("");
  });

  it("replays native Codex exec text items in a fresh asynchronous VM context", async () => {
    const workspace = await makeWorkspace();
    const source = [
      "globalThis.runCount = (globalThis.runCount ?? 0) + 1;",
      'text("first");',
      'text("");',
      "await Promise.resolve();",
      'text({ runCount: globalThis.runCount, label: "second" });',
      '"completion is not authored output";',
    ].join("\n");
    const program: WorkflowRecordedProgram = {
      kind: "javascript",
      source,
      sourceInterface: "codex-exec",
    };
    const expected = [
      { type: "input_text", text: "first" },
      { type: "input_text", text: "" },
      { type: "input_text", text: '{"runCount":1,"label":"second"}' },
    ];
    const first = await runRecordedProgram(program, { cwd: workspace });
    const second = await runRecordedProgram(program, { cwd: workspace });

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe("");
    expect(first.value).toEqual(expected);
    expect(second.value).toEqual(expected);

    const rawSource = 'text("argument source stays authored");  ';
    const callValue = await runRecordedCall(
      {
        step: recordedStep({
          id: "codex-exec",
          runtime: RESIN_PROGRAM_RUNTIME,
          name: "exec",
          program: {
            kind: "javascript",
            source: "",
            argument: "raw",
            sourceInterface: "codex-exec",
          },
        }),
        arguments: { raw: rawSource },
      },
      { cwd: workspace },
    );
    expect(callValue).toEqual([{ type: "input_text", text: "argument source stays authored" }]);
  });

  it("keeps native Codex exec host APIs unavailable and bounds output and runtime", async () => {
    const workspace = await makeWorkspace();
    const unavailable = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'text([typeof process, typeof require, typeof console].join(":"));',
        sourceInterface: "codex-exec",
      },
      { cwd: workspace },
    );
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.value).toEqual([
      { type: "input_text", text: "undefined:undefined:undefined" },
    ]);

    await expect(
      runRecordedProgram(
        {
          kind: "javascript",
          source: 'import fs from "node:fs"; text(typeof fs);',
          sourceInterface: "codex-exec",
        },
        { cwd: workspace },
      ),
    ).rejects.toThrow(/does not support imports/);

    // Dynamic imports must be rejected before the VM linker can expose a host error to source.
    await expect(
      runRecordedProgram(
        {
          kind: "javascript",
          source: 'try { await import("node:fs"); } catch { text("caught"); }',
          sourceInterface: "codex-exec",
        },
        { cwd: workspace },
      ),
    ).rejects.toThrow(/does not support imports/);

    const promiseMutation = await runRecordedProgram(
      {
        kind: "javascript",
        source:
          'try { Promise.prototype.then = function(resolve) { text(resolve.constructor("return typeof process")()); resolve(); }; } catch {} text("failed closed");',
        sourceInterface: "codex-exec",
      },
      { cwd: workspace },
    );
    expect(promiseMutation.exitCode).not.toBe(0);
    expect(promiseMutation.value).toBe("");

    const errorHookMutation = await runRecordedProgram(
      {
        kind: "javascript",
        source:
          'try { Error.prepareStackTrace = (error, frames) => frames; } catch {} text("failed closed");',
        sourceInterface: "codex-exec",
      },
      { cwd: workspace },
    );
    expect(errorHookMutation.exitCode).not.toBe(0);
    expect(errorHookMutation.value).toBe("");

    const detachedRejection = await runRecordedProgram(
      {
        kind: "javascript",
        source:
          'Promise.reject({ [Symbol.for("nodejs.util.inspect.custom")](depth, options, inspect) { return inspect.constructor("return typeof process")(); } }); text("complete");',
        sourceInterface: "codex-exec",
      },
      { cwd: workspace },
    );
    expect(detachedRejection.exitCode).not.toBe(0);
    expect(detachedRejection.value).toBe("");
    const oversized = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'text("exceeds the configured output cap");',
        sourceInterface: "codex-exec",
      },
      { cwd: workspace, maxOutputBytes: 8 },
    );
    expect(oversized.exitCode).not.toBe(0);
    expect(oversized.value).toBe("");

    await expect(
      runRecordedCall(
        {
          step: recordedStep({
            id: "codex-exec-timeout",
            runtime: RESIN_PROGRAM_RUNTIME,
            name: "exec",
            program: {
              kind: "javascript",
              source: "while (true) {}",
              sourceInterface: "codex-exec",
            },
          }),
          arguments: {},
        },
        { cwd: workspace, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/exceeded its 1000ms time budget and was killed/);
  });

  it("rejects unsupported JavaScript module syntax instead of replaying it differently", async () => {
    const workspace = await makeWorkspace();
    await expect(
      runRecordedProgram(
        {
          kind: "javascript",
          source: "export const result = 1;",
          sourceInterface: "javascript-eval",
        },
        { cwd: workspace },
      ),
    ).rejects.toThrow(/static exports/);
    await expect(
      runRecordedProgram(
        {
          kind: "javascript",
          source: 'import value from "node:path" with { type: "json" }; value;',
          sourceInterface: "javascript-eval",
        },
        { cwd: workspace },
      ),
    ).rejects.toThrow();
  });

  it("preserves JavaScript Eval console ordering and independent process streams", async () => {
    const workspace = await makeWorkspace();
    const run = await runRecordedProgram(
      {
        kind: "javascript",
        source:
          "console.log('value %s %d', 'word', 7); console.error('failure'); console.warn('caution'); 'result';",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("value %s %d word 7\n");
    expect(run.stderr).toBe("failure\ncaution\n");
    expect(run.value).toBe("value %s %d word 7\n[error] failure\n[warn] caution\nresult");
  });

  it("preserves top-level JavaScript Eval async completions and ordinary Node semantics", async () => {
    const workspace = await makeWorkspace();
    const awaited = await runRecordedProgram(
      {
        kind: "javascript",
        source: "await Promise.resolve('awaited');",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const returned = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'return "returned";',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const noAsyncCompletion = await runRecordedProgram(
      {
        kind: "javascript",
        source: 'await Promise.resolve(); if (true) { "discarded"; } var trailing = 1;',
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const parenthesizedObject = await runRecordedProgram(
      {
        kind: "javascript",
        source: "await Promise.resolve(); ({ answer: 42 });",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );
    const ordinary = await runRecordedProgram(
      { kind: "javascript", source: "console.log('value %s', 'word'); 'discarded';" },
      { cwd: workspace },
    );
    const failed = await runRecordedProgram(
      {
        kind: "javascript",
        source: "throw new Error('eval failure')",
        sourceInterface: "javascript-eval",
      },
      { cwd: workspace },
    );

    expect(awaited.value).toBe("awaited");
    expect(returned.value).toBe("returned");
    expect(noAsyncCompletion.value).toBe("");
    expect(parenthesizedObject.value).toBe('display[1]:\n{\n  "answer": 42\n}');
    expect(ordinary.stdout).toBe("value word\n");
    expect(ordinary.value).toBe("value word\n");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("eval failure");
  });

  it("preserves Eval display ordering without moving raw unterminated stdout", async () => {
    const workspace = await makeWorkspace();
    const run = await runRecordedProgram(
      {
        kind: "python",
        source: "print('prefix')\nprint('partial', end='')\n42",
        sourceInterface: "python-eval",
      },
      { cwd: workspace },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("prefix\npartial");
    expect(run.value).toBe("prefix\n42\npartial");
  });

  it("bounds unterminated Eval output without rejecting the exact byte limit", async () => {
    const workspace = await makeWorkspace();
    const exact = await runRecordedProgram(
      { kind: "python", source: "print('x' * 8, end='')", sourceInterface: "python-eval" },
      { cwd: workspace, maxOutputBytes: 8 },
    );
    expect(exact.exitCode).toBe(0);
    expect(exact.value).toBe("xxxxxxxx");
    const overflow = await runRecordedProgram(
      { kind: "python", source: "print('x' * 9, end='')", sourceInterface: "python-eval" },
      { cwd: workspace, maxOutputBytes: 8 },
    );
    expect(overflow.exitCode).not.toBe(0);
  });

  it("keeps ordinary Python on byte-for-byte process stdout semantics", async () => {
    const workspace = await makeWorkspace();
    const ordinary = await runRecordedProgram({ kind: "python", source: "42" }, { cwd: workspace });
    const printed = await runRecordedProgram(
      { kind: "python", source: "print('  exact  ')" },
      { cwd: workspace },
    );

    expect(ordinary.value).toBe("");
    expect(printed.stdout).toBe("  exact  \n");
    expect(printed.value).toBe("  exact  \n");
  });

  it("replays a marked Eval expression over its closed Python setup", async () => {
    const workspace = await makeWorkspace();
    const run = await runRecordedProgram(
      {
        kind: "python",
        source: "answer + 1",
        sourceInterface: "python-eval",
        pythonState: {
          schemaVersion: 1,
          status: "closed",
          unresolvedReadCount: 0,
          setup: [
            {
              callId: "setup-call-eval",
              sourceEventId: "setup-source-eval",
              resultEventId: "setup-result-eval",
              reference: "private:python:eval-setup",
            },
          ],
        },
      },
      {
        cwd: workspace,
        isolateEnvironment: true,
        resolvePrivate: () => "print('setup-noise')\nanswer = 41",
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.value).toBe("42");
  });

  it("retains Python Eval exceptions and rejects interface-language mismatches", async () => {
    const workspace = await makeWorkspace();
    const failed = await runRecordedProgram(
      {
        kind: "python",
        source: "raise ValueError('eval failure')",
        sourceInterface: "python-eval",
      },
      { cwd: workspace },
    );
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("ValueError");
    expect(failed.stderr).toContain("eval failure");

    await expect(
      runRecordedProgram(
        {
          kind: "shell",
          source: "echo not-run",
          sourceInterface: "python-eval",
        } as unknown as WorkflowRecordedProgram,
        { cwd: workspace },
      ),
    ).rejects.toThrow(/Python Eval sourceInterface on a non-Python program/);
  });

  it("replays private Python setup cells once in a fresh process and suppresses setup output", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProgramAdapter({ cwd: workspace, isolateEnvironment: true });
    const sources: Record<string, string> = {
      "private:python:setup-1":
        "print('setup-noise')\ncounter = globals().get('counter', 0) + 1\nbase = 7\nexec = 'shadowed-exec'\ncompile = 'shadowed-compile'\nglobals = 'shadowed-globals'",
      "private:python:setup-2": "def bump(value):\n    return value + base",
    };
    const resolved: Array<{ reference: string; workspaceId?: string }> = [];
    const value = await adapter.call({
      step: recordedStep({
        id: "python-closure",
        runtime: RESIN_PROGRAM_RUNTIME,
        name: "python-eval",
        program: {
          kind: "python",
          source: "print(counter, bump(5), exec, compile, globals)",
          pythonState: {
            schemaVersion: 1,
            status: "closed",
            unresolvedReadCount: 0,
            setup: [
              {
                callId: "setup-call-1",
                sourceEventId: "setup-source-1",
                resultEventId: "setup-result-1",
                reference: "private:python:setup-1",
              },
              {
                callId: "setup-call-2",
                sourceEventId: "setup-source-2",
                resultEventId: "setup-result-2",
                reference: "private:python:setup-2",
              },
            ],
          },
        },
      }),
      arguments: {},
      resolvePrivate: (reference, access) => {
        resolved.push({
          reference,
          ...(access?.workspaceId ? { workspaceId: access.workspaceId } : {}),
        });
        return sources[reference]!;
      },
      access: { workspaceId: "workspace-python" },
    });

    expect(value).toBe("1 12 shadowed-exec shadowed-compile shadowed-globals\n");
    expect(resolved).toEqual([
      { reference: "private:python:setup-1", workspaceId: "workspace-python" },
      { reference: "private:python:setup-2", workspaceId: "workspace-python" },
    ]);
  });

  it("rejects a closed Python replay when its private setup context is unavailable", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProgramAdapter({ cwd: workspace });
    await expect(
      adapter.call({
        step: recordedStep({
          id: "python-missing-context",
          runtime: RESIN_PROGRAM_RUNTIME,
          name: "python-eval",
          program: {
            kind: "python",
            source: "print(answer)",
            pythonState: {
              schemaVersion: 1,
              status: "closed",
              unresolvedReadCount: 0,
              setup: [
                {
                  callId: "setup-call",
                  sourceEventId: "setup-source",
                  resultEventId: "setup-result",
                  reference: "private:python:missing",
                },
              ],
            },
          },
        }),
        arguments: {},
      }),
    ).rejects.toThrow(/private source resolver/);
  });

  it("keeps Python setup exceptions and time bounds fail-closed", async () => {
    const workspace = await makeWorkspace();
    const setup = {
      schemaVersion: 1 as const,
      status: "closed" as const,
      unresolvedReadCount: 0,
      setup: [
        {
          callId: "setup-call",
          sourceEventId: "setup-source",
          resultEventId: "setup-result",
          reference: "private:python:setup",
        },
      ],
    };
    const resolve = () => "raise ValueError('setup boom')";
    const exceptionRun = await runRecordedProgram(
      { kind: "python", source: "print('never')", pythonState: setup },
      { cwd: workspace, resolvePrivate: resolve },
    );
    expect(exceptionRun.exitCode).not.toBe(0);
    expect(exceptionRun.stderr).toContain("ValueError");

    await expect(
      runRecordedProgram(
        { kind: "python", source: "print('never')", pythonState: setup },
        { cwd: workspace, timeoutMs: 200, resolvePrivate: () => "while True: pass" },
      ),
    ).rejects.toThrow(/200ms/);
  });

  it("bounds only final Python output after setup output is suppressed", async () => {
    const workspace = await makeWorkspace();
    const setup = {
      schemaVersion: 1 as const,
      status: "closed" as const,
      unresolvedReadCount: 0,
      setup: [
        {
          callId: "setup-call-output",
          sourceEventId: "setup-source-output",
          resultEventId: "setup-result-output",
          reference: "private:python:output",
        },
      ],
    };
    const run = await runRecordedProgram(
      { kind: "python", source: "print('x' * 30, end='')", pythonState: setup },
      {
        cwd: workspace,
        maxOutputBytes: 12,
        resolvePrivate: () => "for _ in range(100000): print('setup-noise')",
      },
    );
    expect(run.stdout).toBe("xxxxxx" + "xxxxxx");
    expect(run.stderr).toContain("stdout truncated");
  });

  it("transports a large composite Python replay over stdin instead of argv", async () => {
    const workspace = await makeWorkspace();
    const setup = {
      schemaVersion: 1 as const,
      status: "closed" as const,
      unresolvedReadCount: 0,
      setup: [
        {
          callId: "setup-call-large",
          sourceEventId: "setup-source-large",
          resultEventId: "setup-result-large",
          reference: "private:python:large",
        },
      ],
    };
    const literal = "x".repeat(150_000);
    const setupSource = `payload = ${JSON.stringify(literal)}`;
    expect(Buffer.byteLength(setupSource, "utf8")).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(setupSource, "utf8")).toBeLessThan(MAX_WORKFLOW_PYTHON_SOURCE_BYTES);
    const run = await runRecordedProgram(
      { kind: "python", source: "print(len(payload))", pythonState: setup },
      { cwd: workspace, resolvePrivate: () => setupSource },
    );
    expect(run.value).toBe("150000\n");
  });

  it("rejects an oversized Python replay before composing or starting a child", async () => {
    const workspace = await makeWorkspace();
    const setupSource = `payload = ${JSON.stringify("x".repeat(200_000))}`;
    const setup = Array.from({ length: 6 }, (_, index) => ({
      callId: `setup-call-${index}`,
      sourceEventId: `setup-source-${index}`,
      resultEventId: `setup-result-${index}`,
      reference: `private:python:oversize-${index}`,
    }));
    const resolved: string[] = [];
    await expect(
      runRecordedProgram(
        {
          kind: "python",
          source: "print('never')",
          pythonState: {
            schemaVersion: 1 as const,
            status: "closed" as const,
            unresolvedReadCount: 0,
            setup,
          },
        },
        {
          cwd: workspace,
          resolvePrivate: (reference) => {
            resolved.push(reference);
            return setupSource;
          },
        },
      ),
    ).rejects.toThrow();
    expect(resolved).toHaveLength(6);
    expect(Buffer.byteLength(setupSource, "utf8")).toBeLessThan(MAX_WORKFLOW_PYTHON_SOURCE_BYTES);
    expect(Buffer.byteLength(setupSource, "utf8") * setup.length).toBeGreaterThan(
      MAX_WORKFLOW_PYTHON_REPLAY_BYTES,
    );
  });

  it("rejects Python setup closures beyond the shared cell bound", async () => {
    const workspace = await makeWorkspace();
    const setup = Array.from({ length: 33 }, (_, index) => ({
      callId: `setup-call-${index}`,
      sourceEventId: `setup-source-${index}`,
      resultEventId: `setup-result-${index}`,
      reference: `private:python:bound-${index}`,
    }));
    await expect(
      runRecordedProgram(
        {
          kind: "python",
          source: "print('never')",
          pythonState: {
            schemaVersion: 1 as const,
            status: "closed" as const,
            unresolvedReadCount: 0,
            setup,
          },
        },
        { cwd: workspace, resolvePrivate: () => "pass" },
      ),
    ).rejects.toThrow();
  });

  it("passes workspace scope to private Python setup resolution", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProgramAdapter({ cwd: workspace });
    await expect(
      adapter.call({
        step: recordedStep({
          id: "python-private-scope",
          runtime: RESIN_PROGRAM_RUNTIME,
          name: "python-eval",
          program: {
            kind: "python",
            source: "print(value)",
            pythonState: {
              schemaVersion: 1,
              status: "closed",
              unresolvedReadCount: 0,
              setup: [
                {
                  callId: "setup-call",
                  sourceEventId: "setup-source",
                  resultEventId: "setup-result",
                  reference: "private:python:authorized",
                },
              ],
            },
          },
        }),
        arguments: {},
        access: { workspaceId: "workspace-other" },
        resolvePrivate: (_reference, access) => {
          if (access?.workspaceId !== "workspace-authorized") {
            throw new Error("WORKSPACE_MISMATCH");
          }
          return "value = 'authorized'";
        },
      }),
    ).rejects.toThrow(/WORKSPACE_MISMATCH/);
  });

  it("keeps numeric-looking, boolean-looking and whitespace-bearing answers as the text they are", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });
    const run = async (program: string) =>
      await adapter.call({
        step: recordedStep({
          id: "print",
          runtime: RESIN_PROCESS_RUNTIME,
          name: "run-command",
          program: { kind: "shell", source: program },
        }),
        arguments: {},
      });

    // Each of these would be a different value if the replay trimmed or parsed the output, and each
    // is what the recorded call actually returned.
    expect(await run("printf '2\\n'")).toBe("2\n");
    expect(await run("printf 'true\\n'")).toBe("true\n");
    expect(await run("printf 'null\\n'")).toBe("null\n");
    expect(await run("printf '  spaced  \\n'")).toBe("  spaced  \n");
    expect(await run("printf 'a\\n\\nb\\n'")).toBe("a\n\nb\n");
    expect(await run("printf '\\n'")).toBe("\n");
  });

  it("hands an isolated program only the environment it was given", async () => {
    const workspace = await makeWorkspace();
    process.env.RESIN_DAEMON_SECRET = "leaked-value";
    try {
      const isolated = await runRecordedProgram(
        {
          kind: "shell",
          source: 'printf "%s|%s" "${RESIN_DAEMON_SECRET:-none}" "${RESIN_REPLAY:-none}"',
        },
        { cwd: workspace, isolateEnvironment: true, env: { RESIN_REPLAY: "1" } },
      );
      // The operator's own environment is not the replayed program's environment.
      expect(isolated.value).toBe("none|1");

      const inherited = await runRecordedProgram(
        { kind: "shell", source: 'printf "%s" "${RESIN_DAEMON_SECRET:-none}"' },
        { cwd: workspace },
      );
      // Without isolation the process's environment is used, which is what the daemon itself wants.
      expect(inherited.value).toBe("leaked-value");
    } finally {
      delete process.env.RESIN_DAEMON_SECRET;
    }
  });

  it("carries a program's answer into the next call that consumes it", async () => {
    const workspace = await makeWorkspace();
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const seen: Array<Record<string, WorkflowJsonValue>> = [];
    adapters.register(
      createToolProtocolAdapter({
        dispatch: async (request) => {
          seen.push(request.arguments);
          return { received: request.arguments.text ?? null };
        },
      }),
    );
    const plan = {
      schemaVersion: 1,
      workflowId: "wf-program-chain",
      inputs: [],
      steps: [
        {
          id: "step0",
          callId: "call_0",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "run-command",
            program: { kind: "shell", source: "printf '  42  \\n'" },
          },
          arguments: [],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
        {
          id: "step1",
          callId: "call_1",
          callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "handoff" },
          arguments: [
            {
              name: "text",
              source: { kind: "template", template: { type: "result", stepId: "step0", path: [] } },
            },
          ],
          dependsOn: ["step0"],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
      ],
    } as unknown as RecordedWorkflow;

    const execution = await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(execution.status).toBe("completed");
    // The earlier program's answer — whitespace included — is what the later call was given.
    expect(seen).toEqual([{ text: "  42  \n" }]);
    expect(execution.steps[1]!.status === "completed" && execution.steps[1]!.result).toEqual({
      received: "  42  \n",
    });
  });

  it("runs the program text the recorded argument carried, and the source when it carries none", async () => {
    const workspace = await makeWorkspace();
    const adapter = createProcessAdapter({ cwd: workspace });
    const step = recordedStep({
      id: "resolve",
      runtime: RESIN_PROCESS_RUNTIME,
      name: "run-command",
      program: { kind: "shell", source: "echo from-source", argument: "command" },
      arguments: [literalArgument("command", "echo from-argument")],
    });

    expect(await adapter.call({ step, arguments: { command: "echo from-argument" } })).toBe(
      "from-argument\n",
    );
    expect(await adapter.call({ step, arguments: {} })).toBe("from-source\n");
  });

  it("kills a program that outlives its time budget instead of waiting for it", async () => {
    const workspace = await makeWorkspace();

    const message = await failureOf(() =>
      runRecordedProgram({ kind: "shell", source: "sleep 30" }, { cwd: workspace, timeoutMs: 300 }),
    );

    expect(message).toContain("300ms");
  });

  it("keeps a head-and-tail window of a program's output and marks what it dropped", async () => {
    const workspace = await makeWorkspace();

    const run = await runRecordedProgram(
      {
        kind: "shell",
        source: "printf 'aaaaaaaaaa'; printf 'bbbbbbbbbb'; printf 'cccccccccc'",
      },
      { cwd: workspace, maxOutputBytes: 12 },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("aaaaaacccccc");
    expect(run.stderr).toContain("stdout truncated");
  });
});

describe("tool protocol adapter", () => {
  it("re-makes a recorded call through the connection the record names", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connection: McpToolConnection = {
      name: "docs",
      listTools: async () => [],
      callTool: async (name, args) => {
        seen.push({ name, args });
        return { tool: name };
      },
      close: async () => {},
    };
    const adapter = createToolProtocolAdapter({ connections: { docs: connection } });
    const step = recordedStep({
      id: "search",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "search_docs",
      connection: "docs",
      arguments: [literalArgument("query", "resin")],
    });

    expect(await adapter.call({ step, arguments: { query: "resin" } })).toEqual({
      tool: "search_docs",
    });
    expect(seen).toEqual([{ name: "search_docs", args: { query: "resin" } }]);
  });

  it("uses the host dispatcher when the record names no connection", async () => {
    const adapter = createToolProtocolAdapter({
      dispatch: async (request) => ({ served: request.name, step: request.stepId }),
    });
    const step = recordedStep({
      id: "list",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "list_issues",
    });

    expect(await adapter.call({ step, arguments: {} })).toEqual({
      served: "list_issues",
      step: "list",
    });
  });

  it("dials a recorded connection on demand, and fails the step when the dial fails", async () => {
    const dialed: string[] = [];
    const step = recordedStep({
      id: "search",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "search_docs",
      connection: "docs",
    });
    const adapter = createToolProtocolAdapter({
      openConnection: async (name) => {
        dialed.push(name);
        return name === "docs"
          ? {
              name,
              listTools: async () => [],
              callTool: async (tool) => ({ tool }),
              close: async () => {},
            }
          : undefined;
      },
    });

    expect(await adapter.call({ step, arguments: { query: "resin" } })).toEqual({
      tool: "search_docs",
    });
    expect(dialed).toEqual(["docs"]);

    // A dialer that has nothing to hand out is not a connection: the host's dispatcher still gets
    // the call.
    const dispatched = createToolProtocolAdapter({
      openConnection: async () => undefined,
      dispatch: async (request) => ({ served: request.name }),
    });
    expect(await dispatched.call({ step, arguments: { query: "resin" } })).toEqual({
      served: "search_docs",
    });

    const failing = createToolProtocolAdapter({
      openConnection: async () => {
        throw new Error("no credentials for connection 'docs'");
      },
      dispatch: async () => ({ served: "should not be reached" }),
    });
    const message = await failureOf(() => failing.call({ step, arguments: { query: "resin" } }));
    expect(message).toContain("no credentials for connection 'docs'");
  });

  it("refuses a call it cannot reach, and an error result, instead of answering", async () => {
    const step = recordedStep({
      id: "search",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "search_docs",
      connection: "docs",
    });

    const unreachable = await failureOf(() =>
      createToolProtocolAdapter({}).call({ step, arguments: { query: "resin" } }),
    );
    expect(unreachable).toContain("step 'search'");
    expect(unreachable).toContain("search_docs");
    expect(unreachable).toContain("connection 'docs'");
    expect(unreachable).toContain("no tool dispatcher");

    const unnamed = recordedStep({
      id: "list",
      runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
      name: "list_issues",
    });
    const withoutConnection = await failureOf(() =>
      createToolProtocolAdapter({}).call({ step: unnamed, arguments: {} }),
    );
    expect(withoutConnection).toContain("step 'list'");
    expect(withoutConnection).toContain("names no connection");

    const erroring = await failureOf(() =>
      createToolProtocolAdapter({ dispatch: async () => ({ isError: true, content: [] }) }).call({
        step: unnamed,
        arguments: {},
      }),
    );
    expect(erroring).toContain("error result");
  });
});

describe("MCP connections", () => {
  it("reaches a tool on a real stdio server through the recorded connection", async () => {
    const directory = await makeWorkspace();
    const serverPath = join(directory, "server.mjs");
    await writeFile(serverPath, STDIO_MCP_SERVER);
    const connection = await connectMcpServer({
      name: "docs",
      transport: { kind: "stdio", command: process.execPath, args: [serverPath] },
    });
    try {
      expect(await connection.listTools()).toEqual([
        { name: "echo", description: "echoes", inputSchema: { type: "object" } },
      ]);
      const adapter = createToolProtocolAdapter({ connections: { docs: connection } });
      const step = recordedStep({
        id: "search",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        name: "echo",
        connection: "docs",
      });
      // `initialized` is what the server saw: the handshake reached it before the tool call did.
      expect(await adapter.call({ step, arguments: { hello: "world" } })).toEqual({
        initialized: true,
        called: "echo",
        args: { hello: "world" },
      });
      expect(await connection.callTool("raw", {})).toBe("  exact output\n");
      await expect(connection.callTool("fail", {})).rejects.toThrow(/refused by the tool/);
      await expect(connection.callTool("broken", {})).rejects.toThrow(
        /the tool blew up \(code -32603\)/,
      );
    } finally {
      await connection.close();
    }
  });

  it("re-reads a tool over streamable HTTP, carrying the session the server handed out", async () => {
    const sessions: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        sessions.push(request.headers["mcp-session-id"] as string | undefined);
        const message = JSON.parse(body) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.method === "initialize") {
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2024-11-05" },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        const result = {
          content: [{ type: "text", text: JSON.stringify({ method: message.method }) }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("the server has no port");
      const connection = await connectMcpServer({
        name: "http",
        transport: { kind: "http", url: `http://127.0.0.1:${address.port}/mcp` },
      });
      expect(await connection.callTool("anything", { a: 1 })).toEqual({ method: "tools/call" });
      await connection.close();
      // The handshake carried no session; everything after it carried the one the server handed out.
      expect(sessions).toEqual([undefined, "session-1", "session-1"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("runtime family names", () => {
  it("uses the runtime family names the observer stamps", async ({ skip }) => {
    expect([
      RESIN_HARNESS_TOOL_RUNTIME,
      RESIN_PROCESS_RUNTIME,
      RESIN_PROGRAM_RUNTIME,
      RESIN_TOOL_PROTOCOL_RUNTIME,
    ]).toEqual(["resin-harness-tool", "resin-process", "resin-program", "resin-tool-protocol"]);

    const names = [
      "RESIN_HARNESS_TOOL_RUNTIME",
      "RESIN_PROCESS_RUNTIME",
      "RESIN_PROGRAM_RUNTIME",
      "RESIN_TOOL_PROTOCOL_RUNTIME",
    ] as const;
    const expected = [
      RESIN_HARNESS_TOOL_RUNTIME,
      RESIN_PROCESS_RUNTIME,
      RESIN_PROGRAM_RUNTIME,
      RESIN_TOOL_PROTOCOL_RUNTIME,
    ] as const;
    const observer = await readObserverModule();
    if (!observer || names.every((name) => typeof Reflect.get(observer, name) !== "string")) {
      skip("the built @resin/observer predates the runtime family vocabulary");
      return;
    }
    for (const [index, name] of names.entries()) {
      expect(Reflect.get(observer, name)).toBe(expected[index]);
    }
  });
});
