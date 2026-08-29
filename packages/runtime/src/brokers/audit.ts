import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Standard broker audit event status.
 */
export type BrokerAuditStatus = "allowed" | "denied" | "error" | "success";

export type BrokerAuditValue =
  | string
  | number
  | boolean
  | null
  | readonly BrokerAuditValue[]
  | BrokerAuditValue[]
  | BrokerAuditSummary;

export interface BrokerAuditSummary {
  [key: string]: BrokerAuditValue | undefined;
}

export interface RedactedHeaderMap {
  [header: string]: string;
}

/**
 * Structured, security-sanitized broker audit event.
 * Contains only non-sensitive summary metadata.
 */
export interface BrokerAuditEvent {
  eventId: string;
  timestamp: string;
  service: "fs" | "net" | "cmd" | "secret" | "monitor" | string;
  action: string;
  invocationId: string;
  grantId?: string;
  toolId?: string;
  toolVersion?: string;
  status: BrokerAuditStatus;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  durationMs?: number;
  summary: BrokerAuditSummary;
  effect?: BrokerAuditSummary;
  quarantineId?: string;
  drift?: boolean;
}

/**
 * Sensitive HTTP header names that must always be redacted.
 */
const SENSITIVE_HEADERS = {
  authorization: true,
  "proxy-authorization": true,
  cookie: true,
  "set-cookie": true,
  "x-api-key": true,
  "api-key": true,
  "x-auth-token": true,
  bearer: true,
  token: true,
  secret: true,
  "access-token": true,
  "refresh-token": true,
  "private-key": true,
  "x-csrf-token": true,
  "x-xsrf-token": true,
} as const satisfies Record<string, true>;

/**
 * Sensitive URL query parameter keys that must always be redacted.
 */
const SENSITIVE_QUERY_PARAMS = {
  token: true,
  key: true,
  api_key: true,
  apikey: true,
  secret: true,
  signature: true,
  sig: true,
  auth: true,
  password: true,
  access_token: true,
  refresh_token: true,
  code: true,
  client_secret: true,
  credential: true,
} as const satisfies Record<string, true>;

/**
 * Blacklisted summary payload keys that must never be recorded in audit logs.
 */
const FORBIDDEN_SUMMARY_KEYS = {
  content: true,
  body: true,
  rawbody: true,
  rawcontent: true,
  filecontent: true,
  stdout: true,
  stderr: true,
  secret: true,
  secretvalue: true,
  secret_value: true,
  password: true,
  privatekey: true,
  private_key: true,
  privkey: true,
  apikey: true,
  api_key: true,
  token: true,
  access_token: true,
  auth: true,
  authorization: true,
  cookie: true,
  cert: true,
  credential: true,
  credentials: true,
  data: true,
  payload: true,
} as const satisfies Record<string, true>;
/**
 * Redacts sensitive HTTP headers by replacing their values with [REDACTED].
 */
export function redactHeaders(
  headers?: Record<string, string | string[] | undefined> | BrokerAuditSummary | null,
): RedactedHeaderMap {
  if (!headers || headers === null || Array.isArray(headers)) return {};
  const redacted: RedactedHeaderMap = {};

  for (const [key, rawVal] of Object.entries(headers)) {
    if (rawVal === undefined || rawVal === null) continue;
    const lowerKey = key.toLowerCase();
    const strVal = Array.isArray(rawVal) ? rawVal.join(", ") : String(rawVal);

    if (
      Object.hasOwn(SENSITIVE_HEADERS, lowerKey) ||
      lowerKey.includes("secret") ||
      lowerKey.includes("auth") ||
      lowerKey.includes("key") ||
      lowerKey.includes("token")
    ) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = strVal;
    }
  }

  return redacted;
}

/**
 * Redacts credentials and sensitive query parameters from a URL string.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);

    // Strip basic auth credentials
    if (parsed.username) parsed.username = "[REDACTED]";
    if (parsed.password) parsed.password = "[REDACTED]";

    // Redact sensitive query parameters
    for (const [paramKey] of Array.from(parsed.searchParams.entries())) {
      const lowerParam = paramKey.toLowerCase();
      if (
        Object.hasOwn(SENSITIVE_QUERY_PARAMS, lowerParam) ||
        lowerParam.includes("secret") ||
        lowerParam.includes("key") ||
        lowerParam.includes("token") ||
        lowerParam.includes("auth") ||
        lowerParam.includes("sig")
      ) {
        parsed.searchParams.set(paramKey, "[REDACTED]");
      }
    }

    return parsed.toString().replace(/%5BREDACTED%5D/gi, "[REDACTED]");
  } catch {
    // If URL is not parseable, return a safe placeholder or clean string
    return rawUrl.replace(/\/\/[^:]+:[^@]+@/, "//[REDACTED]:[REDACTED]@");
  }
}

/**
 * Sanitizes an arbitrary summary object to ensure no file bodies, command outputs,
 * secret payloads, or sensitive headers/URLs leak into audit logs.
 */
export function sanitizeAuditSummary(summary?: BrokerAuditSummary | null): BrokerAuditSummary {
  if (!summary || summary === null || Array.isArray(summary)) return {};
  const sanitized: BrokerAuditSummary = {};

  for (const [key, value] of Object.entries(summary)) {
    const lowerKey = key.toLowerCase();

    if (Object.hasOwn(FORBIDDEN_SUMMARY_KEYS, lowerKey)) {
      continue; // Strictly omit file contents, command stdout/stderr, and raw secrets
    }

    if (
      lowerKey === "headers" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]"
    ) {
      // SAFETY: Checked as object record for header map parsing.
      sanitized[key] = redactHeaders(value as BrokerAuditSummary);
    } else if (lowerKey === "url" && String(value) === value) {
      sanitized[key] = redactUrl(value);
    } else if (
      String(value) === value &&
      (value.startsWith("http://") || value.startsWith("https://"))
    ) {
      sanitized[key] = redactUrl(value);
    } else if (Array.isArray(value)) {
      // Avoid large arrays or payload blobs in audit summaries
      // SAFETY: Array slice keeps bounded array elements for audit summary.
      sanitized[key] = value.slice(0, 50) as BrokerAuditValue[];
    } else if (
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]"
    ) {
      // SAFETY: Checked as object record for recursive summary sanitization.
      sanitized[key] = sanitizeAuditSummary(value as BrokerAuditSummary);
    } else if (
      value === null ||
      String(value) === value ||
      Number.isFinite(value) ||
      value === true ||
      value === false
    ) {
      sanitized[key] = value;
    } else {
      sanitized[key] = String(value);
    }
  }

  return sanitized;
}

/**
 * Event emitter for broker audit events with in-memory retention and subscriber support.
 */
export class BrokerAuditEmitter extends EventEmitter {
  private readonly events: BrokerAuditEvent[] = [];
  private readonly maxRetainedEvents: number;

  constructor(options: { maxRetainedEvents?: number } = {}) {
    super();
    this.maxRetainedEvents = options.maxRetainedEvents ?? 1000;
  }

  /**
   * Emits a redacted audit event to subscribers and records it in memory.
   */
  emitAudit(
    event: Omit<BrokerAuditEvent, "eventId" | "timestamp"> & {
      eventId?: string;
      timestamp?: string;
    },
  ): BrokerAuditEvent {
    const fullEvent: BrokerAuditEvent = Object.freeze({
      eventId: event.eventId ?? `audit_${Date.now()}_${randomUUID().slice(0, 8)}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
      service: event.service,
      action: event.action,
      invocationId: event.invocationId,
      grantId: event.grantId,
      toolId: event.toolId,
      toolVersion: event.toolVersion,
      status: event.status,
      error: event.error,
      durationMs: event.durationMs,
      summary: sanitizeAuditSummary(event.summary),
      effect: event.effect ? sanitizeAuditSummary(event.effect) : undefined,
      quarantineId: event.quarantineId,
      drift: event.drift,
    });

    this.events.push(fullEvent);
    if (this.events.length > this.maxRetainedEvents) {
      this.events.shift();
    }

    this.emit("audit", fullEvent);
    this.emit(`audit:${fullEvent.service}`, fullEvent);
    return fullEvent;
  }

  /**
   * Retrieves all recorded audit events, optionally filtered.
   */
  getEvents(filter?: {
    service?: string;
    invocationId?: string;
    status?: BrokerAuditStatus;
  }): BrokerAuditEvent[] {
    let result = [...this.events];
    if (filter?.service) {
      result = result.filter((e) => e.service === filter.service);
    }
    if (filter?.invocationId) {
      result = result.filter((e) => e.invocationId === filter.invocationId);
    }
    if (filter?.status) {
      result = result.filter((e) => e.status === filter.status);
    }
    return result;
  }

  /**
   * Clears in-memory retained audit events.
   */
  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Global default audit emitter instance.
 */
export const defaultBrokerAuditEmitter = new BrokerAuditEmitter();
