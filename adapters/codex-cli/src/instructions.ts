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
 */
export const CODEX_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in this workspace. They are MCP tools named \`mcp__resin__<name>\`; each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- In your first step, next to your own first look at the task, list them. With an \`exec\` tool (Code Mode), print them in that \`exec\` call: \`text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"))\`. Without \`exec\`, they are deferred: call \`tool_search\` with your task's keywords to load them.
- A tool whose commands do your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. When several apply, call them together (in \`exec\`: \`const [a, b] = await Promise.all([tools.mcp__resin__x({}), tools.mcp__resin__y({})]); text(a.content[0].text); text(b.content[0].text);\`). Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.
`;

/** Resolves Codex's home directory: `$CODEX_HOME`, else `<home>/.codex`. */
export function resolveCodexHome(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return readHostPathEnv(env, "CODEX_HOME") ?? path.join(customHome, ".codex");
}

/** Resolves Codex's global instructions file, `$CODEX_HOME/AGENTS.md`. */
export function resolveCodexAgentsPath(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveCodexHome(customHome, env), "AGENTS.md");
}
