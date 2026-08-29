import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ActionableNotification,
  ActionableNotificationSchema,
  type NotificationInboxState,
  NotificationInboxStateSchema,
  createEmptyNotificationInboxState,
  markNotificationsAlerted,
  reconcileNotificationInbox,
  selectDueNotifications,
} from "@resin/protocol";
import { z } from "zod";
import { type DaemonPaths, type PathResolutionOptions, resolvePaths } from "./paths.js";
import type { DaemonHealthReport } from "./supervisor.js";

export const NOTIFICATION_INBOX_FILE_NAME = "notification-inbox.json";
export const HARNESS_HEALTH_STATE_FILE_NAME = "harness-health.json";
export const ACTIONABLE_NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1_000;
export const ACTIONABLE_NOTIFICATION_OBSERVATION_INTERVAL_MS = 60_000;

export const OBSERVER_NOTIFICATION_IDS = {
  authSessionExpired: "auth.session-expired",
  harnessIntegrationFailed: "harness.integration-failed",
  daemonBackgroundFailed: "daemon.background-failed",
  networkSyncDegraded: "network.sync-degraded",
} as const;

export const OBSERVER_MANAGED_NOTIFICATION_IDS = Object.freeze(
  Object.values(OBSERVER_NOTIFICATION_IDS),
);

const MAX_NOTIFICATION_INBOX_BYTES = 512 * 1024;
const MAX_HARNESS_HEALTH_BYTES = 512 * 1024;
const INBOX_LOCK_RETRY_MS = 10;
const INBOX_LOCK_TIMEOUT_MS = 2_000;
const INBOX_STALE_LOCK_MS = 30_000;

const HarnessHealthStateSchema = z
  .object({
    format: z.literal("resin-harness-health/v1"),
    success: z.boolean(),
    hasDrift: z.boolean(),
    settingsDiagnostic: z.string().min(1).optional(),
    harnesses: z
      .array(
        z
          .object({
            installed: z.boolean(),
            condition: z.enum(["healthy", "missing", "drifted", "corrupt", "not_installed"]),
          })
          .passthrough(),
      )
      .max(32),
    lastFailure: z
      .object({
        code: z.literal("check_failed"),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type HarnessIntegrationState = "healthy" | "failing" | "unknown";

export interface ObserverRecoveryNotificationState {
  readonly circuitBreaker?: "HEALTHY" | "DEGRADED" | "TRIPPED";
  readonly circuitBreakerTripped?: boolean;
  readonly configurationWarning?: unknown;
}

export interface ObserverNotificationObservation {
  readonly health: DaemonHealthReport;
  readonly recovery?: ObserverRecoveryNotificationState;
  readonly harnessIntegration?: HarnessIntegrationState;
  readonly observedAt?: Date | number;
}

export interface NotificationInboxOptions extends PathResolutionOptions {
  readonly inboxPath?: string;
  readonly now?: Date | number;
  readonly managedIds?: readonly string[];
  readonly lockTimeoutMs?: number;
}

function toTimestamp(value: Date | number | undefined): { milliseconds: number; iso: string } {
  const milliseconds = value instanceof Date ? value.getTime() : (value ?? Date.now());
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError("Notification time must be a non-negative finite timestamp");
  }
  const iso = new Date(milliseconds).toISOString();
  return { milliseconds, iso };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNotificationInboxPathFromOptions(options: NotificationInboxOptions): string {
  return options.inboxPath
    ? path.resolve(options.inboxPath)
    : path.join(resolvePaths(options).stateDir, NOTIFICATION_INBOX_FILE_NAME);
}

export function getNotificationInboxPath(options: NotificationInboxOptions = {}): string {
  return getNotificationInboxPathFromOptions(options);
}

async function readInboxFile(filePath: string): Promise<NotificationInboxState> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_NOTIFICATION_INBOX_BYTES) {
      return createEmptyNotificationInboxState();
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const parsed = NotificationInboxStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : createEmptyNotificationInboxState();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return createEmptyNotificationInboxState();
    return createEmptyNotificationInboxState();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeInboxFile(filePath: string, state: NotificationInboxState): Promise<void> {
  const parsed = NotificationInboxStateSchema.parse(state);
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
    await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function acquireInboxLock(lockPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    try {
      const stats = await fs.promises.lstat(lockPath);
      if (stats.isDirectory() && Date.now() - stats.mtimeMs >= INBOX_STALE_LOCK_MS) {
        await fs.promises.rmdir(lockPath);
        continue;
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
    }

    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the notification inbox lock");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, INBOX_LOCK_RETRY_MS);
    await promise;
  }
}

async function mutateNotificationInbox<T>(
  options: NotificationInboxOptions,
  mutate: (state: NotificationInboxState) => { state: NotificationInboxState; value: T },
): Promise<T> {
  const filePath = getNotificationInboxPathFromOptions(options);
  const lockPath = `${filePath}.lock`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await acquireInboxLock(lockPath, options.lockTimeoutMs ?? INBOX_LOCK_TIMEOUT_MS);
  try {
    const previous = await readInboxFile(filePath);
    const result = mutate(previous);
    await writeInboxFile(filePath, result.state);
    return result.value;
  } finally {
    await fs.promises.rmdir(lockPath).catch(() => undefined);
  }
}

export async function readNotificationInbox(
  options: NotificationInboxOptions = {},
): Promise<NotificationInboxState> {
  return readInboxFile(getNotificationInboxPathFromOptions(options));
}

function parseObservedNotifications(
  notifications: readonly ActionableNotification[],
): ActionableNotification[] {
  return notifications.map((notification) => ActionableNotificationSchema.parse(notification));
}

export async function reconcileNotifications(
  active: readonly ActionableNotification[],
  options: NotificationInboxOptions = {},
): Promise<NotificationInboxState> {
  const observed = parseObservedNotifications(active);
  return mutateNotificationInbox(options, (previous) => {
    const state = reconcileNotificationInbox(previous, observed, options.managedIds);
    return { state, value: state };
  });
}

export async function selectPersistedDueNotifications(
  options: NotificationInboxOptions = {},
): Promise<ActionableNotification[]> {
  const now = toTimestamp(options.now);
  return selectDueNotifications(await readNotificationInbox(options), now.milliseconds);
}

export async function markPersistedNotificationsAlerted(
  notificationIds: readonly string[],
  options: NotificationInboxOptions = {},
): Promise<NotificationInboxState> {
  const now = toTimestamp(options.now);
  return mutateNotificationInbox(options, (previous) => {
    const state = markNotificationsAlerted(previous, notificationIds, now.milliseconds);
    return { state, value: state };
  });
}

/**
 * Reconciles the caller's managed observations and consumes every due notification
 * under one cross-process lock. A notification is marked alerted before it is returned.
 */
export async function consumeDueNotifications(
  active: readonly ActionableNotification[],
  options: NotificationInboxOptions = {},
): Promise<ActionableNotification[]> {
  const observed = parseObservedNotifications(active);
  const now = toTimestamp(options.now);
  return mutateNotificationInbox(options, (previous) => {
    const reconciled = reconcileNotificationInbox(previous, observed, options.managedIds);
    const due = selectDueNotifications(reconciled, now.milliseconds);
    const state = markNotificationsAlerted(
      reconciled,
      due.map((notification) => notification.id),
      now.milliseconds,
    );
    return { state, value: due };
  });
}

function makeNotification(
  notification: Omit<ActionableNotification, "timestamp" | "cooldownMs">,
  timestamp: string,
): ActionableNotification {
  return ActionableNotificationSchema.parse({
    ...notification,
    timestamp,
    cooldownMs: ACTIONABLE_NOTIFICATION_COOLDOWN_MS,
  });
}

function hasActionableAuthFailure(health: DaemonHealthReport): boolean {
  const cloud = health.modules["cloud-runtime"];
  const details = asRecord(cloud?.details);
  const credentialStatus = details?.credentialStatus ?? details?.status;
  if (credentialStatus === "expired" || credentialStatus === "invalid") return true;

  const authRecovery = asRecord(details?.authRecovery);
  const category = authRecovery?.category;
  return (
    (authRecovery?.status === "DEGRADED_OFFLINE" || authRecovery?.status === "UNAUTHENTICATED") &&
    category !== undefined &&
    category !== null &&
    category !== "REFRESH_UNAVAILABLE"
  );
}

function hasHarnessIntegrationFailure(
  health: DaemonHealthReport,
  harnessIntegration: HarnessIntegrationState | undefined,
): boolean {
  if (harnessIntegration === "failing" || health.status === "adapter-degraded") return true;
  for (const [moduleId, moduleHealth] of Object.entries(health.modules)) {
    if (/harness|adapter/i.test(moduleId) && moduleHealth.status !== "ready") return true;
    if (moduleId !== "trajectory-capture") continue;
    const details = asRecord(moduleHealth.details);
    if (details?.telemetryEnabled === true && details.adaptersCount === 0) return true;
  }
  return false;
}

function hasNetworkSyncDegradation(health: DaemonHealthReport, authFailure: boolean): boolean {
  if (authFailure) return false;
  if (health.modules["cloud-runtime"]?.status === "offline") return true;
  if (health.status === "cloud-offline") return true;
  return Object.entries(health.modules).some(
    ([moduleId, moduleHealth]) =>
      /network|sync/i.test(moduleId) && moduleHealth.status === "offline",
  );
}

function hasDaemonBackgroundFailure(
  health: DaemonHealthReport,
  recovery: ObserverRecoveryNotificationState | undefined,
): boolean {
  return (
    health.status === "failed" ||
    recovery?.circuitBreakerTripped === true ||
    recovery?.circuitBreaker === "TRIPPED" ||
    recovery?.configurationWarning !== undefined
  );
}

/**
 * Projects only fixed, intervention-required content from health state. Module
 * messages and details never flow into notification text.
 */
export function deriveActionableNotifications(
  observation: ObserverNotificationObservation,
): ActionableNotification[] {
  const timestamp = toTimestamp(observation.observedAt).iso;
  const notifications: ActionableNotification[] = [];
  const authFailure = hasActionableAuthFailure(observation.health);

  if (hasDaemonBackgroundFailure(observation.health, observation.recovery)) {
    notifications.push(
      makeNotification(
        {
          id: OBSERVER_NOTIFICATION_IDS.daemonBackgroundFailed,
          severity: "critical",
          source: "daemon",
          title: "Resin background service needs attention",
          remediationCommand: "resin doctor --fix",
        },
        timestamp,
      ),
    );
  }

  if (authFailure) {
    notifications.push(
      makeNotification(
        {
          id: OBSERVER_NOTIFICATION_IDS.authSessionExpired,
          severity: "error",
          source: "auth",
          title: "Resin Cloud session expired",
          remediationCommand: "resin login",
        },
        timestamp,
      ),
    );
  }

  if (hasHarnessIntegrationFailure(observation.health, observation.harnessIntegration)) {
    notifications.push(
      makeNotification(
        {
          id: OBSERVER_NOTIFICATION_IDS.harnessIntegrationFailed,
          severity: "error",
          source: "harness",
          title: "Harness integration needs repair",
          remediationCommand: "resin doctor --fix",
        },
        timestamp,
      ),
    );
  }

  if (hasNetworkSyncDegradation(observation.health, authFailure)) {
    notifications.push(
      makeNotification(
        {
          id: OBSERVER_NOTIFICATION_IDS.networkSyncDegraded,
          severity: "warning",
          source: "network",
          title: "Cloud sync is degraded",
          remediationCommand: "resin doctor --fix",
        },
        timestamp,
      ),
    );
  }

  return notifications;
}

async function readHarnessIntegrationStateFromPath(
  statePath: string,
): Promise<HarnessIntegrationState> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(
      statePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_HARNESS_HEALTH_BYTES) return "failing";
    const raw = await handle.readFile({ encoding: "utf8" });
    const parsed = HarnessHealthStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return "failing";
    const snapshot = parsed.data;
    const unhealthyHarness = snapshot.harnesses.some(
      (harness) =>
        harness.installed &&
        harness.condition !== "healthy" &&
        harness.condition !== "not_installed",
    );
    return snapshot.success &&
      !snapshot.hasDrift &&
      !snapshot.settingsDiagnostic &&
      !unhealthyHarness
      ? "healthy"
      : "failing";
  } catch (error) {
    return isNodeError(error, "ENOENT") ? "unknown" : "failing";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readPersistedHarnessIntegrationState(
  options: PathResolutionOptions = {},
): Promise<HarnessIntegrationState> {
  const statePath = path.join(resolvePaths(options).stateDir, HARNESS_HEALTH_STATE_FILE_NAME);
  return readHarnessIntegrationStateFromPath(statePath);
}

export async function reconcileObservedNotifications(
  health: DaemonHealthReport,
  recovery: ObserverRecoveryNotificationState | undefined,
  paths: Pick<DaemonPaths, "stateDir">,
  options: Pick<NotificationInboxOptions, "now" | "lockTimeoutMs"> = {},
): Promise<NotificationInboxState> {
  const harnessIntegration = await readHarnessIntegrationStateFromPath(
    path.join(paths.stateDir, HARNESS_HEALTH_STATE_FILE_NAME),
  );
  const active = deriveActionableNotifications({
    health,
    recovery,
    harnessIntegration,
    observedAt: options.now,
  });
  return reconcileNotifications(active, {
    stateDir: paths.stateDir,
    now: options.now,
    lockTimeoutMs: options.lockTimeoutMs,
    managedIds: OBSERVER_MANAGED_NOTIFICATION_IDS,
  });
}
