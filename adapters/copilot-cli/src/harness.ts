import { readFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { HarnessDefinition, HarnessMcpServerDescriptor } from "@resin/harness-contracts";
import { CopilotHarnessAdapter } from "./adapter.js";
import { CopilotRecordDecoder } from "./decoder.js";
import { resolveCopilotMcpConfigPath } from "./discovery.js";
import { copilotInstallHarness } from "./install.js";

interface CopilotServerEntry {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
}

function readServers(filePath: string): Record<string, CopilotServerEntry> {
  try {
    const doc = JSON.parse(readFileSync(filePath, "utf8")) as { mcpServers?: unknown };
    const servers = doc.mcpServers;
    return servers !== null && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, CopilotServerEntry>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The connection Copilot runs for a server it declares: workspace `.mcp.json` /
 * `.github/mcp.json`, then the user's `mcp-config.json`. `local`/`stdio` entries spawn a command;
 * `http`/`sse` entries use their URL.
 */
function resolveCopilotMcpServer(
  name: string,
  workspaceRoot: string,
): HarnessMcpServerDescriptor | undefined {
  const sources = [
    path.join(workspaceRoot, ".mcp.json"),
    path.join(workspaceRoot, ".github", "mcp.json"),
    resolveCopilotMcpConfigPath(os.homedir(), process.env),
  ];
  for (const source of sources) {
    const entry = readServers(source)[name];
    if (!entry) continue;
    const type = entry.type ?? "local";
    if ((type === "local" || type === "stdio") && typeof entry.command === "string") {
      const args = Array.isArray(entry.args) ? entry.args.map(String) : undefined;
      const env =
        entry.env !== null && typeof entry.env === "object" && !Array.isArray(entry.env)
          ? Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)]))
          : undefined;
      return {
        name,
        transport: {
          kind: "stdio",
          command: entry.command,
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
        },
      };
    }
    if ((type === "http" || type === "sse") && typeof entry.url === "string") {
      return { name, transport: { kind: "http", url: entry.url } };
    }
    return undefined;
  }
  return undefined;
}

export const copilotHarness: HarnessDefinition = {
  ...copilotInstallHarness,
  createAdapter: () => new CopilotHarnessAdapter(),
  createDecoder: () => new CopilotRecordDecoder(),
  sessionCapture: "file-activity",
  resolveMcpServer: resolveCopilotMcpServer,
};
