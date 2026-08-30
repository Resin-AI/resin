import fs from "node:fs";
import path from "node:path";
import { ClaudeHarnessAdapter, ClaudeRecordDecoder } from "@resin/adapter-claude-code";
import { CodexHarnessAdapter, CodexRecordDecoder } from "@resin/adapter-codex";
import { OmpHarnessAdapter, OmpRecordDecoder } from "@resin/adapter-omp";
import type {
  LocalDatabaseConnection,
  LocalStateStore,
  SessionRepository,
  SyncRepository,
} from "@resin/db";
import type {
  HarnessAdapter,
  HarnessRecordDecoder,
  HarnessSession,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { z } from "zod";
import {
  type TrajectoryAttributionContext,
  TrajectoryAttributionContextSchema,
  type TrajectoryAttributionResolverFn,
  TrajectoryCaptureCoordinator,
} from "./analytics/index.js";
import { CloudObservationClient, type CloudRuntimeModule } from "./cloud-runtime.js";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import { NormalizationPipeline } from "./normalization/pipeline.js";
import type { JsonObject } from "./normalization/redaction.js";
import { ObserverCoordinator } from "./tailing/coordinator.js";
import { SourceCursorManager } from "./tailing/cursor-manager.js";

export const RemoteTelemetryConsentSnapshotSchema = z
  .object({
    metadataTelemetryEnabled: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RemoteTelemetryConsentSnapshot = z.infer<typeof RemoteTelemetryConsentSnapshotSchema>;

const LegacyTelemetryPrivacyCheckpointSchema = z
  .object({
    version: z.literal(1),
    cutoffMs: z.number().int().nonnegative(),
    telemetryEnabled: z.boolean(),
  })
  .strict();

const CurrentTelemetryPrivacyCheckpointSchema = z
  .object({
    version: z.literal(2),
    cutoffMs: z.number().int().nonnegative(),
    telemetryEnabled: z.boolean(),
    remoteConsent: RemoteTelemetryConsentSnapshotSchema.nullable(),
    remoteConsentCutoffMs: z.number().int().nonnegative(),
    remoteHistoryAvailable: z.boolean(),
  })
  .strict();

const TelemetryPrivacyCheckpointSchema = z.discriminatedUnion("version", [
  LegacyTelemetryPrivacyCheckpointSchema,
  CurrentTelemetryPrivacyCheckpointSchema,
]);

type TelemetryPrivacyCheckpoint = z.infer<typeof TelemetryPrivacyCheckpointSchema>;

export interface ReconcileRemoteTelemetryConsentResult {
  valid: boolean;
  changed: boolean;
  cutoffAdvanced: boolean;
}
/**
 * Resolves trajectory attribution context strictly from session metadata.
 * Missing or schema-invalid metadata returns undefined and is skipped.
 */
export function resolveSessionAttribution(
  session: HarnessSession,
): TrajectoryAttributionContext | undefined {
  const rawAttribution = session.metadata?.resinTrajectoryAttribution;
  if (!rawAttribution || !z.record(z.unknown()).safeParse(rawAttribution).success) {
    return undefined;
  }
  const parsed = TrajectoryAttributionContextSchema.safeParse(rawAttribution);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

export interface TrajectoryCaptureRuntimeModuleOptions {
  /**
   * Getter or factory function to resolve the CloudObservationClient dynamically.
   */
  getObservationClient?: () => CloudObservationClient | undefined;

  /**
   * Directly injected CloudObservationClient instance.
   */
  observationClient?: CloudObservationClient;

  /**
   * Optional custom ObserverCoordinator.
   */
  observerCoordinator?: ObserverCoordinator;

  /**
   * Optional custom SourceCursorManager for persistent or test checkpointing.
   */
  cursorManager?: SourceCursorManager;

  /**
   * Optional local database state store or connection for cursor persistence.
   */
  store?: LocalStateStore | LocalDatabaseConnection;

  /**
   * Optional session repository instance for cursor persistence.
   */
  sessionRepository?: SessionRepository;

  /**
   * Optional custom NormalizationPipeline.
   */
  normalizationPipeline?: NormalizationPipeline;

  /**
   * Optional custom TrajectoryCaptureCoordinator.
   */
  captureCoordinator?: TrajectoryCaptureCoordinator;

  /**
   * Optional custom attribution resolver. Defaults to `resolveSessionAttribution`.
   */
  attributionResolver?: TrajectoryAttributionResolverFn;

  /**
   * Optional harness adapters. Defaults to Claude, Codex, and OMP adapters.
   */
  adapters?: HarnessAdapter[];

  /**
   * Optional record decoders. Defaults to Claude, Codex, and OMP record decoders.
   */
  decoders?: HarnessRecordDecoder[];

  /**
   * Local device telemetry gate. Missing defaults to enabled; any other runtime value fails closed.
   */
  telemetryEnabled?: boolean;

  /**
   * Optional additional emission authorization. The timestamps identify every record represented
   * by the pending payload.
   */
  authorizeTelemetryEmission?: (
    recordTimestampMs: readonly number[],
  ) => Promise<boolean | null | undefined>;

  /**
   * Initial authoritative account-level consent, including the cloud transition timestamp.
   * Explicit `null` configures remote consent as required but currently unknown.
   */
  remoteTelemetryConsent?: RemoteTelemetryConsentSnapshot | null;

  /**
   * Refreshes authoritative account consent before processing and before every cloud request.
   */
  refreshRemoteTelemetryConsent?: () => Promise<RemoteTelemetryConsentSnapshot | null | undefined>;

  /**
   * Owner-only checkpoint recording the latest privacy boundary across daemon restarts.
   */
  privacyCheckpointPath?: string;

  /**
   * Injectable clock for deterministic privacy-boundary tests.
   */
  now?: () => number;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

function isLocalStateStore(
  store: LocalStateStore | LocalDatabaseConnection,
): store is LocalStateStore {
  return "sessions" in store;
}

/**
 * Daemon runtime module managing the transcript tailing coordinator, normalization pipeline,
 * harness adapter decoders, and trajectory capture & calibration submission.
 */
export class TrajectoryCaptureRuntimeModule implements DaemonModule {
  readonly id = "trajectory-capture";
  readonly name = "Trajectory Capture & Calibration Coordinator";
  readonly dependencies: readonly string[] = ["cloud-runtime"];
  readonly critical = false;

  private state: ModuleLifecycleState = "uninitialized";
  private observerCoordinator: ObserverCoordinator;
  private readonly cursorManager?: SourceCursorManager;
  private readonly ownsObserverCoordinator: boolean;
  private observerCoordinatorNeedsRebuild = false;
  private readonly normalizationPipeline: NormalizationPipeline;
  private readonly captureCoordinator: TrajectoryCaptureCoordinator;
  private readonly adapters: HarnessAdapter[];
  private readonly decoders: HarnessRecordDecoder[];
  private readonly getObservationClientFn?: () => CloudObservationClient | undefined;
  private readonly authorizeTelemetryEmissionFn?: (
    recordTimestampMs: readonly number[],
  ) => Promise<boolean | null | undefined>;
  private readonly refreshRemoteTelemetryConsentFn?: () => Promise<
    RemoteTelemetryConsentSnapshot | null | undefined
  >;
  private readonly remoteConsentRequired: boolean;
  private resolvedObservationClient?: CloudObservationClient;
  private unsubscribeRecords?: () => void;
  private telemetryEnabled: boolean;
  private readonly privacyCheckpointPath?: string;
  private readonly now: () => number;
  private privacyCutoffMs: number;
  private remoteConsentCutoffMs: number;
  private remoteTelemetryConsent: RemoteTelemetryConsentSnapshot | null;
  private remoteConsentHistoryAvailable: boolean;
  private remoteConsentAuthorizationQueue: Promise<void> = Promise.resolve();
  private privacyCheckpointHealthy: boolean;
  private skipBackfillOnNextStart = true;
  private logger?: Logger;

  constructor(options: TrajectoryCaptureRuntimeModuleOptions = {}) {
    this.logger = options.logger;
    this.getObservationClientFn = options.getObservationClient;
    this.authorizeTelemetryEmissionFn = options.authorizeTelemetryEmission;
    this.refreshRemoteTelemetryConsentFn = options.refreshRemoteTelemetryConsent;
    this.remoteConsentRequired =
      options.remoteTelemetryConsent !== undefined ||
      options.refreshRemoteTelemetryConsent !== undefined;
    this.resolvedObservationClient = options.observationClient;
    this.privacyCheckpointPath = options.privacyCheckpointPath;
    this.now = options.now ?? Date.now;
    const requestedTelemetryEnabled =
      options.telemetryEnabled === undefined ? true : options.telemetryEnabled === true;
    const persistedCheckpoint = this.readPersistedPrivacyCheckpoint();
    this.remoteConsentCutoffMs =
      persistedCheckpoint?.version === 2 ? persistedCheckpoint.remoteConsentCutoffMs : 0;
    this.remoteTelemetryConsent =
      persistedCheckpoint?.version === 2 ? persistedCheckpoint.remoteConsent : null;
    this.remoteConsentHistoryAvailable =
      !this.remoteConsentRequired ||
      (persistedCheckpoint?.version === 2 && persistedCheckpoint.remoteHistoryAvailable);
    this.privacyCutoffMs = Math.max(
      persistedCheckpoint?.cutoffMs ?? 0,
      this.remoteConsentCutoffMs,
      this.now(),
    );
    if (options.remoteTelemetryConsent) {
      this.reconcileRemoteTelemetryConsent(options.remoteTelemetryConsent);
    }
    this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(requestedTelemetryEnabled);
    this.telemetryEnabled = requestedTelemetryEnabled && this.privacyCheckpointHealthy;

    // 1. Decoders and Normalization Pipeline
    this.decoders = options.decoders ?? [
      new ClaudeRecordDecoder(),
      new CodexRecordDecoder(),
      new OmpRecordDecoder(),
    ];

    let dbConnection: LocalDatabaseConnection | undefined;
    let sessionRepository: SessionRepository | undefined = options.sessionRepository;
    let syncRepository: SyncRepository | undefined;

    if (options.store) {
      if (isLocalStateStore(options.store)) {
        dbConnection = options.store.conn;
        sessionRepository = sessionRepository ?? options.store.sessions;
        syncRepository = options.store.sync;
      } else {
        dbConnection = options.store;
      }
    }

    this.normalizationPipeline =
      options.normalizationPipeline ??
      new NormalizationPipeline({
        sessionRepository,
        syncRepository,
        dbConnection,
      });
    for (const decoder of this.decoders) {
      this.normalizationPipeline.registerDecoder(decoder);
    }

    // 2. Adapters and Observer Coordinator
    this.adapters = options.adapters ?? [
      new ClaudeHarnessAdapter(),
      new CodexHarnessAdapter(),
      new OmpHarnessAdapter(),
    ];

    this.cursorManager =
      options.cursorManager ??
      (options.store
        ? new SourceCursorManager({ store: options.store })
        : options.sessionRepository
          ? new SourceCursorManager({ sessionRepository: options.sessionRepository })
          : undefined);

    this.ownsObserverCoordinator = !options.observerCoordinator;
    this.observerCoordinator =
      options.observerCoordinator ??
      new ObserverCoordinator({
        cursorManager: this.cursorManager,
        defaultBackfillPolicy: { mode: "latest" },
      });
    for (const adapter of this.adapters) {
      this.observerCoordinator.registerAdapter(adapter);
    }
    // 3. Attribution Resolver
    const attributionResolver = options.attributionResolver ?? resolveSessionAttribution;

    // 4. Delegating Observation Client Proxy
    // SAFETY: Proxy wraps dynamically resolved observation client methods.
    const clientProxy =
      this.resolvedObservationClient ??
      new Proxy({} as CloudObservationClient, {
        get: (_target, prop: keyof CloudObservationClient) => {
          const client = this.getEffectiveObservationClient();
          const value = client[prop];
          if (value instanceof Function) {
            return value.bind(client);
          }
          return value;
        },
      });

    // 5. Trajectory Capture Coordinator
    if (options.captureCoordinator) {
      this.captureCoordinator = options.captureCoordinator;
    } else {
      const authorizeTelemetryEmission =
        this.remoteConsentRequired || this.authorizeTelemetryEmissionFn
          ? (recordTimestampMs: readonly number[]) =>
              this.authorizeTelemetryRecords(recordTimestampMs)
          : undefined;
      this.captureCoordinator = new TrajectoryCaptureCoordinator({
        pipeline: this.normalizationPipeline,
        observationClient: clientProxy,
        attributionResolver,
        logger: this.logger,
        isTelemetryEnabled: () => this.telemetryEnabled,
        authorizeTelemetryEmission,
        minimumRecordTimestampMs: this.privacyCutoffMs,
      });
    }

    if (
      "setPrivacyCutoff" in this.captureCoordinator &&
      this.captureCoordinator.setPrivacyCutoff instanceof Function
    ) {
      this.captureCoordinator.setPrivacyCutoff(this.privacyCutoffMs);
    }

    this.captureCoordinator.setTelemetryEnabled(this.telemetryEnabled);

    // 6. Wire onRecords only while local telemetry is explicitly enabled.
    if (this.telemetryEnabled) {
      this.unsubscribeRecords = this.observerCoordinator.onRecords(
        this.captureCoordinator.handleRecords,
      );
    }
  }

  private readPersistedPrivacyCheckpoint(): TelemetryPrivacyCheckpoint | undefined {
    if (!this.privacyCheckpointPath) {
      return undefined;
    }
    try {
      const stats = fs.statSync(this.privacyCheckpointPath);
      if (!stats.isFile() || stats.size > 64 * 1024) {
        throw new Error("invalid checkpoint file");
      }
      return TelemetryPrivacyCheckpointSchema.parse(
        JSON.parse(fs.readFileSync(this.privacyCheckpointPath, "utf8")),
      );
    } catch (error) {
      const errorCode =
        error instanceof Error && "code" in error && z.string().safeParse(error.code).success
          ? String(error.code)
          : undefined;
      if (errorCode !== "ENOENT") {
        this.logger?.warn(
          "Telemetry privacy checkpoint was unreadable; a new fail-closed boundary will be used",
        );
      }
      return undefined;
    }
  }

  private persistPrivacyCheckpoint(telemetryEnabled: boolean): boolean {
    if (!this.privacyCheckpointPath) {
      return true;
    }
    const temporaryPath = `${this.privacyCheckpointPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.privacyCheckpointPath), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify({
          version: 2,
          cutoffMs: this.privacyCutoffMs,
          telemetryEnabled,
          remoteConsent: this.remoteTelemetryConsent,
          remoteConsentCutoffMs: this.remoteConsentCutoffMs,
          remoteHistoryAvailable: this.remoteConsentHistoryAvailable,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      fs.renameSync(temporaryPath, this.privacyCheckpointPath);
      return true;
    } catch {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup only; the telemetry gate remains closed on enable failure.
      }
      this.logger?.warn(
        "Unable to persist the telemetry privacy checkpoint; telemetry remains disabled",
      );
      return false;
    }
  }

  private advanceRemoteConsentCutoff(cutoffMs: number): boolean {
    const normalizedCutoff = Number.isFinite(cutoffMs)
      ? Math.max(0, Math.trunc(cutoffMs))
      : Number.MAX_SAFE_INTEGER;
    if (normalizedCutoff <= this.remoteConsentCutoffMs) {
      return false;
    }
    this.remoteConsentCutoffMs = normalizedCutoff;
    this.privacyCutoffMs = Math.max(this.privacyCutoffMs, normalizedCutoff);
    return true;
  }

  private reconcileRemoteTelemetryConsent(
    snapshot: RemoteTelemetryConsentSnapshot | null | undefined,
  ): ReconcileRemoteTelemetryConsentResult {
    const parsed = RemoteTelemetryConsentSnapshotSchema.safeParse(snapshot);
    const previousHistoryAvailable = this.remoteConsentHistoryAvailable;
    let cutoffAdvanced = false;
    if (!parsed.success) {
      this.remoteConsentHistoryAvailable = false;
      cutoffAdvanced = this.advanceRemoteConsentCutoff(this.now());
      return {
        valid: false,
        changed: previousHistoryAvailable || cutoffAdvanced,
        cutoffAdvanced,
      };
    }

    const nextConsent = parsed.data;
    const nextUpdatedAtMs = Date.parse(nextConsent.updatedAt);
    const previousConsent = this.remoteTelemetryConsent;
    if (!previousConsent) {
      cutoffAdvanced = this.advanceRemoteConsentCutoff(Math.max(this.now(), nextUpdatedAtMs));
      this.remoteTelemetryConsent = nextConsent;
      this.remoteConsentHistoryAvailable = true;
      return { valid: true, changed: true, cutoffAdvanced };
    }

    const previousUpdatedAtMs = Date.parse(previousConsent.updatedAt);
    if (
      nextUpdatedAtMs < previousUpdatedAtMs ||
      (nextUpdatedAtMs === previousUpdatedAtMs &&
        nextConsent.metadataTelemetryEnabled !== previousConsent.metadataTelemetryEnabled)
    ) {
      this.remoteConsentHistoryAvailable = false;
      cutoffAdvanced = this.advanceRemoteConsentCutoff(this.now());
      return {
        valid: false,
        changed: previousHistoryAvailable || cutoffAdvanced,
        cutoffAdvanced,
      };
    }

    if (!this.remoteConsentHistoryAvailable) {
      if (nextUpdatedAtMs <= previousUpdatedAtMs) {
        return { valid: false, changed: false, cutoffAdvanced: false };
      }
      cutoffAdvanced = this.advanceRemoteConsentCutoff(Math.max(this.now(), nextUpdatedAtMs));
      this.remoteConsentHistoryAvailable = true;
    } else if (nextUpdatedAtMs > previousUpdatedAtMs && nextConsent.metadataTelemetryEnabled) {
      // A later enabled snapshot may conceal a complete false -> true transition. Advancing the
      // cutoff to updatedAt makes every record from that unavailable interval ineligible.
      cutoffAdvanced = this.advanceRemoteConsentCutoff(nextUpdatedAtMs);
    }

    const changed =
      cutoffAdvanced ||
      !previousHistoryAvailable ||
      nextConsent.updatedAt !== previousConsent.updatedAt ||
      nextConsent.metadataTelemetryEnabled !== previousConsent.metadataTelemetryEnabled;
    this.remoteTelemetryConsent = nextConsent;
    return { valid: true, changed, cutoffAdvanced };
  }

  private async refreshAndAuthorizeRemoteTelemetry(
    recordTimestampMs: readonly number[],
  ): Promise<boolean> {
    if (!this.refreshRemoteTelemetryConsentFn) {
      return false;
    }
    let snapshot: RemoteTelemetryConsentSnapshot | null;
    try {
      snapshot = (await this.refreshRemoteTelemetryConsentFn()) ?? null;
    } catch {
      snapshot = null;
    }
    if (!snapshot) {
      return false;
    }

    const reconciliation = this.reconcileRemoteTelemetryConsent(snapshot);
    if (reconciliation.cutoffAdvanced) {
      this.captureCoordinator.setPrivacyCutoff(this.privacyCutoffMs);
    }
    if (reconciliation.changed) {
      this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(this.telemetryEnabled);
      if (!this.privacyCheckpointHealthy) {
        this.telemetryEnabled = false;
        this.captureCoordinator.setTelemetryEnabled(false);
        if (this.unsubscribeRecords) {
          this.unsubscribeRecords();
          this.unsubscribeRecords = undefined;
        }
        return false;
      }
    }
    if (
      !reconciliation.valid ||
      !this.remoteConsentHistoryAvailable ||
      this.remoteTelemetryConsent?.metadataTelemetryEnabled !== true
    ) {
      return false;
    }
    return recordTimestampMs.every(
      (timestampMs) => Number.isFinite(timestampMs) && timestampMs > this.remoteConsentCutoffMs,
    );
  }

  private async authorizeTelemetryRecords(recordTimestampMs: readonly number[]): Promise<boolean> {
    if (this.remoteConsentRequired) {
      const remoteAuthorization = this.remoteConsentAuthorizationQueue.then(() =>
        this.refreshAndAuthorizeRemoteTelemetry(recordTimestampMs),
      );
      this.remoteConsentAuthorizationQueue = remoteAuthorization.then(
        () => undefined,
        () => undefined,
      );
      if (!(await remoteAuthorization)) {
        return false;
      }
    }
    if (!this.authorizeTelemetryEmissionFn) {
      return true;
    }
    try {
      return (await this.authorizeTelemetryEmissionFn(recordTimestampMs)) === true;
    } catch {
      return false;
    }
  }

  private getEffectiveObservationClient(): CloudObservationClient {
    if (this.resolvedObservationClient) {
      return this.resolvedObservationClient;
    }
    if (this.getObservationClientFn) {
      const client = this.getObservationClientFn();
      if (client) {
        return client;
      }
    }
    return new CloudObservationClient();
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  /**
   * Closes the local telemetry gate synchronously. Stopping the tailer is intentionally handled
   * by the lifecycle controller so consent withdrawal wins even while shutdown is still pending.
   */
  setTelemetryEnabled(enabled: boolean): boolean {
    const nextEnabled = enabled === true;
    if (!nextEnabled) {
      this.telemetryEnabled = false;
      this.captureCoordinator.setTelemetryEnabled(false);
      if (this.unsubscribeRecords) {
        this.unsubscribeRecords();
        this.unsubscribeRecords = undefined;
      }
      this.privacyCutoffMs = Math.max(this.privacyCutoffMs, this.now());
      if (
        "setPrivacyCutoff" in this.captureCoordinator &&
        this.captureCoordinator.setPrivacyCutoff instanceof Function
      ) {
        this.captureCoordinator.setPrivacyCutoff(this.privacyCutoffMs);
      }
      this.skipBackfillOnNextStart = true;
      this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(false);
      return true;
    }

    if (this.telemetryEnabled) {
      return true;
    }

    this.privacyCutoffMs = Math.max(this.privacyCutoffMs, this.now());
    if (
      "setPrivacyCutoff" in this.captureCoordinator &&
      this.captureCoordinator.setPrivacyCutoff instanceof Function
    ) {
      this.captureCoordinator.setPrivacyCutoff(this.privacyCutoffMs);
    }
    this.skipBackfillOnNextStart = true;
    this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(true);
    if (!this.privacyCheckpointHealthy) {
      this.captureCoordinator.setTelemetryEnabled(false);
      return false;
    }

    this.telemetryEnabled = true;
    this.captureCoordinator.setTelemetryEnabled(true);
    return true;
  }
  isTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
  }

  private rebuildOwnedObserverCoordinator(): void {
    if (!this.ownsObserverCoordinator || !this.observerCoordinatorNeedsRebuild) {
      return;
    }
    if (this.unsubscribeRecords) {
      this.unsubscribeRecords();
      this.unsubscribeRecords = undefined;
    }
    this.observerCoordinator = new ObserverCoordinator({
      cursorManager: this.cursorManager,
      defaultBackfillPolicy: this.skipBackfillOnNextStart ? { mode: "latest" } : undefined,
    });
    for (const adapter of this.adapters) {
      this.observerCoordinator.registerAdapter(adapter);
    }
    this.observerCoordinatorNeedsRebuild = false;
  }

  private async resetCursorsForPrivacyBoundary(): Promise<void> {
    if (!this.skipBackfillOnNextStart) {
      return;
    }
    const tailer = this.observerCoordinator.getTailer();
    const cursorManager = this.cursorManager ?? tailer?.getCursorManager();
    if (!cursorManager) {
      return;
    }
    const cursors = await cursorManager.listCursors();
    for (const sessionId of cursors.keys()) {
      await cursorManager.deleteCursor(sessionId);
    }
  }
  async start(context: ModuleContext): Promise<void> {
    if (!this.telemetryEnabled) {
      this.captureCoordinator.setTelemetryEnabled(false);
      this.state = "stopped";
      return;
    }

    if (this.state === "starting" || this.state === "ready") {
      return;
    }
    this.state = "starting";
    this.logger = context.logger;
    this.rebuildOwnedObserverCoordinator();
    this.captureCoordinator.setTelemetryEnabled(true);

    // Resolve observation client from cloud-runtime if not already injected
    if (!this.resolvedObservationClient && !this.getObservationClientFn) {
      const cloudModule = context.getModule<CloudRuntimeModule>("cloud-runtime");
      if (
        cloudModule &&
        "getObservationClient" in cloudModule &&
        cloudModule.getObservationClient instanceof Function
      ) {
        this.resolvedObservationClient = cloudModule.getObservationClient();
      }
    }

    // Ensure record subscription is wired
    if (!this.unsubscribeRecords) {
      this.unsubscribeRecords = this.observerCoordinator.onRecords(
        this.captureCoordinator.handleRecords,
      );
    }

    try {
      await this.resetCursorsForPrivacyBoundary();
      await this.observerCoordinator.start();
      this.state = "ready";
      this.skipBackfillOnNextStart = false;
      this.logger?.info("Trajectory capture runtime module started successfully", {
        adaptersCount: this.adapters.length,
        decodersCount: this.decoders.length,
      });
    } catch (err) {
      this.state = "failed";
      this.logger?.error("Failed to start trajectory capture runtime module", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async stop(context?: ModuleContext): Promise<void> {
    if (this.state === "stopping" || this.state === "stopped") {
      return;
    }
    this.state = "stopping";

    try {
      if (this.unsubscribeRecords) {
        this.unsubscribeRecords();
        this.unsubscribeRecords = undefined;
      }
      if (
        "waitForIdle" in this.captureCoordinator &&
        this.captureCoordinator.waitForIdle instanceof Function
      ) {
        await this.captureCoordinator.waitForIdle();
      }
      await this.observerCoordinator.stop();
      if (this.ownsObserverCoordinator) {
        this.observerCoordinatorNeedsRebuild = true;
      }
      this.state = "stopped";
      this.logger?.info("Trajectory capture runtime module stopped");
    } catch (err) {
      this.state = "failed";
      this.logger?.error("Error stopping trajectory capture runtime module", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
      message: `Trajectory capture module is ${this.state}`,
      details: {
        state: this.state,
        telemetryEnabled: this.telemetryEnabled,
        tailingActive: this.telemetryEnabled && this.state === "ready",
        adaptersCount: this.observerCoordinator.getAdapters().length,
        activeSessions: this.captureCoordinator.getActiveSessionCount(),
        finalizedSessions: this.captureCoordinator.getFinalizedSessionCount(),
        unattributedSessions: this.captureCoordinator.getUnattributedSessionCount(),
      },
      lastCheckTime: Date.now(),
    };
  }

  async getDiagnostics(): Promise<JsonObject> {
    return {
      id: this.id,
      state: this.state,
      telemetryEnabled: this.telemetryEnabled,
      privacyCutoffMs: this.privacyCutoffMs,
      privacyCheckpointHealthy: this.privacyCheckpointHealthy,
      remoteConsentCutoffMs: this.remoteConsentCutoffMs,
      remoteConsent: this.remoteTelemetryConsent,
      remoteConsentHistoryAvailable: this.remoteConsentHistoryAvailable,
      adapters: this.observerCoordinator.getAdapters().map((a) => ({ id: a.id, name: a.name })),
      activeSessions: this.captureCoordinator.getActiveSessionCount(),
      finalizedSessions: this.captureCoordinator.getFinalizedSessionCount(),
      unattributedSessions: this.captureCoordinator.getUnattributedSessionCount(),
    };
  }

  getObserverCoordinator(): ObserverCoordinator {
    return this.observerCoordinator;
  }

  getNormalizationPipeline(): NormalizationPipeline {
    return this.normalizationPipeline;
  }

  getCaptureCoordinator(): TrajectoryCaptureCoordinator {
    return this.captureCoordinator;
  }

  getAdapters(): HarnessAdapter[] {
    return [...this.adapters];
  }

  getDecoders(): HarnessRecordDecoder[] {
    return [...this.decoders];
  }

  getObservationClient(): CloudObservationClient {
    return this.getEffectiveObservationClient();
  }

  getCursorManager(): SourceCursorManager {
    return this.observerCoordinator.getTailer().getCursorManager();
  }
}
