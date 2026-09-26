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

Resin serves tools learned from earlier work through the \`resin\` MCP server; they appear as \`mcp__resin__<name>\`. Each description lists the commands it runs and the inputs it takes.

- Before re-deriving a procedure from docs or \`--help\`, check whether a \`mcp__resin__\` tool already does it; if one does, call it with this task's values and check its output.
- A learned tool's output is the commands' current output: use it instead of running those commands again.
`;
