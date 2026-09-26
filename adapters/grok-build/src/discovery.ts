import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HarnessInstallation } from "@resin/harness-contracts";
import { UNKNOWN_HARNESS_VERSION } from "@resin/harness-contracts";
import { GROK_DISPLAY_NAME, GROK_HARNESS_ID, resolveGrokHome } from "./paths.js";

/** Exact `grok` versions qualified with the recorded fixtures under `tests/fixtures/recorded/`. */
export const GROK_TESTED_VERSIONS: readonly string[] = Object.freeze(["1.0.13"]);

export type GrokVersionReader = (executablePath: string) => Promise<string | null>;

/** `grok --version` prints `grok 1.0.13 (5e9a58528b76) [stable]`. */
export function parseGrokVersion(output: string): string | null {
  return /\bgrok\s+v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1] ?? null;
}

/**
 * Reads the version from the installed binary's file name: the installer keeps each release as
 * `<GROK_HOME>/bin/grok-<version>` and points `grok` at it. The binary is never run, so probing
 * stays cheap and side-effect free.
 */
export const readGrokVersion: GrokVersionReader = async (executablePath) => {
  const target = await fs.realpath(executablePath).catch(() => executablePath);
  return /^grok-v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)$/.exec(path.basename(target))?.[1] ?? null;
};

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the `grok` binary: the installer's `<GROK_HOME>/bin/grok` first, then `PATH`.
 * (The legacy `~/.grok/bin/agent` binary is a different tool and is ignored.)
 */
export async function findGrokExecutable(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const candidates = [path.join(resolveGrokHome(home, env), "bin", "grok")];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "grok"));
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface ProbeGrokOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  readVersion?: GrokVersionReader;
}

export async function probeGrokInstallation(
  options: ProbeGrokOptions,
): Promise<HarnessInstallation | null> {
  const executablePath = await findGrokExecutable(options.home, options.env);
  const grokHome = resolveGrokHome(options.home, options.env);
  const homeExists = await fs
    .stat(grokHome)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!executablePath && !homeExists) return null;
  const version = executablePath
    ? await (options.readVersion ?? readGrokVersion)(executablePath)
    : null;
  return {
    harnessId: GROK_HARNESS_ID,
    displayName: GROK_DISPLAY_NAME,
    version: version ?? UNKNOWN_HARNESS_VERSION,
    ...(executablePath ? { executablePath } : {}),
    configPath: options.configPath,
    homePath: grokHome,
    isInstalled: executablePath !== null,
    status: executablePath ? "ready" : "missing_executable",
    detectedAt: new Date().toISOString(),
    metadata: {},
  };
}
