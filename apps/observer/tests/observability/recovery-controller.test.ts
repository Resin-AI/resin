import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { createAuditTrailManager } from "../../src/observability/audit-trail.js";
import { createKillSwitchManager } from "../../src/observability/kill-switches.js";
import {
  CircuitBreaker,
  RecoveryController,
  createRecoveryController,
} from "../../src/observability/recovery-controller.js";

describe("RecoveryController", () => {
  describe("Bounded Retries", () => {
    it("retries transient failures up to maxAttempts with exponential backoff", async () => {
      const controller = createRecoveryController();
      let callCount = 0;

      const result = await controller.executeWithRetry(
        "flaky_api",
        async () => {
          callCount++;
          if (callCount < 3) {
            throw new Error("Temporary network timeout");
          }
          return "success_result";
        },
        { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 5, jitter: false },
      );

      expect(result).toBe("success_result");
      expect(callCount).toBe(3);
    });

    it("throws error when max attempts are exhausted", async () => {
      const controller = createRecoveryController();
      let callCount = 0;

      await expect(
        controller.executeWithRetry(
          "failing_op",
          async () => {
            callCount++;
            throw new Error("Persistent error");
          },
          { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, jitter: false },
        ),
      ).rejects.toThrow("Persistent error");

      expect(callCount).toBe(3);
    });

    it("respects retry budget tokens and blocks excessive retry storms", async () => {
      const controller = createRecoveryController({ maxRetriesPerMinute: 2 });

      // Consume tokens
      await expect(
        controller.executeWithRetry(
          "op1",
          async () => {
            throw new Error("fail");
          },
          { maxAttempts: 2, initialDelayMs: 1, jitter: false },
        ),
      ).rejects.toThrow("fail");

      // Next retry attempt should exhaust budget
      await expect(
        controller.executeWithRetry(
          "op2",
          async () => {
            throw new Error("fail2");
          },
          { maxAttempts: 3, initialDelayMs: 1, jitter: false },
        ),
      ).rejects.toThrow(/Retry budget exhausted/);
    });
  });

  describe("Circuit Breaker", () => {
    it("transitions from CLOSED to OPEN after failure threshold", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000 });

      expect(breaker.getState()).toBe("CLOSED");

      // 3 failures
      for (let i = 0; i < 3; i++) {
        await expect(
          breaker.execute(async () => {
            throw new Error("err");
          }),
        ).rejects.toThrow("err");
      }

      expect(breaker.getState()).toBe("OPEN");

      // Immediate subsequent call fails fast without executing op
      let executed = false;
      await expect(
        breaker.execute(async () => {
          executed = true;
          return "val";
        }),
      ).rejects.toThrow(/Circuit breaker is OPEN/);

      expect(executed).toBe(false);
    });

    it("transitions to HALF_OPEN and recovers to CLOSED upon success", async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        recoveryTimeoutMs: 10,
        successThreshold: 2,
      });

      // Fail twice
      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.execute(async () => {
            throw new Error("err");
          }),
        ).rejects.toThrow();
      }

      expect(breaker.getState()).toBe("OPEN");

      // Wait for recovery timeout using fake wait or immediate check after delay
      await new Promise((r) => setTimeout(r, 15));
      expect(breaker.getState()).toBe("HALF_OPEN");

      // Success 1
      await breaker.execute(async () => "ok1");
      expect(breaker.getState()).toBe("HALF_OPEN");

      // Success 2 -> recovers to CLOSED
      await breaker.execute(async () => "ok2");
      expect(breaker.getState()).toBe("CLOSED");
    });
  });

  describe("Stale Lock Recovery", () => {
    it("safely detects and recovers stale lock from dead process", async () => {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lock-test-"));
      const lockPath = path.join(tmpDir, "daemon.lock");

      // Write stale lock with non-existent PID (e.g. 99999999)
      const stalePayload = {
        pid: 99999999,
        startedAt: Date.now() - 60000,
        lastHeartbeat: Date.now() - 30000,
        version: "0.1.0",
        socketPath: "/tmp/fake.sock",
      };
      await fs.promises.writeFile(lockPath, JSON.stringify(stalePayload));

      const controller = createRecoveryController();
      const result = await controller.recoverStaleLock(lockPath, { staleThresholdMs: 5000 });

      expect(result.recovered).toBe(true);
      expect(result.previousPid).toBe(99999999);
      expect(fs.existsSync(lockPath)).toBe(false);

      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it("does not remove active lock from live running process", async () => {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lock-test-live-"));
      const lockPath = path.join(tmpDir, "daemon.lock");

      // Write lock with current live PID
      const livePayload = {
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
        version: "0.1.0",
        socketPath: "/tmp/fake.sock",
      };
      await fs.promises.writeFile(lockPath, JSON.stringify(livePayload));

      const controller = createRecoveryController();
      const result = await controller.recoverStaleLock(lockPath, { staleThresholdMs: 30000 });

      expect(result.recovered).toBe(false);
      expect(result.previousPid).toBe(process.pid);
      expect(fs.existsSync(lockPath)).toBe(true);

      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe("Tool Quarantine", () => {
    it("automatically quarantines tool version after consecutive failures", async () => {
      const auditTrail = createAuditTrailManager();
      const killSwitches = createKillSwitchManager();
      const controller = createRecoveryController(
        { quarantineThreshold: 3 },
        auditTrail,
        killSwitches,
      );

      const toolId = "custom_scout";
      const version = "1.2.0";

      // 1st failure
      const r1 = await controller.recordToolFailure(toolId, version, new Error("Null pointer"));
      expect(r1.quarantined).toBe(false);
      expect(controller.isToolQuarantined(toolId, version)).toBe(false);

      // 2nd failure
      const r2 = await controller.recordToolFailure(toolId, version, new Error("Out of memory"));
      expect(r2.quarantined).toBe(false);

      // 3rd consecutive failure -> should trigger quarantine
      const r3 = await controller.recordToolFailure(
        toolId,
        version,
        new Error("Segfault in worker"),
      );
      expect(r3.quarantined).toBe(true);
      expect(r3.reason).toContain("failed 3 consecutive times");
      expect(controller.isToolQuarantined(toolId, version)).toBe(true);

      // Tool should also be disabled in kill switches
      expect(killSwitches.isToolDisabled(toolId)).toBe(true);

      // Inspect quarantined tools list
      const quarantined = controller.getQuarantinedTools();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].toolId).toBe(toolId);
      expect(quarantined[0].version).toBe(version);
      expect(quarantined[0].failureCount).toBe(3);

      // Lift quarantine
      await controller.unquarantineTool(toolId, version);
      expect(controller.isToolQuarantined(toolId, version)).toBe(false);
      expect(killSwitches.isToolDisabled(toolId)).toBe(false);
    });

    it("resets consecutive failure counter on tool success", async () => {
      const controller = createRecoveryController({ quarantineThreshold: 3 });
      const toolId = "stable_tool";
      const version = "1.0.0";

      await controller.recordToolFailure(toolId, version, "err 1");
      await controller.recordToolFailure(toolId, version, "err 2");

      // Success occurs before 3rd failure
      controller.recordToolSuccess(toolId, version);

      // Next failure should be attempt 1 again
      const r = await controller.recordToolFailure(toolId, version, "err 3");
      expect(r.quarantined).toBe(false);
      expect(controller.isToolQuarantined(toolId, version)).toBe(false);
    });
  });
});
