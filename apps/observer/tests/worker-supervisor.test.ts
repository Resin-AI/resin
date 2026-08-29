import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerSupervisor, buildSanitizedEnv } from "../src/worker-supervisor.js";

describe("worker-supervisor", () => {
  describe("buildSanitizedEnv", () => {
    it("strips sensitive environment variables by default", () => {
      const sanitized = buildSanitizedEnv({ CUSTOM_VAR: "allowed" }, false);
      expect(sanitized.CUSTOM_VAR).toBe("allowed");
      expect(sanitized.RESIN_AUTH_TOKEN).toBeUndefined();
      expect(sanitized.RESIN_CLOUD_API_KEY).toBeUndefined();
      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    });
  });

  describe("runWorker", () => {
    it("executes a child process successfully to completion", async () => {
      const supervisor = new WorkerSupervisor();
      const result = await supervisor.runWorker({
        command: process.execPath,
        args: ["-e", "console.log('Hello from worker'); process.exit(0);"],
      });

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout.trim()).toBe("Hello from worker");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("captures non-zero exit code and crash status", async () => {
      const supervisor = new WorkerSupervisor();
      const result = await supervisor.runWorker({
        command: process.execPath,
        args: ["-e", "console.error('Fatal failure'); process.exit(42);"],
      });

      expect(result.status).toBe("crashed");
      expect(result.exitCode).toBe(42);
      expect(result.stderr.trim()).toBe("Fatal failure");
    });

    it("captures uncaught exceptions without crashing supervisor", async () => {
      const supervisor = new WorkerSupervisor();
      const result = await supervisor.runWorker({
        command: process.execPath,
        args: ["-e", "throw new Error('Uncaught runtime explosion');"],
      });

      expect(result.status).toBe("crashed");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Uncaught runtime explosion");
    });

    it("terminates child process when execution timeout is exceeded", async () => {
      const supervisor = new WorkerSupervisor();
      const result = await supervisor.runWorker({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"], // Hangs forever
        timeoutMs: 150,
      });

      expect(result.status).toBe("timed_out");
      expect(result.error).toContain("timed out");
    });

    it("truncates output when output exceeds maxOutputBytes", async () => {
      const supervisor = new WorkerSupervisor();
      const result = await supervisor.runWorker({
        command: process.execPath,
        args: ["-e", "process.stdout.write('A'.repeat(5000));"],
        maxOutputBytes: 100,
      });

      expect(result.status).toBe("completed");
      expect(result.stdout).toContain("[OUTPUT TRUNCATED]");
      expect(result.stdout.length).toBeLessThan(500);
    });

    it("pipes stdin to child worker process", async () => {
      const supervisor = new WorkerSupervisor();
      const result = await supervisor.runWorker({
        command: process.execPath,
        args: [
          "-e",
          `let data = '';
           process.stdin.on('data', chunk => data += chunk);
           process.stdin.on('end', () => console.log('Received:' + data));`,
        ],
        stdin: "input-payload-123",
      });

      expect(result.status).toBe("completed");
      expect(result.stdout.trim()).toBe("Received:input-payload-123");
    });
  });
});
