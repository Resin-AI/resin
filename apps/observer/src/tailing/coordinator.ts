import { EventEmitter } from "node:events";
import type {
  HarnessAdapter,
  HarnessSession,
  HarnessWorkspace,
  RawHarnessRecord,
  SessionEventSource,
} from "@resin/harness-contracts";
import type { SourceCursorManager } from "./cursor-manager.js";
import {
  type BackfillPolicy,
  type TailerRecordHandler,
  type TailerSessionStatus,
  TranscriptTailer,
} from "./tailer.js";

/**
 * Summary of a single workspace and session polling cycle.
 */
export interface PollSummary {
  timestamp: string;
  adaptersPolled: number;
  workspacesDiscovered: number;
  sessionsDiscovered: number;
  sessionsAttached: number;
  sessionsDetached: number;
  errors: string[];
}

/**
 * Detailed diagnostics snapshot for ObserverCoordinator.
 */
export interface ObserverDiagnostics {
  timestamp: string;
  isRunning: boolean;
  adapters: Array<{ id: string; name?: string; version: string }>;
  workspacesTracked: string[];
  activeSessions: TailerSessionStatus[];
  totalRecordsObserved: number;
  totalRecordsAcknowledged: number;
  pollCyclesCompleted: number;
  lastPollSummary?: PollSummary;
}

/**
 * Options for configuring ObserverCoordinator.
 */
export interface ObserverCoordinatorOptions {
  tailer?: TranscriptTailer;
  cursorManager?: SourceCursorManager;
  pollIntervalMs?: number;
  defaultBackfillPolicy?: BackfillPolicy;
  autoStart?: boolean;
  backfillPolicyForSession?: (session: HarnessSession) => BackfillPolicy | undefined;
  defaultMaxInFlightBatches?: number;
}

/**
 * ObserverCoordinator manages adapter registrations, periodic workspace/session polling,
 * active session lifecycle (attach/detach), and system diagnostics.
 */
export class ObserverCoordinator extends EventEmitter {
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly tailer: TranscriptTailer;
  private readonly pollIntervalMs: number;
  private readonly trackedWorkspaces = new Map<string, HarnessWorkspace>();
  private readonly activeSessionStates = new Map<string, HarnessSession>();
  private readonly backfillPolicyForSession?: (
    session: HarnessSession,
  ) => BackfillPolicy | undefined;
  private readonly defaultMaxInFlightBatches?: number;
  private isRunning = false;
  private pollTimer?: NodeJS.Timeout;
  private inFlightPoll?: Promise<PollSummary>;
  private pollCyclesCompleted = 0;
  private totalRecordsObserved = 0;
  private totalRecordsAcknowledged = 0;
  private lastPollSummary?: PollSummary;

  constructor(options: ObserverCoordinatorOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.backfillPolicyForSession = options.backfillPolicyForSession;
    this.defaultMaxInFlightBatches = options.defaultMaxInFlightBatches;
    this.tailer =
      options.tailer ??
      new TranscriptTailer({
        cursorManager: options.cursorManager,
        defaultBackfillPolicy: options.defaultBackfillPolicy,
        defaultMaxInFlightBatches: options.defaultMaxInFlightBatches,
      });
    if (options.autoStart) {
      void this.start();
    }
  }

  /**
   * Returns the underlying TranscriptTailer instance.
   */
  getTailer(): TranscriptTailer {
    return this.tailer;
  }

  /**
   * Registers a harness adapter for workspace and session discovery.
   */
  registerAdapter(adapter: HarnessAdapter): void {
    const adapterId = adapter.id ?? adapter.name ?? "unnamed-adapter";
    this.adapters.set(adapterId, adapter);
    this.emit("adapter:registered", { adapterId });
  }

  /**
   * Unregisters a harness adapter.
   */
  unregisterAdapter(adapterId: string): boolean {
    const existed = this.adapters.delete(adapterId);
    if (existed) {
      this.emit("adapter:unregistered", { adapterId });
    }
    return existed;
  }

  /**
   * Returns all currently registered harness adapters.
   */
  getAdapters(): HarnessAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Returns a specific adapter by ID.
   */
  getAdapter(adapterId: string): HarnessAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /**
   * Registers downstream handler to receive raw records from all observed sessions.
   */
  onRecords(handler: TailerRecordHandler): () => void {
    return this.tailer.onRecords(async (session, records, ack) => {
      this.totalRecordsObserved += records.length;
      const wrappedAck = async () => {
        await ack();
        this.totalRecordsAcknowledged += records.length;
      };
      await handler(session, records, wrappedAck);
    });
  }

  /**
   * Starts periodic polling and session supervision.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.pollOnce();
    } catch {
      // errors handled per-adapter; catch unexpected errors so startup finishes
    }

    if (!this.isRunning) {
      return;
    }

    this.emit("started");
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = undefined;
      if (!this.isRunning) return;

      try {
        await this.pollOnce();
      } catch {
        // preserve recurring polling despite unexpected errors
      } finally {
        if (this.isRunning) {
          this.schedulePoll();
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Executes a single discovery and sync cycle across all registered adapters.
   * If a poll cycle is already in progress, coalesces onto the in-flight promise.
   */
  async pollOnce(): Promise<PollSummary> {
    if (this.inFlightPoll) {
      return this.inFlightPoll;
    }

    const inFlight = this.executePollOnce().finally(() => {
      if (this.inFlightPoll === inFlight) {
        this.inFlightPoll = undefined;
      }
    });

    this.inFlightPoll = inFlight;
    return inFlight;
  }

  private async executePollOnce(): Promise<PollSummary> {
    const summary: PollSummary = {
      timestamp: new Date().toISOString(),
      adaptersPolled: this.adapters.size,
      workspacesDiscovered: 0,
      sessionsDiscovered: 0,
      sessionsAttached: 0,
      sessionsDetached: 0,
      errors: [],
    };

    const currentDiscoveredSessions = new Set<string>();

    for (const [adapterId, adapter] of this.adapters.entries()) {
      try {
        let workspaces: HarnessWorkspace[] = [];
        if ("listWorkspaces" in adapter && adapter.listWorkspaces instanceof Function) {
          workspaces = await adapter.listWorkspaces();
        }

        summary.workspacesDiscovered += workspaces.length;

        for (const workspace of workspaces) {
          this.trackedWorkspaces.set(workspace.workspaceId, workspace);

          let sessions: HarnessSession[] = [];
          if ("listSessions" in adapter && adapter.listSessions instanceof Function) {
            sessions = await adapter.listSessions(workspace);
          } else if (
            "resolveActiveSession" in adapter &&
            adapter.resolveActiveSession instanceof Function
          ) {
            const active = await adapter.resolveActiveSession(workspace);
            if (active) {
              sessions = [active];
            }
          }

          summary.sessionsDiscovered += sessions.length;

          for (const session of sessions) {
            currentDiscoveredSessions.add(session.sessionId);
            const previousSession = this.activeSessionStates.get(session.sessionId);

            if (session.status === "active") {
              const activeSessions = this.tailer.getActiveSessions();
              if (!activeSessions.includes(session.sessionId)) {
                // Open event source if supported by adapter
                let source: SessionEventSource | undefined;
                if ("openEventSource" in adapter && adapter.openEventSource instanceof Function) {
                  try {
                    const cursor = await this.tailer
                      .getCursorManager()
                      .getCursor(session.sessionId);
                    source = await adapter.openEventSource(session, cursor ?? undefined);
                  } catch (err: unknown) {
                    summary.errors.push(
                      `Failed to open event source for session ${session.sessionId}: ${String(err)}`,
                    );
                  }
                }

                const backfillPolicy = this.backfillPolicyForSession?.(session);

                await this.tailer.attachSession(session, source, {
                  workspaceId: workspace.workspaceId,
                  ...(backfillPolicy ? { backfillPolicy } : {}),
                  ...(this.defaultMaxInFlightBatches !== undefined
                    ? { maxInFlightBatches: this.defaultMaxInFlightBatches }
                    : {}),
                });
                summary.sessionsAttached++;
              }
              this.activeSessionStates.set(session.sessionId, session);
            } else if (
              session.status === "completed" ||
              session.status === "failed" ||
              session.status === "interrupted"
            ) {
              const activeSessions = this.tailer.getActiveSessions();
              if (activeSessions.includes(session.sessionId)) {
                if (previousSession?.status === "active") {
                  await this.tailer.notifyTerminalState(session);
                  this.activeSessionStates.set(session.sessionId, session);
                }
                await this.tailer.detachSession(session.sessionId);
                summary.sessionsDetached++;
              }
              this.activeSessionStates.set(session.sessionId, session);
            } else {
              this.activeSessionStates.set(session.sessionId, session);
            }
          }
        }
      } catch (err: unknown) {
        summary.errors.push(`Error polling adapter ${adapterId}: ${String(err)}`);
      }
    }

    this.pollCyclesCompleted++;
    this.lastPollSummary = summary;
    this.emit("poll:completed", summary);

    return summary;
  }

  /**
   * Returns current observer diagnostics.
   */
  getDiagnostics(): ObserverDiagnostics {
    const activeSessionStatuses: TailerSessionStatus[] = [];
    for (const sessionId of this.tailer.getActiveSessions()) {
      const status = this.tailer.getSessionStatus(sessionId);
      if (status) {
        activeSessionStatuses.push(status);
      }
    }

    return {
      timestamp: new Date().toISOString(),
      isRunning: this.isRunning,
      adapters: Array.from(this.adapters.values()).map((a) => ({
        id: a.id ?? a.name ?? "unnamed",
        name: a.name,
        version: a.version,
      })),
      workspacesTracked: Array.from(this.trackedWorkspaces.keys()),
      activeSessions: activeSessionStatuses,
      totalRecordsObserved: this.totalRecordsObserved,
      totalRecordsAcknowledged: this.totalRecordsAcknowledged,
      pollCyclesCompleted: this.pollCyclesCompleted,
      lastPollSummary: this.lastPollSummary,
    };
  }

  /**
   * Stops the coordinator and underlying tailer.
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.inFlightPoll) {
      try {
        await this.inFlightPoll;
      } catch {
        // ignore errors from in-flight poll during shutdown
      }
    }

    await this.tailer.close();
    this.trackedWorkspaces.clear();
    this.activeSessionStates.clear();
    this.emit("stopped");
  }
}
