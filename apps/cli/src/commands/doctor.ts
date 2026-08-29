import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { SafetyAttestationRecord } from "@resin/contracts";
import {
  AttestationVerifier,
  type LocalSafetyCertificationOptions,
  SafetyGateEvaluator,
  certifyLocalRuntime,
} from "@resin/runtime";
const SYSTEM_META_TOOL_NAMES = [
  "search_tools",
  "get_tool_schema",
  "invoke_tool",
  "manage_tools",
] as const;
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { IpcClient, resolvePaths } from "@resin/observer";
import type { ActionableNotification } from "@resin/protocol";
import {
  HarnessHealthCoordinator,
  type HarnessHealthRunOptions,
  type HarnessHealthRunResult,
  type HarnessHealthRunner,
  type HarnessHealthSettingsDiagnostic,
  saveHarnessHealthSettings,
} from "../installer/harness-health.js";
import { detectPlatform, validatePlatform } from "../installer/platform.js";
import { DeviceAuthClient } from "../service/auth-bootstrap.js";
import { type UserServiceManager, createUserServiceManager } from "../service/manager.js";
import {
  type NotificationConsumer,
  consumeCliActionableNotifications,
  deriveDoctorActionableNotifications,
  formatActionableNotificationsForTerminal,
} from "../service/notifications.js";
import {
  type VerificationCheckResult,
  type VerificationReport,
  runVerificationSuite,
} from "../service/verification.js";

export interface DoctorCommandFlags {
  fix?: boolean;
  json?: boolean;
  strict?: boolean;
  autoRepair?: boolean;
  home?: string;
  help?: boolean;
}

export interface DoctorDiagnosticItem {
  id: string;
  name: string;
  category:
    | "platform"
    | "filesystem"
    | "service"
    | "ipc"
    | "database"
    | "gateway"
    | "harness"
    | "auth"
    | "runtime"
    | "security";
  status: "pass" | "warn" | "fail";
  message: string;
  remediation?: string;
  fixable: boolean;
  fixed?: boolean;
}
export interface DoctorReport {
  passed: boolean;
  healthy: boolean;
  totalChecks: number;
  passedCount: number;
  warnCount: number;
  failCount: number;
  fixedCount: number;
  items: DoctorDiagnosticItem[];
  actionsTaken: string[];
  notifications?: ActionableNotification[];
  timestamp: string;
}

export function parseDoctorFlags(args: string[]): DoctorCommandFlags {
  const flags: DoctorCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fix") {
      flags.fix = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--strict") {
      flags.strict = true;
    } else if (arg === "--auto-repair") {
      flags.autoRepair = true;
    } else if (arg === "--no-auto-repair") {
      flags.autoRepair = false;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    }
  }
  return flags;
}

export function printDoctorHelp(isRepair = false): void {
  const cmd = isRepair ? "repair" : "doctor";
  const text = `
Usage:
  resin ${cmd} [options]

${isRepair ? "Automatically detects and remediates issues with Resin state, services, and harness configurations." : "Runs exhaustive diagnostics across Resin platform, filesystem, background service, IPC, database, gateway, agent harnesses, and authentication."}

Options:
  --fix            Automatically repair detected fixable issues.
  --strict         Fail with non-zero exit code on any warnings as well as errors.
  --auto-repair    Enable automatic harness repair for future startup/hourly checks.
  --no-auto-repair Persistently disable automatic harness repair (detection remains enabled).
  --json           Output diagnostic report in structured JSON format.
  --home <path>    Custom Resin home directory (overrides ~/.resin).
  -h, --help       Show this help message.
`;
  process.stdout.write(text.trimStart());
}

async function runHarnessHealthSafely(
  runner: HarnessHealthRunner,
  options: HarnessHealthRunOptions,
): Promise<HarnessHealthRunResult> {
  try {
    return await runner.run(options);
  } catch {
    return { status: "failed", snapshot: null };
  }
}

function createHarnessSettingsDiagnostic(
  diagnostic: HarnessHealthSettingsDiagnostic,
): DoctorDiagnosticItem {
  let message: string;
  let remediation: string;
  switch (diagnostic) {
    case "settings_invalid":
      message = "Harness auto-repair policy failed closed because its settings file is invalid.";
      remediation =
        "Run `resin doctor --auto-repair` or `resin doctor --no-auto-repair` to replace the invalid regular settings file.";
      break;
    case "settings_unreadable":
      message =
        "Harness auto-repair policy failed closed because its settings file cannot be read.";
      remediation =
        "Restore owner read/write access to the harness health settings file, then run `resin doctor --auto-repair` or `resin doctor --no-auto-repair`.";
      break;
    case "settings_unsafe":
      message =
        "Harness auto-repair policy failed closed because its settings path is linked or is not a regular file.";
      remediation =
        "Remove the link or non-regular harness health settings entry, then run `resin doctor --auto-repair` or `resin doctor --no-auto-repair` to create a regular settings file.";
      break;
  }

  return {
    id: "harness_health_settings",
    name: "Harness Auto-Repair Policy",
    category: "harness",
    status: "warn",
    message,
    remediation,
    fixable: false,
  };
}

function createHarnessDiagnostics(result: HarnessHealthRunResult): DoctorDiagnosticItem[] {
  const settingsDiagnostics =
    result.snapshot?.settingsDiagnostic === undefined
      ? []
      : [createHarnessSettingsDiagnostic(result.snapshot.settingsDiagnostic)];

  if (
    result.status === "failed" ||
    result.snapshot === null ||
    result.snapshot.lastFailure?.code === "check_failed"
  ) {
    return [
      ...settingsDiagnostics,
      {
        id: "harness_health",
        name: "Harness MCP Integration",
        category: "harness",
        status: "warn",
        message: "Harness health could not be checked; other doctor checks continued.",
        remediation: "Run `resin doctor` again after verifying Resin state is writable.",
        fixable: false,
      },
    ];
  }

  const harnessDiagnostics = result.snapshot.harnesses
    .filter((snapshot) => snapshot.installed)
    .map((snapshot) => {
      const recentlyReconciled =
        snapshot.changed &&
        snapshot.recentAction?.kind === "reconciled" &&
        snapshot.recentAction.at === snapshot.checkedAt;
      const repairFailed =
        snapshot.recentAction?.kind === "repair_failed" &&
        snapshot.recentAction.at === snapshot.checkedAt;
      const healthy =
        snapshot.configured &&
        (snapshot.condition === "healthy" || snapshot.status === "reconciled");
      const status: DoctorDiagnosticItem["status"] = healthy
        ? "pass"
        : repairFailed || snapshot.condition === "corrupt"
          ? "fail"
          : "warn";

      let message: string;
      if (healthy && recentlyReconciled) {
        message = `${snapshot.displayName} Resin MCP registration was safely reconciled.`;
      } else if (healthy) {
        message = `${snapshot.displayName} Resin MCP registration is healthy.`;
      } else if (snapshot.condition === "missing") {
        message = `${snapshot.displayName} Resin MCP registration is missing.`;
      } else if (snapshot.condition === "corrupt") {
        message = `${snapshot.displayName} MCP configuration is invalid.`;
      } else {
        message = `${snapshot.displayName} Resin MCP registration has drifted.`;
      }

      return {
        id: `harness_${snapshot.harnessId}`,
        name: `Harness MCP Integration (${snapshot.displayName})`,
        category: "harness" as const,
        status,
        message,
        ...(!healthy
          ? {
              remediation: "Run `resin repair` to safely reconcile only the Resin-owned MCP entry.",
            }
          : {}),
        fixable: !healthy,
        ...(recentlyReconciled ? { fixed: true } : {}),
      };
    });
  return [...settingsDiagnostics, ...harnessDiagnostics];
}

export async function runDiagnostics(options: {
  home?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
  harnessHealthCoordinator?: HarnessHealthRunner;
  serviceManager?: UserServiceManager;
  forceHarnessHealthCheck?: boolean;
}): Promise<DoctorDiagnosticItem[]> {
  const customHome = options.home ? path.resolve(options.home) : os.homedir();
  const resinHome = path.join(customHome, ".resin");
  const daemonPaths = resolvePaths({ home: customHome });
  const fsBridge = options.fsBridge ?? defaultFsBridge;

  const items: DoctorDiagnosticItem[] = [];

  // 1. Platform Check
  try {
    const platformInfo = detectPlatform();
    validatePlatform(platformInfo);
    items.push({
      id: "platform_supported",
      name: "Supported Operating System & Node Runtime",
      category: "platform",
      status: "pass",
      message: `${platformInfo.os} (${platformInfo.arch}) on Node ${platformInfo.nodeVersion}`,
      fixable: false,
    });
  } catch (err: unknown) {
    items.push({
      id: "platform_supported",
      name: "Supported Operating System & Node Runtime",
      category: "platform",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
      remediation: "Install Node.js >= 22 on Linux, macOS, or WSL2.",
      fixable: false,
    });
  }

  // 2. Filesystem & Directory Tree
  const requiredDirs = [
    resinHome,
    daemonPaths.configDir,
    daemonPaths.dataDir,
    daemonPaths.logDir,
    daemonPaths.stateDir,
    path.join(resinHome, "bin"),
  ];

  let missingDirsCount = 0;
  for (const dir of requiredDirs) {
    const exists = await fsBridge.exists(dir);
    if (!exists) {
      missingDirsCount++;
    }
  }

  if (missingDirsCount === 0) {
    items.push({
      id: "fs_directories",
      name: "Resin Home & State Directories",
      category: "filesystem",
      status: "pass",
      message: `All state directories exist in ${resinHome}`,
      fixable: true,
    });
  } else {
    items.push({
      id: "fs_directories",
      name: "Resin Home & State Directories",
      category: "filesystem",
      status: "fail",
      message: `${missingDirsCount} required directories missing under ${resinHome}`,
      remediation: "Run `resin repair` to create required directory tree.",
      fixable: true,
    });
  }

  // 3. User Autostart Service
  const serviceManager =
    options.serviceManager ??
    createUserServiceManager({
      homeDir: customHome,
      resinHome,
      fsBridge,
    });

  const svcStatus = await serviceManager.status();
  if (!svcStatus.installed) {
    items.push({
      id: "service_installed",
      name: "Background User Autostart Service",
      category: "service",
      status: "warn",
      message: `Autostart service not installed for ${serviceManager.platform}`,
      remediation: "Run `resin repair` to install the user background service.",
      fixable: true,
    });
  } else if (!svcStatus.active) {
    items.push({
      id: "service_installed",
      name: "Background User Autostart Service",
      category: "service",
      status: "warn",
      message: `Service unit ${svcStatus.serviceName} is installed but inactive`,
      remediation: "Run `resin repair` to start the daemon service.",
      fixable: true,
    });
  } else {
    items.push({
      id: "service_installed",
      name: "Background User Autostart Service",
      category: "service",
      status: "pass",
      message: `Service ${svcStatus.serviceName} is active (PID: ${svcStatus.pid ?? "running"})`,
      fixable: true,
    });
  }

  // 4. Stale Lockfile Detection
  const lockExists = await fsBridge.exists(daemonPaths.lockFilePath);
  if (lockExists && !svcStatus.active) {
    items.push({
      id: "stale_lockfile",
      name: "Daemon Single-Instance Lockfile",
      category: "ipc",
      status: "warn",
      message: `Lockfile exists at ${daemonPaths.lockFilePath} but daemon process is not running`,
      remediation: "Run `resin repair` to clean stale lockfiles.",
      fixable: true,
    });
  }

  // 5. IPC Ping
  const socketExists = await fsBridge.exists(daemonPaths.socketPath);
  if (socketExists) {
    const ipcClient = new IpcClient({ socketPath: daemonPaths.socketPath, timeoutMs: 2000 });
    try {
      await ipcClient.connect();
      const ping = await ipcClient.ping();
      await ipcClient.close();
      items.push({
        id: "ipc_ping",
        name: "Daemon IPC Socket Responsiveness",
        category: "ipc",
        status: ping.pong ? "pass" : "fail",
        message: `Daemon responded to IPC ping (nonce: ${ping.nonce ?? "none"})`,
        fixable: false,
      });
    } catch (err: unknown) {
      items.push({
        id: "ipc_ping",
        name: "Daemon IPC Socket Responsiveness",
        category: "ipc",
        status: "warn",
        message: `Socket exists but IPC ping failed: ${err instanceof Error ? err.message : String(err)}`,
        remediation: "Restart the daemon service via `resin repair`.",
        fixable: true,
      });
    }
  } else {
    items.push({
      id: "ipc_ping",
      name: "Daemon IPC Socket Responsiveness",
      category: "ipc",
      status: svcStatus.active ? "fail" : "warn",
      message: `IPC socket does not exist at ${daemonPaths.socketPath}`,
      remediation: "Start the daemon service via `resin repair`.",
      fixable: true,
    });
  }

  // 6. State Database
  const dbPath = path.join(daemonPaths.dataDir, "state.db");
  const dbExists = await fsBridge.exists(dbPath);
  items.push({
    id: "db_state",
    name: "SQLite State Database",
    category: "database",
    status: dbExists ? "pass" : "warn",
    message: dbExists
      ? "SQLite state database exists and is accessible."
      : "State database not yet created (will initialize on first daemon run).",
    fixable: false,
  });

  // 7. Harness Configurations
  const harnessHealthCoordinator =
    options.harnessHealthCoordinator ??
    new HarnessHealthCoordinator({
      home: customHome,
      fsBridge,
      autoRepair: false,
    });
  const harnessHealth = await runHarnessHealthSafely(harnessHealthCoordinator, {
    trigger: "doctor",
    force: options.forceHarnessHealthCheck ?? true,
    autoRepair: false,
  });
  items.push(...createHarnessDiagnostics(harnessHealth));
  const authClient = new DeviceAuthClient({
    home: customHome,
    customFetch: options.customFetch,
  });
  const loadResult = await authClient.loadCredentialResult();
  if (loadResult.status === "valid" && loadResult.credentials) {
    items.push({
      id: "cloud_auth",
      name: "Cloud Authentication Credentials",
      category: "auth",
      status: "pass",
      message: `Authenticated for workspace ${loadResult.credentials.workspaceId}`,
      fixable: false,
    });
  } else if (loadResult.status === "expired" && loadResult.credentials) {
    items.push({
      id: "cloud_auth",
      name: "Cloud Authentication Credentials",
      category: "auth",
      status: "warn",
      message: `Cloud credentials expired for workspace ${loadResult.credentials.workspaceId} (expired at ${loadResult.credentials.claims.expiresAt})`,
      remediation: "Run `resin login` or `resin init` to refresh your session.",
      fixable: false,
    });
  } else if (loadResult.status === "offline" && loadResult.credentials) {
    items.push({
      id: "cloud_auth",
      name: "Cloud Authentication Credentials",
      category: "auth",
      status: "warn",
      message: `Offline mode with cached credentials for workspace ${loadResult.credentials.workspaceId}`,
      fixable: false,
    });
  } else if (loadResult.status === "revoked") {
    items.push({
      id: "cloud_auth",
      name: "Cloud Authentication Credentials",
      category: "auth",
      status: "fail",
      message: `Cloud credentials revoked: ${loadResult.reason ?? "Token was revoked remotely"}`,
      remediation: "Run `resin login` or `resin init` to authenticate with a new session.",
      fixable: false,
    });
  } else if (loadResult.status === "invalid") {
    items.push({
      id: "cloud_auth",
      name: "Cloud Authentication Credentials",
      category: "auth",
      status: "fail",
      message: `Invalid cloud credentials: ${loadResult.reason ?? "Malformed credential payload"}`,
      remediation:
        "Run `resin logout` and `resin login` to clear corrupt credentials and re-authenticate.",
      fixable: false,
    });
  } else {
    items.push({
      id: "cloud_auth",
      name: "Cloud Authentication Credentials",
      category: "auth",
      status: "warn",
      message: "No cloud credentials found (running in local offline mode)",
      remediation: "Run `resin init` to connect to Resin Cloud.",
      fixable: false,
    });
  }

  // 6. Safety Gate Attestation Check
  let attestationRecord: SafetyAttestationRecord | null = null;
  const attestationPaths = [
    path.join(customHome, ".resin", "safety-attestation.json"),
    path.join(daemonPaths.configDir, "safety-attestation.json"),
  ];
  for (const attPath of attestationPaths) {
    const raw = await fsBridge.readFile(attPath);
    if (raw) {
      try {
        attestationRecord = JSON.parse(raw);
        break;
      } catch {
        // Corrupted JSON - will be handled by evaluator
      }
    }
  }

  const publicKeyPath = path.join(resinHome, "state", "safety-attestation.pub.pem");
  const publicKeyPem = await fsBridge.readFile(publicKeyPath);
  const trustedKeys = new Map<string, string>();
  const keyId = attestationRecord?.signature?.keyId;
  if (publicKeyPem && keyId) trustedKeys.set(keyId, publicKeyPem);
  const safetyEvaluator = new SafetyGateEvaluator({
    attestation: attestationRecord,
    verifier: new AttestationVerifier({
      trustedPublicKeys: trustedKeys,
      allowUnsignedTestAttestations: Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID),
    }),
  });
  const gateStatus = safetyEvaluator.getStatus();

  if (gateStatus.isOpen && gateStatus.status === "passed") {
    items.push({
      id: "safety_gate",
      name: "Production Readiness Safety Gate",
      category: "security",
      status: "pass",
      message: "Production safety attestation verified and valid",
      fixable: true,
    });
  } else if (gateStatus.status === "unsafe_override") {
    items.push({
      id: "safety_gate",
      name: "Production Readiness Safety Gate",
      category: "security",
      status: "warn",
      message: "Unsafe development override active (RESIN_UNSAFE_ALLOW_AUTONOMOUS)",
      remediation: "Disable unsafe override in production environments.",
      fixable: true,
    });
  } else {
    items.push({
      id: "safety_gate",
      name: "Production Readiness Safety Gate",
      category: "security",
      status: "fail",
      message: gateStatus.reasons.join("; "),
      remediation:
        gateStatus.unmetRequirements[0]?.remediation ??
        "Run `resin repair` to generate a valid local attestation.",
      fixable: true,
    });
  }
  return items;
}

export async function repairState(options: {
  home?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
  safetyCertification?: LocalSafetyCertificationOptions;
  harnessHealthCoordinator?: HarnessHealthRunner;
  serviceManager?: UserServiceManager;
}): Promise<string[]> {
  const customHome = options.home ? path.resolve(options.home) : os.homedir();
  const resinHome = path.join(customHome, ".resin");
  const daemonPaths = resolvePaths({ home: customHome });
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const actions: string[] = [];

  // 1. Ensure all directories exist
  const requiredDirs = [
    resinHome,
    daemonPaths.configDir,
    daemonPaths.dataDir,
    daemonPaths.logDir,
    daemonPaths.stateDir,
    path.join(resinHome, "bin"),
    path.join(resinHome, "run"),
    path.join(resinHome, "vault"),
  ];

  for (const dir of requiredDirs) {
    if (!(await fsBridge.exists(dir))) {
      await fsBridge.mkdirp(dir);
      actions.push(`Created directory: ${dir}`);
    }
  }

  // 2. Clean stale lockfile if daemon not active
  const serviceManager =
    options.serviceManager ??
    createUserServiceManager({
      homeDir: customHome,
      resinHome,
      fsBridge,
    });
  const svcStatus = await serviceManager.status();

  if (!svcStatus.active && (await fsBridge.exists(daemonPaths.lockFilePath))) {
    await fsBridge.unlink(daemonPaths.lockFilePath);
    actions.push(`Removed stale lockfile: ${daemonPaths.lockFilePath}`);
  }

  // 3. Install / repair background service unit
  if (!svcStatus.installed) {
    const installResult = await serviceManager.install({
      homeDir: customHome,
      resinHome,
      autoStart: true,
    });
    if (installResult.success) {
      actions.push(
        `Installed user background service (${serviceManager.platform}): ${installResult.serviceName}`,
      );
    }
  } else if (!svcStatus.active) {
    try {
      await serviceManager.start();
      actions.push(`Started user background service: ${svcStatus.serviceName}`);
    } catch {
      // Ignored if unable to start immediately in test environment
    }
  }

  // 4. Safely reconcile detected harnesses through the shared noninteractive engine.
  const harnessHealthCoordinator =
    options.harnessHealthCoordinator ??
    new HarnessHealthCoordinator({
      home: customHome,
      fsBridge,
      autoRepair: true,
    });
  const harnessHealth = await runHarnessHealthSafely(harnessHealthCoordinator, {
    trigger: "repair",
    force: true,
    autoRepair: true,
  });
  if (harnessHealth.status === "checked" && harnessHealth.snapshot !== null) {
    for (const snapshot of harnessHealth.snapshot.harnesses) {
      if (
        snapshot.changed &&
        snapshot.recentAction?.kind === "reconciled" &&
        snapshot.recentAction.at === snapshot.checkedAt
      ) {
        actions.push(`Reconciled Resin MCP registration for ${snapshot.displayName}`);
      }
    }
  }

  // 5. Execute evidence-backed local Runtime certification.
  const targetAttPath = path.join(resinHome, "safety-attestation.json");
  const privateKeyPath = path.join(resinHome, "state", "safety-attestation.key.pem");
  const publicKeyPath = path.join(resinHome, "state", "safety-attestation.pub.pem");
  const existingPrivateKey = await fsBridge.readFile(privateKeyPath);
  const existingPublicKey = await fsBridge.readFile(publicKeyPath);
  const certification = certifyLocalRuntime({
    environment: "production",
    privateKeyPem: existingPrivateKey ?? undefined,
    publicKeyPem: existingPublicKey ?? undefined,
    ...options.safetyCertification,
  });
  await fsBridge.writeFile(privateKeyPath, certification.privateKeyPem);
  await fsBridge.writeFile(publicKeyPath, certification.publicKeyPem);
  await fsBridge.writeFile(targetAttPath, JSON.stringify(certification.attestation, null, 2));
  actions.push(`Certified and wrote production safety attestation: ${targetAttPath}`);

  return actions;
}

export function formatDoctorForTerminal(report: DoctorReport): string {
  const notificationHeader = formatActionableNotificationsForTerminal(report.notifications ?? []);
  const lines: string[] = [];

  lines.push("┌────────────────────────────────────────────────────────┐");
  lines.push("│               RESIN DOCTOR REPORT               │");
  lines.push("└────────────────────────────────────────────────────────┘\n");

  for (const item of report.items) {
    let icon = "[✓]";
    if (item.status === "warn") icon = "[!]";
    if (item.status === "fail") icon = "[✗]";

    const fixedTag = item.fixed ? " (FIXED)" : "";
    lines.push(`${icon} ${item.name}${fixedTag}`);
    lines.push(`    ${item.message}`);
    if (item.remediation && item.status !== "pass" && !item.fixed) {
      lines.push(`    → Action: ${item.remediation}`);
    }
  }

  if (report.actionsTaken.length > 0) {
    lines.push("\n[Remediations Applied]");
    for (const act of report.actionsTaken) {
      lines.push(`  + ${act}`);
    }
  }

  lines.push("\n----------------------------------------------------------");
  lines.push(
    `Summary: ${report.passedCount} passed, ${report.warnCount} warnings, ${report.failCount} errors, ${report.fixedCount} fixed.`,
  );
  lines.push(
    `Overall Health: ${report.healthy ? "HEALTHY" : report.passed ? "FUNCTIONAL (with warnings)" : "DEGRADED"}`,
  );
  lines.push("----------------------------------------------------------\n");

  return `${notificationHeader}${lines.join("\n")}`;
}

export async function doctorCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
    isRepair?: boolean;
    safetyCertification?: LocalSafetyCertificationOptions;
    harnessHealthCoordinator?: HarnessHealthRunner;
    serviceManager?: UserServiceManager;
    now?: () => number;
    notificationConsumer?: NotificationConsumer;
  } = {},
): Promise<number> {
  const flags = parseDoctorFlags(args);
  const shouldFix = flags.fix || options.isRepair;

  if (flags.help) {
    printDoctorHelp(options.isRepair);
    return 0;
  }

  try {
    const customHome = flags.home ? path.resolve(flags.home) : os.homedir();
    const fsBridge = options.fsBridge ?? defaultFsBridge;
    const serviceManager =
      options.serviceManager ??
      createUserServiceManager({
        homeDir: customHome,
        resinHome: path.join(customHome, ".resin"),
        fsBridge,
      });
    const harnessHealthCoordinator =
      options.harnessHealthCoordinator ??
      new HarnessHealthCoordinator({
        home: customHome,
        fsBridge,
      });
    const actionsTaken: string[] = [];
    if (flags.autoRepair !== undefined) {
      await saveHarnessHealthSettings(flags.autoRepair, {
        home: customHome,
        fsBridge,
      });
      actionsTaken.push(
        flags.autoRepair
          ? "Enabled automatic harness repair for startup and hourly checks"
          : "Disabled automatic harness repair for startup and hourly checks",
      );
    }

    if (shouldFix) {
      actionsTaken.push(
        ...(await repairState({
          home: customHome,
          fsBridge,
          customFetch: options.customFetch,
          safetyCertification: options.safetyCertification,
          harnessHealthCoordinator,
          serviceManager,
        })),
      );
    }

    // Run diagnostics through the same coordinator used for repair.
    const items = await runDiagnostics({
      home: customHome,
      fsBridge,
      serviceManager,
      customFetch: options.customFetch,
      harnessHealthCoordinator,
      forceHarnessHealthCheck: !shouldFix,
    });

    const passedCount = items.filter((i) => i.status === "pass").length;
    const warnCount = items.filter((i) => i.status === "warn").length;
    const failCount = items.filter((i) => i.status === "fail").length;

    const now = options.now?.() ?? Date.now();
    const notificationSet = deriveDoctorActionableNotifications(items, now);
    const notifications = await consumeCliActionableNotifications(notificationSet.active, {
      home: customHome,
      // The observer owns resolution of these shared IDs; doctor only contributes evidence.
      managedIds: [],
      now,
      consume: options.notificationConsumer,
    });
    const report: DoctorReport = {
      passed: failCount === 0,
      healthy: failCount === 0 && warnCount === 0,
      totalChecks: items.length,
      passedCount,
      warnCount,
      failCount,
      fixedCount: actionsTaken.length,
      items,
      actionsTaken,
      timestamp: new Date(now).toISOString(),
      notifications,
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatDoctorForTerminal(report));
    }

    if (flags.strict && (failCount > 0 || warnCount > 0)) {
      return 1;
    }

    return failCount === 0 ? 0 : 1;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ error: msg, success: false }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nDoctor failed: ${msg}\n`);
    }
    return 1;
  }
}

export async function repairCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
    safetyCertification?: LocalSafetyCertificationOptions;
    harnessHealthCoordinator?: HarnessHealthRunner;
    serviceManager?: UserServiceManager;
    now?: () => number;
    notificationConsumer?: NotificationConsumer;
  } = {},
): Promise<number> {
  return doctorCommand(args, { ...options, isRepair: true });
}
