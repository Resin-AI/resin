import * as path from "node:path";

export const GROK_HARNESS_ID = "grok-build";
export const GROK_DISPLAY_NAME = "Grok Build";

/** Resolves Grok's home: `$GROK_HOME`, else `<home>/.grok`. */
export function resolveGrokHome(home: string, env: NodeJS.ProcessEnv = {}): string {
  const override = env.GROK_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, ".grok");
}

/** User-scope config Grok reads MCP servers from (`[mcp_servers.<name>]`). */
export function resolveGrokConfigPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveGrokHome(home, env), "config.toml");
}

/** Global instruction file Grok injects into every session (`grok inspect` scope "global"). */
export function resolveGrokAgentsPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveGrokHome(home, env), "AGENTS.md");
}

export function resolveGrokSessionsDir(home: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveGrokHome(home, env), "sessions");
}

/**
 * Grok names each per-project session directory after the cwd, percent-encoded as one path
 * segment (`/tmp/x` → `%2Ftmp%2Fx`).
 */
export function decodeGrokCwd(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return path.isAbsolute(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
