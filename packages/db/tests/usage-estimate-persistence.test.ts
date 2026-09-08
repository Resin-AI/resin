import {
  type InvocationRecord,
  InvocationRecordSchema,
  createUsageEstimate,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInMemoryStateStore } from "../src/store.js";

describe("Invocation Record Usage Estimate Persistence", () => {
  it("persists and roundtrips usageEstimate accurately through SQLite", async () => {
    const store = await createInMemoryStateStore();

    // Prepare session for foreign key constraint
    await store.sessions.saveSession({
      sessionId: "ses_persist_001",
      harnessId: "claude-code",
      status: "active",
      startedAt: "2026-08-17T14:00:00.000Z",
    });

    const usageEstimate = createUsageEstimate({
      inputTokens: 45,
      outputTokens: 120,
      discoveryTokens: 15,
    });
    expect(usageEstimate).toBeDefined();

    const invocation: InvocationRecord = {
      invocationId: "inv_persist_001",
      sessionId: "ses_persist_001",
      workspaceId: "ws_persist_001",
      toolId: "tool_batch_runner",
      toolVersion: "1.0.0",
      startedAt: "2026-08-17T14:05:00.000Z",
      completedAt: "2026-08-17T14:05:01.250Z",
      durationMs: 1250,
      status: "success",
      inputDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      outputDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      usageEstimate,
    };

    await store.audit.recordInvocation(invocation);

    // 1. Fetch by single ID
    const fetched = await store.audit.getInvocation("inv_persist_001");
    expect(fetched).toBeDefined();
    expect(fetched?.usageEstimate).toEqual({
      method: "tool_io_utf8_v1",
      inputTokens: 45,
      outputTokens: 120,
      discoveryTokens: 15,
      totalTokens: 180,
    });

    // 2. Fetch via listInvocations
    const list = await store.audit.listInvocations({ sessionId: "ses_persist_001" });
    expect(list).toHaveLength(1);
    expect(list[0].usageEstimate).toEqual(usageEstimate);

    // 3. Fetch via listPendingInvocationUploads
    const pending = store.audit.listPendingInvocationUploads(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].usageEstimate).toEqual(usageEstimate);

    // 4. Verify raw DB column contains valid JSON
    const rawRow = store.conn.get<{ usage_estimate_json: string }>(
      "SELECT usage_estimate_json FROM invocation_records WHERE invocation_id = ?;",
      ["inv_persist_001"],
    );
    expect(rawRow?.usage_estimate_json).toBeDefined();
    const parsedRaw = JSON.parse(rawRow!.usage_estimate_json);
    expect(parsedRaw.method).toBe("tool_io_utf8_v1");
    expect(parsedRaw.totalTokens).toBe(180);
  });

  it("handles older records without usageEstimate gracefully (backward compatibility)", async () => {
    const store = await createInMemoryStateStore();

    await store.sessions.saveSession({
      sessionId: "ses_legacy_001",
      harnessId: "claude-code",
      status: "active",
      startedAt: "2026-08-17T14:00:00.000Z",
    });

    // Insert legacy record with NULL usage_estimate_json directly into DB
    store.conn.run(
      `INSERT INTO invocation_records (
        invocation_id, session_id, workspace_id, tool_id, tool_version,
        started_at, completed_at, duration_ms, status, input_digest, output_digest, usage_estimate_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);`,
      [
        "inv_legacy_001",
        "ses_legacy_001",
        "ws_legacy_001",
        "tool_legacy",
        "1.0.0",
        "2026-08-17T14:00:00.000Z",
        "2026-08-17T14:00:01.000Z",
        1000,
        "success",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      ],
    );

    const fetched = await store.audit.getInvocation("inv_legacy_001");
    expect(fetched).toBeDefined();
    expect(fetched?.usageEstimate).toBeUndefined();

    // Verify it parses against InvocationRecordSchema without error
    expect(() => InvocationRecordSchema.parse(fetched)).not.toThrow();

    const pending = store.audit.listPendingInvocationUploads(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].usageEstimate).toBeUndefined();
  });
});
