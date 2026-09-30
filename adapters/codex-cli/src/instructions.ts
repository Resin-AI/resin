import path from "node:path";
import { type ManagedBlockMarkers, readHostPathEnv } from "@resin/harness-contracts";

export const CODEX_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:codex-guidance:start -->",
  end: "<!-- resin:codex-guidance:end -->",
};

/**
 * Guidance for Codex's global instructions. Codex hides MCP tools from the model unless its
 * instructions mention them, and how it hides them depends on the session: Code Mode nests them
 * in `ALL_TOOLS` inside `exec`, while direct tool calling defers them behind `tool_search`. Codex
 * picks the mode per session from its features and profiles, so one global file names both.
 *
 * A nested tool's description in Code Mode is the server's instructions, a blank line, the tool's
 * own description, then its `exec tool declaration`; the listing snippet prints only the tool's
 * own one-line description, since what it prints stays in the transcript for every later request.
 */
export const CODEX_RESIN_GUIDANCE = `# Resin learned tools

Earlier runs in this workspace may have left learned tools: MCP tools named \`mcp__resin__<name>\`, each listed with its purpose and inputs.

- In your first step, next to your own first look at the task, list them. With an \`exec\` tool (Code Mode), print them in that \`exec\` call: \`text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + ": " + t.description.split("\\n\\nexec tool declaration")[0].split("\\n\\n").pop()).join("\\n"))\`. Without \`exec\`, they are deferred: call \`tool_search\` with your task's keywords to load them. None listed: do the task.
- A tool that does your task's next step is a procedure an earlier run already worked out: call it with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, and use its output instead of rerunning its commands. Omitted inputs reuse the recorded values; \`mcp__resin__get_tool_schema({name: "<name>"})\` shows its commands and input docs. Run several at once with \`Promise.all\` in \`exec\`.
`;

/** Resolves Codex's home directory: `$CODEX_HOME`, else `<home>/.codex`. */
export function resolveCodexHome(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return readHostPathEnv(env, "CODEX_HOME") ?? path.join(customHome, ".codex");
}

/** Resolves Codex's global instructions file, `$CODEX_HOME/AGENTS.md`. */
export function resolveCodexAgentsPath(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveCodexHome(customHome, env), "AGENTS.md");
}
