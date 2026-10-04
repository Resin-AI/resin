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

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, call \`mcp__resin__search_tools\` with \`{"query": "<the job in a few words, e.g. the commands or scripts you are about to run>"}\`.
- A result that does your task is the procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`mcp__resin__invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
- If its output does not answer your question (it keeps a value fixed that your task needs changed, such as a period, granularity or filter), do the rest yourself with your usual tools.
`;
