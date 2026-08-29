import path from "node:path";
import process from "node:process";
import { resolvePaths } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import {
  doctorCommand,
  formatDoctorForTerminal,
  parseDoctorFlags,
  repairCommand,
  repairState,
  runDiagnostics,
} from "../src/commands/doctor.js";
import type { UserServiceManager } from "../src/service/manager.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async mkdirp(dirPath: string): Promise<void> {
      files.set(dirPath, "dir");
    },
    async copyFile(src: string, dest: string): Promise<void> {
      const c = files.get(src);
      if (c !== undefined) files.set(dest, c);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
    async chmod(_filePath: string, _mode: number): Promise<void> {},
  };
}

function createMockServiceManager(): UserServiceManager {
  const unitPath = "/mock/resin.service";
  return {
    name: "mock",
    platform: "systemd",
    install: vi.fn().mockResolvedValue({
      success: true,
      unitPath,
      unitContent: "",
      serviceName: "resin.service",
      enabled: true,
      started: false,
    }),
    uninstall: vi.fn().mockResolvedValue({
      success: true,
      unitPath,
      stopped: true,
      disabled: true,
      removed: true,
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({
      installed: false,
      active: false,
      enabled: false,
      serviceName: "resin.service",
      unitPath,
      state: "not_installed",
    }),
    isInstalled: vi.fn().mockResolvedValue(false),
    getUnitDefinition: vi.fn().mockReturnValue(""),
    getUnitPath: vi.fn().mockReturnValue(unitPath),
  };
}

describe("doctor & repair commands", () => {
  const homeDir = "/home/testuser";
  const resinHome = path.join(homeDir, ".resin");
  const daemonPaths = resolvePaths({ home: homeDir });
  const lockFilePath = daemonPaths.lockFilePath;

  it("parses doctor and repair flags", () => {
    const flags1 = parseDoctorFlags(["--fix", "--strict", "--json"]);
    expect(flags1.fix).toBe(true);
    expect(flags1.strict).toBe(true);
    expect(flags1.json).toBe(true);

    const flags2 = parseDoctorFlags(["--home", "/custom/path", "-h"]);
    expect(flags2.home).toBe("/custom/path");
    expect(flags2.help).toBe(true);
  });

  it("diagnoses missing directories and stale lockfiles", async () => {
    const fsBridge = createMockFsBridge({
      [lockFilePath]: "12345", // stale lockfile while daemon is inactive
    });

    const items = await runDiagnostics({
      home: homeDir,
      fsBridge,
      serviceManager: createMockServiceManager(),
    });

    const dirItem = items.find((i) => i.id === "fs_directories");
    expect(dirItem).toBeDefined();
    expect(dirItem?.status).toBe("fail");
    expect(dirItem?.fixable).toBe(true);

    const lockItem = items.find((i) => i.id === "stale_lockfile");
    expect(lockItem).toBeDefined();
    expect(lockItem?.status).toBe("warn");
    expect(lockItem?.fixable).toBe(true);
  });

  it("repairs state by creating directories and removing stale lockfile", async () => {
    const fsBridge = createMockFsBridge({
      [lockFilePath]: "12345",
    });

    const actions = await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    expect(actions.some((a) => a.includes("Created directory"))).toBe(true);
    expect(actions.some((a) => a.includes("Removed stale lockfile"))).toBe(true);

    // Verify lockfile was removed from fsBridge
    expect(await fsBridge.exists(lockFilePath)).toBe(false);

    // Verify directories were created
    expect(await fsBridge.exists(resinHome)).toBe(true);
  });

  it("formats terminal doctor report with proper icons and summary", () => {
    const report = {
      passed: true,
      healthy: true,
      totalChecks: 3,
      passedCount: 3,
      warnCount: 0,
      failCount: 0,
      fixedCount: 1,
      items: [
        {
          id: "platform_supported",
          name: "Supported Operating System",
          category: "platform" as const,
          status: "pass" as const,
          message: "linux (arm64) on Node v22.0.0",
          fixable: false,
        },
      ],
      actionsTaken: ["Created directory: /home/testuser/.resin"],
      timestamp: new Date().toISOString(),
    };

    const formatted = formatDoctorForTerminal(report);
    expect(formatted).toContain("RESIN DOCTOR REPORT");
    expect(formatted).toContain("[✓] Supported Operating System");
    expect(formatted).toContain("[Remediations Applied]");
    expect(formatted).toContain("Overall Health: HEALTHY");
  });

  it("keeps repair successful when notification persistence is unavailable", async () => {
    const fsBridge = createMockFsBridge();
    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    try {
      const exitCode = await repairCommand(["--json", "--home", homeDir], {
        fsBridge,
        serviceManager: createMockServiceManager(),
        notificationConsumer: vi.fn().mockRejectedValue(new Error("inbox unavailable")),
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      });

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutChunks.join(""));
      expect(output.passed).toBe(true);
      expect(output.fixedCount).toBeGreaterThan(0);
      expect(output.notifications).toEqual([]);
    } finally {
      process.stdout.write = originalStdout;
    }
  });
});
