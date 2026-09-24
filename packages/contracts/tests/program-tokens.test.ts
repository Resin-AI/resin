import { describe, expect, it } from "vitest";
import {
  applyProgramTokenValues,
  renderProgramTokenValue,
  tokenizeProgram,
} from "../src/program-tokens.js";

/** The recorded job: open a release, write a file naming it, count the file's lines. */
const RELEASE_PROGRAM =
  "mkdir -p release && printf '%s\\n' 'alpha-7f3c' > release/README.txt && wc -l < release/README.txt";

function tokenOf(source: string, value: string) {
  const token = tokenizeProgram("shell", source).find((entry) => entry.value === value);
  if (token === undefined) throw new Error(`no token with value ${value}`);
  return token;
}

describe("tokenizeProgram", () => {
  it("keeps a shell chain whole, and reports each word, string and operator verbatim", () => {
    const tokens = tokenizeProgram("shell", RELEASE_PROGRAM);
    expect(tokens.map((token) => token.raw)).toEqual([
      "mkdir",
      "-p",
      "release",
      "&&",
      "printf",
      "'%s\\n'",
      "'alpha-7f3c'",
      ">",
      "release/README.txt",
      "&&",
      "wc",
      "-l",
      "<",
      "release/README.txt",
    ]);
    expect(tokenOf(RELEASE_PROGRAM, "alpha-7f3c").kind).toBe("string");
    expect(tokenOf(RELEASE_PROGRAM, "release").raw).toBe("release");
    // Whitespace between tokens is not a token, so nothing can be rewritten there.
    expect(tokens.some((token) => token.raw.trim().length === 0)).toBe(false);
  });

  it("keeps a value that carries shell syntax as one token, not as operators", () => {
    const tokens = tokenizeProgram("shell", "echo 'a;b|c$(d)`e`' && echo done");
    expect(tokens.map((token) => token.raw)).toEqual([
      "echo",
      "'a;b|c$(d)`e`'",
      "&&",
      "echo",
      "done",
    ]);
    expect(tokenOf("echo 'a;b|c$(d)`e`' && echo done", "a;b|c$(d)`e`").kind).toBe("string");
  });

  it("does not treat a comment as a value, and keeps `${…}` inside its word", () => {
    const source = "printf '%s' \"${HOME}/x\" # alpha-7f3c is only a comment";
    const tokens = tokenizeProgram("shell", source);
    expect(tokens.map((token) => token.raw)).toEqual(["printf", "'%s'", '"${HOME}/x"']);
    expect(tokens.some((token) => token.value === "alpha-7f3c")).toBe(false);
  });

  it("reads redirections with a file descriptor as one operator", () => {
    const tokens = tokenizeProgram("shell", "run 2>/dev/null && run >>out.txt");
    expect(tokens.map((token) => token.raw)).toEqual([
      "run",
      "2>",
      "/dev/null",
      "&&",
      "run",
      ">>",
      "out.txt",
    ]);
  });

  it("uses parsed literal nodes for Python, JavaScript and TypeScript", () => {
    const python = tokenizeProgram(
      "python",
      "name = 'alpha-7f3c'\nprint(f\"ok {name}\")# trailing",
    );
    expect(python.filter((token) => token.kind === "string").map((token) => token.value)).toEqual([
      "alpha-7f3c",
      undefined,
    ]);
    const javascript = tokenizeProgram(
      "javascript",
      'const release = "alpha-7f3c"; // not this\nconst other = `alpha-7f3c`;',
    );
    expect(
      javascript.filter((token) => token.kind === "string").map((token) => token.value),
    ).toEqual(["alpha-7f3c", "alpha-7f3c"]);
    const typescript = tokenizeProgram("typescript", "const release: string = 'alpha-7f3c';");
    expect(typescript.find((token) => token.kind === "string")).toMatchObject({
      raw: "'alpha-7f3c'",
      value: "alpha-7f3c",
      bindable: true,
    });
  });

  it("returns interpolated templates as exact-span, unbindable literals", () => {
    const source = "const name = `alpha-${suffix}`;";
    const tokens = tokenizeProgram("javascript", source);
    const template = tokens.find((token) => token.kind === "string");
    expect(template).toMatchObject({
      raw: "`alpha-${suffix}`",
      bindable: false,
    });
    expect(template?.value).toBeUndefined();
    expect(template?.start).toBe(source.indexOf("`"));
    expect(template?.end).toBe(source.indexOf("`;") + 1);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.raw)).toContain(
      "suffix",
    );
  });

  it("preserves numeric and boolean literal types and exact signed spans", () => {
    const source = "const retries: number = -1_250; const enabled: boolean = false;";
    const tokens = tokenizeProgram("typescript", source).filter(
      (token) => token.kind === "number" || token.kind === "boolean",
    );
    expect(tokens).toMatchObject([
      { kind: "number", raw: "-1_250", value: -1250, bindable: true },
      { kind: "boolean", raw: "false", value: false, bindable: true },
    ]);
    expect(tokens[0]?.start).toBe(source.indexOf("-1_250"));
    expect(tokens[0]?.end).toBe(source.indexOf("-1_250") + "-1_250".length);

    const python = tokenizeProgram("python", "retries = -4_000\nactive = True");
    expect(
      python.filter((token) => token.kind === "number" || token.kind === "boolean"),
    ).toMatchObject([
      { kind: "number", raw: "-4_000", value: -4000, bindable: true },
      { kind: "boolean", raw: "True", value: true, bindable: true },
    ]);
  });

  it("decodes static Python string prefixes and marks non-JSON literals unbindable", () => {
    const source = [
      "raw = r'line\\n'",
      "block = '''first",
      "second'''",
      "formatted = f'{{ready}}'",
      "dynamic = f'value {name}'",
      "binary = b'bytes'",
    ].join("\n");
    const strings = tokenizeProgram("python", source).filter((token) => token.kind === "string");
    expect(strings.map((token) => token.value)).toEqual([
      "line\\n",
      "first\nsecond",
      "{ready}",
      undefined,
      undefined,
    ]);
    expect(strings.slice(0, 3).every((token) => token.bindable)).toBe(true);
    expect(strings.slice(3).every((token) => !token.bindable)).toBe(true);
    expect(strings[3]?.raw).toBe("f'value {name}'");
    expect(strings[4]?.raw).toBe("b'bytes'");
  });

  it("exposes unsupported literals and rejects malformed JavaScript or Python", () => {
    const bigint = tokenizeProgram("javascript", "const id = 99n;").find(
      (token) => token.kind === "number",
    );
    expect(bigint).toMatchObject({
      raw: "99n",
      bindable: false,
    });
    expect(bigint?.value).toBeUndefined();
    const regexp = tokenizeProgram("javascript", "const id = /a+/gi;").find(
      (token) => token.kind === "unsupported",
    );
    expect(regexp).toMatchObject({ raw: "/a+/gi", bindable: false });
    expect(regexp?.value).toBeUndefined();
    const ellipsis = tokenizeProgram("python", "value = ...").find(
      (token) => token.kind === "unsupported",
    );
    expect(ellipsis).toMatchObject({ raw: "...", bindable: false });
    expect(ellipsis?.value).toBeUndefined();
    expect(() => tokenizeProgram("javascript", "const = 1;")).toThrow(
      /cannot tokenize invalid javascript/,
    );
    expect(() => tokenizeProgram("python", "value = (")).toThrow(/cannot tokenize invalid python/);
  });

  it("marks dynamic shell expansions unbindable but permits literal single-quoted values", () => {
    const tokens = tokenizeProgram("shell", `echo "$HOME" '$HOME' $UNSET *.txt`);
    expect(tokens.find((token) => token.raw === '"$HOME"')?.bindable).toBe(false);
    expect(tokens.find((token) => token.raw === "'$HOME'")?.bindable).toBe(true);
    expect(tokens.find((token) => token.raw === "$UNSET")?.bindable).toBe(false);
    expect(tokens.find((token) => token.raw === "*.txt")?.bindable).toBe(false);
    const substitutions = tokenizeProgram("shell", "echo $(printf x) `whoami`");
    expect(substitutions.find((token) => token.raw === "printf")?.bindable).toBe(false);
    expect(substitutions.find((token) => token.raw === "x")?.bindable).toBe(false);
    expect(substitutions.find((token) => token.raw === "`whoami`")?.bindable).toBe(false);
  });
});

describe("rendering a bound value back into its token", () => {
  it("quotes like the recorded token when the token was quoted", () => {
    const token = tokenOf(RELEASE_PROGRAM, "alpha-7f3c")!;
    expect(renderProgramTokenValue(token, "beta-9a1")).toBe("'beta-9a1'");
  });

  it("quotes a value that would otherwise become syntax, and keeps it data when re-read", () => {
    const token = tokenOf(RELEASE_PROGRAM, "alpha-7f3c")!;
    const hostile = "b; rm -rf ~ && echo 'x' $(whoami) `id`";
    const rendered = renderProgramTokenValue(token, hostile);
    const rewritten = applyProgramTokenValues(RELEASE_PROGRAM, [token], new Map([[0, hostile]]));
    expect(rewritten).toContain(rendered);
    // Re-tokenizing the rewritten program finds exactly one token carrying the value: the quoting
    // was not a place where the value could split into a command.
    const values = tokenizeProgram("shell", rewritten).filter((entry) => entry.value !== undefined);
    expect(values.filter((entry) => entry.value === hostile)).toHaveLength(1);
    expect(values.some((entry) => entry.value === "rm" || entry.value === "whoami")).toBe(false);
  });

  it("renders a bare word unquoted when it is safe and quoted when it is not", () => {
    const bare = tokenOf("mkdir -p release", "release")!;
    expect(renderProgramTokenValue(bare, "release-2")).toBe("release-2");
    expect(renderProgramTokenValue(bare, "two words")).toBe("'two words'");
  });
  it("renders typed literals and strings in the recorded script language", () => {
    const javascript = "const retries = 4; const enabled = true; const label = 'old';";
    const jsTokens = tokenizeProgram("javascript", javascript);
    const jsRetries = jsTokens.findIndex((token) => token.kind === "number");
    const jsEnabled = jsTokens.findIndex((token) => token.kind === "boolean");
    const jsLabel = jsTokens.findIndex((token) => token.kind === "string");
    expect(
      applyProgramTokenValues(
        javascript,
        jsTokens,
        new Map([
          [jsRetries, 0],
          [jsEnabled, false],
          [jsLabel, "a'b"],
        ]),
        "javascript",
      ),
    ).toBe("const retries = 0; const enabled = false; const label = 'a\\'b';");

    const python = "retries = 4\nenabled = True\nlabel = 'old'";
    const pythonTokens = tokenizeProgram("python", python);
    const pythonRetries = pythonTokens.findIndex((token) => token.kind === "number");
    const pythonEnabled = pythonTokens.findIndex((token) => token.kind === "boolean");
    const pythonLabel = pythonTokens.findIndex((token) => token.kind === "string");
    expect(
      applyProgramTokenValues(
        python,
        pythonTokens,
        new Map([
          [pythonRetries, 0],
          [pythonEnabled, false],
          [pythonLabel, "a'b"],
        ]),
        "python",
      ),
    ).toBe("retries = 0\nenabled = False\nlabel = 'a\\'b'");
  });
});

describe("applyProgramTokenValues", () => {
  it("replaces only the named token, leaving every other byte as recorded", () => {
    const tokens = tokenizeProgram("shell", RELEASE_PROGRAM);
    const index = tokens.findIndex((token) => token.value === "alpha-7f3c");
    const rewritten = applyProgramTokenValues(
      RELEASE_PROGRAM,
      tokens,
      new Map([[index, "gamma-12"]]),
    );
    expect(rewritten).toBe(RELEASE_PROGRAM.replace("'alpha-7f3c'", "'gamma-12'"));
  });

  it("replaces several tokens without disturbing the spans between them", () => {
    const source = "cp 'alpha-1' 'release/alpha-1.txt'";
    const tokens = tokenizeProgram("shell", source);
    const values = new Map<number, string>([
      [1, "beta-2"],
      [2, "release/beta-2.txt"],
    ]);
    expect(applyProgramTokenValues(source, tokens, values)).toBe(
      "cp 'beta-2' 'release/beta-2.txt'",
    );
  });

  it("refuses a token position the recorded program does not have", () => {
    const tokens = tokenizeProgram("shell", RELEASE_PROGRAM);
    expect(() => applyProgramTokenValues(RELEASE_PROGRAM, tokens, new Map([[999, "x"]]))).toThrow(
      /no token 999/,
    );
  });
});
