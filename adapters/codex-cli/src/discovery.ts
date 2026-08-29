import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { HarnessInstallation, ProbeInstallationOptions } from "@resin/harness-contracts";

const execFileAsync = promisify(execFile);

export const CODEX_HARNESS_ID = "codex-cli";
export const CODEX_DISPLAY_NAME = "Codex CLI";
export const CODEX_MIN_SUPPORTED_VERSION = "0.1.0";

/**
 * Resolved paths for Codex CLI configuration and session directories.
 */
export interface CodexResolvedPaths {
  homeDir: string;
  configPath: string;
  sessionRoot: string;
  configFormat: "toml" | "json";
}

/**
 * Platform execution helper type for testability.
 */
export type CommandExecutor = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Path lookup helper type for testability.
 */
export type PathLookupFn = (binName: string) => Promise<string | null>;

/**
 * Candidate binary names for Codex CLI depending on OS.
 */
export function getCandidateBinaryNames(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      "codex.exe",
      "codex.cmd",
      "codex.bat",
      "codex-cli.exe",
      "codex-cli.cmd",
      "codex-cli.bat",
      "codex",
    ];
  }
  return ["codex", "codex-cli"];
}

/**
 * Checks if a file exists and is accessible.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Standard PATH lookup for a binary name.
 */
export async function defaultPathLookup(
  binName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const pathEnv = env.PATH || env.Path || "";
  const delimiter = platform === "win32" ? ";" : ":";
  const searchDirs = pathEnv.split(delimiter).filter(Boolean);

  // Also check standard user bin locations
  const home = env.CODEX_HOME || env.HOME || env.USERPROFILE || os.homedir();
  if (home) {
    searchDirs.push(
      path.join(home, ".codex", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
    );
  }

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, binName);
    if (await fileExists(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

/**
 * Finds the Codex CLI executable on the host system.
 */
export async function findCodexExecutable(options?: {
  customExecutablePath?: string;
  executablePath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathLookup?: PathLookupFn;
}): Promise<string | null> {
  const explicitPath = options?.executablePath ?? options?.customExecutablePath;
  if (explicitPath) {
    if (await fileExists(explicitPath)) {
      return path.resolve(explicitPath);
    }
    return null;
  }

  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const lookup = options?.pathLookup ?? ((bin) => defaultPathLookup(bin, env, platform));
  const candidateNames = getCandidateBinaryNames(platform);

  for (const candidate of candidateNames) {
    const resolved = await lookup(candidate);
    if (resolved) {
      return path.resolve(resolved);
    }
  }

  return null;
}

/**
 * Extracts a SemVer version string from raw command output.
 */
export function extractSemver(output: string): string | null {
  const semverRegex =
    /(?:(?:codex(?:-cli)?|version|v)?\s*)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i;
  const match = output.match(semverRegex);
  return match?.[1] ? match[1] : null;
}

/**
 * Compares two semver strings (returns >0 if v1 > v2, <0 if v1 < v2, 0 if equal).
 */
export function compareSemver(v1: string, v2: string): number {
  const clean1 = v1.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const clean2 = v2.replace(/^v/, "").split("-")[0]!.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const n1 = clean1[i] ?? 0;
    const n2 = clean2[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/**
 * Default command execution function using child_process.execFile.
 */
export const defaultCommandExecutor: CommandExecutor = async (file: string, args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: 5000,
      encoding: "utf8",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    // SAFETY: Node child_process execFile error objects contain stdout, stderr, code, and message properties.
    const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(err),
      exitCode: error.code ?? 1,
    };
  }
};

/**
 * Probes the Codex CLI binary to discover its version.
 */
export async function probeCodexVersion(
  executablePath: string,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<{ version: string | null; rawOutput: string }> {
  for (const flag of ["--version", "-V", "version"]) {
    const result = await executor(executablePath, [flag]);
    if (result.exitCode === 0 && (result.stdout.trim() || result.stderr.trim())) {
      const combined = `${result.stdout} ${result.stderr}`.trim();
      const version = extractSemver(combined);
      if (version) {
        return { version, rawOutput: combined };
      }
    }
  }

  return { version: null, rawOutput: "" };
}

/**
 * Resolves configuration and session root directories for Codex CLI.
 */
export async function resolveCodexPaths(options?: {
  customConfigPath?: string;
  customSessionRoot?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexResolvedPaths> {
  const env = options?.env ?? process.env;
  const home =
    env.CODEX_HOME ||
    options?.homeDir ||
    (env.HOME || env.USERPROFILE
      ? path.join(env.HOME || env.USERPROFILE!, ".codex")
      : os.homedir());

  let configPath: string;
  let configFormat: "toml" | "json" = "toml";

  if (options?.customConfigPath) {
    configPath = path.resolve(options.customConfigPath);
    configFormat = configPath.endsWith(".json") ? "json" : "toml";
  } else if (env.CODEX_CONFIG_PATH) {
    configPath = path.resolve(env.CODEX_CONFIG_PATH);
    configFormat = configPath.endsWith(".json") ? "json" : "toml";
  } else {
    const tomlPath = path.join(home, "config.toml");
    const jsonPath = path.join(home, "config.json");
    const mcpJsonPath = path.join(home, "mcp.json");

    if (await fileExists(tomlPath)) {
      configPath = tomlPath;
      configFormat = "toml";
    } else if (await fileExists(jsonPath)) {
      configPath = jsonPath;
      configFormat = "json";
    } else if (await fileExists(mcpJsonPath)) {
      configPath = mcpJsonPath;
      configFormat = "json";
    } else {
      configPath = tomlPath;
      configFormat = "toml";
    }
  }

  let sessionRoot: string;
  if (options?.customSessionRoot) {
    sessionRoot = path.resolve(options.customSessionRoot);
  } else if (env.CODEX_SESSIONS_DIR) {
    sessionRoot = path.resolve(env.CODEX_SESSIONS_DIR);
  } else {
    const defaultSessions = path.join(home, "sessions");
    const rollouts = path.join(home, "rollouts");
    const history = path.join(home, "history");

    if (await fileExists(defaultSessions)) {
      sessionRoot = defaultSessions;
    } else if (await fileExists(rollouts)) {
      sessionRoot = rollouts;
    } else if (await fileExists(history)) {
      sessionRoot = history;
    } else {
      sessionRoot = defaultSessions;
    }
  }

  return {
    homeDir: home,
    configPath,
    sessionRoot,
    configFormat,
  };
}

/**
 * Options for probing Codex CLI installation.
 */
export interface CodexProbeOptions extends ProbeInstallationOptions {
  platform?: NodeJS.Platform;
  executor?: CommandExecutor;
  pathLookup?: PathLookupFn;
  minSupportedVersion?: string;
  customExecutablePath?: string;
  customConfigPath?: string;
  checkPermissions?: boolean;
}

/**
 * Probes the workstation environment for an installed Codex CLI harness.
 */
export async function probeCodexInstallation(
  options?: CodexProbeOptions,
): Promise<HarnessInstallation> {
  const detectedAt = new Date().toISOString();
  const minVersion = options?.minSupportedVersion ?? CODEX_MIN_SUPPORTED_VERSION;

  const resolvedPaths = await resolveCodexPaths({
    customConfigPath: options?.customConfigPath,
    env: options?.env,
  });

  const executablePath = await findCodexExecutable({
    executablePath: options?.executablePath,
    customExecutablePath: options?.customExecutablePath,
    platform: options?.platform,
    env: options?.env,
    pathLookup: options?.pathLookup,
  });

  if (!executablePath) {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: CODEX_DISPLAY_NAME,
      version: "0.0.0",
      isInstalled: false,
      status: "missing_executable",
      executablePath: undefined,
      configPath: resolvedPaths.configPath,
      homePath: resolvedPaths.homeDir,
      detectedAt,
      metadata: {
        searchedCustomPath: options?.customExecutablePath,
        homeDir: resolvedPaths.homeDir,
        sessionRoot: resolvedPaths.sessionRoot,
        configFormat: resolvedPaths.configFormat,
        diagnostics: [
          {
            code: "MISSING_EXECUTABLE",
            severity: "error",
            message: "Codex CLI executable ('codex' or 'codex-cli') not found on system PATH.",
            path: options?.customExecutablePath,
            timestamp: detectedAt,
          },
        ],
      },
    };
  }

  const { version, rawOutput } = await probeCodexVersion(
    executablePath,
    options?.executor ?? defaultCommandExecutor,
  );

  if (!version) {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: CODEX_DISPLAY_NAME,
      version: "0.0.0",
      isInstalled: true,
      status: "corrupt",
      executablePath,
      configPath: resolvedPaths.configPath,
      homePath: resolvedPaths.homeDir,
      detectedAt,
      metadata: {
        rawOutput,
        homeDir: resolvedPaths.homeDir,
        sessionRoot: resolvedPaths.sessionRoot,
        configFormat: resolvedPaths.configFormat,
        diagnostics: [
          {
            code: "VERSION_PROBE_FAILED",
            severity: "error",
            message: `Failed to detect version from Codex CLI executable at ${executablePath}. Output: ${rawOutput}`,
            path: executablePath,
            timestamp: detectedAt,
          },
        ],
      },
    };
  }

  if (compareSemver(version, minVersion) < 0) {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: CODEX_DISPLAY_NAME,
      version,
      isInstalled: true,
      status: "unsupported_version",
      executablePath,
      configPath: resolvedPaths.configPath,
      homePath: resolvedPaths.homeDir,
      detectedAt,
      metadata: {
        detectedVersion: version,
        minSupportedVersion: minVersion,
        homeDir: resolvedPaths.homeDir,
        sessionRoot: resolvedPaths.sessionRoot,
        configFormat: resolvedPaths.configFormat,
        diagnostics: [
          {
            code: "UNSUPPORTED_VERSION",
            severity: "error",
            message: `Detected Codex CLI version ${version} is lower than minimum supported version ${minVersion}.`,
            path: executablePath,
            timestamp: detectedAt,
          },
        ],
      },
    };
  }

  if (options?.checkPermissions) {
    try {
      const configDir = path.dirname(resolvedPaths.configPath);
      await fs.mkdir(configDir, { recursive: true });
      await fs.access(configDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        harnessId: CODEX_HARNESS_ID,
        displayName: CODEX_DISPLAY_NAME,
        version,
        isInstalled: true,
        status: "config_error",
        executablePath,
        configPath: resolvedPaths.configPath,
        homePath: resolvedPaths.homeDir,
        detectedAt,
        metadata: {
          permissionError: errorMsg,
          homeDir: resolvedPaths.homeDir,
          sessionRoot: resolvedPaths.sessionRoot,
          configFormat: resolvedPaths.configFormat,
          diagnostics: [
            {
              code: "CONFIG_PERMISSION_DENIED",
              severity: "error",
              message: `Cannot read/write Codex configuration directory: ${errorMsg}`,
              path: resolvedPaths.configPath,
              timestamp: detectedAt,
            },
          ],
        },
      };
    }
  }

  return {
    harnessId: CODEX_HARNESS_ID,
    displayName: CODEX_DISPLAY_NAME,
    version,
    isInstalled: true,
    status: "ready",
    executablePath,
    configPath: resolvedPaths.configPath,
    homePath: resolvedPaths.homeDir,
    detectedAt,
    metadata: {
      homeDir: resolvedPaths.homeDir,
      sessionRoot: resolvedPaths.sessionRoot,
      configFormat: resolvedPaths.configFormat,
      diagnostics: [],
    },
  };
}
