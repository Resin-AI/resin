import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ToolManifest, V1LockedToolEntry, V1ToolLock } from "@resin/contracts";
import type { ToolInvocationRequest, ToolInvocationRouter } from "../meta/router-contract.js";
import type { ProjectLockManager } from "../project/lock-manager.js";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import type { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import type { CloudIdentityProvider, CloudRequestIdentity } from "./client.js";
import type { LocalArtifactExecutor } from "./local-executor.js";
import type { ManagedToolAccess } from "./tool-access.js";
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled?: boolean;
}

export interface CloudInvocationContext {
  workspaceContext: WorkspaceContext;
  idempotencyKey: string;
  deadline?: number;
  traceContext?: TraceContext;
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
}

export interface CloudInvocationHeaders {
  [headerName: string]: string;
}

export interface CloudInvocationHandler {
  handleToolInvocation(
    toolIdOrName: string,
    params: JsonRpcParams,
    context: CloudInvocationContext,
  ): Promise<CallToolResult>;
}

export interface CloudInvocationRouterOptions {
  circuitBreaker?: CloudCircuitBreaker;
  catalogCache?: CloudCatalogCache;
  mockService?: CloudInvocationHandler;
  baseUrl?: string;
  authToken?: string;
  identityProvider?: CloudIdentityProvider;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
  invocationForwarder?: (
    toolId: string,
    params: JsonRpcParams,
    context: CloudInvocationContext,
  ) => Promise<CallToolResult>;
  localExecutor?: LocalArtifactExecutor;
  lockManager?: ProjectLockManager;
}

export class CloudInvocationRouter implements ToolInvocationRouter {
  private readonly circuitBreaker: CloudCircuitBreaker;
  private readonly catalogCache?: CloudCatalogCache;
  private readonly mockService?: CloudInvocationHandler;
  private readonly baseUrl?: string;
  private readonly authToken?: string;
  private readonly identityProvider?: CloudIdentityProvider;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly invocationForwarder?: (
    toolId: string,
    params: JsonRpcParams,
    context: CloudInvocationContext,
  ) => Promise<CallToolResult>;
  private localExecutor?: LocalArtifactExecutor;
  private lockManager?: ProjectLockManager;
  private isPaused = false;
  private managedToolAccess?: ManagedToolAccess;
  fallbackHandler?: (
    toolIdOrName: string,
    params: JsonRpcParams,
    context: CloudInvocationContext,
  ) => Promise<CallToolResult>;

  constructor(options: CloudInvocationRouterOptions = {}) {
    this.circuitBreaker = options.circuitBreaker ?? new CloudCircuitBreaker();
    this.catalogCache = options.catalogCache;
    this.mockService = options.mockService;
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.identityProvider = options.identityProvider;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.invocationForwarder = options.invocationForwarder;
    this.localExecutor = options.localExecutor;
    this.lockManager = options.lockManager;
  }

  setManagedToolAccess(access: ManagedToolAccess): void {
    this.managedToolAccess = access;
  }

  pauseCloudCalls(): void {
    this.isPaused = true;
  }

  resumeCloudCalls(): void {
    this.isPaused = false;
  }

  isCloudPaused(): boolean {
    return this.isPaused;
  }

  getCircuitBreaker(): CloudCircuitBreaker {
    return this.circuitBreaker;
  }

  getCatalogCache(): CloudCatalogCache | undefined {
    return this.catalogCache;
  }
  getLocalExecutor(): LocalArtifactExecutor | undefined {
    return this.localExecutor;
  }

  setLocalExecutor(executor?: LocalArtifactExecutor): void {
    this.localExecutor = executor;
  }

  getLockManager(): ProjectLockManager | undefined {
    return this.lockManager;
  }

  setLockManager(lockManager?: ProjectLockManager): void {
    this.lockManager = lockManager;
  }

  private resolveActiveLockEntry(
    toolIdOrName: string,
    workspaceContext: WorkspaceContext,
  ): V1LockedToolEntry | undefined {
    let lock: V1ToolLock | undefined;

    if (this.lockManager) {
      try {
        lock = this.lockManager.read();
      } catch {
        lock = undefined;
      }
    }

    if (!lock && workspaceContext.lockPath && fs.existsSync(workspaceContext.lockPath)) {
      try {
        const content = fs.readFileSync(workspaceContext.lockPath, "utf8");
        lock = JSON.parse(content) as V1ToolLock;
      } catch {
        lock = undefined;
      }
    }

    if (!lock && workspaceContext.lock) {
      lock = workspaceContext.lock;
    }

    if (!lock?.tools) {
      return undefined;
    }

    const directEntry = lock.tools[toolIdOrName];
    if (directEntry && directEntry.status === "active") {
      return directEntry;
    }

    for (const entry of Object.values(lock.tools)) {
      if (
        entry &&
        entry.status === "active" &&
        (entry.toolId === toolIdOrName || entry.name === toolIdOrName)
      ) {
        return entry;
      }
    }

    return undefined;
  }

  /**
   * Factory returning a ToolHandler bound to this cloud router.
   */
  createToolHandler(toolIdOrName: string): ToolHandler {
    return async (context: WorkspaceContext, params: JsonRpcParams, options?: ToolCallOptions) => {
      return await this.forwardInvocation(toolIdOrName, params, context, options);
    };
  }

  /**
   * Routes tool invocation via ToolInvocationRouter interface.
   */
  async invoke(request: ToolInvocationRequest): Promise<CallToolResult> {
    return await this.forwardInvocation(
      request.toolId || request.name,
      request.parameters,
      request.context,
      {
        signal: request.signal,
        onProgress: request.onProgress,
        timeoutMs: request.timeoutMs,
      },
      request.manifest,
    );
  }

  /**
   * Forwards a tool invocation to cloud MCP service.
   *
   * Invariants:
   * 1. Pre-flight circuit check (fail fast if OPEN).
   * 2. Cache TTL & Hard-expiry check (blocks execution past hard expiry).
   * 3. Zero silent queuing: failures are returned immediately to caller.
   * 4. Context forwarding (workspace, session, trace, idempotency, deadline).
   * 5. Cancellation & timeout management.
   * 6. Structured error translation to standard McpProtocolError.
   */
  async forwardInvocation(
    toolIdOrName: string,
    params: JsonRpcParams,
    workspaceContext: WorkspaceContext,
    options?: ToolCallOptions,
    manifest?: ToolManifest,
  ): Promise<CallToolResult> {
    if (this.managedToolAccess?.isInactive()) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        "Managed tool access is unavailable",
      );
    }
    if (this.localExecutor) {
      const activeEntry = this.resolveActiveLockEntry(toolIdOrName, workspaceContext);
      if (activeEntry && this.localExecutor.canExecute(activeEntry)) {
        return await this.localExecutor.execute({
          entry: activeEntry,
          manifest,
          parameters: params,
          context: workspaceContext,
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
          onProgress: options?.onProgress,
        });
      }
    }
    if (this.isPaused) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.CONNECTION_CLOSED,
        "Cloud tool invocation is paused due to authentication failure / credential revocation",
      );
    }

    // 1. Availability & Hard Expiry Check
    if (this.catalogCache) {
      const availabilityInfo = this.catalogCache.getToolAvailability(
        toolIdOrName,
        workspaceContext.workspaceId,
      );
      if (availabilityInfo.availability === "expired") {
        throw new McpProtocolError(
          MCP_ERROR_CODES.TOOL_NOT_FOUND,
          availabilityInfo.reason ||
            `Cloud tool '${toolIdOrName}' has expired past hard TTL and cannot be executed offline`,
        );
      }
    }

    // 2. Pre-flight Circuit Breaker Check
    if (!this.circuitBreaker.canExecute()) {
      const health = this.circuitBreaker.getHealth();
      throw new McpProtocolError(
        MCP_ERROR_CODES.CONNECTION_CLOSED,
        `Cloud service is currently offline/unavailable (circuit: ${health.circuitState}, status: ${health.status}). Invocation rejected (no silent queuing).`,
      );
    }

    // 3. Setup Deadline, Idempotency & Trace Context
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const idempotencyKey = randomUUID();
    const traceContext: TraceContext = {
      traceId: randomUUID().replace(/-/g, ""),
      spanId: randomUUID().replace(/-/g, "").slice(0, 16),
    };

    // 4. Setup Combined AbortController for Signal & Timeout
    const abortController = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    let didTimeout = false;

    if (options?.signal) {
      if (options.signal.aborted) {
        throw new McpProtocolError(
          MCP_ERROR_CODES.CANCELLED,
          "Tool invocation was cancelled by caller",
        );
      }
      options.signal.addEventListener("abort", () => {
        abortController.abort(new Error("Caller cancelled tool invocation"));
      });
    }

    timeoutTimer = setTimeout(() => {
      didTimeout = true;
      abortController.abort(new Error(`Tool invocation deadline exceeded (${timeoutMs}ms)`));
    }, timeoutMs);

    const invocationContext: CloudInvocationContext = {
      workspaceContext,
      idempotencyKey,
      deadline,
      traceContext,
      signal: abortController.signal,
      onProgress: options?.onProgress,
    };

    try {
      // 5. Execute Forwarding
      const result = await this.dispatch(toolIdOrName, params, invocationContext);

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // Handle cancellation vs timeout vs network failure
      if (didTimeout) {
        this.circuitBreaker.recordFailure(err);
        throw new McpProtocolError(
          MCP_ERROR_CODES.REQUEST_TIMEOUT,
          `Tool invocation for '${toolIdOrName}' timed out after ${timeoutMs}ms`,
        );
      }

      if (options?.signal?.aborted) {
        // Client-side cancellation does not increment failure count on circuit breaker
        throw new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Tool invocation was cancelled");
      }

      // Record failure on circuit breaker for upstream / network issues
      this.circuitBreaker.recordFailure(err);
      throw this.translateError(err, toolIdOrName);
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private async dispatch(
    toolIdOrName: string,
    params: JsonRpcParams,
    context: CloudInvocationContext,
  ): Promise<CallToolResult> {
    // Strategy 1: Custom forwarder function
    if (this.invocationForwarder) {
      return await this.invocationForwarder(toolIdOrName, params, context);
    }

    // Strategy 2: In-process invocation handler
    if (this.mockService) {
      return await this.mockService.handleToolInvocation(toolIdOrName, params, context);
    }

    // Strategy 3: HTTP REST API Forwarding
    // Strategy 3: Identity-driven or direct HTTP REST API Forwarding
    if (this.identityProvider || this.baseUrl) {
      let identity = this.identityProvider ? await this.identityProvider() : null;
      if (this.identityProvider && !identity) {
        this.isPaused = true;
        throw new McpProtocolError(
          MCP_ERROR_CODES.UNAUTHORIZED,
          "No cloud credentials available or credentials revoked",
        );
      }

      const targetBaseUrl = identity?.cloudUrl ?? this.baseUrl;
      if (!targetBaseUrl) {
        throw new McpProtocolError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          "No baseUrl or identity cloudUrl configured for CloudInvocationRouter",
        );
      }

      const url = `${targetBaseUrl}/v1/tools/${encodeURIComponent(toolIdOrName)}/invoke`;
      const buildHeaders = (id: CloudRequestIdentity | null): CloudInvocationHeaders => {
        const headers: CloudInvocationHeaders = {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Idempotency-Key": context.idempotencyKey,
          "X-Workspace-Id": id?.workspaceId ?? context.workspaceContext.workspaceId,
          "X-Session-Id": context.workspaceContext.sessionId || "",
          "X-Trace-Id": context.traceContext?.traceId || "",
          "X-Span-Id": context.traceContext?.spanId || "",
          "X-Parent-Span-Id": context.traceContext?.parentSpanId || "",
          "X-Sampled": context.traceContext?.sampled ? "1" : "0",
          "X-Deadline": String(context.deadline),
        };
        if (id) {
          headers.Authorization = `Bearer ${id.accessToken}`;
          headers["x-account-id"] = id.accountId;
          headers["x-workspace-id"] = id.workspaceId;
          headers["x-device-id"] = id.deviceId;
          headers["x-installation-id"] = id.installationId;
          if (id.userId) {
            headers["x-user-id"] = id.userId;
          }
        } else if (this.authToken) {
          headers.Authorization = `Bearer ${this.authToken}`;
        }
        return headers;
      };

      let response = await this.fetchFn(url, {
        method: "POST",
        headers: buildHeaders(identity),
        body: JSON.stringify({
          toolName: toolIdOrName,
          arguments: params,
        }),
        signal: context.signal,
      });

      if (response.status === 401 && this.identityProvider) {
        identity = await this.identityProvider({ forceRefresh: true });
        if (!identity) {
          this.isPaused = true;
          throw new McpProtocolError(
            MCP_ERROR_CODES.UNAUTHORIZED,
            "Cloud credentials revoked or invalid after 401 refresh",
          );
        }
        response = await this.fetchFn(url, {
          method: "POST",
          headers: buildHeaders(identity),
          body: JSON.stringify({
            toolName: toolIdOrName,
            arguments: params,
          }),
          signal: context.signal,
        });
        if (response.status === 401) {
          this.isPaused = true;
          throw new McpProtocolError(
            MCP_ERROR_CODES.UNAUTHORIZED,
            "Unauthorized cloud tool invocation after 401 refresh retry",
          );
        }
      }

      if (!response.ok) {
        let errorData: unknown;
        try {
          errorData = await response.json();
        } catch {
          // ignore non-json error
        }
        const errorMsg =
          errorData &&
          errorData instanceof Object &&
          "message" in errorData &&
          Object.prototype.toString.call(errorData.message) === "[object String]"
            ? String(errorData.message)
            : null;
        const msg =
          errorMsg ||
          `Cloud invocation failed with HTTP ${response.status}: ${response.statusText}`;
        if (response.status === 401 || response.status === 403) {
          this.isPaused = true;
          throw new McpProtocolError(MCP_ERROR_CODES.UNAUTHORIZED, msg);
        }
        if (response.status === 429) {
          throw new McpProtocolError(MCP_ERROR_CODES.RATE_LIMITED, msg);
        }
        if (response.status === 408 || response.status === 504) {
          throw new McpProtocolError(MCP_ERROR_CODES.REQUEST_TIMEOUT, msg);
        }
        if (response.status === 404) {
          throw new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, msg);
        }
        if (response.status === 400 || response.status === 422) {
          throw new McpProtocolError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, msg);
        }
        if (response.status >= 500) {
          throw new McpProtocolError(MCP_ERROR_CODES.CONNECTION_CLOSED, msg);
        }

        throw new McpProtocolError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, msg);
      }

      // SAFETY: Cloud server returns JSON conforming to CallToolResult.
      return (await response.json()) as CallToolResult;
    }

    throw new McpProtocolError(
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      `No cloud invocation transport configured for tool '${toolIdOrName}'`,
    );
  }

  private translateError(
    error:
      | Error
      | McpProtocolError
      | { code?: number; message?: string }
      | string
      | number
      | boolean
      | null
      | undefined,
    toolName: string,
  ): McpProtocolError {
    if (error instanceof McpProtocolError) {
      return error;
    }
    const msg = error instanceof Error ? error.message : String(error ?? "Unknown error");

    if (msg.includes("not found") || msg.includes("404")) {
      return new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `Cloud tool '${toolName}' not found: ${msg}`,
      );
    }

    if (
      msg.includes("Unauthorized") ||
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("token expired")
    ) {
      return new McpProtocolError(
        MCP_ERROR_CODES.UNAUTHORIZED,
        `Unauthorized cloud tool invocation: ${msg}`,
      );
    }

    if (msg.includes("Rate limit") || msg.includes("429") || msg.includes("rate_limited")) {
      return new McpProtocolError(
        MCP_ERROR_CODES.RATE_LIMITED,
        `Cloud tool invocation rate limited: ${msg}`,
      );
    }

    if (
      msg.includes("timed out") ||
      msg.includes("Timeout") ||
      msg.includes("504") ||
      msg.includes("408")
    ) {
      return new McpProtocolError(
        MCP_ERROR_CODES.REQUEST_TIMEOUT,
        `Cloud tool invocation timed out: ${msg}`,
      );
    }

    if (msg.includes("aborted") || msg.includes("cancelled") || msg.includes("Cancelled")) {
      return new McpProtocolError(
        MCP_ERROR_CODES.CANCELLED,
        `Cloud tool invocation cancelled: ${msg}`,
      );
    }

    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("offline") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("closed")
    ) {
      return new McpProtocolError(
        MCP_ERROR_CODES.CONNECTION_CLOSED,
        `Cloud service unavailable for tool '${toolName}': ${msg} (no silent queuing)`,
      );
    }

    return new McpProtocolError(
      JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      `Cloud tool '${toolName}' invocation error: ${msg}`,
    );
  }
}
