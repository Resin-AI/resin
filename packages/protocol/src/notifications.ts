import { ISOTimestampSchema, type V1MetadataPayloadValue } from "@resin/contracts";
import { z } from "zod";

export const MAX_NOTIFICATION_ID_LENGTH = 96;
export const MAX_NOTIFICATION_TITLE_LENGTH = 120;
export const MAX_REMEDIATION_COMMAND_LENGTH = 160;
export const MIN_NOTIFICATION_COOLDOWN_MS = 1_000;
export const MAX_NOTIFICATION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_NOTIFICATION_TIMESTAMP_MS = 253_402_300_799_999;
export const MAX_ACTIVE_NOTIFICATIONS = 256;
export const NOTIFICATION_INBOX_SCHEMA_VERSION = 1 as const;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SAFE_REMEDIATION_COMMAND_PATTERN =
  /^resin [a-z0-9][a-z0-9._/-]*(?: (?:[a-z0-9][a-z0-9._/-]*|--?[a-z0-9][a-z0-9-]*(?:=[a-z0-9][a-z0-9._/-]*)?))*$/i;
const SENSITIVE_COMMAND_ARGUMENT_PATTERN =
  /(?:^|\s)--?(?:access-?token|refresh-?token|token|secret|password|api-?key|authorization|session(?:-?(?:payload|transcript))?)(?:=|\s|$)/i;
const SENSITIVE_CONTENT_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/-]+=*/i,
  /\b(?:access[ _-]?token|refresh[ _-]?token|api[ _-]?key|client[ _-]?secret|password)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:raw[ _-]?)?(?:prompt|session[ _-]?(?:payload|transcript))\s*[:=]/i,
] as const;

function containsSensitiveContent(value: string): boolean {
  return SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(value));
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const epochMilliseconds = Date.parse(value);
  return (
    Number.isInteger(epochMilliseconds) &&
    epochMilliseconds >= 0 &&
    epochMilliseconds <= MAX_NOTIFICATION_TIMESTAMP_MS &&
    new Date(epochMilliseconds).toISOString() === value
  );
}

export const NotificationSeveritySchema = z.enum(["warning", "error", "critical"]);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export const NotificationSourceSchema = z.enum(["auth", "harness", "daemon", "network"]);
export type NotificationSource = z.infer<typeof NotificationSourceSchema>;

export const NotificationIdSchema = z
  .string()
  .min(3)
  .max(MAX_NOTIFICATION_ID_LENGTH)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/,
    "Notification id must be a lowercase, dot-delimited semantic identifier",
  );

export const NotificationTitleSchema = z
  .string()
  .min(1)
  .max(MAX_NOTIFICATION_TITLE_LENGTH)
  .refine((value) => value === value.trim(), "Notification title must not have outer whitespace")
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), "Notification title must be one line")
  .refine(
    (value) => !containsSensitiveContent(value),
    "Notification title must not contain secrets, prompt data, or session payloads",
  );

export const RemediationCommandSchema = z
  .string()
  .min(1)
  .max(MAX_REMEDIATION_COMMAND_LENGTH)
  .regex(
    SAFE_REMEDIATION_COMMAND_PATTERN,
    "Remediation command must be a plain Resin CLI command without shell operators",
  )
  .refine(
    (value) => !SENSITIVE_COMMAND_ARGUMENT_PATTERN.test(value),
    "Remediation command must not contain secret-bearing arguments",
  );

export const NotificationTimestampSchema = ISOTimestampSchema.length(
  24,
  "Notification timestamp must be a canonical UTC timestamp",
).refine(isCanonicalUtcTimestamp, "Notification timestamp must be canonical UTC ISO 8601");

export const NotificationCooldownSchema = z
  .number()
  .int()
  .min(MIN_NOTIFICATION_COOLDOWN_MS)
  .max(MAX_NOTIFICATION_COOLDOWN_MS);

export const NotificationEpochMillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_NOTIFICATION_TIMESTAMP_MS);

export const ActionableNotificationSchema = z
  .object({
    id: NotificationIdSchema,
    severity: NotificationSeveritySchema,
    source: NotificationSourceSchema,
    title: NotificationTitleSchema,
    remediationCommand: RemediationCommandSchema,
    timestamp: NotificationTimestampSchema,
    cooldownMs: NotificationCooldownSchema,
  })
  .strict()
  .superRefine((notification, context) => {
    if (!notification.id.startsWith(`${notification.source}.`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Notification id must be prefixed by its source",
        path: ["id"],
      });
    }
  });

export type ActionableNotification = z.infer<typeof ActionableNotificationSchema>;
export type ActionableNotificationInput = z.input<typeof ActionableNotificationSchema>;

export const ActionableNotificationArraySchema = z
  .array(ActionableNotificationSchema)
  .max(MAX_ACTIVE_NOTIFICATIONS);

export function parseActionableNotification(
  value: ActionableNotificationInput | V1MetadataPayloadValue | null | undefined,
): ActionableNotification {
  return ActionableNotificationSchema.parse(value);
}

export function parseActionableNotifications(
  value: readonly ActionableNotificationInput[] | V1MetadataPayloadValue | null | undefined,
): ActionableNotification[] {
  return ActionableNotificationArraySchema.parse(value);
}

export function isActionableNotification(
  value: ActionableNotificationInput | V1MetadataPayloadValue | null | undefined,
): value is ActionableNotification {
  return ActionableNotificationSchema.safeParse(value).success;
}

export function filterActionableNotifications(
  values: readonly (ActionableNotificationInput | V1MetadataPayloadValue | null | undefined)[],
): ActionableNotification[] {
  const notifications: ActionableNotification[] = [];
  for (const value of values) {
    const parsed = ActionableNotificationSchema.safeParse(value);
    if (parsed.success) notifications.push(parsed.data);
  }
  return notifications;
}

const SEVERITY_RANK = {
  warning: 0,
  error: 1,
  critical: 2,
} satisfies Record<NotificationSeverity, number>;

/**
 * Collapses observations by stable id. The strongest observation wins while the
 * earliest timestamp remains the beginning of the active occurrence.
 */
export function dedupeActionableNotifications(
  notifications: readonly ActionableNotification[],
): ActionableNotification[] {
  const byId = new Map<string, ActionableNotification>();

  for (const notification of notifications) {
    const existing = byId.get(notification.id);
    if (!existing) {
      byId.set(notification.id, notification);
      continue;
    }

    const preferred =
      SEVERITY_RANK[notification.severity] >= SEVERITY_RANK[existing.severity]
        ? notification
        : existing;
    const earliestTimestamp =
      Date.parse(notification.timestamp) < Date.parse(existing.timestamp)
        ? notification.timestamp
        : existing.timestamp;

    byId.set(notification.id, {
      ...preferred,
      timestamp: earliestTimestamp,
    });
  }

  return [...byId.values()];
}

export const NotificationInboxEntrySchema = z
  .object({
    notification: ActionableNotificationSchema,
    lastAlertedAt: NotificationTimestampSchema.nullable(),
  })
  .strict();

export type NotificationInboxEntry = z.infer<typeof NotificationInboxEntrySchema>;

export const NotificationInboxStateSchema = z
  .object({
    schemaVersion: z.literal(NOTIFICATION_INBOX_SCHEMA_VERSION),
    notifications: z.array(NotificationInboxEntrySchema).max(MAX_ACTIVE_NOTIFICATIONS),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    for (let index = 0; index < state.notifications.length; index += 1) {
      const id = state.notifications[index]?.notification.id;
      if (id === undefined) continue;
      if (ids.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Notification inbox ids must be unique",
          path: ["notifications", index, "notification", "id"],
        });
      }
      ids.add(id);
    }
  });

export type NotificationInboxState = z.infer<typeof NotificationInboxStateSchema>;
export type NotificationInboxStateInput = z.input<typeof NotificationInboxStateSchema>;

export function createEmptyNotificationInboxState(): NotificationInboxState {
  return {
    schemaVersion: NOTIFICATION_INBOX_SCHEMA_VERSION,
    notifications: [],
  };
}

export function parseNotificationInboxState(
  value: NotificationInboxStateInput,
): NotificationInboxState {
  return NotificationInboxStateSchema.parse(value);
}

/**
 * Reconciles active observations. Without a managed-id scope, missing ids are
 * resolved and removed. With a scope, unrelated producer entries remain intact.
 * Continuous ids retain their first timestamp and cooldown history; escalation
 * clears the cooldown.
 */
export function reconcileNotificationInbox(
  previous: NotificationInboxState,
  observedNotifications: readonly ActionableNotification[],
  managedNotificationIds?: readonly string[],
): NotificationInboxState {
  const observed = dedupeActionableNotifications(observedNotifications);
  const observedById = new Map(
    observed.map((notification) => [notification.id, notification] as const),
  );
  const managedIds = managedNotificationIds === undefined ? null : new Set(managedNotificationIds);
  if (managedIds) {
    for (const notification of observed) managedIds.add(notification.id);
  }

  const notifications: NotificationInboxEntry[] = [];
  for (const existing of previous.notifications) {
    const notification = observedById.get(existing.notification.id);
    if (notification) {
      const escalated =
        SEVERITY_RANK[notification.severity] > SEVERITY_RANK[existing.notification.severity];
      notifications.push({
        notification: {
          ...notification,
          timestamp: existing.notification.timestamp,
        },
        lastAlertedAt: escalated ? null : existing.lastAlertedAt,
      });
      observedById.delete(notification.id);
      continue;
    }

    if (managedIds === null || managedIds.has(existing.notification.id)) continue;
    notifications.push(existing);
  }

  for (const notification of observedById.values()) {
    notifications.push({ notification, lastAlertedAt: null });
  }

  return {
    schemaVersion: NOTIFICATION_INBOX_SCHEMA_VERSION,
    notifications,
  };
}

function isNotificationDueAt(entry: NotificationInboxEntry, nowMilliseconds: number): boolean {
  if (entry.lastAlertedAt === null) return true;
  return nowMilliseconds - Date.parse(entry.lastAlertedAt) >= entry.notification.cooldownMs;
}

export function isNotificationDue(entry: NotificationInboxEntry, now: number): boolean {
  return isNotificationDueAt(entry, NotificationEpochMillisecondsSchema.parse(now));
}

export function selectDueNotifications(
  inbox: NotificationInboxState,
  now: number,
): ActionableNotification[] {
  const nowMilliseconds = NotificationEpochMillisecondsSchema.parse(now);
  return inbox.notifications
    .filter((entry) => isNotificationDueAt(entry, nowMilliseconds))
    .map((entry) => entry.notification);
}

export function markNotificationsAlerted(
  inbox: NotificationInboxState,
  notificationIds: readonly string[],
  now: number,
): NotificationInboxState {
  const nowMilliseconds = NotificationEpochMillisecondsSchema.parse(now);
  const alertedAt = new Date(nowMilliseconds).toISOString();
  const ids = new Set(notificationIds);
  let changed = false;

  const notifications = inbox.notifications.map((entry) => {
    if (!ids.has(entry.notification.id) || entry.lastAlertedAt === alertedAt) return entry;
    changed = true;
    return { ...entry, lastAlertedAt: alertedAt };
  });

  return changed ? { ...inbox, notifications } : inbox;
}
