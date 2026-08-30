import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMetadataRecord,
  type ConfigMutationPlan,
  DEFAULT_RESIN_MCP_ARGS,
  DEFAULT_RESIN_MCP_COMMAND,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  applyConfigMutation,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
  isResinMcpCommand,
  migrateJsonMcpServers,
  planConfigMutation,
  rollbackConfigMutation,
} from "@resin/harness-contracts";
import { CODEX_HARNESS_ID } from "./discovery.js";

/**
 * Standard server definition for Resin Gateway in Codex CLI.
 */
export interface CodexMcpServerConfig extends ConfigMetadataRecord {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "sse" | "stdio" | "http" | "websocket";
}

export interface CodexJsonConfigDoc {
  mcpServers?: Record<string, CodexMcpServerConfig>;
  mcp_servers?: Record<string, CodexMcpServerConfig>;
  [key: string]: unknown;
}

export const DEFAULT_GATEWAY_SERVER_NAME = CANONICAL_RESIN_MCP_SERVER_KEY;
export {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  DEFAULT_RESIN_MCP_ARGS,
  DEFAULT_RESIN_MCP_COMMAND,
};

/**
 * Options for planning Codex MCP configuration mutations.
 */
export interface PlanCodexMcpConfigOptions {
  targetPath: string;
  gatewayUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  serverName?: string;
  serverType?: "sse" | "stdio" | "http" | "websocket";
  type?: "sse" | "stdio" | "http" | "websocket";
  url?: string;
  fsBridge?: ConfigFsBridge;
  currentContent?: string | null;
}

/**
 * Options for verifying Codex MCP configurations.
 */
export interface VerifyCodexMcpConfigOptions {
  targetPath: string;
  gatewayUrl?: string;
  expectedUrl?: string;
  command?: string;
  expectedCommand?: string;
  serverName?: string;
  fsBridge?: ConfigFsBridge;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveServerConfig(
  serverConfigOrUrl?: string | CodexMcpServerConfig,
): CodexMcpServerConfig {
  if (!serverConfigOrUrl) {
    return {
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: [...CANONICAL_RESIN_MCP_ARGS],
    };
  }
  if (typeof serverConfigOrUrl === "string") {
    if (serverConfigOrUrl.startsWith("http://") || serverConfigOrUrl.startsWith("https://")) {
      return { url: serverConfigOrUrl };
    }
    return {
      command: serverConfigOrUrl,
      args: [],
    };
  }
  const config = { ...serverConfigOrUrl };
  if (config.command === undefined && config.url === undefined) {
    config.command = CANONICAL_RESIN_MCP_COMMAND;
    if (config.args === undefined) {
      config.args = [...CANONICAL_RESIN_MCP_ARGS];
    }
  }
  return config;
}

/**
 * Updates or inserts an MCP server definition into TOML content while preserving comments and existing structure.
 * Safely migrates recognized legacy aliases (resin_gateway, resin-gateway) to the canonical server name.
 */
export function updateTomlMcpConfig(
  content: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
  serverConfigOrUrl?: string | CodexMcpServerConfig,
  configuredGatewayUrl?: string,
): string {
  const serverConfig = resolveServerConfig(serverConfigOrUrl);
  const trimmed = content.trim();
  if (!trimmed) {
    let freshSection = `[mcp_servers.${serverName}]\n`;
    if (serverConfig.command !== undefined) {
      freshSection += `command = "${serverConfig.command}"\n`;
      if (serverConfig.args !== undefined && serverConfig.args.length > 0) {
        freshSection += `args = ${JSON.stringify(serverConfig.args)}\n`;
      }
    } else if (serverConfig.url !== undefined) {
      freshSection += `url = "${serverConfig.url}"\n`;
    }
    return `# Codex CLI Configuration\n\n${freshSection}`;
  }
  const existingServer = parseCodexTomlServerConfig(content, serverName);
  const hasLegacyAlias = LEGACY_RESIN_MCP_SERVER_ALIASES.some(
    (alias) => alias !== serverName && parseCodexTomlServerConfig(content, alias) !== null,
  );
  if (
    !hasLegacyAlias &&
    serverConfig.command === CANONICAL_RESIN_MCP_COMMAND &&
    (serverConfig.args === undefined || serverConfig.args.length === 0) &&
    serverConfig.url === undefined &&
    serverConfig.type === undefined &&
    serverConfig.env === undefined &&
    existingServer?.command === CANONICAL_RESIN_MCP_COMMAND &&
    existingServer.url === undefined
  ) {
    return content;
  }

  let cleanedContent = content;
  const legacyExtraLines: string[] = [];

  // Step 1: Remove recognized legacy aliases from TOML content while preserving user extras and non-Resin aliases
  for (const alias of [...LEGACY_RESIN_MCP_SERVER_ALIASES, serverName]) {
    const escapedAlias = escapeRegExp(alias);

    // Check table section: [mcp_servers.<alias>] or [mcpServers.<alias>] or [mcp.servers.<alias>]
    const sectionRegex = new RegExp(
      `^[ \\t]*\\[[ \\t]*(?:"(?:mcp_servers|mcpServers)"|'(?:mcp_servers|mcpServers)'|mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${escapedAlias}"|'${escapedAlias}'|${escapedAlias})[ \\t]*\\][ \\t]*(?:#[^\\r\\n]*)?(?:\\r?\\n)?`,
      "m",
    );
    const sectionMatch = cleanedContent.match(sectionRegex);
    if (sectionMatch && sectionMatch.index !== undefined) {
      const sectionStart = sectionMatch.index;
      const bodyStart = sectionStart + sectionMatch[0].length;
      const rest = cleanedContent.slice(bodyStart);
      const nextSectionMatch = rest.match(/^[ \t]*\[/m);
      const sectionEnd =
        nextSectionMatch && nextSectionMatch.index !== undefined
          ? bodyStart + nextSectionMatch.index
          : cleanedContent.length;

      const sectionBody = cleanedContent.slice(bodyStart, sectionEnd);
      const urlMatch = sectionBody.match(/url[ \t]*=[ \t]*["']([^"']+)["']/);
      const commandMatch = sectionBody.match(/command[ \t]*=[ \t]*["']([^"']+)["']/);
      const entryObj: ConfigMetadataRecord = {
        url: urlMatch ? urlMatch[1] : undefined,
        command: commandMatch ? commandMatch[1] : undefined,
      };

      if (
        alias === serverName ||
        isRecognizedResinMcpEntry(entryObj, configuredGatewayUrl ?? serverConfig.url)
      ) {
        // Collect user-owned lines/comments while dropping the full Resin transport block.
        const lines = sectionBody.split(/\r?\n/);
        let skippingArgs = false;
        for (const line of lines) {
          if (skippingArgs) {
            if (line.includes("]")) {
              skippingArgs = false;
            }
            continue;
          }
          if (/^\s*args\s*=/.test(line)) {
            skippingArgs = !line.includes("]");
            continue;
          }
          const trimmedLine = line.trim();
          if (
            trimmedLine &&
            !/^\s*url\s*=/.test(line) &&
            !/^\s*command\s*=/.test(line) &&
            !/^\s*type\s*=/.test(line)
          ) {
            legacyExtraLines.push(line);
          }
        }
        cleanedContent = `${cleanedContent.slice(0, sectionStart)}${cleanedContent.slice(sectionEnd)}`;
      }
    }
    const dottedInlineRegex = new RegExp(
      `^[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${escapedAlias}"|'${escapedAlias}'|${escapedAlias})[ \\t]*=[ \\t]*\\{([^\\r\\n]*)\\}[ \\t]*(?:#[^\\r\\n]*)?(?:\\r?\\n)?`,
      "m",
    );
    const dottedInlineMatch = cleanedContent.match(dottedInlineRegex);
    if (dottedInlineMatch && dottedInlineMatch.index !== undefined) {
      const inlineBody = dottedInlineMatch[1] ?? "";
      const urlMatch = inlineBody.match(/url\s*=\s*["']([^"']+)["']/);
      const commandMatch = inlineBody.match(/command\s*=\s*["']([^"']+)["']/);
      if (
        alias === serverName ||
        isRecognizedResinMcpEntry(
          {
            url: urlMatch?.[1],
            command: commandMatch?.[1],
          },
          configuredGatewayUrl ?? serverConfig.url,
        )
      ) {
        for (const extraMatch of inlineBody.matchAll(/\b(headers|env)\s*=\s*(\{[^}]*\})/g)) {
          legacyExtraLines.push(`${extraMatch[1]} = ${extraMatch[2]}`);
        }
        const removeStart = dottedInlineMatch.index;
        const removeEnd = removeStart + dottedInlineMatch[0].length;
        cleanedContent = `${cleanedContent.slice(0, removeStart)}${cleanedContent.slice(removeEnd)}`;
      }
    }

    // Check inline table in container: [mcp_servers] -> alias = { ... }
    const containerSectionRegex =
      /^[ \t]*\[[ \t]*(?:mcp_servers|mcpServers|mcp\.servers)[ \t]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n)?/m;
    const containerMatch = cleanedContent.match(containerSectionRegex);
    if (containerMatch && containerMatch.index !== undefined) {
      const containerStart = containerMatch.index + containerMatch[0].length;
      const rest = cleanedContent.slice(containerStart);
      const nextSectionMatch = rest.match(/^[ \t]*\[/m);
      const containerEnd =
        nextSectionMatch && nextSectionMatch.index !== undefined
          ? containerStart + nextSectionMatch.index
          : cleanedContent.length;

      const containerBody = cleanedContent.slice(containerStart, containerEnd);
      const inlineInContainerRegex = new RegExp(
        `^[ \\t]*(?:"${escapedAlias}"|'${escapedAlias}'|${escapedAlias})[ \\t]*=[ \\t]*\\{([^\\r\\n]*)\\}[ \\t]*(?:#[^\\r\\n]*)?(?:\\r?\\n)?`,
        "m",
      );
      const matchInContainer = containerBody.match(inlineInContainerRegex);
      if (matchInContainer && matchInContainer.index !== undefined) {
        const inlineBody = matchInContainer[1]!;
        const urlMatch = inlineBody.match(/url[ \t]*=[ \t]*["']([^"']+)["']/);
        const commandMatch = inlineBody.match(/command[ \t]*=[ \t]*["']([^"']+)["']/);
        const entryObj: ConfigMetadataRecord = {
          url: urlMatch ? urlMatch[1] : undefined,
          command: commandMatch ? commandMatch[1] : undefined,
        };
        if (
          alias === serverName ||
          isRecognizedResinMcpEntry(entryObj, configuredGatewayUrl ?? serverConfig.url)
        ) {
          const inlineBody = matchInContainer[1] ?? "";
          for (const extraMatch of inlineBody.matchAll(/\b(headers|env)\s*=\s*(\{[^}]*\})/g)) {
            legacyExtraLines.push(`${extraMatch[1]} = ${extraMatch[2]}`);
          }
          const removeStart = containerStart + matchInContainer.index;
          const removeEnd = removeStart + matchInContainer[0].length;
          cleanedContent = `${cleanedContent.slice(0, removeStart)}${cleanedContent.slice(removeEnd)}`;
        }
      }
    }
  }

  // Step 2: Add or update canonical server section
  const escapedServerName = escapeRegExp(serverName);
  const canonicalSectionRegex = new RegExp(
    `^[ \\t]*\\[[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${escapedServerName}"|'${escapedServerName}'|${escapedServerName})[ \\t]*\\][ \\t]*(?:#[^\\r\\n]*)?(?:\\r?\\n)?`,
    "m",
  );

  const match = cleanedContent.match(canonicalSectionRegex);
  if (match && match.index !== undefined) {
    const sectionStart = match.index;
    const bodyStart = sectionStart + match[0].length;
    const rest = cleanedContent.slice(bodyStart);
    const nextSectionMatch = rest.match(/^[ \t]*\[/m);
    const sectionEnd =
      nextSectionMatch && nextSectionMatch.index !== undefined
        ? bodyStart + nextSectionMatch.index
        : cleanedContent.length;

    const sectionBody = cleanedContent.slice(bodyStart, sectionEnd);
    const lines = sectionBody.split(/\r?\n/);
    const updatedLines: string[] = [];
    let commandHandled = false;
    let urlHandled = false;
    let argsHandled = false;

    for (const line of lines) {
      if (/^\s*url\s*=/m.test(line)) {
        if (serverConfig.command !== undefined) {
          if (!commandHandled) {
            updatedLines.push(`command = "${serverConfig.command}"`);
            commandHandled = true;
          }
        } else if (serverConfig.url !== undefined) {
          updatedLines.push(`url = "${serverConfig.url}"`);
          urlHandled = true;
        }
      } else if (/^\s*command\s*=/m.test(line)) {
        if (serverConfig.command !== undefined) {
          updatedLines.push(`command = "${serverConfig.command}"`);
          commandHandled = true;
        } else if (serverConfig.url !== undefined) {
          if (!urlHandled) {
            updatedLines.push(`url = "${serverConfig.url}"`);
            urlHandled = true;
          }
        }
      } else if (/^\s*args\s*=/m.test(line)) {
        if (serverConfig.args !== undefined) {
          if (serverConfig.args.length > 0) {
            updatedLines.push(`args = ${JSON.stringify(serverConfig.args)}`);
          }
          argsHandled = true;
        } else {
          updatedLines.push(line);
        }
      } else {
        updatedLines.push(line);
      }
    }

    if (serverConfig.command !== undefined && !commandHandled) {
      updatedLines.unshift(`command = "${serverConfig.command}"`);
    } else if (serverConfig.url !== undefined && !urlHandled) {
      updatedLines.unshift(`url = "${serverConfig.url}"`);
    }
    if (serverConfig.args !== undefined && serverConfig.args.length > 0 && !argsHandled) {
      updatedLines.push(`args = ${JSON.stringify(serverConfig.args)}`);
    }

    let newBody = updatedLines.join("\n");
    newBody = newBody.replace(/\n+$/, "");
    const before = cleanedContent.slice(0, sectionStart);
    const after = cleanedContent.slice(sectionEnd);
    const newSection = `${match[0]}${newBody}\n`;

    return `${before}${newSection}${after}`;
  }

  // Section does not exist: append new canonical section
  const lines: string[] = [`[mcp_servers.${serverName}]`];
  if (serverConfig.command !== undefined) {
    lines.push(`command = "${serverConfig.command}"`);
    if (serverConfig.args !== undefined && serverConfig.args.length > 0) {
      lines.push(`args = ${JSON.stringify(serverConfig.args)}`);
    }
  } else if (serverConfig.url !== undefined) {
    lines.push(`url = "${serverConfig.url}"`);
  }
  if (serverConfig.type !== undefined) {
    lines.push(`type = "${serverConfig.type}"`);
  }
  if (serverConfig.env !== undefined) {
    lines.push(`env = ${JSON.stringify(serverConfig.env)}`);
  }
  for (const extra of legacyExtraLines) {
    lines.push(extra);
  }

  const newSection = lines.join("\n");
  return `${cleanedContent.trimEnd()}\n\n${newSection}\n`;
}

/**
 * Updates or inserts an MCP server definition into JSON content while preserving existing keys.
 */
export function updateJsonMcpConfig(
  content: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
  serverConfigOrUrl?: string | CodexMcpServerConfig,
  configuredGatewayUrl?: string,
): string {
  const serverConfig = resolveServerConfig(serverConfigOrUrl);
  let doc: CodexJsonConfigDoc = {};

  const trimmed = content.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(content);
      if (parsed instanceof Object && !Array.isArray(parsed)) {
        doc = parsed as CodexJsonConfigDoc;
      }
    } catch {
      doc = {};
    }
  }

  // Preserve existing mcpServers vs mcp_servers property name preference
  const targetKey = doc.mcpServers ? "mcpServers" : doc.mcp_servers ? "mcp_servers" : "mcpServers";
  const existingServers: Record<string, CodexMcpServerConfig> =
    doc[targetKey] && doc[targetKey] instanceof Object && !Array.isArray(doc[targetKey])
      ? { ...doc[targetKey] }
      : {};

  const updatedServers = migrateJsonMcpServers(
    existingServers,
    serverConfig,
    configuredGatewayUrl ?? serverConfig.url,
    serverName,
  );

  const updatedConfig: CodexJsonConfigDoc = {
    ...doc,
    [targetKey]: updatedServers,
  };

  return `${JSON.stringify(updatedConfig, null, 2)}\n`;
}

/**
 * Plans an atomic configuration modification to register the Resin Gateway in Codex config.
 */
export async function planCodexMcpConfig(
  options: PlanCodexMcpConfigOptions,
): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const serverName = options.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;

  let currentContent: string | null = null;
  if (options.currentContent !== undefined) {
    currentContent = options.currentContent;
  } else {
    currentContent = await fsBridge.readFile(options.targetPath);
  }

  const explicitType = options.serverType ?? options.type;
  let serverEntry: CodexMcpServerConfig;

  if (options.command !== undefined) {
    serverEntry = {
      command: options.command,
      args: options.args ?? [],
    };
    if (explicitType !== undefined) {
      serverEntry.type = explicitType;
    }
    if (options.env !== undefined) {
      serverEntry.env = options.env;
    }
    if (options.url !== undefined) {
      serverEntry.url = options.url;
    }
  } else if (options.url !== undefined && explicitType === "sse") {
    serverEntry = {
      type: "sse",
      url: options.url,
    };
    if (options.env !== undefined) {
      serverEntry.env = options.env;
    }
  } else {
    serverEntry = {
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: options.args !== undefined ? options.args : [...CANONICAL_RESIN_MCP_ARGS],
    };
    if (explicitType !== undefined) {
      serverEntry.type = explicitType;
    }
    if (options.env !== undefined) {
      serverEntry.env = options.env;
    }
  }

  const configuredGatewayUrl = options.gatewayUrl ?? options.url;
  const isJson = options.targetPath.endsWith(".json");
  const plannedContent = isJson
    ? updateJsonMcpConfig(currentContent ?? "", serverName, serverEntry, configuredGatewayUrl)
    : updateTomlMcpConfig(currentContent ?? "", serverName, serverEntry, configuredGatewayUrl);

  const diffDescription = `Register Resin Gateway MCP server (${serverName} -> ${serverEntry.command ?? serverEntry.url}) in ${options.targetPath}`;

  return planConfigMutation({
    harnessId: CODEX_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent,
    description: diffDescription,
    metadata: {
      serverName,
      serverConfig: serverEntry,
      changesSummary: isJson
        ? `Add/update mcpServers.${serverName}`
        : `Add/update [mcp_servers.${serverName}]`,
    },
  });
}

/**
 * Applies a planned MCP configuration mutation atomically and returns a backup descriptor.
 */
export async function applyCodexMcpConfig(
  plan: ConfigMutationPlan,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<ConfigBackup> {
  return applyConfigMutation(plan, fsBridge);
}

/**
 * Rolls back a previous configuration mutation using its backup.
 */
export async function rollbackCodexMcpConfig(
  backup: ConfigBackup,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<void> {
  return rollbackConfigMutation(backup, fsBridge);
}

/**
 * Parses a server configuration block from the body of a dedicated TOML section.
 */
function parseTomlKeySegments(source: string): string[] | null {
  const segments: string[] = [];
  let index = 0;
  const trimmed = source.trim();
  if (!trimmed) return null;

  while (index < trimmed.length) {
    while (index < trimmed.length && /\s/.test(trimmed[index]!)) {
      index++;
    }
    if (index >= trimmed.length) break;

    const char = trimmed[index]!;
    if (char === '"' || char === "'") {
      const quote = char;
      index++;
      let token = "";
      let escaped = false;
      let closed = false;
      while (index < trimmed.length) {
        const c = trimmed[index]!;
        index++;
        if (quote === '"' && escaped) {
          token += c;
          escaped = false;
        } else if (quote === '"' && c === "\\") {
          escaped = true;
        } else if (c === quote) {
          closed = true;
          break;
        } else {
          token += c;
        }
      }
      if (!closed) return null;
      segments.push(token);
    } else {
      let token = "";
      while (index < trimmed.length && trimmed[index] !== "." && !/\s/.test(trimmed[index]!)) {
        token += trimmed[index]!;
        index++;
      }
      if (!token) return null;
      segments.push(token);
    }

    while (index < trimmed.length && /\s/.test(trimmed[index]!)) {
      index++;
    }
    if (index < trimmed.length) {
      if (trimmed[index] === ".") {
        index++;
      } else {
        return null;
      }
    }
  }

  return segments.length > 0 ? segments : null;
}

function isContainerPath(segments: string[]): boolean {
  if (segments.length === 1 && (segments[0] === "mcp_servers" || segments[0] === "mcpServers")) {
    return true;
  }
  if (segments.length === 2 && segments[0] === "mcp" && segments[1] === "servers") {
    return true;
  }
  return false;
}

function isDedicatedServerSection(segments: string[], serverName: string): boolean {
  if (
    segments.length === 2 &&
    (segments[0] === "mcp_servers" || segments[0] === "mcpServers") &&
    segments[1] === serverName
  ) {
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "mcp" &&
    segments[1] === "servers" &&
    segments[2] === serverName
  ) {
    return true;
  }
  return false;
}

function applyDottedKeyValue(
  config: CodexMcpServerConfig,
  propSegments: string[],
  valPart: string,
): void {
  const prop = propSegments[0];
  if (prop === "command") {
    const m = valPart.match(/^["']([^"']+)["']/);
    if (m) config.command = m[1];
  } else if (prop === "url") {
    const m = valPart.match(/^["']([^"']+)["']/);
    if (m) config.url = m[1];
  } else if (prop === "type") {
    const m = valPart.match(/^["']([^"']+)["']/);
    if (m) config.type = m[1] as CodexMcpServerConfig["type"];
  } else if (prop === "args") {
    const m = valPart.match(/^\[([^\]]*)\]/);
    if (m) {
      const rawItems = m[1]!.split(",");
      const parsedArgs: string[] = [];
      for (const item of rawItems) {
        const itemMatch = item.trim().match(/^["']([^"']*)["']$/);
        if (itemMatch) parsedArgs.push(itemMatch[1]!);
      }
      config.args = parsedArgs;
    }
  } else if (prop === "env") {
    if (propSegments.length === 2) {
      const envKey = propSegments[1]!;
      const m = valPart.match(/^["']([^"']*)["']/);
      if (m) {
        if (!config.env) config.env = {};
        config.env[envKey] = m[1]!;
      }
    } else {
      const m = valPart.match(/^\{([^}]+)\}/);
      if (m) {
        const envObj: Record<string, string> = {};
        const pairs = m[1]!.split(",");
        for (const pair of pairs) {
          const pairMatch = pair
            .trim()
            .match(/^(?:["']([^"']+)["']|([a-zA-Z0-9_-]+))\s*=\s*["']([^"']*)["']/);
          if (pairMatch) {
            const key = pairMatch[1] ?? pairMatch[2]!;
            const val = pairMatch[3]!;
            envObj[key] = val;
          }
        }
        config.env = envObj;
      }
    }
  }
}

/**
 * Parses a server configuration block from the body of a dedicated TOML section.
 */
function parseTomlServerBody(body: string): CodexMcpServerConfig {
  const result: CodexMcpServerConfig = {};
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cmdMatch = trimmed.match(/^command\s*=\s*["']([^"']+)["']/);
    if (cmdMatch) {
      result.command = cmdMatch[1];
      continue;
    }
    const urlMatch = trimmed.match(/^url\s*=\s*["']([^"']+)["']/);
    if (urlMatch) {
      result.url = urlMatch[1];
      continue;
    }
    const typeMatch = trimmed.match(/^type\s*=\s*["']([^"']+)["']/);
    if (typeMatch) {
      result.type = typeMatch[1] as CodexMcpServerConfig["type"];
      continue;
    }
    const argsMatch = trimmed.match(/^args\s*=\s*\[([^\]]*)\]/);
    if (argsMatch) {
      const rawItems = argsMatch[1]!.split(",");
      const parsedArgs: string[] = [];
      for (const item of rawItems) {
        const itemMatch = item.trim().match(/^["']([^"']*)["']$/);
        if (itemMatch) {
          parsedArgs.push(itemMatch[1]!);
        }
      }
      result.args = parsedArgs;
      continue;
    }
    const envDottedMatch = trimmed.match(
      /^env\.(?:["']([^"']+)["']|([a-zA-Z0-9_.-]+))\s*=\s*["']([^"']*)["']/,
    );
    if (envDottedMatch) {
      const key = envDottedMatch[1] ?? envDottedMatch[2]!;
      const val = envDottedMatch[3]!;
      if (!result.env) result.env = {};
      result.env[key] = val;
      continue;
    }
    const envMatch = trimmed.match(/^env\s*=\s*\{([^}]+)\}/);
    if (envMatch) {
      const envObj: Record<string, string> = {};
      const pairs = envMatch[1]!.split(",");
      for (const pair of pairs) {
        const pairMatch = pair
          .trim()
          .match(/^(?:["']([^"']+)["']|([a-zA-Z0-9_-]+))\s*=\s*["']([^"']*)["']/);
        if (pairMatch) {
          const key = pairMatch[1] ?? pairMatch[2]!;
          const val = pairMatch[3]!;
          envObj[key] = val;
        }
      }
      result.env = envObj;
    }
  }
  return result;
}

/**
 * Parses a server configuration block from an inline TOML table string `{ ... }`.
 */
function parseTomlInlineServerBody(inlineContent: string): CodexMcpServerConfig {
  const result: CodexMcpServerConfig = {};
  const cmdMatch = inlineContent.match(/command\s*=\s*["']([^"']+)["']/);
  if (cmdMatch) {
    result.command = cmdMatch[1];
  }
  const urlMatch = inlineContent.match(/url\s*=\s*["']([^"']+)["']/);
  if (urlMatch) {
    result.url = urlMatch[1];
  }
  const typeMatch = inlineContent.match(/type\s*=\s*["']([^"']+)["']/);
  if (typeMatch) {
    result.type = typeMatch[1] as CodexMcpServerConfig["type"];
  }
  const argsMatch = inlineContent.match(/args\s*=\s*\[([^\]]*)\]/);
  if (argsMatch) {
    const rawItems = argsMatch[1]!.split(",");
    const parsedArgs: string[] = [];
    for (const item of rawItems) {
      const itemMatch = item.trim().match(/^["']([^"']*)["']$/);
      if (itemMatch) {
        parsedArgs.push(itemMatch[1]!);
      }
    }
    result.args = parsedArgs;
  }
  const envMatch = inlineContent.match(/env\s*=\s*\{([^}]+)\}/);
  if (envMatch) {
    const envObj: Record<string, string> = {};
    const pairs = envMatch[1]!.split(",");
    for (const pair of pairs) {
      const pairMatch = pair
        .trim()
        .match(/^(?:["']([^"']+)["']|([a-zA-Z0-9_-]+))\s*=\s*["']([^"']*)["']/);
      if (pairMatch) {
        const key = pairMatch[1] ?? pairMatch[2]!;
        const val = pairMatch[3]!;
        envObj[key] = val;
      }
    }
    result.env = envObj;
  }
  return result;
}

/**
 * Scans and extracts a server configuration record from Codex TOML content in a section-scoped manner.
 */
export function parseCodexTomlServerConfig(
  content: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
): CodexMcpServerConfig | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  let currentSectionPath: string[] | null = null;
  let dedicatedSectionBodyLines: string[] | null = null;
  let containerServerConfig: CodexMcpServerConfig | null = null;
  let topLevelServerConfig: CodexMcpServerConfig | null = null;

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    // Check if table header [ ... ]
    const headerMatch = rawLine.match(/^[ \t]*\[([^[\]]+)\][ \t]*(?:#[^\r\n]*)?$/);
    if (headerMatch && headerMatch[1]) {
      if (dedicatedSectionBodyLines !== null) {
        break;
      }

      const headerContent = headerMatch[1].trim();
      const segments = parseTomlKeySegments(headerContent);
      if (segments && isDedicatedServerSection(segments, serverName)) {
        currentSectionPath = segments;
        dedicatedSectionBodyLines = [];
        continue;
      }
      if (segments && isContainerPath(segments)) {
        currentSectionPath = segments;
        continue;
      }
      currentSectionPath = segments;
      continue;
    }

    // If currently in dedicated section for serverName
    if (dedicatedSectionBodyLines !== null) {
      dedicatedSectionBodyLines.push(rawLine);
      continue;
    }

    // If currently in container section [mcp_servers], [mcpServers], or [mcp.servers]
    if (currentSectionPath && isContainerPath(currentSectionPath)) {
      // Check for inline table: resin = { ... }
      const inlineMatch = rawLine.match(
        /^[ \t]*(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+))[ \t]*=[ \t]*\{([^}]+)\}/,
      );
      if (inlineMatch) {
        const key = inlineMatch[1] ?? inlineMatch[2] ?? inlineMatch[3];
        if (key === serverName) {
          containerServerConfig = parseTomlInlineServerBody(inlineMatch[4]!);
          continue;
        }
      }

      // Check for dotted keys: resin.command = "..."
      const equalsIdx = line.indexOf("=");
      if (equalsIdx !== -1) {
        const keyPart = line.slice(0, equalsIdx).trim();
        const valPart = line.slice(equalsIdx + 1).trim();
        const keySegments = parseTomlKeySegments(keyPart);
        if (keySegments && keySegments.length >= 2 && keySegments[0] === serverName) {
          if (!containerServerConfig) containerServerConfig = {};
          applyDottedKeyValue(containerServerConfig, keySegments.slice(1), valPart);
        }
      }
      continue;
    }

    // If at top level (currentSectionPath === null)
    if (currentSectionPath === null) {
      const equalsIdx = rawLine.indexOf("=");
      if (equalsIdx !== -1) {
        const keyPart = rawLine.slice(0, equalsIdx).trim();
        const valPart = rawLine.slice(equalsIdx + 1).trim();
        const keySegments = parseTomlKeySegments(keyPart);
        if (keySegments) {
          if (
            isDedicatedServerSection(keySegments, serverName) &&
            valPart.startsWith("{") &&
            valPart.includes("}")
          ) {
            const tableContent = valPart.slice(valPart.indexOf("{") + 1, valPart.lastIndexOf("}"));
            topLevelServerConfig = parseTomlInlineServerBody(tableContent);
            continue;
          }
          if (keySegments.length >= 3) {
            const containerSegs = keySegments.slice(0, -2);
            const sNameSeg = keySegments[keySegments.length - 2];
            const propSeg = keySegments[keySegments.length - 1];
            if (isContainerPath(containerSegs) && sNameSeg === serverName) {
              if (!topLevelServerConfig) topLevelServerConfig = {};
              applyDottedKeyValue(topLevelServerConfig, [propSeg!], valPart);
            }
          }
        }
      }
    }
  }

  if (dedicatedSectionBodyLines !== null) {
    return parseTomlServerBody(dedicatedSectionBodyLines.join("\n"));
  }

  if (containerServerConfig !== null) {
    return containerServerConfig;
  }

  if (topLevelServerConfig !== null) {
    return topLevelServerConfig;
  }

  return null;
}

/**
 * Extracts a server configuration record from Codex JSON content.
 */
export function parseCodexJsonServerConfig(
  content: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
): CodexMcpServerConfig | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const doc = JSON.parse(content);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const parsed = doc as CodexJsonConfigDoc;
    const servers =
      parsed.mcpServers ??
      parsed.mcp_servers ??
      (parsed.mcp && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp)
        ? (parsed.mcp as Record<string, unknown>).servers
        : undefined);
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
    const server = (servers as Record<string, unknown>)[serverName];
    if (!server || typeof server !== "object" || Array.isArray(server)) return null;
    return server as CodexMcpServerConfig;
  } catch {
    return null;
  }
}

/**
 * Verifies that the Resin Gateway is properly registered in the Codex configuration.
 */
export async function verifyCodexMcpConfig(
  targetPathOrOptions: string | VerifyCodexMcpConfigOptions,
  expectedCommandOrUrl?: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<boolean> {
  let targetPath: string;
  let expectedUrl: string | undefined;
  let expectedCommand: string | undefined;
  let gatewayUrl: string | undefined;
  let sName = serverName;
  let bridge = fsBridge;

  if (typeof targetPathOrOptions === "object" && targetPathOrOptions !== null) {
    targetPath = targetPathOrOptions.targetPath;
    expectedUrl = targetPathOrOptions.expectedUrl;
    expectedCommand = targetPathOrOptions.expectedCommand ?? targetPathOrOptions.command;
    gatewayUrl = targetPathOrOptions.gatewayUrl;
    sName = targetPathOrOptions.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;
    bridge = targetPathOrOptions.fsBridge ?? defaultFsBridge;
  } else {
    targetPath = targetPathOrOptions;
    if (expectedCommandOrUrl) {
      if (
        expectedCommandOrUrl.startsWith("http://") ||
        expectedCommandOrUrl.startsWith("https://") ||
        expectedCommandOrUrl.startsWith("ws://") ||
        expectedCommandOrUrl.startsWith("wss://")
      ) {
        gatewayUrl = expectedCommandOrUrl;
      } else {
        expectedCommand = expectedCommandOrUrl;
      }
    }
  }

  const content = await bridge.readFile(targetPath);
  if (!content || content.trim().length === 0) return false;

  const server = targetPath.endsWith(".json")
    ? parseCodexJsonServerConfig(content, sName)
    : parseCodexTomlServerConfig(content, sName);

  if (!server) return false;

  if (expectedCommand !== undefined) {
    return server.command === expectedCommand;
  }

  if (expectedUrl !== undefined) {
    return server.url === expectedUrl;
  }

  if (isRecognizedResinMcpEntry(server, gatewayUrl)) {
    return true;
  }

  if (server.command !== undefined && typeof server.command === "string") {
    if (sName !== DEFAULT_GATEWAY_SERVER_NAME && server.command.trim().length > 0) {
      return true;
    }
  }

  if (server.url !== undefined && typeof server.url === "string") {
    if (gatewayUrl && server.url === gatewayUrl) {
      return true;
    }
    if (sName !== DEFAULT_GATEWAY_SERVER_NAME && server.url.trim().length > 0) {
      return true;
    }
  }
  return false;
}
