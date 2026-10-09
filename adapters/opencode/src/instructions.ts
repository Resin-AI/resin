import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const OPENCODE_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:opencode-guidance:start -->",
  end: "<!-- resin:opencode-guidance:end -->",
};

/**
 * Guidance for OpenCode's global `AGENTS.md`. OpenCode exposes MCP tools to the model as
 * `<server>_<tool>`, so Resin's tools appear as `resin_<name>`. No recorded OpenCode session shows
 * Resin's server instructions reaching the model, so the block carries when to call the tools and
 * the use rules itself, which is why it is longer than Claude's or Cursor's.
 */
export const OPENCODE_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools for this repository: \`resin_<name>\` tools beside \`resin_invoke_tool\`. Call one directly when it is your next step; omitted inputs reuse recorded values. If \`resin_search_tools\` is listed, search only when your next command is one its description names, then invoke a result directly. Otherwise do the task directly. Use a tool only for exactly the user's task; check its errors and effects; never enable, pin, disable or roll back tools.
`;
