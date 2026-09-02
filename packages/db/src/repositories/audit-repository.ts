import {
  type AuditRecord,
  AuditRecordSchema,
  type InvocationRecord,
  InvocationRecordSchema,
  canonicalJson,
} from "@resin/contracts";
import type { LocalDatabaseConnection, SQLBindValue } from "../connection.js";

/**
 * Repository managing tool invocation logs and system audit trail records.
 */
export class AuditRepository {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  // ---------------------------------------------------------------------------
  // Invocation Records
  // ---------------------------------------------------------------------------

  async recordInvocation(invocation: InvocationRecord): Promise<void> {
    const validated = InvocationRecordSchema.parse(invocation);
    this.conn.run(
      `INSERT INTO invocation_records (
        invocation_id, session_id, workspace_id, tool_id, tool_version,
        started_at, completed_at, duration_ms, status, input_digest, output_digest, error_details_json, resource_usage_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id) DO UPDATE SET
        session_id = excluded.session_id,
        workspace_id = excluded.workspace_id,
        tool_id = excluded.tool_id,
        tool_version = excluded.tool_version,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        status = excluded.status,
        input_digest = excluded.input_digest,
        output_digest = excluded.output_digest,
        error_details_json = excluded.error_details_json,
        resource_usage_json = excluded.resource_usage_json;`,
      [
        validated.invocationId,
        validated.sessionId,
        validated.workspaceId,
        validated.toolId,
        validated.toolVersion,
        validated.startedAt,
        validated.completedAt,
        validated.durationMs,
        validated.status,
        validated.inputDigest,
        validated.outputDigest ?? null,
        validated.errorDetails ? canonicalJson(validated.errorDetails) : null,
        validated.resourceUsage ? canonicalJson(validated.resourceUsage) : null,
      ],
    );
  }

  async getInvocation(invocationId: string): Promise<InvocationRecord | null> {
    const row = this.conn.get<{
      invocation_id: string;
      session_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      started_at: string;
      completed_at: string;
      duration_ms: number;
      status: "success" | "error" | "timeout" | "rejected_capability";
      input_digest: string;
      output_digest: string | null;
      error_details_json: string | null;
      resource_usage_json: string | null;
    }>("SELECT * FROM invocation_records WHERE invocation_id = ?;", [invocationId]);

    if (!row) {
      return null;
    }

    return InvocationRecordSchema.parse({
      invocationId: row.invocation_id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      status: row.status,
      inputDigest: row.input_digest,
      outputDigest: row.output_digest ?? undefined,
      errorDetails: row.error_details_json ? JSON.parse(row.error_details_json) : undefined,
      resourceUsage: row.resource_usage_json ? JSON.parse(row.resource_usage_json) : undefined,
    });
  }

  async listInvocations(options?: {
    sessionId?: string;
    workspaceId?: string;
    toolId?: string;
    status?: string;
    limit?: number;
  }): Promise<InvocationRecord[]> {
    const conditions: string[] = [];
    const params: SQLBindValue[] = [];

    if (options?.sessionId) {
      conditions.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options?.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options?.toolId) {
      conditions.push("tool_id = ?");
      params.push(options.toolId);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    let sql = "SELECT * FROM invocation_records";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY started_at DESC";
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.conn.all<{
      invocation_id: string;
      session_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      started_at: string;
      completed_at: string;
      duration_ms: number;
      status: "success" | "error" | "timeout" | "rejected_capability";
      input_digest: string;
      output_digest: string | null;
      error_details_json: string | null;
      resource_usage_json: string | null;
    }>(sql, params);

    return rows.map((row) =>
      InvocationRecordSchema.parse({
        invocationId: row.invocation_id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        toolId: row.tool_id,
        toolVersion: row.tool_version,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
        status: row.status,
        inputDigest: row.input_digest,
        outputDigest: row.output_digest ?? undefined,
        errorDetails: row.error_details_json ? JSON.parse(row.error_details_json) : undefined,
        resourceUsage: row.resource_usage_json ? JSON.parse(row.resource_usage_json) : undefined,
      }),
    );
  }

  listPendingInvocationUploads(limit: number): InvocationRecord[] {
    const sql =
      "SELECT * FROM invocation_records WHERE uploaded_at IS NULL ORDER BY started_at ASC LIMIT ?;";
    const rows = this.conn.all<{
      invocation_id: string;
      session_id: string;
      workspace_id: string;
      tool_id: string;
      tool_version: string;
      started_at: string;
      completed_at: string;
      duration_ms: number;
      status: "success" | "error" | "timeout" | "rejected_capability";
      input_digest: string;
      output_digest: string | null;
      error_details_json: string | null;
      resource_usage_json: string | null;
    }>(sql, [limit]);

    return rows.map((row) =>
      InvocationRecordSchema.parse({
        invocationId: row.invocation_id,
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        toolId: row.tool_id,
        toolVersion: row.tool_version,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
        status: row.status,
        inputDigest: row.input_digest,
        outputDigest: row.output_digest ?? undefined,
        errorDetails: row.error_details_json ? JSON.parse(row.error_details_json) : undefined,
        resourceUsage: row.resource_usage_json ? JSON.parse(row.resource_usage_json) : undefined,
      }),
    );
  }

  markInvocationsUploaded(invocationIds: string[], uploadedAt: string): void {
    if (invocationIds.length === 0) {
      return;
    }
    const placeholders = invocationIds.map(() => "?").join(", ");
    this.conn.run(
      `UPDATE invocation_records SET uploaded_at = ? WHERE invocation_id IN (${placeholders});`,
      [uploadedAt, ...invocationIds],
    );
  }

  // ---------------------------------------------------------------------------
  // Audit Records
  // ---------------------------------------------------------------------------

  async recordAudit(audit: AuditRecord): Promise<void> {
    const validated = AuditRecordSchema.parse(audit);
    this.conn.run(
      `INSERT INTO audit_records (
        audit_id, timestamp, event_type, actor_json, workspace_id, resource_type, resource_id, action, status, details_json, client_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(audit_id) DO UPDATE SET
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        actor_json = excluded.actor_json,
        workspace_id = excluded.workspace_id,
        resource_type = excluded.resource_type,
        resource_id = excluded.resource_id,
        action = excluded.action,
        status = excluded.status,
        details_json = excluded.details_json,
        client_ip = excluded.client_ip;`,
      [
        validated.auditId,
        validated.timestamp,
        validated.eventType,
        canonicalJson(validated.actor),
        validated.workspaceId ?? null,
        validated.resourceType,
        validated.resourceId,
        validated.action,
        validated.status,
        canonicalJson(validated.details),
        validated.clientIp ?? null,
      ],
    );
  }

  async getAudit(auditId: string): Promise<AuditRecord | null> {
    const row = this.conn.get<{
      audit_id: string;
      timestamp: string;
      event_type: string;
      actor_json: string;
      workspace_id: string | null;
      resource_type:
        | "tool"
        | "deployment"
        | "candidate"
        | "workspace"
        | "capability"
        | "session"
        | "device"
        | "config";
      resource_id: string;
      action: string;
      status: "success" | "failure" | "denied";
      details_json: string;
      client_ip: string | null;
    }>("SELECT * FROM audit_records WHERE audit_id = ?;", [auditId]);

    if (!row) {
      return null;
    }

    return AuditRecordSchema.parse({
      auditId: row.audit_id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      actor: JSON.parse(row.actor_json),
      workspaceId: row.workspace_id ?? undefined,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      action: row.action,
      status: row.status,
      details: JSON.parse(row.details_json || "{}"),
      clientIp: row.client_ip ?? undefined,
    });
  }

  async listAuditRecords(options?: {
    eventType?: string;
    workspaceId?: string;
    resourceType?: string;
    resourceId?: string;
    status?: string;
    limit?: number;
  }): Promise<AuditRecord[]> {
    const conditions: string[] = [];
    const params: SQLBindValue[] = [];

    if (options?.eventType) {
      conditions.push("event_type = ?");
      params.push(options.eventType);
    }
    if (options?.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options?.resourceType) {
      conditions.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options?.resourceId) {
      conditions.push("resource_id = ?");
      params.push(options.resourceId);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    let sql = "SELECT * FROM audit_records";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY timestamp DESC";
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.conn.all<{
      audit_id: string;
      timestamp: string;
      event_type: string;
      actor_json: string;
      workspace_id: string | null;
      resource_type:
        | "tool"
        | "deployment"
        | "candidate"
        | "workspace"
        | "capability"
        | "session"
        | "device"
        | "config";
      resource_id: string;
      action: string;
      status: "success" | "failure" | "denied";
      details_json: string;
      client_ip: string | null;
    }>(sql, params);

    return rows.map((row) =>
      AuditRecordSchema.parse({
        auditId: row.audit_id,
        timestamp: row.timestamp,
        eventType: row.event_type,
        actor: JSON.parse(row.actor_json),
        workspaceId: row.workspace_id ?? undefined,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        status: row.status,
        details: JSON.parse(row.details_json || "{}"),
        clientIp: row.client_ip ?? undefined,
      }),
    );
  }
}
