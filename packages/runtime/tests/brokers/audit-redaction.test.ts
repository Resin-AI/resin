import { describe, expect, it } from "vitest";
import {
  BrokerAuditEmitter,
  redactHeaders,
  redactUrl,
  sanitizeAuditSummary,
} from "../../src/brokers/audit.js";

describe("Broker Audit Trail & Redaction", () => {
  it("redacts sensitive HTTP headers while preserving safe headers", () => {
    const rawHeaders = {
      Authorization: "Bearer secret-token-abcdef123456",
      "X-Api-Key": "my-secret-api-key-999",
      Cookie: "sessionId=123456; secure",
      "Set-Cookie": "auth=secret",
      "X-Custom-Secret": "sensitive-data",
      "Content-Type": "application/json",
      Accept: "text/plain",
      "User-Agent": "Resin/1.0",
    };

    const redacted = redactHeaders(rawHeaders);

    expect(redacted.Authorization).toBe("[REDACTED]");
    expect(redacted["X-Api-Key"]).toBe("[REDACTED]");
    expect(redacted.Cookie).toBe("[REDACTED]");
    expect(redacted["Set-Cookie"]).toBe("[REDACTED]");
    expect(redacted["X-Custom-Secret"]).toBe("[REDACTED]");
    expect(redacted["Content-Type"]).toBe("application/json");
    expect(redacted.Accept).toBe("text/plain");
    expect(redacted["User-Agent"]).toBe("Resin/1.0");
  });

  it("redacts credentials and sensitive query parameters in URLs", () => {
    const sensitiveUrl =
      "https://admin:SuperPassword123@api.partner.io/v1/query?token=secretTokenVal&apiKey=abc999&search=apples";
    const cleaned = redactUrl(sensitiveUrl);

    expect(cleaned).not.toContain("SuperPassword123");
    expect(cleaned).not.toContain("secretTokenVal");
    expect(cleaned).not.toContain("abc999");
    expect(cleaned).toContain("apples");
    expect(cleaned).toContain("[REDACTED]");
  });

  it("sanitizes audit summaries by strictly omitting file bodies, command outputs, and raw secrets", () => {
    const rawSummary = {
      path: "/app/data.json",
      size: 1024,
      content: "SUPER_SECRET_FILE_BODY_DATA",
      fileContent: "ANOTHER_SECRET_BODY",
      stdout: "OUTPUT_LOGS_WITH_PASSWORDS",
      stderr: "ERROR_STACK_TRACE_SECRETS",
      secret: "RAW_SECRET_STRING_VALUE",
      secretValue: "ANOTHER_SECRET",
      password: "secret_password",
      url: "https://user:pass@api.example.com/data?key=secret123",
      headers: {
        Authorization: "Bearer my-token",
        Host: "api.example.com",
      },
      exitCode: 0,
      durationMs: 120,
    };

    const sanitized = sanitizeAuditSummary(rawSummary);

    // Forbidden keys must be completely absent
    expect(sanitized.content).toBeUndefined();
    expect(sanitized.fileContent).toBeUndefined();
    expect(sanitized.stdout).toBeUndefined();
    expect(sanitized.stderr).toBeUndefined();
    expect(sanitized.secret).toBeUndefined();
    expect(sanitized.secretValue).toBeUndefined();
    expect(sanitized.password).toBeUndefined();

    // Safe metadata must be preserved
    expect(sanitized.path).toBe("/app/data.json");
    expect(sanitized.size).toBe(1024);
    expect(sanitized.exitCode).toBe(0);
    expect(sanitized.durationMs).toBe(120);

    // Headers and URLs must be redacted
    expect(sanitized.headers).toEqual({
      Authorization: "[REDACTED]",
      Host: "api.example.com",
    });

    expect(sanitized.url).toBe("https://[REDACTED]:[REDACTED]@api.example.com/data?key=[REDACTED]");
  });

  it("records and filters audit events via BrokerAuditEmitter", () => {
    const emitter = new BrokerAuditEmitter();
    const receivedEvents: unknown[] = [];

    emitter.on("audit", (ev) => receivedEvents.push(ev));
    emitter.on("audit:fs", (ev) => expect(ev.service).toBe("fs"));

    emitter.emitAudit({
      service: "fs",
      action: "readFile",
      invocationId: "inv_audit_001",
      status: "allowed",
      summary: { path: "data.txt", size: 50, content: "SHOULD_BE_REDACTED" },
    });

    emitter.emitAudit({
      service: "net",
      action: "request",
      invocationId: "inv_audit_002",
      status: "denied",
      error: { code: "BLOCKED_IP_RANGE", message: "Private IP blocked" },
      summary: { url: "http://10.0.0.1" },
    });

    expect(receivedEvents.length).toBe(2);

    // Filter by service
    const fsEvents = emitter.getEvents({ service: "fs" });
    expect(fsEvents.length).toBe(1);
    expect(fsEvents[0]?.action).toBe("readFile");
    expect(fsEvents[0]?.summary.content).toBeUndefined(); // Verify redaction on emitted event

    const deniedEvents = emitter.getEvents({ status: "denied" });
    expect(deniedEvents.length).toBe(1);
    expect(deniedEvents[0]?.service).toBe("net");

    // Clear
    emitter.clear();
    expect(emitter.getEvents().length).toBe(0);
  });
});
