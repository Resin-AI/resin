import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkerSupervisor,
  buildDenoWorkerPermissions,
  buildSanitizedEnv,
} from "../src/worker-supervisor.js";

describe("Observer Worker Supervisor Filesystem Isolation", () => {
  let tempDir: string;
  let workspaceDir: string;
  let scratchDir: string;
  let bundlePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin_obs_worker_"));
    workspaceDir = path.join(tempDir, "workspace");
    scratchDir = path.join(tempDir, "scratch");
    bundlePath = path.join(tempDir, "bundle", "entry.ts");

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });

    fs.writeFileSync(path.join(workspaceDir, "data.txt"), "WORKSPACE_SECRET_DATA");
    fs.writeFileSync(bundlePath, "export default async function() { return 42; }");
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("buildDenoWorkerPermissions", () => {
    it("generates strict permission flags exposing only bundle, sdk, and scratch dir", () => {
      const sdkDir = path.join(tempDir, "sdk");
      fs.mkdirSync(sdkDir, { recursive: true });

      const flags = buildDenoWorkerPermissions({
        bundleEntrypoint: bundlePath,
        scratchDir,
        sdkPaths: [sdkDir],
        workspaceRoot: workspaceDir,
      });

      expect(flags).toContain("--no-prompt");
      expect(flags).toContain("--deny-net");
      expect(flags).toContain("--deny-env");
      expect(flags).toContain("--deny-run");
      expect(flags).toContain("--deny-ffi");

      const readFlag = flags.find((f) => f.startsWith("--allow-read="));
      expect(readFlag).toBeDefined();

      const writeFlag = flags.find((f) => f.startsWith("--allow-write="));
      expect(writeFlag).toBe(`--allow-write=${path.resolve(scratchDir)}`);

      // Verify read paths contain bundle, scratch, sdk
      expect(readFlag).toContain(path.resolve(bundlePath));
      expect(readFlag).toContain(path.resolve(scratchDir));
      expect(readFlag).toContain(path.resolve(sdkDir));

      // CRITICAL: Verify workspace directory is ABSENT from read permissions
      expect(readFlag).not.toContain(path.resolve(workspaceDir));
    });

    it("strictly refuses to add workspaceRoot even if attempted in allowReadPaths", () => {
      const flags = buildDenoWorkerPermissions({
        bundleEntrypoint: bundlePath,
        scratchDir,
        workspaceRoot: workspaceDir,
        allowReadPaths: [workspaceDir, path.join(tempDir, "extra_allowed")],
      });

      const readFlag = flags.find((f) => f.startsWith("--allow-read="));
      expect(readFlag).toBeDefined();

      // workspaceDir must be filtered out
      expect(readFlag).not.toContain(path.resolve(workspaceDir));
      expect(readFlag).toContain(path.resolve(path.join(tempDir, "extra_allowed")));
    });
  });

  describe("WorkerSupervisor Execution Isolation", () => {
    it("runs child process with sanitized environment and custom scratch directory", async () => {
      const supervisor = new WorkerSupervisor({ defaultTimeoutMs: 5000 });

      // Run node script printing env and writing to scratchDir
      const script = `
        const fs = require('node:fs');
        const path = require('node:path');
        fs.writeFileSync(path.join(process.cwd(), 'worker_out.txt'), 'SUCCESS');
        console.log(JSON.stringify({
          cwd: process.cwd(),
          hasSecret: !!process.env.RESIN_AUTH_TOKEN,
          customVar: process.env.CUSTOM_TEST_VAR
        }));
      `;

      const result = await supervisor.runWorker({
        scriptPath: "-e",
        args: [script],
        cwd: scratchDir,
        env: buildSanitizedEnv({
          CUSTOM_TEST_VAR: "allowed_value",
          RESIN_AUTH_TOKEN: "should_be_stripped",
        }),
      });

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.hasSecret).toBe(false);
      expect(parsed.customVar).toBe("allowed_value");
      expect(parsed.cwd).toBe(scratchDir);

      // Verify file written in scratchDir
      expect(fs.existsSync(path.join(scratchDir, "worker_out.txt"))).toBe(true);
    });

    it("isolates worker failures and resource violations", async () => {
      const supervisor = new WorkerSupervisor({ defaultTimeoutMs: 1000 });

      const hungScript = "while(true) {}";
      const result = await supervisor.runWorker({
        scriptPath: "-e",
        args: [hungScript],
        timeoutMs: 500,
      });

      expect(result.status).toBe("timed_out");
      expect(result.error).toContain("timed out");
    });
  });
});
