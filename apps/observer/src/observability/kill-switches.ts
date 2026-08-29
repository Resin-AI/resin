import type { AuditActor } from "@resin/contracts";
import type { LocalDatabaseConnection } from "@resin/db";
import type { AuditTrailManager } from "./audit-trail.js";

export type KillSwitchType =
  | "evolution_pause"
  | "global_tool_disable"
  | "workspace_tool_disable"
  | "tool_disable"
  | "cloud_disconnect"
  | "custom";

export interface KillSwitchEntry {
  switchKey: string;
  switchType: KillSwitchType;
  targetId?: string;
  enabled: boolean;
  reason?: string;
  actor?: AuditActor;
  activatedAt?: string;
  updatedAt: string;
}

export interface KillSwitchSnapshot {
  evolutionPaused: boolean;
  allToolsDisabled: boolean;
  cloudDisconnected: boolean;
  disabledWorkspaces: string[];
  disabledTools: string[];
  activeSwitches: KillSwitchEntry[];
}

export interface KillSwitchEvaluation {
  allowed: boolean;
  reason?: string;
  switchType?: KillSwitchType;
  switchKey?: string;
}

export class KillSwitchManager {
  private inMemorySwitches = new Map<string, KillSwitchEntry>();
  private initialized = false;

  constructor(
    private readonly conn?: LocalDatabaseConnection,
    private readonly auditTrail?: AuditTrailManager,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.conn) {
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS kill_switches (
          switch_key TEXT PRIMARY KEY,
          switch_type TEXT NOT NULL,
          target_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          reason TEXT,
          actor_json TEXT,
          activated_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_kill_switches_type ON kill_switches(switch_type);
        CREATE INDEX IF NOT EXISTS idx_kill_switches_target ON kill_switches(target_id);
      `);

      const rows = this.conn.all<{
        switch_key: string;
        switch_type: KillSwitchType;
        target_id: string | null;
        enabled: number;
        reason: string | null;
        actor_json: string | null;
        activated_at: string | null;
        updated_at: string;
      }>("SELECT * FROM kill_switches");

      for (const row of rows) {
        const entry: KillSwitchEntry = {
          switchKey: row.switch_key,
          switchType: row.switch_type,
          targetId: row.target_id ?? undefined,
          enabled: row.enabled === 1,
          reason: row.reason ?? undefined,
          actor: row.actor_json ? JSON.parse(row.actor_json) : undefined,
          activatedAt: row.activated_at ?? undefined,
          updatedAt: row.updated_at,
        };
        this.inMemorySwitches.set(entry.switchKey, entry);
      }
    }

    this.initialized = true;
  }

  private async setSwitch(
    key: string,
    type: KillSwitchType,
    enabled: boolean,
    targetId?: string,
    reason?: string,
    actor: AuditActor = { type: "daemon", id: "kill-switch-manager" },
  ): Promise<KillSwitchEntry> {
    await this.initialize();

    const now = new Date().toISOString();
    const existing = this.inMemorySwitches.get(key);
    const activatedAt = enabled ? (existing?.activatedAt ?? now) : undefined;

    const entry: KillSwitchEntry = {
      switchKey: key,
      switchType: type,
      targetId,
      enabled,
      reason,
      actor,
      activatedAt,
      updatedAt: now,
    };

    this.inMemorySwitches.set(key, entry);

    if (this.conn) {
      this.conn.run(
        `INSERT INTO kill_switches (
          switch_key, switch_type, target_id, enabled, reason, actor_json, activated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(switch_key) DO UPDATE SET
          switch_type = excluded.switch_type,
          target_id = excluded.target_id,
          enabled = excluded.enabled,
          reason = excluded.reason,
          actor_json = excluded.actor_json,
          activated_at = excluded.activated_at,
          updated_at = excluded.updated_at`,
        [
          entry.switchKey,
          entry.switchType,
          entry.targetId ?? null,
          entry.enabled ? 1 : 0,
          entry.reason ?? null,
          JSON.stringify(entry.actor),
          entry.activatedAt ?? null,
          entry.updatedAt,
        ],
      );
    }

    if (this.auditTrail) {
      const eventType = enabled ? "kill_switch_activated" : "kill_switch_deactivated";
      const action = enabled ? `activate_${type}` : `deactivate_${type}`;
      void this.auditTrail.append({
        eventType,
        actor,
        resourceType: "kill_switch",
        resourceId: key,
        action,
        status: "success",
        details: {
          switchType: type,
          targetId,
          reason,
          enabled,
        },
      });
    }

    return entry;
  }

  // ---------------------------------------------------------------------------
  // 1. Global Evolution Pause
  // ---------------------------------------------------------------------------

  async pauseEvolution(reason?: string, actor?: AuditActor): Promise<void> {
    await this.setSwitch(
      "evolution_pause:global",
      "evolution_pause",
      true,
      undefined,
      reason,
      actor,
    );
  }

  async resumeEvolution(actor?: AuditActor): Promise<void> {
    await this.setSwitch(
      "evolution_pause:global",
      "evolution_pause",
      false,
      undefined,
      undefined,
      actor,
    );
  }

  isEvolutionPaused(): boolean {
    return this.inMemorySwitches.get("evolution_pause:global")?.enabled ?? false;
  }

  canEvolve(): KillSwitchEvaluation {
    const sw = this.inMemorySwitches.get("evolution_pause:global");
    if (sw?.enabled) {
      return {
        allowed: false,
        reason: sw.reason ?? "Evolution paused globally by kill switch",
        switchType: "evolution_pause",
        switchKey: "evolution_pause:global",
      };
    }
    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // 2. Global Tool Execution Disable
  // ---------------------------------------------------------------------------

  async disableAllTools(reason?: string, actor?: AuditActor): Promise<void> {
    await this.setSwitch(
      "global_tool_disable:global",
      "global_tool_disable",
      true,
      undefined,
      reason,
      actor,
    );
  }

  async enableAllTools(actor?: AuditActor): Promise<void> {
    await this.setSwitch(
      "global_tool_disable:global",
      "global_tool_disable",
      false,
      undefined,
      undefined,
      actor,
    );
  }

  isAllToolsDisabled(): boolean {
    return this.inMemorySwitches.get("global_tool_disable:global")?.enabled ?? false;
  }

  // ---------------------------------------------------------------------------
  // 3. Workspace Disable
  // ---------------------------------------------------------------------------

  async disableWorkspaceTools(
    workspaceId: string,
    reason?: string,
    actor?: AuditActor,
  ): Promise<void> {
    const key = `workspace_tool_disable:${workspaceId}`;
    await this.setSwitch(key, "workspace_tool_disable", true, workspaceId, reason, actor);
  }

  async enableWorkspaceTools(workspaceId: string, actor?: AuditActor): Promise<void> {
    const key = `workspace_tool_disable:${workspaceId}`;
    await this.setSwitch(key, "workspace_tool_disable", false, workspaceId, undefined, actor);
  }

  isWorkspaceDisabled(workspaceId: string): boolean {
    return this.inMemorySwitches.get(`workspace_tool_disable:${workspaceId}`)?.enabled ?? false;
  }

  // ---------------------------------------------------------------------------
  // 4. Individual Tool Disable
  // ---------------------------------------------------------------------------

  async disableTool(toolId: string, reason?: string, actor?: AuditActor): Promise<void> {
    const key = `tool_disable:${toolId}`;
    await this.setSwitch(key, "tool_disable", true, toolId, reason, actor);
  }

  async enableTool(toolId: string, actor?: AuditActor): Promise<void> {
    const key = `tool_disable:${toolId}`;
    await this.setSwitch(key, "tool_disable", false, toolId, undefined, actor);
  }

  isToolDisabled(toolId: string, workspaceId?: string): boolean {
    if (this.isAllToolsDisabled()) {
      return true;
    }
    if (workspaceId && this.isWorkspaceDisabled(workspaceId)) {
      return true;
    }
    return this.inMemorySwitches.get(`tool_disable:${toolId}`)?.enabled ?? false;
  }

  canExecuteTool(toolId: string, workspaceId?: string): KillSwitchEvaluation {
    const globalSw = this.inMemorySwitches.get("global_tool_disable:global");
    if (globalSw?.enabled) {
      return {
        allowed: false,
        reason: globalSw.reason ?? "All tool executions are disabled globally",
        switchType: "global_tool_disable",
        switchKey: "global_tool_disable:global",
      };
    }

    if (workspaceId) {
      const wsSw = this.inMemorySwitches.get(`workspace_tool_disable:${workspaceId}`);
      if (wsSw?.enabled) {
        return {
          allowed: false,
          reason: wsSw.reason ?? `Tools are disabled for workspace '${workspaceId}'`,
          switchType: "workspace_tool_disable",
          switchKey: `workspace_tool_disable:${workspaceId}`,
        };
      }
    }

    const toolSw = this.inMemorySwitches.get(`tool_disable:${toolId}`);
    if (toolSw?.enabled) {
      return {
        allowed: false,
        reason: toolSw.reason ?? `Tool '${toolId}' is disabled by kill switch`,
        switchType: "tool_disable",
        switchKey: `tool_disable:${toolId}`,
      };
    }

    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // 5. Emergency Cloud Disconnect
  // ---------------------------------------------------------------------------

  async disconnectCloud(reason?: string, actor?: AuditActor): Promise<void> {
    await this.setSwitch(
      "cloud_disconnect:global",
      "cloud_disconnect",
      true,
      undefined,
      reason,
      actor,
    );
  }

  async reconnectCloud(actor?: AuditActor): Promise<void> {
    await this.setSwitch(
      "cloud_disconnect:global",
      "cloud_disconnect",
      false,
      undefined,
      undefined,
      actor,
    );
  }

  isCloudDisconnected(): boolean {
    return this.inMemorySwitches.get("cloud_disconnect:global")?.enabled ?? false;
  }

  canConnectCloud(): KillSwitchEvaluation {
    const sw = this.inMemorySwitches.get("cloud_disconnect:global");
    if (sw?.enabled) {
      return {
        allowed: false,
        reason: sw.reason ?? "Cloud connection is severed by emergency disconnect kill switch",
        switchType: "cloud_disconnect",
        switchKey: "cloud_disconnect:global",
      };
    }
    return { allowed: true };
  }

  // ---------------------------------------------------------------------------
  // Queries & Inspection
  // ---------------------------------------------------------------------------

  getAllSwitches(): KillSwitchEntry[] {
    return Array.from(this.inMemorySwitches.values());
  }

  getActiveSwitches(): KillSwitchEntry[] {
    return Array.from(this.inMemorySwitches.values()).filter((sw) => sw.enabled);
  }

  getSnapshot(): KillSwitchSnapshot {
    const active = this.getActiveSwitches();
    const disabledWorkspaces: string[] = [];
    const disabledTools: string[] = [];

    for (const sw of active) {
      if (sw.switchType === "workspace_tool_disable" && sw.targetId) {
        disabledWorkspaces.push(sw.targetId);
      } else if (sw.switchType === "tool_disable" && sw.targetId) {
        disabledTools.push(sw.targetId);
      }
    }

    return {
      evolutionPaused: this.isEvolutionPaused(),
      allToolsDisabled: this.isAllToolsDisabled(),
      cloudDisconnected: this.isCloudDisconnected(),
      disabledWorkspaces,
      disabledTools,
      activeSwitches: active,
    };
  }

  async resetAll(actor?: AuditActor): Promise<void> {
    for (const key of this.inMemorySwitches.keys()) {
      const sw = this.inMemorySwitches.get(key);
      if (sw?.enabled) {
        await this.setSwitch(key, sw.switchType, false, sw.targetId, undefined, actor);
      }
    }
  }
}

export function createKillSwitchManager(
  conn?: LocalDatabaseConnection,
  auditTrail?: AuditTrailManager,
): KillSwitchManager {
  return new KillSwitchManager(conn, auditTrail);
}
