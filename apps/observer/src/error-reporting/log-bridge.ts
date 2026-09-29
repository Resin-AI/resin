import type { Logger } from "../lifecycle.js";
import type { JsonObject } from "../normalization/redaction.js";
import { type ErrorReporterLike, getErrorReporter } from "./facade.js";

/** Error logs already reported explicitly (with real stacks) by their call sites. */
const EXPLICITLY_REPORTED_PREFIXES = [
  "Failed to start module",
  "Error rolling back module",
  "Error stopping module",
  "Daemon shutdown timed out",
];
const MAX_PER_FINGERPRINT_PER_WINDOW = 3;
const MAX_PER_WINDOW = 50;
const WINDOW_MS = 60 * 60_000;

/** An error the daemon logged (and recovered from) rather than threw. */
export class LoggedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoggedError";
  }
}

/**
 * A grouping key for a log message: quoted values, numbers and id-like tokens become `<x>`, so
 * "session ses_123 failed" and "session ses_456 failed" are one issue.
 */
export function logFingerprint(message: string): string {
  return message
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "<x>")
    .replace(/\b[A-Za-z]*[_-]?[A-Za-z0-9]*\d[A-Za-z0-9_-]*\b/g, "<x>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface ErrorLogBridgeOptions {
  readonly reporter?: () => ErrorReporterLike;
  readonly now?: () => number;
}

/**
 * Wraps a daemon logger so every `error` log is also reported as a handled `LoggedError`
 * exception (message and the `meta.error` string only, sanitized by the reporter), rate-limited
 * per message pattern. The wrapped logger's own output is unchanged.
 */
export function bridgeErrorLogs(logger: Logger, options: ErrorLogBridgeOptions = {}): Logger {
  const reporter = options.reporter ?? getErrorReporter;
  const now = options.now ?? Date.now;
  let windowStart = now();
  let windowCount = 0;
  const perFingerprint = new Map<string, number>();

  const report = (message: string, meta: JsonObject | undefined): void => {
    try {
      if (EXPLICITLY_REPORTED_PREFIXES.some((prefix) => message.startsWith(prefix))) return;
      const current = now();
      if (current - windowStart >= WINDOW_MS) {
        windowStart = current;
        windowCount = 0;
        perFingerprint.clear();
      }
      const fingerprint = logFingerprint(message);
      const seen = perFingerprint.get(fingerprint) ?? 0;
      if (seen >= MAX_PER_FINGERPRINT_PER_WINDOW || windowCount >= MAX_PER_WINDOW) return;
      perFingerprint.set(fingerprint, seen + 1);
      windowCount += 1;
      const detail = typeof meta?.error === "string" ? `: ${meta.error}` : "";
      reporter().captureException(new LoggedError(`${message}${detail}`), {
        handled: true,
        failureClass: "daemon_error_log",
        properties: { $exception_fingerprint: `logged:${fingerprint}` },
      });
    } catch {
      // Reporting never affects logging.
    }
  };

  return {
    debug: (message, meta) => logger.debug(message, meta),
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    error: (message, meta) => {
      logger.error(message, meta);
      report(message, meta);
    },
  };
}
