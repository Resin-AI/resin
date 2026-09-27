import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessDefinition, HarnessMcpServerDescriptor } from "@resin/harness-contracts";
import { GrokHarnessAdapter } from "./adapter.js";
import { readGrokTomlServer } from "./config-planner.js";
import { GrokRecordDecoder } from "./decoder.js";
import { grokBuildInstallHarness } from "./install.js";
import { resolveGrokConfigPath } from "./paths.js";

function readServer(configPath: string, name: string): HarnessMcpServerDescriptor | undefined {
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
  const entry = readGrokTomlServer(content, name);
  if (entry?.command) {
    return { name, transport: { kind: "stdio", command: entry.command, args: entry.args ?? [] } };
  }
  return entry?.url ? { name, transport: { kind: "http", url: entry.url } } : undefined;
}

export const grokBuildHarness: HarnessDefinition = {
  ...grokBuildInstallHarness,
  createAdapter: () => new GrokHarnessAdapter(),
  createDecoder: () => new GrokRecordDecoder(),
  // Headless runs exit right away and `--resume` appends to old sessions, so capture follows
  // transcript activity rather than session creation time.
  sessionCapture: "file-activity",
  // Project `.grok/config.toml` overrides the user config (grok-build `util/config/mcp.rs`).
  resolveMcpServer: (name, workspaceRoot) =>
    readServer(path.join(workspaceRoot, ".grok", "config.toml"), name) ??
    readServer(resolveGrokConfigPath(os.homedir(), process.env), name),
};
