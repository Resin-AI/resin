import path from "node:path";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { ClaudeHarnessAdapter } from "./adapter.js";
import { planClaudeMcpConfig } from "./config-planner.js";
import { ClaudeRecordDecoder } from "./decoder.js";
import { CLAUDE_TESTED_VERSIONS, probeClaudeInstallation } from "./discovery.js";

function resolveClaudeConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const configDirectory = env.CLAUDE_CONFIG_DIR;
  return configDirectory && configDirectory.trim().length > 0
    ? path.join(path.resolve(configDirectory), ".claude.json")
    : path.join(home, ".claude.json");
}

export const claudeCodeHarness: HarnessDefinition = {
  id: "claude-code",
  displayName: "Claude Code CLI",
  shortName: "Claude Code",
  adapterPackage: "@resin/adapter-claude-code",
  testedVersions: CLAUDE_TESTED_VERSIONS,
  knownLimits: [],
  probeInstallation: ({ targetPath, fsBridge }) =>
    probeClaudeInstallation({ customConfigPath: targetPath }, fsBridge),
  mcpConfig: {
    resolvePath: resolveClaudeConfigPath,
    uninstallPaths: (home, env) => [
      resolveClaudeConfigPath(home, env),
      path.join(home, ".claude.json"),
      path.join(home, ".claude", "claude.json"),
      path.join(home, ".claude", "config.json"),
    ],
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcpServers"],
    transports: ["sse", "stdio"],
    planRegistration: ({ workspace, gatewayUrl, fsBridge, command }) =>
      planClaudeMcpConfig(workspace, gatewayUrl, fsBridge, command),
  },
  createAdapter: () => new ClaudeHarnessAdapter(),
  createDecoder: () => new ClaudeRecordDecoder(),
  sessionCapture: "observation-window",
};
