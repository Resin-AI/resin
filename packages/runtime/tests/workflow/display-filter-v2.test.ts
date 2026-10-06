import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowStep,
  splitDisplayFilters,
  tokenizeProgram,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPromotedPlan } from "../../src/workflow/binding-validation.js";
import {
  displayFilterChunks,
  instrumentDisplayFilters,
} from "../../src/workflow/display-filter-replay.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
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

async function invoke(source: string, dialect: Dialect, cwd: string, replay = false) {
  return runRecordedCall(
    {
      step: filteredStep(source, dialect),
      arguments: { command: source },
      ...(replay ? { displayFilter: "replay" as const } : {}),
    },
    { cwd },
  );
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

      it("replays programs carrying heredocs byte for byte, and runs their commands whole", async () => {
        const workspace = await makeWorkspace();
        for (const source of HEREDOCS) {
          const split = splitDisplayFilters(dialect, source);
          expect(split?.cuts.length, source).toBeGreaterThan(0);
          expect(await invoke(source, dialect, workspace, true), source).toBe(
            recorded(source, dialect, workspace),
          );
          expect(await invoke(source, dialect, workspace), source).toBe(
            recorded(split!.command, dialect, workspace),
          );
        }
        // The PR body reached the command whole, through the opaque heredoc.
        expect(await invoke(HEREDOCS[0]!, dialect, workspace)).toContain(`[${BODY.slice(0, -1)}]`);
      });

      it("returns the commands' whole output to an invocation", async () => {
        const workspace = await makeWorkspace();
        expect(
          await invoke("./emit | grep b; ./noeol | tail -n 1; echo done", dialect, workspace),
        ).toBe("a\nb\nc\nx\ny\nzdone\n");
        expect(await invoke("./mixed 2>&1 | grep err", dialect, workspace)).toBe(
          "out-1\nerr-1\nout-2\nerr-2\n",
        );
      });

      it("runs what follows `&&` only when the command itself succeeded", async () => {
        const workspace = await makeWorkspace();
        const ran = "./emit | grep zzz && echo ran; echo after";
        expect(await invoke(ran, dialect, workspace)).toBe("a\nb\nc\nran\nafter\n");
        // The replay pipes the bracketed output through grep, nothing else changes.
        expect(await invoke(ran, dialect, workspace, true)).toBe("ran\nafter\n");
        const skipped = "./fail | grep a && echo ran; echo after";
        expect(await invoke(skipped, dialect, workspace)).toBe("a\nb\nc\nafter\n");
        expect(await invoke(skipped, dialect, workspace, true)).toBe("a\nafter\n");
        // `$?` after a cut pipeline is the command's own status.
        expect(await invoke("./fail | tail -1; echo $?", dialect, workspace, true)).toBe("c\n1\n");
        // The program's own exit status decides: a failing last command fails both modes.
        await expect(invoke("./fail | tail -1", dialect, workspace)).rejects.toThrow(
          "step 'run' failed: recorded shell program exited with code 1",
        );
        await expect(invoke("./fail | tail -1", dialect, workspace, true)).rejects.toThrow(
          /^step 'run' failed: recorded shell program exited with code 1: a\nb\nc$/,
        );
      });

      it("runs the recorded program whole when the caller switches the filter on", async () => {
        const workspace = await makeWorkspace();
        const source = "./emit | tail -1; ./emit | head -1";
        expect(
          await runRecordedCall(
            {
              step: filteredStep(source, dialect),
              arguments: { command: source },
              displayFilter: "whole",
            },
            { cwd: workspace },
          ),
        ).toBe("c\na\n");
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
    adapters.register(createProcessAdapter({ cwd: workspace }));
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
      expect(invoked.result).toBe(`${expected}a\nb\nc\n`);
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
