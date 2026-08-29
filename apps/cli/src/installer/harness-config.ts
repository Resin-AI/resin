import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { planClaudeMcpConfig, probeClaudeInstallation } from "@resin/adapter-claude-code";
import { planCodexMcpConfig, probeCodexInstallation } from "@resin/adapter-codex";
import { planOmpMcpConfig, probeOmpInstallation } from "@resin/adapter-omp";
import {
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type HarnessInstallation,
  type HarnessWorkspace,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  isRecognizedResinMcpEntry,
} from "@resin/harness-contracts";
import { parse as parseToml } from "smol-toml";

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:9400/mcp/sse";

export const SUPPORTED_HARNESS_IDS = ["claude-code", "codex-cli", "omp"] as const;
export type SupportedHarnessId = (typeof SUPPORTED_HARNESS_IDS)[number];

export type HarnessConfigValue =
  | string
  | number
  | boolean
  | null
  | HarnessConfigValue[]
  | { [key: string]: HarnessConfigValue };

export type HarnessConfigRecord = Record<string, HarnessConfigValue>;

function isConfigObject(
  value: HarnessConfigValue | undefined | null,
): value is HarnessConfigRecord {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export const HARNESS_DISPLAY_NAMES = {
  "claude-code": "Claude Code CLI",
  "codex-cli": "Codex CLI",
  omp: "Oh My Pi (OMP)",
} as const satisfies Readonly<Record<SupportedHarnessId, string>>;

export const RESIN_MCP_SERVER_KEYS = {
  "claude-code": "resin",
  "codex-cli": "resin",
  omp: "resin",
} as const satisfies Readonly<Record<SupportedHarnessId, string>>;

export interface HarnessConfigResult {
  readonly harnessId: SupportedHarnessId;
  readonly displayName: string;
  readonly installed: boolean;
  readonly configured: boolean;
  readonly wasAlreadyConfigured: boolean;
  readonly targetPath?: string;
  readonly plan?: ConfigMutationPlan;
  readonly backup?: ConfigBackup;
  readonly error?: string;
}

export interface MultiHarnessConfigOptions {
  harnesses?: SupportedHarnessId[];
  workspacePath?: string;
  gatewayUrl?: string;
  customHome?: string;
  fsBridge?: ConfigFsBridge;
  dryRun?: boolean;
  probeHarness?: (options: HarnessProbeOptions) => Promise<HarnessInstallation | null>;
  onHarnessDiscovered?: (harness: HarnessInstallation) => void;
  onPlanCreated?: (plan: ConfigMutationPlan) => void;
}

export interface HarnessAdapterOperationOptions {
  readonly harnessId: SupportedHarnessId;
  readonly targetPath: string;
  readonly workspacePath: string;
  readonly gatewayUrl: string;
  readonly fsBridge: ConfigFsBridge;
}

export interface HarnessProbeOptions {
  readonly harnessId: SupportedHarnessId;
  readonly targetPath: string;
  readonly customHome: string;
  readonly fsBridge: ConfigFsBridge;
}

/**
 * Resolves the canonical global MCP configuration path managed by each supported harness.
 */
export function resolveHarnessConfigPath(
  harnessId: SupportedHarnessId,
  customHome: string,
): string {
  switch (harnessId) {
    case "claude-code":
      return path.join(customHome, ".claude", "claude.json");
    case "codex-cli":
      return path.join(customHome, ".codex", "config.toml");
    case "omp":
      return path.join(customHome, ".omp", "agent", "mcp.json");
  }
}

/**
 * Probes one harness while pinning discovery to Resin's canonical global config path.
 */
export async function probeHarnessInstallation(
  options: HarnessProbeOptions,
): Promise<HarnessInstallation | null> {
  switch (options.harnessId) {
    case "claude-code":
      return probeClaudeInstallation({ customConfigPath: options.targetPath }, options.fsBridge);
    case "codex-cli":
      return probeCodexInstallation({
        customConfigPath: options.targetPath,
        env: { ...process.env, HOME: options.customHome },
      });
    case "omp":
      return probeOmpInstallation({ homeDir: options.customHome });
  }
}

/**
 * Creates an adapter-neutral mutation plan for one supported harness.
 */
export async function planHarnessRegistration(
  options: HarnessAdapterOperationOptions,
): Promise<ConfigMutationPlan> {
  const workspaceName = path.basename(options.workspacePath) || "workspace";
  const workspace: HarnessWorkspace = {
    workspaceId: `${options.harnessId}_${workspaceName}`,
    name: workspaceName,
    rootPath: options.workspacePath,
    harnessId: options.harnessId,
    configPath: options.targetPath,
    mcpConfigPath: options.targetPath,
    metadata: {},
  };

  switch (options.harnessId) {
    case "claude-code":
      return planClaudeMcpConfig(workspace, options.gatewayUrl, options.fsBridge);
    case "codex-cli": {
      const adapterPlan = await planCodexMcpConfig({
        targetPath: options.targetPath,
        gatewayUrl: options.gatewayUrl,
        fsBridge: options.fsBridge,
      });
      if (options.targetPath.endsWith(".json")) {
        return adapterPlan;
      }

      const currentContent = await options.fsBridge.readFile(options.targetPath);
      if (currentContent === null || currentContent.trim().length === 0) {
        parseCodexTomlConfig(adapterPlan.plannedContent);
        return adapterPlan;
      }

      const currentConfig = parseCodexTomlConfig(currentContent);
      if (findCodexTomlServerConfig(currentConfig, RESIN_MCP_SERVER_KEYS["codex-cli"]) === null) {
        parseCodexTomlConfig(adapterPlan.plannedContent);
        return adapterPlan;
      }

      const plannedContent = updateCodexTomlServerTransport(
        currentContent,
        RESIN_MCP_SERVER_KEYS["codex-cli"],
        options.gatewayUrl,
      );
      parseCodexTomlConfig(plannedContent);
      return { ...adapterPlan, plannedContent };
    }
    case "omp":
      return planOmpMcpConfig({
        customConfigPath: options.targetPath,
        gatewayUrl: options.gatewayUrl,
        fsBridge: options.fsBridge,
      });
  }
}

/**
 * Verifies one registration through its adapter. Codex TOML receives an additional
 * section-scoped URL check because its adapter verifier also scans unrelated sections.
 */
export async function verifyHarnessRegistration(
  options: HarnessAdapterOperationOptions,
): Promise<boolean> {
  const content = await options.fsBridge.readFile(options.targetPath);
  if (content === null || content.trim().length === 0) {
    return false;
  }

  try {
    let server: HarnessConfigRecord | null;
    if (options.harnessId === "codex-cli" && !options.targetPath.endsWith(".json")) {
      server = findCodexTomlServerConfig(
        parseCodexTomlConfig(content),
        RESIN_MCP_SERVER_KEYS["codex-cli"],
      );
    } else {
      const config = asObject(JSON.parse(content));
      if (config === null) {
        return false;
      }
      server = findJsonServerConfig(
        config,
        options.harnessId,
        RESIN_MCP_SERVER_KEYS[options.harnessId],
      );
    }

    if (server === null) {
      return false;
    }
    const expectedTransport = {
      type: options.harnessId === "codex-cli" ? undefined : "sse",
      url: options.gatewayUrl,
      command: undefined,
      args: undefined,
    } satisfies Record<(typeof RESIN_TRANSPORT_FIELDS)[number], HarnessConfigValue | undefined>;
    return RESIN_TRANSPORT_FIELDS.every((field) =>
      isDeepStrictEqual(server[field], expectedTransport[field]),
    );
  } catch {
    return false;
  }
}

const RESIN_TRANSPORT_FIELDS = ["type", "url", "command", "args"] as const;
const CODEX_SERVER_CONTAINER_PATHS = [["mcp_servers"], ["mcpServers"], ["mcp", "servers"]] as const;

export function parseCodexTomlConfig(content: string): HarnessConfigRecord {
  // SAFETY: parseToml returns parsed TOML object structure.
  const parsed = parseToml(content) as HarnessConfigValue;
  const config = asObject(parsed);
  if (config === null) {
    throw new Error("Codex TOML root must be a table");
  }
  return config;
}

export function findCodexTomlServerConfig(
  config: HarnessConfigRecord,
  serverName: string,
): HarnessConfigRecord | null {
  const matches: HarnessConfigRecord[] = [];
  for (const containerPath of CODEX_SERVER_CONTAINER_PATHS) {
    const container = getObjectAtPath(config, containerPath);
    const entry = container === null ? null : asObject(container[serverName]);
    if (entry !== null) {
      matches.push(entry);
    }
  }
  return matches[0] ?? null;
}

export function projectUserOwnedCodexToml(
  content: string,
  serverName: string,
): HarnessConfigRecord {
  const projected = structuredClone(parseCodexTomlConfig(content));
  for (const containerPath of CODEX_SERVER_CONTAINER_PATHS) {
    const container = getObjectAtPath(projected, containerPath);
    if (container === null) {
      continue;
    }
    let legacyExtras: HarnessConfigRecord | null = null;
    for (const legacyAlias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
      if (legacyAlias in container && legacyAlias !== serverName) {
        const legacyServer = asObject(container[legacyAlias]);
        if (legacyServer !== null && isRecognizedResinMcpEntry(legacyServer)) {
          const userEntry = { ...legacyServer };
          for (const field of RESIN_TRANSPORT_FIELDS) {
            delete userEntry[field];
          }
          if (Object.keys(userEntry).length > 0 && legacyExtras === null) {
            legacyExtras = userEntry;
          }
          delete container[legacyAlias];
        }
      }
    }

    if (serverName in container) {
      const server = asObject(container[serverName]);
      if (server === null) {
        delete container[serverName];
      } else {
        for (const field of RESIN_TRANSPORT_FIELDS) {
          delete server[field];
        }
        if (legacyExtras !== null) {
          for (const [key, value] of Object.entries(legacyExtras)) {
            if (!(key in server)) {
              server[key] = value;
            }
          }
        }
        if (Object.keys(server).length === 0) {
          delete container[serverName];
        }
      }
    }

    if (legacyExtras !== null && !(serverName in container)) {
      container[serverName] = legacyExtras;
    }

    pruneEmptyObjectPath(projected, containerPath);
  }
  return projected;
}

export { projectUserOwnedCodexToml as projectCodexTomlUserConfig };

function findJsonServerConfig(
  config: HarnessConfigRecord,
  harnessId: SupportedHarnessId,
  serverName: string,
): HarnessConfigRecord | null {
  const containerKeys = harnessId === "codex-cli" ? ["mcpServers", "mcp_servers"] : ["mcpServers"];
  const matches = containerKeys.flatMap((key) => {
    const container = asObject(config[key]);
    const entry = container === null ? null : asObject(container[serverName]);
    return entry === null ? [] : [entry];
  });
  return matches[0] ?? null;
}

function asObject(value: HarnessConfigValue | undefined | null): HarnessConfigRecord | null {
  return isConfigObject(value) ? value : null;
}

function getObjectAtPath(
  root: HarnessConfigRecord,
  keyPath: readonly string[],
): HarnessConfigRecord | null {
  let current: HarnessConfigRecord = root;
  for (const key of keyPath) {
    const next = asObject(current[key]);
    if (next === null) {
      return null;
    }
    current = next;
  }
  return current;
}

function pruneEmptyObjectPath(root: HarnessConfigRecord, keyPath: readonly string[]): void {
  for (let length = keyPath.length; length > 0; length -= 1) {
    const parent = getObjectAtPath(root, keyPath.slice(0, length - 1));
    if (parent === null) {
      continue;
    }
    const key = keyPath[length - 1];
    if (key === undefined) {
      continue;
    }
    const target = asObject(parent[key]);
    if (target === null || Object.keys(target).length > 0) {
      return;
    }
    delete parent[key];
  }
}

interface TomlReplacement {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

interface TomlSourceStatement {
  readonly start: number;
  readonly end: number;
  readonly source: string;
}

function splitTomlSourceStatements(content: string): TomlSourceStatement[] {
  const statements: TomlSourceStatement[] = [];
  let start = 0;
  let brackets = 0;
  let braces = 0;
  let quote: "'" | '"' | "'''" | '"""' | null = null;
  let escaped = false;
  let comment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (comment) {
      if (character === "\n") {
        comment = false;
      } else {
        continue;
      }
    }

    if (quote === "'''" || quote === '"""') {
      if (content.startsWith(quote, index) && !(quote === '"""' && escaped)) {
        index += 2;
        quote = null;
        escaped = false;
      } else if (quote === '"""' && character === "\\") {
        escaped = !escaped;
      } else {
        escaped = false;
      }
    } else if (quote !== null) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
    } else if (content.startsWith('"""', index) || content.startsWith("'''", index)) {
      // SAFETY: Sliced 3-character delimiter is verified to be a valid triple-quote token.
      quote = content.slice(index, index + 3) as "'''" | '"""';
      index += 2;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      comment = true;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
    }

    if (character === "\n" && quote === null && brackets === 0 && braces === 0) {
      const end = index + 1;
      statements.push({ start, end, source: content.slice(start, end) });
      start = end;
    }
  }

  if (start < content.length) {
    statements.push({ start, end: content.length, source: content.slice(start) });
  }
  return statements;
}

function updateCodexTomlServerTransport(
  content: string,
  serverName: string,
  gatewayUrl: string,
): string {
  const serverPaths = CODEX_SERVER_CONTAINER_PATHS.map((containerPath) => [
    ...containerPath,
    serverName,
  ]);
  const replacements: TomlReplacement[] = [];
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  let tablePath: string[] = [];
  let tableInsertion: number | null = null;
  let tableInsertionNeedsNewline = false;
  let matchedPath: readonly string[] | null = null;
  let foundServer = false;
  let foundUrl = false;

  for (const sourceStatement of splitTomlSourceStatements(content)) {
    const sourceStart = sourceStatement.start;
    const sourceEnd = sourceStatement.end;
    const body = sourceStatement.source.replace(/\r?\n$/, "");
    const statementEnd = findTomlCommentIndex(body);
    const statement = body.slice(0, statementEnd).trim();
    if (statement.length === 0) {
      continue;
    }

    const headerPath = parseTomlTableHeader(statement);
    if (headerPath !== null) {
      tablePath = headerPath;
      const matchingServerPath = serverPaths.find((serverPath) =>
        sameKeyPath(serverPath, tablePath),
      );
      if (matchingServerPath !== undefined) {
        foundServer = true;
        matchedPath = matchingServerPath;
        tableInsertion = sourceEnd;
        tableInsertionNeedsNewline = !sourceStatement.source.endsWith("\n");
      }
      continue;
    }

    const equalsIndex = findTomlTopLevelCharacter(statement, "=");
    if (equalsIndex < 0) {
      continue;
    }
    const assignmentPath = parseTomlKeyPath(statement.slice(0, equalsIndex));
    if (assignmentPath === null) {
      continue;
    }
    const effectivePath = [...tablePath, ...assignmentPath];
    const rawEqualsIndex = findTomlTopLevelCharacter(body, "=");
    if (rawEqualsIndex < 0) {
      continue;
    }
    const valueStart = skipWhitespace(body, rawEqualsIndex + 1);
    const valueEnd = trimWhitespaceEnd(body, statementEnd);
    const rawValue = body.slice(valueStart, valueEnd);

    for (const serverPath of serverPaths) {
      if (sameKeyPath(effectivePath, serverPath)) {
        const updatedInline = updateTomlInlineTable(rawValue, [], gatewayUrl);
        if (updatedInline !== null) {
          foundServer = true;
          foundUrl = true;
          matchedPath = serverPath;
          replacements.push({
            start: sourceStart + valueStart,
            end: sourceStart + valueEnd,
            content: updatedInline,
          });
        }
        break;
      }

      if (isKeyPathPrefix(effectivePath, serverPath)) {
        const remainingPath = serverPath.slice(effectivePath.length);
        const updatedInline = updateTomlInlineTable(rawValue, remainingPath, gatewayUrl);
        if (updatedInline !== null) {
          foundServer = true;
          foundUrl = true;
          matchedPath = serverPath;
          replacements.push({
            start: sourceStart + valueStart,
            end: sourceStart + valueEnd,
            content: updatedInline,
          });
        }
        break;
      }

      if (!isKeyPathPrefix(serverPath, effectivePath)) {
        continue;
      }
      foundServer = true;
      matchedPath = serverPath;
      const relativePath = effectivePath.slice(serverPath.length);
      if (relativePath.length !== 1) {
        break;
      }
      const field = relativePath[0]!;
      if (field === "url") {
        foundUrl = true;
        replacements.push({
          start: sourceStart + valueStart,
          end: sourceStart + valueEnd,
          content: JSON.stringify(gatewayUrl),
        });
      } else if (field === "type" || field === "command" || field === "args") {
        replacements.push({ start: sourceStart, end: sourceEnd, content: "" });
      }
      break;
    }
  }

  if (!foundServer || matchedPath === null) {
    throw new Error("Unable to locate the parsed Resin Codex server in its TOML source");
  }
  if (!foundUrl) {
    if (tableInsertion !== null) {
      replacements.push({
        start: tableInsertion,
        end: tableInsertion,
        content: `${tableInsertionNeedsNewline ? newline : ""}url = ${JSON.stringify(gatewayUrl)}${newline}`,
      });
    } else {
      const separator = content.length === 0 || content.endsWith("\n") ? "" : newline;
      replacements.push({
        start: content.length,
        end: content.length,
        content: `${separator}${matchedPath.map(serializeTomlKey).join(".")}.url = ${JSON.stringify(gatewayUrl)}${newline}`,
      });
    }
  }
  let updated = content;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, replacement.start)}${replacement.content}${updated.slice(replacement.end)}`;
  }

  for (const legacyAlias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    if (legacyAlias === serverName) continue;
    const legacySectionRegex = new RegExp(
      `^[ \\t]*\\[[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${escapeRegExp(legacyAlias)}"|'${escapeRegExp(legacyAlias)}'|${escapeRegExp(legacyAlias)})[ \\t]*\\][ \\t]*(?:\\r?\\n)?`,
      "m",
    );
    const match = updated.match(legacySectionRegex);
    if (match && match.index !== undefined) {
      const startIndex = match.index;
      const afterHeader = startIndex + match[0].length;
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
      if (isRecognizedResinMcpEntry(entryObj, gatewayUrl)) {
        updated = `${updated.slice(0, startIndex)}${updated.slice(sectionEnd)}`;
      }
    }
  }

  return updated;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
}

function updateTomlInlineTable(
  source: string,
  remainingPath: readonly string[],
  gatewayUrl: string,
): string | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  const entries = splitTomlInlineEntries(trimmed.slice(1, -1));
  const updatedEntries: string[] = [];
  let matched = remainingPath.length === 0;
  let foundUrl = false;

  for (const entry of entries) {
    const equalsIndex = findTomlTopLevelCharacter(entry, "=");
    if (equalsIndex < 0) {
      updatedEntries.push(entry.trim());
      continue;
    }
    const keyPath = parseTomlKeyPath(entry.slice(0, equalsIndex));
    if (keyPath === null) {
      updatedEntries.push(entry.trim());
      continue;
    }
    const value = entry.slice(equalsIndex + 1).trim();

    if (remainingPath.length > 0) {
      if (sameKeyPath(keyPath, remainingPath)) {
        const nested = updateTomlInlineTable(value, [], gatewayUrl);
        if (nested !== null) {
          matched = true;
          foundUrl = true;
          updatedEntries.push(`${entry.slice(0, equalsIndex).trim()} = ${nested}`);
          continue;
        }
      } else if (isKeyPathPrefix(keyPath, remainingPath)) {
        const nested = updateTomlInlineTable(
          value,
          remainingPath.slice(keyPath.length),
          gatewayUrl,
        );
        if (nested !== null) {
          matched = true;
          foundUrl = true;
          updatedEntries.push(`${entry.slice(0, equalsIndex).trim()} = ${nested}`);
          continue;
        }
      } else if (isKeyPathPrefix(remainingPath, keyPath)) {
        const relativePath = keyPath.slice(remainingPath.length);
        if (relativePath.length === 1 && relativePath[0] === "url") {
          matched = true;
          foundUrl = true;
          updatedEntries.push(
            `${entry.slice(0, equalsIndex).trim()} = ${JSON.stringify(gatewayUrl)}`,
          );
          continue;
        }
        if (
          relativePath.length === 1 &&
          (relativePath[0] === "type" ||
            relativePath[0] === "command" ||
            relativePath[0] === "args")
        ) {
          matched = true;
          continue;
        }
      }
      updatedEntries.push(entry.trim());
      continue;
    }

    if (keyPath.length === 1 && keyPath[0] === "url") {
      foundUrl = true;
      updatedEntries.push(`url = ${JSON.stringify(gatewayUrl)}`);
    } else if (
      keyPath.length === 1 &&
      (keyPath[0] === "type" || keyPath[0] === "command" || keyPath[0] === "args")
    ) {
    } else {
      updatedEntries.push(entry.trim());
    }
  }

  if (!matched) {
    return null;
  }
  if (remainingPath.length === 0 && !foundUrl) {
    updatedEntries.push(`url = ${JSON.stringify(gatewayUrl)}`);
  }
  return `{ ${updatedEntries.filter((entry) => entry.length > 0).join(", ")} }`;
}

function splitTomlInlineEntries(source: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== null) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
    } else if (character === "," && braces === 0 && brackets === 0) {
      entries.push(source.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(source.slice(start));
  return entries;
}

function parseTomlTableHeader(statement: string): string[] | null {
  const arrayTable = statement.startsWith("[[") && statement.endsWith("]]");
  const standardTable = !arrayTable && statement.startsWith("[") && statement.endsWith("]");
  if (!arrayTable && !standardTable) {
    return null;
  }
  return parseTomlKeyPath(arrayTable ? statement.slice(2, -2) : statement.slice(1, -1));
}

function parseTomlKeyPath(source: string): string[] | null {
  const keys: string[] = [];
  let index = 0;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (index >= source.length) {
      return null;
    }
    const quote = source[index];
    let key = "";
    if (quote === '"' || quote === "'") {
      index += 1;
      let escaped = false;
      let closed = false;
      while (index < source.length) {
        const character = source[index]!;
        index += 1;
        if (quote === '"' && escaped) {
          key += `\\${character}`;
          escaped = false;
        } else if (quote === '"' && character === "\\") {
          escaped = true;
        } else if (character === quote) {
          closed = true;
          break;
        } else {
          key += character;
        }
      }
      if (!closed) {
        return null;
      }
      if (quote === '"') {
        try {
          // SAFETY: Parsed JSON string from valid quoted key segment.
          key = JSON.parse(`"${key}"`) as string;
        } catch {
          return null;
        }
      }
    } else {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_-]/.test(source[index]!)) {
        index += 1;
      }
      if (start === index) {
        return null;
      }
      key = source.slice(start, index);
    }
    keys.push(key);
    index = skipWhitespace(source, index);
    if (index === source.length) {
      return keys;
    }
    if (source[index] !== ".") {
      return null;
    }
    index += 1;
  }
  return null;
}

function findTomlCommentIndex(source: string): number {
  const index = findTomlTopLevelCharacter(source, "#");
  return index < 0 ? source.length : index;
}

function findTomlTopLevelCharacter(source: string, target: string): number {
  let quote: "'" | '"' | "'''" | '"""' | null = null;
  let escaped = false;
  let comment = false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (comment) {
      if (character === "\n") {
        comment = false;
      }
      continue;
    }
    if (quote === "'''" || quote === '"""') {
      if (source.startsWith(quote, index) && !(quote === '"""' && escaped)) {
        index += 2;
        quote = null;
        escaped = false;
      } else if (quote === '"""' && character === "\\") {
        escaped = !escaped;
      } else {
        escaped = false;
      }
      continue;
    }
    if (quote !== null) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      // SAFETY: Sliced 3-character delimiter is verified to be a valid triple-quote token.
      quote = source.slice(index, index + 3) as "'''" | '"""';
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      if (target === "#" && braces === 0 && brackets === 0) {
        return index;
      }
      comment = true;
      continue;
    }
    if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
    } else if (character === target && braces === 0 && brackets === 0) {
      return index;
    }
  }
  return -1;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index]!)) {
    index += 1;
  }
  return index;
}

function trimWhitespaceEnd(source: string, end: number): number {
  let index = end;
  while (index > 0 && /\s/.test(source[index - 1]!)) {
    index -= 1;
  }
  return index;
}

function sameKeyPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isKeyPathPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((key, index) => key === value[index]);
}

function serializeTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export interface OrchestrationResult {
  readonly success: boolean;
  readonly results: HarnessConfigResult[];
  readonly backups: ConfigBackup[];
  readonly error?: string;
  readonly rollbackErrors?: readonly string[];
  rollback: () => Promise<void>;
}

/**
 * Orchestrates multi-harness discovery, configuration planning, atomic application,
 * and rollback across Claude Code, Codex CLI, and Oh My Pi.
 */
export class HarnessConfigOrchestrator {
  private pendingRollback:
    | {
        readonly reconciler: {
          rollbackBackups(
            backups: readonly ConfigBackup[],
            fsBridge: ConfigFsBridge,
          ): Promise<void>;
        };
        readonly backups: readonly ConfigBackup[];
        readonly fsBridge: ConfigFsBridge;
      }
    | undefined;

  async configureHarnesses(options: MultiHarnessConfigOptions = {}): Promise<OrchestrationResult> {
    const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    const customHome = options.customHome ?? process.env.HOME ?? os.homedir();
    const workspacePath = options.workspacePath ?? process.cwd();
    const targetHarnesses = [...new Set(options.harnesses ?? SUPPORTED_HARNESS_IDS)];
    // Deferred only to break the intentional adapter/reconciler module cycle.
    const { HarnessReconciler, ReconciliationNodeFsBridge } = await import(
      "./harness-reconciler.js"
    );
    const fsBridge = options.fsBridge ?? new ReconciliationNodeFsBridge();
    const reconciler = new HarnessReconciler();
    const report = await reconciler.reconcile({
      harnesses: targetHarnesses,
      installedHarnesses: options.fsBridge === undefined ? undefined : targetHarnesses,
      customHome,
      workspacePath,
      gatewayUrl,
      fsBridge,
      dryRun: options.dryRun,
      onHarnessDiscovered: options.onHarnessDiscovered,
      probeHarness: options.probeHarness,
      onPlanCreated: options.onPlanCreated,
    });

    const results: HarnessConfigResult[] = report.results.map((result) => ({
      harnessId: result.harnessId,
      displayName: result.displayName,
      installed: result.installed,
      configured: result.configured,
      wasAlreadyConfigured: result.status === "registered",
      targetPath: result.targetPath,
      plan: result.plan,
      backup: result.backup,
      error: result.error,
    }));
    const backups = report.results.flatMap((result) =>
      result.backup === undefined ? [] : [result.backup],
    );
    const rollbackState = {
      reconciler,
      backups,
      fsBridge,
    };
    const rollback = async (): Promise<void> => {
      await rollbackState.reconciler.rollbackBackups(rollbackState.backups, rollbackState.fsBridge);
      if (this.pendingRollback === rollbackState) {
        this.pendingRollback = undefined;
      }
    };
    this.pendingRollback = backups.length === 0 ? undefined : rollbackState;

    const resultErrors = report.results.flatMap((result) =>
      result.error === undefined ? [] : [`${result.displayName}: ${result.error}`],
    );
    const rollbackErrors: string[] = [];
    if (!report.success && backups.length > 0) {
      try {
        await rollback();
      } catch (error: unknown) {
        if (error instanceof AggregateError) {
          rollbackErrors.push(
            ...error.errors.map((rollbackError: Error | string | { message?: string }) =>
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            ),
          );
        } else {
          rollbackErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    return {
      success: report.success,
      results,
      backups,
      error:
        resultErrors.length === 0 && rollbackErrors.length === 0
          ? undefined
          : [...resultErrors, ...rollbackErrors.map((error) => `Rollback failed: ${error}`)].join(
              "; ",
            ),
      rollbackErrors: rollbackErrors.length === 0 ? undefined : rollbackErrors,
      rollback,
    };
  }

  async rollbackAll(fsBridge?: ConfigFsBridge): Promise<void> {
    const pending = this.pendingRollback;
    if (pending === undefined) {
      return;
    }
    await pending.reconciler.rollbackBackups(pending.backups, fsBridge ?? pending.fsBridge);
    if (this.pendingRollback === pending) {
      this.pendingRollback = undefined;
    }
  }
}
