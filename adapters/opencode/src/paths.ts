import * as os from "node:os";
import * as path from "node:path";

/**
 * OpenCode resolves its directories through XDG base directories (`xdg-basedir`), falling
 * back to `~/.local/share`, `~/.config`, `~/.cache` on every platform.
 */
function xdg(home: string, env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value && path.isAbsolute(value) ? value : path.join(home, fallback);
}

export function resolveOpencodeDataDir(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(xdg(home, env, "XDG_DATA_HOME", path.join(".local", "share")), "opencode");
}

export function resolveOpencodeConfigDir(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(xdg(home, env, "XDG_CONFIG_HOME", ".config"), "opencode");
}

/**
 * SQLite store path. Mirrors OpenCode 1.2+: `OPENCODE_DB` (absolute, or relative to the data
 * dir) overrides; release channels (`latest`, `beta`, `prod`) use `opencode.db`. Other
 * channels use `opencode-<channel>.db`, which Resin does not guess.
 */
export function resolveOpencodeDbPath(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dataDir = resolveOpencodeDataDir(home, env);
  const override = env.OPENCODE_DB?.trim();
  if (override && override !== ":memory:") {
    return path.isAbsolute(override) ? override : path.join(dataDir, override);
  }
  return path.join(dataDir, "opencode.db");
}

/** Legacy (pre-1.2) JSON storage tree: `storage/{session,message,part}`. */
export function resolveOpencodeLegacyStorageDir(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOpencodeDataDir(home, env), "storage");
}

/**
 * Global config files OpenCode merges, in load order. Resin writes `opencode.json`; all
 * three are cleaned on uninstall.
 */
export const OPENCODE_GLOBAL_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"];

export function resolveOpencodeMcpConfigPath(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOpencodeConfigDir(home, env), "opencode.json");
}

/** Global instruction file OpenCode always loads (`<config>/AGENTS.md`). */
export function resolveOpencodeGuidancePath(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOpencodeConfigDir(home, env), "AGENTS.md");
}
