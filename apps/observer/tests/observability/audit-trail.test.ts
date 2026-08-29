import { LocalDatabaseConnection, createInMemoryStateStore } from "@resin/db";
import { describe, expect, it } from "vitest";
import {
  AuditTrailManager,
  GENESIS_HASH,
  computeAuditEntryHash,
  createAuditTrailManager,
} from "../../src/observability/audit-trail.js";

describe("AuditTrailManager", () => {
  it("creates hash-chained audit trail entries with GENESIS_HASH for first entry", async () => {
    const manager = createAuditTrailManager();

    const entry1 = await manager.append({
      eventType: "config_change",
      actor: { type: "user", id: "usr_admin" },
      resourceType: "config",
      resourceId: "logLevel",
      action: "update_log_level",
      status: "success",
      details: { newLevel: "debug" },
    });

    expect(entry1.sequence).toBe(1);
    expect(entry1.previousHash).toBe(GENESIS_HASH);
    expect(entry1.hash).toBeDefined();
    expect(entry1.hash.length).toBe(64);

    const entry2 = await manager.append({
      eventType: "tool_disabled",
      actor: { type: "daemon", id: "supervisor" },
      resourceType: "tool",
      resourceId: "bash_exec",
      action: "disable_tool",
      status: "success",
      details: { reason: "high_error_rate" },
    });

    expect(entry2.sequence).toBe(2);
    expect(entry2.previousHash).toBe(entry1.hash);
    expect(entry2.hash).not.toBe(entry1.hash);

    const integrity = await manager.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    expect(integrity.totalEntries).toBe(2);
  });

  it("detects tampering when payload content is modified", async () => {
    const manager = createAuditTrailManager();

    await manager.append({
      eventType: "event_1",
      actor: { type: "user", id: "u1" },
      resourceType: "session",
      resourceId: "s1",
      action: "create",
      status: "success",
      details: { role: "admin" },
    });

    const entry2 = await manager.append({
      eventType: "event_2",
      actor: { type: "user", id: "u2" },
      resourceType: "tool",
      resourceId: "t2",
      action: "execute",
      status: "success",
      details: { amount: 100 },
    });

    await manager.append({
      eventType: "event_3",
      actor: { type: "user", id: "u3" },
      resourceType: "device",
      resourceId: "d3",
      action: "connect",
      status: "success",
      details: {},
    });

    // Tamper with entry2 in memory
    entry2.details.amount = 999999;

    const report = await manager.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.corruptedSequence).toBe(2);
    expect(report.reason).toContain("Digest mismatch at sequence 2");
  });

  it("detects tampering when previousHash is manipulated", async () => {
    const manager = createAuditTrailManager();

    await manager.append({
      eventType: "e1",
      actor: { type: "system", id: "sys" },
      resourceType: "config",
      resourceId: "c1",
      action: "a1",
      status: "success",
    });

    const entry2 = await manager.append({
      eventType: "e2",
      actor: { type: "system", id: "sys" },
      resourceType: "config",
      resourceId: "c2",
      action: "a2",
      status: "success",
    });

    // Manipulate previousHash
    entry2.previousHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = await manager.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.corruptedSequence).toBe(2);
    expect(report.reason).toContain("Hash chain broken at sequence 2");
  });

  it("detects sequence gaps or missing records", async () => {
    const manager = createAuditTrailManager();

    await manager.append({
      eventType: "e1",
      actor: { type: "system", id: "sys" },
      resourceType: "config",
      resourceId: "c1",
      action: "a1",
      status: "success",
    });

    const entry2 = await manager.append({
      eventType: "e2",
      actor: { type: "system", id: "sys" },
      resourceType: "config",
      resourceId: "c2",
      action: "a2",
      status: "success",
    });

    entry2.sequence = 5;

    const report = await manager.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.corruptedSequence).toBe(5);
    expect(report.reason).toContain("Sequence gap");
  });

  it("persists hash chain to SQLite and recovers state on restart", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const manager1 = createAuditTrailManager(conn);
    await manager1.initialize();

    const e1 = await manager1.append({
      eventType: "db_init",
      actor: { type: "daemon", id: "d1" },
      resourceType: "config",
      resourceId: "db",
      action: "init",
      status: "success",
      details: { secretToken: "sk-secret12345678901234567890" },
    });

    const e2 = await manager1.append({
      eventType: "user_login",
      actor: { type: "user", id: "u1" },
      resourceType: "session",
      resourceId: "sess_1",
      action: "login",
      status: "success",
      details: { clientIp: "127.0.0.1" },
    });

    // Details secret should be redacted before hashing/storing
    expect(e1.details.secretToken).toBe("[REDACTED]");

    // Verify integrity in DB
    const report1 = await manager1.verifyIntegrity();
    expect(report1.valid).toBe(true);
    expect(report1.totalEntries).toBe(2);

    // Simulate daemon restart with new manager instance over same DB
    const manager2 = createAuditTrailManager(conn);
    await manager2.initialize();

    const count = await manager2.count();
    expect(count).toBe(2);

    const e3 = await manager2.append({
      eventType: "tool_quarantined",
      actor: { type: "daemon", id: "recovery" },
      resourceType: "tool",
      resourceId: "flaky_tool",
      action: "quarantine",
      status: "success",
      details: { consecutiveErrors: 3 },
    });

    expect(e3.sequence).toBe(3);
    expect(e3.previousHash).toBe(e2.hash);

    const report2 = await manager2.verifyIntegrity();
    expect(report2.valid).toBe(true);
    expect(report2.totalEntries).toBe(3);

    // Filter queries
    const toolEntries = await manager2.getEntries({ resourceType: "tool" });
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].resourceId).toBe("flaky_tool");

    conn.close();
  });
});
