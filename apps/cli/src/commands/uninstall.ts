import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  type ConfigFsBridge,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
} from "@resin/harness-contracts";
import { resolvePaths } from "@resin/observer";
import { HarnessConfigOrchestrator } from "../installer/harness-config.js";
import { createUserServiceManager } from "../service/manager.js";
export type McpServerConfigValue =
  | string
  | number
  | boolean
  | null
  | McpServerConfigValue[]
  | { [key: string]: McpServerConfigValue };

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
  [key: string]: McpServerConfigValue | undefined;
}

export type McpServersRecord = Record<string, McpServerConfig>;

export interface HarnessJsonConfig {
  mcpServers?: McpServersRecord;
  mcp_servers?: McpServersRecord;
  [key: string]: McpServersRecord | McpServerConfigValue | undefined;
}

export interface TomlRemovalResult {
  content: string;
  modified: boolean;
}

function cleanMcpContainer(mcp: McpServersRecord): boolean {
  let modified = false;
  if ("resin" in mcp) {
    delete mcp.resin;
    modified = true;
  }
  for (const alias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    if (alias in mcp && isRecognizedResinMcpEntry(mcp[alias])) {
      delete mcp[alias];
      modified = true;
    }
  }
  return modified;
}

export interface UninstallCommandFlags {
  purgeData?: boolean;
  purgeSecrets?: boolean;
  purgeAll?: boolean;
  dryRun?: boolean;
  nonInteractive?: boolean;
  json?: boolean;
  home?: string;
  help?: boolean;
}

export interface UninstallResult {
  success: boolean;
  dryRun: boolean;
  serviceUninstalled: boolean;
  harnessesCleaned: string[];
  purgedData: boolean;
  purgedSecrets: boolean;
  purgedAll: boolean;
  removedPaths: string[];
  error?: string;
}

export function parseUninstallFlags(args: string[]): UninstallCommandFlags {
  const flags: UninstallCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--non-interactive" || arg === "-y" || arg === "--yes") {
      flags.nonInteractive = true;
    } else if (arg === "--purge-data") {
      flags.purgeData = true;
    } else if (arg === "--purge-secrets") {
      flags.purgeSecrets = true;
    } else if (arg === "--purge-all" || arg === "--all") {
      flags.purgeAll = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    }
  }
  return flags;
}

export function printUninstallHelp(): void {
  const text = `
Usage:
  resin uninstall [options]

Stops and removes the Resin background daemon service and removes Resin
MCP gateway registrations from all installed AI agent harnesses.

Options:
  --purge-data        Delete state databases, telemetry, and log files.
  --purge-secrets     Delete secure secret vault and cached cloud credentials.
  --purge-all, --all  Purge all Resin state, secrets, and directories completely.
  --dry-run           Simulate uninstallation without modifying files or services.
  -y, --yes           Skip confirmation prompts.
  --json              Output result in structured JSON format.
  --home <path>       Custom Resin home directory (overrides ~/.resin).
  -h, --help          Show this help message.
`;
  process.stdout.write(text.trimStart());
}

/**
 * Removes Resin MCP configuration from known harness config files.
 */
export async function removeHarnessMcpConfigurations(options: {
  customHome?: string;
  fsBridge?: ConfigFsBridge;
}): Promise<string[]> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const home = options.customHome ?? os.homedir();
  const cleaned: string[] = [];

  // 1. Claude Code (~/.claude.json)
  const claudePaths = [path.join(home, ".claude.json"), path.join(home, ".claude", "config.json")];
  for (const cPath of claudePaths) {
    const content = await fsBridge.readFile(cPath);
    if (content) {
      try {
        const parsed: HarnessJsonConfig = JSON.parse(content);
        if (parsed.mcpServers && !Array.isArray(parsed.mcpServers)) {
          const modified = cleanMcpContainer(parsed.mcpServers);
          if (modified) {
            await fsBridge.writeFile(cPath, `${JSON.stringify(parsed, null, 2)}\n`);
            cleaned.push("Claude Code");
            break;
          }
        }
      } catch {
        // Continue
      }
    }
  }

  // 2. Codex CLI (~/.codex/config.toml and ~/.codex/config.json)
  const codexPath = path.join(home, ".codex", "config.toml");
  const codexContent = await fsBridge.readFile(codexPath);
  if (codexContent) {
    const removal = removeResinFromCodexToml(codexContent);
    if (removal.modified) {
      await fsBridge.writeFile(codexPath, removal.content);
      cleaned.push("Codex CLI");
    }
  }

  const codexJsonPath = path.join(home, ".codex", "config.json");
  const codexJsonContent = await fsBridge.readFile(codexJsonPath);
  if (codexJsonContent) {
    try {
      const parsed: HarnessJsonConfig = JSON.parse(codexJsonContent);
      let modified = false;
      if (parsed.mcp_servers && !Array.isArray(parsed.mcp_servers)) {
        if (cleanMcpContainer(parsed.mcp_servers)) modified = true;
      }
      if (parsed.mcpServers && !Array.isArray(parsed.mcpServers)) {
        if (cleanMcpContainer(parsed.mcpServers)) modified = true;
      }
      if (modified) {
        await fsBridge.writeFile(codexJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
        if (!cleaned.includes("Codex CLI")) {
          cleaned.push("Codex CLI");
        }
      }
    } catch {
      // Continue
    }
  }

  // 3. OMP (~/.omp/agent/mcp.json and legacy ~/.omp/config.json)
  const ompPaths = [
    path.join(home, ".omp", "agent", "mcp.json"),
    path.join(home, ".omp", "config.json"),
  ];
  let ompCleaned = false;
  for (const oPath of ompPaths) {
    const ompContent = await fsBridge.readFile(oPath);
    if (ompContent) {
      try {
        const parsed: HarnessJsonConfig = JSON.parse(ompContent);
        if (parsed.mcpServers && !Array.isArray(parsed.mcpServers)) {
          if (cleanMcpContainer(parsed.mcpServers)) {
            await fsBridge.writeFile(oPath, `${JSON.stringify(parsed, null, 2)}\n`);
            cleaned.push(`Oh My Pi (${path.basename(oPath)})`);
            ompCleaned = true;
          }
        }
      } catch {
        // Continue
      }
    }
  }
  if (ompCleaned) {
    cleaned.push("Oh My Pi (OMP)");
  }

  return cleaned;
}

function removeResinFromCodexToml(content: string): TomlRemovalResult {
  let updated = content;
  let modified = false;

  // 1. Remove canonical resin sections: [mcp_servers.resin], [mcpServers.resin], etc.
  const canonicalSectionRegex =
    /^[ \t]*\[[ \t]*(?:mcp_servers|mcpServers|mcp\.servers)[ \t]*\.[ \t]*(?:"resin"|'resin'|resin)[ \t]*\][ \t]*(?:\r?\n)?/m;
  let match = updated.match(canonicalSectionRegex);
  while (match && match.index !== undefined) {
    modified = true;
    const startIndex = match.index;
    const afterHeader = startIndex + match[0].length;
    const rest = updated.slice(afterHeader);
    const nextSection = rest.match(/^[ \t]*\[/m);
    const sectionEnd =
      nextSection && nextSection.index !== undefined
        ? afterHeader + nextSection.index
        : updated.length;
    updated = `${updated.slice(0, startIndex)}${updated.slice(sectionEnd)}`;
    match = updated.match(canonicalSectionRegex);
  }

  // 2. Remove recognized legacy alias sections: [mcp_servers.resin_gateway], etc.
  for (const alias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    const aliasRegex = new RegExp(
      `^[ \\t]*\\[[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${alias}"|'${alias}'|${alias})[ \\t]*\\][ \\t]*(?:\\r?\\n)?`,
      "m",
    );
    let aliasMatch = updated.match(aliasRegex);
    while (aliasMatch && aliasMatch.index !== undefined) {
      const startIndex = aliasMatch.index;
      const afterHeader = startIndex + aliasMatch[0].length;
      const rest = updated.slice(afterHeader);
      const nextSection = rest.match(/^[ \t]*\[/m);
      const sectionEnd =
        nextSection && nextSection.index !== undefined
          ? afterHeader + nextSection.index
          : updated.length;
      const sectionBody = updated.slice(afterHeader, sectionEnd);
      const urlMatch = sectionBody.match(/^[ \t]*url[ \t]*=[ \t]*["']([^"']+)["']/m);
      const commandMatch = sectionBody.match(/^[ \t]*command[ \t]*=[ \t]*["']([^"']+)["']/m);
      const entryObj = {
        url: urlMatch ? urlMatch[1] : undefined,
        command: commandMatch ? commandMatch[1] : undefined,
      };
      if (isRecognizedResinMcpEntry(entryObj)) {
        modified = true;
        updated = `${updated.slice(0, startIndex)}${updated.slice(sectionEnd)}`;
      } else {
        break;
      }
      aliasMatch = updated.match(aliasRegex);
    }
  }

  // 3. Remove dotted inline table entries: mcp_servers.resin = { ... }
  const dottedCanonicalRegex =
    /^[ \t]*(?:mcp_servers|mcpServers|mcp\.servers)[ \t]*\.[ \t]*(?:"resin"|'resin'|resin)[ \t]*=[ \t]*\{[^}]*\}[ \t]*(?:\r?\n)?/m;
  let dottedMatch = updated.match(dottedCanonicalRegex);
  while (dottedMatch && dottedMatch.index !== undefined) {
    modified = true;
    updated = `${updated.slice(0, dottedMatch.index)}${updated.slice(dottedMatch.index + dottedMatch[0].length)}`;
    dottedMatch = updated.match(dottedCanonicalRegex);
  }

  return { content: updated, modified };
}

export async function uninstallCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
  } = {},
): Promise<number> {
  const flags = parseUninstallFlags(args);

  if (flags.help) {
    printUninstallHelp();
    return 0;
  }

  const customHome = flags.home ? path.resolve(flags.home) : os.homedir();
  const resinHome = path.join(customHome, ".resin");
  const daemonPaths = resolvePaths({ home: customHome });
  const fsBridge = options.fsBridge ?? defaultFsBridge;

  const removedPaths: string[] = [];

  if (flags.dryRun) {
    const dryRunResult: UninstallResult = {
      success: true,
      dryRun: true,
      serviceUninstalled: true,
      harnessesCleaned: ["Claude Code", "Codex CLI", "Oh My Pi (OMP)"],
      purgedData: Boolean(flags.purgeData || flags.purgeAll),
      purgedSecrets: Boolean(flags.purgeSecrets || flags.purgeAll),
      purgedAll: Boolean(flags.purgeAll),
      removedPaths: flags.purgeAll ? [resinHome] : [],
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(dryRunResult, null, 2)}\n`);
    } else {
      process.stdout.write("\n[DRY-RUN] Simulated uninstallation:\n");
      process.stdout.write("  • User background service would be stopped and removed.\n");
      process.stdout.write("  • Harness MCP entries would be cleaned up.\n");
      if (flags.purgeAll) {
        process.stdout.write(`  • Entire ${resinHome} directory would be purged.\n`);
      }
      process.stdout.write("\n");
    }
    return 0;
  }

  try {
    // 1. Stop and uninstall user background service
    const serviceManager = createUserServiceManager({
      homeDir: customHome,
      resinHome,
      fsBridge,
    });
    const svcUninstallResult = await serviceManager.uninstall();

    // 2. Remove Resin MCP configuration from all agent harnesses
    const cleanedHarnesses = await removeHarnessMcpConfigurations({
      customHome,
      fsBridge,
    });

    // 3. Purge data / secrets / all if requested
    const purgeAll = Boolean(flags.purgeAll);
    const purgeData = Boolean(flags.purgeData || purgeAll);
    const purgeSecrets = Boolean(flags.purgeSecrets || purgeAll);

    if (purgeAll) {
      if (await fsBridge.exists(resinHome)) {
        await fs.rm(resinHome, { recursive: true, force: true }).catch(() => {});
        removedPaths.push(resinHome);
      }
    } else {
      if (purgeData) {
        const dataDirs = [
          daemonPaths.dataDir,
          daemonPaths.logDir,
          path.join(resinHome, "artifacts"),
        ];
        for (const dir of dataDirs) {
          if (await fsBridge.exists(dir)) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
            removedPaths.push(dir);
          }
        }
      }
      if (purgeSecrets) {
        const secretDirs = [
          path.join(resinHome, "vault"),
          path.join(resinHome, "state", "device-token.json"),
        ];
        for (const target of secretDirs) {
          if (await fsBridge.exists(target)) {
            await fs.rm(target, { recursive: true, force: true }).catch(() => {});
            removedPaths.push(target);
          }
        }
      }
    }

    const result: UninstallResult = {
      success: true,
      dryRun: false,
      serviceUninstalled: svcUninstallResult.success,
      harnessesCleaned: cleanedHarnesses,
      purgedData: purgeData,
      purgedSecrets: purgeSecrets,
      purgedAll: purgeAll,
      removedPaths,
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write("\n✓ Resin uninstalled successfully.\n");
      process.stdout.write("  • Service stopped and unit removed.\n");
      if (cleanedHarnesses.length > 0) {
        process.stdout.write(
          `  • Removed MCP configurations for: ${cleanedHarnesses.join(", ")}\n`,
        );
      }
      if (purgeAll) {
        process.stdout.write(`  • Purged directory: ${resinHome}\n`);
      } else {
        if (purgeData) process.stdout.write("  • Data and log files purged.\n");
        if (purgeSecrets) process.stdout.write("  • Secrets and credentials purged.\n");
        if (!purgeData && !purgeSecrets) {
          process.stdout.write("  • Data and credentials preserved in ~/.resin\n");
        }
      }
      process.stdout.write("\n");
    }

    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ error: msg, success: false }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nUninstall failed: ${msg}\n`);
    }
    return 1;
  }
}
