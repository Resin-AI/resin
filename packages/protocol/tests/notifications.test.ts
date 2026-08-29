import { describe, expect, it } from "vitest";
import { ActionableNotificationSchema as BarrelNotificationSchema } from "../src/index.js";
import {
  type ActionableNotification,
  ActionableNotificationArraySchema,
  ActionableNotificationSchema,
  MAX_NOTIFICATION_COOLDOWN_MS,
  MAX_NOTIFICATION_TITLE_LENGTH,
  createEmptyNotificationInboxState,
  dedupeActionableNotifications,
  filterActionableNotifications,
  isActionableNotification,
  markNotificationsAlerted,
  parseActionableNotification,
  parseNotificationInboxState,
  reconcileNotificationInbox,
  selectDueNotifications,
} from "../src/notifications.js";

const OCCURRED_AT = "2026-08-28T12:00:00.000Z";
const NOW = Date.parse("2026-08-28T12:05:00.000Z");
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

function notification(overrides: Partial<ActionableNotification> = {}): ActionableNotification {
  return {
    id: "auth.session-expired",
    severity: "warning",
    source: "auth",
    title: "Authentication needs attention",
    remediationCommand: "resin login",
    timestamp: OCCURRED_AT,
    cooldownMs: FOUR_HOURS_MS,
    ...overrides,
  };
}

describe("ActionableNotification protocol", () => {
  it("barrel-exports and parses the strict shared contract", () => {
    const value = notification();

    expect(parseActionableNotification(value)).toEqual(value);
    expect(BarrelNotificationSchema).toBe(ActionableNotificationSchema);
    expect(
      ActionableNotificationSchema.safeParse({
        ...value,
        diagnosticDetails: "session payload",
      }).success,
    ).toBe(false);
    expect(
      ActionableNotificationSchema.safeParse({
        ...value,
        accessToken: "not-allowed",
      }).success,
    ).toBe(false);
  });

  it("accepts only intervention severities and declared sources", () => {
    for (const severity of ["warning", "error", "critical"] as const) {
      expect(ActionableNotificationSchema.safeParse(notification({ severity })).success).toBe(true);
    }

    expect(
      ActionableNotificationSchema.safeParse(notification({ severity: "info" as "warning" }))
        .success,
    ).toBe(false);
    expect(
      ActionableNotificationSchema.safeParse(notification({ source: "billing" as "auth" })).success,
    ).toBe(false);
  });

  it("requires stable source-prefixed semantic ids", () => {
    expect(
      ActionableNotificationSchema.safeParse(notification({ id: "session-expired" })).success,
    ).toBe(false);
    expect(
      ActionableNotificationSchema.safeParse(
        notification({ id: "daemon.background-failed", source: "auth" }),
      ).success,
    ).toBe(false);
    expect(
      ActionableNotificationSchema.safeParse(notification({ id: "auth.SessionExpired" })).success,
    ).toBe(false);
  });

  it("bounds titles and rejects obvious secret or transcript content", () => {
    const invalidTitles = [
      " Authentication needs attention",
      "Authentication\nneeds attention",
      "x".repeat(MAX_NOTIFICATION_TITLE_LENGTH + 1),
      "Authorization failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "access_token=secret-value",
      "session transcript: user private content",
    ];

    for (const title of invalidTitles) {
      expect(ActionableNotificationSchema.safeParse(notification({ title })).success).toBe(false);
    }

    expect(
      ActionableNotificationSchema.safeParse(
        notification({ title: "Authentication token expired" }),
      ).success,
    ).toBe(true);
  });

  it("allows only bounded, non-secret Resin CLI remediation commands", () => {
    for (const remediationCommand of ["resin login", "resin doctor --fix", "resin status"]) {
      expect(
        ActionableNotificationSchema.safeParse(notification({ remediationCommand })).success,
      ).toBe(true);
    }

    for (const remediationCommand of [
      "curl https://example.invalid",
      "resin login; rm -rf /",
      "resin doctor --fix | cat",
      "resin login --token=secret-value",
      "resin  login",
    ]) {
      expect(
        ActionableNotificationSchema.safeParse(notification({ remediationCommand })).success,
      ).toBe(false);
    }
  });

  it("requires canonical bounded UTC timestamps and cooldowns", () => {
    for (const timestamp of [
      "2026-08-28T12:00:00Z",
      "2026-08-28T12:00:00.000+00:00",
      "1969-12-31T23:59:59.999Z",
      "not-a-timestamp",
    ]) {
      expect(ActionableNotificationSchema.safeParse(notification({ timestamp })).success).toBe(
        false,
      );
    }

    for (const cooldownMs of [999, 1.5, MAX_NOTIFICATION_COOLDOWN_MS + 1]) {
      expect(ActionableNotificationSchema.safeParse(notification({ cooldownMs })).success).toBe(
        false,
      );
    }
  });

  it("filters malformed and non-actionable values without admitting info noise", () => {
    const values: unknown[] = [
      notification(),
      notification({
        id: "harness.integration-failed",
        source: "harness",
        severity: "error",
        remediationCommand: "resin doctor --fix",
      }),
      notification({
        id: "daemon.background-failed",
        source: "daemon",
        severity: "critical",
        remediationCommand: "resin status",
      }),
      { ...notification(), id: "auth.recovered", severity: "info" },
      { ...notification(), body: "unexpected payload" },
    ];

    expect(filterActionableNotifications(values).map(({ severity }) => severity)).toEqual([
      "warning",
      "error",
      "critical",
    ]);
    expect(isActionableNotification(values[0])).toBe(true);
    expect(isActionableNotification(values[3])).toBe(false);
    expect(ActionableNotificationArraySchema.safeParse(values).success).toBe(false);
  });
});

describe("notification inbox transitions", () => {
  it("deduplicates stable ids, retaining strongest severity and first occurrence", () => {
    const first = notification();
    const escalated = notification({
      severity: "critical",
      title: "Authentication is blocking Resin",
      timestamp: "2026-08-28T12:01:00.000Z",
    });

    expect(dedupeActionableNotifications([first, escalated])).toEqual([
      {
        ...escalated,
        timestamp: first.timestamp,
      },
    ]);
  });

  it("suppresses duplicates until cooldown expiry while preserving active occurrence", () => {
    const first = notification();
    const initial = reconcileNotificationInbox(createEmptyNotificationInboxState(), [first, first]);

    expect(initial.notifications).toHaveLength(1);
    expect(selectDueNotifications(initial, NOW)).toEqual([first]);

    const alerted = markNotificationsAlerted(initial, [first.id], NOW);
    expect(alerted.notifications[0]?.lastAlertedAt).toBe("2026-08-28T12:05:00.000Z");

    const continuing = reconcileNotificationInbox(alerted, [
      notification({
        title: "Authentication still needs attention",
        timestamp: "2026-08-28T13:00:00.000Z",
      }),
    ]);

    expect(continuing.notifications[0]?.notification.timestamp).toBe(first.timestamp);
    expect(continuing.notifications[0]?.lastAlertedAt).toBe(
      alerted.notifications[0]?.lastAlertedAt,
    );
    expect(selectDueNotifications(continuing, NOW + FOUR_HOURS_MS - 1)).toEqual([]);
    expect(selectDueNotifications(continuing, NOW + FOUR_HOURS_MS)).toEqual([
      continuing.notifications[0]?.notification,
    ]);
  });

  it("makes severity escalation due immediately", () => {
    const first = notification();
    const initial = reconcileNotificationInbox(createEmptyNotificationInboxState(), [first]);
    const alerted = markNotificationsAlerted(initial, [first.id], NOW);
    const escalated = reconcileNotificationInbox(alerted, [
      notification({ severity: "critical", timestamp: "2026-08-28T12:06:00.000Z" }),
    ]);

    expect(escalated.notifications[0]?.lastAlertedAt).toBeNull();
    expect(selectDueNotifications(escalated, NOW + 60_000)).toEqual([
      escalated.notifications[0]?.notification,
    ]);
  });

  it("removes resolved ids so recurrence alerts immediately", () => {
    const first = notification();
    const active = markNotificationsAlerted(
      reconcileNotificationInbox(createEmptyNotificationInboxState(), [first]),
      [first.id],
      NOW,
    );
    const resolved = reconcileNotificationInbox(active, []);

    expect(resolved.notifications).toEqual([]);

    const recurrence = notification({ timestamp: "2026-08-28T12:06:00.000Z" });
    const reactivated = reconcileNotificationInbox(resolved, [recurrence]);
    expect(reactivated.notifications[0]?.lastAlertedAt).toBeNull();
    expect(selectDueNotifications(reactivated, NOW + 60_000)).toEqual([recurrence]);
  });

  it("resolves only managed ids for partial producer snapshots", () => {
    const authNotification = notification();
    const daemonNotification = notification({
      id: "daemon.background-failed",
      source: "daemon",
      severity: "critical",
      remediationCommand: "resin status",
    });
    const active = reconcileNotificationInbox(createEmptyNotificationInboxState(), [
      authNotification,
      daemonNotification,
    ]);

    const authResolved = reconcileNotificationInbox(active, [], [authNotification.id]);
    expect(authResolved.notifications.map(({ notification: item }) => item.id)).toEqual([
      daemonNotification.id,
    ]);
  });

  it("strictly parses schema v1 inboxes and rejects duplicate ids", () => {
    const entry = {
      notification: notification(),
      lastAlertedAt: null,
    };

    expect(parseNotificationInboxState({ schemaVersion: 1, notifications: [entry] })).toEqual({
      schemaVersion: 1,
      notifications: [entry],
    });
    expect(() =>
      parseNotificationInboxState({ schemaVersion: 1, notifications: [entry, entry] }),
    ).toThrow();
    expect(() => parseNotificationInboxState({ schemaVersion: 2, notifications: [] })).toThrow();
    expect(() =>
      parseNotificationInboxState({ schemaVersion: 1, notifications: [], token: "secret" }),
    ).toThrow();
  });
});
