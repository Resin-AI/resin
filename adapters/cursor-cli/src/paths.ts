import path from "node:path";

export const CURSOR_HARNESS_ID = "cursor-cli" as const;

/**
 * The cursor-agent build this adapter's hook contract was read from (bundle inspection),
 * normalized to semver: `cursor-agent --version` prints `2026.09.26-dd393fe`.
 */
export const CURSOR_TARGET_VERSION = "2026.9.26-dd393fe";

/**
 * Versions qualified with recorded fixtures (normalized, see {@link normalizeCursorVersion}).
 * Empty until a logged-in capture of {@link CURSOR_TARGET_VERSION} is recorded under
 * `tests/fixtures/recorded/`; until then every install reports `untested`.
 */
export const CURSOR_TESTED_VERSIONS: readonly string[] = [];

/**
 * Cursor's per-user directory. cursor-agent 2026.09.26 hard-codes `os.homedir()/.cursor` for
 * `mcp.json`, `hooks.json`, `rules/` and `projects/` (CURSOR_CONFIG_DIR only moves
 * `cli-config.json`), so no environment override applies here.
 */
export function resolveCursorHome(home: string): string {
  return path.join(path.resolve(home), ".cursor");
}

/** User-level MCP config read by cursor-agent for every project. */
export function resolveCursorMcpConfigPath(home: string): string {
  return path.join(resolveCursorHome(home), "mcp.json");
}

/** User-level hooks config (`{ version: 1, hooks: { <event>: [{ command }] } }`). */
export function resolveCursorHooksPath(home: string): string {
  return path.join(resolveCursorHome(home), "hooks.json");
}

/** Cursor's lossy per-project transcripts: `projects/<slug>/agent-transcripts/`. */
export function resolveCursorProjectsDir(home: string): string {
  return path.join(resolveCursorHome(home), "projects");
}

/** Resin's user store. */
export function resolveResinHome(home: string, env: NodeJS.ProcessEnv = {}): string {
  const configured = env.RESIN_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(path.resolve(home), ".resin");
}

/** The capture hook script Resin installs; Cursor runs it for every registered hook event. */
export function resolveCursorHookScriptPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveResinHome(home, env), "hooks", "cursor-capture.mjs");
}

/**
 * Spool directory the hook script appends to: one `<conversation_id>.jsonl` per conversation.
 * The script derives it from its own location (`../capture/cursor-cli`), so the two stay in step.
 */
export function resolveCursorSpoolDir(home: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveResinHome(home, env), "capture", CURSOR_HARNESS_ID);
}

/**
 * cursor-agent's project slug for a workspace path (`workspace-paths.js`): every
 * non-alphanumeric run becomes `-`. Lossy, so it is only used to match a recorded cwd to
 * its transcript directory, never to recover a cwd.
 */
export function cursorProjectSlug(workspacePath: string): string {
  return workspacePath
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalizes `cursor-agent --version` output (`2026.09.26-dd393fe`) to semver by dropping
 * leading zeros from numeric parts. Returns null for anything else.
 */
export function normalizeCursorVersion(raw: string): string | null {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  const core = [major, minor, patch].map((part) => String(Number(part))).join(".");
  return pre ? `${core}-${pre}` : core;
}
