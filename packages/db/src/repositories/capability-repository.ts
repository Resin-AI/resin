import {
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type CapabilityGrant,
  CapabilityGrantSchema,
  canonicalJson,
} from "@resin/contracts";
import type { LocalDatabaseConnection } from "../connection.js";

/**
 * Repository managing workspace capability envelopes and fine-grained tool capability grants.
 */
export class CapabilityRepository {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  // ---------------------------------------------------------------------------
  // Capability Envelopes
  // ---------------------------------------------------------------------------

  async saveEnvelope(envelope: CapabilityEnvelope): Promise<void> {
    const validated = CapabilityEnvelopeSchema.parse(envelope);
    this.conn.run(
      `INSERT INTO capability_envelopes (
        envelope_id, workspace_id, version, fs_json, net_json, command_json, secrets_json, limits_json, is_frozen, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(envelope_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        version = excluded.version,
        fs_json = excluded.fs_json,
        net_json = excluded.net_json,
        command_json = excluded.command_json,
        secrets_json = excluded.secrets_json,
        limits_json = excluded.limits_json,
        is_frozen = excluded.is_frozen,
        updated_at = excluded.updated_at;`,
      [
        validated.envelopeId,
        validated.workspaceId,
        validated.version,
        canonicalJson(validated.fs),
        canonicalJson(validated.net),
        canonicalJson(validated.command),
        canonicalJson(validated.secrets),
        canonicalJson(validated.limits),
        validated.isFrozen ? 1 : 0,
        validated.createdAt,
        validated.updatedAt ?? null,
      ],
    );
  }

  async getEnvelope(workspaceId: string): Promise<CapabilityEnvelope | null> {
    const row = this.conn.get<{
      envelope_id: string;
      workspace_id: string;
      version: string;
      fs_json: string;
      net_json: string;
      command_json: string;
      secrets_json: string;
      limits_json: string;
      is_frozen: number;
      created_at: string;
      updated_at: string | null;
    }>(
      "SELECT * FROM capability_envelopes WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1;",
      [workspaceId],
    );

    if (!row) {
      return null;
    }

    return CapabilityEnvelopeSchema.parse({
      envelopeId: row.envelope_id,
      workspaceId: row.workspace_id,
      version: row.version,
      fs: JSON.parse(row.fs_json || "{}"),
      net: JSON.parse(row.net_json || "{}"),
      command: JSON.parse(row.command_json || "{}"),
      secrets: JSON.parse(row.secrets_json || "{}"),
      limits: JSON.parse(row.limits_json || "{}"),
      isFrozen: row.is_frozen === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Capability Grants
  // ---------------------------------------------------------------------------

  async saveGrant(grant: CapabilityGrant): Promise<void> {
    const validated = CapabilityGrantSchema.parse(grant);
    this.conn.run(
      `INSERT INTO capability_grants (
        grant_id, workspace_id, tool_id, granted_at, expires_at, grant_type, capabilities_json, actor_json, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(grant_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        tool_id = excluded.tool_id,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        grant_type = excluded.grant_type,
        capabilities_json = excluded.capabilities_json,
        actor_json = excluded.actor_json,
        reason = excluded.reason;`,
      [
        validated.grantId,
        validated.workspaceId,
        validated.toolId,
        validated.grantedAt,
        validated.expiresAt ?? null,
        validated.grantType,
        canonicalJson(validated.capabilities),
        canonicalJson(validated.actor),
        validated.reason ?? null,
      ],
    );
  }

  async getGrant(grantId: string): Promise<CapabilityGrant | null> {
    const row = this.conn.get<{
      grant_id: string;
      workspace_id: string;
      tool_id: string;
      granted_at: string;
      expires_at: string | null;
      grant_type: "implicit" | "explicit" | "policy";
      capabilities_json: string;
      actor_json: string;
      reason: string | null;
    }>("SELECT * FROM capability_grants WHERE grant_id = ?;", [grantId]);

    if (!row) {
      return null;
    }

    return CapabilityGrantSchema.parse({
      grantId: row.grant_id,
      workspaceId: row.workspace_id,
      toolId: row.tool_id,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at ?? undefined,
      grantType: row.grant_type,
      capabilities: JSON.parse(row.capabilities_json || "{}"),
      actor: JSON.parse(row.actor_json),
      reason: row.reason ?? undefined,
    });
  }

  async listGrants(workspaceId: string, toolId?: string): Promise<CapabilityGrant[]> {
    let sql = "SELECT * FROM capability_grants WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];
    if (toolId) {
      sql += " AND tool_id = ?";
      params.push(toolId);
    }
    sql += " ORDER BY granted_at DESC;";

    const rows = this.conn.all<{
      grant_id: string;
      workspace_id: string;
      tool_id: string;
      granted_at: string;
      expires_at: string | null;
      grant_type: "implicit" | "explicit" | "policy";
      capabilities_json: string;
      actor_json: string;
      reason: string | null;
    }>(sql, params);

    return rows.map((row) =>
      CapabilityGrantSchema.parse({
        grantId: row.grant_id,
        workspaceId: row.workspace_id,
        toolId: row.tool_id,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at ?? undefined,
        grantType: row.grant_type,
        capabilities: JSON.parse(row.capabilities_json || "{}"),
        actor: JSON.parse(row.actor_json),
        reason: row.reason ?? undefined,
      }),
    );
  }
}
