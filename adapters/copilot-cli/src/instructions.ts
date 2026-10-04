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

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, call \`resin-search_tools\` with \`{"query": "<the job in a few words, e.g. the commands or scripts you are about to run>"}\`.
- A result that does your task is the procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`resin-invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
- If its output does not answer your question (it keeps a value fixed that your task needs changed, such as a period, granularity or filter), do the rest yourself with your usual tools.
`;
