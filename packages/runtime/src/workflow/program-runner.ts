/**
 * Running a recorded program through the family of runtime its record names.
 *
 * A recorded program is evidence about one execution: the text that ran and the way it was handed
 * to the system. Reuse therefore means running that text again the same way — a shell program keeps
 * its operators, pipes, redirections and exit status, a language program goes to its interpreter
 * through a single `-c`/`-e` argument — and never re-quoting, tokenizing or otherwise
 * reconstructing it. The recorded `argv` stays evidence and is never executed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import type { WorkflowJsonValue, WorkflowRecordedProgram } from "@resin/contracts";
import type { RecordedCallRequest } from "./recorded-workflow.js";
import { RESIN_PROGRAM_LANGUAGES } from "./runtime-families.js";

export interface RecordedProgramRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON when it is a single JSON value; otherwise the raw text. */
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

interface ChildInvocation {
  command: string;
  args: string[];
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
      return { command: interpreter, args: ["-c", source] };
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
  if (program.source.length === 0 && (program.argv?.length ?? 0) === 0) {
    throw new Error(
      "the record carries neither a program source nor an argv, so there is nothing to run",
    );
  }
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
): Promise<CapturedRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const stdout = new BoundedOutput(maxOutputBytes);
  const stderr = new BoundedOutput(maxOutputBytes);
  const cwd = options.cwd ?? process.cwd();

  return new Promise<CapturedRun>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      // No stdin: a program waiting for input would otherwise hang until the time budget expires.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX, so the time budget can end the whole tree, not just the shell.
      detached: process.platform !== "win32",
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
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
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const diagnostics: string[] = [];
      if (stdout.truncated) diagnostics.push(`[stdout truncated: ${stdout.omitted} bytes omitted]`);
      if (stderr.truncated) diagnostics.push(`[stderr truncated: ${stderr.omitted} bytes omitted]`);
      if (signal) diagnostics.push(`[terminated by signal ${signal}]`);
      const stderrText =
        stderr.text() + (diagnostics.length > 0 ? `\n${diagnostics.join("\n")}\n` : "");
      finish({ exitCode: code ?? 1, stdout: stdout.text(), stderr: stderrText });
    });
  });
}

/**
 * The value a recorded program's result has.
 *
 * A program's result is what the interface that ran it produced, and for a process that is its
 * standard output as text — the same bytes, unchanged. Trimming it would lose meaningful
 * whitespace, and parsing it would turn a program that printed `2` into a number the recorded call
 * never returned; both would make the replay disagree with the recording it is checked against, and
 * neither is what the tool the user ran actually received. A result that is structured is
 * structured because the interface that returned it says so, which is the tool-protocol adapter's
 * business rather than this one's.
 */
function resultValue(stdout: string): WorkflowJsonValue {
  return stdout;
}

/**
 * Runs a recorded program exactly once, through the family its record names. Shell programs keep
 * shell semantics; language programs reach their interpreter as a single argument. A non-zero exit
 * code is reported in the result and is left for the caller to refuse: this function never invents
 * a value for a program that failed.
 */
export async function runRecordedProgram(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions = {},
): Promise<RecordedProgramRun> {
  assertRunnable(program);
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const invocation = invocationFor(program, options, env);
  const captured = await runChild(invocation, options);
  return {
    exitCode: captured.exitCode,
    stdout: captured.stdout,
    stderr: captured.stderr,
    value: resultValue(captured.stdout),
  };
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
  const run = await runRecordedProgram({ ...program, source }, options);
  if (run.exitCode !== 0) {
    const tail = stderrTail(run.stderr);
    const detail = tail.length > 0 ? `: ${tail}` : " (no stderr)";
    throw new Error(
      `step '${step.id}' failed: recorded ${program.kind} program exited with code ${run.exitCode}${detail}`,
    );
  }
  return run.value;
}
