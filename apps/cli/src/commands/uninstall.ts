import os from "node:os";
import path from "node:path";
import process from "node:process";
import { applyOmpCatalogInstructions } from "@resin/adapter-omp";
import type { HarnessId } from "@resin/contracts";
import {
  type ConfigFsBridge,
  type HarnessInstallDefinition,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  applyManagedBlock,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
  resolveHarnessUserHome,
} from "@resin/harness-contracts";
import { resolvePaths } from "@resin/observer";
import {
  HARNESS_DEFINITIONS,
  getHarnessDefinition,
  isSupportedHarnessId,
} from "../harness-registry.js";
import { removeShellPath } from "../installer/bootstrap-entry.js";
import { updateHarnessHealthSettings } from "../installer/harness-health.js";
import {
  type HarnessReconcileFsBridge,
  HarnessReconciler,
  ReconciliationNodeFsBridge,
} from "../installer/harness-reconciler.js";
import {
  type WindowsUserPathOptions,
  type WindowsUserPathResult,
  removeWindowsUserPath,
} from "../installer/windows-install.js";
import { type UserServiceManager, createUserServiceManager } from "../service/manager.js";
import {
  type WindowsPurgeResult,
  purgeWindowsTree,
  removeTreeWithRetries,
  scheduleWindowsDeferredRemoval,
} from "./windows-purge.js";

export { scheduleWindowsDeferredRemoval };
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

export type HarnessJsonConfig = Record<string, McpServersRecord | McpServerConfigValue | undefined>;

function isMcpContainer(
  value: McpServersRecord | McpServerConfigValue | undefined,
): value is McpServersRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  /**
   * Harnesses (comma-separated ids) to remove Resin from, leaving the service and every other
   * harness in place. Resin then never re-registers them on its own.
   */
  harness?: string;
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
  /** Why the service could not be fully removed (e.g. the task could not be ended). */
  serviceError?: string;
  /** Paths that could not be purged (on Windows usually a file in use). */
  purgeFailures?: { path: string; error: string }[];
  /** Locked Windows paths scheduled for removal right after this process exits. */
  deferredRemoval?: string[];
  /** Failure removing Resin's bin directory from the Windows user PATH. */
  pathCleanupError?: string;
  error?: string;
}

export interface UninstallCommandOptions {
  env?: NodeJS.ProcessEnv;
  fsBridge?: ConfigFsBridge;
  platform?: NodeJS.Platform;
  serviceManager?: UserServiceManager;
  /** Removes a path recursively; rejects when it cannot (e.g. a file is in use). */
  removePath?: (target: string) => Promise<void>;
  removeWindowsUserPath?: (options: WindowsUserPathOptions) => Promise<WindowsUserPathResult>;
  /** Removes still-locked Windows paths after this process exits. */
  scheduleDeferredRemoval?: (paths: readonly string[]) => void;
  /** Deletes the Resin home on Windows, moving files that are in use out of it. */
  purgeWindowsTree?: (
    target: string,
    options: { keep: readonly string[] },
  ) => Promise<WindowsPurgeResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    } else if (arg === "--harness" && i + 1 < args.length) {
      flags.harness = args[++i];
    } else if (arg.startsWith("--harness=")) {
      flags.harness = arg.slice("--harness=".length);
    }
  }
  return flags;
}

export function printUninstallHelp(): void {
  const text = `
Usage:
  resin uninstall [options]
  resin uninstall --harness <id>[,<id>...] [--dry-run] [--json]

Stops and removes the Resin background daemon service and removes Resin
MCP gateway registrations from all installed AI agent harnesses.

With --harness, removes Resin only from the named harnesses and keeps the
service and every other harness. Resin records the choice and does not
add itself back to those harnesses; \`resin init --harness <id>\` does.

Options:
  --harness <ids>     Remove Resin from these harnesses only (e.g. omp,claude-code).
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

async function removeResinFromJsonConfig(
  configPath: string,
  containerKeys: readonly string[],
  fsBridge: ConfigFsBridge,
): Promise<boolean> {
  const content = await fsBridge.readFile(configPath);
  if (!content) {
    return false;
  }

  try {
    const parsed: HarnessJsonConfig = JSON.parse(content);
    let modified = false;
    for (const key of containerKeys) {
      const container = parsed[key];
      if (isMcpContainer(container)) {
        modified = cleanMcpContainer(container) || modified;
      }
    }
    if (modified) {
      await fsBridge.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    return modified;
  } catch {
    return false;
  }
}

/**
 * Removes Resin MCP configuration from active and legacy harness config files.
 */
export async function removeHarnessMcpConfigurations(options: {
  customHome?: string;
  env?: NodeJS.ProcessEnv;
  fsBridge?: HarnessReconcileFsBridge;
  /** Only these harnesses; all supported ones when omitted. */
  harnesses?: readonly HarnessId[];
}): Promise<string[]> {
  const fsBridge = options.fsBridge ?? new ReconciliationNodeFsBridge();
  const home = path.resolve(
    options.customHome ?? resolveHarnessUserHome({ env: options.env ?? process.env }),
  );
  const env = options.env ?? (options.customHome === undefined ? process.env : { HOME: home });
  const reconciler = new HarnessReconciler();
  const cleaned: string[] = [];

  for (const definition of HARNESS_DEFINITIONS) {
    if (options.harnesses !== undefined && !options.harnesses.includes(definition.id)) {
      continue;
    }
    if (await removeHarnessRegistration(definition, home, env, fsBridge, reconciler)) {
      cleaned.push(definition.displayName);
    }
  }

  return cleaned;
}

async function removeHarnessRegistration(
  definition: HarnessInstallDefinition,
  home: string,
  env: NodeJS.ProcessEnv,
  fsBridge: HarnessReconcileFsBridge,
  reconciler: HarnessReconciler,
): Promise<boolean> {
  const { mcpConfig } = definition;
  let cleaned = false;
  // Files Resin created and alone wrote go entirely, with Resin's backups; directories Resin
  // created for them go once everything below is removed and they are empty.
  const createdDirectories: string[] = [];
  for (const configPath of new Set(mcpConfig.uninstallPaths(home, env))) {
    const released = await reconciler.releaseOwnedConfig(configPath, fsBridge);
    cleaned = released.removedTarget || cleaned;
    createdDirectories.push(...released.createdDirectories);
  }
  if (mcpConfig.removeRegistration !== undefined) {
    cleaned = await mcpConfig.removeRegistration({ home, env, fsBridge });
  } else {
    for (const configPath of new Set(mcpConfig.uninstallPaths(home, env))) {
      if (mcpConfig.format !== "codex-toml" || configPath.endsWith(".json")) {
        cleaned =
          (await removeResinFromJsonConfig(configPath, mcpConfig.jsonContainerKeys, fsBridge)) ||
          cleaned;
        continue;
      }
      const content = await fsBridge.readFile(configPath);
      if (!content) {
        continue;
      }
      const removal = removeResinFromCodexToml(content);
      if (removal.modified) {
        await fsBridge.writeFile(configPath, removal.content);
        cleaned = true;
      }
    }
  }
  if (definition.guidance !== undefined) {
    const guidance = await applyManagedBlock(
      fsBridge,
      definition.guidance.resolvePath(home, env),
      definition.guidance.markers,
      null,
    );
    cleaned = guidance.action === "removed" || cleaned;
  }
  for (const extension of definition.installExtensions ?? []) {
    const outcomes = await extension.uninstall({ home, env, fsBridge });
    cleaned = outcomes.some((outcome) => outcome.action === "removed") || cleaned;
  }
  for (const directory of createdDirectories) {
    await fsBridge.removeDirectoryWithoutFiles?.(directory);
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
  options: UninstallCommandOptions = {},
): Promise<number> {
  const flags = parseUninstallFlags(args);

  if (flags.help) {
    printUninstallHelp();
    return 0;
  }

  const customHome = flags.home
    ? path.resolve(flags.home)
    : path.resolve(resolveHarnessUserHome({ env: options.env ?? process.env }));
  const env = { ...(options.env ?? process.env), HOME: customHome };
  const resinHome = path.join(customHome, ".resin");
  const daemonPaths = resolvePaths({ home: customHome });
  const fsBridge = options.fsBridge ?? defaultFsBridge;

  if (flags.harness !== undefined) {
    return uninstallFromHarnesses(flags, { customHome, env, fsBridge: options.fsBridge });
  }

  const removedPaths: string[] = [];
  const purgeFailures: { path: string; error: string }[] = [];
  const platform = options.platform ?? process.platform;
  const removePath = options.removePath ?? ((target: string) => removeTreeWithRetries(target));
  const purge = async (target: string): Promise<void> => {
    try {
      await removePath(target);
      removedPaths.push(target);
    } catch (error: unknown) {
      purgeFailures.push({ path: target, error: errorMessage(error) });
    }
  };

  if (flags.dryRun) {
    const dryRunResult: UninstallResult = {
      success: true,
      dryRun: true,
      serviceUninstalled: true,
      harnessesCleaned: HARNESS_DEFINITIONS.map((definition) => definition.displayName),
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
    const serviceManager =
      options.serviceManager ??
      createUserServiceManager({
        homeDir: customHome,
        resinHome,
        fsBridge,
      });
    const svcUninstallResult = await serviceManager.uninstall().catch((error: unknown) => ({
      success: false,
      error: errorMessage(error),
    }));

    // Nothing to remove (no definition under this home) is not a failure; a service
    // that is still registered, or whose state cannot be read, is.
    const serviceRemoved =
      svcUninstallResult.success ||
      serviceManager.platform === "external" ||
      !(await serviceManager.isInstalled().catch(() => true));

    // 2. Remove Resin MCP configuration from all agent harnesses
    const cleanedHarnesses = await removeHarnessMcpConfigurations({
      customHome,
      env,
      fsBridge: options.fsBridge,
    });

    // 3. Purge data / secrets / all if requested
    const purgeAll = Boolean(flags.purgeAll);
    const purgeData = Boolean(flags.purgeData || purgeAll);
    const purgeSecrets = Boolean(flags.purgeSecrets || purgeAll);

    let cleanedProfiles: string[] = [];
    let deferredRemoval: string[] = [];
    let pathCleanupError: string | undefined;
    if (purgeAll) {
      if (platform === "win32") {
        const removeUserPath = options.removeWindowsUserPath ?? removeWindowsUserPath;
        try {
          const pathResult = await removeUserPath({ resinHome, platform });
          if (pathResult.error !== undefined) {
            pathCleanupError = pathResult.error;
          } else if (pathResult.present) {
            pathCleanupError = `${pathResult.binDir} is still on the user PATH`;
          }
        } catch (error: unknown) {
          pathCleanupError = errorMessage(error);
        }
      }
      if (platform === "win32") {
        // This process runs from the Resin home (the security addon is mapped from
        // versions\, and resin.cmd's shell holds bin\): files in use are moved out and
        // removed, with anything unmovable, once this process has exited.
        const deferred: string[] = [];
        try {
          // bin\ holds the resin.cmd that cmd.exe is still running; the cleanup removes it
          // (and with it the Resin home) right after this process exits.
          const purged = await (options.purgeWindowsTree ?? purgeWindowsTree)(resinHome, {
            keep: [path.join(resinHome, "bin")],
          });
          if (purged.removed) {
            removedPaths.push(resinHome);
          } else {
            deferred.push(resinHome);
          }
          if (purged.stagingDir !== undefined) deferred.push(purged.stagingDir);
        } catch (error: unknown) {
          purgeFailures.push({ path: resinHome, error: errorMessage(error) });
        }
        if (deferred.length > 0) {
          try {
            (options.scheduleDeferredRemoval ?? scheduleWindowsDeferredRemoval)(deferred);
            deferredRemoval = deferred;
          } catch (error: unknown) {
            for (const target of deferred) {
              purgeFailures.push({
                path: target,
                error: `in use; deferred removal failed: ${errorMessage(error)}`,
              });
            }
          }
        }
      } else if (await fsBridge.exists(resinHome)) {
        await purge(resinHome);
      }
      cleanedProfiles = await removeShellPath({ resinHome, homeDir: customHome, fsBridge });
    } else {
      if (purgeData) {
        const dataDirs = [
          daemonPaths.dataDir,
          daemonPaths.logDir,
          path.join(resinHome, "artifacts"),
        ];
        for (const dir of dataDirs) {
          if (await fsBridge.exists(dir)) {
            await purge(dir);
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
            await purge(target);
          }
        }
      }
    }

    const result: UninstallResult = {
      // A service left registered (and running from the Resin home) is a failed uninstall.
      success: serviceRemoved && purgeFailures.length === 0 && pathCleanupError === undefined,
      dryRun: false,
      serviceUninstalled: svcUninstallResult.success,
      harnessesCleaned: cleanedHarnesses,
      purgedData: purgeData,
      purgedSecrets: purgeSecrets,
      purgedAll: purgeAll,
      removedPaths,
    };
    if (!svcUninstallResult.success && svcUninstallResult.error !== undefined) {
      result.serviceError = svcUninstallResult.error;
    }
    if (purgeFailures.length > 0) {
      result.purgeFailures = purgeFailures;
      result.error = `Could not remove: ${purgeFailures.map((failure) => failure.path).join(", ")}`;
    }
    if (deferredRemoval.length > 0) {
      result.deferredRemoval = deferredRemoval;
    }
    if (pathCleanupError !== undefined) {
      result.pathCleanupError = pathCleanupError;
      result.error = result.error
        ? `${result.error}; PATH cleanup failed: ${pathCleanupError}`
        : `PATH cleanup failed: ${pathCleanupError}`;
    }

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        result.success
          ? "\n✓ Resin uninstalled successfully.\n"
          : "\n✗ Resin uninstall finished with errors.\n",
      );
      if (svcUninstallResult.success) {
        process.stdout.write("  • Service stopped and unit removed.\n");
      } else {
        process.stdout.write(
          `  • Background service was not fully removed: ${result.serviceError ?? "unknown error"}\n`,
        );
      }
      for (const failure of purgeFailures) {
        process.stdout.write(`  • Could not remove ${failure.path}: ${failure.error}\n`);
      }
      for (const target of deferredRemoval) {
        process.stdout.write(
          `  • ${target} is in use; it will be removed a few seconds after this command exits.\n`,
        );
      }
      if (pathCleanupError !== undefined) {
        process.stdout.write(`  • Could not remove Resin from your PATH: ${pathCleanupError}\n`);
      }
      if (cleanedHarnesses.length > 0) {
        process.stdout.write(
          `  • Removed MCP configurations for: ${cleanedHarnesses.join(", ")}\n`,
        );
      }
      if (purgeAll) {
        process.stdout.write(`  • Purged directory: ${resinHome}\n`);
        for (const profilePath of cleanedProfiles) {
          process.stdout.write(`  • Removed Resin PATH entry from ${profilePath}\n`);
        }
      } else {
        if (purgeData) process.stdout.write("  • Data and log files purged.\n");
        if (purgeSecrets) process.stdout.write("  • Secrets and credentials purged.\n");
        if (!purgeData && !purgeSecrets) {
          process.stdout.write("  • Data and credentials preserved in ~/.resin\n");
        }
      }
      process.stdout.write("\n");
    }

    return result.success ? 0 : 1;
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

/**
 * `resin uninstall --harness <ids>`: removes Resin from the named harnesses only and records
 * the opt-out first, so the resident daemon's repair never races the removal and never adds
 * Resin back. The service, other harnesses and Resin's data stay.
 */
async function uninstallFromHarnesses(
  flags: UninstallCommandFlags,
  options: {
    readonly customHome: string;
    readonly env: NodeJS.ProcessEnv;
    readonly fsBridge: HarnessReconcileFsBridge | undefined;
  },
): Promise<number> {
  const fail = (message: string): number => {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ success: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nUninstall failed: ${message}\n`);
    }
    return 1;
  };
  const requested = (flags.harness ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const unsupported = requested.filter((value) => !isSupportedHarnessId(value));
  if (requested.length === 0 || unsupported.length > 0) {
    const supported = HARNESS_DEFINITIONS.map((definition) => definition.id).join(", ");
    return fail(
      requested.length === 0
        ? `--harness needs at least one harness id (${supported})`
        : `Unsupported harness '${unsupported.join("', '")}' (supported: ${supported})`,
    );
  }
  if (flags.purgeData || flags.purgeSecrets || flags.purgeAll) {
    return fail("--harness cannot be combined with --purge-data, --purge-secrets or --purge-all");
  }
  const harnesses = HARNESS_DEFINITIONS.filter((definition) =>
    requested.includes(definition.id),
  ).map((definition) => definition.id);
  const names = harnesses.map((harnessId) => getHarnessDefinition(harnessId).displayName);

  if (flags.dryRun) {
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ success: true, dryRun: true, disabledHarnesses: harnesses, harnessesCleaned: names }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `\n[DRY-RUN] Resin would be removed from ${names.join(", ")} and not added back automatically.\n\n`,
      );
    }
    return 0;
  }

  try {
    await updateHarnessHealthSettings(
      { disableHarnesses: harnesses },
      { home: options.customHome, fsBridge: options.fsBridge },
    );
    const cleaned = await removeHarnessMcpConfigurations({
      customHome: options.customHome,
      env: options.env,
      fsBridge: options.fsBridge,
      harnesses,
    });
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ success: true, dryRun: false, disabledHarnesses: harnesses, harnessesCleaned: cleaned }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`\n✓ Resin removed from ${names.join(", ")}.\n`);
      process.stdout.write(
        "  • Resin will not add itself back to these harnesses. Running sessions keep Resin until they restart.\n",
      );
      process.stdout.write(`  • To add it back: resin init --harness ${harnesses.join(",")}\n\n`);
    }
    return 0;
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
