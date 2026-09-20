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

  it("reads python, javascript and typescript string literals", () => {
    expect(
      tokenizeProgram("python", "name = 'alpha-7f3c'\nprint(f\"ok {name}\")# trailing").map(
        (token) => token.value,
      ),
    ).toEqual(["alpha-7f3c", "ok {name}"]);
    const script = 'const release = "alpha-7f3c"; // not this\nconst other = `alpha-7f3c`;';
    expect(tokenizeProgram("javascript", script).map((token) => token.value)).toEqual([
      "alpha-7f3c",
      "alpha-7f3c",
    ]);
  });

  it("leaves a template literal that interpolates alone: its value is code", () => {
    const tokens = tokenizeProgram("javascript", "const name = `alpha-${suffix}`;");
    expect(tokens).toEqual([]);
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
