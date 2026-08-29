import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "@resin/observer";
import {
  type ActionableNotification,
  ActionableNotificationSchema,
  type NotificationInboxState,
  NotificationInboxStateSchema,
  type NotificationSeverity,
  createEmptyNotificationInboxState,
  filterActionableNotifications,
  markNotificationsAlerted,
  reconcileNotificationInbox,
  selectDueNotifications,
} from "@resin/protocol";

const NOTIFICATION_INBOX_FILE_NAME = "notification-inbox.json";
const MAX_NOTIFICATION_INBOX_BYTES = 512 * 1024;
const INBOX_LOCK_RETRY_MS = 10;
const INBOX_LOCK_TIMEOUT_MS = 2_000;
const INBOX_STALE_LOCK_MS = 30_000;

export const CLI_NOTIFICATION_COOLDOWN_MS = 4 * 60 * 60 * 1_000;

export const CLI_NOTIFICATION_IDS = {
  auth: "auth.session-expired",
  daemon: "daemon.background-failed",
  harness: "harness.integration-failed",
  network: "network.sync-degraded",
} as const;

export type CliNotificationId = (typeof CLI_NOTIFICATION_IDS)[keyof typeof CLI_NOTIFICATION_IDS];

export interface StatusNotificationSnapshot {
  service: {
    installed: boolean;
    active: boolean;
  };
  ipc: {
    connected: boolean;
    responsive: boolean;
  };
  daemon: {
    health: "healthy" | "degraded" | "stopped" | "starting" | "unknown";
    lockfile: {
      state: "healthy" | "missing" | "stale" | "invalid" | "unknown";
    };
  };
  cloud: {
    status: "missing" | "valid" | "expired" | "invalid" | "offline" | "revoked" | "local_only";
  };
  recovery: {
    status: "healthy" | "degraded" | "tripped" | "unknown";
  };
  harnessHealth: {
    success: boolean | null;
  };
  harnesses: ReadonlyArray<{
    installed: boolean;
    status: "attached" | "unconfigured" | "not_installed" | "drift" | "error";
  }>;
}

export interface DoctorNotificationDiagnostic {
  category:
    | "platform"
    | "filesystem"
    | "service"
    | "ipc"
    | "database"
    | "gateway"
    | "harness"
    | "auth"
    | "runtime"
    | "security";
  status: "pass" | "warn" | "fail";
  remediation?: string;
  fixed?: boolean;
}

export interface DoctorNotificationSet {
  active: ActionableNotification[];
  managedIds: CliNotificationId[];
}

export interface NotificationConsumeOptions {
  home: string;
  now: number;
  managedIds: readonly string[];
}

export type NotificationConsumer = (
  active: readonly ActionableNotification[],
  options: NotificationConsumeOptions,
) => Promise<readonly unknown[]>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readNotificationInbox(filePath: string): Promise<NotificationInboxState> {
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
  } catch {
    return createEmptyNotificationInboxState();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeNotificationInbox(
  filePath: string,
  state: NotificationInboxState,
): Promise<void> {
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

async function acquireNotificationInboxLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + INBOX_LOCK_TIMEOUT_MS;
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
    await new Promise<void>((resolve) => setTimeout(resolve, INBOX_LOCK_RETRY_MS));
  }
}

async function consumeSharedNotificationInbox(
  active: readonly ActionableNotification[],
  options: NotificationConsumeOptions,
): Promise<ActionableNotification[]> {
  const observed = active.map((notification) => ActionableNotificationSchema.parse(notification));
  const filePath = path.join(
    resolvePaths({ home: options.home }).stateDir,
    NOTIFICATION_INBOX_FILE_NAME,
  );
  const lockPath = `${filePath}.lock`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await acquireNotificationInboxLock(lockPath);
  try {
    const previous = await readNotificationInbox(filePath);
    const reconciled = reconcileNotificationInbox(previous, observed, options.managedIds);
    const due = selectDueNotifications(reconciled, options.now);
    const state = markNotificationsAlerted(
      reconciled,
      due.map((notification) => notification.id),
      options.now,
    );
    await writeNotificationInbox(filePath, state);
    return due;
  } finally {
    await fs.promises.rmdir(lockPath).catch(() => undefined);
  }
}

const NOTIFICATION_DEFINITIONS = {
  auth: {
    id: CLI_NOTIFICATION_IDS.auth,
    severity: "error",
    source: "auth",
    title: "Resin Cloud session expired",
    remediationCommand: "resin login",
  },
  daemon: {
    id: CLI_NOTIFICATION_IDS.daemon,
    severity: "critical",
    source: "daemon",
    title: "Resin background service needs attention",
    remediationCommand: "resin doctor --fix",
  },
  harness: {
    id: CLI_NOTIFICATION_IDS.harness,
    severity: "error",
    source: "harness",
    title: "Harness integration needs repair",
    remediationCommand: "resin doctor --fix",
  },
  network: {
    id: CLI_NOTIFICATION_IDS.network,
    severity: "warning",
    source: "network",
    title: "Cloud sync is degraded",
    remediationCommand: "resin doctor --fix",
  },
} as const;

const DAEMON_DOCTOR_CATEGORIES: Partial<Record<DoctorNotificationDiagnostic["category"], true>> = {
  filesystem: true,
  service: true,
  ipc: true,
  database: true,
  runtime: true,
  security: true,
};

export function deriveStatusActionableNotifications(
  snapshot: StatusNotificationSnapshot,
  now = Date.now(),
): ActionableNotification[] {
  const active: ActionableNotification[] = [];

  const daemonNeedsAttention =
    !snapshot.service.installed ||
    !snapshot.service.active ||
    !snapshot.ipc.connected ||
    !snapshot.ipc.responsive ||
    snapshot.daemon.health === "stopped" ||
    snapshot.daemon.lockfile.state === "stale" ||
    snapshot.daemon.lockfile.state === "invalid" ||
    snapshot.recovery.status === "tripped";
  if (daemonNeedsAttention) active.push(createNotification("daemon", now));

  if (["expired", "invalid", "revoked"].includes(snapshot.cloud.status)) {
    active.push(createNotification("auth", now));
  }

  const harnessNeedsAttention =
    snapshot.harnessHealth.success === false ||
    snapshot.harnesses.some(
      (harness) =>
        harness.installed &&
        (harness.status === "unconfigured" ||
          harness.status === "drift" ||
          harness.status === "error"),
    );
  if (harnessNeedsAttention) active.push(createNotification("harness", now));

  if (snapshot.cloud.status === "offline") active.push(createNotification("network", now));

  return active;
}

export function deriveDoctorActionableNotifications(
  diagnostics: readonly DoctorNotificationDiagnostic[],
  now = Date.now(),
): DoctorNotificationSet {
  const managedIds = new Set<CliNotificationId>();
  let authActionRequired = false;
  let daemonActionRequired = false;
  let harnessActionRequired = false;
  let networkActionRequired = false;

  for (const diagnostic of diagnostics) {
    if (diagnostic.category === "auth") managedIds.add(CLI_NOTIFICATION_IDS.auth);
    if (DAEMON_DOCTOR_CATEGORIES[diagnostic.category] === true) {
      managedIds.add(CLI_NOTIFICATION_IDS.daemon);
    }
    if (diagnostic.category === "harness") managedIds.add(CLI_NOTIFICATION_IDS.harness);
    if (diagnostic.category === "gateway") managedIds.add(CLI_NOTIFICATION_IDS.network);

    const actionable =
      diagnostic.status !== "pass" && diagnostic.fixed !== true && Boolean(diagnostic.remediation);
    if (!actionable) continue;

    if (diagnostic.category === "auth") authActionRequired = true;
    if (DAEMON_DOCTOR_CATEGORIES[diagnostic.category] === true) daemonActionRequired = true;
    if (diagnostic.category === "harness") harnessActionRequired = true;
    if (diagnostic.category === "gateway") networkActionRequired = true;
  }

  const active: ActionableNotification[] = [];
  if (daemonActionRequired) active.push(createNotification("daemon", now));
  if (authActionRequired) active.push(createNotification("auth", now));
  if (harnessActionRequired) active.push(createNotification("harness", now));
  if (networkActionRequired) active.push(createNotification("network", now));

  return { active, managedIds: [...managedIds] };
}

export async function consumeCliActionableNotifications(
  active: readonly ActionableNotification[],
  options: {
    home: string;
    managedIds: readonly string[];
    now?: number;
    consume?: NotificationConsumer;
  },
): Promise<ActionableNotification[]> {
  const now = options.now ?? Date.now();
  try {
    const consume: NotificationConsumer = options.consume ?? consumeSharedNotificationInbox;
    const due = await consume(active, {
      home: options.home,
      managedIds: options.managedIds,
      now,
    });
    return filterActionableNotifications(due);
  } catch {
    // A damaged or temporarily unwritable inbox must not make status/doctor unusable.
    return [];
  }
}

export function formatActionableNotificationsForTerminal(
  notifications: readonly ActionableNotification[],
): string {
  if (notifications.length === 0) return "";

  const severityRank: Record<NotificationSeverity, number> = {
    warning: 0,
    error: 1,
    critical: 2,
  };
  const safeNotifications = filterActionableNotifications(notifications)
    .filter(
      (notification) =>
        notification.severity === "warning" ||
        notification.severity === "error" ||
        notification.severity === "critical",
    )
    .map((notification) => ({
      ...notification,
      title: escapeTerminalLine(notification.title),
      remediationCommand: escapeTerminalLine(notification.remediationCommand),
    }))
    .filter(
      (notification) => notification.title.length > 0 && notification.remediationCommand.length > 0,
    )
    .sort(
      (left, right) =>
        severityRank[right.severity] - severityRank[left.severity] ||
        left.id.localeCompare(right.id),
    );
  if (safeNotifications.length === 0) return "";

  const lines = ["ACTION REQUIRED"];
  for (const notification of safeNotifications) {
    lines.push(`  [${notification.severity.toUpperCase()}] ${notification.title}`);
    lines.push(`    Fix: ${notification.remediationCommand}`);
  }
  return `${lines.join("\n")}\n\n`;
}

function createNotification(
  kind: keyof typeof NOTIFICATION_DEFINITIONS,
  now: number,
): ActionableNotification {
  return {
    ...NOTIFICATION_DEFINITIONS[kind],
    timestamp: new Date(now).toISOString(),
    cooldownMs: CLI_NOTIFICATION_COOLDOWN_MS,
  };
}

function escapeTerminalLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
