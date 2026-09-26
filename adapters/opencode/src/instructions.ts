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

Resin learned tools from earlier work in this workspace. They are MCP tools named \`resin_<name>\`; each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- Before working out a procedure yourself, check the \`resin_\` tools: one whose commands do your task is the procedure an earlier run already worked out. Call it with your task's values instead of re-reading docs or \`--help\`; omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself, then check the results.
`;
