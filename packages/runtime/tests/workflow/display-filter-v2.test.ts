import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowStep,
  displayFilterPipelines,
  splitDisplayFilters,
  tokenizeProgram,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPromotedPlan } from "../../src/workflow/binding-validation.js";
import {
  DISPLAY_FILTER_REPORT_LIMIT,
  KEPT_INVOCATION_OUTPUTS,
  diagnosticKind,
  displayFilterReport,
  isRecordedCheckFailure,
  observeDisplayFilters,
} from "../../src/workflow/display-filter-observation.js";
import {
  displayFilterChunks,
  instrumentDisplayFilters,
} from "../../src/workflow/display-filter-replay.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import type { ProgramRunnerOptions } from "../../src/workflow/program-runner.js";
import { runRecordedCall } from "../../src/workflow/program-runner.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const FOREIGN_NONCE = "0123456789abcdef0123456789abcdef";

/** Scripts the programs below run: each prints lines, some without a final newline. */
async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "resin-display-filter-v2-"));
  workspaces.push(workspace);
  const script = async (name: string, body: string) =>
    writeFile(join(workspace, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await script("emit", "printf 'a\\nb\\nc\\n'");
  await script("fail", "printf 'a\\nb\\nc\\n'\nexit 1");
  await script("noeol", "printf 'x\\ny\\nz'");
  await script("mixed", "echo out-1\necho err-1 >&2\necho out-2\necho err-2 >&2");
  await script("args", 'for arg in "$@"; do printf \'[%s]\\n\' "$arg"; done');
  await script("stdin", "printf 'args:%s\\n' \"$*\"\ncat\nprintf 'end\\n'");
  await script(
    "forge",
    // Lines shaped like the replay's markers, under a nonce the replay never uses.
    `printf '%s\\n' '<<RESIN-DISPLAY-FILTER-${FOREIGN_NONCE}-e0>>' keep '<<RESIN-DISPLAY-FILTER-${FOREIGN_NONCE}-b1>>' drop`,
  );
  return workspace;
}

type Dialect = "sh" | "bash";

/** A recorded step running `source` under `dialect` through its `command` argument. */
function filteredStep(source: string, dialect: Dialect): WorkflowStep {
  return {
    id: "run",
    callId: "call-run",
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source, argument: "command", dialect },
    },
    arguments: [{ name: "command", source: { kind: "literal", value: source } }],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
    displayFilter: { version: 2 },
  };
}

/** What `source` printed when its recording ran it whole: stdout of `dialect -c source`. */
function recorded(source: string, dialect: Dialect, cwd: string): string {
  return execFileSync(dialect === "bash" ? "/bin/bash" : "/bin/sh", ["-c", source], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Runs `source` as a recorded step. A replay returns the step's value; an invocation returns the
 * report its caller sees, after checking that the step's value is what the program printed.
 */
async function invoke(source: string, dialect: Dialect, cwd: string, replay = false) {
  let display: string | undefined;
  const value = await runRecordedCall(
    {
      step: filteredStep(source, dialect),
      arguments: { command: source },
      ...(replay ? { displayFilter: "replay" as const } : {}),
      onDisplay: (text) => {
        display = text;
      },
    },
    { cwd, invocationOutputRoot: join(cwd, ".invocation-output") },
  );
  if (replay) return value;
  expect(display, source).toBeDefined();
  // The value later steps bind is the program's own stdout, never the report.
  const stdout = outputOf(display!)
    .replace(/^\(none: the program printed nothing\)$/, "")
    .replace(/(?:^|\n)stderr:\n[\s\S]*$/, "");
  expect(stdout).toBe(String(value).replace(/\n$/, ""));
  return display;
}

/** The capture directory an invocation's report points at. */
function directoryOf(report: string): string {
  const match = /Full output, kept without re-running anything, in (.+):\n/.exec(report);
  expect(match, report).not.toBeNull();
  return match![1]!;
}

/** The program output an invocation's report shows: all of a success's head, a failure's `Output:`. */
function outputOf(report: string): string {
  const match = report.startsWith("step '")
    ? /\nOutput:\n([\s\S]*?)\n(?:From the unfiltered output|Full output)/.exec(report)
    : /^([\s\S]*?)(?:\nFrom the unfiltered output|\nFull output|$)/.exec(report);
  expect(match, report).not.toBeNull();
  return match![1]!;
}

/** The report a failing invocation threw. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected a failure, got ${String(value)}`);
    },
    (caught: unknown) => caught,
  );
  return (error as Error).message;
}

const MULTI_CUT = [
  "./emit 2>&1 | grep -E 'a|c' ; ./emit >/dev/null && echo ok",
  './emit | sort -r | tail -n 2; S=$(./emit | grep -c .); echo "lines=$S"',
  "./noeol | tail -n 2; ./emit | head -1\n./noeol | grep -v y",
  "./mixed 2>&1 | grep err; ./mixed 2>/dev/null | tail -n 1",
  "./emit 2>&1 | tail -2; echo status=$?",
  "./forge | grep -v drop; ./forge | tail -n 1",
  "./emit |\n  grep b &&\n  ./noeol | head -n 1",
];

/** A heredoc body holding separators, pipes, parentheses and delimiter-like lines. */
const BODY =
  "Fixes a | b; c && d ) e\nEOFX\n EOF\nEOF;echo z\n\tEOF\n$(not run) `nor this` \"q\" 'q'\n";

/** Programs carrying heredocs: the user's PR merge, a commit from stdin, and the other forms. */
const HEREDOCS = [
  `./args pr merge 12 --repo o/r --squash --match-head-commit abc123 \\
  --subject 'Fix: a | b' \\
  --body "$(cat <<'EOF'
${BODY}EOF
)" 2>&1 | tail -n 3; ./args pr view 12 --repo o/r --json state --jq '{state}'`,
  `./stdin -q -F - <<'EOF' | tail -n 2\n${BODY}EOF\n./emit | head -1\n`,
  'cat - /dev/fd/3 <<EOF 3<<-"END" | grep -v skip\nhi $((1)) | a\nskip me\nEOF\n\tbye ; b\n\tEND\n./emit | tail -1',
  "./stdin <<\\EOF | head -n 3; echo after\na | b\nEOF\n",
];

describe.skipIf(process.platform === "win32")("version-2 display-filter steps", () => {
  for (const dialect of ["sh", "bash"] as const) {
    describe(dialect, () => {
      it("replays every cut pipeline's output through its filter, byte for byte", async () => {
        const workspace = await makeWorkspace();
        for (const source of MULTI_CUT) {
          expect(splitDisplayFilters(dialect, source)?.cuts.length, source).toBeGreaterThan(0);
          expect(await invoke(source, dialect, workspace, true), source).toBe(
            recorded(source, dialect, workspace),
          );
        }
      });

      it("replays programs carrying heredocs byte for byte, and runs them as recorded", async () => {
        const workspace = await makeWorkspace();
        for (const source of HEREDOCS) {
          const split = splitDisplayFilters(dialect, source);
          expect(split?.cuts.length, source).toBeGreaterThan(0);
          expect(await invoke(source, dialect, workspace, true), source).toBe(
            recorded(source, dialect, workspace),
          );
          const report = String(await invoke(source, dialect, workspace));
          expect(`${outputOf(report)}\n`, source).toBe(recorded(source, dialect, workspace));
        }
        // The PR body reached the command whole, through the opaque heredoc; nothing was hidden, so
        // no capture location is shown.
        const report = String(await invoke(HEREDOCS[0]!, dialect, workspace));
        expect(report).toContain(`${BODY.slice(BODY.indexOf("EOF;echo z"), -1)}]`);
        expect(report).not.toContain("Full output");
      });

      it("runs the program as recorded: the filter's status decides what follows `&&`", async () => {
        const workspace = await makeWorkspace();
        // grep selected nothing, so `echo ran` did not run, exactly as recorded; the command passed.
        const ran = "./emit | grep zzz && echo ran; echo after";
        const passed = String(await invoke(ran, dialect, workspace));
        expect(passed).not.toContain("Commands:");
        expect(outputOf(passed)).toBe("after");
        // The replay pipes the bracketed output through grep, nothing else changes.
        expect(await invoke(ran, dialect, workspace, true)).toBe("ran\nafter\n");
        // grep selected a line, so `echo ran` ran; the command's own failure still fails the step.
        const skipped = "./fail | grep a && echo ran; echo after";
        const failed = await failure(invoke(skipped, dialect, workspace));
        expect(failed).toMatch(
          /^step 'run' failed: command 1 \(\.\/fail\) exited 1; the program exited 0\.\n/,
        );
        expect(failed).toContain("  1 (./fail): exit 1 (failed); its output is shown filtered\n");
        expect(outputOf(failed)).toBe("a\nran\nafter");
        expect(await invoke(skipped, dialect, workspace, true)).toBe("a\nafter\n");
        // `$?` after a cut pipeline is the command's own status under replay.
        expect(await invoke("./fail | tail -1; echo $?", dialect, workspace, true)).toBe("c\n1\n");
        // An invocation sees the filter's, as the recording did.
        expect(
          outputOf(await failure(invoke("./fail | tail -1; echo $?", dialect, workspace))),
        ).toBe("c\n0");
        await expect(invoke("./fail | tail -1", dialect, workspace, true)).rejects.toThrow(
          /^step 'run' failed: recorded shell program exited with code 1: a\nb\nc$/,
        );
      });

      it("pipes each command's output through its filter when the caller switches it on", async () => {
        const workspace = await makeWorkspace();
        const whole = async (source: string) =>
          runRecordedCall(
            {
              step: filteredStep(source, dialect),
              arguments: { command: source },
              displayFilter: "whole",
            },
            { cwd: workspace },
          );
        expect(await whole("./emit | tail -1; ./emit | head -1")).toBe("c\na\n");
        // The command's own status decides what follows `&&`, not the grep that selected nothing.
        expect(await whole("./emit | grep zzz && echo ran")).toBe("ran\n");
      });
    });
  }

  it("never lets output shaped like a marker move the splice", async () => {
    const workspace = await makeWorkspace();
    const source = "./forge | grep -v drop";
    expect(await invoke(source, "sh", workspace, true)).toBe(
      `<<RESIN-DISPLAY-FILTER-${FOREIGN_NONCE}-e0>>\nkeep\n<<RESIN-DISPLAY-FILTER-${FOREIGN_NONCE}-b1>>\n`,
    );
    // Output carrying the replay's own nonce outside its brackets is refused, never spliced.
    const nonce = "fedcba9876543210fedcba9876543210";
    const marks = (text: string) => text.replaceAll("<N>", nonce);
    expect(
      displayFilterChunks(
        marks("x<<RESIN-DISPLAY-FILTER-<N>-b0>>y<<RESIN-DISPLAY-FILTER-<N>-e0>>z"),
        nonce,
        1,
      ),
    ).toEqual([{ text: "x" }, { text: "y", cut: 0 }, { text: "z" }]);
    for (const stdout of [
      "<<RESIN-DISPLAY-FILTER-<N>-b0>>y",
      "<<RESIN-DISPLAY-FILTER-<N>-b0>>y<<RESIN-DISPLAY-FILTER-<N>-b0>><<RESIN-DISPLAY-FILTER-<N>-e0>>",
      "<<RESIN-DISPLAY-FILTER-<N>-b0>>y<<RESIN-DISPLAY-FILTER-<N>-e0>><<RESIN-DISPLAY-FILTER-<N>-e0>>",
      "<<RESIN-DISPLAY-FILTER-<N>-b1>>y<<RESIN-DISPLAY-FILTER-<N>-e1>><<RESIN-DISPLAY-FILTER-<N>-b0>>y<<RESIN-DISPLAY-FILTER-<N>-e0>>",
    ])
      expect(displayFilterChunks(marks(stdout), nonce, 2), stdout).toBeUndefined();
    // A cut that never ran has no chunk.
    expect(
      displayFilterChunks(
        marks("<<RESIN-DISPLAY-FILTER-<N>-b1>><<RESIN-DISPLAY-FILTER-<N>-e1>>"),
        nonce,
        2,
      ),
    ).toEqual([{ text: "" }, { text: "", cut: 1 }, { text: "" }]);
  });

  it("inserts only the marker wrappers, at the cut pipelines' exact offsets", () => {
    const source = "a 2>&1 | grep x ; b >/dev/null && c | tail -2";
    const split = splitDisplayFilters("bash", source)!;
    const nonce = "00000000000000000000000000000000";
    const mark = `resin_display_filter_${nonce}`;
    expect(instrumentDisplayFilters(source, split.cuts, nonce)).toBe(
      `${mark}() { ${mark}_status=$?; printf '%s' "<<RESIN-DISPLAY-FILTER-${nonce}-$1>>"; return $${mark}_status; }; ` +
        `{ ${mark} b0; a 2>&1; ${mark} e0; } ; b >/dev/null && { ${mark} b1; c; ${mark} e1; }`,
    );
    expect(() => instrumentDisplayFilters(source, split.cuts, "x")).toThrow();
  });

  it("refuses a resolved program that no longer cuts where the recorded one does", async () => {
    const workspace = await makeWorkspace();
    const step = filteredStep("./emit | tail -1; ./emit | head -1", "sh");
    for (const command of [
      "./emit | tail -1; ./emit | wc -l",
      "./emit | tail -1; ./emit | head -1; ./emit | grep a",
      "./emit | tail -2; ./emit | head -1",
    ])
      await expect(
        runRecordedCall({ step, arguments: { command } }, { cwd: workspace }),
      ).rejects.toThrow(
        "step 'run' cannot run: the program does not end in the display filter this step drops",
      );
  });

  it("keeps hostile bound values inside their quoted holes, never adding a cut", async () => {
    const workspace = await makeWorkspace();
    const source = "./args hello there | grep -v zzz; ./emit | tail -n 1";
    const tokens = tokenizeProgram("shell", source);
    const hole = (raw: string) => tokens.findIndex((token) => token.raw === raw);
    const step: WorkflowStep = {
      ...filteredStep(source, "bash"),
      arguments: [
        {
          name: "command",
          source: {
            kind: "template",
            template: {
              type: "program",
              language: "shell",
              source: { type: "literal", value: source },
              holes: [
                { token: hole("hello"), binding: { type: "input", name: "first" } },
                { token: hole("there"), binding: { type: "input", name: "second" } },
              ],
            },
          },
        },
      ],
    };
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf-display-filter-hostile",
      inputs: [
        { name: "first", type: "string", required: true },
        { name: "second", type: "string", required: true },
      ],
      steps: [step],
    };
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(
      createProcessAdapter({ cwd: workspace, invocationOutputRoot: join(workspace, ".out") }),
    );
    for (const [first, second] of [
      ["x | head -1", "y; ./emit | tail -1"],
      ['it\'s "q"', "$(echo pwned) `echo pwned` ${HOME}"],
      ["a\n./emit | head -1\n", "b && ./emit | grep a || true"],
      ["'; ./emit | tail -n 1; '", '"; ./emit | tail -n 1; "'],
    ]) {
      const expected = `[${first}]\n[${second}]\n`;
      const invoked = await executeRecordedWorkflow(plan, {
        inputs: { first, second },
        adapters,
      });
      expect(invoked.status, first).toBe("completed");
      // Later steps bind what the program printed; the caller sees the report.
      expect(invoked.result).toBe(`${expected}c\n`);
      const outcome = invoked.steps[0];
      const display = outcome?.status === "completed" ? outcome.display : undefined;
      expect(outputOf(String(display))).toBe(`${expected}c`);
      const replayed = await executeRecordedWorkflow(plan, {
        inputs: { first, second },
        adapters,
        applyDisplayFilters: true,
      });
      expect(replayed.result).toBe(`${expected}c\n`);
    }
  });

  it("confirms a plan against a recording whose reference is the filtered output", async () => {
    const workspace = await makeWorkspace();
    const source = "./emit 2>&1 | grep -E 'a|c' ; ./noeol | tail -n 1 && echo ok";
    const environment = (observed: string) => {
      const adapters = new RuntimeAdapterRegistry();
      adapters.register(createProcessAdapter({ cwd: workspace }));
      return { adapters, inputs: {}, observed: { run: observed }, timeoutMs: 10_000 };
    };
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf-display-filter-v2-confirm",
      inputs: [],
      steps: [filteredStep(source, "bash")],
    };
    const output = recorded(source, "bash", workspace);
    expect(output).toBe("a\nc\nzok\n");
    const confirmed = await confirmPromotedPlan({
      plan,
      accepted: [],
      environment: environment(output),
    });
    expect(confirmed.verification.status).toBe("verified");
    const missed = await confirmPromotedPlan({
      plan,
      accepted: [],
      environment: environment("a\nb\nc\nx\ny\nzok\n"),
    });
    expect(missed.verification.status).toBe("failed");
  });
});

describe.skipIf(process.platform === "win32")("invoking a version-2 display-filter step", () => {
  /** Scripts shaped like a formatter, a linter and test runners. */
  async function makeTools(): Promise<string> {
    const workspace = await makeWorkspace();
    const script = async (name: string, body: string) =>
      writeFile(join(workspace, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await script("fmt", "echo 'src/a.lua would be reformatted' >&2\nexit 1");
    await script(
      "lint",
      "echo 'checking 12 files'\necho 'warning[unused]: x is unused'\necho '1 warnings'\necho '0 errors'",
    );
    await script(
      "tests",
      "echo 'error: test_one panicked at src/a.rs:3'\nfor i in 1 2 3 4 5 6 7 8; do echo \"ok $i\"; done\necho 'done'\nexit 1",
    );
    await script(
      "huge",
      "echo 'FATAL: early failure in setup'\ni=0\nwhile [ $i -lt 30000 ]; do echo \"progress line $i of the run\"; i=$((i+1)); done\necho 'Totals: 0 passed, 1 failed'\nexit 1",
    );
    return workspace;
  }

  it("fails on a failing command in an uncut pipeline ending an and-or list", async () => {
    const workspace = await makeTools();
    // The formatter fails: `&&` skips the rest, and the program exits 1, as recorded.
    const skipped = await failure(invoke("./fmt && ./lint | tail -n 1", "bash", workspace));
    expect(skipped).toMatch(
      /^step 'run' failed: command 1 \(\.\/fmt\) exited 1; the program exited 1\.\n/,
    );
    expect(skipped).toContain("  1 (./fmt): exit 1 (failed)\n  2 (./lint): did not run");
    expect(skipped).toContain("stderr:\nsrc/a.lua would be reformatted");
    // After `;` the rest runs and the program exits 0, but the formatter's list still failed.
    const continued = await failure(invoke("./fmt; ./lint | tail -n 1", "bash", workspace));
    expect(continued).toMatch(
      /^step 'run' failed: command 1 \(\.\/fmt\) exited 1; the program exited 0\.\n/,
    );
    expect(continued).toContain("  2 (./lint): exit 0; its output is shown filtered\n");
    // `|| true` consumes the status: no failure.
    const tested = String(await invoke("./fmt || true; ./lint | tail -n 1", "bash", workspace));
    expect(tested).not.toContain("Commands:");
    expect(outputOf(tested)).toBe("0 errors\nstderr:\nsrc/a.lua would be reformatted");
  });

  it("classifies a check that ran to completion and failed apart from execution failures", async () => {
    const workspace = await makeTools();
    const thrown = async (source: string) =>
      invoke(source, "bash", workspace).then(
        (value) => {
          throw new Error(`expected a failure, got ${String(value)}`);
        },
        (caught: unknown) => caught,
      );
    // Every command ran; the last one, a check, exited 1: the tool worked and reports the failure.
    const check = await thrown("./lint && ./tests 2>&1 | tail -n 1");
    expect(isRecordedCheckFailure(check)).toBe(true);
    expect((check as Error).message).toMatch(
      /^step 'run' failed: command 2 \(\.\/tests\) exited 1; the program exited 0\.\nCommands:\n {2}1 \(\.\/lint\): exit 0\n {2}2 \(\.\/tests\): exit 1 \(failed\); its output is shown filtered\n/,
    );
    // A command that did not run, or one that was not found, is not a completed check failure.
    const skipped = await thrown("./fmt && ./lint | tail -n 1");
    expect((skipped as Error).message).toContain("  2 (./lint): did not run");
    expect(isRecordedCheckFailure(skipped)).toBe(false);
    const missing = await thrown("./missing | tail -n 1");
    expect((missing as Error).message).toContain("exited 127");
    expect(isRecordedCheckFailure(missing)).toBe(false);

    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const outcome = async (source: string) =>
      (
        await executeRecordedWorkflow(
          {
            schemaVersion: 1,
            workflowId: "wf-display-filter-v2-check",
            inputs: [],
            steps: [filteredStep(source, "bash")],
          },
          { adapters, inputs: {}, timeoutMs: 10_000 },
        )
      ).steps[0];
    expect(await outcome("./lint && ./tests 2>&1 | tail -n 1")).toMatchObject({
      status: "failed",
      check: true,
    });
    expect(await outcome("./fmt && ./lint | tail -n 1")).not.toHaveProperty("check");
  });

  it("fails on a command's failure its tail filter hides, showing the hidden failure line", async () => {
    const workspace = await makeTools();
    const report = await failure(invoke("./tests 2>&1 | tail -n 1", "sh", workspace));
    expect(report).toMatch(
      /^step 'run' failed: command 1 \(\.\/tests\) exited 1; the program exited 0\.\n/,
    );
    expect(outputOf(report)).toBe("done");
    expect(report).toContain(
      "From the unfiltered output of the filtered commands:\n  command 1 (./tests):\n    error: test_one panicked at src/a.rs:3\n",
    );
    const directory = directoryOf(report);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(directory, "o1"), "utf8")).toContain("ok 8\ndone\n");
    expect(await readFile(join(directory, "stdout"), "utf8")).toBe("done\n");
    expect((await readdir(directory)).sort()).toEqual(["o1", "stderr", "stdout"]);
  });

  it("passes a check whose filter hides a non-zero warning summary, and shows the summary", async () => {
    const workspace = await makeTools();
    const report = String(await invoke("./lint 2>&1 | tail -n 1", "bash", workspace));
    expect(outputOf(report)).toBe("0 errors");
    // The non-zero summary is shown; the plain warning line of a passing check is not essential
    // and stays only in the full output.
    expect(report).toContain("  command 1 (./lint):\n    1 warnings\nFull output, kept");
    expect(report).not.toContain("more diagnostic lines");
    expect(report).not.toContain("hidden lines mention");
    expect(diagnosticKind("0 errors, 0 warnings")).toBeUndefined();
    expect(diagnosticKind("Totals: 12 passed, 0 failed")).toBeUndefined();
    // A count with one qualifier word is still a count: selene's `0 parse errors` must not
    // read as a displayed failure line (it would hide a failed lint's error lines).
    expect(diagnosticKind("0 parse errors")).toBeUndefined();
    expect(diagnosticKind("2 lint warnings")).toBe("summary");
    expect(diagnosticKind("Simulated DataStore 500 internal error. Failing closed")).toBe("plain");
    expect(diagnosticKind("failed: 0")).toBeUndefined();
    expect(diagnosticKind("0 errors, 3 warnings")).toBe("summary");
    expect(diagnosticKind("FAILED tests/a.py::test_b")).toBe("plain");
    expect(diagnosticKind("Traceback (most recent call last):")).toBe("plain");
    expect(diagnosticKind("terror and errorless")).toBeUndefined();
  });

  it("reports empty filtered output, passing on exit 0 and failing on exit 1", async () => {
    const workspace = await makeTools();
    const passed = String(await invoke("./emit | grep zzz || true", "bash", workspace));
    expect(outputOf(passed)).toBe("(none: the program printed nothing)");
    const failed = await failure(invoke("./emit | grep zzz", "bash", workspace));
    expect(failed).toMatch(/^step 'run' failed: the program exited 1\.\n/);
    expect(failed).toContain(
      "  1 (./emit): exit 0; its output is shown filtered (filter exit 1)\n",
    );
    expect(outputOf(failed)).toBe("(none: the program printed nothing)");
  });

  it("bounds the report of a huge output, finding a failure line early in it", async () => {
    const workspace = await makeTools();
    const report = await failure(invoke("./huge 2>&1 | tail -n 3", "bash", workspace));
    expect(report.length).toBeLessThanOrEqual(DISPLAY_FILTER_REPORT_LIMIT);
    expect(report).toContain("    FATAL: early failure in setup\n");
    const full = await readFile(join(directoryOf(report), "o1"), "utf8");
    expect(full.split("\n").length).toBe(30_003);
    // An unfiltered-through output too long to show is shortened, never the status lines.
    const long = await failure(invoke("./huge 2>&1 | grep -v zzz", "bash", workspace));
    expect(long.length).toBeLessThanOrEqual(DISPLAY_FILTER_REPORT_LIMIT);
    expect(long).toMatch(
      /^step 'run' failed: command 1 \(\.\/huge\) exited 1; the program exited 0\.\n/,
    );
    expect(long).toContain("…[output shortened to its last part; all of it is in ");
    expect(long).toContain("Totals: 0 passed, 1 failed\n");
    expect(long).toContain("Full output, kept without re-running anything, in ");
  });

  it("shows a success's whole output when it fits without the output-location lines", () => {
    const success = (stdout: string) =>
      displayFilterReport({
        stepId: "run",
        exitCode: 0,
        pipelines: [],
        failed: new Set(),
        stdout,
        stderr: "",
        hidden: [],
        directory: "/tmp/kept",
        files: ["o1", "stdout", "stderr"],
      });
    // Fits the report only while the location lines, shown on a success only when something was
    // hidden or shortened, are left out.
    const fits = `${"x".repeat(DISPLAY_FILTER_REPORT_LIMIT - 2)}\n`;
    expect(success(fits)).toEqual({ failed: false, text: fits.slice(0, -1) });
    const tooLong = success(`${"y".repeat(DISPLAY_FILTER_REPORT_LIMIT)}z\n`);
    expect(tooLong.text.length).toBeLessThanOrEqual(DISPLAY_FILTER_REPORT_LIMIT);
    expect(tooLong.text).toMatch(
      /^…\[output shortened to its last part; all of it is in \/tmp\/kept\]\n/,
    );
    expect(tooLong.text).toContain(
      "z\nFull output, kept without re-running anything, in /tmp/kept:",
    );
  });

  it("reports a command its `head` filter stopped early as no failure", async () => {
    const workspace = await makeTools();
    const report = String(await invoke("yes | head -n 2 && echo done", "bash", workspace));
    expect(outputOf(report)).toBe("y\ny\ndone");
  });

  it("inserts only the observation wrappers, at the pipelines' exact offsets, on the first line", () => {
    const source = "a 2>&1 | grep x ; b >/dev/null && c | tail -2 # end\nd";
    const nonce = "00000000000000000000000000000000";
    const save = `resin_observe_${nonce}`;
    const observed = observeDisplayFilters(
      source,
      displayFilterPipelines("bash", source)!,
      splitDisplayFilters("bash", source)!.cuts,
      "/tmp/o'k",
      nonce,
    );
    const dir = "'/tmp/o'\\''k'";
    expect(observed).toBe(
      `${save}() { ${save}_s=$?; printf '%s\\n' "$${save}_s" >${dir}/"$1"; return $${save}_s; }; ` +
        `{ { a 2>&1; ${save} c1; } | tee ${dir}/o1 | grep x; ${save} p1; } ; ` +
        `{ b >/dev/null; ${save} p2; } && { { c; ${save} c3; } | tee ${dir}/o3 | tail -2; ${save} p3; } # end\n` +
        `{ d; ${save} p4; }`,
    );
    expect(observed!.split("\n").length).toBe(source.split("\n").length);
    // A capture directory whose path would add a line is refused.
    expect(
      observeDisplayFilters(
        source,
        displayFilterPipelines("bash", source)!,
        splitDisplayFilters("bash", source)!.cuts,
        "/tmp/a\nb",
        nonce,
      ),
    ).toBeUndefined();
  });

  /** Runs `source` once, returning the step's value and the report its caller sees. */
  async function run(source: string, workspace: string, extra: ProgramRunnerOptions = {}) {
    let display: string | undefined;
    const value = await runRecordedCall(
      {
        step: filteredStep(source, "bash"),
        arguments: { command: source },
        onDisplay: (text) => {
          display = text;
        },
      },
      { cwd: workspace, invocationOutputRoot: join(workspace, ".invocation-output"), ...extra },
    );
    return { value, display };
  }

  it("runs exactly as recorded, without statuses, when no capture directory can be made", async () => {
    const workspace = await makeTools();
    const blocked = join(workspace, "blocked");
    await writeFile(blocked, "a file, not a directory");
    const { value, display } = await run("./emit | tail -n 1 && echo ok", workspace, {
      invocationOutputRoot: join(blocked, "out"),
    });
    expect(value).toBe("c\nok\n");
    expect(display).toBe("c\nok");
  });

  it("runs a program that may change shell options exactly as recorded, unobserved", async () => {
    const workspace = await makeTools();
    // `set -e`: unwrapped, the failing producer of a cut pipeline does not stop the program.
    const set = await run("set -e; ./fail | tail -n 1; echo after", workspace);
    expect(set.value).toBe("c\nafter\n");
    expect(set.display).toBe("c\nafter");
    const shopt = await run("shopt -s nullglob\n./emit | head -n 1", workspace);
    expect(shopt.value).toBe("a\n");
    expect(shopt.display).toBe("a");
    const read = await run('echo "$SHELLOPTS" >/dev/null; ./emit | head -n 1', workspace);
    expect(read.display).toBe("a");
    for (const name of ["SHELLOPTS", "BASHOPTS"]) {
      const inherited = await run("./emit | head -n 1", workspace, {
        env: { [name]: name === "SHELLOPTS" ? "errexit" : "nullglob" },
      });
      expect(inherited.value, name).toBe("a\n");
      expect(inherited.display, name).toBe("a");
    }
    // Without any of them the same program runs observed and shows the same output.
    expect((await run("./emit | head -n 1", workspace)).display).toBe("a");
  });

  it("keeps only the newest capture directories", async () => {
    const workspace = await makeTools();
    const root = join(workspace, ".invocation-output");
    await mkdir(root, { recursive: true });
    for (let index = 0; index < KEPT_INVOCATION_OUTPUTS + 5; index += 1)
      await mkdir(join(root, `${String(index).padStart(13, "0")}-old`));
    await invoke("./emit | tail -n 1", "bash", workspace);
    const kept = await readdir(root);
    expect(kept.length).toBe(KEPT_INVOCATION_OUTPUTS);
    expect(kept).not.toContain("0000000000000-old");
  });

  it("stops the whole observed program, tee included, when cancelled", async () => {
    const workspace = await makeTools();
    await writeFile(join(workspace, "slow"), "#!/bin/sh\necho start\n: > started\nsleep 30\n", {
      mode: 0o755,
    });
    const controller = new AbortController();
    // Cancel once the program is running: its script creates `started`.
    const watcher = watch(workspace, (_event, name) => {
      if (name === "started") controller.abort(new Error("caller cancelled"));
    });
    const outputRoot = join(workspace, ".invocation-output");
    try {
      await expect(
        runRecordedCall(
          {
            step: filteredStep("./slow | tail -n 1", "bash"),
            arguments: { command: "./slow | tail -n 1" },
            signal: controller.signal,
          },
          { cwd: workspace, invocationOutputRoot: outputRoot },
        ),
      ).rejects.toThrow(/caller cancelled/);
    } finally {
      watcher.close();
    }
    // The run settles only once every process holding its output closed it: tee is gone too.
    expect(execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })).not.toContain(outputRoot);
  });

  it("passes the program's own output to a later step, the report only to the caller", async () => {
    const workspace = await makeTools();
    const first = "./emit | tail -n 1; ./lint 2>&1 | tail -n 1";
    const second = "./args VALUE";
    const { displayFilter: _unfiltered, ...plainStep } = filteredStep(second, "bash");
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf-display-filter-v2-chain",
      inputs: [],
      steps: [
        filteredStep(first, "bash"),
        {
          ...plainStep,
          id: "show",
          callId: "call-show",
          dependsOn: ["run"],
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: {
                  type: "program",
                  language: "shell",
                  source: { type: "literal", value: second },
                  holes: [
                    {
                      token: tokenizeProgram("shell", second).findIndex(
                        (token) => token.raw === "VALUE",
                      ),
                      binding: { type: "result", stepId: "run", path: [] },
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    };
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(
      createProcessAdapter({ cwd: workspace, invocationOutputRoot: join(workspace, ".out") }),
    );
    const invoked = await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(invoked.status, invoked.error).toBe("completed");
    const [run, show] = invoked.steps;
    expect(run?.status === "completed" ? run.result : undefined).toBe("c\n0 errors\n");
    expect(run?.status === "completed" ? run.display : undefined).toMatch(
      /^c\n0 errors\nFrom the unfiltered output[\s\S]*\n {4}1 warnings\n/,
    );
    expect(invoked.result).toBe("[c\n0 errors\n]\n");
    expect(show?.status === "completed" ? show.display : "absent").toBeUndefined();
  });
});
