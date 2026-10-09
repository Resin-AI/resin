import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSuggestCli } from "../../src/suggest/cli.js";
import { setSuggestionShownCounter } from "../../src/suggest/funnel.js";
import {
  type SuggestTool,
  resolveCommandSuggestDir,
  writeRepositoryTools,
} from "../../src/suggest/index-file.js";
import {
  MAX_PROMPT_BLOCK_CHARS,
  MAX_PROMPT_TOOLS,
  rankForPrompt,
  renderPromptBlock,
  suggestForPrompt,
} from "../../src/suggest/prompt.js";
import { setCommandSuggestionsEnabled } from "../../src/suggest/suggest.js";

const REPO_A = "a".repeat(64);
const REPO_EMPTY = "e".repeat(64);

const TOOLS: SuggestTool[] = [
  {
    name: "run_parser_tests",
    commands: ["cargo test"],
    inputs: [{ name: "filter", required: true }],
    purpose: "Run the parser crate's unit tests with a name filter.",
  },
  {
    name: "wait_for_pr_checks",
    commands: ["gh pr checks"],
    inputs: [{ name: "pr_number", required: true }],
    purpose: "Wait for a pull request's CI checks and report failures.",
  },
  {
    name: "build_plugin",
    commands: ["bundler build"],
    inputs: [],
    purpose: "Build the editor plugin into a bundle file.",
  },
  {
    name: "deploy_docs",
    commands: [],
    inputs: [{ name: "run_preview", required: false }],
    purpose: "Publish the documentation site.",
  },
];

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setSuggestionShownCounter(undefined);
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(tools: readonly SuggestTool[] = TOOLS) {
  const stateDir = tempDir("resin-prompt-state-");
  const cwd = tempDir("resin-prompt-cwd-");
  const emptyCwd = tempDir("resin-prompt-empty-");
  const dir = resolveCommandSuggestDir({ stateDir });
  writeRepositoryTools(dir, REPO_A, tools);
  writeRepositoryTools(dir, REPO_EMPTY, []);
  const resolver = (at: string) =>
    at === cwd
      ? { id: REPO_A, root: cwd }
      : at === emptyCwd
        ? { id: REPO_EMPTY, root: emptyCwd }
        : undefined;
  return {
    stateDir,
    cwd,
    emptyCwd,
    dir,
    options: { stateDir, env: {}, repositoryIdentity: resolver },
  };
}

describe("rankForPrompt", () => {
  it("puts tools whose name, commands or purpose match the prompt first", () => {
    const ranked = rankForPrompt(
      "The PR checks are failing on pull request 18, can you look?",
      TOOLS,
    );
    expect(ranked[0]?.tool.name).toBe("wait_for_pr_checks");
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(2);
    const parser = rankForPrompt("Fix the failing parser tests", TOOLS);
    expect(parser[0]?.tool.name).toBe("run_parser_tests");
    // Unrelated tools follow by name with no score.
    expect(parser.slice(1).map((entry) => entry.score)).toEqual([0, 0, 0]);
    expect(parser.slice(1).map((entry) => entry.tool.name)).toEqual([
      "build_plugin",
      "deploy_docs",
      "wait_for_pr_checks",
    ]);
  });

  it("ignores filler words", () => {
    expect(rankForPrompt("please can you run the tool", TOOLS).every((e) => e.score === 0)).toBe(
      true,
    );
  });
});

describe("renderPromptBlock", () => {
  it("lists each tool with a ready call and its purpose", () => {
    const block = renderPromptBlock(TOOLS.slice(0, 1), "claude-code", true);
    expect(block?.text).toBe(
      [
        "Resin learned tools for this repository (to run one, call mcp__resin__invoke_tool with <call>):",
        `- {"name":"run_parser_tests","parameters":{"filter":"…"}} — Run the parser crate's unit tests with a name filter.`,
      ].join("\n"),
    );
    expect(renderPromptBlock(TOOLS.slice(0, 1), "omp", true)?.text).toContain(
      "write <call> to xd://mcp__resin_invoke_tool",
    );
  });

  it("caps the block at the tool count and character limits", () => {
    const many: SuggestTool[] = Array.from({ length: 30 }, (_, index) => ({
      name: `tool_${String(index).padStart(2, "0")}`,
      commands: [],
      inputs: [{ name: "value", required: true }],
      purpose: `Purpose ${index} ${"x".repeat(150)}`,
    }));
    const block = renderPromptBlock(many, "claude-code", true);
    expect(block).toBeDefined();
    expect(block?.text.length ?? 0).toBeLessThanOrEqual(MAX_PROMPT_BLOCK_CHARS);
    expect(block?.tools.length ?? 0).toBeLessThanOrEqual(MAX_PROMPT_TOOLS);
    expect(block?.text).toMatch(/\(\+\d+ more; search_tools finds them\)$/u);
    const short = many.map((tool) => ({ ...tool, purpose: "Short." }));
    expect(renderPromptBlock(short, "omp", true)?.tools).toHaveLength(MAX_PROMPT_TOOLS);
  });
});

describe("suggestForPrompt", () => {
  it("shows the full block once per session, then only tools relevant to each prompt", () => {
    const { cwd, options } = setup();
    const first = suggestForPrompt(
      { prompt: "Fix the parser tests", cwd, harness: "omp", sessionId: "s-1" },
      options,
    );
    expect(first?.full).toBe(true);
    expect(first?.tools).toEqual([
      "run_parser_tests",
      "build_plugin",
      "deploy_docs",
      "wait_for_pr_checks",
    ]);

    const later = suggestForPrompt(
      { prompt: "Now wait for the PR checks", cwd, harness: "omp", sessionId: "s-1" },
      options,
    );
    expect(later?.full).toBe(false);
    expect(later?.tools).toEqual(["wait_for_pr_checks"]);
    expect(later?.text.startsWith("Resin learned tools that may fit this prompt")).toBe(true);

    expect(
      suggestForPrompt(
        { prompt: "Thanks, that looks good", cwd, harness: "omp", sessionId: "s-1" },
        options,
      ),
    ).toBeUndefined();

    // Another session gets its own full block.
    expect(
      suggestForPrompt(
        { prompt: "Thanks, that looks good", cwd, harness: "omp", sessionId: "s-2" },
        options,
      )?.full,
    ).toBe(true);
  });

  it("shows nothing for a repository without tools, an unknown one, or with suggestions off", () => {
    const { cwd, emptyCwd, options } = setup();
    const request = { prompt: "Run the parser tests", harness: "claude-code" as const };
    expect(suggestForPrompt({ ...request, cwd: emptyCwd }, options)).toBeUndefined();
    expect(suggestForPrompt({ ...request, cwd: tempDir("resin-prompt-x-") }, options)).toBe(
      undefined,
    );
    expect(
      suggestForPrompt({ ...request, cwd }, { ...options, env: { RESIN_COMMAND_SUGGEST: "off" } }),
    ).toBeUndefined();
    setCommandSuggestionsEnabled(false, options);
    expect(suggestForPrompt({ ...request, cwd }, options)).toBeUndefined();
  });

  it("never opens a connection and never stores the prompt", () => {
    const { cwd, stateDir, options } = setup();
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const httpRequest = vi.spyOn(http, "request");
    const httpsRequest = vi.spyOn(https, "request");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const prompt = "unique-marker-7f3a: wait for the PR checks on the release branch";
    expect(
      suggestForPrompt({ prompt, cwd, harness: "omp", sessionId: "secret-session-id" }, options),
    ).toBeDefined();
    expect(connect).not.toHaveBeenCalled();
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = fs
      .readdirSync(stateDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
      .join("\n");
    expect(stored).not.toContain("unique-marker-7f3a");
    expect(stored).not.toContain("release branch");
    expect(stored).not.toContain("secret-session-id");
  });
});

async function runCli(argv: string[], stdin: string, options: Record<string, unknown>) {
  let stdout = "";
  let stderr = "";
  const code = await runSuggestCli(argv, {
    stdin: Readable.from([stdin]),
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env: {},
    options,
  });
  return { code, stdout, stderr };
}

describe("resin suggest --prompt (hook I/O contracts)", () => {
  it("answers Claude Code's UserPromptSubmit with additionalContext only", async () => {
    const { cwd, options } = setup();
    const counted = vi.fn();
    setSuggestionShownCounter(counted);
    const payload = JSON.stringify({
      session_id: "claude-session",
      transcript_path: "/tmp/transcript.jsonl",
      cwd,
      permission_mode: "default",
      hook_event_name: "UserPromptSubmit",
      prompt: "Why is the plugin build broken?",
    });
    const result = await runCli(["--prompt", "--harness", "claude-code"], payload, options);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toMatch(
      /^Resin learned tools for this repository[^\n]*\n- \{"name":"build_plugin"/u,
    );
    expect(output).not.toHaveProperty("decision");
    expect(counted).toHaveBeenCalledWith({ harness: "claude-code", kind: "prompt" });
  });

  it("answers the OMP extension with additionalContext", async () => {
    const { cwd, options } = setup();
    const result = await runCli(
      ["--harness", "omp", "--prompt"],
      JSON.stringify({ prompt: "check the PR", cwd, sessionId: "omp-1" }),
      options,
    );
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["additionalContext"]);
  });

  it.each([
    ["another event", { hook_event_name: "PreToolUse" }],
    ["no prompt", { prompt: undefined }],
    ["a relative cwd", { cwd: "relative" }],
  ])("prints nothing for %s", async (_label, overrides) => {
    const { cwd, options } = setup();
    const counted = vi.fn();
    setSuggestionShownCounter(counted);
    const payload = JSON.stringify({
      session_id: "s",
      cwd,
      hook_event_name: "UserPromptSubmit",
      prompt: "build the plugin",
      ...overrides,
    });
    expect(await runCli(["--prompt", "--harness", "claude-code"], payload, options)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(counted).not.toHaveBeenCalled();
  });

  it("prints nothing for malformed input", async () => {
    const { options } = setup();
    expect(await runCli(["--prompt", "--harness", "omp"], "{", options)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });
});
