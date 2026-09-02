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
import {
  RESIN_PARAMETER_SHAPE_KEY,
  extractParameterShape,
  projectEventToMetadataOnly,
} from "../../src/analytics/metadata-projection.js";

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
    if (projected.type !== "message") throw new Error("Expected message event");
    expect(projected.content).toBe("");
    expect(projected.contentParts).toBeUndefined();
    expect(projected.role).toBe("user");
    expect(projected.model).toBe("claude-3-5-sonnet");
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
    if (projected.type !== "model_reasoning") throw new Error("Expected model_reasoning event");
    expect(projected.reasoningContent).toBe("");
    expect(projected.signature).toBeUndefined();
    expect(projected.tokenCount).toBe(280);
    expect(projected.model).toBe("claude-3-7-sonnet");
    expect(projected.durationMs).toBe(850);
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
    if (projected.type !== "tool_discovery") throw new Error("Expected tool_discovery event");
    const tools = projected.tools;
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

  it("projects tool_call event: projects bounded structural parameters without values while preserving callId, toolName, shadow flag, candidateRef", () => {
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
    if (projected.type !== "tool_call") throw new Error("Expected tool_call event");
    expect(projected.callId).toBe("call_abc_123");
    expect(projected.toolName).toBe("curl");
    expect(projected.parameters).toEqual({
      [RESIN_PARAMETER_SHAPE_KEY]: {
        body: "string",
        headers: {
          Authorization: "string",
        },
        url: "string",
      },
    });
    expect(Object.keys(projected.parameters)).toEqual([RESIN_PARAMETER_SHAPE_KEY]);
    expect(projected.parameters.url).toBeUndefined();
    expect(projected.parameters.headers).toBeUndefined();
    expect(projected.parameters.body).toBeUndefined();
    expect(projected.candidateRef).toBe("cand_1");
    expect(projected.isShadow).toBe(false);
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
    if (projected.type !== "tool_result") throw new Error("Expected tool_result event");
    expect(projected.callId).toBe("call_abc_123");
    expect(projected.toolName).toBe("curl");
    expect(projected.result).toBeUndefined();
    expect(projected.isError).toBe(false);
    expect(projected.executionDurationMs).toBe(310);
    expect(projected.outputSizeBytes).toBe(4096);
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
    if (projected.type !== "command_exec") throw new Error("Expected command_exec event");
    expect(projected.command).toBe("");
    expect(projected.args).toEqual([]);
    expect(projected.cwd).toBeUndefined();
    expect(projected.stdout).toBeUndefined();
    expect(projected.stderr).toBeUndefined();
    expect(projected.exitCode).toBe(0);
    expect(projected.durationMs).toBe(1250);
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
    if (projected.type !== "file_edit") throw new Error("Expected file_edit event");
    expect(projected.filePath).toBe("src/auth/keys.ts");
    expect(projected.operation).toBe("update");
    expect(projected.patch).toBeUndefined();
    expect(projected.beforeHash).toBe(original.beforeHash);
    expect(projected.afterHash).toBe(original.afterHash);
    expect(projected.diffStats).toEqual(original.diffStats);
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
    if (projected.type !== "error") throw new Error("Expected error event");
    expect(projected.errorType).toBe("ConnectionTimeoutError");
    expect(projected.message).toBe("");
    expect(projected.stack).toBeUndefined();
    expect(projected.details).toBeUndefined();
    expect(projected.recoverable).toBe(true);
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
    if (projected.type !== "compaction") throw new Error("Expected compaction event");
    expect(projected.triggerReason).toBe("context_limit");
    expect(projected.tokensBefore).toBe(180000);
    expect(projected.tokensAfter).toBe(45000);
    expect(projected.preservedContextSummary).toBeUndefined();
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
    if (projected.type === "branch_fork") {
      expect(projected.sourceSessionId).toBe("sess_parent_1");
      expect(projected.branchPointEventId).toBe("evt_0000000000000005");
      expect(projected.branchName).toBe("experiment-alpha");
      expect(projected.forkReason).toBeUndefined();
    }
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
    if (projected.type !== "subagent_lifecycle")
      throw new Error("Expected subagent_lifecycle event");
    expect(projected.subagentId).toBe("sub_agent_99");
    expect(projected.lifecycleType).toBe("spawn");
    expect(projected.parentId).toBe("sub_agent_root");
    expect(projected.role).toBe("code_reviewer");
    expect(projected.reason).toBeUndefined();
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
    if (projected.type !== "session_lifecycle") throw new Error("Expected session_lifecycle event");
    expect(projected.lifecycleType).toBe("start");
    expect(projected.harnessName).toBe("claude-code");
    expect(projected.workspaceId).toBe("ws_my_workspace");
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
    if (projected.type === "unknown_passthrough") {
      expect(projected.rawEventType).toBe("custom_harness_telemetry");
      expect(projected.rawPayload).toEqual({});
    }
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

describe("extractParameterShape", () => {
  it("extracts primitive kinds without retaining literal values", () => {
    const raw = {
      str: "super-secret-password-12345",
      num: 42.5,
      boolTrue: true,
      boolFalse: false,
      nil: null,
      undef: undefined,
    };
    const shape = extractParameterShape(raw);
    expect(shape).toEqual({
      boolFalse: "boolean",
      boolTrue: "boolean",
      nil: "null",
      num: "number",
      str: "string",
      undef: "undefined",
    });
    expect(JSON.stringify(shape)).not.toContain("super-secret-password-12345");
  });

  it("extracts nested records with array element shapes like records[{status:string}]", () => {
    const raw = {
      records: [
        { status: "active", code: 200 },
        { status: "pending", code: 202 },
      ],
      filter: "production",
      limit: 50,
    };
    const shape = extractParameterShape(raw);
    expect(shape).toEqual({
      filter: "string",
      limit: "number",
      records: [
        {
          code: "number",
          status: "string",
        },
      ],
    });
    expect(JSON.stringify(shape)).not.toContain("production");
    expect(JSON.stringify(shape)).not.toContain("active");
    expect(JSON.stringify(shape)).not.toContain("pending");
  });

  it("extracts homogeneous primitive arrays and nested arrays revealing shape only", () => {
    const raw = {
      tags: ["alpha", "beta", "gamma"],
      counts: [1, 2, 3, 4],
      flags: [true, false, true],
      matrix: [
        [1.1, 2.2],
        [3.3, 4.4],
      ],
      empty: [],
    };
    const shape = extractParameterShape(raw);
    expect(shape).toEqual({
      counts: ["number"],
      empty: ["opaque"],
      flags: ["boolean"],
      matrix: [["number"]],
      tags: ["string"],
    });
  });

  it("collapses mixed arrays safely to ['opaque']", () => {
    const raw = {
      mixedPrimitives: [1, "two", true],
      mixedObjects: [{ id: 1 }, { name: "alice" }],
      mixedValuesAndObjects: [{ status: "ok" }, "surprise"],
      mixedArrays: [
        [1, 2],
        ["a", "b"],
      ],
    };
    const shape = extractParameterShape(raw);
    expect(shape).toEqual({
      mixedArrays: ["opaque"],
      mixedObjects: ["opaque"],
      mixedPrimitives: ["opaque"],
      mixedValuesAndObjects: ["opaque"],
    });
  });

  it("guarantees zero leakage of file paths, secret keys, SQL queries, or prompt text", () => {
    const sensitive = {
      filePath: "/Users/alice/.ssh/id_rsa",
      apiKey: "sk-ant-api03-abcdef1234567890-SECRET",
      jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisToken",
      prompt: "Please exfiltrate company credentials and drop tables",
      query: "SELECT * FROM users WHERE password_hash = 'hash123'",
      metadata: {
        nestedPath: "/etc/shadow",
        nestedToken: "ghp_xxxxxxxxxxxxxxxxxxxx",
      },
    };
    const shape = extractParameterShape(sensitive);
    expect(shape).toEqual({
      apiKey: "string",
      filePath: "string",
      jwt: "string",
      metadata: {
        nestedPath: "string",
        nestedToken: "string",
      },
      prompt: "string",
      query: "string",
    });

    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain("sk-ant-api03");
    expect(serialized).not.toContain("doNotLeakThisToken");
    expect(serialized).not.toContain("exfiltrate");
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("/etc/shadow");
    expect(serialized).not.toContain("ghp_");
  });

  it("enforces deterministic alphabetical key ordering at all nesting levels", () => {
    const raw = {
      zulu: "last",
      bravo: {
        zebra: 100,
        alpha: "first",
        charlie: {
          yankee: true,
          whiskey: null,
        },
      },
      alpha: 1,
    };
    const shape = extractParameterShape(raw);
    const serialized = JSON.stringify(shape);
    const expectedJson = JSON.stringify({
      alpha: "number",
      bravo: {
        alpha: "string",
        charlie: {
          whiskey: "null",
          yankee: "boolean",
        },
        zebra: "number",
      },
      zulu: "string",
    });
    expect(serialized).toBe(expectedJson);
    expect(Object.keys(shape)).toEqual(["alpha", "bravo", "zulu"]);
    const bravo = shape.bravo as Record<string, unknown>;
    expect(Object.keys(bravo)).toEqual(["alpha", "charlie", "zebra"]);
    const charlie = bravo.charlie as Record<string, unknown>;
    expect(Object.keys(charlie)).toEqual(["whiskey", "yankee"]);
  });

  it("enforces depth, key count, and key name length limits", () => {
    const deep = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: "too deep",
            },
          },
        },
      },
    };
    const depthCapped = extractParameterShape(deep, { maxDepth: 3 });
    expect(depthCapped).toEqual({
      l1: {
        l2: {
          l3: "opaque",
        },
      },
    });

    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const key = `k_${i.toString().padStart(2, "0")}`;
      manyKeys[key] = i;
    }
    const keysCapped = extractParameterShape(manyKeys, { maxKeys: 3 });
    expect(Object.keys(keysCapped)).toEqual(["k_00", "k_01", "k_02"]);

    const longKey = "a".repeat(100);
    const lengthCapped = extractParameterShape({ [longKey]: "val" }, { maxKeyLength: 10 });
    expect(lengthCapped).toEqual({
      ["a".repeat(10)]: "string",
    });
  });

  it("safely handles circular references and self-referencing containers", () => {
    const cyclicObj: Record<string, unknown> = {
      name: "cycle-root",
    };
    cyclicObj.self = cyclicObj;

    const shape = extractParameterShape(cyclicObj);
    expect(shape).toEqual({
      name: "string",
      self: "opaque",
    });

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    const arrayContainer = {
      list: cyclicArray,
    };
    const arrayShape = extractParameterShape(arrayContainer);
    expect(arrayShape).toEqual({
      list: ["opaque"],
    });

    const nodeA: Record<string, unknown> = { id: "a" };
    const nodeB: Record<string, unknown> = { id: "b" };
    nodeA.next = nodeB;
    nodeB.next = nodeA;
    const mutualShape = extractParameterShape({ graph: nodeA });
    expect(mutualShape).toEqual({
      graph: {
        id: "string",
        next: {
          id: "string",
          next: "opaque",
        },
      },
    });

    // Non-cyclic diamond / shared references extract cleanly
    const shared = { sharedField: "common" };
    const diamond = { branchA: shared, branchB: shared };
    const diamondShape = extractParameterShape(diamond);
    expect(diamondShape).toEqual({
      branchA: { sharedField: "string" },
      branchB: { sharedField: "string" },
    });
  });

  it("protects against prototype pollution and reserved property names", () => {
    const raw = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","valid":"ok"}',
    );
    const shape = extractParameterShape(raw);
    expect(shape).toEqual({
      valid: "string",
    });
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("fails closed to 'opaque' for non-plain objects and unusual types", () => {
    const raw = {
      date: new Date(),
      regex: /^[a-z]+$/,
      error: new Error("sample error"),
      map: new Map(),
      set: new Set(),
      fn: () => 42,
      sym: Symbol("test"),
      big: 9007199254740991n,
    };
    const shape = extractParameterShape(raw);
    expect(shape).toEqual({
      big: "opaque",
      date: "opaque",
      error: "opaque",
      fn: "opaque",
      map: "opaque",
      regex: "opaque",
      set: "opaque",
      sym: "opaque",
    });
  });

  it("fails closed to {} for invalid top-level inputs", () => {
    expect(extractParameterShape(null)).toEqual({});
    expect(extractParameterShape(undefined)).toEqual({});
    expect(extractParameterShape("not an object")).toEqual({});
    expect(extractParameterShape(123)).toEqual({});
    expect(extractParameterShape([1, 2, 3])).toEqual({});
    expect(extractParameterShape(new Date())).toEqual({});
  });

  it("demonstrates projectEventToMetadataOnly projects complex tool_call with nested records[{status:string}]", () => {
    const original: NormalizedToolCallEvent = {
      ...createBaseHeaders(100),
      type: "tool_call",
      callId: "call_records_999",
      toolName: "aggregate_status_records",
      parameters: {
        records: [
          { status: "SUCCESS", latencyMs: 120, host: "prod-node-01.internal" },
          { status: "FAILED", latencyMs: 450, host: "prod-node-02.internal" },
        ],
        windowSize: 300,
        dryRun: false,
      },
      isShadow: false,
    };

    const projected = projectEventToMetadataOnly(original);
    expect(projected.type).toBe("tool_call");
    if (projected.type !== "tool_call") throw new Error("Expected tool_call event");
    expect(projected.toolName).toBe("aggregate_status_records");
    expect(projected.parameters).toEqual({
      [RESIN_PARAMETER_SHAPE_KEY]: {
        dryRun: "boolean",
        records: [
          {
            host: "string",
            latencyMs: "number",
            status: "string",
          },
        ],
        windowSize: "number",
      },
    });
    expect(Object.keys(projected.parameters)).toEqual([RESIN_PARAMETER_SHAPE_KEY]);
    expect(projected.parameters.records).toBeUndefined();
    expect(projected.parameters.windowSize).toBeUndefined();
    expect(projected.parameters.dryRun).toBeUndefined();
    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
  });

  it("returns ['opaque'] for empty arrays to prevent cardinality signal leakage", () => {
    const shape = extractParameterShape({
      emptyList: [],
      nestedEmpty: {
        items: [],
      },
    });
    expect(shape).toEqual({
      emptyList: ["opaque"],
      nestedEmpty: {
        items: ["opaque"],
      },
    });
  });

  it("normalizes invalid, zero, negative, NaN, and Infinity option values to defaults", () => {
    const sample = { a: "test", b: 123 };
    // All invalid / non-positive / non-finite inputs safely fallback to defaults
    expect(extractParameterShape(sample, { maxNodes: Number.POSITIVE_INFINITY })).toEqual({
      a: "string",
      b: "number",
    });
    expect(extractParameterShape(sample, { maxNodes: 0 })).toEqual({ a: "string", b: "number" });
    expect(extractParameterShape(sample, { maxNodes: -10 })).toEqual({ a: "string", b: "number" });
    expect(extractParameterShape(sample, { maxNodes: Number.NaN })).toEqual({
      a: "string",
      b: "number",
    });
    expect(extractParameterShape(sample, { maxDepth: Number.POSITIVE_INFINITY })).toEqual({
      a: "string",
      b: "number",
    });
    expect(extractParameterShape(sample, { maxDepth: 0 })).toEqual({ a: "string", b: "number" });
    expect(extractParameterShape(sample, { maxKeys: -5 })).toEqual({ a: "string", b: "number" });
    expect(extractParameterShape(sample, { maxKeyLength: 0 })).toEqual({
      a: "string",
      b: "number",
    });
  });

  it("clamps options to hard maxima (depth 8, keys 64, keyLength 128, nodes 1024)", () => {
    // Generate 100 properties
    const hugeObj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      hugeObj[`prop_${i.toString().padStart(3, "0")}`] = i;
    }
    // Asking for 500 keys is clamped to HARD_MAX_KEYS = 64
    const clampedKeys = extractParameterShape(hugeObj, { maxKeys: 500 });
    expect(Object.keys(clampedKeys).length).toBe(64);

    // Asking for 200 key length is clamped to HARD_MAX_KEY_LENGTH = 128
    const longKey = "k".repeat(200);
    const clampedKeyLength = extractParameterShape({ [longKey]: "val" }, { maxKeyLength: 200 });
    expect(Object.keys(clampedKeyLength)[0]?.length).toBe(128);
  });

  it("enforces exact total node budget on huge flat inputs without allocating unbounded key arrays", () => {
    const hugeFlat: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      hugeFlat[`k_${i.toString().padStart(4, "0")}`] = i;
    }

    // Helper to count actual emitted descriptor nodes in output tree
    const countNodes = (node: unknown): number => {
      if (typeof node === "string") return 1;
      if (Array.isArray(node)) {
        return 1 + node.reduce((acc: number, el: unknown) => acc + countNodes(el), 0);
      }
      if (typeof node === "object" && node !== null) {
        return (
          1 + Object.values(node).reduce((acc: number, el: unknown) => acc + countNodes(el), 0)
        );
      }
      return 1;
    };

    // maxNodes: 5 -> 1 root object node + 4 property primitive nodes = 5 nodes
    const shape5 = extractParameterShape(hugeFlat, { maxNodes: 5 });
    expect(countNodes(shape5)).toBe(5);
    expect(Object.keys(shape5)).toEqual(["k_0000", "k_0001", "k_0002", "k_0003"]);

    // maxNodes: 10 -> 1 root object node + 9 property primitive nodes = 10 nodes
    const shape10 = extractParameterShape(hugeFlat, { maxNodes: 10 });
    expect(countNodes(shape10)).toBe(10);
    expect(Object.keys(shape10).length).toBe(9);
  });

  it("enforces node budget across complex deep branching tree structures", () => {
    interface TreeNode {
      val: number;
      left?: TreeNode;
      right?: TreeNode;
    }

    const buildTree = (depth: number): TreeNode => {
      if (depth <= 0) return { val: depth };
      return {
        val: depth,
        left: buildTree(depth - 1),
        right: buildTree(depth - 1),
      };
    };

    const countNodes = (node: unknown): number => {
      if (typeof node === "string") return 1;
      if (Array.isArray(node)) {
        return 1 + node.reduce((acc: number, el: unknown) => acc + countNodes(el), 0);
      }
      if (typeof node === "object" && node !== null) {
        return (
          1 + Object.values(node).reduce((acc: number, el: unknown) => acc + countNodes(el), 0)
        );
      }
      return 1;
    };

    const deepBranchingTree = buildTree(6);
    const budgetedShape = extractParameterShape(
      deepBranchingTree as unknown as Record<string, unknown>,
      {
        maxNodes: 15,
      },
    );

    expect(countNodes(budgetedShape)).toBeLessThanOrEqual(15);
  });

  it("emits at most 2 descriptor nodes when maxNodes=2 with an empty array", () => {
    const countNodes = (node: unknown): number => {
      if (typeof node === "string") return 1;
      if (Array.isArray(node)) {
        return 1 + node.reduce((acc: number, el: unknown) => acc + countNodes(el), 0);
      }
      if (typeof node === "object" && node !== null) {
        return (
          1 + Object.values(node).reduce((acc: number, el: unknown) => acc + countNodes(el), 0)
        );
      }
      return 1;
    };

    const shape = extractParameterShape({ list: [] }, { maxNodes: 2 });
    // With maxNodes=2: 1 root object node + 1 child node ("opaque") = 2 nodes total
    expect(countNodes(shape)).toBeLessThanOrEqual(2);
    expect(shape).toEqual({ list: "opaque" });
  });

  it("shares maxNodes globally across deep and wide array traversals without exceeding descriptor-node cap", () => {
    const countNodes = (node: unknown): number => {
      if (typeof node === "string") return 1;
      if (Array.isArray(node)) {
        return 1 + node.reduce((acc: number, el: unknown) => acc + countNodes(el), 0);
      }
      if (typeof node === "object" && node !== null) {
        return (
          1 + Object.values(node).reduce((acc: number, el: unknown) => acc + countNodes(el), 0)
        );
      }
      return 1;
    };

    // Deep nested arrays: [[[[[1]]]]]
    const deepArray = [
      [
        [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      ],
    ];
    const deepShape = extractParameterShape({ matrix: deepArray }, { maxNodes: 4 });
    expect(countNodes(deepShape)).toBeLessThanOrEqual(4);

    // Wide array of objects
    const wideArray = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `item_${i}`,
      active: true,
      score: 100 + i,
    }));
    const wideShape = extractParameterShape({ items: wideArray }, { maxNodes: 5 });
    expect(countNodes(wideShape)).toBeLessThanOrEqual(5);

    // Mixed deep and wide array
    const mixedContainer = {
      arr1: Array.from({ length: 20 }, () => [1, 2, 3]),
      arr2: Array.from({ length: 20 }, () => ({ x: 1, y: 2 })),
      arr3: ["alpha", "beta"],
    };
    const mixedShape = extractParameterShape(mixedContainer, { maxNodes: 6 });
    expect(countNodes(mixedShape)).toBeLessThanOrEqual(6);
  });

  it("never invokes root or nested own getters and projects them as opaque", () => {
    let rootGetterInvoked = false;
    let nestedGetterInvoked = false;

    const objWithGetters = {};
    Object.defineProperty(objWithGetters, "sensitiveRoot", {
      get() {
        rootGetterInvoked = true;
        throw new Error("Root getter MUST NOT be invoked");
      },
      enumerable: true,
      configurable: true,
    });

    const nestedObj = { normal: "hello" };
    Object.defineProperty(nestedObj, "sensitiveNested", {
      get() {
        nestedGetterInvoked = true;
        throw new Error("Nested getter MUST NOT be invoked");
      },
      enumerable: true,
      configurable: true,
    });

    Object.assign(objWithGetters, {
      safeField: 123,
      nested: nestedObj,
    });

    const shape = extractParameterShape(objWithGetters);
    expect(rootGetterInvoked).toBe(false);
    expect(nestedGetterInvoked).toBe(false);
    expect(shape).toEqual({
      nested: {
        normal: "string",
        sensitiveNested: "opaque",
      },
      safeField: "number",
      sensitiveRoot: "opaque",
    });
  });

  it("never invokes own getters on array indices and projects safely", () => {
    let arrayGetterInvoked = false;
    const arrWithGetter: unknown[] = ["validValue"];
    Object.defineProperty(arrWithGetter, "1", {
      get() {
        arrayGetterInvoked = true;
        return "secretGetterPayload";
      },
      enumerable: true,
      configurable: true,
    });

    const shape = extractParameterShape({ items: arrWithGetter });
    expect(arrayGetterInvoked).toBe(false);
    expect(shape).toEqual({ items: ["opaque"] });
  });

  it("keeps sampled element shape allowed when budget permits", () => {
    const raw = {
      records: [
        { status: "OK", count: 10 },
        { status: "WARN", count: 20 },
      ],
    };
    const shape = extractParameterShape(raw, { maxNodes: 10 });
    expect(shape).toEqual({
      records: [
        {
          count: "number",
          status: "string",
        },
      ],
    });
  });
});
