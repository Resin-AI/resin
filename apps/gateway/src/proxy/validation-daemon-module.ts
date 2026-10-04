import path from "node:path";
import {
  type DaemonModule,
  type DaemonModuleProviderContext,
  type DeviceSyncSignal,
  type DeviceSyncSnapshot,
  FilePrivateValueStore,
  type ModuleContext,
  type ModuleHealth,
  type ModuleLifecycleState,
  createLocalCallIdentity,
} from "@resin/observer";
import {
  FileValidationAskLedger,
  WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME,
} from "./validation-ask-ledger.js";
import {
  FileWorkflowValidationPassLease,
  WORKFLOW_VALIDATION_LEASE_FILE_NAME,
} from "./validation-lease.js";
import {
  DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS,
  DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS,
  WorkflowValidationClient,
  WorkflowValidationWorker,
  type WorkflowValidationWorkerOptions,
} from "./validation-worker.js";

export const WORKFLOW_VALIDATION_DAEMON_MODULE_ID = "workflow-validation";

/**
 * Answers the cloud's validation asks from the background daemon, so a learned tool is checked and
 * published without any agent session running `resin mcp`.
 *
 * It is the gateway's worker, built the way the gateway builds it: the same transport, the same
 * recording check over this device's own sessions and private-value store, the same workspace and
 * plan-digest refusals. It never runs a recorded program. The device-wide pass lease it shares with
 * every gateway keeps one process answering at a time.
 */
export class WorkflowValidationDaemonModule implements DaemonModule {
  readonly id = WORKFLOW_VALIDATION_DAEMON_MODULE_ID;
  readonly name = "Workflow Validation Answers";
  readonly dependencies = ["cloud-runtime"] as const;
  readonly critical = false;

  private readonly worker: WorkflowValidationWorker;
  private readonly deviceSync?: DeviceSyncSignal;
  private state: ModuleLifecycleState = "uninitialized";
  private readonly retryDelayMs: number;
  private unsubscribe?: () => void;
  /**
   * Identity and pending-ask token a pass has listed asks for. Recorded only once a listing that
   * started after the token was seen succeeded, so a pass skipped on the shared lease or a failed
   * listing leaves the token owed.
   */
  private followedToken?: string;
  /** The token a pass is owed for, while it is not yet listed. */
  private owedToken?: string;
  private retryTimer?: NodeJS.Timeout;

  /**
   * `deviceSync`: the daemon's consolidated sync. While it publishes answers, a pass runs at once
   * whenever the pending-ask token changes, and the worker's own timer only retries local work
   * (the worker must be built with `followsDeviceSync` reading the same signal). A pass that could
   * not list (another process held the lease, or the listing failed) is retried every
   * `retryDelayMs` until one lists or the token moves on.
   */
  constructor(
    worker: WorkflowValidationWorker,
    deviceSync?: DeviceSyncSignal,
    options: { retryDelayMs?: number } = {},
  ) {
    this.worker = worker;
    this.deviceSync = deviceSync;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS;
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(_context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.worker.start();
    this.followedToken = undefined;
    this.owedToken = undefined;
    this.unsubscribe ??= this.deviceSync?.subscribe((snapshot) => this.follow(snapshot));
    const current = this.deviceSync?.current();
    if (current) this.follow(current);
    this.state = "ready";
  }

  async stop(_context: ModuleContext): Promise<void> {
    this.state = "stopping";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.owedToken = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.worker.stop();
    this.state = "stopped";
  }

  /** Runs a pass now when the pending-ask token (or the identity it is for) changed. */
  private follow(snapshot: DeviceSyncSnapshot | null): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (snapshot === null) {
      // Answers stopped; the worker's own timer polls again, and the next answer starts afresh.
      this.followedToken = undefined;
      this.owedToken = undefined;
      return;
    }
    const { accountId, userId, validationToken } = snapshot.sync;
    if (validationToken === null) {
      // No asks are served without tool access; remember that so regaining it runs a pass.
      this.followedToken = `${accountId}\u0000${userId}\u0000-`;
      this.owedToken = undefined;
      return;
    }
    const token = `${accountId}\u0000${userId}\u0000${validationToken}`;
    if (token === this.followedToken || !this.worker.isRunning()) return;
    this.owedToken = token;
    void this.listFor(token);
  }

  /** Runs a pass whose listing starts now; records `token` only once such a listing succeeded. */
  private async listFor(token: string): Promise<void> {
    const seenAt = Date.now();
    try {
      await this.worker.runFresh();
    } catch {
      // A pass reports its own failures; whether it listed is read below.
    }
    if (this.owedToken !== token) return;
    if (this.worker.listedAt() >= seenAt) {
      this.followedToken = token;
      this.owedToken = undefined;
      return;
    }
    if (!this.worker.isRunning()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.owedToken === token) void this.listFor(token);
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }

  async healthCheck(): Promise<ModuleHealth> {
    return this.worker.isRunning()
      ? { status: "ready", lastCheckTime: Date.now() }
      : { status: "degraded", message: "validation polling is stopped", lastCheckTime: Date.now() };
  }
}

/**
 * The daemon's module for an enrolled device. `overrides` exist for tests and the local smoke;
 * the packaged daemon passes none.
 */
export function createWorkflowValidationDaemonModule(
  context: DaemonModuleProviderContext,
  overrides: Partial<Omit<WorkflowValidationWorkerOptions, "identity">> = {},
  moduleOptions: { retryDelayMs?: number } = {},
): WorkflowValidationDaemonModule {
  const privateValues = overrides.privateValues ?? FilePrivateValueStore.default();
  const workspaceId = context.credentials.workspaceId;
  return new WorkflowValidationDaemonModule(
    new WorkflowValidationWorker({
      client: new WorkflowValidationClient({
        identityProvider: (identityOptions) =>
          context.credentialStore.getRequestIdentity(identityOptions),
      }),
      privateValues,
      localCalls: createLocalCallIdentity({ workspaceId, privateValues }),
      timeoutMs: DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS,
      passLease: new FileWorkflowValidationPassLease({
        filePath: path.join(context.paths.stateDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME),
      }),
      askLedger: new FileValidationAskLedger({
        filePath: path.join(context.paths.stateDir, WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME),
        log: (message) => context.logger.warn(message),
      }),
      log: (message) => context.logger.info(message),
      ...(context.deviceSync
        ? { followsDeviceSync: () => context.deviceSync?.current() !== null }
        : {}),
      ...overrides,
      identity: { workspaceId, deviceId: context.credentials.deviceId },
    }),
    context.deviceSync,
    moduleOptions,
  );
}
