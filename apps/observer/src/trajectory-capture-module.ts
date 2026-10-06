import fs from "node:fs";
import path from "node:path";
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
  CloudUploadStatusRecorder,
  type TrajectoryAttributionContext,
  TrajectoryAttributionContextSchema,
  type TrajectoryAttributionResolverFn,
  TrajectoryCaptureCoordinator,
} from "./analytics/index.js";
import { FilePrivateValueStore } from "./analytics/private-value-store.js";
import { WorkflowCallRecorder } from "./analytics/workflow-call-recorder.js";
import { AuthRecoveryError } from "./auth-recovery.js";
import { CloudObservationClient, type CloudRuntimeModule } from "./cloud-runtime.js";
import { HARNESS_DEFINITIONS } from "./harness-registry.js";
import {
  type HarnessVersionResolver,
  HarnessVersionStatsRecorder,
  createInstalledVersionResolver,
} from "./harness-version-stats.js";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import { NormalizationPipeline } from "./normalization/pipeline.js";
import type { JsonObject } from "./normalization/redaction.js";
import { ensurePrivateDirectorySync } from "./private-fs.js";
import { consumeSignOutBoundary, readSignOutBoundary } from "./sign-out-boundary.js";
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

export const TelemetryPrivacyCheckpointSchema = z.discriminatedUnion("version", [
  LegacyTelemetryPrivacyCheckpointSchema,
  CurrentTelemetryPrivacyCheckpointSchema,
]);

export type TelemetryPrivacyCheckpoint = z.infer<typeof TelemetryPrivacyCheckpointSchema>;

export interface ReconcileRemoteTelemetryConsentResult {
  valid: boolean;
  changed: boolean;
  cutoffAdvanced: boolean;
}

/**
 * Longest downtime a restarted daemon catches up. Sessions that finished while the daemon was
 * down (restart, update, closed `resin connect`) are captured on the next start only when their
 * activity is after the capture watermark and within this window; anything older stays history.
 */
export const MAX_DOWNTIME_CATCH_UP_MS = 24 * 60 * 60 * 1000;

/** How often a running capture refreshes its watermark, bounding what a crash can lose. */
export const CAPTURE_WATERMARK_HEARTBEAT_MS = 60_000;

/** The capture watermark's file name in the daemon state directory. */
export const CAPTURE_WATERMARK_FILE_NAME = "capture-watermark.json";

/** Backoff bounds for re-checking consent while deliveries wait for it to become verifiable. */
const CONSENT_RECOVERY_INITIAL_DELAY_MS = 1_000;
const CONSENT_RECOVERY_MAX_DELAY_MS = 60_000;

/**
 * Owner-only record of the last instant capture was running with consent. `ownerWorkspaceId`
 * pins it to the paired workspace so a re-pair never inherits the previous pairing's window.
 */
export const CaptureWatermarkSchema = z
  .object({
    version: z.literal(1),
    lastRunningAtMs: z.number().int().nonnegative(),
    ownerWorkspaceId: z.string().nullable(),
  })
  .strict();

export type CaptureWatermark = z.infer<typeof CaptureWatermarkSchema>;

/**
 * The instant a restarted capture may observe from, or undefined for today's behavior (observe
 * from now). Never earlier than the watermark, the maximum window or the consent floor (the
 * persisted privacy cutoff, which is at or after the last consent change).
 */
export function resolveDowntimeCatchUpFrom(input: {
  nowMs: number;
  watermarkMs: number | undefined;
  consentFloorMs: number;
  maxWindowMs: number;
}): number | undefined {
  const { nowMs, watermarkMs, consentFloorMs, maxWindowMs } = input;
  if (watermarkMs === undefined || !Number.isFinite(watermarkMs) || watermarkMs > nowMs) {
    return undefined;
  }
  const from = Math.max(watermarkMs, nowMs - Math.max(0, maxWindowMs), consentFloorMs);
  return from < nowMs ? from : undefined;
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

/** How long start() waits for the first discovery scan; well inside the supervisor's 5 s. */
const INITIAL_SCAN_WAIT_MS = 3_000;

/** Sessions of `file-activity` harnesses are backfilled whole and captured by transcript activity. */
function capturesByFileActivity(session: HarnessSession): boolean {
  return HARNESS_DEFINITIONS.some(
    (definition) =>
      definition.id === session.harnessId && definition.sessionCapture === "file-activity",
  );
}

function sessionStartedDuringObservation(
  session: HarnessSession,
  startedAt: number | undefined,
): boolean {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return false;
  const createdAt = Date.parse(session.createdAt);
  const updatedAt = Date.parse(session.updatedAt);
  const now = Date.now();
  return createdAt >= startedAt && createdAt <= updatedAt && updatedAt <= now;
}

function captureInactiveSession(session: HarnessSession, startedAt: number): boolean {
  if (!capturesByFileActivity(session)) {
    return sessionStartedDuringObservation(session, startedAt);
  }
  if (typeof session.metadata?.fileMtime !== "string") {
    return false;
  }
  // Require actual file activity as well as the coordinator's transcript timestamp boundary.
  // Neither touching an old transcript nor future-dated content grants historical capture.
  const modifiedAt = Date.parse(session.metadata.fileMtime);
  return modifiedAt >= startedAt && modifiedAt <= Date.now();
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
   * Paired cloud workspace that owns private workflow values across local project identities.
   */
  privateValueOwnerWorkspaceId?: string;

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
   * Cloud consent could not be verified at construction (signed out, auth or network failure).
   * Capture stays off without recording a withdrawal: the persisted checkpoint and the capture
   * watermark are kept, so the next start with verified consent catches up the downtime.
   */
  telemetryConsentUnknown?: boolean;

  /**
   * Refreshes authoritative account consent before processing and before every cloud request.
   * `null`/`undefined` (or a throw) means consent is currently unknown: deliveries are deferred
   * with an `AuthRecoveryError` until it can be verified again, never dropped.
   */
  refreshRemoteTelemetryConsent?: () => Promise<RemoteTelemetryConsentSnapshot | null | undefined>;

  /**
   * Workspace of the credentials behind the most recent verified consent snapshot. Read right
   * after every verification: deliveries deferred while consent was unverifiable belong to the
   * workspace capture was bound to, and are discarded (never uploaded) when the verified
   * credentials belong to another workspace. Without it the bound workspace is never checked.
   */
  getVerifiedWorkspaceId?: () => string | null | undefined;

  /**
   * The `resin logout` marker (`SIGN_OUT_BOUNDARY_FILE_NAME` in the state directory). While it
   * exists, every verified consent snapshot moves the privacy cutoff to the verification time;
   * the first verification that started after the marker was written (credentials saved by a
   * later `resin login`) consumes it.
   */
  signOutBoundaryPath?: string;

  /**
   * What `signOutBoundaryPath` held before `remoteTelemetryConsent` was read. When it is
   * unchanged at construction, that verified read started after the logout, so construction
   * consumes the marker; otherwise the next verification does.
   */
  signOutBoundaryAtConsentRead?: string | null;

  /**
   * Owner-only checkpoint recording the latest privacy boundary across daemon restarts.
   */
  privacyCheckpointPath?: string;

  /**
   * Owner-only record of the last capture upload the cloud accepted, kept across restarts.
   * In-memory only when omitted.
   */
  uploadStatusPath?: string;

  /**
   * Owner-only capture watermark: refreshed while capture runs and on clean shutdown, read on
   * construction so the next start catches up sessions that finished during the downtime. With
   * no path (or no watermark yet) capture observes from start only.
   */
  captureWatermarkPath?: string;

  /** Overrides `MAX_DOWNTIME_CATCH_UP_MS`, the longest downtime that is caught up. */
  maxDowntimeCatchUpMs?: number;

  /**
   * Injectable clock for deterministic privacy-boundary tests.
   */
  now?: () => number;

  /**
   * Optional logger.
   */
  logger?: Logger;
  /**
   * If true (default), agent sessions that name no parent session are not attached. Subagent and
   * child sessions that carry `metadata.parentSessionId` are user work and are always captured.
   */
  captureUserSessionsOnly?: boolean;
  /**
   * Resolves the harness version a session ran under when its adapter reports none. Defaults to
   * probing the installed harness. Per-harness-version decode stats are only kept when the module
   * has a state store.
   */
  resolveHarnessVersion?: HarnessVersionResolver;
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
  /** The first discovery scan; start() waits for it only briefly, stop() waits for it fully. */
  private initialScan: Promise<void> = Promise.resolve();

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
  private readonly captureWatermarkPath?: string;
  private readonly privateValueOwnerWorkspaceId: string | null;
  private readonly getVerifiedWorkspaceIdFn?: () => string | null | undefined;
  /** The workspace whose verified consent deferred deliveries wait for. */
  private consentWorkspaceId: string | null;
  private readonly signOutBoundaryPath?: string;
  /** Downtime catch-up boundary for the first start only; cleared once used or on consent change. */
  private pendingCatchUpFromMs?: number;
  private watermarkHeartbeat?: NodeJS.Timeout;
  private readonly now: () => number;
  private privacyCutoffMs: number;
  private remoteConsentCutoffMs: number;
  private remoteTelemetryConsent: RemoteTelemetryConsentSnapshot | null;
  private remoteConsentHistoryAvailable: boolean;
  private remoteConsentAuthorizationQueue: Promise<void> = Promise.resolve();
  private privacyCheckpointHealthy: boolean;
  private skipBackfillOnNextStart = false;
  /**
   * Cloud consent cannot currently be verified (signed out, auth or network failure). Capture is
   * suspended — not withdrawn — and the watermark is left where verified capture last ran.
   */
  private consentUnverified = false;
  /** Deferred deliveries waiting for consent to become verifiable again. */
  private readonly consentRecoveryListeners = new Set<() => void>();
  private consentRecoveryTimer?: NodeJS.Timeout;
  private consentRecoveryDelayMs = CONSENT_RECOVERY_INITIAL_DELAY_MS;
  private logger?: Logger;
  private readonly captureUserSessionsOnly: boolean;
  private readonly decodeStats?: HarnessVersionStatsRecorder;
  private readonly resolveHarnessVersion?: HarnessVersionResolver;
  private readonly uploadStatus: CloudUploadStatusRecorder;

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
    this.uploadStatus = new CloudUploadStatusRecorder({
      filePath: options.uploadStatusPath,
      now: options.now,
    });
    this.captureUserSessionsOnly = options.captureUserSessionsOnly ?? true;
    this.now = options.now ?? Date.now;
    const requestedTelemetryEnabled =
      options.telemetryEnabled === undefined ? true : options.telemetryEnabled === true;
    const consentUnknown = options.telemetryConsentUnknown === true && !requestedTelemetryEnabled;
    const persistedCheckpoint = this.readPersistedPrivacyCheckpoint();
    this.remoteConsentCutoffMs =
      persistedCheckpoint?.version === 2 ? persistedCheckpoint.remoteConsentCutoffMs : 0;
    this.remoteTelemetryConsent =
      persistedCheckpoint?.version === 2 ? persistedCheckpoint.remoteConsent : null;
    this.remoteConsentHistoryAvailable =
      !this.remoteConsentRequired ||
      (persistedCheckpoint?.version === 2 && persistedCheckpoint.remoteHistoryAvailable);
    this.captureWatermarkPath = options.captureWatermarkPath;
    this.privateValueOwnerWorkspaceId = options.privateValueOwnerWorkspaceId ?? null;
    this.getVerifiedWorkspaceIdFn = options.getVerifiedWorkspaceId;
    this.consentWorkspaceId = this.privateValueOwnerWorkspaceId;
    this.signOutBoundaryPath = options.signOutBoundaryPath;
    // Only a run that ended with consent may extend capture into the downtime after it.
    const watermark =
      requestedTelemetryEnabled && persistedCheckpoint?.telemetryEnabled === true
        ? this.readCaptureWatermark()
        : undefined;
    const catchUpFromMs = resolveDowntimeCatchUpFrom({
      nowMs: this.now(),
      watermarkMs:
        watermark?.ownerWorkspaceId === this.privateValueOwnerWorkspaceId
          ? watermark.lastRunningAtMs
          : undefined,
      consentFloorMs: Math.max(persistedCheckpoint?.cutoffMs ?? 0, this.remoteConsentCutoffMs),
      maxWindowMs: options.maxDowntimeCatchUpMs ?? MAX_DOWNTIME_CATCH_UP_MS,
    });
    this.privacyCutoffMs = Math.max(
      persistedCheckpoint?.cutoffMs ?? 0,
      this.remoteConsentCutoffMs,
      catchUpFromMs ?? this.now(),
    );
    if (options.remoteTelemetryConsent) {
      this.reconcileRemoteTelemetryConsent(options.remoteTelemetryConsent);
      // Signed in after a `resin logout`: capture starts now and never reaches into the window.
      const signOutBoundary = this.signOutBoundaryPath
        ? readSignOutBoundary(this.signOutBoundaryPath)
        : null;
      if (this.signOutBoundaryPath && signOutBoundary !== null) {
        this.advanceRemoteConsentCutoff(this.now());
        if (signOutBoundary === options.signOutBoundaryAtConsentRead) {
          consumeSignOutBoundary(this.signOutBoundaryPath, signOutBoundary);
        }
      }
    }
    // A consent change advances the privacy cutoff; the catch-up never reaches behind it.
    if (catchUpFromMs !== undefined && this.privacyCutoffMs < this.now()) {
      this.pendingCatchUpFromMs = this.privacyCutoffMs;
    }
    if (consentUnknown) {
      // Unknown consent is not a withdrawal: the persisted boundary and the watermark stay as
      // they are, so the next start with verified consent catches up this downtime.
      this.privacyCheckpointHealthy = true;
      this.telemetryEnabled = false;
      this.markConsentUnverified();
    } else {
      this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(requestedTelemetryEnabled);
      this.telemetryEnabled = requestedTelemetryEnabled && this.privacyCheckpointHealthy;
    }
    if (!this.telemetryEnabled) {
      this.pendingCatchUpFromMs = undefined;
    }

    // 1. Decoders and Normalization Pipeline
    this.decoders =
      options.decoders ?? HARNESS_DEFINITIONS.map((definition) => definition.createDecoder());

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

    // Tests with no store and no injected resolver must not probe real installed harnesses.
    const resolveHarnessVersion =
      dbConnection || options.resolveHarnessVersion
        ? (options.resolveHarnessVersion ??
          createInstalledVersionResolver({ definitions: HARNESS_DEFINITIONS }))
        : undefined;
    this.resolveHarnessVersion = resolveHarnessVersion;
    if (dbConnection && resolveHarnessVersion) {
      this.decodeStats = new HarnessVersionStatsRecorder({
        conn: dbConnection,
        resolveVersion: resolveHarnessVersion,
        logger: this.logger,
      });
    }

    this.normalizationPipeline =
      options.normalizationPipeline ??
      new NormalizationPipeline({
        sessionRepository,
        syncRepository,
        dbConnection,
        // The daemon's shared store: redaction placeholders stay recoverable locally so
        // recorded workflows can resolve private values on this machine at execution.
        privateValueStore: FilePrivateValueStore.default(),
      });
    for (const decoder of this.decoders) {
      this.normalizationPipeline.registerDecoder(decoder);
    }

    // 2. Adapters and Observer Coordinator
    this.adapters =
      options.adapters ?? HARNESS_DEFINITIONS.map((definition) => definition.createAdapter());

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
        defaultMaxInFlightBatches: 100,
        defaultBackfillPolicy: { mode: "latest" },
        backfillPolicyForSession: (session: HarnessSession, startedAt?: number) =>
          capturesByFileActivity(session) || sessionStartedDuringObservation(session, startedAt)
            ? { mode: "all" }
            : undefined,
        captureInactiveSessions: captureInactiveSession,
        captureUserSessionsOnly: this.captureUserSessionsOnly,
        logger: this.logger,
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
        privateValueStore: FilePrivateValueStore.default(),
        logger: this.logger,
        isTelemetryEnabled: () => this.telemetryEnabled,
        authorizeTelemetryEmission,
        minimumRecordTimestampMs: this.privacyCutoffMs,
        resolveHarnessVersion: this.resolveHarnessVersion,
        // A session runs in its workspace's root unless a call names another directory; only the
        // keyed identity of the resulting directory is uploaded.
        resolveSessionWorkingDirectory: (session) => {
          const coordinator = this.observerCoordinator;
          return typeof coordinator.workspaceRootPath === "function"
            ? coordinator.workspaceRootPath(session.workspaceId)
            : undefined;
        },
        uploadStatus: this.uploadStatus,
        onPipelineResults: this.decodeStats
          ? (session, results) => this.decodeStats?.record(session, results)
          : undefined,
        workflowCallRecorder: new WorkflowCallRecorder({
          privateValueOwnerWorkspaceId: options.privateValueOwnerWorkspaceId,
        }),
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
      this.unsubscribeRecords = this.subscribeCapture();
    }
  }

  /**
   * Wires tailer deliveries into the capture coordinator. A terminal drain waits for every
   * delivered batch to be acknowledged, so it also asks the coordinator to send the ending
   * session's coalesced batch now rather than at the end of its upload window.
   */
  private subscribeCapture(): () => void {
    const unsubscribeRecords = this.observerCoordinator.onRecords(
      this.captureCoordinator.handleRecords,
    );
    const tailer =
      "getTailer" in this.observerCoordinator &&
      this.observerCoordinator.getTailer instanceof Function
        ? this.observerCoordinator.getTailer()
        : undefined;
    const captureCoordinator = this.captureCoordinator;
    if (
      !tailer ||
      !("expediteFlush" in captureCoordinator) ||
      !(captureCoordinator.expediteFlush instanceof Function)
    ) {
      return unsubscribeRecords;
    }
    const onDraining = (event: { sessionId: string }) => {
      captureCoordinator.expediteFlush(event.sessionId);
    };
    tailer.on("session:draining", onDraining);
    return () => {
      unsubscribeRecords();
      tailer.off("session:draining", onDraining);
    };
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
      ensurePrivateDirectorySync(path.dirname(this.privacyCheckpointPath));
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

  private readCaptureWatermark(): CaptureWatermark | undefined {
    if (!this.captureWatermarkPath) {
      return undefined;
    }
    try {
      const stats = fs.statSync(this.captureWatermarkPath);
      if (!stats.isFile() || stats.size > 4 * 1024) {
        throw new Error("invalid capture watermark file");
      }
      return CaptureWatermarkSchema.parse(
        JSON.parse(fs.readFileSync(this.captureWatermarkPath, "utf8")),
      );
    } catch (error) {
      const errorCode =
        error instanceof Error && "code" in error && z.string().safeParse(error.code).success
          ? String(error.code)
          : undefined;
      if (errorCode !== "ENOENT") {
        this.logger?.warn("Capture watermark was unreadable; downtime sessions are not caught up");
      }
      return undefined;
    }
  }

  /**
   * Records that capture is running now. Best effort: a missed write only shortens catch-up.
   * Only the start of a capture run creates the file; later refreshes (heartbeat, clean stop)
   * update an existing one, so a watermark removed underneath a running daemon (`resin logout`)
   * stays removed and the signed-out window is never caught up.
   */
  private writeCaptureWatermark(options: { create: boolean }): void {
    if (!this.captureWatermarkPath) {
      return;
    }
    if (!options.create && !fs.existsSync(this.captureWatermarkPath)) {
      return;
    }
    const temporaryPath = `${this.captureWatermarkPath}.${process.pid}.tmp`;
    const watermark: CaptureWatermark = {
      version: 1,
      lastRunningAtMs: Math.max(0, Math.trunc(this.now())),
      ownerWorkspaceId: this.privateValueOwnerWorkspaceId,
    };
    try {
      ensurePrivateDirectorySync(path.dirname(this.captureWatermarkPath));
      fs.writeFileSync(temporaryPath, `${JSON.stringify(watermark)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.captureWatermarkPath);
    } catch {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
      this.logger?.warn("Unable to persist the capture watermark");
    }
  }

  /** Forgets the watermark so the next start observes from start only (consent withdrawn). */
  private clearCaptureWatermark(): void {
    if (!this.captureWatermarkPath) {
      return;
    }
    try {
      fs.rmSync(this.captureWatermarkPath, { force: true });
    } catch {
      this.logger?.warn("Unable to remove the capture watermark");
    }
  }

  private startWatermarkHeartbeat(): void {
    this.stopWatermarkHeartbeat();
    this.writeCaptureWatermark({ create: true });
    this.watermarkHeartbeat = setInterval(() => {
      // While consent is unverifiable the watermark stays where verified capture last ran.
      if (this.telemetryEnabled && this.state === "ready" && !this.consentUnverified) {
        this.writeCaptureWatermark({ create: false });
      }
    }, CAPTURE_WATERMARK_HEARTBEAT_MS);
    this.watermarkHeartbeat.unref();
  }

  private stopWatermarkHeartbeat(): void {
    clearInterval(this.watermarkHeartbeat);
    this.watermarkHeartbeat = undefined;
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
      if (previousHistoryAvailable) {
        this.logger?.warn("telemetry paused until consent is re-verified");
      }
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
      if (previousHistoryAvailable) {
        this.logger?.warn("telemetry paused until consent is re-verified");
      }
      return {
        valid: false,
        changed: previousHistoryAvailable || cutoffAdvanced,
        cutoffAdvanced,
      };
    }

    if (!this.remoteConsentHistoryAvailable) {
      if (
        nextUpdatedAtMs <= previousUpdatedAtMs &&
        nextConsent.metadataTelemetryEnabled === previousConsent.metadataTelemetryEnabled
      ) {
        cutoffAdvanced = this.advanceRemoteConsentCutoff(this.now());
        this.remoteConsentHistoryAvailable = true;
        this.remoteTelemetryConsent = nextConsent;
        this.logger?.info("telemetry resumed after consent is re-verified");
        return { valid: true, changed: true, cutoffAdvanced };
      }
      if (nextUpdatedAtMs <= previousUpdatedAtMs) {
        return { valid: false, changed: false, cutoffAdvanced: false };
      }
      cutoffAdvanced = this.advanceRemoteConsentCutoff(Math.max(this.now(), nextUpdatedAtMs));
      this.remoteConsentHistoryAvailable = true;
      this.logger?.info("telemetry resumed after consent is re-verified");
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
    const signOutBoundaryBefore = this.signOutBoundaryPath
      ? readSignOutBoundary(this.signOutBoundaryPath)
      : null;
    let snapshot: RemoteTelemetryConsentSnapshot | null;
    try {
      snapshot = (await this.refreshRemoteTelemetryConsentFn()) ?? null;
    } catch {
      snapshot = null;
    }
    if (!snapshot) {
      // Unknown is not withdrawn: the delivery is deferred durably until consent is verifiable.
      this.markConsentUnverified();
      throw new AuthRecoveryError("REFRESH_UNAVAILABLE", {
        message:
          "Resin Cloud telemetry consent cannot be verified; observations remain queued locally until it can (run `resin login` if this device is signed out).",
        subscribeToRecovery: (listener) => this.onConsentVerifiable(listener),
      });
    }
    const checkpointHealthy = this.crossVerifiedIdentityBoundary(signOutBoundaryBefore);
    this.markConsentVerified();
    if (!checkpointHealthy) {
      return false;
    }

    const reconciliation = this.reconcileRemoteTelemetryConsent(snapshot);
    if (reconciliation.cutoffAdvanced) {
      this.captureCoordinator.setPrivacyCutoff(this.privacyCutoffMs);
    }
    if (reconciliation.changed) {
      this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(this.telemetryEnabled);
      if (!this.privacyCheckpointHealthy) {
        this.closeCaptureOnCheckpointFailure();
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

  /** Closes both capture gates because the privacy checkpoint could not be persisted. */
  private closeCaptureOnCheckpointFailure(): void {
    this.telemetryEnabled = false;
    this.captureCoordinator.setTelemetryEnabled(false);
    if (this.unsubscribeRecords) {
      this.unsubscribeRecords();
      this.unsubscribeRecords = undefined;
    }
  }

  /**
   * Moves the privacy cutoff to now so nothing observed so far can leave the device: the
   * coordinator drops its buffered batches, every delivery deferred while consent was
   * unverifiable (in memory or in `auth-pending/`) is discarded when it is redelivered, the
   * watermark goes so no restart catches up behind it, and the checkpoint keeps the cutoff across
   * restarts. Returns whether the checkpoint was persisted; when it was not, capture is closed.
   */
  private withdrawObservedSoFar(): boolean {
    this.advanceRemoteConsentCutoff(this.now());
    this.captureCoordinator.setPrivacyCutoff(this.privacyCutoffMs);
    this.pendingCatchUpFromMs = undefined;
    this.clearCaptureWatermark();
    this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(this.telemetryEnabled);
    if (!this.privacyCheckpointHealthy) {
      this.closeCaptureOnCheckpointFailure();
    }
    return this.privacyCheckpointHealthy;
  }

  /**
   * Runs on every verified consent snapshot, before deferred deliveries resume. A `resin logout`
   * since capture last verified consent, or verified credentials for a different workspace than
   * the one deferred deliveries wait for, is a hard boundary ({@link withdrawObservedSoFar}). The
   * logout marker is consumed only when it is unchanged since before this verification started:
   * only then were the verifying credentials saved after the logout. Returns false when the
   * boundary could not be persisted (capture is then closed).
   */
  private crossVerifiedIdentityBoundary(signOutBoundaryBefore: string | null): boolean {
    const signOutBoundary = this.signOutBoundaryPath
      ? readSignOutBoundary(this.signOutBoundaryPath)
      : null;
    const workspaceId = this.getVerifiedWorkspaceIdFn
      ? (this.getVerifiedWorkspaceIdFn() ?? null)
      : this.consentWorkspaceId;
    if (signOutBoundary === null && workspaceId === this.consentWorkspaceId) {
      return true;
    }
    this.logger?.info(
      signOutBoundary === null
        ? "Verified credentials belong to a different workspace; nothing observed before is uploaded"
        : "Verified credentials after `resin logout`; nothing observed while signed out is uploaded",
    );
    this.consentWorkspaceId = workspaceId;
    if (!this.withdrawObservedSoFar()) {
      return false;
    }
    if (
      this.signOutBoundaryPath &&
      signOutBoundary !== null &&
      signOutBoundary === signOutBoundaryBefore
    ) {
      consumeSignOutBoundary(this.signOutBoundaryPath, signOutBoundary);
    }
    return true;
  }

  /**
   * `resin logout` reached this daemon: a hard privacy boundary in every daemon mode. Everything
   * observed so far is withdrawn from upload ({@link withdrawObservedSoFar}) and the tailer
   * redelivers its auth-deferred batches now, so they are discarded instead of waiting for a
   * login. Capture keeps deferring while signed out; the logout's durable marker then moves the
   * cutoff past the whole signed-out window at the next verification. Returns whether the
   * boundary was persisted.
   */
  applySignOutBoundary(): boolean {
    const persisted = this.withdrawObservedSoFar();
    if (
      "getTailer" in this.observerCoordinator &&
      this.observerCoordinator.getTailer instanceof Function
    ) {
      this.observerCoordinator.getTailer().redeliverAuthDeferred();
    }
    this.logger?.info(
      "Applied the `resin logout` privacy boundary; nothing observed so far will be uploaded",
    );
    return persisted;
  }

  /** Logs (once) and records that capture is suspended until consent can be verified. */
  private markConsentUnverified(): void {
    if (this.consentUnverified) {
      return;
    }
    this.consentUnverified = true;
    this.consentRecoveryDelayMs = CONSENT_RECOVERY_INITIAL_DELAY_MS;
    this.logger?.info(
      "Trajectory capture is paused until Resin Cloud consent can be verified; run `resin login` if this device is signed out",
    );
  }

  /** Consent is verifiable again: deferred deliveries resume and are re-authorized normally. */
  private markConsentVerified(): void {
    if (this.consentUnverified) {
      this.consentUnverified = false;
      this.logger?.info(
        "Resin Cloud consent is verifiable again; paused trajectory capture resumes",
      );
    }
    this.clearConsentRecoveryTimer();
    const listeners = [...this.consentRecoveryListeners];
    this.consentRecoveryListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }

  private onConsentVerifiable(listener: () => void): () => void {
    this.consentRecoveryListeners.add(listener);
    this.scheduleConsentRecoveryPoll();
    return () => {
      this.consentRecoveryListeners.delete(listener);
      if (this.consentRecoveryListeners.size === 0) {
        this.clearConsentRecoveryTimer();
      }
    };
  }

  /** Re-checks consent on a capped backoff while any deferred delivery waits for it. */
  private scheduleConsentRecoveryPoll(): void {
    if (this.consentRecoveryTimer || this.consentRecoveryListeners.size === 0) {
      return;
    }
    const delayMs = this.consentRecoveryDelayMs;
    this.consentRecoveryDelayMs = Math.min(CONSENT_RECOVERY_MAX_DELAY_MS, delayMs * 2);
    this.consentRecoveryTimer = setTimeout(() => {
      void this.pollConsentRecovery();
    }, delayMs);
    this.consentRecoveryTimer.unref();
  }

  private async pollConsentRecovery(): Promise<void> {
    const signOutBoundaryBefore = this.signOutBoundaryPath
      ? readSignOutBoundary(this.signOutBoundaryPath)
      : null;
    let snapshot: RemoteTelemetryConsentSnapshot | null = null;
    try {
      snapshot = (await this.refreshRemoteTelemetryConsentFn?.()) ?? null;
    } catch {
      snapshot = null;
    }
    this.consentRecoveryTimer = undefined;
    if (snapshot) {
      // The boundary moves before deferred deliveries resume, so they are re-filtered against it.
      this.crossVerifiedIdentityBoundary(signOutBoundaryBefore);
      this.markConsentVerified();
    } else {
      this.scheduleConsentRecoveryPoll();
    }
  }

  private clearConsentRecoveryTimer(): void {
    clearTimeout(this.consentRecoveryTimer);
    this.consentRecoveryTimer = undefined;
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
   * Closes the capture gate because cloud consent cannot be verified right now (signed out, auth
   * or network failure). Unlike a withdrawal this records no privacy boundary: the persisted
   * checkpoint, its cutoff and the capture watermark stay, so the next start with verified
   * consent catches up the downtime (bounded by `MAX_DOWNTIME_CATCH_UP_MS` and the consent floor).
   */
  suspendUntilConsentVerified(): void {
    this.telemetryEnabled = false;
    this.captureCoordinator.setTelemetryEnabled(false);
    if (this.unsubscribeRecords) {
      this.unsubscribeRecords();
      this.unsubscribeRecords = undefined;
    }
    this.pendingCatchUpFromMs = undefined;
    this.stopWatermarkHeartbeat();
    this.markConsentUnverified();
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
      this.pendingCatchUpFromMs = undefined;
      this.stopWatermarkHeartbeat();
      this.clearCaptureWatermark();
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
    this.pendingCatchUpFromMs = undefined;
    this.skipBackfillOnNextStart = true;
    this.privacyCheckpointHealthy = this.persistPrivacyCheckpoint(true);
    if (!this.privacyCheckpointHealthy) {
      this.captureCoordinator.setTelemetryEnabled(false);
      return false;
    }

    this.telemetryEnabled = true;
    this.consentUnverified = false;
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
      defaultMaxInFlightBatches: 100,
      defaultBackfillPolicy: { mode: "latest" },
      backfillPolicyForSession: (session: HarnessSession, startedAt?: number) =>
        capturesByFileActivity(session) || sessionStartedDuringObservation(session, startedAt)
          ? { mode: "all" }
          : undefined,
      captureInactiveSessions: captureInactiveSession,
      captureUserSessionsOnly: this.captureUserSessionsOnly,
      logger: this.logger,
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
    this.decodeStats?.start();

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
      this.unsubscribeRecords = this.subscribeCapture();
    }

    try {
      await this.resetCursorsForPrivacyBoundary();
      // The first discovery scan walks every harness's transcript history: tens of seconds on a
      // machine with tens of thousands of transcripts. Start waits a bounded time so a normal
      // start still begins with sessions attached, then lets it finish in the background so
      // daemon readiness never waits on history size.
      // Only the first start after construction catches up the downtime since the watermark; a
      // privacy boundary crossed in this process (consent toggled) never does.
      const catchUpFromMs = this.skipBackfillOnNextStart ? undefined : this.pendingCatchUpFromMs;
      this.pendingCatchUpFromMs = undefined;
      if (catchUpFromMs !== undefined) {
        this.logger?.info("Catching up sessions that finished while capture was down", {
          catchUpFrom: new Date(catchUpFromMs).toISOString(),
        });
      }
      const scan = this.observerCoordinator.start({ catchUpFromMs });
      this.initialScan = scan.catch((err: unknown) => {
        this.logger?.error("Initial transcript discovery failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      let waitTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        scan,
        new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, INITIAL_SCAN_WAIT_MS);
          waitTimer.unref();
        }),
      ]).finally(() => clearTimeout(waitTimer));
      this.state = "ready";
      this.skipBackfillOnNextStart = false;
      // The watermark moves only once the catch-up scan has attached the downtime sessions, so a
      // crash during that scan still catches them up on the next start.
      void this.initialScan.then(() => {
        if (this.state === "ready" && this.telemetryEnabled) {
          this.startWatermarkHeartbeat();
        }
      });
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
    const wasCapturing = this.state === "ready" && this.telemetryEnabled;
    this.state = "stopping";
    this.stopWatermarkHeartbeat();
    this.consentRecoveryListeners.clear();
    this.clearConsentRecoveryTimer();

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
      await this.initialScan;
      await this.observerCoordinator.stop();
      // Clean shutdown: the next start catches up whatever finishes from here on. While consent
      // is unverifiable the watermark stays where verified capture last ran.
      if (wasCapturing && this.telemetryEnabled && !this.consentUnverified) {
        this.writeCaptureWatermark({ create: false });
      }
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
    } finally {
      // Shutdown (SIGTERM/SIGINT or IPC) always persists pending placeholder aliases.
      FilePrivateValueStore.default().flush();
      await this.decodeStats?.stop();
      this.captureCoordinator.clearComputationEvidence();
      this.captureCoordinator.clearCommandSequenceEvidence();
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
        observationUpload: this.captureCoordinator.getBatchMetrics(),
        cloudUpload: this.uploadStatus.snapshot(),
        captureDeadLetters: this.captureDeadLetters(),
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
      observationUpload: this.captureCoordinator.getBatchMetrics(),
      cloudUpload: this.uploadStatus.snapshot(),
      captureDeadLetters: this.captureDeadLetters(),
    };
  }

  /** Delivered batches the capture handler failed: their records were dead-lettered, not captured. */
  private captureDeadLetters(): { batches: number; records: number } {
    const diagnostics =
      "getDiagnostics" in this.observerCoordinator &&
      this.observerCoordinator.getDiagnostics instanceof Function
        ? this.observerCoordinator.getDiagnostics()
        : undefined;
    return {
      batches: diagnostics?.deadLetteredBatches ?? 0,
      records: diagnostics?.deadLetteredRecords ?? 0,
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
