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

Resin learned tools from earlier work in this workspace. They are not listed: Resin lists only \`resin_search_tools\`, \`resin_get_tool_schema\`, \`resin_invoke_tool\` and \`resin_manage_tools\`.

- Before running a multi-step job by hand, call \`resin_search_tools\` with \`{"query": "<the job in a few words, e.g. the commands or scripts you are about to run>"}\`.
- A tool that does your task is the procedure an earlier run already worked out: call \`resin_get_tool_schema\` with \`{"name": "<name>"}\` to see its commands and inputs, then run it with your task's values through \`resin_invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
`;
