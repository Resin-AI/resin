import type { HarnessSession } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverCoordinator, resolveObservationStart } from "../../src/tailing/index.js";
import { FakeHarnessAdapter } from "../fake-harness.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const MINUTE = 60_000;

function completedSession(sessionId: string, activityAt: Date): HarnessSession {
  return {
    sessionId,
    workspaceId: "ws-catch-up",
    harnessId: "omp",
    status: "completed",
    createdAt: activityAt.toISOString(),
    updatedAt: activityAt.toISOString(),
    metadata: { sessionKind: "user" },
  };
}

async function startWith(
  catchUpFromMs: number | undefined,
  sessions: HarnessSession[],
): Promise<{ coordinator: ObserverCoordinator; boundaries: number[] }> {
  const boundaries: number[] = [];
  const coordinator = new ObserverCoordinator({
    captureInactiveSessions: (_session, startedAt) => {
      boundaries.push(startedAt);
      return true;
    },
  });
  const adapter = new FakeHarnessAdapter({ id: "omp" });
  adapter.addWorkspace({ workspaceId: "ws-catch-up", harnessId: "omp", rootPath: "/tmp/catch" });
  for (const session of sessions) {
    adapter.addSession(session);
  }
  coordinator.registerAdapter(adapter);
  coordinator.onRecords(async (_session, _records, ack) => ack());
  await coordinator.start({ catchUpFromMs });
  return { coordinator, boundaries };
}

describe("resolveObservationStart", () => {
  it("observes from now unless the catch-up boundary is a finite earlier instant", () => {
    const now = NOW.getTime();
    expect(resolveObservationStart(now)).toBe(now);
    expect(resolveObservationStart(now, now - MINUTE)).toBe(now - MINUTE);
    expect(resolveObservationStart(now, now + MINUTE)).toBe(now);
    expect(resolveObservationStart(now, Number.NaN)).toBe(now);
    expect(resolveObservationStart(now, -1)).toBe(now);
  });
});

describe("ObserverCoordinator downtime catch-up", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches sessions finished after the catch-up boundary, not before it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const catchUpFromMs = NOW.getTime() - 10 * MINUTE;
    const { coordinator, boundaries } = await startWith(catchUpFromMs, [
      completedSession("downtime", new Date(NOW.getTime() - 5 * MINUTE)),
      completedSession("before-boundary", new Date(NOW.getTime() - 20 * MINUTE)),
    ]);
    try {
      const summary = coordinator.getDiagnostics().lastPollSummary;
      expect(summary).toMatchObject({ sessionsAttached: 1, errors: [] });
      expect(boundaries).toEqual([catchUpFromMs]);
    } finally {
      await coordinator.stop();
    }
  });

  it("without a boundary keeps observing from start only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { coordinator, boundaries } = await startWith(undefined, [
      completedSession("downtime", new Date(NOW.getTime() - 5 * MINUTE)),
    ]);
    try {
      expect(coordinator.getDiagnostics().lastPollSummary).toMatchObject({
        sessionsAttached: 0,
        errors: [],
      });
      expect(boundaries).toEqual([]);
    } finally {
      await coordinator.stop();
    }
  });
});
