import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DaemonPaths {
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
}
export interface PathResolutionOptions {
  home?: string;
  resinHome?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  configDir?: string;
  dataDir?: string;
  stateDir?: string;
  logDir?: string;
  socketPath?: string;
  lockFilePath?: string;
  pidFilePath?: string;
  tokenFilePath?: string;
  configFile?: string;
}

/**
 * Detect whether the current runtime is running inside WSL (Windows Subsystem for Linux).
 */
export function isWsl(
  env: Record<string, string | undefined> = process.env,
  releaseOverride?: string,
): boolean {
  if (env.WSL_DISTRO_NAME || env.IS_WSL) {
    return true;
  }
  if (process.platform === "linux") {
    try {
      const release = (releaseOverride ?? os.release()).toLowerCase();
      if (release.includes("microsoft") || release.includes("wsl")) {
        return true;
      }
    } catch {
      // Ignore errors reading os release
    }
  }
  return false;
}

/**
 * Resolves all daemon-related paths according to platform standards and environment overrides.
 */
export function resolvePaths(options: PathResolutionOptions = {}): DaemonPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
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
  } else if (platform === "darwin") {
    baseHomeDir = path.join(userHome, ".resin");
    baseConfigDir = path.join(userHome, "Library", "Application Support", "resin");
    baseDataDir = path.join(userHome, "Library", "Application Support", "resin");
    baseStateDir = path.join(userHome, "Library", "Caches", "resin");
    baseLogDir = path.join(userHome, "Library", "Logs", "resin");
    defaultSocketPath = path.join(baseStateDir, "daemon.sock");
  } else if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(userHome, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? path.join(userHome, "AppData", "Local");
    baseHomeDir = path.join(userHome, ".resin");
    baseConfigDir = path.join(appData, "resin");
    baseDataDir = path.join(localAppData, "resin");
    baseStateDir = path.join(localAppData, "resin", "state");
    baseLogDir = path.join(localAppData, "resin", "logs");
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

  // Apply environment variable and options overrides
  const configDir = path.resolve(options.configDir ?? env.RESIN_CONFIG_DIR ?? baseConfigDir);
  const dataDir = path.resolve(options.dataDir ?? env.RESIN_DATA_DIR ?? baseDataDir);
  const stateDir = path.resolve(options.stateDir ?? env.RESIN_STATE_DIR ?? baseStateDir);
  const logDir = path.resolve(options.logDir ?? env.RESIN_LOG_DIR ?? baseLogDir);

  let socketPath = options.socketPath ?? env.RESIN_SOCKET_PATH ?? defaultSocketPath;
  // If not a Windows named pipe, resolve to absolute path
  if (platform !== "win32" || !socketPath.startsWith("\\\\.\\pipe\\")) {
    socketPath = path.resolve(socketPath);
  }

  const lockFilePath = path.resolve(
    options.lockFilePath ?? env.RESIN_LOCK_FILE ?? path.join(stateDir, "daemon.lock"),
  );
  const pidFilePath = path.resolve(
    options.pidFilePath ?? env.RESIN_PID_FILE ?? path.join(stateDir, "daemon.pid"),
  );
  const tokenFilePath = path.resolve(
    options.tokenFilePath ?? env.RESIN_TOKEN_FILE ?? path.join(stateDir, "auth.token"),
  );
  const configFile = path.resolve(
    options.configFile ?? env.RESIN_CONFIG_FILE ?? path.join(configDir, "config.json"),
  );

  return {
    homeDir: path.resolve(baseHomeDir),
    configDir,
    dataDir,
    stateDir,
    logDir,
    socketPath,
    lockFilePath,
    pidFilePath,
    tokenFilePath,
    configFile,
  };
}

export function getDaemonPaths(options?: PathResolutionOptions): DaemonPaths {
  return resolvePaths(options);
}

/**
 * Asynchronously ensures all required daemon directories exist.
 */
export async function ensureDaemonDirectories(paths: DaemonPaths): Promise<void> {
  const dirs = [paths.homeDir, paths.configDir, paths.dataDir, paths.stateDir, paths.logDir];
  for (const dir of dirs) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Ensure socket directory exists if socket path is a filesystem path
  if (!paths.socketPath.startsWith("\\\\.\\pipe\\")) {
    const socketDir = path.dirname(paths.socketPath);
    await fs.promises.mkdir(socketDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Synchronously ensures all required daemon directories exist.
 */
export function ensureDaemonDirectoriesSync(paths: DaemonPaths): void {
  const dirs = [paths.homeDir, paths.configDir, paths.dataDir, paths.stateDir, paths.logDir];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (!paths.socketPath.startsWith("\\\\.\\pipe\\")) {
    const socketDir = path.dirname(paths.socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
}
