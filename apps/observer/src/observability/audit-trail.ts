import crypto from "node:crypto";
import {
  type AuditActor,
  type AuditRecord,
  AuditRecordSchema,
  canonicalJson,
} from "@resin/contracts";
import type { LocalDatabaseConnection, SQLBindValue } from "@resin/db";
import type { JsonObject } from "../normalization/redaction.js";
import { redactSecrets } from "./logger.js";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export type AuditResourceType =
  | "tool"
  | "deployment"
  | "candidate"
  | "workspace"
  | "capability"
  | "session"
  | "device"
  | "config"
  | "kill_switch"
  | "system";

export type AuditStatus = "success" | "failure" | "denied";

export interface AuditTrailEntryInput {
  auditId?: string;
  timestamp?: string;
  eventType: string;
  actor: AuditActor;
  workspaceId?: string;
  resourceType: AuditResourceType;
  resourceId: string;
  action: string;
  status: AuditStatus;
  details?: JsonObject;
  clientIp?: string;
}

export interface AuditTrailEntry {
  sequence: number;
  auditId: string;
  timestamp: string;
  eventType: string;
  actor: AuditActor;
  workspaceId?: string;
  resourceType: AuditResourceType;
  resourceId: string;
  action: string;
  status: AuditStatus;
  details: JsonObject;
  clientIp?: string;
  previousHash: string;
  hash: string;
}

export interface AuditQueryFilter {
  limit?: number;
  offset?: number;
  eventType?: string;
  resourceType?: AuditResourceType;
  resourceId?: string;
  workspaceId?: string;
  status?: AuditStatus;
  since?: string;
  until?: string;
  order?: "asc" | "desc";
}

export interface AuditIntegrityReport {
  valid: boolean;
  totalEntries: number;
  firstSequence?: number;
  lastSequence?: number;
  corruptedSequence?: number;
  reason?: string;
}

/**
 * Computes deterministic SHA-256 hash for an audit entry given its fields and previous hash.
 */
export function computeAuditEntryHash(payload: Omit<AuditTrailEntry, "hash">): string {
  const canonicalPayload = {
    sequence: payload.sequence,
    auditId: payload.auditId,
    timestamp: payload.timestamp,
    eventType: payload.eventType,
    actor: payload.actor,
    workspaceId: payload.workspaceId ?? null,
    resourceType: payload.resourceType,
    resourceId: payload.resourceId,
    action: payload.action,
    status: payload.status,
    details: payload.details ?? {},
    clientIp: payload.clientIp ?? null,
    previousHash: payload.previousHash,
  };

  const serialized = canonicalJson(canonicalPayload);
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

export class AuditTrailManager {
  private inMemoryChain: AuditTrailEntry[] = [];
  private lastHash: string = GENESIS_HASH;
  private currentSequence = 0;
  private initialized = false;

  constructor(private readonly conn?: LocalDatabaseConnection) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.conn) {
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS audit_trail_chain (
          sequence INTEGER PRIMARY KEY,
          audit_id TEXT UNIQUE NOT NULL,
          timestamp TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          workspace_id TEXT,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}',
          client_ip TEXT,
          previous_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_chain_event_type ON audit_trail_chain(event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_timestamp ON audit_trail_chain(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_resource ON audit_trail_chain(resource_type, resource_id);
      `);

      const lastRow = this.conn.get<{
        sequence: number;
        hash: string;
      }>("SELECT sequence, hash FROM audit_trail_chain ORDER BY sequence DESC LIMIT 1");

      if (lastRow) {
        this.currentSequence = lastRow.sequence;
        this.lastHash = lastRow.hash;
      }
    }

    this.initialized = true;
  }

  async append(input: AuditTrailEntryInput): Promise<AuditTrailEntry> {
    await this.initialize();

    const timestamp = input.timestamp ?? new Date().toISOString();
    const auditId = input.auditId ?? `aud_${crypto.randomUUID()}`;
    // SAFETY: redactSecrets cleans sensitive tokens while preserving JsonObject structure.
    const redactedDetails: JsonObject = input.details
      ? (redactSecrets(input.details) as JsonObject)
      : {};

    const nextSequence = this.currentSequence + 1;
    const previousHash = this.lastHash;

    const partialEntry: Omit<AuditTrailEntry, "hash"> = {
      sequence: nextSequence,
      auditId,
      timestamp,
      eventType: input.eventType,
      actor: input.actor,
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      action: input.action,
      status: input.status,
      details: redactedDetails,
      clientIp: input.clientIp,
      previousHash,
    };

    const hash = computeAuditEntryHash(partialEntry);
    const entry: AuditTrailEntry = {
      ...partialEntry,
      hash,
    };

    if (this.conn) {
      this.conn.transaction(() => {
        this.conn!.run(
          `INSERT INTO audit_trail_chain (
            sequence, audit_id, timestamp, event_type, actor_json,
            workspace_id, resource_type, resource_id, action, status,
            details_json, client_ip, previous_hash, hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.sequence,
            entry.auditId,
            entry.timestamp,
            entry.eventType,
            JSON.stringify(entry.actor),
            entry.workspaceId ?? null,
            entry.resourceType,
            entry.resourceId,
            entry.action,
            entry.status,
            JSON.stringify(entry.details),
            entry.clientIp ?? null,
            entry.previousHash,
            entry.hash,
          ],
        );

        // Also populate standard audit_records table if supported
        try {
          if (
            entry.resourceType === "tool" ||
            entry.resourceType === "deployment" ||
            entry.resourceType === "candidate" ||
            entry.resourceType === "workspace" ||
            entry.resourceType === "capability" ||
            entry.resourceType === "session" ||
            entry.resourceType === "device" ||
            entry.resourceType === "config"
          ) {
            this.conn!.run(
              `INSERT OR IGNORE INTO audit_records (
                audit_id, timestamp, event_type, actor_json, workspace_id,
                resource_type, resource_id, action, status, details_json, client_ip
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                entry.auditId,
                entry.timestamp,
                entry.eventType,
                JSON.stringify(entry.actor),
                entry.workspaceId ?? null,
                entry.resourceType,
                entry.resourceId,
                entry.action,
                entry.status,
                JSON.stringify(entry.details),
                entry.clientIp ?? null,
              ],
            );
          }
        } catch {
          // audit_records table may not exist in minimal db setup; ignore safely
        }
      });
    } else {
      this.inMemoryChain.push(entry);
    }

    this.currentSequence = nextSequence;
    this.lastHash = hash;

    return entry;
  }

  async getEntries(filter: AuditQueryFilter = {}): Promise<AuditTrailEntry[]> {
    await this.initialize();

    if (this.conn) {
      let sql = "SELECT * FROM audit_trail_chain WHERE 1=1";
      const params: SQLBindValue[] = [];

      if (filter.eventType) {
        sql += " AND event_type = ?";
        params.push(filter.eventType);
      }
      if (filter.resourceType) {
        sql += " AND resource_type = ?";
        params.push(filter.resourceType);
      }
      if (filter.resourceId) {
        sql += " AND resource_id = ?";
        params.push(filter.resourceId);
      }
      if (filter.workspaceId) {
        sql += " AND workspace_id = ?";
        params.push(filter.workspaceId);
      }
      if (filter.status) {
        sql += " AND status = ?";
        params.push(filter.status);
      }
      if (filter.since) {
        sql += " AND timestamp >= ?";
        params.push(filter.since);
      }
      if (filter.until) {
        sql += " AND timestamp <= ?";
        params.push(filter.until);
      }

      const order = filter.order === "desc" ? "DESC" : "ASC";
      sql += ` ORDER BY sequence ${order}`;

      if (filter.limit) {
        sql += " LIMIT ?";
        params.push(filter.limit);
        if (filter.offset) {
          sql += " OFFSET ?";
          params.push(filter.offset);
        }
      }

      const rows = this.conn.all<{
        sequence: number;
        audit_id: string;
        timestamp: string;
        event_type: string;
        actor_json: string;
        workspace_id: string | null;
        resource_type: AuditResourceType;
        resource_id: string;
        action: string;
        status: AuditStatus;
        details_json: string;
        client_ip: string | null;
        previous_hash: string;
        hash: string;
      }>(sql, params);

      return rows.map((row) => ({
        sequence: row.sequence,
        auditId: row.audit_id,
        timestamp: row.timestamp,
        eventType: row.event_type,
        // SAFETY: actor_json is validated AuditActor serialized on write.
        actor: JSON.parse(row.actor_json) as AuditActor,
        workspaceId: row.workspace_id ?? undefined,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        status: row.status,
        // SAFETY: details_json is serialized JsonObject persisted during append.
        details: JSON.parse(row.details_json || "{}") as JsonObject,
        clientIp: row.client_ip ?? undefined,
        previousHash: row.previous_hash,
        hash: row.hash,
      }));
    }

    let entries = [...this.inMemoryChain];
    if (filter.eventType) {
      entries = entries.filter((e) => e.eventType === filter.eventType);
    }
    if (filter.resourceType) {
      entries = entries.filter((e) => e.resourceType === filter.resourceType);
    }
    if (filter.resourceId) {
      entries = entries.filter((e) => e.resourceId === filter.resourceId);
    }
    if (filter.workspaceId) {
      entries = entries.filter((e) => e.workspaceId === filter.workspaceId);
    }
    if (filter.status) {
      entries = entries.filter((e) => e.status === filter.status);
    }
    if (filter.since) {
      entries = entries.filter((e) => e.timestamp >= filter.since!);
    }
    if (filter.until) {
      entries = entries.filter((e) => e.timestamp <= filter.until!);
    }

    if (filter.order === "desc") {
      entries.reverse();
    }

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? entries.length;
    return entries.slice(offset, offset + limit);
  }

  async getLatestEntry(): Promise<AuditTrailEntry | null> {
    const entries = await this.getEntries({ limit: 1, order: "desc" });
    return entries[0] ?? null;
  }

  async count(): Promise<number> {
    await this.initialize();
    if (this.conn) {
      const row = this.conn.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM audit_trail_chain",
      );
      return row?.count ?? 0;
    }
    return this.inMemoryChain.length;
  }

  async verifyIntegrity(): Promise<AuditIntegrityReport> {
    await this.initialize();
    const entries = await this.getEntries({ order: "asc" });

    if (entries.length === 0) {
      return {
        valid: true,
        totalEntries: 0,
      };
    }

    let expectedPrevHash = GENESIS_HASH;
    let expectedSequence = 1;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      if (entry.sequence !== expectedSequence) {
        return {
          valid: false,
          totalEntries: entries.length,
          firstSequence: entries[0].sequence,
          lastSequence: entries[entries.length - 1].sequence,
          corruptedSequence: entry.sequence,
          reason: `Sequence gap or mismatch at index ${i}: expected ${expectedSequence}, got ${entry.sequence}`,
        };
      }

      if (entry.previousHash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: entries.length,
          firstSequence: entries[0].sequence,
          lastSequence: entries[entries.length - 1].sequence,
          corruptedSequence: entry.sequence,
          reason: `Hash chain broken at sequence ${entry.sequence}: expected previousHash ${expectedPrevHash}, got ${entry.previousHash}`,
        };
      }

      const partial: Omit<AuditTrailEntry, "hash"> = {
        sequence: entry.sequence,
        auditId: entry.auditId,
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        actor: entry.actor,
        workspaceId: entry.workspaceId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        action: entry.action,
        status: entry.status,
        details: entry.details,
        clientIp: entry.clientIp,
        previousHash: entry.previousHash,
      };

      const calculatedHash = computeAuditEntryHash(partial);
      if (calculatedHash !== entry.hash) {
        return {
          valid: false,
          totalEntries: entries.length,
          firstSequence: entries[0].sequence,
          lastSequence: entries[entries.length - 1].sequence,
          corruptedSequence: entry.sequence,
          reason: `Digest mismatch at sequence ${entry.sequence}: stored hash ${entry.hash} != calculated hash ${calculatedHash}`,
        };
      }

      expectedPrevHash = entry.hash;
      expectedSequence++;
    }

    return {
      valid: true,
      totalEntries: entries.length,
      firstSequence: entries[0].sequence,
      lastSequence: entries[entries.length - 1].sequence,
    };
  }
}

export function createAuditTrailManager(conn?: LocalDatabaseConnection): AuditTrailManager {
  return new AuditTrailManager(conn);
}
