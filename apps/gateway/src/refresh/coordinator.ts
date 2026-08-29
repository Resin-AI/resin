import crypto from "node:crypto";
import path from "node:path";
import type { CatalogSnapshot, CatalogToolSummary } from "@resin/contracts";
import type {
  CatalogChangeSummary,
  HarnessWorkspace,
  RefreshCapability,
} from "@resin/harness-contracts";
import type { McpConnection } from "../connection.js";
import type { JsonRpcNotification } from "../protocol/types.js";
import type { CatalogChangeEvent, ToolRegistry } from "../registry/index.js";
import { DEFAULT_META_TOOLS_REMINDER, NudgeDeduplicator, buildSafeNudgePayload } from "./nudge.js";
import type {
  NudgePayload,
  NudgeScope,
  RefreshAdapterHandler,
  RefreshAttempt,
  RefreshCoordinatorOptions,
  RefreshCoordinatorStats,
  RefreshOutcome,
  RefreshVerification,
} from "./types.js";
import { RefreshVerifier } from "./verifier.js";

/**
 * Interface representing a gateway providing connection management and notification dispatch.
 */
export interface McpGatewayLike {
  getAllConnections(): McpConnection[];
  getConnection(connectionId: string): McpConnection | undefined;
  sendNotificationToConnection(connectionId: string, notification: JsonRpcNotification): void;
}

/**
 * Outcome priority order for selecting the primary outcome of a refresh attempt.
 */
const OUTCOME_PRECEDENCE: Record<RefreshOutcome, number> = {
  native_observed: 7,
  native_sent: 6,
  nudge_delivered: 5,
  nudge_queued: 4,
  next_session_required: 3,
  meta_tools_only: 2,
  unsupported: 1,
  failed: 0,
};

/**
 * Central coordinator for tool catalog refresh notifications and harness-specific nudges.
 * Listens to ToolRegistry events, targets affected connections, debounces mutations,
 * dispatches MCP notifications and adapter nudges, and verifies client acknowledgment.
 */
export class CatalogRefreshCoordinator {
  private readonly debounceMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly metaToolsReminder: string;
  private readonly logger?: (level: string, message: string, meta?: unknown) => void;

  private readonly deduplicator: NudgeDeduplicator;
  private readonly verifier: RefreshVerifier;
  private readonly adapters = new Map<string, RefreshAdapterHandler>();
  private readonly attempts: RefreshAttempt[] = [];
  private readonly maxAttemptsHistory = 1000;

  private gateway?: McpGatewayLike;
  private registry?: ToolRegistry;
  private unsubscribeRegistry?: () => void;

  // Debouncing buffer: scopeKey -> { event: CatalogChangeEvent, timer: NodeJS.Timeout }
  private readonly pendingDebounceEvents = new Map<
    string,
    { event: CatalogChangeEvent; timer: NodeJS.Timeout }
  >();

  // Event listeners
  private readonly attemptListeners = new Set<(attempt: RefreshAttempt) => void>();
  private readonly verifiedListeners = new Set<(verification: RefreshVerification) => void>();

  // Internal counters
  private totalEventsReceived = 0;
  private totalAttempts = 0;
  private totalNativeSent = 0;
  private totalNativeObserved = 0;
  private totalNudgesDelivered = 0;
  private totalMetaToolsOnly = 0;
  private totalNextSessionRequired = 0;
  private totalUnsupported = 0;
  private totalFailed = 0;

  constructor(options: RefreshCoordinatorOptions = {}) {
    this.debounceMs = options.debounceMs ?? 50;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 30_000;
    this.metaToolsReminder = options.metaToolsReminder ?? DEFAULT_META_TOOLS_REMINDER;
    this.logger = options.logger;

    this.deduplicator = new NudgeDeduplicator({
      maxNudgesPerMinute: options.rateLimitMaxNudgesPerMinute ?? 60,
    });
    this.verifier = new RefreshVerifier({
      defaultTimeoutMs: this.verificationTimeoutMs,
    });

    this.verifier.onVerificationChanged((verification) => {
      if (verification.status === "observed") {
        this.totalNativeObserved++;
        const attempt = this.attempts.find((a) => a.attemptId === verification.attemptId);
        if (attempt) {
          attempt.verificationStatus = "observed";
          if (!attempt.outcomes.includes("native_observed")) {
            attempt.outcomes.push("native_observed");
          }
        }
      }
      this.notifyVerifiedListeners(verification);
    });

    if (options.adapters) {
      if (options.adapters instanceof Map) {
        for (const [id, handler] of options.adapters.entries()) {
          this.adapters.set(id, handler);
        }
      } else {
        for (const [id, handler] of Object.entries(options.adapters)) {
          this.adapters.set(id, handler);
        }
      }
    }

    this.initDefaultAdapters();

    if (options.gateway) {
      this.attachGateway(options.gateway);
    }
    if (options.registry) {
      this.attachRegistry(options.registry);
    }
  }

  /**
   * Initializes built-in adapter fallback profiles for standard harnesses.
   */
  private initDefaultAdapters(): void {
    if (!this.adapters.has("claude-code")) {
      this.adapters.set("claude-code", {
        harnessId: "claude-code",
        getCapabilities: () => ({
          supportsNativeListChange: false,
          supportsContextNudge: true,
          requiresSessionRestart: false,
          description: "Claude Code context notice nudge",
        }),
      });
    }

    if (!this.adapters.has("codex") && !this.adapters.has("codex-cli")) {
      const codexHandler: RefreshAdapterHandler = {
        harnessId: "codex-cli",
        getCapabilities: () => ({
          supportsNativeListChange: false,
          supportsContextNudge: false,
          requiresSessionRestart: true,
          description: "Codex CLI requires session restart",
        }),
      };
      this.adapters.set("codex", codexHandler);
      this.adapters.set("codex-cli", codexHandler);
    }

    if (!this.adapters.has("omp")) {
      this.adapters.set("omp", {
        harnessId: "omp",
        getCapabilities: () => ({
          supportsNativeListChange: true,
          supportsContextNudge: true,
          requiresSessionRestart: false,
          description: "Oh My Pi dual-refresh",
        }),
      });
    }
  }

  /**
   * Attaches an MCP Gateway server instance to this coordinator.
   */
  attachGateway(gateway: McpGatewayLike): void {
    this.gateway = gateway;
  }

  /**
   * Attaches a ToolRegistry instance to subscribe to catalog change events.
   */
  attachRegistry(registry: ToolRegistry): void {
    if (this.unsubscribeRegistry) {
      this.unsubscribeRegistry();
      this.unsubscribeRegistry = undefined;
    }

    this.registry = registry;
    this.unsubscribeRegistry = registry.events.onCatalogChanged((event: CatalogChangeEvent) => {
      this.enqueueCatalogChangeEvent(event);
    });
  }
  /**
   * Registers or overrides a harness adapter handler.
   */
  registerAdapter(harnessId: string, handler: RefreshAdapterHandler): void {
    this.adapters.set(harnessId, handler);
  }

  /**
   * Returns the registered adapter handler for a given harness ID.
   */
  getAdapter(harnessId: string): RefreshAdapterHandler | undefined {
    return this.adapters.get(harnessId);
  }

  /**
   * Receives incoming catalog change events from registry and applies debouncing.
   */
  enqueueCatalogChangeEvent(event: CatalogChangeEvent): void {
    this.totalEventsReceived++;
    const scopeKey = `${event.workspaceId}::${event.sessionId ?? "*"}`;

    if (this.debounceMs <= 0) {
      void this.dispatchCatalogRefresh(event);
      return;
    }

    const existing = this.pendingDebounceEvents.get(scopeKey);
    if (existing) {
      clearTimeout(existing.timer);
      for (const id of event.changedToolIds) {
        if (!existing.event.changedToolIds.includes(id)) {
          existing.event.changedToolIds.push(id);
        }
      }
      existing.event.snapshot = event.snapshot;
      existing.event.revision = event.revision;
      existing.event.timestamp = event.timestamp;

      existing.timer = setTimeout(() => {
        this.pendingDebounceEvents.delete(scopeKey);
        void this.dispatchCatalogRefresh(existing.event);
      }, this.debounceMs);
    } else {
      const timer = setTimeout(() => {
        this.pendingDebounceEvents.delete(scopeKey);
        void this.dispatchCatalogRefresh(event);
      }, this.debounceMs);

      this.pendingDebounceEvents.set(scopeKey, {
        event: { ...event, changedToolIds: [...event.changedToolIds] },
        timer,
      });
    }
  }

  /**
   * Dispatches catalog refresh to all active connections matching the event scope.
   */
  async dispatchCatalogRefresh(event: CatalogChangeEvent): Promise<RefreshAttempt[]> {
    if (!this.gateway) {
      this.logger?.("warn", "RefreshCoordinator received event but no gateway is attached.");
      return [];
    }

    const connections = this.gateway.getAllConnections();
    const affectedConnections = connections.filter((conn) => {
      if (conn.isClosed) return false;
      const connWorkspaceId = conn.workspaceContext.workspaceId;
      if (event.workspaceId !== "*" && connWorkspaceId !== event.workspaceId) {
        return false;
      }
      if (
        event.sessionId &&
        conn.workspaceContext.sessionId &&
        conn.workspaceContext.sessionId !== event.sessionId
      ) {
        return false;
      }
      return true;
    });

    if (affectedConnections.length === 0) {
      return [];
    }

    const attempts: RefreshAttempt[] = [];
    for (const conn of affectedConnections) {
      const attempt = await this.processConnectionRefresh(conn, event);
      attempts.push(attempt);
    }

    return attempts;
  }

  /**
   * Processes catalog refresh for a single active connection.
   */
  private async processConnectionRefresh(
    conn: McpConnection,
    event: CatalogChangeEvent,
  ): Promise<RefreshAttempt> {
    const attemptId = `att-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const outcomes: RefreshOutcome[] = [];
    let mcpNotificationSent = false;
    let adapterNudgeSent = false;
    let nudgePayload: NudgePayload | undefined;
    let error: string | undefined;

    const harnessId = conn.harnessId || "generic";
    const adapter = this.adapters.get(harnessId);
    const capabilities: RefreshCapability = adapter?.getCapabilities?.() ?? {
      supportsNativeListChange: Boolean(conn.clientCapabilities?.tools?.listChanged),
      supportsContextNudge: false,
      requiresSessionRestart: false,
    };

    const clientSupportsNative = Boolean(conn.clientCapabilities?.tools?.listChanged);
    const scope: NudgeScope = {
      workspaceId: conn.workspaceContext.workspaceId,
      ...(conn.workspaceContext.sessionId ? { sessionId: conn.workspaceContext.sessionId } : {}),
    };

    // 1. Native MCP Notification Dispatch (if client negotiated tools.listChanged)
    if (clientSupportsNative && conn.isInitialized && !conn.isClosed) {
      try {
        const notification: JsonRpcNotification = {
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        };
        this.gateway?.sendNotificationToConnection(conn.connectionId, notification);
        mcpNotificationSent = true;
        outcomes.push("native_sent");
        this.totalNativeSent++;
      } catch (err) {
        this.logger?.(
          "error",
          `Failed to send native list_changed to ${conn.connectionId}: ${(err as Error).message}`,
        );
        error = (err as Error).message;
        outcomes.push("failed");
      }
    }

    // 2. Harness Adapter Refresh / Context Nudge
    if (capabilities.supportsContextNudge) {
      if (this.deduplicator.shouldSendNudge(scope, event.revision)) {
        const addedIds: string[] = [];
        const updatedIds: string[] = [];
        const removedIds: string[] = [];

        // Classify changed tool IDs using snapshot if available
        for (const toolId of event.changedToolIds) {
          const tool = event.snapshot?.tools?.[toolId];
          if (tool) {
            if (tool.status === "active") {
              addedIds.push(toolId);
            } else if (tool.status === "deprecated") {
              updatedIds.push(toolId);
            } else {
              removedIds.push(toolId);
            }
          } else {
            updatedIds.push(toolId);
          }
        }

        nudgePayload = buildSafeNudgePayload({
          catalogRevision: event.revision,
          scope,
          addedToolIds: addedIds.length > 0 ? addedIds : event.changedToolIds,
          updatedToolIds: updatedIds,
          removedToolIds: removedIds,
          metaToolsReminder: this.metaToolsReminder,
          timestamp,
        });

        if (adapter?.notifyCatalogRefresh) {
          const workspace: HarnessWorkspace = {
            workspaceId: conn.workspaceContext.workspaceId,
            name: conn.workspaceContext.name || conn.workspaceContext.workspaceId,
            rootPath: conn.workspaceContext.canonicalRoot,
            configPath: path.join(conn.workspaceContext.canonicalRoot, ".config"),
            harnessId,
            metadata: {},
            ...(conn.workspaceContext.sessionId
              ? { activeSessionId: conn.workspaceContext.sessionId }
              : {}),
          };

          const changeSummary: CatalogChangeSummary = {
            addedToolIds: nudgePayload.addedToolIds,
            updatedToolIds: nudgePayload.updatedToolIds,
            removedToolIds: nudgePayload.removedToolIds,
            catalogVersion: "1.0.0",
            timestamp,
          };

          try {
            const result = await adapter.notifyCatalogRefresh(workspace, changeSummary);
            adapterNudgeSent = true;
            this.deduplicator.recordNudgeSent(scope, event.revision);

            if (result.outcome === "context_nudge") {
              outcomes.push("nudge_delivered");
              this.totalNudgesDelivered++;
            } else if (result.outcome === "native_list_change") {
              if (!outcomes.includes("native_sent")) {
                outcomes.push("native_sent");
                this.totalNativeSent++;
              }
            } else if (result.outcome === "next_session_required") {
              outcomes.push("next_session_required");
              this.totalNextSessionRequired++;
            } else if (result.outcome === "unsupported") {
              outcomes.push("unsupported");
              this.totalUnsupported++;
            } else {
              outcomes.push("failed");
              this.totalFailed++;
            }
          } catch (err) {
            this.logger?.(
              "error",
              `Adapter refresh failed for ${harnessId}: ${(err as Error).message}`,
            );
            error = (err as Error).message;
            outcomes.push("failed");
            this.totalFailed++;
          }
        } else {
          adapterNudgeSent = true;
          this.deduplicator.recordNudgeSent(scope, event.revision);
          outcomes.push("nudge_delivered");
          this.totalNudgesDelivered++;
        }
      }
    } else if (capabilities.requiresSessionRestart) {
      outcomes.push("next_session_required");
      this.totalNextSessionRequired++;
    } else if (!clientSupportsNative && !capabilities.supportsNativeListChange) {
      outcomes.push("meta_tools_only");
      this.totalMetaToolsOnly++;
    }

    if (outcomes.length === 0) {
      outcomes.push("unsupported");
      this.totalUnsupported++;
    }

    // Select primary outcome based on precedence
    let primaryOutcome: RefreshOutcome = outcomes[0] ?? "unsupported";
    for (const o of outcomes) {
      if ((OUTCOME_PRECEDENCE[o] ?? 0) > (OUTCOME_PRECEDENCE[primaryOutcome] ?? 0)) {
        primaryOutcome = o;
      }
    }

    const attempt: RefreshAttempt = {
      attemptId,
      connectionId: conn.connectionId,
      harnessId,
      workspaceId: conn.workspaceContext.workspaceId,
      ...(conn.workspaceContext.sessionId ? { sessionId: conn.workspaceContext.sessionId } : {}),
      revision: event.revision,
      primaryOutcome,
      outcomes,
      mcpNotificationSent,
      adapterNudgeSent,
      ...(nudgePayload ? { nudgePayload } : {}),
      ...(error ? { error } : {}),
      timestamp,
      verificationStatus: mcpNotificationSent ? "pending" : "skipped",
    };

    if (mcpNotificationSent) {
      this.verifier.registerAttempt(attempt, this.verificationTimeoutMs);
    }

    this.addAttemptToHistory(attempt);
    this.totalAttempts++;
    this.notifyAttemptListeners(attempt);

    return attempt;
  }

  /**
   * Invoked when a client connection performs `tools/list` to opportunistically verify catalog awareness.
   */
  recordToolsListObserved(connectionId: string, workspaceId?: string): RefreshVerification[] {
    return this.verifier.recordToolsListObserved(connectionId, workspaceId);
  }

  /**
   * Manually triggers a catalog refresh attempt for testing or administrative sync.
   */
  async triggerRefresh(
    workspaceId: string,
    revision: number,
    options: {
      sessionId?: string;
      changedToolIds?: string[];
      snapshot?: CatalogSnapshot;
    } = {},
  ): Promise<RefreshAttempt[]> {
    const event: CatalogChangeEvent = {
      workspaceId,
      sessionId: options.sessionId,
      revision,
      changedToolIds: options.changedToolIds ?? [],
      snapshot: options.snapshot ?? {
        snapshotId: `snap_${crypto.randomUUID()}`,
        workspaceId,
        timestamp: new Date().toISOString(),
        tools: {},
        digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      timestamp: new Date().toISOString(),
    };

    return this.dispatchCatalogRefresh(event);
  }

  /**
   * Adds an attempt to historical log.
   */
  private addAttemptToHistory(attempt: RefreshAttempt): void {
    this.attempts.push(attempt);
    if (this.attempts.length > this.maxAttemptsHistory) {
      this.attempts.shift();
    }
  }

  /**
   * Returns refresh attempts filtered by connection, workspace, or revision.
   */
  getAttempts(filter?: {
    connectionId?: string;
    workspaceId?: string;
    revision?: number;
    primaryOutcome?: RefreshOutcome;
  }): RefreshAttempt[] {
    let result = this.attempts;
    if (filter?.connectionId) {
      result = result.filter((a) => a.connectionId === filter.connectionId);
    }
    if (filter?.workspaceId) {
      result = result.filter((a) => a.workspaceId === filter.workspaceId);
    }
    if (filter?.revision !== undefined) {
      result = result.filter((a) => a.revision === filter.revision);
    }
    if (filter?.primaryOutcome) {
      result = result.filter((a) => a.primaryOutcome === filter.primaryOutcome);
    }
    return result;
  }

  /**
   * Returns verification records from the verifier.
   */
  getVerifications(filter?: {
    connectionId?: string;
    workspaceId?: string;
  }): RefreshVerification[] {
    return this.verifier.getVerifications(filter);
  }

  /**
   * Returns the internal deduplicator instance.
   */
  getDeduplicator(): NudgeDeduplicator {
    return this.deduplicator;
  }

  /**
   * Returns the internal verifier instance.
   */
  getVerifier(): RefreshVerifier {
    return this.verifier;
  }

  /**
   * Aggregates coordinator statistics.
   */
  getStats(): RefreshCoordinatorStats {
    const pending = this.verifier.getPendingVerifications().length;
    const timeouts = this.verifier.getVerifications({ status: "timeout" }).length;
    const observed = this.verifier.getVerifications({ status: "observed" }).length;

    return {
      totalEventsReceived: this.totalEventsReceived,
      totalAttempts: this.totalAttempts,
      totalNativeSent: this.totalNativeSent,
      totalNativeObserved: observed,
      totalNudgesDelivered: this.totalNudgesDelivered,
      totalMetaToolsOnly: this.totalMetaToolsOnly,
      totalNextSessionRequired: this.totalNextSessionRequired,
      totalUnsupported: this.totalUnsupported,
      totalFailed: this.totalFailed,
      totalVerificationsPending: pending,
      totalVerificationsObserved: observed,
      totalVerificationsTimedOut: timeouts,
    };
  }

  /**
   * Subscribes to refresh attempt events.
   */
  onRefreshAttempt(listener: (attempt: RefreshAttempt) => void): () => void {
    this.attemptListeners.add(listener);
    return () => {
      this.attemptListeners.delete(listener);
    };
  }

  /**
   * Subscribes to refresh verification events.
   */
  onRefreshVerified(listener: (verification: RefreshVerification) => void): () => void {
    this.verifiedListeners.add(listener);
    return () => {
      this.verifiedListeners.delete(listener);
    };
  }

  private notifyAttemptListeners(attempt: RefreshAttempt): void {
    for (const l of this.attemptListeners) {
      try {
        l(attempt);
      } catch {
        // Suppress listener error
      }
    }
  }

  private notifyVerifiedListeners(verification: RefreshVerification): void {
    for (const l of this.verifiedListeners) {
      try {
        l(verification);
      } catch {
        // Suppress listener error
      }
    }
  }

  /**
   * Destroys the coordinator, canceling all pending timers and unregistering listeners.
   */
  destroy(): void {
    for (const pending of this.pendingDebounceEvents.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingDebounceEvents.clear();

    if (this.unsubscribeRegistry) {
      this.unsubscribeRegistry();
      this.unsubscribeRegistry = undefined;
    }

    this.verifier.destroy();
    this.deduplicator.clear();
    this.attemptListeners.clear();
    this.verifiedListeners.clear();
  }
}
