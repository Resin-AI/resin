import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../src/config.js";
import { IpcServer } from "../src/ipc/server.js";
import type { DaemonModule, ModuleContext, ModuleLifecycleState } from "../src/lifecycle.js";
import { DaemonLock } from "../src/lock.js";
import { resolvePaths } from "../src/paths.js";
import { DaemonSupervisor } from "../src/supervisor.js";

function createSlowModule(
  id: string,
  dependencies: string[] = [],
  stopDelayMs = 0,
): DaemonModule & { stopCalled: boolean; state: ModuleLifecycleState } {
  const mod = {
    id,
    name: `SlowModule ${id}`,
    dependencies,
    stopCalled: false,
    state: "uninitialized",
    getState: () => mod.state,
    start: async () => {
      mod.state = "ready";
    },
    stop: async () => {
      mod.stopCalled = true;
      if (stopDelayMs > 0) {
        await new Promise((r) => setTimeout(r, stopDelayMs));
      }
      mod.state = "stopped";
    },
  };
  return mod;
}

describe("shutdown and single-instance enforcement", () => {
  it("enforces single owner: second daemon instance fails with already_running", async () => {
    const tempDir = path.join(os.tmpdir(), `resin-single-owner-${Date.now()}`);
    const paths = resolvePaths({ home: tempDir });

    const lock1 = new DaemonLock({ lockPath: paths.lockFilePath, socketPath: paths.socketPath });
    const lock2 = new DaemonLock({ lockPath: paths.lockFilePath, socketPath: paths.socketPath });

    const res1 = await lock1.acquire();
    expect(res1.status).toBe("acquired");

    const res2 = await lock2.acquire();
    expect(res2.status).toBe("already_running");
    expect(res2.pid).toBe(process.pid);

    await lock1.release();
    expect(fs.existsSync(paths.lockFilePath)).toBe(false);

    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("shuts down gracefully in reverse dependency order within bounded deadline", async () => {
    const stopOrder: string[] = [];

    const modA = createSlowModule("A", []);
    const modB = createSlowModule("B", ["A"]);
    const modC = createSlowModule("C", ["B"]);

    const origStopA = modA.stop;
    modA.stop = async (ctx: ModuleContext) => {
      stopOrder.push("A");
      await origStopA(ctx);
    };

    const origStopB = modB.stop;
    modB.stop = async (ctx: ModuleContext) => {
      stopOrder.push("B");
      await origStopB(ctx);
    };

    const origStopC = modC.stop;
    modC.stop = async (ctx: ModuleContext) => {
      stopOrder.push("C");
      await origStopC(ctx);
    };

    const config = DaemonConfigSchema.parse({
      logLevel: "silent",
      shutdownTimeoutMs: 5000,
    });

    const supervisor = new DaemonSupervisor({
      config,
      modules: [modA, modB, modC],
    });

    await supervisor.start();
    expect(supervisor.currentState).toBe("ready");

    const startTime = Date.now();
    await supervisor.stop({ reason: "SIGTERM simulated" });
    const duration = Date.now() - startTime;

    expect(supervisor.currentState).toBe("stopped");
    expect(stopOrder).toEqual(["C", "B", "A"]);
    expect(duration).toBeLessThan(5000);
  });

  it("enforces shutdown deadline when a module takes too long to stop", async () => {
    const hangModule = createSlowModule("hang", [], 5000); // 5 second hang
    const config = DaemonConfigSchema.parse({
      logLevel: "silent",
      shutdownTimeoutMs: 100, // Short 100ms deadline
    });

    const supervisor = new DaemonSupervisor({
      config,
      modules: [hangModule],
    });

    await supervisor.start();

    const start = Date.now();
    await supervisor.stop({ timeoutMs: 100 });
    const duration = Date.now() - start;

    expect(supervisor.currentState).toBe("stopped");
    // Should complete quickly without hanging for 5 seconds
    expect(duration).toBeLessThan(1500);
  });
});
