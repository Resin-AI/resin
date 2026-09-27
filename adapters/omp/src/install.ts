import path from "node:path";
import type { HarnessInstallDefinition } from "@resin/harness-contracts";
import { planOmpMcpConfig } from "./config-planner.js";
import { OMP_TESTED_VERSIONS, probeOmpInstallation } from "./discovery.js";
import {
  OMP_GUIDANCE_MARKERS,
  OMP_RESIN_GUIDANCE,
  resolveOmpConfigHome,
  resolveOmpGuidancePath,
} from "./instructions.js";

export const ompInstallHarness: HarnessInstallDefinition = {
  id: "omp",
  displayName: "Oh My Pi (OMP)",
  shortName: "Oh My Pi",
  adapterPackage: "@resin/adapter-omp",
  testedVersions: OMP_TESTED_VERSIONS,
  knownLimits: [
    "Subagent sessions are learned as their own sessions; a workflow split between a parent and its subagents is not learned as one tool.",
    "Built-in tool replay runs the OMP SDK Resin pins (18.3.2) under Bun; a built-in that SDK does not export fails with an explicit error.",
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probeOmpInstallation({ customConfigPath: targetPath, env, homeDir: home }),
  mcpConfig: {
    resolvePath: (home, env) => path.join(resolveOmpConfigHome(home, env), "agent", "mcp.json"),
    uninstallPaths: (home, env) => {
      const activeHome = resolveOmpConfigHome(home, env);
      return [
        path.join(activeHome, "agent", "mcp.json"),
        path.join(activeHome, "config.json"),
        path.join(home, ".omp", "agent", "mcp.json"),
        path.join(home, ".omp", "config.json"),
      ];
    },
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcpServers"],
    transports: ["stdio", "sse", "websocket", "http"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planOmpMcpConfig({ customConfigPath: targetPath, command, args: [...args], fsBridge }),
  },
  guidance: {
    resolvePath: resolveOmpGuidancePath,
    markers: OMP_GUIDANCE_MARKERS,
    body: OMP_RESIN_GUIDANCE,
  },
};
