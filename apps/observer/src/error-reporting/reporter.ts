import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PostHog, type PostHogOptions } from "posthog-node";
import { resolvePaths } from "../paths.js";
import {
  type ErrorReportingConsent,
  readDeviceReportingConfig,
  resolveErrorReportingConsent,
  withProcessTestMarker,
} from "./consent.js";
import {
  type CaptureExceptionOptions,
  type ErrorReporterLike,
  type EventProperties,
  type ResinEnvironment,
  type ResinSurface,
  resolveReportingHost,
  resolveReportingKey,
  setActiveErrorReporter,
} from "./facade.js";
import {
  type CloudIdentity,
  isOpaqueId,
  peekAnonymousId,
  readCloudIdentity,
  readOrCreateAnonymousId,
} from "./identity.js";
import {
  MAX_FEEDBACK_LENGTH,
  type SanitizeContext,
  type SanitizedError,
  defaultSanitizeContext,
  errorCauses,
  sanitizeError,
  sanitizeText,
} from "./sanitize.js";
import {
  type ReportingTransport,
  createUnrefTransport,
  isCancellableTransport,
} from "./transport.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 3_000;
const STATE_REFRESH_MS = 60_000;

export interface ReportingMessage {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly groups?: Record<string, string>;
}

/** The subset of the posthog-node client the reporter uses; tests supply a fake. */
export interface ReportingClient {
  capture(message: ReportingMessage): void;
  captureImmediate(message: ReportingMessage): Promise<void>;
  alias(data: { distinctId: string; alias: string }): void;
  flush(): Promise<void>;
}

export interface ReportingClientConfig {
  readonly apiKey: string;
  readonly host: string;
  readonly transport: ReportingTransport;
}

export interface ErrorReporterOptions {
  readonly surface: ResinSurface;
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly resinHome?: string;
  /** Replaced by `<project>` in messages and stacks; defaults to the working directory. */
  readonly projectRoot?: string;
  readonly clientFactory?: (config: ReportingClientConfig) => ReportingClient;
  /** Defaults to an unref'd `node:https` transport; tests supply a fake. */
  readonly transport?: ReportingTransport;
  readonly now?: () => number;
}

function isSourceCheckout(): boolean {
  try {
    let directory = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth += 1) {
      if (fs.existsSync(path.join(directory, "pnpm-workspace.yaml"))) return true;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // Treat an unknown layout as a release.
  }
  return false;
}

export function resolveReportingEnvironment(env: NodeJS.ProcessEnv): ResinEnvironment {
  const explicit = env.RESIN_ENVIRONMENT?.trim().toLowerCase();
  if (explicit === "production" || explicit === "staging" || explicit === "development") {
    return explicit;
  }
  if (env.NODE_ENV === "development") return "development";
  const cloudUrl = env.RESIN_CLOUD_URL?.toLowerCase() ?? "";
  if (cloudUrl.includes("staging")) return "staging";
  if (/\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(cloudUrl)) return "development";
  return isSourceCheckout() ? "development" : "production";
}

/**
 * posthog-node logs flush failures to the console and retries. Reporting is best-effort: a
 * request that fails, times out or is rejected is dropped silently and reported as delivered.
 */
export function createSilentFetch(
  transport: ReportingTransport,
): NonNullable<PostHogOptions["fetch"]> {
  const delivered = {
    status: 200,
    text: async () => "",
    json: async () => ({}),
  };
  return async (url, options) => {
    try {
      const response = await transport(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 200 && response.status < 300) return response;
    } catch {
      // Offline, DNS failure, timeout: drop.
    }
    return delivered;
  };
}

function defaultClientFactory(config: ReportingClientConfig): ReportingClient {
  const client = new PostHog(config.apiKey, {
    host: config.host,
    flushAt: 20,
    flushInterval: 10_000,
    fetchRetryCount: 0,
    requestTimeout: REQUEST_TIMEOUT_MS,
    disableGeoip: true,
    persistence: "memory",
    enableExceptionAutocapture: false,
    fetch: createSilentFetch(config.transport),
  });
  client.on("error", () => undefined);
  return client;
}

/** Races `promise` against a timeout; resolves either way and never rejects. */
async function bounded(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    // Referenced on purpose: the wait itself keeps the process alive (a CLI awaiting a flush must
    // not exit mid-await); the sockets behind it are unref'd, so nothing outlives this bound.
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function buildExceptionEntry(error: SanitizedError, handled: boolean): Record<string, unknown> {
  return {
    type: error.type,
    value: error.message,
    mechanism: { handled, synthetic: false, type: "generic" },
    stacktrace: { type: "raw", frames: error.frames },
  };
}

const FAILURE_CLASS_PATTERN = /^[a-z0-9_.:-]{1,64}$/i;

interface IdentityState {
  readonly distinctId: string;
  readonly cloud?: CloudIdentity;
}

/**
 * The PostHog-backed reporter. Every public method is total: it never throws, never writes to
 * stdout, and does nothing unless a real project key is configured and consent resolves enabled.
 */
export class ErrorReporter implements ErrorReporterLike {
  readonly surface: ResinSurface;
  private readonly version: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly stateDir: string;
  private readonly configFile: string;
  private readonly apiKey: string | undefined;
  private readonly host: string;
  private readonly environment: ResinEnvironment;
  private readonly sanitizeContext: SanitizeContext;
  private readonly clientFactory: (config: ReportingClientConfig) => ReportingClient;
  private readonly transport: ReportingTransport;
  private readonly now: () => number;
  private readonly reported = new WeakSet<object>();
  private client: ReportingClient | undefined;
  private consentCache: { value: ErrorReportingConsent; at: number } | undefined;
  private identityCache: { value: IdentityState; at: number } | undefined;

  constructor(options: ErrorReporterOptions) {
    this.surface = options.surface;
    this.version = options.version;
    this.env = options.env ?? process.env;
    const paths = resolvePaths({ home: options.home, resinHome: options.resinHome, env: this.env });
    this.stateDir = paths.stateDir;
    this.configFile = paths.configFile;
    this.apiKey = resolveReportingKey(this.env);
    this.host = resolveReportingHost(this.env);
    this.environment = resolveReportingEnvironment(this.env);
    const context = defaultSanitizeContext(options.projectRoot);
    this.sanitizeContext = options.home ? { ...context, homeDir: options.home } : context;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.transport = options.transport ?? createUnrefTransport(REQUEST_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
  }

  /** True when a real project key is available (placeholder and malformed keys are not). */
  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  consent(): ErrorReportingConsent {
    const now = this.now();
    if (this.consentCache && now - this.consentCache.at < STATE_REFRESH_MS) {
      return this.consentCache.value;
    }
    let value: ErrorReportingConsent;
    try {
      value = resolveErrorReportingConsent({
        env: withProcessTestMarker(this.env),
        config: readDeviceReportingConfig(this.configFile),
      });
    } catch {
      value = { enabled: false, reason: "config_unreadable" };
    }
    this.consentCache = { value, at: now };
    return value;
  }

  isEnabled(): boolean {
    return this.apiKey !== undefined && this.consent().enabled;
  }

  private getClient(): ReportingClient | undefined {
    if (!this.isEnabled() || this.apiKey === undefined) return undefined;
    if (!this.client) {
      this.client = this.clientFactory({
        apiKey: this.apiKey,
        host: this.host,
        transport: this.transport,
      });
    }
    return this.client;
  }

  private identity(): IdentityState {
    const now = this.now();
    if (this.identityCache && now - this.identityCache.at < STATE_REFRESH_MS) {
      return this.identityCache.value;
    }
    const cloud = readCloudIdentity(this.stateDir);
    const value: IdentityState = cloud
      ? { distinctId: cloud.userId, cloud }
      : { distinctId: readOrCreateAnonymousId(this.stateDir) };
    this.identityCache = { value, at: now };
    return value;
  }

  private commonProperties(): Record<string, unknown> {
    return {
      resin_surface: this.surface,
      resin_version: this.version,
      environment: this.environment,
      os: process.platform,
      arch: process.arch,
      node_version: process.version,
    };
  }

  private sanitizeProperties(properties: EventProperties | undefined): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    if (!properties) return output;
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined) continue;
      if (typeof value !== "string") {
        output[key] = typeof value === "number" && !Number.isFinite(value) ? null : value;
      } else if (/_ids?$/.test(key)) {
        if (isOpaqueId(value)) output[key] = value;
      } else {
        output[key] = sanitizeText(value, this.sanitizeContext, 256);
      }
    }
    return output;
  }

  private message(event: string, properties: Record<string, unknown>): ReportingMessage {
    const identity = this.identity();
    const groups: Record<string, string> = {};
    if (identity.cloud?.accountId) groups.account = identity.cloud.accountId;
    if (identity.cloud?.workspaceId) groups.workspace = identity.cloud.workspaceId;
    return {
      distinctId: identity.distinctId,
      event,
      properties: {
        ...properties,
        ...this.commonProperties(),
        ...(identity.cloud?.accountId ? { resin_account_id: identity.cloud.accountId } : {}),
        ...(identity.cloud?.workspaceId ? { resin_workspace_id: identity.cloud.workspaceId } : {}),
      },
      groups: Object.keys(groups).length > 0 ? groups : undefined,
    };
  }

  private exceptionMessage(
    error: unknown,
    options: CaptureExceptionOptions,
  ): ReportingMessage | undefined {
    if (error !== null && typeof error === "object") {
      if (this.reported.has(error)) return undefined;
      this.reported.add(error);
    }
    const primary = sanitizeError(error, this.sanitizeContext);
    const causes = errorCauses(error).map((cause) => sanitizeError(cause, this.sanitizeContext));
    const errorCode = options.errorCode ?? primary.code;
    const properties: Record<string, unknown> = {
      ...this.sanitizeProperties(options.properties),
      $exception_list: [primary, ...causes].map((entry) =>
        buildExceptionEntry(entry, options.handled),
      ),
      $exception_level: options.level ?? (options.handled ? "error" : "fatal"),
      $exception_handled: options.handled,
    };
    if (errorCode && FAILURE_CLASS_PATTERN.test(errorCode)) properties.resin_error_code = errorCode;
    if (options.failureClass && FAILURE_CLASS_PATTERN.test(options.failureClass)) {
      properties.resin_failure_class = options.failureClass;
    }
    return this.message("$exception", properties);
  }

  captureException(error: unknown, options: CaptureExceptionOptions): void {
    try {
      const client = this.getClient();
      if (!client) return;
      const message = this.exceptionMessage(error, options);
      if (message) client.capture(message);
    } catch {
      // Reporting never affects the program.
    }
  }

  async captureExceptionImmediate(
    error: unknown,
    options: CaptureExceptionOptions,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    try {
      const client = this.getClient();
      if (!client) return;
      const message = this.exceptionMessage(error, options);
      if (!message) return;
      await bounded(client.captureImmediate(message), timeoutMs);
    } catch {
      // Reporting never affects the program.
    }
  }

  capture(event: string, properties?: EventProperties): void {
    try {
      const client = this.getClient();
      if (!client) return;
      client.capture(this.message(event, this.sanitizeProperties(properties)));
    } catch {
      // Reporting never affects the program.
    }
  }

  async captureImmediate(
    event: string,
    properties?: EventProperties,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    try {
      const client = this.getClient();
      if (!client) return;
      await bounded(
        client.captureImmediate(this.message(event, this.sanitizeProperties(properties))),
        timeoutMs,
      );
    } catch {
      // Reporting never affects the program.
    }
  }

  async submitFeedback(message: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    try {
      const client = this.getClient();
      if (!client) return false;
      const text = sanitizeText(message, this.sanitizeContext, MAX_FEEDBACK_LENGTH);
      await bounded(
        client.captureImmediate(
          this.message("feedback_submitted", { message: text, message_length: message.length }),
        ),
        timeoutMs,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Links this install's anonymous id to the paired cloud user so earlier events join the person.
   */
  identifyCloudUser(identity: CloudIdentity): void {
    try {
      if (!isOpaqueId(identity.userId)) return;
      const client = this.getClient();
      this.identityCache = {
        value: { distinctId: identity.userId, cloud: identity },
        at: this.now(),
      };
      if (!client) return;
      const anonymousId = peekAnonymousId(this.stateDir);
      if (anonymousId) client.alias({ distinctId: identity.userId, alias: anonymousId });
    } catch {
      // Reporting never affects the program.
    }
  }

  /**
   * Waits at most `timeoutMs` for queued events, then drops whatever is still in flight so no
   * socket (not even a pending connect to a dead host) outlives the wait.
   */
  async flush(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
    try {
      if (!this.client) return;
      await bounded(this.client.flush(), timeoutMs);
    } catch {
      // Reporting never affects the program.
    } finally {
      this.cancelPending();
    }
  }

  private cancelPending(): void {
    try {
      if (isCancellableTransport(this.transport)) this.transport.cancelPending();
    } catch {
      // Reporting never affects the program.
    }
  }
}

/**
 * Creates the process-wide reporter for an entry point. Deep call sites reach it through
 * {@link getErrorReporter}; before this runs (and in tests) they get a no-op.
 */
export function configureErrorReporting(options: ErrorReporterOptions): ErrorReporter {
  const reporter = new ErrorReporter(options);
  setActiveErrorReporter(reporter);
  return reporter;
}

let installedCrashListener:
  | ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void)
  | undefined;

export interface CrashHandlerOptions {
  /** Bound on how long a crash waits for the report before exiting. */
  readonly timeoutMs?: number;
  readonly stderr?: { write: (chunk: string) => boolean | undefined };
  readonly exit?: (code: number) => void;
}

/**
 * Installs an `uncaughtException` listener (which also receives unhandled rejections in Node's
 * default `throw` mode) that reports the crash, then reproduces Node's default outcome: the stack
 * on stderr and exit code 1. Installed only when reporting is enabled, so a disabled or
 * unconfigured reporter leaves crash behaviour completely untouched.
 */
export function installCrashHandlers(
  reporter: ErrorReporterLike,
  options: CrashHandlerOptions = {},
): boolean {
  if (installedCrashListener || !reporter.isEnabled()) return false;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let crashing = false;
  let finished = false;

  const finish = (error: unknown): void => {
    if (finished) return;
    finished = true;
    try {
      const text =
        error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
      stderr.write(`${text}\n`);
    } catch {
      // Still exit.
    }
    exit(1);
  };

  const listener = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    if (crashing) {
      // A second crash while reporting the first: exit now.
      finished = false;
      finish(error);
      return;
    }
    crashing = true;
    // A referenced timer keeps the process alive while the report is in flight.
    const guard = setTimeout(() => finish(error), timeoutMs + 250);
    void reporter
      .captureExceptionImmediate(
        error,
        { handled: false, level: "fatal", properties: { resin_crash_origin: origin } },
        timeoutMs,
      )
      .finally(() => {
        clearTimeout(guard);
        finish(error);
      });
  };
  installedCrashListener = listener;
  process.on("uncaughtException", listener);
  return true;
}

/** Test seam for {@link installCrashHandlers}'s once-per-process guard. */
export function resetCrashHandlersForTesting(): void {
  if (installedCrashListener) process.off("uncaughtException", installedCrashListener);
  installedCrashListener = undefined;
}
