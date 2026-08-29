import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { DaemonLock, acquireDaemonLock, isProcessAlive } from "../src/lock.js";

describe("lock", () => {
  const getTempLockPath = () =>
    path.join(
      os.tmpdir(),
      `resin-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "daemon.lock",
    );

  describe("isProcessAlive", () => {
    it("returns true for the current running process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent PID", () => {
      // 9999999 is almost certainly not a valid running PID
      expect(isProcessAlive(9999999)).toBe(false);
    });

    it("returns false for invalid inputs", () => {
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(Number.NaN)).toBe(false);
    });
  });

  describe("DaemonLock acquisition and release", () => {
    it("acquires lock successfully when no lock file exists", async () => {
      const lockPath = getTempLockPath();
      const lock = new DaemonLock({
        lockPath,
        socketPath: "/tmp/resin-test.sock",
        version: "0.1.0",
      });

      const result = await lock.acquire();
      expect(result.status).toBe("acquired");
      expect(result.pid).toBe(process.pid);
      expect(result.lockData?.version).toBe("0.1.0");
      expect(lock.isLocked).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);

      const content = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
      expect(content.pid).toBe(process.pid);
      expect(content.socketPath).toBe("/tmp/resin-test.sock");

      await lock.release();
      expect(lock.isLocked).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("returns already_running when another instance holds the lock", async () => {
      const lockPath = getTempLockPath();
      const lock1 = new DaemonLock({ lockPath, socketPath: "/tmp/sock1" });
      const lock2 = new DaemonLock({ lockPath, socketPath: "/tmp/sock2" });

      const res1 = await lock1.acquire();
      expect(res1.status).toBe("acquired");

      const res2 = await lock2.acquire();
      expect(res2.status).toBe("already_running");
      expect(res2.pid).toBe(process.pid);
      expect(res2.lockData?.socketPath).toBe("/tmp/sock1");

      await lock1.release();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("acquireDaemonLock helper acquires lock", async () => {
      const lockPath = getTempLockPath();
      const res = await acquireDaemonLock({ lockPath });
      expect(res.status).toBe("acquired");
      if (res.lock) {
        await res.lock.release();
      }
    });
  });

  describe("Stale lock recovery", () => {
    it("recovers stale lock when process PID is dead", async () => {
      const lockPath = getTempLockPath();
      await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

      // Write lock with a dead PID (9999999)
      const fakePayload = {
        pid: 9999999,
        startedAt: Date.now() - 60000,
        lastHeartbeat: Date.now(),
        version: "0.1.0",
        socketPath: "/tmp/dead.sock",
      };
      await fs.promises.writeFile(lockPath, JSON.stringify(fakePayload), "utf-8");

      const lock = new DaemonLock({ lockPath });
      const result = await lock.acquire();

      expect(result.status).toBe("stale_recovered");
      expect(result.pid).toBe(process.pid);
      expect(result.previousLockData?.pid).toBe(9999999);

      await lock.release();
    });

    it("recovers stale lock when heartbeat is expired", async () => {
      const lockPath = getTempLockPath();
      await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

      // Write lock with heartbeat older than staleThresholdMs (e.g. 5000ms)
      const fakePayload = {
        pid: 9999999,
        startedAt: Date.now() - 60000,
        lastHeartbeat: Date.now() - 30000,
        version: "0.1.0",
        socketPath: "/tmp/expired.sock",
      };
      await fs.promises.writeFile(lockPath, JSON.stringify(fakePayload), "utf-8");

      const lock = new DaemonLock({ lockPath, staleThresholdMs: 5000 });
      const result = await lock.acquire();

      expect(result.status).toBe("stale_recovered");
      expect(result.pid).toBe(process.pid);

      await lock.release();
    });

    it("recovers stale lock when lock file is corrupted", async () => {
      const lockPath = getTempLockPath();
      await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.promises.writeFile(lockPath, "{ corrupted json... !!", "utf-8");

      const lock = new DaemonLock({ lockPath });
      const result = await lock.acquire();

      expect(result.status).toBe("stale_recovered");
      expect(result.pid).toBe(process.pid);

      await lock.release();
    });
  });

  describe("Heartbeat updates", () => {
    it("updates heartbeat timestamp in lock file", async () => {
      const lockPath = getTempLockPath();
      const lock = new DaemonLock({
        lockPath,
        heartbeatIntervalMs: 1000,
      });

      await lock.acquire();

      const content1 = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
      const hb1 = content1.lastHeartbeat;

      // Manually trigger heartbeat
      await new Promise((r) => setTimeout(r, 20));
      await lock.heartbeat();

      const content2 = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
      const hb2 = content2.lastHeartbeat;

      expect(hb2).toBeGreaterThanOrEqual(hb1);

      await lock.release();
    });
  });
});
