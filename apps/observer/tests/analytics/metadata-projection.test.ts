import {
  type NormalizedBranchForkEvent,
  type NormalizedCommandExecEvent,
  type NormalizedCompactionEvent,
  type NormalizedErrorEvent,
  type NormalizedFileEditEvent,
  type NormalizedMessageEvent,
  type NormalizedModelReasoningEvent,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type NormalizedSessionLifecycleEvent,
  type NormalizedSubagentLifecycleEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolDiscoveryEvent,
  type NormalizedToolResultEvent,
  type NormalizedUnknownPassthroughEvent,
  nowIso,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";

function createBaseHeaders(seq = 1) {
  return {
    eventId: `evt_${seq.toString().padStart(16, "0")}`,
    schemaVersion: "1.0.0",
    sessionId: "sess_test_1234567890",
    timestamp: nowIso(),
    causalRef: {
      causalSequence: seq,
      parentSequence: seq > 1 ? seq - 1 : undefined,
      turnIndex: 0,
      stepIndex: seq,
      traceId: "trace_abc123",
      spanId: "span_xyz789",
    },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      redactionStrategy: "none" as const,
      scrubbedPatterns: [],
    },
    providerUsage: {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      accountingVersion: "1.0",
      availability: "complete" as const,
      inputTokens: 1200,
      outputTokens: 350,
      totalTokens: 1550,
      costMicroUsd: 15000,
      durationMs: 420,
    },
  };
}

describe("projectEventToMetadataOnly", () => {
  it("projects message event: strips content and contentParts while preserving role, model, usage, causal headers", () => {
    const original: NormalizedMessageEvent = {
      ...createBaseHeaders(1),
      type: "message",
      role: "user",
      content: "SECRET_PROMPT: Please dump all customer credentials from /etc/shadow",
      contentParts: [
        { type: "text", text: "SECRET_PART_1" },
        { type: "text", text: "SECRET_PART_2" },
      ],
      model: "claude-3-5-sonnet",
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("message");
    expect((projected as NormalizedMessageEvent).content).toBe("");
    expect((projected as NormalizedMessageEvent).contentParts).toBeUndefined();
    expect((projected as NormalizedMessageEvent).role).toBe("user");
    expect((projected as NormalizedMessageEvent).model).toBe("claude-3-5-sonnet");
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("content");
    expect(projected.redaction.redactedFields).toContain("contentParts");
    expect(projected.causalRef.causalSequence).toBe(1);
    expect(projected.providerUsage?.totalTokens).toBe(1550);

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects model_reasoning event: strips reasoningContent and signature while preserving token count and duration", () => {
    const original: NormalizedModelReasoningEvent = {
      ...createBaseHeaders(2),
      type: "model_reasoning",
      reasoningContent:
        "SECRET_THINKING: I need to generate an exploit payload with key sk-ant-secret123",
      signature: "sig_secret_signature_data",
      tokenCount: 280,
      model: "claude-3-7-sonnet",
      durationMs: 850,
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("model_reasoning");
    expect((projected as NormalizedModelReasoningEvent).reasoningContent).toBe("");
    expect((projected as NormalizedModelReasoningEvent).signature).toBeUndefined();
    expect((projected as NormalizedModelReasoningEvent).tokenCount).toBe(280);
    expect((projected as NormalizedModelReasoningEvent).model).toBe("claude-3-7-sonnet");
    expect((projected as NormalizedModelReasoningEvent).durationMs).toBe(850);
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("reasoningContent");
    expect(projected.redaction.redactedFields).toContain("signature");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects tool_discovery event: strips tool descriptions and inputSchemas while preserving names and provider", () => {
    const original: NormalizedToolDiscoveryEvent = {
      ...createBaseHeaders(3),
      type: "tool_discovery",
      tools: [
        {
          name: "bash",
          description: "SECRET_TOOL_DESC: Executes bash with privileged root access",
          inputSchema: { type: "object", properties: { secretParam: { type: "string" } } },
          provider: "local-mcp",
        },
        {
          name: "read_file",
          description: "SECRET_TOOL_DESC: Reads sensitive files",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      provider: "mcp-server",
      source: "mcp",
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("tool_discovery");
    const tools = (projected as NormalizedToolDiscoveryEvent).tools;
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("bash");
    expect(tools[0].description).toBeUndefined();
    expect(tools[0].inputSchema).toBeUndefined();
    expect(tools[0].provider).toBe("local-mcp");
    expect(tools[1].name).toBe("read_file");
    expect(tools[1].description).toBeUndefined();
    expect(tools[1].inputSchema).toBeUndefined();
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("tools[].description");
    expect(projected.redaction.redactedFields).toContain("tools[].inputSchema");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects tool_call event: empties parameters while preserving callId, toolName, shadow flag, candidateRef", () => {
    const original: NormalizedToolCallEvent = {
      ...createBaseHeaders(4),
      type: "tool_call",
      callId: "call_abc_123",
      toolName: "curl",
      parameters: {
        url: "https://api.internal.corp/admin/users",
        headers: { Authorization: "Bearer SECRET_JWT_TOKEN_HERE" },
        body: JSON.stringify({ action: "delete_user", target: "admin" }),
      },
      candidateRef: "cand_1",
      isShadow: false,
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("tool_call");
    expect((projected as NormalizedToolCallEvent).callId).toBe("call_abc_123");
    expect((projected as NormalizedToolCallEvent).toolName).toBe("curl");
    expect((projected as NormalizedToolCallEvent).parameters).toEqual({});
    expect((projected as NormalizedToolCallEvent).candidateRef).toBe("cand_1");
    expect((projected as NormalizedToolCallEvent).isShadow).toBe(false);
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("parameters");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects tool_result event: strips result while preserving callId, toolName, isError, executionDurationMs, outputSizeBytes", () => {
    const original: NormalizedToolResultEvent = {
      ...createBaseHeaders(5),
      type: "tool_result",
      callId: "call_abc_123",
      toolName: "curl",
      result: {
        status: 200,
        data: "SECRET_INTERNAL_DATABASE_DUMP_ROW_1_ROW_2",
      },
      isError: false,
      executionDurationMs: 310,
      outputSizeBytes: 4096,
      isShadow: false,
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("tool_result");
    expect((projected as NormalizedToolResultEvent).callId).toBe("call_abc_123");
    expect((projected as NormalizedToolResultEvent).toolName).toBe("curl");
    expect((projected as NormalizedToolResultEvent).result).toBeUndefined();
    expect((projected as NormalizedToolResultEvent).isError).toBe(false);
    expect((projected as NormalizedToolResultEvent).executionDurationMs).toBe(310);
    expect((projected as NormalizedToolResultEvent).outputSizeBytes).toBe(4096);
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("result");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects command_exec event: strips command, args, cwd, stdout, stderr while preserving exitCode and durationMs", () => {
    const original: NormalizedCommandExecEvent = {
      ...createBaseHeaders(6),
      type: "command_exec",
      command: "export SECRET_API_KEY='12345' && deploy.sh",
      args: ["--token=SECRET_TOKEN_XYZ", "--dest=/var/secrets"],
      cwd: "/Users/alice/classified-project",
      exitCode: 0,
      stdout: "SECRET_STDOUT: Successfully uploaded certificate to prod",
      stderr: "SECRET_STDERR: Debug warning at line 42",
      durationMs: 1250,
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("command_exec");
    expect((projected as NormalizedCommandExecEvent).command).toBe("");
    expect((projected as NormalizedCommandExecEvent).args).toEqual([]);
    expect((projected as NormalizedCommandExecEvent).cwd).toBeUndefined();
    expect((projected as NormalizedCommandExecEvent).stdout).toBeUndefined();
    expect((projected as NormalizedCommandExecEvent).stderr).toBeUndefined();
    expect((projected as NormalizedCommandExecEvent).exitCode).toBe(0);
    expect((projected as NormalizedCommandExecEvent).durationMs).toBe(1250);
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("command");
    expect(projected.redaction.redactedFields).toContain("args");
    expect(projected.redaction.redactedFields).toContain("cwd");
    expect(projected.redaction.redactedFields).toContain("stdout");
    expect(projected.redaction.redactedFields).toContain("stderr");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects file_edit event: strips patch while preserving filePath, operation, hashes, diffStats", () => {
    const original: NormalizedFileEditEvent = {
      ...createBaseHeaders(7),
      type: "file_edit",
      filePath: "src/auth/keys.ts",
      operation: "update",
      patch: "@@ -1,3 +1,3 @@\n-const OLD_SECRET = 'abc';\n+const NEW_SECRET = 'def';",
      afterHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      diffStats: { linesAdded: 1, linesRemoved: 1 },
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("file_edit");
    expect((projected as NormalizedFileEditEvent).filePath).toBe("src/auth/keys.ts");
    expect((projected as NormalizedFileEditEvent).operation).toBe("update");
    expect((projected as NormalizedFileEditEvent).patch).toBeUndefined();
    expect((projected as NormalizedFileEditEvent).beforeHash).toBe(original.beforeHash);
    expect((projected as NormalizedFileEditEvent).afterHash).toBe(original.afterHash);
    expect((projected as NormalizedFileEditEvent).diffStats).toEqual(original.diffStats);
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("patch");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects error event: strips message, stack, details while preserving errorType and recoverable flag", () => {
    const original: NormalizedErrorEvent = {
      ...createBaseHeaders(8),
      type: "error",
      errorType: "ConnectionTimeoutError",
      message: "Connection failed with SECRET_CREDENTIALS at redis://user:secret@10.0.0.1:6379",
      stack: "Error: SECRET_STACK_TRACE at Redis.connect (/app/redis.ts:15)",
      recoverable: true,
      details: {
        host: "10.0.0.1",
        user: "admin",
        secretToken: "SECRET_DETAIL_VAL",
      },
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("error");
    expect((projected as NormalizedErrorEvent).errorType).toBe("ConnectionTimeoutError");
    expect((projected as NormalizedErrorEvent).message).toBe("");
    expect((projected as NormalizedErrorEvent).stack).toBeUndefined();
    expect((projected as NormalizedErrorEvent).details).toBeUndefined();
    expect((projected as NormalizedErrorEvent).recoverable).toBe(true);
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("message");
    expect(projected.redaction.redactedFields).toContain("stack");
    expect(projected.redaction.redactedFields).toContain("details");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects compaction event: strips preservedContextSummary while preserving token accounting", () => {
    const original: NormalizedCompactionEvent = {
      ...createBaseHeaders(9),
      type: "compaction",
      triggerReason: "context_limit",
      tokensBefore: 180000,
      tokensAfter: 45000,
      preservedContextSummary:
        "SECRET_SUMMARY: The user requested architecture changes for private project X",
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("compaction");
    expect((projected as NormalizedCompactionEvent).triggerReason).toBe("context_limit");
    expect((projected as NormalizedCompactionEvent).tokensBefore).toBe(180000);
    expect((projected as NormalizedCompactionEvent).tokensAfter).toBe(45000);
    expect((projected as NormalizedCompactionEvent).preservedContextSummary).toBeUndefined();
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("preservedContextSummary");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects branch_fork event: strips forkReason while preserving source/branch point and branchName", () => {
    const original: NormalizedBranchForkEvent = {
      ...createBaseHeaders(10),
      type: "branch_fork",
      sourceSessionId: "sess_parent_1",
      branchPointEventId: "evt_0000000000000005",
      forkReason: "SECRET_FORK_REASON: Testing secret algorithm against baseline",
      branchName: "experiment-alpha",
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("branch_fork");
    expect((projected as NormalizedBranchForkEvent).sourceSessionId).toBe("sess_parent_1");
    expect((projected as NormalizedBranchForkEvent).branchPointEventId).toBe(
      "evt_0000000000000005",
    );
    expect((projected as NormalizedBranchForkEvent).forkReason).toBeUndefined();
    expect((projected as NormalizedBranchForkEvent).branchName).toBe("experiment-alpha");
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("forkReason");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects subagent_lifecycle event: strips reason while preserving subagentId, lifecycleType, parentId, role", () => {
    const original: NormalizedSubagentLifecycleEvent = {
      ...createBaseHeaders(11),
      type: "subagent_lifecycle",
      subagentId: "sub_agent_99",
      lifecycleType: "spawn",
      parentId: "sub_agent_root",
      role: "code_reviewer",
      reason: "SECRET_SPAWN_REASON: Reviewing confidential proprietary codebase",
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("subagent_lifecycle");
    expect((projected as NormalizedSubagentLifecycleEvent).subagentId).toBe("sub_agent_99");
    expect((projected as NormalizedSubagentLifecycleEvent).lifecycleType).toBe("spawn");
    expect((projected as NormalizedSubagentLifecycleEvent).parentId).toBe("sub_agent_root");
    expect((projected as NormalizedSubagentLifecycleEvent).role).toBe("code_reviewer");
    expect((projected as NormalizedSubagentLifecycleEvent).reason).toBeUndefined();
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("reason");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects session_lifecycle event: preserves lifecycleType, harnessName, workspaceId", () => {
    const original: NormalizedSessionLifecycleEvent = {
      ...createBaseHeaders(12),
      type: "session_lifecycle",
      lifecycleType: "start",
      harnessName: "claude-code",
      workspaceId: "ws_my_workspace",
      exitReason: "normal_start",
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("session_lifecycle");
    expect((projected as NormalizedSessionLifecycleEvent).lifecycleType).toBe("start");
    expect((projected as NormalizedSessionLifecycleEvent).harnessName).toBe("claude-code");
    expect((projected as NormalizedSessionLifecycleEvent).workspaceId).toBe("ws_my_workspace");
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("projects unknown_passthrough event: empties rawPayload while preserving rawEventType", () => {
    const original: NormalizedUnknownPassthroughEvent = {
      ...createBaseHeaders(13),
      type: "unknown_passthrough",
      rawEventType: "custom_harness_telemetry",
      rawPayload: {
        secretRawField1: "SECRET_VALUE_1",
        secretRawField2: { nestedKey: "SECRET_NESTED_VALUE" },
      },
    };

    const projected = projectEventToMetadataOnly(original);

    expect(projected.type).toBe("unknown_passthrough");
    expect((projected as NormalizedUnknownPassthroughEvent).rawEventType).toBe(
      "custom_harness_telemetry",
    );
    expect((projected as NormalizedUnknownPassthroughEvent).rawPayload).toEqual({});
    expect(projected.redaction.isRedacted).toBe(true);
    expect(projected.redaction.redactionStrategy).toBe("drop");
    expect(projected.redaction.redactedFields).toContain("rawPayload");

    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("guarantees zero secret markers in serialized JSON across an entire mixed batch", () => {
    const secretMarkers = [
      "SECRET_USER_PASSWORD_123",
      "SECRET_REASONING_CHAIN_KEY",
      "SECRET_TOOL_SCHEMA_PROPERTY",
      "SECRET_TOOL_INVOCATION_ARG",
      "SECRET_TOOL_DATABASE_RESULT",
      "SECRET_CLI_COMMAND_STRING",
      "SECRET_FILE_DIFF_CONTENT",
      "SECRET_STACK_TRACE_LINE",
      "SECRET_COMPACTION_SUMMARY_TEXT",
      "SECRET_FORK_RATIONALE",
      "SECRET_SUBAGENT_PURPOSE",
      "SECRET_PASSTHROUGH_BLOB",
    ];

    const events: NormalizedSessionEvent[] = [
      {
        ...createBaseHeaders(1),
        type: "message",
        role: "user",
        content: `Secret: ${secretMarkers[0]}`,
      },
      {
        ...createBaseHeaders(2),
        type: "model_reasoning",
        reasoningContent: `Secret: ${secretMarkers[1]}`,
      },
      {
        ...createBaseHeaders(3),
        type: "tool_discovery",
        tools: [
          {
            name: "mcp_tool",
            description: secretMarkers[2],
            inputSchema: { val: secretMarkers[2] },
          },
        ],
      },
      {
        ...createBaseHeaders(4),
        type: "tool_call",
        callId: "c_1",
        toolName: "bash",
        parameters: { cmd: secretMarkers[3] },
      },
      {
        ...createBaseHeaders(5),
        type: "tool_result",
        callId: "c_1",
        toolName: "bash",
        result: { out: secretMarkers[4] },
        isError: false,
        executionDurationMs: 10,
      },
      {
        ...createBaseHeaders(6),
        type: "command_exec",
        command: secretMarkers[5],
        args: [secretMarkers[5]],
        cwd: `/home/${secretMarkers[5]}`,
        stdout: secretMarkers[5],
        stderr: secretMarkers[5],
        exitCode: 0,
        durationMs: 50,
      },
      {
        ...createBaseHeaders(7),
        type: "file_edit",
        filePath: "app.ts",
        operation: "update",
        patch: secretMarkers[6],
      },
      {
        ...createBaseHeaders(8),
        type: "error",
        errorType: "FatalError",
        message: secretMarkers[7],
        stack: secretMarkers[7],
        recoverable: false,
        details: { detail: secretMarkers[7] },
      },
      {
        ...createBaseHeaders(9),
        type: "compaction",
        triggerReason: "manual",
        tokensBefore: 1000,
        tokensAfter: 500,
        preservedContextSummary: secretMarkers[8],
      },
      {
        ...createBaseHeaders(10),
        type: "branch_fork",
        sourceSessionId: "sess_1",
        branchPointEventId: "evt_0000000000000005",
        forkReason: secretMarkers[9],
      },
      {
        ...createBaseHeaders(11),
        type: "subagent_lifecycle",
        subagentId: "sub_1",
        lifecycleType: "spawn",
        reason: secretMarkers[10],
      },
      {
        ...createBaseHeaders(12),
        type: "unknown_passthrough",
        rawEventType: "custom",
        rawPayload: { blob: secretMarkers[11] },
      },
    ];

    const projected = events.map((e) => projectEventToMetadataOnly(e));
    const serialized = JSON.stringify(projected);

    for (const marker of secretMarkers) {
      expect(serialized).not.toContain(marker);
    }

    for (const p of projected) {
      expect(p.redaction.isRedacted).toBe(true);
      expect(p.redaction.redactionStrategy).toBe("drop");
      expect(NormalizedSessionEventSchema.safeParse(p).success).toBe(true);
    }
  });
});
