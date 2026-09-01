export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { type DaemonHealthReport, IpcClient } from "@resin/observer";
import { z } from "zod";
import {
  type AssetDownloadOptions,
  type DownloadedAssetResult,
  type VersionInstallOptions,
  type VersionInstallResult,
  type VersionSwitchOptions,
  type VersionSwitchResult,
  downloadAndVerifyAsset,
  getActiveVersion,
  installReleaseVersion,
  switchActiveVersion,
} from "../installer/asset-downloader.js";
import { compareSemver } from "../installer/channel-verifier.js";
import {
  type ResolveProductionReleaseOptions,
  type ResolvedProductionRelease,
  resolveProductionRelease,
} from "../installer/release-client.js";
import { type PlatformInfo, resolvePlatformPaths } from "../platform/index.js";
import { detectPlatform, validatePlatform } from "../platform/platform.js";
import {
  type ServiceStatusInfo,
  type UserServiceManager,
  createUserServiceManager,
  isStaleSupervisorUnitContent,
} from "../service/manager.js";
import { RecoveryStateTracker, sanitizeCrashDiagnostic } from "../service/recovery-state.js";
import {
  type VerificationCheckResult,
  type VerificationReport,
  runVerificationSuite,
} from "../service/verification.js";
import {
  type PolicyValue,
  type UpdateChannel,
  type UpdatePolicy,
  type UpdatePolicyPatch,
  isUpdateChannel,
  mergeUpdatePolicy,
} from "./policy.js";
import {
  type AcquireUpdateLockOptions,
  type UpdateLock,
  UpdateLockUnavailableError,
  acquireUpdateLock,
  resolveUpdateLockPath,
} from "./update-lock.js";

export const UPDATE_STATUS_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_UPDATE_PROBATION_MS = 15_000;
export const DEFAULT_UPDATE_HEALTH_PROBE_INTERVAL_MS = 1_000;
export const UPDATE_JOURNAL_FILE_NAME = "journal.json";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UPDATE_DRAIN_TIMEOUT_MS = 30_000;
const REINSTALL_RECOVERY_FILE_NAME = "reinstall-recovery.json";
const TRUSTED_RELEASES_DIRECTORY_NAME = "trusted-releases";
const EXACT_RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type UpdateRunMode = "manual" | "background";

export type UpdateRunStatus =
  | "disabled"
  | "locked"
  | "offline"
  | "already-current"
  | "downgrade-blocked"
  | "quarantined"
  | "activation-deferred"
  | "activated"
  | "rolled-back"
  | "failed";

export type UpdateDeferralReason = "active-sessions" | "session-activity-unavailable" | "offline";

export interface UpdateQuarantineEntry {
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly quarantinedAt: string;
  readonly reason: string;
}

export interface UpdateRollbackSnapshot {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly rolledBackAt: string;
  readonly reason: string;
}

/** Sanitized, local-only state intended for a future unified status command. */
export interface UpdateStatusSnapshot {
  readonly schemaVersion: typeof UPDATE_STATUS_SNAPSHOT_VERSION;
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly targetVersion: string | null;
  readonly pendingVersion: string | null;
  readonly lastCheckAt: string | null;
  readonly lastResult: UpdateRunStatus | null;
  readonly lastError: string | null;
  readonly lastRollback: UpdateRollbackSnapshot | null;
  readonly quarantine: UpdateQuarantineEntry[];
}

export interface UpdateSessionActivity {
  readonly state: "active" | "inactive" | "unknown";
  readonly activeCount?: number;
  readonly reason?: string;
}

export interface UpdateHealthProbeResult {
  readonly serviceActive: boolean;
  readonly ipcResponsive: boolean;
  readonly mcpResponsive: boolean;
  readonly recoveryBreakerTripped: boolean;
  readonly message?: string;
  /**
   * Identifies whether an unhealthy result came from the candidate or from the
   * local machinery used to observe it. Omitted results are candidate-attributable
   * for compatibility with injected probes.
   */
  readonly failureAttribution?: "candidate" | "infrastructure";
}

export interface UpdateHealthProbeContext {
  readonly targetVersion: string;
  readonly elapsedMs: number;
}

export interface UpdateEngineRunRequest {
  readonly mode?: UpdateRunMode;
  readonly channel?: UpdateChannel | string;
  readonly targetVersion?: string;
  readonly force?: boolean;
  readonly allowDowngrades?: boolean;
  readonly rollback?: boolean;
  readonly rollbackOnFailure?: boolean;
  readonly lockTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface UpdateEngineResult {
  readonly success: boolean;
  readonly mode: UpdateRunMode;
  readonly status: UpdateRunStatus;
  readonly channel: UpdateChannel;
  /** Version active when the operation started. */
  readonly currentVersion: string;
  /** Version active when the operation finished. */
  readonly activeVersion: string;
  readonly targetVersion?: string;
  readonly pendingVersion?: string;
  readonly staged: boolean;
  readonly activated: boolean;
  readonly healthGatePassed: boolean;
  readonly rolledBack?: boolean;
  readonly quarantined?: boolean;
  readonly deferralReason?: UpdateDeferralReason;
  readonly error?: string;
  readonly backupPath?: string;
  readonly verificationReport?: VerificationReport;
  readonly stepsCompleted: string[];
  readonly snapshot: UpdateStatusSnapshot;
}

type UpdateServiceManager = Pick<UserServiceManager, "start" | "stop" | "status"> &
  Partial<Pick<UserServiceManager, "install" | "getUnitDefinition" | "getUnitPath">>;
type UpdateLockHandle = Pick<UpdateLock, "release">;
type ReleaseResolver = (
  options: ResolveProductionReleaseOptions,
) => Promise<ResolvedProductionRelease>;
type AssetDownloader = (options: AssetDownloadOptions) => Promise<DownloadedAssetResult>;
type ReleaseInstaller = (options: VersionInstallOptions) => Promise<VersionInstallResult>;
type VersionSwitcher = (options: VersionSwitchOptions) => Promise<VersionSwitchResult>;

export interface UpdateEngineOptions {
  readonly homeDir?: string;
  readonly resinHome?: string;
  readonly configPath?: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly customFetch?: typeof fetch;
  readonly platformInfo?: PlatformInfo;
  readonly policy?: PolicyValue | undefined;
  readonly channelUrl?: string;
  readonly env?: Record<string, string | undefined>;
  readonly currentVersionFallback?: string;
  readonly lockOptions?: AcquireUpdateLockOptions;
  readonly acquireLock?: (options: AcquireUpdateLockOptions) => Promise<UpdateLockHandle>;
  readonly resolveRelease?: ReleaseResolver;
  readonly downloadAsset?: AssetDownloader;
  readonly installRelease?: ReleaseInstaller;
  readonly switchVersion?: VersionSwitcher;
  readonly readActiveVersion?: (resinHome: string) => string | null | Promise<string | null>;
  readonly removeVersion?: (versionDir: string) => Promise<void>;
  readonly serviceManager?: UpdateServiceManager;
  readonly sessionActivity?: () =>
    | boolean
    | UpdateSessionActivity
    | Promise<boolean | UpdateSessionActivity>;
  readonly healthProbe?: (
    context: UpdateHealthProbeContext,
  ) => UpdateHealthProbeResult | Promise<UpdateHealthProbeResult>;
  readonly probationMs?: number;
  readonly healthProbeIntervalMs?: number;
  readonly drainTimeoutMs?: number;
  readonly clock?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onSnapshot?: (snapshot: UpdateStatusSnapshot) => void | Promise<void>;
}

interface VersionMetadataState {
  readonly raw: string;
  readonly version: string;
  readonly previousVersion?: string;
}

interface VersionMetadataPayload {
  version: string;
  channel: UpdateChannel;
  previousVersion?: string;
  rolledBackAt?: string;
  upgradedAt?: string;
  provenance?: ResolvedProductionRelease["provenance"];
}

interface BackupState {
  readonly path: string;
  readonly versionPath: string;
  readonly versionBackupPath: string;
  readonly versionRaw: string;
  readonly configPath: string;
  readonly configHash: string | null;
  readonly configBackupPath?: string;
}

interface ActivationLease {
  readonly activity: UpdateSessionActivity;
  readonly serviceState: ServiceStatusInfo;
  readonly drainInitiated: boolean;
}

interface ReinstallRecoveryIntent {
  readonly schemaVersion: 1;
  readonly targetVersion: string;
  readonly candidateVersion: string;
  readonly rollbackVersion: string;
  readonly phase: "prepared" | "activated";
}

interface ReinstallSwapState {
  readonly targetVersion: string;
  readonly candidateVersion: string;
  readonly candidateDir: string;
  readonly rollbackVersion: string;
  promoted: boolean;
}

interface RollbackOutcome {
  readonly rolledBack: boolean;
  readonly activeVersion: string;
  readonly serviceStopped: boolean;
  readonly configConflict: boolean;
  readonly error?: Error;
}

interface ProbationResult {
  readonly passed: boolean;
  readonly report: VerificationReport;
  readonly message?: string;
  readonly failureAttribution?: "candidate" | "infrastructure";
}

class UpdateVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateVerificationError";
  }
}

class CandidateHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateHealthError";
  }
}

function normalizeVersion(version: string): string {
  return version.replace(/^v/, "").trim();
}

function normalizeExactVersion(version: string): string {
  const normalized = normalizeVersion(version);
  if (!EXACT_RELEASE_VERSION_PATTERN.test(normalized)) {
    throw new UpdateVerificationError(
      `Installed release version is not one safe exact SemVer segment: '${version}'.`,
    );
  }
  return normalized;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function combineErrors(errors: unknown[]): Error | undefined {
  const messages = errors.map(safeDiagnostic).filter(Boolean);
  return messages.length === 0 ? undefined : new Error(messages.join("; "));
}

function normalizeSha256(value: string): string {
  return value
    .replace(/^sha256:/i, "")
    .trim()
    .toLowerCase();
}

const SnapshotTextSchema = z.string().min(1).max(500);
const UpdateChannelSchema = z.enum(["stable", "beta", "nightly"]);
const UpdateRunStatusSchema = z.enum([
  "disabled",
  "locked",
  "offline",
  "already-current",
  "downgrade-blocked",
  "quarantined",
  "activation-deferred",
  "activated",
  "rolled-back",
  "failed",
]);
const UpdateQuarantineEntrySchema = z
  .object({
    version: SnapshotTextSchema,
    channel: UpdateChannelSchema,
    quarantinedAt: SnapshotTextSchema,
    reason: SnapshotTextSchema,
  })
  .strict();
const UpdateRollbackSnapshotSchema = z
  .object({
    fromVersion: SnapshotTextSchema,
    toVersion: SnapshotTextSchema,
    rolledBackAt: SnapshotTextSchema,
    reason: SnapshotTextSchema,
  })
  .strict();
const UpdateStatusSnapshotSchema = z.object({
  schemaVersion: z.literal(UPDATE_STATUS_SNAPSHOT_VERSION),
  channel: UpdateChannelSchema,
  currentVersion: SnapshotTextSchema,
  targetVersion: SnapshotTextSchema.nullable(),
  pendingVersion: SnapshotTextSchema.nullable(),
  lastCheckAt: SnapshotTextSchema.nullable(),
  lastResult: UpdateRunStatusSchema.nullable(),
  lastError: SnapshotTextSchema.nullable(),
  lastRollback: UpdateRollbackSnapshotSchema.nullable(),
  quarantine: z.array(UpdateQuarantineEntrySchema).max(64),
});
const UpdateConfigEnvelopeSchema = z
  .object({
    updates: z.custom<PolicyValue>().optional(),
  })
  .passthrough();
const VersionMetadataSchema = z
  .object({
    version: z.string().min(1).optional(),
    previousVersion: z.string().min(1).optional(),
  })
  .passthrough();
const InstalledReleaseMetadataSchema = z
  .object({
    version: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    provenance: z
      .object({
        version: z.string().min(1),
        channelSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        releaseAssetSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        signingKeyIds: z.array(z.string().min(1)).min(1),
      })
      .passthrough(),
  })
  .passthrough();
const TrustedInstalledReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    physicalVersion: z.string().min(1),
    channel: UpdateChannelSchema,
    treeSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    filePaths: z.array(z.string().min(1)).min(1),
    provenance: z
      .object({
        version: z.string().min(1),
        channelSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        releaseAssetSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        signingKeyIds: z.array(z.string().min(1)).min(1),
      })
      .passthrough(),
  })
  .strict();
const ReinstallRecoveryIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    targetVersion: z.string().min(1),
    candidateVersion: z.string().min(1),
    rollbackVersion: z.string().min(1),
    phase: z.enum(["prepared", "activated"]),
  })
  .strict();

function isNumberValue(cause: unknown): cause is number {
  return Object.prototype.toString.call(cause) === "[object Number]";
}

function isPositiveFiniteNumber(cause: unknown): cause is number {
  return isNumberValue(cause) && Number.isFinite(cause) && cause > 0;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function safeDiagnostic(cause: unknown): string {
  if (cause instanceof Error) {
    return sanitizeCrashDiagnostic(cause)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 500);
  }
  if (cause === null || cause === undefined) {
    return "";
  }
  if (cause instanceof Object && "message" in cause && String(cause.message) === cause.message) {
    return sanitizeCrashDiagnostic({ message: cause.message })
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 500);
  }
  return sanitizeCrashDiagnostic(String(cause))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500);
}
function hasErrorCode(cause: unknown, code: string): boolean {
  if (cause === null || cause === undefined || !(cause instanceof Object)) return false;
  if ("code" in cause && cause.code === code) return true;
  if (!("cause" in cause) || cause.cause === cause) return false;
  return hasErrorCode(cause.cause, code);
}

function hasErrorName(cause: unknown, name: string): boolean {
  if (cause === null || cause === undefined || !(cause instanceof Object)) return false;
  if ("name" in cause && cause.name === name) return true;
  if (!("cause" in cause) || cause.cause === cause) return false;
  return hasErrorName(cause.cause, name);
}

function isOfflineError(cause: unknown): boolean {
  if (
    [
      "ENETDOWN",
      "ENETUNREACH",
      "ECONNREFUSED",
      "ECONNRESET",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ETIMEDOUT",
    ].some((code) => hasErrorCode(cause, code))
  ) {
    return true;
  }
  const message = safeDiagnostic(cause).toLowerCase();
  return (
    /\b(?:offline|network unavailable|network error|fetch failed|dns|timed? ?out|connection refused)\b/.test(
      message,
    ) || hasErrorName(cause, "AbortError")
  );
}

function isVerificationError(cause: unknown): boolean {
  if (cause instanceof UpdateVerificationError) return true;
  return /signature|checksum|sha-?256|digest|trust root|untrusted|revoked|authenticated release/i.test(
    safeDiagnostic(cause),
  );
}

function cloneSnapshot(snapshot: UpdateStatusSnapshot): UpdateStatusSnapshot {
  return {
    ...snapshot,
    lastRollback: snapshot.lastRollback ? { ...snapshot.lastRollback } : null,
    quarantine: snapshot.quarantine.map((entry) => ({ ...entry })),
  };
}

function parseUpdateStatusSnapshot(raw: string): UpdateStatusSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Update journal is not valid JSON: ${safeDiagnostic(error)}`);
  }
  const parsed = UpdateStatusSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Update journal validation failed: ${parsed.error.issues[0]?.message ?? "invalid data"}`,
    );
  }
  return parsed.data;
}

export function resolveUpdateJournalPath(resinHome: string): string {
  return path.join(resinHome, UPDATE_JOURNAL_FILE_NAME);
}

export async function readUpdateStatusSnapshot(
  options: {
    readonly resinHome?: string;
    readonly fsBridge?: ConfigFsBridge;
  } = {},
): Promise<UpdateStatusSnapshot | null> {
  const resinHome =
    options.resinHome ?? (process.env.RESIN_HOME?.trim() || path.join(os.homedir(), ".resin"));
  const raw = await (options.fsBridge ?? defaultFsBridge).readFile(
    resolveUpdateJournalPath(resinHome),
  );
  return raw === null ? null : parseUpdateStatusSnapshot(raw);
}

export class UpdateEngine {
  private readonly homeDir: string;
  private readonly resinHome: string;
  private readonly configPath: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly customFetch?: typeof fetch;
  private readonly platformInfo: PlatformInfo;
  private readonly policyLayer: PolicyValue | undefined;
  private readonly channelUrl?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly currentVersionFallback: string;
  private readonly lockOptions: AcquireUpdateLockOptions;
  private readonly acquireLock: (options: AcquireUpdateLockOptions) => Promise<UpdateLockHandle>;
  private readonly resolveRelease: ReleaseResolver;
  private readonly downloadAsset: AssetDownloader;
  private readonly installRelease: ReleaseInstaller;
  private readonly switchVersion: VersionSwitcher;
  private readonly readActiveVersion: (resinHome: string) => string | null | Promise<string | null>;
  private readonly removeVersion: (versionDir: string) => Promise<void>;
  private readonly serviceManager: UpdateServiceManager;
  private readonly sessionActivity?: UpdateEngineOptions["sessionActivity"];
  private readonly healthProbe?: UpdateEngineOptions["healthProbe"];
  private readonly probationMs: number;
  private readonly healthProbeIntervalMs: number;
  private readonly drainTimeoutMs: number;
  private readonly clock: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onSnapshot?: UpdateEngineOptions["onSnapshot"];

  constructor(options: UpdateEngineOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.platformInfo =
      options.platformInfo ??
      validatePlatform(
        detectPlatform({
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
        }),
      );
    const platformPaths = resolvePlatformPaths({
      home: this.homeDir,
      platformInfo: this.platformInfo,
    });
    this.configPath = options.configPath ?? platformPaths.configFile;
    this.customFetch = options.customFetch;
    this.policyLayer = options.policy;
    this.channelUrl = options.channelUrl;
    this.env = options.env ?? process.env;
    this.currentVersionFallback = normalizeVersion(options.currentVersionFallback ?? "0.0.0");
    this.lockOptions = options.lockOptions ?? {};
    this.acquireLock = options.acquireLock ?? acquireUpdateLock;
    this.resolveRelease = options.resolveRelease ?? resolveProductionRelease;
    this.downloadAsset = options.downloadAsset ?? downloadAndVerifyAsset;
    this.installRelease = options.installRelease ?? installReleaseVersion;
    this.switchVersion = options.switchVersion ?? switchActiveVersion;
    this.readActiveVersion = options.readActiveVersion ?? getActiveVersion;
    this.removeVersion =
      options.removeVersion ??
      (async (versionDir) => {
        await fs.rm(versionDir, { recursive: true, force: true });
      });
    this.serviceManager =
      options.serviceManager ??
      createUserServiceManager({
        homeDir: this.homeDir,
        resinHome: this.resinHome,
        fsBridge: this.fsBridge,
        platform: this.platformInfo.os,
      });
    this.sessionActivity = options.sessionActivity;
    this.healthProbe = options.healthProbe;
    this.probationMs = options.probationMs ?? DEFAULT_UPDATE_PROBATION_MS;
    this.healthProbeIntervalMs =
      options.healthProbeIntervalMs ?? DEFAULT_UPDATE_HEALTH_PROBE_INTERVAL_MS;
    this.drainTimeoutMs = options.drainTimeoutMs ?? UPDATE_DRAIN_TIMEOUT_MS;
    if (!Number.isInteger(this.probationMs) || this.probationMs < 0) {
      throw new TypeError("Update probation duration must be a non-negative integer.");
    }
    if (!Number.isInteger(this.healthProbeIntervalMs) || this.healthProbeIntervalMs <= 0) {
      throw new TypeError("Update health probe interval must be a positive integer.");
    }
    if (!Number.isInteger(this.drainTimeoutMs) || this.drainTimeoutMs <= 0) {
      throw new TypeError("Update session drain timeout must be a positive integer.");
    }
    this.clock = options.clock ?? Date.now;
    this.sleep =
      options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    this.onSnapshot = options.onSnapshot;
  }

  async run(request: UpdateEngineRunRequest = {}): Promise<UpdateEngineResult> {
    const mode = request.mode ?? "manual";
    const lockPath = this.lockOptions.lockPath ?? resolveUpdateLockPath(this.resinHome);
    let lock: UpdateLockHandle;
    try {
      lock = await this.acquireLock({
        ...this.lockOptions,
        lockPath,
        timeoutMs: request.lockTimeoutMs ?? this.lockOptions.timeoutMs ?? 0,
        label: mode === "manual" ? "manual-upgrade" : "background-update",
      });
    } catch (error) {
      if (!(error instanceof UpdateLockUnavailableError)) throw error;
      const version = await this.readCurrentVersion();
      const channel = this.requestedChannelOrDefault(request.channel);
      const snapshot = await this.readSnapshot(version, channel).catch(() =>
        this.createSnapshot(version, channel),
      );
      return this.createResult({
        request,
        snapshot,
        status: "locked",
        success: false,
        currentVersion: version,
        error: "Another manual or background update operation holds the shared update lock.",
        steps: ["preflight", "lock_refused"],
      });
    }

    try {
      return await this.runLocked(request);
    } finally {
      await lock.release();
    }
  }

  private async runLocked(request: UpdateEngineRunRequest): Promise<UpdateEngineResult> {
    const mode = request.mode ?? "manual";
    this.throwIfAborted(request.signal);
    await this.recoverInterruptedReinstall();
    const metadata = await this.readVersionMetadata();
    const currentVersion = metadata.version;
    let policy: UpdatePolicy;
    try {
      policy = await this.resolvePolicy(request);
    } catch (error) {
      const channel = this.requestedChannelOrDefault(request.channel);
      const snapshot = await this.readSnapshot(currentVersion, channel).catch(() =>
        this.createSnapshot(currentVersion, channel),
      );
      return this.finishFailure(request, snapshot, currentVersion, undefined, error, [
        "preflight",
        "policy_rejected",
      ]);
    }

    let snapshot: UpdateStatusSnapshot;
    try {
      snapshot = await this.readSnapshot(currentVersion, policy.channel);
    } catch (error) {
      try {
        snapshot = await this.recoverCorruptSnapshot(currentVersion, policy.channel, error);
      } catch (recoveryError) {
        return this.createResult({
          request,
          snapshot: this.createSnapshot(currentVersion, policy.channel),
          status: "failed",
          success: false,
          currentVersion,
          error: `Update journal recovery failed: ${safeDiagnostic(recoveryError)}`,
          steps: ["preflight", "journal_recovery_failed"],
        });
      }
    }

    snapshot = {
      ...snapshot,
      channel: policy.channel,
      currentVersion,
      targetVersion: request.targetVersion ? normalizeVersion(request.targetVersion) : null,
      lastCheckAt: this.nowIso(),
      lastError: null,
    };
    await this.persistSnapshot(snapshot);

    if (request.rollback && request.targetVersion !== undefined) {
      return this.finishFailure(
        request,
        snapshot,
        currentVersion,
        undefined,
        new Error("--rollback cannot be combined with --target-version."),
        ["preflight", "rollback_target_rejected"],
      );
    }

    if (mode === "background" && !policy.autoUpdate) {
      snapshot = await this.recordSnapshot(snapshot, {
        lastResult: "disabled",
        targetVersion: null,
        pendingVersion: null,
      });
      return this.createResult({
        request,
        snapshot,
        status: "disabled",
        success: true,
        currentVersion,
        steps: ["preflight", "auto_update_disabled"],
      });
    }

    if (request.rollback) {
      return this.runExplicitRollback(request, snapshot, metadata, policy);
    }

    return this.resolveStageAndActivate(request, snapshot, metadata, policy);
  }

  private async resolveStageAndActivate(
    request: UpdateEngineRunRequest,
    initialSnapshot: UpdateStatusSnapshot,
    metadata: VersionMetadataState,
    policy: UpdatePolicy,
  ): Promise<UpdateEngineResult> {
    const currentVersion = metadata.version;
    const steps = ["preflight", "lock_acquired", "channel_resolved"];
    let snapshot = initialSnapshot;
    let targetVersion: string | undefined;
    let release: ResolvedProductionRelease;

    try {
      release = await this.resolveRelease({
        platform: this.platformInfo,
        channel: policy.channel,
        channelUrl: this.channelUrl ?? this.env.RESIN_RELEASE_CHANNEL_URL,
        currentInstalledVersion: currentVersion,
        currentActiveVersion: currentVersion,
        fetchImpl: this.customFetch,
        env: this.env,
        allowInsecureHttpForTests: this.env.RESIN_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
      });
      this.assertTrustedRelease(release);
      targetVersion = normalizeVersion(release.version);
      steps.push("signed_release_resolved");
    } catch (error) {
      if (isOfflineError(error)) {
        snapshot = await this.tryRecordSnapshot(snapshot, {
          lastResult: "offline",
          lastError: safeDiagnostic(error),
        });
        return this.createResult({
          request,
          snapshot,
          status: "offline",
          success: false,
          currentVersion,
          error: safeDiagnostic(error),
          deferralReason: "offline",
          steps: [...steps, "offline_deferred"],
        });
      }
      return this.finishFailure(request, snapshot, currentVersion, targetVersion, error, [
        ...steps,
        "release_rejected",
      ]);
    }

    snapshot = await this.recordSnapshot(snapshot, { targetVersion });
    if (
      request.targetVersion &&
      normalizeVersion(request.targetVersion) !== normalizeVersion(targetVersion)
    ) {
      return this.finishFailure(
        request,
        snapshot,
        currentVersion,
        targetVersion,
        new Error(
          `Requested version '${request.targetVersion}' is not the version authenticated by the signed ${policy.channel} channel ('${targetVersion}').`,
        ),
        [...steps, "target_version_rejected"],
      );
    }

    if (this.isQuarantined(snapshot, targetVersion)) {
      snapshot = await this.recordSnapshot(snapshot, {
        lastResult: "quarantined",
        lastError: `Release v${targetVersion} is quarantined after a prior activation failure.`,
      });
      return this.createResult({
        request,
        snapshot,
        status: "quarantined",
        success: false,
        currentVersion,
        targetVersion,
        quarantined: true,
        error: snapshot.lastError ?? undefined,
        steps: [...steps, "quarantine_refused"],
      });
    }

    if (compareSemver(targetVersion, currentVersion) < 0 && !policy.allowDowngrades) {
      const error = `Refusing to downgrade Resin from v${currentVersion} to v${targetVersion}; updates.allowDowngrades is false.`;
      snapshot = await this.recordSnapshot(snapshot, {
        lastResult: "downgrade-blocked",
        lastError: error,
        pendingVersion: null,
      });
      return this.createResult({
        request,
        snapshot,
        status: "downgrade-blocked",
        success: false,
        currentVersion,
        targetVersion,
        error,
        steps: [...steps, "downgrade_refused"],
      });
    }

    if (!request.force && normalizeVersion(targetVersion) === normalizeVersion(currentVersion)) {
      snapshot = await this.recordSnapshot(snapshot, {
        lastResult: "already-current",
        currentVersion,
        pendingVersion: null,
      });
      return this.createResult({
        request,
        snapshot,
        status: "already-current",
        success: true,
        currentVersion,
        targetVersion,
        steps: [...steps, "already_current"],
      });
    }

    const sameVersionReinstall =
      request.force === true &&
      normalizeVersion(targetVersion) === normalizeVersion(currentVersion);
    const installVersion = sameVersionReinstall
      ? this.createReinstallCandidateVersion(targetVersion)
      : targetVersion;

    let installed: VersionInstallResult;
    try {
      const downloadsDir = path.join(this.resinHome, "downloads");
      const releaseDownload = await this.downloadAsset({
        asset: release.releaseAsset,
        downloadDir: downloadsDir,
        sourceUrlOrPath: release.releaseAssetUrl,
        fsBridge: this.fsBridge,
        fetchImpl: this.customFetch,
      });
      this.assertVerifiedDownload(releaseDownload, release.releaseAsset.sha256, "release payload");
      const denoDownload = await this.downloadAsset({
        asset: {
          filename: release.denoAsset.filename,
          platform: this.platformInfo.os,
          arch: this.platformInfo.arch,
          isWsl: this.platformInfo.isWsl,
          sizeBytes: 0,
          sha256: release.denoAsset.sha256,
          path: release.denoAsset.filename,
        },
        downloadDir: downloadsDir,
        sourceUrlOrPath: release.denoAsset.url,
        fsBridge: this.fsBridge,
        fetchImpl: this.customFetch,
      });
      this.assertVerifiedDownload(denoDownload, release.denoAsset.sha256, "Deno runtime");
      steps.push("artifacts_verified");
      installed = await this.installRelease({
        version: installVersion,
        tarballPathOrBuffer: releaseDownload.path,
        resinHome: this.resinHome,
        fsBridge: this.fsBridge,
        provenance: release.provenance,
        denoRuntime: {
          archivePathOrBuffer: denoDownload.path,
          version: release.provenance.deno.version,
          sha256: release.provenance.deno.sha256,
          executable: release.denoAsset.executable,
        },
        force: request.force === true && !sameVersionReinstall,
      });
      if (normalizeVersion(installed.version) !== installVersion) {
        throw new UpdateVerificationError(
          `Staged release version '${installed.version}' does not match expected candidate '${installVersion}'.`,
        );
      }
      if (!sameVersionReinstall) {
        await this.recordTrustedInstalledRelease(installed, targetVersion, release, policy.channel);
        steps.push("installed_tree_trusted");
      }
      steps.push("release_staged");
      snapshot = await this.recordSnapshot(snapshot, {
        targetVersion,
        pendingVersion: targetVersion,
        lastResult: "activation-deferred",
        lastError: null,
      });
    } catch (error) {
      if (isOfflineError(error)) {
        snapshot = await this.tryRecordSnapshot(snapshot, {
          lastResult: "offline",
          lastError: safeDiagnostic(error),
          pendingVersion: null,
        });
        return this.createResult({
          request,
          snapshot,
          status: "offline",
          success: false,
          currentVersion,
          targetVersion,
          error: safeDiagnostic(error),
          deferralReason: "offline",
          steps: [...steps, "offline_deferred"],
        });
      }
      if (isVerificationError(error)) {
        snapshot = await this.tryQuarantine(snapshot, targetVersion, policy.channel, error);
      }
      return this.finishFailure(request, snapshot, currentVersion, targetVersion, error, [
        ...steps,
        "staging_failed",
      ]);
    }

    const lease = await this.acquireActivationLease(request.signal);
    const activity = lease.activity;
    if (activity.state !== "inactive") {
      const deferralReason: UpdateDeferralReason =
        activity.state === "active" ? "active-sessions" : "session-activity-unavailable";
      const message =
        activity.state === "active"
          ? `Activation deferred while ${activity.activeCount ?? "one or more"} session(s) are active.`
          : `Activation deferred because session activity could not be determined${activity.reason ? `: ${activity.reason}` : "."}`;
      snapshot = await this.tryRecordSnapshot(snapshot, {
        lastResult: "activation-deferred",
        lastError: null,
        pendingVersion: targetVersion,
      });
      return this.createResult({
        request,
        snapshot,
        status: "activation-deferred",
        success: true,
        currentVersion,
        targetVersion,
        pendingVersion: targetVersion,
        staged: true,
        deferralReason,
        error: message,
        steps: [...steps, "activation_deferred"],
      });
    }

    return this.activateVersion({
      request,
      snapshot,
      metadata,
      policy,
      targetVersion,
      installed,
      release,
      steps,
      lease,
      sameVersionReinstall,
      removeCandidateOnFailure: true,
    });
  }

  private async runExplicitRollback(
    request: UpdateEngineRunRequest,
    snapshot: UpdateStatusSnapshot,
    metadata: VersionMetadataState,
    policy: UpdatePolicy,
  ): Promise<UpdateEngineResult> {
    const steps = ["preflight", "lock_acquired", "rollback_requested"];
    const previousVersion = metadata.previousVersion;
    if (!previousVersion) {
      return this.finishFailure(
        request,
        snapshot,
        metadata.version,
        undefined,
        new Error("Cannot rollback: version metadata does not name a previous known-good version."),
        [...steps, "rollback_target_missing"],
      );
    }

    let targetVersion: string;
    try {
      targetVersion = normalizeExactVersion(previousVersion);
      if (targetVersion === normalizeVersion(metadata.version)) {
        throw new UpdateVerificationError(
          "Cannot rollback: the recorded predecessor is already the active version.",
        );
      }
      await this.verifyKnownGoodVersion(targetVersion, metadata.version, policy, request.signal);
      steps.push("rollback_provenance_verified");
    } catch (error) {
      return this.finishFailure(request, snapshot, metadata.version, undefined, error, [
        ...steps,
        "rollback_provenance_rejected",
      ]);
    }

    let currentSnapshot = await this.recordSnapshot(snapshot, { targetVersion });
    if (this.isQuarantined(currentSnapshot, targetVersion)) {
      return this.createResult({
        request,
        snapshot: currentSnapshot,
        status: "quarantined",
        success: false,
        currentVersion: metadata.version,
        targetVersion,
        quarantined: true,
        error: `Cannot rollback to quarantined release v${targetVersion}.`,
        steps: [...steps, "quarantine_refused"],
      });
    }

    const lease = await this.acquireActivationLease(request.signal);
    const activity = lease.activity;
    if (activity.state !== "inactive") {
      const deferralReason: UpdateDeferralReason =
        activity.state === "active" ? "active-sessions" : "session-activity-unavailable";
      currentSnapshot = await this.tryRecordSnapshot(currentSnapshot, {
        pendingVersion: targetVersion,
        lastResult: "activation-deferred",
        lastError: null,
      });
      return this.createResult({
        request,
        snapshot: currentSnapshot,
        status: "activation-deferred",
        success: true,
        currentVersion: metadata.version,
        targetVersion,
        pendingVersion: targetVersion,
        deferralReason,
        steps: [...steps, "activation_deferred"],
      });
    }

    const installed: VersionInstallResult = {
      version: targetVersion,
      versionDir: path.join(this.resinHome, "versions", `v${targetVersion}`),
      installedFiles: [],
      entryPoints: { daemon: "", mcpShim: "", cli: "" },
    };
    return this.activateVersion({
      request,
      snapshot: currentSnapshot,
      metadata,
      policy,
      targetVersion,
      installed,
      steps,
      lease,
      sameVersionReinstall: false,
      removeCandidateOnFailure: false,
      explicitRollback: true,
    });
  }

  private async activateVersion(options: {
    readonly request: UpdateEngineRunRequest;
    readonly snapshot: UpdateStatusSnapshot;
    readonly metadata: VersionMetadataState;
    readonly policy: UpdatePolicy;
    readonly targetVersion: string;
    readonly installed: VersionInstallResult;
    readonly release?: ResolvedProductionRelease;
    readonly steps: string[];
    readonly lease: ActivationLease;
    readonly sameVersionReinstall: boolean;
    readonly removeCandidateOnFailure: boolean;
    readonly explicitRollback?: boolean;
  }): Promise<UpdateEngineResult> {
    const {
      request,
      metadata,
      policy,
      targetVersion,
      installed,
      release,
      lease,
      sameVersionReinstall,
      removeCandidateOnFailure,
      explicitRollback = false,
    } = options;
    const steps = [...options.steps];
    let snapshot = options.snapshot;
    let backup: BackupState | undefined;
    let serviceStopped = !lease.serviceState.active;
    let switched = false;
    let candidateStarted = false;
    let rollbackTarget = metadata.version;
    let verificationReport: VerificationReport | undefined;
    let reinstallSwap: ReinstallSwapState | undefined;

    try {
      backup = await this.createBackup(metadata);
      steps.push("backup_created");
      if (lease.serviceState.installed || lease.serviceState.active || lease.drainInitiated) {
        await this.serviceManager.stop();
        serviceStopped = true;
      }
      steps.push(lease.drainInitiated ? "session_drain_completed" : "stop_daemon");

      if (sameVersionReinstall) {
        reinstallSwap = await this.promoteSameVersionReinstall(installed, targetVersion, release);
        steps.push("active_reinstall_promoted");
      }

      const switchedVersion = await this.switchVersion({
        resinHome: this.resinHome,
        targetVersion: reinstallSwap?.candidateVersion ?? targetVersion,
        fsBridge: this.fsBridge,
      });
      switched = true;
      if (reinstallSwap) {
        await this.persistReinstallRecovery(reinstallSwap, "activated");
      }
      if (switchedVersion.previousVersion) {
        rollbackTarget = normalizeVersion(switchedVersion.previousVersion);
      }
      await this.writeVersionMetadata({
        targetVersion,
        previousVersion: sameVersionReinstall ? metadata.previousVersion : metadata.version,
        channel: policy.channel,
        provenance: release?.provenance,
        explicitRollback,
      });
      steps.push("active_version_switched");
      if (
        typeof this.serviceManager.getUnitDefinition === "function" &&
        typeof this.serviceManager.getUnitPath === "function" &&
        typeof this.serviceManager.install === "function"
      ) {
        const unitPath = this.serviceManager.getUnitPath();
        const targetUnit = this.serviceManager.getUnitDefinition();
        const unitExists = await this.fsBridge.exists(unitPath);
        if (unitExists) {
          const onDiskUnit = await this.fsBridge.readFile(unitPath);
          if (isStaleSupervisorUnitContent(onDiskUnit, targetUnit)) {
            const installResult = await this.serviceManager.install({
              homeDir: this.homeDir,
              resinHome: this.resinHome,
              autoStart: false,
            });
            if (!installResult.success) {
              throw new Error(
                `Failed to update stale service unit during update cutover: ${installResult.error || "installation failed"}`,
              );
            }
            steps.push("service_unit_updated");
          }
        }
      }

      await this.serviceManager.start();
      candidateStarted = true;
      serviceStopped = false;
      steps.push("restart_service");
      const probation = await this.runProbation(targetVersion, request.signal);
      verificationReport = probation.report;
      steps.push("health_gate");
      if (!probation.passed) {
        const message = probation.message ?? "Update health probation failed.";
        if (probation.failureAttribution === "infrastructure") {
          throw new Error(`Update health probe infrastructure failed: ${message}`);
        }
        throw new CandidateHealthError(message);
      }

      if (!lease.serviceState.active) {
        await this.serviceManager.stop();
        candidateStarted = false;
        serviceStopped = true;
        steps.push("service_state_restored");
      }

      const finalStatus: UpdateRunStatus = explicitRollback ? "rolled-back" : "activated";
      snapshot = await this.recordSnapshot(snapshot, {
        currentVersion: targetVersion,
        targetVersion,
        pendingVersion: null,
        lastResult: finalStatus,
        lastError: null,
        lastRollback: explicitRollback
          ? {
              fromVersion: metadata.version,
              toVersion: targetVersion,
              rolledBackAt: this.nowIso(),
              reason: "Manual rollback requested.",
            }
          : snapshot.lastRollback,
      });
      if (sameVersionReinstall && release) {
        await this.recordTrustedInstalledRelease(installed, targetVersion, release, policy.channel);
        steps.push("installed_tree_trusted");
      }
      await this.cleanupReinstallSwap(reinstallSwap);
      await this.cleanupBackup(backup);
      return this.createResult({
        request,
        snapshot,
        status: finalStatus,
        success: true,
        currentVersion: metadata.version,
        targetVersion,
        staged: !explicitRollback,
        activated: true,
        healthGatePassed: true,
        rolledBack: explicitRollback || undefined,
        backupPath: backup.path,
        verificationReport,
        steps: [...steps, "complete"],
      });
    } catch (error) {
      const shouldRollback =
        (request.rollbackOnFailure ?? true) && (switched || reinstallSwap?.promoted === true);
      let rollbackOutcome: RollbackOutcome = {
        rolledBack: false,
        activeVersion: switched ? targetVersion : metadata.version,
        serviceStopped,
        configConflict: false,
      };
      if (shouldRollback && backup) {
        rollbackOutcome = await this.rollbackActivation({
          backup,
          installed,
          reinstallSwap,
          rollbackTarget,
          targetVersion,
          serviceWasActive: lease.serviceState.active,
          serviceStopped,
          candidateStarted,
          removeCandidateOnFailure,
          steps,
        });
        serviceStopped = rollbackOutcome.serviceStopped;
      } else if (!switched && reinstallSwap?.promoted !== true) {
        const restorationErrors: unknown[] = [];
        if (lease.serviceState.active) {
          try {
            await this.serviceManager.start();
            serviceStopped = false;
          } catch (serviceError) {
            restorationErrors.push(serviceError);
          }
        } else if (!serviceStopped) {
          try {
            await this.serviceManager.stop();
            serviceStopped = true;
          } catch (serviceError) {
            restorationErrors.push(serviceError);
          }
        }
        rollbackOutcome = {
          rolledBack: false,
          activeVersion: metadata.version,
          serviceStopped,
          configConflict: false,
          error: combineErrors(restorationErrors),
        };
      }

      const activationError = safeDiagnostic(error);
      const failureParts = [activationError];
      if (rollbackOutcome.configConflict) {
        failureParts.push(
          "Configuration changed during activation; the concurrent user configuration was preserved.",
        );
        steps.push("config_conflict_preserved");
      }
      if (rollbackOutcome.error) {
        failureParts.push(`rollback failed: ${safeDiagnostic(rollbackOutcome.error)}`);
      }
      const failureMessage = failureParts.join("; ");
      const candidateFailure = error instanceof CandidateHealthError;
      if (candidateFailure) {
        snapshot = this.withQuarantine(snapshot, targetVersion, policy.channel, error);
      }

      if (rollbackOutcome.rolledBack) {
        snapshot = await this.tryRecordSnapshot(snapshot, {
          currentVersion: rollbackTarget,
          targetVersion,
          pendingVersion: null,
          lastResult: "rolled-back",
          lastError: failureMessage,
          lastRollback: {
            fromVersion: targetVersion,
            toVersion: rollbackTarget,
            rolledBackAt: this.nowIso(),
            reason: activationError,
          },
        });
        if (backup) await this.cleanupBackup(backup);
      } else {
        snapshot = await this.tryRecordSnapshot(snapshot, {
          currentVersion: rollbackOutcome.activeVersion,
          targetVersion,
          pendingVersion: null,
          lastResult: "failed",
          lastError: failureMessage,
        });
      }

      return this.createResult({
        request,
        snapshot,
        status: rollbackOutcome.rolledBack ? "rolled-back" : "failed",
        success: false,
        currentVersion: metadata.version,
        targetVersion,
        staged: !explicitRollback,
        activated: switched,
        rolledBack: rollbackOutcome.rolledBack,
        quarantined: candidateFailure,
        error: failureMessage,
        backupPath: backup?.path,
        verificationReport,
        steps,
      });
    }
  }

  private async runProbation(
    targetVersion: string,
    signal?: AbortSignal,
  ): Promise<ProbationResult> {
    const startedAt = this.clock();
    let elapsedMs = 0;
    let attempts = 0;
    let everHealthy = false;
    let lastProbe: UpdateHealthProbeResult | undefined;

    while (true) {
      this.throwIfAborted(signal);
      lastProbe = await this.probeHealth({ targetVersion, elapsedMs });
      attempts += 1;
      const healthy = this.isHealthy(lastProbe);
      everHealthy ||= healthy;
      if (lastProbe.recoveryBreakerTripped) {
        return {
          passed: false,
          report: this.createVerificationReport(lastProbe, attempts, elapsedMs),
          message: lastProbe.message ?? "Recovery breaker tripped during update probation.",
          failureAttribution: lastProbe.failureAttribution ?? "candidate",
        };
      }
      if (elapsedMs >= this.probationMs) {
        const passed = healthy && everHealthy;
        return {
          passed,
          report: this.createVerificationReport(lastProbe, attempts, elapsedMs),
          message: passed
            ? undefined
            : (lastProbe.message ?? "Candidate did not become healthy during update probation."),
          failureAttribution: passed ? undefined : (lastProbe.failureAttribution ?? "candidate"),
        };
      }
      const delayMs = Math.min(this.healthProbeIntervalMs, this.probationMs - elapsedMs);
      await this.sleep(delayMs);
      this.throwIfAborted(signal);
      const wallElapsed = Math.max(0, this.clock() - startedAt);
      elapsedMs = Math.max(elapsedMs + delayMs, wallElapsed);
    }
  }

  private async probeHealth(context: UpdateHealthProbeContext): Promise<UpdateHealthProbeResult> {
    if (this.healthProbe) return this.healthProbe(context);

    let serviceActive = false;
    let ipcResponsive = false;
    let mcpResponsive = false;
    let recoveryBreakerTripped = false;
    let infrastructureFailure = false;
    const failures: string[] = [];
    try {
      const status = await this.serviceManager.status();
      serviceActive = status.active;
      if (!serviceActive) failures.push(`service is ${status.state ?? "inactive"}`);
    } catch (error) {
      failures.push(`service status failed: ${safeDiagnostic(error)}`);
      infrastructureFailure = true;
    }

    const paths = resolvePlatformPaths({ home: this.homeDir, platformInfo: this.platformInfo });
    const ipcClient = new IpcClient({
      socketPath: paths.socketPath,
      timeoutMs: 2_000,
    });
    try {
      await ipcClient.connect();
      await ipcClient.ping(`update-${context.elapsedMs}`);
      const health = await ipcClient.getHealth();
      ipcResponsive = !["failed", "stopped", "stopping"].includes(health.status);
      if (!ipcResponsive) failures.push(`daemon health is ${health.status}`);
      const gateway = await runVerificationSuite({
        homeDir: this.homeDir,
        resinHome: this.resinHome,
        fsBridge: this.fsBridge,
        ipcClient,
        customFetch: this.customFetch,
        onlyChecks: ["gateway"],
        allowOffline: false,
      });
      mcpResponsive = gateway.passed;
      if (!mcpResponsive) failures.push("MCP gateway is unresponsive");
    } catch (error) {
      failures.push(`IPC/MCP probe failed: ${safeDiagnostic(error)}`);
      infrastructureFailure = true;
    } finally {
      await ipcClient.close().catch(() => {});
    }

    try {
      const recovery = await new RecoveryStateTracker({ resinHome: this.resinHome }).getState();
      recoveryBreakerTripped = recovery.status === "TRIPPED";
      if (recoveryBreakerTripped) failures.push("recovery breaker is tripped");
    } catch (error) {
      failures.push(`recovery state probe failed: ${safeDiagnostic(error)}`);
      infrastructureFailure = true;
    }

    return {
      serviceActive,
      ipcResponsive,
      mcpResponsive,
      recoveryBreakerTripped,
      message: failures.length > 0 ? failures.join("; ") : undefined,
      failureAttribution: infrastructureFailure ? "infrastructure" : "candidate",
    };
  }

  private async acquireActivationLease(signal?: AbortSignal): Promise<ActivationLease> {
    let serviceState: ServiceStatusInfo;
    try {
      this.throwIfAborted(signal);
      serviceState = await this.withTimeoutAndSignal(
        this.serviceManager.status(),
        Math.min(this.drainTimeoutMs, 5_000),
        signal,
        "Initial service status inspection timed out.",
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        activity: {
          state: "unknown",
          reason: `service state unavailable: ${safeDiagnostic(error)}`,
        },
        serviceState: {
          installed: false,
          active: false,
          enabled: false,
          serviceName: "resin",
          unitPath: "",
        },
        drainInitiated: false,
      };
    }

    if (!serviceState.active) {
      return {
        activity: { state: "inactive", activeCount: 0 },
        serviceState,
        drainInitiated: false,
      };
    }

    if (this.sessionActivity) {
      try {
        this.throwIfAborted(signal);
        const reported = await this.withTimeoutAndSignal(
          Promise.resolve().then(() => this.sessionActivity!()),
          this.drainTimeoutMs,
          signal,
          "Session activity inspection timed out.",
        );
        const activity =
          reported === true || reported === false
            ? {
                state: reported ? ("active" as const) : ("inactive" as const),
                activeCount: reported ? 1 : 0,
              }
            : reported;
        return { activity, serviceState, drainInitiated: false };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          activity: { state: "unknown", reason: safeDiagnostic(error) },
          serviceState,
          drainInitiated: false,
        };
      }
    }

    const paths = resolvePlatformPaths({ home: this.homeDir, platformInfo: this.platformInfo });
    const client = new IpcClient({
      socketPath: paths.socketPath,
      timeoutMs: Math.min(this.drainTimeoutMs, 5_000),
    });
    let drainInitiated = false;
    try {
      this.throwIfAborted(signal);
      await this.withTimeoutAndSignal(
        client.connect(),
        Math.min(this.drainTimeoutMs, 5_000),
        signal,
        "IPC daemon connection timed out.",
      );
      const initialHealth = await this.withTimeoutAndSignal(
        client.getHealth(),
        Math.min(this.drainTimeoutMs, 5_000),
        signal,
        "IPC daemon health probe timed out.",
      );
      if (initialHealth.status === "stopped" && this.countActiveWork(initialHealth) === 0) {
        return {
          activity: { state: "inactive", activeCount: 0 },
          serviceState,
          drainInitiated: false,
        };
      }

      if (initialHealth.status === "stopping") {
        drainInitiated = true;
      } else {
        const drain = await this.withTimeoutAndSignal(
          client.gracefulShutdown({
            timeoutMs: this.drainTimeoutMs,
            reason: "Signed Resin update activation drain",
          }),
          Math.min(this.drainTimeoutMs, 5_000),
          signal,
          "IPC daemon graceful shutdown timed out.",
        );
        if (!drain.accepted) {
          return {
            activity: { state: "unknown", reason: drain.message },
            serviceState,
            drainInitiated: false,
          };
        }
        drainInitiated = true;
      }

      const startedAt = this.clock();
      let elapsedMs = 0;
      let ipcDisconnected = false;
      let lastReportedActiveCount = this.countActiveWork(initialHealth);

      while (true) {
        this.throwIfAborted(signal);
        if (elapsedMs >= this.drainTimeoutMs) {
          return {
            activity: ipcDisconnected
              ? {
                  state: "active",
                  activeCount: 1,
                  reason: "daemon drain timed out with service still active",
                }
              : lastReportedActiveCount > 0
                ? {
                    state: "active",
                    activeCount: lastReportedActiveCount,
                    reason: "daemon drain timed out with work still active",
                  }
                : {
                    state: "unknown",
                    reason: `daemon drain did not complete within ${this.drainTimeoutMs}ms`,
                  },
            serviceState,
            drainInitiated: true,
          };
        }
        const remainingBudgetMs = Math.max(0, this.drainTimeoutMs - elapsedMs);

        if (!ipcDisconnected) {
          try {
            const probeTimeout = Math.max(
              1,
              Math.min(this.healthProbeIntervalMs, remainingBudgetMs, 5_000),
            );
            const health = await this.withTimeoutAndSignal(
              client.getHealth(),
              probeTimeout,
              signal,
              "IPC health probe timed out",
            );
            const activeCount = this.countActiveWork(health);
            lastReportedActiveCount = activeCount;
            if (activeCount === 0 && health.status === "stopped") {
              return {
                activity: { state: "inactive", activeCount: 0 },
                serviceState,
                drainInitiated: true,
              };
            }
          } catch (ipcError) {
            if (signal?.aborted) throw ipcError;
            ipcDisconnected = true;
          }
        }

        if (ipcDisconnected) {
          let currentServiceState: ServiceStatusInfo;
          try {
            currentServiceState = await this.withTimeoutAndSignal(
              this.serviceManager.status(),
              Math.min(remainingBudgetMs, 5_000),
              signal,
              "Service status inspection timed out.",
            );
          } catch (statusError) {
            if (signal?.aborted) throw statusError;
            return {
              activity: {
                state: "unknown",
                reason: `service state unavailable after drain: ${safeDiagnostic(statusError)}`,
              },
              serviceState,
              drainInitiated: true,
            };
          }

          if (!currentServiceState.active) {
            return {
              activity: { state: "inactive", activeCount: 0 },
              serviceState,
              drainInitiated: true,
            };
          }
        }

        const delayMs = Math.min(this.healthProbeIntervalMs, this.drainTimeoutMs - elapsedMs);
        await this.sleep(delayMs);
        this.throwIfAborted(signal);
        const wallElapsed = Math.max(0, this.clock() - startedAt);
        elapsedMs = Math.max(elapsedMs + delayMs, wallElapsed);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        activity: { state: "unknown", reason: safeDiagnostic(error) },
        serviceState,
        drainInitiated,
      };
    } finally {
      await client.close().catch(() => {});
    }
  }

  private countActiveWork(health: DaemonHealthReport): number {
    let activeCount = 0;
    for (const moduleHealth of Object.values(health.modules)) {
      const details = moduleHealth.details;
      if (!details) continue;
      for (const key of [
        "activeSessions",
        "activeToolExecutions",
        "activeExecutions",
        "inFlightRequests",
      ]) {
        const count = details[key];
        if (isPositiveFiniteNumber(count)) {
          activeCount += count;
        }
      }
    }
    return activeCount;
  }

  private async resolvePolicy(request: UpdateEngineRunRequest): Promise<UpdatePolicy> {
    const raw = await this.fsBridge.readFile(this.configPath);
    let configured: PolicyValue | undefined;
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Cannot parse update configuration: ${safeDiagnostic(error)}`);
      }
      const envelope = UpdateConfigEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        throw new Error(
          `Cannot parse update configuration: ${envelope.error.issues[0]?.message ?? "invalid data"}`,
        );
      }
      configured = envelope.data.updates;
    }
    const requestLayer: UpdatePolicyPatch = {};
    if (request.channel !== undefined && isUpdateChannel(request.channel))
      requestLayer.channel = request.channel;
    if (request.allowDowngrades !== undefined) {
      requestLayer.allowDowngrades = request.allowDowngrades;
    }
    return mergeUpdatePolicy(configured, this.policyLayer, requestLayer);
  }

  private async readVersionMetadata(): Promise<VersionMetadataState> {
    const versionPath = path.join(this.resinHome, "version.json");
    const raw = await this.fsBridge.readFile(versionPath);
    let metadataVersion: string | undefined;
    let previousVersion: string | undefined;
    if (raw !== null) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Cannot parse installed version metadata: ${safeDiagnostic(error)}`);
      }
      const parsed = VersionMetadataSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(
          `Cannot parse installed version metadata: ${parsed.error.issues[0]?.message ?? "invalid data"}`,
        );
      }
      metadataVersion = parsed.data.version ? normalizeVersion(parsed.data.version) : undefined;
      previousVersion = parsed.data.previousVersion
        ? normalizeVersion(parsed.data.previousVersion)
        : undefined;
    }
    const activeVersion = await this.readActiveVersion(this.resinHome);
    const version = normalizeVersion(
      activeVersion ?? metadataVersion ?? this.currentVersionFallback,
    );
    return {
      raw: raw ?? JSON.stringify({ version }, null, 2),
      version,
      previousVersion,
    };
  }

  private async readCurrentVersion(): Promise<string> {
    try {
      return (await this.readVersionMetadata()).version;
    } catch {
      return this.currentVersionFallback;
    }
  }

  private async createBackup(metadata: VersionMetadataState): Promise<BackupState> {
    const backupRoot = path.join(this.resinHome, "backups");
    const backupPath = path.join(
      backupRoot,
      `update_${this.clock()}_${crypto.randomBytes(6).toString("hex")}`,
    );
    const versionPath = path.join(this.resinHome, "version.json");
    const versionBackupPath = path.join(backupPath, "version.json");
    const configBackupPath = path.join(backupPath, "config.json");
    const configRaw = await this.fsBridge.readFile(this.configPath);
    const sanitizedConfig = this.sanitizeConfigBackup(configRaw);

    if (this.fsBridge === defaultFsBridge) {
      await fs.mkdir(backupRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      await fs.chmod(backupRoot, PRIVATE_DIRECTORY_MODE);
      await fs.mkdir(backupPath, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    } else {
      await this.fsBridge.mkdirp(backupPath);
    }
    await this.writeStateFile(versionBackupPath, metadata.raw, PRIVATE_FILE_MODE);
    if (sanitizedConfig !== null) {
      await this.writeStateFile(configBackupPath, sanitizedConfig, PRIVATE_FILE_MODE);
    }

    const backupResult: BackupState =
      sanitizedConfig !== null
        ? {
            path: backupPath,
            versionPath,
            versionBackupPath,
            versionRaw: metadata.raw,
            configPath: this.configPath,
            configHash: configRaw === null ? null : sha256Text(configRaw),
            configBackupPath,
          }
        : {
            path: backupPath,
            versionPath,
            versionBackupPath,
            versionRaw: metadata.raw,
            configPath: this.configPath,
            configHash: configRaw === null ? null : sha256Text(configRaw),
          };
    return backupResult;
  }
  private sanitizeConfigBackup(raw: string | null): string | null {
    if (raw === null) return null;
    let parsed: JsonValue;
    try {
      // SAFETY: JSON.parse returns a valid JsonValue tree.
      parsed = JSON.parse(raw) as JsonValue;
    } catch {
      return null;
    }
    if (!isJsonObject(parsed) || !("updates" in parsed)) {
      return null;
    }
    const updates = parsed.updates;
    if (!isJsonObject(updates)) return null;
    const allowed: Record<string, boolean | string> = {};
    if ("autoUpdate" in updates && (updates.autoUpdate === true || updates.autoUpdate === false)) {
      allowed.autoUpdate = updates.autoUpdate;
    }
    if (
      "channel" in updates &&
      (updates.channel === "stable" || updates.channel === "beta" || updates.channel === "nightly")
    ) {
      allowed.channel = updates.channel;
    }
    if (
      "allowDowngrades" in updates &&
      (updates.allowDowngrades === true || updates.allowDowngrades === false)
    ) {
      allowed.allowDowngrades = updates.allowDowngrades;
    }
    return Object.keys(allowed).length === 0 ? null : JSON.stringify({ updates: allowed }, null, 2);
  }

  private async restoreBackup(backup: BackupState): Promise<boolean> {
    await this.writeStateFile(backup.versionPath, backup.versionRaw, PRIVATE_FILE_MODE);
    const currentConfig = await this.fsBridge.readFile(backup.configPath);
    const currentHash = currentConfig === null ? null : sha256Text(currentConfig);
    return currentHash !== backup.configHash;
  }

  private async cleanupBackup(backup: BackupState): Promise<void> {
    if (this.fsBridge === defaultFsBridge) {
      await fs.rm(backup.path, { recursive: true, force: true }).catch(() => {});
      return;
    }
    await this.fsBridge.unlink(backup.versionBackupPath).catch(() => {});
    if (backup.configBackupPath) {
      await this.fsBridge.unlink(backup.configBackupPath).catch(() => {});
    }
    await this.fsBridge.unlink(backup.path).catch(() => {});
  }

  private async writeVersionMetadata(options: {
    readonly targetVersion: string;
    readonly previousVersion?: string;
    readonly channel: UpdateChannel;
    readonly provenance?: ResolvedProductionRelease["provenance"];
    readonly explicitRollback: boolean;
  }): Promise<void> {
    const versionPayload: VersionMetadataPayload = {
      version: options.targetVersion,
      channel: options.channel,
    };
    if (options.previousVersion) {
      versionPayload.previousVersion = options.previousVersion;
    }
    if (options.explicitRollback) {
      versionPayload.rolledBackAt = this.nowIso();
    } else {
      versionPayload.upgradedAt = this.nowIso();
      if (options.provenance !== undefined) {
        versionPayload.provenance = options.provenance;
      }
    }
    await this.writeStateFile(
      path.join(this.resinHome, "version.json"),
      JSON.stringify(versionPayload, null, 2),
      PRIVATE_FILE_MODE,
    );
  }

  private resolveVersionDirectory(version: string): string {
    const normalized = normalizeExactVersion(version);
    const versionsRoot = path.resolve(this.resinHome, "versions");
    const versionDir = path.resolve(versionsRoot, `v${normalized}`);
    if (path.dirname(versionDir) !== versionsRoot) {
      throw new UpdateVerificationError(
        `Installed release directory escapes the versions root: '${versionDir}'.`,
      );
    }
    return versionDir;
  }

  private async readVerifiedInstalledMetadata(
    versionDir: string,
    expectedInstalledVersion: string,
    expectedProvenanceVersion: string,
  ): Promise<z.infer<typeof InstalledReleaseMetadataSchema>> {
    const metadataPath = path.join(versionDir, "version.json");
    if (this.fsBridge === defaultFsBridge) {
      const [directoryStats, metadataStats] = await Promise.all([
        fs.lstat(versionDir),
        fs.lstat(metadataPath),
      ]);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw new UpdateVerificationError(
          `Installed release path is not a real directory: '${versionDir}'.`,
        );
      }
      if (metadataStats.isSymbolicLink() || !metadataStats.isFile()) {
        throw new UpdateVerificationError(
          `Installed release metadata is not a regular file: '${metadataPath}'.`,
        );
      }
    }

    const raw = await this.fsBridge.readFile(metadataPath);
    if (raw === null) {
      throw new UpdateVerificationError(
        `Installed release v${expectedInstalledVersion} has no provenance metadata.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new UpdateVerificationError(
        `Installed release metadata is invalid JSON: ${safeDiagnostic(error)}`,
      );
    }
    const parsed = InstalledReleaseMetadataSchema.safeParse(value);
    if (!parsed.success) {
      throw new UpdateVerificationError(
        `Installed release provenance is incomplete: ${parsed.error.issues[0]?.message ?? "invalid data"}`,
      );
    }
    if (
      normalizeExactVersion(parsed.data.version) !==
        normalizeExactVersion(expectedInstalledVersion) ||
      normalizeExactVersion(parsed.data.provenance.version) !==
        normalizeExactVersion(expectedProvenanceVersion) ||
      normalizeSha256(parsed.data.sha256) !==
        normalizeSha256(parsed.data.provenance.releaseAssetSha256)
    ) {
      throw new UpdateVerificationError(
        `Installed release v${expectedInstalledVersion} failed provenance consistency checks.`,
      );
    }
    return parsed.data;
  }

  private async verifyKnownGoodVersion(
    version: string,
    currentVersion: string,
    policy: UpdatePolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const normalized = normalizeExactVersion(version);
    this.throwIfAborted(signal);
    const authorization = await this.resolveRelease({
      platform: this.platformInfo,
      channel: policy.channel,
      channelUrl: this.channelUrl ?? this.env.RESIN_RELEASE_CHANNEL_URL,
      currentInstalledVersion: currentVersion,
      currentActiveVersion: currentVersion,
      fetchImpl: this.customFetch,
      env: this.env,
      allowInsecureHttpForTests: this.env.RESIN_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
    });
    this.throwIfAborted(signal);
    this.assertTrustedRelease(authorization);

    if (
      authorization.channel.revokedVersions?.some(
        (revoked) => normalizeVersion(revoked) === normalized,
      )
    ) {
      throw new UpdateVerificationError(`Cannot rollback to revoked release v${normalized}.`);
    }

    const trusted = await this.readTrustedInstalledRelease(normalized);
    if (trusted.channel !== policy.channel) {
      throw new UpdateVerificationError(
        `Installed release v${normalized} was not authenticated for the '${policy.channel}' channel.`,
      );
    }
    if (
      normalizeExactVersion(trusted.version) !== normalized ||
      normalizeExactVersion(trusted.provenance.version) !== normalized
    ) {
      throw new UpdateVerificationError(
        `Trusted rollback record for v${normalized} has inconsistent provenance.`,
      );
    }

    if (normalizeVersion(authorization.version) === normalized) {
      const signed = authorization.provenance;
      if (
        normalizeSha256(trusted.provenance.channelSha256) !==
          normalizeSha256(signed.channelSha256) ||
        normalizeSha256(trusted.provenance.manifestSha256) !==
          normalizeSha256(signed.manifestSha256) ||
        normalizeSha256(trusted.provenance.releaseAssetSha256) !==
          normalizeSha256(signed.releaseAssetSha256) ||
        [...trusted.provenance.signingKeyIds].sort().join("\0") !==
          [...signed.signingKeyIds].sort().join("\0")
      ) {
        throw new UpdateVerificationError(
          `Installed release v${normalized} does not match the authenticated release provenance.`,
        );
      }
    } else {
      const rollback = authorization.channel.rollbackReferences;
      if (
        !rollback ||
        normalizeVersion(rollback.targetVersion) !== normalized ||
        !rollback.rollbackSha256 ||
        normalizeSha256(rollback.rollbackSha256) !==
          normalizeSha256(trusted.provenance.releaseAssetSha256)
      ) {
        throw new UpdateVerificationError(
          `The signed '${policy.channel}' channel does not authorize rollback to v${normalized}.`,
        );
      }
    }

    const versionDir = this.resolveVersionDirectory(trusted.physicalVersion);
    const tree = await this.hashInstalledTree(versionDir, trusted.filePaths);
    if (
      normalizeSha256(tree.treeSha256) !== normalizeSha256(trusted.treeSha256) ||
      tree.filePaths.join("\0") !== [...trusted.filePaths].sort().join("\0")
    ) {
      throw new UpdateVerificationError(
        `Installed release v${normalized} failed its trusted tree digest check.`,
      );
    }
  }

  private trustedReleaseRecordPath(version: string): string {
    const normalized = normalizeExactVersion(version);
    return path.join(
      this.resinHome,
      "updates",
      TRUSTED_RELEASES_DIRECTORY_NAME,
      `v${normalized}.json`,
    );
  }

  private async readTrustedInstalledRelease(
    version: string,
  ): Promise<z.infer<typeof TrustedInstalledReleaseSchema>> {
    const recordPath = this.trustedReleaseRecordPath(version);
    if (this.fsBridge === defaultFsBridge) {
      const stats = await fs.lstat(recordPath).catch(() => null);
      if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
        throw new UpdateVerificationError(
          `Installed release v${version} has no trusted rollback record.`,
        );
      }
    }
    const raw = await this.fsBridge.readFile(recordPath);
    if (raw === null) {
      throw new UpdateVerificationError(
        `Installed release v${version} has no trusted rollback record.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new UpdateVerificationError(
        `Trusted rollback record is invalid JSON: ${safeDiagnostic(error)}`,
      );
    }
    const parsed = TrustedInstalledReleaseSchema.safeParse(value);
    if (!parsed.success) {
      throw new UpdateVerificationError(
        `Trusted rollback record is invalid: ${parsed.error.issues[0]?.message ?? "invalid data"}`,
      );
    }
    return parsed.data;
  }

  private async recordTrustedInstalledRelease(
    installed: VersionInstallResult,
    logicalVersion: string,
    release: ResolvedProductionRelease,
    channel: UpdateChannel,
  ): Promise<void> {
    const version = normalizeExactVersion(logicalVersion);
    const physicalVersion = normalizeExactVersion(installed.version);
    const versionDir = this.resolveVersionDirectory(physicalVersion);
    if (path.resolve(installed.versionDir) !== versionDir) {
      throw new UpdateVerificationError(
        "The installed release was returned from an unexpected directory.",
      );
    }
    const tree = await this.hashInstalledTree(versionDir, installed.installedFiles);
    await this.writeStateFile(
      this.trustedReleaseRecordPath(version),
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          physicalVersion,
          channel,
          treeSha256: tree.treeSha256,
          filePaths: tree.filePaths,
          provenance: release.provenance,
        },
        null,
        2,
      ),
      PRIVATE_FILE_MODE,
    );
  }

  private async hashInstalledTree(
    versionDir: string,
    knownFiles: readonly string[],
  ): Promise<{ readonly treeSha256: string; readonly filePaths: string[] }> {
    const filePaths: string[] = [];
    if (this.fsBridge === defaultFsBridge) {
      const visit = async (directory: string): Promise<void> => {
        const names = (await fs.readdir(directory)).sort();
        for (const name of names) {
          const absolutePath = path.join(directory, name);
          const stats = await fs.lstat(absolutePath);
          if (stats.isSymbolicLink()) {
            throw new UpdateVerificationError(
              `Installed release tree contains a symbolic link: '${absolutePath}'.`,
            );
          }
          if (stats.isDirectory()) {
            await visit(absolutePath);
          } else if (stats.isFile()) {
            filePaths.push(path.relative(versionDir, absolutePath));
          } else {
            throw new UpdateVerificationError(
              `Installed release tree contains an unsupported entry: '${absolutePath}'.`,
            );
          }
        }
      };
      await visit(versionDir);
    } else {
      for (const candidate of [...knownFiles, path.join(versionDir, "version.json")]) {
        const relativePath = path.isAbsolute(candidate)
          ? path.relative(versionDir, candidate)
          : candidate;
        if (
          relativePath.length === 0 ||
          relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)
        ) {
          throw new UpdateVerificationError(
            `Installed release file escapes its version directory: '${candidate}'.`,
          );
        }
        filePaths.push(relativePath);
      }
    }

    const uniquePaths = [...new Set(filePaths)].sort();
    if (uniquePaths.length === 0) {
      throw new UpdateVerificationError("Installed release tree is empty.");
    }
    const treeHash = crypto.createHash("sha256");
    for (const relativePath of uniquePaths) {
      const absolutePath = path.join(versionDir, relativePath);
      let content: Buffer;
      if (this.fsBridge === defaultFsBridge) {
        content = await fs.readFile(absolutePath);
      } else {
        const raw = await this.fsBridge.readFile(absolutePath);
        if (raw === null) {
          throw new UpdateVerificationError(`Installed release tree is missing '${relativePath}'.`);
        }
        content = Buffer.from(raw, "utf8");
      }
      const contentHash = crypto.createHash("sha256").update(content).digest("hex");
      treeHash.update(`${relativePath}\0${content.length}\0${contentHash}\n`, "utf8");
    }
    return { treeSha256: treeHash.digest("hex"), filePaths: uniquePaths };
  }

  private createReinstallCandidateVersion(targetVersion: string): string {
    const normalized = normalizeExactVersion(targetVersion);
    const suffix = `resin-reinstall.${crypto.randomBytes(6).toString("hex")}`;
    return normalizeExactVersion(
      normalized.includes("+") ? `${normalized}.${suffix}` : `${normalized}+${suffix}`,
    );
  }

  private async promoteSameVersionReinstall(
    installed: VersionInstallResult,
    targetVersion: string,
    release: ResolvedProductionRelease | undefined,
  ): Promise<ReinstallSwapState> {
    if (!release) {
      throw new UpdateVerificationError(
        "A same-version reinstall candidate must retain signed release provenance.",
      );
    }
    const normalizedTarget = normalizeExactVersion(targetVersion);
    const candidateVersion = normalizeExactVersion(installed.version);
    const candidateDir = this.resolveVersionDirectory(candidateVersion);
    if (path.resolve(installed.versionDir) !== candidateDir) {
      throw new UpdateVerificationError(
        "The staged reinstall candidate was returned from an unexpected directory.",
      );
    }
    const candidateMetadata = await this.readVerifiedInstalledMetadata(
      candidateDir,
      candidateVersion,
      normalizedTarget,
    );
    if (
      normalizeVersion(release.provenance.version) !== normalizedTarget ||
      normalizeSha256(candidateMetadata.provenance.channelSha256) !==
        normalizeSha256(release.provenance.channelSha256) ||
      normalizeSha256(candidateMetadata.provenance.manifestSha256) !==
        normalizeSha256(release.provenance.manifestSha256) ||
      normalizeSha256(candidateMetadata.provenance.releaseAssetSha256) !==
        normalizeSha256(release.provenance.releaseAssetSha256)
    ) {
      throw new UpdateVerificationError(
        "The staged reinstall candidate does not match the authenticated release provenance.",
      );
    }

    const rollbackVersion = normalizeExactVersion(
      (await this.readActiveVersion(this.resinHome)) ?? normalizedTarget,
    );
    const rollbackDir = this.resolveVersionDirectory(rollbackVersion);
    const rollbackStats = await fs.lstat(rollbackDir);
    if (rollbackStats.isSymbolicLink() || !rollbackStats.isDirectory()) {
      throw new UpdateVerificationError(
        `Active release path is not a real directory: '${rollbackDir}'.`,
      );
    }

    const candidateMetadataPath = path.join(candidateDir, "version.json");
    const rewrittenMetadata = JSON.stringify(
      { ...candidateMetadata, version: normalizedTarget },
      null,
      2,
    );
    await this.writeStateFile(candidateMetadataPath, rewrittenMetadata, 0o644);
    if (this.fsBridge !== defaultFsBridge) {
      const nativeMetadata = await fs.lstat(candidateMetadataPath).catch(() => null);
      if (nativeMetadata?.isFile() && !nativeMetadata.isSymbolicLink()) {
        await this.writeAtomicNativeFile(candidateMetadataPath, rewrittenMetadata, 0o644);
      }
    }

    const state: ReinstallSwapState = {
      targetVersion: normalizedTarget,
      candidateVersion,
      candidateDir,
      rollbackVersion,
      promoted: true,
    };
    await this.persistReinstallRecovery(state, "prepared");
    return state;
  }

  private reinstallRecoveryPath(): string {
    return path.join(this.resinHome, "updates", REINSTALL_RECOVERY_FILE_NAME);
  }

  private async persistReinstallRecovery(
    state: ReinstallSwapState,
    phase: ReinstallRecoveryIntent["phase"],
  ): Promise<void> {
    const intent: ReinstallRecoveryIntent = {
      schemaVersion: 1,
      targetVersion: state.targetVersion,
      candidateVersion: state.candidateVersion,
      rollbackVersion: state.rollbackVersion,
      phase,
    };
    await this.writeStateFile(
      this.reinstallRecoveryPath(),
      JSON.stringify(intent, null, 2),
      PRIVATE_FILE_MODE,
    );
  }

  private async removeReinstallRecovery(): Promise<void> {
    const recoveryPath = this.reinstallRecoveryPath();
    if (this.fsBridge === defaultFsBridge) {
      await fs.rm(recoveryPath, { force: true });
      return;
    }
    await this.fsBridge.unlink(recoveryPath);
  }

  private async recoverInterruptedReinstall(): Promise<void> {
    const recoveryPath = this.reinstallRecoveryPath();
    if (this.fsBridge === defaultFsBridge) {
      const stats = await fs.lstat(recoveryPath).catch(() => null);
      if (!stats) return;
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new UpdateVerificationError(
          "Same-version reinstall recovery intent is not a regular file.",
        );
      }
    }
    const raw = await this.fsBridge.readFile(recoveryPath);
    if (raw === null) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new UpdateVerificationError(
        `Same-version reinstall recovery intent is invalid JSON: ${safeDiagnostic(error)}`,
      );
    }
    const parsed = ReinstallRecoveryIntentSchema.safeParse(value);
    if (!parsed.success) {
      throw new UpdateVerificationError(
        `Same-version reinstall recovery intent is invalid: ${parsed.error.issues[0]?.message ?? "invalid data"}`,
      );
    }
    const intent = {
      ...parsed.data,
      targetVersion: normalizeExactVersion(parsed.data.targetVersion),
      candidateVersion: normalizeExactVersion(parsed.data.candidateVersion),
      rollbackVersion: normalizeExactVersion(parsed.data.rollbackVersion),
    };
    const activeVersion = await this.readActiveVersion(this.resinHome);
    const normalizedActive = activeVersion ? normalizeExactVersion(activeVersion) : null;
    if (
      normalizedActive !== null &&
      normalizedActive !== intent.candidateVersion &&
      normalizedActive !== intent.rollbackVersion
    ) {
      throw new UpdateVerificationError(
        `Cannot recover interrupted reinstall: active pointer names unexpected version '${normalizedActive}'.`,
      );
    }
    if (normalizedActive !== intent.rollbackVersion) {
      await this.switchVersion({
        resinHome: this.resinHome,
        targetVersion: intent.rollbackVersion,
        fsBridge: this.fsBridge,
      });
    }
    await this.removeReinstallRecovery();
  }

  private async restoreReinstallSwap(state: ReinstallSwapState): Promise<void> {
    if (!state.promoted) return;
    await this.removeReinstallRecovery();
    await this.removeVersion(state.candidateDir).catch(() => {});
    state.promoted = false;
  }

  private async cleanupReinstallSwap(state: ReinstallSwapState | undefined): Promise<void> {
    if (!state?.promoted) return;
    await this.removeReinstallRecovery();
    state.promoted = false;
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error("Update operation aborted.");
  }
  private async withTimeoutAndSignal<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    timeoutMessage: string,
  ): Promise<T> {
    this.throwIfAborted(signal);
    if (timeoutMs <= 0) {
      throw new Error(timeoutMessage);
    }
    let rejectRace: (reason?: unknown) => void = () => {};
    const racePromise = new Promise<T>((_resolve, reject) => {
      rejectRace = reject;
    });
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      rejectRace(
        signal?.reason instanceof Error ? signal.reason : new Error("Update operation aborted."),
      );
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      rejectRace(new Error(timeoutMessage));
    }, timeoutMs);

    try {
      return await Promise.race([promise, racePromise]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async rollbackActivation(options: {
    readonly backup: BackupState;
    readonly installed: VersionInstallResult;
    readonly reinstallSwap?: ReinstallSwapState;
    readonly rollbackTarget: string;
    readonly targetVersion: string;
    readonly serviceWasActive: boolean;
    readonly serviceStopped: boolean;
    readonly candidateStarted: boolean;
    readonly removeCandidateOnFailure: boolean;
    readonly steps: string[];
  }): Promise<RollbackOutcome> {
    options.steps.push("rollback_initiated");
    const errors: unknown[] = [];
    let serviceStopped = options.serviceStopped;
    let pointerRestored = false;
    let metadataRestored = false;
    let serviceRestored = false;
    let configConflict = false;

    if (!serviceStopped || options.candidateStarted) {
      try {
        await this.serviceManager.stop();
        serviceStopped = true;
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      if (options.reinstallSwap?.promoted) {
        await this.switchVersion({
          resinHome: this.resinHome,
          targetVersion: options.reinstallSwap.rollbackVersion,
          fsBridge: this.fsBridge,
        });
        await this.restoreReinstallSwap(options.reinstallSwap);
      } else {
        await this.switchVersion({
          resinHome: this.resinHome,
          targetVersion: options.rollbackTarget,
          fsBridge: this.fsBridge,
        });
      }
      pointerRestored = true;
    } catch (error) {
      errors.push(error);
    }

    try {
      configConflict = await this.restoreBackup(options.backup);
      metadataRestored = true;
    } catch (error) {
      errors.push(error);
    }

    if (
      options.removeCandidateOnFailure &&
      !options.reinstallSwap &&
      normalizeVersion(options.targetVersion) !== normalizeVersion(options.rollbackTarget)
    ) {
      await this.removeVersion(options.installed.versionDir).catch(() => {});
    }

    if (options.serviceWasActive) {
      try {
        await this.serviceManager.start();
        serviceStopped = false;
        serviceRestored = true;
      } catch (error) {
        errors.push(error);
      }
    } else if (serviceStopped) {
      serviceRestored = true;
    } else {
      try {
        await this.serviceManager.stop();
        serviceStopped = true;
        serviceRestored = true;
      } catch (error) {
        errors.push(error);
      }
    }

    const rolledBack = pointerRestored && metadataRestored && serviceRestored;
    options.steps.push(rolledBack ? "rollback_completed" : "rollback_failed");
    return {
      rolledBack,
      activeVersion: pointerRestored ? options.rollbackTarget : options.targetVersion,
      serviceStopped,
      configConflict,
      error: combineErrors(errors),
    };
  }

  private assertTrustedRelease(release: ResolvedProductionRelease): void {
    if (
      normalizeVersion(release.version) !== normalizeVersion(release.provenance.version) ||
      release.provenance.signingKeyIds.length === 0 ||
      !/^[a-f0-9]{64}$/i.test(normalizeSha256(release.provenance.channelSha256)) ||
      !/^[a-f0-9]{64}$/i.test(normalizeSha256(release.provenance.manifestSha256))
    ) {
      throw new UpdateVerificationError(
        "Signed release resolver returned incomplete or inconsistent provenance.",
      );
    }
  }

  private assertVerifiedDownload(
    download: DownloadedAssetResult,
    expectedSha256: string,
    label: string,
  ): void {
    if (
      !download.verified ||
      normalizeSha256(download.sha256) !== normalizeSha256(expectedSha256)
    ) {
      throw new UpdateVerificationError(`${label} checksum verification failed before staging.`);
    }
  }

  private isHealthy(probe: UpdateHealthProbeResult): boolean {
    return (
      probe.serviceActive &&
      probe.ipcResponsive &&
      probe.mcpResponsive &&
      !probe.recoveryBreakerTripped
    );
  }

  private createVerificationReport(
    probe: UpdateHealthProbeResult,
    attempts: number,
    elapsedMs: number,
  ): VerificationReport {
    const timestamp = this.nowIso();
    const check = (
      name: string,
      displayName: string,
      passed: boolean,
      message: string,
    ): VerificationCheckResult => ({
      name,
      displayName,
      status: passed ? "pass" : "fail",
      message,
      durationMs: elapsedMs,
      details: { attempts, probationMs: this.probationMs },
    });
    const checks = [
      check("service_state", "Daemon Service State", probe.serviceActive, "Daemon service active"),
      check(
        "daemon_ipc",
        "Daemon IPC Responsiveness",
        probe.ipcResponsive,
        "Daemon IPC responsive",
      ),
      check("gateway", "MCP Gateway Responsiveness", probe.mcpResponsive, "MCP gateway responsive"),
      check(
        "recovery_breaker",
        "Recovery Breaker",
        !probe.recoveryBreakerTripped,
        "Recovery breaker remains healthy",
      ),
    ];
    const passedChecks = checks.filter((item) => item.status === "pass").length;
    return {
      passed: passedChecks === checks.length,
      totalChecks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
      warnChecks: 0,
      checks,
      timestamp,
    };
  }

  private createSnapshot(currentVersion: string, channel: UpdateChannel): UpdateStatusSnapshot {
    return {
      schemaVersion: UPDATE_STATUS_SNAPSHOT_VERSION,
      channel,
      currentVersion,
      targetVersion: null,
      pendingVersion: null,
      lastCheckAt: null,
      lastResult: null,
      lastError: null,
      lastRollback: null,
      quarantine: [],
    };
  }

  private async readSnapshot(
    currentVersion: string,
    channel: UpdateChannel,
  ): Promise<UpdateStatusSnapshot> {
    const snapshot = await readUpdateStatusSnapshot({
      resinHome: this.resinHome,
      fsBridge: this.fsBridge,
    });
    return snapshot ?? this.createSnapshot(currentVersion, channel);
  }

  private async recoverCorruptSnapshot(
    currentVersion: string,
    channel: UpdateChannel,
    cause: unknown,
  ): Promise<UpdateStatusSnapshot> {
    const journalPath = resolveUpdateJournalPath(this.resinHome);
    const raw = await this.fsBridge.readFile(journalPath);
    if (raw !== null) {
      const corruptPath = path.join(
        this.resinHome,
        `journal.corrupt-${this.clock()}-${crypto.randomBytes(6).toString("hex")}.json`,
      );
      if (this.fsBridge === defaultFsBridge) {
        await fs.rename(journalPath, corruptPath);
        await fs.chmod(corruptPath, PRIVATE_FILE_MODE);
      } else {
        await this.fsBridge.writeFile(corruptPath, raw);
        await this.fsBridge.unlink(journalPath);
      }
    }
    const recovered: UpdateStatusSnapshot = {
      ...this.createSnapshot(currentVersion, channel),
      lastCheckAt: this.nowIso(),
      lastResult: "failed",
      lastError: `Recovered corrupt update journal: ${safeDiagnostic(cause)}`,
    };
    await this.persistSnapshot(recovered);
    return recovered;
  }

  private applySnapshotPatch(
    snapshot: UpdateStatusSnapshot,
    patch: Partial<UpdateStatusSnapshot>,
  ): UpdateStatusSnapshot {
    return {
      ...snapshot,
      ...patch,
      schemaVersion: UPDATE_STATUS_SNAPSHOT_VERSION,
      quarantine: patch.quarantine
        ? patch.quarantine.map((entry) => ({ ...entry }))
        : snapshot.quarantine.map((entry) => ({ ...entry })),
    };
  }

  private async recordSnapshot(
    snapshot: UpdateStatusSnapshot,
    patch: Partial<UpdateStatusSnapshot>,
  ): Promise<UpdateStatusSnapshot> {
    const next = this.applySnapshotPatch(snapshot, patch);
    await this.persistSnapshot(next);
    return next;
  }

  private async tryRecordSnapshot(
    snapshot: UpdateStatusSnapshot,
    patch: Partial<UpdateStatusSnapshot>,
  ): Promise<UpdateStatusSnapshot> {
    const next = this.applySnapshotPatch(snapshot, patch);
    try {
      await this.persistSnapshot(next);
    } catch {}
    return next;
  }

  private async writeAtomicNativeFile(
    filePath: string,
    content: string,
    mode: number,
  ): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", mode);
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.chmod(temporaryPath, mode);
      await fs.rename(temporaryPath, filePath);
      try {
        const directoryHandle = await fs.open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch {}
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  private async writeStateFile(filePath: string, content: string, mode: number): Promise<void> {
    if (this.fsBridge === defaultFsBridge) {
      await this.writeAtomicNativeFile(filePath, content, mode);
      return;
    }
    await this.fsBridge.writeFile(filePath, content);
  }

  private async persistSnapshot(snapshot: UpdateStatusSnapshot): Promise<void> {
    await this.fsBridge.mkdirp(this.resinHome);
    await this.writeStateFile(
      resolveUpdateJournalPath(this.resinHome),
      JSON.stringify(snapshot, null, 2),
      PRIVATE_FILE_MODE,
    );
    try {
      await this.onSnapshot?.(cloneSnapshot(snapshot));
    } catch {}
  }

  private withQuarantine(
    snapshot: UpdateStatusSnapshot,
    version: string,
    channel: UpdateChannel,
    cause: unknown,
  ): UpdateStatusSnapshot {
    const normalized = normalizeVersion(version);
    const entry: UpdateQuarantineEntry = {
      version: normalized,
      channel,
      quarantinedAt: this.nowIso(),
      reason: safeDiagnostic(cause),
    };
    const quarantine = snapshot.quarantine
      .filter((item) => normalizeVersion(item.version) !== normalized)
      .concat(entry)
      .slice(-64);
    return this.applySnapshotPatch(snapshot, { quarantine });
  }

  private async tryQuarantine(
    snapshot: UpdateStatusSnapshot,
    version: string,
    channel: UpdateChannel,
    cause: unknown,
  ): Promise<UpdateStatusSnapshot> {
    const next = this.withQuarantine(snapshot, version, channel, cause);
    try {
      await this.persistSnapshot(next);
    } catch {}
    return next;
  }

  private isQuarantined(snapshot: UpdateStatusSnapshot, version: string): boolean {
    const normalized = normalizeVersion(version);
    return snapshot.quarantine.some((entry) => normalizeVersion(entry.version) === normalized);
  }

  private async finishFailure(
    request: UpdateEngineRunRequest,
    snapshot: UpdateStatusSnapshot,
    currentVersion: string,
    targetVersion: string | undefined,
    cause: unknown,
    steps: string[],
  ): Promise<UpdateEngineResult> {
    const message = safeDiagnostic(cause);
    const next = await this.tryRecordSnapshot(snapshot, {
      targetVersion: targetVersion ?? snapshot.targetVersion,
      lastResult: "failed",
      lastError: message,
    });
    return this.createResult({
      request,
      snapshot: next,
      status: "failed",
      success: false,
      currentVersion,
      targetVersion,
      error: message,
      quarantined: targetVersion ? this.isQuarantined(next, targetVersion) : false,
      steps,
    });
  }

  private createResult(options: {
    readonly request: UpdateEngineRunRequest;
    readonly snapshot: UpdateStatusSnapshot;
    readonly status: UpdateRunStatus;
    readonly success: boolean;
    readonly currentVersion: string;
    readonly targetVersion?: string;
    readonly pendingVersion?: string;
    readonly staged?: boolean;
    readonly activated?: boolean;
    readonly healthGatePassed?: boolean;
    readonly rolledBack?: boolean;
    readonly quarantined?: boolean;
    readonly deferralReason?: UpdateDeferralReason;
    readonly error?: string;
    readonly backupPath?: string;
    readonly verificationReport?: VerificationReport;
    readonly steps: string[];
  }): UpdateEngineResult {
    return {
      success: options.success,
      mode: options.request.mode ?? "manual",
      status: options.status,
      channel: options.snapshot.channel,
      currentVersion: options.currentVersion,
      activeVersion: options.snapshot.currentVersion,
      targetVersion: options.targetVersion,
      pendingVersion: options.pendingVersion ?? options.snapshot.pendingVersion ?? undefined,
      staged: options.staged ?? false,
      activated: options.activated ?? false,
      healthGatePassed: options.healthGatePassed ?? false,
      rolledBack: options.rolledBack,
      quarantined: options.quarantined,
      deferralReason: options.deferralReason,
      error: options.error,
      backupPath: options.backupPath,
      verificationReport: options.verificationReport,
      stepsCompleted: options.steps,
      snapshot: cloneSnapshot(options.snapshot),
    };
  }

  private requestedChannelOrDefault(channel: UpdateEngineRunRequest["channel"]): UpdateChannel {
    return channel === "beta" || channel === "nightly" ? channel : "stable";
  }

  private nowIso(): string {
    const now = this.clock();
    if (!Number.isFinite(now))
      throw new TypeError("Update engine clock must return a finite time.");
    return new Date(now).toISOString();
  }
}
