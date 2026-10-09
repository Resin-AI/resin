import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const MUSE_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:muse-guidance:start -->",
  end: "<!-- resin:muse-guidance:end -->",
};

/**
 * Guidance placed in muse's machine-wide user rules (`$CONFIG_DIR/AGENTS.md`), which muse loads
 * into every session in every workspace. It is static text: no paths, workspace names, tool
 * names, or recorded values, so nothing private reaches unrelated projects.
 */
export const MUSE_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier work in this workspace. They are not listed: the \`resin\` server lists only \`mcp__resin__search_tools\`, \`mcp__resin__get_tool_schema\`, \`mcp__resin__invoke_tool\` and \`mcp__resin__manage_tools\`. The \`mcp__resin__search_tools\` description says how many learned tools this workspace has and names the commands they run.

- Search only when the next command you are about to run is one of those commands: call \`mcp__resin__search_tools\` with \`{"query": "<that command line>"}\`. If it lists no command, or says there are no learned tools, do not search: do the task directly.
- A result is directly invocable: call \`mcp__resin__invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, parameters from its \`inputSchema\`, without calling \`mcp__resin__get_tool_schema\` first. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Invoke a tool you already found without searching; search again only if invoke_tool rejects it.
- Its output gives each command's exit status when one fails and the diagnostics its recorded \`tail\`/\`head\`/\`grep\` filters hid: use it instead of rerunning those commands. If it does not answer your question (it keeps a value fixed that your task needs changed, such as a period or filter), do the rest yourself.
`;
