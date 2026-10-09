import { Transform } from "node:stream";
import type { ListingToolDefinition } from "@resin/contracts";
import { recordDiscoveryFunnelEvent } from "@resin/observer/discovery-funnel";
import {
  DEFAULT_GATEWAY_INSTRUCTIONS,
  DISABLED_SEARCH_GATEWAY_INSTRUCTIONS,
  type LearnedToolListing,
  type ListedLearnedTool,
  searchListingInstructions,
  searchListingTools,
} from "../listing-surface.js";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "../protocol/framing.js";
import {
  InitializeParamsSchema,
  type JsonRpcId,
  type JsonRpcMessage,
  RESIN_BENCHMARK_ID_META,
  RESIN_LEARNED_TOOL_COMMANDS_META,
  RESIN_LEARNED_TOOL_COUNT_META,
  RESIN_LEARNED_TOOL_IDS_META,
  RESIN_LEARNED_TOOL_LISTING_META,
  RESIN_LEARNED_TOOL_META,
  RESIN_SEARCH_LISTING_META,
} from "../protocol/types.js";

export { DISABLED_SEARCH_GATEWAY_INSTRUCTIONS };

export const CONNECTION_DISABLED_SEARCH_REASON =
  "Disabled for this connection (start MCP shim with --enable-tool-search to enable)";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function listedLearnedTools(value: unknown): ListedLearnedTool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ListedLearnedTool[] => {
    const tool = record(entry);
    if (typeof tool?.name !== "string" || tool.name === "") return [];
    const runs = Array.isArray(tool.runs)
      ? tool.runs.filter((label): label is string => typeof label === "string" && label !== "")
      : [];
    return [
      {
        name: tool.name,
        ...(typeof tool.signature === "string" ? { signature: tool.signature } : {}),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(runs.length === 0 ? {} : { runs }),
      },
    ];
  });
}

/** The learned tools the gateway put in a result's `_meta`: only once the catalog is known. */
function learnedToolsOf(result: Record<string, unknown>): LearnedToolListing | undefined {
  const meta = record(result._meta);
  const count = meta?.[RESIN_LEARNED_TOOL_COUNT_META];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return undefined;
  const commands = meta?.[RESIN_LEARNED_TOOL_COMMANDS_META];
  return {
    count,
    commands: Array.isArray(commands)
      ? commands.filter((command): command is string => typeof command === "string")
      : [],
    listing: listedLearnedTools(meta?.[RESIN_LEARNED_TOOL_LISTING_META]),
  };
}

/**
 * What one connection was served, reported each time a tools/list answer reaches the harness: the
 * instructions its initialize answer carried, every tool definition the list carried, the cloud ids
 * of the learned tools among them, and whether the listing cap left relevant learned tools out.
 */
export interface ServedListingSurface {
  /** The MCP client's own name, from its initialize request. */
  clientName?: string;
  instructions: string;
  tools: ListingToolDefinition[];
  listedToolIds: string[];
  capped: boolean;
}

function isSearch(value: unknown): boolean {
  return typeof value === "string" && ["search_tools", "sys_search_tools"].includes(value.trim());
}

function isInvoke(value: unknown): boolean {
  return typeof value === "string" && ["invoke_tool", "sys_invoke_tool"].includes(value.trim());
}
interface ResolvedCall {
  targetTool: string;
  targetArgs: Record<string, unknown> | undefined;
}

function resolveTargetCall(name: unknown, args: unknown): ResolvedCall | undefined {
  if (typeof name !== "string") return undefined;
  let currentName = name.trim();
  let currentArgs = record(args);

  while (isInvoke(currentName)) {
    if (!currentArgs) break;
    // Match invoke_tool's public-name precedence; tool_name is only a fallback to name.
    const publicName = [currentArgs.name, currentArgs.tool_name]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim();
    const toolId = typeof currentArgs.toolId === "string" ? currentArgs.toolId.trim() : "";
    const metaNames = [
      "get_tool_schema",
      "sys_get_tool_schema",
      "manage_tools",
      "sys_manage_tools",
      "invoke_tool",
      "sys_invoke_tool",
    ];
    // Unknown names can fall back to a registered ID. Conflicts are rejected by the
    // backend and error responses are never rewritten here.
    const target = publicName && metaNames.includes(publicName) ? publicName : toolId || publicName;
    if (!target) break;
    currentName = target;
    currentArgs = record(currentArgs.parameters ?? currentArgs.arguments);
  }

  return { targetTool: currentName, targetArgs: currentArgs };
}

function targetsSearch(name: unknown, args: unknown): boolean {
  if (isSearch(name)) return true;
  if (typeof name !== "string" || !isInvoke(name)) return false;
  let params = record(args);
  // All aliases share one nested argument object; visit it once, not once per alias.
  while (params) {
    const targets = [params.name, params.tool_name, params.toolId];
    if (targets.some(isSearch)) return true;
    if (!targets.some((target) => typeof target === "string" && isInvoke(target))) return false;
    params = record(params.parameters ?? params.arguments);
  }
  return false;
}

type MetadataCallType = "list_versions" | "status" | "get_tool_schema";

interface PendingMetadataCall {
  type: MetadataCallType;
  includeDisabled?: boolean;
  compact?: boolean;
}

function classifyMetadataCall(name: unknown, args: unknown): PendingMetadataCall | undefined {
  const resolved = resolveTargetCall(name, args);
  if (!resolved) return undefined;
  const target = resolved.targetTool;
  if (["get_tool_schema", "sys_get_tool_schema"].includes(target)) {
    return { type: "get_tool_schema" };
  }
  if (["manage_tools", "sys_manage_tools"].includes(target)) {
    const action = resolved.targetArgs?.action;
    if (action === "status") {
      return { type: "status" };
    }
    if (action === "list_versions") {
      const a = resolved.targetArgs;
      const compact =
        a?.compact === true ||
        (a?.compact !== false &&
          (a?.query !== undefined ||
            a?.limit !== undefined ||
            a?.offset !== undefined ||
            a?.includeDisabled !== undefined ||
            a?.excludeToolIds !== undefined));
      return {
        type: "list_versions",
        includeDisabled: a?.includeDisabled === true,
        compact,
      };
    }
  }
  return undefined;
}

function transformMetadataResult(
  message: JsonRpcMessage,
  pending: PendingMetadataCall,
): JsonRpcMessage {
  if (!("result" in message) || message.error !== undefined) return message;
  const result = record(message.result);
  if (
    !result ||
    result.isError === true ||
    !Array.isArray(result.content) ||
    result.content.length === 0
  ) {
    return message;
  }
  const firstContent = record(result.content[0]);
  if (!firstContent || firstContent.type !== "text" || typeof firstContent.text !== "string") {
    return message;
  }

  try {
    const payload = record(JSON.parse(firstContent.text));
    if (!payload) return message;
    let changed = false;

    const isCompact =
      pending.type === "list_versions" &&
      (pending.compact || ("total" in payload && typeof payload.total === "number"));

    if (pending.type === "list_versions" && Array.isArray(payload.tools)) {
      if (isCompact) {
        if (pending.includeDisabled) {
          for (const item of payload.tools) {
            const tool = record(item);
            if (tool && (isSearch(tool.toolId) || isSearch(tool.name))) {
              tool.isDisabled = true;
              tool.disabledReason = CONNECTION_DISABLED_SEARCH_REASON;
              changed = true;
            }
          }
        }
      } else {
        for (const item of payload.tools) {
          const tool = record(item);
          if (tool && (isSearch(tool.toolId) || isSearch(tool.name))) {
            tool.isDisabled = true;
            tool.disabledReason = CONNECTION_DISABLED_SEARCH_REASON;
            if (Array.isArray(tool.installedVersions)) {
              for (const version of tool.installedVersions) {
                const entry = record(version);
                if (entry) entry.isActive = false;
              }
            }
            changed = true;
          }
        }
      }
    } else {
      if (isSearch(payload.toolId) || isSearch(payload.name)) {
        payload.isDisabled = true;
        payload.disabledReason = CONNECTION_DISABLED_SEARCH_REASON;
        if (pending.type === "list_versions" && Array.isArray(payload.installedVersions)) {
          for (const version of payload.installedVersions) {
            const entry = record(version);
            if (entry) entry.isActive = false;
          }
        }
        changed = true;
      }
    }

    if (!changed) return message;

    const text = isCompact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);

    return {
      ...message,
      result: {
        ...result,
        content: [
          {
            ...firstContent,
            text,
          },
          ...result.content.slice(1),
        ],
      },
    };
  } catch {
    return message;
  }
}

export interface ToolSearchSurface {
  input: Transform;
  output: Transform;
}

export interface ToolSearchSurfaceOptions {
  /** With `fullCatalog`, list and allow search_tools (Codex clients always get it). */
  enableSearch?: boolean;
  /**
   * List the daemon's whole catalog instead of the bounded default listing (see listing-surface):
   * invoke_tool, the learned tools of the caller's repository that fit the listing cap, and
   * search_tools only for the ones left out. Any learned tool still answers tools/call by name.
   */
  fullCatalog?: boolean;
  /**
   * The run's validated `RESIN_BENCHMARK_ID`, sent to the gateway on `initialize` so it marks the
   * invocations it records for this client.
   */
  benchmarkId?: string;
  /** Told what the harness was served, each time a tools/list answer reaches it. */
  onServed?: (surface: ServedListingSurface) => void;
}

/** A served tool definition: only the fields a model reads, which the footprint counts. */
function servedDefinition(tool: unknown): ListingToolDefinition[] {
  const entry = record(tool);
  if (entry === undefined || typeof entry.name !== "string") return [];
  return [
    {
      name: entry.name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.inputSchema === undefined ? {} : { inputSchema: entry.inputSchema }),
    },
  ];
}

/** A per-stdio-client view. Never mutates the daemon's shared catalog. */
export function createToolSearchSurface(
  output: NodeJS.WritableStream,
  options: ToolSearchSurfaceOptions = {},
): ToolSearchSurface {
  const enableSearch = options.enableSearch === true;
  const fullCatalog = options.fullCatalog === true;
  const searchOnlyListing = !fullCatalog;
  const lists = new Set<JsonRpcId>();
  const initializeIds = new Set<JsonRpcId>();
  const pendingMetadataCalls = new Map<JsonRpcId, PendingMetadataCall>();
  let clientIdentified = false;
  let clientName: string | undefined;
  let codexClient = false;
  let searchEnabled = enableSearch || searchOnlyListing;
  // Learned tools in the workspace's catalog, as the gateway last reported them; unknown until it
  // reports a count, which it does only once the catalog is known.
  let learnedTools: LearnedToolListing | undefined;
  // The instructions the harness's initialize answer carried; a surface is reported only after it.
  let servedInstructions: string | undefined;
  const send = (message: JsonRpcMessage) => output.write(encodeMcpMessage(message));
  const transform = (filter: (message: JsonRpcMessage) => JsonRpcMessage | undefined) => {
    const decoder = new McpFrameDecoder();
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          for (const message of decoder.push(chunk)) {
            const filtered = filter(message);
            if (filtered) this.push(encodeMcpMessage(filtered));
          }
        } catch (error) {
          decoder.reset();
          send({
            jsonrpc: "2.0",
            id: null,
            error: {
              code:
                error instanceof McpProtocolError
                  ? error.code
                  : JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
              message: "Invalid MCP message",
            },
          });
        }
        callback();
      },
    });
  };
  return {
    input: transform((message) => {
      if (!("method" in message)) return message;
      if (message.method === "initialize" && "id" in message && !clientIdentified) {
        const parsed = InitializeParamsSchema.safeParse(message.params);
        if (parsed.success) {
          clientIdentified = true;
          // Exact public MCP client names, not the gateway's broad harness-name heuristic.
          // This is a connection-local discovery surface, never an authorization decision.
          const name = parsed.data.clientInfo.name;
          clientName = name;
          codexClient = name === "codex-mcp-client" || name === "openai-codex-cli";
          searchEnabled = enableSearch || searchOnlyListing || codexClient;
        }
        initializeIds.add(message.id);
        const meta = {
          // Tells the gateway to keep the per-tool catalog out of the harness's own prompt files.
          ...(searchOnlyListing ? { [RESIN_SEARCH_LISTING_META]: true } : {}),
          ...(options.benchmarkId === undefined
            ? {}
            : { [RESIN_BENCHMARK_ID_META]: options.benchmarkId }),
        };
        if (Object.keys(meta).length > 0) {
          // Initialize params never reach the model.
          const params = record(message.params) ?? {};
          return { ...message, params: { ...params, _meta: { ...record(params._meta), ...meta } } };
        }
      }
      if (
        !searchEnabled &&
        message.method === "tools/call" &&
        targetsSearch(message.params?.name, message.params?.arguments)
      ) {
        if ("id" in message)
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: MCP_ERROR_CODES.TOOL_NOT_FOUND,
              message:
                "Tool 'search_tools' is disabled for this connection. " +
                'Use manage_tools with {"action":"list_versions","scope":"workspace"} ' +
                "for read-only discovery, or start the MCP shim with --enable-tool-search.",
            },
          });
        return undefined;
      }
      if (
        !searchEnabled &&
        message.method === "tools/call" &&
        "id" in message &&
        message.id !== null
      ) {
        const pending = classifyMetadataCall(message.params?.name, message.params?.arguments);
        if (pending) {
          pendingMetadataCalls.set(message.id, pending);
          if (pending.type === "list_versions" && pending.compact && !pending.includeDisabled) {
            const resolved = resolveTargetCall(message.params?.name, message.params?.arguments);
            if (resolved?.targetArgs) {
              const currentExclude = resolved.targetArgs.excludeToolIds;
              if (currentExclude === undefined) {
                resolved.targetArgs.excludeToolIds = ["sys_search_tools", "search_tools"];
              } else if (
                Array.isArray(currentExclude) &&
                currentExclude.every((id: unknown) => typeof id === "string")
              ) {
                resolved.targetArgs.excludeToolIds = Array.from(
                  new Set([...currentExclude, "sys_search_tools", "search_tools"]),
                );
              }
            }
          }
        }
      }
      if (message.method === "tools/list" && "id" in message) lists.add(message.id);
      return message;
    }),
    output: transform((message) => {
      if (!("method" in message) && "id" in message && message.id !== null) {
        if (initializeIds.delete(message.id)) {
          const result =
            "result" in message && message.error === undefined ? record(message.result) : undefined;
          if (result) learnedTools = learnedToolsOf(result) ?? learnedTools;
          const replacement = searchOnlyListing
            ? searchListingInstructions(learnedTools)
            : searchEnabled
              ? undefined
              : DISABLED_SEARCH_GATEWAY_INSTRUCTIONS;
          if (result && typeof result.instructions === "string") {
            const instructions =
              replacement === undefined
                ? result.instructions
                : result.instructions.includes(DEFAULT_GATEWAY_INSTRUCTIONS)
                  ? result.instructions.replace(DEFAULT_GATEWAY_INSTRUCTIONS, replacement)
                  : `${replacement}\n${result.instructions}`;
            servedInstructions = instructions;
            if (instructions !== result.instructions) {
              return { jsonrpc: "2.0", id: message.id, result: { ...result, instructions } };
            }
          }
        }
        const pending = pendingMetadataCalls.get(message.id);
        if (pending) {
          pendingMetadataCalls.delete(message.id);
          return transformMetadataResult(message, pending);
        }
        if (lists.delete(message.id) && "result" in message) {
          const result = record(message.result);
          if (result && Array.isArray(result.tools)) {
            learnedTools = learnedToolsOf(result);
            const tools = searchOnlyListing
              ? searchListingTools(result.tools, learnedTools)
              : result.tools.filter((tool) => {
                  const name = record(tool)?.name;
                  return typeof name === "string" && (searchEnabled || !isSearch(name));
                });
            const learnedIds = record(record(result._meta)?.[RESIN_LEARNED_TOOL_IDS_META]) ?? {};
            const listedToolIds = tools.flatMap((tool) => {
              const entry = record(tool);
              const id = typeof entry?.name === "string" ? learnedIds[entry.name] : undefined;
              return record(entry?._meta)?.[RESIN_LEARNED_TOOL_META] === true &&
                typeof id === "string"
                ? [id]
                : [];
            });
            // The discovery funnel counts the learned tools a search-only listing showed.
            if (searchOnlyListing && listedToolIds.length > 0) {
              recordDiscoveryFunnelEvent("tools_listed", { count: listedToolIds.length });
            }
            const forwarded: JsonRpcMessage = {
              jsonrpc: "2.0",
              id: message.id,
              result: { ...result, tools },
            };
            if (servedInstructions !== undefined && options.onServed !== undefined) {
              try {
                options.onServed({
                  ...(clientName === undefined ? {} : { clientName }),
                  instructions: servedInstructions,
                  tools: tools.flatMap(servedDefinition),
                  listedToolIds,
                  capped:
                    searchOnlyListing &&
                    learnedTools !== undefined &&
                    learnedTools.listing.length < learnedTools.count,
                });
              } catch {
                // Observing what was served never affects serving it.
              }
            }
            return forwarded;
          }
        }
      }
      return message;
    }),
  };
}
