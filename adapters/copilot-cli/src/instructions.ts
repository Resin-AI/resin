import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const COPILOT_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:copilot-guidance:start -->",
  end: "<!-- resin:copilot-guidance:end -->",
};

/**
 * Guidance installed in Copilot's global instructions (`$COPILOT_HOME/copilot-instructions.md`).
 * Copilot exposes MCP tools to the model as `<server>-<tool>` functions (recorded on 1.0.88:
 * `fixture-echo_upper` for server `fixture`, tool `echo_upper`), so Resin's tools are `resin-*`.
 * No recorded Copilot session shows Resin's server instructions reaching the model, so the block
 * carries when to call the tools and the use rules itself, which is why it is longer than
 * Claude's or Cursor's.
 */
export const COPILOT_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools for this repository: \`resin-<name>\` tools beside \`resin-invoke_tool\`. Call one directly when it is your next step; omitted inputs reuse recorded values. If \`resin-search_tools\` is listed, search only when your next command is one its description names, then invoke a result directly. Otherwise do the task directly. Use a tool only for exactly the user's task; check its errors and effects; never enable, pin, disable or roll back tools.
`;
