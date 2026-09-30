import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const COPILOT_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:copilot-guidance:start -->",
  end: "<!-- resin:copilot-guidance:end -->",
};

/**
 * Guidance installed in Copilot's global instructions (`$COPILOT_HOME/copilot-instructions.md`).
 * Copilot exposes MCP tools to the model as `<server>-<tool>` functions (recorded on 1.0.88:
 * `fixture-echo_upper` for server `fixture`, tool `echo_upper`), so Resin's tools are `resin-*`.
 */
export const COPILOT_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in this workspace. They are MCP tools from the \`resin\` server, named \`resin-<name>\` in your tool list (besides \`resin-search_tools\`, \`resin-get_tool_schema\`, \`resin-invoke_tool\` and \`resin-manage_tools\`), each listed with its purpose and inputs; \`resin-get_tool_schema\` with its name shows the commands it runs and each input's recorded value.

- In your first step, next to your own first look at the task, go through the \`resin-\` tools and their descriptions.
- A tool that does your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.
- Resin can add tools while you work. A tool added during a task appears in your tool list on your next step; use it from then on.
`;
