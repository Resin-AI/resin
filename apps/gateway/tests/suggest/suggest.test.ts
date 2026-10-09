import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogNoticeTool } from "../../src/router.js";
import { runSuggestCli } from "../../src/suggest/cli.js";
import { setSuggestionShownCounter } from "../../src/suggest/funnel.js";
import {
  commandSuggestIndexPath,
  parseCommandSuggestIndex,
  readRepositoryTools,
  resolveCommandSuggestDir,
  writeRepositoryTools,
} from "../../src/suggest/index-file.js";
import {
  createCommandSuggestIndexWriter,
  suggestToolsFromCatalog,
} from "../../src/suggest/index-writer.js";
import { repositoryIdentity } from "../../src/suggest/repository-identity.js";
import {
  MAX_SUGGESTIONS_PER_TOOL_PER_SESSION,
  setCommandSuggestionsEnabled,
  suggestForCommand,
} from "../../src/suggest/suggest.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const REPO_A = "a".repeat(64);
const REPO_B = "b".repeat(64);
const VITEST_TOOL = {
  name: "run_vitest_tests",
  commands: ["vitest"],
  inputs: [
    { name: "test_file", required: true },
    { name: "reporter", required: false },
  ],
};

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setSuggestionShownCounter(undefined);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A Resin state directory with REPO_A's tools indexed; `cwd` resolves to REPO_A. */
function setup() {
  const stateDir = tempDir("resin-suggest-state-");
  const cwd = tempDir("resin-suggest-cwd-");
  const dir = resolveCommandSuggestDir({ stateDir });
  writeRepositoryTools(dir, REPO_A, [VITEST_TOOL]);
  const resolver = vi.fn((at: string) => (at === cwd ? { id: REPO_A, root: cwd } : undefined));
  const env: NodeJS.ProcessEnv = {};
  return { stateDir, cwd, dir, resolver, options: { stateDir, env, repositoryIdentity: resolver } };
}

function claudePayload(command: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Run tests" },
    ...extra,
  });
}

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

describe("suggestion index", () => {
  it("replaces one repository's entry, keeps others, and skips an unchanged write", () => {
    const dir = resolveCommandSuggestDir({ stateDir: tempDir("resin-suggest-index-") });
    expect(writeRepositoryTools(dir, REPO_A, [VITEST_TOOL])).toBe(true);
    expect(writeRepositoryTools(dir, REPO_B, [])).toBe(true);
    expect(writeRepositoryTools(dir, REPO_A, [VITEST_TOOL])).toBe(false);
    expect(readRepositoryTools(dir, REPO_A)).toEqual([VITEST_TOOL]);
    expect(readRepositoryTools(dir, REPO_B)).toEqual([]);
    expect(readRepositoryTools(dir, "c".repeat(64))).toBeUndefined();
    if (process.platform !== "win32") {
      expect(fs.statSync(commandSuggestIndexPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a malformed repository id and reads a malformed file as empty", () => {
    const dir = resolveCommandSuggestDir({ stateDir: tempDir("resin-suggest-index-") });
    expect(writeRepositoryTools(dir, "not-a-repository", [VITEST_TOOL])).toBe(false);
    expect(parseCommandSuggestIndex("{not json").repositories).toEqual({});
    expect(parseCommandSuggestIndex(JSON.stringify({ version: 99, repositories: {} }))).toEqual({
      version: 1,
      repositories: {},
    });
  });

  it("resolves under RESIN_STATE_DIR, else the Resin home's state directory", () => {
    expect(resolveCommandSuggestDir({ env: { RESIN_STATE_DIR: "/srv/state" } })).toBe(
      path.resolve("/srv/state/command-suggest"),
    );
    expect(resolveCommandSuggestDir({ env: { RESIN_HOME: "/srv/resin" } })).toBe(
      path.resolve("/srv/resin/state/command-suggest"),
    );
    expect(resolveCommandSuggestDir({ env: { HOME: "/home/example" } })).toBe(
      path.resolve("/home/example/.resin/state/command-suggest"),
    );
  });
});

describe("suggestForCommand", () => {
  it("names the learned tool and how to call it in each harness", () => {
    const { cwd, options } = setup();
    const claude = suggestForCommand(
      { command: "npx vitest run src/a.test.ts", cwd, harness: "claude-code" },
      options,
    );
    expect(claude?.tool).toBe("run_vitest_tests");
    expect(claude?.line).toBe(
      'Resin, next time: learned tool run_vitest_tests runs `vitest`; call mcp__resin__invoke_tool with {"name":"run_vitest_tests","parameters":{"test_file":"…"}}.',
    );
    const omp = suggestForCommand({ command: "vitest", cwd, harness: "omp" }, options);
    expect(omp?.line).toContain(
      'write {"name":"run_vitest_tests","parameters":{"test_file":"…"}} to xd://mcp__resin_invoke_tool',
    );
    expect(claude?.line).not.toContain("\n");
  });

  it("suggests nothing in another repository, outside a repository, or for an unmatched command", () => {
    const { cwd, options } = setup();
    const elsewhere = tempDir("resin-suggest-other-");
    expect(suggestForCommand({ command: "vitest", cwd: elsewhere, harness: "omp" }, options)).toBe(
      undefined,
    );
    expect(
      suggestForCommand(
        { command: "vitest", cwd, harness: "omp" },
        { ...options, repositoryIdentity: () => ({ id: REPO_B, root: cwd }) },
      ),
    ).toBeUndefined();
    expect(suggestForCommand({ command: "git status", cwd, harness: "omp" }, options)).toBe(
      undefined,
    );
  });

  it("does not identify the repository when there is no index or suggestions are off", () => {
    const stateDir = tempDir("resin-suggest-empty-");
    const resolver = vi.fn(() => ({ id: REPO_A, root: "/" }));
    const request = { command: "vitest", cwd: "/", harness: "omp" as const };
    expect(suggestForCommand(request, { stateDir, env: {}, repositoryIdentity: resolver })).toBe(
      undefined,
    );
    expect(resolver).not.toHaveBeenCalled();

    const { cwd, options } = setup();
    setCommandSuggestionsEnabled(false, options);
    expect(suggestForCommand({ ...request, cwd }, options)).toBeUndefined();
    setCommandSuggestionsEnabled(true, options);
    expect(suggestForCommand({ ...request, cwd }, options)?.tool).toBe("run_vitest_tests");
    expect(
      suggestForCommand({ ...request, cwd }, { ...options, env: { RESIN_COMMAND_SUGGEST: "0" } }),
    ).toBeUndefined();
  });

  it("suggests one tool at most twice per session", () => {
    const { cwd, options } = setup();
    const request = { command: "vitest", cwd, harness: "omp" as const, sessionId: "s1" };
    for (let shown = 0; shown < MAX_SUGGESTIONS_PER_TOOL_PER_SESSION; shown += 1) {
      expect(suggestForCommand(request, options)?.tool).toBe("run_vitest_tests");
    }
    expect(suggestForCommand(request, options)).toBeUndefined();
    expect(suggestForCommand({ ...request, sessionId: "s2" }, options)?.tool).toBe(
      "run_vitest_tests",
    );
    const sessions = fs.readFileSync(
      path.join(options.stateDir, "command-suggest", "sessions.json"),
      "utf8",
    );
    expect(sessions).not.toContain("s1");
  });

  it("follows a leading cd into another directory", () => {
    const { cwd, options } = setup();
    const other = tempDir("resin-suggest-cd-");
    fs.mkdirSync(path.join(cwd, "packages", "app"), { recursive: true });
    const resolver = (at: string) =>
      at.startsWith(cwd)
        ? { id: REPO_A, root: cwd }
        : at === other
          ? { id: REPO_B, root: other }
          : undefined;
    const ask = (command: string, from: string) =>
      suggestForCommand(
        { command, cwd: from, harness: "omp" },
        { ...options, repositoryIdentity: resolver },
      )?.tool;
    expect(ask(`cd ${JSON.stringify(other)} && npx vitest run`, cwd)).toBeUndefined();
    expect(ask(`cd ${cwd}; npx vitest run`, other)).toBe("run_vitest_tests");
    expect(ask("cd packages/app && npx vitest run", cwd)).toBe("run_vitest_tests");
    expect(ask("cd missing-dir && npx vitest run", cwd)).toBe("run_vitest_tests");
    expect(ask("cd $HOME && npx vitest run", other)).toBeUndefined();
  });

  it("never throws, even when the resolver does", () => {
    const { cwd, options } = setup();
    expect(
      suggestForCommand(
        { command: "vitest", cwd, harness: "omp" },
        {
          ...options,
          repositoryIdentity: () => {
            throw new Error("git exploded");
          },
        },
      ),
    ).toBeUndefined();
  });

  it("records nothing about the command", () => {
    const { cwd, options, stateDir } = setup();
    suggestForCommand(
      { command: "npx vitest run secret-canary-path.test.ts", cwd, harness: "omp", sessionId: "x" },
      options,
    );
    for (const file of fs.readdirSync(path.join(stateDir, "command-suggest"))) {
      const text = fs.readFileSync(path.join(stateDir, "command-suggest", file), "utf8");
      expect(text).not.toContain("secret-canary-path");
    }
  });
});

describe("resin suggest --harness claude-code (hook I/O contract)", () => {
  it("answers a matching Bash call with PreToolUse additionalContext and no decision", async () => {
    const { cwd, options } = setup();
    const counted = vi.fn();
    setSuggestionShownCounter(counted);
    const result = await runCli(
      ["--harness", "claude-code"],
      claudePayload("npx vitest run", cwd),
      options,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toMatch(
      /^Resin, next time: learned tool run_vitest_tests runs `vitest`/,
    );
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(output.hookSpecificOutput).not.toHaveProperty("updatedInput");
    expect(counted).toHaveBeenCalledTimes(1);
    expect(counted).toHaveBeenCalledWith({ harness: "claude-code" });
  });

  it.each([
    ["another tool", claudePayloadFor({ tool_name: "Read" })],
    ["another event", claudePayloadFor({ hook_event_name: "PostToolUse" })],
    ["an unmatched command", claudePayloadFor({ tool_input: { command: "git status" } })],
    ["a relative cwd", claudePayloadFor({ cwd: "relative/dir" })],
    ["malformed JSON", "{"],
    ["an empty payload", ""],
  ])("prints nothing and exits 0 for %s", async (_label, payload) => {
    const { cwd, options } = setup();
    const counted = vi.fn();
    setSuggestionShownCounter(counted);
    const result = await runCli(
      ["--harness", "claude-code"],
      payload.replaceAll("__CWD__", cwd),
      options,
    );
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(counted).not.toHaveBeenCalled();
  });

  it("gives up silently on a payload that never ends", async () => {
    const { options } = setup();
    let stdout = "";
    const never = new Readable({ read() {} });
    vi.useFakeTimers();
    try {
      const pending = runSuggestCli(["--harness", "claude-code"], {
        stdin: never,
        stdout: { write: (text: string) => (stdout += text) },
        env: {},
        options,
        stdinTimeoutMs: 2_000,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect({ code: await pending, stdout }).toEqual({ code: 0, stdout: "" });
    } finally {
      vi.useRealTimers();
    }
    expect(never.destroyed).toBe(true);
  });

  it("answers the OMP extension's request with additionalContext", async () => {
    const { cwd, options } = setup();
    const result = await runCli(
      ["--harness", "omp"],
      JSON.stringify({ command: "vitest", cwd, sessionId: "omp-session" }),
      options,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).additionalContext).toContain("xd://mcp__resin_invoke_tool");
  });

  it("switches suggestions off and on, and rejects an unknown harness without blocking", async () => {
    const { cwd, options } = setup();
    expect((await runCli(["--disable"], "", options)).stdout).toContain("off");
    expect((await runCli(["--status"], "", options)).stdout).toContain("are off");
    expect(
      (await runCli(["--harness", "claude-code"], claudePayload("vitest", cwd), options)).stdout,
    ).toBe("");
    expect((await runCli(["--enable"], "", options)).stdout).toContain("on");
    expect(
      (await runCli(["--harness", "claude-code"], claudePayload("vitest", cwd), options)).stdout,
    ).not.toBe("");
    const unknown = await runCli(["--harness", "cursor"], "", options);
    expect(unknown.code).toBe(1);
    expect(unknown.code).not.toBe(2);
  });
});

function claudePayloadFor(overrides: Record<string, unknown>): string {
  return claudePayload("npx vitest run", "__CWD__", overrides);
}

function context(startupPath: string): WorkspaceContext {
  // SAFETY: the writer reads only the context's paths.
  return { startupPath, canonicalRoot: startupPath } as WorkspaceContext;
}

describe("index writer", () => {
  const learned = (name: string, localCommands?: string[]): CatalogNoticeTool => ({
    name,
    inputSchema: { type: "object", properties: { test_file: {} }, required: ["test_file"] },
    _meta: { "resin/learned": true },
    ...(localCommands === undefined ? {} : { localCommands }),
  });

  it("indexes learned tools by name, with or without commands", () => {
    expect(
      suggestToolsFromCatalog([
        learned("zeta", ["vitest"]),
        learned("no_program"),
        { name: "search_tools", inputSchema: { type: "object" } },
        learned("alpha", ["gh pr checks"]),
        { ...learned("costly", ["make"]), recommended: false },
      ]),
    ).toEqual([
      {
        name: "alpha",
        commands: ["gh pr checks"],
        inputs: [{ name: "test_file", required: true }],
      },
      { name: "no_program", commands: [], inputs: [{ name: "test_file", required: true }] },
      { name: "zeta", commands: ["vitest"], inputs: [{ name: "test_file", required: true }] },
    ]);
  });

  it("keeps each tool's one-line purpose and what each recorded step runs", () => {
    const [entry] = suggestToolsFromCatalog([
      {
        ...learned("run_checks", ["cargo test", "cargo clippy"]),
        listing: { purpose: "Run the crate's\n tests and lints.", signature: "{}" },
        localSteps: [
          { commands: ["cargo test"] },
          { commands: ["cargo clippy"], optional: "run_clippy" },
          { commands: [], writes: true },
        ],
      },
    ]);
    expect(entry).toEqual({
      name: "run_checks",
      commands: ["cargo test", "cargo clippy"],
      inputs: [{ name: "test_file", required: true }],
      purpose: "Run the crate's tests and lints.",
      steps: [
        { commands: ["cargo test"] },
        { commands: ["cargo clippy"], optional: "run_clippy" },
        { commands: [], writes: true },
      ],
    });
    const dir = resolveCommandSuggestDir({ stateDir: tempDir("resin-suggest-steps-") });
    writeRepositoryTools(dir, REPO_A, entry === undefined ? [] : [entry]);
    expect(readRepositoryTools(dir, REPO_A)).toEqual([entry]);
  });

  it("writes each repository's listing under its identity, and nothing outside a repository", () => {
    const dir = resolveCommandSuggestDir({ stateDir: tempDir("resin-suggest-writer-") });
    const write = createCommandSuggestIndexWriter({
      dir,
      repositoryIdentity: (at) => (at === "/repo" ? { id: REPO_A, root: "/repo" } : undefined),
    });
    write(context("/repo"), [learned("run_vitest_tests", ["vitest"])]);
    write(context("/elsewhere"), [learned("other", ["make"])]);
    expect(readRepositoryTools(dir, REPO_A)?.map((tool) => tool.name)).toEqual([
      "run_vitest_tests",
    ]);
    write(context("/repo"), []);
    expect(readRepositoryTools(dir, REPO_A)).toEqual([]);
  });

  it("reports a failed write instead of throwing", () => {
    const blocker = path.join(tempDir("resin-suggest-blocked-"), "file");
    fs.writeFileSync(blocker, "");
    const onError = vi.fn();
    const write = createCommandSuggestIndexWriter({
      dir: path.join(blocker, "command-suggest"),
      repositoryIdentity: () => ({ id: REPO_A, root: "/" }),
      onError,
    });
    expect(() => write(context("/"), [learned("t", ["vitest"])])).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("repositoryIdentity", () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Example",
        GIT_AUTHOR_EMAIL: "example@example.com",
        GIT_COMMITTER_NAME: "Example",
        GIT_COMMITTER_EMAIL: "example@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  }

  it("is the same for a clone and a worktree of one repository and differs across repositories", () => {
    const base = tempDir("resin-suggest-git-");
    const repo = path.join(base, "repo");
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "root");
    const clone = path.join(base, "clone");
    git(base, "clone", "-q", repo, clone);
    git(repo, "worktree", "add", "-q", path.join(base, "worktree"));
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    git(other, "init", "-q");
    git(other, "commit", "-q", "--allow-empty", "-m", "another root");

    const identity = repositoryIdentity(path.join(repo, "sub"));
    expect(identity?.id).toMatch(/^[0-9a-f]{64}$/u);
    expect(identity?.root).toBe(fs.realpathSync.native(repo));
    expect(repositoryIdentity(clone)?.id).toBe(identity?.id);
    expect(repositoryIdentity(path.join(base, "worktree"))?.id).toBe(identity?.id);
    expect(repositoryIdentity(other)?.id).not.toBe(identity?.id);
    expect(repositoryIdentity(tempDir("resin-suggest-nogit-"))).toBeUndefined();
  });
});
