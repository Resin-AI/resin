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

Resin learned tools from earlier work in this workspace. They are MCP tools from the \`resin\` server named \`mcp__resin__<name>\` (besides Resin's own \`search_tools\`, \`get_tool_schema\`, \`invoke_tool\` and \`manage_tools\`); each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- In your first step, next to your own first look at the task, go through the \`mcp__resin__\` tools and their descriptions.
- A tool whose commands do your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.
`;
