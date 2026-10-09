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
 * picks the mode per session from its features and profiles, so one global file names both.
 * `resin mcp` lists only Resin's meta tools, so learned tools are found with search_tools.
 */
export const CODEX_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier runs in this workspace. They are not listed: Resin lists only \`mcp__resin__search_tools\`, \`mcp__resin__get_tool_schema\`, \`mcp__resin__invoke_tool\` and \`mcp__resin__manage_tools\`. The \`mcp__resin__search_tools\` description says how many learned tools this workspace has and names the commands they run, as do Resin's server instructions.

- Search only when the next command you are about to run is one of those commands, with that command line as the query. With an \`exec\` tool (Code Mode), do it in that \`exec\` call: \`text(JSON.stringify(await tools.mcp__resin__search_tools({query: "<the command line>"})))\`. Without \`exec\`, Resin's tools are deferred: call \`tool_search\` with \`resin search_tools\` to load them, then call \`mcp__resin__search_tools\` with \`{"query": "<the command line>"}\`. If it lists no command, or says there are no learned tools, do not search: do the task directly.
- A result is directly invocable: call \`mcp__resin__invoke_tool({name: "<name>", parameters: {...}})\` with parameters from its \`inputSchema\`, without calling \`mcp__resin__get_tool_schema\` first. Omitted inputs reuse the recorded values. Run several at once with \`Promise.all\` in \`exec\`.
- Invoke a tool you already found without searching; search again only if invoke_tool rejects it.
- Its output gives each command's exit status when one fails and the diagnostics its recorded \`tail\`/\`head\`/\`grep\` filters hid: use it instead of rerunning those commands. If it does not answer your question (it keeps a value fixed that your task needs changed, such as a period or filter), do the rest yourself.
`;

/** Resolves Codex's home directory: `$CODEX_HOME`, else `<home>/.codex`. */
export function resolveCodexHome(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return readHostPathEnv(env, "CODEX_HOME") ?? path.join(customHome, ".codex");
}

/** Resolves Codex's global instructions file, `$CODEX_HOME/AGENTS.md`. */
export function resolveCodexAgentsPath(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveCodexHome(customHome, env), "AGENTS.md");
}
