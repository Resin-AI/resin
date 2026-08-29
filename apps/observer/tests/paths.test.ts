import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureDaemonDirectories,
  ensureDaemonDirectoriesSync,
  getDaemonPaths,
  isWsl,
  resolvePaths,
} from "../src/paths.js";

describe("paths", () => {
  describe("resolvePaths", () => {
    it("resolves paths for Linux with default XDG paths", () => {
      const mockEnv = {
        HOME: "/home/testuser",
      } satisfies Record<string, string>;
      const paths = resolvePaths({
        env: mockEnv,
        platform: "linux",
        home: "/home/testuser",
      });

      expect(paths.configDir).toBe("/home/testuser/.config/resin");
      expect(paths.dataDir).toBe("/home/testuser/.local/share/resin");
      expect(paths.stateDir).toBe("/home/testuser/.local/state/resin");
      expect(paths.logDir).toBe("/home/testuser/.local/state/resin/logs");
      expect(paths.socketPath).toBe("/home/testuser/.local/state/resin/daemon.sock");
      expect(paths.lockFilePath).toBe("/home/testuser/.local/state/resin/daemon.lock");
      expect(paths.tokenFilePath).toBe("/home/testuser/.local/state/resin/auth.token");
    });

    it("respects explicit XDG environment variables on Linux", () => {
      const mockEnv = {
        HOME: "/home/testuser",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
        XDG_STATE_HOME: "/custom/state",
        XDG_RUNTIME_DIR: "/run/user/1000",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "linux",
      });

      expect(paths.configDir).toBe("/custom/config/resin");
      expect(paths.dataDir).toBe("/custom/data/resin");
      expect(paths.stateDir).toBe("/custom/state/resin");
      expect(paths.socketPath).toBe("/run/user/1000/resin.sock");
    });

    it("resolves paths for macOS (darwin)", () => {
      const mockEnv = {
        HOME: "/Users/testuser",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "darwin",
        home: "/Users/testuser",
      });

      expect(paths.configDir).toBe("/Users/testuser/Library/Application Support/resin");
      expect(paths.dataDir).toBe("/Users/testuser/Library/Application Support/resin");
      expect(paths.stateDir).toBe("/Users/testuser/Library/Caches/resin");
      expect(paths.logDir).toBe("/Users/testuser/Library/Logs/resin");
      expect(paths.socketPath).toBe("/Users/testuser/Library/Caches/resin/daemon.sock");
    });

    it("resolves paths for Windows (win32)", () => {
      const mockEnv = {
        USERPROFILE: "C:\\Users\\testuser",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "win32",
        home: "C:\\Users\\testuser",
      });

      expect(paths.configDir).toContain("AppData");
      expect(paths.configDir).toContain("resin");
      expect(paths.socketPath).toBe("\\\\.\\pipe\\resin-daemon");
    });

    it("uses RESIN_HOME as the root base when provided", () => {
      const customHome = "/tmp/test-resin-root";
      const paths = resolvePaths({
        resinHome: customHome,
      });

      expect(paths.homeDir).toBe(customHome);
      expect(paths.configDir).toBe(path.join(customHome, "config"));
      expect(paths.dataDir).toBe(path.join(customHome, "data"));
      expect(paths.stateDir).toBe(path.join(customHome, "state"));
      expect(paths.logDir).toBe(path.join(customHome, "logs"));
      expect(paths.socketPath).toBe(path.join(customHome, "state", "daemon.sock"));
      expect(paths.lockFilePath).toBe(path.join(customHome, "state", "daemon.lock"));
    });

    it("allows granular environment variable overrides", () => {
      const mockEnv = {
        RESIN_CONFIG_DIR: "/override/config",
        RESIN_DATA_DIR: "/override/data",
        RESIN_STATE_DIR: "/override/state",
        RESIN_LOG_DIR: "/override/logs",
        RESIN_SOCKET_PATH: "/override/socket.sock",
        RESIN_LOCK_FILE: "/override/my.lock",
        RESIN_TOKEN_FILE: "/override/my.token",
      };

      const paths = resolvePaths({ env: mockEnv });

      expect(paths.configDir).toBe(path.resolve("/override/config"));
      expect(paths.dataDir).toBe(path.resolve("/override/data"));
      expect(paths.stateDir).toBe(path.resolve("/override/state"));
      expect(paths.logDir).toBe(path.resolve("/override/logs"));
      expect(paths.socketPath).toBe(path.resolve("/override/socket.sock"));
      expect(paths.lockFilePath).toBe(path.resolve("/override/my.lock"));
      expect(paths.tokenFilePath).toBe(path.resolve("/override/my.token"));
    });

    it("getDaemonPaths aliases resolvePaths", () => {
      const paths = getDaemonPaths({ resinHome: "/tmp/resin-test" });
      expect(paths.homeDir).toBe(path.resolve("/tmp/resin-test"));
    });
  });

  describe("WSL detection", () => {
    it("detects WSL from environment variable", () => {
      expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
      expect(isWsl({ IS_WSL: "1" })).toBe(true);
      expect(isWsl({}, "6.8.0-generic")).toBe(false);
    });
  });

  describe("ensureDaemonDirectories", () => {
    it("creates all required directories", async () => {
      const testDir = path.join(
        os.tmpdir(),
        `resin-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const paths = resolvePaths({ home: testDir });

      await ensureDaemonDirectories(paths);

      expect(fs.existsSync(paths.homeDir)).toBe(true);
      expect(fs.existsSync(paths.configDir)).toBe(true);
      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(fs.existsSync(paths.stateDir)).toBe(true);
      expect(fs.existsSync(paths.logDir)).toBe(true);

      // Cleanup
      await fs.promises.rm(testDir, { recursive: true, force: true });
    });

    it("synchronously creates all required directories", () => {
      const testDir = path.join(
        os.tmpdir(),
        `resin-paths-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const paths = resolvePaths({ home: testDir });

      ensureDaemonDirectoriesSync(paths);

      expect(fs.existsSync(paths.homeDir)).toBe(true);
      expect(fs.existsSync(paths.configDir)).toBe(true);
      expect(fs.existsSync(paths.dataDir)).toBe(true);
      expect(fs.existsSync(paths.stateDir)).toBe(true);
      expect(fs.existsSync(paths.logDir)).toBe(true);

      fs.rmSync(testDir, { recursive: true, force: true });
    });
  });
});
