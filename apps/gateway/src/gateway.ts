import os from "node:os";
import path from "node:path";
import { McpConnection, type McpConnectionOptions } from "./connection.js";
import type { ToolInvocationRouter } from "./meta/router-contract.js";
import {
  JSON_RPC_ERROR_CODES,
  MCP_ERROR_CODES,
  McpProtocolError,
  createMcpError,
  isMcpProtocolError,
} from "./protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "./protocol/framing.js";
import {
  CallToolParamsSchema,
  type CallToolResult,
  CancelRequestParamsSchema,
  InitializeParamsSchema,
  type InitializeResult,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcParamValue,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcResponse,
  LATEST_PROTOCOL_VERSION,
  type ListRootsResult,
  type ListToolsResult,
  type McpImplementationInfo,
  type McpTool,
  type ProgressNotificationParams,
} from "./protocol/types.js";
import type { ProductionProxyRuntime } from "./proxy/runtime.js";
import { CatalogRefreshCoordinator, type RefreshCoordinatorOptions } from "./refresh/index.js";
import { ToolRegistry } from "./registry/registry.js";
import {
  type GatewayRouter,
  RegistryGatewayRouter,
  createRegistryGatewayRouter,
} from "./router.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "./workspace-resolver.js";
export type GatewayLogMeta =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | readonly GatewayLogMeta[]
  | { readonly [key: string]: string | number | boolean | null | undefined };

export type GatewayCallParams = JsonRpcParams | undefined;

export type GatewayErrorInput =
  | Error
  | McpProtocolError
  | JsonRpcErrorObject
  | string
  | number
  | boolean
  | null
  | undefined;

export type GatewayMethodResult =
  | InitializeResult
  | ListToolsResult
  | CallToolResult
  | ListRootsResult
  | Record<string, string | number | boolean | null | undefined>
  | null
  | undefined;

function isNotificationMessage(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) || msg.id === undefined;
}

function isRequestMessage(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && msg.id !== undefined && "method" in msg;
}
function isParamsObject(value: JsonRpcParamValue | undefined): value is JsonRpcParams {
  return Boolean(value) && Object.prototype.toString.call(value) === "[object Object]";
}

export interface GatewayServerOptions {
  router?: GatewayRouter;
  registry?: ToolRegistry;
  invocationRouter?: ToolInvocationRouter;
  serverInfo?: McpImplementationInfo;
  maxMessageSizeBytes?: number;
  maxConcurrentRequestsPerConnection?: number;
  maxTotalConcurrentRequests?: number;
  requestTimeoutMs?: number;
  rateLimitRps?: number;
  rateLimitBurst?: number;
  harnessDetector?: (clientInfo: McpImplementationInfo) => string;
  logger?: (level: string, message: string, meta?: GatewayLogMeta) => void;
  refreshCoordinator?: CatalogRefreshCoordinator;
  refreshCoordinatorOptions?: RefreshCoordinatorOptions;
  enableRefreshCoordinator?: boolean;
  onWorkspaceReady?: (workspace: WorkspaceContext, connection: McpConnection) => Promise<void>;
  cloudRuntime?: ProductionProxyRuntime;
}
export interface ConnectionSession {
  connection: McpConnection;
  sendNotification: (notification: JsonRpcNotification) => void;
  sendResponse: (response: JsonRpcResponse) => void;
}

const SENSITIVE_PATTERN =
  /\b(?:sk-[a-zA-Z0-9_-]{10,}|ghp_[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._~+/-]+=*|(?:api[_-]?key|auth[_-]?token|secret|password|credential)\s*[:=]\s*['"]?[a-zA-Z0-9._~+/-]+['"]?)\b/gi;

/**
 * Redacts sensitive tokens, API keys, credentials, and user home paths from error messages or logs.
 */
export function redactSensitiveText(text: string, workspaceRoot?: string): string {
  if (!text || Object.prototype.toString.call(text) !== "[object String]") {
    return text;
  }

  let scrubbed = text;

  // 1. Redact basic auth in URLs
  scrubbed = scrubbed.replace(/(https?:\/\/[^:\s\/]+:)([^@\s\/]+)(@)/gi, "$1[REDACTED_SECRET]$3");

  // 2. Redact specific auth tokens and secrets
  scrubbed = scrubbed.replace(SENSITIVE_PATTERN, "[REDACTED_SECRET]");
  // 2. Redact home directory
  const home = os.homedir();
  if (home && home.length > 1) {
    const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    scrubbed = scrubbed.replace(new RegExp(escapedHome, "g"), "<HOME>");
  }

  // 3. Redact generic /home/username or /Users/username patterns if still visible
  scrubbed = scrubbed.replace(/(?:\/home\/|\/Users\/)[a-zA-Z0-9._-]+/g, "<HOME>");
  scrubbed = scrubbed.replace(/[A-Za-z]:\\Users\\[a-zA-Z0-9._-]+/g, "<HOME>");

  return scrubbed;
}

/**
 * Detects AI harness from client info name or environment.
 */
export function defaultHarnessDetector(clientInfo: McpImplementationInfo): string {
  const name = clientInfo.name.toLowerCase();
  if (name.includes("claude") || name.includes("anthropic")) {
    return "claude-code";
  }
  if (name.includes("codex") || name.includes("openai")) {
    return "codex";
  }
  if (name.includes("omp") || name.includes("oh-my-pi") || name.includes("ohmypi")) {
    return "omp";
  }
  if (name.includes("cursor")) {
    return "cursor";
  }
  if (name.includes("windsurf")) {
    return "windsurf";
  }
  return "generic-mcp";
}

/**
 * Local MCP Gateway Server implementing JSON-RPC 2.0 lifecycle and routing.
 */
export class LocalMcpGateway {
  private readonly router: GatewayRouter;
  private readonly serverInfo: McpImplementationInfo;
  private readonly maxMessageSizeBytes: number;
  private readonly maxConcurrentRequestsPerConnection: number;
  private readonly maxTotalConcurrentRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly rateLimitRps: number;
  private readonly rateLimitBurst: number;
  private readonly harnessDetector: (clientInfo: McpImplementationInfo) => string;
  private readonly logger?: (level: string, message: string, meta?: GatewayLogMeta) => void;
  readonly refreshCoordinator?: CatalogRefreshCoordinator;
  private readonly ownRefreshCoordinator: boolean = false;
  private readonly onWorkspaceReady?: (
    workspace: WorkspaceContext,
    connection: McpConnection,
  ) => Promise<void>;
  readonly cloudRuntime?: ProductionProxyRuntime;

  private readonly connections = new Map<string, McpConnection>();
  private readonly messageWriters = new Map<string, (msg: JsonRpcMessage) => void>();
  private isClosed = false;
  private unsubscribeRouterListener?: () => void;

  constructor(options: GatewayServerOptions = {}) {
    let internalRegistry: ToolRegistry | undefined;
    if (options.router) {
      this.router = options.router;
    } else if (options.registry) {
      this.router = createRegistryGatewayRouter(options.registry, options.invocationRouter);
    } else {
      internalRegistry = new ToolRegistry();
      this.router = createRegistryGatewayRouter(internalRegistry, options.invocationRouter);
    }

    this.serverInfo = options.serverInfo ?? {
      name: "resin-mcp",
      version: "0.1.0",
    };
    this.maxMessageSizeBytes = options.maxMessageSizeBytes ?? 4 * 1024 * 1024;
    this.maxConcurrentRequestsPerConnection = options.maxConcurrentRequestsPerConnection ?? 32;
    this.maxTotalConcurrentRequests = options.maxTotalConcurrentRequests ?? 128;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
    this.rateLimitRps = options.rateLimitRps ?? 100;
    this.rateLimitBurst = options.rateLimitBurst ?? 50;
    this.harnessDetector = options.harnessDetector ?? defaultHarnessDetector;
    this.logger = options.logger;
    this.onWorkspaceReady = options.onWorkspaceReady;
    this.cloudRuntime = options.cloudRuntime;

    if (this.router.onToolListChanged) {
      this.unsubscribeRouterListener = this.router.onToolListChanged(() => {
        this.broadcastToolListChanged();
      });
    }

    const registryToAttach =
      options.registry ??
      internalRegistry ??
      (this.router instanceof RegistryGatewayRouter ? this.router.getRegistry() : undefined);

    if (options.refreshCoordinator) {
      this.refreshCoordinator = options.refreshCoordinator;
      this.refreshCoordinator.attachGateway(this);
      if (registryToAttach) {
        this.refreshCoordinator.attachRegistry(registryToAttach);
      }
    } else if (options.enableRefreshCoordinator !== false) {
      this.refreshCoordinator = new CatalogRefreshCoordinator(options.refreshCoordinatorOptions);
      this.refreshCoordinator.attachGateway(this);
      this.ownRefreshCoordinator = true;
      if (registryToAttach) {
        this.refreshCoordinator.attachRegistry(registryToAttach);
      }
    }
  }

  /**
   * Registers a new MCP connection with this gateway.
   */
  createConnection(
    options: {
      connectionId?: string;
      harnessId?: string;
      cwd?: string;
      sendMessage?: (msg: JsonRpcMessage) => void;
    } = {},
  ): McpConnection {
    const workspace = resolveWorkspaceContext({
      cwd: options.cwd,
      harnessId: options.harnessId,
      disableBootstrap: true,
    });

    const connection = new McpConnection({
      connectionId: options.connectionId,
      harnessId: options.harnessId,
      workspaceContext: workspace,
      rateLimiterOptions: {
        capacity: this.rateLimitBurst,
        refillRatePerSec: this.rateLimitRps,
      },
      onClose: () => {
        this.connections.delete(connection.connectionId);
        this.messageWriters.delete(connection.connectionId);
      },
    });

    this.connections.set(connection.connectionId, connection);
    if (options.sendMessage) {
      this.messageWriters.set(connection.connectionId, options.sendMessage);
    }

    return connection;
  }

  /**
   * Total count of active in-flight requests across all connections.
   */
  getTotalActiveRequests(): number {
    let total = 0;
    for (const conn of this.connections.values()) {
      total += conn.getActiveRequestCount();
    }
    return total;
  }
  /**
   * Returns all active MCP connections registered with this gateway.
   */
  getAllConnections(): McpConnection[] {
    return Array.from(this.connections.values()).filter((c) => !c.isClosed);
  }

  /**
   * Returns an active connection by its connection ID.
   */
  getConnection(connectionId: string): McpConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Handles a parsed JSON-RPC message for a given connection and returns a response (or null for notifications).
   */
  async handleMessage(
    connectionIdOrConnection: string | McpConnection,
    message: JsonRpcMessage,
  ): Promise<JsonRpcResponse | null> {
    const connection =
      connectionIdOrConnection instanceof McpConnection
        ? connectionIdOrConnection
        : this.connections.get(connectionIdOrConnection);
    if (!connection || connection.isClosed) {
      return {
        jsonrpc: "2.0",
        id: "id" in message ? message.id : null,
        error: {
          code: MCP_ERROR_CODES.CONNECTION_CLOSED,
          message: "Connection is not registered or has closed",
        },
      };
    }

    // Case 1: Notifications (no id)
    if (isNotificationMessage(message)) {
      await this.handleNotification(connection, message);
      return null;
    }

    // Case 2: Response from client (if gateway sent a client-bound request)
    if ("result" in message || "error" in message) {
      return null;
    }

    // Case 3: Request from client
    if (isRequestMessage(message)) {
      return this.handleRequest(connection, message);
    }
    return null;
  }

  /**
   * Dispatches and processes an incoming JSON-RPC request.
   */
  private async handleRequest(
    connection: McpConnection,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    // Concurrency limit check
    if (
      connection.getActiveRequestCount() >= this.maxConcurrentRequestsPerConnection ||
      this.getTotalActiveRequests() >= this.maxTotalConcurrentRequests
    ) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: MCP_ERROR_CODES.CONCURRENCY_LIMIT_EXCEEDED,
          message: "Too many concurrent requests in flight",
        },
      };
    }

    // Rate limiting check
    const rateLimit = connection.checkRateLimit();
    if (!rateLimit.allowed) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: MCP_ERROR_CODES.RATE_LIMITED,
          message: "Request rate limit exceeded",
          data: { retryAfterMs: rateLimit.retryAfterMs },
        },
      };
    }

    // Register request for timeout & cancellation
    const signal = connection.registerInFlightRequest(id, method, this.requestTimeoutMs, () => {
      this.logger?.("warn", `Request ${id} (${method}) timed out`);
    });

    try {
      let result: GatewayMethodResult;
      switch (method) {
        case "initialize":
          result = await this.handleInitialize(connection, params);
          break;

        case "ping":
          result = {};
          break;

        case "tools/list":
          result = await this.handleToolsList(connection, params);
          break;

        case "tools/call":
          result = await this.handleToolsCall(connection, id, params, signal);
          break;

        case "roots/list":
          result = {
            roots: connection.workspaceContext.roots.map((r) => ({
              uri: r.uri,
              name: r.name,
            })),
          };
          break;

        default:
          throw new McpProtocolError(
            JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Method '${method}' not found`,
          );
      }

      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    } catch (err) {
      const errorInput: GatewayErrorInput = err instanceof Error ? err : new Error(String(err));
      return {
        jsonrpc: "2.0",
        id,
        error: this.mapErrorToJsonRpcError(errorInput, connection.workspaceContext.canonicalRoot),
      };
    } finally {
      connection.completeInFlightRequest(id);
    }
  }

  /**
   * Handles incoming notifications.
   */
  private async handleNotification(
    connection: McpConnection,
    notification: JsonRpcNotification,
  ): Promise<void> {
    const { method, params } = notification;

    switch (method) {
      case "notifications/initialized":
        connection.isInitialized = true;
        break;

      case "$/cancelRequest":
      case "notifications/cancelled": {
        const parsed = CancelRequestParamsSchema.safeParse(params);
        if (parsed.success) {
          connection.cancelRequest(parsed.data.requestId, parsed.data.reason);
        }
        break;
      }

      case "notifications/roots/list_changed": {
        // Re-resolve workspace
        const updated = resolveWorkspaceContext({
          cwd: connection.workspaceContext.canonicalRoot,
          harnessId: connection.harnessId,
        });
        connection.updateWorkspace(updated);
        break;
      }

      case "logging/setLevel":
        // No-op or level update
        break;

      default:
        // Ignore unrecognized notifications per JSON-RPC spec
        break;
    }
  }

  /**
   * Handles `initialize` request.
   */
  private async handleInitialize(
    connection: McpConnection,
    rawParams: GatewayCallParams,
  ): Promise<InitializeResult> {
    const parsed = InitializeParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Invalid initialize parameters: ${parsed.error.message}`,
      );
    }

    const params = parsed.data;
    const detectedHarness = this.harnessDetector(params.clientInfo);
    connection.applyInitialize(params, detectedHarness);
    // Resolve workspace from init params
    const workspace = resolveWorkspaceContext({
      initParams: params,
      harnessId: detectedHarness,
      clientInfo: params.clientInfo,
      cwd: connection.workspaceContext.canonicalRoot,
    });
    connection.updateWorkspace(workspace);
    connection.isInitialized = true;

    if (this.onWorkspaceReady) {
      await this.onWorkspaceReady(workspace, connection);
    } else if (this.cloudRuntime) {
      try {
        await this.cloudRuntime.onWorkspaceReady(workspace);
      } catch {
        // Cloud degradation during initialization degrades safely without preventing local MCP initialization
      }
    }

    return {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: connection.serverCapabilities,
      serverInfo: this.serverInfo,
      instructions: "Resin Autonomous MCP Gateway",
    };
  }

  /**
   * Handles `notifications/initialized`.
   */
  private async handleInitialized(
    connection: McpConnection,
    _params: GatewayCallParams,
  ): Promise<void> {
    // Standard MCP initialized notification - state transition already completed during initialize
  }

  /**
   * Handles `tools/list` request.
   */
  private async handleToolsList(
    connection: McpConnection,
    _params: GatewayCallParams,
  ): Promise<ListToolsResult> {
    if (!connection.isInitialized) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Server is not initialized. Send 'initialize' first.",
      );
    }

    const tools = await this.router.listTools(connection.workspaceContext);
    this.refreshCoordinator?.recordToolsListObserved(
      connection.connectionId,
      connection.workspaceContext.workspaceId,
    );
    return { tools };
  }
  /**
   * Handles `tools/call` request.
   */
  private async handleToolsCall(
    connection: McpConnection,
    requestId: JsonRpcId,
    rawParams: GatewayCallParams,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    if (!connection.isInitialized) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Server is not initialized. Send 'initialize' first.",
      );
    }

    const parsed = CallToolParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Invalid tools/call parameters: ${parsed.error.message}`,
      );
    }

    const { name, arguments: args, _meta } = parsed.data;
    const progressToken = _meta?.progressToken;

    const onProgress = progressToken
      ? (progress: number, total?: number) => {
          const progressParams =
            total !== undefined
              ? {
                  progressToken,
                  progress,
                  total,
                }
              : {
                  progressToken,
                  progress,
                };
          this.sendNotificationToConnection(connection.connectionId, {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: progressParams,
          });
        }
      : undefined;

    const toolArgs: JsonRpcParams =
      rawParams && isParamsObject(rawParams.arguments) ? rawParams.arguments : {};

    return this.router.callTool(connection.workspaceContext, name, toolArgs, {
      signal,
      onProgress,
      timeoutMs: this.requestTimeoutMs,
    });
  }

  /**
   * Broadcasts `notifications/tools/list_changed` to all connected clients that support it.
   */
  broadcastToolListChanged(): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };

    for (const [connId, conn] of this.connections.entries()) {
      if (conn.isInitialized && !conn.isClosed) {
        this.sendNotificationToConnection(connId, notification);
      }
    }
  }

  /**
   * Sends a JSON-RPC notification to a specific connection.
   */
  sendNotificationToConnection(connectionId: string, notification: JsonRpcNotification): void {
    const writer = this.messageWriters.get(connectionId);
    if (writer) {
      try {
        writer(notification);
      } catch (err) {
        this.logger?.(
          "error",
          `Failed to send notification to ${connectionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  /**
   * Maps an arbitrary caught error to a sanitized JsonRpcErrorObject.
   */
  private mapErrorToJsonRpcError(
    err: GatewayErrorInput,
    workspaceRoot?: string,
  ): JsonRpcErrorObject {
    if (isMcpProtocolError(err)) {
      const errObj: JsonRpcErrorObject = {
        code: err.code,
        message: redactSensitiveText(err.message, workspaceRoot),
      };
      if (err.data !== undefined) {
        errObj.data = err.data;
      }
      return errObj;
    }

    const rawMessage = err instanceof Error ? err.message : String(err);
    const sanitizedMessage = redactSensitiveText(rawMessage, workspaceRoot);

    return {
      code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      message: sanitizedMessage,
    };
  }

  /**
   * Processes an MCP communication stream (e.g. process.stdin/process.stdout or net.Socket).
   */
  async processStream(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    options: { connectionId?: string; cwd?: string; harnessId?: string } = {},
  ): Promise<McpConnection> {
    const decoder = new McpFrameDecoder({
      maxMessageSizeBytes: this.maxMessageSizeBytes,
    });

    const sendMessage = (msg: JsonRpcMessage) => {
      try {
        output.write(encodeMcpMessage(msg));
      } catch {
        // Ignore write errors to closed stream
      }
    };

    const connection = this.createConnection({
      connectionId: options.connectionId,
      cwd: options.cwd,
      harnessId: options.harnessId,
      sendMessage,
    });

    const onData = async (chunk: Buffer | string) => {
      let messages: JsonRpcMessage[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        const errorInput: GatewayErrorInput = err instanceof Error ? err : new Error(String(err));
        if (isMcpProtocolError(errorInput)) {
          sendMessage({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: errorInput.code,
              message: redactSensitiveText(errorInput.message),
            },
          });
        }
        return;
      }

      for (const msg of messages) {
        try {
          const response = await this.handleMessage(connection.connectionId, msg);
          if (response) {
            sendMessage(response);
          }
        } catch (err) {
          const errorInput: GatewayErrorInput = err instanceof Error ? err : new Error(String(err));
          sendMessage({
            jsonrpc: "2.0",
            id: "id" in msg ? msg.id : null,
            error: this.mapErrorToJsonRpcError(
              errorInput,
              connection.workspaceContext.canonicalRoot,
            ),
          });
        }
      }
    };

    const onEnd = () => {
      connection.close();
      cleanup();
    };

    const onError = (err: Error) => {
      this.logger?.(
        "error",
        `Stream error on connection ${connection.connectionId}: ${err.message}`,
      );
      connection.close();
      cleanup();
    };

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);

    return connection;
  }

  /**
   * Closes the gateway server and all active connections.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.unsubscribeRouterListener) {
      this.unsubscribeRouterListener();
      this.unsubscribeRouterListener = undefined;
    }
    if (this.ownRefreshCoordinator && this.refreshCoordinator) {
      this.refreshCoordinator.destroy();
    }
    if (this.cloudRuntime) {
      void this.cloudRuntime.stop();
    }
  }
}
