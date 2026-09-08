import { Transform } from "node:stream";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "../protocol/framing.js";
import { InitializeParamsSchema, type JsonRpcId, type JsonRpcMessage } from "../protocol/types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSearch(value: unknown): boolean {
  return typeof value === "string" && ["search_tools", "sys_search_tools"].includes(value.trim());
}

function targetsSearch(name: unknown, args: unknown): boolean {
  if (isSearch(name)) return true;
  if (typeof name !== "string" || !["invoke_tool", "sys_invoke_tool"].includes(name.trim()))
    return false;
  let params = record(args);
  // All aliases share one nested argument object; visit it once, not once per alias.
  while (params) {
    const targets = [params.name, params.tool_name, params.toolId];
    if (targets.some(isSearch)) return true;
    if (
      !targets.some(
        (target) =>
          typeof target === "string" && ["invoke_tool", "sys_invoke_tool"].includes(target.trim()),
      )
    )
      return false;
    params = record(params.parameters ?? params.arguments);
  }
  return false;
}
export interface ToolSearchSurface {
  input: Transform;
  output: Transform;
}

/** A per-stdio-client view. Never mutates the daemon's shared catalog. */
export function createToolSearchSurface(
  output: NodeJS.WritableStream,
  enableSearch = false,
): ToolSearchSurface {
  const lists = new Set<JsonRpcId>();
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
              message: "Tool 'search_tools' not found",
            },
          });
        return undefined;
      }
      if (message.method === "tools/list" && "id" in message) lists.add(message.id);
      return message;
    }),
    output: transform((message) => {
      if (
        !("method" in message) &&
        lists.delete(message.id) &&
        "result" in message &&
        (codexClient || !searchEnabled)
      ) {
        const result = record(message.result);
        if (result && Array.isArray(result.tools))
          return {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              ...result,
              tools: result.tools.filter((tool) => {
                const name = record(tool)?.name;
                if (!codexClient) return !isSearch(name);
                // A stable facade keeps discovery live without caching individual tools.
                return (
                  name === "search_tools" ||
                  name === "get_tool_schema" ||
                  name === "invoke_tool" ||
                  name === "manage_tools"
                );
              }),
            },
          };
      }
      return message;
    }),
  };
}
