import type { HarnessInstallDefinition } from "@resin/harness-contracts";
import { CANONICAL_RESIN_MCP_SERVER_KEY } from "@resin/harness-contracts";
import { planGrokMcpConfig } from "./config-planner.js";
import { GROK_TESTED_VERSIONS, probeGrokInstallation } from "./discovery.js";
import {
  GROK_DISPLAY_NAME,
  GROK_HARNESS_ID,
  resolveGrokAgentsPath,
  resolveGrokConfigPath,
} from "./paths.js";

export const GROK_GUIDANCE_MARKERS = Object.freeze({
  start: "<!-- resin:grok-guidance:start -->",
  end: "<!-- resin:grok-guidance:end -->",
});

/**
 * Grok keeps MCP tools out of the model's tool list and exposes them through its `search_tool`
 * and `use_tool` meta-tools, so the model only finds Resin's tools when told to look. No recorded
 * Grok session shows Resin's server instructions reaching the model, so the block also carries
 * when to call the tools and the use rules, which is why it is longer than Claude's or Cursor's.
 */
export const GROK_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools for this repository: \`resin__<name>\` tools beside \`resin__invoke_tool\`, found with \`search_tool\` and run with \`use_tool\`. Call one directly when it is your next step; omitted inputs reuse recorded values. If \`resin__search_tools\` is listed, search only when your next command is one its description names, then invoke a result directly. Otherwise do the task directly. Use a tool only for exactly the user's task; check its errors and effects; never enable, pin, disable or roll back tools.`;

export const grokBuildInstallHarness: HarnessInstallDefinition = {
  id: GROK_HARNESS_ID,
  displayName: GROK_DISPLAY_NAME,
  shortName: "Grok",
  adapterPackage: "@resin/adapter-grok-build",
  testedVersions: GROK_TESTED_VERSIONS,
  knownLimits: [
    "A rewind keeps the abandoned turns in the captured trajectory; the rewind is recorded as a branch point before the replacement turns.",
    "Sessions continued from another harness with /resume-claude, /resume-codex or /resume-cursor capture only Grok's new work; the original transcript is captured by that harness's adapter.",
    "A fork whose parent session was deleted is captured in full.",
    'Grok also starts MCP servers from ~/.claude.json, ~/.cursor/mcp.json and .mcp.json; a Resin entry there under a name other than "resin" starts a second gateway.',
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probeGrokInstallation({ home, env, configPath: targetPath }),
  mcpConfig: {
    resolvePath: resolveGrokConfigPath,
    uninstallPaths: (home, env) => [resolveGrokConfigPath(home, env)],
    format: "codex-toml",
    serverKey: CANONICAL_RESIN_MCP_SERVER_KEY,
    jsonContainerKeys: [],
    transports: ["stdio", "http", "sse"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planGrokMcpConfig({ targetPath, command, args, fsBridge }),
  },
  guidance: {
    resolvePath: resolveGrokAgentsPath,
    markers: GROK_GUIDANCE_MARKERS,
    body: GROK_RESIN_GUIDANCE,
  },
};
