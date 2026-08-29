import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  applyConfigMutation,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
  migrateJsonMcpServers,
  planConfigMutation,
  rollbackConfigMutation,
} from "@resin/harness-contracts";
import { CODEX_HARNESS_ID } from "./discovery.js";

export const DEFAULT_GATEWAY_SERVER_NAME = CANONICAL_RESIN_MCP_SERVER_KEY;
/**
 * Options for planning Codex MCP configuration mutations.
 */
export interface PlanCodexMcpConfigOptions {
  targetPath: string;
  gatewayUrl: string;
  serverName?: string;
  fsBridge?: ConfigFsBridge;
  currentContent?: string | null;
}

/**
 * Updates or inserts an MCP server definition into TOML content while preserving comments and existing structure.
 * Safely migrates recognized legacy aliases (resin_gateway, resin-gateway) to the canonical server name.
 */
export function updateTomlMcpConfig(
  content: string,
  serverName: string,
  gatewayUrl: string,
): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return `# Codex CLI Configuration\n\n[mcp_servers.${serverName}]\nurl = "${gatewayUrl}"\n`;
  }

  // Step 1: Remove recognized legacy aliases from TOML content while preserving user extras
  let cleanedContent = content;
  const legacyExtraLines: string[] = [];

  const canonicalSectionRegex = new RegExp(
    `^[ \\t]*\\[[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${escapeRegExp(serverName)}"|'${escapeRegExp(serverName)}'|${escapeRegExp(serverName)})[ \\t]*\\]`,
    "m",
  );
  const canonicalExists = canonicalSectionRegex.test(cleanedContent);

  for (const legacyAlias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    if (legacyAlias === serverName) continue;

    // Check for section headers: [mcp_servers.alias], [mcpServers.alias], ["mcp_servers".alias], etc.
    const legacySectionRegex = new RegExp(
      `^[ \\t]*\\[[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers)[ \\t]*\\.[ \\t]*(?:"${escapeRegExp(legacyAlias)}"|'${escapeRegExp(legacyAlias)}'|${escapeRegExp(legacyAlias)})[ \\t]*\\][ \\t]*(?:\\r?\\n)?`,
      "m",
    );

    const legacyMatch = cleanedContent.match(legacySectionRegex);
    if (legacyMatch && legacyMatch.index !== undefined) {
      const startIndex = legacyMatch.index;
      const afterHeaderIndex = startIndex + legacyMatch[0].length;
      const rest = cleanedContent.slice(afterHeaderIndex);
      const nextSectionMatch = rest.match(/^[ \t]*\[/m);
      const sectionEnd =
        nextSectionMatch && nextSectionMatch.index !== undefined
          ? afterHeaderIndex + nextSectionMatch.index
          : cleanedContent.length;

      const sectionBody = cleanedContent.slice(afterHeaderIndex, sectionEnd);
      const urlMatch = sectionBody.match(/^[ \t]*url[ \t]*=[ \t]*["']([^"']+)["']/m);
      const commandMatch = sectionBody.match(/^[ \t]*command[ \t]*=[ \t]*["']([^"']+)["']/m);

      const entryObj = {
        url: urlMatch ? urlMatch[1] : undefined,
        command: commandMatch ? commandMatch[1] : undefined,
      };

      if (isRecognizedResinMcpEntry(entryObj, gatewayUrl)) {
        if (!canonicalExists) {
          const bodyLines = sectionBody.split(/\r?\n/);
          for (const line of bodyLines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith("#")) continue;
            if (/^(?:url|type|command|args)[ \t]*=/i.test(trimmedLine)) continue;
            legacyExtraLines.push(line);
          }
        }
        // Remove this legacy section cleanly
        cleanedContent = `${cleanedContent.slice(0, startIndex)}${cleanedContent.slice(sectionEnd)}`;
      }
    }

    // Check for dotted inline table entries: mcp_servers.alias = { ... }
    const dottedInlineRegex = new RegExp(
      `^[ \\t]*(?:mcp_servers|mcpServers|mcp\\.servers|"mcp_servers"|'mcp_servers'|"mcpServers"|'mcpServers')[ \\t]*\\.[ \\t]*(?:"${escapeRegExp(legacyAlias)}"|'${escapeRegExp(legacyAlias)}'|${escapeRegExp(legacyAlias)})[ \\t]*=[ \\t]*\\{([^}]+)\\}[ \\t]*(?:\\r?\\n)?`,
      "m",
    );
    const dottedMatch = cleanedContent.match(dottedInlineRegex);
    if (dottedMatch && dottedMatch.index !== undefined) {
      const inlineBody = dottedMatch[1]!;
      const urlMatch = inlineBody.match(/url[ \\t]*=[ \\t]*["']([^"']+)["']/);
      const commandMatch = inlineBody.match(/command[ \\t]*=[ \\t]*["']([^"']+)["']/);
      const entryObj = {
        url: urlMatch ? urlMatch[1] : undefined,
        command: commandMatch ? commandMatch[1] : undefined,
      };
      if (isRecognizedResinMcpEntry(entryObj, gatewayUrl)) {
        cleanedContent = `${cleanedContent.slice(0, dottedMatch.index)}${cleanedContent.slice(dottedMatch.index + dottedMatch[0].length)}`;
      }
    }

    // Check for inline table entries scoped strictly inside MCP container sections: [mcp_servers], [mcpServers], [mcp.servers]
    const containerHeaderRegex =
      /^[ \t]*\[[ \t]*(?:mcp_servers|mcpServers|mcp\.servers|"mcp_servers"|'mcp_servers'|"mcpServers"|'mcpServers')[ \t]*\][ \t]*(?:\r?\n)?/gm;
    let containerMatch: RegExpExecArray | null;
    while ((containerMatch = containerHeaderRegex.exec(cleanedContent)) !== null) {
      const containerStart = containerMatch.index + containerMatch[0].length;
      const rest = cleanedContent.slice(containerStart);
      const nextSection = rest.match(/^[ \t]*\[/m);
      const containerEnd =
        nextSection && nextSection.index !== undefined
          ? containerStart + nextSection.index
          : cleanedContent.length;
      const containerBody = cleanedContent.slice(containerStart, containerEnd);

      const inlineInContainerRegex = new RegExp(
        `^[ \\t]*(?:"${escapeRegExp(legacyAlias)}"|'${escapeRegExp(legacyAlias)}'|${escapeRegExp(legacyAlias)})[ \\t]*=[ \\t]*\\{([^}]+)\\}[ \\t]*(?:\\r?\\n)?`,
        "m",
      );
      const matchInContainer = containerBody.match(inlineInContainerRegex);
      if (matchInContainer && matchInContainer.index !== undefined) {
        const inlineBody = matchInContainer[1]!;
        const urlMatch = inlineBody.match(/url[ \\t]*=[ \\t]*["']([^"']+)["']/);
        const commandMatch = inlineBody.match(/command[ \\t]*=[ \\t]*["']([^"']+)["']/);
        const entryObj = {
          url: urlMatch ? urlMatch[1] : undefined,
          command: commandMatch ? commandMatch[1] : undefined,
        };
        if (isRecognizedResinMcpEntry(entryObj, gatewayUrl)) {
          const removeStart = containerStart + matchInContainer.index;
          const removeEnd = removeStart + matchInContainer[0].length;
          cleanedContent = `${cleanedContent.slice(0, removeStart)}${cleanedContent.slice(removeEnd)}`;
        }
      }
    }
  }

  // Step 2: Add or update canonical server section
  const match = cleanedContent.match(canonicalSectionRegex);
  if (match && match.index !== undefined) {
    const startIndex = match.index;
    const afterHeaderIndex = startIndex + match[0].length;
    const rest = cleanedContent.slice(afterHeaderIndex);
    const nextSectionMatch = rest.match(/^[ \t]*\[/m);
    const sectionEnd =
      nextSectionMatch && nextSectionMatch.index !== undefined
        ? afterHeaderIndex + nextSectionMatch.index
        : cleanedContent.length;

    const sectionBody = cleanedContent.slice(afterHeaderIndex, sectionEnd);
    const urlMatch = sectionBody.match(/^[ \t]*url[ \t]*=[ \t]*"([^"]+)"/m);
    if (urlMatch && urlMatch[1] === gatewayUrl && cleanedContent === content) {
      return content;
    }

    const header = match[0].trim();
    const existingNonTransportLines = sectionBody.split(/\r?\n/).filter((line) => {
      const trimmedLine = line.trim();
      return trimmedLine && !/^(?:url|type|command|args)[ \t]*=/i.test(trimmedLine);
    });

    const extraContent =
      existingNonTransportLines.length > 0 ? `\n${existingNonTransportLines.join("\n")}` : "";
    const newSection = `${header}\nurl = "${gatewayUrl}"${extraContent}\n`;
    const before = cleanedContent.slice(0, startIndex);
    const after = cleanedContent.slice(sectionEnd);

    return `${before}${newSection}${after}`;
  }

  const extraContent = legacyExtraLines.length > 0 ? `\n${legacyExtraLines.join("\n")}` : "";
  const suffix = cleanedContent.endsWith("\n") ? "" : "\n";
  return `${cleanedContent}${suffix}\n[mcp_servers.${serverName}]\nurl = "${gatewayUrl}"${extraContent}\n`;
}
/**
 * Updates or inserts an MCP server definition into JSON content while preserving existing keys.
 */
export function updateJsonMcpConfig(
  content: string,
  serverName: string,
  gatewayUrl: string,
): string {
  const trimmed = content.trim();
  let parsed: Record<string, unknown> = {};

  if (trimmed) {
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  const serversKey = "mcp_servers" in parsed ? "mcp_servers" : "mcpServers";
  const currentServers =
    typeof parsed[serversKey] === "object" && parsed[serversKey] !== null
      ? (parsed[serversKey] as Record<string, unknown>)
      : {};

  const updatedServers = migrateJsonMcpServers(
    currentServers,
    { url: gatewayUrl },
    gatewayUrl,
    serverName,
  );

  const updatedConfig = {
    ...parsed,
    [serversKey]: updatedServers,
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

  const isJson = options.targetPath.endsWith(".json");
  const plannedContent = isJson
    ? updateJsonMcpConfig(currentContent ?? "", serverName, options.gatewayUrl)
    : updateTomlMcpConfig(currentContent ?? "", serverName, options.gatewayUrl);

  const diffDescription = `Register Resin Gateway MCP server (${serverName} -> ${options.gatewayUrl}) in ${options.targetPath}`;

  return planConfigMutation({
    harnessId: CODEX_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent,
    description: diffDescription,
  });
}

/**
 * Applies a planned MCP configuration mutation, creating a restorable backup.
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
 * Verifies that the Resin Gateway is properly registered in the Codex configuration.
 */
export async function verifyCodexMcpConfig(
  targetPath: string,
  gatewayUrl?: string,
  serverName: string = DEFAULT_GATEWAY_SERVER_NAME,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<boolean> {
  const content = await fsBridge.readFile(targetPath);
  if (!content) return false;

  if (targetPath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const servers = (parsed.mcpServers ?? parsed.mcp_servers) as
        | Record<string, unknown>
        | undefined;
      if (!servers || typeof servers !== "object") return false;

      const server = servers[serverName] as Record<string, unknown> | undefined;
      if (!server || typeof server !== "object") return false;

      if (gatewayUrl) {
        return server.url === gatewayUrl;
      }
      return typeof server.url === "string" && server.url.length > 0;
    } catch {
      return false;
    }
  }

  // Check TOML
  const escapedName = escapeRegExp(serverName);
  const headerRegex = new RegExp(
    `^\\[\\s*(?:mcp_servers|mcpServers|mcp\\.servers)\\.${escapedName}\\s*\\]`,
    "m",
  );
  if (!headerRegex.test(content)) return false;

  if (gatewayUrl) {
    const escapedUrl = escapeRegExp(gatewayUrl);
    const urlRegex = new RegExp(`^\\s*url\\s*=\\s*"${escapedUrl}"`, "m");
    return urlRegex.test(content);
  }

  return /^\s*url\s*=\s*"[^"]+"/m.test(content);
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
