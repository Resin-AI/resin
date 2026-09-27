import type { HarnessDefinition, HarnessMcpServerDescriptor } from "@resin/harness-contracts";
import { OmpHarnessAdapter } from "./adapter.js";
import { OmpRecordDecoder } from "./decoder.js";
import { readConfiguredOmpServers } from "./device-surface.js";
import { ompInstallHarness } from "./install.js";
import { invokeOmpNativeTool } from "./native-tool-invoker.js";

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
  ...ompInstallHarness,
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
