import { describe, expect, it } from "vitest";
import type { SuggestTool } from "../../src/suggest/index-file.js";
import { isDistinctivePhrase, matchCommand } from "../../src/suggest/match.js";

function tool(name: string, commands: string[], inputs: string[] = []): SuggestTool {
  return { name, commands, inputs: inputs.map((input) => ({ name: input, required: false })) };
}

const VITEST = tool("run_vitest_tests", ["vitest"], ["test_file"]);
const PR_CHECKS = tool("wait_for_pr_checks", ["gh pr checks"], ["pr_number"]);
const LINT_LUA = tool("lint_lua", ["stylua", "selene"]);
const BUILD_SCRIPT = tool("build_manifest", ["python3 scripts/manifest.py"]);
const TYPECHECK_AND_TEST = tool("typecheck_and_test", ["tsc", "vitest"]);
const GIT_SUMMARY = tool("git_summary", ["git status", "git log"]);
const PNPM_BUILD = tool("pnpm_build", ["pnpm run"]);
const AWS_LOGS = tool("tail_errors", [
  "aws logs filter-log-events",
  "aws logs describe-log-groups",
]);
const TOOLS = [
  VITEST,
  PR_CHECKS,
  LINT_LUA,
  BUILD_SCRIPT,
  TYPECHECK_AND_TEST,
  GIT_SUMMARY,
  PNPM_BUILD,
  AWS_LOGS,
];

describe("matchCommand", () => {
  it.each([
    ["npx vitest run src/example.test.ts", "run_vitest_tests"],
    ["cd apps/example && npx vitest run src/example.test.ts 2>&1 | tail -40", "run_vitest_tests"],
    ["pnpm exec vitest run", "run_vitest_tests"],
    ["timeout 600 vitest --reporter=verbose", "run_vitest_tests"],
    ["gh pr checks 12 --watch", "wait_for_pr_checks"],
    ["stylua --check src && selene src", "lint_lua"],
    ["stylua src", "lint_lua"],
    ["python3 scripts/manifest.py --out build", "build_manifest"],
    ["npx tsc --noEmit", "typecheck_and_test"],
    ["aws logs filter-log-events --log-group-name example", "tail_errors"],
  ])("suggests a tool for %j", (command, expected) => {
    expect(matchCommand(command, TOOLS)?.tool.name).toBe(expected);
  });

  it.each([
    // Read-only lookups and plumbing.
    "git status",
    "git log --oneline -20",
    "git diff HEAD~1",
    "gh pr view 12",
    "ls -la",
    "cat package.json | grep vitest",
    "rg vitest src",
    "aws logs describe-log-groups",
    // Help and version probes.
    "vitest --help",
    "npx vitest --version",
    // Launchers whose script is unknown, and bare CLIs.
    "pnpm run build",
    "pnpm vitest",
    "git frobnicate",
    // A command the tool does not fully cover.
    "npx vitest run && npx eslint .",
    "selene src && luacheck src",
    // A command no tool runs.
    "cargo test",
    "",
    "   ",
  ])("suggests nothing for %j", (command) => {
    expect(matchCommand(command, TOOLS)).toBeUndefined();
  });

  it("names what the matched tool also runs", () => {
    const match = matchCommand("npx tsc --noEmit -p .", TOOLS);
    expect(match?.covered).toEqual(["tsc"]);
    expect(match?.alsoRuns).toEqual(["vitest"]);
  });

  it("prefers the tool closest to the command, whatever the listing order", () => {
    const forward = matchCommand("npx vitest run", [TYPECHECK_AND_TEST, VITEST]);
    const backward = matchCommand("npx vitest run", [VITEST, TYPECHECK_AND_TEST]);
    expect(forward?.tool.name).toBe("run_vitest_tests");
    expect(backward?.tool.name).toBe("run_vitest_tests");
  });

  it("breaks exact ties by name", () => {
    const a = tool("a_tests", ["vitest"]);
    const b = tool("b_tests", ["vitest"]);
    expect(matchCommand("vitest", [b, a])?.tool.name).toBe("a_tests");
  });

  it("ignores pasted scripts longer than a command", () => {
    expect(matchCommand(`vitest ${"x".repeat(5_000)}`, TOOLS)).toBeUndefined();
  });

  it("matches a here-document body as data, never as a command", () => {
    expect(matchCommand("cat <<EOF\nvitest\nEOF", TOOLS)).toBeUndefined();
  });
});

describe("isDistinctivePhrase", () => {
  it.each([
    ["vitest", true],
    ["gh pr checks", true],
    ["aws logs filter-log-events", true],
    ["git", false],
    ["gh", false],
    ["pnpm", false],
    ["pnpm run", false],
    ["git status", false],
    ["aws logs", false],
  ])("%j → %j", (phrase, expected) => {
    expect(isDistinctivePhrase(phrase)).toBe(expected);
  });
});
