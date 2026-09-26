import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PI_RESIN_EXTENSION_FILE_NAME } from "./extension.js";

export const PI_HARNESS_ID = "pi";
export const PI_DISPLAY_NAME = "Pi";

/** Pi's own environment overrides (see `docs/environment-variables.md` in the Pi package). */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** `$PI_CODING_AGENT_DIR` (with `~` expanded) or `<home>/.pi/agent`, as Pi's `getAgentDir()`. */
export function resolvePiAgentDir(home: string, env: NodeJS.ProcessEnv): string {
  const configured = nonEmpty(env[PI_AGENT_DIR_ENV]);
  return configured ? path.resolve(expandHome(configured, home)) : path.join(home, ".pi", "agent");
}

/** The Resin bridge extension Pi auto-loads from `<agent-dir>/extensions/`. */
export function resolvePiExtensionPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolvePiAgentDir(home, env), "extensions", PI_RESIN_EXTENSION_FILE_NAME);
}

/**
 * Directory name Pi uses for a working directory under `<agent-dir>/sessions/`: the resolved cwd
 * without its leading separator, with `/`, `\`, and `:` replaced by `-`, wrapped in `--`.
 */
export function encodePiSessionDirName(cwd: string): string {
  return `--${path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

/** Reads the `sessionDir` setting from a Pi settings.json, or undefined when absent/unreadable. */
export function readPiSessionDirSetting(settingsPath: string): string | undefined {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && "sessionDir" in parsed) {
      return typeof parsed.sessionDir === "string" ? nonEmpty(parsed.sessionDir) : undefined;
    }
  } catch {
    // Pi itself refuses to start on invalid settings; nothing to discover from it.
  }
  return undefined;
}

export type PiSessionRootSource = "default" | "env" | "settings" | "project-settings" | "extra";

export interface PiSessionRoot {
  dir: string;
  source: PiSessionRootSource;
}

export interface ResolvePiSessionRootsOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Directories passed to Pi with `--session-dir`, which leave no trace Resin can read. */
  extraSessionDirs?: readonly string[];
  /** Workspace roots whose `.pi/settings.json` may set a project `sessionDir`. */
  workspaceRoots?: readonly string[];
}

/**
 * Every directory Pi may write session files to. Pi resolves one directory per run with
 * precedence `--session-dir` > `$PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting >
 * `<agent-dir>/sessions/--<cwd>--/`; runs with different settings coexist, so discovery scans
 * all of them. A relative global `sessionDir` resolves against each run's cwd and cannot be
 * enumerated without that cwd; it is resolved against the given workspace roots.
 */
export function resolvePiSessionRoots(options: ResolvePiSessionRootsOptions): PiSessionRoot[] {
  const { home, env } = options;
  const agentDir = resolvePiAgentDir(home, env);
  const roots: PiSessionRoot[] = [{ dir: path.join(agentDir, "sessions"), source: "default" }];
  const envDir = nonEmpty(env[PI_SESSION_DIR_ENV]);
  if (envDir) roots.push({ dir: path.resolve(expandHome(envDir, home)), source: "env" });

  const globalSetting = readPiSessionDirSetting(path.join(agentDir, "settings.json"));
  const workspaceRoots = options.workspaceRoots ?? [];
  if (globalSetting) {
    const expanded = expandHome(globalSetting, home);
    if (path.isAbsolute(expanded)) {
      roots.push({ dir: path.resolve(expanded), source: "settings" });
    } else {
      for (const root of workspaceRoots) {
        roots.push({ dir: path.resolve(root, expanded), source: "settings" });
      }
    }
  }
  for (const root of workspaceRoots) {
    const projectSetting = readPiSessionDirSetting(path.join(root, ".pi", "settings.json"));
    if (projectSetting) {
      roots.push({
        dir: path.resolve(root, expandHome(projectSetting, home)),
        source: "project-settings",
      });
    }
  }
  for (const dir of options.extraSessionDirs ?? []) {
    roots.push({ dir: path.resolve(expandHome(dir, home)), source: "extra" });
  }

  const seen = new Set<string>();
  return roots.filter((root) => {
    if (seen.has(root.dir)) return false;
    seen.add(root.dir);
    return true;
  });
}
