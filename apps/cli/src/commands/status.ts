import os from "node:os";
import path from "node:path";
import process from "node:process";
import { probeClaudeInstallation } from "@resin/adapter-claude-code";
import { probeCodexInstallation } from "@resin/adapter-codex";
import { probeOmpInstallation } from "@resin/adapter-omp";
import {
  type ProductionSafetyGateStatus,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
} from "@resin/contracts";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import {
  type DaemonHealthReport,
  IpcClient,
  StoredCloudCredentialsSchema,
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
import { AttestationVerifier, SafetyGateEvaluator } from "@resin/runtime";
import {
  DEFAULT_GATEWAY_URL,
  resolveHarnessConfigPath,
  resolveInstalledResinMcpCommand,
  verifyHarnessRegistration,
} from "../installer/harness-config.js";
import { resolveLocalSourceResinCommand } from "../installer/harness-health.js";
import {
  type CloudCredentialLoadResult,
  type CloudCredentialStatus,
  DeviceAuthClient,
} from "../service/auth-bootstrap.js";
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
import { readUpdateStatusSnapshot } from "../updates/engine.js";

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

const HARNESS_DETAILS = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex CLI",
  omp: "Oh My Pi",
} as const;

type HarnessId = keyof typeof HARNESS_DETAILS;
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
    status: "active" | "stopped" | "not_installed";
    pid: number | null;
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
    available: boolean;
    channel: string | null;
    currentVersion: string | null;
    targetVersion: string | null;
    pendingVersion: string | null;
    lastCheckAt: string | null;
    lastResult: string | null;
    hasError: boolean;
    errorCode: "update_state_unreadable" | null;
    lastRollback: {
      fromVersion: string;
      toVersion: string;
      rolledBackAt: string;
    } | null;
    quarantinedVersions: string[];
  };
  harnessHealth: {
    available: boolean;
    checkedAt: string | null;
    success: boolean | null;
    hasDrift: boolean | null;
    autoRepair: boolean | null;
  };
  harnesses: Array<{
    id: HarnessId;
    name: string;
    installed: boolean;
    configured: boolean;
    mcpAttached: boolean;
    status: "attached" | "unconfigured" | "not_installed" | "drift" | "error";
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
    activeCustomToolsCount: number;
  };
  remediations: StatusRemediation[];
  notifications?: ActionableNotification[];
}

export interface StatusCommandFlags {
  json?: boolean;
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

Shows a versioned, privacy-safe view of the local Resin workspace, daemon,
cloud identity, privacy posture, harnesses, recovery state, and updates.
Degraded and offline states are reported successfully with contextual hints.

Options:
  --json           Output schema-versioned JSON.
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
  const home = options.home ?? options.customHome ?? options.env?.HOME ?? os.homedir();
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
      status: active ? "active" : installed ? "stopped" : "not_installed",
      pid: safePositiveInteger(rawStatus.pid),
    };
  } catch {
    // Status is deliberately fail-safe; service defaults remain explicit.
  }

  const socketPath = options.socket ?? options.socketPath ?? daemonPaths.socketPath;
  const socketPresent = await safeExists(fsBridge, socketPath);
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
    expiresAt,
    expired,
  } satisfies DaemonStatusSummary["account"];

  const workspace = await resolveWorkspaceStatus(
    options.cwd ?? process.cwd(),
    fsBridge,
    workspaceIdFromCredentials,
  );

  const harnessSnapshot = await readHarnessSnapshot(fsBridge, resinHome);
  const harnesses = await collectHarnessStatuses(
    home,
    fsBridge,
    harnessSnapshot,
    env,
    options.entryPath,
  );
  const recovery = await readRecoveryStatus(fsBridge, resinHome);
  const update = await readUpdateStatus(fsBridge, resinHome);
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
    },
    harnesses,
    safetyGate,
    tools: {
      metaToolsCount: SYSTEM_META_TOOL_NAMES.length,
      metaTools: [...SYSTEM_META_TOOL_NAMES],
      activeCustomToolsCount: 0,
    },
    remediations,
    notifications: reportedNotifications,
  };
}

export function formatStatusForTerminal(summary: DaemonStatusSummary): string {
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
  lines.push(
    `  State:      ${service.active ? "RUNNING (active)" : service.installed ? "STOPPED (inactive)" : "NOT INSTALLED"}`,
  );
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
    if (summary.update.lastResult) lines.push(`  Last check: ${summary.update.lastResult}`);
    if (summary.update.errorCode) {
      lines.push(`  State:      ERROR (${summary.update.errorCode})`);
    }
  }

  if (summary.safetyGate) {
    lines.push("\n[Production Safety Gate]");
    lines.push(
      `  Status:     ${summary.safetyGate.isOpen ? (summary.safetyGate.unsafeOverrideActive ? "OVERRIDE (unsafe dev mode)" : "PASS (open)") : "BLOCKED (fail-closed)"}`,
    );
  }

  lines.push("\n[Tools & MCP Catalog]");
  lines.push(`  System Tools:   ${summary.tools.metaToolsCount}`);
  lines.push(`  Custom Tools:   ${summary.tools.activeCustomToolsCount}`);

  lines.push("\n[Harness Integrations]");
  lines.push("  [Agent Harness Connections]");
  for (const harness of summary.harnesses) {
    const installed = harness.installed ? "Installed" : "Not Installed";
    const attached = harness.configured ? "Configured (MCP Attached)" : "Not Configured";
    lines.push(`  - ${harness.name.padEnd(16)} [${installed}] - ${attached}`);
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
    : path.resolve(options.env?.HOME ?? os.homedir());
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
      flags.json ? `${JSON.stringify(output, null, 2)}\n` : formatStatusForTerminal(output),
    );
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
  entryPath?: string,
): Promise<DaemonStatusSummary["harnesses"]> {
  const claudePath = resolveHarnessConfigPath("claude-code", home, env);
  const codexPath = resolveHarnessConfigPath("codex-cli", home, env);
  const ompPath = resolveHarnessConfigPath("omp", home, env);
  const resinCommand =
    resolveLocalSourceResinCommand(env, entryPath) ?? resolveInstalledResinMcpCommand(home);
  const [claudeProbe, codexProbe, ompProbe] = await Promise.all([
    probeClaudeInstallation({ customConfigPath: claudePath }, fsBridge).catch(() => null),
    probeCodexInstallation({
      customConfigPath: codexPath,
      env: { ...env, HOME: home },
    }).catch(() => null),
    probeOmpInstallation({
      customConfigPath: ompPath,
      env,
      homeDir: home,
    }).catch(() => null),
  ]);
  const [claudeConfigured, codexConfigured, ompConfigured] = await Promise.all([
    verifyLiveHarnessConfig(fsBridge, claudePath, () =>
      verifyHarnessRegistration({
        harnessId: "claude-code",
        targetPath: claudePath,
        workspacePath: home,
        gatewayUrl: DEFAULT_GATEWAY_URL,
        command: resinCommand,
        fsBridge,
      }),
    ),
    verifyLiveHarnessConfig(fsBridge, codexPath, () =>
      verifyHarnessRegistration({
        harnessId: "codex-cli",
        targetPath: codexPath,
        workspacePath: home,
        gatewayUrl: DEFAULT_GATEWAY_URL,
        command: resinCommand,
        fsBridge,
      }),
    ),
    verifyLiveHarnessConfig(fsBridge, ompPath, () =>
      verifyHarnessRegistration({
        harnessId: "omp",
        targetPath: ompPath,
        workspacePath: home,
        gatewayUrl: DEFAULT_GATEWAY_URL,
        command: resinCommand,
        fsBridge,
      }),
    ),
  ]);

  const live = {
    "claude-code": {
      installed: claudeProbe === null ? null : Boolean(claudeProbe.isInstalled),
      configured: claudeConfigured,
    },
    "codex-cli": {
      installed: codexProbe === null ? null : Boolean(codexProbe.isInstalled),
      configured: codexConfigured,
    },
    omp: {
      installed: ompProbe === null ? null : Boolean(ompProbe.isInstalled),
      configured: ompConfigured,
    },
  } satisfies Record<HarnessId, { installed: boolean | null; configured: boolean | null }>;

  // SAFETY: Known harness keys match HarnessId union.
  return (Object.keys(HARNESS_DETAILS) as HarnessId[]).map((id) => {
    const cachedHarness = cached.harnesses[id];
    const installed = live[id].installed ?? cachedHarness?.installed ?? false;
    const liveConfigured = live[id].configured;
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
      name: HARNESS_DETAILS[id],
      installed,
      configured,
      mcpAttached: configured,
      status: error
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
  });
}

async function readUpdateStatus(
  fsBridge: ConfigFsBridge,
  resinHome: string,
): Promise<DaemonStatusSummary["update"]> {
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
): DaemonStatusSummary["update"] {
  return {
    available: false,
    channel: null,
    currentVersion: null,
    targetVersion: null,
    pendingVersion: null,
    lastCheckAt: null,
    lastResult: null,
    hasError: errorCode !== null,
    errorCode,
    lastRollback: null,
    quarantinedVersions: [],
  };
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
  if (!service.active || !ipcConnected || lockfileState !== "healthy") return "degraded";
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
  if (!input.service.installed) {
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
  // SAFETY: String key membership in HARNESS_DETAILS maps to HarnessId.
  return String(value) === value && value in HARNESS_DETAILS ? (value as HarnessId) : null;
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
  return summary.service.active && summary.ipc.connected ? "healthy" : "degraded";
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
