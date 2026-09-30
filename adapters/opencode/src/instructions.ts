import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const OPENCODE_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:opencode-guidance:start -->",
  end: "<!-- resin:opencode-guidance:end -->",
};

/**
 * Guidance for OpenCode's global `AGENTS.md`. OpenCode exposes MCP tools to the model as
 * `<server>_<tool>`, so Resin's tools appear as `resin_<name>`.
 */
export const OPENCODE_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in this workspace. They are MCP tools named \`resin_<name>\` (besides Resin's own \`resin_search_tools\`, \`resin_get_tool_schema\`, \`resin_invoke_tool\` and \`resin_manage_tools\`), each listed with its purpose and inputs; \`resin_get_tool_schema\` with its name shows the commands it runs and each input's recorded value.

- In your first step, next to your own first look at the task, go through the \`resin_\` tools and their descriptions.
- A tool that does your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.
`;
