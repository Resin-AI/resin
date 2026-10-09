import { describe, expect, it } from "vitest";
import type { SuggestTool } from "../../src/suggest/index-file.js";
import type { SuggestStep } from "../../src/suggest/index-file.js";
import { isDistinctivePhrase, isLoopOrBackground, matchCommand } from "../../src/suggest/match.js";
import { renderSuggestion } from "../../src/suggest/render.js";

function tool(
  name: string,
  commands: string[],
  inputs: string[] = [],
  steps?: SuggestStep[],
): SuggestTool {
  return {
    name,
    commands,
    inputs: inputs.map((input) => ({ name: input, required: false })),
    ...(steps === undefined ? {} : { steps }),
  };
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
    ["python3 scripts/manifest.py --out build", "build_manifest"],
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
    // A tool that would also run expensive steps the command did not ask for.
    "stylua src",
    "npx tsc --noEmit",
    // A command no tool runs.
    "cargo test",
    "",
    "   ",
  ])("suggests nothing for %j", (command) => {
    expect(matchCommand(command, TOOLS)).toBeUndefined();
  });

  it("names the cheap lookups the matched tool also runs", () => {
    const watch = tool("watch_pr", ["gh pr checks", "gh run view"]);
    const match = matchCommand("gh pr checks 7 --watch", [watch]);
    expect(match?.covered).toEqual(["gh pr checks"]);
    expect(match?.alsoRuns).toEqual(["gh run view"]);
    expect(match?.skip).toEqual([]);
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

describe("matchCommand: close fits only", () => {
  // A lint + coverage + test bundle for a test runner `lest`.
  const LINT_COVERAGE_TEST = tool(
    "check_everything",
    ["eslint", "c8", "lest"],
    [],
    [{ commands: ["eslint"] }, { commands: ["c8"] }, { commands: ["lest"] }],
  );
  // cargo test, clippy, a cross-target check and fmt, as four steps.
  const rustBundle = (optional: boolean): SuggestTool =>
    tool(
      "run_rust_quality_checks",
      ["cargo test", "cargo clippy", "cargo check", "cargo fmt"],
      ["run_clippy", "run_windows_check", "run_fmt"],
      [
        { commands: ["cargo test"] },
        { commands: ["cargo clippy"], ...(optional ? { optional: "run_clippy" } : {}) },
        {
          commands: ["cargo check"],
          ...(optional ? { optional: "run_windows_check" } : {}),
        },
        { commands: ["cargo fmt"], ...(optional ? { optional: "run_fmt" } : {}), writes: true },
      ],
    );

  it("never offers a lint + coverage + test bundle for one filtered test run", () => {
    expect(
      matchCommand("lest spec/parser_spec.lua | tail -20", [LINT_COVERAGE_TEST]),
    ).toBeUndefined();
    expect(matchCommand("lest spec | tail", [LINT_COVERAGE_TEST])).toBeUndefined();
  });

  it("never offers a bundle with a required cross-target check for `cargo test --lib x`", () => {
    expect(matchCommand("cargo test --lib parser", [rustBundle(false)])).toBeUndefined();
  });

  it("offers the bundle when its extra steps are optional, turning them off in the call", () => {
    const match = matchCommand("cargo test --lib parser", [rustBundle(true)]);
    expect(match?.tool.name).toBe("run_rust_quality_checks");
    expect(match?.skip).toEqual(["run_clippy", "run_windows_check", "run_fmt"]);
    expect(match === undefined ? "" : renderSuggestion(match, "omp")).toBe(
      'Resin, next time: learned tool run_rust_quality_checks runs `cargo test`; write {"name":"run_rust_quality_checks","parameters":{"run_clippy":false,"run_windows_check":false,"run_fmt":false}} to xd://mcp__resin_invoke_tool.',
    );
  });

  it("offers a PR-checks watcher for `gh pr checks N --watch`", () => {
    const watcher = tool(
      "wait_for_pr_checks",
      ["gh pr checks"],
      ["pr_number"],
      [{ commands: ["gh pr checks"] }],
    );
    expect(matchCommand("gh pr checks 18 --watch", [watcher])?.tool.name).toBe(
      "wait_for_pr_checks",
    );
  });

  it("never matches a word inside a jq filter or a path", () => {
    const widget = tool(
      "build_widget_plugin",
      ["python3 scripts/build_widget.py", "bundler build"],
      [],
      [{ commands: ["python3 scripts/build_widget.py"] }, { commands: ["bundler build"] }],
    );
    for (const command of [
      `jq '.plugins[] | select(.name == "widget")' reports/widget.json`,
      "jq -r .widget.size out/widget/report.json | head",
      "cat build/widget.bin | wc -c",
    ]) {
      expect(matchCommand(command, [widget])).toBeUndefined();
    }
  });

  it.each([
    "for i in $(seq 1 20); do cargo test --lib parser || break; done",
    "for i in `seq 5`; do npx vitest run a.test.ts; done",
    "while true; do gh pr checks 18; sleep 30; done",
    "until npx vitest run; do :; done",
    "npx vitest run a.test.ts & npx vitest run b.test.ts & wait",
    "seq 1 10 | xargs -I{} npx vitest run",
  ])("never matches a loop, stress test or background job: %j", (command) => {
    expect(isLoopOrBackground(command)).toBe(true);
    expect(matchCommand(command, [...TOOLS, rustBundle(true)])).toBeUndefined();
  });

  it.each([
    "npx vitest run 2>&1 | tail -40",
    "npx vitest run &> out.log",
    "cargo test && cargo clippy",
    `git commit -m "for while & until"`,
  ])("does not mistake redirections, && or quoted words for loops: %j", (command) => {
    expect(isLoopOrBackground(command)).toBe(false);
  });

  it("rejects a tool whose other required step writes files or runs a non-lookup", () => {
    const withEdit = tool(
      "test_and_patch",
      ["vitest"],
      [],
      [{ commands: ["vitest"] }, { commands: [], writes: true }],
    );
    const withLookup = tool(
      "test_and_status",
      ["vitest", "git status"],
      [],
      [{ commands: [] }, { commands: ["vitest"] }, { commands: ["git status"] }],
    );
    expect(matchCommand("npx vitest run", [withEdit])).toBeUndefined();
    expect(matchCommand("npx vitest run", [withLookup])?.alsoRuns).toEqual(["git status"]);
  });

  it("prefers the tool with fewer skipped steps", () => {
    const plain = tool("z_plain", ["cargo test"], [], [{ commands: ["cargo test"] }]);
    expect(matchCommand("cargo test", [rustBundle(true), plain])?.tool.name).toBe("z_plain");
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
