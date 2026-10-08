import path from "node:path";
import process from "node:process";
import {
  type ProductionSafetyGateStatus,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
} from "@resin/contracts";
import type { HarnessId } from "@resin/contracts";
import {
  type ConfigFsBridge,
  type HarnessVersionClassification,
  classifyHarnessVersion,
  defaultFsBridge,
  resolveHarnessUserHome,
} from "@resin/harness-contracts";
import {
  CLOUD_UPLOAD_STATUS_FILE_NAME,
  type DaemonHealthReport,
  type HarnessVersionEvidence,
  IpcClient,
  StoredCloudCredentialsSchema,
  classifyHarnessVersionEvidence,
  daemonPipePresent,
  parseCloudUploadStatus,
  resolvePaths,
} from "@resin/observer";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type HealthValue = DaemonHealthReport | JsonValue | null | undefined;
import {
  type ActionableNotification,
  areClaimsExpired,
  filterActionableNotifications,
} from "@resin/protocol";
import type { MembershipType } from "@resin/protocol";
import { AttestationVerifier, SafetyGateEvaluator } from "@resin/runtime";
import {
  HARNESS_DEFINITIONS,
  findHarnessDefinition,
  isSupportedHarnessId,
} from "../harness-registry.js";
import { getActiveVersion } from "../installer/asset-downloader.js";
import { compareSemver } from "../installer/channel-verifier.js";
import {
  DEFAULT_GATEWAY_URL,
  resolveInstalledResinMcpCommand,
  verifyHarnessRegistration,
} from "../installer/harness-config.js";
import {
  HARNESS_HEALTH_SETTINGS_FILENAME,
  loadHarnessHealthSettings,
  resolveLocalSourceResinCommand,
} from "../installer/harness-health.js";
import { fetchAccountProfile } from "../service/account-profile.js";
import {
  type CloudCredentialLoadResult,
  type CloudCredentialStatus,
  DeviceAuthClient,
} from "../service/auth-bootstrap.js";
import {
  type HarnessSessionRestartReason,
  type ProcessTableReader,
  createProcessTableReader,
  findHarnessSessionsNeedingRestart,
} from "../service/harness-sessions.js";
import {
  type LocalStateReader,
  type ServedCatalogReading,
  type ServedCatalogUnavailableReason,
  openLocalStateReader,
} from "../service/local-state-reader.js";
import { createUserServiceManager } from "../service/manager.js";
import {
  type NotificationConsumer,
  consumeCliActionableNotifications,
  deriveStatusActionableNotifications,
  formatActionableNotificationsForTerminal,
} from "../service/notifications.js";
import {
  RECOVERY_REMEDIATIONS,
  RECOVERY_STATE_FILE_NAME,
  type RecoveryFailureCategory,
} from "../service/recovery-state.js";
import {
  acknowledgeAutoUpdateNotice,
  readAutoUpdateNotice,
  readAutoUpdateState,
} from "../updates/auto-update-state.js";
import {
  type UpdateDeferralSnapshot,
  UpdateEngine,
  readUpdateStatusSnapshot,
} from "../updates/engine.js";
import {
  type CredentialUnsafeGateway,
  formatCredentialUnsafeGateways,
  listRunningGateways,
  listUnregisteredGatewayPids,
  selectCredentialUnsafeGateways,
} from "../updates/gateway-registry.js";

export const STATUS_SCHEMA_VERSION = 1 as const;

const SYSTEM_META_TOOL_NAMES = [
  "search_tools",
  "get_tool_schema",
  "invoke_tool",
  "manage_tools",
] as const;

const RECOVERY_FAILURE_CATEGORIES = {
  AUTHENTICATION: true,
  CONFIGURATION: true,
  PORT_CONFLICT: true,
  PERMISSION: true,
  NETWORK: true,
  RUNTIME: true,
  UNKNOWN: true,
} as const satisfies Record<RecoveryFailureCategory, true>;
const RETENTION_HOLD_TYPES = {
  legal_hold: true,
  investigation: true,
  security_incident: true,
} as const satisfies Record<"legal_hold" | "investigation" | "security_incident", true>;

type OverallStatus = "healthy" | "degraded" | "stopped";
type AccountStatus = CloudCredentialStatus | "local_only";
type IpcErrorCode = "socket_missing" | "timeout" | "connection_failed" | "protocol_error";
type LockfileState = "healthy" | "missing" | "stale" | "invalid" | "unknown";
type RecoveryStatus = "healthy" | "degraded" | "tripped" | "unknown";

export interface StatusRemediation {
  code:
    | "install_daemon"
    | "start_daemon"
    | "repair_ipc"
    | "repair_lockfile"
    | "refresh_login"
    | "check_network"
    | "repair_harnesses"
    | "repair_privacy_config"
    | "inspect_recovery"
    | "inspect_update";
  message: string;
  command: string | null;
}

export interface DaemonStatusSummary {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  generatedAt: string;
  status: OverallStatus;
  workspace: {
    activeDirectory: string;
    workspaceId: string | null;
    projectConfigLoaded: boolean;
    rootDir: string | null;
  };
  service: {
    installed: boolean;
    active: boolean;
    enabled: boolean;
    platform: string;
    serviceName: string;
    status: "active" | "stopped" | "not_installed" | "externally_managed";
    pid: number | null;
    /** Native Windows: the scheduled task's state (ready, running, disabled, queued, unknown). */
    taskState?: string;
  };
  ipc: {
    connected: boolean;
    responsive: boolean;
    socketPresent: boolean;
    pingLatencyMs: number | null;
    daemonVersion: string | null;
    uptimeSeconds: number | null;
    errorCode: IpcErrorCode | null;
  };
  daemon: {
    health: "healthy" | "degraded" | "stopped" | "starting" | "unknown";
    reportedHealth: string | null;
    ipcResponsive: boolean;
    activeWorkers: number | null;
    uptimeSeconds: number | null;
    lockfile: {
      state: LockfileState;
      pid: number | null;
    };
  };
  cloud: {
    authenticated: boolean;
    status: AccountStatus;
    workspaceId: string | null;
    deviceId: string | null;
    accountId: string | null;
    expiresAt: string | null;
    expired: boolean | null;
    scopes: string[];
    reasonCode: "pairing_skipped" | null;
  };
  account: {
    linked: boolean;
    status: AccountStatus;
    accountId: string | null;
    emailOrUser: string | null;
    email?: string | null;
    membershipType?: MembershipType | null;
    expiresAt: string | null;
    expired: boolean | null;
  };
  privacy: {
    source: "daemon" | "credentials" | "local" | "defaults";
    configurationState: "configured" | "default" | "invalid" | "unreadable";
    deviceMetadataTelemetryEnabled: boolean;
    cloudMetadataTelemetryEnabled: boolean | null;
    effectiveMetadataTelemetryEnabled: boolean;
    rawTranscriptUploadEnabled: boolean;
    rawTranscriptConsent: "opted_in" | "opted_out";
    retentionDays: number | null;
    activeHolds: Array<{
      type: "legal_hold" | "investigation" | "security_incident";
    }>;
    updatedAt: string | null;
  };
  telemetry: {
    enabled: boolean;
    rawTranscriptsAllowed: boolean;
    sink: "cloud" | "disabled";
  };
  recovery: {
    available: boolean;
    status: RecoveryStatus;
    restartCount: number;
    recentCrashCount: number;
    trippedAt: string | null;
    lastFailure: {
      category: RecoveryFailureCategory;
      at: string;
      remediation: string;
    } | null;
  };
  update: {
    /** Whether the update journal could be read; see `updateAvailable` for a newer release. */
    available: boolean;
    /** True only when the journal's target release is newer than the current one. */
    updateAvailable: boolean;
    channel: string | null;
    currentVersion: string | null;
    targetVersion: string | null;
    pendingVersion: string | null;
    /** The newest check: an update run (journal) or an automatic availability check. */
    lastCheckAt: string | null;
    lastResult: string | null;
    /** Since when a staged release has been waiting on active daemon work, if it is. */
    deferral: { targetVersion: string; since: string; activeCount: number | null } | null;
    hasError: boolean;
    errorCode: "update_state_unreadable" | null;
    lastRollback: {
      fromVersion: string;
      toVersion: string;
      rolledBackAt: string;
    } | null;
    quarantinedVersions: string[];
    automatic: {
      enabled: boolean | null;
      channel: string | null;
      checkIntervalMinutes: number | null;
      maintenanceWindow: { start: string; end: string; timeZone?: string } | null;
      lastCheckAt: string | null;
      lastOutcome: string | null;
      /** Raw check errors stay local (they may contain paths); status only flags them. */
      hasError: boolean;
      nextCheckAt: string | null;
      offlineFailureCount: number;
      stateError: boolean;
    };
    lastAutomaticUpdate: {
      fromVersion: string;
      toVersion: string;
      activatedAt: string;
    } | null;
    /** `resin mcp` processes still running a version other than the active install. */
    staleMcpGateways: {
      count: number;
      versions: string[];
      /** Live `resin mcp` processes that never registered a version (older releases). */
      unknownVersionCount: number;
      /**
       * Live gateways whose credential client predates the refresh hardening (resin#294), by PID;
       * `version` is null for unregistered ones. They must restart before this device pairs.
       */
      credentialUnsafe: CredentialUnsafeGateway[];
    };
  };
  harnessHealth: {
    available: boolean;
    checkedAt: string | null;
    success: boolean | null;
    hasDrift: boolean | null;
    autoRepair: boolean | null;
    /** Harnesses the user removed Resin from (`resin uninstall --harness`); never repaired. */
    disabledHarnesses?: HarnessId[];
  };
  /**
   * Running harness sessions that need a restart to reach the current Resin: started without a
   * Resin gateway, or running an older one. `available` is false where the process table cannot
   * be read (native Windows). Absent from reports written before this existed.
   */
  harnessSessions?: {
    available: boolean;
    sessions: Array<{
      harnessId: HarnessId;
      name: string;
      pid: number;
      reason: HarnessSessionRestartReason;
      version: string | null;
    }>;
  };
  harnesses: Array<{
    id: HarnessId;
    name: string;
    installed: boolean;
    configured: boolean;
    mcpAttached: boolean;
    /** `disabled`: installed, and the user removed Resin from it on purpose. */
    status: "attached" | "unconfigured" | "not_installed" | "drift" | "error" | "disabled";
    /** Installed version as reported by the harness; null when not installed or unreadable. */
    version: string | null;
    /** `version` against the definition's exact tested versions. */
    versionStatus: HarnessVersionClassification;
    /**
     * Local decode evidence for the installed `version`: counters the observer keeps while it
     * captures real sessions, classified against named thresholds.
     */
    versionEvidence: HarnessVersionEvidence;
    /** `verified on N local sessions`, `decode problems: ...`, or the fixture label. */
    versionLabel: string;
    lastCheckedAt: string | null;
    recentAction: "discovered" | "reconciled" | "drift_detected" | "repair_failed" | null;
  }>;
  safetyGate: {
    isOpen: boolean;
    status: "passed" | "failed" | "unsafe_override" | "uninitialized";
    unsafeOverrideActive: boolean;
    unmetRequirementCodes: string[];
  } | null;
  tools: {
    metaToolsCount: number;
    metaTools: string[];
    /**
     * Learned (non-system) tools in the latest catalog the MCP gateway served for the active
     * workspace, from the local state store; null when that catalog cannot be read. Never 0 as
     * a stand-in for unknown.
     */
    activeCustomToolsCount: number | null;
    customToolsCatalog: {
      status: "available" | "unavailable";
      workspaceId: string | null;
      /** When the gateway resolved the counted catalog snapshot. */
      asOf: string | null;
      reason: ServedCatalogUnavailableReason | null;
    };
  };
  remediations: StatusRemediation[];
  notifications?: ActionableNotification[];
  /**
   * Report-only verification of cloud tool signature certificates, as the MCP gateway last
   * recorded it. Absent from reports written before this existed.
   */
  toolSignatures?: ToolSignaturesStatus;
  /**
   * The last capture upload Resin Cloud accepted, as the daemon last recorded it. Absent from
   * reports written before this existed.
   */
  cloudUpload?: CloudUploadSummary;
}

export interface CloudUploadSummary {
  /** False when the daemon has recorded no accepted upload yet (or the record is unreadable). */
  available: boolean;
  lastSuccessAt: string | null;
  lastBatchObservations: number | null;
  totalBatches: number;
  totalObservations: number;
  /** When the first upload counted in the totals was accepted. */
  since: string | null;
}

export interface ToolSignaturesStatus {
  /** False when the gateway has recorded no checks yet (or the record is unreadable). */
  available: boolean;
  mode: "report-only" | "enforce";
  verified: number;
  missing: number;
  /** Checks against a cloud origin with no pinned signing key. */
  unpinned: number;
  failed: number;
  updatedAt: string | null;
}

/**
 * The gateway's tool signature state file in the daemon state directory. Mirrors
 * `TOOL_SIGNATURES_STATE_FILE_NAME` in @resin/gateway (not imported: status must not load it).
 */
export const TOOL_SIGNATURES_STATE_FILE_NAME = "tool-signatures.json";

export interface StatusCommandFlags {
  json?: boolean;
  verbose?: boolean;
  home?: string;
  socket?: string;
  help?: boolean;
}

interface StatusCollectionOptions {
  socket?: string;
  socketPath?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  entryPath?: string;
  now?: () => number;
  /** Read-only local state store view; defaults to `<dataDir>/state.db`. Not closed when injected. */
  stateReader?: LocalStateReader;
  /** Process table for the harness session check; defaults to this platform's reader. */
  readProcessTable?: ProcessTableReader;
}

interface LocalConfigSnapshot {
  telemetryEnabled: boolean;
  configurationState: DaemonStatusSummary["privacy"]["configurationState"];
  lockStaleThresholdMs: number;
}

interface CachedHarnessStatus {
  installed: boolean;
  configured: boolean;
  status: string;
  condition: string;
  checkedAt: string | null;
  recentAction: DaemonStatusSummary["harnesses"][number]["recentAction"];
}

interface CachedHarnessSnapshot {
  available: boolean;
  checkedAt: string | null;
  success: boolean | null;
  hasDrift: boolean | null;
  autoRepair: boolean | null;
  harnesses: Partial<Record<HarnessId, CachedHarnessStatus>>;
}

export function parseStatusFlags(args: string[]): StatusCommandFlags {
  const flags: StatusCommandFlags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--verbose" || arg === "-v") flags.verbose = true;
    else if (arg === "--home") {
      const value = args[index + 1];
      if (!value) throw new Error("--home requires a path");
      flags.home = value;
      index += 1;
    } else if (arg === "--socket") {
      const value = args[index + 1];
      if (!value) throw new Error("--socket requires a path");
      flags.socket = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return flags;
}

export function printStatusHelp(): void {
  const text = `
Usage:
  resin status [options]

Shows a brief summary of Resin's health, cloud sign-in, integrations, and sharing.
Problems and suggested next steps are always shown.
Use --verbose for full diagnostics or --json for machine-readable status.

Options:
  --json           Output schema-versioned JSON.
  -v, --verbose    Show detailed diagnostics.
  --home <path>    Use an alternate user home directory.
  --socket <path>  Use an alternate daemon IPC socket.
  -h, --help       Show this help message.
`;
  process.stdout.write(text.trimStart());
}

export async function collectStatus(
  options: StatusCollectionOptions & {
    home?: string;
    customHome?: string;
  } = {},
): Promise<DaemonStatusSummary> {
  const home =
    options.home ??
    options.customHome ??
    resolveHarnessUserHome({ env: options.env ?? process.env });
  return fetchDaemonStatusSummary(home, options);
}

export async function fetchDaemonStatusSummary(
  customHome: string,
  options: StatusCollectionOptions = {},
): Promise<DaemonStatusSummary> {
  const now = options.now?.() ?? Date.now();
  const env = options.env ?? process.env;
  const home = path.resolve(customHome);
  const resinHome = path.join(home, ".resin");
  const daemonPaths = resolvePaths({ home, env });
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const localConfig = await readLocalConfigSnapshot(fsBridge, daemonPaths.configFile, env);

  const serviceManager = createUserServiceManager({
    homeDir: home,
    resinHome,
    fsBridge,
    env: env.RESIN_NO_SERVICE === "1" ? { RESIN_NO_SERVICE: "1" } : undefined,
  });
  let service: DaemonStatusSummary["service"] = {
    installed: false,
    active: false,
    enabled: false,
    platform: sanitizeServiceIdentifier(serviceManager.platform, "unknown"),
    serviceName: "resin.service",
    status: "not_installed",
    pid: null,
  };
  try {
    const rawStatus = await serviceManager.status();
    const installed = Boolean(rawStatus.installed);
    const active = Boolean(rawStatus.active);
    service = {
      installed,
      active,
      enabled: Boolean(rawStatus.enabled),
      platform: sanitizeServiceIdentifier(serviceManager.platform, "unknown"),
      serviceName: sanitizeServiceIdentifier(rawStatus.serviceName, "resin.service"),
      status:
        serviceManager.platform === "external"
          ? "externally_managed"
          : active
            ? "active"
            : installed
              ? "stopped"
              : "not_installed",
      pid: safePositiveInteger(rawStatus.pid),
    };
    if (serviceManager.platform === "windows-task" && installed) {
      service.taskState = sanitizeServiceIdentifier(rawStatus.state, "unknown");
    }
  } catch {
    // Status is deliberately fail-safe; service defaults remain explicit.
  }

  const socketPath = options.socket ?? options.socketPath ?? daemonPaths.socketPath;
  const socketPresent = daemonPipePresent(socketPath) ?? (await safeExists(fsBridge, socketPath));
  let ipcConnected = false;
  let pingLatencyMs: number | null = null;
  let daemonVersion: string | null = null;
  let uptimeSeconds: number | null = null;
  let ipcErrorCode: IpcErrorCode | null = socketPresent ? null : "socket_missing";
  let daemonHealthReport: DaemonHealthReport | null = null;

  if (socketPresent) {
    const ipcClient = new IpcClient({ socketPath, timeoutMs: 2_000 });
    const pingStartedAt = performance.now();
    try {
      await ipcClient.connect();
      const pingResponse = await ipcClient.ping();
      pingLatencyMs = Math.max(0, Math.round(performance.now() - pingStartedAt));
      ipcConnected = Boolean(pingResponse.pong);
      if (!ipcConnected) ipcErrorCode = "protocol_error";
      if (ipcConnected) {
        daemonHealthReport = await ipcClient.getHealth().catch(() => null);
        const health = asRecord(daemonHealthReport);
        daemonVersion = safeVersion(health?.version);
        uptimeSeconds = safeNonnegativeInteger(health?.uptimeSeconds);
      }
    } catch (error) {
      ipcErrorCode = classifyIpcError(error);
    } finally {
      await ipcClient.close().catch(() => undefined);
    }
  }

  const lockfile = await readLockfileStatus(
    fsBridge,
    daemonPaths.lockFilePath,
    localConfig.lockStaleThresholdMs,
    now,
    ipcConnected,
  );

  const tokenFilePath = path.join(resinHome, "state", "device-token.json");
  const authClient = new DeviceAuthClient({
    tokenFilePath,
    resinHome,
    customFetch: options.customFetch,
    home,
  });
  let loadResult: CloudCredentialLoadResult;
  try {
    loadResult = await authClient.loadCredentialResult();
  } catch {
    loadResult = { status: "invalid" };
  }

  if (loadResult.status === "missing") {
    const rawCredentials = await safeReadFile(fsBridge, tokenFilePath);
    if (rawCredentials !== null) {
      const decoded = parseJson(rawCredentials);
      const parsedCredentials = StoredCloudCredentialsSchema.safeParse(decoded);
      if (parsedCredentials.success) {
        loadResult = {
          status: areClaimsExpired(parsedCredentials.data.claims) ? "expired" : "valid",
          credentials: parsedCredentials.data,
        };
      } else {
        loadResult = { status: "invalid" };
      }
    }
  }

  const credentials = loadResult.credentials;
  let accountStatus: AccountStatus = loadResult.status;
  let reasonCode: DaemonStatusSummary["cloud"]["reasonCode"] = null;
  if (loadResult.status === "missing") {
    const installJournal = parseJson(
      await safeReadFile(fsBridge, path.join(resinHome, "state", "install-journal.json")),
    );
    const journal = asRecord(installJournal);
    const steps = Array.isArray(journal?.steps) ? journal.steps : [];
    const pairingStep = steps.map(asRecord).find((step) => step?.name === "pairing");
    const pairingDetails = asRecord(pairingStep?.details);
    if (
      journal?.status === "completed" &&
      pairingStep?.status === "completed" &&
      pairingDetails?.paired === false &&
      pairingDetails.localOnly === true
    ) {
      accountStatus = "local_only";
      reasonCode = "pairing_skipped";
    }
  }

  const expiresAt = safeIsoTimestamp(credentials?.claims.expiresAt);
  const expired = credentials ? areClaimsExpired(credentials.claims) : null;
  const accountId = safePublicString(credentials?.claims.accountId);
  const profile =
    credentials && accountStatus === "valid" && !expired
      ? await fetchAccountProfile(credentials, options.customFetch)
      : null;
  const workspaceIdFromCredentials = safePublicString(credentials?.workspaceId);
  const cloud = {
    authenticated: Boolean(credentials?.accessToken),
    status: accountStatus,
    workspaceId: workspaceIdFromCredentials,
    deviceId: safePublicString(credentials?.deviceId),
    accountId,
    expiresAt,
    expired,
    scopes: Array.isArray(credentials?.claims.scopes)
      ? credentials.claims.scopes.map((scope) => String(scope)).slice(0, 8)
      : [],
    reasonCode,
  } satisfies DaemonStatusSummary["cloud"];

  const account = {
    linked: credentials !== undefined,
    status: accountStatus,
    accountId,
    emailOrUser: safePublicString(credentials?.claims.subject ?? credentials?.claims.userId),
    email: profile?.email ?? null,
    membershipType: profile?.membershipType ?? null,
    expiresAt,
    expired,
  } satisfies DaemonStatusSummary["account"];

  const workspace = await resolveWorkspaceStatus(
    options.cwd ?? process.cwd(),
    fsBridge,
    workspaceIdFromCredentials,
  );

  const harnessSnapshot = await readHarnessSnapshot(fsBridge, resinHome);
  const disabledHarnesses = await readDisabledHarnesses(fsBridge, resinHome);
  const stateReader = options.stateReader ?? openLocalStateReader({ dataDir: daemonPaths.dataDir });
  const [harnesses, servedCatalog] = await Promise.all([
    collectHarnessStatuses(
      home,
      fsBridge,
      harnessSnapshot,
      env,
      stateReader,
      options.entryPath,
      disabledHarnesses,
    ),
    stateReader.servedCatalog(options.cwd ?? process.cwd()),
  ]).finally(() => {
    if (options.stateReader === undefined) stateReader.close();
  });
  const recovery = await readRecoveryStatus(fsBridge, resinHome);
  const toolSignatures = await readToolSignaturesStatus(fsBridge, daemonPaths.stateDir);
  const cloudUpload = await readCloudUploadSummary(fsBridge, daemonPaths.stateDir);
  const update = await readUpdateStatus(fsBridge, {
    home,
    resinHome,
    gatewayResinHome: daemonPaths.homeDir,
    configPath: daemonPaths.configFile,
    env,
  });
  const harnessSessions = await readHarnessSessionsStatus({
    resinHome: daemonPaths.homeDir,
    harnesses: harnesses
      .filter((harness) => harness.status === "attached")
      .map((harness) => harness.id),
    // Under Vitest the machine's own harness sessions would leak into status assertions; tests
    // that cover the check inject a table.
    readProcessTable: options.readProcessTable ?? (process.env.VITEST ? async () => [] : undefined),
    nowMs: now,
  });
  const privacy = collectPrivacySnapshot(
    localConfig,
    daemonHealthReport,
    credentials?.claims.rawUploadConsent ?? false,
  );
  const telemetry = {
    enabled: privacy.effectiveMetadataTelemetryEnabled,
    rawTranscriptsAllowed: privacy.rawTranscriptUploadEnabled,
    sink: privacy.effectiveMetadataTelemetryEnabled ? "cloud" : "disabled",
  } satisfies DaemonStatusSummary["telemetry"];

  const reportedHealth = readReportedDaemonHealth(daemonHealthReport);
  const daemonHealth = deriveDaemonHealth(service, ipcConnected, lockfile.state, reportedHealth);
  const activeWorkers = readActiveWorkerCount(daemonHealthReport);
  const reportedNotifications = readReportedNotifications(daemonHealthReport);
  const safetyGate = await readSafetyGateStatus(home, daemonPaths.configDir, fsBridge, env);

  const remediations = buildRemediations({
    service,
    ipcConnected,
    ipcErrorCode,
    lockfileState: lockfile.state,
    accountStatus,
    recovery,
    update,
    privacy,
    harnesses,
  });

  const status = deriveOverallStatus({
    service,
    ipcConnected,
    daemonHealth,
    accountStatus,
    recovery,
    update,
    privacy,
    harnesses,
    harnessHasDrift: harnessSnapshot.hasDrift === true,
  });

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    status,
    workspace,
    service,
    ipc: {
      connected: ipcConnected,
      responsive: ipcConnected,
      socketPresent,
      pingLatencyMs,
      daemonVersion,
      uptimeSeconds,
      errorCode: ipcConnected ? null : ipcErrorCode,
    },
    daemon: {
      health: daemonHealth,
      reportedHealth,
      ipcResponsive: ipcConnected,
      activeWorkers,
      uptimeSeconds,
      lockfile,
    },
    cloud,
    account,
    privacy,
    telemetry,
    recovery,
    update,
    harnessHealth: {
      available: harnessSnapshot.available,
      checkedAt: harnessSnapshot.checkedAt,
      success: harnessSnapshot.success,
      hasDrift: harnessSnapshot.hasDrift,
      autoRepair: harnessSnapshot.autoRepair,
      ...(disabledHarnesses.length > 0 ? { disabledHarnesses } : {}),
    },
    harnessSessions,
    harnesses,
    safetyGate,
    tools: {
      metaToolsCount: SYSTEM_META_TOOL_NAMES.length,
      metaTools: [...SYSTEM_META_TOOL_NAMES],
      activeCustomToolsCount: servedCatalog.available ? servedCatalog.customToolsCount : null,
      customToolsCatalog: describeServedCatalog(servedCatalog),
    },
    remediations,
    notifications: reportedNotifications,
    toolSignatures,
    cloudUpload,
  };
}

export function formatStatusForTerminal(
  summary: DaemonStatusSummary,
  options: { verbose?: boolean } = {},
): string {
  if (options.verbose) return formatDetailedStatusForTerminal(summary);

  const notificationHeader = formatActionableNotificationsForTerminal(summary.notifications ?? []);
  const remediations = summary.remediations ?? [];
  const overall = summary.status ?? deriveLegacyOverallStatus(summary);
  const accountStatus =
    summary.account?.status ??
    summary.cloud.status ??
    (summary.cloud.authenticated ? "valid" : "missing");
  const gate = summary.safetyGate;
  const needsAttention =
    overall === "degraded" ||
    remediations.length > 0 ||
    notificationHeader.length > 0 ||
    (accountStatus !== "valid" && accountStatus !== "local_only") ||
    summary.account?.expired ||
    gate?.status === "failed" ||
    gate?.unsafeOverrideActive;
  const headline =
    overall === "stopped" ? "Stopped" : needsAttention ? "Needs attention" : "Running";
  const lines = [`Resin: ${headline}`, ""];
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(12)} ${value}`);

  let daemon: string;
  if (!summary.ipc.connected) {
    daemon = summary.service.active
      ? "Not responding"
      : summary.service.installed || summary.service.status === "externally_managed"
        ? "Stopped"
        : "Not installed";
  } else if (summary.daemon?.health === "starting") {
    daemon = "Starting";
  } else if (summary.daemon?.health === "degraded") {
    daemon = "Needs attention";
  } else if (summary.daemon?.health === "stopped") {
    daemon = "Stopped";
  } else if (summary.daemon?.health === "unknown") {
    daemon = "Responding (health unknown)";
  } else {
    daemon = summary.service.status === "externally_managed" ? "Running (foreground)" : "Running";
  }
  row("Daemon", daemon);

  const cloudLabels: Record<AccountStatus, string> = {
    valid: "Signed in",
    missing: "Not signed in",
    expired: "Sign-in expired",
    invalid: "Sign-in invalid",
    revoked: "Sign-in revoked",
    offline: "Offline (local tools still available)",
    local_only: "Local only",
  };
  row("Cloud", summary.account?.expired ? cloudLabels.expired : cloudLabels[accountStatus]);
  if (summary.account?.linked) {
    row(
      "Email",
      summary.account.email ? escapeTerminalControls(summary.account.email) : "Unavailable",
    );
    row("Membership", formatMembershipType(summary.account.membershipType));
  }

  const agents = summary.harnesses
    .filter((harness) => harness.installed)
    .map((harness) => {
      const versionTag = describeBriefVersionTag(harness);
      const name =
        versionTag === null
          ? escapeTerminalControls(harness.name)
          : `${escapeTerminalControls(harness.name)} ${escapeTerminalControls(harness.version ?? "")} (${escapeTerminalControls(versionTag)})`;
      if (harness.status === "disabled") return `${name} (Resin removed by you)`;
      if (harness.status === "drift" || harness.status === "error") return `${name} (needs repair)`;
      if (!harness.configured || !harness.mcpAttached || harness.status !== "attached") {
        return `${name} (needs setup)`;
      }
      return name;
    });
  row("Agents", agents.length > 0 ? agents.join(", ") : "None configured");

  const privacy = summary.privacy;
  const metadata =
    privacy?.effectiveMetadataTelemetryEnabled ?? summary.telemetry?.enabled ?? false;
  const consentUnknown =
    privacy?.deviceMetadataTelemetryEnabled && privacy.cloudMetadataTelemetryEnabled === null;
  const rawUploads =
    privacy?.rawTranscriptUploadEnabled ?? summary.telemetry?.rawTranscriptsAllowed ?? false;
  row(
    "Sharing",
    `Metadata ${consentUnknown ? "unknown" : metadata ? "on" : "off"}; raw transcripts ${rawUploads ? "on" : "off"}`,
  );

  if (gate?.unsafeOverrideActive) {
    row("Production", "Unsafe override");
  } else if (gate && !gate.isOpen) {
    row("Production", gate.status === "uninitialized" ? "Not verified" : "Blocked");
  }
  if (summary.cloudUpload?.available || summary.account?.linked) {
    row("Uploads", formatLastCloudUpload(summary.cloudUpload));
  }
  if (summary.toolSignatures?.available) {
    row("Signatures", formatToolSignatureCounts(summary.toolSignatures));
  }

  const automaticUpdateNotice = formatAutomaticUpdateNotice(summary.update?.lastAutomaticUpdate);
  if (automaticUpdateNotice) lines.push("", automaticUpdateNotice);
  const staleGateways = formatStaleMcpGateways(summary.update?.staleMcpGateways);
  if (staleGateways) lines.push("", staleGateways);
  const harnessSessions = formatHarnessSessionsNotice(summary.harnessSessions);
  if (harnessSessions) lines.push("", harnessSessions);

  if (remediations.length > 0) {
    lines.push("", "Next steps:");
    for (const remediation of remediations) {
      lines.push(`  - ${escapeTerminalControls(remediation.message)}`);
      if (remediation.command)
        lines.push(`    Run: ${escapeTerminalControls(remediation.command)}`);
    }
  }

  lines.push("", "Details: resin status --verbose");
  return `${notificationHeader}${lines.join("\n")}\n`;
}

function formatToolSignatureCounts(status: ToolSignaturesStatus): string {
  const counts = `${status.verified} verified, ${status.missing} missing, ${status.failed} failed`;
  const unpinned = status.unpinned > 0 ? `, ${status.unpinned} unchecked (unpinned cloud)` : "";
  return `${counts}${unpinned} (${status.mode})`;
}

/** One line, e.g. `Tool signatures (report-only): 3 verified, 1 missing, 0 failed`. */
export function formatToolSignatureSummary(status: ToolSignaturesStatus | undefined): string {
  if (!status?.available) return "Tool signatures (report-only): no checks recorded yet";
  const unpinned = status.unpinned > 0 ? `, ${status.unpinned} unchecked (unpinned cloud)` : "";
  return `Tool signatures (${status.mode}): ${status.verified} verified, ${status.missing} missing, ${status.failed} failed${unpinned}`;
}

function emptyToolSignatures(): ToolSignaturesStatus {
  return {
    available: false,
    mode: "report-only",
    verified: 0,
    missing: 0,
    unpinned: 0,
    failed: 0,
    updatedAt: null,
  };
}

/** Reads the gateway's recorded tool signature summary. Never throws; unreadable reads as none. */
export async function readToolSignaturesStatus(
  fsBridge: ConfigFsBridge,
  stateDir: string,
): Promise<ToolSignaturesStatus> {
  const raw = await safeReadFile(fsBridge, path.join(stateDir, TOOL_SIGNATURES_STATE_FILE_NAME));
  const summary = asRecord(asRecord(parseJson(raw))?.summary);
  if (summary === null) return emptyToolSignatures();
  const verified = safeNonnegativeInteger(summary.verified);
  const missing = safeNonnegativeInteger(summary.missing);
  const unpinned = safeNonnegativeInteger(summary.unpinned);
  const failed = safeNonnegativeInteger(summary.failed);
  if (verified === null || missing === null || unpinned === null || failed === null) {
    return emptyToolSignatures();
  }
  return {
    available: true,
    mode: summary.mode === "enforce" ? "enforce" : "report-only",
    verified,
    missing,
    unpinned,
    failed,
    updatedAt: safeIsoTimestamp(summary.updatedAt),
  };
}

/** e.g. `2026-10-04T09:30:00.000Z (37 observations)`, or `none recorded yet`. */
export function formatLastCloudUpload(upload: CloudUploadSummary | undefined): string {
  if (!upload?.available || upload.lastSuccessAt === null) return "none recorded yet";
  return `${upload.lastSuccessAt} (${upload.lastBatchObservations ?? 0} observations)`;
}

/** Reads the daemon's recorded last cloud upload. Never throws; unreadable reads as none. */
export async function readCloudUploadSummary(
  fsBridge: ConfigFsBridge,
  stateDir: string,
): Promise<CloudUploadSummary> {
  const raw = await safeReadFile(fsBridge, path.join(stateDir, CLOUD_UPLOAD_STATUS_FILE_NAME));
  const status = parseCloudUploadStatus(parseJson(raw));
  if (status === null) {
    return {
      available: false,
      lastSuccessAt: null,
      lastBatchObservations: null,
      totalBatches: 0,
      totalObservations: 0,
      since: null,
    };
  }
  return {
    available: true,
    lastSuccessAt: status.lastSuccessAt,
    lastBatchObservations: status.lastBatchObservations,
    totalBatches: status.totalBatches,
    totalObservations: status.totalObservations,
    since: status.since,
  };
}

function formatMembershipType(membershipType: MembershipType | null | undefined): string {
  const labels: Record<MembershipType, string> = {
    free: "Free",
    pro: "Pro",
    max: "Max",
    founder: "Founder",
  };
  return membershipType ? labels[membershipType] : "Unavailable";
}

function formatDetailedStatusForTerminal(summary: DaemonStatusSummary): string {
  const notificationHeader = formatActionableNotificationsForTerminal(summary.notifications ?? []);
  const lines: string[] = [];
  const overall = summary.status ?? deriveLegacyOverallStatus(summary);
  const overallBadge =
    overall === "healthy" ? "[OK]" : overall === "stopped" ? "[STOPPED]" : "[WARN]";

  lines.push("RESIN SYSTEM STATUS");
  lines.push(`Schema: v${summary.schemaVersion ?? STATUS_SCHEMA_VERSION}`);
  lines.push(`Overall: ${overallBadge} ${overall.toUpperCase()}`);

  const service = summary.service;
  const ipc = summary.ipc;
  lines.push("\n[Service & IPC]");
  lines.push("  [Daemon Service]");
  lines.push(`  Platform:   ${service.platform}`);
  lines.push(`  Unit:       ${service.serviceName}`);
  const serviceState =
    service.status === "externally_managed"
      ? "EXTERNALLY MANAGED (foreground)"
      : service.active
        ? "RUNNING (active)"
        : service.installed
          ? "STOPPED (inactive)"
          : "NOT INSTALLED";
  lines.push(`  State:      ${serviceState}`);
  if (service.taskState !== undefined) lines.push(`  Task:       ${service.taskState}`);
  if (service.pid !== null && service.pid !== undefined) lines.push(`  PID:        ${service.pid}`);

  lines.push("  [IPC & Subsystems]");
  if (ipc.connected) {
    lines.push("  IPC:        CONNECTED");
    if (ipc.pingLatencyMs !== null && ipc.pingLatencyMs !== undefined) {
      lines.push(`  Latency:    ${ipc.pingLatencyMs}ms`);
    }
    if (ipc.daemonVersion) lines.push(`  Version:    v${ipc.daemonVersion}`);
    if (ipc.uptimeSeconds !== null && ipc.uptimeSeconds !== undefined) {
      lines.push(`  Uptime:     ${formatDuration(ipc.uptimeSeconds)}`);
    }
  } else {
    lines.push(`  IPC:        DISCONNECTED (${formatIpcErrorCode(ipc.errorCode)})`);
  }
  const daemon = summary.daemon;
  if (daemon) {
    lines.push(`  Health:     ${daemon.health.toUpperCase()}`);
    lines.push(`  Workers:    ${daemon.activeWorkers === null ? "unknown" : daemon.activeWorkers}`);
    lines.push(`  Lockfile:   ${daemon.lockfile.state.toUpperCase()}`);
  }

  const cloud = summary.cloud;
  const account = summary.account ?? {
    linked: cloud.authenticated,
    status: cloud.status ?? (cloud.authenticated ? "valid" : "missing"),
    accountId: cloud.accountId ?? null,
    emailOrUser: null,
    expiresAt: cloud.expiresAt ?? null,
    expired: cloud.expired ?? null,
  };
  lines.push("\n[Identity & Cloud]");
  lines.push("  [Cloud Authentication]");
  lines.push(
    `  Status:     ${account.linked ? (account.expired ? "LINKED (EXPIRED)" : "LINKED") : account.status === "local_only" ? "LOCAL ONLY (Cloud Unconfigured)" : "NOT AUTHENTICATED"}`,
  );
  if (account.accountId) lines.push(`  Account:    ${account.accountId}`);
  if (account.emailOrUser) lines.push(`  User:       ${account.emailOrUser}`);
  if (account.linked) {
    lines.push(
      `  Email:      ${summary.account?.email ? escapeTerminalControls(summary.account.email) : "Unavailable"}`,
    );
    lines.push(`  Membership: ${formatMembershipType(summary.account?.membershipType)}`);
  }
  if (cloud.workspaceId) lines.push(`  Workspace:  ${cloud.workspaceId}`);
  if (account.expiresAt) {
    lines.push(`  Expires:    ${account.expiresAt}${account.expired ? " (EXPIRED)" : ""}`);
  }

  const workspace = summary.workspace;
  if (workspace) {
    lines.push("\n[Workspace]");
    lines.push(`  Active:     ${escapeTerminalControls(workspace.activeDirectory)}`);
    lines.push(
      `  Project:    ${workspace.projectConfigLoaded ? "resin.json loaded" : "not configured"}`,
    );
    if (workspace.rootDir) lines.push(`  Root:       ${escapeTerminalControls(workspace.rootDir)}`);
    if (workspace.workspaceId && workspace.workspaceId !== cloud.workspaceId) {
      lines.push(`  Workspace:  ${workspace.workspaceId}`);
    }
  }

  const privacy = summary.privacy;
  const telemetry = summary.telemetry ?? {
    enabled: false,
    rawTranscriptsAllowed: false,
    sink: "disabled" as const,
  };
  lines.push("\n[Privacy & Telemetry]");
  if (privacy) {
    const accountConsent =
      privacy.cloudMetadataTelemetryEnabled !== true &&
      privacy.cloudMetadataTelemetryEnabled !== false
        ? "unknown"
        : privacy.cloudMetadataTelemetryEnabled
          ? "on"
          : "off";
    lines.push(
      `  Metadata:   ${privacy.effectiveMetadataTelemetryEnabled ? "ENABLED" : "DISABLED"} (device ${privacy.deviceMetadataTelemetryEnabled ? "on" : "off"}, account ${accountConsent})`,
    );
    lines.push(
      `  Raw upload: ${privacy.rawTranscriptUploadEnabled ? "EXPLICIT OPT-IN" : "OPT-OUT (default)"}`,
    );
    lines.push(`  Sink:       ${telemetry.sink.toUpperCase()}`);
    lines.push(
      `  Retention:  ${privacy.retentionDays === null ? "account default" : `${privacy.retentionDays} days`}`,
    );
  } else {
    lines.push(`  Metadata:   ${telemetry.enabled ? "ENABLED" : "DISABLED"}`);
    lines.push(
      `  Raw upload: ${telemetry.rawTranscriptsAllowed ? "EXPLICIT OPT-IN" : "OPT-OUT (default)"}`,
    );
  }
  lines.push(`  Last upload: ${formatLastCloudUpload(summary.cloudUpload)}`);
  if (summary.cloudUpload?.available) {
    lines.push(
      `  Uploaded:   ${summary.cloudUpload.totalObservations} observations in ${summary.cloudUpload.totalBatches} batches since ${summary.cloudUpload.since}`,
    );
  }

  if (summary.recovery) {
    lines.push("\n[Recovery]");
    lines.push(`  Status:     ${summary.recovery.status.toUpperCase()}`);
    lines.push(`  Restarts:   ${summary.recovery.restartCount}`);
    lines.push(`  Crashes:    ${summary.recovery.recentCrashCount}`);
    if (summary.recovery.lastFailure) {
      lines.push(`  Last issue: ${summary.recovery.lastFailure.category}`);
    }
  }

  if (summary.update) {
    lines.push("\n[Updates]");
    lines.push(`  Channel:    ${summary.update.channel ?? "unknown"}`);
    lines.push(`  Current:    ${summary.update.currentVersion ?? "unknown"}`);
    if (summary.update.pendingVersion) lines.push(`  Pending:    ${summary.update.pendingVersion}`);
    if (summary.update.deferral) {
      const count = summary.update.deferral.activeCount;
      lines.push(
        `  Deferred:   since ${summary.update.deferral.since}${count === null ? "" : ` (${count} active session(s))`}`,
      );
    }
    if (summary.update.lastResult) lines.push(`  Last check: ${summary.update.lastResult}`);
    if (summary.update.errorCode) {
      lines.push(`  State:      ERROR (${summary.update.errorCode})`);
    }
    lines.push(...formatAutomaticUpdateLines(summary.update));
  }

  if (summary.safetyGate) {
    lines.push("\n[Production Safety Gate]");
    lines.push(
      `  Status:     ${summary.safetyGate.isOpen ? (summary.safetyGate.unsafeOverrideActive ? "OVERRIDE (unsafe dev mode)" : "PASS (open)") : "BLOCKED (fail-closed)"}`,
    );
  }

  if (summary.toolSignatures) {
    lines.push("\n[Tool Signatures]");
    lines.push(`  ${formatToolSignatureSummary(summary.toolSignatures)}`);
    if (summary.toolSignatures.updatedAt) {
      lines.push(`  Checked:    ${summary.toolSignatures.updatedAt}`);
    }
  }

  lines.push("\n[Tools & MCP Catalog]");
  lines.push(`  System Tools:   ${summary.tools.metaToolsCount}`);
  lines.push(`  Custom Tools:   ${formatCustomToolsCount(summary.tools)}`);

  lines.push("\n[Harness Integrations]");
  lines.push("  [Agent Harness Connections]");
  for (const harness of summary.harnesses) {
    const installed = !harness.installed
      ? "Not Installed"
      : harness.version === null
        ? "Installed, version unknown"
        : `Installed ${escapeTerminalControls(harness.version)}, ${escapeTerminalControls(harness.versionLabel ?? harness.versionStatus)}`;
    const attached = harness.configured
      ? "Configured (MCP Attached)"
      : harness.status === "disabled"
        ? `Resin removed by you (resin init --harness ${harness.id} adds it back)`
        : "Not Configured";
    lines.push(`  - ${harness.name.padEnd(16)} [${installed}] - ${attached}`);
  }
  if (summary.harnessSessions && !summary.harnessSessions.available) {
    lines.push("  Running sessions: not checked on this platform");
  }
  const harnessSessions = formatHarnessSessionsNotice(summary.harnessSessions);
  if (harnessSessions) {
    for (const line of harnessSessions.split("\n")) lines.push(`  ${line}`);
  }

  const remediations = summary.remediations ?? [];
  if (remediations.length > 0) {
    lines.push("\n[Actionable Remediation]");
    for (const remediation of remediations) {
      lines.push(`  - ${remediation.message}`);
      if (remediation.command) lines.push(`    Run: ${remediation.command}`);
    }
  }

  lines.push("");
  return `${notificationHeader}${lines.join("\n")}\n`;
}

export async function statusCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    verbose?: boolean;
    notificationConsumer?: NotificationConsumer;
  } = {},
): Promise<number> {
  let flags: StatusCommandFlags;
  try {
    flags = parseStatusFlags(args);
  } catch {
    writeStatusCommandError(args.includes("--json"), "INVALID_FLAGS", 2);
    return 2;
  }

  if (flags.help) {
    printStatusHelp();
    return 0;
  }

  const customHome = flags.home
    ? path.resolve(flags.home)
    : path.resolve(resolveHarnessUserHome({ env: options.env ?? process.env }));
  const env = { ...(options.env ?? process.env), HOME: customHome };
  try {
    const now = options.now?.() ?? Date.now();
    const summary = await fetchDaemonStatusSummary(customHome, {
      socket: flags.socket,
      fsBridge: options.fsBridge,
      customFetch: options.customFetch,
      cwd: options.cwd,
      env,
      now: () => now,
    });
    const activeNotifications = [
      ...(summary.notifications ?? []),
      ...deriveStatusActionableNotifications(summary, now),
    ];
    const notifications = await consumeCliActionableNotifications(activeNotifications, {
      home: customHome,
      // Only the observer may resolve observer-managed notifications. Status can
      // add local evidence, but an incomplete snapshot must never clear alerts.
      managedIds: [],
      now,
      consume: options.notificationConsumer,
    });
    const output = { ...summary, notifications };
    process.stdout.write(
      flags.json
        ? `${JSON.stringify(output, null, 2)}\n`
        : formatStatusForTerminal(output, { verbose: flags.verbose || options.verbose }),
    );
    if (summary.update.lastAutomaticUpdate) {
      // The notice was shown once; acknowledging it is best-effort.
      await acknowledgeAutoUpdateNotice({
        resinHome: path.join(customHome, ".resin"),
        fsBridge: options.fsBridge,
      }).catch(() => undefined);
    }
    return 0;
  } catch {
    writeStatusCommandError(Boolean(flags.json), "STATUS_EVALUATION_FAILED", 1);
    return 1;
  }
}

async function readLocalConfigSnapshot(
  fsBridge: ConfigFsBridge,
  configFile: string,
  env: NodeJS.ProcessEnv,
): Promise<LocalConfigSnapshot> {
  const environmentValue = env.RESIN_TELEMETRY_ENABLED;
  const environmentTelemetry =
    environmentValue === undefined
      ? null
      : environmentValue === "1" || environmentValue.toLowerCase() === "true";
  try {
    const raw = await fsBridge.readFile(configFile);
    if (raw === null) {
      return {
        telemetryEnabled: environmentTelemetry ?? true,
        configurationState: "default",
        lockStaleThresholdMs: 15_000,
      };
    }
    const record = asRecord(parseJson(raw));
    if (
      record === null ||
      (record.telemetryEnabled !== undefined &&
        record.telemetryEnabled !== true &&
        record.telemetryEnabled !== false)
    ) {
      return {
        telemetryEnabled: false,
        configurationState: "invalid",
        lockStaleThresholdMs: 15_000,
      };
    }
    return {
      telemetryEnabled:
        environmentTelemetry ??
        (record.telemetryEnabled === true || record.telemetryEnabled === false
          ? record.telemetryEnabled
          : true),
      configurationState: "configured",
      lockStaleThresholdMs: safePositiveInteger(record.lockStaleThresholdMs) ?? 15_000,
    };
  } catch {
    return {
      telemetryEnabled: false,
      configurationState: "unreadable",
      lockStaleThresholdMs: 15_000,
    };
  }
}

async function resolveWorkspaceStatus(
  activeDirectory: string,
  fsBridge: ConfigFsBridge,
  fallbackWorkspaceId: string | null,
): Promise<DaemonStatusSummary["workspace"]> {
  let directory = path.resolve(activeDirectory);
  const resolvedActiveDirectory = directory;
  while (true) {
    const manifestPath = path.join(directory, "resin.json");
    let rawManifest: string | null = null;
    try {
      rawManifest = await fsBridge.readFile(manifestPath);
    } catch {
      rawManifest = null;
    }
    if (rawManifest !== null) {
      const manifest = asRecord(parseJson(rawManifest));
      if (manifest !== null) {
        const nestedWorkspace = asRecord(manifest.workspace);
        const nestedProject = asRecord(manifest.project);
        return {
          activeDirectory: resolvedActiveDirectory,
          workspaceId:
            safePublicString(manifest.workspaceId) ??
            safePublicString(nestedWorkspace?.id) ??
            safePublicString(nestedProject?.workspaceId) ??
            fallbackWorkspaceId,
          projectConfigLoaded: true,
          rootDir: directory,
        };
      }
      return {
        activeDirectory: resolvedActiveDirectory,
        workspaceId: fallbackWorkspaceId,
        projectConfigLoaded: false,
        rootDir: directory,
      };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return {
    activeDirectory: resolvedActiveDirectory,
    workspaceId: fallbackWorkspaceId,
    projectConfigLoaded: false,
    rootDir: null,
  };
}

async function readLockfileStatus(
  fsBridge: ConfigFsBridge,
  lockFilePath: string,
  staleThresholdMs: number,
  now: number,
  ipcConnected: boolean,
): Promise<DaemonStatusSummary["daemon"]["lockfile"]> {
  try {
    const raw = await fsBridge.readFile(lockFilePath);
    if (raw === null) return { state: "missing", pid: null };
    const record = asRecord(parseJson(raw));
    const pid = safePositiveInteger(record?.pid);
    if (record === null || pid === null) return { state: "invalid", pid: null };
    const heartbeat = safeNonnegativeInteger(record.lastHeartbeat) ?? 0;
    const startedAt = safeNonnegativeInteger(record.startedAt) ?? 0;
    const latestLease = Math.max(heartbeat, startedAt);
    const stale = latestLease <= 0 || now - latestLease > staleThresholdMs;
    return { state: stale && !ipcConnected ? "stale" : stale ? "stale" : "healthy", pid };
  } catch {
    return { state: "unknown", pid: null };
  }
}

async function readRecoveryStatus(
  fsBridge: ConfigFsBridge,
  resinHome: string,
): Promise<DaemonStatusSummary["recovery"]> {
  let raw: string | null;
  try {
    raw = await fsBridge.readFile(path.join(resinHome, "state", RECOVERY_STATE_FILE_NAME));
  } catch {
    return emptyRecovery("unknown");
  }
  if (raw === null) return emptyRecovery("healthy");
  const record = asRecord(parseJson(raw));
  const rawStatus = record?.status;
  const status: RecoveryStatus =
    rawStatus === "HEALTHY"
      ? "healthy"
      : rawStatus === "DEGRADED"
        ? "degraded"
        : rawStatus === "TRIPPED"
          ? "tripped"
          : "unknown";
  if (record === null || record.version !== 1 || status === "unknown") {
    return emptyRecovery("unknown");
  }
  const crashes = Array.isArray(record.crashTimestamps)
    ? record.crashTimestamps.filter((value) => safeNonnegativeInteger(value) !== null)
    : [];
  const failure = asRecord(record.lastFailure);
  const category = readRecoveryCategory(failure?.category);
  const failureAt = safeIsoFromEpoch(failure?.timestamp);
  return {
    available: true,
    status,
    restartCount: safeNonnegativeInteger(record.restartCount) ?? 0,
    recentCrashCount: crashes.length,
    trippedAt: safeIsoFromEpoch(record.trippedAt),
    lastFailure:
      category && failureAt
        ? {
            category,
            at: failureAt,
            remediation: RECOVERY_REMEDIATIONS[category],
          }
        : null,
  };
}

function emptyRecovery(status: RecoveryStatus): DaemonStatusSummary["recovery"] {
  return {
    available: false,
    status,
    restartCount: 0,
    recentCrashCount: 0,
    trippedAt: null,
    lastFailure: null,
  };
}

async function readHarnessSnapshot(
  fsBridge: ConfigFsBridge,
  resinHome: string,
): Promise<CachedHarnessSnapshot> {
  const empty: CachedHarnessSnapshot = {
    available: false,
    checkedAt: null,
    success: null,
    hasDrift: null,
    autoRepair: null,
    harnesses: {},
  };
  const raw = await safeReadFile(fsBridge, path.join(resinHome, "state", "harness-health.json"));
  if (raw === null) return empty;
  const record = asRecord(parseJson(raw));
  if (record?.format !== "resin-harness-health/v1" || !Array.isArray(record.harnesses)) {
    return empty;
  }
  const harnesses: Partial<Record<HarnessId, CachedHarnessStatus>> = {};
  for (const candidate of record.harnesses) {
    const harness = asRecord(candidate);
    const id = readHarnessId(harness?.harnessId);
    if (
      !id ||
      (harness?.installed !== true && harness?.installed !== false) ||
      (harness?.configured !== true && harness?.configured !== false)
    ) {
      continue;
    }
    const recent = asRecord(harness.recentAction);
    harnesses[id] = {
      installed: harness.installed,
      configured: harness.configured,
      status: safePublicString(harness.status) ?? "unknown",
      condition: safePublicString(harness.condition) ?? "unknown",
      checkedAt: safeIsoTimestamp(harness.checkedAt),
      recentAction: readHarnessAction(recent?.kind),
    };
  }
  return {
    available: true,
    checkedAt: safeIsoTimestamp(record.checkedAt),
    success: record.success === true || record.success === false ? record.success : null,
    hasDrift: record.hasDrift === true || record.hasDrift === false ? record.hasDrift : null,
    autoRepair:
      record.autoRepair === true || record.autoRepair === false ? record.autoRepair : null,
    harnesses,
  };
}

async function verifyLiveHarnessConfig(
  fsBridge: ConfigFsBridge,
  configPath: string,
  verify: () => Promise<boolean>,
): Promise<boolean | null> {
  try {
    if ((await fsBridge.readFile(configPath)) === null) return false;
    return await verify();
  } catch {
    return null;
  }
}

async function collectHarnessStatuses(
  home: string,
  fsBridge: ConfigFsBridge,
  cached: CachedHarnessSnapshot,
  env: NodeJS.ProcessEnv,
  stateReader: LocalStateReader,
  entryPath?: string,
  disabledHarnesses: readonly HarnessId[] = [],
): Promise<DaemonStatusSummary["harnesses"]> {
  const resinCommand =
    resolveLocalSourceResinCommand(env, entryPath) ?? resolveInstalledResinMcpCommand(home);
  return Promise.all(
    HARNESS_DEFINITIONS.map(async (definition) => {
      const id = definition.id;
      const configPath = definition.mcpConfig.resolvePath(home, env);
      const [probe, liveConfigured] = await Promise.all([
        definition
          .probeInstallation({ targetPath: configPath, home, env, fsBridge })
          .catch(() => null),
        verifyLiveHarnessConfig(fsBridge, configPath, () =>
          verifyHarnessRegistration({
            harnessId: id,
            targetPath: configPath,
            workspacePath: home,
            gatewayUrl: DEFAULT_GATEWAY_URL,
            command: resinCommand,
            fsBridge,
          }),
        ),
      ]);
      const cachedHarness = cached.harnesses[id];
      const installed =
        (probe === null ? null : Boolean(probe.isInstalled)) ?? cachedHarness?.installed ?? false;
      const versionStatus = installed
        ? classifyHarnessVersion(probe?.version, definition.testedVersions)
        : "unknown";
      const versionEvidence: HarnessVersionEvidence =
        versionStatus === "unknown" || !probe
          ? { kind: "none" }
          : classifyHarnessVersionEvidence(stateReader.harnessVersionStats(id, probe.version));
      const configured = liveConfigured ?? cachedHarness?.configured ?? false;
      const useCachedDiagnostic = liveConfigured === null;
      const drift =
        useCachedDiagnostic &&
        (cachedHarness?.condition === "drifted" ||
          cachedHarness?.status === "drifted" ||
          cachedHarness?.recentAction === "drift_detected");
      const error = useCachedDiagnostic && cachedHarness?.recentAction === "repair_failed";
      return {
        id,
        name: definition.shortName,
        installed,
        configured,
        mcpAttached: configured,
        version: versionStatus === "unknown" ? null : (probe?.version ?? null),
        versionStatus,
        versionEvidence,
        versionLabel: describeHarnessVersion(versionStatus, versionEvidence),
        status:
          installed && !configured && disabledHarnesses.includes(id)
            ? "disabled"
            : error
              ? "error"
              : drift
                ? "drift"
                : !installed
                  ? "not_installed"
                  : configured
                    ? "attached"
                    : "unconfigured",
        lastCheckedAt: cachedHarness?.checkedAt ?? cached.checkedAt,
        recentAction: useCachedDiagnostic ? (cachedHarness?.recentAction ?? null) : null,
      };
    }),
  );
}

/**
 * Label for an installed harness version. Decode evidence gathered from real local sessions wins
 * (`verified` or `problems`); with too little or no evidence the recorded-fixture classification
 * is the fallback.
 */
export function describeHarnessVersion(
  versionStatus: HarnessVersionClassification,
  evidence: HarnessVersionEvidence,
): string {
  if (evidence.kind === "verified") return `verified on ${evidence.sessions} local sessions`;
  if (evidence.kind === "problems") return `decode problems: ${evidence.problems.join("; ")}`;
  return versionStatus;
}

/** The parenthesized version note in the brief Agents row; null when nothing needs saying. */
function describeBriefVersionTag(harness: DaemonStatusSummary["harnesses"][number]): string | null {
  const evidenceKind = harness.versionEvidence?.kind;
  if (evidenceKind === "problems") return harness.versionLabel;
  if (harness.versionStatus === "untested") {
    return evidenceKind === "verified" ? harness.versionLabel : "untested";
  }
  return null;
}

const CATALOG_UNAVAILABLE_LABELS: Record<ServedCatalogUnavailableReason, string> = {
  state_db_missing: "no local state store yet",
  state_db_unreadable: "local state store unreadable",
  no_workspace: "no Resin project for this directory",
  no_snapshot: "no catalog served for this workspace yet",
  snapshot_unreadable: "catalog snapshot unreadable",
};

function describeServedCatalog(
  reading: ServedCatalogReading,
): DaemonStatusSummary["tools"]["customToolsCatalog"] {
  return reading.available
    ? {
        status: "available",
        workspaceId: reading.workspaceId,
        asOf: reading.asOf,
        reason: null,
      }
    : {
        status: "unavailable",
        workspaceId: reading.workspaceId,
        asOf: null,
        reason: reading.reason,
      };
}

function formatCustomToolsCount(tools: DaemonStatusSummary["tools"]): string {
  if (tools.activeCustomToolsCount !== null) {
    const asOf = tools.customToolsCatalog?.asOf;
    return asOf
      ? `${tools.activeCustomToolsCount} (catalog as of ${asOf})`
      : `${tools.activeCustomToolsCount}`;
  }
  const reason = tools.customToolsCatalog?.reason;
  return reason ? `unknown (${CATALOG_UNAVAILABLE_LABELS[reason]})` : "unknown";
}

type UpdateJournalStatus = Omit<
  DaemonStatusSummary["update"],
  "automatic" | "lastAutomaticUpdate" | "staleMcpGateways" | "updateAvailable"
>;

async function readUpdateStatus(
  fsBridge: ConfigFsBridge,
  options: {
    home: string;
    resinHome: string;
    /** Where `resin mcp` gateways register: the RESIN_HOME-aware root they resolve themselves. */
    gatewayResinHome: string;
    configPath: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<DaemonStatusSummary["update"]> {
  const [journal, automaticCheck, lastAutomaticUpdate, staleMcpGateways] = await Promise.all([
    readUpdateJournalStatus(fsBridge, options.resinHome),
    readAutomaticUpdateStatus(fsBridge, options),
    readLastAutomaticUpdate(fsBridge, options.resinHome),
    readStaleMcpGateways(options.gatewayResinHome),
  ]);
  const { automatic } = automaticCheck;
  // Automatic checks are read-only and never touch the journal, which only update runs write:
  // report whichever of the two checked last.
  const journalCheckMs =
    journal.lastCheckAt === null ? Number.NaN : Date.parse(journal.lastCheckAt);
  const automaticIsNewer =
    automatic.lastCheckAt !== null &&
    automatic.lastOutcome !== null &&
    (Number.isNaN(journalCheckMs) || Date.parse(automatic.lastCheckAt) > journalCheckMs);
  const targetVersion = automaticIsNewer ? automaticCheck.targetVersion : journal.targetVersion;
  return {
    ...journal,
    ...(automaticIsNewer
      ? { lastCheckAt: automatic.lastCheckAt, lastResult: automatic.lastOutcome }
      : {}),
    updateAvailable:
      targetVersion !== null &&
      journal.currentVersion !== null &&
      compareSemver(targetVersion, journal.currentVersion) > 0,
    automatic,
    lastAutomaticUpdate,
    staleMcpGateways,
  };
}

/**
 * Counts `resin mcp` processes not running the active install: registered gateways on another
 * version plus live unregistered ones, whose release predates the registry. Never throws.
 */
export async function readStaleMcpGateways(
  resinHome: string,
  options: { readonly procRoot?: string; readonly isAlive?: (pid: number) => boolean } = {},
): Promise<DaemonStatusSummary["update"]["staleMcpGateways"]> {
  const none = { count: 0, versions: [], unknownVersionCount: 0, credentialUnsafe: [] };
  try {
    const registered = await listRunningGateways({
      resinHome,
      isAlive: options.isAlive,
      procRoot: options.procRoot,
    });
    const unregisteredPids = await listUnregisteredGatewayPids({
      resinHome,
      registeredPids: registered.map((gateway) => gateway.pid),
      procRoot: options.procRoot,
    });
    const credentialUnsafe = selectCredentialUnsafeGateways(registered, unregisteredPids);
    const activeVersion = getActiveVersion(resinHome);
    if (!activeVersion) return { ...none, credentialUnsafe };
    const active = activeVersion.replace(/^v/u, "");
    const stale = registered.filter((gateway) => gateway.version !== active);
    const versions = [...new Set(stale.map((gateway) => safeVersion(gateway.version)))]
      .filter((version): version is string => version !== null)
      .sort();
    const unknownVersionCount = unregisteredPids.length;
    return {
      count: stale.length + unknownVersionCount,
      versions,
      unknownVersionCount,
      credentialUnsafe,
    };
  } catch {
    return none;
  }
}

export function formatStaleMcpGateways(
  stale: DaemonStatusSummary["update"]["staleMcpGateways"] | undefined,
): string | null {
  if (!stale) return null;
  const notices: string[] = [];
  if (stale.count > 0) {
    const versions = stale.versions.map((version) => `v${version}`);
    if (stale.unknownVersionCount > 0) versions.push("unknown version");
    notices.push(
      `${stale.count} MCP gateway process(es) still run an older Resin (${versions.join(", ")}); restart the harness to load the updated version.`,
    );
  }
  const credentialUnsafe = formatCredentialUnsafeGateways(stale.credentialUnsafe);
  if (credentialUnsafe)
    notices.push(`${credentialUnsafe} \`resin login\` will not pair while they run.`);
  return notices.length > 0 ? notices.join(" ") : null;
}

/** Harnesses the user removed Resin from, from the harness health settings. Never throws. */
async function readDisabledHarnesses(
  fsBridge: ConfigFsBridge,
  resinHome: string,
): Promise<HarnessId[]> {
  try {
    const settings = await loadHarnessHealthSettings({
      settingsPath: path.join(resinHome, "config", HARNESS_HEALTH_SETTINGS_FILENAME),
      fsBridge,
    });
    return settings.disabledHarnesses.filter(isSupportedHarnessId);
  } catch {
    return [];
  }
}

/**
 * Running sessions of `harnesses` (those whose config registers Resin) that need a restart:
 * no `resin mcp` gateway below them, or one older than the active install. Never throws.
 */
export async function readHarnessSessionsStatus(options: {
  readonly resinHome: string;
  readonly harnesses: readonly HarnessId[];
  readonly readProcessTable?: ProcessTableReader;
  readonly nowMs: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly procRoot?: string;
}): Promise<NonNullable<DaemonStatusSummary["harnessSessions"]>> {
  if (options.harnesses.length === 0) return { available: true, sessions: [] };
  try {
    const table = await (options.readProcessTable ?? createProcessTableReader())();
    if (table === null) return { available: false, sessions: [] };
    const registered = await listRunningGateways({
      resinHome: options.resinHome,
      isAlive: options.isAlive,
      procRoot: options.procRoot,
    });
    const sessions = findHarnessSessionsNeedingRestart(table, {
      harnesses: options.harnesses,
      gatewayVersions: new Map(registered.map((gateway) => [gateway.pid, gateway.version])),
      activeVersion: getActiveVersion(options.resinHome),
      resinHome: options.resinHome,
      nowMs: options.nowMs,
    });
    return {
      available: true,
      sessions: sessions.map((session) => ({
        ...session,
        name: findHarnessDefinition(session.harnessId)?.shortName ?? session.harnessId,
        version: safeVersion(session.version),
      })),
    };
  } catch {
    return { available: false, sessions: [] };
  }
}

/** One line per harness naming the sessions to restart, or null when there are none. */
export function formatHarnessSessionsNotice(
  status: DaemonStatusSummary["harnessSessions"] | undefined,
): string | null {
  if (!status || status.sessions.length === 0) return null;
  const lines: string[] = [];
  const pids = (sessions: readonly { pid: number }[]) =>
    `${sessions.length === 1 ? "PID" : "PIDs"} ${sessions.map((session) => session.pid).join(", ")}`;
  for (const harnessId of new Set(status.sessions.map((session) => session.harnessId))) {
    const sessions = status.sessions.filter((session) => session.harnessId === harnessId);
    const name = escapeTerminalControls(sessions[0]?.name ?? harnessId);
    const missing = sessions.filter((session) => session.reason === "missing");
    const outdated = sessions.filter((session) => session.reason === "outdated");
    if (missing.length > 0) {
      lines.push(
        `${missing.length} ${name} session(s) started without Resin (${pids(missing)}); restart them to use Resin's tools.`,
      );
    }
    if (outdated.length > 0) {
      const versions = [
        ...new Set(
          outdated.map((session) => (session.version ? `v${session.version}` : "unknown version")),
        ),
      ].sort();
      lines.push(
        `${outdated.length} ${name} session(s) run an older Resin (${versions.join(", ")}; ${pids(outdated)}); restart them to load the current version.`,
      );
    }
  }
  return lines.join("\n");
}

function readDeferralStatus(
  deferral: UpdateDeferralSnapshot | null | undefined,
): DaemonStatusSummary["update"]["deferral"] {
  const targetVersion = safeVersion(deferral?.targetVersion);
  const since = safeIsoTimestamp(deferral?.since);
  return deferral && targetVersion && since
    ? { targetVersion, since, activeCount: deferral.activeCount }
    : null;
}

async function readUpdateJournalStatus(
  fsBridge: ConfigFsBridge,
  resinHome: string,
): Promise<UpdateJournalStatus> {
  try {
    const snapshot = await readUpdateStatusSnapshot({ resinHome, fsBridge });
    if (!snapshot) return emptyUpdate();
    return {
      available: true,
      channel: snapshot.channel,
      currentVersion: snapshot.currentVersion,
      targetVersion: snapshot.targetVersion,
      pendingVersion: snapshot.pendingVersion,
      lastCheckAt: snapshot.lastCheckAt,
      lastResult: snapshot.lastResult,
      deferral: readDeferralStatus(snapshot.deferral),
      hasError: snapshot.lastError !== null || snapshot.lastResult === "failed",
      errorCode: null,
      lastRollback: snapshot.lastRollback
        ? {
            fromVersion: snapshot.lastRollback.fromVersion,
            toVersion: snapshot.lastRollback.toVersion,
            rolledBackAt: snapshot.lastRollback.rolledBackAt,
          }
        : null,
      quarantinedVersions: snapshot.quarantine.map((entry) => entry.version),
    };
  } catch {
    return emptyUpdate("update_state_unreadable");
  }
}

function emptyUpdate(
  errorCode: DaemonStatusSummary["update"]["errorCode"] = null,
): UpdateJournalStatus {
  return {
    available: false,
    channel: null,
    currentVersion: null,
    targetVersion: null,
    pendingVersion: null,
    lastCheckAt: null,
    lastResult: null,
    deferral: null,
    hasError: errorCode !== null,
    errorCode,
    lastRollback: null,
    quarantinedVersions: [],
  };
}

async function readAutomaticUpdateStatus(
  fsBridge: ConfigFsBridge,
  options: {
    home: string;
    resinHome: string;
    configPath: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{
  automatic: DaemonStatusSummary["update"]["automatic"];
  /** The release the latest automatic check found, when it named one. */
  targetVersion: string | null;
}> {
  const automatic: DaemonStatusSummary["update"]["automatic"] = {
    enabled: null,
    channel: null,
    checkIntervalMinutes: null,
    maintenanceWindow: null,
    lastCheckAt: null,
    lastOutcome: null,
    hasError: false,
    nextCheckAt: null,
    offlineFailureCount: 0,
    stateError: false,
  };
  try {
    const policy = await new UpdateEngine({
      homeDir: options.home,
      resinHome: options.resinHome,
      configPath: options.configPath,
      env: options.env,
      fsBridge,
    }).readPolicy();
    automatic.enabled = policy.autoUpdate;
    automatic.channel = policy.channel;
    automatic.checkIntervalMinutes = policy.checkIntervalMinutes;
    const window = policy.maintenanceWindow;
    automatic.maintenanceWindow = window
      ? {
          start: window.start,
          end: window.end,
          ...(window.timeZone ? { timeZone: window.timeZone } : {}),
        }
      : null;
  } catch {
    // An invalid update policy is reported as unknown; status never fails on it.
  }
  let targetVersion: string | null = null;
  try {
    const state = await readAutoUpdateState({ resinHome: options.resinHome, fsBridge });
    if (state) {
      automatic.lastCheckAt = safeIsoTimestamp(state.lastCheck?.at);
      automatic.lastOutcome = state.lastCheck?.outcome ?? null;
      automatic.hasError = Boolean(state.lastCheck?.error);
      automatic.nextCheckAt = safeIsoTimestamp(state.nextCheckAt ?? undefined);
      automatic.offlineFailureCount = state.scheduler.offlineFailureCount;
      targetVersion = safeVersion(state.lastCheck?.targetVersion ?? undefined);
    }
  } catch {
    automatic.stateError = true;
  }
  return { automatic, targetVersion };
}

export async function readLastAutomaticUpdate(
  fsBridge: ConfigFsBridge,
  resinHome: string,
): Promise<DaemonStatusSummary["update"]["lastAutomaticUpdate"]> {
  try {
    const notice = await readAutoUpdateNotice({ resinHome, fsBridge });
    if (!notice) return null;
    const fromVersion = safeVersion(notice.fromVersion);
    const toVersion = safeVersion(notice.toVersion);
    const activatedAt = safeIsoTimestamp(notice.activatedAt);
    return fromVersion && toVersion && activatedAt ? { fromVersion, toVersion, activatedAt } : null;
  } catch {
    return null;
  }
}

export function formatAutomaticUpdateNotice(
  notice: DaemonStatusSummary["update"]["lastAutomaticUpdate"] | undefined,
): string | null {
  if (!notice) return null;
  return `Updated automatically: v${notice.fromVersion} -> v${notice.toVersion} (at ${notice.activatedAt})`;
}

function formatAutomaticUpdateLines(update: DaemonStatusSummary["update"]): string[] {
  const automatic = update.automatic;
  const lines: string[] = [];
  if (automatic) {
    if (automatic.enabled === null) {
      lines.push("  Automatic:  unknown (update configuration is invalid)");
    } else if (!automatic.enabled) {
      lines.push("  Automatic:  off (updates.autoUpdate=false)");
    } else {
      lines.push(
        `  Automatic:  on (every ${automatic.checkIntervalMinutes ?? "?"}m, ${automatic.channel ?? "unknown"})`,
      );
    }
    const window = automatic.maintenanceWindow;
    if (window) {
      lines.push(
        `  Window:     ${escapeTerminalControls(`${window.start}-${window.end} ${window.timeZone ?? "UTC"}`)}`,
      );
    }
    if (automatic.enabled && automatic.nextCheckAt) {
      lines.push(`  Next check: ${automatic.nextCheckAt}`);
    }
    if (automatic.lastOutcome) {
      const at = automatic.lastCheckAt ? ` at ${automatic.lastCheckAt}` : "";
      const error = automatic.hasError ? " (error; see resin doctor)" : "";
      lines.push(`  Last auto:  ${automatic.lastOutcome}${at}${error}`);
    }
    if (automatic.stateError) {
      lines.push("  Auto state: ERROR (auto_update_state_unreadable)");
    }
  }
  const notice = formatAutomaticUpdateNotice(update.lastAutomaticUpdate);
  if (notice) lines.push(`  ${notice}`);
  const staleGateways = formatStaleMcpGateways(update.staleMcpGateways);
  if (staleGateways) lines.push(`  ${staleGateways}`);
  return lines;
}

function collectPrivacySnapshot(
  localConfig: LocalConfigSnapshot,
  daemonHealthReport: HealthValue,
  credentialRawConsent: boolean,
): DaemonStatusSummary["privacy"] {
  const health = asRecord(daemonHealthReport);
  const telemetry = asRecord(health?.telemetry);
  const daemonPrivacy = asRecord(health?.privacy);
  const cloudMetadataTelemetryEnabled = firstBoolean(
    daemonPrivacy?.metadataTelemetryEnabled,
    telemetry?.cloudConsentEnabled,
    telemetry?.cloudConsent,
    telemetry?.accountEnabled,
  );
  const daemonEffectiveTelemetry = firstBoolean(
    telemetry?.effectiveEnabled,
    telemetry?.effectiveMetadataTelemetryEnabled,
    daemonPrivacy?.effectiveMetadataTelemetryEnabled,
  );
  const daemonDeviceTelemetry = firstBoolean(
    telemetry?.deviceEnabled,
    telemetry?.deviceTelemetryEnabled,
  );
  const deviceMetadataTelemetryEnabled =
    localConfig.telemetryEnabled &&
    daemonDeviceTelemetry !== false &&
    telemetry?.failClosed !== true;
  const rawTranscriptUploadEnabled =
    firstBoolean(
      daemonPrivacy?.rawTranscriptUploadEnabled,
      telemetry?.rawTranscriptUploadEnabled,
    ) ?? credentialRawConsent;
  const retentionDays = readRetentionDays(daemonPrivacy?.retentionDays);
  const activeHolds = readRetentionHolds(daemonPrivacy?.activeHolds);
  const updatedAt = safeIsoTimestamp(daemonPrivacy?.updatedAt);
  const daemonSource = telemetry !== null || daemonPrivacy !== null;
  return {
    source: daemonSource
      ? "daemon"
      : credentialRawConsent
        ? "credentials"
        : localConfig.configurationState === "default"
          ? "defaults"
          : "local",
    configurationState: localConfig.configurationState,
    deviceMetadataTelemetryEnabled,
    cloudMetadataTelemetryEnabled,
    effectiveMetadataTelemetryEnabled:
      deviceMetadataTelemetryEnabled &&
      cloudMetadataTelemetryEnabled === true &&
      daemonEffectiveTelemetry !== false,
    rawTranscriptUploadEnabled,
    rawTranscriptConsent: rawTranscriptUploadEnabled ? "opted_in" : "opted_out",
    retentionDays,
    activeHolds,
    updatedAt,
  };
}

async function readSafetyGateStatus(
  home: string,
  configDir: string,
  fsBridge: ConfigFsBridge,
  env: NodeJS.ProcessEnv,
): Promise<DaemonStatusSummary["safetyGate"]> {
  let attestation: SafetyAttestationRecord | null = null;
  for (const candidate of [
    path.join(home, ".resin", "safety-attestation.json"),
    path.join(configDir, "safety-attestation.json"),
    path.join(home, ".resin", "state", "safety-attestation.json"),
  ]) {
    const decoded = parseJson(await safeReadFile(fsBridge, candidate));
    const parsed = SafetyAttestationRecordSchema.safeParse(decoded);
    if (parsed.success) {
      attestation = parsed.data;
      break;
    }
  }
  try {
    const publicKey = await safeReadFile(
      fsBridge,
      path.join(home, ".resin", "state", "safety-attestation.pub.pem"),
    );
    const trustedPublicKeys = new Map<string, string>();
    const keyId = attestation?.signature?.keyId;
    if (publicKey && keyId) trustedPublicKeys.set(keyId, publicKey);
    const gate = new SafetyGateEvaluator({
      attestation,
      verifier: new AttestationVerifier({
        trustedPublicKeys,
        allowUnsignedTestAttestations: Boolean(env.VITEST || env.VITEST_WORKER_ID),
      }),
    }).getStatus();
    return sanitizeSafetyGate(gate);
  } catch {
    return null;
  }
}

function sanitizeSafetyGate(
  gate: ProductionSafetyGateStatus,
): NonNullable<DaemonStatusSummary["safetyGate"]> {
  return {
    isOpen: gate.isOpen,
    status: gate.status,
    unsafeOverrideActive: gate.unsafeOverrideActive,
    unmetRequirementCodes: gate.unmetRequirements
      .map((requirement) => requirement.code)
      .filter((code) => /^[A-Z0-9_.-]{1,64}$/i.test(code))
      .slice(0, 32),
  };
}

function deriveDaemonHealth(
  service: DaemonStatusSummary["service"],
  ipcConnected: boolean,
  lockfileState: LockfileState,
  reportedHealth: string | null,
): DaemonStatusSummary["daemon"]["health"] {
  if (!service.active && !ipcConnected) return "stopped";
  if (reportedHealth === "starting") return "starting";
  if (
    (!service.active && service.status !== "externally_managed") ||
    !ipcConnected ||
    lockfileState !== "healthy"
  )
    return "degraded";
  if (reportedHealth === null) return "unknown";
  return reportedHealth === "fully-ready" ? "healthy" : "degraded";
}

function deriveOverallStatus(input: {
  service: DaemonStatusSummary["service"];
  ipcConnected: boolean;
  daemonHealth: DaemonStatusSummary["daemon"]["health"];
  accountStatus: AccountStatus;
  recovery: DaemonStatusSummary["recovery"];
  update: DaemonStatusSummary["update"];
  privacy: DaemonStatusSummary["privacy"];
  harnesses: DaemonStatusSummary["harnesses"];
  harnessHasDrift: boolean;
}): OverallStatus {
  if (!input.service.active && !input.ipcConnected) return "stopped";
  if (
    input.daemonHealth !== "healthy" ||
    ["expired", "invalid", "revoked", "offline"].includes(input.accountStatus) ||
    ["degraded", "tripped", "unknown"].includes(input.recovery.status) ||
    input.update.hasError ||
    (input.privacy.deviceMetadataTelemetryEnabled &&
      input.privacy.cloudMetadataTelemetryEnabled === null) ||
    ["invalid", "unreadable"].includes(input.privacy.configurationState) ||
    input.harnessHasDrift ||
    input.harnesses.some(
      (harness) =>
        harness.status === "unconfigured" ||
        harness.status === "drift" ||
        harness.status === "error",
    )
  ) {
    return "degraded";
  }
  return "healthy";
}

function buildRemediations(input: {
  service: DaemonStatusSummary["service"];
  ipcConnected: boolean;
  ipcErrorCode: IpcErrorCode | null;
  lockfileState: LockfileState;
  accountStatus: AccountStatus;
  recovery: DaemonStatusSummary["recovery"];
  update: DaemonStatusSummary["update"];
  privacy: DaemonStatusSummary["privacy"];
  harnesses: DaemonStatusSummary["harnesses"];
}): StatusRemediation[] {
  const remediations: StatusRemediation[] = [];
  const add = (remediation: StatusRemediation) => {
    if (!remediations.some((candidate) => candidate.code === remediation.code)) {
      remediations.push(remediation);
    }
  };
  if (input.service.status === "externally_managed") {
    if (!input.ipcConnected) {
      add({
        code: "start_daemon",
        message: "The externally managed daemon IPC endpoint is unreachable.",
        command: "resin-daemon --foreground",
      });
    }
  } else if (!input.service.installed) {
    add({
      code: "install_daemon",
      message: "The Resin daemon is not installed.",
      command: "resin init",
    });
  } else if (!input.service.active) {
    add({
      code: "start_daemon",
      message: "The Resin daemon is stopped.",
      command: "resin doctor --fix",
    });
  }
  if (input.service.active && !input.ipcConnected) {
    add({
      code: "repair_ipc",
      message:
        input.ipcErrorCode === "timeout"
          ? "The daemon IPC endpoint timed out."
          : "The service is active but daemon IPC is unreachable.",
      command: "resin doctor --fix",
    });
  }
  if (["stale", "invalid", "unknown"].includes(input.lockfileState)) {
    add({
      code: "repair_lockfile",
      message: "The daemon lockfile needs repair.",
      command: "resin doctor --fix",
    });
  }
  if (["expired", "invalid", "revoked"].includes(input.accountStatus)) {
    add({
      code: "refresh_login",
      message: "Cloud authentication must be refreshed.",
      command: "resin login",
    });
  } else if (input.accountStatus === "offline") {
    add({
      code: "check_network",
      message: "Cloud is offline; local MCP operation remains available.",
      command: null,
    });
  }
  if (
    input.harnesses.some(
      (harness) =>
        harness.status === "unconfigured" ||
        harness.status === "drift" ||
        harness.status === "error",
    )
  ) {
    add({
      code: "repair_harnesses",
      message: "One or more installed harness integrations need attention.",
      command: "resin doctor --fix",
    });
  }
  if (["invalid", "unreadable"].includes(input.privacy.configurationState)) {
    add({
      code: "repair_privacy_config",
      message:
        "The local privacy configuration is invalid or unreadable; telemetry is fail-closed.",
      command: "resin doctor --fix",
    });
  }
  if (["degraded", "tripped", "unknown"].includes(input.recovery.status)) {
    add({
      code: "inspect_recovery",
      message:
        input.recovery.lastFailure?.remediation ?? "Runtime recovery state needs inspection.",
      command: "resin doctor",
    });
  }
  if (input.update.hasError) {
    add({
      code: "inspect_update",
      message:
        input.update.errorCode === "update_state_unreadable"
          ? "The local update state is unreadable; inspect or repair it before updating."
          : "The last update did not complete successfully.",
      command: "resin doctor",
    });
  }
  return remediations;
}

function readReportedDaemonHealth(value: HealthValue): string | null {
  const status = asRecord(value)?.status;
  // SAFETY: String equality check verifies that status is a string literal.
  return String(status) === status &&
    [
      "fully-ready",
      "cloud-offline",
      "adapter-degraded",
      "runtime-degraded",
      "upgrade-required",
      "degraded",
      "starting",
      "stopping",
      "stopped",
      "failed",
    ].includes(status as string)
    ? (status as string)
    : null;
}
function readReportedNotifications(value: HealthValue): ActionableNotification[] {
  const notifications = asRecord(value)?.notifications;
  return Array.isArray(notifications) ? filterActionableNotifications(notifications) : [];
}

function readActiveWorkerCount(value: HealthValue): number | null {
  const modules = asRecord(asRecord(value)?.modules);
  if (!modules) return null;
  let total = 0;
  let found = false;
  for (const moduleHealth of Object.values(modules)) {
    const details = asRecord(asRecord(moduleHealth)?.details);
    const count = firstNonnegativeInteger(
      details?.activeWorkers,
      details?.runningWorkers,
      details?.workerCount,
    );
    if (count !== null) {
      total += count;
      found = true;
    }
  }
  return found ? total : null;
}

function readRetentionDays(value: HealthValue): number | null {
  if (value === null || value === undefined) return null;
  const days = safeNonnegativeInteger(value);
  return days === null ? null : days;
}

function readRetentionHolds(value: HealthValue): DaemonStatusSummary["privacy"]["activeHolds"] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .map((record) => record?.type)
    .filter(
      (type): type is "legal_hold" | "investigation" | "security_incident" =>
        // SAFETY: Type checked against retention hold map keys.
        String(type) === type &&
        RETENTION_HOLD_TYPES[type as keyof typeof RETENTION_HOLD_TYPES] === true,
    )
    .map((type) => ({ type }));
}

function readRecoveryCategory(value: HealthValue): RecoveryFailureCategory | null {
  // SAFETY: String membership in failure categories maps to RecoveryFailureCategory.
  return String(value) === value &&
    RECOVERY_FAILURE_CATEGORIES[value as RecoveryFailureCategory] === true
    ? (value as RecoveryFailureCategory)
    : null;
}

function readHarnessId(value: HealthValue): HarnessId | null {
  return isSupportedHarnessId(value) ? value : null;
}

function readHarnessAction(
  value: HealthValue,
): DaemonStatusSummary["harnesses"][number]["recentAction"] {
  // SAFETY: String membership in allowed recentAction values.
  return String(value) === value &&
    ["discovered", "reconciled", "drift_detected", "repair_failed"].includes(value as string)
    ? (value as DaemonStatusSummary["harnesses"][number]["recentAction"])
    : null;
}

function classifyIpcError(cause: unknown): IpcErrorCode {
  // SAFETY: Object validation inspects optional code property on error instance or object.
  const record = cause instanceof Object ? (cause as { code?: unknown }) : null;
  const code = String(record?.code) === record?.code ? String(record?.code) : "";
  const name = cause instanceof Error ? cause.name : "";
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (
    code === "ETIMEDOUT" ||
    name === "AbortError" ||
    message.includes("timeout") ||
    message.includes("timed out")
  ) {
    return "timeout";
  }
  if (["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE"].includes(code)) {
    return "connection_failed";
  }
  return "connection_failed";
}

function formatIpcErrorCode(value: IpcErrorCode | string | null | undefined): string {
  if (value === "socket_missing") return "socket missing";
  if (value === "timeout") return "timeout";
  if (value === "protocol_error") return "protocol error";
  return "unreachable";
}

function deriveLegacyOverallStatus(summary: DaemonStatusSummary): OverallStatus {
  if (!summary.service.active && !summary.ipc.connected) return "stopped";
  return (summary.service.active || summary.service.status === "externally_managed") &&
    summary.ipc.connected
    ? "healthy"
    : "degraded";
}

function writeStatusCommandError(json: boolean, code: string, exitCode: number): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: STATUS_SCHEMA_VERSION,
          status: "error",
          error: { code },
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(
      code === "INVALID_FLAGS"
        ? "Invalid status options. Run `resin status --help`.\n"
        : "Unable to evaluate Resin status.\n",
    );
  }
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s` : `${minutes}m ${remainder}s`;
}

async function safeReadFile(fsBridge: ConfigFsBridge, filePath: string): Promise<string | null> {
  try {
    return await fsBridge.readFile(filePath);
  } catch {
    return null;
  }
}

async function safeExists(fsBridge: ConfigFsBridge, filePath: string): Promise<boolean> {
  try {
    return await fsBridge.exists(filePath);
  } catch {
    return false;
  }
}

function parseJson(raw: string | null): JsonValue | null {
  if (raw === null) return null;
  try {
    // SAFETY: JSON.parse result treated safely via parse helpers.
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

function isJsonObject(value: HealthValue): value is JsonObject {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function asRecord(value: HealthValue): JsonObject | null {
  return isJsonObject(value) ? value : null;
}
function isString(value: JsonValue | undefined): value is string {
  return value !== null && value !== undefined && String(value) === value;
}

function safePublicString(value: JsonValue | undefined, maxLength = 256): string | null {
  if (!isString(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}
function escapeTerminalControls(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function sanitizeServiceIdentifier(value: JsonValue | undefined, fallback: string): string {
  const sanitized = safePublicString(value, 128);
  return sanitized ?? fallback;
}
function safeVersion(value: JsonValue | undefined): string | null {
  const version = safePublicString(value, 64);
  if (!version) return null;
  return /^[0-9A-Za-z.+_-]+$/.test(version) ? version : null;
}

function safePositiveInteger(value: HealthValue): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeNonnegativeInteger(value: HealthValue): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function firstNonnegativeInteger(...values: HealthValue[]): number | null {
  for (const value of values) {
    const parsed = safeNonnegativeInteger(value);
    if (parsed !== null) return parsed;
  }
  return null;
}
function firstBoolean(...values: (JsonValue | undefined)[]): boolean | null {
  for (const value of values) {
    if (value === true) return true;
    if (value === false) return false;
  }
  return null;
}

function safeIsoTimestamp(value: JsonValue | undefined): string | null {
  if (!isString(value)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeIsoFromEpoch(value: JsonValue | undefined): string | null {
  const timestamp = safeNonnegativeInteger(value);
  if (timestamp === null) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}
