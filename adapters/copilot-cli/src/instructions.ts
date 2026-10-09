import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const COPILOT_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:copilot-guidance:start -->",
  end: "<!-- resin:copilot-guidance:end -->",
};

/**
 * Guidance installed in Copilot's global instructions (`$COPILOT_HOME/copilot-instructions.md`).
 * Copilot exposes MCP tools to the model as `<server>-<tool>` functions (recorded on 1.0.88:
 * `fixture-echo_upper` for server `fixture`, tool `echo_upper`), so Resin's tools are `resin-*`.
 * `resin mcp` lists only Resin's meta tools; learned tools are found with search_tools.
 */
export const COPILOT_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier work in this workspace. They are not in your tool list: Resin lists only \`resin-search_tools\`, \`resin-get_tool_schema\`, \`resin-invoke_tool\` and \`resin-manage_tools\`. The \`resin-search_tools\` description says how many learned tools this workspace has and names the commands they run.

- Search only when the next command you are about to run is one of those commands: call \`resin-search_tools\` with \`{"query": "<that command line>"}\`. If it lists no command, or says there are no learned tools, do not search: do the task directly.
- A result is directly invocable: call \`resin-invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, parameters from its \`inputSchema\`, without calling \`resin-get_tool_schema\` first. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Invoke a tool you already found without searching; search again only if invoke_tool rejects it.
- Its output gives each command's exit status when one fails and the diagnostics its recorded \`tail\`/\`head\`/\`grep\` filters hid: use it instead of rerunning those commands. If it does not answer your question (it keeps a value fixed that your task needs changed, such as a period or filter), do the rest yourself.
`;
