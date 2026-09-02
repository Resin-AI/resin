import {
  type CatalogChangeSummary,
  type HarnessWorkspace,
  type RefreshCapability,
  type RefreshResult,
  createRefreshResult,
} from "@resin/harness-contracts";
import type { McpConnection } from "../../src/connection.js";
import type { JsonRpcMessage, JsonRpcNotification } from "../../src/protocol/types.js";
import type { RefreshAdapterHandler } from "../../src/refresh/types.js";
import { resolveWorkspaceContext } from "../../src/workspace-resolver.js";

export type MatrixScenario =
  | "native_only"
  | "nudge_only"
  | "both"
  | "restart_required"
  | "meta_tools_only"
  | "failure"
  | "unsupported";

export interface FakeAdapterOptions {
  harnessId?: string;
  scenario?: MatrixScenario;
  shouldThrow?: boolean;
  onRefreshCalled?: (workspace: HarnessWorkspace, changeSummary: CatalogChangeSummary) => void;
}

/**
 * Fake implementation of a harness adapter for deterministic refresh testing.
 */
export class FakeRefreshAdapter implements RefreshAdapterHandler {
  readonly harnessId: string;
  scenario: MatrixScenario;
  shouldThrow: boolean;
  refreshCalls: Array<{ workspace: HarnessWorkspace; changeSummary: CatalogChangeSummary }> = [];
  private readonly onRefreshCalled?: (
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ) => void;

  constructor(options: FakeAdapterOptions = {}) {
    this.harnessId = options.harnessId ?? "fake-harness";
    this.scenario = options.scenario ?? "both";
    this.shouldThrow = options.shouldThrow ?? false;
    this.onRefreshCalled = options.onRefreshCalled;
  }

  getCapabilities(): RefreshCapability {
    switch (this.scenario) {
      case "native_only":
        return {
          supportsNativeListChange: true,
          supportsContextNudge: false,
          requiresSessionRestart: false,
          description: "Fake native-only adapter",
        };
      case "nudge_only":
        return {
          supportsNativeListChange: false,
          supportsContextNudge: true,
          requiresSessionRestart: false,
          description: "Fake nudge-only adapter",
        };
      case "both":
        return {
          supportsNativeListChange: true,
          supportsContextNudge: true,
          requiresSessionRestart: false,
          description: "Fake dual-refresh adapter",
        };
      case "restart_required":
        return {
          supportsNativeListChange: false,
          supportsContextNudge: false,
          requiresSessionRestart: true,
          description: "Fake restart-required adapter",
        };
      case "failure":
        return {
          supportsNativeListChange: false,
          supportsContextNudge: true,
          requiresSessionRestart: false,
          description: "Fake failing adapter",
        };
      default:
        return {
          supportsNativeListChange: false,
          supportsContextNudge: false,
          requiresSessionRestart: false,
          description: "Fake unsupported adapter",
        };
    }
  }

  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    this.refreshCalls.push({ workspace, changeSummary });
    this.onRefreshCalled?.(workspace, changeSummary);

    if (this.shouldThrow || this.scenario === "failure") {
      throw new Error(`Simulated adapter failure for harness '${this.harnessId}'`);
    }

    const affectedToolCount =
      changeSummary.addedToolIds.length +
      changeSummary.updatedToolIds.length +
      changeSummary.removedToolIds.length;

    switch (this.scenario) {
      case "nudge_only":
      case "both":
        return createRefreshResult("context_nudge", {
          message: `Nudge delivered for ${affectedToolCount} tools`,
          catalogVersion: changeSummary.catalogVersion,
          appliedAt: changeSummary.timestamp,
          affectedToolCount,
        });

      case "native_only":
        return createRefreshResult("native_list_change", {
          message: `Native refresh applied for ${affectedToolCount} tools`,
          catalogVersion: changeSummary.catalogVersion,
          appliedAt: changeSummary.timestamp,
          affectedToolCount,
        });

      case "restart_required":
        return createRefreshResult("next_session_required", {
          message: `Session restart required for ${affectedToolCount} tools`,
          catalogVersion: changeSummary.catalogVersion,
          appliedAt: changeSummary.timestamp,
          affectedToolCount,
          requiresRestart: true,
        });
      default:
        return createRefreshResult("unsupported", {
          message: "Catalog refresh unsupported on this harness",
          catalogVersion: changeSummary.catalogVersion,
          appliedAt: changeSummary.timestamp,
          affectedToolCount,
        });
    }
  }
}

export interface FakeConnectionOptions {
  connectionId?: string;
  harnessId?: string;
  workspaceId?: string;
  sessionId?: string;
  cwd?: string;
  supportsListChanged?: boolean;
  isInitialized?: boolean;
  hasReceivedInitializedNotification?: boolean;
  onNotification?: (msg: JsonRpcNotification) => void;
}

/**
 * Creates a mock-capable McpConnection object for refresh testing.
 */
export function createMockConnection(options: FakeConnectionOptions = {}) {
  const connectionId = options.connectionId ?? "mock-conn-1";
  const harnessId = options.harnessId ?? "fake-harness";
  const workspaceContext = resolveWorkspaceContext({
    cwd: options.cwd ?? "/mock/workspace",
    harnessId,
    sessionId: options.sessionId,
  });
  if (options.workspaceId) {
    workspaceContext.workspaceId = options.workspaceId;
  }

  const notificationsReceived: JsonRpcNotification[] = [];

  const conn = {
    connectionId,
    harnessId,
    workspaceContext,
    isInitialized: options.isInitialized ?? true,
    hasReceivedInitializedNotification: options.hasReceivedInitializedNotification ?? true,
    isClosed: false,
    clientCapabilities: {
      roots: { listChanged: true },
      tools: {
        listChanged: options.supportsListChanged ?? false,
      },
    },
    serverCapabilities: {
      tools: { listChanged: true },
    },
    sendMessage(msg: JsonRpcMessage) {
      if (!("id" in msg) || msg.id === undefined) {
        const notif: JsonRpcNotification = {
          jsonrpc: "2.0",
          method: msg.method,
          params: "params" in msg ? msg.params : undefined,
        };
        notificationsReceived.push(notif);
        options.onNotification?.(notif);
      }
    },
    getActiveRequestCount() {
      return 0;
    },
    updateWorkspace(ctx: typeof workspaceContext) {
      this.workspaceContext = ctx;
    },
    close() {
      this.isClosed = true;
    },
  };

  // SAFETY: Test fixture implements mock McpConnection interface for testing.
  return {
    connection: conn as McpConnection,
    notificationsReceived,
  };
}

/**
 * Matrix bundle providing standard adapters matching all target harness profiles.
 */
export function createRefreshMatrix() {
  return {
    claudeCode: new FakeRefreshAdapter({
      harnessId: "claude-code",
      scenario: "nudge_only",
    }),
    codexCli: new FakeRefreshAdapter({
      harnessId: "codex-cli",
      scenario: "restart_required",
    }),
    omp: new FakeRefreshAdapter({
      harnessId: "omp",
      scenario: "both",
    }),
    nativeMcp: new FakeRefreshAdapter({
      harnessId: "native-mcp",
      scenario: "native_only",
    }),
    unsupported: new FakeRefreshAdapter({
      harnessId: "generic",
      scenario: "unsupported",
    }),
    failing: new FakeRefreshAdapter({
      harnessId: "faulty",
      scenario: "failure",
    }),
  };
}
