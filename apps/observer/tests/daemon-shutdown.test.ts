import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonShutdown } from "../src/daemon-shutdown.js";
import { DaemonLock } from "../src/lock.js";

describe("daemon shutdown", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("releases the lock before the network flush, surviving repeated stop signals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shutdown-"));
    roots.push(root);
    const lockPath = path.join(root, "daemon.lock");
    const socketPath = path.join(root, "daemon.sock");
    const pidFilePath = path.join(root, "daemon.pid");
    fs.writeFileSync(pidFilePath, String(process.pid));
    const lock = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 50 });
    expect((await lock.acquire()).status).toBe("acquired");

    // The drained daemon's error-report flush waits on the network; the update meanwhile restarts
    // the service, which signals the daemon more than once (systemd, then the service supervisor).
    let finishFlush = (): void => undefined;
    let flushing = false;
    const flush = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    const signals = new EventEmitter();
    const exit = vi.fn();
    const shutdown = createDaemonShutdown({
      logger: { info: () => undefined },
      exit,
      signals,
      resources: {
        stopSupervisor: async () => undefined,
        closeStateStore: () => undefined,
        stopIpcServer: async () => undefined,
        releaseLock: () => lock.release(),
        removePidFile: () => fs.promises.rm(pidFilePath, { force: true }),
        reportStopped: async () => {
          flushing = true;
          await flush;
        },
      },
    });

    shutdown.requestExit("IPC graceful shutdown");
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    // A second SIGTERM with no listener would take Node's default action and kill the process.
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);

    await vi.waitFor(() => expect(flushing).toBe(true));
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(pidFilePath)).toBe(false);
    // The successor acquires cleanly: no stale lock to recover or quarantine.
    const successor = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 50 });
    const acquired = await successor.acquire();
    expect(acquired.status).toBe("acquired");
    expect(acquired.quarantinedLockPath).toBeUndefined();
    await successor.release();
    expect(exit).not.toHaveBeenCalled();

    finishFlush();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("releases the remaining resources when an earlier one fails", async () => {
    const released: string[] = [];
    const exit = vi.fn();
    const shutdown = createDaemonShutdown({
      logger: { info: () => undefined },
      exit,
      signals: new EventEmitter(),
      resources: {
        stopSupervisor: async () => {
          throw new Error("supervisor stop failed");
        },
        closeStateStore: () => {
          throw new Error("close failed");
        },
        stopIpcServer: async () => {
          released.push("ipc");
        },
        releaseLock: async () => {
          released.push("lock");
        },
        removePidFile: async () => {
          released.push("pid");
        },
        reportStopped: async () => {
          released.push("report");
        },
      },
    });

    await shutdown.cleanup("SIGTERM");
    expect(released).toEqual(["ipc", "lock", "pid", "report"]);
  });
});
