import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeConfigFsBridge } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OMP_COMMAND_SUGGEST_EXTENSION_MARKER,
  OMP_PROMPT_SUGGEST_MESSAGE_TYPE,
  installOmpCommandSuggest,
  ompCommandSuggestExtension,
  resolveOmpCommandSuggestExtensionPath,
  uninstallOmpCommandSuggest,
  verifyOmpCommandSuggest,
} from "../src/command-suggest.js";
import { ompInstallHarness } from "../src/install.js";

const fsBridge = new NodeConfigFsBridge();
const dirs: string[] = [];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("OMP command-suggest extension installer", () => {
  it("is registered as an OMP install extension", () => {
    expect(ompInstallHarness.installExtensions).toContain(ompCommandSuggestExtension);
  });

  it("writes the extension once, verifies it, and removes it on uninstall", async () => {
    const home = tempDir("resin-omp-suggest-");
    const env: NodeJS.ProcessEnv = {};
    const filePath = resolveOmpCommandSuggestExtensionPath(home, env);
    expect(filePath).toBe(
      path.join(home, ".omp", "agent", "extensions", "resin-command-suggest.ts"),
    );

    expect(await installOmpCommandSuggest({ home, env, fsBridge, dryRun: true })).toEqual([
      { path: filePath, action: "created" },
    ]);
    expect(fs.existsSync(filePath)).toBe(false);

    expect((await installOmpCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe("created");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content.startsWith(OMP_COMMAND_SUGGEST_EXTENSION_MARKER)).toBe(true);
    expect(content).toContain(JSON.stringify(path.join(home, ".resin", "bin", "resin")));
    expect(content).toContain('["suggest","--harness","omp"]');
    expect(content).toContain('pi.on("before_agent_start"');
    expect(await verifyOmpCommandSuggest({ home, env, fsBridge })).toBe(true);

    expect((await installOmpCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe("unchanged");
    expect(fs.readFileSync(filePath, "utf8")).toBe(content);

    // A moved Resin home rewrites the extension in place.
    const moved = { RESIN_HOME: path.join(home, "elsewhere") };
    expect(await verifyOmpCommandSuggest({ home, env: moved, fsBridge })).toBe(false);
    expect((await installOmpCommandSuggest({ home, env: moved, fsBridge }))[0]?.action).toBe(
      "updated",
    );

    expect((await uninstallOmpCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe("removed");
    expect(fs.existsSync(filePath)).toBe(false);
    expect((await uninstallOmpCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe(
      "unchanged",
    );
    // Other extensions in the directory are untouched.
    expect(fs.existsSync(path.dirname(filePath))).toBe(true);
  });

  it("never overwrites or removes a same-named file Resin did not write", async () => {
    const home = tempDir("resin-omp-suggest-");
    const env: NodeJS.ProcessEnv = {};
    const filePath = resolveOmpCommandSuggestExtensionPath(home, env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export default function () {}\n");
    await expect(installOmpCommandSuggest({ home, env, fsBridge })).rejects.toThrow(
      /not managed by Resin/,
    );
    expect((await uninstallOmpCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe(
      "unchanged",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("export default function () {}\n");
  });

  it("honours OMP_HOME", async () => {
    const home = tempDir("resin-omp-suggest-");
    const env = { OMP_HOME: path.join(home, "omp-home") };
    await installOmpCommandSuggest({ home, env, fsBridge });
    expect(
      fs.existsSync(path.join(home, "omp-home", "agent", "extensions", "resin-command-suggest.ts")),
    ).toBe(true);
  });
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

async function loadExtension(filePath: string): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  const module: { default: (pi: { on(event: string, handler: Handler): void }) => void } =
    await import(pathToFileURL(filePath).href);
  module.default({ on: (event, handler) => handlers.set(event, handler) });
  return handlers;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Example",
      GIT_AUTHOR_EMAIL: "example@example.com",
      GIT_COMMITTER_NAME: "Example",
      GIT_COMMITTER_EMAIL: "example@example.com",
    },
  });
}

describe.skipIf(process.platform === "win32")(
  "OMP extension before_agent_start (temp HOME, fake resin launcher)",
  () => {
    /** A `<resin home>/bin/resin` that records its arguments and stdin and answers `answer`. */
    function fakeResin(home: string, answer: string): { resinHome: string; log: string } {
      const resinHome = path.join(home, ".resin");
      const log = path.join(home, "calls.log");
      const reply = path.join(home, "reply.txt");
      fs.mkdirSync(path.join(resinHome, "bin"), { recursive: true });
      fs.writeFileSync(reply, `${answer}\n`);
      fs.writeFileSync(
        path.join(resinHome, "bin", "resin"),
        [
          "#!/bin/sh",
          `echo "$*" >> '${log}'`,
          `cat >> '${log}'`,
          `echo >> '${log}'`,
          `cat '${reply}'`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return { resinHome, log };
    }

    it("asks resin suggest --prompt with the prompt, cwd and session, and returns a shown message", async () => {
      const home = tempDir("resin-omp-prompt-");
      const { resinHome, log } = fakeResin(
        home,
        JSON.stringify({ additionalContext: "Resin learned tools for this repository: …" }),
      );
      const env = { RESIN_HOME: resinHome };
      await installOmpCommandSuggest({ home, env, fsBridge });
      const handlers = await loadExtension(resolveOmpCommandSuggestExtensionPath(home, env));
      const beforeAgentStart = handlers.get("before_agent_start");
      expect(beforeAgentStart).toBeDefined();
      const ctx = { cwd: home, sessionManager: { getSessionId: () => "omp-session" } };
      const result = await beforeAgentStart?.(
        { type: "before_agent_start", prompt: "build the plugin", systemPrompt: [] },
        ctx,
      );
      expect(result).toEqual({
        message: {
          customType: OMP_PROMPT_SUGGEST_MESSAGE_TYPE,
          content: "Resin learned tools for this repository: …",
          display: true,
        },
      });
      const calls = fs.readFileSync(log, "utf8");
      expect(calls).toContain("suggest --harness omp --prompt");
      expect(JSON.parse(calls.split("\n")[1] ?? "")).toEqual({
        prompt: "build the plugin",
        cwd: home,
        sessionId: "omp-session",
      });
    });

    it("returns nothing when resin prints nothing or garbage, or the event is malformed", async () => {
      const home = tempDir("resin-omp-prompt-");
      const { resinHome } = fakeResin(home, "not json");
      const env = { RESIN_HOME: resinHome };
      await installOmpCommandSuggest({ home, env, fsBridge });
      const handlers = await loadExtension(resolveOmpCommandSuggestExtensionPath(home, env));
      const beforeAgentStart = handlers.get("before_agent_start");
      expect(
        await beforeAgentStart?.({ type: "before_agent_start", prompt: "x" }, { cwd: home }),
      ).toBeUndefined();
      expect(await beforeAgentStart?.({ type: "before_agent_start" }, { cwd: home })).toBe(
        undefined,
      );
      expect(await beforeAgentStart?.(null, null)).toBeUndefined();
    });
  },
);

/** The parts of the built `@resin/gateway/suggest` this smoke test drives. */
interface BuiltSuggestModule {
  repositoryIdentity(dir: string): { id: string } | undefined;
  resolveCommandSuggestDir(options: { resinHome?: string }): string;
  writeRepositoryTools(
    dir: string,
    repositoryId: string,
    tools: ReadonlyArray<{
      name: string;
      commands: string[];
      inputs: Array<{ name: string; required: boolean }>;
    }>,
  ): boolean;
}

const builtSuggest = path.join(REPO_ROOT, "apps", "gateway", "dist", "suggest", "index.js");

describe.skipIf(process.platform === "win32" || !fs.existsSync(builtSuggest))(
  "OMP extension → resin suggest (harness smoke test, temp HOME)",
  () => {
    it("adds a one-line suggestion to a covered bash call and nothing to others", async () => {
      const home = tempDir("resin-omp-smoke-");
      const resinHome = path.join(home, ".resin");
      // `<resin home>/bin/resin` runs this checkout's CLI launcher.
      fs.mkdirSync(path.join(resinHome, "bin"), { recursive: true });
      const launcher = path.join(resinHome, "bin", "resin");
      fs.writeFileSync(
        launcher,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(REPO_ROOT, "apps", "cli", "bin", "resin.mjs"))} "$@"\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("RESIN_HOME", resinHome);
      vi.stubEnv("RESIN_STATE_DIR", "");
      vi.stubEnv("RESIN_COMMAND_SUGGEST", "");

      const repo = path.join(home, "work", "example-repo");
      fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
      git(repo, "init", "-q");
      git(repo, "commit", "-q", "--allow-empty", "-m", "root");

      // The index `resin mcp` keeps: this repository offers one learned tool running vitest.
      const suggest: BuiltSuggestModule = await import(pathToFileURL(builtSuggest).href);
      const identity = suggest.repositoryIdentity(repo);
      expect(identity).toBeDefined();
      suggest.writeRepositoryTools(
        suggest.resolveCommandSuggestDir({ resinHome }),
        identity?.id ?? "",
        [
          {
            name: "run_vitest_tests",
            commands: ["vitest"],
            inputs: [{ name: "test_file", required: true }],
          },
        ],
      );

      const env = { RESIN_HOME: resinHome };
      await installOmpCommandSuggest({ home, env, fsBridge });
      const handlers = await loadExtension(resolveOmpCommandSuggestExtensionPath(home, env));
      const toolCall = handlers.get("tool_call");
      expect(toolCall).toBeDefined();
      const ctx = { cwd: repo, sessionManager: { getSessionId: () => "smoke-session" } };

      const started = performance.now();
      const result = await toolCall?.(
        {
          type: "tool_call",
          toolCallId: "1",
          toolName: "bash",
          input: { command: "npx vitest run src/a.test.ts", cwd: "packages/app" },
        },
        ctx,
      );
      const elapsedMs = performance.now() - started;
      expect(result).toEqual({
        additionalContext:
          'Resin, next time: learned tool run_vitest_tests runs `vitest`; write {"name":"run_vitest_tests","parameters":{"test_file":"…"}} to xd://mcp__resin_invoke_tool.',
      });
      expect(elapsedMs).toBeLessThan(1_000);

      for (const event of [
        { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "git status" } },
        { type: "tool_call", toolCallId: "3", toolName: "read", input: { path: "README.md" } },
      ]) {
        expect(await toolCall?.(event, ctx)).toBeUndefined();
      }
      // At a prompt, the repository's tools are listed once per session, before the work starts.
      const beforeAgentStart = handlers.get("before_agent_start");
      const first = await beforeAgentStart?.(
        { type: "before_agent_start", prompt: "the vitest suite fails", systemPrompt: [] },
        { cwd: repo, sessionManager: { getSessionId: () => "smoke-session" } },
      );
      expect(first).toEqual({
        message: {
          customType: OMP_PROMPT_SUGGEST_MESSAGE_TYPE,
          content: expect.stringContaining(
            '- {"name":"run_vitest_tests","parameters":{"test_file":"…"}}',
          ),
          display: true,
        },
      });
      expect(
        await beforeAgentStart?.(
          { type: "before_agent_start", prompt: "thanks", systemPrompt: [] },
          { cwd: repo, sessionManager: { getSessionId: () => "smoke-session" } },
        ),
      ).toBeUndefined();
      // Outside the repository nothing is suggested.
      expect(
        await toolCall?.(
          { type: "tool_call", toolCallId: "4", toolName: "bash", input: { command: "vitest" } },
          { cwd: home },
        ),
      ).toBeUndefined();
    });

    it("lets the command run unannotated when resin is missing", async () => {
      const home = tempDir("resin-omp-smoke-");
      const env = { RESIN_HOME: path.join(home, "missing") };
      await installOmpCommandSuggest({ home, env, fsBridge });
      const handlers = await loadExtension(resolveOmpCommandSuggestExtensionPath(home, env));
      expect(
        await handlers.get("tool_call")?.(
          { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "vitest" } },
          { cwd: home },
        ),
      ).toBeUndefined();
    });
  },
);
