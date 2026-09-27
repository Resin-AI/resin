import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigFsBridge,
  type ConfigMetadataRecord,
  type ConfigMutationPlan,
  defaultFsBridge,
  migrateJsonMcpServers,
  planConfigMutation,
} from "@resin/harness-contracts";
import { MUSE_HARNESS_ID } from "./discovery.js";

/** Muse rejects a settings file without this exact `schema_version` (1.4.0: only `1`). */
export const MUSE_SETTINGS_SCHEMA_VERSION = 1;

export class MuseSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuseSettingsError";
  }
}

function parseSettings(currentContent: string | null, targetPath: string): ConfigMetadataRecord {
  if (currentContent === null || currentContent.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(currentContent);
  } catch {
    // Rewriting an unreadable settings file would discard the user's configuration.
    throw new MuseSettingsError(`Muse settings at ${targetPath} are not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MuseSettingsError(`Muse settings at ${targetPath} are not a JSON object`);
  }
  // SAFETY: a parsed JSON object only holds JSON values.
  return parsed as ConfigMetadataRecord;
}

/**
 * Renders muse `settings.json` with Resin registered under `mcp_servers.<serverKey>` as a
 * stdio server. Every other setting and server is preserved; a new file gets the
 * `schema_version` muse requires.
 */
export function renderMuseSettings(options: {
  currentContent: string | null;
  targetPath: string;
  command?: string;
  args?: readonly string[];
  gatewayUrl?: string;
  serverKey?: string;
}): string {
  const doc = parseSettings(options.currentContent, options.targetPath);
  const existing = doc.mcp_servers;
  const servers =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, ConfigMetadataRecord>)
      : {};
  const next: ConfigMetadataRecord = {
    schema_version: doc.schema_version ?? MUSE_SETTINGS_SCHEMA_VERSION,
    ...doc,
  };
  next.mcp_servers = migrateJsonMcpServers(
    servers,
    {
      command: options.command ?? CANONICAL_RESIN_MCP_COMMAND,
      args: [...(options.args ?? CANONICAL_RESIN_MCP_ARGS)],
    },
    options.gatewayUrl,
    options.serverKey ?? CANONICAL_RESIN_MCP_SERVER_KEY,
  );
  return `${JSON.stringify(next, null, 2)}\n`;
}

export async function planMuseMcpConfig(options: {
  targetPath: string;
  command?: string;
  args?: readonly string[];
  gatewayUrl?: string;
  fsBridge?: ConfigFsBridge;
}): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const currentContent = await fsBridge.readFile(options.targetPath);
  return planConfigMutation({
    harnessId: MUSE_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent: renderMuseSettings({ ...options, currentContent }),
    description: "Register Resin Gateway in Muse Code settings.json mcp_servers",
  });
}
