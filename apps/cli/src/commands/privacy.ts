import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  IpcClient,
  type StoredCloudCredentials,
  parseJwtClaims,
  resolvePaths,
} from "@resin/observer";
import {
  DeviceAuthClient,
  type OneTimeDeviceAuthorization,
  validateCloudUrl,
} from "../service/auth-bootstrap.js";

export type RetentionHoldType = "legal_hold" | "investigation" | "security_incident";

export interface PrivacySettings {
  metadataTelemetryEnabled: boolean;
  rawTranscriptUploadEnabled: boolean;
  retentionDays: number | null;
  activeHolds: Array<{ type: RetentionHoldType }>;
  updatedAt: string;
}

export type PrivacyAction = "status" | "telemetry" | "export" | "delete" | "help";
const PRIVACY_DELETE_SCOPE = "privacy:delete" as const;
const PRIVACY_DELETE_TOKEN_ENV = "RESIN_PRIVACY_DELETE_TOKEN";
const MAX_DELETE_AUTHORIZATION_LIFETIME_MS = 65 * 60 * 1000;

export interface PrivacyCommandFlags {
  action: PrivacyAction;
  telemetryAction?: "enable" | "disable";
  confirm: boolean;
  json: boolean;
  home?: string;
}

export type LocalPrivacyConfigurationState = "configured" | "default" | "invalid" | "unreadable";

export interface LocalPrivacyStatus {
  metadataTelemetryEnabled: boolean;
  configuredMetadataTelemetryEnabled: boolean;
  environmentTelemetryEnabled: boolean | null;
  configurationState: LocalPrivacyConfigurationState;
}

export type PrivacyCloudErrorCode =
  | "CLOUD_UNREACHABLE"
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_CLOUD_RESPONSE"
  | "CLOUD_REQUEST_FAILED";

export interface PrivacyStatus {
  schemaVersion: 1;
  device: LocalPrivacyStatus;
  cloud: {
    paired: boolean;
    available: boolean;
    accountId: string | null;
    settings: PrivacySettings | null;
    errorCode: PrivacyCloudErrorCode | null;
  };
  effective: {
    metadataTelemetryEnabled: boolean;
    rawTranscriptUploadEnabled: boolean;
    redactionStrategy: "metadata-only";
  };
}

export interface PrivacyExportResult {
  jobId: string;
  status: string;
  downloadAvailable: boolean;
  requestedAt: string | null;
  expiresAt: string | null;
}

export interface PrivacyDeletionResult {
  jobId: string;
  status: string;
  requestedAt: string | null;
}

export interface DaemonReloadResult {
  success: boolean;
  errors?: string[];
}

export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | ConfigValue[]
  | { [key: string]: ConfigValue };

export type ConfigRecord = Record<string, ConfigValue>;

export interface PrivacyJobResult {
  jobId: string;
  status: string;
  requestedAt: string | null;
  expiresAt: string | null;
}

function isConfigRecord(value: ConfigValue | null | undefined): value is ConfigRecord {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export interface PrivacyCommandOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  customFetch?: typeof fetch;
  loadCredentials?: () => Promise<StoredCloudCredentials | null>;
  reloadDaemon?: (config: { telemetryEnabled: boolean }) => Promise<DaemonReloadResult>;
  confirmDeletion?: (question: string) => Promise<boolean>;
  stdinIsTTY?: boolean;
  stdout?: { write: (chunk: string) => boolean | undefined };
  stderr?: { write: (chunk: string) => boolean | undefined };
  now?: () => number;
}

export type PrivacyCommandErrorCode =
  | "INVALID_ARGUMENTS"
  | "CONFIG_INVALID"
  | "CONFIG_READ_FAILED"
  | "CONFIG_WRITE_FAILED"
  | "CONFIG_ROLLBACK_FAILED"
  | "DAEMON_RELOAD_FAILED"
  | "DAEMON_ROLLBACK_FAILED"
  | "AUTHENTICATION_REQUIRED"
  | "ELEVATION_REQUIRED"
  | "CLOUD_UNREACHABLE"
  | "INVALID_CLOUD_RESPONSE"
  | "CLOUD_REQUEST_FAILED"
  | "ACTIVE_RETENTION_HOLD";

export class PrivacyCommandError extends Error {
  readonly code: PrivacyCommandErrorCode;
  readonly activeHolds: Array<{ type: RetentionHoldType }>;

  constructor(
    code: PrivacyCommandErrorCode,
    message: string,
    activeHolds: Array<{ type: RetentionHoldType }> = [],
  ) {
    super(message);
    this.name = "PrivacyCommandError";
    this.code = code;
    this.activeHolds = activeHolds;
  }
}

interface PrivacyCommandErrorJsonPayload {
  code: string;
  message: string;
  activeHolds?: Array<{ type: RetentionHoldType }>;
}

interface ConfigSnapshot {
  contents: string | null;
  record: ConfigRecord;
  configuredEnabled: boolean;
}

const HOLD_TYPES = {
  legal_hold: true,
  investigation: true,
  security_incident: true,
} satisfies Record<RetentionHoldType, true>;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const JOB_STATUSES = {
  pending: true,
  queued: true,
  processing: true,
  ready: true,
  completed: true,
  failed: true,
  cancelled: true,
} satisfies Record<string, true>;

function invalidArguments(message: string): never {
  throw new PrivacyCommandError("INVALID_ARGUMENTS", message);
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    invalidArguments(`${flag} requires a value.`);
  }
  return value;
}

export function parsePrivacyFlags(args: string[]): PrivacyCommandFlags {
  const positional: string[] = [];
  let json = false;
  let confirm = false;
  let home: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--home") {
      home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg?.startsWith("--home=")) {
      home = arg.slice("--home=".length);
      if (!home) invalidArguments("--home requires a value.");
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      invalidArguments("Unknown privacy option.");
    } else if (arg) {
      positional.push(arg);
    }
  }

  if (help || positional.length === 0) {
    return { action: "help", confirm, json, home };
  }

  const action = positional[0];
  if (action === "status" || action === "export" || action === "delete") {
    if (positional.length !== 1) {
      invalidArguments(`privacy ${action} does not accept positional arguments.`);
    }
    if (confirm && action !== "delete") {
      invalidArguments("--confirm is only valid with privacy delete.");
    }
    return { action, confirm, json, home };
  }

  if (action === "telemetry") {
    if (confirm) invalidArguments("--confirm is only valid with privacy delete.");
    if (positional.length !== 2 || !["enable", "disable"].includes(positional[1] ?? "")) {
      invalidArguments("Usage: resin privacy telemetry enable|disable");
    }
    const subAction = positional[1];
    if (subAction !== "enable" && subAction !== "disable") {
      invalidArguments("Usage: resin privacy telemetry enable|disable");
    }
    return {
      action,
      telemetryAction: subAction,
      confirm,
      json,
      home,
    };
  }

  invalidArguments("Unknown privacy command.");
}

export function printPrivacyHelp(
  output: { write: (chunk: string) => boolean | undefined } = process.stdout,
): void {
  const text = `
Usage:
  resin privacy status [--json] [--home <path>]
  resin privacy telemetry enable|disable [--json] [--home <path>]
  resin privacy export [--json] [--home <path>]
  resin privacy delete [--confirm] [--json] [--home <path>]

Commands:
  status       Show device, cloud, and effective privacy posture.
  telemetry    Enable or disable metadata telemetry on this device.
  export       Request an idempotent cloud data export.
  delete       Request personal-data deletion, subject to active retention holds.

Options:
  --confirm      Required for deletion with --json; otherwise skip interactive confirmation.
  --json         Emit a versioned machine-readable result.
  --home <path>  Use an alternate user home directory.
  -h, --help     Show this help message.

Environment:
  RESIN_PRIVACY_DELETE_TOKEN  Short-lived privacy:delete token for non-interactive deletion.
`;
  output.write(text.trimStart());
}

function parseEnvironmentTelemetry(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  return value === "1" || value === "true";
}

function aggregateLocalTelemetry(configured: boolean, environment: boolean | null): boolean {
  return environment ?? configured;
}

function parseConfigRecord(contents: string): ConfigRecord {
  let parsed: ConfigValue | null | undefined;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new PrivacyCommandError(
      "CONFIG_INVALID",
      "The daemon configuration is malformed; telemetry was not changed.",
    );
  }
  if (!isConfigRecord(parsed)) {
    throw new PrivacyCommandError(
      "CONFIG_INVALID",
      "The daemon configuration is malformed; telemetry was not changed.",
    );
  }
  const record = parsed;
  if (
    record.telemetryEnabled !== undefined &&
    record.telemetryEnabled !== true &&
    record.telemetryEnabled !== false
  ) {
    throw new PrivacyCommandError(
      "CONFIG_INVALID",
      "The daemon configuration has an invalid telemetry setting; telemetry was not changed.",
    );
  }
  return record;
}

async function readConfigSnapshot(configFile: string): Promise<ConfigSnapshot> {
  try {
    const contents = await fs.readFile(configFile, "utf8");
    const record = parseConfigRecord(contents);
    return {
      contents,
      record,
      configuredEnabled:
        record.telemetryEnabled === true || record.telemetryEnabled === false
          ? record.telemetryEnabled
          : true,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { contents: null, record: {}, configuredEnabled: true };
    }
    if (error instanceof PrivacyCommandError) throw error;
    throw new PrivacyCommandError(
      "CONFIG_READ_FAILED",
      "The daemon configuration could not be read; telemetry was not changed.",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some platforms. File sync and rename still apply.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writePrivateFileAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => undefined);
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
    await syncDirectory(directory);
  } catch {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw new PrivacyCommandError(
      "CONFIG_WRITE_FAILED",
      "The daemon configuration could not be updated safely.",
    );
  }
}

async function restoreConfig(filePath: string, previousContents: string | null): Promise<void> {
  if (previousContents !== null) {
    await writePrivateFileAtomically(filePath, previousContents);
    return;
  }

  try {
    await fs.unlink(filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new PrivacyCommandError(
        "CONFIG_ROLLBACK_FAILED",
        "The daemon rejected the change and its configuration could not be restored.",
      );
    }
  }
}

function resolveHome(home: string | undefined): string {
  return path.resolve(home ?? os.homedir());
}

export async function readLocalPrivacyStatus(
  options: Pick<PrivacyCommandOptions, "home" | "env"> = {},
): Promise<LocalPrivacyStatus> {
  const home = resolveHome(options.home);
  const env = options.env ?? process.env;
  const paths = resolvePaths({ home, env });
  const environmentTelemetryEnabled = parseEnvironmentTelemetry(env.RESIN_TELEMETRY_ENABLED);

  try {
    const snapshot = await readConfigSnapshot(paths.configFile);
    return {
      metadataTelemetryEnabled: aggregateLocalTelemetry(
        snapshot.configuredEnabled,
        environmentTelemetryEnabled,
      ),
      configuredMetadataTelemetryEnabled: snapshot.configuredEnabled,
      environmentTelemetryEnabled,
      configurationState: snapshot.contents === null ? "default" : "configured",
    };
  } catch (error) {
    const configurationState: LocalPrivacyConfigurationState =
      error instanceof PrivacyCommandError && error.code === "CONFIG_INVALID"
        ? "invalid"
        : "unreadable";
    return {
      metadataTelemetryEnabled: false,
      configuredMetadataTelemetryEnabled: false,
      environmentTelemetryEnabled,
      configurationState,
    };
  }
}

async function defaultReloadDaemon(
  home: string,
  env: NodeJS.ProcessEnv,
  config: { telemetryEnabled: boolean },
): Promise<DaemonReloadResult> {
  const paths = resolvePaths({ home, env });
  const client = new IpcClient({
    socketPath: paths.socketPath,
    timeoutMs: 3_000,
  });
  try {
    await client.connect();
    return await client.reloadConfig(config);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function setDeviceTelemetry(
  enabled: boolean,
  options: PrivacyCommandOptions = {},
): Promise<{
  configuredMetadataTelemetryEnabled: boolean;
  metadataTelemetryEnabled: boolean;
  reloaded: true;
}> {
  const home = resolveHome(options.home);
  const env = options.env ?? process.env;
  const paths = resolvePaths({ home, env });
  const snapshot = await readConfigSnapshot(paths.configFile);
  const environmentTelemetryEnabled = parseEnvironmentTelemetry(env.RESIN_TELEMETRY_ENABLED);
  const previousEffective = aggregateLocalTelemetry(
    snapshot.configuredEnabled,
    environmentTelemetryEnabled,
  );
  const effectiveEnabled = aggregateLocalTelemetry(enabled, environmentTelemetryEnabled);
  const updatedRecord = { ...snapshot.record, telemetryEnabled: enabled };
  const updatedContents = `${JSON.stringify(updatedRecord, null, 2)}\n`;
  const reload = options.reloadDaemon ?? ((config) => defaultReloadDaemon(home, env, config));

  await writePrivateFileAtomically(paths.configFile, updatedContents);

  try {
    const result = await reload({ telemetryEnabled: effectiveEnabled });
    if (!result.success) {
      throw new PrivacyCommandError(
        "DAEMON_RELOAD_FAILED",
        "The daemon rejected the telemetry change; the previous setting was restored.",
      );
    }
  } catch (error) {
    try {
      await restoreConfig(paths.configFile, snapshot.contents);
    } catch {
      throw new PrivacyCommandError(
        "CONFIG_ROLLBACK_FAILED",
        "The daemon rejected the telemetry change and its configuration could not be restored.",
      );
    }

    let runtimeRollbackSucceeded = false;
    try {
      runtimeRollbackSucceeded = (await reload({ telemetryEnabled: previousEffective })).success;
    } catch {
      // Report the sanitized divergence below.
    }

    if (!runtimeRollbackSucceeded) {
      throw new PrivacyCommandError(
        "DAEMON_ROLLBACK_FAILED",
        "The telemetry change failed. The stored configuration was restored, but the running daemon could not be rolled back. Its runtime state is unknown and may diverge until the daemon is restarted.",
      );
    }

    if (error instanceof PrivacyCommandError) throw error;
    throw new PrivacyCommandError(
      "DAEMON_RELOAD_FAILED",
      "The daemon could not reload the telemetry change; the previous setting was restored.",
    );
  }

  return {
    configuredMetadataTelemetryEnabled: enabled,
    metadataTelemetryEnabled: effectiveEnabled,
    reloaded: true,
  };
}

function sanitizeIdentifier(value: ConfigValue | undefined): string | null {
  return String(value) === value && SAFE_IDENTIFIER.test(value) ? value : null;
}

function sanitizeDate(value: ConfigValue | undefined): string | null {
  if (String(value) !== value || !ISO_TIMESTAMP.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function isRetentionHoldType(value: ConfigValue | undefined): value is RetentionHoldType {
  return String(value) === value && Object.hasOwn(HOLD_TYPES, value);
}

function parseActiveHolds(value: ConfigValue | undefined): Array<{ type: RetentionHoldType }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ type: RetentionHoldType }> = [];
  for (const entry of value) {
    let type: ConfigValue | undefined;
    if (String(entry) === entry) {
      type = entry;
    } else if (isConfigRecord(entry) && "type" in entry) {
      if (String(entry.type) === entry.type) {
        type = entry.type;
      }
    }
    if (isRetentionHoldType(type)) result.push({ type });
  }
  return result;
}

function asRecord(value: ConfigValue | undefined): ConfigRecord | null {
  return isConfigRecord(value) ? value : null;
}

function unwrapRecord(
  value: ConfigValue | undefined,
  keys: readonly string[],
): ConfigRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return record;
}

export function parsePrivacySettings(value: ConfigValue | undefined): PrivacySettings {
  const record = unwrapRecord(value, ["settings", "privacy"]);
  const updatedAt = sanitizeDate(record?.updatedAt);
  const isBool = (v: ConfigValue | undefined): v is boolean => v === true || v === false;
  const isRetentionDays = (v: ConfigValue | undefined): v is number | null =>
    v === null || (Number(v) === v && Number.isInteger(v) && v >= 1 && v <= 3_650);
  if (
    !record ||
    !isBool(record.metadataTelemetryEnabled) ||
    !isBool(record.rawTranscriptUploadEnabled) ||
    !isRetentionDays(record.retentionDays) ||
    !Array.isArray(record.activeHolds) ||
    updatedAt === null
  ) {
    throw new PrivacyCommandError(
      "INVALID_CLOUD_RESPONSE",
      "Resin Cloud returned an invalid privacy response.",
    );
  }

  const activeHolds = parseActiveHolds(record.activeHolds);
  if (activeHolds.length !== record.activeHolds.length) {
    throw new PrivacyCommandError(
      "INVALID_CLOUD_RESPONSE",
      "Resin Cloud returned an invalid privacy response.",
    );
  }

  return {
    metadataTelemetryEnabled: record.metadataTelemetryEnabled,
    rawTranscriptUploadEnabled: record.rawTranscriptUploadEnabled,
    retentionDays: record.retentionDays,
    activeHolds,
    updatedAt,
  };
}

async function defaultCredentialLoader(
  home: string,
  customFetch: typeof fetch,
): Promise<StoredCloudCredentials | null> {
  const resinHome = path.join(home, ".resin");
  const tokenFilePath = path.join(resinHome, "state", "device-token.json");
  const client = new DeviceAuthClient({
    home,
    resinHome,
    tokenFilePath,
    customFetch,
  });
  return client.loadCredentials();
}

function assertPairedCredentials(
  credentials: StoredCloudCredentials | null,
  now: number,
): StoredCloudCredentials {
  if (!credentials) {
    throw new PrivacyCommandError(
      "AUTHENTICATION_REQUIRED",
      "This installation is not paired with Resin Cloud. Run resin login first.",
    );
  }

  try {
    validateCloudUrl(credentials.cloudUrl);
  } catch {
    throw new PrivacyCommandError(
      "AUTHENTICATION_REQUIRED",
      "The paired Resin Cloud credentials are invalid. Run resin login again.",
    );
  }

  if (!credentials.accessToken) {
    throw new PrivacyCommandError(
      "AUTHENTICATION_REQUIRED",
      "The paired Resin Cloud credentials are invalid. Run resin login again.",
    );
  }

  const expiresAt = credentials.claims?.expiresAt;
  if (String(expiresAt) === expiresAt) {
    const expiration = Date.parse(expiresAt);
    if (Number.isFinite(expiration) && expiration <= now) {
      throw new PrivacyCommandError(
        "AUTHENTICATION_REQUIRED",
        "The paired Resin Cloud session has expired. Run resin login again.",
      );
    }
  }

  return credentials;
}

async function parseResponseBody(response: Response): Promise<ConfigValue | null> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function serverErrorCode(body: ConfigValue | null | undefined): string | null {
  const record = asRecord(body);
  if (!record) return null;
  if (String(record.error) === record.error) return record.error.toUpperCase();
  const error = asRecord(record.error);
  if (error && String(error.code) === error.code) return error.code.toUpperCase();
  if (String(record.code) === record.code) return record.code.toUpperCase();
  return null;
}

function serverRetentionHolds(
  body: ConfigValue | null | undefined,
): Array<{ type: RetentionHoldType }> {
  const record = asRecord(body);
  if (!record) return [];
  const error = asRecord(record.error);
  const details = asRecord(record.details) ?? (error ? asRecord(error.details) : null);
  return parseActiveHolds(
    record.activeHolds ?? error?.activeHolds ?? details?.activeHolds ?? details?.holds,
  );
}

function classifyCloudFailure(
  response: Response,
  body: ConfigValue | null | undefined,
): PrivacyCommandError {
  const code = serverErrorCode(body) ?? "";
  const holds = serverRetentionHolds(body);
  if (
    holds.length > 0 ||
    (response.status === 409 && code.includes("HOLD")) ||
    (code.includes("RETENTION") && code.includes("HOLD"))
  ) {
    return new PrivacyCommandError(
      "ACTIVE_RETENTION_HOLD",
      "Data deletion is blocked by an active retention hold.",
      holds,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new PrivacyCommandError(
      "AUTHENTICATION_REQUIRED",
      "Resin Cloud authentication is required. Run resin login again.",
    );
  }
  return new PrivacyCommandError(
    "CLOUD_REQUEST_FAILED",
    "Resin Cloud could not complete the privacy request.",
  );
}

async function cloudRequest(
  route: string,
  method: "GET" | "POST",
  credentials: StoredCloudCredentials,
  fetchImpl: typeof fetch,
): Promise<ConfigValue> {
  const cloudUrl = validateCloudUrl(credentials.cloudUrl);
  const url = new URL(`${cloudUrl.replace(/\/$/, "")}${route}`);
  let response: Response;
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.accessToken}`,
    };
    if (method === "POST") {
      // SAFETY: Setting Content-Type header on plain request headers object for POST request.
      Object.assign(headers, { "Content-Type": "application/json" });
    }
    const init: RequestInit = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    };
    if (method === "POST") {
      init.body = "{}";
    }
    response = await fetchImpl(url, init);
  } catch {
    throw new PrivacyCommandError("CLOUD_UNREACHABLE", "Resin Cloud is currently unreachable.");
  }

  const body = await parseResponseBody(response);
  if (!response.ok) throw classifyCloudFailure(response, body);
  if (body === null) {
    throw new PrivacyCommandError(
      "INVALID_CLOUD_RESPONSE",
      "Resin Cloud returned an invalid privacy response.",
    );
  }
  return body;
}

function cloudErrorCode(error: PrivacyCommandError): PrivacyCloudErrorCode {
  if (error.code === "CLOUD_UNREACHABLE") return "CLOUD_UNREACHABLE";
  if (error.code === "AUTHENTICATION_REQUIRED") return "AUTHENTICATION_REQUIRED";
  if (error.code === "INVALID_CLOUD_RESPONSE") return "INVALID_CLOUD_RESPONSE";
  return "CLOUD_REQUEST_FAILED";
}

export async function collectPrivacyStatus(
  options: PrivacyCommandOptions = {},
): Promise<PrivacyStatus> {
  const home = resolveHome(options.home);
  const fetchImpl = options.customFetch ?? globalThis.fetch;
  const local = await readLocalPrivacyStatus({ home, env: options.env });
  const loadCredentials =
    options.loadCredentials ?? (() => defaultCredentialLoader(home, fetchImpl));

  let credentials: StoredCloudCredentials | null = null;
  let settings: PrivacySettings | null = null;
  let cloudAvailable = false;
  let errorCode: PrivacyCloudErrorCode | null = null;

  try {
    credentials = await loadCredentials();
    if (credentials) {
      assertPairedCredentials(credentials, options.now?.() ?? Date.now());
      settings = parsePrivacySettings(
        await cloudRequest("/api/user/privacy", "GET", credentials, fetchImpl),
      );
      cloudAvailable = true;
    }
  } catch (error) {
    const safeError =
      error instanceof PrivacyCommandError
        ? error
        : new PrivacyCommandError("CLOUD_REQUEST_FAILED", "Privacy status is unavailable.");
    errorCode = cloudErrorCode(safeError);
  }

  const accountId = sanitizeIdentifier(credentials?.claims?.accountId);
  const cloudTelemetry = settings?.metadataTelemetryEnabled ?? false;

  return {
    schemaVersion: 1,
    device: local,
    cloud: {
      paired: credentials !== null,
      available: cloudAvailable,
      accountId,
      settings,
      errorCode,
    },
    effective: {
      metadataTelemetryEnabled: local.metadataTelemetryEnabled && cloudTelemetry,
      rawTranscriptUploadEnabled: settings?.rawTranscriptUploadEnabled ?? false,
      redactionStrategy: "metadata-only",
    },
  };
}

function parseJobResult(
  value: ConfigValue | undefined,
  nestedKeys: readonly string[],
): PrivacyJobResult {
  const record = unwrapRecord(value, nestedKeys);
  const jobId = sanitizeIdentifier(
    record?.jobId ?? record?.exportId ?? record?.deletionId ?? record?.id,
  );
  if (!record || !jobId) {
    throw new PrivacyCommandError(
      "INVALID_CLOUD_RESPONSE",
      "Resin Cloud returned an invalid job response.",
    );
  }
  const rawStatus =
    String(record.status) === record.status ? record.status.toLowerCase() : "pending";
  return {
    jobId,
    status: Object.hasOwn(JOB_STATUSES, rawStatus) ? rawStatus : "pending",
    requestedAt: sanitizeDate(record.requestedAt ?? record.createdAt),
    expiresAt: sanitizeDate(record.expiresAt),
  };
}

async function loadRequiredCredentials(
  options: PrivacyCommandOptions,
): Promise<{ credentials: StoredCloudCredentials; fetchImpl: typeof fetch }> {
  const home = resolveHome(options.home);
  const fetchImpl = options.customFetch ?? globalThis.fetch;
  const loadCredentials =
    options.loadCredentials ?? (() => defaultCredentialLoader(home, fetchImpl));
  let loaded: StoredCloudCredentials | null;
  try {
    loaded = await loadCredentials();
  } catch {
    throw new PrivacyCommandError(
      "AUTHENTICATION_REQUIRED",
      "Paired Resin Cloud credentials could not be loaded. Run resin login again.",
    );
  }
  return {
    credentials: assertPairedCredentials(loaded, options.now?.() ?? Date.now()),
    fetchImpl,
  };
}
interface PrivacyDeletionAuthorization {
  credentials: StoredCloudCredentials;
  revoke: (() => Promise<boolean>) | null;
}

function assertDeletionAuthorizationClaims(
  claims: StoredCloudCredentials["claims"],
  pairedCredentials: StoredCloudCredentials,
  now: number,
  requireDeleteScope: boolean,
): void {
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  const pairedSubject = pairedCredentials.claims.subject ?? pairedCredentials.claims.userId;
  const authorizedSubject = claims.subject ?? claims.userId;
  const identityMatches =
    claims.accountId === pairedCredentials.claims.accountId &&
    claims.workspaceId === pairedCredentials.claims.workspaceId &&
    claims.deviceId === pairedCredentials.claims.deviceId &&
    claims.installationId === pairedCredentials.claims.installationId &&
    (!pairedSubject || authorizedSubject === pairedSubject);
  const lifetime = expiresAt - issuedAt;

  if (
    !identityMatches ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    lifetime <= 0 ||
    lifetime > MAX_DELETE_AUTHORIZATION_LIFETIME_MS ||
    (requireDeleteScope && !claims.scopes.includes(PRIVACY_DELETE_SCOPE))
  ) {
    throw new PrivacyCommandError(
      "ELEVATION_REQUIRED",
      "Deletion requires a fresh, short-lived privacy:delete authorization for this paired account.",
    );
  }
}

async function authorizePrivacyDeletion(
  pairedCredentials: StoredCloudCredentials,
  fetchImpl: typeof fetch,
  options: PrivacyCommandOptions,
): Promise<PrivacyDeletionAuthorization> {
  const now = options.now?.() ?? Date.now();
  const suppliedToken = (options.env ?? process.env)[PRIVACY_DELETE_TOKEN_ENV]?.trim();
  if (suppliedToken) {
    let claims: StoredCloudCredentials["claims"];
    try {
      claims = parseJwtClaims(suppliedToken);
    } catch {
      throw new PrivacyCommandError(
        "ELEVATION_REQUIRED",
        `${PRIVACY_DELETE_TOKEN_ENV} must contain a valid, short-lived token for this paired account.`,
      );
    }
    assertDeletionAuthorizationClaims(claims, pairedCredentials, now, false);
    return {
      credentials: {
        cloudUrl: pairedCredentials.cloudUrl,
        accessToken: suppliedToken,
        claims,
        deviceId: claims.deviceId,
        workspaceId: claims.workspaceId,
        storedAt: new Date(now).toISOString(),
      },
      revoke: null,
    };
  }

  const interactive = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!interactive) {
    throw new PrivacyCommandError(
      "ELEVATION_REQUIRED",
      `Deletion requires interactive one-time approval or a short-lived ${PRIVACY_DELETE_TOKEN_ENV}.`,
    );
  }

  const output = options.stderr ?? process.stderr;
  let authorization: OneTimeDeviceAuthorization;
  output.write(
    "Deletion is confirmed but will not be sent until you approve one-time privacy:delete access.\n",
  );
  const home = resolveHome(options.home);
  const resinHome = path.join(home, ".resin");
  const client = new DeviceAuthClient({
    cloudUrl: pairedCredentials.cloudUrl,
    customFetch: fetchImpl,
    home,
    resinHome,
    tokenFilePath: path.join(resinHome, "state", "device-token.json"),
  });

  try {
    authorization = await client.authorizeOnce({
      deviceId: pairedCredentials.deviceId,
      installationId: pairedCredentials.claims.installationId,
      workspaceId: pairedCredentials.workspaceId,
      scopes: [PRIVACY_DELETE_SCOPE],
      onUserCodeReceived: (info) => {
        const targetUrl = info.verificationUriComplete ?? info.verificationUri;
        output.write(`Approve one-time deletion access at: ${targetUrl}\n`);
        output.write(`Verification code: ${info.userCode}\n`);
        output.write("Waiting for approval...\n");
      },
    });
  } catch {
    throw new PrivacyCommandError(
      "ELEVATION_REQUIRED",
      "One-time privacy:delete authorization was not approved; no deletion request was sent.",
    );
  }

  try {
    assertDeletionAuthorizationClaims(authorization.claims, pairedCredentials, now, true);
  } catch (error) {
    await authorization.revoke();
    throw error;
  }

  return {
    credentials: {
      cloudUrl: pairedCredentials.cloudUrl,
      accessToken: authorization.accessToken,
      claims: authorization.claims,
      deviceId: authorization.deviceId,
      workspaceId: authorization.claims.workspaceId,
      storedAt: new Date(now).toISOString(),
    },
    revoke: authorization.revoke,
  };
}

export async function requestPrivacyExport(
  options: PrivacyCommandOptions = {},
): Promise<PrivacyExportResult> {
  const { credentials, fetchImpl } = await loadRequiredCredentials(options);
  const body = await cloudRequest("/api/user/data/export", "POST", credentials, fetchImpl);
  const record = unwrapRecord(body, ["export", "job"]);
  const result = parseJobResult(body, ["export", "job"]);
  if (!record || (record.downloadAvailable !== true && record.downloadAvailable !== false)) {
    throw new PrivacyCommandError(
      "INVALID_CLOUD_RESPONSE",
      "Resin Cloud returned an invalid export response.",
    );
  }
  return { ...result, downloadAvailable: record.downloadAvailable };
}

export async function requestPrivacyDeletion(
  options: PrivacyCommandOptions = {},
): Promise<PrivacyDeletionResult> {
  const { credentials, fetchImpl } = await loadRequiredCredentials(options);
  const authorization = await authorizePrivacyDeletion(credentials, fetchImpl, options);
  let body: ConfigValue | undefined;
  try {
    body = await cloudRequest(
      "/api/user/data/delete",
      "POST",
      authorization.credentials,
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof PrivacyCommandError && error.code === "AUTHENTICATION_REQUIRED") {
      throw new PrivacyCommandError(
        "ELEVATION_REQUIRED",
        "The one-time privacy:delete authorization was rejected; no deletion was scheduled.",
      );
    }
    throw error;
  } finally {
    await authorization.revoke?.();
  }

  const result = parseJobResult(body, ["deletion", "job"]);
  return {
    jobId: result.jobId,
    status: result.status,
    requestedAt: result.requestedAt,
  };
}

async function defaultDeletionConfirmation(
  question: string,
  stdinIsTTY: boolean,
): Promise<boolean> {
  if (!stdinIsTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await reader.question(question)).trim() === "DELETE";
  } finally {
    reader.close();
  }
}

export function formatPrivacyStatus(status: PrivacyStatus): string {
  const cloudConsent = status.cloud.settings?.metadataTelemetryEnabled;
  const rawConsent = status.cloud.settings?.rawTranscriptUploadEnabled;
  const retention = status.cloud.settings?.retentionDays;
  const holds = status.cloud.settings?.activeHolds ?? [];
  const lines = [
    "Privacy status",
    `  Paired account: ${status.cloud.paired ? (status.cloud.accountId ?? "yes") : "no"}`,
    `  Device metadata telemetry: ${status.device.metadataTelemetryEnabled ? "enabled" : "disabled"}`,
    `  Cloud metadata consent: ${cloudConsent === undefined ? "unavailable" : cloudConsent ? "enabled" : "disabled"}`,
    `  Effective metadata telemetry: ${status.effective.metadataTelemetryEnabled ? "enabled" : "disabled"}`,
    `  Raw transcript upload consent: ${rawConsent === undefined ? "unavailable" : rawConsent ? "enabled" : "disabled"}`,
    `  Redaction strategy: ${status.effective.redactionStrategy}`,
    `  Retention: ${retention === undefined ? "unavailable" : retention === null ? "account default" : `${retention} days`}`,
    `  Active holds: ${holds.length === 0 ? "none" : holds.map((hold) => hold.type).join(", ")}`,
  ];
  if (status.cloud.errorCode === "CLOUD_UNREACHABLE") {
    lines.push("  Cloud status: offline; local privacy controls remain available");
  } else if (status.cloud.errorCode) {
    lines.push(`  Cloud status: unavailable (${status.cloud.errorCode})`);
  }
  return `${lines.join("\n")}\n`;
}

function writeJson(
  output: { write: (chunk: string) => boolean | undefined },
  value:
    | ConfigValue
    | PrivacyStatus
    | Record<
        string,
        | ConfigValue
        | PrivacyJobResult
        | PrivacyDeletionResult
        | PrivacyCommandErrorJsonPayload
        | Array<{ type: RetentionHoldType }>
        | boolean
        | string
        | number
        | null
        | undefined
      >,
): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function safeCommandError(cause: unknown): PrivacyCommandError {
  return cause instanceof PrivacyCommandError
    ? cause
    : new PrivacyCommandError(
        "CLOUD_REQUEST_FAILED",
        "The privacy command could not be completed.",
      );
}

function writeCommandError(
  error: PrivacyCommandError,
  json: boolean,
  output: { write: (chunk: string) => boolean | undefined },
): void {
  if (json) {
    const errError: PrivacyCommandErrorJsonPayload = {
      code: error.code,
      message: error.message,
    };
    if (error.activeHolds.length > 0) {
      errError.activeHolds = error.activeHolds;
    }
    writeJson(output, {
      schemaVersion: 1,
      ok: false,
      error: errError,
    });
    return;
  }
  output.write(`Privacy error [${error.code}]: ${error.message}\n`);
  if (error.activeHolds.length > 0) {
    output.write(`Active holds: ${error.activeHolds.map((hold) => hold.type).join(", ")}\n`);
  }
}

export async function privacyCommand(
  args: string[],
  options: PrivacyCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let flags: PrivacyCommandFlags;
  try {
    flags = parsePrivacyFlags(args);
  } catch (error) {
    writeCommandError(safeCommandError(error), args.includes("--json"), stderr);
    return 1;
  }

  if (flags.action === "help") {
    printPrivacyHelp(stdout);
    return 0;
  }

  const commandOptions: PrivacyCommandOptions = {
    ...options,
    home: flags.home ?? options.home,
  };

  try {
    if (flags.action === "status") {
      const status = await collectPrivacyStatus(commandOptions);
      if (flags.json) {
        writeJson(stdout, status);
      } else {
        stdout.write(formatPrivacyStatus(status));
      }
      return 0;
    }

    if (flags.action === "telemetry") {
      const enabled = flags.telemetryAction === "enable";
      const result = await setDeviceTelemetry(enabled, commandOptions);
      if (flags.json) {
        writeJson(stdout, {
          schemaVersion: 1,
          ok: true,
          command: "telemetry",
          configuredMetadataTelemetryEnabled: result.configuredMetadataTelemetryEnabled,
          metadataTelemetryEnabled: result.metadataTelemetryEnabled,
          daemonReloaded: result.reloaded,
        });
      } else {
        stdout.write(
          `Device metadata telemetry ${result.metadataTelemetryEnabled ? "enabled" : "disabled"}. Daemon configuration reloaded.\n`,
        );
        if (result.configuredMetadataTelemetryEnabled !== result.metadataTelemetryEnabled) {
          stdout.write(
            `A local environment override keeps telemetry ${result.metadataTelemetryEnabled ? "enabled" : "disabled"}.\n`,
          );
        }
      }
      return 0;
    }

    if (flags.action === "export") {
      const result = await requestPrivacyExport(commandOptions);
      if (flags.json) {
        writeJson(stdout, { schemaVersion: 1, ok: true, command: "export", result });
      } else {
        stdout.write(`Data export requested. Job ${result.jobId} is ${result.status}.\n`);
      }
      return 0;
    }

    if (flags.json && !flags.confirm) {
      throw new PrivacyCommandError(
        "INVALID_ARGUMENTS",
        "Deletion with --json requires --confirm; no request was sent.",
      );
    }

    if (!flags.confirm) {
      const confirm =
        commandOptions.confirmDeletion ??
        ((question: string) =>
          defaultDeletionConfirmation(
            question,
            commandOptions.stdinIsTTY ?? Boolean(process.stdin.isTTY),
          ));
      const accepted = await confirm(
        "This permanently deletes eligible personal data. Type DELETE to continue: ",
      );
      if (!accepted) {
        if (flags.json) {
          writeJson(stdout, {
            schemaVersion: 1,
            ok: true,
            command: "delete",
            cancelled: true,
          });
        } else {
          stdout.write(
            "Deletion cancelled; no request was sent. Use --confirm in non-interactive use.\n",
          );
        }
        return 0;
      }
    }

    const result = await requestPrivacyDeletion(commandOptions);
    if (flags.json) {
      writeJson(stdout, { schemaVersion: 1, ok: true, command: "delete", result });
    } else {
      stdout.write(`Data deletion requested. Job ${result.jobId} is ${result.status}.\n`);
    }
    return 0;
  } catch (error) {
    writeCommandError(safeCommandError(error), flags.json, stderr);
    return 1;
  }
}
