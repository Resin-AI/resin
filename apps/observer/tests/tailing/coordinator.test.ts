import type { HarnessSession, HarnessWorkspace } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { ObserverCoordinator } from "../../src/tailing/index.js";
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
});
