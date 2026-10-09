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
 * and `use_tool` meta-tools, so the model only finds Resin's tools when told to look. `resin mcp`
 * lists only Resin's meta tools; learned tools are found with Resin's own search_tools.
 */
export const GROK_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier work in this workspace. Grok runs MCP tools through \`use_tool\`; Resin lists only \`resin__search_tools\`, \`resin__get_tool_schema\`, \`resin__invoke_tool\` and \`resin__manage_tools\`, and its learned tools are found with \`resin__search_tools\`. Grok's tool search shows the \`resin__search_tools\` description, and that description says how many learned tools this workspace has and names the commands they run.

- Search only when the next command you are about to run is one of those commands: call \`use_tool\` with \`tool_name: "resin__search_tools"\` and \`{"query": "<that command line>"}\`. If it lists no command, or says there are no learned tools, do not search: do the task directly.
- A result is directly invocable: call \`resin__invoke_tool\` (via \`use_tool\`) with \`{"name": "<name>", "parameters": {...}}\`, parameters from its \`inputSchema\`, without calling \`resin__get_tool_schema\` first. Omitted inputs reuse the recorded values.
- Invoke a tool you already found without searching; search again only if invoke_tool rejects it.
- Its output gives each command's exit status when one fails and the diagnostics its recorded \`tail\`/\`head\`/\`grep\` filters hid: use it instead of rerunning those commands. If it does not answer your question (it keeps a value fixed that your task needs changed, such as a period or filter), do the rest yourself.`;

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
