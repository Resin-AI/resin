import * as path from "node:path";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { OmpHarnessAdapter } from "./adapter.js";
import { DEFAULT_GATEWAY_SERVER_NAME, planOmpMcpConfig } from "./config-planner.js";
import { OmpRecordDecoder } from "./decoder.js";
import { resolveOmpMcpServer } from "./device-surface.js";
import { probeOmpInstallation } from "./discovery.js";
import { invokeOmpNativeTool } from "./native-tool-invoker.js";
import { OMP_TESTED_VERSIONS } from "./versions.js";

function resolveOmpAgentHome(home: string, env: NodeJS.ProcessEnv): string {
  const configured = [env.OMP_HOME, env.RESIN_OMP_HOME].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  return configured ? path.resolve(configured) : path.join(home, ".omp");
}

export const ompHarness: HarnessDefinition = {
  id: "omp",
  displayName: "Oh My Pi (OMP)",
  shortName: "OMP",
  adapterPackage: "@resin/adapter-omp",
  testedVersions: OMP_TESTED_VERSIONS,
  knownLimits: [
    "Subagent sessions are captured as their own sessions; a workflow spanning a parent and its subagents is learned per session, not as one execution.",
    "Built-in tool replay needs Bun and the OMP SDK pinned by Resin; a built-in the SDK no longer exports fails with an explicit error.",
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probeOmpInstallation({ customConfigPath: targetPath, env, homeDir: home }),
  mcpConfig: {
    resolvePath: (home, env) => path.join(resolveOmpAgentHome(home, env), "agent", "mcp.json"),
    uninstallPaths: (home, env) => {
      const active = resolveOmpAgentHome(home, env);
      return [
        ...new Set([
          path.join(active, "agent", "mcp.json"),
          path.join(active, "config.json"),
          path.join(home, ".omp", "agent", "mcp.json"),
          path.join(home, ".omp", "config.json"),
        ]),
      ];
    },
    format: "json",
    serverKey: DEFAULT_GATEWAY_SERVER_NAME,
    jsonContainerKeys: ["mcpServers"],
    transports: ["stdio", "sse", "http", "websocket"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planOmpMcpConfig({ customConfigPath: targetPath, command, args: [...args], fsBridge }),
  },
  createAdapter: () => new OmpHarnessAdapter({ activeOnly: false }),
  createDecoder: () => new OmpRecordDecoder(),
  sessionCapture: "file-activity",
  resolveMcpServer: resolveOmpMcpServer,
  nativeToolInvoker: invokeOmpNativeTool,
};
