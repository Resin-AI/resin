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

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, call \`resin_search_tools\` with \`{"query": "<the job or command line you are about to run>"}\`, unless an earlier search already found a tool for it: invoke that one directly, and search again only if invoke_tool rejects it.
- A result that does your task is the procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`resin_invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
- If its output does not answer your question (it keeps a value fixed that your task needs changed, such as a period, granularity or filter), do the rest yourself with your usual tools.
`;
