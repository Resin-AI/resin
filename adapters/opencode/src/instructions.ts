import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const OPENCODE_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:opencode-guidance:start -->",
  end: "<!-- resin:opencode-guidance:end -->",
};

/**
 * Guidance for OpenCode's global `AGENTS.md`. OpenCode exposes MCP tools to the model as
 * `<server>_<tool>`, so Resin's tools appear as `resin_<name>`. `resin mcp` lists only Resin's
 * meta tools; learned tools are found with search_tools.
 */
export const OPENCODE_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier work in this workspace. They are not listed: Resin lists only \`resin_search_tools\`, \`resin_get_tool_schema\`, \`resin_invoke_tool\` and \`resin_manage_tools\`. The \`resin_search_tools\` description says how many learned tools this workspace has and names the commands they run.

- Search only when the next command you are about to run is one of those commands: call \`resin_search_tools\` with \`{"query": "<that command line>"}\`. If it lists no command, or says there are no learned tools, do not search: do the task directly.
- A result is directly invocable: call \`resin_invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, parameters from its \`inputSchema\`, without calling \`resin_get_tool_schema\` first. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Invoke a tool you already found without searching; search again only if invoke_tool rejects it.
- Its output gives each command's exit status when one fails and the diagnostics its recorded \`tail\`/\`head\`/\`grep\` filters hid: use it instead of rerunning those commands. If it does not answer your question (it keeps a value fixed that your task needs changed, such as a period or filter), do the rest yourself.
`;
