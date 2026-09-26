import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessDefinition, HarnessMcpServerDescriptor } from "@resin/harness-contracts";
import { CANONICAL_RESIN_MCP_SERVER_KEY } from "@resin/harness-contracts";
import { GrokHarnessAdapter } from "./adapter.js";
import { planGrokMcpConfig, readGrokTomlServer } from "./config-planner.js";
import { GrokRecordDecoder } from "./decoder.js";
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

Resin learned tools from earlier work in this workspace. Grok lists MCP tools through \`search_tool\` and runs them through \`use_tool\`; Resin's are named \`resin__<name>\`. Each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- Before working on a task, call \`search_tool\` with a few words describing it to see matching \`resin__\` tools.
- A tool whose commands do your task is the procedure an earlier run already worked out: call it with \`use_tool\` (\`tool_name: "resin__<name>"\`) and your task's values instead of rediscovering those steps. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.`;

function readServer(configPath: string, name: string): HarnessMcpServerDescriptor | undefined {
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  const entry = readGrokTomlServer(content, name);
  if (entry?.command) {
    return { name, transport: { kind: "stdio", command: entry.command, args: entry.args ?? [] } };
  }
  return entry?.url ? { name, transport: { kind: "http", url: entry.url } } : undefined;
}

export const grokBuildHarness: HarnessDefinition = {
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
  createAdapter: () => new GrokHarnessAdapter(),
  createDecoder: () => new GrokRecordDecoder(),
  // Headless runs exit right away and `--resume` appends to old sessions, so capture follows
  // transcript activity rather than session creation time.
  sessionCapture: "file-activity",
  // Project `.grok/config.toml` overrides the user config (grok-build `util/config/mcp.rs`).
  resolveMcpServer: (name, workspaceRoot) =>
    readServer(path.join(workspaceRoot, ".grok", "config.toml"), name) ??
    readServer(resolveGrokConfigPath(os.homedir(), process.env), name),
};
