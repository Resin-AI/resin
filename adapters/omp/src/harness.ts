import path from "node:path";
import type { HarnessDefinition, HarnessMcpServerDescriptor } from "@resin/harness-contracts";
import { OmpHarnessAdapter } from "./adapter.js";
import { planOmpMcpConfig } from "./config-planner.js";
import { OmpRecordDecoder } from "./decoder.js";
import { readConfiguredOmpServers } from "./device-surface.js";
import { OMP_TESTED_VERSIONS, probeOmpInstallation } from "./discovery.js";
import { invokeOmpNativeTool } from "./native-tool-invoker.js";

function resolveOmpConfigHome(home: string, env: NodeJS.ProcessEnv): string {
  const configuredHome = [env.OMP_HOME, env.RESIN_OMP_HOME].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  return configuredHome ? path.resolve(configuredHome) : path.join(home, ".omp");
}

/**
 * The connection OMP itself runs for a declared MCP server. A name OMP does not declare, or one
 * declared over a transport this host cannot speak, has no descriptor.
 */
function resolveOmpMcpServer(
  name: string,
  workspaceRoot: string,
): HarnessMcpServerDescriptor | undefined {
  const server = readConfiguredOmpServers({ workspaceRoot }).find((entry) => entry.name === name);
  if (server === undefined) return undefined;
  const { entry } = server;
  const transport = entry.transport ?? entry.type;
  if (entry.command !== undefined && (transport === undefined || transport === "stdio")) {
    return {
      name: server.name,
      transport: {
        kind: "stdio",
        command: entry.command,
        ...(entry.args === undefined ? {} : { args: entry.args }),
        ...(entry.env === undefined ? {} : { env: entry.env }),
      },
    };
  }
  if (entry.url !== undefined && (transport === "http" || transport === "sse")) {
    return { name: server.name, transport: { kind: "http", url: entry.url } };
  }
  return undefined;
}

export const ompHarness: HarnessDefinition = {
  id: "omp",
  displayName: "Oh My Pi (OMP)",
  shortName: "Oh My Pi",
  adapterPackage: "@resin/adapter-omp",
  testedVersions: OMP_TESTED_VERSIONS,
  knownLimits: [],
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
  createAdapter: () => new OmpHarnessAdapter({ activeOnly: false }),
  // OMP's device paths are resolved against the server names the harness itself is configured
  // with: the registry is read when a path needs it, so a server added mid-session is honored.
  createDecoder: () =>
    new OmpRecordDecoder({
      deviceSurfaceServers: () => readConfiguredOmpServers().map((server) => server.name),
    }),
  sessionCapture: "file-activity",
  resolveMcpServer: resolveOmpMcpServer,
  nativeToolInvoker: invokeOmpNativeTool,
};
