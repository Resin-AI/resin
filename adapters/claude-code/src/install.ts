import * as path from "node:path";
import { type HarnessInstallDefinition, readHostPathEnv } from "@resin/harness-contracts";
import { planClaudeMcpConfig } from "./config-planner.js";
import { CLAUDE_TESTED_VERSIONS, probeClaudeInstallation } from "./discovery.js";

/** `$CLAUDE_CONFIG_DIR` when set, else `<home>/.claude` (Claude's settings, CLAUDE.md, projects). */
export function resolveClaudeConfigDir(home: string, env: NodeJS.ProcessEnv): string {
  return readHostPathEnv(env, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude");
}

/**
 * Claude's user-scope MCP servers live in `.claude.json`: `<home>/.claude.json` by default, or
 * inside `$CLAUDE_CONFIG_DIR` when that is set (what `claude mcp add -s user` writes).
 */
export function resolveClaudeMcpConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const configured = readHostPathEnv(env, "CLAUDE_CONFIG_DIR");
  return configured ? path.join(configured, ".claude.json") : path.join(home, ".claude.json");
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
 * their names until it loads them. `resin mcp` lists only Resin's meta tools, so the block says
 * how to find learned tools with search_tools and run them with invoke_tool.
 */
export const CLAUDE_RESIN_GUIDANCE = `# Resin learned tools

Resin may have learned tools from earlier work in your projects. They are not listed: Resin lists only \`mcp__resin__search_tools\`, \`mcp__resin__get_tool_schema\`, \`mcp__resin__invoke_tool\` and \`mcp__resin__manage_tools\` (if they are deferred, load them with tool search, query \`resin\`). The \`mcp__resin__search_tools\` description says how many learned tools this workspace has and names the commands they run.

- If it says there are none, do the task directly: there is nothing to search for, and tools Resin learns from this work reach later sessions.
- Otherwise, before running one of those commands or another multi-step job by hand, call \`mcp__resin__search_tools\` with \`{"query": "<the job in a few words, e.g. the commands or scripts you are about to run>"}\`.
- A result that does your task is the procedure an earlier run already worked out: its description lists the recorded steps and its \`inputSchema\` the inputs, so run it directly with your task's values through \`mcp__resin__invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, instead of re-reading docs or \`--help\` to rediscover those steps. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- Its output is the commands' current output: use it instead of running those commands yourself.`;

export const claudeCodeInstallHarness: HarnessInstallDefinition = {
  id: "claude-code",
  displayName: "Claude Code CLI",
  shortName: "Claude Code",
  adapterPackage: "@resin/adapter-claude-code",
  testedVersions: CLAUDE_TESTED_VERSIONS,
  knownLimits: [
    "Only user-scope MCP registration (.claude.json) is managed; project .mcp.json files are left alone.",
    "Edit/Write steps are learned only when Claude recorded the resulting patch (toolUseResult.structuredPatch or created-file content).",
  ],
  probeInstallation: ({ targetPath, home, env, fsBridge }) =>
    probeClaudeInstallation({ customConfigPath: targetPath, homeDir: home, env }, fsBridge),
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
    planRegistration: ({ workspace, gatewayUrl, command, args, fsBridge }) =>
      planClaudeMcpConfig(workspace, gatewayUrl, fsBridge, command, args),
  },
  guidance: {
    resolvePath: resolveClaudeGuidancePath,
    markers: CLAUDE_GUIDANCE_MARKERS,
    body: CLAUDE_RESIN_GUIDANCE,
  },
};
