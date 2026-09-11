import type { ProvenPatternDto } from "@resin/contracts";
import type {
  CapabilityRepository,
  LocalDatabaseConnection,
  LocalStateStore,
  OpportunityLocalRepository,
  SessionRepository,
  ToolRepository,
} from "@resin/db";
import type { SessionEventSink, TrajectoryCaptureCoordinator } from "./analytics/index.js";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import type { JsonObject } from "./normalization/redaction.js";
import { type KillSwitchManager, createKillSwitchManager } from "./observability/kill-switches.js";
import { SessionOpportunityTracker } from "./opportunity/session-opportunity-tracker.js";
import type { TrajectoryCaptureRuntimeModule } from "./trajectory-capture-module.js";

/** Local session statuses whose in-memory opportunity windows can be released. */
const TERMINAL_SESSION_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  interrupted: true,
  terminated: true,
};

export interface OpportunityTrackingModuleOptions {
  /** Local state store or raw connection used to resolve repositories. */
  store?: LocalStateStore | LocalDatabaseConnection;
  /** Explicit session repository override. */
  sessionRepository?: SessionRepository;
  /** Explicit tool catalog override. */
  toolRepository?: ToolRepository;
  /** Explicit capability envelope source override. */
  capabilityRepository?: CapabilityRepository;
  /** Explicit local opportunity repository override. */
  opportunities?: OpportunityLocalRepository;
  /** Explicit evolution kill switch override. */
  killSwitches?: KillSwitchManager;
  logger?: Logger;
  /** Injectable clock in epoch milliseconds. */
  now?: () => number;
  /** Cost of synthesizing one tool, in USD. Dispatch requires savings to beat it. */
  synthesisCostUsd?: number;
  /** Minimum evidence-maturity confidence required to dispatch a proven pattern. */
  minDispatchConfidence?: number;
  /** Rolling per-session episode window bound. */
  maxEpisodesPerSession?: number;
  /** Authenticated account owning local sessions; used for published pattern attribution. */
  accountId?: string;
  /** Maintenance cadence for local pattern-outbox upload and hash-cache reconciliation. */
  uploadIntervalMs?: number;
  /** When false the tracker stays detached from the capture stream. */
  enabled?: boolean;
  /** Reuse an externally constructed tracker (tests and embedders). */
  tracker?: SessionOpportunityTracker;
  /**
   * Observed after a proven pattern is durably enqueued in the local pattern outbox.
   * The daemon uses this to surface `pattern:proven` locally.
   */
  onPatternProven?: (pattern: ProvenPatternDto) => void;
}

function isLocalStateStore(
  store: LocalStateStore | LocalDatabaseConnection,
): store is LocalStateStore {
  return "sessions" in store;
}

/**
 * Daemon runtime module that continuously tracks per-session workflow opportunities.
 *
 * It attaches a local-only sink to the trajectory capture coordinator's normalized event stream,
 * then drives the deterministic local opportunity engine over each session's rolling episode
 * window. Proven patterns are enqueued into the local pattern outbox for upload.
 */
export class OpportunityTrackingModule implements DaemonModule {
  readonly id = "opportunity-tracking";
  readonly name = "Local Opportunity Tracking";
  readonly dependencies: readonly string[] = ["cloud-runtime", "trajectory-capture"];
  readonly critical = false;

  private state: ModuleLifecycleState = "uninitialized";
  private readonly sessionRepository?: SessionRepository;
  private readonly toolRepository?: ToolRepository;
  private readonly capabilityRepository?: CapabilityRepository;
  private readonly opportunities?: OpportunityLocalRepository;
  private readonly killSwitches: KillSwitchManager;
  private readonly enabled: boolean;
  private readonly uploadIntervalMs?: number;
  private readonly synthesisCostUsd?: number;
  private readonly minDispatchConfidence?: number;
  private readonly maxEpisodesPerSession?: number;
  private readonly accountId?: string;
  private readonly onPatternProvenFn?: (pattern: ProvenPatternDto) => void;
  private readonly now: () => number;
  private logger?: Logger;
  private tracker?: SessionOpportunityTracker;
  private captureCoordinator?: TrajectoryCaptureCoordinator;
  private attachedSink?: SessionEventSink;
  private maintenanceTimer?: NodeJS.Timeout;
  private lastMaintenanceAtMs?: number;
  private maintenanceRuns = 0;

  constructor(options: OpportunityTrackingModuleOptions = {}) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled !== false;
    this.uploadIntervalMs =
      typeof options.uploadIntervalMs === "number" && options.uploadIntervalMs > 0
        ? Math.floor(options.uploadIntervalMs)
        : undefined;
    this.onPatternProvenFn = options.onPatternProven;
    this.synthesisCostUsd = options.synthesisCostUsd;
    this.minDispatchConfidence = options.minDispatchConfidence;
    this.maxEpisodesPerSession = options.maxEpisodesPerSession;
    this.accountId = options.accountId;
    this.tracker = options.tracker;

    let sessionRepository = options.sessionRepository;
    let toolRepository = options.toolRepository;
    let capabilityRepository = options.capabilityRepository;
    let opportunities = options.opportunities;
    let dbConnection: LocalDatabaseConnection | undefined;

    if (options.store) {
      if (isLocalStateStore(options.store)) {
        sessionRepository = sessionRepository ?? options.store.sessions;
        toolRepository = toolRepository ?? options.store.tools;
        capabilityRepository = capabilityRepository ?? options.store.capabilities;
        opportunities = opportunities ?? options.store.opportunities;
        dbConnection = options.store.conn;
      } else {
        dbConnection = options.store;
      }
    }

    this.sessionRepository = sessionRepository;
    this.toolRepository = toolRepository;
    this.capabilityRepository = capabilityRepository;
    this.opportunities = opportunities;
    this.killSwitches = options.killSwitches ?? createKillSwitchManager(dbConnection);
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(context: ModuleContext): Promise<void> {
    if (this.state === "starting" || this.state === "ready") {
      return;
    }
    this.logger = context.logger;
    this.state = "starting";

    if (!this.enabled) {
      this.state = "stopped";
      this.logger?.info("Opportunity tracking is disabled by configuration");
      return;
    }
    const opportunities = this.opportunities;
    if (!opportunities) {
      this.state = "degraded";
      this.logger?.warn(
        "Opportunity tracking has no local opportunity repository; module stays degraded",
      );
      return;
    }

    try {
      await this.killSwitches.initialize();
    } catch (err) {
      this.logger?.warn("Unable to initialize opportunity kill switches", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.tracker =
      this.tracker ??
      new SessionOpportunityTracker({
        opportunities,
        tools: this.toolRepository,
        capabilities: this.capabilityRepository,
        killSwitches: this.killSwitches,
        logger: this.logger,
        now: this.now,
        synthesisCostUsd: this.synthesisCostUsd,
        minDispatchConfidence: this.minDispatchConfidence,
        maxEpisodesPerSession: this.maxEpisodesPerSession,
        accountId: this.accountId,
        onPatternProven: this.onPatternProvenFn,
      });

    this.attachCaptureSink(context);
    this.startMaintenanceTimer();
    this.state = this.captureCoordinator ? "ready" : "degraded";
    this.logger?.info("Local opportunity tracking module started", {
      sinkAttached: Boolean(this.captureCoordinator),
      uploadIntervalMs: this.uploadIntervalMs ?? null,
    });
  }

  async stop(): Promise<void> {
    if (this.state === "stopping" || this.state === "stopped") {
      return;
    }
    this.state = "stopping";
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    this.detachCaptureSink();
    this.tracker?.reset();
    this.state = "stopped";
    this.logger?.info("Local opportunity tracking module stopped");
  }

  async healthCheck(): Promise<ModuleHealth> {
    const status =
      this.state === "ready"
        ? "ready"
        : this.state === "degraded"
          ? "degraded"
          : this.state === "failed"
            ? "failed"
            : "offline";
    return {
      status,
      message: `Opportunity tracking module is ${this.state}`,
      details: {
        state: this.state,
        enabled: this.enabled,
        sinkAttached: Boolean(this.captureCoordinator),
        maintenanceRuns: this.maintenanceRuns,
        ...(this.tracker?.getDiagnostics() ?? {}),
      },
      lastCheckTime: Date.now(),
    };
  }

  async getDiagnostics(): Promise<JsonObject> {
    return {
      id: this.id,
      state: this.state,
      enabled: this.enabled,
      sinkAttached: Boolean(this.captureCoordinator),
      uploadIntervalMs: this.uploadIntervalMs ?? null,
      lastMaintenanceAtMs: this.lastMaintenanceAtMs ?? null,
      maintenanceRuns: this.maintenanceRuns,
      ...(this.tracker?.getDiagnostics() ?? {}),
    };
  }

  getTracker(): SessionOpportunityTracker | undefined {
    return this.tracker;
  }

  private attachCaptureSink(context: ModuleContext): void {
    const captureModule = context.getModule<TrajectoryCaptureRuntimeModule>("trajectory-capture");
    const tracker = this.tracker;
    if (!captureModule || typeof captureModule.getCaptureCoordinator !== "function" || !tracker) {
      this.logger?.warn(
        "Trajectory capture coordinator unavailable; opportunity tracking stays detached",
      );
      return;
    }
    const coordinator = captureModule.getCaptureCoordinator();
    const sink: SessionEventSink = (session, events, sinkContext) =>
      tracker.handleSessionEvents(session, events, sinkContext);
    coordinator.setSessionEventSink(sink);
    this.captureCoordinator = coordinator;
    this.attachedSink = sink;
  }

  private detachCaptureSink(): void {
    if (this.captureCoordinator && this.attachedSink) {
      this.captureCoordinator.setSessionEventSink(undefined);
    }
    this.captureCoordinator = undefined;
    this.attachedSink = undefined;
  }

  /**
   * Periodic local maintenance: releases in-memory windows for sessions that are already terminal
   * or absent locally, then expires stale hash-cache entries that would otherwise suppress fresh
   * evidence. Queued patterns are already durable in the pattern outbox; reconciling
   * published/rejected outcomes is the cloud sync worker's job.
   */
  private startMaintenanceTimer(): void {
    if (!this.uploadIntervalMs || this.maintenanceTimer) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenance();
    }, this.uploadIntervalMs);
    this.maintenanceTimer.unref();
  }

  private async runMaintenance(): Promise<void> {
    const opportunities = this.opportunities;
    const tracker = this.tracker;
    if (!opportunities || !tracker) {
      return;
    }
    const nowMs = this.now();
    this.lastMaintenanceAtMs = nowMs;
    this.maintenanceRuns += 1;

    if (this.sessionRepository) {
      for (const sessionId of tracker.getTrackedSessionIds()) {
        try {
          const record = await this.sessionRepository.getSession(sessionId);
          if (!record || TERMINAL_SESSION_STATUSES[record.status] === true) {
            tracker.pruneSession(sessionId);
          }
        } catch (err) {
          this.logger?.debug(`Unable to resolve local session ${sessionId} during prune`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    try {
      await opportunities.pruneHashCache(new Date(nowMs).toISOString());
    } catch (err) {
      this.logger?.warn("Opportunity hash cache pruning failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
