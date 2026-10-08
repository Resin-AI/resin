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

Resin may have learned tools from earlier runs in this workspace. They are not listed: Resin lists only \`mcp__resin__search_tools\`, \`mcp__resin__get_tool_schema\`, \`mcp__resin__invoke_tool\` and \`mcp__resin__manage_tools\`, and you find learned tools with \`mcp__resin__search_tools\`. The \`mcp__resin__search_tools\` description says how many learned tools this workspace has and names the commands they run, as do Resin's server instructions; search only when they report some.

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, search with the job or command line you are about to run, unless an earlier search already found a tool for it: invoke that one directly, and search again only if invoke_tool rejects it. With an \`exec\` tool (Code Mode), do it in that \`exec\` call: \`text(JSON.stringify(await tools.mcp__resin__search_tools({query: "<the job>"})))\`. Without \`exec\`, Resin's tools are deferred: call \`tool_search\` with \`resin search_tools\` to load them, then call \`mcp__resin__search_tools\` with \`{"query": "<the job>"}\`. No match: do the task.
- A result that does your task's next step is a procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`mcp__resin__invoke_tool({name: "<name>", parameters: {...}})\` instead of re-reading docs or \`--help\` to rediscover those steps, and use its output instead of rerunning its commands. Omitted inputs reuse the recorded values. Run several at once with \`Promise.all\` in \`exec\`.
- If its output does not answer your question (it keeps a value fixed that your task needs changed, such as a period, granularity or filter), do the rest yourself with your usual tools.
`;

/** Resolves Codex's home directory: `$CODEX_HOME`, else `<home>/.codex`. */
export function resolveCodexHome(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return readHostPathEnv(env, "CODEX_HOME") ?? path.join(customHome, ".codex");
}

/** Resolves Codex's global instructions file, `$CODEX_HOME/AGENTS.md`. */
export function resolveCodexAgentsPath(customHome: string, env: NodeJS.ProcessEnv = {}): string {
  return path.join(resolveCodexHome(customHome, env), "AGENTS.md");
}
