/**
 * Running a recorded program through the family of runtime its record names.
 *
 * A recorded program is evidence about one execution: the text that ran and the way it was handed
 * to the system. Reuse therefore means running that text again the same way — a shell program keeps
 * its operators, pipes, redirections and exit status, a language program reaches its interpreter
 * through the recorded transport (argv for ordinary runs, stdin for bounded Python composites) —
 * and never re-quoting, tokenizing or otherwise reconstructing it. The recorded `argv` stays evidence
 * and is never executed.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import {
  MAX_WORKFLOW_PYTHON_REPLAY_BYTES,
  MAX_WORKFLOW_PYTHON_SOURCE_BYTES,
  type WorkflowJsonValue,
  type WorkflowRecordedProgram,
  validateWorkflowProgramSourceInterface,
  validateWorkflowPythonState,
} from "@resin/contracts";
import type { RecordedCallRequest } from "./recorded-workflow.js";
import { RESIN_PROGRAM_LANGUAGES } from "./runtime-families.js";

export interface RecordedProgramRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw stdout for ordinary programs; rendered result text for the explicit Python Eval interface. */
  value: WorkflowJsonValue;
}

export interface ProgramRunnerOptions {
  /** Directory the program runs in. Defaults to the process cwd. */
  cwd?: string;
  /** Hard wall-clock bound; the child is killed and the run fails when exceeded. */
  timeoutMs?: number;
  /** Cap on captured stdout bytes. */
  maxOutputBytes?: number;
  /** Extra environment; PATH is always inherited. */
  env?: Record<string, string>;
  /**
   * Hand the program ONLY the environment it was given, never the process's own.
   *
   * A replay is not the daemon: a recorded program has no business reading the operator's
   * credentials, tokens or proxy configuration out of the environment, and inheriting them would
   * make a validation run as powerful as the daemon itself. PATH is always provided, because a
   * program text naming an interpreter needs one to be found.
   */
  isolateEnvironment?: boolean;
  /** Resolves private Python setup-cell source in the owning workspace. */
  resolvePrivate?: (
    reference: string,
    access?: { workspaceId?: string },
  ) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  /** Workspace scope forwarded to the private setup resolver. */
  access?: { workspaceId?: string };
  /** Overridable for tests. */
  platform?: NodeJS.Platform;
}

/** Long enough for a real build or install, short enough that a hung program cannot pin a run. */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
/** Share of the byte budget kept from the start of a stream; the rest is kept from the end. */
const HEAD_SHARE = 0.5;
/** Bounded PATH probe: enough directories for a normal host, never an unbounded filesystem walk. */
const MAX_PATH_ENTRIES = 256;
/** Fixed Python transport driver; composite replay source travels over stdin, not argv. */
const PYTHON_STDIN_DRIVER =
  "import sys\nexec(compile(sys.stdin.read(), '<resin-python>', 'exec'), {'__name__': '__main__'})";
interface ChildInvocation {
  command: string;
  args: string[];
  input?: string;
}

interface CapturedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function isRecordedProgram(value: unknown): value is WorkflowRecordedProgram {
  return typeof value === "object" && value !== null;
}

/**
 * Keeps a head-and-tail window of a stream: the start says how the program began, the end says why
 * it failed, and the middle is what nobody reads.
 */
class BoundedOutput {
  private readonly headLimit: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private omittedBytes = 0;

  constructor(private readonly limit: number) {
    this.headLimit = Math.max(0, Math.floor(limit * HEAD_SHARE));
  }

  write(chunk: Buffer): void {
    let rest = chunk;
    const headRoom = this.headLimit - this.head.length;
    if (headRoom > 0) {
      this.head = Buffer.concat([this.head, rest.subarray(0, headRoom)]);
      rest = rest.subarray(headRoom);
    }
    if (rest.length === 0) return;
    const tailLimit = this.limit - this.headLimit;
    if (tailLimit === 0) {
      this.omittedBytes += rest.length;
      return;
    }
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > tailLimit) {
      const drop = this.tail.length - tailLimit;
      this.tail = this.tail.subarray(drop);
      this.omittedBytes += drop;
    }
  }

  get truncated(): boolean {
    return this.omittedBytes > 0;
  }

  get omitted(): number {
    return this.omittedBytes;
  }

  text(): string {
    return this.head.toString("utf8") + this.tail.toString("utf8");
  }
}

/**
 * Resolves an interpreter on PATH without spawning it. A probe that ran the interpreter to see
 * whether it exists would execute the recorded source twice; the record is executed exactly once.
 */
function resolveInterpreter(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const searchPath = env.PATH ?? env.Path ?? "";
  const directories = searchPath.split(delimiter).filter((entry) => entry.length > 0);
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const name of names) {
    for (const extension of extensions) {
      const candidateName = `${name}${extension}`;
      for (const directory of directories.slice(0, MAX_PATH_ENTRIES)) {
        const candidate = join(directory, candidateName);
        try {
          accessSync(candidate, fsConstants.X_OK);
          return candidate;
        } catch {
          // Not here; keep looking along PATH.
        }
      }
    }
  }
  return undefined;
}

function invocationFor(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions,
  env: NodeJS.ProcessEnv,
  input?: string,
): ChildInvocation {
  const platform = options.platform ?? process.platform;
  const source = program.source;
  switch (program.kind) {
    case "shell":
      // The platform shell runs the whole text: `&&`, `||`, pipes and redirections are what the
      // recorded call did, and exit status is the program's exit status.
      return platform === "win32"
        ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", source] }
        : { command: "/bin/sh", args: ["-c", source] };
    case "python": {
      const interpreter = resolveInterpreter(["python3", "python"], env, platform);
      if (!interpreter) {
        throw new Error("no python interpreter is resolvable on PATH (looked for python3, python)");
      }
      if (program.sourceInterface === "python-eval") {
        return {
          command: interpreter,
          args: ["-c", PYTHON_STDIN_DRIVER],
          input: source,
        };
      }
      return input === undefined
        ? { command: interpreter, args: ["-c", source] }
        : { command: interpreter, args: ["-c", PYTHON_STDIN_DRIVER], input };
    }
    case "javascript":
    case "typescript":
      // A `typescript` record is the text the runtime actually accepted and ran: the recording
      // shows a JavaScript execution, so it is re-run as one rather than re-typed.
      return { command: process.execPath, args: ["-e", source] };
    default: {
      const exhaustive: never = program.kind;
      throw new Error(`recorded program kind '${String(exhaustive)}' cannot be run`);
    }
  }
}

function assertRunnable(program: unknown): asserts program is WorkflowRecordedProgram {
  if (!isRecordedProgram(program)) {
    throw new Error("the record carries no program to run");
  }
  if (typeof program.kind !== "string" || !Object.hasOwn(RESIN_PROGRAM_LANGUAGES, program.kind)) {
    throw new Error(`the record names an unknown program kind '${String(program.kind)}'`);
  }
  if (typeof program.source !== "string") {
    throw new Error(`recorded ${program.kind} program source is not text`);
  }
  const interfaceErrors: string[] = [];
  validateWorkflowProgramSourceInterface(program, "recorded Python program", interfaceErrors);
  if (interfaceErrors.length > 0) throw new Error(interfaceErrors[0]);
  if (program.source.length === 0 && (program.argv?.length ?? 0) === 0) {
    throw new Error(
      "the record carries neither a program source nor an argv, so there is nothing to run",
    );
  }
}

/**
 * Rejects Python closure metadata before any child is started. The structural contract validator
 * catches these records during compilation; the runner repeats the safety boundary for direct
 * adapter callers so malformed state can never fall back to ambient interpreter state.
 */
function assertPythonState(program: WorkflowRecordedProgram, targetCallId?: string): void {
  if (program.pythonState === undefined) return;
  if (program.kind !== "python") {
    throw new Error("pythonState is only valid for Python programs");
  }
  const errors: string[] = [];
  validateWorkflowPythonState(
    program,
    "recorded Python pythonState",
    targetCallId,
    new Set<string>(),
    undefined,
    errors,
  );
  if (errors.length > 0) throw new Error(errors[0]);
  if (program.pythonState.status !== "closed") {
    throw new Error("recorded Python pythonState is unresolved");
  }
  if (program.pythonState.unresolvedReadCount !== 0) {
    throw new Error("recorded Python pythonState has unresolved reads");
  }
}

function composePythonReplaySource(setupSources: readonly string[], target: string): string {
  if (setupSources.length === 0) return target;
  const setup = setupSources
    .map(
      (source, index) =>
        `        __resin_exec(__resin_compile(${JSON.stringify(source)}, ${JSON.stringify(`<resin-python-setup-${index}>`)}, "exec"), __resin_namespace, __resin_namespace)`,
    )
    .join("\n");
  const targetExecution = `    __resin_exec(__resin_compile(${JSON.stringify(target)}, "<resin-python-target>", "exec"), __resin_namespace, __resin_namespace)`;
  return [
    "def __resin_run():",
    '    __resin_builtins = __import__("builtins")',
    '    __resin_contextlib = __import__("contextlib")',
    "    __resin_exec = __resin_builtins.exec",
    "    __resin_compile = __resin_builtins.compile",
    "    __resin_len = __resin_builtins.len",
    "    __resin_discard_type = __resin_builtins.type",
    "    __resin_namespace = {'__name__': '__main__', '__builtins__': __resin_builtins.__dict__}",
    "    __resin_discard = __resin_discard_type(",
    '        "_ResinDiscard",',
    "        (),",
    "        {",
    '            "write": lambda _self, data: __resin_len(data),',
    '            "flush": lambda _self: None,',
    "        },",
    "    )",
    "    with __resin_contextlib.redirect_stdout(__resin_discard()), __resin_contextlib.redirect_stderr(__resin_discard()):",
    setup,
    targetExecution,
    "__resin_run()",
  ].join("\n");
}

/**
 * Replays OMP's Python Eval source interface through the same interpreter, with a bounded,
 * private result file separating rendered output events from the child's real stdout/stderr.
 */
function composePythonEvalReplaySource(
  setupSources: readonly string[],
  target: string,
  outputPath: string,
  maxOutputBytes: number,
  maxEventBytes: number,
): string {
  const serializedSources = JSON.stringify(JSON.stringify([...setupSources, target]));
  return [
    "import ast as __resin_ast",
    "import builtins as __resin_builtins",
    "import contextlib as __resin_contextlib",
    "import __future__ as __resin_future",
    "import json as __resin_json",
    "import sys as __resin_sys",
    "",
    "def __resin_run():",
    `    __resin_sources = __resin_json.loads(${serializedSources})`,
    "    __resin_namespace = {'__name__': '__main__', '__builtins__': __resin_builtins.__dict__}",
    "    __resin_exec = __resin_builtins.exec",
    "    __resin_compile = __resin_builtins.compile",
    "    __resin_eval = __resin_builtins.eval",
    "    __resin_future_mask = 0",
    "    for __resin_feature in __resin_future.all_feature_names:",
    "        __resin_future_mask |= getattr(__resin_future, __resin_feature).compiler_flag",
    "    __resin_open = __resin_builtins.open",
    `    _resin_output_limit = ${String(maxOutputBytes)}`,
    `    _resin_event_limit = ${String(maxEventBytes)}`,
    "    _resin_output_bytes = 0",
    "    _resin_event_bytes = 0",
    "    __resin_original_stdout = __resin_sys.stdout",
    `    __resin_event_file = __resin_open(${JSON.stringify(outputPath)}, 'ab', buffering=0)`,
    "",
    "    def _resin_write_all(data):",
    "        view = memoryview(data)",
    "        while view:",
    "            written = __resin_event_file.write(view)",
    "            if written is None or written <= 0:",
    "                raise OSError('short write to private Python Eval result file')",
    "            view = view[written:]",
    "",
    "    def _resin_emit(kind, text):",
    "        nonlocal _resin_output_bytes, _resin_event_bytes",
    "        if kind == 'r':",
    "            _resin_output_bytes += len(text.encode('utf-8'))",
    "            if _resin_output_bytes > _resin_output_limit:",
    "                raise ValueError('Python Eval result exceeds the replay output bound')",
    "        frame = __resin_json.dumps({'k': kind, 'v': text}, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\\n'",
    "        _resin_event_bytes += len(frame)",
    "        if _resin_event_bytes > _resin_event_limit:",
    "            raise ValueError('Python Eval result events exceed the replay output bound')",
    "        _resin_write_all(frame)",
    "",
    "    def __resin_emit_done():",
    "        nonlocal _resin_event_bytes",
    "        frame = b'{\"d\":true}\\n'",
    "        _resin_event_bytes += len(frame)",
    "        if _resin_event_bytes > _resin_event_limit:",
    "            raise ValueError('Python Eval result events exceed the replay output bound')",
    "        _resin_write_all(frame)",
    "",
    "    class __ResinDiscard:",
    "        def write(self, _text):",
    "            return len(_text)",
    "        def flush(self):",
    "            return None",
    "",
    "    class _ResinBinaryOutput:",
    "        def __init__(self, owner):",
    "            self.owner = owner",
    "        def write(self, data):",
    "            written = self.owner.target.buffer.write(data)",
    "            self.owner.record(data.decode(self.owner.encoding, errors='replace'))",
    "            return written",
    "        def flush(self):",
    "            return self.owner.flush()",
    "",
    "    class _ResinStdout:",
    "        def __init__(self, target):",
    "            self.target = target",
    "            self.encoding = target.encoding",
    "            self.errors = target.errors",
    "            self.pending = bytearray()",
    "            self.buffer = _ResinBinaryOutput(self)",
    "        def record(self, text):",
    "            nonlocal _resin_output_bytes",
    "            if len(text) + _resin_output_bytes > _resin_output_limit:",
    "                raise ValueError('Python Eval output exceeds the replay output bound')",
    "            data = text.encode('utf-8')",
    "            if len(data) + _resin_output_bytes > _resin_output_limit:",
    "                raise ValueError('Python Eval output exceeds the replay output bound')",
    "            _resin_output_bytes += len(data)",
    "            start = 0",
    "            while start < len(data):",
    "                end = data.find(b'\\n', start)",
    "                stop = len(data) if end < 0 else end + 1",
    "                piece = data[start:stop]",
    "                if len(self.pending) + len(piece) > _resin_output_limit:",
    "                    raise ValueError('Python Eval output line exceeds the replay output bound')",
    "                self.pending.extend(piece)",
    "                if end >= 0:",
    "                    _resin_emit('s', self.pending.decode('utf-8'))",
    "                    self.pending.clear()",
    "                start = stop",
    "        def write(self, text):",
    "            written = self.target.write(text)",
    "            self.record(text)",
    "            return written",
    "        def flush(self):",
    "            if self.pending:",
    "                _resin_emit('s', self.pending.decode('utf-8'))",
    "                self.pending.clear()",
    "            return self.target.flush()",
    "        def isatty(self):",
    "            return self.target.isatty()",
    "        def fileno(self):",
    "            return self.target.fileno()",
    "        def writable(self):",
    "            return self.target.writable()",
    "",
    "    __resin_discard = __ResinDiscard()",
    "    for __resin_index, __resin_source in enumerate(__resin_sources[:-1]):",
    "        with __resin_contextlib.redirect_stdout(__resin_discard), __resin_contextlib.redirect_stderr(__resin_discard):",
    "            __resin_exec(__resin_compile(__resin_source, '<resin-python-setup-' + str(__resin_index) + '>', 'exec'), __resin_namespace, __resin_namespace)",
    "",
    "    __resin_tree = __resin_ast.parse(__resin_sources[-1], '<resin-python-target>', 'exec')",
    "    __resin_body = __resin_tree.body",
    "    __resin_has_result = bool(__resin_body and isinstance(__resin_body[-1], __resin_ast.Expr))",
    "    __resin_expression = __resin_body[-1] if __resin_has_result else None",
    "    if __resin_has_result:",
    "        __resin_tree.body = __resin_body[:-1]",
    "    __resin_ast.fix_missing_locations(__resin_tree)",
    "    __resin_prefix_code = __resin_compile(__resin_tree, '<resin-python-target>', 'exec', dont_inherit=True)",
    "    __resin_stdout = _ResinStdout(__resin_original_stdout)",
    "    try:",
    "        with __resin_contextlib.redirect_stdout(__resin_stdout):",
    "            __resin_exec(__resin_prefix_code, __resin_namespace, __resin_namespace)",
    "            if __resin_has_result:",
    "                __resin_expression_tree = __resin_ast.Expression(body=__resin_expression.value)",
    "                __resin_ast.fix_missing_locations(__resin_expression_tree)",
    "                __resin_future_flags = __resin_prefix_code.co_flags & __resin_future_mask",
    "                __resin_expression_code = __resin_compile(__resin_expression_tree, '<resin-python-result>', 'eval', flags=__resin_future_flags, dont_inherit=True)",
    "                __resin_result = __resin_eval(__resin_expression_code, __resin_namespace, __resin_namespace)",
    "                if __resin_result is not None:",
    "                    _resin_emit('r', repr(__resin_result) + '\\n')",
    "            __resin_stdout.flush()",
    "    finally:",
    "        try:",
    "            __resin_emit_done()",
    "        finally:",
    "            __resin_event_file.close()",
    "",
    "__resin_run()",
  ].join("\n");
}

interface PythonEvalOutputBounds {
  output: number;
  events: number;
}

function pythonEvalOutputBounds(maxOutputBytes: number): PythonEvalOutputBounds {
  const output = Math.floor(maxOutputBytes);
  const events = output * 24 + 64;
  if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(events)) {
    throw new Error("Python Eval replay output limit must be a finite non-negative safe integer");
  }
  return { output, events };
}

async function preparePythonReplaySource(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions,
  targetCallId?: string,
  pythonEvalOutputPath?: string,
): Promise<string> {
  assertPythonState(program, targetCallId);
  const state = program.pythonState;
  const pythonEval = program.sourceInterface === "python-eval";
  const composeEval = (setupSources: readonly string[]): string => {
    if (pythonEvalOutputPath === undefined) {
      throw new Error("Python Eval replay result file was not prepared");
    }
    const bounds = pythonEvalOutputBounds(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    return composePythonEvalReplaySource(
      setupSources,
      program.source,
      pythonEvalOutputPath,
      bounds.output,
      bounds.events,
    );
  };
  if (state === undefined || state.setup.length === 0) {
    if (!pythonEval) return program.source;
    const targetBytes = Buffer.byteLength(program.source, "utf8");
    if (targetBytes > MAX_WORKFLOW_PYTHON_SOURCE_BYTES) {
      throw new Error(
        `recorded Python target source exceeds ${MAX_WORKFLOW_PYTHON_SOURCE_BYTES} bytes`,
      );
    }
    const composed = composeEval([]);
    if (Buffer.byteLength(composed, "utf8") > MAX_WORKFLOW_PYTHON_REPLAY_BYTES) {
      throw new Error(
        `composed Python replay source exceeds ${MAX_WORKFLOW_PYTHON_REPLAY_BYTES} bytes`,
      );
    }
    return composed;
  }
  const targetBytes = Buffer.byteLength(program.source, "utf8");
  if (targetBytes > MAX_WORKFLOW_PYTHON_SOURCE_BYTES) {
    throw new Error(
      `recorded Python target source exceeds ${MAX_WORKFLOW_PYTHON_SOURCE_BYTES} bytes`,
    );
  }
  let rawBytes = targetBytes;
  if (options.resolvePrivate === undefined) {
    throw new Error("recorded Python setup requires a private source resolver");
  }
  const setupSources: string[] = [];
  for (const descriptor of state.setup) {
    const source = await options.resolvePrivate(descriptor.reference, options.access);
    if (typeof source !== "string") {
      throw new Error(
        `recorded Python setup reference '${descriptor.reference}' did not resolve to source text`,
      );
    }
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (sourceBytes > MAX_WORKFLOW_PYTHON_SOURCE_BYTES) {
      throw new Error(
        `recorded Python setup source '${descriptor.reference}' exceeds ${MAX_WORKFLOW_PYTHON_SOURCE_BYTES} bytes`,
      );
    }
    rawBytes += sourceBytes;
    if (rawBytes > MAX_WORKFLOW_PYTHON_REPLAY_BYTES) {
      throw new Error(
        `recorded Python replay sources exceed ${MAX_WORKFLOW_PYTHON_REPLAY_BYTES} bytes before composition`,
      );
    }
    setupSources.push(source);
  }
  const composed = pythonEval
    ? composeEval(setupSources)
    : composePythonReplaySource(setupSources, program.source);
  const composedBytes = Buffer.byteLength(composed, "utf8");
  if (composedBytes > MAX_WORKFLOW_PYTHON_REPLAY_BYTES) {
    throw new Error(
      `composed Python replay source exceeds ${MAX_WORKFLOW_PYTHON_REPLAY_BYTES} bytes`,
    );
  }
  return composed;
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // A cmd.exe child is not the root of a process group, so walk the tree explicitly first.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // No process group for this child; kill the child itself.
    child.kill("SIGKILL");
  }
}

function runChild(
  invocation: ChildInvocation,
  options: ProgramRunnerOptions,
  env: NodeJS.ProcessEnv,
): Promise<CapturedRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new BoundedOutput(maxOutputBytes);
  const stderr = new BoundedOutput(maxOutputBytes);
  const cwd = options.cwd ?? process.cwd();

  return new Promise<CapturedRun>((resolve, reject) => {
    const stdio: SpawnOptions["stdio"] = [
      invocation.input === undefined ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ];
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio,
      windowsHide: true,
      // Own process group on POSIX, so the time budget can end the whole tree, not just the shell.
      detached: process.platform !== "win32",
    });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      killProcessTree(child);
      reject(new Error(`recorded program exceeded its ${timeoutMs}ms time budget and was killed`));
    }, timeoutMs);

    const finish = (run: CapturedRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.write(chunk);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `recorded program could not be started (${invocation.command}): ${error.message}`,
        ),
      );
    });
    if (invocation.input !== undefined && child.stdin !== null) {
      // The interpreter may exit before consuming all source; EPIPE is a normal transport race.
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(invocation.input, "utf8");
      } catch {
        // The close/error handlers below report the child outcome.
      }
    }
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const diagnostics: string[] = [];
      if (stdout.truncated) diagnostics.push(`[stdout truncated: ${stdout.omitted} bytes omitted]`);
      if (stderr.truncated) diagnostics.push(`[stderr truncated: ${stderr.omitted} bytes omitted]`);
      if (signal) diagnostics.push(`[terminated by signal ${signal}]`);
      const stderrText =
        stderr.text() + (diagnostics.length > 0 ? `\n${diagnostics.join("\n")}\n` : "");
      finish({
        exitCode: code ?? 1,
        stdout: stdout.text(),
        stderr: stderrText,
      });
    });
  });
}

/**
 * Validates the bounded private event stream produced by the Python Eval wrapper, then applies the
 * result text projection used by that source interface.
 */
function pythonEvalResultValue(output: string): WorkflowJsonValue {
  const resultEvents: string[] = [];
  let complete = false;
  let hasResult = false;
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error("recorded Python Eval replay produced an invalid output event");
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      throw new Error("recorded Python Eval replay produced an invalid output event");
    }
    const event = frame as Record<string, unknown>;
    if (complete) {
      throw new Error("recorded Python Eval replay produced data after its completion event");
    }
    if (Object.keys(event).length === 1 && event.d === true) {
      complete = true;
      continue;
    }
    if (
      Object.keys(event).length !== 2 ||
      typeof event.k !== "string" ||
      typeof event.v !== "string" ||
      (event.k !== "s" && event.k !== "r")
    ) {
      throw new Error("recorded Python Eval replay produced an invalid output text event");
    }
    if (event.k === "r") {
      if (hasResult) {
        throw new Error("recorded Python Eval replay produced multiple result events");
      }
      hasResult = true;
    }
    resultEvents.push(event.v);
  }
  if (!complete) {
    throw new Error("recorded Python Eval replay did not complete its output");
  }
  return resultEvents.join("").trim();
}

/**
 * Runs a recorded program exactly once, through the family its record names. Shell programs keep
 * shell semantics. Python state replay sends composed source through stdin; other language
 * programs receive source as a single argument. A non-zero exit code is left for the caller to
 * refuse: this function never invents a value for a program that failed.
 */
export async function runRecordedProgram(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions = {},
  targetCallId?: string,
): Promise<RecordedProgramRun> {
  assertRunnable(program);
  const isPythonEval = program.sourceInterface === "python-eval";
  let outputDirectory: string | undefined;
  let outputFile: FileHandle | undefined;
  try {
    let outputPath: string | undefined;
    let outputBounds: PythonEvalOutputBounds | undefined;
    if (isPythonEval) {
      outputBounds = pythonEvalOutputBounds(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      outputDirectory = await mkdtemp(join(tmpdir(), "resin-python-eval-"));
      outputPath = join(outputDirectory, "events.jsonl");
      outputFile = await open(outputPath, "wx+", 0o600);
    }
    const source = await preparePythonReplaySource(program, options, targetCallId, outputPath);
    const runnable = source === program.source ? program : { ...program, source };
    const env: NodeJS.ProcessEnv = options.isolateEnvironment
      ? { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env }
      : { ...process.env, ...options.env };
    const replayInput =
      runnable.kind === "python" && runnable.pythonState !== undefined ? source : undefined;
    const invocation = invocationFor(runnable, options, env, replayInput);
    const captured = await runChild(invocation, options, env);
    let value: WorkflowJsonValue = captured.stdout;
    if (isPythonEval && captured.exitCode === 0) {
      if (outputFile === undefined || outputBounds === undefined) {
        throw new Error("recorded Python Eval replay did not preserve its complete output");
      }
      const outputStat = await outputFile.stat();
      if (outputStat.size > outputBounds.events) {
        throw new Error("recorded Python Eval replay exceeded its output event bound");
      }
      value = pythonEvalResultValue(await outputFile.readFile({ encoding: "utf8" }));
    }
    return {
      exitCode: captured.exitCode,
      stdout: captured.stdout,
      stderr: captured.stderr,
      value,
    };
  } finally {
    try {
      await outputFile?.close();
    } finally {
      if (outputDirectory !== undefined) {
        await rm(outputDirectory, { recursive: true, force: true });
      }
    }
  }
}

/** The tail of a failure message, bounded so a noisy program cannot flood a step's error. */
function stderrTail(stderr: string, limit = 800): string {
  const text = stderr.trim();
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - limit)}`;
}

/**
 * The program text a recorded call must run. When the record says the program arrived as a tool
 * argument, the value resolved for that argument *is* the program: that is what lets a resolved
 * private leaf or a promoted input reach the program on a re-run.
 */
function programTextFor(
  program: WorkflowRecordedProgram,
  args: Record<string, WorkflowJsonValue>,
): string {
  const argumentName = program.argument;
  if (argumentName !== undefined && Object.hasOwn(args, argumentName)) {
    const carried = args[argumentName];
    if (typeof carried === "string") return carried;
  }
  return program.source;
}

/**
 * Runs the program a recorded call names and returns its value. Both program families share this:
 * they differ in how the observer recorded the call, not in what running it again means. A failure
 * — a missing program, an unrunnable record, a non-zero exit status — throws with the step id so
 * the executor records the step as failed instead of passing a fabricated value on.
 */
export async function runRecordedCall(
  request: RecordedCallRequest,
  options: ProgramRunnerOptions = {},
): Promise<WorkflowJsonValue> {
  const { step } = request;
  const program = step.callable.program;
  if (!program) {
    throw new Error(
      `step '${step.id}' cannot run: the record carries no program for callable '${step.callable.name}'`,
    );
  }
  const source = programTextFor(program, request.arguments);
  if (source.length === 0) {
    throw new Error(
      `step '${step.id}' cannot run: the record carries no program text for callable '${step.callable.name}'`,
    );
  }
  const replayOptions: ProgramRunnerOptions = {
    ...options,
    ...(options.resolvePrivate === undefined && request.resolvePrivate
      ? { resolvePrivate: request.resolvePrivate }
      : {}),
    ...(options.access === undefined && request.access ? { access: request.access } : {}),
  };
  const run = await runRecordedProgram({ ...program, source }, replayOptions, step.callId);
  if (run.exitCode !== 0) {
    const tail = stderrTail(run.stderr);
    const detail = tail.length > 0 ? `: ${tail}` : " (no stderr)";
    throw new Error(
      `step '${step.id}' failed: recorded ${program.kind} program exited with code ${run.exitCode}${detail}`,
    );
  }
  return run.value;
}
