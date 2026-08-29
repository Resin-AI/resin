import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionableNotification } from "@resin/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIONABLE_NOTIFICATION_COOLDOWN_MS,
  HARNESS_HEALTH_STATE_FILE_NAME,
  OBSERVER_MANAGED_NOTIFICATION_IDS,
  OBSERVER_NOTIFICATION_IDS,
  consumeDueNotifications,
  deriveActionableNotifications,
  readNotificationInbox,
  reconcileNotifications,
  reconcileObservedNotifications,
} from "../src/notifications.js";
import type { DaemonHealthReport } from "../src/supervisor.js";

const temporaryDirectories: string[] = [];

function makeHealth(
  status: DaemonHealthReport["status"],
  modules: DaemonHealthReport["modules"],
): DaemonHealthReport {
  return {
    status,
    uptimeSeconds: 10,
    startedAt: 1,
    version: "test",
    modules,
    timestamp: 1,
  };
}

function authNotification(observedAt: number): ActionableNotification {
  return deriveActionableNotifications({
    health: makeHealth("cloud-offline", {
      "cloud-runtime": {
        status: "degraded",
        details: { status: "expired" },
      },
    }),
    observedAt,
  })[0]!;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("persistent actionable notification transitions", () => {
  it("suppresses repeated cycles, clears recovery, and alerts on recurrence and cooldown", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resin-notifications-"));
    temporaryDirectories.push(directory);
    const inboxPath = path.join(directory, "notification-inbox.json");
    const firstObservedAt = Date.parse("2026-08-28T10:00:00.000Z");
    const options = {
      inboxPath,
      managedIds: OBSERVER_MANAGED_NOTIFICATION_IDS,
    };

    const first = await consumeDueNotifications([authNotification(firstObservedAt)], {
      ...options,
      now: firstObservedAt,
    });
    expect(first.map((notification) => notification.id)).toEqual([
      OBSERVER_NOTIFICATION_IDS.authSessionExpired,
    ]);

    const repeated = await consumeDueNotifications([authNotification(firstObservedAt + 1_000)], {
      ...options,
      now: firstObservedAt + 1_000,
    });
    expect(repeated).toEqual([]);
    const continuous = await readNotificationInbox({ inboxPath });
    expect(continuous.notifications[0]?.notification.timestamp).toBe("2026-08-28T10:00:00.000Z");
    expect(continuous.notifications[0]?.lastAlertedAt).toBe("2026-08-28T10:00:00.000Z");

    await reconcileNotifications([], {
      ...options,
      now: firstObservedAt + 2_000,
    });
    expect((await readNotificationInbox({ inboxPath })).notifications).toEqual([]);

    const recurrenceAt = firstObservedAt + 3_000;
    const recurrence = await consumeDueNotifications([authNotification(recurrenceAt)], {
      ...options,
      now: recurrenceAt,
    });
    expect(recurrence).toHaveLength(1);

    const beforeCooldown = await consumeDueNotifications([authNotification(recurrenceAt + 1_000)], {
      ...options,
      now: recurrenceAt + ACTIONABLE_NOTIFICATION_COOLDOWN_MS - 1,
    });
    expect(beforeCooldown).toEqual([]);

    const afterCooldown = await consumeDueNotifications(
      [authNotification(recurrenceAt + ACTIONABLE_NOTIFICATION_COOLDOWN_MS)],
      {
        ...options,
        now: recurrenceAt + ACTIONABLE_NOTIFICATION_COOLDOWN_MS,
      },
    );
    expect(afterCooldown).toHaveLength(1);
  });

  it("preserves entries outside a producer's managed scope", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resin-notifications-"));
    temporaryDirectories.push(directory);
    const inboxPath = path.join(directory, "notification-inbox.json");
    const observedAt = Date.parse("2026-08-28T11:00:00.000Z");
    const auth = authNotification(observedAt);

    await reconcileNotifications([auth], {
      inboxPath,
      managedIds: [auth.id],
      now: observedAt,
    });
    await reconcileNotifications([], {
      inboxPath,
      managedIds: [OBSERVER_NOTIFICATION_IDS.harnessIntegrationFailed],
      now: observedAt + 1_000,
    });

    expect((await readNotificationInbox({ inboxPath })).notifications[0]?.notification.id).toBe(
      auth.id,
    );
  });
});

describe("observer notification producers", () => {
  it("maps auth, network, daemon, and harness states to fixed safe remediation", () => {
    const observedAt = Date.parse("2026-08-28T12:00:00.000Z");
    const secret = "Bearer secret-token raw session transcript: private";

    const auth = deriveActionableNotifications({
      health: makeHealth("cloud-offline", {
        "cloud-runtime": {
          status: "degraded",
          message: secret,
          details: { status: "expired", error: secret },
        },
      }),
      observedAt,
    });
    expect(auth).toMatchObject([
      {
        id: OBSERVER_NOTIFICATION_IDS.authSessionExpired,
        severity: "error",
        remediationCommand: "resin login",
      },
    ]);
    expect(JSON.stringify(auth)).not.toContain("secret-token");
    expect(JSON.stringify(auth)).not.toContain("transcript");

    const network = deriveActionableNotifications({
      health: makeHealth("cloud-offline", {
        "cloud-runtime": { status: "offline", message: secret },
      }),
      observedAt,
    });
    expect(network).toMatchObject([
      {
        id: OBSERVER_NOTIFICATION_IDS.networkSyncDegraded,
        severity: "warning",
        remediationCommand: "resin doctor --fix",
      },
    ]);

    const daemonAndHarness = deriveActionableNotifications({
      health: makeHealth("failed", {
        "harness-reconciler": { status: "failed", message: secret },
      }),
      recovery: { circuitBreaker: "TRIPPED" },
      observedAt,
    });
    expect(daemonAndHarness.map((notification) => notification.id)).toEqual([
      OBSERVER_NOTIFICATION_IDS.daemonBackgroundFailed,
      OBSERVER_NOTIFICATION_IDS.harnessIntegrationFailed,
    ]);
    expect(daemonAndHarness.map((notification) => notification.remediationCommand)).toEqual([
      "resin doctor --fix",
      "resin doctor --fix",
    ]);
  });

  it("reads harness reconciliation failure and clears it after a healthy snapshot", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resin-notifications-"));
    temporaryDirectories.push(directory);
    const stateDir = path.join(directory, "state");
    await fs.promises.mkdir(stateDir, { recursive: true });
    const harnessStatePath = path.join(stateDir, HARNESS_HEALTH_STATE_FILE_NAME);
    const health = makeHealth("fully-ready", {});
    const observedAt = Date.parse("2026-08-28T13:00:00.000Z");

    await fs.promises.writeFile(
      harnessStatePath,
      JSON.stringify({
        format: "resin-harness-health/v1",
        success: false,
        hasDrift: true,
        harnesses: [{ installed: true, condition: "drifted" }],
        lastFailure: { code: "check_failed", at: "2026-08-28T13:00:00.000Z" },
      }),
    );
    await reconcileObservedNotifications(health, undefined, { stateDir }, { now: observedAt });
    expect((await readNotificationInbox({ stateDir })).notifications).toMatchObject([
      { notification: { id: OBSERVER_NOTIFICATION_IDS.harnessIntegrationFailed } },
    ]);

    await fs.promises.writeFile(
      harnessStatePath,
      JSON.stringify({
        format: "resin-harness-health/v1",
        success: true,
        hasDrift: false,
        harnesses: [{ installed: true, condition: "healthy" }],
      }),
    );
    await reconcileObservedNotifications(
      health,
      undefined,
      { stateDir },
      { now: observedAt + 1_000 },
    );
    expect((await readNotificationInbox({ stateDir })).notifications).toEqual([]);
  });
});
