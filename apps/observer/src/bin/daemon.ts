#!/usr/bin/env node

import child_process, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLocalStateStore } from "@resin/db";
import type { ActionableNotification } from "@resin/protocol";
import { z } from "zod";
import { CloudCredentialStore } from "../cloud-credentials.js";
import { CloudRuntimeModule } from "../cloud-runtime.js";
import {
  CONFIG_RECOVERY_WARNING_STATE_FILE_NAME,
  type ConfigRecoveryWarning,
  ConfigRecoveryWarningSchema,
  type DaemonConfig,
  DaemonConfigSchema,
  clearPersistedConfigRecoveryWarning,
  loadDaemonConfig,
  persistConfigRecoveryWarning,
  readPersistedConfigRecoveryWarning,
} from "../config.js";
import {
  ControlPlaneClient,
  ControlPlaneRuntimeModule,
  FileControlPlaneApplyAdapter,
} from "../control-plane.js";
import { IpcClient } from "../ipc/client.js";
import { IpcServer } from "../ipc/server.js";
import type { DaemonModule, Logger, ModuleContext } from "../lifecycle.js";
import { DaemonLock } from "../lock.js";
import type { JsonObject } from "../normalization/redaction.js";
import {
  ACTIONABLE_NOTIFICATION_OBSERVATION_INTERVAL_MS,
  reconcileObservedNotifications,
} from "../notifications.js";
import { type DaemonPaths, ensureDaemonDirectories, resolvePaths } from "../paths.js";
import {
  type ConfigReloadResult,
  type DaemonHealthReport,
  DaemonSupervisor,
  DefaultLogger,
  type ModuleStatusReport,
} from "../supervisor.js";
import { SourceCursorManager } from "../tailing/cursor-manager.js";
import {
  type RemoteTelemetryConsentSnapshot,
  TrajectoryCaptureRuntimeModule,
} from "../trajectory-capture-module.js";

function resolveVersion(): string {
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileURLToPath(candidate), "utf8"));
      const parsedObj = z.object({ version: z.string().min(1) }).safeParse(parsed);
      if (parsedObj.success) {
        return parsedObj.data.version;
      }
    } catch {
      // Continue to the next enclosing package candidate.
    }
  }
  return "0.1.0";
}

const CloudPrivacySettingsSchema = z
  .object({
    metadataTelemetryEnabled: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .passthrough();

const CloudPrivacySettingsEnvelopeSchema = z
  .object({ settings: CloudPrivacySettingsSchema })
  .passthrough();
const CloudPrivacyEnvelopeSchema = z.object({ privacy: CloudPrivacySettingsSchema }).passthrough();

export interface CloudTelemetryConsentOptions {
  credentialStore: Pick<CloudCredentialStore, "getRequestIdentity">;
  fetchImpl?: typeof fetch;
}

/**
 * Reads authoritative account telemetry consent. Missing credentials, invalid responses, auth
 * failures, and network failures are all unknown and therefore fail closed at the caller.
 */
export async function readCloudTelemetryConsent(
  options: CloudTelemetryConsentOptions,
): Promise<RemoteTelemetryConsentSnapshot | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await options.credentialStore
      .getRequestIdentity({ forceRefresh: attempt > 0 })
      .catch(() => null);
    if (!identity) {
      return null;
    }

    let response: Response;
    try {
      response = await fetchImpl(new URL("/api/user/privacy", `${identity.cloudUrl}/`), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${identity.accessToken}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return null;
    }

    if (response.status === 401 && attempt === 0) {
      continue;
    }
    if (!response.ok) {
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    const directSettings = CloudPrivacySettingsSchema.safeParse(body);
    if (directSettings.success) {
      return {
        metadataTelemetryEnabled: directSettings.data.metadataTelemetryEnabled,
        updatedAt: directSettings.data.updatedAt,
      };
    }
    const settingsEnvelope = CloudPrivacySettingsEnvelopeSchema.safeParse(body);
    if (settingsEnvelope.success) {
      return {
        metadataTelemetryEnabled: settingsEnvelope.data.settings.metadataTelemetryEnabled,
        updatedAt: settingsEnvelope.data.settings.updatedAt,
      };
    }
    const privacyEnvelope = CloudPrivacyEnvelopeSchema.safeParse(body);
    if (!privacyEnvelope.success) {
      return null;
    }
    return {
      metadataTelemetryEnabled: privacyEnvelope.data.privacy.metadataTelemetryEnabled,
      updatedAt: privacyEnvelope.data.privacy.updatedAt,
    };
  }
  return null;
}

const VERSION = process.env.RESIN_RELEASE_VERSION ?? resolveVersion();

const RecoveryCircuitBreakerSchema = z.enum(["HEALTHY", "DEGRADED", "TRIPPED"]);
type RecoveryCircuitBreaker = z.infer<typeof RecoveryCircuitBreakerSchema>;

const AuthRecoveryStatusSchema = z.enum([
  "AUTHENTICATED",
  "REFRESHING",
  "DEGRADED_OFFLINE",
  "UNAUTHENTICATED",
]);
type AuthRecoveryStatus = z.infer<typeof AuthRecoveryStatusSchema>;

const RecoveryFailureCategorySchema = z.enum([
  "AUTHENTICATION",
  "CONFIGURATION",
  "PORT_CONFLICT",
  "PERMISSION",
  "NETWORK",
  "RUNTIME",
  "UNKNOWN",
]);
type RecoveryFailureCategory = z.infer<typeof RecoveryFailureCategorySchema>;

const PersistedRecoveryStateSchema = z.object({
  version: z.literal(1),
  status: RecoveryCircuitBreakerSchema,
  restartCount: z.number().int().nonnegative(),
  lastFailure: z
    .object({
      timestamp: z.number().finite().nonnegative(),
      category: z.unknown(),
    })
    .passthrough()
    .optional(),
});

const AuthRecoveryDetailsSchema = z.object({
  status: AuthRecoveryStatusSchema,
});

interface RecoveryLastFailure {
  timestamp: number;
  category: RecoveryFailureCategory;
  remediation: string;
}

export interface RecoverySnapshot {
  restartCount: number;
  circuitBreaker: RecoveryCircuitBreaker;
  circuitBreakerTripped: boolean;
  authStatus: AuthRecoveryStatus;
  lastFailure?: RecoveryLastFailure;
  configurationWarning?: ConfigRecoveryWarning;
}

export interface EffectiveTelemetryStatus {
  deviceEnabled: boolean;
  cloudConsentEnabled: boolean | null;
  effectiveEnabled: boolean;
  captureActive: boolean;
  failClosed: boolean;
}

export interface RecoveryAwareHealthReport extends DaemonHealthReport {
  recovery: RecoverySnapshot;
  telemetry: EffectiveTelemetryStatus;
  notifications: ActionableNotification[];
}

const DaemonStartupMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("config-recovery-warning"),
      warning: ConfigRecoveryWarningSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ready"),
      pid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("startup-error"),
      message: z.string().min(1).max(2_048),
    })
    .strict(),
]);
type DaemonStartupMessage = z.infer<typeof DaemonStartupMessageSchema>;

const FAILURE_REMEDIATIONS = {
  AUTHENTICATION: "Run `resin login` to restore cloud access.",
  CONFIGURATION: "Run `resin doctor`, then `resin repair` if the problem persists.",
  PORT_CONFLICT: "Free the configured Resin port, then restart the service.",
  PERMISSION: "Check Resin state-directory permissions, then run `resin doctor`.",
  NETWORK: "Check network connectivity; local-only MCP operation remains available.",
  RUNTIME: "Run `resin doctor` and inspect the crash recovery log.",
  UNKNOWN: "Run `resin doctor` and inspect the crash recovery log.",
} satisfies Record<RecoveryFailureCategory, string>;

function getAuthRecoveryStatus(health: DaemonHealthReport): AuthRecoveryStatus {
  const authRecovery = AuthRecoveryDetailsSchema.safeParse(
    health.modules["cloud-runtime"]?.details?.authRecovery,
  );
  if (authRecovery.success) {
    return authRecovery.data.status;
  }
  return health.modules["cloud-runtime"]?.status === "ready" ? "AUTHENTICATED" : "UNAUTHENTICATED";
}

const MAX_RECOVERY_STATE_BYTES = 64 * 1024;

async function readBoundedRecoveryState(recoveryStatePath: string): Promise<JsonObject | null> {
  const entryStat = await fs.promises.lstat(recoveryStatePath);
  if (!entryStat.isFile()) {
    throw new Error(`Recovery state is not a regular file: ${recoveryStatePath}`);
  }
  if (entryStat.size > MAX_RECOVERY_STATE_BYTES) {
    throw new Error("Recovery state exceeds the safe status-read limit");
  }

  const handle = await fs.promises.open(recoveryStatePath, "r");
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== entryStat.dev ||
      openedStat.ino !== entryStat.ino
    ) {
      throw new Error("Recovery state changed while it was being inspected");
    }
    if (openedStat.size > MAX_RECOVERY_STATE_BYTES) {
      throw new Error("Recovery state exceeds the safe status-read limit");
    }

    const content = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== content.length) {
      throw new Error("Recovery state changed while it was being read");
    }
    const parsed = JSON.parse(content.toString("utf-8"));
    // SAFETY: Parsed recovery state JSON is an object matching JsonObject.
    return z.record(z.unknown()).safeParse(parsed).success ? (parsed as JsonObject) : null;
  } finally {
    await handle.close();
  }
}

export async function getRecoverySnapshot(
  paths: DaemonPaths,
  health?: DaemonHealthReport,
): Promise<RecoverySnapshot> {
  const authStatus = health ? getAuthRecoveryStatus(health) : "UNAUTHENTICATED";
  const recoveryStatePath = path.join(paths.stateDir, "recovery-state.json");
  const configWarningStatePath = path.join(paths.stateDir, CONFIG_RECOVERY_WARNING_STATE_FILE_NAME);

  let configurationWarning: ConfigRecoveryWarning | undefined;
  try {
    configurationWarning = await readPersistedConfigRecoveryWarning(configWarningStatePath);
  } catch {
    // Recovery state remains available even if the optional warning record is unreadable.
  }

  let snapshot: RecoverySnapshot;
  let persisted: unknown;
  try {
    persisted = await readBoundedRecoveryState(recoveryStatePath);
  } catch (err) {
    // SAFETY: Node.js filesystem error carries standard ErrnoException code.
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      snapshot = {
        restartCount: 0,
        circuitBreaker: "HEALTHY",
        circuitBreakerTripped: false,
        authStatus,
      };
    } else {
      const category: RecoveryFailureCategory =
        error.code === "EACCES" || error.code === "EPERM" ? "PERMISSION" : "CONFIGURATION";
      snapshot = {
        restartCount: 0,
        circuitBreaker: "DEGRADED",
        circuitBreakerTripped: false,
        authStatus,
        lastFailure: {
          timestamp: Date.now(),
          category,
          remediation: FAILURE_REMEDIATIONS[category],
        },
      };
    }
    if (configurationWarning) {
      snapshot.configurationWarning = configurationWarning;
      if (snapshot.circuitBreaker === "HEALTHY") {
        snapshot.circuitBreaker = "DEGRADED";
        snapshot.lastFailure = {
          timestamp: configurationWarning.detectedAt,
          category: "CONFIGURATION",
          remediation: configurationWarning.remediation,
        };
      }
    }
    return snapshot;
  }

  const recoveryState = PersistedRecoveryStateSchema.safeParse(persisted);
  if (!recoveryState.success) {
    snapshot = {
      restartCount: 0,
      circuitBreaker: "DEGRADED",
      circuitBreakerTripped: false,
      authStatus,
      lastFailure: {
        timestamp: Date.now(),
        category: "CONFIGURATION",
        remediation: FAILURE_REMEDIATIONS.CONFIGURATION,
      },
    };
  } else {
    const rawLastFailure = recoveryState.data.lastFailure;
    const parsedCategory = rawLastFailure
      ? RecoveryFailureCategorySchema.safeParse(rawLastFailure.category)
      : undefined;
    const category = parsedCategory?.success ? parsedCategory.data : "UNKNOWN";
    snapshot = {
      restartCount: recoveryState.data.restartCount,
      circuitBreaker: recoveryState.data.status,
      circuitBreakerTripped: recoveryState.data.status === "TRIPPED",
      authStatus,
      lastFailure: rawLastFailure
        ? {
            timestamp: rawLastFailure.timestamp,
            category,
            remediation: FAILURE_REMEDIATIONS[category],
          }
        : undefined,
    };
  }

  if (configurationWarning) {
    snapshot.configurationWarning = configurationWarning;
    if (snapshot.circuitBreaker === "HEALTHY") {
      snapshot.circuitBreaker = "DEGRADED";
      snapshot.lastFailure = {
        timestamp: configurationWarning.detectedAt,
        category: "CONFIGURATION",
        remediation: configurationWarning.remediation,
      };
    }
  }
  snapshot.circuitBreakerTripped = snapshot.circuitBreaker === "TRIPPED";
  return snapshot;
}

export class RecoveryAwareDaemonSupervisor extends DaemonSupervisor {
  private telemetryStatusProvider?: () => EffectiveTelemetryStatus;
  private readonly dynamicallyManagedModuleIds = new Set<string>();
  private notificationStateDir?: string;

  enableNotificationPersistence(stateDir: string): void {
    this.notificationStateDir = stateDir;
  }

  setTelemetryStatusProvider(provider: () => EffectiveTelemetryStatus): void {
    this.telemetryStatusProvider = provider;
  }

  trackDynamicModuleState(moduleId: string): void {
    this.dynamicallyManagedModuleIds.add(moduleId);
  }

  override getModuleStatus(moduleId?: string): ModuleStatusReport[] {
    return super.getModuleStatus(moduleId).map((status) => {
      if (!this.dynamicallyManagedModuleIds.has(status.id)) {
        return status;
      }
      const module = this.getModule(status.id);
      return module ? { ...status, state: module.getState() } : status;
    });
  }

  override async getHealth(): Promise<RecoveryAwareHealthReport> {
    const health = await super.getHealth();
    const recovery = await getRecoverySnapshot(this.getPaths(), health);
    let telemetry: EffectiveTelemetryStatus;
    try {
      telemetry = this.telemetryStatusProvider
        ? this.telemetryStatusProvider()
        : {
            deviceEnabled: this.getConfig().telemetryEnabled === true,
            cloudConsentEnabled: null,
            effectiveEnabled: false,
            captureActive: false,
            failClosed: false,
          };
    } catch {
      telemetry = {
        deviceEnabled: false,
        cloudConsentEnabled: null,
        effectiveEnabled: false,
        captureActive: false,
        failClosed: true,
      };
    }

    let notifications: ActionableNotification[] = [];
    if (this.notificationStateDir) {
      try {
        const inbox = await reconcileObservedNotifications(health, recovery, {
          stateDir: this.notificationStateDir,
        });
        notifications = inbox.notifications.map((entry) => entry.notification);
      } catch {
        // Notification persistence must not make daemon health unavailable.
      }
    }

    return {
      ...health,
      recovery,
      telemetry,
      notifications,
    };
  }
}

export interface TelemetryCaptureControllerOptions {
  supervisor: DaemonSupervisor;
  captureModule: TrajectoryCaptureRuntimeModule;
  logger: Logger;
  deviceEnabled: unknown;
  failClosed?: boolean;
  getCloudConsentEnabled?: () => boolean | null | undefined;
  refreshCloudConsentEnabled?: () => Promise<boolean | null | undefined>;
}

export function resolveDeviceTelemetryEnabled<T>(value: T, failClosed = false): boolean {
  if (failClosed) {
    return false;
  }
  if (value === false) {
    return false;
  }
  return value === true || value === undefined;
}

/**
 * Owns the capture module's dynamic registration and lifecycle without disturbing the cloud or
 * local IPC/MCP runtime modules.
 */
export class TelemetryCaptureController {
  private readonly supervisor: DaemonSupervisor;
  private readonly captureModule: TrajectoryCaptureRuntimeModule;
  private readonly logger: Logger;
  private readonly getCloudConsentEnabled?: () => boolean | null | undefined;
  private readonly refreshCloudConsentEnabled?: () => Promise<boolean | null | undefined>;
  private cloudConsentEnabled: boolean | null = null;
  private deviceEnabled: boolean;
  private failClosed: boolean;

  constructor(options: TelemetryCaptureControllerOptions) {
    this.supervisor = options.supervisor;
    this.captureModule = options.captureModule;
    this.logger = options.logger;
    this.getCloudConsentEnabled = options.getCloudConsentEnabled;
    this.refreshCloudConsentEnabled = options.refreshCloudConsentEnabled;
    this.failClosed = options.failClosed === true;
    this.deviceEnabled = resolveDeviceTelemetryEnabled(options.deviceEnabled, this.failClosed);
    const shouldCapture = this.getStatus().effectiveEnabled;
    if (shouldCapture && !this.captureModule.setTelemetryEnabled(true)) {
      this.failClosed = true;
    } else {
      this.captureModule.setTelemetryEnabled(shouldCapture);
    }
  }

  private readCloudConsent(): boolean | null {
    if (!this.getCloudConsentEnabled) {
      return this.cloudConsentEnabled;
    }
    try {
      const consent = this.getCloudConsentEnabled();
      this.cloudConsentEnabled = z.boolean().safeParse(consent).data ?? null;
    } catch {
      this.cloudConsentEnabled = null;
    }
    return this.cloudConsentEnabled;
  }

  private async refreshCloudConsent(): Promise<void> {
    if (!this.refreshCloudConsentEnabled) {
      this.readCloudConsent();
      return;
    }
    try {
      const consent = await this.refreshCloudConsentEnabled();
      this.cloudConsentEnabled = z.boolean().safeParse(consent).data ?? null;
    } catch {
      this.cloudConsentEnabled = null;
    }
  }

  private trackDynamicModuleState(): void {
    if (this.supervisor instanceof RecoveryAwareDaemonSupervisor) {
      this.supervisor.trackDynamicModuleState(this.captureModule.id);
    }
  }

  prepareForStartup(): void {
    const shouldCapture = this.getStatus().effectiveEnabled;
    if (shouldCapture && !this.captureModule.setTelemetryEnabled(true)) {
      this.failClosed = true;
      return;
    }
    this.captureModule.setTelemetryEnabled(shouldCapture);
    if (!shouldCapture) {
      return;
    }
    const existingModule = this.supervisor.getModule(this.captureModule.id);
    if (existingModule && existingModule !== this.captureModule) {
      throw new Error(`Unexpected module registered as '${this.captureModule.id}'`);
    }
    if (!existingModule) {
      this.supervisor.registerModule(this.captureModule);
    }
  }

  async setDeviceTelemetryEnabled<T>(
    enabled: T,
    options: { failClosed?: boolean } = {},
  ): Promise<void> {
    // Close both emitter and subscription gates before any asynchronous work so withdrawal wins.
    this.captureModule.setTelemetryEnabled(false);
    const moduleState = this.captureModule.getState();
    if (
      moduleState !== "uninitialized" &&
      moduleState !== "stopped" &&
      moduleState !== "stopping"
    ) {
      await this.captureModule.stop();
      this.trackDynamicModuleState();
    }

    this.failClosed = options.failClosed === true;
    this.deviceEnabled = resolveDeviceTelemetryEnabled(enabled, this.failClosed);
    if (this.deviceEnabled && !this.failClosed) {
      await this.refreshCloudConsent();
    }
    const shouldCapture = this.getStatus().effectiveEnabled;
    if (!shouldCapture) {
      return;
    }

    const existingModule = this.supervisor.getModule(this.captureModule.id);
    if (existingModule && existingModule !== this.captureModule) {
      this.failClosed = true;
      throw new Error(`Unexpected module registered as '${this.captureModule.id}'`);
    }

    if (!this.captureModule.setTelemetryEnabled(true)) {
      this.failClosed = true;
      throw new Error("Telemetry privacy checkpoint could not be persisted");
    }
    if (!existingModule) {
      this.supervisor.registerModule(this.captureModule);
    }

    if (this.supervisor.currentState === "ready") {
      const context: ModuleContext = {
        config: this.supervisor.getConfig(),
        paths: this.supervisor.getPaths(),
        logger: this.logger,
        getModule: <T extends DaemonModule>(id: string) => this.supervisor.getModule<T>(id),
      };
      try {
        await this.captureModule.start(context);
        this.trackDynamicModuleState();
      } catch (error) {
        this.failClosed = true;
        this.deviceEnabled = false;
        this.captureModule.setTelemetryEnabled(false);
        this.trackDynamicModuleState();
        throw error;
      }
    }
  }

  getStatus(): EffectiveTelemetryStatus {
    const cloudConsentEnabled = this.readCloudConsent();
    const effectiveEnabled = this.deviceEnabled && !this.failClosed && cloudConsentEnabled === true;
    return {
      deviceEnabled: this.deviceEnabled,
      cloudConsentEnabled,
      effectiveEnabled,
      captureActive:
        effectiveEnabled &&
        this.captureModule.isTelemetryEnabled() &&
        this.captureModule.getState() === "ready",
      failClosed: this.failClosed,
    };
  }
}

export interface LoadedTelemetryConfig {
  config: DaemonConfig;
  warning?: ConfigRecoveryWarning;
}

export interface TelemetryReloadHandlerOptions {
  supervisor: DaemonSupervisor;
  captureController: TelemetryCaptureController;
  loadConfig: () => LoadedTelemetryConfig;
  onWarning?: (warning: ConfigRecoveryWarning) => Promise<void>;
  onValidConfig?: () => Promise<void>;
  logger?: Logger;
}

/**
 * Builds an authenticated IPC reload handler. Concurrent callers are serialized in arrival order
 * so the last accepted write determines final state; every failure closes both capture boundaries.
 */
export function createTelemetryReloadHandler(
  options: TelemetryReloadHandlerOptions,
): (config?: Partial<DaemonConfig>) => Promise<ConfigReloadResult> {
  let reloadQueue: Promise<void> = Promise.resolve();

  const performReload = async (
    configUpdate?: Partial<DaemonConfig>,
  ): Promise<ConfigReloadResult> => {
    try {
      const wasFailClosed = options.captureController.getStatus().failClosed;
      await options.captureController.setDeviceTelemetryEnabled(false, { failClosed: true });

      let warning: ConfigRecoveryWarning | undefined;
      let reloadResult: ConfigReloadResult;
      if (configUpdate === undefined) {
        const loaded = options.loadConfig();
        warning = loaded.warning;
        if (warning) {
          await options.onWarning?.(warning);
          return {
            success: false,
            reloadedModules: [],
            errors: ["Configuration reload failed closed"],
            config: { telemetryEnabled: false },
          };
        }
        reloadResult = await options.supervisor.reloadConfig(loaded.config);
      } else {
        reloadResult = await options.supervisor.reloadConfig(configUpdate);
      }

      if (!reloadResult.success) {
        return {
          success: false,
          reloadedModules: [],
          errors: ["Configuration reload failed closed"],
          config: { telemetryEnabled: false },
        };
      }

      if (configUpdate === undefined) {
        await options.onValidConfig?.();
      }
      const remainFailClosed = configUpdate !== undefined && wasFailClosed;
      const deviceEnabled = resolveDeviceTelemetryEnabled(
        options.supervisor.getConfig().telemetryEnabled,
        remainFailClosed,
      );
      await options.captureController.setDeviceTelemetryEnabled(deviceEnabled, {
        failClosed: remainFailClosed,
      });
      if (remainFailClosed) {
        return {
          success: false,
          reloadedModules: [],
          errors: ["Configuration reload failed closed"],
          config: { telemetryEnabled: false },
        };
      }
      return {
        success: true,
        reloadedModules: reloadResult.reloadedModules,
        errors: [],
        config: { telemetryEnabled: options.captureController.getStatus().deviceEnabled },
      };
    } catch (error) {
      options.logger?.error("Configuration reload failed closed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await options.captureController
        .setDeviceTelemetryEnabled(false, { failClosed: true })
        .catch(() => undefined);
      return {
        success: false,
        reloadedModules: [],
        errors: ["Configuration reload failed closed"],
        config: { telemetryEnabled: false },
      };
    }
  };
  return (configUpdate?: Partial<DaemonConfig>) => {
    const operation = reloadQueue.then(() => performReload(configUpdate));
    reloadQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

function printHelp(): void {
  console.log(`
Resin Daemon v${VERSION}

Usage:
  resin-daemon [options]
  resin-daemon <command> [options]

Commands:
  --status              Query the status and health of the running daemon
  --stop                Gracefully shut down the running daemon
  --reload              Reload configuration for the running daemon
  --diagnostics         Print full diagnostics report from the running daemon

Options:
  -f, --foreground      Run in foreground development mode (default is background daemon)
  -c, --config <path>   Path to custom configuration file
  --home <path>         Custom RESIN_HOME directory
  --port <port>         Port override for local services
  --socket <path>       Unix domain socket path override
  -v, --version         Print version and exit
  -h, --help            Print this help message and exit
`);
}

export async function handleIpcCommand(
  command: "status" | "stop" | "reload" | "diagnostics",
  paths: DaemonPaths,
): Promise<number> {
  const client = new IpcClient({
    socketPath: paths.socketPath,
    timeoutMs: 5000,
  });

  try {
    await client.connect();

    switch (command) {
      case "status": {
        // SAFETY: Daemon health response contains DaemonHealthReport and optional recovery metadata.
        const health = (await client.getHealth()) as DaemonHealthReport & {
          recovery?: RecoverySnapshot;
        };
        const recovery = health.recovery ?? (await getRecoverySnapshot(paths, health));
        console.log(JSON.stringify({ ...health, recovery }, null, 2));
        break;
      }
      case "stop": {
        const result = await client.gracefulShutdown({ reason: "CLI --stop command" });
        console.log(`Shutdown response: ${result.message}`);
        break;
      }
      case "reload": {
        const result = await client.reloadConfig();
        console.log(`Config reload: ${result.success ? "SUCCESS" : "FAILED"}`);
        if (result.errors.length > 0) {
          console.error("Errors:", result.errors);
        }
        break;
      }
      case "diagnostics": {
        const diagnostics = await client.getDiagnostics();
        // SAFETY: Support bundle health property matches DaemonHealthReport and optional recovery metadata.
        const health = diagnostics.health as DaemonHealthReport & {
          recovery?: RecoverySnapshot;
        };
        const recovery = health.recovery ?? (await getRecoverySnapshot(paths, health));
        console.log(
          JSON.stringify(
            {
              ...diagnostics,
              health: { ...health, recovery },
              recovery,
            },
            null,
            2,
          ),
        );
        break;
      }
    }

    await client.close();
    return 0;
  } catch (err) {
    await client.close().catch(() => undefined);
    if (command === "status" || command === "diagnostics") {
      const recovery = await getRecoverySnapshot(paths);
      console.log(
        JSON.stringify(
          {
            status: "unavailable",
            daemonReachable: false,
            recovery,
          },
          null,
          2,
        ),
      );
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to connect or execute command on daemon: ${errorMsg}`);
    return 1;
  }
}

function sendStartupMessage(message: DaemonStartupMessage): void {
  if (!process.connected || !process.send) return;
  try {
    process.send(message);
  } catch {
    // The foreground daemon remains usable if its short-lived parent has exited.
  }
}

function sanitizeStartupError<T>(error: T): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(
      /\b(token|secret|password|authorization|credential)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 2_048);
}

export interface TelemetrySafeDaemonConfigLoadOptions {
  configPath: string;
  port?: number;
  socketPath?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Loads daemon configuration without sacrificing local continuity. Any unreadable or
 * schema-invalid source is represented by a sanitized warning and telemetry-disabled defaults.
 */
export function loadTelemetrySafeDaemonConfig(
  options: TelemetrySafeDaemonConfigLoadOptions,
): LoadedTelemetryConfig {
  let warning: ConfigRecoveryWarning | undefined;
  try {
    const config = loadDaemonConfig({
      configPath: options.configPath,
      env: options.env,
      overrides: {
        port: options.port,
        socketPath: options.socketPath,
      },
      onWarning: (nextWarning) => {
        warning = nextWarning;
      },
    });
    return {
      config: warning ? DaemonConfigSchema.parse({ ...config, telemetryEnabled: false }) : config,
      warning,
    };
  } catch {
    const fallbackWarning = ConfigRecoveryWarningSchema.parse({
      category: "MALFORMED_CONFIG",
      detectedAt: options.now?.() ?? Date.now(),
      configPath: options.configPath,
      backupPath: options.configPath,
      remediation: "Fix or replace the daemon configuration, then request an authenticated reload.",
      message:
        "WARNING: Resin could not safely load the daemon configuration. The original file was left untouched; the daemon is continuing in local-only mode with telemetry disabled.",
    });
    return {
      config: DaemonConfigSchema.parse({
        port: options.port,
        socketPath: options.socketPath,
        telemetryEnabled: false,
      }),
      warning: fallbackWarning,
    };
  }
}

export async function persistAndSurfaceConfigRecoveryWarning(
  paths: DaemonPaths,
  warning: ConfigRecoveryWarning,
): Promise<void> {
  const warningStatePath = path.join(paths.stateDir, CONFIG_RECOVERY_WARNING_STATE_FILE_NAME);
  try {
    await persistConfigRecoveryWarning(warningStatePath, warning);
  } catch {
    console.error(
      `WARNING: Resin could not persist its malformed-config recovery notice at ${warningStatePath}.`,
    );
  }

  console.error(warning.message);
}

async function runForeground(options: {
  configPath?: string;
  home?: string;
  port?: number;
  socketPath?: string;
}): Promise<void> {
  const paths = resolvePaths({
    home: options.home,
    socketPath: options.socketPath,
    configFile: options.configPath,
  });

  await ensureDaemonDirectories(paths);

  const loadedConfig = loadTelemetrySafeDaemonConfig({
    configPath: paths.configFile,
    port: options.port,
    socketPath: paths.socketPath,
  });
  const config = loadedConfig.config;
  let configRecoveryWarning = loadedConfig.warning;

  if (configRecoveryWarning) {
    await persistAndSurfaceConfigRecoveryWarning(paths, configRecoveryWarning);
    sendStartupMessage({
      type: "config-recovery-warning",
      warning: configRecoveryWarning,
    });
  }

  const logger = new DefaultLogger(config.logLevel);
  const lock = new DaemonLock({
    lockPath: paths.lockFilePath,
    socketPath: paths.socketPath,
    version: config.version,
    staleThresholdMs: config.lockStaleThresholdMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });

  const lockResult = await lock.acquire();
  if (lockResult.status === "already_running") {
    throw new Error(
      `Resin daemon is already running${lockResult.pid ? ` (PID: ${lockResult.pid})` : ""}`,
    );
  }
  if (!configRecoveryWarning) {
    const configWarningStatePath = path.join(
      paths.stateDir,
      CONFIG_RECOVERY_WARNING_STATE_FILE_NAME,
    );
    try {
      await clearPersistedConfigRecoveryWarning(configWarningStatePath);
    } catch {
      logger.warn(
        `Unable to clear the persisted config recovery warning at ${configWarningStatePath}`,
      );
    }
  }

  if (lockResult.status === "stale_recovered") {
    logger.warn(
      `Recovered stale lock from inactive daemon (previous PID: ${lockResult.previousLockData?.pid})`,
    );
  }
  if (lockResult.quarantinedLockPath) {
    logger.info(`Quarantined inactive daemon lock at ${lockResult.quarantinedLockPath}`);
  }
  for (const recoveredSocketPath of lockResult.recoveredSocketPaths ?? []) {
    logger.info(`Removed orphaned daemon socket at ${recoveredSocketPath}`);
  }

  try {
    await fs.promises.writeFile(paths.pidFilePath, String(process.pid), { mode: 0o644 });
  } catch {
    // Ignore error writing PID file.
  }
  const stateDbPath = path.join(paths.dataDir, "state.db");
  const stateStore = createLocalStateStore({ path: stateDbPath });
  await stateStore.initialize();
  const cursorManager = new SourceCursorManager({ store: stateStore });

  const supervisor = new RecoveryAwareDaemonSupervisor({
    config,
    paths,
    logger,
    enableSignalHandlers: false,
  });
  supervisor.enableNotificationPersistence(paths.stateDir);
  const credentialStore = new CloudCredentialStore({
    home: paths.homeDir,
    tokenFilePath: path.join(paths.stateDir, "device-token.json"),
  });
  const cloudRuntimeModule = new CloudRuntimeModule({ credentialStore });
  supervisor.registerModule(cloudRuntimeModule);
  const deviceTelemetryEnabled = resolveDeviceTelemetryEnabled(
    config.telemetryEnabled,
    Boolean(configRecoveryWarning),
  );
  let cloudConsent: RemoteTelemetryConsentSnapshot | null = deviceTelemetryEnabled
    ? await readCloudTelemetryConsent({ credentialStore })
    : null;
  const refreshCloudConsent = async (): Promise<RemoteTelemetryConsentSnapshot | null> => {
    cloudConsent = await readCloudTelemetryConsent({ credentialStore });
    return cloudConsent;
  };
  const trajectoryCaptureModule = new TrajectoryCaptureRuntimeModule({
    getObservationClient: () => cloudRuntimeModule.getObservationClient(),
    cursorManager,
    logger,
    telemetryEnabled: deviceTelemetryEnabled && cloudConsent?.metadataTelemetryEnabled === true,
    remoteTelemetryConsent: cloudConsent,
    refreshRemoteTelemetryConsent: refreshCloudConsent,
    privacyCheckpointPath: path.join(paths.stateDir, "telemetry-privacy-checkpoint.json"),
  });
  const telemetryController = new TelemetryCaptureController({
    supervisor,
    captureModule: trajectoryCaptureModule,
    logger,
    deviceEnabled: deviceTelemetryEnabled,
    failClosed: Boolean(configRecoveryWarning),
    getCloudConsentEnabled: () => cloudConsent?.metadataTelemetryEnabled ?? null,
    refreshCloudConsentEnabled: async () =>
      (await refreshCloudConsent())?.metadataTelemetryEnabled ?? null,
  });
  telemetryController.prepareForStartup();
  supervisor.setTelemetryStatusProvider(() => telemetryController.getStatus());

  const reloadConfig = createTelemetryReloadHandler({
    supervisor,
    captureController: telemetryController,
    loadConfig: () =>
      loadTelemetrySafeDaemonConfig({
        configPath: paths.configFile,
        port: options.port,
        socketPath: paths.socketPath,
      }),
    onWarning: async (warning) => {
      configRecoveryWarning = warning;
      await persistAndSurfaceConfigRecoveryWarning(paths, warning);
    },
    onValidConfig: async () => {
      configRecoveryWarning = undefined;
      const warningStatePath = path.join(paths.stateDir, CONFIG_RECOVERY_WARNING_STATE_FILE_NAME);
      try {
        await clearPersistedConfigRecoveryWarning(warningStatePath);
      } catch {
        logger.warn("Unable to clear persisted config recovery warning after reload");
      }
    },
    logger,
  });

  const controlCredentials = await credentialStore.load();
  if (controlCredentials.credentials) {
    const controlPlaneClient = new ControlPlaneClient({
      identityProvider: (identityOptions) => credentialStore.getRequestIdentity(identityOptions),
    });
    supervisor.registerModule(
      new ControlPlaneRuntimeModule({
        client: controlPlaneClient,
        deviceId: controlCredentials.credentials.deviceId,
        applyAdapter: new FileControlPlaneApplyAdapter({
          reloadConfig: async () => {
            const result = await reloadConfig();
            const json: JsonObject = {
              success: result.success,
            };
            return json;
          },
        }),
      }),
    );
  }

  const ipcServer = new IpcServer({
    supervisor,
    socketPath: paths.socketPath,
    logger,
    reloadConfig,
  });
  logger.info(`Starting Resin daemon in foreground (PID: ${process.pid})`);

  await supervisor.start();
  await supervisor.getHealth();
  const notificationObserver = setInterval(() => {
    void supervisor.getHealth().catch(() => undefined);
  }, ACTIONABLE_NOTIFICATION_OBSERVATION_INTERVAL_MS);
  notificationObserver.unref();
  await ipcServer.start();
  sendStartupMessage({ type: "ready", pid: process.pid });

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (reason: string): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    clearInterval(notificationObserver);
    cleanupPromise = (async () => {
      logger.info("Cleaning up daemon resources...");
      try {
        await supervisor.stop({ reason });
      } catch {
        // Ignore shutdown errors while releasing process resources.
      }
      try {
        stateStore.close();
      } catch {
        // Ignore database close errors on shutdown.
      }
      try {
        await ipcServer.stop();
      } catch {
        // Ignore.
      }
      try {
        await lock.release();
      } catch {
        // Ignore.
      }
      try {
        if (fs.existsSync(paths.pidFilePath)) {
          await fs.promises.unlink(paths.pidFilePath);
        }
      } catch {
        // Ignore.
      }
    })();
    return cleanupPromise;
  };

  let exitRequested = false;
  const exitAfterCleanup = (reason: string) => {
    if (exitRequested) return;
    exitRequested = true;
    void cleanup(reason).finally(() => process.exit(0));
  };

  process.once("SIGINT", () => exitAfterCleanup("SIGINT"));
  process.once("SIGTERM", () => exitAfterCleanup("SIGTERM"));

  const shutdownWatcher = setInterval(() => {
    if (supervisor.currentState === "stopped") {
      clearInterval(shutdownWatcher);
      exitAfterCleanup("IPC graceful shutdown");
    }
  }, 100);
  shutdownWatcher.unref();
}

export interface BackgroundDaemonStartupOptions {
  timeoutMs?: number;
  onWarning?: (warning: ConfigRecoveryWarning) => void;
}

export async function awaitBackgroundDaemonStartup(
  child: ChildProcess,
  options: BackgroundDaemonStartupOptions = {},
): Promise<number> {
  const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? 15_000));
  const { promise, resolve, reject } = Promise.withResolvers<number>();

  const onMessage = <M>(message: M): void => {
    const parsed = DaemonStartupMessageSchema.safeParse(message);
    if (!parsed.success) return;
    if (parsed.data.type === "config-recovery-warning") {
      options.onWarning?.(parsed.data.warning);
      return;
    }
    if (parsed.data.type === "startup-error") {
      reject(new Error(parsed.data.message));
      return;
    }
    resolve(parsed.data.pid);
  };
  const onError = (error: Error): void => {
    reject(error);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    reject(
      new Error(
        `Background daemon exited before startup completed (code: ${code ?? "none"}, signal: ${signal ?? "none"})`,
      ),
    );
  };

  child.on("message", onMessage);
  child.once("error", onError);
  child.once("exit", onExit);
  const timeout = setTimeout(() => {
    reject(new Error(`Background daemon startup timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
    child.off("message", onMessage);
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

async function runBackground(
  argv: string[],
  _options: {
    configPath?: string;
    home?: string;
    port?: number;
    socketPath?: string;
  },
): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const childArgs = [
    currentFile,
    "--foreground",
    ...argv.filter((argument) => argument !== "--daemon" && argument !== "-d"),
  ];

  const child = child_process.spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.env,
  });

  try {
    const childPid = await awaitBackgroundDaemonStartup(child, {
      onWarning: (warning) => console.error(warning.message),
    });
    if (child.connected) child.disconnect();
    child.unref();
    console.log(`Resin daemon started in background (PID: ${childPid})`);
  } catch (err) {
    if (child.connected) child.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    child.unref();
    throw err;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let foreground = false;
  let configPath: string | undefined;
  let home: string | undefined;
  let port: number | undefined;
  let socketPath: string | undefined;
  let command: "status" | "stop" | "reload" | "diagnostics" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "-v" || arg === "--version") {
      console.log(`resin-daemon v${VERSION}`);
      process.exit(0);
    } else if (arg === "-f" || arg === "--foreground") {
      foreground = true;
    } else if (arg === "--status") {
      command = "status";
    } else if (arg === "--stop") {
      command = "stop";
    } else if (arg === "--reload") {
      command = "reload";
    } else if (arg === "--diagnostics") {
      command = "diagnostics";
    } else if (arg === "-c" || arg === "--config") {
      configPath = argv[++i];
    } else if (arg === "--home") {
      home = argv[++i];
    } else if (arg === "--port") {
      port = Number.parseInt(argv[++i], 10);
    } else if (arg === "--socket") {
      socketPath = argv[++i];
    }
  }

  const paths = resolvePaths({ home, socketPath, configFile: configPath });

  if (command) {
    const exitCode = await handleIpcCommand(command, paths);
    process.exit(exitCode);
  }

  if (foreground) {
    await runForeground({ configPath, home, port, socketPath });
  } else {
    await runBackground(argv, { configPath, home, port, socketPath });
  }
}

if (!process.env.VITEST) {
  main().catch((err) => {
    const message = sanitizeStartupError(err);
    sendStartupMessage({
      type: "startup-error",
      message: message || "Resin daemon startup failed",
    });
    console.error("Fatal error in daemon CLI:", err);
    process.exit(1);
  });
}
