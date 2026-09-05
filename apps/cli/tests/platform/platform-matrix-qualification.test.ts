import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_QUALIFICATION_LANES,
  PINNED_DENO_VERSION,
  PINNED_NODE_VERSION,
  PINNED_PNPM_VERSION,
  type PlatformInfo,
  type PlatformQualificationLane,
  REQUIRED_QUALIFICATION_LANES,
  UnsupportedPlatformError,
  V1_SUPPORT_MATRIX,
  canonicalizePlatformPath,
  detectPlatform,
  emitSupportMatrix,
  getPlatformDisplayName,
  getQualificationLane,
  isAppleSilicon,
  isWslEnvironment,
  isWslHostDrivePath,
  resolvePlatformPaths,
  resolveWindowsHostPath,
  resolveWslToWindowsPath,
  validatePlatform,
} from "../../src/platform/index.js";

describe("Platform Matrix Qualification Suite", () => {
  describe("Machine-Readable V1 Support Matrix Contract", () => {
    it("emits the canonical machine-readable support matrix", () => {
      expect(V1_SUPPORT_MATRIX.schemaVersion).toBe("2.0.0");
      expect(V1_SUPPORT_MATRIX.releaseVersion).toBe("1.0.0");

      // Product Identity & Package Names
      expect(V1_SUPPORT_MATRIX.product.productName).toBe("Resin");
      expect(V1_SUPPORT_MATRIX.product.binaryName).toBe("resin");
      expect(V1_SUPPORT_MATRIX.product.packageName).toBe("resin");
      expect(V1_SUPPORT_MATRIX.product.internalNamespace).toBe("@resin");
      expect(V1_SUPPORT_MATRIX.product.hasResinBinary).toBe(false);
      expect(V1_SUPPORT_MATRIX.product.hasResinPackage).toBe(false);

      // Toolchains & Pinned Versions
      expect(V1_SUPPORT_MATRIX.toolchain.node.pinned).toBe("22");
      expect(V1_SUPPORT_MATRIX.toolchain.node.minimum).toBe("22.0.0");
      expect(V1_SUPPORT_MATRIX.toolchain.node.range).toBe(">=22.0.0");
      expect(V1_SUPPORT_MATRIX.toolchain.pnpm.pinned).toBe("10.24.0");
      expect(V1_SUPPORT_MATRIX.toolchain.deno.pinned).toBe("2.9.5");
      expect(PINNED_NODE_VERSION).toBe("22");
      expect(PINNED_PNPM_VERSION).toBe("10.24.0");
      expect(PINNED_DENO_VERSION).toBe("2.9.5");

      // Platform Lanes
      expect(V1_SUPPORT_MATRIX.qualificationLanes).toEqual([
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "wsl",
      ]);
      expect(REQUIRED_QUALIFICATION_LANES).toEqual(V1_SUPPORT_MATRIX.qualificationLanes);
      expect(V1_SUPPORT_MATRIX.platforms).toHaveLength(5);

      // Qualified AI Coding Harnesses
      expect(V1_SUPPORT_MATRIX.harnesses["claude-code"].qualifiedVersions).toEqual([
        "0.2.14",
        "1.0.0",
      ]);
      expect(V1_SUPPORT_MATRIX.harnesses["codex-cli"].qualifiedVersions).toEqual(["0.45.0"]);
      expect(V1_SUPPORT_MATRIX.harnesses.omp.qualifiedVersions).toEqual(["0.12.5", "1.0.0"]);
      expect(V1_SUPPORT_MATRIX.harnesses["codex-cli"].transports).toEqual(["stdio", "sse"]);
      expect(V1_SUPPORT_MATRIX.harnesses.omp.transports).toEqual([
        "stdio",
        "sse",
        "websocket",
        "http",
      ]);

      // Shell & Package Manager Assumptions
      expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toEqual([
        "bash",
        "zsh",
        "sh",
      ]);
      expect(V1_SUPPORT_MATRIX.environmentAssumptions.packageManagers.pnpm.supported).toBe(true);
      expect(V1_SUPPORT_MATRIX.environmentAssumptions.packageManagers.pnpm.version).toBe("10.24.0");

      // Explicit Limitations
      expect(V1_SUPPORT_MATRIX.limitations.nativeWindows.supported).toBe(false);
      expect(V1_SUPPORT_MATRIX.limitations.nativeWindows.impliedByWsl2).toBe(false);
      expect(V1_SUPPORT_MATRIX.limitations.wsl1.supported).toBe(false);
      expect(V1_SUPPORT_MATRIX.limitations.nodeUnder22.supported).toBe(false);
      expect(V1_SUPPORT_MATRIX.limitations.unsupportedArchitectures.supported).toBe(false);

      // emitSupportMatrix helper
      const emittedJson = emitSupportMatrix({ format: "json" });
      expect(String(emittedJson) === emittedJson).toBe(true);
      const parsed = JSON.parse(emittedJson);
      expect(parsed.product.productName).toBe("Resin");
      expect(parsed.toolchain.deno.pinned).toBe("2.9.5");
      expect(emitSupportMatrix()).toBe(V1_SUPPORT_MATRIX);
    });
  });

  describe("Qualification Lanes Detection & Classification", () => {
    it("recognizes all 6 required qualification lanes", () => {
      expect(ALL_QUALIFICATION_LANES).toEqual([
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "wsl-systemd",
        "wsl-fallback",
      ]);
      expect(ALL_QUALIFICATION_LANES).toHaveLength(6);
    });

    it("correctly identifies Linux x64 lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "x64",
        env: { WSL_DISTRO_NAME: undefined },
        release: "6.8.0-generic",
      });

      expect(info.os).toBe("linux");
      expect(info.arch).toBe("x64");
      expect(info.isWsl).toBe(false);
      expect(getQualificationLane(info)).toBe("linux-x64");
      expect(getPlatformDisplayName(info)).toContain("Linux x86_64");
    });

    it("correctly identifies Linux arm64 lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "arm64",
        env: { WSL_DISTRO_NAME: undefined },
        release: "6.8.0-generic",
      });

      expect(info.os).toBe("linux");
      expect(info.arch).toBe("arm64");
      expect(info.isWsl).toBe(false);
      expect(getQualificationLane(info)).toBe("linux-arm64");
      expect(getPlatformDisplayName(info)).toContain("Linux aarch64");
    });

    it("correctly identifies macOS Intel (darwin-x64) lane", () => {
      const info = detectPlatform({
        platform: "darwin",
        arch: "x64",
        env: {},
        release: "24.0.0",
      });

      expect(info.os).toBe("darwin");
      expect(info.arch).toBe("x64");
      expect(info.isAppleSilicon).toBe(false);
      expect(getQualificationLane(info)).toBe("darwin-x64");
      expect(getPlatformDisplayName(info)).toContain("macOS Intel");
    });

    it("correctly identifies macOS Apple Silicon (darwin-arm64) lane", () => {
      const info = detectPlatform({
        platform: "darwin",
        arch: "arm64",
        env: {},
        release: "24.0.0",
      });

      expect(info.os).toBe("darwin");
      expect(info.arch).toBe("arm64");
      expect(info.isAppleSilicon).toBe(true);
      expect(getQualificationLane(info)).toBe("darwin-arm64");
      expect(getPlatformDisplayName(info)).toContain("macOS Apple Silicon");
    });

    it("correctly identifies WSL with systemd enabled lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "x64",
        env: {
          WSL_DISTRO_NAME: "Ubuntu-24.04",
          WSL_SYSTEMD: "1",
        },
        release: "5.15.153.1-microsoft-standard-WSL2",
      });

      expect(info.os).toBe("wsl");
      expect(info.isWsl).toBe(true);
      expect(info.hasSystemd).toBe(true);
      expect(getQualificationLane(info)).toBe("wsl-systemd");
      expect(getPlatformDisplayName(info)).toContain("systemd enabled");
    });

    it("correctly identifies WSL with fallback supervisor lane", () => {
      const info = detectPlatform({
        platform: "linux",
        arch: "x64",
        env: {
          WSL_DISTRO_NAME: "Debian",
          WSL_SYSTEMD: "0",
        },
        release: "5.15.153.1-microsoft-standard-WSL2",
        hasSystemdOverride: false,
      });

      expect(info.os).toBe("wsl");
      expect(info.isWsl).toBe(true);
      expect(info.hasSystemd).toBe(false);
      expect(getQualificationLane(info)).toBe("wsl-fallback");
      expect(getPlatformDisplayName(info)).toContain("fallback mode");
    });
  });

  describe("Platform Path Resolution & Standards Compliance", () => {
    it("resolves default canonical ~/.resin paths on macOS", () => {
      const customHome = "/Users/testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "darwin",
          isWsl: false,
          platform: "darwin",
          arch: "arm64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(paths.homeDir).toBe("/Users/testuser/.resin");
      expect(paths.configDir).toBe("/Users/testuser/.resin/config");
      expect(paths.dataDir).toBe("/Users/testuser/.resin/data");
      expect(paths.stateDir).toBe("/Users/testuser/.resin/state");
      expect(paths.logDir).toBe("/Users/testuser/.resin/logs");
      expect(paths.socketPath).toBe("/Users/testuser/.resin/state/daemon.sock");
      expect(paths.lockFilePath).toBe("/Users/testuser/.resin/state/daemon.lock");
      expect(paths.pidFilePath).toBe("/Users/testuser/.resin/state/daemon.pid");
      expect(paths.configFile).toBe("/Users/testuser/.resin/config/config.json");
    });

    it("resolves default canonical ~/.resin paths on Linux when XDG environment variables are unset", () => {
      const customHome = "/home/testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
        env: {},
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

    it("XDG environment variables alone do not displace canonical ~/.resin default paths", () => {
      const customHome = "/home/testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
        env: {
          XDG_CONFIG_HOME: "/home/testuser/.custom-config",
          XDG_DATA_HOME: "/home/testuser/.custom-share",
          XDG_STATE_HOME: "/home/testuser/.custom-state",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      });

      expect(paths.homeDir).toBe("/home/testuser/.resin");
      expect(paths.configDir).toBe("/home/testuser/.resin/config");
      expect(paths.dataDir).toBe("/home/testuser/.resin/data");
      expect(paths.stateDir).toBe("/home/testuser/.resin/state");
      expect(paths.logDir).toBe("/home/testuser/.resin/logs");
      expect(paths.socketPath).toBe("/home/testuser/.resin/state/daemon.sock");
      expect(paths.lockFilePath).toBe("/home/testuser/.resin/state/daemon.lock");
      expect(paths.pidFilePath).toBe("/home/testuser/.resin/state/daemon.pid");
    });

    it("relocates all paths under explicit resinHome option or RESIN_HOME", () => {
      const pathsFromOption = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "/opt/custom-resin",
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(pathsFromOption.homeDir).toBe("/opt/custom-resin");
      expect(pathsFromOption.configDir).toBe("/opt/custom-resin/config");
      expect(pathsFromOption.dataDir).toBe("/opt/custom-resin/data");
      expect(pathsFromOption.stateDir).toBe("/opt/custom-resin/state");
      expect(pathsFromOption.logDir).toBe("/opt/custom-resin/logs");
      expect(pathsFromOption.socketPath).toBe("/opt/custom-resin/state/daemon.sock");
      expect(pathsFromOption.lockFilePath).toBe("/opt/custom-resin/state/daemon.lock");
      expect(pathsFromOption.pidFilePath).toBe("/opt/custom-resin/state/daemon.pid");
      expect(pathsFromOption.configFile).toBe("/opt/custom-resin/config/config.json");

      const pathsFromEnv = resolvePlatformPaths({
        home: "/home/testuser",
        env: {
          RESIN_HOME: "/srv/resin-data",
        },
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(pathsFromEnv.homeDir).toBe("/srv/resin-data");
      expect(pathsFromEnv.configDir).toBe("/srv/resin-data/config");
      expect(pathsFromEnv.dataDir).toBe("/srv/resin-data/data");
      expect(pathsFromEnv.stateDir).toBe("/srv/resin-data/state");
      expect(pathsFromEnv.logDir).toBe("/srv/resin-data/logs");
      expect(pathsFromEnv.socketPath).toBe("/srv/resin-data/state/daemon.sock");
      expect(pathsFromEnv.lockFilePath).toBe("/srv/resin-data/state/daemon.lock");
      expect(pathsFromEnv.pidFilePath).toBe("/srv/resin-data/state/daemon.pid");
    });

    it("falls back to canonical ~/.resin paths when resinHome option or RESIN_HOME is empty or whitespace-only", () => {
      const platformInfo: PlatformInfo = {
        os: "linux",
        isWsl: false,
        platform: "linux",
        arch: "x64",
        nodeVersion: "v22.0.0",
      };

      // Empty string resinHome option falls back to ~/.resin instead of resolving to cwd
      const pathsEmptyOption = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "",
        platformInfo,
      });
      expect(pathsEmptyOption.homeDir).toBe("/home/testuser/.resin");
      expect(pathsEmptyOption.configDir).toBe("/home/testuser/.resin/config");
      expect(pathsEmptyOption.dataDir).toBe("/home/testuser/.resin/data");
      expect(pathsEmptyOption.stateDir).toBe("/home/testuser/.resin/state");
      expect(pathsEmptyOption.logDir).toBe("/home/testuser/.resin/logs");
      expect(pathsEmptyOption.socketPath).toBe("/home/testuser/.resin/state/daemon.sock");

      // Whitespace-only resinHome option falls back to ~/.resin
      const pathsWhitespaceOption = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "   \t\n  ",
        platformInfo,
      });
      expect(pathsWhitespaceOption.homeDir).toBe("/home/testuser/.resin");

      // Empty string RESIN_HOME env falls back to ~/.resin
      const pathsEmptyEnv = resolvePlatformPaths({
        home: "/home/testuser",
        env: {
          RESIN_HOME: "",
        },
        platformInfo,
      });
      expect(pathsEmptyEnv.homeDir).toBe("/home/testuser/.resin");

      // Whitespace-only RESIN_HOME env falls back to ~/.resin
      const pathsWhitespaceEnv = resolvePlatformPaths({
        home: "/home/testuser",
        env: {
          RESIN_HOME: "   ",
        },
        platformInfo,
      });
      expect(pathsWhitespaceEnv.homeDir).toBe("/home/testuser/.resin");

      // Both empty/whitespace fall back to ~/.resin
      const pathsBothEmpty = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "  ",
        env: {
          RESIN_HOME: "",
        },
        platformInfo,
      });
      expect(pathsBothEmpty.homeDir).toBe("/home/testuser/.resin");

      // Empty resinHome option falls back to non-empty RESIN_HOME env
      const pathsEmptyOptionWithEnv = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "  ",
        env: {
          RESIN_HOME: "/srv/resin-from-env",
        },
        platformInfo,
      });
      expect(pathsEmptyOptionWithEnv.homeDir).toBe("/srv/resin-from-env");
      expect(pathsEmptyOptionWithEnv.configDir).toBe("/srv/resin-from-env/config");

      // Non-empty resinHome option still overrides non-empty RESIN_HOME env
      const pathsNonEmptyOptionWithEnv = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "/opt/resin-from-opt",
        env: {
          RESIN_HOME: "/srv/resin-from-env",
        },
        platformInfo,
      });
      expect(pathsNonEmptyOptionWithEnv.homeDir).toBe("/opt/resin-from-opt");
      expect(pathsNonEmptyOptionWithEnv.configDir).toBe("/opt/resin-from-opt/config");

      // Empty options.home falls back to env.HOME
      const pathsEmptyHomeOption = resolvePlatformPaths({
        home: "  ",
        env: {
          HOME: "/home/envuser",
        },
        platformInfo,
      });
      expect(pathsEmptyHomeOption.homeDir).toBe("/home/envuser/.resin");
    });

    it("respects granular directory and socket overrides over canonical root", () => {
      const paths = resolvePlatformPaths({
        home: "/home/testuser",
        resinHome: "/opt/resin",
        configDir: "/etc/resin",
        dataDir: "/var/lib/resin",
        stateDir: "/run/resin",
        logDir: "/var/log/resin",
        socketPath: "/run/resin/custom.sock",
        configFile: "/etc/resin/override.json",
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(paths.homeDir).toBe("/opt/resin");
      expect(paths.configDir).toBe("/etc/resin");
      expect(paths.dataDir).toBe("/var/lib/resin");
      expect(paths.stateDir).toBe("/run/resin");
      expect(paths.logDir).toBe("/var/log/resin");
      expect(paths.socketPath).toBe("/run/resin/custom.sock");
      expect(paths.lockFilePath).toBe("/run/resin/daemon.lock");
      expect(paths.pidFilePath).toBe("/run/resin/daemon.pid");
      expect(paths.configFile).toBe("/etc/resin/override.json");

      const pathsEnv = resolvePlatformPaths({
        home: "/home/testuser",
        env: {
          RESIN_CONFIG_DIR: "/env/config",
          RESIN_DATA_DIR: "/env/data",
          RESIN_STATE_DIR: "/env/state",
          RESIN_LOG_DIR: "/env/logs",
          RESIN_SOCKET_PATH: "/env/socket.sock",
          RESIN_LOCK_FILE: "/env/lock.lck",
          RESIN_PID_FILE: "/env/pid.pid",
          RESIN_CONFIG_FILE: "/env/config.json",
        },
        platformInfo: {
          os: "linux",
          isWsl: false,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(pathsEnv.configDir).toBe("/env/config");
      expect(pathsEnv.dataDir).toBe("/env/data");
      expect(pathsEnv.stateDir).toBe("/env/state");
      expect(pathsEnv.logDir).toBe("/env/logs");
      expect(pathsEnv.socketPath).toBe("/env/socket.sock");
      expect(pathsEnv.lockFilePath).toBe("/env/lock.lck");
      expect(pathsEnv.pidFilePath).toBe("/env/pid.pid");
      expect(pathsEnv.configFile).toBe("/env/config.json");
    });

    it("resolves WSL paths with Windows host interop paths", () => {
      const customHome = "/home/wsluser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "wsl",
          isWsl: true,
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
        env: {
          USER: "WindowsUser",
        },
      });

      expect(paths.homeDir).toBe("/home/wsluser/.resin");
      expect(paths.stateDir).toBe("/home/wsluser/.resin/state");
      expect(paths.socketPath).toBe("/home/wsluser/.resin/state/daemon.sock");
      expect(paths.lockFilePath).toBe("/home/wsluser/.resin/state/daemon.lock");
      expect(paths.wslHostConfig).toBeDefined();
      expect(paths.wslHostConfig?.windowsAppDataDir).toBe(
        "/mnt/c/Users/WindowsUser/AppData/Roaming/Resin",
      );
      expect(paths.wslHostConfig?.windowsLocalAppDataDir).toBe(
        "/mnt/c/Users/WindowsUser/AppData/Local/Resin",
      );
      expect(paths.wslHostConfig?.windowsUserHome).toBe("/mnt/c/Users/WindowsUser");
    });

    it("resolves Windows native named pipe default socket", () => {
      const customHome = "C:\\Users\\testuser";
      const paths = resolvePlatformPaths({
        home: customHome,
        platformInfo: {
          os: "windows",
          isWsl: false,
          platform: "win32",
          arch: "x64",
          nodeVersion: "v22.0.0",
        },
      });

      expect(paths.socketPath).toBe("\\\\.\\pipe\\resin-daemon");
    });
  });

  describe("WSL & Windows Host Path Conversions", () => {
    it("converts Windows drive paths to WSL mount paths", () => {
      expect(resolveWindowsHostPath("C:\\Users\\Alice\\code")).toBe("/mnt/c/Users/Alice/code");
      expect(resolveWindowsHostPath("D:/Projects/app")).toBe("/mnt/d/Projects/app");
      expect(resolveWindowsHostPath("C:\\")).toBe("/mnt/c");
      expect(resolveWindowsHostPath("C:")).toBe("/mnt/c");
    });

    it("converts WSL mount paths to Windows drive paths", () => {
      expect(resolveWslToWindowsPath("/mnt/c/Users/Alice/code")).toBe("C:/Users/Alice/code");
      expect(resolveWslToWindowsPath("/mnt/d/Projects/app")).toBe("D:/Projects/app");
      expect(resolveWslToWindowsPath("/mnt/c")).toBe("C:");
    });

    it("accurately detects WSL host drive paths", () => {
      expect(isWslHostDrivePath("/mnt/c/Users/Bob")).toBe(true);
      expect(isWslHostDrivePath("/mnt/d/data")).toBe(true);
      expect(isWslHostDrivePath("/home/user/code")).toBe(false);
      expect(isWslHostDrivePath("/var/log")).toBe(false);
    });
  });

  describe("Path Canonicalization & Security Traversal Checks", () => {
    it("canonicalizes relative paths and verifies traversal safety", () => {
      const res = canonicalizePlatformPath("src/platform/paths.ts", { cwd: "/app" });
      expect(res.canonicalPath).toBe("/app/src/platform/paths.ts");
      expect(res.isTraversalSafe).toBe(true);
      expect(res.isWindowsDrive).toBe(false);
    });

    it("canonicalizes Windows paths in WSL format", () => {
      const res = canonicalizePlatformPath("C:\\Users\\Alice\\project", { cwd: "/app" });
      expect(res.canonicalPath).toBe("/mnt/c/Users/Alice/project");
      expect(res.isWindowsDrive).toBe(true);
      expect(res.isTraversalSafe).toBe(true);
    });

    it("rejects paths with null bytes as security violations", () => {
      expect(() => {
        canonicalizePlatformPath("/safe/path\0/malicious", { cwd: "/app" });
      }).toThrow(/null byte detected/i);
    });

    it("rejects empty paths", () => {
      expect(() => {
        canonicalizePlatformPath("", { cwd: "/app" });
      }).toThrow(/Cannot canonicalize empty path/i);
    });
  });

  describe("Platform Validation & Error Handling", () => {
    it("accepts valid Linux platforms", () => {
      const info = validatePlatform(
        detectPlatform({ platform: "linux", release: "6.8.0-generic", env: {} }),
      );
      expect(info.os).toBe("linux");
    });

    it("accepts valid macOS platforms", () => {
      const info = validatePlatform(
        detectPlatform({ platform: "darwin", arch: "arm64", env: {}, release: "24.0.0" }),
      );
      expect(info.os).toBe("darwin");
    });

    it("rejects native Windows with actionable WSL2 guidance", () => {
      expect(() => {
        validatePlatform(detectPlatform({ platform: "win32" }));
      }).toThrow(UnsupportedPlatformError);

      try {
        validatePlatform(detectPlatform({ platform: "win32" }));
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedPlatformError);
        if (err instanceof UnsupportedPlatformError) {
          expect(err.message).toContain("wsl --install");
          expect(err.platform).toBe("win32");
        }
      }
    });

    it("rejects unsupported OSes such as AIX or FreeBSD", () => {
      expect(() => {
        // SAFETY: Testing platform validation rejection for aix platform.
        validatePlatform(detectPlatform({ platform: "aix" as NodeJS.Platform }));
      }).toThrow(UnsupportedPlatformError);

      expect(() => {
        // SAFETY: Testing platform validation rejection for freebsd platform.
        validatePlatform(detectPlatform({ platform: "freebsd" as NodeJS.Platform }));
      }).toThrow(UnsupportedPlatformError);
    });
  });
});
