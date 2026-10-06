import { describe, expect, it } from "vitest";
import {
  DISPLAY_FILTER_VERSION,
  DISPLAY_FILTER_VERSIONS,
  RECORDED_WORKFLOW_SCHEMA_VERSION,
  renderProgramTokenValue,
  splitDisplayFilter,
  splitDisplayFilters,
  tokenizeProgram,
  validateRecordedWorkflow,
} from "../src/index.js";

describe("splitDisplayFilter", () => {
  it("drops the trailing display-filter stages, keeping exact slices of the program", () => {
    expect(DISPLAY_FILTER_VERSION).toBe(2);
    expect(splitDisplayFilter("bash", "pnpm vitest run 2>&1 | tail -30")).toEqual({
      command: "pnpm vitest run 2>&1",
      filter: "tail -30",
    });
    expect(splitDisplayFilter("bash", "gh pr checks 12 | grep -E 'fail|pass' | head -5")).toEqual({
      command: "gh pr checks 12",
      filter: "grep -E 'fail|pass' | head -5",
    });
    expect(splitDisplayFilter("sh", "git log --oneline  |  egrep fix\t| fgrep -v wip")).toEqual({
      command: "git log --oneline",
      filter: "egrep fix\t| fgrep -v wip",
    });
    // Only the trailing run: a grep before a non-filter stage stays in the command.
    expect(splitDisplayFilter("dash", "cat notes | grep x | sort | head -3")).toEqual({
      command: "cat notes | grep x | sort",
      filter: "head -3",
    });
    expect(splitDisplayFilter("sh-or-zsh", "make test | tail -n 20")).toEqual({
      command: "make test",
      filter: "tail -n 20",
    });
    expect(splitDisplayFilter("bash", "pytest -q | grep -v 'passed' | tail -2", 1)).toEqual({
      command: "pytest -q",
      filter: "grep -v 'passed' | tail -2",
    });
    // A chain keeps its earlier segments verbatim, builtins included; quotes may hold Unicode.
    expect(
      splitDisplayFilter(
        "bash",
        'cd packages/frontend && npx vitest run a.test.tsx 2>&1 | grep -E "×|FAIL" | head -40',
      ),
    ).toEqual({
      command: "cd packages/frontend && npx vitest run a.test.tsx 2>&1",
      filter: 'grep -E "×|FAIL" | head -40',
    });
    expect(splitDisplayFilter("bash", "sleep 5; gh pr checks 12 --watch 2>&1 | tail -4")).toEqual({
      command: "sleep 5; gh pr checks 12 --watch 2>&1",
      filter: "tail -4",
    });
    expect(splitDisplayFilter("dash", "./prep\n./run =x 2>&1| grep '✓ ok' \n")).toEqual({
      command: "./prep\n./run =x 2>&1",
      filter: "grep '✓ ok'",
    });
    expect(splitDisplayFilter("bash", "grep -c x notes | sort && make | tail -2")).toEqual({
      command: "grep -c x notes | sort && make",
      filter: "tail -2",
    });
    // A double-quoted pattern may end in `$` and carry a backslash it does not escape.
    expect(splitDisplayFilter("bash", 'make 2>&1 | grep -vE "^\\s+at " | grep -v "^$"')).toEqual({
      command: "make 2>&1",
      filter: 'grep -vE "^\\s+at " | grep -v "^$"',
    });
  });

  it("splits nothing that is not a display filter", () => {
    for (const text of [
      "ls | wc -l",
      "tail -f log | grep x",
      "make | tail -F log",
      "make | tail -nf 5",
      "make | tail --follow=name log",
      "make | tail --retry",
      "make | tail --pid=4 log",
      "make | grep -c x",
      "make | grep -vl x",
      "make | grep -o x",
      "make | grep -q x",
      "make | grep --count x",
      "make | grep --only-matching x",
      "make | grep --null-data x",
      "make | grep x > out",
      "make | grep x 2> err",
      "make | head -5 < in",
      "make | tail 2>&1",
    ])
      expect(splitDisplayFilter("bash", text), text).toBeUndefined();
  });

  it("splits only a program in its own grammar under a POSIX shell and a known version", () => {
    for (const text of [
      "a | grep x || true",
      'a | grep "$X"',
      "a $(b) | tail",
      "a > f | tail",
      "make | tail -$N",
      "make || ls | tail",
      "make |& tail",
      "make >&2 | tail",
      "make 1>&2 | tail",
      "make & ls | tail",
      "a ;; b | tail",
      "a | | tail",
      "; a | tail",
      "a\n\nb | tail",
      "a | tail;",
      "a | tail &&",
      "a |\ntail",
      "2>&1 | tail",
      "a 2>&1x | tail",
      "a ×| tail",
      "a 'x\ny' | tail",
      "a | grep 'x\ty'",
      'a | grep "x\\\\y"',
      'a | grep "x\\$y"',
      'a | grep "x\\"y"',
      'a | grep "x\\"',
      'a | grep "x$y"',
      'a | grep "x`y`"',
      'a | grep "x!"',
      "a | grep 'unterminated",
      "a | tail # note",
      "tail -5",
      "grep x notes | head -5",
      "make | tail && ls",
    ])
      expect(splitDisplayFilter("bash", text), text).toBeUndefined();
    expect(splitDisplayFilter("pwsh", "make | tail -5")).toBeUndefined();
    expect(splitDisplayFilter("zsh", "make | tail -5")).toBeUndefined();
    expect(splitDisplayFilter("bash", "make | tail -5", 2)).toBeUndefined();
  });
});

/** The cuts of a version-2 split as `[dropped text, filter]` pairs, for readable expectations. */
const cutsOf = (shell: string, text: string) => {
  const split = splitDisplayFilters(shell, text, 2);
  return split === undefined
    ? undefined
    : {
        command: split.command,
        cuts: split.cuts.map((cut) => [text.slice(cut.start, cut.end), cut.filter]),
      };
};

describe("splitDisplayFilters", () => {
  it("drops the trailing display filter of every top-level pipeline, keeping the rest verbatim", () => {
    expect(DISPLAY_FILTER_VERSIONS).toEqual([1, 2]);
    expect(cutsOf("bash", "A 2>&1 | grep -E 'x|y' ; B >/dev/null && echo ok")).toEqual({
      command: "A 2>&1 ; B >/dev/null && echo ok",
      cuts: [[" | grep -E 'x|y'", "grep -E 'x|y'"]],
    });
    expect(
      cutsOf("bash", 'A | sort -V | tail -n 4; S=$(git rev-parse origin/main); echo "main=$S"'),
    ).toEqual({
      command: 'A | sort -V; S=$(git rev-parse origin/main); echo "main=$S"',
      cuts: [[" | tail -n 4", "tail -n 4"]],
    });
    expect(cutsOf("sh", "build 2>&1 | tail -8; echo build=$?")).toEqual({
      command: "build 2>&1; echo build=$?",
      cuts: [[" | tail -8", "tail -8"]],
    });
    expect(cutsOf("dash", "A 2>&1 | tail -n 2")).toEqual({
      command: "A 2>&1",
      cuts: [[" | tail -n 2", "tail -n 2"]],
    });
    expect(cutsOf("bash", "A | tail -n 3 && B")).toEqual({
      command: "A && B",
      cuts: [[" | tail -n 3", "tail -n 3"]],
    });
    // Several cuts; kept text with redirections, expansions and quotes stays byte for byte.
    expect(
      cutsOf(
        "bash",
        'pnpm exec vitest run "$F" 2>&1 | grep -E \'Test Files|Tests|FAIL\' ; pnpm exec oxlint ${G:-src} >/dev/null && echo \'oxlint: ok\'\nnpx tsc --noEmit -p "$(pwd)/x" 2>&1 | head -20 || echo "tsc=$?"',
      ),
    ).toEqual({
      command:
        'pnpm exec vitest run "$F" 2>&1 ; pnpm exec oxlint ${G:-src} >/dev/null && echo \'oxlint: ok\'\nnpx tsc --noEmit -p "$(pwd)/x" 2>&1 || echo "tsc=$?"',
      cuts: [
        [" | grep -E 'Test Files|Tests|FAIL'", "grep -E 'Test Files|Tests|FAIL'"],
        [" | head -20", "head -20"],
      ],
    });
    // Line breaks after `|` and `&&`, line continuations, blank lines and comments delimit as the
    // shell reads them; trailing blanks and a trailing comment are not part of the command.
    expect(
      cutsOf(
        "bash",
        "# build\nmake \\\n  all |\n  tail -3 &&\n\n./run x>out | grep -v ok # done\n",
      ),
    ).toEqual({
      command: "# build\nmake \\\n  all &&\n\n./run x>out",
      cuts: [
        [" |\n  tail -3", "tail -3"],
        [" | grep -v ok", "grep -v ok"],
      ],
    });
    // A pipeline that is all filters, or ends in no filter, is left whole.
    expect(cutsOf("bash", "grep -r x . | head -2; ls | wc -l; make | tail -1")).toEqual({
      command: "grep -r x . | head -2; ls | wc -l; make",
      cuts: [[" | tail -1", "tail -1"]],
    });
  });

  it("splits every version-1 program as version 1 did", () => {
    for (const [shell, text] of [
      ["bash", "pnpm vitest run 2>&1 | tail -30"],
      ["bash", "gh pr checks 12 | grep -E 'fail|pass' | head -5"],
      ["sh", "git log --oneline  |  egrep fix\t| fgrep -v wip"],
      ["dash", "cat notes | grep x | sort | head -3"],
      ["sh-or-zsh", "make test | tail -n 20"],
      ["bash", "pytest -q | grep -v 'passed' | tail -2"],
      [
        "bash",
        'cd packages/frontend && npx vitest run a.test.tsx 2>&1 | grep -E "×|FAIL" | head -40',
      ],
      ["bash", "sleep 5; gh pr checks 12 --watch 2>&1 | tail -4"],
      ["dash", "./prep\n./run =x 2>&1| grep '✓ ok' \n"],
      ["bash", "grep -c x notes | sort && make | tail -2"],
      ["bash", 'make 2>&1 | grep -vE "^\\s+at " | grep -v "^$"'],
    ] as const) {
      const v1 = splitDisplayFilter(shell, text, 1)!;
      const v2 = splitDisplayFilters(shell, text, 2)!;
      expect(v1, text).toBeDefined();
      expect(v2.command, text).toBe(v1.command);
      expect(v2.cuts.map((cut) => cut.filter)).toEqual([v1.filter]);
    }
  });

  it("refuses a program it cannot delimit safely", () => {
    for (const text of [
      "cat <<EOF | head\nx\nEOF",
      "cat <<-EOF | head\n\tx\n\tEOF",
      "cat <<< x | head",
      "a `b` | head",
      'a "`b`" | head',
      "a | head; echo ${PIPESTATUS[0]}",
      'a | head; echo "${pipestatus[1]}"',
      "cd x | head",
      "exit 1 | tail",
      "X=1 | head",
      "export X=1 | head",
      "$CMD x | head",
      "(cd x && make) | tail",
      "{ make; } | tail",
      "make | tail; (cd x)",
      "tail -f log | grep x",
      "tail -n 5 -F log | head -2",
      "a 'unterminated | head",
      'a "unterminated | head',
      "a $(b | head",
      "a $((1 + 2)) | head",
      "a $[ 1 | 2 ] | head",
      'a "$[1|2]" | head',
      "a $'x' | head",
      "a <(b) | head",
      "a >(b) | head",
      "a <> f | head",
      "a >| f | head",
      "a |& head",
      "a & b | head",
      "a &> f | head",
      "a ;; b | head",
      "a | | head",
      "; a | head",
      "a && ; b | head",
      "a | head &&",
      "a | head |",
      "a | head >",
      "if a; then b | head; fi",
      "for x in a; do b | head; done",
      "while a | head; do :; done",
      "! a | head",
      "[[ a ]] | head",
      "time a | head",
      "function f { a; }; a | head",
      "f() { a; }; a | head",
      "a $(case x in x) y;; esac) | head",
      "a $(b # c\n) | head",
      "a {fd}>f | head",
      "a ${x:-$y} | head",
      'a ${x:-"y"} | head',
      "a \\",
    ])
      expect(splitDisplayFilters("bash", text, 2), text).toBeUndefined();
    // Only version 2, only a POSIX shell, and only a program with a display filter.
    expect(splitDisplayFilters("bash", "make | tail -5", 1)).toBeUndefined();
    expect(splitDisplayFilters("bash", "make | tail -5", 3)).toBeUndefined();
    expect(splitDisplayFilters("zsh", "make | tail -5", 2)).toBeUndefined();
    expect(splitDisplayFilters("pwsh", "make | tail -5", 2)).toBeUndefined();
    for (const text of [
      "make",
      "ls | wc -l",
      "make | grep -c x",
      'make | grep "$X"',
      "make | tail 2>&1",
    ])
      expect(splitDisplayFilters("bash", text, 2), text).toBeUndefined();
  });

  it("never cuts inside a bound value its hole quotes", () => {
    const source = "./args hello there | grep -v zzz; ./emit | tail -n 1";
    const tokens = tokenizeProgram("shell", source);
    const recorded = splitDisplayFilters("bash", source, 2)!;
    for (const value of [
      "x | head -1",
      "y; ./emit | tail -1",
      'it\'s "q" | head',
      "$(echo x | head) `echo y` ${HOME} $?",
      "a\n./emit | head -1\n",
      "b && ./emit | grep a || true &",
      "'; ./emit | tail -n 1; '",
      '"; ./emit | tail -n 1; "',
      "<<EOF\n| head\nEOF",
    ]) {
      let rendered = source;
      for (const raw of ["there", "hello"]) {
        const token = tokens.find((entry) => entry.raw === raw)!;
        rendered =
          rendered.slice(0, token.start) +
          renderProgramTokenValue(token, value) +
          rendered.slice(token.end);
      }
      const split = splitDisplayFilters("bash", rendered, 2);
      expect(
        split?.cuts.map((cut) => cut.filter),
        value,
      ).toEqual(recorded.cuts.map((cut) => cut.filter));
      expect(split!.command.endsWith("; ./emit"), value).toBe(true);
    }
  });
});

const PROGRAM = "gh pr checks 12 | tail -5";

/** A recorded OMP bash step running `source`, whose program argument is its projected template. */
const step = (
  extra: Record<string, unknown> = {},
  source = PROGRAM,
  holes: unknown[] = [],
  templateSource = source,
) => ({
  id: "checks",
  callId: "call-1",
  callable: {
    runtime: "resin-process",
    name: "bash",
    program: { kind: "shell", source, argument: "command" },
  },
  arguments: [
    {
      name: "command",
      source: {
        kind: "template",
        template: {
          type: "program",
          language: "shell",
          source: { type: "literal", value: templateSource },
          sourceReference: "private:checks",
          protectedTokens: [],
          holes,
        },
      },
    },
  ],
  dependsOn: [],
  failurePolicy: { onError: "abort", policy: "default" },
  observed: { outcome: "succeeded" },
  displayFilter: { version: 1 },
  ...extra,
});
const plan = (steps: unknown[]) => ({
  schemaVersion: RECORDED_WORKFLOW_SCHEMA_VERSION,
  workflowId: "wf",
  inputs: [{ name: "n", type: "string", required: true }],
  steps,
  privateReferences: ["private:checks"],
});
/** A hole binding input `n` at the token whose text is `raw`. */
const holeAt = (source: string, raw: string) => {
  const token = tokenizeProgram("shell", source).findIndex((entry) => entry.raw === raw);
  expect(token).toBeGreaterThanOrEqual(0);
  return [{ token, binding: { type: "input", name: "n" } }];
};

describe("displayFilter steps", () => {
  it("accepts a recorded POSIX shell step ending in a display filter, with a hole in its command", () => {
    expect(validateRecordedWorkflow(plan([step()])).errors).toEqual([]);
    expect(
      validateRecordedWorkflow(plan([step({}, PROGRAM, holeAt(PROGRAM, "12"))])).errors,
    ).toEqual([]);
    expect(
      validateRecordedWorkflow(
        plan([
          step({
            callable: {
              runtime: "resin-process",
              name: "bash",
              program: { kind: "shell", source: PROGRAM, argument: "command", dialect: "dash" },
            },
          }),
        ]),
      ).errors,
    ).toEqual([]);
  });

  it("refuses a malformed or unsupported displayFilter", () => {
    for (const displayFilter of [
      { version: 3 },
      { version: 0 },
      { version: "1" },
      { version: 1, extra: true },
      { version: 1.5 },
      [],
      null,
      true,
    ])
      expect(validateRecordedWorkflow(plan([step({ displayFilter })])).valid).toBe(false);
  });

  it("refuses a program without a display filter, a non-POSIX shell, a derivation, or no program", () => {
    expect(validateRecordedWorkflow(plan([step({}, "ls | wc -l")])).valid).toBe(false);
    expect(validateRecordedWorkflow(plan([step({}, "gh pr checks 12")])).valid).toBe(false);
    expect(
      validateRecordedWorkflow(
        plan([
          step({
            callable: {
              runtime: "resin-process",
              name: "bash",
              program: { kind: "shell", source: PROGRAM, argument: "command", dialect: "pwsh" },
            },
          }),
        ]),
      ).valid,
    ).toBe(false);
    expect(
      validateRecordedWorkflow(
        plan([step({ callable: { runtime: "resin-tool-protocol", name: "checks" } })]),
      ).valid,
    ).toBe(false);
    expect(validateRecordedWorkflow(plan([step({ origin: "derivation" })])).valid).toBe(false);
  });

  it("refuses a template whose text is not the recorded program", () => {
    const other = "gh pr checks 13 | tail -5";
    expect(validateRecordedWorkflow(plan([step({}, PROGRAM, [], other)])).valid).toBe(false);
  });

  it("refuses a hole inside the dropped filter", () => {
    expect(
      validateRecordedWorkflow(plan([step({}, PROGRAM, holeAt(PROGRAM, "-5"))])).errors,
    ).toContain("step checks binds a value inside the display filter it drops");
  });

  it("accepts version 2, refusing a hole inside any of its cuts", () => {
    const source =
      "gh pr checks 12 2>&1 | grep -E 'fail|pass' ; gh pr view 12 >/dev/null && gh pr diff 12 | tail -1";
    const version2 = (holes: unknown[]) =>
      validateRecordedWorkflow(plan([step({ displayFilter: { version: 2 } }, source, holes)]));
    expect(version2([]).errors).toEqual([]);
    const at = (raw: string, last = false) => {
      const tokens = tokenizeProgram("shell", source);
      const token = last
        ? tokens.findLastIndex((entry) => entry.raw === raw)
        : tokens.findIndex((entry) => entry.raw === raw);
      expect(token).toBeGreaterThanOrEqual(0);
      return [{ token, binding: { type: "input", name: "n" } }];
    };
    expect(version2(at("12")).errors).toEqual([]);
    expect(version2(at("12", true)).errors).toEqual([]);
    expect(version2(at("'fail|pass'")).errors).toContain(
      "step checks binds a value inside the display filter it drops",
    );
    expect(version2(at("-1")).errors).toContain(
      "step checks binds a value inside the display filter it drops",
    );
    // A program version 2 cannot split is refused under it.
    expect(
      validateRecordedWorkflow(plan([step({ displayFilter: { version: 2 } }, "cd x | tail -1")]))
        .valid,
    ).toBe(false);
  });

  it("lets a hole inside the filter stand when a boolean input switches the filter", () => {
    const toggle = { name: "filter_output", type: "boolean", default: false };
    const switched = (steps: unknown[], inputs: unknown[] = [toggle]) =>
      validateRecordedWorkflow({ ...plan(steps), inputs: [...plan([]).inputs, ...inputs] });
    const switchedStep = (extra: Record<string, unknown> = {}, holes = holeAt(PROGRAM, "-5")) =>
      step({ displayFilter: { version: 1, input: "filter_output" }, ...extra }, PROGRAM, holes);
    expect(switched([switchedStep()]).errors).toEqual([]);
    // The input must exist, be a boolean defaulting to false, and switch only this filter.
    expect(switched([switchedStep()], []).valid).toBe(false);
    expect(switched([switchedStep()], [{ ...toggle, default: true }]).valid).toBe(false);
    expect(switched([switchedStep()], [{ ...toggle, type: "string", default: "" }]).valid).toBe(
      false,
    );
    expect(switched([switchedStep(), switchedStep({ id: "again", callId: "call-2" })]).valid).toBe(
      false,
    );
    const readsSwitch = [{ token: 0, binding: { type: "input", name: "filter_output" } }];
    expect(switched([switchedStep({}, readsSwitch)]).valid).toBe(false);
    expect(switched([switchedStep({ optional: { input: "filter_output" } })]).valid).toBe(false);
    expect(switched([step({ displayFilter: { version: 1, input: "" } })]).valid).toBe(false);
  });
});
