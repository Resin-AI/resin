import * as path from "node:path";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { ClaudeHarnessAdapter } from "./adapter.js";
import { planClaudeMcpConfig } from "./config-planner.js";
import { ClaudeRecordDecoder } from "./decoder.js";
import { CLAUDE_TESTED_VERSIONS, probeClaudeInstallation } from "./discovery.js";

/** `$CLAUDE_CONFIG_DIR` when set, else `<home>/.claude` (Claude's settings, CLAUDE.md, projects). */
export function resolveClaudeConfigDir(home: string, env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured && configured.trim().length > 0
    ? path.resolve(configured)
    : path.join(home, ".claude");
}

/**
 * Claude's user-scope MCP servers live in `.claude.json`: `<home>/.claude.json` by default, or
 * inside `$CLAUDE_CONFIG_DIR` when that is set (what `claude mcp add -s user` writes).
 */
export function resolveClaudeMcpConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured && configured.trim().length > 0
    ? path.join(path.resolve(configured), ".claude.json")
    : path.join(home, ".claude.json");
}

/** Claude's user memory file, loaded into every session. */
export function resolveClaudeGuidancePath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolveClaudeConfigDir(home, env), "CLAUDE.md");
}

export const CLAUDE_GUIDANCE_MARKERS = {
  start: "<!-- resin:claude-guidance:start -->",
  end: "<!-- resin:claude-guidance:end -->",
} as const;

/**
 * Claude Code defers MCP tools behind its tool search on first-party models: the model sees only
 * their names until it loads them. The block says where Resin's learned tools are and how to use
 * them; catalog changes themselves arrive through MCP `tools/list_changed`, which Claude handles.
 */
export const CLAUDE_RESIN_GUIDANCE = `# Resin learned tools

Resin learned tools from earlier work in your projects. They are MCP tools named \`mcp__resin__<name>\` (besides Resin's own \`search_tools\`, \`get_tool_schema\`, \`invoke_tool\`, and \`manage_tools\`). Each description shows the commands it runs, with \`{input}\` where a value you pass goes, and each input's recorded value.

- Before working out a task from docs or \`--help\`, check whether a Resin tool already does it. If the tools are deferred, load them with tool search (query \`resin\`).
- A tool whose commands do your task is the procedure an earlier run already worked out: call it with your task's values, then check its output. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.`;

export const claudeCodeHarness: HarnessDefinition = {
  id: "claude-code",
  displayName: "Claude Code CLI",
  shortName: "Claude Code",
  adapterPackage: "@resin/adapter-claude-code",
  testedVersions: CLAUDE_TESTED_VERSIONS,
  knownLimits: [
    "Only user-scope MCP registration (.claude.json) is managed; project .mcp.json files are left alone.",
    "Edit/Write steps are learned only when Claude recorded the resulting patch (toolUseResult.structuredPatch or created-file content).",
  ],
  probeInstallation: ({ targetPath, fsBridge }) =>
    probeClaudeInstallation({ customConfigPath: targetPath }, fsBridge),
  mcpConfig: {
    resolvePath: resolveClaudeMcpConfigPath,
    uninstallPaths: (home, env) => [
      resolveClaudeMcpConfigPath(home, env),
      path.join(home, ".claude.json"),
      path.join(home, ".claude", "claude.json"),
      path.join(home, ".claude", "config.json"),
    ],
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcpServers"],
    transports: ["stdio"],
    planRegistration: ({ workspace, gatewayUrl, command, fsBridge }) =>
      planClaudeMcpConfig(workspace, gatewayUrl, fsBridge, command),
  },
  guidance: {
    resolvePath: resolveClaudeGuidancePath,
    markers: CLAUDE_GUIDANCE_MARKERS,
    body: CLAUDE_RESIN_GUIDANCE,
  },
  createAdapter: () => new ClaudeHarnessAdapter(),
  createDecoder: () => new ClaudeRecordDecoder(),
  sessionCapture: "observation-window",
};
