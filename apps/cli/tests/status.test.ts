import path from "node:path";
import process from "node:process";
import * as claudeAdapter from "@resin/adapter-claude-code";
import * as codexAdapter from "@resin/adapter-codex";
import * as ompAdapter from "@resin/adapter-omp";
import { type DaemonHealthReport, IpcClient } from "@resin/observer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/cli.js";
import * as statusCommands from "../src/commands/status.js";
import {
  STATUS_SCHEMA_VERSION,
  collectStatus,
  formatStatusForTerminal,
  statusCommand,
} from "../src/commands/status.js";
import * as serviceManagerModule from "../src/service/manager.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const runtime = vi.hoisted(() => ({
  service: {
    installed: true,
    active: true,
    enabled: true,
    serviceName: "resin.service",
    pid: 4242,
  },
  serviceError: false,
  // SAFETY: Typed union for test mock runtime state.
  ipcMode: "healthy" as "healthy" | "timeout" | "protocol_error",
  health: {
    status: "fully-ready",
    version: "1.2.3",
    uptimeSeconds: 3_661,
    modules: {
      workers: {
        status: "ready",
        details: { activeWorkers: 3 },
      },
    },
    telemetry: {
      deviceEnabled: true,
      cloudConsentEnabled: true,
      effectiveEnabled: true,
      captureActive: true,
      failClosed: false,
    },
  },
  installedHarnesses: {
    "claude-code": true,
    "codex-cli": true,
    omp: true,
  },
}));

vi.spyOn(serviceManagerModule, "createUserServiceManager").mockImplementation(() => ({
  platform: "systemd",
  getUnitPath: () => "/private/service/path",
  status: async () => {
    if (runtime.serviceError) throw new Error("private service failure");
    return { ...runtime.service };
  },
  install: async () => undefined,
  uninstall: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
  restart: async () => undefined,
  enable: async () => undefined,
  disable: async () => undefined,
  isActive: async () => runtime.service.active,
  isEnabled: async () => runtime.service.enabled,
  isInstalled: async () => runtime.service.installed,
}));

vi.spyOn(IpcClient.prototype, "connect").mockImplementation(async () => {
  if (runtime.ipcMode === "timeout") {
    throw Object.assign(new Error("timed out with IPC_ERROR_SECRET"), { code: "ETIMEDOUT" });
  }
});

vi.spyOn(IpcClient.prototype, "ping").mockImplementation(async () => ({
  pong: runtime.ipcMode !== "protocol_error",
  timestamp: Date.now(),
}));

vi.spyOn(IpcClient.prototype, "getHealth").mockImplementation(async () => {
  // SAFETY: Mock runtime health object conforms to DaemonHealthReport for test fixture.
  return runtime.health as DaemonHealthReport;
});

vi.spyOn(IpcClient.prototype, "close").mockImplementation(async () => {});

vi.spyOn(claudeAdapter, "probeClaudeInstallation").mockImplementation(async () => ({
  isInstalled: runtime.installedHarnesses["claude-code"],
}));

vi.spyOn(codexAdapter, "probeCodexInstallation").mockImplementation(async () => ({
  isInstalled: runtime.installedHarnesses["codex-cli"],
}));

vi.spyOn(ompAdapter, "probeOmpInstallation").mockImplementation(async () => ({
  isInstalled: runtime.installedHarnesses.omp,
}));

const NOW = 1_800_000_000_000;
const HOME = "/home/status-user";
const RESIN_HOME = path.join(HOME, ".resin");
const RESIN_COMMAND = path.join(RESIN_HOME, "bin", "resin");
const STATE_DIR = path.join(RESIN_HOME, "state");
const CONFIG_FILE = path.join(RESIN_HOME, "config", "config.json");
const SOCKET_FILE = path.join(STATE_DIR, "daemon.sock");
const LOCK_FILE = path.join(STATE_DIR, "daemon.lock");
const TOKEN_FILE = path.join(STATE_DIR, "device-token.json");
const ENV = { RESIN_HOME };
const PROFILE = {
  schemaVersion: "1.0.0",
  accountId: "acc_status_42",
  userId: "user_status_42",
  email: "member@example.com",
  membershipType: "pro",
};
const profileFetch = vi.fn<typeof fetch>();

afterEach(() => vi.unstubAllGlobals());

function createMockFsBridge(initialFiles: Record<string, string> = {}, failReads = false) {
  const files = new Map(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string) {
      if (failReads) throw new Error("unreadable path with FILE_ERROR_SECRET");
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, contents: string) {
      files.set(filePath, contents);
    },
    async exists(filePath: string) {
      if (failReads) throw new Error("unreadable path with FILE_ERROR_SECRET");
      return files.has(filePath);
    },
    async mkdirp() {},
    async copyFile(source: string, destination: string) {
      const contents = files.get(source);
      if (contents !== undefined) files.set(destination, contents);
    },
    async unlink(filePath: string) {
      files.delete(filePath);
    },
  };
}

function validCredentials(overrides: JsonObject = {}) {
  return {
    cloudUrl: "https://api.resin.sh",
    accessToken: "ACCESS_TOKEN_SECRET",
    refreshToken: "REFRESH_TOKEN_SECRET",
    deviceId: "dev_status_42",
    workspaceId: "ws_cloud_42",
    storedAt: "2027-01-01T00:00:00.000Z",
    claims: {
      accountId: "acc_status_42",
      workspaceId: "ws_cloud_42",
      deviceId: "dev_status_42",
      installationId: "inst_status_42",
      userId: "user_status_42",
      subject: "user_status_42",
      scopes: ["device:connect", "telemetry:write"],
      rawUploadConsent: true,
      issuedAt: "2027-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenType: "access",
    },
    ...overrides,
  };
}

function updateSnapshot(overrides: JsonObject = {}) {
  return {
    schemaVersion: 1,
    channel: "stable",
    currentVersion: "1.2.3",
    targetVersion: null,
    pendingVersion: null,
    lastCheckAt: "2027-01-02T00:00:00.000Z",
    lastResult: "already-current",
    lastError: null,
    lastRollback: null,
    quarantine: [],
    ...overrides,
  };
}

function recoverySnapshot(overrides: JsonObject = {}) {
  return {
    version: 1,
    status: "HEALTHY",
    restartCount: 0,
    crashTimestamps: [],
    ...overrides,
  };
}

function harnessSnapshot(overrides: JsonObject = {}) {
  return {
    format: "resin-harness-health/v1",
    checkedAt: "2027-01-03T00:00:00.000Z",
    trigger: "scheduled",
    autoRepair: true,
    success: true,
    hasDrift: false,
    configFiles: {},
    harnesses: [
      {
        harnessId: "claude-code",
        displayName: "Claude Code",
        installed: true,
        configured: true,
        status: "registered",
        condition: "healthy",
        changed: false,
        checkedAt: "2027-01-03T00:00:00.000Z",
      },
      {
        harnessId: "codex-cli",
        displayName: "Codex CLI",
        installed: true,
        configured: true,
        status: "registered",
        condition: "healthy",
        changed: false,
        checkedAt: "2027-01-03T00:00:00.000Z",
      },
      {
        harnessId: "omp",
        displayName: "Oh My Pi",
        installed: true,
        configured: true,
        status: "registered",
        condition: "healthy",
        changed: false,
        checkedAt: "2027-01-03T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function healthyFiles() {
  return {
    [CONFIG_FILE]: JSON.stringify({ telemetryEnabled: true, lockStaleThresholdMs: 15_000 }),
    [SOCKET_FILE]: "",
    [LOCK_FILE]: JSON.stringify({
      pid: 4242,
      startedAt: NOW - 60_000,
      lastHeartbeat: NOW - 1_000,
      version: "1.2.3",
      socketPath: SOCKET_FILE,
      metadata: { privateKey: "LOCK_METADATA_SECRET" },
    }),
    [TOKEN_FILE]: JSON.stringify(validCredentials()),
    [path.join(RESIN_HOME, "journal.json")]: JSON.stringify(updateSnapshot()),
    [path.join(STATE_DIR, "recovery-state.json")]: JSON.stringify(recoverySnapshot()),
    [path.join(STATE_DIR, "harness-health.json")]: JSON.stringify(harnessSnapshot()),
    [path.join(HOME, ".claude.json")]: JSON.stringify({
      mcpServers: { resin: { command: RESIN_COMMAND, args: ["mcp"] } },
    }),
    [path.join(HOME, ".codex", "config.toml")]:
      `[mcp_servers.resin]\ncommand = "${RESIN_COMMAND}"\nargs = ["mcp"]\n`,
    [path.join(HOME, ".omp", "agent", "mcp.json")]: JSON.stringify({
      mcpServers: { resin: { command: RESIN_COMMAND, args: ["mcp"] } },
    }),
    "/workspace/resin.json": JSON.stringify({
      workspaceId: "ws_project_99",
      name: "status-project",
    }),
  };
}

beforeEach(() => {
  profileFetch.mockReset().mockImplementation(async () => Response.json(PROFILE));
  vi.stubGlobal("fetch", profileFetch);
  runtime.service = {
    installed: true,
    active: true,
    enabled: true,
    serviceName: "resin.service",
    pid: 4242,
  };
  runtime.serviceError = false;
  runtime.ipcMode = "healthy";
  runtime.health = {
    status: "fully-ready",
    version: "1.2.3",
    uptimeSeconds: 3_661,
    modules: {
      workers: { status: "ready", details: { activeWorkers: 3 } },
    },
    telemetry: {
      deviceEnabled: true,
      cloudConsentEnabled: true,
      effectiveEnabled: true,
      captureActive: true,
      failClosed: false,
    },
  };
  runtime.installedHarnesses = {
    "claude-code": true,
    "codex-cli": true,
    omp: true,
  };
});

describe("unified status schema", () => {
  it.each([
    ["--verbose", "status"],
    ["status", "-v"],
  ])("renders detailed status through main(%j)", async (...args) => {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const realStatusCommand = statusCommand;
    const command = vi
      .spyOn(statusCommands, "statusCommand")
      .mockImplementation((commandArgs, options) =>
        realStatusCommand(commandArgs, {
          ...options,
          cwd: "/workspace/packages/app",
          env: ENV,
          now: () => NOW,
          fsBridge: createMockFsBridge(healthyFiles()),
          notificationConsumer: async (active) => active,
        }),
      );
    try {
      expect(await main([...args, "--home", HOME], { isInitialized: false, env: ENV })).toBe(0);
      expect(chunks.join("")).toContain("[Service & IPC]");
      expect(chunks.join("")).toContain("[Tools & MCP Catalog]");
      expect(chunks.join("")).toContain("/workspace/packages/app");
    } finally {
      command.mockRestore();
      stdout.mockRestore();
    }
  });

  it.each([
    { label: "compact by default", args: [], verbose: undefined, detailed: false },
    { label: "long flag", args: ["--verbose"], verbose: undefined, detailed: true },
    { label: "short flag", args: ["-v"], verbose: undefined, detailed: true },
    { label: "command option", args: [], verbose: true, detailed: true },
  ])("prints $label through statusCommand", async ({ args, verbose, detailed }) => {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await statusCommand([...args, "--home", HOME], {
        verbose,
        cwd: "/workspace/packages/app",
        env: ENV,
        now: () => NOW,
        fsBridge: createMockFsBridge(healthyFiles()),
        notificationConsumer: async (active) => active,
      });

      expect(exitCode).toBe(0);
      const output = chunks.join("");
      if (detailed) {
        expect(output).toContain("[Service & IPC]");
        expect(output).toContain("[Tools & MCP Catalog]");
        expect(output).toContain("ws_project_99");
        expect(output).toContain("/workspace/packages/app");
      } else {
        expect(output).toContain("Resin: Running");
        expect(output).toContain("Details: resin status --verbose");
        expect(output).not.toContain("[Service & IPC]");
        expect(output).not.toContain("ws_project_99");
      }
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps JSON identical when verbose flags and options are enabled", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(NOW);
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const options = {
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    };
    try {
      expect(await statusCommand(["--json", "--home", HOME], options)).toBe(0);
      const plainJson = chunks.join("");
      chunks.length = 0;
      expect(
        await statusCommand(["--json", "--verbose", "-v", "--home", HOME], {
          ...options,
          verbose: true,
        }),
      ).toBe(0);
      expect(chunks.join("")).toBe(plainJson);
      expect(JSON.parse(plainJson)).toMatchObject({
        schemaVersion: STATUS_SCHEMA_VERSION,
        status: "healthy",
        workspace: { workspaceId: "ws_project_99" },
        daemon: { ipcResponsive: true },
      });
    } finally {
      stdout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("collects a healthy workspace, daemon, identity, privacy, harness, recovery, and update snapshot", async () => {
    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });

    expect(summary.schemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(summary.generatedAt).toBe(new Date(NOW).toISOString());
    expect(summary.status).toBe("healthy");
    expect(summary.workspace).toEqual({
      activeDirectory: "/workspace/packages/app",
      workspaceId: "ws_project_99",
      projectConfigLoaded: true,
      rootDir: "/workspace",
    });
    expect(summary.daemon).toMatchObject({
      health: "healthy",
      ipcResponsive: true,
      activeWorkers: 3,
      lockfile: { state: "healthy", pid: 4242 },
    });
    expect(summary.account).toMatchObject({
      linked: true,
      accountId: "acc_status_42",
      emailOrUser: "user_status_42",
      expired: false,
    });
    expect(summary.account).toMatchObject({ email: PROFILE.email, membershipType: "pro" });
    expect(summary.privacy).toMatchObject({
      deviceMetadataTelemetryEnabled: true,
      cloudMetadataTelemetryEnabled: true,
      effectiveMetadataTelemetryEnabled: true,
      rawTranscriptUploadEnabled: true,
      rawTranscriptConsent: "opted_in",
    });
    expect(summary.telemetry).toEqual({
      enabled: true,
      rawTranscriptsAllowed: true,
      sink: "cloud",
    });
    expect(summary.recovery).toMatchObject({ available: true, status: "healthy" });
    expect(summary.update).toMatchObject({
      available: true,
      channel: "stable",
      currentVersion: "1.2.3",
      lastResult: "already-current",
      hasError: false,
      errorCode: null,
    });
    expect(summary.harnessHealth).toMatchObject({
      available: true,
      success: true,
      hasDrift: false,
    });
    expect(summary.harnesses.every((harness) => harness.status === "attached")).toBe(true);
    expect(summary.remediations).toEqual([]);
  });

  it("keeps healthy foreground status compact without hiding sharing or installed agents", async () => {
    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });
    summary.service = {
      ...summary.service,
      installed: false,
      active: false,
      status: "externally_managed",
    };
    summary.harnesses = summary.harnesses.map((harness) =>
      harness.id === "omp" ? { ...harness, installed: false } : harness,
    );
    summary.safetyGate = {
      isOpen: false,
      status: "uninitialized",
      unsafeOverrideActive: false,
      unmetRequirementCodes: [],
    };

    const output = formatStatusForTerminal(summary);

    expect(output).toContain("Resin: Running");
    expect(output).toMatch(/Daemon\s+Running \(foreground\)/);
    expect(output).toMatch(/Cloud\s+Signed in/i);
    expect(output).toMatch(/Email\s+member@example\.com/);
    expect(output).toMatch(/Membership\s+Pro/);
    expect(output).toMatch(/Agents\s+.*Claude Code.*Codex CLI/);
    expect(output).not.toContain("Oh My Pi");
    expect(output).toMatch(/Sharing\s+metadata on.*raw transcripts on/i);
    expect(output).toMatch(/Production\s+Not verified/i);
    expect(output).toContain("Details: resin status --verbose");
    expect(output.trim().split("\n").length).toBeLessThanOrEqual(12);
    for (const privateDetail of [
      "Schema:",
      "ws_project_99",
      "ws_cloud_42",
      "dev_status_42",
      "acc_status_42",
      "user_status_42",
      "/workspace",
      summary.generatedAt,
      "[Service & IPC]",
      "[Recovery]",
      "[Updates]",
      "[Production Safety Gate]",
      "[Tools & MCP Catalog]",
      "System Tools:",
      "Custom Tools:",
    ]) {
      expect(output).not.toContain(privateDetail);
    }
  });

  it.each([
    ["free", "Free"],
    ["pro", "Pro"],
    ["max", "Max"],
    ["founder", "Founder"],
  ])(
    "shows the caller's email and %s membership in each output format",
    async (membershipType, label) => {
      profileFetch.mockResolvedValue(Response.json({ ...PROFILE, membershipType }));
      const summary = await collectStatus({
        home: HOME,
        env: ENV,
        now: () => NOW,
        fsBridge: createMockFsBridge(healthyFiles()),
      });

      expect(summary.account).toMatchObject({ email: PROFILE.email, membershipType });
      for (const verbose of [false, true]) {
        const output = formatStatusForTerminal(summary, { verbose });
        expect(output).toContain(PROFILE.email);
        expect(output).toMatch(new RegExp(`Membership:?\\s+${label}`));
        expect(output).not.toContain("ACCESS_TOKEN_SECRET");
      }
      expect(JSON.parse(JSON.stringify(summary)).account).toMatchObject({
        email: PROFILE.email,
        membershipType,
      });
    },
  );

  it.each([401, 403, 404, 503])(
    "keeps local health and credentials intact when the profile returns %s",
    async (status) => {
      profileFetch.mockResolvedValue(Response.json({ error: "unavailable" }, { status }));
      const fsBridge = createMockFsBridge(healthyFiles());
      const credentialsBefore = fsBridge.files.get(TOKEN_FILE);
      const summary = await collectStatus({ home: HOME, env: ENV, now: () => NOW, fsBridge });

      expect(summary.status).toBe("healthy");
      expect(summary.account).toMatchObject({ status: "valid", email: null, membershipType: null });
      expect(formatStatusForTerminal(summary)).toMatch(/Email\s+Unavailable/);
      expect(formatStatusForTerminal(summary)).toMatch(/Membership\s+Unavailable/);
      expect(fsBridge.files.get(TOKEN_FILE)).toBe(credentialsBefore);
      expect(profileFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not fetch or invent account metadata for missing or expired credentials", async () => {
    const files = healthyFiles();
    const credentials = validCredentials();
    files[TOKEN_FILE] = JSON.stringify({
      ...credentials,
      claims: { ...credentials.claims, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    const expired = await collectStatus({
      home: HOME,
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });
    expect(expired.account).toMatchObject({ status: "expired", email: null, membershipType: null });
    const fsBridge = createMockFsBridge(healthyFiles());
    fsBridge.files.delete(TOKEN_FILE);
    const missing = await collectStatus({ home: HOME, env: ENV, now: () => NOW, fsBridge });
    expect(missing.account).toMatchObject({ linked: false, email: null, membershipType: null });
    expect(formatStatusForTerminal(missing)).not.toMatch(/Membership\s+Free/);
    expect(profileFetch).not.toHaveBeenCalled();
  });

  it.each(["failed", "unsafe_override"] as const)(
    "shows a %s safety gate even when daemon health is otherwise healthy",
    async (status) => {
      const summary = await collectStatus({
        home: HOME,
        cwd: "/workspace/packages/app",
        env: ENV,
        now: () => NOW,
        fsBridge: createMockFsBridge(healthyFiles()),
      });
      summary.safetyGate = {
        isOpen: status === "unsafe_override",
        status,
        unsafeOverrideActive: status === "unsafe_override",
        unmetRequirementCodes: [],
      };

      const output = formatStatusForTerminal(summary);

      expect(output).toContain("Resin: Needs attention");
      expect(output).toMatch(
        status === "failed" ? /Production\s+Blocked/i : /Production\s+Unsafe override/i,
      );
      expect(output).not.toContain("[Production Safety Gate]");
    },
  );

  it("distinguishes an offline cloud connection from a stopped local daemon", async () => {
    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });
    summary.account.status = "offline";
    summary.cloud.status = "offline";

    const output = formatStatusForTerminal(summary);

    expect(output).toContain("Resin: Needs attention");
    expect(output).toMatch(/Daemon\s+Running/);
    expect(output).toMatch(/Cloud\s+Offline.*local tools still available/i);
    expect(output).toMatch(/Agents\s+.*Claude Code/);
  });

  it("uses the active CODEX_HOME and does not accept a configured inactive default", async () => {
    const activeCodexHome = "/profiles/status-codex";
    const activeCodexPath = path.join(activeCodexHome, "config.toml");
    const files = healthyFiles();
    const env = { ...ENV, HOME, CODEX_HOME: activeCodexHome };

    const inactiveOnly = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });
    expect(inactiveOnly.harnesses.find((harness) => harness.id === "codex-cli")).toMatchObject({
      configured: false,
      status: "unconfigured",
    });

    const active = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env,
      now: () => NOW,
      fsBridge: createMockFsBridge({
        ...files,
        [activeCodexPath]: `[mcp_servers.resin]\ncommand = "${RESIN_COMMAND}"\nargs = ["mcp"]\n`,
      }),
    });
    expect(active.harnesses.find((harness) => harness.id === "codex-cli")).toMatchObject({
      configured: true,
      status: "attached",
    });
  });

  it("includes validated authoritative notifications from daemon health", async () => {
    const notification = {
      id: "daemon.background-failed",
      severity: "critical",
      source: "daemon",
      title: "Resin background service needs attention",
      remediationCommand: "resin doctor --fix",
      timestamp: new Date(NOW).toISOString(),
      cooldownMs: 14_400_000,
    };
    runtime.health = {
      ...runtime.health,
      notifications: [notification, { id: "invalid" }],
    };

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });

    expect(summary.notifications).toEqual([notification]);
    const output = formatStatusForTerminal(summary);
    expect(output).toContain(notification.title);
    expect(output).toContain(notification.remediationCommand);
    expect(output).toContain("Resin: Needs attention");
  });

  it("does not let a status snapshot resolve observer-managed notifications", async () => {
    const notification = {
      id: "daemon.background-failed",
      severity: "critical",
      source: "daemon",
      title: "Resin background service needs attention",
      remediationCommand: "resin doctor --fix",
      timestamp: new Date(NOW).toISOString(),
      cooldownMs: 14_400_000,
    };
    runtime.health = { ...runtime.health, notifications: [notification] };
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await statusCommand(["--json", "--home", HOME], {
        cwd: "/workspace/packages/app",
        env: ENV,
        now: () => NOW,
        fsBridge: createMockFsBridge(healthyFiles()),
        notificationConsumer: async (active, options) => {
          expect(options.managedIds).toEqual([]);
          return active;
        },
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(chunks.join("")).notifications).toEqual([notification]);
    } finally {
      stdout.mockRestore();
    }
  });

  it("honors the daemon's authoritative disabled telemetry state", async () => {
    runtime.health = {
      ...runtime.health,
      telemetry: {
        deviceEnabled: true,
        cloudConsentEnabled: true,
        effectiveEnabled: false,
        captureActive: false,
        failClosed: false,
      },
    };

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });

    expect(summary.status).toBe("healthy");
    expect(summary.privacy).toMatchObject({
      deviceMetadataTelemetryEnabled: true,
      cloudMetadataTelemetryEnabled: true,
      effectiveMetadataTelemetryEnabled: false,
    });
    expect(summary.telemetry).toEqual({
      enabled: false,
      rawTranscriptsAllowed: true,
      sink: "disabled",
    });
  });

  it("shows unknown metadata consent without claiming sharing is enabled", async () => {
    runtime.health = { ...runtime.health, telemetry: {} };
    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });

    expect(formatStatusForTerminal(summary)).toMatch(/Sharing\s+metadata unknown/i);
  });

  it("degrades enabled telemetry when required cloud consent is unknown", async () => {
    runtime.health = {
      ...runtime.health,
      telemetry: {
        deviceEnabled: true,
        captureActive: false,
        failClosed: false,
      },
    };

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(healthyFiles()),
    });

    expect(summary.status).toBe("degraded");
    expect(summary.privacy).toMatchObject({
      deviceMetadataTelemetryEnabled: true,
      cloudMetadataTelemetryEnabled: null,
      effectiveMetadataTelemetryEnabled: false,
    });
    expect(summary.telemetry).toEqual({
      enabled: false,
      rawTranscriptsAllowed: true,
      sink: "disabled",
    });
  });

  it("lets a successful live harness check override stale attached cache state", async () => {
    const files = healthyFiles();
    delete files[path.join(HOME, ".claude.json")];

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });

    expect(summary.harnesses.find((harness) => harness.id === "claude-code")).toMatchObject({
      configured: false,
      mcpAttached: false,
      status: "unconfigured",
    });
    expect(summary.status).toBe("degraded");
    expect(summary.remediations.map((item) => item.code)).toContain("repair_harnesses");
    const output = formatStatusForTerminal(summary);
    expect(output).toMatch(/Agents\s+.*Claude Code.*needs (setup|repair)/i);
    for (const remediation of summary.remediations) {
      expect(output).toContain(remediation.message);
      if (remediation.command) expect(output).toContain(remediation.command);
    }
  });

  it("lets authoritative live health clear stale cached harness drift", async () => {
    const files = healthyFiles();
    files[path.join(STATE_DIR, "harness-health.json")] = JSON.stringify(
      harnessSnapshot({
        success: false,
        hasDrift: true,
        harnesses: [
          {
            harnessId: "claude-code",
            displayName: "Claude Code",
            installed: true,
            configured: false,
            status: "drifted",
            condition: "drifted",
            changed: true,
            checkedAt: "2027-01-03T00:00:00.000Z",
            recentAction: { kind: "repair_failed", at: "2027-01-03T00:00:00.000Z" },
          },
        ],
      }),
    );

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });

    expect(summary.harnesses.find((harness) => harness.id === "claude-code")).toMatchObject({
      configured: true,
      mcpAttached: true,
      status: "attached",
      recentAction: null,
    });
  });

  it("does not treat the legacy OMP config as an active attachment", async () => {
    const files = healthyFiles();
    delete files[path.join(HOME, ".omp", "agent", "mcp.json")];
    files[path.join(HOME, ".omp", "config.json")] = JSON.stringify({
      mcpServers: { resin: { command: RESIN_COMMAND, args: ["mcp"] } },
    });

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });

    expect(summary.harnesses.find((harness) => harness.id === "omp")).toMatchObject({
      configured: false,
      mcpAttached: false,
      status: "unconfigured",
    });
  });

  it("uses cached harness attachment only when live verification is unavailable", async () => {
    const fsBridge = createMockFsBridge(healthyFiles());
    const exists = fsBridge.exists.bind(fsBridge);
    fsBridge.exists = async (filePath: string) => {
      if (filePath === path.join(HOME, ".claude.json")) {
        throw new Error("live harness verification unavailable");
      }
      return await exists(filePath);
    };

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge,
    });

    expect(summary.harnesses.find((harness) => harness.id === "claude-code")).toMatchObject({
      configured: true,
      mcpAttached: true,
      status: "attached",
    });
  });

  it("reports degraded IPC, expired auth, fail-closed privacy, recovery, updates, and harness hints", async () => {
    runtime.ipcMode = "timeout";
    runtime.health = {};
    const expired = validCredentials({
      claims: {
        // SAFETY: Spreading valid claims for test credential construction.
        ...validCredentials().claims,
        rawUploadConsent: false,
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    });
    const files = healthyFiles();
    files[CONFIG_FILE] = JSON.stringify({
      telemetryEnabled: false,
      authToken: "CONFIG_AUTH_TOKEN_SECRET",
      privateKey: "CONFIG_PRIVATE_KEY_SECRET",
    });
    files[LOCK_FILE] = JSON.stringify({
      pid: 4242,
      startedAt: NOW - 120_000,
      lastHeartbeat: NOW - 120_000,
    });
    files[TOKEN_FILE] = JSON.stringify(expired);
    files[path.join(RESIN_HOME, "journal.json")] = JSON.stringify(
      updateSnapshot({
        lastResult: "failed",
        lastError: "UPDATE_ERROR_SECRET at /private/update/path",
        quarantine: [
          {
            version: "1.2.4",
            channel: "stable",
            quarantinedAt: "2027-01-04T00:00:00.000Z",
            reason: "UPDATE_QUARANTINE_SECRET",
          },
        ],
      }),
    );
    files[path.join(STATE_DIR, "recovery-state.json")] = JSON.stringify(
      recoverySnapshot({
        status: "DEGRADED",
        restartCount: 2,
        crashTimestamps: [NOW - 5_000],
        lastFailure: {
          timestamp: NOW - 5_000,
          category: "AUTHENTICATION",
          remediation: "RECOVERY_REMEDIATION_SECRET",
        },
      }),
    );
    files[path.join(STATE_DIR, "harness-health.json")] = JSON.stringify(
      harnessSnapshot({
        success: false,
        hasDrift: true,
        harnesses: [
          {
            harnessId: "claude-code",
            displayName: "HARNESS_DISPLAY_SECRET",
            installed: true,
            configured: false,
            status: "drifted",
            condition: "drifted",
            changed: true,
            checkedAt: "2027-01-03T00:00:00.000Z",
            recentAction: { kind: "repair_failed", at: "2027-01-03T00:00:00.000Z" },
          },
        ],
      }),
    );
    delete files[path.join(HOME, ".claude.json")];
    delete files[path.join(HOME, ".codex", "config.toml")];
    delete files[path.join(HOME, ".omp", "agent", "mcp.json")];

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });
    const output = formatStatusForTerminal(summary);

    expect(summary.status).toBe("degraded");
    expect(summary.ipc).toMatchObject({ connected: false, errorCode: "timeout" });
    expect(summary.account).toMatchObject({ linked: true, expired: true, status: "expired" });
    expect(summary.daemon.lockfile.state).toBe("stale");
    expect(summary.privacy).toMatchObject({
      deviceMetadataTelemetryEnabled: false,
      effectiveMetadataTelemetryEnabled: false,
      rawTranscriptUploadEnabled: false,
    });
    expect(summary.recovery).toMatchObject({
      status: "degraded",
      restartCount: 2,
      recentCrashCount: 1,
    });
    expect(summary.update).toMatchObject({
      hasError: true,
      quarantinedVersions: ["1.2.4"],
    });
    expect(summary.remediations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "repair_ipc",
        "repair_lockfile",
        "refresh_login",
        "repair_harnesses",
        "inspect_recovery",
        "inspect_update",
      ]),
    );
    expect(output).toContain("Resin: Needs attention");
    expect(output).toMatch(/Cloud\s+.*expired/i);
    expect(output).toMatch(/Sharing\s+metadata off.*raw transcripts off/i);
    for (const remediation of summary.remediations) {
      expect(output).toContain(remediation.message);
      if (remediation.command) expect(output).toContain(remediation.command);
    }
    expect(output).toContain("Run: resin login");
    expect(output).toContain("Run: resin doctor --fix");
    expect(output).toMatch(/^[\x00-\x7f]*$/);
  });

  it("reports corrupt update state as a sanitized degraded error", async () => {
    const files = healthyFiles();
    files[path.join(RESIN_HOME, "journal.json")] = "{UPDATE_STATE_PRIVATE_DETAIL";

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });
    const terminal = formatStatusForTerminal(summary, { verbose: true });
    const json = JSON.stringify(summary);

    expect(summary.status).toBe("degraded");
    expect(summary.update).toMatchObject({
      available: false,
      lastResult: null,
      hasError: true,
      errorCode: "update_state_unreadable",
    });
    expect(summary.remediations.map((item) => item.code)).toContain("inspect_update");
    expect(terminal).toContain("State:      ERROR (update_state_unreadable)");
    expect(`${json}\n${terminal}`).not.toContain("UPDATE_STATE_PRIVATE_DETAIL");
  });

  it("returns exit zero for a stopped offline daemon while consuming persisted fallback state", async () => {
    runtime.service = {
      installed: true,
      active: false,
      enabled: true,
      serviceName: "resin.service",
      pid: undefined,
    };
    const files = healthyFiles();
    delete files[SOCKET_FILE];
    delete files[LOCK_FILE];
    delete files[TOKEN_FILE];
    files[path.join(RESIN_HOME, "journal.json")] = JSON.stringify(
      updateSnapshot({ lastResult: "offline" }),
    );
    const customFetch = vi.fn();
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await statusCommand(["--json", "--home", HOME], {
        cwd: "/workspace/packages/app",
        env: ENV,
        now: () => NOW,
        fsBridge: createMockFsBridge(files),
        // SAFETY: Vitest mock function implementing fetch interface.
        customFetch: customFetch as typeof fetch,
      });
      const result = JSON.parse(chunks.join(""));
      expect(exitCode).toBe(0);
      expect(result.schemaVersion).toBe(1);
      expect(result.status).toBe("stopped");
      expect(result.ipc).toMatchObject({
        connected: false,
        socketPresent: false,
        errorCode: "socket_missing",
      });
      expect(result.recovery).toMatchObject({ available: true, status: "healthy" });
      expect(result.harnessHealth.available).toBe(true);
      expect(result.update).toMatchObject({ available: true, lastResult: "offline" });
      expect(result.privacy).toMatchObject({
        deviceMetadataTelemetryEnabled: true,
        cloudMetadataTelemetryEnabled: null,
        effectiveMetadataTelemetryEnabled: false,
        rawTranscriptUploadEnabled: false,
      });
      expect(result.telemetry).toEqual({
        enabled: false,
        rawTranscriptsAllowed: false,
        sink: "disabled",
      });
      const terminal = formatStatusForTerminal(result);
      expect(terminal).toContain("Resin: Stopped");
      expect(terminal).toMatch(/Daemon\s+Stopped/i);
      expect(terminal).toMatch(/Cloud\s+Not signed in/i);
      expect(terminal).toMatch(/Sharing\s+metadata unknown.*raw transcripts off/i);
      for (const remediation of result.remediations) {
        expect(terminal).toContain(remediation.message);
        if (remediation.command) expect(terminal).toContain(remediation.command);
      }
      expect(customFetch).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it("falls closed without throwing when every local status file is unreadable", async () => {
    runtime.serviceError = true;
    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge({}, true),
    });

    expect(summary.status).toBe("stopped");
    expect(summary.service).toMatchObject({ installed: false, active: false });
    expect(summary.ipc).toMatchObject({ connected: false, errorCode: "socket_missing" });
    expect(summary.privacy).toMatchObject({
      configurationState: "unreadable",
      deviceMetadataTelemetryEnabled: false,
      effectiveMetadataTelemetryEnabled: false,
    });
    expect(summary.recovery).toMatchObject({ available: false, status: "unknown" });
    expect(summary.update).toMatchObject({
      available: false,
      hasError: true,
      errorCode: "update_state_unreadable",
    });
    expect(summary.remediations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "install_daemon",
        "repair_privacy_config",
        "inspect_recovery",
        "inspect_update",
      ]),
    );
  });

  it("escapes workspace path controls in terminal output without changing JSON values", async () => {
    const unsafeRoot = "/workspace/\u001b[31mforged\nline\r\t\u007f\u009b";
    const unsafeCwd = path.join(unsafeRoot, "app");
    const files = healthyFiles();
    files[path.join(unsafeRoot, "resin.json")] = files["/workspace/resin.json"];

    const summary = await collectStatus({
      home: HOME,
      cwd: unsafeCwd,
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });
    const terminal = formatStatusForTerminal(summary, { verbose: true });
    const jsonRoundTrip = JSON.parse(JSON.stringify(summary));
    const escapedRoot = "/workspace/\\u001b[31mforged\\u000aline\\u000d\\u0009\\u007f\\u009b";

    expect(summary.workspace.activeDirectory).toBe(unsafeCwd);
    expect(summary.workspace.rootDir).toBe(unsafeRoot);
    expect(jsonRoundTrip.workspace.activeDirectory).toBe(unsafeCwd);
    expect(jsonRoundTrip.workspace.rootDir).toBe(unsafeRoot);
    expect(terminal).toContain(`  Active:     ${escapedRoot}/app`);
    expect(terminal).toContain(`  Root:       ${escapedRoot}`);
    expect(terminal).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  it("excludes tokens, keys, secrets, private errors, and non-workspace paths from JSON and terminal output", async () => {
    runtime.ipcMode = "timeout";
    const files = healthyFiles();
    files[CONFIG_FILE] = JSON.stringify({
      telemetryEnabled: true,
      authToken: "CONFIG_AUTH_TOKEN_SECRET",
      privateKey: "CONFIG_PRIVATE_KEY_SECRET",
      password: "CONFIG_PASSWORD_SECRET",
    });
    files["/workspace/resin.json"] = JSON.stringify({
      workspaceId: "ws_project_99",
      apiToken: "PROJECT_API_TOKEN_SECRET",
      secret: "PROJECT_MANIFEST_SECRET",
    });
    files[path.join(STATE_DIR, "safety-attestation.json")] = JSON.stringify({
      privateKey: "ATTESTATION_PRIVATE_KEY_SECRET",
      error: "ATTESTATION_ERROR_SECRET",
    });

    const summary = await collectStatus({
      home: HOME,
      cwd: "/workspace/packages/app",
      env: ENV,
      now: () => NOW,
      fsBridge: createMockFsBridge(files),
    });
    const json = JSON.stringify(summary);
    const terminal = formatStatusForTerminal(summary);
    const detailed = formatStatusForTerminal(summary, { verbose: true });
    const combined = `${json}\n${terminal}\n${detailed}`;

    for (const secret of [
      "ACCESS_TOKEN_SECRET",
      "REFRESH_TOKEN_SECRET",
      "LOCK_METADATA_SECRET",
      "CONFIG_AUTH_TOKEN_SECRET",
      "CONFIG_PRIVATE_KEY_SECRET",
      "CONFIG_PASSWORD_SECRET",
      "PROJECT_API_TOKEN_SECRET",
      "PROJECT_MANIFEST_SECRET",
      "ATTESTATION_PRIVATE_KEY_SECRET",
      "ATTESTATION_ERROR_SECRET",
      "IPC_ERROR_SECRET",
      "UPDATE_ERROR_SECRET",
      "UPDATE_QUARANTINE_SECRET",
      "RECOVERY_REMEDIATION_SECRET",
      "HARNESS_DISPLAY_SECRET",
      "/private/service/path",
      HOME,
    ]) {
      expect(combined).not.toContain(secret);
    }
    for (const forbiddenKey of [
      "accessToken",
      "refreshToken",
      "authToken",
      "privateKey",
      "password",
      "configPath",
      "unitPath",
      "socketPath",
      "lastError",
    ]) {
      expect(json).not.toContain(`\"${forbiddenKey}\"`);
    }
    expect(summary.workspace.activeDirectory).toBe("/workspace/packages/app");
    expect(summary.workspace.rootDir).toBe("/workspace");
  });

  it("uses a distinct nonzero exit for invalid flags without exposing parser details", async () => {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await statusCommand(["--json", "--unknown-private-flag"]);
      expect(exitCode).toBe(2);
      expect(JSON.parse(chunks.join(""))).toEqual({
        schemaVersion: 1,
        status: "error",
        error: { code: "INVALID_FLAGS" },
        exitCode: 2,
      });
      expect(chunks.join("")).not.toContain("--unknown-private-flag");
    } finally {
      stdout.mockRestore();
    }
  });
});
