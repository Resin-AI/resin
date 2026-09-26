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

Resin learned tools from earlier work in this workspace. They are MCP tools from the \`resin\` server, named \`resin-<name>\` in your tool list; each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- Before working out a procedure yourself, check your tool list for \`resin-\` tools other than \`resin-search_tools\`, \`resin-get_tool_schema\`, \`resin-invoke_tool\` and \`resin-manage_tools\`.
- A tool whose commands do your task is the procedure an earlier run already worked out: call it with your task's values instead of re-reading docs or \`--help\`, then check its output. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.
- Resin can add tools while you work. A tool added during a task appears in your tool list on your next step; use it from then on.
`;
