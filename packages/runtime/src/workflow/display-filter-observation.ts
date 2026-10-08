/**
 * An ordinary invocation of a version-2 display-filter step (`splitDisplayFilters`): the recorded
 * program runs exactly as recorded, its display filters inline, so `&&`, `||`, `;`, `$?` and its
 * own exit status are the recording's. Only observation wrappers are inserted, at the exact offsets
 * of its top-level pipelines (`displayFilterPipelines`), with no line break added:
 *
 * - a shell function `F`, defined on the program's first line, that writes the status it was
 *   called with to a file in the run's capture directory and returns it;
 * - every pipeline `P` (number `n`, from 1) becomes `{ P; F p<n>; }`;
 * - every cut pipeline becomes `{ { KEPT; F c<n>; } | tee '<dir>/o<n>' FILTER; F p<n>; }`, so
 *   `c<n>` is its command's own status, `o<n>` that command's unfiltered output, `p<n>` the
 *   pipeline's status (its filter's). When the filter stops reading early, the command gets SIGPIPE
 *   exactly as it did in the recording, and `o<n>` holds only what it printed until then.
 *
 * The step's value is what the program printed (the filtered view), as the recording saw it; later
 * steps bind that. The caller is shown a bounded report (`displayFilterReport`) instead: each
 * pipeline's outcome, that output, the diagnostic lines the filters hid, and where the whole output
 * is kept. A check whose command failed, or an and-or list whose last pipeline that ran failed,
 * fails the step with the report, whatever its filter printed. A program that may change shell
 * options (`changesShellOptions`) runs without wrappers.
 */

import { randomBytes } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { DisplayFilterCut, DisplayFilterPipeline } from "@resin/contracts";

/** The most characters a report holds; the program's output is shortened first to fit. */
export const DISPLAY_FILTER_REPORT_LIMIT = 4_000;

/** How many capture directories are kept under one root; older ones are removed after each run. */
export const KEPT_INVOCATION_OUTPUTS = 20;

/** Exit status of a command killed by SIGPIPE: its reader (the filter) stopped reading. */
const SIGPIPE_STATUS = 141;

/** The longest diagnostic line shown, and the longest line read from a capture file. */
const LINE_LIMIT = 200;
const READ_LINE_LIMIT = 4_096;

const NONCE = /^[0-9a-f]{32}$/;
const DIRECTORY_NAME = /^\d{13}-/;

/** A fresh nonce naming one run's observation function. */
export function observationNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * `text` with the observation wrappers inserted (see the module comment). `pipelines` and `cuts`
 * come from `displayFilterPipelines` and `splitDisplayFilters` of the same text. Undefined when the
 * wrappers cannot be inserted safely: pipelines that do not match the cuts, or a capture directory
 * whose path holds a line break (it would move the program's line numbers).
 */
export function observeDisplayFilters(
  text: string,
  pipelines: readonly DisplayFilterPipeline[],
  cuts: readonly DisplayFilterCut[],
  directory: string,
  nonce: string,
): string | undefined {
  if (!NONCE.test(nonce)) throw new Error("an observation nonce must be 32 hex digits");
  if (directory.includes("\n") || directory.includes("\0")) return undefined;
  if (pipelines.filter((pipeline) => pipeline.cut !== undefined).length !== cuts.length) {
    return undefined;
  }
  const dir = `'${directory.replaceAll("'", "'\\''")}'`;
  const save = `resin_observe_${nonce}`;
  let program = `${save}() { ${save}_s=$?; printf '%s\\n' "$${save}_s" >${dir}/"$1"; return $${save}_s; }; `;
  let from = 0;
  for (const [index, pipeline] of pipelines.entries()) {
    const number = index + 1;
    if (pipeline.start < from || pipeline.end < pipeline.start) return undefined;
    program += text.slice(from, pipeline.start);
    if (pipeline.cut === undefined) {
      program += `{ ${text.slice(pipeline.start, pipeline.end)}; ${save} p${number}; }`;
    } else {
      const cut = cuts[pipeline.cut];
      if (cut === undefined || cut.pipelineStart !== pipeline.start || cut.end !== pipeline.end) {
        return undefined;
      }
      program +=
        `{ { ${text.slice(pipeline.start, cut.start)}; ${save} c${number}; } | tee ${dir}/o${number}` +
        `${text.slice(cut.start, cut.end)}; ${save} p${number}; }`;
    }
    from = pipeline.end;
  }
  return program + text.slice(from);
}

/** Names whose values carry shell options a program may inherit or read. */
const SHELL_OPTION_VARIABLES = /\b(?:SHELLOPTS|BASHOPTS)\b/;

/** Top-level commands that set shell options, or may run code that does in the current shell. */
const SHELL_OPTION_COMMANDS = new Set([
  "set",
  "shopt",
  "eval",
  "source",
  ".",
  "command",
  "builtin",
]);

/**
 * Whether a program may run under shell options that make the wrappers change what it does
 * (`set -e` exits a wrapped producer before its status is written, `set -o pipefail` counts `tee`,
 * `set -x` traces the wrappers): a top-level pipeline whose command is one of
 * `SHELL_OPTION_COMMANDS` or is not a literal word, any reference to `SHELLOPTS` or `BASHOPTS`, or
 * either variable in the environment it runs with. Such a program runs exactly as recorded,
 * without observation.
 */
export function changesShellOptions(
  text: string,
  pipelines: readonly DisplayFilterPipeline[],
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    pipelines.some(
      (pipeline) => pipeline.command === undefined || SHELL_OPTION_COMMANDS.has(pipeline.command),
    ) ||
    SHELL_OPTION_VARIABLES.test(text) ||
    env.SHELLOPTS !== undefined ||
    env.BASHOPTS !== undefined
  );
}

/** A process-wide private directory for capture directories when no root is configured. */
let fallbackRoot: Promise<string> | undefined;

/**
 * A fresh private (0700) capture directory under `root`, or under a private temp directory of this
 * process when no root is given. Its name starts with the creation time, so older ones sort first.
 */
export async function createInvocationOutputDirectory(root: string | undefined): Promise<string> {
  const parent =
    root ?? (await (fallbackRoot ??= mkdtemp(join(tmpdir(), "resin-invocation-output-"))));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(parent, `${String(Date.now()).padStart(13, "0")}-`));
}

/** Removes all but the newest `KEPT_INVOCATION_OUTPUTS` capture directories in `directory`'s parent. */
export async function pruneInvocationOutputs(directory: string): Promise<void> {
  const parent = join(directory, "..");
  let names: string[];
  try {
    names = (await readdir(parent)).filter((name) => DIRECTORY_NAME.test(name)).sort();
  } catch {
    return;
  }
  await Promise.all(
    names
      .slice(0, Math.max(0, names.length - KEPT_INVOCATION_OUTPUTS))
      .map((name) => rm(join(parent, name), { recursive: true, force: true })),
  );
}

/** Reads one status file the observation function wrote; undefined when it never ran. */
async function readStatus(directory: string, name: string): Promise<number | undefined> {
  const path = join(directory, name);
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  await unlink(path).catch(() => {});
  const status = Number.parseInt(text.trim(), 10);
  return Number.isSafeInteger(status) ? status : undefined;
}

/** What one top-level pipeline did. */
export interface ObservedPipeline {
  /** 1-based position in the program. */
  number: number;
  command?: string;
  /** Whether it is a check: a pipeline whose output a display filter selected. */
  check: boolean;
  next: DisplayFilterPipeline["next"];
  /** A check's command's own status (`c<n>`). */
  producer?: number;
  /** The pipeline's own status (`p<n>`): a check's filter's. */
  status?: number;
}

/** Reads every pipeline's status files from a finished observed run's capture directory. */
export async function readObservedPipelines(
  directory: string,
  pipelines: readonly DisplayFilterPipeline[],
): Promise<ObservedPipeline[]> {
  return await Promise.all(
    pipelines.map(async (pipeline, index) => {
      const number = index + 1;
      const check = pipeline.cut !== undefined;
      const [producer, status] = await Promise.all([
        check ? readStatus(directory, `c${number}`) : undefined,
        readStatus(directory, `p${number}`),
      ]);
      return {
        number,
        ...(pipeline.command === undefined ? {} : { command: pipeline.command }),
        check,
        next: pipeline.next,
        ...(producer === undefined ? {} : { producer }),
        ...(status === undefined ? {} : { status }),
      };
    }),
  );
}

/** Whether a pipeline ran at all: some status file of it was written. */
function ran(pipeline: ObservedPipeline): boolean {
  return pipeline.producer !== undefined || pipeline.status !== undefined;
}

/**
 * The pipelines that failed the run, by number: a check whose command exited non-zero (SIGPIPE
 * from its filter closing early excepted), and the last pipeline that ran in an and-or list (a
 * check counted by its command's status) when it ended non-zero. A pipeline whose status a `&&`
 * or `||` consumed is not a failure by itself; one that never ran is no failure.
 */
export function failedPipelines(pipelines: readonly ObservedPipeline[]): Set<number> {
  const failed = new Set<number>();
  /** The last pipeline that ran in the current and-or list. */
  let last: ObservedPipeline | undefined;
  for (const pipeline of pipelines) {
    if (
      pipeline.check &&
      pipeline.producer !== undefined &&
      pipeline.producer !== 0 &&
      pipeline.producer !== SIGPIPE_STATUS
    ) {
      failed.add(pipeline.number);
    }
    if (ran(pipeline)) last = pipeline;
    if (pipeline.next === "&&" || pipeline.next === "||") continue;
    const status = last === undefined ? undefined : (last.producer ?? last.status);
    if (
      last !== undefined &&
      status !== undefined &&
      status !== 0 &&
      !(last.check && last.producer === SIGPIPE_STATUS)
    ) {
      failed.add(last.number);
    }
    last = undefined;
  }
  return failed;
}

/** What one check's unfiltered output holds that the displayed output does not. */
export interface HiddenDiagnostics {
  number: number;
  command?: string;
  /** Diagnostic lines to show (see `hiddenDiagnostics`). */
  lines: string[];
  /** Further hidden diagnostic lines not shown. */
  more: number;
  /** Whether `lines` are the file's last lines, because no diagnostic line was hidden. */
  tail: boolean;
}

const DIAGNOSTIC =
  /\b(?:errors?|warnings?|warn|fail(?:ed|ure|ures)?|fatal|panic(?:ked)?|exceptions?|traceback)\b/gi;

/**
 * How a line reads as a diagnostic: `summary` when it counts a non-zero number of errors, warnings
 * or failures (`1 warnings`, `2 lint warnings`, `failed: 2`), `plain` for any other mention, and
 * undefined for none or only zero counts (`0 errors`, `0 parse errors`, `failed: 0`). A count may
 * name one qualifier word between the number and a plural diagnostic word (`0 parse errors`), but
 * not a singular one (`500 internal error` is a message, not a count).
 */
export function diagnosticKind(line: string): "summary" | "plain" | undefined {
  let kind: "summary" | "plain" | undefined;
  for (const match of line.matchAll(DIAGNOSTIC)) {
    const before = line.slice(0, match.index);
    const after = line.slice(match.index + match[0].length);
    const qualified = /s$/i.test(match[0]) ? "(?:[A-Za-z-]+\\s+)?" : "";
    if (new RegExp(`\\b0+\\s*${qualified}$`).test(before) || /^\s*[:=]\s*0+\b/.test(after))
      continue;
    if (
      new RegExp(`\\b[1-9]\\d*\\s*${qualified}$`).test(before) ||
      /^\s*[:=]\s*[1-9]/.test(after)
    ) {
      return "summary";
    }
    kind = "plain";
  }
  return kind;
}

/**
 * The diagnostic lines of the whole file `path` (a check's unfiltered output) that `displayed`
 * (the lines the program printed) does not hold. Only non-zero count summaries (up to 3, with a
 * count of further ones) are essential for a passing check, or for a failed one whose filter
 * already displayed one of its failure lines (a diagnostic line that is not just a count, such as
 * `FAILED name`): there the other mentions (log lines of tests) stay only in the full output. A
 * displayed count (`Totals: 0 passed, 1 failed`) does not say what failed, so a failed check whose
 * filter displayed only counts shows up to 10 diagnostic lines, or its last 5 lines when none is
 * hidden. Read in chunks, so a failure line early in a huge output is still found.
 */
export async function hiddenDiagnostics(
  path: string,
  displayed: ReadonlySet<string>,
  failed: boolean,
): Promise<Omit<HiddenDiagnostics, "number" | "command"> | undefined> {
  const shown = new Set<string>();
  /** Hidden diagnostic lines of either kind, in order, for a failure the filter did not show. */
  const all: string[] = [];
  let allMore = 0;
  const summaries: string[] = [];
  let summariesMore = 0;
  const last: string[] = [];
  let displayedDiagnostic = false;
  const consider = (raw: string): void => {
    const line = raw.trimEnd();
    if (line.trim().length === 0) return;
    last.push(line);
    if (last.length > 5) last.shift();
    if (displayed.has(line.trim())) {
      if (diagnosticKind(line) === "plain") displayedDiagnostic = true;
      return;
    }
    const kind = diagnosticKind(line);
    if (kind === undefined || shown.has(line)) return;
    // Only lines kept for showing are remembered, so a huge output holds no more than these.
    if (kind === "summary" ? summaries.length < 3 : failed && all.length < 10) shown.add(line);
    if (kind === "summary") {
      if (summaries.length < 3) summaries.push(line);
      else summariesMore += 1;
    }
    if (failed) {
      if (all.length < 10) all.push(line);
      else allMore += 1;
    }
  };
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(64 * 1024);
    let pending = "";
    let overlong = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      const chunk = bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      const parts = (pending + chunk).split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (!overlong) consider(part);
        overlong = false;
      }
      // A line longer than any shown is read only up to the limit.
      if (pending.length > READ_LINE_LIMIT) {
        if (!overlong) consider(pending.slice(0, READ_LINE_LIMIT));
        overlong = true;
        pending = "";
      }
      if (bytesRead === 0) break;
    }
    if (!overlong) consider(pending);
  } finally {
    await handle.close();
  }
  if (!failed || displayedDiagnostic) {
    if (summaries.length === 0) return undefined;
    return { lines: summaries, more: summariesMore, tail: false };
  }
  if (all.length === 0) return { lines: last, more: 0, tail: true };
  return { lines: all, more: allMore, tail: false };
}

/** Everything a report is made of. */
export interface ObservedRunReport {
  stepId: string;
  /** The program's own exit status, and the signal that ended it, if one did. */
  exitCode: number;
  signal?: string;
  /** Per-pipeline outcomes; undefined when the program ran without observation wrappers. */
  pipelines?: readonly ObservedPipeline[];
  failed: ReadonlySet<number>;
  stdout: string;
  stderr: string;
  hidden: readonly HiddenDiagnostics[];
  /** The capture directory and the files it keeps. */
  directory?: string;
  files: readonly string[];
}

function label(pipeline: { number: number; command?: string }): string {
  return `${pipeline.number}${pipeline.command === undefined ? "" : ` (${pipeline.command.slice(0, 60)})`}`;
}

/** One pipeline's status line, never its program text. */
function outcomeLine(
  pipeline: ObservedPipeline,
  failed: boolean,
  later: boolean,
  exitCode: number,
): string {
  let outcome: string;
  if (!ran(pipeline)) {
    outcome =
      later || exitCode === 0
        ? "did not run"
        : "did not run, or did not finish (the program exited)";
  } else if (pipeline.check && pipeline.producer === SIGPIPE_STATUS) {
    outcome = "stopped early when its output filter stopped reading";
  } else {
    const status = pipeline.check ? pipeline.producer : pipeline.status;
    outcome =
      status === undefined
        ? "exit status not recorded"
        : status === 0
          ? "exit 0"
          : failed
            ? `exit ${status} (failed)`
            : `exit ${status} (tested by && or ||, not a failure)`;
  }
  if (pipeline.check && ran(pipeline)) {
    outcome += "; its output is shown filtered";
    if (pipeline.status !== undefined && pipeline.status !== 0) {
      outcome += ` (filter exit ${pipeline.status})`;
    }
  }
  return `  ${label(pipeline)}: ${outcome}`;
}

/**
 * The bounded text an observed run returns (or fails with): a first line, each pipeline's outcome,
 * the program's own output, the diagnostics its filters hid, and where its whole output is kept.
 * At most `DISPLAY_FILTER_REPORT_LIMIT` characters: the output is shortened first, then lines of
 * pipelines that exited 0; status and failure lines are kept.
 */
export function displayFilterReport(report: ObservedRunReport): {
  failed: boolean;
  text: string;
} {
  const { pipelines, failed, exitCode, signal } = report;
  const program = signal === undefined ? `exited ${exitCode}` : `was killed by signal ${signal}`;
  const isFailure = failed.size > 0 || exitCode !== 0 || signal !== undefined;
  const reasons = [...failed].map((number) => {
    const pipeline = pipelines![number - 1]!;
    const status = pipeline.check ? pipeline.producer : pipeline.status;
    return `command ${label(pipeline)} exited ${status}`;
  });
  const head = isFailure
    ? `step '${report.stepId}' failed: ${[...reasons, `the program ${program}`].join("; ")}.`
    : `The program ${program}.`;

  const statusLines: string[] = [];
  if (pipelines === undefined) {
    statusLines.push("Per-command statuses were not available for this program.");
  } else {
    let lastRan = -1;
    for (const [index, pipeline] of pipelines.entries()) if (ran(pipeline)) lastRan = index;
    const lines = pipelines.map((pipeline, index) => ({
      text: outcomeLine(pipeline, failed.has(pipeline.number), index < lastRan, exitCode),
      plain: !failed.has(pipeline.number) && pipeline.status === 0 && !pipeline.check,
    }));
    statusLines.push("Commands:", ...lines.map((line) => line.text));
    const room = DISPLAY_FILTER_REPORT_LIMIT / 2;
    if (statusLines.join("\n").length > room) {
      const kept = lines.filter((line) => !line.plain).map((line) => line.text);
      const dropped = lines.length - kept.length;
      statusLines.length = 0;
      statusLines.push(
        "Commands:",
        ...kept,
        ...(dropped > 0 ? [`  (${dropped} other commands exited 0)`] : []),
      );
    }
  }

  const hiddenLines: string[] = [];
  for (const entry of report.hidden) {
    const which = `command ${label(entry)}`;
    if (entry.tail) {
      hiddenLines.push(
        entry.lines.length === 0
          ? `  ${which}: printed nothing`
          : `  ${which}: no diagnostic line was hidden; its last lines:`,
      );
    } else if (entry.lines.length > 0) {
      hiddenLines.push(`  ${which}:`);
    }
    hiddenLines.push(
      ...entry.lines.map(
        (line) => `    ${line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line}`,
      ),
    );
    if (entry.more > 0) {
      hiddenLines.push(
        entry.lines.length > 0
          ? `    (${entry.more} more diagnostic lines)`
          : `  ${which}: ${entry.more} hidden lines mention errors, warnings or failures`,
      );
    }
  }
  const hidden =
    hiddenLines.length > 0
      ? ["From the unfiltered output of the filtered commands:", ...hiddenLines]
      : [];

  const where: string[] = [];
  if (report.directory !== undefined && report.files.length > 0) {
    where.push(
      `Full output, kept without re-running anything, in ${report.directory}:`,
      ...report.files.map((file) => {
        const match = /^o(\d+)$/.exec(file);
        return `  ${file}: ${match === null ? `the program's ${file}` : `unfiltered output of command ${match[1]}`}`;
      }),
    );
  }

  const fullOutput =
    report.stderr.trim().length === 0
      ? report.stdout
      : `${report.stdout.length === 0 ? "" : `${report.stdout.replace(/\n$/, "")}\n`}stderr:\n${report.stderr}`;
  const fixed = [head, ...statusLines, "Output:", "", ...hidden, ...where].join("\n");
  let output = fullOutput.length === 0 ? "(none: the program printed nothing)" : fullOutput;
  const budget = DISPLAY_FILTER_REPORT_LIMIT - fixed.length;
  if (output.length > budget) {
    const note = `…[output shortened to its last part${report.directory === undefined ? "" : `; all of it is in ${report.directory}`}]\n`;
    const keep = Math.max(0, budget - note.length);
    output = `${note}${keep > 0 ? output.slice(output.length - keep) : ""}`;
  }
  let text = [head, ...statusLines, "Output:", output.replace(/\n$/, ""), ...hidden, ...where].join(
    "\n",
  );
  if (text.length > DISPLAY_FILTER_REPORT_LIMIT) {
    const note = `\n…[report truncated at ${DISPLAY_FILTER_REPORT_LIMIT} characters${report.directory === undefined ? "" : `; full output in ${report.directory}`}]`;
    text = text.slice(0, DISPLAY_FILTER_REPORT_LIMIT - note.length) + note;
  }
  return { failed: isFailure, text };
}

/** Writes the program's captured output into its capture directory. */
export async function keepProgramOutput(
  directory: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  await Promise.all([
    writeFile(join(directory, "stdout"), stdout, { mode: 0o600 }),
    writeFile(join(directory, "stderr"), stderr, { mode: 0o600 }),
  ]);
}
