import path from "node:path";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { CodexHarnessAdapter } from "./adapter.js";
import { planCodexMcpConfig } from "./config-planner.js";
import { CodexRecordDecoder } from "./decoder.js";
import { CODEX_TESTED_VERSIONS, probeCodexInstallation } from "./discovery.js";
import {
  CODEX_GUIDANCE_MARKERS,
  CODEX_RESIN_GUIDANCE,
  resolveCodexAgentsPath,
  resolveCodexHome,
} from "./instructions.js";

function resolveCodexConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const configPath = env.CODEX_CONFIG_PATH;
  if (configPath && configPath.trim().length > 0) {
    return path.resolve(configPath);
  }
  return path.join(resolveCodexHome(home, env), "config.toml");
}

export const codexHarness: HarnessDefinition = {
  id: "codex-cli",
  displayName: "Codex CLI",
  shortName: "Codex CLI",
  adapterPackage: "@resin/adapter-codex",
  testedVersions: CODEX_TESTED_VERSIONS,
  knownLimits: [],
  probeInstallation: ({ targetPath, home, env }) =>
    probeCodexInstallation({ customConfigPath: targetPath, env: { ...env, HOME: home } }),
  mcpConfig: {
    resolvePath: resolveCodexConfigPath,
    uninstallPaths: (home, env) => [
      resolveCodexConfigPath(home, env),
      path.join(home, ".codex", "config.toml"),
      path.join(home, ".codex", "config.json"),
      path.join(home, ".codex", "mcp.json"),
    ],
    format: "codex-toml",
    serverKey: "resin",
    jsonContainerKeys: ["mcpServers", "mcp_servers"],
    transports: ["stdio", "sse"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planCodexMcpConfig({ targetPath, command, args: [...args], fsBridge }),
  },
  guidance: {
    resolvePath: resolveCodexAgentsPath,
    markers: CODEX_GUIDANCE_MARKERS,
    body: CODEX_RESIN_GUIDANCE.trimEnd(),
  },
  createAdapter: () => new CodexHarnessAdapter(),
  createDecoder: () => new CodexRecordDecoder(),
  sessionCapture: "observation-window",
};
