import type { InvocationRecord } from "@resin/contracts";
import { AuditRepository, createInMemoryStateStore } from "@resin/db";
import { describe, expect, it } from "vitest";
import { createInvocationRecorder } from "../../src/meta/invocation-recorder.js";

describe("createInvocationRecorder", () => {
  it("creates a stub session row and inserts invocation_records", async () => {
    const store = await createInMemoryStateStore();
    const recorder = createInvocationRecorder({ db: store.conn });

    const invocation: InvocationRecord = {
      invocationId: "inv_01j7db4n000000000000000001",
      sessionId: "ses_standalone_ws_test",
      workspaceId: "ws_test",
      toolId: "tool_git_diff",
      toolVersion: "1.0.0",
      startedAt: "2026-08-17T14:05:00.000Z",
      completedAt: "2026-08-17T14:05:01.250Z",
      durationMs: 1250,
      status: "success",
      inputDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      outputDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    };

    await recorder(invocation);

    // Verify stub session exists with default harnessId 'resin-mcp' and active status
    const session = await store.sessions.getSession(invocation.sessionId);
    expect(session).toBeDefined();
    expect(session?.sessionId).toBe(invocation.sessionId);
    expect(session?.harnessId).toBe("resin-mcp");
    expect(session?.status).toBe("active");
    expect(session?.startedAt).toBeDefined();

    // Verify invocation record is persisted and retrievable
    const fetched = await store.audit.getInvocation(invocation.invocationId);
    expect(fetched).toEqual(invocation);
  });

  it("supports custom harnessId when creating stub session", async () => {
    const store = await createInMemoryStateStore();
    const recorder = createInvocationRecorder({
      db: store.conn,
      harnessId: "custom-agent-harness",
    });

    const invocation: InvocationRecord = {
      invocationId: "inv_custom_harness_01",
      sessionId: "ses_custom_session",
      workspaceId: "ws_custom",
      toolId: "tool_compiler",
      toolVersion: "2.1.0",
      startedAt: "2026-08-17T15:00:00.000Z",
      completedAt: "2026-08-17T15:00:00.500Z",
      durationMs: 500,
      status: "success",
      inputDigest: "1111111111111111111111111111111111111111111111111111111111111111",
    };

    await recorder(invocation);

    const session = await store.sessions.getSession(invocation.sessionId);
    expect(session).toBeDefined();
    expect(session?.harnessId).toBe("custom-agent-harness");

    const fetched = await store.audit.getInvocation(invocation.invocationId);
    expect(fetched).toEqual(invocation);
  });

  it("is idempotent for the session row across multiple invocations", async () => {
    const store = await createInMemoryStateStore();
    const recorder = createInvocationRecorder({ db: store.conn });

    const invocation1: InvocationRecord = {
      invocationId: "inv_multi_01",
      sessionId: "ses_shared_session",
      workspaceId: "ws_test",
      toolId: "tool_first",
      toolVersion: "1.0.0",
      startedAt: "2026-08-17T14:00:00.000Z",
      completedAt: "2026-08-17T14:00:01.000Z",
      durationMs: 1000,
      status: "success",
      inputDigest: "2222222222222222222222222222222222222222222222222222222222222222",
    };

    const invocation2: InvocationRecord = {
      invocationId: "inv_multi_02",
      sessionId: "ses_shared_session",
      workspaceId: "ws_test",
      toolId: "tool_second",
      toolVersion: "1.1.0",
      startedAt: "2026-08-17T14:05:00.000Z",
      completedAt: "2026-08-17T14:05:02.000Z",
      durationMs: 2000,
      status: "error",
      inputDigest: "3333333333333333333333333333333333333333333333333333333333333333",
      errorDetails: {
        errorType: "ToolExecutionError",
        message: "Tool failed during processing",
      },
    };

    await recorder(invocation1);
    await recorder(invocation2);

    // Both invocations should be present under the same session
    const list = await store.audit.listInvocations({ sessionId: "ses_shared_session" });
    expect(list).toHaveLength(2);

    const fetched1 = await store.audit.getInvocation("inv_multi_01");
    expect(fetched1).toEqual(invocation1);

    const fetched2 = await store.audit.getInvocation("inv_multi_02");
    expect(fetched2).toEqual(invocation2);
  });

  it("links workspace_id on the session when workspace exists in store", async () => {
    const store = await createInMemoryStateStore();
    await store.sessions.saveWorkspace({
      workspaceId: "ws_registered",
      rootPath: "/workspaces/ws_registered",
      name: "registered_workspace",
      config: {},
      capabilityEnvelope: {
        envelopeId: "env_ws_registered",
        workspaceId: "ws_registered",
        version: "1.0.0",
        fs: {},
        net: {},
        command: {},
        secrets: {},
        limits: {},
        createdAt: "2026-08-17T12:00:00.000Z",
      },
      activeTools: {},
      createdAt: "2026-08-17T12:00:00.000Z",
    });

    const recorder = createInvocationRecorder({ db: store.conn });
    const invocation: InvocationRecord = {
      invocationId: "inv_ws_link_01",
      sessionId: "ses_linked_session",
      workspaceId: "ws_registered",
      toolId: "tool_search",
      toolVersion: "1.0.0",
      startedAt: "2026-08-17T16:00:00.000Z",
      completedAt: "2026-08-17T16:00:00.100Z",
      durationMs: 100,
      status: "success",
      inputDigest: "4444444444444444444444444444444444444444444444444444444444444444",
    };

    await recorder(invocation);

    const session = await store.sessions.getSession("ses_linked_session");
    expect(session).toBeDefined();
    expect(session?.workspaceId).toBe("ws_registered");
  });
});
