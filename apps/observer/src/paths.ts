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

function normalizeCandidate(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves all daemon-related paths according to canonical root precedence:
 * 1. Explicit `resinHome` option
 * 2. `RESIN_HOME` environment variable
 * 3. `<userHome>/.resin` canonical default
 *
 * Config/data/state/logs default beneath that canonical root:
 * - configDir: <resinHome>/config
 * - dataDir: <resinHome>/data
 * - stateDir: <resinHome>/state
 * - logDir: <resinHome>/logs
 * - socketPath: <stateDir>/daemon.sock (or named pipe on Windows)
 *
 * Granular options and RESIN_*_DIR / RESIN_SOCKET_PATH environment variables retain precedence.
 * XDG variables alone do not displace the canonical default.
 */
export function resolvePaths(options: PathResolutionOptions = {}): DaemonPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
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
    platform === "win32" ? "\\\\.\\pipe\\resin-daemon" : path.join(baseStateDir, "daemon.sock");

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
  const configFile = path.resolve(
    options.configFile ?? env.RESIN_CONFIG_FILE ?? path.join(configDir, "config.json"),
  );

  return {
    homeDir: baseHomeDir,
    configDir,
    dataDir,
    stateDir,
    logDir,
    socketPath,
    lockFilePath,
    pidFilePath,
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
