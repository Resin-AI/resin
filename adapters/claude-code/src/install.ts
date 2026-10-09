import * as path from "node:path";
import { type HarnessInstallDefinition, readHostPathEnv } from "@resin/harness-contracts";
import { claudeCommandSuggestExtension } from "./command-suggest.js";
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

- Search only when the next command you are about to run is one of those commands: call \`mcp__resin__search_tools\` with \`{"query": "<that command line>"}\`. If it lists no command, or says there are no learned tools, do not search: do the task directly.
- A result is directly invocable: call \`mcp__resin__invoke_tool\` with \`{"name": "<name>", "parameters": {...}}\`, parameters from its \`inputSchema\`, without calling \`mcp__resin__get_tool_schema\` first. When several apply, call them together in one turn. Omitted inputs reuse the recorded values.
- A listed tool's description already gives its inputs (or \`{}\`): call it with those arguments directly, without looking up its schema first.
- Invoke a tool you already found without searching; search again only if invoke_tool rejects it.
- Its output gives each command's exit status when one fails and the diagnostics its recorded \`tail\`/\`head\`/\`grep\` filters hid: use it instead of rerunning those commands. If it does not answer your question (it keeps a value fixed that your task needs changed, such as a period or filter), do the rest yourself.`;

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
  installExtensions: [
    // Suggests the learned tool that already runs a shell command, as the agent is about to run it.
    claudeCommandSuggestExtension,
  ],
};

export {
  claudeCommandSuggestExtension,
  editClaudeSettingsDocument,
  renderClaudeCommandSuggestCommand,
  resolveClaudeSettingsPath,
} from "./command-suggest.js";
