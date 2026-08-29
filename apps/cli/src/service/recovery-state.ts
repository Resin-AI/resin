import { Buffer } from "node:buffer";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { SecretRedactor } from "@resin/crypto";
import { z } from "zod";

export const RECOVERY_STATE_VERSION = 1 as const;
export const INITIAL_RESTART_DELAY_MS = 2_000;
export const MAX_RESTART_DELAY_MS = 60_000;
export const RESTART_JITTER_RATIO = 0.2;
export const CRASH_WINDOW_MS = 5 * 60_000;
export const MAX_CRASHES_IN_WINDOW = 5;
export const RECOVERY_STATE_FILE_NAME = "recovery-state.json";
export const CRASH_RECOVERY_LOG_FILE_NAME = "crash-recovery.log";
export const CRASH_RECOVERY_LOG_BACKUP_SUFFIX = ".1";
export const CRASH_RECOVERY_LOG_MAX_BYTES = 64 * 1_024;

export type RecoveryStatus = "HEALTHY" | "DEGRADED" | "TRIPPED";

export const RECOVERY_FAILURE_CATEGORIES = [
  "AUTHENTICATION",
  "CONFIGURATION",
  "PORT_CONFLICT",
  "PERMISSION",
  "NETWORK",
  "RUNTIME",
  "UNKNOWN",
] as const;

export type RecoveryFailureCategory = (typeof RECOVERY_FAILURE_CATEGORIES)[number];

export const RECOVERY_REMEDIATIONS = {
  AUTHENTICATION: "Run `resin login` to restore cloud access.",
  CONFIGURATION: "Run `resin doctor`, then `resin repair` if the problem persists.",
  PORT_CONFLICT: "Free the configured Resin port, then restart the service.",
  PERMISSION: "Check Resin state-directory permissions, then run `resin doctor`.",
  NETWORK: "Check network connectivity; local-only MCP operation remains available.",
  RUNTIME: "Run `resin doctor` and inspect the crash recovery log.",
  UNKNOWN: "Run `resin doctor` and inspect the crash recovery log.",
} as const satisfies Record<RecoveryFailureCategory, string>;

export interface RecoveryFailureDiagnostic {
  timestamp: number;
  category: RecoveryFailureCategory;
  remediation: string;
  exitCode?: number;
}

export interface RecoveryState {
  version: typeof RECOVERY_STATE_VERSION;
  status: RecoveryStatus;
  restartCount: number;
  crashTimestamps: number[];
  trippedAt?: number;
  lastFailure?: RecoveryFailureDiagnostic;
}

export interface CrashDiagnosticInput {
  error?: unknown;
  exitCode?: number;
  category?: RecoveryFailureCategory;
}

export interface RestartDecision {
  shouldRestart: boolean;
  delayMs?: number;
  crashCount: number;
  state: RecoveryState;
}

export interface RecoveryStateTrackerOptions {
  resinHome?: string;
  stateDir?: string;
  logDir?: string;
  clock?: () => number;
  random?: () => number;
  maxCrashLogBytes?: number;
}

interface ForensicCrashRecord extends RecoveryFailureDiagnostic {
  event: "runtime_crash";
  status: RecoveryStatus;
  crashCount: number;
  restartScheduled: boolean;
  delayMs?: number;
  environmentSignature: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
  };
  detail: string;
}

const RecoveryStatusSchema = z.enum(["HEALTHY", "DEGRADED", "TRIPPED"]);
const RecoveryFailureCategorySchema = z.enum(RECOVERY_FAILURE_CATEGORIES);
const PersistedFailureDiagnosticSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  category: RecoveryFailureCategorySchema,
  exitCode: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
});
const PersistedRecoveryStateSchema = z.object({
  version: z.literal(RECOVERY_STATE_VERSION),
  status: RecoveryStatusSchema,
  restartCount: z.number().int().nonnegative(),
  crashTimestamps: z.array(z.number().int().nonnegative()).max(MAX_CRASHES_IN_WINDOW + 1),
  trippedAt: z.number().int().nonnegative().optional(),
  lastFailure: PersistedFailureDiagnosticSchema.optional(),
});
const MAX_FORENSIC_DETAIL_LENGTH = 8_192;
const MIN_CRASH_RECOVERY_LOG_MAX_BYTES = 1_024;
const MAX_PERSISTED_CRASH_TIMESTAMPS = MAX_CRASHES_IN_WINDOW + 1;
const SENSITIVE_ENVIRONMENT_VARIABLE =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|COOKIE|CREDENTIAL|DATABASE_URL|DSN|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|SESSION|TOKEN)(?:_|$)/i;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:aws_access_key_id|aws_secret_access_key|aws_session_token|[a-z0-9_]*(?:access_key|api_key|auth_token|cookie|credential|database_url|dsn|password|passwd|private_key|secret|session_token|token)[a-z0-9_]*)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}\]]+))/gim;
const SECRET_COMMAND_ARGUMENT_PATTERN =
  /(?:^|[\s"'[,])(--?(?:[a-z0-9]+[-_])*(?:access[-_]?key|api[-_]?key|auth[-_]?token|connection[-_]?string|database[-_]?url|dsn|password|passwd|private[-_]?key|secret|secret[-_]?key|session[-_]?token|token)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"',}\]]+)))/gim;
const CREDENTIAL_DSN_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^/\s@]+@)/gi;
const REDACTED_TRANSCRIPT = "[REDACTED_TRANSCRIPT]";
const REDACTED_TOOL_OUTPUT = "[REDACTED_TOOL_OUTPUT]";
const TRANSCRIPT_FIELD_PATTERN = /^(?:transcript|conversation|messages)$/i;
const TOOL_OUTPUT_FIELD_PATTERN =
  /^(?:tool(?:[ _-]?(?:output|result|response))?|output|stdout|stderr)$/i;
const TRANSCRIPT_ROLE_PATTERN = /^(?:user|assistant|system|developer)$/i;
const TOOL_ROLE_PATTERN = /^tool(?:[ _-]?(?:output|result|response))?$/i;
const TRANSCRIPT_BLOCK_PATTERN = /<(transcript|conversation|messages)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TOOL_OUTPUT_BLOCK_PATTERN =
  /<(tool(?:[_-]?(?:output|result|response))?)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TRANSCRIPT_LINE_PATTERN =
  /^[ \t]*(?:user|assistant|system|developer|transcript|conversation|messages)[ \t]*:.*$/gim;
const TOOL_OUTPUT_LINE_PATTERN =
  /^[ \t]*(?:tool(?:[ _-]*(?:output|result|response))?|stdout|stderr)[ \t]*:.*$/gim;
let atomicWriteSequence = 0;

export function calculateRestartDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Restart attempt must be a positive safe integer");
  }

  const exponent = Math.min(attempt - 1, 30);
  const baseDelay = Math.min(INITIAL_RESTART_DELAY_MS * 2 ** exponent, MAX_RESTART_DELAY_MS);
  const sample = random();
  if (!Number.isFinite(sample)) {
    throw new RangeError("Restart jitter source must return a finite number");
  }

  const boundedSample = Math.min(1, Math.max(0, sample));
  const jitterMultiplier = 1 - RESTART_JITTER_RATIO + boundedSample * RESTART_JITTER_RATIO * 2;

  return Math.min(MAX_RESTART_DELAY_MS, Math.round(baseDelay * jitterMultiplier));
}

export function categorizeRecoveryFailure(error: unknown): RecoveryFailureCategory {
  const detail = extractErrorDetail(error).toLowerCase();

  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|token expired|jwt expired/.test(detail)) {
    return "AUTHENTICATION";
  }
  if (/eaddrinuse|address already in use|port (?:is )?(?:busy|occupied)/.test(detail)) {
    return "PORT_CONFLICT";
  }
  if (/eacces|eperm|permission denied|operation not permitted/.test(detail)) {
    return "PERMISSION";
  }
  if (
    /econnreset|econnrefused|etimedout|enetunreach|eai_again|network|socket hang up/.test(detail)
  ) {
    return "NETWORK";
  }
  if (/configuration|config(?:uration)? file|json (?:parse|syntax)|syntaxerror/.test(detail)) {
    return "CONFIGURATION";
  }
  if (error instanceof Error || detail.length > 0) {
    return "RUNTIME";
  }
  return "UNKNOWN";
}

export function sanitizeCrashDiagnostic(
  error: unknown,
  redactor: SecretRedactor = createRecoverySecretRedactor(),
): string {
  const detail = extractErrorDetail(error);
  if (detail.length === 0) {
    return "No diagnostic detail was provided.";
  }

  const privateContentRedacted = redactPrivateDiagnosticContent(detail);
  registerEmbeddedSecrets(redactor, privateContentRedacted);
  return redactor.redact(privateContentRedacted).slice(0, MAX_FORENSIC_DETAIL_LENGTH);
}

function redactPrivateDiagnosticContent(detail: string): string {
  let redacted = detail;
  if (/^[\s]*[\[{]/.test(detail)) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (typeof parsed === "object" && parsed !== null) {
        const serialized = JSON.stringify(parsed, redactPrivateDiagnosticField);
        if (serialized !== undefined) {
          redacted = serialized;
        }
      }
    } catch {
      // Malformed JSON falls through to the text redaction pass.
    }
  }

  return redactPrivateDiagnosticText(redacted);
}

function redactPrivateDiagnosticText(detail: string): string {
  return detail
    .replace(TRANSCRIPT_BLOCK_PATTERN, REDACTED_TRANSCRIPT)
    .replace(TOOL_OUTPUT_BLOCK_PATTERN, REDACTED_TOOL_OUTPUT)
    .replace(TRANSCRIPT_LINE_PATTERN, "[REDACTED_TRANSCRIPT_LINE]")
    .replace(TOOL_OUTPUT_LINE_PATTERN, "[REDACTED_TOOL_OUTPUT_LINE]");
}

function redactPrivateDiagnosticField(
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  if (TRANSCRIPT_FIELD_PATTERN.test(key)) {
    return REDACTED_TRANSCRIPT;
  }
  if (TOOL_OUTPUT_FIELD_PATTERN.test(key)) {
    return REDACTED_TOOL_OUTPUT;
  }

  const role =
    typeof this.role === "string"
      ? this.role
      : typeof this.type === "string"
        ? this.type
        : undefined;
  if (/^content$/i.test(key) && role && TRANSCRIPT_ROLE_PATTERN.test(role)) {
    return REDACTED_TRANSCRIPT;
  }
  if (/^content$/i.test(key) && role && TOOL_ROLE_PATTERN.test(role)) {
    return REDACTED_TOOL_OUTPUT;
  }
  return typeof value === "string" ? redactPrivateDiagnosticText(value) : value;
}

function createRecoverySecretRedactor(
  environment: NodeJS.ProcessEnv = process.env,
): SecretRedactor {
  const redactor = new SecretRedactor();
  for (const [name, value] of Object.entries(environment)) {
    if (value && SENSITIVE_ENVIRONMENT_VARIABLE.test(name)) {
      redactor.registerSecret(value, name);
    }
  }
  return redactor;
}

function registerEmbeddedSecrets(redactor: SecretRedactor, detail: string): void {
  for (const pattern of [
    SENSITIVE_ASSIGNMENT_PATTERN,
    SECRET_COMMAND_ARGUMENT_PATTERN,
    CREDENTIAL_DSN_PATTERN,
  ]) {
    for (const match of detail.matchAll(pattern)) {
      for (const candidate of match) {
        if (candidate) {
          redactor.registerSecret(candidate.trim(), "recovery-diagnostic");
        }
      }
    }
  }
}

export class RecoveryStateTracker {
  readonly statePath: string;
  readonly crashLogPath: string;

  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly crashLogMaxBytes: number;
  private readonly redactor: SecretRedactor;
  private state?: RecoveryState;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: RecoveryStateTrackerOptions = {}) {
    const resinHome =
      options.resinHome ?? process.env.RESIN_HOME ?? path.join(os.homedir(), ".resin");
    const stateDir = options.stateDir ?? path.join(resinHome, "state");
    const logDir = options.logDir ?? path.join(resinHome, "logs");

    this.statePath = path.join(stateDir, RECOVERY_STATE_FILE_NAME);
    this.crashLogPath = path.join(logDir, CRASH_RECOVERY_LOG_FILE_NAME);
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    const crashLogMaxBytes = options.maxCrashLogBytes ?? CRASH_RECOVERY_LOG_MAX_BYTES;
    if (
      !Number.isSafeInteger(crashLogMaxBytes) ||
      crashLogMaxBytes < MIN_CRASH_RECOVERY_LOG_MAX_BYTES
    ) {
      throw new RangeError(
        `Crash recovery log limit must be at least ${MIN_CRASH_RECOVERY_LOG_MAX_BYTES} bytes`,
      );
    }
    this.crashLogMaxBytes = crashLogMaxBytes;
    this.redactor = createRecoverySecretRedactor();
  }

  getState(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      const now = this.getCurrentTime();
      const current = await this.loadState(now);
      const refreshed = refreshRollingWindow(current, now);

      if (refreshed.changed) {
        this.state = refreshed.state;
        await this.persistState(refreshed.state);
      }

      return cloneRecoveryState(refreshed.state);
    });
  }

  recordStableRuntime(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      const current = await this.loadState(this.getCurrentTime());
      if (
        current.status === "TRIPPED" ||
        (current.status === "HEALTHY" &&
          current.restartCount === 0 &&
          current.crashTimestamps.length === 0)
      ) {
        return cloneRecoveryState(current);
      }

      const state: RecoveryState = {
        version: RECOVERY_STATE_VERSION,
        status: "HEALTHY",
        restartCount: 0,
        crashTimestamps: [],
        ...(current.lastFailure ? { lastFailure: { ...current.lastFailure } } : {}),
      };
      this.state = state;
      await this.persistState(state);
      return cloneRecoveryState(state);
    });
  }

  recordCrash(input: CrashDiagnosticInput = {}): Promise<RestartDecision> {
    return this.enqueue(async () => {
      const now = this.getCurrentTime();
      const loaded = await this.loadState(now);
      const current = refreshRollingWindow(loaded, now).state;
      const crashCount = current.crashTimestamps.length + 1;
      const crashTimestamps = [...current.crashTimestamps, now];
      if (crashTimestamps.length > MAX_PERSISTED_CRASH_TIMESTAMPS) {
        crashTimestamps.shift();
      }
      const alreadyTripped = current.status === "TRIPPED";
      const shouldTrip = alreadyTripped || crashCount > MAX_CRASHES_IN_WINDOW;
      const shouldRestart = !shouldTrip;
      const restartCount = shouldRestart ? crashCount : current.restartCount;
      const category = isFailureCategory(input.category)
        ? input.category
        : categorizeRecoveryFailure(input.error);
      const exitCode =
        typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode)
          ? input.exitCode
          : undefined;
      const lastFailure: RecoveryFailureDiagnostic = {
        timestamp: now,
        category,
        remediation: RECOVERY_REMEDIATIONS[category],
        ...(exitCode === undefined ? {} : { exitCode }),
      };
      const nextState: RecoveryState = {
        version: RECOVERY_STATE_VERSION,
        status: shouldTrip ? "TRIPPED" : "DEGRADED",
        restartCount,
        crashTimestamps,
        ...(shouldTrip ? { trippedAt: current.trippedAt ?? now } : {}),
        lastFailure,
      };
      const delayMs = shouldRestart
        ? calculateRestartDelayMs(restartCount, this.random)
        : undefined;

      this.state = nextState;
      await this.persistState(nextState);
      await this.appendForensicCrash({
        ...lastFailure,
        event: "runtime_crash",
        status: nextState.status,
        crashCount,
        restartScheduled: shouldRestart,
        ...(delayMs === undefined ? {} : { delayMs }),
        environmentSignature: {
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version,
        },
        detail: sanitizeCrashDiagnostic(input.error, this.redactor),
      });

      return {
        shouldRestart,
        ...(delayMs === undefined ? {} : { delayMs }),
        crashCount,
        state: cloneRecoveryState(nextState),
      };
    });
  }

  reset(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      const state = createHealthyState();
      this.state = state;
      await this.persistState(state);
      return cloneRecoveryState(state);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getCurrentTime(): number {
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("Recovery clock must return a non-negative finite timestamp");
    }
    return Math.trunc(now);
  }

  private async loadState(now: number): Promise<RecoveryState> {
    if (this.state) {
      return this.state;
    }

    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        this.state = createHealthyState();
        return this.state;
      }
      throw error;
    }

    const parsed = parsePersistedState(raw, now);
    this.state = parsed ?? createFailClosedState(now);
    return this.state;
  }

  private async persistState(state: RecoveryState): Promise<void> {
    const stateDir = path.dirname(this.statePath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });

    atomicWriteSequence += 1;
    const temporaryPath = path.join(
      stateDir,
      `.${RECOVERY_STATE_FILE_NAME}.${process.pid}.${atomicWriteSequence}.tmp`,
    );

    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.statePath);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }

  private async appendForensicCrash(record: ForensicCrashRecord): Promise<void> {
    await mkdir(path.dirname(this.crashLogPath), { recursive: true, mode: 0o700 });

    const safeRecord = this.redactor.redactObject(record);
    const serialized = serializeForensicRecord(safeRecord, this.crashLogMaxBytes);
    const existingSize = await getRegularFileSize(this.crashLogPath);
    if (
      existingSize !== undefined &&
      existingSize + Buffer.byteLength(serialized) > this.crashLogMaxBytes
    ) {
      await this.rotateForensicLog();
    }

    await appendFile(this.crashLogPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async rotateForensicLog(): Promise<void> {
    const backupPath = `${this.crashLogPath}${CRASH_RECOVERY_LOG_BACKUP_SUFFIX}`;
    if ((await getRegularFileSize(backupPath)) !== undefined) {
      await unlink(backupPath).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) {
          throw error;
        }
      });
    }

    try {
      await rename(this.crashLogPath, backupPath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    const rotatedSize = await getRegularFileSize(backupPath);
    if (rotatedSize !== undefined && rotatedSize > this.crashLogMaxBytes) {
      await truncate(backupPath, this.crashLogMaxBytes);
    }
  }
}

function serializeForensicRecord(record: ForensicCrashRecord, maxBytes: number): string {
  let serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) <= maxBytes) {
    return serialized;
  }

  let detail = record.detail;
  while (detail.length > 0 && Buffer.byteLength(serialized) > maxBytes) {
    const excessBytes = Buffer.byteLength(serialized) - maxBytes;
    detail = detail.slice(0, Math.max(0, detail.length - excessBytes));
    serialized = `${JSON.stringify({ ...record, detail })}\n`;
  }

  if (Buffer.byteLength(serialized) > maxBytes) {
    throw new RangeError("Crash recovery log limit is too small for forensic metadata");
  }
  return serialized;
}

async function getRegularFileSize(filePath: string): Promise<number | undefined> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) {
      throw new Error(`Refusing to replace non-file recovery log path: ${filePath}`);
    }
    return metadata.size;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function createHealthyState(): RecoveryState {
  return {
    version: RECOVERY_STATE_VERSION,
    status: "HEALTHY",
    restartCount: 0,
    crashTimestamps: [],
  };
}

function createFailClosedState(now: number): RecoveryState {
  return {
    version: RECOVERY_STATE_VERSION,
    status: "TRIPPED",
    restartCount: MAX_CRASHES_IN_WINDOW,
    crashTimestamps: [],
    trippedAt: now,
    lastFailure: {
      timestamp: now,
      category: "CONFIGURATION",
      remediation: RECOVERY_REMEDIATIONS.CONFIGURATION,
    },
  };
}

function refreshRollingWindow(
  state: RecoveryState,
  now: number,
): { state: RecoveryState; changed: boolean } {
  const cutoff = now - CRASH_WINDOW_MS;
  const crashTimestamps = state.crashTimestamps.filter(
    (timestamp) => timestamp > cutoff && timestamp <= now,
  );
  const status =
    state.status === "TRIPPED" ? "TRIPPED" : crashTimestamps.length === 0 ? "HEALTHY" : "DEGRADED";
  const restartCount =
    status === "TRIPPED"
      ? state.restartCount
      : Math.min(crashTimestamps.length, MAX_CRASHES_IN_WINDOW);
  const changed =
    status !== state.status ||
    restartCount !== state.restartCount ||
    crashTimestamps.length !== state.crashTimestamps.length ||
    crashTimestamps.some((timestamp, index) => timestamp !== state.crashTimestamps[index]);

  if (!changed) {
    return { state, changed: false };
  }

  return {
    state: {
      ...state,
      status,
      restartCount,
      crashTimestamps,
    },
    changed: true,
  };
}

function parsePersistedState(raw: string, now: number): RecoveryState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = PersistedRecoveryStateSchema.safeParse(value);
  if (!result.success) {
    return null;
  }

  const persisted = result.data;
  const crashTimestamps = persisted.crashTimestamps;
  const restartCount = Math.min(persisted.restartCount, MAX_CRASHES_IN_WINDOW);
  const exceedsCrashLimit = crashTimestamps.length > MAX_CRASHES_IN_WINDOW;
  const status: RecoveryStatus =
    persisted.status === "TRIPPED" || exceedsCrashLimit ? "TRIPPED" : persisted.status;
  const lastFailure: RecoveryFailureDiagnostic | undefined = persisted.lastFailure
    ? {
        timestamp: persisted.lastFailure.timestamp,
        category: persisted.lastFailure.category,
        remediation: RECOVERY_REMEDIATIONS[persisted.lastFailure.category],
        ...(persisted.lastFailure.exitCode === undefined
          ? {}
          : { exitCode: persisted.lastFailure.exitCode }),
      }
    : undefined;
  const parsed: RecoveryState = {
    version: RECOVERY_STATE_VERSION,
    status,
    restartCount:
      status === "TRIPPED"
        ? Math.max(restartCount, Math.min(crashTimestamps.length, MAX_CRASHES_IN_WINDOW))
        : Math.min(crashTimestamps.length, MAX_CRASHES_IN_WINDOW),
    crashTimestamps,
    ...(status === "TRIPPED" ? { trippedAt: persisted.trippedAt ?? now } : {}),
    ...(lastFailure ? { lastFailure } : {}),
  };

  return parsed;
}

function cloneRecoveryState(state: RecoveryState): RecoveryState {
  return {
    ...state,
    crashTimestamps: [...state.crashTimestamps],
    ...(state.lastFailure ? { lastFailure: { ...state.lastFailure } } : {}),
  };
}

function extractErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "";
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to a bounded diagnostic fallback.
  }

  try {
    return String(error);
  } catch {
    return "Unserializable runtime failure";
  }
}

function isFailureCategory(value: unknown): value is RecoveryFailureCategory {
  return RecoveryFailureCategorySchema.safeParse(value).success;
}

function hasErrorCode(error: unknown, code: string): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
