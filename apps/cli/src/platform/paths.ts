import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type PlatformInfo, detectPlatform } from "./platform.js";

/**
 * Standard paths for Resin runtime, state, logs, sockets, and configuration.
 */
export interface PlatformPaths {
  readonly platform: PlatformInfo;
  readonly homeDir: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly socketPath: string;
  readonly lockFilePath: string;
  readonly pidFilePath: string;
  readonly tokenFilePath: string;
  readonly configFile: string;
  readonly artifactsDir: string;
  readonly versionsDir: string;
  readonly currentVersionLink: string;
  readonly rollbackDir: string;
  readonly wslHostConfig?: {
    readonly windowsAppDataDir?: string;
    readonly windowsLocalAppDataDir?: string;
    readonly windowsUserHome?: string;
    readonly isHostDrivePath: boolean;
  };
}

export interface PlatformPathOptions {
  platformInfo?: PlatformInfo;
  home?: string;
  resinHome?: string;
  configDir?: string;
  dataDir?: string;
  stateDir?: string;
  logDir?: string;
  socketPath?: string;
  configFile?: string;
  env?: Record<string, string | undefined>;
  wslMountRoot?: string;
}

/**
 * Resolves a Windows-style path (e.g. C:\Users\Alice\foo or C:/Users/Alice) into a WSL path (/mnt/c/Users/Alice/foo).
 */
export function resolveWindowsHostPath(windowsPath: string, wslMountRoot = "/mnt"): string {
  if (!windowsPath) return "";
  const cleaned = windowsPath.replace(/\\/g, "/");
  const driveMatch = cleaned.match(/^([a-zA-Z]):(?:\/(.*))?$/);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase();
    const subPath = driveMatch[2] ? `/${driveMatch[2]}` : "";
    return `${wslMountRoot}/${driveLetter}${subPath}`;
  }
  return windowsPath;
}

/**
 * Converts a WSL path under /mnt/<drive>/... to a Windows-style path (e.g. C:/...).
 */
export function resolveWslToWindowsPath(wslPath: string, wslMountRoot = "/mnt"): string {
  if (!wslPath) return "";
  const normalized = wslPath.replace(/\\/g, "/");
  const pattern = new RegExp(
    `^${wslMountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-zA-Z])(?:/(.*))?$`,
  );
  const match = normalized.match(pattern);
  if (match) {
    const driveLetter = match[1].toUpperCase();
    const rest = match[2] ? `/${match[2]}` : "";
    return `${driveLetter}:${rest}`;
  }
  return wslPath;
}

/**
 * Checks if a given path is located on a Windows host drive under WSL (/mnt/[a-z]/...).
 */
export function isWslHostDrivePath(testPath: string, wslMountRoot = "/mnt"): boolean {
  if (!testPath) return false;
  const normalized = testPath.replace(/\\/g, "/");
  const pattern = new RegExp(
    `^${wslMountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-zA-Z](?:/.*)?$`,
  );
  return pattern.test(normalized);
}

/**
 * Canonicalizes a path securely across platforms, normalizing separators, relative segments,
 * checking against path traversal attacks, and normalizing WSL drive mount syntax.
 */
export function canonicalizePlatformPath(
  rawPath: string,
  options: {
    cwd?: string;
    allowNonExistent?: boolean;
    wslMountRoot?: string;
  } = {},
): { canonicalPath: string; isWindowsDrive: boolean; isTraversalSafe: boolean } {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new Error("Cannot canonicalize empty path.");
  }

  const wslMountRoot = options.wslMountRoot ?? "/mnt";
  let normalized = rawPath.replace(/\\/g, "/");

  // Check for suspicious null bytes
  if (normalized.includes("\0")) {
    throw new Error(`Security violation: null byte detected in path: ${rawPath}`);
  }

  // Canonicalize WSL drive path if present
  let isWindowsDrive = false;
  if (isWslHostDrivePath(normalized, wslMountRoot)) {
    isWindowsDrive = true;
  } else {
    const winDriveMatch = normalized.match(/^([a-zA-Z]):(?:\/(.*))?$/);
    if (winDriveMatch) {
      isWindowsDrive = true;
      normalized = resolveWindowsHostPath(normalized, wslMountRoot);
    }
  }

  const baseCwd = options.cwd ?? process.cwd();
  const absolutePath = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.normalize(path.resolve(baseCwd, normalized));

  // Verify traversal safety: ensuring no trailing unresolved traversal segments
  const segments = absolutePath.split("/").filter(Boolean);
  const isTraversalSafe = !segments.includes("..");

  return {
    canonicalPath: absolutePath,
    isWindowsDrive,
    isTraversalSafe,
  };
}

/**
 * Resolves platform paths according to OS and WSL conventions:
 * - macOS: ~/Library/Application Support/Resin, ~/Library/Caches/resin, ~/Library/Logs/resin
 * - Linux: ~/.local/share/resin, ~/.config/resin, ~/.local/state/resin
 * - WSL: XDG base directories within Linux guest + Windows host interop paths (/mnt/c/...)
 */
export function resolvePlatformPaths(options: PlatformPathOptions = {}): PlatformPaths {
  const env = options.env ?? process.env;
  const platform = options.platformInfo ?? detectPlatform({ env });
  const userHome = options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const explicitHome = options.resinHome ?? env.RESIN_HOME;

  let baseHomeDir: string;
  let baseConfigDir: string;
  let baseDataDir: string;
  let baseStateDir: string;
  let baseLogDir: string;
  let defaultSocketPath: string;

  if (explicitHome) {
    baseHomeDir = path.resolve(explicitHome);
    baseConfigDir = path.join(baseHomeDir, "config");
    baseDataDir = path.join(baseHomeDir, "data");
    baseStateDir = path.join(baseHomeDir, "state");
    baseLogDir = path.join(baseHomeDir, "logs");
    defaultSocketPath = path.join(baseStateDir, "daemon.sock");
  } else if (platform.os === "darwin") {
    // macOS Platform Standards
    baseHomeDir = path.join(userHome, ".resin");
    // Standard macOS Library locations (supporting Resin and resin)
    baseConfigDir = path.join(userHome, "Library", "Application Support", "Resin");
    baseDataDir = path.join(userHome, "Library", "Application Support", "Resin");
    baseStateDir = path.join(userHome, "Library", "Caches", "resin");
    baseLogDir = path.join(userHome, "Library", "Logs", "resin");
    defaultSocketPath = path.join(baseStateDir, "daemon.sock");
  } else if (platform.platform === "win32") {
    // Native Windows (if inspected)
    const appData = env.APPDATA ?? path.join(userHome, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? path.join(userHome, "AppData", "Local");
    baseHomeDir = path.join(userHome, ".resin");
    baseConfigDir = path.join(appData, "Resin");
    baseDataDir = path.join(localAppData, "Resin");
    baseStateDir = path.join(localAppData, "Resin", "state");
    baseLogDir = path.join(localAppData, "Resin", "logs");
    defaultSocketPath = "\\\\.\\pipe\\resin-daemon";
  } else {
    // Linux and WSL (XDG Base Directory Specification)
    const xdgConfig = env.XDG_CONFIG_HOME;
    const xdgData = env.XDG_DATA_HOME;
    const xdgState = env.XDG_STATE_HOME;
    const xdgRuntime = env.XDG_RUNTIME_DIR;

    baseHomeDir = path.join(userHome, ".resin");
    baseConfigDir = xdgConfig
      ? path.join(xdgConfig, "resin")
      : path.join(userHome, ".config", "resin");
    baseDataDir = xdgData
      ? path.join(xdgData, "resin")
      : path.join(userHome, ".local", "share", "resin");
    baseStateDir = xdgState
      ? path.join(xdgState, "resin")
      : path.join(userHome, ".local", "state", "resin");
    baseLogDir = path.join(baseStateDir, "logs");

    if (xdgRuntime) {
      defaultSocketPath = path.join(xdgRuntime, "resin.sock");
    } else {
      defaultSocketPath = path.join(baseStateDir, "daemon.sock");
    }
  }

  // Apply overrides if supplied
  const homeDir = baseHomeDir;
  const configDir = path.resolve(options.configDir ?? env.RESIN_CONFIG_DIR ?? baseConfigDir);
  const dataDir = path.resolve(options.dataDir ?? env.RESIN_DATA_DIR ?? baseDataDir);
  const stateDir = path.resolve(options.stateDir ?? env.RESIN_STATE_DIR ?? baseStateDir);
  const logDir = path.resolve(options.logDir ?? env.RESIN_LOG_DIR ?? baseLogDir);
  const socketPath = path.resolve(options.socketPath ?? env.RESIN_SOCKET_PATH ?? defaultSocketPath);

  const lockFilePath = path.join(stateDir, "daemon.lock");
  const pidFilePath = path.join(stateDir, "daemon.pid");
  const tokenFilePath = path.join(stateDir, "daemon.token");
  const configFile = options.configFile ?? path.join(configDir, "config.json");
  const artifactsDir = path.join(dataDir, "artifacts");
  const versionsDir = path.join(homeDir, "versions");
  const currentVersionLink = path.join(homeDir, "current");
  const rollbackDir = path.join(dataDir, "backups");

  // WSL Host interop resolution
  let wslHostConfig: PlatformPaths["wslHostConfig"];
  if (platform.isWsl) {
    const winUser = env.USER ?? env.USERNAME ?? "User";
    const mntRoot = options.wslMountRoot ?? "/mnt";
    wslHostConfig = {
      windowsAppDataDir: `${mntRoot}/c/Users/${winUser}/AppData/Roaming/Resin`,
      windowsLocalAppDataDir: `${mntRoot}/c/Users/${winUser}/AppData/Local/Resin`,
      windowsUserHome: `${mntRoot}/c/Users/${winUser}`,
      isHostDrivePath: isWslHostDrivePath(homeDir, mntRoot),
    };
  }

  return {
    platform,
    homeDir,
    configDir,
    dataDir,
    stateDir,
    logDir,
    socketPath,
    lockFilePath,
    pidFilePath,
    tokenFilePath,
    configFile,
    artifactsDir,
    versionsDir,
    currentVersionLink,
    rollbackDir,
    wslHostConfig,
  };
}
