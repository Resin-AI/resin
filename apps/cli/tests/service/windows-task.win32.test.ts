/**
 * Native Windows integration test for the scheduled-task service backend.
 *
 * Registers a real per-user `\ResinTest-...` task through the backend, runs the
 * built service host and supervisor against a stand-in daemon, and checks the
 * windowless process tree, crash respawn, graceful stop, /End tree teardown and
 * removal. Runs only on win32 with the host prebuild and the CLI build present:
 *   node packages/windows-security/scripts/build-native.mjs
 *   npx tsc -p apps/cli/tsconfig.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ServiceCommandRunner,
  WindowsTaskUserServiceManager,
  defaultServiceCommandRunner,
} from "../../src/service/manager.js";
import { windowsPowerShellExecutable } from "../../src/service/windows-task.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const hostSource = path.join(
  repoRoot,
  "packages",
  "windows-security",
  "prebuilds",
  `win32-${process.arch}`,
  "resin-service-host.exe",
);
const supervisorEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const runnable =
  process.platform === "win32" && existsSync(hostSource) && existsSync(supervisorEntry);

const taskName = `\\ResinTest-ServiceIntegration-${process.pid}`;
// A distinct object, so the backend accepts commands for the temporary Resin home.
const runner: ServiceCommandRunner = {
  run: (cmd, args) => defaultServiceCommandRunner.run(cmd, args),
};

// Stand-in daemon: records its PID and a grandchild's PID, then stays alive.
const FAKE_DAEMON = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const signals = process.env.RESIN_TEST_SIGNALS;
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
fs.writeFileSync(path.join(signals, "daemon.json"), JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, started: Date.now() }));
setInterval(() => {}, 1000);
`;

interface DaemonRecord {
  pid: number;
  grandchild: number;
}

function powershellJson<T>(script: string): T {
  const stdout = execFileSync(
    windowsPowerShellExecutable(),
    ["-NoProfile", "-NonInteractive", "-Command", `${script} | ConvertTo-Json -Compress -Depth 3`],
    { encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(stdout);
}

function processTable(): Array<{ ProcessId: number; ParentProcessId: number; Name: string }> {
  return powershellJson(
    "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)",
  );
}

function descendants(rootPid: number): Array<{ ProcessId: number; Name: string; depth: number }> {
  const table = processTable();
  const found: Array<{ ProcessId: number; Name: string; depth: number }> = [];
  const visit = (pid: number, depth: number): void => {
    for (const entry of table) {
      if (entry.ParentProcessId === pid && entry.ProcessId !== pid) {
        found.push({ ProcessId: entry.ProcessId, Name: entry.Name, depth });
        visit(entry.ProcessId, depth + 1);
      }
    }
  };
  visit(rootPid, 1);
  return found;
}

function windowHandles(pids: readonly number[]): number[] {
  const rows = powershellJson<Array<{ MainWindowHandle: number }> | { MainWindowHandle: number }>(
    `@(Get-Process -Id ${pids.join(",")} | ForEach-Object { [pscustomobject]@{ MainWindowHandle = [int64]$_.MainWindowHandle } })`,
  );
  return (Array.isArray(rows) ? rows : [rows]).map((row) => row.MainWindowHandle);
}

/** Blocks (outside the JS event loop) until every PID has exited, or fails. */
function waitForExit(pids: readonly number[], seconds = 20): void {
  execFileSync(
    windowsPowerShellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; Wait-Process -Id ${pids.join(",")} -Timeout ${seconds} -ErrorAction SilentlyContinue; if (@(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue).Count -gt 0) { exit 3 }`,
    ],
    { windowsHide: true },
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves with the daemon record once it satisfies `accept` (fs events, no timers). */
function nextDaemonRecord(
  signals: string,
  accept: (record: DaemonRecord) => boolean,
): Promise<DaemonRecord> {
  const file = path.join(signals, "daemon.json");
  return new Promise((resolve) => {
    let settled = false;
    const check = (): void => {
      void fs
        .readFile(file, "utf8")
        .then((raw) => {
          const record: DaemonRecord = JSON.parse(raw);
          if (!settled && accept(record)) {
            settled = true;
            watcher.close();
            resolve(record);
          }
        })
        .catch(() => undefined);
    };
    const watcher = watch(signals, check);
    check();
  });
}

describe.runIf(runnable)("Windows scheduled task service (native integration)", () => {
  let manager: WindowsTaskUserServiceManager | undefined;
  let root = "";

  afterAll(async () => {
    try {
      execFileSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], { stdio: "ignore" });
    } catch {
      // Already removed by the test.
    }
    if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("registers, runs windowless, respawns a crashed daemon, stops, ends the tree and removes the task", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-task-it-"));
    const resinHome = path.join(root, ".resin");
    const signals = path.join(root, "signals");
    await fs.mkdir(signals, { recursive: true });
    const daemonPath = path.join(root, "fake-daemon.mjs");
    await fs.writeFile(daemonPath, FAKE_DAEMON);

    manager = new WindowsTaskUserServiceManager({
      homeDir: root,
      resinHome,
      daemonPath,
      nodePath: process.execPath,
      supervisorEntryPath: supervisorEntry,
      runner,
      env: { RESIN_TEST_SIGNALS: signals },
      windowsTask: { taskName, serviceHostSourcePath: hostSource, stopTimeoutMs: 20_000 },
    });

    // 1. Register and start without administrator rights.
    const firstDaemon = nextDaemonRecord(signals, () => true);
    const install = await manager.install();
    expect(install).toMatchObject({ success: true, enabled: true, started: true });
    const daemon = await firstDaemon;
    const status = await manager.status();
    expect(status).toMatchObject({ installed: true, active: true, state: "running" });
    const hostPid = status.pid ?? 0;
    expect(hostPid).toBeGreaterThan(0);

    // 2. The tree is host -> supervisor node -> daemon node -> grandchild, with no windows.
    const tree = descendants(hostPid);
    const treePids = tree.map((entry) => entry.ProcessId);
    expect(tree.find((entry) => entry.depth === 1)?.Name).toBe("node.exe");
    expect(treePids).toContain(daemon.pid);
    expect(treePids).toContain(daemon.grandchild);
    for (const handle of windowHandles([hostPid, daemon.pid, daemon.grandchild])) {
      expect(handle).toBe(0);
    }

    // 3. Killing the daemon makes the supervisor respawn it inside the same task.
    const respawned = nextDaemonRecord(signals, (record) => record.pid !== daemon.pid);
    process.kill(daemon.pid);
    const second = await respawned;
    expect(isAlive(second.pid)).toBe(true);
    expect((await manager.status()).pid).toBe(hostPid);

    // 4. A graceful stop ends the host cleanly and takes the whole tree with it.
    await manager.stop();
    const stopped = await manager.status();
    expect(stopped).toMatchObject({ installed: true, active: false, state: "ready" });
    waitForExit([hostPid, second.pid, second.grandchild]);

    // 5. /End on a running task kills the tree through the job object.
    const thirdRecord = nextDaemonRecord(signals, (record) => record.pid !== second.pid);
    await manager.start();
    const third = await thirdRecord;
    const runningHost = (await manager.status()).pid ?? 0;
    execFileSync("schtasks.exe", ["/End", "/TN", taskName], { stdio: "ignore" });
    waitForExit([runningHost, third.pid, third.grandchild]);
    expect(isAlive(third.grandchild)).toBe(false);

    // 6. Uninstall removes the task, its XML and the host copy.
    const uninstall = await manager.uninstall();
    expect(uninstall).toMatchObject({ success: true, disabled: true, removed: true });
    expect(await manager.status()).toMatchObject({ installed: false });
    expect(existsSync(path.join(resinHome, "services", "windows-task.xml"))).toBe(false);
    expect(existsSync(path.join(resinHome, "services", "resin-service-host.exe"))).toBe(false);
  }, 120_000);
});
