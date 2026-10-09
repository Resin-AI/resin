import path from "node:path";
import { type ManagedBlockMarkers, readHostPathEnv } from "@resin/harness-contracts";

export const CODEX_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:codex-guidance:start -->",
  end: "<!-- resin:codex-guidance:end -->",
};

/**
 * Guidance for Codex's global instructions. Codex hides MCP tools from the model unless its
 * instructions mention them, and how it hides them depends on the session: Code Mode nests them
 * in `tools` inside `exec`, while direct tool calling defers them behind `tool_search`. Codex
 * picks the mode per session from its features and profiles, so one global file names both; that
 * is why this block runs past the others' length. Codex repeats Resin's server instructions (when
 * to call each tool, and the use rules) in each tool's description, so the block does not.
 */
export const CODEX_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools for this repository: \`mcp__resin__<name>\` tools beside \`mcp__resin__invoke_tool\`; their descriptions say when to call them. In \`exec\` (Code Mode) call them from \`tools\`, e.g. \`text(JSON.stringify(await tools.mcp__resin__invoke_tool({name: "<name>", parameters: {}})))\`, several at once with \`Promise.all\`. Without \`exec\`, load them with \`tool_search\` (query \`resin\`).
`;

/** Resolves Codex's home directory: `$CODEX_HOME`, else `<home>/.codex`. */
export function resolveCodexHome(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return readHostPathEnv(env, "CODEX_HOME") ?? path.join(customHome, ".codex");
}

/** Resolves Codex's global instructions file, `$CODEX_HOME/AGENTS.md`. */
export function resolveCodexAgentsPath(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveCodexHome(customHome, env), "AGENTS.md");
}
