import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/normalization/redaction.js";
import {
  type LogEntry,
  StructuredLogger,
  createStructuredLogger,
  redactSecrets,
} from "../../src/observability/logger.js";

describe("StructuredLogger", () => {
  it("formats structured JSON log entries with timestamp and level", () => {
    const sinkLogs: LogEntry[] = [];
    const logger = createStructuredLogger({
      level: "debug",
      sink: (entry) => sinkLogs.push(entry),
    });

    logger.info("System initialized", { module: "supervisor" });

    expect(sinkLogs).toHaveLength(1);
    const entry = sinkLogs[0];
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("System initialized");
    expect(entry.context).toEqual({ module: "supervisor" });
    expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
  });

  it("propagates correlation IDs into every log entry", () => {
    const sinkLogs: LogEntry[] = [];
    const logger = createStructuredLogger({
      initialContext: {
        traceId: "tr_abc123",
        spanId: "sp_456",
        sessionId: "sess_789",
        invocationId: "inv_001",
        toolId: "file_search",
        workspaceId: "ws_main",
        deviceId: "dev_xyz",
      },
      sink: (entry) => sinkLogs.push(entry),
    });

    logger.info("Tool invocation started");

    expect(sinkLogs).toHaveLength(1);
    const entry = sinkLogs[0];
    expect(entry.traceId).toBe("tr_abc123");
    expect(entry.spanId).toBe("sp_456");
    expect(entry.sessionId).toBe("sess_789");
    expect(entry.invocationId).toBe("inv_001");
    expect(entry.toolId).toBe("file_search");
    expect(entry.workspaceId).toBe("ws_main");
    expect(entry.deviceId).toBe("dev_xyz");
  });

  it("supports child loggers with merged contextual metadata", () => {
    const sinkLogs: LogEntry[] = [];
    const parent = createStructuredLogger({
      initialContext: { traceId: "tr_parent", workspaceId: "ws_alpha" },
      sink: (entry) => sinkLogs.push(entry),
    });

    const child = parent.child({
      spanId: "sp_child",
      toolId: "bash_exec",
      actorId: "user_42",
    });

    child.warn("High resource usage", { memoryMb: 1024 });

    expect(sinkLogs).toHaveLength(1);
    const entry = sinkLogs[0];
    expect(entry.traceId).toBe("tr_parent");
    expect(entry.spanId).toBe("sp_child");
    expect(entry.workspaceId).toBe("ws_alpha");
    expect(entry.toolId).toBe("bash_exec");
    expect(entry.context).toEqual({
      actorId: "user_42",
      memoryMb: 1024,
    });
  });

  it("propagates context across async call boundaries via runWithContext", async () => {
    const sinkLogs: LogEntry[] = [];
    const logger = createStructuredLogger({
      sink: (entry) => sinkLogs.push(entry),
    });

    await logger.runWithContext({ traceId: "tr_async_flow", sessionId: "sess_async" }, async () => {
      logger.info("Step 1 started");
      await Promise.resolve();
      logger.info("Step 2 finished");
    });

    expect(sinkLogs).toHaveLength(2);
    expect(sinkLogs[0].traceId).toBe("tr_async_flow");
    expect(sinkLogs[0].sessionId).toBe("sess_async");
    expect(sinkLogs[1].traceId).toBe("tr_async_flow");
    expect(sinkLogs[1].sessionId).toBe("sess_async");
  });

  it("automatically redacts sensitive keys and patterns in messages and metadata", () => {
    const sinkLogs: LogEntry[] = [];
    const logger = createStructuredLogger({
      sink: (entry) => sinkLogs.push(entry),
    });

    logger.info("Connected to database with postgres://admin:secretPass123@db.internal:5432/main", {
      apiKey: "sk-proj-123456789012345678901234567890",
      authToken: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
      userPassword: "PlainPassword99",
      sessionSecret: "super-secret-key-material",
      nested: {
        privateKey:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----",
        safeValue: "public-metadata",
      },
    });

    expect(sinkLogs).toHaveLength(1);
    const entry = sinkLogs[0];

    // Message URL password redacted
    expect(entry.message).toContain("[REDACTED_PASSWORD]");
    expect(entry.message).not.toContain("secretPass123");

    // Sensitive keys redacted
    expect(entry.context?.apiKey).toBe("[REDACTED]");
    expect(entry.context?.authToken).toBe("[REDACTED]");
    expect(entry.context?.userPassword).toBe("[REDACTED]");
    expect(entry.context?.sessionSecret).toBe("[REDACTED]");

    // SAFETY: Logger context nested field is a validated JSON object.
    const nested = entry.context?.nested as JsonObject;
    expect(nested.privateKey).toBe("[REDACTED]");
    expect(nested.safeValue).toBe("public-metadata");
  });

  it("serializes and redacts Error objects properly", () => {
    const sinkLogs: LogEntry[] = [];
    const logger = createStructuredLogger({
      sink: (entry) => sinkLogs.push(entry),
    });

    const err = new Error("Failed connecting with token sk-abcdef12345678901234567890");
    logger.error("Operation failed", { error: err });

    expect(sinkLogs).toHaveLength(1);
    const entry = sinkLogs[0];
    expect(entry.level).toBe("error");
    expect(entry.error?.name).toBe("Error");
    expect(entry.error?.message).toContain("[REDACTED_API_KEY]");
    expect(entry.error?.message).not.toContain("sk-abcdef12345678901234567890");
  });

  it("filters logs by log level", () => {
    const sinkLogs: LogEntry[] = [];
    const logger = createStructuredLogger({
      level: "warn",
      sink: (entry) => sinkLogs.push(entry),
    });

    logger.debug("Debug msg");
    logger.info("Info msg");
    logger.warn("Warn msg");
    logger.error("Error msg");

    expect(sinkLogs).toHaveLength(2);
    expect(sinkLogs[0].level).toBe("warn");
    expect(sinkLogs[1].level).toBe("error");
  });

  it("maintains in-memory ring buffer with capacity bounding", () => {
    const logger = createStructuredLogger({
      bufferCapacity: 3,
    });

    logger.info("msg 1");
    logger.info("msg 2");
    logger.info("msg 3");
    logger.info("msg 4");

    const recent = logger.getRecentLogs();
    expect(recent).toHaveLength(3);
    expect(recent.map((l) => l.message)).toEqual(["msg 2", "msg 3", "msg 4"]);

    logger.clearLogs();
    expect(logger.getRecentLogs()).toHaveLength(0);
  });
});
