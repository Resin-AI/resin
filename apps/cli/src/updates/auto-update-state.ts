import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { reconcileNotifications, resolvePaths } from "@resin/observer";
import type { ActionableNotification } from "@resin/protocol";
import { z } from "zod";
import type { UpdateSchedulerState } from "./scheduler.js";

export const AUTO_UPDATE_STATE_FILE_NAME = "auto-update-state.json";
export const AUTO_UPDATE_NOTICE_FILE_NAME = "auto-update-notice.json";
const AUTO_UPDATE_NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1_000;
const MAX_STATE_ERROR_LENGTH = 300;

/** Update-producer notification ids. They use the public `daemon` source. */
export const AUTO_UPDATE_NOTIFICATION_IDS = {
  rolledBack: "daemon.update-rolled-back",
  failed: "daemon.update-failed",
} as const;

export const AUTO_UPDATE_MANAGED_NOTIFICATION_IDS = Object.freeze(
  Object.values(AUTO_UPDATE_NOTIFICATION_IDS),
);

export const AUTO_UPDATE_OUTCOMES = [
  "disabled",
  "update-available",
  "already-current",
  "downgrade-blocked",
  "quarantined",
  "offline",
  "failed",
  "worker-launched",
  "worker-launch-failed",
  "activation-retry",
] as const;

export type AutoUpdateOutcome = (typeof AUTO_UPDATE_OUTCOMES)[number];

const TimestampMsSchema = z.number().int().nonnegative().nullable();

const AutoUpdateStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    scheduler: z
      .object({
        lastSuccessfulCheckAtMs: TimestampMsSchema,
        offlineFailureCount: z.number().int().nonnegative(),
        offlineRetryAtMs: TimestampMsSchema,
      })
      .strict(),
    lastCheck: z
      .object({
        at: z.string(),
        outcome: z.enum(AUTO_UPDATE_OUTCOMES),
        targetVersion: z.string().nullable(),
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    nextCheckAt: z.string().nullable(),
    lastWorkerLaunchAt: z.string().nullable(),
  })
  .strict();

export type AutoUpdateState = z.infer<typeof AutoUpdateStateSchema>;

const AutoUpdateNoticeSchema = z
  .object({
    schemaVersion: z.literal(1),
    fromVersion: z.string().min(1),
    toVersion: z.string().min(1),
    activatedAt: z.string().min(1),
  })
  .strict();

/** A one-time notice that the resident service installed a new version. */
export type AutoUpdateNotice = z.infer<typeof AutoUpdateNoticeSchema>;

export function createAutoUpdateState(): AutoUpdateState {
  return {
    schemaVersion: 1,
    scheduler: { lastSuccessfulCheckAtMs: null, offlineFailureCount: 0, offlineRetryAtMs: null },
    lastCheck: null,
    nextCheckAt: null,
    lastWorkerLaunchAt: null,
  };
}

export function resolveAutoUpdateStatePath(resinHome: string): string {
  return path.join(resinHome, "updates", AUTO_UPDATE_STATE_FILE_NAME);
}

export function resolveAutoUpdateNoticePath(resinHome: string): string {
  return path.join(resinHome, "updates", AUTO_UPDATE_NOTICE_FILE_NAME);
}

export function schedulerStateFrom(state: AutoUpdateState): UpdateSchedulerState {
  return { ...state.scheduler };
}

export function truncateAutoUpdateError(error: string | undefined | null): string | null {
  if (!error) return null;
  const singleLine = error.replace(/\s+/gu, " ").trim();
  return singleLine.length > MAX_STATE_ERROR_LENGTH
    ? `${singleLine.slice(0, MAX_STATE_ERROR_LENGTH - 1)}…`
    : singleLine;
}

/** Returns null when no state exists; throws when the state file is unreadable or invalid. */
export async function readAutoUpdateState(options: {
  readonly resinHome: string;
  readonly fsBridge?: ConfigFsBridge;
}): Promise<AutoUpdateState | null> {
  const raw = await (options.fsBridge ?? defaultFsBridge).readFile(
    resolveAutoUpdateStatePath(options.resinHome),
  );
  if (raw === null) return null;
  return AutoUpdateStateSchema.parse(JSON.parse(raw));
}

export async function writeAutoUpdateState(
  resinHome: string,
  state: AutoUpdateState,
): Promise<void> {
  await writePrivateJson(resolveAutoUpdateStatePath(resinHome), AutoUpdateStateSchema.parse(state));
}

export async function readAutoUpdateNotice(options: {
  readonly resinHome: string;
  readonly fsBridge?: ConfigFsBridge;
}): Promise<AutoUpdateNotice | null> {
  const raw = await (options.fsBridge ?? defaultFsBridge).readFile(
    resolveAutoUpdateNoticePath(options.resinHome),
  );
  if (raw === null) return null;
  const parsed = AutoUpdateNoticeSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function writeAutoUpdateNotice(
  resinHome: string,
  notice: Omit<AutoUpdateNotice, "schemaVersion">,
): Promise<void> {
  await writePrivateJson(
    resolveAutoUpdateNoticePath(resinHome),
    AutoUpdateNoticeSchema.parse({ schemaVersion: 1, ...notice }),
  );
}

/** Acknowledges a displayed notice so each automatic update is reported once. */
export async function acknowledgeAutoUpdateNotice(options: {
  readonly resinHome: string;
  readonly fsBridge?: ConfigFsBridge;
}): Promise<void> {
  const noticePath = resolveAutoUpdateNoticePath(options.resinHome);
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  if (await fsBridge.exists(noticePath)) {
    await fsBridge.unlink(noticePath);
  }
}

export type AutoUpdateNotificationState = "rolled-back" | "failed" | "clear";

/**
 * Publishes update-producer notifications into the shared inbox. Only update ids
 * are managed here, so daemon/auth/harness/network alerts are never resolved.
 */
export async function publishAutoUpdateNotification(options: {
  readonly resinHome: string;
  readonly state: AutoUpdateNotificationState;
  readonly now?: number;
}): Promise<void> {
  const now = options.now ?? Date.now();
  const active: ActionableNotification[] = [];
  if (options.state === "rolled-back") {
    active.push({
      id: AUTO_UPDATE_NOTIFICATION_IDS.rolledBack,
      severity: "error",
      source: "daemon",
      title: "Automatic Resin update was rolled back",
      remediationCommand: "resin status --verbose",
      timestamp: new Date(now).toISOString(),
      cooldownMs: AUTO_UPDATE_NOTIFICATION_COOLDOWN_MS,
    });
  } else if (options.state === "failed") {
    active.push({
      id: AUTO_UPDATE_NOTIFICATION_IDS.failed,
      severity: "warning",
      source: "daemon",
      title: "Automatic Resin update failed",
      remediationCommand: "resin upgrade",
      timestamp: new Date(now).toISOString(),
      cooldownMs: AUTO_UPDATE_NOTIFICATION_COOLDOWN_MS,
    });
  }
  await reconcileNotifications(active, {
    stateDir: resolvePaths({ resinHome: options.resinHome }).stateDir,
    now,
    managedIds: AUTO_UPDATE_MANAGED_NOTIFICATION_IDS,
  });
}

async function writePrivateJson(filePath: string, value: object): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
