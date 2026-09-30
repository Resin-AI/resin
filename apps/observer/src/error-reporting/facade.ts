import type { ErrorReportingConsent } from "./consent.js";
import type { CloudIdentity } from "./identity.js";

/**
 * The dependency-free face of error reporting: constants, types, the process-wide reporter
 * registry and report helpers. Deep call sites import this module (it never loads posthog-node,
 * which keeps the standalone install helper bundle small); entry points configure the real,
 * PostHog-backed reporter from `./reporter.js`.
 */

/**
 * The public, write-only PostHog project API key. This is the single source of truth: the
 * shell/PowerShell installers carry the same literal and a unit test keeps them equal. Until a
 * real `phc_` key replaces the placeholder, every reporter is a silent no-op.
 */
export const RESIN_POSTHOG_PROJECT_API_KEY = "phc_xkn83r4yVHBSfLrdrQVgB856j2DS4BUJNi6Ds6fDA9uW";
/** First-party ingest proxy; it forwards to PostHog without the `/ingest` prefix. */
export const RESIN_POSTHOG_DEFAULT_HOST = "https://resin.sh/ingest";

const PROJECT_KEY_PATTERN = /^phc_[A-Za-z0-9_-]{16,}$/;

/**
 * The process that reports. `updater` is the automatic updater: the service supervisor's update
 * timer and the out-of-service update worker (`resin upgrade` reports as `cli`).
 */
export type ResinSurface = "cli" | "daemon" | "gateway" | "mcp_shim" | "installer" | "updater";
export type ResinEnvironment = "production" | "staging" | "development";
export type ExceptionLevel = "fatal" | "error" | "warning";
export type EventPropertyValue = string | number | boolean | null | undefined;
export type EventProperties = Readonly<Record<string, EventPropertyValue>>;

export interface CaptureExceptionOptions {
  /** False for crashes and uncaught errors; true for errors the program recovered from. */
  readonly handled: boolean;
  readonly level?: ExceptionLevel;
  /** A stable Resin error code (e.g. `CONFIG_WRITE_FAILED`); defaults to the error's `code`. */
  readonly errorCode?: string;
  /** A coarse failure classification (e.g. `supervisor_module_start`). */
  readonly failureClass?: string;
  readonly properties?: EventProperties;
}

/** What every entry point and deep call site talks to. The no-op form is the default. */
export interface ErrorReporterLike {
  readonly surface: ResinSurface | undefined;
  isConfigured(): boolean;
  isEnabled(): boolean;
  consent(): ErrorReportingConsent;
  captureException(error: unknown, options: CaptureExceptionOptions): void;
  captureExceptionImmediate(
    error: unknown,
    options: CaptureExceptionOptions,
    timeoutMs?: number,
  ): Promise<void>;
  capture(event: string, properties?: EventProperties): void;
  captureImmediate(event: string, properties?: EventProperties, timeoutMs?: number): Promise<void>;
  identifyCloudUser(identity: CloudIdentity): void;
  /** Sends user-authored feedback; false when reporting is unconfigured or disabled. */
  submitFeedback(message: string, timeoutMs?: number): Promise<boolean>;
  flush(timeoutMs?: number): Promise<void>;
}

export function isUsableProjectKey(key: string | undefined): key is string {
  return typeof key === "string" && PROJECT_KEY_PATTERN.test(key);
}

/** `RESIN_POSTHOG_KEY` overrides the built-in key; unusable keys (the placeholder) yield none. */
export function resolveReportingKey(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.RESIN_POSTHOG_KEY?.trim();
  const key = override || RESIN_POSTHOG_PROJECT_API_KEY;
  return isUsableProjectKey(key) ? key : undefined;
}

/** `RESIN_POSTHOG_HOST` overrides the proxy host: https, or http on loopback, no credentials. */
export function resolveReportingHost(env: NodeJS.ProcessEnv): string {
  const override = env.RESIN_POSTHOG_HOST?.trim();
  if (!override) return RESIN_POSTHOG_DEFAULT_HOST;
  try {
    const parsed = new URL(override);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.username || parsed.password) return RESIN_POSTHOG_DEFAULT_HOST;
    if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) {
      return override.replace(/\/+$/, "");
    }
  } catch {
    // Fall through to the default host.
  }
  return RESIN_POSTHOG_DEFAULT_HOST;
}

class NoopErrorReporter implements ErrorReporterLike {
  readonly surface = undefined;
  isConfigured(): boolean {
    return false;
  }
  isEnabled(): boolean {
    return false;
  }
  consent(): ErrorReportingConsent {
    return { enabled: false, reason: "environment_disabled" };
  }
  captureException(): void {}
  async captureExceptionImmediate(): Promise<void> {}
  capture(): void {}
  async captureImmediate(): Promise<void> {}
  identifyCloudUser(): void {}
  async submitFeedback(): Promise<boolean> {
    return false;
  }
  async flush(): Promise<void> {}
}

const NOOP_REPORTER = new NoopErrorReporter();
let activeReporter: ErrorReporterLike | undefined;

/** The process-wide reporter; a no-op until an entry point configures one (and in tests). */
export function getErrorReporter(): ErrorReporterLike {
  return activeReporter ?? NOOP_REPORTER;
}

/** Installs (or clears) the process-wide reporter. Entry points and tests only. */
export function setActiveErrorReporter(reporter: ErrorReporterLike | undefined): void {
  activeReporter = reporter;
}

/** Reports a recovered error through the process-wide reporter. Never throws. */
export function reportHandledError(
  error: unknown,
  options: Omit<CaptureExceptionOptions, "handled"> = {},
): void {
  try {
    getErrorReporter().captureException(error, { ...options, handled: true });
  } catch {
    // Reporting never affects the program.
  }
}

/** Records a product/usage event through the process-wide reporter. Never throws. */
export function reportEvent(event: string, properties?: EventProperties): void {
  try {
    getErrorReporter().capture(event, properties);
  } catch {
    // Reporting never affects the program.
  }
}

/**
 * Runs `operation`; if it throws, reports the error (unhandled by default) and rethrows the very
 * same value, so callers observe no difference.
 */
export async function withErrorCapture<T>(
  operation: () => Promise<T>,
  options: CaptureExceptionOptions = { handled: false },
  reporter: ErrorReporterLike = getErrorReporter(),
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await reporter.captureExceptionImmediate(error, options);
    throw error;
  }
}
