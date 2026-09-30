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
 * and `use_tool` meta-tools, so the model only finds Resin's tools when told to look.
 */
export const GROK_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in this workspace. Grok lists MCP tools through \`search_tool\` and runs them through \`use_tool\`; Resin's are named \`resin__<name>\`, each listed with its purpose and inputs, and \`resin__get_tool_schema\` with its name shows the commands one runs and each input's recorded value.

- In your first step, next to your own first look at the task, call \`search_tool\` with a few words describing the task to list the matching \`resin__\` tools.
- A tool that does your task is the procedure an earlier run already worked out from the docs: call it next with your task's values instead of re-reading docs or \`--help\` to rediscover those steps, then check its output and the results. Call it with \`use_tool\` (\`tool_name: "resin__<name>"\`). Omitted inputs reuse the recorded values.
- Their output is the commands' current output: use it instead of running those commands yourself.`;

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
