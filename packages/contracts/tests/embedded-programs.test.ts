import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProgramSourceProjection } from "../src/program-source-projection.js";
import {
  type EmbeddedProgram,
  applyProgramTokenValues,
  bindProgramToken,
  embeddedProgramProtectedTokens,
  embeddedPrograms,
  programTokenPath,
  projectedEmbeddedTokenIsBindable,
  tokenizeProgram,
} from "../src/program-tokens.js";
import { validateWorkflowProgramProjection } from "../src/recorded-workflow.js";

const MATRIX = {
  quotedPythonHeredoc:
    "python3 - <<'PY'\nimport csv\nrows=[r for r in csv.DictReader(open('data/payments.csv')) if r['merchant']=='Belles_cookbook_store' and r['day_of_year']=='12']\nprint(len(rows))\nPY",
  unquotedPythonHeredoc: "python3 <<PY\nprint('alpha-7f3c')\nPY",
  nodeHeredoc: "node - <<JS\nconsole.log('alpha-7f3c')\nJS",
  pythonSingle: "python3 -c 'print(\"alpha-7f3c\")' out.txt",
  pythonDouble: "python -c \"print('alpha-7f3c')\" > out.txt",
  unknownInterpreter: "ruby - <<'RB'\nputs 'alpha-7f3c'\nRB",
  expandingDollar: "python3 - <<PY\nprint('$HOME')\nPY",
  missingTerminator: "python3 - <<'PY'\nprint('alpha-7f3c')\n",
  twoHeredocs:
    "python3 - <<'A'\nprint('first')\nA\nnode <<'B'\nconsole.log('second')\nB\necho done",
} as const;

/**
 * `tokenizeProgram("shell")`: raw text as it was before embedded programs existed (token indexes
 * never move), and bindability. A heredoc body and its terminator are another text, so none of
 * their words is ever bindable as a word of the command.
 */
const TOP_LEVEL: Record<keyof typeof MATRIX, Array<[string, boolean]>> = {
  quotedPythonHeredoc: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["'PY'", false],
    ["import", false],
    ["csv", false],
    ["rows=[r", false],
    ["for", false],
    ["r", false],
    ["in", false],
    ["csv.DictReader", false],
    ["(", false],
    ["open", false],
    ["(", false],
    ["'data/payments.csv'", false],
    [")", false],
    [")", false],
    ["if", false],
    ["r['merchant']=='Belles_cookbook_store'", false],
    ["and", false],
    ["r['day_of_year']=='12']", false],
    ["print", false],
    ["(", false],
    ["len", false],
    ["(", false],
    ["rows", false],
    [")", false],
    [")", false],
    ["PY", false],
  ],
  unquotedPythonHeredoc: [
    ["python3", false],
    ["<<", false],
    ["PY", false],
    ["print", false],
    ["(", false],
    ["'alpha-7f3c'", false],
    [")", false],
    ["PY", false],
  ],
  nodeHeredoc: [
    ["node", false],
    ["-", true],
    ["<<", false],
    ["JS", false],
    ["console.log", false],
    ["(", false],
    ["'alpha-7f3c'", false],
    [")", false],
    ["JS", false],
  ],
  pythonSingle: [
    ["python3", false],
    ["-c", true],
    ["'print(\"alpha-7f3c\")'", false],
    ["out.txt", true],
  ],
  pythonDouble: [
    ["python", false],
    ["-c", true],
    ["\"print('alpha-7f3c')\"", false],
    [">", false],
    ["out.txt", true],
  ],
  unknownInterpreter: [
    ["ruby", false],
    ["-", true],
    ["<<", false],
    ["'RB'", false],
    ["puts", false],
    ["'alpha-7f3c'", false],
    ["RB", false],
  ],
  expandingDollar: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["PY", false],
    ["print", false],
    ["(", false],
    ["'$HOME'", false],
    [")", false],
    ["PY", false],
  ],
  missingTerminator: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["'PY'", false],
    ["print", false],
    ["(", false],
    ["'alpha-7f3c'", false],
    [")", false],
  ],
  twoHeredocs: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["'A'", false],
    ["print", false],
    ["(", false],
    ["'first'", false],
    [")", false],
    ["A", false],
    ["node", true],
    ["<<", false],
    ["'B'", false],
    ["console.log", false],
    ["(", false],
    ["'second'", false],
    [")", false],
    ["B", false],
    ["echo", true],
    ["done", true],
  ],
};

const hasInterpreters = ["python3", "node"].every(
  (command) => spawnSync(command, ["--version"]).status === 0,
);

function only(source: string): EmbeddedProgram {
  const programs = embeddedPrograms(source);
  expect(programs).toHaveLength(1);
  return programs[0]!;
}

function tokenIndex(program: EmbeddedProgram, raw: string): number {
  const index = program.tokens.findIndex((token) => token.raw === raw);
  if (index < 0) throw new Error(`no embedded token ${raw}`);
  return index;
}

function bindEmbedded(source: string, raw: string, value: string): string {
  const program = only(source);
  return applyProgramTokenValues(
    source,
    tokenizeProgram("shell", source),
    new Map(),
    "shell",
    new Map([[program.anchor, new Map([[tokenIndex(program, raw), value]])]]),
  );
}

describe("embedded programs", () => {
  it("keeps top-level token boundaries and never binds a heredoc body word", () => {
    for (const [name, source] of Object.entries(MATRIX)) {
      expect(
        tokenizeProgram("shell", source).map((token) => [token.raw, token.bindable]),
        name,
      ).toEqual(TOP_LEVEL[name as keyof typeof MATRIX]);
    }
  });

  it("finds heredoc bodies and code strings fed to python or node, anchored at top-level tokens", () => {
    const describe = (source: string) =>
      embeddedPrograms(source).map((program) => ({
        anchor: tokenizeProgram("shell", source)[program.anchor]!.raw,
        language: program.language,
        context: program.context,
        text: source.slice(program.start, program.end),
      }));
    expect(describe(MATRIX.quotedPythonHeredoc)).toEqual([
      {
        anchor: "'PY'",
        language: "python",
        context: "literal-heredoc",
        text: MATRIX.quotedPythonHeredoc.slice("python3 - <<'PY'\n".length, -"PY".length),
      },
    ]);
    expect(describe(MATRIX.unquotedPythonHeredoc)).toEqual([
      {
        anchor: "PY",
        language: "python",
        context: "expanding-heredoc",
        text: "print('alpha-7f3c')\n",
      },
    ]);
    expect(describe(MATRIX.nodeHeredoc)).toEqual([
      {
        anchor: "JS",
        language: "javascript",
        context: "expanding-heredoc",
        text: "console.log('alpha-7f3c')\n",
      },
    ]);
    expect(describe(MATRIX.pythonSingle)).toEqual([
      {
        anchor: `'print("alpha-7f3c")'`,
        language: "python",
        context: "single-quoted",
        text: 'print("alpha-7f3c")',
      },
    ]);
    expect(describe(MATRIX.pythonDouble)).toEqual([
      {
        anchor: `"print('alpha-7f3c')"`,
        language: "python",
        context: "double-quoted",
        text: "print('alpha-7f3c')",
      },
    ]);
    expect(describe(MATRIX.twoHeredocs)).toEqual([
      { anchor: "'A'", language: "python", context: "literal-heredoc", text: "print('first')\n" },
      {
        anchor: "'B'",
        language: "javascript",
        context: "literal-heredoc",
        text: "console.log('second')\n",
      },
    ]);
    // Embedded token offsets are absolute in the shell text.
    const program = only(MATRIX.quotedPythonHeredoc);
    const merchant = program.tokens[tokenIndex(program, "'Belles_cookbook_store'")]!;
    expect(MATRIX.quotedPythonHeredoc.slice(merchant.start, merchant.end)).toBe(
      "'Belles_cookbook_store'",
    );
    expect(merchant.value).toBe("Belles_cookbook_store");
  });

  it("finds nothing it cannot delimit or read literally", () => {
    for (const source of [
      MATRIX.unknownInterpreter,
      MATRIX.expandingDollar,
      MATRIX.missingTerminator,
      "python3 -c \"print('$HOME')\"",
      "python3 script.py - <<'PY'\nprint('x')\nPY",
      "python3 -m http.server <<'PY'\nprint('x')\nPY",
      "cat <<'PY' | python3\nprint('x')\nPY",
      "python3 - <<'PY'\nprint('unterminated\nPY",
    ]) {
      expect(embeddedPrograms(source), source).toEqual([]);
    }
  });

  it("does not read commands inside a heredoc body as commands", () => {
    const source = "cat <<'EOF'\npython3 -c 'print(1)'\nEOF\npython3 -c 'print(2)'";
    expect(
      embeddedPrograms(source).map((program) => source.slice(program.start, program.end)),
    ).toEqual(["print(2)"]);
  });

  it.skipIf(!hasInterpreters)(
    "renders quotes, dollars, backslashes and newlines as data the interpreter prints back",
    () => {
      const values = [
        `it's`,
        `say "hi"`,
        "$HOME `id`",
        "back\\slash",
        "two\nPY\nlines",
        "all ' \" $ \\ `",
      ];
      for (const source of [
        `python3 -c 'print("alpha", end="")'`,
        `python3 -c "print('alpha', end='')"`,
        "python3 - <<'PY'\nprint('alpha', end='')\nPY",
        "python3 - <<PY\nprint('alpha', end='')\nPY",
        "node -e 'process.stdout.write(\"alpha\")'",
        "node - <<JS\nprocess.stdout.write('alpha')\nJS",
      ]) {
        for (const value of values) {
          const rendered = bindEmbedded(
            source,
            only(source).tokens.find((token) => token.kind === "string")!.raw,
            value,
          );
          const run = spawnSync("sh", ["-c", rendered], { encoding: "utf8" });
          expect({ source, value, stdout: run.stdout, status: run.status }).toEqual({
            source,
            value,
            stdout: value,
            status: 0,
          });
        }
      }
    },
  );

  it("refuses unknown anchors, out-of-range indexes and overlapping replacements", () => {
    const source = MATRIX.pythonSingle;
    const tokens = tokenizeProgram("shell", source);
    const program = only(source);
    const string = tokenIndex(program, '"alpha-7f3c"');
    expect(() =>
      applyProgramTokenValues(
        source,
        tokens,
        new Map(),
        "shell",
        new Map([[0, new Map([[0, "x"]])]]),
      ),
    ).toThrow();
    expect(() =>
      applyProgramTokenValues(
        source,
        tokens,
        new Map(),
        "shell",
        new Map([[program.anchor, new Map([[999, "x"]])]]),
      ),
    ).toThrow();
    // A heredoc body's top-level words overlap its embedded tokens.
    const heredoc = MATRIX.unquotedPythonHeredoc;
    const heredocTokens = tokenizeProgram("shell", heredoc);
    const body = only(heredoc);
    const topLevelString = heredocTokens.findIndex((token) => token.raw === "'alpha-7f3c'");
    heredocTokens[topLevelString]!.bindable = true;
    expect(() =>
      applyProgramTokenValues(
        heredoc,
        heredocTokens,
        new Map([[topLevelString, "y"]]),
        "shell",
        new Map([[body.anchor, new Map([[tokenIndex(body, "'alpha-7f3c'"), "x"]])]]),
      ),
    ).toThrow();
    // A top-level token after the code string binds exactly as before, alongside an embedded one.
    const outIndex = tokens.findIndex((token) => token.raw === "out.txt");
    expect(outIndex).toBe(3);
    expect(
      applyProgramTokenValues(
        source,
        tokens,
        new Map([[outIndex, "next.txt"]]),
        "shell",
        new Map([[program.anchor, new Map([[string, "beta"]])]]),
      ),
    ).toBe(`python3 -c 'print("beta")' next.txt`);
  });

  it("binds embedded holes only where the program is embedded, never on a secret", () => {
    const source = { type: "literal" as const, value: MATRIX.pythonSingle };
    const program = only(MATRIX.pythonSingle);
    const index = tokenIndex(program, '"alpha-7f3c"');
    expect(
      bindProgramToken(source, "shell", program.anchor, { type: "input", name: "text" }, index),
    ).toEqual({
      type: "program",
      language: "shell",
      source,
      holes: [{ token: program.anchor, embedded: index, binding: { type: "input", name: "text" } }],
    });
    expect(() =>
      bindProgramToken(source, "shell", 3, { type: "input", name: "text" }, 0),
    ).toThrow();
    expect(() =>
      bindProgramToken(
        { type: "literal", value: "print('a')" },
        "python",
        0,
        { type: "input", name: "t" },
        0,
      ),
    ).toThrow();

    const secret = "python3 - <<'PY'\nkey='sk-[REDACTED]'\nprint('alpha-7f3c')\nPY";
    const secretTokens = tokenizeProgram("shell", secret);
    const protectedToken = secretTokens.findIndex((token) => token.raw.startsWith("key="));
    const body = only(secret);
    const projected = {
      type: "program" as const,
      language: "shell" as const,
      source: { type: "literal" as const, value: secret },
      sourceReference: "private:program",
      protectedTokens: [protectedToken],
      holes: [],
    };
    const hole = (raw: string) => ({
      token: body.anchor,
      embedded: tokenIndex(body, raw),
      binding: { type: "input" as const, name: "t" },
    });
    // The literal beside the secret binds; the secret's own token never does.
    expect(
      bindProgramToken(
        projected,
        "shell",
        body.anchor,
        hole("'alpha-7f3c'").binding,
        hole("'alpha-7f3c'").embedded,
      ).type,
    ).toBe("program");
    expect(() =>
      bindProgramToken(
        projected,
        "shell",
        body.anchor,
        hole("'sk-[REDACTED]'").binding,
        hole("'sk-[REDACTED]'").embedded,
      ),
    ).toThrow();
    const errorsFor = (raw: string) => {
      const errors: string[] = [];
      validateWorkflowProgramProjection(
        { ...projected, holes: [hole(raw)] },
        "step1.command",
        errors,
      );
      return errors;
    };
    expect(errorsFor("'alpha-7f3c'")).toEqual([]);
    expect(errorsFor("'sk-[REDACTED]'")).toHaveLength(1);
  });

  it("reads the words after a heredoc terminator as the command's own, whatever the body holds", () => {
    // satb-audio-transcription: nested parentheses, quotes and a `<<` shift in the written body.
    const source = `cat > /tmp/decode4.py <<'PY'
ranked=sorted(inds,key=lambda i:-(y[codes[i,1]-36] if codes[i,1]>0 else 0))
r[a]=((r[c]<<r[d])|(r[c]>>(8-r[d])))&255  # don't
np.savez('/tmp/decoded4.npz',p=res)
PY
/tmp/chorale-venv/bin/python /tmp/decode4.py > /tmp/decode4.out && head -n 85 /tmp/decode4.out`;
    const tokens = tokenizeProgram("shell", source);
    const after = tokens.filter((token) => token.start > source.indexOf("\nPY\n"));
    expect(
      after.filter((token) => token.raw === "/tmp/decode4.out").map((t) => t.bindable),
    ).toEqual([true, true]);
    const body = tokens.filter(
      (token) => token.start > source.indexOf("\n") && token.end <= source.indexOf("\nPY\n") + 3,
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((token) => !token.bindable && token.value === undefined)).toBe(true);
    // An arithmetic shift is no heredoc: the words after it stay readable.
    const shift = tokenizeProgram("shell", "x=$(( 1 << 2 )); ls out.txt\nls more.txt");
    expect(shift.find((token) => token.raw === "more.txt")?.bindable).toBe(true);
    // A subshell holds ordinary commands.
    const subshell = tokenizeProgram("shell", '(cd "$tmp" && bun dist/client-entry.js)');
    expect(subshell.find((token) => token.raw === "dist/client-entry.js")?.bindable).toBe(true);
  });

  it("parses a script a heredoc writes as a program once a later command runs it, else keeps it data", () => {
    // satb-audio-transcription: the body of `cat > f.py` is the python a later command runs.
    const written = `cat > /tmp/decode3.py <<'PY'
import numpy as np
np.savez('/tmp/decoded3.npz',p=[1])
PY
/tmp/chorale-venv/bin/python /tmp/decode3.py`;
    const program = only(written);
    expect(program.language).toBe("python");
    expect(program.tokens[tokenIndex(program, "'/tmp/decoded3.npz'")]!.bindable).toBe(true);
    expect(bindEmbedded(written, "'/tmp/decoded3.npz'", "/tmp/other.npz")).toBe(
      written.replace("'/tmp/decoded3.npz'", "'/tmp/other.npz'"),
    );
    for (const run of [
      "python3 decode3.py",
      "timeout 60 python3 -u /tmp/decode3.py",
      "./decode3.py",
    ]) {
      expect(embeddedPrograms(written.replace(/\n[^\n]*$/, `\n${run}`)), run).toHaveLength(1);
    }
    for (const data of [
      // Nothing runs it.
      written.replace(/\n[^\n]*$/, "\ncat /tmp/decode3.py"),
      // It is compiled, not run; or run as a module; or read as a script's argument.
      written.replace(/\n[^\n]*$/, "\npython -m py_compile /tmp/decode3.py"),
      written.replace(/\n[^\n]*$/, "\npython3 other.py /tmp/decode3.py"),
      // Rewritten before it runs.
      written.replace(
        /\n[^\n]*$/,
        "\ncat > /tmp/decode3.py <<'PY'\nprint(1)\nPY\npython3 /tmp/decode3.py",
      ),
      // Appended to, not written whole.
      written.replace("cat >", "cat >>"),
      // A JSON file is data even when a command reads it.
      `cat > /tmp/cfg.json <<'EOF'\n{"a": "/tmp/x"}\nEOF\npython3 run.py /tmp/cfg.json`,
    ]) {
      expect(
        embeddedPrograms(data).filter((each) => each.start === data.indexOf("\n") + 1),
        data,
      ).toEqual([]);
    }
  });

  it.skipIf(!hasInterpreters)("runs a written script with the bound value", () => {
    const dir = mkdtempSync(join(tmpdir(), "resin-written-"));
    try {
      const script = join(dir, "s.py");
      const source = `cat > ${script} <<'PY'\nprint('alpha-7f3c')\nPY\npython3 ${script}`;
      const bound = bindEmbedded(source, "'alpha-7f3c'", "it's $HOME");
      expect(spawnSync("bash", ["-c", bound], { encoding: "utf8" }).stdout).toBe("it's $HOME\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("protects only the secret inside a script, and runs the private original around it", () => {
    // nextjs-performance: the endpoint list holds a secret; its other paths stay bindable.
    const secretValue = "/internal/7ffcc398bd861a0cQzL";
    const shape = (value: string) =>
      `node - <<'NODE'\nconst endpoints=['/dispatch/summary?site=RNO1','${value}','/shipments/dock-windows?site=RNO1'];\nconsole.log(endpoints)\nNODE`;
    const original = shape(secretValue);
    const sanitized = shape("[REDACTED_HIGH_ENTROPY_SECRET:7ffcc398bd861a0c]");
    const { protectedTokens } = analyzeProgramSourceProjection("shell", original, sanitized);
    expect(protectedTokens).toHaveLength(1);
    const program = only(sanitized);
    const path = tokenIndex(program, "'/shipments/dock-windows?site=RNO1'");
    const placeholder = tokenIndex(program, "'[REDACTED_HIGH_ENTROPY_SECRET:7ffcc398bd861a0c]'");
    const secretTokens = embeddedProgramProtectedTokens(
      program,
      sanitized,
      tokenizeProgram("shell", sanitized),
      protectedTokens,
    );
    expect([...secretTokens]).toEqual([placeholder]);
    expect(
      projectedEmbeddedTokenIsBindable(original, sanitized, protectedTokens, program.anchor, path),
    ).toBe(true);
    expect(
      projectedEmbeddedTokenIsBindable(
        original,
        sanitized,
        protectedTokens,
        program.anchor,
        placeholder,
      ),
    ).toBe(false);
    // Bound into the private original, the path changes and the secret is run as recorded.
    const originalProgram = embeddedPrograms(original).find(
      (each) => each.anchor === program.anchor,
    )!;
    const rendered = applyProgramTokenValues(
      original,
      tokenizeProgram("shell", original),
      new Map(),
      "shell",
      new Map([[originalProgram.anchor, new Map([[path, "/shipments/carriers?site=RNO2"]])]]),
    );
    expect(rendered).toBe(
      original.replace("/shipments/dock-windows?site=RNO1", "/shipments/carriers?site=RNO2"),
    );
    expect(rendered).toContain(secretValue);
    // An original whose tokens a redaction shifted never takes an embedded value.
    const shifted = original.replace(`'${secretValue}'`, "secretFrom(env)");
    expect(
      projectedEmbeddedTokenIsBindable(shifted, sanitized, protectedTokens, program.anchor, path),
    ).toBe(false);
  });

  it("reads token paths", () => {
    expect(programTokenPath(["tokens", 3])).toEqual({ token: 3 });
    expect(programTokenPath(["tokens", 3, "embedded", 7])).toEqual({ token: 3, embedded: 7 });
    expect(programTokenPath(["tokens", 3, "embedded"])).toBeUndefined();
    expect(programTokenPath(["tokens", -1])).toBeUndefined();
    expect(programTokenPath(["tokens", 3, "other", 7])).toBeUndefined();
  });
});
