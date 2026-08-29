import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type DaemonHealthReport,
  readNotificationInbox,
  reconcileObservedNotifications,
  resolvePaths,
} from "@resin/observer";
import type { ActionableNotification } from "@resin/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctorForTerminal } from "../src/commands/doctor.js";
import {
  CLI_NOTIFICATION_COOLDOWN_MS,
  CLI_NOTIFICATION_IDS,
  type StatusNotificationSnapshot,
  consumeCliActionableNotifications,
  deriveDoctorActionableNotifications,
  deriveStatusActionableNotifications,
  formatActionableNotificationsForTerminal,
} from "../src/service/notifications.js";

const tempHomes: string[] = [];
const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function healthyStatus(
  overrides: Partial<StatusNotificationSnapshot> = {},
): StatusNotificationSnapshot {
  return {
    service: { installed: true, active: true },
    ipc: { connected: true, responsive: true },
    daemon: { health: "healthy", lockfile: { state: "healthy" } },
    cloud: { status: "valid" },
    recovery: { status: "healthy" },
    harnessHealth: { success: true },
    harnesses: [],
    ...overrides,
  };
}

async function createTempHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-cli-notifications-"));
  tempHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    tempHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe("CLI actionable notifications", () => {
  it("deduplicates across executions, honors cooldown, and re-alerts after resolution", async () => {
    const home = await createTempHome();
    const active = deriveStatusActionableNotifications(
      healthyStatus({ cloud: { status: "offline" } }),
      NOW,
    );
    const options = {
      home,
      managedIds: Object.values(CLI_NOTIFICATION_IDS),
    };

    const first = await consumeCliActionableNotifications(active, { ...options, now: NOW });
    const repeated = await consumeCliActionableNotifications(active, { ...options, now: NOW + 1 });
    const afterCooldown = await consumeCliActionableNotifications(active, {
      ...options,
      now: NOW + CLI_NOTIFICATION_COOLDOWN_MS,
    });

    expect(first.map((notification) => notification.id)).toEqual([CLI_NOTIFICATION_IDS.network]);
    expect(repeated).toEqual([]);
    expect(afterCooldown.map((notification) => notification.id)).toEqual([
      CLI_NOTIFICATION_IDS.network,
    ]);
    expect(afterCooldown[0]?.timestamp).toBe(first[0]?.timestamp);

    await consumeCliActionableNotifications([], {
      ...options,
      now: NOW + CLI_NOTIFICATION_COOLDOWN_MS + 1,
    });
    const recurrence = deriveStatusActionableNotifications(
      healthyStatus({ cloud: { status: "offline" } }),
      NOW + CLI_NOTIFICATION_COOLDOWN_MS + 2,
    );
    const reAlerted = await consumeCliActionableNotifications(recurrence, {
      ...options,
      now: NOW + CLI_NOTIFICATION_COOLDOWN_MS + 2,
    });

    expect(reAlerted.map((notification) => notification.id)).toEqual([
      CLI_NOTIFICATION_IDS.network,
    ]);
    expect(reAlerted[0]?.timestamp).not.toBe(first[0]?.timestamp);
  });

  it("preserves and deduplicates an observer configuration warning until observer recovery", async () => {
    const home = await createTempHome();
    const stateDir = resolvePaths({ home }).stateDir;
    const health: DaemonHealthReport = {
      status: "fully-ready",
      uptimeSeconds: 10,
      startedAt: NOW - 10_000,
      version: "test",
      modules: {},
      timestamp: NOW,
    };

    await reconcileObservedNotifications(
      health,
      { configurationWarning: "invalid daemon setting" },
      { stateDir },
      { now: NOW },
    );

    const first = await consumeCliActionableNotifications([], {
      home,
      managedIds: [],
      now: NOW,
    });
    const repeated = await consumeCliActionableNotifications([], {
      home,
      managedIds: [],
      now: NOW + 1,
    });

    expect(first.map((notification) => notification.id)).toEqual([CLI_NOTIFICATION_IDS.daemon]);
    expect(repeated).toEqual([]);
    expect(
      (await readNotificationInbox({ stateDir })).notifications.map(
        (entry) => entry.notification.id,
      ),
    ).toEqual([CLI_NOTIFICATION_IDS.daemon]);

    await reconcileObservedNotifications(health, undefined, { stateDir }, { now: NOW + 2 });
    expect((await readNotificationInbox({ stateDir })).notifications).toEqual([]);
  });

  it("derives only intervention-required severities without healthy-state noise", () => {
    const degraded = deriveStatusActionableNotifications(
      healthyStatus({
        service: { installed: true, active: false },
        ipc: { connected: false, responsive: false },
        daemon: { health: "stopped", lockfile: { state: "stale" } },
        cloud: { status: "expired" },
        recovery: { status: "tripped" },
        harnessHealth: { success: false },
        harnesses: [{ installed: true, status: "error" }],
      }),
      NOW,
    );
    const network = deriveStatusActionableNotifications(
      healthyStatus({ cloud: { status: "offline" } }),
      NOW,
    );

    expect(
      [...degraded, ...network].map(({ id, severity, source }) => ({ id, severity, source })),
    ).toEqual([
      { id: CLI_NOTIFICATION_IDS.daemon, severity: "critical", source: "daemon" },
      { id: CLI_NOTIFICATION_IDS.auth, severity: "error", source: "auth" },
      { id: CLI_NOTIFICATION_IDS.harness, severity: "error", source: "harness" },
      { id: CLI_NOTIFICATION_IDS.network, severity: "warning", source: "network" },
    ]);
    expect(deriveStatusActionableNotifications(healthyStatus(), NOW)).toEqual([]);
  });

  it("keeps diagnostic secrets and transcript text out of notification content", () => {
    const diagnostics = [
      {
        category: "auth" as const,
        status: "fail" as const,
        remediation: "Bearer access-token=very-secret; transcript: private prompt",
        message: "session transcript and access-token=very-secret",
      },
    ];

    const { active, managedIds } = deriveDoctorActionableNotifications(diagnostics, NOW);
    const serialized = JSON.stringify(active);

    expect(managedIds).toEqual([CLI_NOTIFICATION_IDS.auth]);
    expect(active).toHaveLength(1);
    expect(serialized).not.toContain("very-secret");
    expect(serialized.toLowerCase()).not.toContain("transcript");
    expect(active[0]?.remediationCommand).toBe("resin login");
    expect(JSON.parse(serialized)).toEqual(active);
  });

  it("places due notifications on the doctor terminal surface", () => {
    const notification = deriveStatusActionableNotifications(
      healthyStatus({ cloud: { status: "offline" } }),
      NOW,
    )[0]!;
    const output = formatDoctorForTerminal({
      passed: true,
      healthy: true,
      totalChecks: 0,
      passedCount: 0,
      warnCount: 0,
      failCount: 0,
      fixedCount: 0,
      items: [],
      actionsTaken: [],
      timestamp: new Date(NOW).toISOString(),
      notifications: [notification],
    });

    expect(output).toContain("ACTION REQUIRED");
    expect(output).toContain("[WARNING] Cloud sync is degraded");
    expect(output).toContain("Fix: resin doctor --fix");
    expect(output).toContain("RESIN DOCTOR REPORT");
  });

  it("renders compact severity and remediation lines without terminal control injection", () => {
    const safeRuntimeValue = deriveStatusActionableNotifications(
      healthyStatus({ service: { installed: true, active: false } }),
      NOW,
    )[0];
    const unsafeRuntimeValue = {
      id: CLI_NOTIFICATION_IDS.network,
      severity: "warning",
      source: "network",
      title: "\u001b[31mSync stopped\nfor token=secret",
      remediationCommand: "resin status\u001b[2J",
      timestamp: new Date(NOW).toISOString(),
      cooldownMs: CLI_NOTIFICATION_COOLDOWN_MS,
    } as ActionableNotification;

    const output = formatActionableNotificationsForTerminal([
      safeRuntimeValue!,
      unsafeRuntimeValue,
    ]);

    expect(output).toContain("ACTION REQUIRED");
    expect(output).toContain("[CRITICAL]");
    expect(output).toContain("Resin background service needs attention");
    expect(output).toContain("Fix: resin doctor --fix");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("token=secret");
    expect(output).not.toContain("[2J");
  });
});
