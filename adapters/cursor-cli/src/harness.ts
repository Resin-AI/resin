import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessDefinition, HarnessMcpServerDescriptor } from "@resin/harness-contracts";
import { CursorHarnessAdapter } from "./adapter.js";
import { CursorRecordDecoder } from "./decoder.js";
import { isRecord } from "./guards.js";
import { cursorInstallHarness } from "./install.js";
import { resolveCursorMcpConfigPath } from "./paths.js";

function readMcpServers(filePath: string): Record<string, unknown> {
  try {
    const doc: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : {};
  } catch {
    return {};
  }
}

/**
 * The connection cursor-agent runs for a declared MCP server: the project's
 * `.cursor/mcp.json` wins over the user-level `~/.cursor/mcp.json`, as in cursor-agent's loader.
 */
export function resolveCursorMcpServer(
  name: string,
  workspaceRoot: string,
  home: string = os.homedir(),
): HarnessMcpServerDescriptor | undefined {
  const entry =
    readMcpServers(path.join(workspaceRoot, ".cursor", "mcp.json"))[name] ??
    readMcpServers(resolveCursorMcpConfigPath(home))[name];
  if (!isRecord(entry)) return undefined;
  if (typeof entry.command === "string" && (entry.type === undefined || entry.type === "stdio")) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg) => typeof arg === "string")
      : undefined;
    const env = isRecord(entry.env)
      ? Object.fromEntries(
          Object.entries(entry.env).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          ),
        )
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
  if (typeof entry.url === "string") return { name, transport: { kind: "http", url: entry.url } };
  return undefined;
}

export const cursorHarness: HarnessDefinition = {
  ...cursorInstallHarness,
  createAdapter: () => new CursorHarnessAdapter(),
  createDecoder: () => new CursorRecordDecoder(),
  sessionCapture: "file-activity",
  resolveMcpServer: (name, workspaceRoot) => resolveCursorMcpServer(name, workspaceRoot),
};
