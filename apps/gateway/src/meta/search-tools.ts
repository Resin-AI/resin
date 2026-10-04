import type { CapabilityManifest, ToolParameterSchema } from "@resin/contracts";
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
  /** The tool's input schema, so a caller can invoke it without a separate schema lookup. */
  inputSchema: ToolParameterSchema | JsonRpcParams;
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
 * Local-only detail about what a tool runs, such as a learned tool's recorded program. It is
 * resolved on this machine for the local agent's discovery and never uploaded.
 */
export type LocalToolDescriber = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => string | undefined;

/** The input schema a tool is invoked with; a tool without declared inputs takes none. */
export function toolInputSchema(tool: RegistryTool): ToolParameterSchema | JsonRpcParams {
  return (
    tool.parameters ??
    tool.manifest?.parameters ?? {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    }
  );
}

/** The description an agent sees: the catalog's, followed by any local detail. */
export function describeToolLocally(
  tool: Pick<RegistryTool, "artifactDigest" | "description" | "manifest">,
  context: WorkspaceContext,
  describer?: LocalToolDescriber,
): string {
  const catalog = tool.description || tool.manifest?.description || "";
  const local = describer?.(tool, context);
  return local ? (catalog ? `${catalog}\n\n${local}` : local) : catalog;
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

/** Lowercases text and splits it into whole words, folding a plural `s` so `tests` finds `test`. */
function searchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) =>
      token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token,
    );
}

/** Whether `needle` occurs as a contiguous run of `haystack`. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((token, i) => haystack[start + i] === token)) {
      return true;
    }
  }
  return false;
}

/** The text of one candidate tool that a query is matched against. */
interface SearchableTool {
  /** Exposed and registered names. */
  names: string[];
  tags: string[];
  /** What the agent sees, including a learned tool's local recorded program. */
  description: string;
  isPinned: boolean;
}

// A query word counts more in a tool's name than in its tags, and more there than in its description.
const NAME_WEIGHT = 2;
const TAG_WEIGHT = 1.5;
const DESCRIPTION_WEIGHT = 1;
// Bonuses for searching by a tool's name; they outrank any word match (worth at most LEXICAL_SCALE).
const EXACT_NAME_BONUS = 100;
const NAME_PREFIX_BONUS = 60;
const NAME_PHRASE_BONUS = 35;
const LEXICAL_SCALE = 20;
const PINNED_BONUS = 5;
// A word in more than half the candidates (and in more than this many) cannot by itself make a tool
// match: learned tools share boilerplate ("Runs ...", "recorded shell program", the `shell` tag).
const UBIQUITOUS_MIN_TOOLS = 5;
// A tool covering less than this share of the query weight the best tool covers is dropped as noise
// (so its Lucene-style coverage-squared relevance stays above ~35% of the best).
const RELATIVE_COVERAGE_FLOOR = 0.6;

/**
 * Scores each tool against the query, or returns undefined for a tool that does not match.
 *
 * Query words are weighted by inverse document frequency over the candidates, so a word nearly every
 * tool contains contributes almost nothing and a distinctive one (`pnpm`, `gh`) decides the ranking.
 * A tool's word score is scaled by the share of the query's weight it covers, so tools matching the
 * whole command outrank tools matching one common word of it. Searching by name earns a bonus.
 */
function scoreToolsForQuery(
  query: string,
  tools: readonly SearchableTool[],
): (number | undefined)[] {
  const queryTokens = [...new Set(searchTokens(query))];
  const documents = tools.map((tool) => {
    const nameSequences = tool.names.map(searchTokens);
    const name = new Set(nameSequences.flat());
    const tags = new Set(tool.tags.flatMap(searchTokens));
    const description = new Set(searchTokens(tool.description));
    return { nameSequences, name, tags, description };
  });

  const total = documents.length;
  const idf = new Map<string, number>();
  const informative = new Set<string>();
  for (const token of queryTokens) {
    const frequency = documents.filter(
      (doc) => doc.name.has(token) || doc.tags.has(token) || doc.description.has(token),
    ).length;
    if (frequency === 0) {
      continue;
    }
    idf.set(token, Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5)));
    if (frequency <= total / 2 || frequency <= UBIQUITOUS_MIN_TOOLS) {
      informative.add(token);
    }
  }
  const queryWeight = [...idf.values()].reduce((sum, weight) => sum + weight, 0);

  const scored = tools.map((tool, index) => {
    const doc = documents[index];
    if (!doc) {
      return undefined;
    }
    const startsWithQuery = (seq: string[]) =>
      queryTokens.length > 0 && queryTokens.every((token, i) => seq[i] === token);
    const exact =
      tool.names.some((name) => name.toLowerCase() === query) ||
      doc.nameSequences.some((seq) => seq.length === queryTokens.length && startsWithQuery(seq));
    const prefix =
      !exact &&
      (tool.names.some((name) => name.toLowerCase().startsWith(query)) ||
        doc.nameSequences.some(startsWithQuery));
    const phrase =
      queryTokens.length > 0 && doc.nameSequences.some((seq) => containsSequence(seq, queryTokens));

    let matchedWeight = 0;
    let fieldWeighted = 0;
    let matchesInformative = false;
    for (const [token, weight] of idf) {
      const fieldWeight = doc.name.has(token)
        ? NAME_WEIGHT
        : doc.tags.has(token)
          ? TAG_WEIGHT
          : doc.description.has(token)
            ? DESCRIPTION_WEIGHT
            : 0;
      if (fieldWeight === 0) {
        continue;
      }
      matchedWeight += weight;
      fieldWeighted += weight * fieldWeight;
      matchesInformative ||= informative.has(token);
    }
    const coverage = queryWeight > 0 ? matchedWeight / queryWeight : 0;
    const lexical =
      queryWeight > 0
        ? (LEXICAL_SCALE * fieldWeighted * coverage) / (NAME_WEIGHT * queryWeight)
        : 0;
    const bonus = exact
      ? EXACT_NAME_BONUS
      : prefix
        ? NAME_PREFIX_BONUS
        : phrase
          ? NAME_PHRASE_BONUS
          : 0;
    return { lexical, bonus, coverage, alwaysMatches: exact || prefix, matchesInformative };
  });

  const bestCoverage = Math.max(0, ...scored.map((s) => (s?.matchesInformative ? s.coverage : 0)));
  return scored.map((s, index) => {
    if (!s) {
      return undefined;
    }
    const relevant = s.matchesInformative && s.coverage >= RELATIVE_COVERAGE_FLOOR * bestCoverage;
    if (!s.alwaysMatches && !relevant) {
      return undefined;
    }
    const score = s.bonus + s.lexical + (tools[index]?.isPinned ? PINNED_BONUS : 0);
    return Math.round(score * 100) / 100;
  });
}

/**
 * Factory for creating the search_tools handler.
 */
export function createSearchToolsHandler(
  registry: ToolRegistry,
  describer?: LocalToolDescriber,
): ToolHandler {
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
    // The version each tool resolves to when invoked: the registry keeps every version this process
    // registered, oldest first, so a version synced after startup would otherwise lose to its
    // predecessor here while get_tool_schema and invoke_tool run the new one.
    const activeVersions = (await registry.resolveCatalog(context.workspaceId, context.sessionId))
      .tools;

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
      // The meta-tools are always exposed directly; searching lists them only when asked for.
      if (tool.isSystem && requestedScope !== "system") {
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

      // Only pick the pinned, else the active, version per toolId for search listing
      const existing = candidateMap.get(tool.toolId);
      const isActive = activeVersions[tool.toolId]?.version === tool.version;
      if (!existing || isPinned || (isActive && !existing.isPinned)) {
        candidateMap.set(tool.toolId, { tool, isPinned, isDisabled });
      }
    }

    // Filter, then score against the tools that remain: word weights depend on the whole set.
    // The registered name stays searchable when the exposed one is disambiguated.
    const filtered: { item: SearchToolsResultItem; registeredName: string }[] = [];

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

      filtered.push({
        registeredName: tool.name,
        item: {
          toolId: tool.toolId,
          name: tool.exposedName || tool.name,
          version: tool.version,
          scope: tool.scope ?? "workspace",
          status: isDisabled ? "disabled" : tool.status || "active",
          description: describeToolLocally(tool, context, describer),
          inputSchema: toolInputSchema(tool),
          tags,
          capabilities: capSummary,
          isPinned,
          isDisabled,
          score: undefined,
        },
      });
    }

    const scores = query
      ? scoreToolsForQuery(
          query,
          filtered.map(({ item, registeredName }) => ({
            names: [item.name, registeredName],
            tags: item.tags,
            description: item.description,
            isPinned: item.isPinned,
          })),
        )
      : [];
    const scoredTools = query
      ? filtered.flatMap(({ item }, index) => {
          const score = scores[index];
          return score === undefined ? [] : [{ item: { ...item, score }, score }];
        })
      : filtered.map(({ item }) => ({ item, score: 0 }));

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
          text: JSON.stringify(response),
        },
      ],
    };
  };
}
