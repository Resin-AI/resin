import { AsyncLocalStorage } from "node:async_hooks";
import { calculateShannonEntropy } from "../normalization/scanner.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface CorrelationContext {
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  invocationId?: string;
  toolId?: string;
  workspaceId?: string;
  deviceId?: string;
  actorId?: string;
  [key: string]: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: Exclude<LogLevel, "silent">;
  message: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  invocationId?: string;
  toolId?: string;
  workspaceId?: string;
  deviceId?: string;
  context?: Record<string, unknown>;
  error?: SerializedError;
  [key: string]: unknown;
}

export type LogSink = (entry: LogEntry, jsonLine: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bufferCapacity?: number;
  enableStdout?: boolean;
  enableAsyncStorage?: boolean;
  initialContext?: CorrelationContext;
  redactSecrets?: boolean;
}

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|key|auth|authorization|credential|credentials|assertion|signature|jwt|cookie|session|private|cert|vault/i;
const REDACTED_MARKER = "[REDACTED]";

const COMMON_SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  {
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    regex: /Bearer\s+[^\s"',;]+/gi,
    replacement: "Bearer [REDACTED]",
  },
  {
    regex:
      /(?:sk-[a-zA-Z0-9_-]{10,}|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|glpat-[a-zA-Z0-9_-]{10,}|xoxb-[a-zA-Z0-9-]{10,}|xoxp-[a-zA-Z0-9-]{10,}|resin_sec_[a-zA-Z0-9_-]{10,}|resin_tok_[a-zA-Z0-9_-]{10,})/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    regex: /ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    regex: /((?:https?|ftp|postgres|mysql|mongodb|redis):\/\/[^:]+:)([^@\s]+)(@)/gi,
    replacement: "$1[REDACTED_PASSWORD]$3",
  },
  {
    regex: /(password\s*(?:is|=|:|\s)\s*)([^\s,;]+)/gi,
    replacement: "$1[REDACTED_PASSWORD]",
  },
  {
    regex: /(secret\s*(?:is|=|:|\s)\s*)([^\s,;]+)/gi,
    replacement: "$1[REDACTED_SECRET]",
  },
  {
    regex: /(api[_-]?key\s*(?:is|=|:|\s)\s*)([^\s,;]+)/gi,
    replacement: "$1[REDACTED_API_KEY]",
  },
  {
    regex:
      /((?:access[_-]?token|accessToken|refresh[_-]?token|refreshToken|device[_-]?token|deviceToken|auth[_-]?token|authToken|id[_-]?token)\s*(?:is|=|:|\s)\s*)([^\s"',;]+)/gi,
    replacement: "$1[REDACTED_TOKEN]",
  },
  {
    regex:
      /((?:approval[_-]?assertion|approvalAssertion|assertion)\s*(?:is|=|:|\s)\s*)([^\s"',;]+)/gi,
    replacement: "$1[REDACTED_ASSERTION]",
  },
  {
    regex:
      /((?:vault[_-]?secret|vaultSecret|vault[_-]?value|vaultValue|secret[_-]?value|secretValue)\s*(?:is|=|:|\s)\s*)([^\s"',;]+)/gi,
    replacement: "$1[REDACTED_VAULT_SECRET]",
  },
  {
    regex: /((?:proxy[_-]?authorization|authorization)\s*(?:is|=|:|\s)\s*)([^\s,;]+)/gi,
    replacement: "$1[REDACTED_AUTH]",
  },
];

/**
 * Deeply redacts sensitive strings and object keys from any data structure.
 */
export function redactSecrets(
  data: unknown,
  currentKey?: string,
  parentSensitive = false,
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  const isSensitive = Boolean(
    parentSensitive || (currentKey && SENSITIVE_KEY_PATTERN.test(currentKey)),
  );

  if (typeof data === "string") {
    if (isSensitive && data.length > 0) {
      return REDACTED_MARKER;
    }

    let result = data;
    for (const { regex, replacement } of COMMON_SECRET_PATTERNS) {
      result = result.replace(regex, replacement);
    }

    // Shannon entropy check for high-entropy tokens
    if (result === data && result.length >= 28 && !result.includes(" ") && !result.includes("/")) {
      const entropy = calculateShannonEntropy(result);
      if (entropy >= 4.5) {
        return "[REDACTED_HIGH_ENTROPY_SECRET]";
      }
    }

    return result;
  }

  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
    if (isSensitive) {
      return REDACTED_MARKER;
    }
    return data;
  }

  if (data instanceof Error) {
    return serializeError(data);
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSecrets(item, currentKey, isSensitive));
  }

  if (typeof data === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const keyIsSensitive = isSensitive || SENSITIVE_KEY_PATTERN.test(key);
      if (keyIsSensitive) {
        if (value === null || value === undefined) {
          output[key] = value;
        } else if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint"
        ) {
          output[key] = REDACTED_MARKER;
        } else {
          output[key] = redactSecrets(value, key, true);
        }
      } else {
        output[key] = redactSecrets(value, key, false);
      }
    }
    return output;
  }

  return data;
}

function serializeError(err: Error): SerializedError {
  const serialized: SerializedError = {
    name: err.name,
    message: String(redactSecrets(err.message)),
  };

  if (err.stack) {
    serialized.stack = String(redactSecrets(err.stack));
  }

  if ("code" in err && (typeof err.code === "string" || typeof err.code === "number")) {
    serialized.code = err.code;
  }

  // Preserve non-standard properties on custom errors safely
  for (const [key, val] of Object.entries(err as unknown as Record<string, unknown>)) {
    if (key !== "name" && key !== "message" && key !== "stack") {
      serialized[key] = redactSecrets(val, key);
    }
  }

  return serialized;
}

export class StructuredLogger {
  private level: LogLevel;
  private readonly sink?: LogSink;
  private readonly bufferCapacity: number;
  private readonly enableStdout: boolean;
  private readonly redact: boolean;
  private readonly logBuffer: LogEntry[] = [];
  private readonly staticContext: CorrelationContext;
  private readonly asyncStorage?: AsyncLocalStorage<CorrelationContext>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink;
    this.bufferCapacity = options.bufferCapacity ?? 1000;
    this.enableStdout = options.enableStdout ?? false;
    this.redact = options.redactSecrets ?? true;
    this.staticContext = options.initialContext ? { ...options.initialContext } : {};

    if (options.enableAsyncStorage !== false) {
      this.asyncStorage = new AsyncLocalStorage<CorrelationContext>();
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  getContext(): CorrelationContext {
    const asyncCtx = this.asyncStorage?.getStore() ?? {};
    return { ...this.staticContext, ...asyncCtx };
  }

  withContext(context: CorrelationContext): StructuredLogger {
    const merged = { ...this.getContext(), ...context };
    return new StructuredLogger({
      level: this.level,
      sink: this.sink,
      bufferCapacity: this.bufferCapacity,
      enableStdout: this.enableStdout,
      enableAsyncStorage: false,
      initialContext: merged,
      redactSecrets: this.redact,
    });
  }

  child(context: CorrelationContext): StructuredLogger {
    return this.withContext(context);
  }

  async runWithContext<T>(context: CorrelationContext, fn: () => T | Promise<T>): Promise<T> {
    if (!this.asyncStorage) {
      return fn();
    }
    const current = this.getContext();
    const merged = { ...current, ...context };
    return this.asyncStorage.run(merged, fn);
  }

  debug(msg: string, meta?: Record<string, unknown> | Error): void {
    this.log("debug", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown> | Error): void {
    this.log("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown> | Error): void {
    this.log("warn", msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown> | Error): void {
    this.log("error", msg, meta);
  }

  log(
    level: Exclude<LogLevel, "silent">,
    message: string,
    meta?: Record<string, unknown> | Error,
  ): void {
    if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[this.level]) {
      return;
    }

    const currentContext = this.getContext();
    const timestamp = new Date().toISOString();

    let errorObj: SerializedError | undefined;
    let extraMeta: Record<string, unknown> | undefined;

    if (meta instanceof Error) {
      errorObj = serializeError(meta);
    } else if (meta && typeof meta === "object") {
      const { error, ...rest } = meta;
      if (error instanceof Error) {
        errorObj = serializeError(error);
      } else if (error && typeof error === "object") {
        errorObj = error as SerializedError;
      }
      extraMeta = rest;
    }

    const rawMessage = this.redact ? (redactSecrets(message) as string) : message;
    const rawMeta = extraMeta
      ? this.redact
        ? (redactSecrets(extraMeta) as Record<string, unknown>)
        : extraMeta
      : undefined;

    const entry: LogEntry = {
      timestamp,
      level,
      message: rawMessage,
      ...(currentContext.traceId ? { traceId: currentContext.traceId } : {}),
      ...(currentContext.spanId ? { spanId: currentContext.spanId } : {}),
      ...(currentContext.sessionId ? { sessionId: currentContext.sessionId } : {}),
      ...(currentContext.invocationId ? { invocationId: currentContext.invocationId } : {}),
      ...(currentContext.toolId ? { toolId: currentContext.toolId } : {}),
      ...(currentContext.workspaceId ? { workspaceId: currentContext.workspaceId } : {}),
      ...(currentContext.deviceId ? { deviceId: currentContext.deviceId } : {}),
    };

    // Filter out top-level correlation keys from custom context bag
    const customContext: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(currentContext)) {
      if (
        ![
          "traceId",
          "spanId",
          "sessionId",
          "invocationId",
          "toolId",
          "workspaceId",
          "deviceId",
        ].includes(key)
      ) {
        customContext[key] = this.redact ? redactSecrets(value, key) : value;
      }
    }

    if (rawMeta && Object.keys(rawMeta).length > 0) {
      Object.assign(customContext, rawMeta);
    }

    if (Object.keys(customContext).length > 0) {
      entry.context = customContext;
    }

    if (errorObj) {
      entry.error = errorObj;
    }

    // Add to in-memory ring buffer
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.bufferCapacity) {
      this.logBuffer.shift();
    }

    const jsonLine = JSON.stringify(entry);

    if (this.enableStdout) {
      if (level === "error") {
        process.stderr.write(`${jsonLine}\n`);
      } else {
        process.stdout.write(`${jsonLine}\n`);
      }
    }

    if (this.sink) {
      try {
        this.sink(entry, jsonLine);
      } catch {
        // Prevent sink errors from crashing caller
      }
    }
  }

  getRecentLogs(limit?: number): LogEntry[] {
    if (limit === undefined || limit >= this.logBuffer.length) {
      return [...this.logBuffer];
    }
    return this.logBuffer.slice(-limit);
  }

  clearLogs(): void {
    this.logBuffer.length = 0;
  }
}

export function createStructuredLogger(options?: LoggerOptions): StructuredLogger {
  return new StructuredLogger(options);
}
