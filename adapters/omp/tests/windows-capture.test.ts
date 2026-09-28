/**
 * Native Windows capture: OMP keeps sessions under `%USERPROFILE%\.omp\agent\sessions\<cwd slug>`
 * (or `%OMP_HOME%`), and installs `%LOCALAPPDATA%\omp\omp.exe` (install.ps1), `~\.bun\bin\omp.exe`
 * (bun) or `%APPDATA%\npm\omp.cmd` (npm). The host is injected (`platform: "win32"` plus a
 * Windows-shaped env), so this runs on every OS.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntermediateSessionEvent, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OmpHarnessAdapter } from "../src/adapter.js";
import { OmpRecordDecoder } from "../src/decoder.js";
import { findOmpExecutable, resolveOmpHome, resolveRecordedPath } from "../src/discovery.js";

const FIXTURE_AGENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/windows/agent",
);
const SESSION_ID = "01a0e200-0000-7000-8000-000000000001";
const WINDOWS_ROOT = "C:\\Users\\Dev User\\source\\app";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function windowsProfile(): { root: string; profile: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-omp-win-"));
  tempDirs.push(root);
  const profile = path.join(root, "Users", "Dev User");
  fs.mkdirSync(profile, { recursive: true });
  return {
    root,
    profile,
    env: {
      // OMP (Bun) resolves `~` to %USERPROFILE% on Windows; HOME is Git Bash's and never read.
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

describe("OMP on native Windows", () => {
  it("resolves OMP home to %USERPROFILE%\\.omp unless OMP_HOME relocates it", () => {
    const { profile, env } = windowsProfile();
    expect(resolveOmpHome({ env, platform: "win32" })).toBe(path.join(profile, ".omp"));
    const relocated = path.join(profile, "omp data");
    expect(resolveOmpHome({ env: { ...env, omp_home: relocated }, platform: "win32" })).toBe(
      relocated,
    );
  });

  it("resolves recorded Windows working directories with Windows semantics on any host", () => {
    expect(resolveRecordedPath("c:\\Users\\Dev User\\source\\app")).toBe(WINDOWS_ROOT);
    expect(resolveRecordedPath("C:/Users/Dev User/source/app")).toBe(WINDOWS_ROOT);
    expect(resolveRecordedPath("\\\\wsl.localhost\\Ubuntu\\home\\dev")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\dev",
    );
  });

  it("captures a session from %USERPROFILE%\\.omp\\agent\\sessions bound to its drive-letter cwd", async () => {
    const { profile, env } = windowsProfile();
    const sessionsDir = path.join(profile, ".omp", "agent");
    fs.cpSync(FIXTURE_AGENT, sessionsDir, { recursive: true });
    const adapter = new OmpHarnessAdapter({
      env,
      platform: "win32",
      activeOnly: false,
      cwd: profile,
    });

    const workspaces = await adapter.listWorkspaces();
    const workspace = workspaces.find((entry) => entry.rootPath === WINDOWS_ROOT);
    expect(workspace).toBeDefined();
    const sessions = await adapter.listSessions(workspace!);
    const session = sessions.find((entry) => entry.sessionId === SESSION_ID);
    expect(session?.transcriptPath).toBe(
      path.join(
        sessionsDir,
        "sessions",
        "-source-app",
        `2026-09-27T10-00-00-000Z_${SESSION_ID}.jsonl`,
      ),
    );

    const source = await adapter.openEventSource(session!);
    const records: RawHarnessRecord[] = await source.readNext(10_000);
    await source.close();
    const decoder = new OmpRecordDecoder({ deviceSurfaceServers: () => ["resin"] });
    const events = records.flatMap((record): IntermediateSessionEvent[] =>
      [decoder.decode(record) ?? []].flat(),
    );
    const calls = events.flatMap((event) =>
      event.type === "tool_call" ? [[event.toolName, event.parameters?.command]] : [],
    );
    expect(calls).toEqual([["bash", "node -p \"require('./package.json').version\""]]);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("finds omp.exe from OMP's PowerShell installer in %LOCALAPPDATA%\\omp", async () => {
    const { env } = windowsProfile();
    const installed = path.join(env.LOCALAPPDATA!, "omp", "omp.exe");
    touch(installed);
    expect(await findOmpExecutable({ env, platform: "win32" })).toBe(installed);
  });

  it("prefers PATH, and takes npm's omp.cmd over its extensionless POSIX script", async () => {
    const { profile, env } = windowsProfile();
    const npmDir = path.join(env.APPDATA!, "npm");
    touch(path.join(npmDir, "omp"));
    touch(path.join(npmDir, "omp.cmd"));
    touch(path.join(profile, ".bun", "bin", "omp.exe"));
    expect(
      await findOmpExecutable({
        env: { ...env, Path: `${npmDir};${env.Path}` },
        platform: "win32",
      }),
    ).toBe(path.join(npmDir, "omp.cmd"));
    expect(await findOmpExecutable({ env, platform: "win32" })).toBe(
      path.join(profile, ".bun", "bin", "omp.exe"),
    );
  });
});
