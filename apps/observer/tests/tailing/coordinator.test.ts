import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  HarnessAdapter,
  HarnessSession,
  HarnessWorkspace,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { ObserverCoordinator, SourceCursorManager } from "../../src/tailing/index.js";
import { FakeHarnessAdapter } from "../fake-harness.js";

describe("ObserverCoordinator Lifecycle and Discovery", () => {
  it("registers adapters, discovers workspaces, and manages active session lifecycles", async () => {
    const coordinator = new ObserverCoordinator({ pollIntervalMs: 5000 });

    const adapter = new FakeHarnessAdapter({
      id: "fake-adapter-1",
      name: "Fake Adapter 1",
    });

    coordinator.registerAdapter(adapter);
    expect(coordinator.getAdapters()).toHaveLength(1);
    expect(coordinator.getAdapter("fake-adapter-1")).toBe(adapter);

    // Setup workspace and session
    const ws: HarnessWorkspace = {
      workspaceId: "ws-coord-1",
      harnessId: "fake-adapter-1",
      rootPath: "/tmp/ws-1",
      name: "Workspace 1",
      configPath: "/tmp/ws-1/.config",
    };
    adapter.addWorkspace(ws);

    const sess: HarnessSession = {
      sessionId: "session-coord-active",
      workspaceId: ws.workspaceId,
      harnessId: "fake-adapter-1",
      transcriptPath: "/tmp/fake-coord-active.jsonl",
      status: "active",
      startedAt: new Date().toISOString(),
    };
    adapter.addSession(sess);

    // Run discovery poll
    const summary1 = await coordinator.pollOnce();
    expect(summary1.workspacesDiscovered).toBe(1);
    expect(summary1.sessionsDiscovered).toBe(1);
    expect(summary1.sessionsAttached).toBe(1);

    const tailer = coordinator.getTailer();
    expect(tailer.getActiveSessions()).toContain(sess.sessionId);

    // Transition session to completed by replacing session with completed status
    const completedSess: HarnessSession = {
      ...sess,
      status: "completed",
    };
    adapter.addSession(completedSess);

    const summary2 = await coordinator.pollOnce();
    expect(summary2.sessionsDetached).toBe(1);
    expect(tailer.getActiveSessions()).not.toContain(sess.sessionId);

    // Check diagnostics
    const diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.adapters).toHaveLength(1);
    expect(diagnostics.workspacesTracked).toContain("ws-coord-1");
    expect(diagnostics.pollCyclesCompleted).toBe(2);

    // Unregister adapter
    expect(coordinator.unregisterAdapter("fake-adapter-1")).toBe(true);
    expect(coordinator.getAdapters()).toHaveLength(0);

    await coordinator.stop();
  });

  it("coalesces concurrent manual pollOnce calls onto one in-flight execution", async () => {
    const coordinator = new ObserverCoordinator({ pollIntervalMs: 5000 });
    let listWorkspacesCalls = 0;
    let resolveListWorkspaces!: (workspaces: HarnessWorkspace[]) => void;

    const delayedAdapter = new FakeHarnessAdapter({ id: "delayed-adapter" });
    delayedAdapter.listWorkspaces = async () => {
      listWorkspacesCalls++;
      if (listWorkspacesCalls === 1) {
        return new Promise<HarnessWorkspace[]>((resolve) => {
          resolveListWorkspaces = resolve;
        });
      }
      return [
        {
          workspaceId: "ws-delay-1",
          harnessId: "delayed-adapter",
          rootPath: "/tmp/ws-delay-1",
          name: "Delayed Workspace",
        },
      ];
    };

    coordinator.registerAdapter(delayedAdapter);

    // Trigger 3 concurrent pollOnce calls
    const p1 = coordinator.pollOnce();
    const p2 = coordinator.pollOnce();
    const p3 = coordinator.pollOnce();

    expect(listWorkspacesCalls).toBe(1);

    // Resolve the delayed adapter call
    resolveListWorkspaces([
      {
        workspaceId: "ws-delay-1",
        harnessId: "delayed-adapter",
        rootPath: "/tmp/ws-delay-1",
        name: "Delayed Workspace",
      },
    ]);

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    // All promises resolve to the identical PollSummary object
    expect(res1).toBe(res2);
    expect(res2).toBe(res3);
    expect(res1.workspacesDiscovered).toBe(1);
    expect(listWorkspacesCalls).toBe(1);
    expect(coordinator.getDiagnostics().pollCyclesCompleted).toBe(1);

    // Subsequent call after settling creates a new poll cycle
    const res4 = await coordinator.pollOnce();
    expect(listWorkspacesCalls).toBe(2);
    expect(coordinator.getDiagnostics().pollCyclesCompleted).toBe(2);
    expect(res4).not.toBe(res1);

    await coordinator.stop();
  });

  it("enforces max poll concurrency of one with serialized scheduler", async () => {
    vi.useFakeTimers();
    try {
      let activePolls = 0;
      let maxActivePolls = 0;
      let totalPolls = 0;

      const delayedAdapter = new FakeHarnessAdapter({ id: "concurrency-adapter" });
      delayedAdapter.listWorkspaces = async () => {
        activePolls++;
        maxActivePolls = Math.max(maxActivePolls, activePolls);
        totalPolls++;

        // Simulate async work taking 50ms
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });

        activePolls--;
        return [];
      };

      const coordinator = new ObserverCoordinator({ pollIntervalMs: 100 });
      coordinator.registerAdapter(delayedAdapter);

      // Start coordinator (triggers initial pollOnce)
      const startPromise = coordinator.start();

      // Advance by 25ms (halfway through the first poll)
      await vi.advanceTimersByTimeAsync(25);
      expect(activePolls).toBe(1);
      expect(maxActivePolls).toBe(1);

      // Triggering manual pollOnce while scheduled poll is in flight should coalesce
      const coalescedPoll = coordinator.pollOnce();

      // Advance by remaining 25ms so the first poll completes
      await vi.advanceTimersByTimeAsync(25);
      await startPromise;
      await coalescedPoll;

      expect(activePolls).toBe(0);
      expect(maxActivePolls).toBe(1);
      expect(totalPolls).toBe(1);

      // Advance by 99ms (pollIntervalMs is 100ms) - next cycle has NOT started yet
      await vi.advanceTimersByTimeAsync(99);
      expect(totalPolls).toBe(1);

      // Advance by 1ms (100ms elapsed since completion) - second cycle starts
      await vi.advanceTimersByTimeAsync(1);
      expect(activePolls).toBe(1);
      expect(totalPolls).toBe(2);

      // Finish second poll (50ms)
      await vi.advanceTimersByTimeAsync(50);
      expect(activePolls).toBe(0);
      expect(maxActivePolls).toBe(1);
      expect(totalPolls).toBe(2);

      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules a later cycle after prior poll settles and continues after adapter errors", async () => {
    vi.useFakeTimers();
    try {
      let pollCount = 0;
      const errorAdapter = new FakeHarnessAdapter({ id: "error-adapter" });
      errorAdapter.listWorkspaces = async () => {
        pollCount++;
        if (pollCount === 1) {
          throw new Error("Simulated adapter connection failure");
        }
        return [
          {
            workspaceId: "ws-error-recovery",
            harnessId: "error-adapter",
            rootPath: "/tmp/ws-error",
            name: "Recovered Workspace",
          },
        ];
      };

      const coordinator = new ObserverCoordinator({ pollIntervalMs: 150 });
      coordinator.registerAdapter(errorAdapter);

      // Start runs initial poll, which encounters an adapter error
      await coordinator.start();
      expect(pollCount).toBe(1);

      const diag1 = coordinator.getDiagnostics();
      expect(diag1.pollCyclesCompleted).toBe(1);
      expect(diag1.lastPollSummary?.errors).toHaveLength(1);
      expect(diag1.lastPollSummary?.errors[0]).toContain("Simulated adapter connection failure");
      expect(diag1.isRunning).toBe(true);

      // Advance by 150ms to trigger next scheduled cycle
      await vi.advanceTimersByTimeAsync(150);

      expect(pollCount).toBe(2);
      const diag2 = coordinator.getDiagnostics();
      expect(diag2.pollCyclesCompleted).toBe(2);
      expect(diag2.lastPollSummary?.errors).toHaveLength(0);
      expect(diag2.workspacesTracked).toContain("ws-error-recovery");

      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop clears pending timer and prevents future polling cycles", async () => {
    vi.useFakeTimers();
    try {
      let pollCount = 0;
      const adapter = new FakeHarnessAdapter({ id: "stop-test-adapter" });
      adapter.listWorkspaces = async () => {
        pollCount++;
        return [];
      };

      const coordinator = new ObserverCoordinator({ pollIntervalMs: 200 });
      coordinator.registerAdapter(adapter);

      await coordinator.start();
      expect(pollCount).toBe(1);

      await coordinator.stop();
      expect(coordinator.getDiagnostics().isRunning).toBe(false);

      // Advance time significantly
      await vi.advanceTimersByTimeAsync(2000);
      expect(pollCount).toBe(1);
      expect(coordinator.getDiagnostics().pollCyclesCompleted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop waits for in-flight poll before closing tailer, preventing attach-after-close race", async () => {
    const ws: HarnessWorkspace = {
      workspaceId: "ws-race-test",
      harnessId: "race-adapter",
      rootPath: "/tmp/ws-race",
      name: "Race Test Workspace",
    };

    const sess: HarnessSession = {
      sessionId: "session-race-active",
      workspaceId: ws.workspaceId,
      harnessId: "race-adapter",
      transcriptPath: "/tmp/fake-race.jsonl",
      status: "active",
      startedAt: new Date().toISOString(),
    };

    let resolveListSessions!: (sessions: HarnessSession[]) => void;
    let listSessionsStartedResolve!: () => void;
    const listSessionsStartedPromise = new Promise<void>((resolve) => {
      listSessionsStartedResolve = resolve;
    });

    const raceAdapter = new FakeHarnessAdapter({ id: "race-adapter" });
    raceAdapter.addWorkspace(ws);
    raceAdapter.listSessions = async () => {
      listSessionsStartedResolve();
      return new Promise<HarnessSession[]>((resolve) => {
        resolveListSessions = resolve;
      });
    };

    const coordinator = new ObserverCoordinator({ pollIntervalMs: 5000 });
    coordinator.registerAdapter(raceAdapter);

    // Trigger pollOnce (in background)
    const pollPromise = coordinator.pollOnce();

    // Await the signal that listSessions has started
    await listSessionsStartedPromise;

    // Initiate stop while poll is in-flight
    let stopSettled = false;
    const stopPromise = coordinator.stop().then(() => {
      stopSettled = true;
    });

    // Allow microtasks to cycle; verify stop is waiting on in-flight poll
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    // Now resolve listSessions with an active session that needs to be attached
    resolveListSessions([sess]);

    // Await both pollPromise and stopPromise
    const summary = await pollPromise;
    await stopPromise;

    expect(stopSettled).toBe(true);
    // Summary should have attached session without any errors
    expect(summary.sessionsAttached).toBe(1);
    expect(summary.errors).toHaveLength(0);

    // Tailer was closed after in-flight poll finished, so active sessions are detached
    const tailer = coordinator.getTailer();
    expect(tailer.getActiveSessions()).toHaveLength(0);
  });
});

describe("ObserverCoordinator backfillPolicyForSession Contract", () => {
  it("evaluates per-session callback once on initial attach, overrides global latest with all, and retains global latest for undefined", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-coord-backfill-"));
    try {
      const pathAll = path.join(tmpDir, "transcript-all.jsonl");
      const pathLatest = path.join(tmpDir, "transcript-latest.jsonl");

      const initialAllLines = [
        JSON.stringify({ index: 1, text: "All Initial 1" }),
        JSON.stringify({ index: 2, text: "All Initial 2" }),
      ];
      fs.writeFileSync(pathAll, `${initialAllLines.join("\n")}\n`);

      const initialLatestLines = [
        JSON.stringify({ index: 1, text: "Latest Initial 1" }),
        JSON.stringify({ index: 2, text: "Latest Initial 2" }),
      ];
      fs.writeFileSync(pathLatest, `${initialLatestLines.join("\n")}\n`);

      const ws: HarnessWorkspace = {
        workspaceId: "ws-backfill-test",
        harnessId: "backfill-adapter",
        rootPath: tmpDir,
        name: "Backfill Workspace",
      };

      const sessionAll: HarnessSession = {
        sessionId: "sess-override-all",
        workspaceId: ws.workspaceId,
        harnessId: "backfill-adapter",
        transcriptPath: pathAll,
        status: "active",
        startedAt: new Date().toISOString(),
      };

      const sessionLatest: HarnessSession = {
        sessionId: "sess-default-latest",
        workspaceId: ws.workspaceId,
        harnessId: "backfill-adapter",
        transcriptPath: pathLatest,
        status: "active",
        startedAt: new Date().toISOString(),
      };

      const adapter: HarnessAdapter = {
        id: "backfill-adapter",
        version: "1.0.0",
        supportedHarnessVersions: ["1.0.0"],
        probeInstallation: async () => null,
        listWorkspaces: async () => [ws],
        listSessions: async () => [sessionAll, sessionLatest],
      };

      const callbackInvocations: string[] = [];
      const coordinator = new ObserverCoordinator({
        defaultBackfillPolicy: { mode: "latest" },
        backfillPolicyForSession: (session) => {
          callbackInvocations.push(session.sessionId);
          if (session.sessionId === "sess-override-all") {
            return { mode: "all" };
          }
          return undefined;
        },
      });

      const tailer = coordinator.getTailer();
      const attachSpy = vi.spyOn(tailer, "attachSession");

      const receivedAllIndices: number[] = [];
      const receivedLatestIndices: number[] = [];

      let resolveAllInitialDone!: () => void;
      const allInitialDonePromise = new Promise<void>((resolve) => {
        resolveAllInitialDone = resolve;
      });

      let resolveLatestAppendedDone!: () => void;
      const latestAppendedDonePromise = new Promise<void>((resolve) => {
        resolveLatestAppendedDone = resolve;
      });

      tailer.onRecords(async (sessionContext, records, ack) => {
        for (const record of records) {
          const payload = record.rawPayload as { index: number };
          if (sessionContext.sessionId === "sess-override-all") {
            receivedAllIndices.push(payload.index);
            if (receivedAllIndices.length >= 2) {
              resolveAllInitialDone();
            }
          } else if (sessionContext.sessionId === "sess-default-latest") {
            receivedLatestIndices.push(payload.index);
            if (receivedLatestIndices.length >= 1) {
              resolveLatestAppendedDone();
            }
          }
        }
        await ack();
      });

      coordinator.registerAdapter(adapter);

      // First poll cycle: attaches both sessions
      const summary1 = await coordinator.pollOnce();
      expect(summary1.sessionsAttached).toBe(2);
      expect(summary1.errors).toHaveLength(0);

      // Callback ran exactly once for each session upon first attach
      expect(callbackInvocations).toEqual(["sess-override-all", "sess-default-latest"]);

      // Verified TailerSessionOptions passed to attachSession
      expect(attachSpy).toHaveBeenCalledWith(sessionAll, undefined, {
        workspaceId: ws.workspaceId,
        backfillPolicy: { mode: "all" },
      });
      expect(attachSpy).toHaveBeenCalledWith(sessionLatest, undefined, {
        workspaceId: ws.workspaceId,
      });

      // sess-override-all receives initial historical records 1 and 2
      await allInitialDonePromise;
      expect(receivedAllIndices).toEqual([1, 2]);

      // sess-default-latest has received 0 records because mode: latest skipped to EOF
      expect(receivedLatestIndices).toHaveLength(0);

      // Append new line to transcript-latest
      const newLine = JSON.stringify({ index: 3, text: "Latest New 3" });
      fs.appendFileSync(pathLatest, `${newLine}\n`);

      await latestAppendedDonePromise;
      expect(receivedLatestIndices).toEqual([3]);

      // Second poll cycle: sessions remain active, callback is NOT evaluated again
      const summary2 = await coordinator.pollOnce();
      expect(summary2.sessionsAttached).toBe(0);
      expect(callbackInvocations).toEqual(["sess-override-all", "sess-default-latest"]);

      await coordinator.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ensures persisted checkpoints remain authoritative over both per-session all and default latest policies", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-coord-checkpoint-"));
    try {
      const pathPersistedAll = path.join(tmpDir, "transcript-p-all.jsonl");
      const pathPersistedLatest = path.join(tmpDir, "transcript-p-latest.jsonl");

      const lines1 = [
        JSON.stringify({ index: 1, text: "Line 1" }),
        JSON.stringify({ index: 2, text: "Line 2" }),
        JSON.stringify({ index: 3, text: "Line 3" }),
        JSON.stringify({ index: 4, text: "Line 4" }),
        JSON.stringify({ index: 5, text: "Line 5" }),
      ];
      fs.writeFileSync(pathPersistedAll, `${lines1.join("\n")}\n`);

      const lines2 = [
        JSON.stringify({ index: 1, text: "Line 1" }),
        JSON.stringify({ index: 2, text: "Line 2" }),
        JSON.stringify({ index: 3, text: "Line 3" }),
        JSON.stringify({ index: 4, text: "Line 4" }),
        JSON.stringify({ index: 5, text: "Line 5" }),
      ];
      fs.writeFileSync(pathPersistedLatest, `${lines2.join("\n")}\n`);

      // Point checkpoint after line 2 (offset at start of line 3)
      const prefix1 = `${lines1.slice(0, 2).join("\n")}\n`;
      const offset3_1 = Buffer.byteLength(prefix1, "utf-8");

      const prefix2 = `${lines2.slice(0, 2).join("\n")}\n`;
      const offset3_2 = Buffer.byteLength(prefix2, "utf-8");

      const cursorManager = new SourceCursorManager();
      await cursorManager.commitCheckpoint("sess-persisted-all", {
        offset: offset3_1,
        line: 3,
        sequence: 2,
        timestamp: new Date().toISOString(),
      });
      await cursorManager.commitCheckpoint("sess-persisted-latest", {
        offset: offset3_2,
        line: 3,
        sequence: 2,
        timestamp: new Date().toISOString(),
      });

      const ws: HarnessWorkspace = {
        workspaceId: "ws-checkpoint-test",
        harnessId: "checkpoint-adapter",
        rootPath: tmpDir,
        name: "Checkpoint Workspace",
      };

      const sessionPAll: HarnessSession = {
        sessionId: "sess-persisted-all",
        workspaceId: ws.workspaceId,
        harnessId: "checkpoint-adapter",
        transcriptPath: pathPersistedAll,
        status: "active",
        startedAt: new Date().toISOString(),
      };

      const sessionPLatest: HarnessSession = {
        sessionId: "sess-persisted-latest",
        workspaceId: ws.workspaceId,
        harnessId: "checkpoint-adapter",
        transcriptPath: pathPersistedLatest,
        status: "active",
        startedAt: new Date().toISOString(),
      };

      const adapter: HarnessAdapter = {
        id: "checkpoint-adapter",
        version: "1.0.0",
        supportedHarnessVersions: ["1.0.0"],
        probeInstallation: async () => null,
        listWorkspaces: async () => [ws],
        listSessions: async () => [sessionPAll, sessionPLatest],
      };

      const coordinator = new ObserverCoordinator({
        cursorManager,
        defaultBackfillPolicy: { mode: "latest" },
        backfillPolicyForSession: (session) => {
          if (session.sessionId === "sess-persisted-all") {
            return { mode: "all" };
          }
          return undefined;
        },
      });

      const receivedPAll: number[] = [];
      const receivedPLatest: number[] = [];

      let resolveDone!: () => void;
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      coordinator.getTailer().onRecords(async (sessionContext, records, ack) => {
        for (const record of records) {
          const payload = record.rawPayload as { index: number };
          if (sessionContext.sessionId === "sess-persisted-all") {
            receivedPAll.push(payload.index);
          } else if (sessionContext.sessionId === "sess-persisted-latest") {
            receivedPLatest.push(payload.index);
          }
        }
        await ack();
        if (receivedPAll.length >= 3 && receivedPLatest.length >= 3) {
          resolveDone();
        }
      });

      coordinator.registerAdapter(adapter);
      const summary = await coordinator.pollOnce();
      expect(summary.sessionsAttached).toBe(2);
      expect(summary.errors).toHaveLength(0);

      await donePromise;

      // Both sessions start strictly at the persisted checkpoint (lines 3, 4, 5)
      // sess-persisted-all did NOT restart from line 1 despite { mode: "all" }
      // sess-persisted-latest did NOT skip to line 6 / EOF despite { mode: "latest" }
      expect(receivedPAll).toEqual([3, 4, 5]);
      expect(receivedPLatest).toEqual([3, 4, 5]);

      await coordinator.stop();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
