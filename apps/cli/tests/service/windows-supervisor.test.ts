import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServiceSupervisor } from "../../src/service/manager.js";
import { RecoveryStateTracker } from "../../src/service/recovery-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryResinHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "resin-win-supervisor-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Resolves once `fileName` appears in `directory` (event driven, no timers). */
function whenFileAppears(directory: string, fileName: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(directory, () => {
      void fs.access(path.join(directory, fileName)).then(
        () => {
          watcher.close();
          resolve();
        },
        () => undefined,
      );
    });
  });
}

// A daemon stand-in: announces readiness, then drains and exits 0 once asked.
const DAEMON_SCRIPT = `
const fs = require("node:fs");
fs.writeFileSync(process.env.TEST_READY, "ready");
const poll = setInterval(() => {
  if (fs.existsSync(process.env.TEST_DRAIN)) {
    clearInterval(poll);
    fs.writeFileSync(process.env.TEST_DRAINED, "drained");
    process.exit(0);
  }
}, 20);
`;

// A daemon stand-in that ignores shutdown requests and must be killed.
const STUBBORN_SCRIPT = `
require("node:fs").writeFileSync(process.env.TEST_READY, "ready");
setInterval(() => {}, 1000);
`;

describe("service supervisor on Windows (no POSIX signals)", () => {
  it("stops on a stop request by asking the daemon to drain instead of killing it", async () => {
    const resinHome = await temporaryResinHome();
    const signals = path.join(resinHome, "signals");
    await fs.mkdir(signals);
    const ready = whenFileAppears(signals, "ready");
    let requestStop: (() => void) | undefined;
    const requestChildShutdown = vi.fn(async () => {
      await fs.writeFile(path.join(signals, "drain"), "drain");
      return true;
    });

    const supervisor = runServiceSupervisor({
      command: process.execPath,
      args: ["-e", DAEMON_SCRIPT],
      resinHome,
      platform: "win32",
      env: {
        TEST_READY: path.join(signals, "ready"),
        TEST_DRAIN: path.join(signals, "drain"),
        TEST_DRAINED: path.join(signals, "drained"),
      },
      tracker: new RecoveryStateTracker({ resinHome }),
      stopRequestWatcher: (onRequest) => {
        requestStop = onRequest;
        return { close: () => undefined };
      },
      requestChildShutdown,
      report: () => undefined,
    });
    await ready;
    requestStop?.();
    const result = await supervisor;

    expect(result.reason).toBe("SHUTDOWN");
    expect(requestChildShutdown).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(signals, "drained"), "utf8")).toBe("drained");
  });

  it("kills a daemon that refuses to drain, and exits cleanly", async () => {
    const resinHome = await temporaryResinHome();
    const signals = path.join(resinHome, "signals");
    await fs.mkdir(signals);
    const ready = whenFileAppears(signals, "ready");
    let requestStop: (() => void) | undefined;
    const requestChildShutdown = vi.fn(async () => false);

    const supervisor = runServiceSupervisor({
      command: process.execPath,
      args: ["-e", STUBBORN_SCRIPT],
      resinHome,
      platform: "win32",
      env: { TEST_READY: path.join(signals, "ready") },
      tracker: new RecoveryStateTracker({ resinHome }),
      stopRequestWatcher: (onRequest) => {
        requestStop = onRequest;
        return { close: () => undefined };
      },
      requestChildShutdown,
      report: () => undefined,
    });
    await ready;
    requestStop?.();

    expect(await supervisor).toMatchObject({ reason: "SHUTDOWN", childExitCount: 0 });
    expect(requestChildShutdown).toHaveBeenCalledOnce();
  });
});
