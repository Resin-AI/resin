/**
 * Native Windows capture: Codex keeps rollouts under `%USERPROFILE%\.codex\sessions\YYYY\MM\DD`
 * (or `%CODEX_HOME%\sessions`) and installs `codex.exe` / npm's `codex.cmd`. The host is injected
 * (`platform: "win32"` plus a Windows-shaped env), so this runs on every OS.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntermediateSessionEvent, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHarnessAdapter } from "../src/adapter.js";
import { CodexRecordDecoder } from "../src/decoder.js";
import { findCodexExecutable, resolveCodexPaths } from "../src/discovery.js";

const FIXTURE_SESSIONS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/windows/sessions",
);
const WINDOWS_ROOT = "C:\\Users\\Dev User\\source\\app";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function windowsProfile(): { profile: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-codex-win-"));
  tempDirs.push(root);
  const profile = path.join(root, "Users", "Dev User");
  fs.mkdirSync(profile, { recursive: true });
  return {
    profile,
    env: {
      // Codex reads the profile folder on Windows (`dirs::home_dir()`), never HOME.
      HOME: path.join(root, "msys-home"),
      USERPROFILE: profile,
      APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"),
      Path: path.join(root, "Windows", "System32"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
  };
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

async function readAll(adapter: CodexHarnessAdapter, transcriptPath: string, sessionId: string) {
  const source = await adapter.openEventSource({
    sessionId,
    workspaceId: "ws",
    harnessId: "codex-cli",
    transcriptPath,
    status: "idle",
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    metadata: {},
  });
  const records: RawHarnessRecord[] = [];
  for (
    let batch = await source.readNext(100);
    batch.length > 0;
    batch = await source.readNext(100)
  ) {
    records.push(...batch);
  }
  await source.close();
  const decoder = new CodexRecordDecoder();
  return records.flatMap((record): IntermediateSessionEvent[] => decoder.decode(record));
}

describe("Codex CLI on native Windows", () => {
  it("defaults Codex home to %USERPROFILE%\\.codex, never HOME or the bare profile", async () => {
    const { profile, env } = windowsProfile();
    const paths = await resolveCodexPaths({ env, platform: "win32" });
    expect(paths.homeDir).toBe(path.join(profile, ".codex"));
    expect(paths.sessionRoot).toBe(path.join(profile, ".codex", "sessions"));
    expect(paths.configPath).toBe(path.join(profile, ".codex", "config.toml"));

    const custom = path.join(profile, "codex-home");
    expect(
      (await resolveCodexPaths({ env: { ...env, codex_home: custom }, platform: "win32" })).homeDir,
    ).toBe(custom);
  });

  it("captures rollouts from %USERPROFILE%\\.codex\\sessions as one drive-letter workspace", async () => {
    const { profile, env } = windowsProfile();
    fs.cpSync(FIXTURE_SESSIONS, path.join(profile, ".codex", "sessions"), { recursive: true });
    const adapter = new CodexHarnessAdapter({ env, platform: "win32" });

    // `c:\…` (VS Code) and `C:\…` (terminal) sessions of the same folder share one workspace.
    const workspaces = await adapter.listWorkspaces();
    expect(workspaces.map((workspace) => workspace.rootPath)).toEqual([WINDOWS_ROOT]);
    const sessions = await adapter.listSessions(workspaces[0]!);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.transcriptPath.startsWith(path.join(profile, ".codex", "sessions"))).toBe(
        true,
      );
    }

    const commands = (
      await Promise.all(
        sessions.map((session) => readAll(adapter, session.transcriptPath, session.sessionId)),
      )
    )
      .flat()
      .flatMap((event) =>
        event.type === "tool_call" && event.toolName === "shell_command"
          ? [event.parameters?.command]
          : [],
      );
    expect(commands.sort()).toEqual([
      "(Get-Content -Raw package.json | ConvertFrom-Json).version",
      "Get-ChildItem -Name dist",
    ]);
  });

  it("reads %CODEX_HOME%\\sessions when Codex home is relocated", async () => {
    const { profile, env } = windowsProfile();
    const codexHome = path.join(profile, "Codex Data");
    fs.cpSync(FIXTURE_SESSIONS, path.join(codexHome, "sessions"), { recursive: true });
    const adapter = new CodexHarnessAdapter({
      env: { ...env, CODEX_HOME: codexHome },
      platform: "win32",
    });
    const [workspace] = await adapter.listWorkspaces();
    expect(workspace?.rootPath).toBe(WINDOWS_ROOT);
    expect(await adapter.listSessions(workspace!)).toHaveLength(2);
  });

  // A Codex home shared with WSL holds rollouts whose cwd is a Linux path; on Windows they keep
  // that identity instead of being resolved onto the current drive (`C:\home\…`).
  it.runIf(process.platform === "win32")(
    "keeps a WSL-recorded POSIX cwd as its own workspace on a Windows host",
    async () => {
      const { profile, env } = windowsProfile();
      const sessionsDir = path.join(profile, ".codex", "sessions");
      fs.cpSync(FIXTURE_SESSIONS, sessionsDir, { recursive: true });
      const wslRollout = path.join(
        sessionsDir,
        "2026/09/27/rollout-2026-09-27T12-00-00-01a0e100-0000-7000-8000-000000000003.jsonl",
      );
      const header = {
        timestamp: "2026-09-27T12:00:00.100Z",
        type: "session_meta",
        payload: {
          id: "01a0e100-0000-7000-8000-000000000003",
          timestamp: "2026-09-27T12:00:00.000Z",
          cwd: "/home/dev/app",
          originator: "codex_cli_rs",
          cli_version: "0.157.1",
        },
      };
      fs.writeFileSync(wslRollout, `${JSON.stringify(header)}\n`);
      const adapter = new CodexHarnessAdapter({ env, platform: "win32" });
      const roots = (await adapter.listWorkspaces()).map((workspace) => workspace.rootPath);
      expect(roots).toEqual(expect.arrayContaining([WINDOWS_ROOT, "/home/dev/app"]));
    },
  );

  it("finds npm's codex.cmd rather than its extensionless POSIX script", async () => {
    const { env } = windowsProfile();
    const npmDir = path.join(env.APPDATA!, "npm");
    touch(path.join(npmDir, "codex"));
    touch(path.join(npmDir, "codex.cmd"));
    expect(await findCodexExecutable({ env, platform: "win32" })).toBe(
      path.join(npmDir, "codex.cmd"),
    );
  });

  it("prefers the PATH entry's codex.exe in PATHEXT order within one directory", async () => {
    const { profile, env } = windowsProfile();
    const binDir = path.join(profile, "tools bin");
    touch(path.join(binDir, "codex.cmd"));
    touch(path.join(binDir, "codex.exe"));
    touch(path.join(env.APPDATA!, "npm", "codex.cmd"));
    expect(
      await findCodexExecutable({
        env: { ...env, Path: `"${binDir}";${env.Path}` },
        platform: "win32",
      }),
    ).toBe(path.join(binDir, "codex.exe"));
  });

  it("probes a Windows install with the injected host and reports its version", async () => {
    const { profile, env } = windowsProfile();
    touch(path.join(profile, ".local", "bin", "codex.cmd"));
    const probed: string[] = [];
    const installation = await new CodexHarnessAdapter({
      env,
      platform: "win32",
      executor: async (file, args) => {
        probed.push(`${file} ${args.join(" ")}`);
        return { stdout: "codex-cli 0.157.1\r\n", stderr: "", exitCode: 0 };
      },
    }).probeInstallation();
    expect(installation).toMatchObject({
      executablePath: path.join(profile, ".local", "bin", "codex.cmd"),
      version: "0.157.1",
      homePath: path.join(profile, ".codex"),
    });
    expect(probed).toEqual([`${path.join(profile, ".local", "bin", "codex.cmd")} --version`]);
  });
});
