import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  type EmbeddedProgram,
  applyProgramTokenValues,
  bindProgramToken,
  embeddedPrograms,
  programTokenPath,
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

/** `tokenizeProgram("shell")` as it was before embedded programs existed: raw text and bindability. */
const TOP_LEVEL_BEFORE: Record<keyof typeof MATRIX, Array<[string, boolean]>> = {
  quotedPythonHeredoc: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["'PY'", false],
    ["import", true],
    ["csv", true],
    ["rows=[r", false],
    ["for", true],
    ["r", true],
    ["in", true],
    ["csv.DictReader", true],
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
    ["print", true],
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
    ["console.log", true],
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
    ["puts", true],
    ["'alpha-7f3c'", true],
    ["RB", true],
  ],
  expandingDollar: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["PY", false],
    ["print", true],
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
    ["print", true],
    ["(", false],
    ["'alpha-7f3c'", false],
    [")", false],
  ],
  twoHeredocs: [
    ["python3", false],
    ["-", true],
    ["<<", false],
    ["'A'", false],
    ["print", true],
    ["(", false],
    ["'first'", false],
    [")", false],
    ["A", false],
    ["node", true],
    ["<<", false],
    ["'B'", false],
    ["console.log", true],
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
  it("leaves the top-level shell tokens exactly as they were", () => {
    for (const [name, source] of Object.entries(MATRIX)) {
      expect(
        tokenizeProgram("shell", source).map((token) => [token.raw, token.bindable]),
        name,
      ).toEqual(TOP_LEVEL_BEFORE[name as keyof typeof MATRIX]);
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

  it("binds embedded holes only where the program is embedded and carries no secret", () => {
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
    expect(() =>
      bindProgramToken(
        projected,
        "shell",
        body.anchor,
        { type: "input", name: "t" },
        tokenIndex(body, "'alpha-7f3c'"),
      ),
    ).toThrow();
    const errors: string[] = [];
    validateWorkflowProgramProjection(
      {
        ...projected,
        holes: [
          {
            token: body.anchor,
            embedded: tokenIndex(body, "'alpha-7f3c'"),
            binding: { type: "input", name: "t" },
          },
        ],
      },
      "step1.command",
      errors,
    );
    expect(errors).toHaveLength(1);
  });

  it("reads token paths", () => {
    expect(programTokenPath(["tokens", 3])).toEqual({ token: 3 });
    expect(programTokenPath(["tokens", 3, "embedded", 7])).toEqual({ token: 3, embedded: 7 });
    expect(programTokenPath(["tokens", 3, "embedded"])).toBeUndefined();
    expect(programTokenPath(["tokens", -1])).toBeUndefined();
    expect(programTokenPath(["tokens", 3, "other", 7])).toBeUndefined();
  });
});
