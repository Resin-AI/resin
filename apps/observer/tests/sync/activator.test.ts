import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentActivator } from "../../src/sync/activator.js";
import type { CatalogChangeEvent } from "../../src/sync/types.js";
import { createSampleToolManifest } from "./fixtures.js";

describe("DeploymentActivator", () => {
  let store: LocalStateStore;
  let activator: DeploymentActivator;

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    activator = new DeploymentActivator({ conn: store.conn, toolRepo: store.tools });
  });

  afterEach(() => {
    store.close();
  });

  it("stages tool manifest and tool version in SQLite", async () => {
    const manifest = createSampleToolManifest("formatter", "1.0.0");
    await activator.stageTool(manifest, {
      workspaceId: "ws-1",
      artifactDigest: "digest-123",
      status: "draft",
    });

    const mRow = store.conn.get<{ name: string; version: string }>(
      "SELECT name, version FROM tool_manifests WHERE tool_id = ?;",
      ["formatter"],
    );
    expect(mRow?.name).toBe("formatter");
    expect(mRow?.version).toBe("1.0.0");

    const vRow = store.conn.get<{ status: string; artifact_digest: string }>(
      "SELECT status, artifact_digest FROM tool_versions WHERE tool_id = ? AND version = ?;",
      ["formatter", "1.0.0"],
    );
    expect(vRow?.status).toBe("draft");
    expect(vRow?.artifact_digest).toBe("digest-123");
  });

  it("atomically activates a tool deployment, records transitions, and emits CatalogChangeEvent", async () => {
    const emittedEvents: CatalogChangeEvent[] = [];
    activator.onCatalogChange((evt) => {
      emittedEvents.push(evt);
    });

    const manifest = createSampleToolManifest("linter", "1.0.0");
    await activator.stageTool(manifest);

    const result = await activator.activate({
      workspaceId: "ws-test",
      toolId: "linter",
      version: "1.0.0",
      reason: "Initial deployment",
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe("active");
    expect(result.revision).toBe(1);
    expect(result.snapshot.tools.linter?.version).toBe("1.0.0");
    expect(result.snapshot.tools.linter?.status).toBe("active");

    // Verify DB records
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-test"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools.linter).toBe("1.0.0");

    const instRow = store.conn.get<{ tool_version: string; state: string }>(
      "SELECT tool_version, state FROM installations WHERE workspace_id = ? AND tool_id = ?;",
      ["ws-test", "linter"],
    );
    expect(instRow?.tool_version).toBe("1.0.0");
    expect(instRow?.state).toBe("active");

    // Verify CatalogChangeEvent emitted
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].workspaceId).toBe("ws-test");
    expect(emittedEvents[0].revision).toBe(1);
    expect(emittedEvents[0].changedToolIds).toContain("linter");
  });

  it("supports canary deployments with specified traffic percentage", async () => {
    const manifest = createSampleToolManifest("canary-tool", "2.0.0");
    await activator.stageTool(manifest);

    const result = await activator.activate({
      workspaceId: "ws-canary",
      toolId: "canary-tool",
      version: "2.0.0",
      isCanary: true,
      targetTrafficPercentage: 25,
      reason: "Canary rollout",
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe("canary");
    expect(result.activeTrafficPercentage).toBe(25);

    const depRow = store.conn.get<{ state: string; active_traffic_percentage: number }>(
      "SELECT state, active_traffic_percentage FROM deployment_records WHERE workspace_id = ? AND tool_id = ?;",
      ["ws-canary", "canary-tool"],
    );
    expect(depRow?.state).toBe("canary");
    expect(depRow?.active_traffic_percentage).toBe(25);
  });

  it("guarantees crash resilience and atomic rollback with zero partial state on error", async () => {
    // Initial activation
    const v1 = createSampleToolManifest("resilient-tool", "1.0.0");
    await activator.stageTool(v1);
    await activator.activate({
      workspaceId: "ws-atomic",
      toolId: "resilient-tool",
      version: "1.0.0",
    });

    const initialSnap = store.conn.get<{ digest: string }>(
      "SELECT digest FROM catalog_snapshots WHERE workspace_id = ?;",
      ["ws-atomic"],
    );
    expect(initialSnap).toBeDefined();

    // Stage v2
    const v2 = createSampleToolManifest("resilient-tool", "2.0.0");
    await activator.stageTool(v2);

    // Mock an error during activation transaction (e.g. simulate disk/DB failure)
    const originalRun = store.conn.run.bind(store.conn);
    let runCallCount = 0;
    store.conn.run = (sql: string, params?: unknown[]) => {
      runCallCount++;
      // Fail on the 3rd statement during activation
      if (runCallCount === 4) {
        throw new Error("Simulated SQLite write failure mid-transaction");
      }
      return originalRun(sql, params);
    };

    // Attempt activation expecting failure
    await expect(
      activator.activate({
        workspaceId: "ws-atomic",
        toolId: "resilient-tool",
        version: "2.0.0",
      }),
    ).rejects.toThrow("Simulated SQLite write failure mid-transaction");

    // Restore DB method
    store.conn.run = originalRun;

    // Verify workspace active tools remains at v1 (never exposed v2 or partial state)
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-atomic"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["resilient-tool"]).toBe("1.0.0");

    // Verify latest snapshot is still v1
    const latestSnap = store.conn.get<{ tools_json: string }>(
      "SELECT tools_json FROM catalog_snapshots WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT 1;",
      ["ws-atomic"],
    );
    const snapTools = JSON.parse(latestSnap?.tools_json || "{}");
    expect(snapTools["resilient-tool"]?.version).toBe("1.0.0");
  });

  it("atomically rolls back deployment to previous version and emits CatalogChangeEvent", async () => {
    const emittedEvents: CatalogChangeEvent[] = [];
    activator.onCatalogChange((evt) => {
      emittedEvents.push(evt);
    });

    // Deploy v1
    const v1 = createSampleToolManifest("calc", "1.0.0");
    await activator.stageTool(v1);
    await activator.activate({ workspaceId: "ws-rb", toolId: "calc", version: "1.0.0" });

    // Deploy v2
    const v2 = createSampleToolManifest("calc", "2.0.0");
    await activator.stageTool(v2);
    await activator.activate({ workspaceId: "ws-rb", toolId: "calc", version: "2.0.0" });

    // Roll back
    const rbResult = await activator.rollback({
      workspaceId: "ws-rb",
      toolId: "calc",
      reason: "Regression detected in v2",
    });

    expect(rbResult.success).toBe(true);
    expect(rbResult.state).toBe("rolled_back");
    expect(rbResult.rolledBackVersion).toBe("2.0.0");
    expect(rbResult.restoredVersion).toBe("1.0.0");
    expect(rbResult.snapshot.tools.calc?.version).toBe("1.0.0");

    // Verify workspace DB state
    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-rb"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools.calc).toBe("1.0.0");

    // Verify event emitted for rollback
    expect(emittedEvents.length).toBe(3); // v1 activate, v2 activate, rollback
    expect(emittedEvents[2].changedToolIds).toContain("calc");
  });

  it("rolls back first-installed tool to uninstalled state", async () => {
    const v1 = createSampleToolManifest("standalone", "1.0.0");
    await activator.stageTool(v1);
    await activator.activate({ workspaceId: "ws-first", toolId: "standalone", version: "1.0.0" });

    const rbResult = await activator.rollback({
      workspaceId: "ws-first",
      toolId: "standalone",
      reason: "Uninstallation rollback",
    });

    expect(rbResult.success).toBe(true);
    expect(rbResult.restoredVersion).toBeUndefined();
    expect(rbResult.snapshot.tools.standalone).toBeUndefined();

    const wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-first"],
    );
    const activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools.standalone).toBeUndefined();
  });

  it("handles suspend, resume, and retire lifecycle transitions cleanly", async () => {
    const manifest = createSampleToolManifest("lifecycle-tool", "1.0.0");
    await activator.stageTool(manifest);
    await activator.activate({
      workspaceId: "ws-life",
      toolId: "lifecycle-tool",
      version: "1.0.0",
    });

    // 1. Suspend
    const susResult = await activator.suspend({ workspaceId: "ws-life", toolId: "lifecycle-tool" });
    expect(susResult.success).toBe(true);
    expect(susResult.snapshot.tools["lifecycle-tool"]).toBeUndefined();

    let wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-life"],
    );
    let activeTools: Record<string, string> = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["lifecycle-tool"]).toBeUndefined();

    // 2. Resume
    const resumeResult = await activator.resume({
      workspaceId: "ws-life",
      toolId: "lifecycle-tool",
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.snapshot.tools["lifecycle-tool"]?.version).toBe("1.0.0");

    wsRow = store.conn.get<{ active_tools_json: string }>(
      "SELECT active_tools_json FROM workspaces WHERE workspace_id = ?;",
      ["ws-life"],
    );
    activeTools = JSON.parse(wsRow?.active_tools_json || "{}");
    expect(activeTools["lifecycle-tool"]).toBe("1.0.0");

    // 3. Retire
    const retireResult = await activator.retire({
      workspaceId: "ws-life",
      toolId: "lifecycle-tool",
    });
    expect(retireResult.success).toBe(true);

    const depRow = store.conn.get<{ state: string }>(
      "SELECT state FROM deployment_records WHERE workspace_id = ? AND tool_id = ?;",
      ["ws-life", "lifecycle-tool"],
    );
    expect(depRow?.state).toBe("retired");
  });

  it("bounds catalog_snapshots across repeated activate/rollback/suspend cycles", async () => {
    const manifest = createSampleToolManifest("bounded-tool", "1.0.0");
    await activator.stageTool(manifest);
    const manifest2 = createSampleToolManifest("bounded-tool", "2.0.0");
    await activator.stageTool(manifest2);

    // Drive many snapshot-writing transitions. Each activate/rollback/suspend inserts a
    // catalog_snapshots row directly (bypassing ToolRepository), so without pruning this
    // table would grow one row per transition forever.
    for (let i = 0; i < 12; i += 1) {
      await activator.activate({
        workspaceId: "ws-bound",
        toolId: "bounded-tool",
        version: i % 2 === 0 ? "1.0.0" : "2.0.0",
      });
      await activator.suspend({ workspaceId: "ws-bound", toolId: "bounded-tool" });
      await activator.resume({ workspaceId: "ws-bound", toolId: "bounded-tool" });
    }
    await activator.rollback({ workspaceId: "ws-bound", toolId: "bounded-tool", reason: "test" });

    const row = store.conn.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM catalog_snapshots WHERE workspace_id = ?;",
      ["ws-bound"],
    );
    expect(row?.count).toBeLessThanOrEqual(5);
  });

  it("allocates a fresh snapshot revision even when the wall clock moves backward", async () => {
    const manifest = createSampleToolManifest("clock-tool", "1.0.0");
    await activator.stageTool(manifest);
    const manifest2 = createSampleToolManifest("clock-tool", "2.0.0");
    await activator.stageTool(manifest2);

    // Activate once at the real time, then again with the clock stepped backward so the
    // second snapshot carries an earlier timestamp than the first. A timestamp-ordered
    // "latest" lookup would then pick the older rev and collide on snapshot_id.
    const realNow = Date.now;
    try {
      await activator.activate({ workspaceId: "ws-clock", toolId: "clock-tool", version: "1.0.0" });

      // Step the clock back an hour and activate a second revision.
      Date.now = () => realNow() - 3_600_000;
      const second = await activator.activate({
        workspaceId: "ws-clock",
        toolId: "clock-tool",
        version: "2.0.0",
      });
      expect(second.success).toBe(true);

      // A third activation at the regressed time must still allocate a fresh rev.
      const third = await activator.activate({
        workspaceId: "ws-clock",
        toolId: "clock-tool",
        version: "1.0.0",
      });
      expect(third.success).toBe(true);

      // Drive past the retention bound while the clock is still regressed. Each new
      // revision must be kept (not pruned as "oldest by timestamp") and must not be
      // re-allocated, or the returned snapshot would silently not persist.
      for (let i = 0; i < 6; i += 1) {
        const r = await activator.activate({
          workspaceId: "ws-clock",
          toolId: "clock-tool",
          version: i % 2 === 0 ? "1.0.0" : "2.0.0",
        });
        expect(r.success).toBe(true);
      }

      const ids = store.conn
        .all<{ snapshot_id: string }>(
          "SELECT snapshot_id FROM catalog_snapshots WHERE workspace_id = ? ORDER BY rowid;",
          ["ws-clock"],
        )
        .map((r) => r.snapshot_id);
      expect(new Set(ids).size).toBe(ids.length);
      // Retention keeps the newest-by-insertion revisions; the highest rev must survive.
      const revs = ids.map((id) => Number(id.match(/_rev(\d+)$/)?.[1] ?? 0));
      expect(Math.max(...revs)).toBeGreaterThanOrEqual(8);
    } finally {
      Date.now = realNow;
    }
  });
});
