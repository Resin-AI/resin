import os from "node:os";
import path from "node:path";
import { McpConnection, type McpConnectionOptions } from "./connection.js";
import { summarizeLearnedCommands } from "./meta/learned-commands.js";
import type { ToolInvocationRouter } from "./meta/router-contract.js";
import {
  JSON_RPC_ERROR_CODES,
  MCP_ERROR_CODES,
  McpProtocolError,
  createMcpError,
  isMcpProtocolError,
  jsonRpcErrorOf,
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
  RESIN_LEARNED_TOOL_COMMANDS_META,
  RESIN_LEARNED_TOOL_COUNT_META,
  RESIN_LEARNED_TOOL_META,
} from "./protocol/types.js";
import type { ProductionProxyRuntime } from "./proxy/runtime.js";
import { CatalogResponseNotices } from "./refresh/catalog-response-notices.js";
import { CatalogRefreshCoordinator, type RefreshCoordinatorOptions } from "./refresh/index.js";
import { ToolRegistry } from "./registry/registry.js";
import {
  type CatalogNoticeTool,
  type GatewayRouter,
  RegistryGatewayRouter,
  createRegistryGatewayRouter,
  toNativeToolCatalog,
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
  /**
   * Deadline for `tools/call` requests. Tool executions are bounded by their
   * manifest limits; this is the outer ceiling (default 10 minutes).
   */
  toolCallTimeoutMs?: number;
  rateLimitRps?: number;
  rateLimitBurst?: number;
  harnessDetector?: (clientInfo: McpImplementationInfo) => string;
  logger?: (level: string, message: string, meta?: GatewayLogMeta) => void;
  refreshCoordinator?: CatalogRefreshCoordinator;
  refreshCoordinatorOptions?: RefreshCoordinatorOptions;
  enableRefreshCoordinator?: boolean;
  onWorkspaceReady?: (workspace: WorkspaceContext, connection: McpConnection) => Promise<void>;
  cloudRuntime?: ProductionProxyRuntime;
  /**
   * A cheap, synchronous check for a notice every connection should see once in a tool result,
   * such as a newer Resin release this long-lived process does not run. Undefined when none.
   */
  releaseNotice?: () => string | undefined;
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

/** How long a connection's first tool list waits for a fresh install's initial catalog sync. */
export const FIRST_TOOL_LIST_CATALOG_WAIT_MS = 5_000;

/**
 * Result `_meta` describing a workspace's learned tools once its catalog is known: how many there
 * are, and the commands their recorded programs run most widely, so search-listing instructions can
 * name them. Nothing while the catalog is unknown.
 */
function learnedToolsMeta(tools: readonly CatalogNoticeTool[] | undefined) {
  if (tools === undefined) return {};
  const learned = tools.filter((tool) => tool._meta?.[RESIN_LEARNED_TOOL_META] === true);
  const commands = summarizeLearnedCommands(learned.map((tool) => tool.localCommands ?? []));
  return {
    _meta: {
      [RESIN_LEARNED_TOOL_COUNT_META]: learned.length,
      ...(commands.length === 0 ? {} : { [RESIN_LEARNED_TOOL_COMMANDS_META]: commands }),
    },
  };
}

/**
 * How any Resin tool may be used, whichever discovery the connection offers: only for exactly the
 * user's task, verified by its actual effects, and never by changing tool state. Kept short because
 * code-mode harnesses repeat a server's instructions in every tool description they list.
 */
const GATEWAY_USE_RULES =
  "Use a tool only for exactly the user's task, honoring their tool choices; check its errors and effects, and never enable, pin, disable or roll back tools.";

/**
 * How learned tools are used. Their listing names each one's purpose and inputs only; the recorded
 * steps and input docs are one get_tool_schema call away. With the discovery route after it, this
 * first line stays within the 250 characters Codex keeps of a deferred tool source's summary.
 */
const LEARNED_TOOL_GUIDANCE =
  "Learned tools rerun recorded work: call one directly when it is your next step; omitted inputs reuse recorded values.";

/** Static initialization instructions returned to MCP clients during capability negotiation. */
export const DEFAULT_GATEWAY_INSTRUCTIONS = `${LEARNED_TOOL_GUIDANCE} Else: search_tools(query=<task>) or manage_tools(action=list_versions,scope=workspace); get_tool_schema(name): steps; invoke_tool.\n${GATEWAY_USE_RULES}`;

/** Initialization instructions for a connection whose tool search is disabled: discovery uses manage_tools. */
export const DISABLED_SEARCH_GATEWAY_INSTRUCTIONS = `${LEARNED_TOOL_GUIDANCE} Else: manage_tools(action=list_versions,scope=workspace,compact=true,query=<keyword>); get_tool_schema(name): steps; invoke_tool.\n${GATEWAY_USE_RULES}`;

/**
 * How a search-listing connection runs what search_tools found: each result already carries the
 * tool's recorded steps and its inputSchema, so the next call is invoke_tool, not get_tool_schema.
 */
const INVOKE_FROM_SEARCH =
  "Each result has the tool's recorded steps and inputSchema: call invoke_tool(name, parameters) with it directly (get_tool_schema only for output schema or limits); learned tools rerun recorded work and omitted inputs reuse recorded values.";

/**
 * The first sentence of search_tools' description on a search-listing connection: how many
 * learned tools the workspace has, which commands they run, and whether to search at all.
 * Harnesses that ignore server instructions still show tool descriptions, so this is the one
 * channel every harness gets.
 */
export function learnedToolCountSentence(
  learnedToolCount: number,
  commands: readonly string[] = [],
): string {
  if (learnedToolCount === 0) {
    return "Resin has no learned tools for this workspace yet, so do not search: do the task directly (tools Resin learns from it reach later sessions).";
  }
  const tools = `Resin has ${learnedToolCount} learned tool${learnedToolCount === 1 ? "" : "s"} for this workspace`;
  return commands.length === 0
    ? `${tools}: search them before running a multi-step job by hand.`
    : `${tools}: search them before running a multi-step job or one of the commands they run (${commands.map((command) => `\`${command}\``).join(", ")}) by hand.`;
}

/**
 * Initialization instructions for a connection that lists only the meta tools (`resin mcp`
 * without `--full-catalog`): learned tools are found with search_tools, not read from a list.
 * `learnedToolCount` is omitted while the workspace's catalog is unknown; with none learned yet,
 * the agent is told not to search. `commands` names what the learned tools run, so an agent about
 * to type one of them knows a search will find a tool.
 */
export function searchListingGatewayInstructions(
  learnedToolCount?: number,
  commands: readonly string[] = [],
): string {
  if (learnedToolCount === 0) {
    return `${learnedToolCountSentence(0)}\n${GATEWAY_USE_RULES}`;
  }
  const available =
    learnedToolCount === undefined
      ? "Resin may have learned tools for this workspace"
      : `Resin has ${learnedToolCount} learned tool${learnedToolCount === 1 ? "" : "s"} for this workspace`;
  if (commands.length === 0) {
    return `${available}, not listed: before running a multi-step job by hand, call search_tools(query=<the job in a few words, e.g. the commands or scripts you are about to run>). ${INVOKE_FROM_SEARCH}\n${GATEWAY_USE_RULES}`;
  }
  return `${available}, not listed; they run commands such as ${commands.map((command) => `\`${command}\``).join(", ")}. Before running one of those commands or another multi-step job by hand, call search_tools(query=<the command line or job you are about to run>). ${INVOKE_FROM_SEARCH}\n${GATEWAY_USE_RULES}`;
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
  private readonly toolCallTimeoutMs: number;
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
  private readonly listedConnections = new WeakSet<McpConnection>();
  private readonly messageWriters = new Map<string, (msg: JsonRpcMessage) => void>();
  private isClosed = false;
  private unsubscribeRouterListener?: () => void;
  private readonly catalogNotices: CatalogResponseNotices;
  private readonly releaseNotice?: () => string | undefined;
  /** The release notice each connection was last given, so it is delivered once. */
  private readonly deliveredReleaseNotices = new WeakMap<McpConnection, string>();

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
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 600_000;
    this.rateLimitRps = options.rateLimitRps ?? 100;
    this.rateLimitBurst = options.rateLimitBurst ?? 50;
    this.harnessDetector = options.harnessDetector ?? defaultHarnessDetector;
    this.logger = options.logger;
    this.onWorkspaceReady = options.onWorkspaceReady;
    this.cloudRuntime = options.cloudRuntime;
    this.releaseNotice = options.releaseNotice;
    this.catalogNotices = new CatalogResponseNotices({
      listTools: (context) =>
        this.router.listCatalogNoticeTools?.(context) ?? this.router.listTools(context),
      getGeneration: () => this.router.getCatalogGeneration?.(),
      redact: redactSensitiveText,
    });

    if (this.router.onToolListChanged) {
      this.unsubscribeRouterListener = this.router.onToolListChanged(() => {
        this.catalogNotices.markChanged();
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
      /** Session scope for composed invoke_tool references; defaults to the connection id. */
      sessionId?: string;
      sendMessage?: (msg: JsonRpcMessage) => void;
    } = {},
  ): McpConnection {
    const connectionId = options.connectionId ?? crypto.randomUUID();
    const workspace = resolveWorkspaceContext({
      cwd: options.cwd,
      harnessId: options.harnessId,
      disableBootstrap: true,
      // A connection is the session boundary: composed calls on it share one
      // reference scope, and another connection's handles never resolve here.
      sessionId: options.sessionId ?? connectionId,
    });

    const connection = new McpConnection({
      connectionId,
      harnessId: options.harnessId,
      workspaceContext: workspace,
      rateLimiterOptions: {
        capacity: this.rateLimitBurst,
        refillRatePerSec: this.rateLimitRps,
      },
      onClose: () => {
        this.catalogNotices.reset(connection);
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

  /** The learned tools a workspace lists, as the model sees them: names and descriptions only. */
  async listLearnedTools(
    context: McpConnection["workspaceContext"],
  ): Promise<Array<{ name: string; description?: string }>> {
    const tools = await this.router.listTools(context);
    return tools
      .filter((tool) => tool._meta?.[RESIN_LEARNED_TOOL_META] === true)
      .map((tool) =>
        tool.description === undefined
          ? { name: tool.name }
          : { name: tool.name, description: tool.description },
      );
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

    // Register request for timeout & cancellation. Tool executions get their
    // own ceiling so the generic request deadline cannot SIGKILL a tool that is
    // still inside its manifest-declared limit.
    const deadlineMs = method === "tools/call" ? this.toolCallTimeoutMs : this.requestTimeoutMs;
    const signal = connection.registerInFlightRequest(id, method, deadlineMs, () => {
      this.logger?.("warn", `Request ${id} (${method}) timed out after ${deadlineMs}ms`);
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
          result = await this.handleToolsList(connection, params, signal);
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
        connection.hasReceivedInitializedNotification = true;
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
        // Re-resolve workspace from the directory the session started in, not its git root:
        // learned tools run their commands in that directory (see `sessionWorkingDirectory`).
        const updated = resolveWorkspaceContext({
          cwd: connection.workspaceContext.startupPath,
          harnessId: connection.harnessId,
        });
        this.catalogNotices.reset(connection);
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
      // The directory the session started in, not its git root: learned tools run their commands
      // there (see `sessionWorkingDirectory`), and the project root resolves the same from it.
      cwd: connection.workspaceContext.startupPath,
      // The session scope bound at connection time survives the initialize handshake:
      // composed references keep resolving against this connection's results.
      sessionId: connection.workspaceContext.sessionId,
    });
    this.catalogNotices.reset(connection);
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
    // The catalog may have changed while this harness was not connected, which raises no change
    // event; render its learned-tool instructions from the catalog once it is known. Before the
    // cloud answers, an empty registry means "not loaded yet", so nothing is written until then.
    void (async () => {
      if (!this.refreshCoordinator) return;
      await this.cloudRuntime?.whenCatalogLoaded?.();
      if (connection.isClosed || this.isClosed) return;
      await this.refreshCoordinator.syncConnectionInstructions(connection);
    })().catch((error: unknown) => {
      this.logger?.(
        "warn",
        `Learned-tool instructions sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    // A search-listing connection states the workspace's learned-tool count, and the commands those
    // tools run, to the model. They are reported only once the catalog is known; a fresh install's
    // background sync gets the same bounded wait as a first tool list, and an already-loaded catalog
    // adds none.
    const knownTools = connection.searchListing
      ? await this.knownCatalogTools(connection.workspaceContext, true)
      : undefined;
    return {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: connection.serverCapabilities,
      serverInfo: this.serverInfo,
      instructions: DEFAULT_GATEWAY_INSTRUCTIONS,
      ...learnedToolsMeta(knownTools),
    };
  }

  /** The tools a connection's workspace lists, as tools/list returns them before conversion. */
  private async listCatalogTools(context: McpConnection["workspaceContext"]) {
    return await (this.router.listCatalogNoticeTools?.(context) ?? this.router.listTools(context));
  }

  /**
   * Whether the workspace's catalog is known: there is no cloud runtime (the local registry is the
   * whole catalog), or the cloud has answered. `waitForSync` waits, at most
   * {@link FIRST_TOOL_LIST_CATALOG_WAIT_MS}, for the sync workspace-ready started in the background.
   */
  private async catalogKnown(waitForSync: boolean): Promise<boolean> {
    const runtime = this.cloudRuntime;
    if (runtime?.whenCatalogLoaded === undefined) return true;
    let loaded = false;
    // An already-loaded catalog marks itself before the race below settles.
    const loading = runtime.whenCatalogLoaded().then(
      () => {
        loaded = true;
      },
      () => {},
    );
    await Promise.race([loading, Promise.resolve()]);
    if (loaded || !waitForSync || runtime.catalogSettled === undefined) return loaded;
    await Promise.race([loading, runtime.catalogSettled(FIRST_TOOL_LIST_CATALOG_WAIT_MS)]);
    return loaded;
  }

  /** The tools the workspace lists, or undefined while its catalog is unknown. */
  private async knownCatalogTools(
    context: McpConnection["workspaceContext"],
    waitForSync: boolean,
  ): Promise<CatalogNoticeTool[] | undefined> {
    try {
      if (!(await this.catalogKnown(waitForSync))) return undefined;
      return await this.listCatalogTools(context);
    } catch {
      return undefined;
    }
  }

  /**
   * Handles `notifications/initialized`.
   */
  private async handleInitialized(
    connection: McpConnection,
    _params: GatewayCallParams,
  ): Promise<void> {
    connection.isInitialized = true;
    connection.hasReceivedInitializedNotification = true;
  }

  /**
   * Handles `tools/list` request.
   */
  private async handleToolsList(
    connection: McpConnection,
    _params: GatewayCallParams,
    signal: AbortSignal,
  ): Promise<ListToolsResult> {
    if (!connection.isInitialized) {
      throw new McpProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Server is not initialized. Send 'initialize' first.",
      );
    }

    const context = connection.workspaceContext;
    const list = async () => await this.listCatalogTools(context);
    let tools = await list();
    // A fresh install syncs its catalog in the background after initialize, and many clients read
    // the tool list only once. When nothing learned for this workspace is available locally yet,
    // the first list per connection waits briefly for that sync, so the learned tools are in it.
    if (!this.listedConnections.has(connection)) {
      this.listedConnections.add(connection);
      if (
        this.cloudRuntime?.catalogSettled !== undefined &&
        !tools.some((tool) => tool._meta?.[RESIN_LEARNED_TOOL_META] === true)
      ) {
        await this.cloudRuntime.catalogSettled(FIRST_TOOL_LIST_CATALOG_WAIT_MS);
        tools = await list();
      }
    }
    this.catalogNotices.observeList(connection, context, tools, signal);
    this.refreshCoordinator?.recordToolsListObserved(
      connection.connectionId,
      connection.workspaceContext.workspaceId,
    );
    const knownTools = (await this.catalogKnown(false)) ? tools : undefined;
    return { tools: toNativeToolCatalog(tools), ...learnedToolsMeta(knownTools) };
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

    const result = await this.catalogNotices.call(connection, signal, (context) =>
      this.router.callTool(context, name, toolArgs, {
        signal,
        onProgress,
        timeoutMs: this.toolCallTimeoutMs,
      }),
    );
    return this.withReleaseNotice(connection, result);
  }

  /** Appends the pending release notice to `result` the first time `connection` sees it. */
  private withReleaseNotice(connection: McpConnection, result: CallToolResult): CallToolResult {
    let notice: string | undefined;
    try {
      notice = this.releaseNotice?.();
    } catch {
      // The notice is advisory; a failed check never affects the tool result.
    }
    if (!notice || this.deliveredReleaseNotices.get(connection) === notice) return result;
    this.deliveredReleaseNotices.set(connection, notice);
    return { ...result, content: [...result.content, { type: "text", text: notice }] };
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
      if (conn.isInitialized && conn.hasReceivedInitializedNotification && !conn.isClosed) {
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
    return jsonRpcErrorOf(err, (message) => redactSensitiveText(message, workspaceRoot));
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
    this.catalogNotices.close();

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
