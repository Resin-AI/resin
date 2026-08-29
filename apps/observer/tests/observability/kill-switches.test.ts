import { LocalDatabaseConnection } from "@resin/db";
import { describe, expect, it } from "vitest";
import { createAuditTrailManager } from "../../src/observability/audit-trail.js";
import {
  KillSwitchManager,
  createKillSwitchManager,
} from "../../src/observability/kill-switches.js";

describe("KillSwitchManager", () => {
  it("manages global evolution pause with immediate effect", async () => {
    const manager = createKillSwitchManager();

    expect(manager.isEvolutionPaused()).toBe(false);
    expect(manager.canEvolve().allowed).toBe(true);

    await manager.pauseEvolution("High regression rate detected in canary");

    expect(manager.isEvolutionPaused()).toBe(true);
    const evalResult = manager.canEvolve();
    expect(evalResult.allowed).toBe(false);
    expect(evalResult.reason).toContain("High regression rate");
    expect(evalResult.switchType).toBe("evolution_pause");

    await manager.resumeEvolution();
    expect(manager.isEvolutionPaused()).toBe(false);
    expect(manager.canEvolve().allowed).toBe(true);
  });

  it("manages global, workspace, and tool-level execution disables with precedence", async () => {
    const manager = createKillSwitchManager();

    // Initially all allowed
    expect(manager.canExecuteTool("git_diff", "ws_main").allowed).toBe(true);

    // 1. Tool-level disable
    await manager.disableTool("git_diff", "Security vulnerability in diff parser");
    expect(manager.isToolDisabled("git_diff")).toBe(true);
    expect(manager.isToolDisabled("read_file")).toBe(false);

    const evalTool1 = manager.canExecuteTool("git_diff", "ws_main");
    expect(evalTool1.allowed).toBe(false);
    expect(evalTool1.switchType).toBe("tool_disable");

    const evalTool2 = manager.canExecuteTool("read_file", "ws_main");
    expect(evalTool2.allowed).toBe(true);

    // 2. Workspace-level disable
    await manager.disableWorkspaceTools("ws_sandboxed", "Workspace policy lockdown");
    expect(manager.isWorkspaceDisabled("ws_sandboxed")).toBe(true);
    expect(manager.isWorkspaceDisabled("ws_main")).toBe(false);

    const evalWsBlocked = manager.canExecuteTool("read_file", "ws_sandboxed");
    expect(evalWsBlocked.allowed).toBe(false);
    expect(evalWsBlocked.switchType).toBe("workspace_tool_disable");

    const evalWsAllowed = manager.canExecuteTool("read_file", "ws_main");
    expect(evalWsAllowed.allowed).toBe(true);

    // 3. Global tool disable overrides everything
    await manager.disableAllTools("Emergency lockdown by administrator");
    expect(manager.isAllToolsDisabled()).toBe(true);

    const evalGlobalBlocked = manager.canExecuteTool("read_file", "ws_main");
    expect(evalGlobalBlocked.allowed).toBe(false);
    expect(evalGlobalBlocked.switchType).toBe("global_tool_disable");

    // Enable all tools globally
    await manager.enableAllTools();
    expect(manager.isAllToolsDisabled()).toBe(false);

    // ws_main is allowed again for read_file
    expect(manager.canExecuteTool("read_file", "ws_main").allowed).toBe(true);
    // but git_diff is still disabled specifically
    expect(manager.canExecuteTool("git_diff", "ws_main").allowed).toBe(false);
  });

  it("manages emergency cloud disconnect", async () => {
    const manager = createKillSwitchManager();

    expect(manager.isCloudDisconnected()).toBe(false);
    expect(manager.canConnectCloud().allowed).toBe(true);

    await manager.disconnectCloud("Airgap mode requested");

    expect(manager.isCloudDisconnected()).toBe(true);
    const evalResult = manager.canConnectCloud();
    expect(evalResult.allowed).toBe(false);
    expect(evalResult.switchType).toBe("cloud_disconnect");

    await manager.reconnectCloud();
    expect(manager.isCloudDisconnected()).toBe(false);
    expect(manager.canConnectCloud().allowed).toBe(true);
  });

  it("persists kill switch state to SQLite and recovers immediately across restart", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const auditTrail = createAuditTrailManager(conn);
    await auditTrail.initialize();

    const manager1 = createKillSwitchManager(conn, auditTrail);
    await manager1.initialize();

    await manager1.pauseEvolution("Maintenance window");
    await manager1.disableTool("python_eval", "Sandbox leak");
    await manager1.disableWorkspaceTools("ws_restricted", "Audit underway");

    expect(manager1.isEvolutionPaused()).toBe(true);
    expect(manager1.isToolDisabled("python_eval")).toBe(true);
    expect(manager1.isWorkspaceDisabled("ws_restricted")).toBe(true);

    // Audit logs recorded
    const auditEntries = await auditTrail.getEntries({ resourceType: "kill_switch" });
    expect(auditEntries.length).toBeGreaterThanOrEqual(3);

    // Reconnect new manager on same SQLite database
    const manager2 = createKillSwitchManager(conn, auditTrail);
    await manager2.initialize();

    // Verify persisted state loaded immediately
    expect(manager2.isEvolutionPaused()).toBe(true);
    expect(manager2.isToolDisabled("python_eval")).toBe(true);
    expect(manager2.isWorkspaceDisabled("ws_restricted")).toBe(true);

    const snapshot = manager2.getSnapshot();
    expect(snapshot.evolutionPaused).toBe(true);
    expect(snapshot.disabledTools).toContain("python_eval");
    expect(snapshot.disabledWorkspaces).toContain("ws_restricted");

    conn.close();
  });
});
