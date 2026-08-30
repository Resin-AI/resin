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
export interface CanonicalizedPlatformPath {
  canonicalPath: string;
  isWindowsDrive: boolean;
  isTraversalSafe: boolean;
}

export function canonicalizePlatformPath(
  rawPath: string,
  options: {
    cwd?: string;
    allowNonExistent?: boolean;
    wslMountRoot?: string;
  } = {},
): CanonicalizedPlatformPath {
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
function normalizeCandidate(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves platform paths for the Resin standalone runtime and CLI:
 * - Canonical root precedence: explicit resinHome option -> env.RESIN_HOME -> <userHome>/.resin
 * - Subdirectories default beneath that canonical root:
 *   - configDir: <resinHome>/config
 *   - dataDir: <resinHome>/data
 *   - stateDir: <resinHome>/state
 *   - logDir: <resinHome>/logs
 *   - socketPath: <stateDir>/daemon.sock (or named pipe on Windows)
 * - Granular directory/socket environment variables and options retain precedence.
 * - XDG variables alone do not displace the canonical default.
 * - WSL: Windows host interop paths (/mnt/c/...)
 */
export function resolvePlatformPaths(options: PlatformPathOptions = {}): PlatformPaths {
  const env = options.env ?? process.env;
  const platform = options.platformInfo ?? detectPlatform({ env });
  const userHome =
    normalizeCandidate(options.home) ??
    normalizeCandidate(env.HOME) ??
    normalizeCandidate(env.USERPROFILE) ??
    os.homedir();
  const explicitHome = normalizeCandidate(options.resinHome) ?? normalizeCandidate(env.RESIN_HOME);

  const baseHomeDir = path.resolve(explicitHome ?? path.join(userHome, ".resin"));
  const baseConfigDir = path.join(baseHomeDir, "config");
  const baseDataDir = path.join(baseHomeDir, "data");
  const baseStateDir = path.join(baseHomeDir, "state");
  const baseLogDir = path.join(baseHomeDir, "logs");

  const defaultSocketPath =
    platform.platform === "win32"
      ? "\\\\.\\pipe\\resin-daemon"
      : path.join(baseStateDir, "daemon.sock");

  // Apply overrides if supplied
  const homeDir = baseHomeDir;
  const configDir = path.resolve(
    normalizeCandidate(options.configDir) ??
      normalizeCandidate(env.RESIN_CONFIG_DIR) ??
      baseConfigDir,
  );
  const dataDir = path.resolve(
    normalizeCandidate(options.dataDir) ?? normalizeCandidate(env.RESIN_DATA_DIR) ?? baseDataDir,
  );
  const stateDir = path.resolve(
    normalizeCandidate(options.stateDir) ?? normalizeCandidate(env.RESIN_STATE_DIR) ?? baseStateDir,
  );
  const logDir = path.resolve(
    normalizeCandidate(options.logDir) ?? normalizeCandidate(env.RESIN_LOG_DIR) ?? baseLogDir,
  );

  let socketPath =
    normalizeCandidate(options.socketPath) ??
    normalizeCandidate(env.RESIN_SOCKET_PATH) ??
    defaultSocketPath;
  if (platform.platform !== "win32" || !socketPath.startsWith("\\\\.\\pipe\\")) {
    socketPath = path.resolve(socketPath);
  }

  const lockFilePath = path.resolve(
    normalizeCandidate(env.RESIN_LOCK_FILE) ?? path.join(stateDir, "daemon.lock"),
  );
  const pidFilePath = path.resolve(
    normalizeCandidate(env.RESIN_PID_FILE) ?? path.join(stateDir, "daemon.pid"),
  );
  const configFile = path.resolve(
    normalizeCandidate(options.configFile) ??
      normalizeCandidate(env.RESIN_CONFIG_FILE) ??
      path.join(configDir, "config.json"),
  );
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
    configFile,
    artifactsDir,
    versionsDir,
    currentVersionLink,
    rollbackDir,
    wslHostConfig,
  };
}
