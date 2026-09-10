import { Transform } from "node:stream";
import { DEFAULT_GATEWAY_INSTRUCTIONS, DISABLED_SEARCH_GATEWAY_INSTRUCTIONS } from "../gateway.js";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "../protocol/framing.js";
import { InitializeParamsSchema, type JsonRpcId, type JsonRpcMessage } from "../protocol/types.js";

export { DISABLED_SEARCH_GATEWAY_INSTRUCTIONS };

export const CONNECTION_DISABLED_SEARCH_REASON =
  "Disabled for this connection (start MCP shim with --enable-tool-search to enable)";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  enableSearch?: boolean;
  fullCatalog?: boolean;
}

/** A per-stdio-client view. Never mutates the daemon's shared catalog. */
export function createToolSearchSurface(
  output: NodeJS.WritableStream,
  optionsOrEnableSearch: boolean | ToolSearchSurfaceOptions = false,
  fullCatalogLegacy = false,
): ToolSearchSurface {
  const enableSearch =
    typeof optionsOrEnableSearch === "boolean"
      ? optionsOrEnableSearch
      : (optionsOrEnableSearch?.enableSearch ?? false);
  const fullCatalog =
    typeof optionsOrEnableSearch === "boolean"
      ? fullCatalogLegacy
      : (optionsOrEnableSearch?.fullCatalog ?? fullCatalogLegacy);
  const lists = new Set<JsonRpcId>();
  const initializeIds = new Set<JsonRpcId>();
  const pendingMetadataCalls = new Map<JsonRpcId, PendingMetadataCall>();
  let clientIdentified = false;
  let codexClient = false;
  let searchEnabled = enableSearch;
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
          codexClient = name === "codex-mcp-client" || name === "openai-codex-cli";
          searchEnabled = enableSearch || codexClient;
        }
        initializeIds.add(message.id);
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
          if (!searchEnabled && "result" in message && message.error === undefined) {
            const result = record(message.result);
            if (result && typeof result.instructions === "string") {
              return {
                ...message,
                result: {
                  ...result,
                  instructions: result.instructions.includes(DEFAULT_GATEWAY_INSTRUCTIONS)
                    ? result.instructions.replace(
                        DEFAULT_GATEWAY_INSTRUCTIONS,
                        DISABLED_SEARCH_GATEWAY_INSTRUCTIONS,
                      )
                    : `${DISABLED_SEARCH_GATEWAY_INSTRUCTIONS}\n${result.instructions}`,
                },
              };
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
          if (result && Array.isArray(result.tools))
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                ...result,
                tools: result.tools.filter((tool) => {
                  const name = record(tool)?.name;
                  if (typeof name !== "string") return false;
                  if (fullCatalog) {
                    return searchEnabled ? true : !isSearch(name);
                  }
                  // Stable facade exposes system meta tools only
                  if (
                    name === "get_tool_schema" ||
                    name === "invoke_tool" ||
                    name === "manage_tools"
                  ) {
                    return true;
                  }
                  return searchEnabled && name === "search_tools";
                }),
              },
            };
        }
      }
      return message;
    }),
  };
}
