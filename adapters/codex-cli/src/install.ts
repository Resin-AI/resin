import path from "node:path";
import { type HarnessInstallDefinition, readHostPathEnv } from "@resin/harness-contracts";
import { planCodexMcpConfig } from "./config-planner.js";
import { CODEX_TESTED_VERSIONS, probeCodexInstallation } from "./discovery.js";
import {
  CODEX_GUIDANCE_MARKERS,
  CODEX_RESIN_GUIDANCE,
  resolveCodexAgentsPath,
  resolveCodexHome,
} from "./instructions.js";

function resolveCodexConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  return (
    readHostPathEnv(env, "CODEX_CONFIG_PATH") ??
    path.join(resolveCodexHome(home, env), "config.toml")
  );
}

export const codexInstallHarness: HarnessInstallDefinition = {
  id: "codex-cli",
  displayName: "Codex CLI",
  shortName: "Codex CLI",
  adapterPackage: "@resin/adapter-codex",
  testedVersions: CODEX_TESTED_VERSIONS,
  knownLimits: [
    "No native-tool invoker: learned tools replay Codex built-in steps only as shell commands and apply_patch edits; web search and multi-agent steps are recorded but not replayable.",
    "Multi-agent child threads are separate rollouts: each is captured as its own agent session linked to the spawning thread's session (its own cwd binds it to a project), and the history a forked child replays from its parent is not captured again.",
    "Compaction boundaries are captured, but Codex does not record the token count after compaction.",
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probeCodexInstallation({
      customConfigPath: targetPath,
      env: { ...env, HOME: home },
      userHome: home,
    }),
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
};
