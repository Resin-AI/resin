import crypto from "node:crypto";
import type {
  InitializeParams,
  JsonRpcId,
  McpClientCapabilities,
  McpImplementationInfo,
  McpServerCapabilities,
} from "./protocol/types.js";
import type { WorkspaceContext } from "./workspace-resolver.js";

export interface RateLimiterOptions {
  capacity?: number;
  refillRatePerSec?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

/**
 * Token Bucket Rate Limiter for request throttling.
 */
export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private tokens: number;
  private lastRefillTimestamp: number;

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 50;
    this.refillRatePerSec = options.refillRatePerSec ?? 100;
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  tryConsume(cost = 1): RateLimitResult {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillTimestamp) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
    this.lastRefillTimestamp = now;

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true };
    }

    const missingTokens = cost - this.tokens;
    const retryAfterMs = Math.ceil((missingTokens / this.refillRatePerSec) * 1000);
    return { allowed: false, retryAfterMs };
  }
}

export interface InFlightRequest {
  id: JsonRpcId;
  method: string;
  startTime: number;
  abortController: AbortController;
  timeoutHandle?: NodeJS.Timeout;
}

export interface McpConnectionOptions {
  connectionId?: string;
  harnessId?: string;
  clientInfo?: McpImplementationInfo;
  workspaceContext: WorkspaceContext;
  protocolVersion?: string;
  rateLimiterOptions?: RateLimiterOptions;
  onClose?: () => void;
}

/**
 * Represents an active MCP client connection / harness session.
 */
export class McpConnection {
  readonly connectionId: string;
  readonly createdAt: number;
  harnessId: string;
  clientInfo: McpImplementationInfo;
  workspaceContext: WorkspaceContext;
  clientCapabilities: McpClientCapabilities;
  serverCapabilities: McpServerCapabilities;
  protocolVersion: string;
  isInitialized = false;
  isClosed = false;

  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly inFlightRequests = new Map<string | number, InFlightRequest>();
  private readonly onCloseCallbacks = new Set<() => void>();

  constructor(options: McpConnectionOptions) {
    this.connectionId = options.connectionId ?? crypto.randomUUID();
    this.createdAt = Date.now();
    this.harnessId = options.harnessId ?? "generic-mcp";
    this.clientInfo = options.clientInfo ?? { name: "unknown-mcp-client", version: "0.1.0" };
    this.workspaceContext = options.workspaceContext;
    this.clientCapabilities = {};
    this.serverCapabilities = {
      tools: { listChanged: true },
      logging: {},
    };
    this.protocolVersion = options.protocolVersion ?? "2024-11-05";
    this.rateLimiter = new TokenBucketRateLimiter(options.rateLimiterOptions);

    if (options.onClose) {
      this.onCloseCallbacks.add(options.onClose);
    }
  }

  /**
   * Applies initialize parameters from the client.
   */
  applyInitialize(params: InitializeParams, detectedHarnessId?: string): void {
    this.clientInfo = params.clientInfo;
    this.clientCapabilities = params.capabilities;
    this.protocolVersion = params.protocolVersion;
    if (detectedHarnessId) {
      this.harnessId = detectedHarnessId;
    }
  }

  /**
   * Updates workspace context associated with this connection.
   */
  updateWorkspace(context: WorkspaceContext): void {
    this.workspaceContext = context;
  }

  /**
   * Checks rate limit for incoming requests.
   */
  checkRateLimit(): { allowed: boolean; retryAfterMs?: number } {
    return this.rateLimiter.tryConsume(1);
  }

  /**
   * Registers an in-flight request and sets up cancellation and timeout handling.
   */
  registerInFlightRequest(
    id: JsonRpcId,
    method: string,
    timeoutMs?: number,
    onTimeout?: () => void,
  ): AbortSignal {
    if (id === null) {
      return new AbortController().signal;
    }

    // Cancel any existing request with the same ID
    this.cancelRequest(id, "Replaced by new request with same ID");

    const abortController = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        abortController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        this.inFlightRequests.delete(id);
        onTimeout?.();
      }, timeoutMs);
    }

    this.inFlightRequests.set(id, {
      id,
      method,
      startTime: Date.now(),
      abortController,
      timeoutHandle,
    });

    return abortController.signal;
  }

  /**
   * Marks an in-flight request as completed and cleans up timers.
   */
  completeInFlightRequest(id: JsonRpcId): void {
    if (id === null) return;
    const req = this.inFlightRequests.get(id);
    if (req) {
      clearTimeout(req.timeoutHandle);
      this.inFlightRequests.delete(id);
    }
  }

  /**
   * Cancels an active in-flight request by ID.
   */
  cancelRequest(id: JsonRpcId, reason?: string): boolean {
    if (id === null) return false;
    const req = this.inFlightRequests.get(id);
    if (req) {
      clearTimeout(req.timeoutHandle);
      req.abortController.abort(new Error(reason ?? "Request cancelled"));
      this.inFlightRequests.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Count of currently active in-flight requests.
   */
  getActiveRequestCount(): number {
    return this.inFlightRequests.size;
  }

  /**
   * Register close callback.
   */
  onClose(callback: () => void): () => void {
    this.onCloseCallbacks.add(callback);
    return () => {
      this.onCloseCallbacks.delete(callback);
    };
  }

  /**
   * Closes connection and cancels all in-flight requests.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    for (const req of this.inFlightRequests.values()) {
      clearTimeout(req.timeoutHandle);
      req.abortController.abort(new Error("Connection closed"));
    }
    this.inFlightRequests.clear();

    for (const cb of this.onCloseCallbacks) {
      try {
        cb();
      } catch {
        // Ignore errors during close
      }
    }
  }
}
