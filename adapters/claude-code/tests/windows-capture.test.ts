/**
 * Native Windows capture: Claude Code keeps sessions under `%USERPROFILE%\.claude\projects` (or
 * `%CLAUDE_CONFIG_DIR%\projects`) and installs `claude.exe` / `claude.cmd`. The host is injected
 * (`platform: "win32"` plus a Windows-shaped env), so this runs on every OS; the directories
 * themselves are real temp directories.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type IntermediateSessionEvent,
  NodeConfigFsBridge,
  type RawHarnessRecord,
} from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeHarnessAdapter } from "../src/adapter.js";
import { ClaudeRecordDecoder } from "../src/decoder.js";
import { claudeCodeInstallHarness } from "../src/install.js";

const FIXTURE_PROJECT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/windows/projects/C--Users-Dev-User-source-app",
);
const SESSION_ID = "5b0c1a52-7c1e-4f0e-9d51-3f7f0c2b8a11";
const WINDOWS_ROOT = "C:\\Users\\Dev User\\source\\app";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway Windows-like user profile (with a space in its name) and the env pointing at it. */
function windowsProfile(): { profile: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-claude-win-"));
  tempDirs.push(root);
  const profile = path.join(root, "Users", "Dev User");
  fs.mkdirSync(profile, { recursive: true });
  return {
    profile,
    env: {
      // Git Bash sets HOME to a POSIX-style path Claude Code never reads on Windows.
      HOME: path.join(root, "msys-home"),
      USERPROFILE: profile,
      LOCALAPPDATA: path.join(profile, "AppData", "Local"),
      APPDATA: path.join(profile, "AppData", "Roaming"),
      Path: path.join(root, "Windows", "System32"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
    },
  };
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

function copyFixtureProject(projectsDir: string): string {
  const target = path.join(projectsDir, path.basename(FIXTURE_PROJECT));
  fs.cpSync(FIXTURE_PROJECT, target, { recursive: true });
  return target;
}

async function captureAll(
  adapter: ClaudeHarnessAdapter,
  workspaceRoot: string,
): Promise<{ transcriptPath: string; events: IntermediateSessionEvent[] }> {
  const workspace = (await adapter.listWorkspaces()).find(
    (entry) => entry.rootPath === workspaceRoot,
  );
  expect(workspace).toBeDefined();
  const sessions = await adapter.listSessions(workspace!);
  const session = sessions.find((entry) => entry.sessionId === SESSION_ID);
  expect(session).toBeDefined();
  const source = await adapter.openSessionSource(session!);
  const records: RawHarnessRecord[] = [];
  for (
    let batch = await source.readNext(100);
    batch.length > 0;
    batch = await source.readNext(100)
  ) {
    records.push(...batch);
  }
  await source.close();
  const decoder = new ClaudeRecordDecoder();
  return {
    transcriptPath: session!.transcriptPath,
    events: records.flatMap((record) => decoder.decode(record)),
  };
}

const version = async () => ({ stdout: "2.1.283 (Claude Code)\n", stderr: "" });

describe("Claude Code on native Windows", () => {
  it("captures a session from %USERPROFILE%\\.claude\\projects with a drive-letter cwd", async () => {
    const { profile, env } = windowsProfile();
    const projectDir = copyFixtureProject(path.join(profile, ".claude", "projects"));
    const adapter = new ClaudeHarnessAdapter({ env, platform: "win32", execFn: version });

    const { transcriptPath, events } = await captureAll(adapter, WINDOWS_ROOT);

    expect(transcriptPath).toBe(path.join(projectDir, `${SESSION_ID}.jsonl`));
    const calls = events.flatMap((event) =>
      event.type === "tool_call" ? [[event.toolName, event.parameters?.command]] : [],
    );
    expect(calls).toEqual([
      [
        "PowerShell",
        "Get-ChildItem -LiteralPath 'C:\\Users\\Dev User\\source\\app\\dist' | Select-Object -ExpandProperty Name",
      ],
      ["Bash", "node -p \"require('./package.json').version\""],
    ]);
    const results = events.flatMap((event) => (event.type === "tool_result" ? [event.callId] : []));
    expect(results).toHaveLength(2);
  });

  it("reads sessions from %CLAUDE_CONFIG_DIR%\\projects before the profile default", async () => {
    const { profile, env } = windowsProfile();
    const configDir = path.join(profile, "claude-work");
    copyFixtureProject(path.join(configDir, "projects"));
    const adapter = new ClaudeHarnessAdapter({
      env: { ...env, CLAUDE_CONFIG_DIR: configDir },
      platform: "win32",
      execFn: version,
    });

    const { transcriptPath } = await captureAll(adapter, WINDOWS_ROOT);
    expect(transcriptPath.startsWith(path.join(configDir, "projects"))).toBe(true);
  });

  it("binds a UNC working directory (\\\\wsl.localhost\\…) to its project", async () => {
    const { profile, env } = windowsProfile();
    const uncRoot = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app";
    const projectDir = path.join(
      profile,
      ".claude",
      "projects",
      "--wsl-localhost-Ubuntu-home-dev-app",
    );
    fs.mkdirSync(projectDir, { recursive: true });
    const record = {
      type: "user",
      isSidechain: false,
      sessionId: SESSION_ID,
      cwd: uncRoot,
      message: { role: "user", content: "hi" },
    };
    fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), `${JSON.stringify(record)}\n`);
    const adapter = new ClaudeHarnessAdapter({ env, platform: "win32", execFn: version });

    const workspaces = await adapter.listWorkspaces();
    expect(workspaces.map((workspace) => workspace.rootPath)).toContain(uncRoot);
  });

  it("finds the native installer's claude.exe and never the WindowsApps desktop alias", async () => {
    const { profile, env } = windowsProfile();
    const windowsApps = path.join(env.LOCALAPPDATA!, "Microsoft", "WindowsApps");
    touch(path.join(windowsApps, "claude.exe"));
    touch(path.join(profile, ".local", "bin", "claude.exe"));
    const probed: string[] = [];
    const installation = await new ClaudeHarnessAdapter({
      env: { ...env, Path: `${windowsApps};${env.Path}` },
      platform: "win32",
      execFn: async (file) => {
        probed.push(file);
        return await version();
      },
    }).probeInstallation();

    expect(installation).toMatchObject({
      executablePath: path.join(profile, ".local", "bin", "claude.exe"),
      version: "2.1.283",
      status: "ready",
      homePath: path.join(profile, ".claude"),
    });
    expect(probed).toEqual([path.join(profile, ".local", "bin", "claude.exe")]);
  });

  it("falls back to WinGet's link, then npm's claude.cmd (not the extensionless script)", async () => {
    const { env } = windowsProfile();
    const npmDir = path.join(env.APPDATA!, "npm");
    touch(path.join(npmDir, "claude"));
    touch(path.join(npmDir, "claude.cmd"));
    const adapter = new ClaudeHarnessAdapter({ env, platform: "win32", execFn: version });
    expect((await adapter.probeInstallation())?.executablePath).toBe(
      path.join(npmDir, "claude.cmd"),
    );

    touch(path.join(env.LOCALAPPDATA!, "Microsoft", "WinGet", "Links", "claude.exe"));
    expect((await adapter.probeInstallation())?.executablePath).toBe(
      path.join(env.LOCALAPPDATA!, "Microsoft", "WinGet", "Links", "claude.exe"),
    );
  });

  // The install definition probes the real host platform, so this one needs Windows itself.
  it.runIf(process.platform === "win32")(
    "probes through the install definition with the profile home resin init passes",
    async () => {
      const { profile, env } = windowsProfile();
      touch(path.join(profile, ".local", "bin", "claude.exe"));
      fs.mkdirSync(path.join(profile, ".claude"), { recursive: true });
      const probe = await claudeCodeInstallHarness.probeInstallation({
        targetPath: path.join(profile, ".claude.json"),
        home: profile,
        env,
        fsBridge: new NodeConfigFsBridge(),
      });
      expect(probe?.executablePath).toBe(path.join(profile, ".local", "bin", "claude.exe"));
      expect(probe?.homePath).toBe(path.join(profile, ".claude"));
    },
  );
});
