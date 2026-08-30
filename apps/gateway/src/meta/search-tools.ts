import type { CapabilityManifest } from "@resin/contracts";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

export interface CapabilitySummary {
  types: string[];
  summary: string;
  auditLevel: string;
  network?: {
    allowedHosts: string[];
    allowedPorts?: number[];
    allowAll?: boolean;
  };
  filesystem?: {
    readOnly: boolean;
    allowedPaths: string[];
  };
}

export interface SearchToolsResultItem {
  toolId: string;
  name: string;
  version: string;
  scope: string;
  status: string;
  description: string;
  tags: string[];
  capabilities: CapabilitySummary;
  isPinned: boolean;
  isDisabled: boolean;
  score?: number;
}

export interface SearchToolsResponse {
  tools: SearchToolsResultItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SearchToolsParams {
  query?: string;
  tags?: string[];
  capabilities?: string[];
  scope?: "session" | "workspace" | "account" | "system" | "global" | "all";
  status?: "active" | "draft" | "deprecated" | "revoked" | "all";
  limit?: number;
  offset?: number;
}

/**
 * Summarizes tool capability manifest into a human and agent-readable summary.
 */
export function summarizeCapabilities(caps?: CapabilityManifest): CapabilitySummary {
  if (!caps) {
    return {
      types: ["none"],
      summary: "No external capabilities required (pure compute)",
      auditLevel: "standard",
    };
  }

  const detectedTypes: string[] = [];
  const summaryParts: string[] = [];

  let networkInfo: CapabilitySummary["network"] | undefined;
  if (caps.net) {
    const net = caps.net;
    const hosts = [...(net.allowedHosts ?? []), ...(net.allowedDomains ?? [])];
    const hasNet = Boolean(net.allowOutbound || hosts.length > 0);
    if (hasNet) {
      detectedTypes.push("network");
      networkInfo = {
        allowedHosts: hosts,
        allowedPorts: net.allowedPorts,
        allowAll: Boolean(net.allowOutbound && hosts.length === 0),
      };
      if (hosts.length > 0) {
        summaryParts.push(`Network (${hosts.join(", ")})`);
      } else {
        summaryParts.push("Network (outbound)");
      }
    }
  }

  let filesystemInfo: CapabilitySummary["filesystem"] | undefined;
  if (caps.fs) {
    const fs = caps.fs;
    const paths = Array.from(new Set([...(fs.readPaths ?? []), ...(fs.writePaths ?? [])]));
    const hasFs =
      paths.length > 0 || (fs.allowTemp && (fs.readPaths?.length || fs.writePaths?.length));
    if (hasFs || paths.length > 0) {
      detectedTypes.push("filesystem");
      const isReadOnly = (fs.writePaths?.length ?? 0) === 0;
      filesystemInfo = {
        readOnly: isReadOnly,
        allowedPaths: paths,
      };
      const mode = isReadOnly ? "read-only" : "read-write";
      if (paths.length > 0) {
        summaryParts.push(`Filesystem (${mode}: ${paths.join(", ")})`);
      } else {
        summaryParts.push(`Filesystem (${mode})`);
      }
    }
  }

  if (caps.command) {
    const cmd = caps.command;
    const cmds = [...(cmd.allowedCommands ?? []), ...(cmd.allowedBinaries ?? [])];
    if (cmd.allowShellExecution || cmds.length > 0) {
      detectedTypes.push("shell");
      summaryParts.push("Shell execution");
    }
  }

  if (caps.secrets) {
    const sec = caps.secrets;
    const names = [...(sec.allowedSecretNames ?? []), ...(sec.allowedPrefixes ?? [])];
    if (names.length > 0) {
      detectedTypes.push("secrets");
      summaryParts.push(`Secrets access (${names.join(", ")})`);
    }
  }

  if (detectedTypes.length === 0) {
    detectedTypes.push("builtin");
    summaryParts.push("Builtin capability / pure compute");
  }

  return {
    types: detectedTypes,
    summary: summaryParts.join("; "),
    auditLevel: "standard",
    network: networkInfo,
    filesystem: filesystemInfo,
  };
}

/**
 * Extracts all searchable tags from a tool.
 */
function extractTags(tool: RegistryTool): string[] {
  const tags = new Set<string>();

  const meta =
    tool.manifest.metadata && tool.manifest.metadata instanceof Object
      ? tool.manifest.metadata
      : undefined;
  if (meta && "tags" in meta && Array.isArray(meta.tags)) {
    for (const t of meta.tags) {
      if (t && Object.prototype.toString.call(t) === "[object String]" && String(t).trim()) {
        tags.add(String(t).trim().toLowerCase());
      }
    }
  }

  const capSummary = summarizeCapabilities(tool.manifest.capabilities);
  for (const t of capSummary.types) {
    tags.add(t.toLowerCase());
  }

  return Array.from(tags);
}

/**
 * Checks whether a tool is visible within the caller's context scope.
 */
export function isToolInScope(tool: RegistryTool, context: WorkspaceContext): boolean {
  const toolScope = tool.scope ?? "workspace";

  // System or global tools are visible everywhere
  if (toolScope === "system" || toolScope === "global" || tool.isSystem) {
    return true;
  }

  // Session-scoped tools: must match workspace and session
  if (toolScope === "session" || tool.sessionId) {
    if (!context.sessionId || tool.sessionId !== context.sessionId) {
      return false;
    }
    if (tool.workspaceId && context.workspaceId && tool.workspaceId !== context.workspaceId) {
      return false;
    }
    return true;
  }

  // Workspace-scoped tools (default): must match workspace
  if (tool.workspaceId) {
    return tool.workspaceId === context.workspaceId;
  }

  return false;
}

/**
 * Computes lexical and tag match score for ranking.
 */
function computeToolScore(
  tool: RegistryTool,
  queryLower: string,
  tags: string[],
  isPinned: boolean,
): number {
  if (!queryLower) {
    return isPinned ? 10 : 0;
  }

  let score = 0;
  const nameLower = (tool.exposedName || tool.name).toLowerCase();
  const rawNameLower = tool.name.toLowerCase();
  const descLower = (tool.description || tool.manifest.description || "").toLowerCase();

  // Exact name match
  if (nameLower === queryLower || rawNameLower === queryLower) {
    score += 100;
  }
  // Name prefix match
  else if (nameLower.startsWith(queryLower) || rawNameLower.startsWith(queryLower)) {
    score += 60;
  }
  // Substring in name
  else if (nameLower.includes(queryLower) || rawNameLower.includes(queryLower)) {
    score += 35;
  }

  // Description match
  if (descLower.includes(queryLower)) {
    score += 15;
  }

  // Word token matches
  const queryTokens = queryLower.split(/\s+/).filter(Boolean);
  for (const token of queryTokens) {
    if (nameLower.includes(token)) {
      score += 10;
    }
    if (descLower.includes(token)) {
      score += 5;
    }
    if (tags.some((t) => t.includes(token))) {
      score += 12;
    }
  }

  // Tag matches
  for (const tag of tags) {
    if (tag === queryLower) {
      score += 25;
    } else if (tag.includes(queryLower)) {
      score += 10;
    }
  }

  // Boost for pinned tools
  if (isPinned) {
    score += 5;
  }

  return score;
}

/**
 * Factory for creating the search_tools handler.
 */
export function createSearchToolsHandler(registry: ToolRegistry): ToolHandler {
  return async (
    context: WorkspaceContext,
    params: JsonRpcParams,
    _options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const query =
      params.query && Object.prototype.toString.call(params.query) === "[object String]"
        ? String(params.query).trim().toLowerCase()
        : "";
    const requestedTags = Array.isArray(params.tags)
      ? params.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
      : [];
    const requestedCaps = Array.isArray(params.capabilities)
      ? params.capabilities.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    const requestedScope = params.scope;
    const requestedStatus = params.status ?? "active";
    const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
    const offset = Math.max(Number(params.offset) || 0, 0);

    // Retrieve caller's user controls
    const controls = await registry.controls.getControls(context.workspaceId);

    // Collect all registered tools and filter to caller's scoped tools
    const allRegistered = registry.getAllRegisteredTools();
    const candidateMap = new Map<
      string,
      { tool: RegistryTool; isPinned: boolean; isDisabled: boolean }
    >();

    for (const tool of allRegistered) {
      // Check scope visibility strictly
      if (!isToolInScope(tool, context)) {
        continue;
      }

      const isPinned = controls.pinnedVersions[tool.toolId] === tool.version;
      const isDisabled = controls.disabledTools.includes(tool.toolId) && !tool.isSystem;

      // Filter by status
      if (requestedStatus !== "all") {
        if (requestedStatus === "active" && isDisabled) {
          continue;
        }
        if (tool.status !== requestedStatus && requestedStatus !== "active") {
          continue;
        }
      }

      // Filter by scope
      if (requestedScope && requestedScope !== "all") {
        const toolScope = tool.scope ?? "workspace";
        if (toolScope !== requestedScope) {
          if (
            requestedScope === "system" &&
            !tool.isSystem &&
            toolScope !== "system" &&
            toolScope !== "global"
          ) {
            continue;
          }
          if (requestedScope !== "system" && toolScope !== requestedScope) {
            continue;
          }
        }
      }

      // Only pick the active or pinned version per toolId for search listing
      const existing = candidateMap.get(tool.toolId);
      if (!existing) {
        candidateMap.set(tool.toolId, { tool, isPinned, isDisabled });
      } else {
        // If this one is pinned or latest, replace
        if (isPinned) {
          candidateMap.set(tool.toolId, { tool, isPinned, isDisabled });
        }
      }
    }

    // Filter, Score, and Rank
    interface ScoredTool {
      item: SearchToolsResultItem;
      score: number;
    }

    const scoredTools: ScoredTool[] = [];

    for (const { tool, isPinned, isDisabled } of candidateMap.values()) {
      const tags = extractTags(tool);
      const capSummary = summarizeCapabilities(tool.manifest.capabilities);

      // Filter by requested tags
      if (requestedTags.length > 0) {
        const hasAllTags = requestedTags.some((rt) => tags.includes(rt));
        if (!hasAllTags) {
          continue;
        }
      }

      // Filter by requested capabilities
      if (requestedCaps.length > 0) {
        const hasCap = requestedCaps.some((rc) =>
          capSummary.types.map((t) => t.toLowerCase()).includes(rc),
        );
        if (!hasCap) {
          continue;
        }
      }

      const score = computeToolScore(tool, query, tags, isPinned);

      // If query was specified, exclude tools that didn't match at all
      if (query && score <= 0) {
        continue;
      }

      const resultItem: SearchToolsResultItem = {
        toolId: tool.toolId,
        name: tool.exposedName || tool.name,
        version: tool.version,
        scope: tool.scope ?? "workspace",
        status: isDisabled ? "disabled" : tool.status || "active",
        description: tool.description || tool.manifest.description || "",
        tags,
        capabilities: capSummary,
        isPinned,
        isDisabled,
        score: query ? score : undefined,
      };

      scoredTools.push({ item: resultItem, score });
    }

    // Sort by score descending, then name ascending
    scoredTools.sort((a, b) => {
      if (query) {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
      } else {
        // System tools first, then pinned, then alphabetical
        if (a.item.toolId.startsWith("sys_") && !b.item.toolId.startsWith("sys_")) return -1;
        if (!a.item.toolId.startsWith("sys_") && b.item.toolId.startsWith("sys_")) return 1;
        if (a.item.isPinned && !b.item.isPinned) return -1;
        if (!a.item.isPinned && b.item.isPinned) return 1;
      }
      return a.item.name.localeCompare(b.item.name);
    });

    const total = scoredTools.length;
    const paginated = scoredTools.slice(offset, offset + limit).map((s) => s.item);
    const hasMore = offset + limit < total;

    const response: SearchToolsResponse = {
      tools: paginated,
      total,
      limit,
      offset,
      hasMore,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  };
}
