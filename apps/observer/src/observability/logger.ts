import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import { calculateShannonEntropy } from "../normalization/scanner.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export const LOG_LEVEL_SEVERITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} satisfies Record<LogLevel, number>;

export interface CorrelationContext {
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  invocationId?: string;
  toolId?: string;
  workspaceId?: string;
  deviceId?: string;
  actorId?: string;
  [key: string]: JsonValue;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  [key: string]: JsonValue;
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
  context?: JsonObject;
  error?: SerializedError;
  [key: string]: JsonValue;
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
export function redactSecrets<T>(data: T, currentKey?: string, parentSensitive = false): T {
  if (data === null || data === undefined) {
    return data;
  }

  const isSensitive = Boolean(
    parentSensitive || (currentKey && SENSITIVE_KEY_PATTERN.test(currentKey)),
  );

  const stringParsed = z.string().safeParse(data);
  if (stringParsed.success) {
    const str = stringParsed.data;
    if (isSensitive && str.length > 0) {
      // SAFETY: REDACTED_MARKER is a string literal replacing secret string data of type T.
      return REDACTED_MARKER as T;
    }

    let result = str;
    for (const { regex, replacement } of COMMON_SECRET_PATTERNS) {
      result = result.replace(regex, replacement);
    }

    // Shannon entropy check for high-entropy tokens
    if (result === str && result.length >= 28 && !result.includes(" ") && !result.includes("/")) {
      const entropy = calculateShannonEntropy(result);
      if (entropy >= 4.5) {
        // SAFETY: replacement string matches input string contract for type T.
        return "[REDACTED_HIGH_ENTROPY_SECRET]" as T;
      }
    }

    // SAFETY: sanitized string matches input string contract for type T.
    return result as T;
  }

  if (
    z.number().safeParse(data).success ||
    z.boolean().safeParse(data).success ||
    z.bigint().safeParse(data).success
  ) {
    if (isSensitive) {
      // SAFETY: REDACTED_MARKER replaces sensitive primitive representation.
      return REDACTED_MARKER as T;
    }
    return data;
  }

  if (data instanceof Error) {
    // SAFETY: serializeError converts Error into SerializedError representing data T.
    return serializeError(data) as T;
  }

  if (Array.isArray(data)) {
    // SAFETY: deeply sanitized array elements maintain array structure for type T.
    return data.map((item) => redactSecrets(item, currentKey, isSensitive)) as T;
  }

  const objectParsed = z.record(z.unknown()).safeParse(data);
  if (objectParsed.success) {
    const output: JsonObject = {};
    for (const [key, value] of Object.entries(objectParsed.data)) {
      const keySensitive = isSensitive || SENSITIVE_KEY_PATTERN.test(key);
      if (
        keySensitive &&
        (z.string().safeParse(value).success ||
          z.number().safeParse(value).success ||
          z.boolean().safeParse(value).success ||
          z.bigint().safeParse(value).success)
      ) {
        output[key] = REDACTED_MARKER;
      } else {
        // SAFETY: Recursive secret redaction returns valid JSON value.
        output[key] = redactSecrets(value, key, keySensitive) as JsonValue;
      }
    }
    // SAFETY: sanitized output object matches dictionary structure of type T.
    return output as T;
  }

  return data;
}

function serializeError(err: Error): SerializedError {
  const serialized: SerializedError = {
    name: err.name || "Error",
    message: err.message,
  };

  if (err.stack) {
    serialized.stack = err.stack;
  }
  if ("code" in err) {
    const codeParsed = z.union([z.string(), z.number()]).safeParse(err.code);
    if (codeParsed.success) {
      serialized.code = codeParsed.data;
    }
  }

  // Include any extra enumerable properties
  const errRecord = Object.assign({}, err);
  for (const [key, val] of Object.entries(errRecord)) {
    if (key !== "name" && key !== "message" && key !== "stack" && key !== "code") {
      // SAFETY: Redacted additional error properties conform to JSON values.
      serialized[key] = redactSecrets(val, key) as JsonValue;
    }
  }

  return serialized;
}
function isSerializedError(val: JsonValue | undefined): val is SerializedError {
  if (!val) {
    return false;
  }
  const parsed = z.record(z.unknown()).safeParse(val);
  return parsed.success;
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

  debug(msg: string, meta?: JsonObject | Error): void {
    this.log("debug", msg, meta);
  }

  info(msg: string, meta?: JsonObject | Error): void {
    this.log("info", msg, meta);
  }

  warn(msg: string, meta?: JsonObject | Error): void {
    this.log("warn", msg, meta);
  }

  error(msg: string, meta?: JsonObject | Error): void {
    this.log("error", msg, meta);
  }

  log(level: Exclude<LogLevel, "silent">, message: string, meta?: JsonObject | Error): void {
    if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[this.level]) {
      return;
    }

    const currentContext = this.getContext();
    const timestamp = new Date().toISOString();

    let errorObj: SerializedError | undefined;
    let extraMeta: JsonObject | undefined;

    if (meta instanceof Error) {
      errorObj = serializeError(meta);
    } else if (meta) {
      if (meta.error instanceof Error) {
        errorObj = serializeError(meta.error);
        const { error: _err, ...rest } = meta;
        extraMeta = rest;
      } else if (isSerializedError(meta.error)) {
        errorObj = meta.error;
        const { error: _err, ...rest } = meta;
        extraMeta = rest;
      } else {
        extraMeta = meta;
      }
    }

    const rawMessage = this.redact ? redactSecrets(message) : message;
    const rawMeta = this.redact && extraMeta ? redactSecrets(extraMeta) : extraMeta;

    const entry: LogEntry = {
      timestamp,
      level,
      message: rawMessage,
    };
    if (currentContext.traceId) entry.traceId = currentContext.traceId;
    if (currentContext.spanId) entry.spanId = currentContext.spanId;
    if (currentContext.sessionId) entry.sessionId = currentContext.sessionId;
    if (currentContext.invocationId) entry.invocationId = currentContext.invocationId;
    if (currentContext.toolId) entry.toolId = currentContext.toolId;
    if (currentContext.workspaceId) entry.workspaceId = currentContext.workspaceId;
    if (currentContext.deviceId) entry.deviceId = currentContext.deviceId;

    const customContext: JsonObject = {};
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
      entry.error = this.redact ? redactSecrets(errorObj) : errorObj;
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
