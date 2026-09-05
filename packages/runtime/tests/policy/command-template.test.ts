import { describe, expect, it } from "vitest";
import {
  PolicyCanonicalizationError,
  canonicalizeCommand,
} from "../../src/policy/canonicalizers.js";
import {
  COMMAND_PLACEHOLDER_CLASSES,
  commandProfileAuthorizes,
  commandProfileInputs,
  compileCommandProfileArg,
  isCommandPlaceholderToken,
  isTemplatedCommandProfile,
  matchCommandProfileArgs,
  tokenizeCommandProfile,
} from "../../src/policy/command-template.js";

describe("Command Template Policy", () => {
  it("defines the fixed placeholder vocabulary and classes", () => {
    expect(COMMAND_PLACEHOLDER_CLASSES).toEqual({
      $STR: "[^\\s]+",
      $NUM: "-?\\d+(\\.\\d+)?",
      $URL: "https?://[^\\s]+",
      $GLOB: "[^\\s]+",
      $PATH: "[^\\s-][^\\s]*",
      $SRC_FILE: "[^\\s-][^\\s]*",
      $TEST_FILE: "[^\\s-][^\\s]*",
      $CONFIG_FILE: "[^\\s-][^\\s]*",
      $DOC_FILE: "[^\\s-][^\\s]*",
      $BUILD_DIR: "[^\\s-][^\\s]*",
      $TMP_DIR: "[^\\s-][^\\s]*",
    });
  });

  it("identifies whole and embedded placeholder tokens", () => {
    expect(isCommandPlaceholderToken("literal")).toBe(false);
    expect(isCommandPlaceholderToken("$TEST_FILE")).toBe(true);
    expect(isCommandPlaceholderToken("--to=$NUM")).toBe(true);
    expect(isCommandPlaceholderToken("$HOME")).toBe(false);
  });

  it("tokenizes profiles on whitespace", () => {
    expect(tokenizeCommandProfile("  node\t--test   $TEST_FILE ")).toEqual([
      "node",
      "--test",
      "$TEST_FILE",
    ]);
    expect(tokenizeCommandProfile("   ")).toEqual([]);
  });

  it("detects templated command profiles", () => {
    expect(isTemplatedCommandProfile("node --test $TEST_FILE")).toBe(true);
    expect(isTemplatedCommandProfile("node migrate.js --to=$NUM")).toBe(true);
    expect(isTemplatedCommandProfile("node --test test.js")).toBe(false);
  });

  it("compiles literal, whole-token, and embedded arguments", () => {
    const literal = compileCommandProfileArg("file[1].js");
    expect(literal.test("file[1].js")).toBe(true);
    expect(literal.test("file11.js")).toBe(false);

    const number = compileCommandProfileArg("$NUM");
    expect(number.test("-12.5")).toBe(true);
    expect(number.test("abc")).toBe(false);

    const embedded = compileCommandProfileArg("--to=$NUM");
    expect(embedded.test("--to=42")).toBe(true);
    expect(embedded.test("--to=abc")).toBe(false);

    expect(compileCommandProfileArg("$URL").test("https://example.com/a?q=1")).toBe(true);
    expect(compileCommandProfileArg("$PATH").test("src/index.ts")).toBe(true);
    expect(compileCommandProfileArg("$TEST_FILE").test("-flag")).toBe(false);
  });

  it("matches profile argument vectors exactly", () => {
    expect(
      matchCommandProfileArgs(["--test", "$TEST_FILE"], ["--test", "packages/a/test.js"]),
    ).toBe(true);
    expect(matchCommandProfileArgs(["--to=$NUM"], ["--to=2.5"])).toBe(true);
    expect(matchCommandProfileArgs(["--to=$NUM"], ["--to=abc"])).toBe(false);
    expect(matchCommandProfileArgs(["$PATH"], ["-flag"])).toBe(false);
    expect(matchCommandProfileArgs(["--test", "$TEST_FILE"], ["--test"])).toBe(false);
    expect(matchCommandProfileArgs(["literal"], ["other"])).toBe(false);
  });

  it("allows spaces inside one string argument without admitting additional argv elements", () => {
    expect(
      matchCommandProfileArgs(
        ["commit", "-m", "$STR"],
        ["commit", "-m", "fix: update release notes"],
      ),
    ).toBe(true);
    expect(
      matchCommandProfileArgs(["commit", "-m", "$STR"], ["commit", "-m", "fix", "--amend"]),
    ).toBe(false);
    expect(matchCommandProfileArgs(["$STR"], [""])).toBe(false);
    expect(matchCommandProfileArgs(["$STR"], ["bad\0value"])).toBe(false);
    expect(matchCommandProfileArgs(["$STR"], ["first\nsecond"])).toBe(false);
    expect(matchCommandProfileArgs(["$STR"], ["trailing\n"])).toBe(false);
  });

  it("authorizes command profile prefixes and placeholder values", () => {
    expect(commandProfileAuthorizes("node --test", "node --test $TEST_FILE")).toBe(true);
    expect(commandProfileAuthorizes("node", "node --test $TEST_FILE")).toBe(true);
    expect(commandProfileAuthorizes("node --test $TEST_FILE", "node --test $TEST_FILE")).toBe(true);
    expect(commandProfileAuthorizes("node --test $TEST_FILE", "node --test test/a.js")).toBe(true);
    expect(commandProfileAuthorizes("node --test $TEST_FILE", "node --check $TEST_FILE")).toBe(
      false,
    );
    expect(commandProfileAuthorizes("node --test $TEST_FILE", "node --test -x")).toBe(false);
    expect(commandProfileAuthorizes("node --test $TEST_FILE", "node --test")).toBe(false);
    expect(commandProfileAuthorizes("node --to=$NUM", "node --to=$STR")).toBe(false);
    expect(commandProfileAuthorizes("python", "node script.py")).toBe(false);
  });

  it("lists placeholder inputs in argument order", () => {
    expect(commandProfileInputs("tool $SRC_FILE --to=$NUM tests.test_$STR")).toEqual([
      { placeholder: "$SRC_FILE", token: "$SRC_FILE", index: 0 },
      { placeholder: "$NUM", token: "--to=$NUM", index: 1 },
      { placeholder: "$STR", token: "tests.test_$STR", index: 2 },
    ]);
  });

  it("canonicalizes known templates while rejecting shell expansions", () => {
    expect(canonicalizeCommand("node --test $TEST_FILE")).toBe("node --test $TEST_FILE");
    expect(canonicalizeCommand("node migrate.js --to=$NUM")).toBe("node migrate.js --to=$NUM");
    for (const command of ["node $(x)", "echo `x`", "echo $HOME"]) {
      try {
        canonicalizeCommand(command);
        expect.unreachable(`Expected '${command}' to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyCanonicalizationError);
        expect(error).toMatchObject({ code: "SHELL_METACHARACTERS_DETECTED" });
      }
    }
  });
});
