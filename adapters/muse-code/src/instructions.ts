import type { ManagedBlockMarkers } from "@resin/harness-contracts";

export const MUSE_GUIDANCE_MARKERS: ManagedBlockMarkers = {
  start: "<!-- resin:muse-guidance:start -->",
  end: "<!-- resin:muse-guidance:end -->",
};

/**
 * Guidance placed in muse's machine-wide user rules (`$CONFIG_DIR/AGENTS.md`), which muse loads
 * into every session in every workspace. It is static text: no paths, workspace names, tool
 * names, or recorded values, so nothing private reaches unrelated projects. No recorded muse
 * session shows Resin's server instructions reaching the model, so the block carries when to call
 * the tools and the use rules itself, which is why it is longer than Claude's or Cursor's.
 */
export const MUSE_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools for this repository: \`mcp__resin__<name>\` tools beside \`mcp__resin__invoke_tool\`. Call one directly when it is your next step; omitted inputs reuse recorded values. If \`mcp__resin__search_tools\` is listed, search only when your next command is one its description names, then invoke a result directly. Otherwise do the task directly. Use a tool only for exactly the user's task; check its errors and effects; never enable, pin, disable or roll back tools.
`;
