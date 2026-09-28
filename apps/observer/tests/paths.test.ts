import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkOwnerOnly, windowsDaemonPipeName } from "@resin/windows-security";
import { PROBE_ACCESS, probeOpenWithUserSidDisabled } from "@resin/windows-security/testing";
import { describe, expect, it } from "vitest";
import {
  ensureDaemonDirectories,
  ensureDaemonDirectoriesSync,
  getDaemonPaths,
  isWsl,
  resolvePaths,
} from "../src/paths.js";

// These cases assert literal POSIX paths ("/home/testuser/.resin"), which path.resolve turns into
// drive paths on Windows; the Windows layout has its own cases below.
const itPosixLayout = it.skipIf(process.platform === "win32");

/** Default daemon endpoint for a Resin home on this OS. */
function defaultSocketFor(resinHome: string): string {
  return process.platform === "win32"
    ? windowsDaemonPipeName(path.resolve(resinHome))
    : path.resolve(path.join(resinHome, "state", "daemon.sock"));
}

const WINDOWS_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

describe("paths", () => {
  describe("resolvePaths", () => {
    itPosixLayout("resolves default canonical paths under ~/.resin on Linux", () => {
      const mockEnv = {
        HOME: "/home/testuser",
      } satisfies Record<string, string>;
      const paths = resolvePaths({
        env: mockEnv,
        platform: "linux",
        home: "/home/testuser",
      });

      expect(paths.homeDir).toBe("/home/testuser/.resin");
      expect(paths.configDir).toBe("/home/testuser/.resin/config");
      expect(paths.dataDir).toBe("/home/testuser/.resin/data");
      expect(paths.stateDir).toBe("/home/testuser/.resin/state");
      expect(paths.logDir).toBe("/home/testuser/.resin/logs");
      expect(paths.socketPath).toBe("/home/testuser/.resin/state/daemon.sock");
      expect(paths.lockFilePath).toBe("/home/testuser/.resin/state/daemon.lock");
      expect(paths.pidFilePath).toBe("/home/testuser/.resin/state/daemon.pid");
      expect(paths.configFile).toBe("/home/testuser/.resin/config/config.json");
    });

    itPosixLayout(
      "ensures XDG environment variables do not displace the canonical default root",
      () => {
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
          home: "/home/testuser",
        });

        expect(paths.homeDir).toBe("/home/testuser/.resin");
        expect(paths.configDir).toBe("/home/testuser/.resin/config");
        expect(paths.dataDir).toBe("/home/testuser/.resin/data");
        expect(paths.stateDir).toBe("/home/testuser/.resin/state");
        expect(paths.logDir).toBe("/home/testuser/.resin/logs");
        expect(paths.socketPath).toBe("/home/testuser/.resin/state/daemon.sock");
        expect(paths.lockFilePath).toBe("/home/testuser/.resin/state/daemon.lock");
      },
    );

    itPosixLayout("resolves default canonical paths for macOS (darwin)", () => {
      const mockEnv = {
        HOME: "/Users/testuser",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "darwin",
        home: "/Users/testuser",
      });

      expect(paths.homeDir).toBe("/Users/testuser/.resin");
      expect(paths.configDir).toBe("/Users/testuser/.resin/config");
      expect(paths.dataDir).toBe("/Users/testuser/.resin/data");
      expect(paths.stateDir).toBe("/Users/testuser/.resin/state");
      expect(paths.logDir).toBe("/Users/testuser/.resin/logs");
      expect(paths.socketPath).toBe("/Users/testuser/.resin/state/daemon.sock");
      expect(paths.lockFilePath).toBe("/Users/testuser/.resin/state/daemon.lock");
    });

    it("resolves default canonical paths for Windows (win32) with named pipe", () => {
      const winHome = "C:\\Users\\testuser";
      const mockEnv = {
        USERPROFILE: winHome,
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
      };
      const paths = resolvePaths({
        env: mockEnv,
        platform: "win32",
        home: winHome,
        windowsUserSid: WINDOWS_SID,
      });

      const expectedHome = path.resolve(path.join(winHome, ".resin"));
      const expectedState = path.join(expectedHome, "state");

      expect(paths.homeDir).toBe(expectedHome);
      expect(paths.configDir).toBe(path.join(expectedHome, "config"));
      expect(paths.dataDir).toBe(path.join(expectedHome, "data"));
      expect(paths.stateDir).toBe(expectedState);
      expect(paths.logDir).toBe(path.join(expectedHome, "logs"));
      expect(paths.socketPath).toBe(windowsDaemonPipeName(expectedHome, WINDOWS_SID));
      expect(paths.socketPath).toMatch(/^\\\\\.\\pipe\\resin-daemon-[0-9a-f]{16}$/);
      expect(paths.lockFilePath).toBe(path.join(expectedState, "daemon.lock"));
    });

    it("canonicalizes local pipe overrides on Windows and never turns other values into pipes", () => {
      const base = {
        platform: "win32" as const,
        home: "C:\\Users\\testuser",
        windowsUserSid: WINDOWS_SID,
      };
      expect(resolvePaths({ ...base, socketPath: "\\\\.\\PIPE\\resin-custom" }).socketPath).toBe(
        "\\\\.\\pipe\\resin-custom",
      );
      expect(
        resolvePaths({ ...base, env: { RESIN_SOCKET_PATH: "\\\\.\\pipe\\resin-env" } }).socketPath,
      ).toBe("\\\\.\\pipe\\resin-env");
      // The daemon refuses to serve, and clients refuse to dial, anything that is not a local pipe.
      for (const socketPath of ["\\\\server\\pipe\\resin", "\\\\?\\pipe\\resin", "daemon.sock"]) {
        expect(resolvePaths({ ...base, socketPath }).socketPath.startsWith("\\\\.\\pipe\\")).toBe(
          false,
        );
      }
    });

    it.skipIf(process.platform === "win32")("needs a SID to simulate win32 elsewhere", () => {
      expect(() => resolvePaths({ platform: "win32", home: "C:\\Users\\testuser" })).toThrow(
        /windowsUserSid/,
      );
    });

    it("uses resinHome option with highest precedence and relocates socket and lock files", () => {
      const customHome = "/tmp/test-resin-root";
      const paths = resolvePaths({
        resinHome: customHome,
        env: {
          RESIN_HOME: "/env/resin/root",
          HOME: "/home/testuser",
        },
      });

      expect(paths.homeDir).toBe(path.resolve(customHome));
      expect(paths.configDir).toBe(path.resolve(path.join(customHome, "config")));
      expect(paths.dataDir).toBe(path.resolve(path.join(customHome, "data")));
      expect(paths.stateDir).toBe(path.resolve(path.join(customHome, "state")));
      expect(paths.logDir).toBe(path.resolve(path.join(customHome, "logs")));
      expect(paths.socketPath).toBe(defaultSocketFor(customHome));
      expect(paths.lockFilePath).toBe(path.resolve(path.join(customHome, "state", "daemon.lock")));
      expect(paths.pidFilePath).toBe(path.resolve(path.join(customHome, "state", "daemon.pid")));
      expect(paths.configFile).toBe(path.resolve(path.join(customHome, "config", "config.json")));
    });

    it("uses RESIN_HOME environment variable when resinHome option is not set", () => {
      const envHome = "/env/resin-root";
      const paths = resolvePaths({
        env: {
          RESIN_HOME: envHome,
          HOME: "/home/testuser",
        },
      });

      expect(paths.homeDir).toBe(path.resolve(envHome));
      expect(paths.configDir).toBe(path.resolve(path.join(envHome, "config")));
      expect(paths.dataDir).toBe(path.resolve(path.join(envHome, "data")));
      expect(paths.stateDir).toBe(path.resolve(path.join(envHome, "state")));
      expect(paths.logDir).toBe(path.resolve(path.join(envHome, "logs")));
      expect(paths.socketPath).toBe(defaultSocketFor(envHome));
      expect(paths.lockFilePath).toBe(path.resolve(path.join(envHome, "state", "daemon.lock")));
    });

    itPosixLayout(
      "falls back to default canonical root when resinHome option and RESIN_HOME are empty or whitespace",
      () => {
        const pathsEmpty = resolvePaths({
          resinHome: "",
          env: {
            RESIN_HOME: "",
            HOME: "/home/testuser",
          },
          platform: "linux",
        });

        expect(pathsEmpty.homeDir).toBe("/home/testuser/.resin");
        expect(pathsEmpty.configDir).toBe("/home/testuser/.resin/config");
        expect(pathsEmpty.dataDir).toBe("/home/testuser/.resin/data");
        expect(pathsEmpty.stateDir).toBe("/home/testuser/.resin/state");
        expect(pathsEmpty.logDir).toBe("/home/testuser/.resin/logs");

        const pathsWhitespace = resolvePaths({
          resinHome: "   ",
          env: {
            RESIN_HOME: "   ",
            HOME: "/home/testuser",
          },
          platform: "linux",
        });

        expect(pathsWhitespace.homeDir).toBe("/home/testuser/.resin");
      },
    );

    it("falls back to RESIN_HOME when resinHome option is empty or whitespace", () => {
      const envHome = "/env/resin-root";
      const pathsEmptyOption = resolvePaths({
        resinHome: "",
        env: {
          RESIN_HOME: envHome,
          HOME: "/home/testuser",
        },
      });

      expect(pathsEmptyOption.homeDir).toBe(path.resolve(envHome));

      const pathsWhitespaceOption = resolvePaths({
        resinHome: "   ",
        env: {
          RESIN_HOME: envHome,
          HOME: "/home/testuser",
        },
      });

      expect(pathsWhitespaceOption.homeDir).toBe(path.resolve(envHome));
    });

    itPosixLayout(
      "falls back to default canonical root when RESIN_HOME is empty or whitespace and resinHome is omitted",
      () => {
        const pathsEmptyEnv = resolvePaths({
          env: {
            RESIN_HOME: "",
            HOME: "/home/testuser",
          },
          platform: "linux",
        });

        expect(pathsEmptyEnv.homeDir).toBe("/home/testuser/.resin");

        const pathsWhitespaceEnv = resolvePaths({
          env: {
            RESIN_HOME: "   ",
            HOME: "/home/testuser",
          },
          platform: "linux",
        });

        expect(pathsWhitespaceEnv.homeDir).toBe("/home/testuser/.resin");
      },
    );

    itPosixLayout("falls back to default user home when home option is empty or whitespace", () => {
      const pathsEmptyHome = resolvePaths({
        home: "",
        env: {
          HOME: "/home/testuser",
        },
        platform: "linux",
      });

      expect(pathsEmptyHome.homeDir).toBe("/home/testuser/.resin");

      const pathsWhitespaceHome = resolvePaths({
        home: "   ",
        env: {
          HOME: "/home/testuser",
        },
        platform: "linux",
      });

      expect(pathsWhitespaceHome.homeDir).toBe("/home/testuser/.resin");
    });

    itPosixLayout("allows granular environment variable overrides on top of canonical root", () => {
      const mockEnv = {
        HOME: "/home/testuser",
        RESIN_CONFIG_DIR: "/override/config",
        RESIN_DATA_DIR: "/override/data",
        RESIN_STATE_DIR: "/override/state",
        RESIN_LOG_DIR: "/override/logs",
        RESIN_SOCKET_PATH: "/override/socket.sock",
        RESIN_LOCK_FILE: "/override/my.lock",
        RESIN_PID_FILE: "/override/my.pid",
        RESIN_CONFIG_FILE: "/override/my-config.json",
      };

      const paths = resolvePaths({ env: mockEnv, platform: "linux", home: "/home/testuser" });

      expect(paths.homeDir).toBe("/home/testuser/.resin");
      expect(paths.configDir).toBe(path.resolve("/override/config"));
      expect(paths.dataDir).toBe(path.resolve("/override/data"));
      expect(paths.stateDir).toBe(path.resolve("/override/state"));
      expect(paths.logDir).toBe(path.resolve("/override/logs"));
      expect(paths.socketPath).toBe(path.resolve("/override/socket.sock"));
      expect(paths.lockFilePath).toBe(path.resolve("/override/my.lock"));
      expect(paths.pidFilePath).toBe(path.resolve("/override/my.pid"));
      expect(paths.configFile).toBe(path.resolve("/override/my-config.json"));
    });

    it("allows granular option overrides on top of environment and canonical root", () => {
      const mockEnv = {
        RESIN_CONFIG_DIR: "/env/config",
        RESIN_SOCKET_PATH: "/env/socket.sock",
      };

      const paths = resolvePaths({
        resinHome: "/custom/root",
        env: mockEnv,
        configDir: "/option/config",
        socketPath: "/option/socket.sock",
      });

      expect(paths.homeDir).toBe(path.resolve("/custom/root"));
      expect(paths.configDir).toBe(path.resolve("/option/config"));
      expect(paths.socketPath).toBe(path.resolve("/option/socket.sock"));
      expect(paths.dataDir).toBe(path.resolve("/custom/root/data"));
      expect(paths.stateDir).toBe(path.resolve("/custom/root/state"));
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

    it.runIf(process.platform === "win32")(
      "gives the Resin home and its directories owner-only DACLs on Windows",
      async () => {
        const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-paths-acl-"));
        try {
          const paths = resolvePaths({ home: testDir });
          expect(paths.socketPath).toBe(windowsDaemonPipeName(paths.homeDir));
          await ensureDaemonDirectories(paths);
          for (const dir of [paths.homeDir, paths.configDir, paths.dataDir, paths.stateDir]) {
            expect(checkOwnerOnly(dir)).toMatchObject({ ok: true, ownedByCurrentUser: true });
            expect(probeOpenWithUserSidDisabled(dir, PROBE_ACCESS.read).ok).toBe(false);
          }
          // Files created later inherit owner-only access.
          const file = path.join(paths.stateDir, "anything.json");
          fs.writeFileSync(file, "{}");
          expect(checkOwnerOnly(file).ok).toBe(true);
          expect(probeOpenWithUserSidDisabled(file, PROBE_ACCESS.read).win32Error).toBe(5);
        } finally {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      },
    );
  });
});
