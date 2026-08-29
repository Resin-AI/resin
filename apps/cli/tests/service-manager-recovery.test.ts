import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LaunchdUserServiceManager,
  SERVICE_SUPERVISOR_COMMAND,
  SystemdUserServiceManager,
  WslUserServiceManager,
  runServiceSupervisor,
} from "../src/service/manager.js";
import {
  CRASH_RECOVERY_LOG_BACKUP_SUFFIX,
  CRASH_RECOVERY_LOG_FILE_NAME,
  CRASH_WINDOW_MS,
  MAX_CRASHES_IN_WINDOW,
  RECOVERY_REMEDIATIONS,
  RECOVERY_STATE_FILE_NAME,
  RecoveryStateTracker,
  calculateRestartDelayMs,
} from "../src/service/recovery-state.js";

const temporaryDirectories: string[] = [];

async function createTemporaryResinHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "resin-recovery-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("bounded service recovery", () => {
  it("calculates exponential delays with deterministic jitter and a 60 second cap", () => {
    const midpointDelays = Array.from({ length: 7 }, (_, index) =>
      calculateRestartDelayMs(index + 1, () => 0.5),
    );

    expect(midpointDelays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(calculateRestartDelayMs(1, () => 0)).toBe(1_600);
    expect(calculateRestartDelayMs(1, () => 1)).toBe(2_400);
    expect(calculateRestartDelayMs(6, () => 1)).toBe(60_000);
  });

  it("supervises real child exits through persisted backoff and trips without another launch", async () => {
    const resinHome = await createTemporaryResinHome();
    const tracker = new RecoveryStateTracker({
      resinHome,
      random: () => 0.5,
    });
    const restartDelays: number[] = [];
    const reports: string[] = [];
    const awsAccessKey = "AKIAIOSFODNN7EXAMPLE";
    const awsSecretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const dsnPassword = "database-password";
    const commandSecret = "command-token-secret";
    const childStderr = [
      `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
      `AWS_SECRET_ACCESS_KEY=${awsSecretKey}`,
      `DATABASE_URL=postgres://resin:${dsnPassword}@db.example.test/resin`,
    ].join(" ");
    const childScript = `process.stderr.write(${JSON.stringify(`${childStderr}\n`)}, () => process.exit(17));`;
    const result = await runServiceSupervisor({
      command: process.execPath,
      args: ["-e", childScript, "--", "--token", commandSecret],
      resinHome,
      tracker,
      wait: (delayMs) => {
        restartDelays.push(delayMs);
        return Promise.resolve();
      },
      report: (message) => {
        reports.push(message);
      },
    });

    const rawState = await fs.readFile(
      path.join(resinHome, "state", RECOVERY_STATE_FILE_NAME),
      "utf8",
    );
    const rawLog = await fs.readFile(
      path.join(resinHome, "logs", CRASH_RECOVERY_LOG_FILE_NAME),
      "utf8",
    );
    const records = rawLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result).toMatchObject({
      reason: "TRIPPED",
      childExitCount: MAX_CRASHES_IN_WINDOW + 1,
      state: {
        status: "TRIPPED",
      },
    });
    expect(restartDelays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(reports.at(-1)).toContain("TRIPPED");
    expect(records).toHaveLength(MAX_CRASHES_IN_WINDOW + 1);
    expect(records.at(-1)).toMatchObject({
      status: "TRIPPED",
      restartScheduled: false,
      exitCode: 17,
    });
    for (const credential of [awsAccessKey, awsSecretKey, dsnPassword, commandSecret]) {
      expect(rawState).not.toContain(credential);
      expect(rawLog).not.toContain(credential);
    }
  });

  it("stops after one clean child exit without changing recovery state or logs", async () => {
    const resinHome = await createTemporaryResinHome();
    const tracker = new RecoveryStateTracker({
      resinHome,
      clock: () => 1_000,
      random: () => 0.5,
    });
    await tracker.recordCrash({
      error: new Error("pre-existing transient failure"),
      exitCode: 8,
    });
    const statePath = path.join(resinHome, "state", RECOVERY_STATE_FILE_NAME);
    const logPath = path.join(resinHome, "logs", CRASH_RECOVERY_LOG_FILE_NAME);
    const launchRecordPath = path.join(resinHome, "clean-child-launches");
    const [stateBefore, logBefore] = await Promise.all([
      fs.readFile(statePath, "utf8"),
      fs.readFile(logPath, "utf8"),
    ]);
    const restartDelays: number[] = [];
    const reports: string[] = [];
    const childScript = `require("node:fs").appendFileSync(${JSON.stringify(
      launchRecordPath,
    )}, "launch\\n");`;

    const result = await runServiceSupervisor({
      command: process.execPath,
      args: ["-e", childScript],
      resinHome,
      tracker,
      wait: (delayMs) => {
        restartDelays.push(delayMs);
        return Promise.resolve();
      },
      report: (message) => {
        reports.push(message);
      },
    });

    const [stateAfter, logAfter, launches] = await Promise.all([
      fs.readFile(statePath, "utf8"),
      fs.readFile(logPath, "utf8"),
      fs.readFile(launchRecordPath, "utf8"),
    ]);

    expect(result).toMatchObject({
      reason: "SHUTDOWN",
      childExitCount: 1,
      state: {
        status: "DEGRADED",
        restartCount: 1,
      },
    });
    expect(launches).toBe("launch\n");
    expect(restartDelays).toEqual([]);
    expect(reports).toEqual([]);
    expect(stateAfter).toBe(stateBefore);
    expect(logAfter).toBe(logBefore);
  });

  it("evicts crashes outside the rolling five-minute window", async () => {
    const resinHome = await createTemporaryResinHome();
    let now = 0;
    const tracker = new RecoveryStateTracker({
      resinHome,
      clock: () => now,
      random: () => 0.5,
    });

    for (let crash = 0; crash < MAX_CRASHES_IN_WINDOW; crash += 1) {
      await tracker.recordCrash({ error: new Error("transient runtime failure") });
      now += 1;
    }

    now = CRASH_WINDOW_MS + MAX_CRASHES_IN_WINDOW - 1;
    const decision = await tracker.recordCrash({ error: new Error("later isolated failure") });

    expect(decision.shouldRestart).toBe(true);
    expect(decision.delayMs).toBe(2_000);
    expect(decision.crashCount).toBe(1);
    expect(decision.state).toMatchObject({
      status: "DEGRADED",
      restartCount: 1,
      crashTimestamps: [now],
    });
  });

  it("trips after more than five crashes and remains tripped until reset", async () => {
    const resinHome = await createTemporaryResinHome();
    let now = 10_000;
    const tracker = new RecoveryStateTracker({
      resinHome,
      clock: () => now,
      random: () => 0.5,
    });

    let latestDecision = await tracker.recordCrash({ error: new Error("failure 1") });
    for (let crash = 2; crash <= MAX_CRASHES_IN_WINDOW + 1; crash += 1) {
      now += 1;
      latestDecision = await tracker.recordCrash({ error: new Error(`failure ${crash}`) });
    }

    expect(latestDecision.shouldRestart).toBe(false);
    expect(latestDecision.delayMs).toBeUndefined();
    expect(latestDecision.crashCount).toBe(MAX_CRASHES_IN_WINDOW + 1);
    expect(latestDecision.state).toMatchObject({
      status: "TRIPPED",
      restartCount: MAX_CRASHES_IN_WINDOW,
      trippedAt: now,
    });

    const forensicLog = await fs.readFile(
      path.join(resinHome, "logs", CRASH_RECOVERY_LOG_FILE_NAME),
      "utf8",
    );
    const forensicLines = forensicLog.trim().split("\n");
    const tripRecord = JSON.parse(forensicLines[forensicLines.length - 1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(tripRecord).toMatchObject({
      status: "TRIPPED",
      crashCount: MAX_CRASHES_IN_WINDOW + 1,
      restartScheduled: false,
    });

    now += CRASH_WINDOW_MS + 1;
    const stillTripped = await tracker.getState();
    expect(stillTripped.status).toBe("TRIPPED");

    const reset = await tracker.reset();
    expect(reset).toEqual({
      version: 1,
      status: "HEALTHY",
      restartCount: 0,
      crashTimestamps: [],
    });
  });

  it("atomically persists recovery state for a new tracker instance", async () => {
    const resinHome = await createTemporaryResinHome();
    let now = 42_000;
    const firstTracker = new RecoveryStateTracker({
      resinHome,
      clock: () => now,
      random: () => 0.5,
    });

    await firstTracker.recordCrash({ error: new Error("first failure"), exitCode: 17 });
    now += 10;
    await firstTracker.recordCrash({ error: new Error("second failure"), exitCode: 18 });

    const secondTracker = new RecoveryStateTracker({
      resinHome,
      clock: () => now,
      random: () => 0.5,
    });
    const persisted = await secondTracker.getState();
    const stateDirectory = path.join(resinHome, "state");
    const stateFiles = await fs.readdir(stateDirectory);
    const rawState = await fs.readFile(path.join(stateDirectory, RECOVERY_STATE_FILE_NAME), "utf8");

    expect(persisted).toMatchObject({
      version: 1,
      status: "DEGRADED",
      restartCount: 2,
      crashTimestamps: [42_000, 42_010],
      lastFailure: {
        timestamp: 42_010,
        category: "RUNTIME",
        remediation: RECOVERY_REMEDIATIONS.RUNTIME,
        exitCode: 18,
      },
    });
    expect(JSON.parse(rawState)).toEqual(persisted);
    expect(stateFiles).toEqual([RECOVERY_STATE_FILE_NAME]);
  });

  it("persists a healthy reset after a supervised child survives the stability window", async () => {
    const resinHome = await createTemporaryResinHome();
    const tracker = new RecoveryStateTracker({
      resinHome,
      random: () => 0.5,
    });
    await tracker.recordCrash({ error: new Error("initial transient failure"), exitCode: 8 });

    const shutdown = new AbortController();
    const stabilityStarted = Promise.withResolvers<void>();
    const allowStability = Promise.withResolvers<void>();
    const supervisorResult = runServiceSupervisor({
      command: process.execPath,
      args: ["-e", "require('net').createServer().listen(0)"],
      resinHome,
      tracker,
      signal: shutdown.signal,
      stabilityWindowMs: 5,
      stabilityWait: () => {
        stabilityStarted.resolve();
        return allowStability.promise;
      },
    });

    await stabilityStarted.promise;
    allowStability.resolve();
    await Promise.resolve();
    const stableState = await tracker.getState();
    shutdown.abort();
    const result = await supervisorResult;
    const persisted = JSON.parse(
      await fs.readFile(path.join(resinHome, "state", RECOVERY_STATE_FILE_NAME), "utf8"),
    ) as Record<string, unknown>;

    expect(stableState).toMatchObject({
      status: "HEALTHY",
      restartCount: 0,
      crashTimestamps: [],
    });
    expect(result).toMatchObject({
      reason: "SHUTDOWN",
      childExitCount: 0,
      state: {
        status: "HEALTHY",
        restartCount: 0,
      },
    });
    expect(persisted).toMatchObject({
      status: "HEALTHY",
      restartCount: 0,
      crashTimestamps: [],
    });
  });

  it("rotates forensic records within a fixed two-file byte bound", async () => {
    const resinHome = await createTemporaryResinHome();
    const tracker = new RecoveryStateTracker({
      resinHome,
      random: () => 0.5,
      maxCrashLogBytes: 1_024,
    });
    const credential = "rotation-secret-credential";

    for (let crash = 0; crash < 8; crash += 1) {
      await tracker.recordCrash({
        error: new Error(`failure ${crash} token=${credential} ${"diagnostic".repeat(140)}`),
        exitCode: crash + 1,
      });
    }

    const logDirectory = path.join(resinHome, "logs");
    const logFiles = (await fs.readdir(logDirectory)).sort();
    const expectedFiles = [
      CRASH_RECOVERY_LOG_FILE_NAME,
      `${CRASH_RECOVERY_LOG_FILE_NAME}${CRASH_RECOVERY_LOG_BACKUP_SUFFIX}`,
    ].sort();
    expect(logFiles).toEqual(expectedFiles);

    for (const logFile of logFiles) {
      const logPath = path.join(logDirectory, logFile);
      const metadata = await fs.stat(logPath);
      const content = await fs.readFile(logPath, "utf8");
      expect(metadata.size).toBeLessThanOrEqual(1_024);
      expect(content).not.toContain(credential);
      for (const line of content.trim().split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("persists only safe status fields and appends sanitized forensic records", async () => {
    const resinHome = await createTemporaryResinHome();
    let now = 77_000;
    const tracker = new RecoveryStateTracker({
      resinHome,
      clock: () => now,
      random: () => 0.5,
    });
    const privateDiagnosticContent = {
      transcriptLine: "private transcript content",
      transcriptValue: "private structured transcript content",
      toolOutputValue: "private tool output content",
    };
    const authenticationError = new Error("authentication failure");
    authenticationError.stack = [
      "Error: Unauthorized 401 Authorization: Bearer super-secret-token",
      `user: ${privateDiagnosticContent.transcriptLine}`,
      "    at reconnect (/opt/resin/runtime.js:10:2)",
    ].join("\n");

    const diagnosticSecrets = {
      awsAccessKey: "ASIAIOSFODNN7EXAMPLE",
      awsSecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      dsnPassword: "dsn-password-secret",
      commandToken: "command-argument-secret",
    };

    await tracker.recordCrash({ error: authenticationError, exitCode: 1 });
    now += 1;
    await tracker.recordCrash({
      error: {
        message: [
          "sync failed",
          `AWS_ACCESS_KEY_ID=${diagnosticSecrets.awsAccessKey}`,
          `AWS_SECRET_ACCESS_KEY=${diagnosticSecrets.awsSecretKey}`,
          `postgres://resin:${diagnosticSecrets.dsnPassword}@db.example.test/resin`,
          `resin sync --token ${diagnosticSecrets.commandToken}`,
        ].join(" "),
        refresh_token: "rtk_refresh_secret",
        transcript: privateDiagnosticContent.transcriptValue,
        toolOutput: privateDiagnosticContent.toolOutputValue,
      },
      exitCode: 2,
    });

    const statePath = path.join(resinHome, "state", RECOVERY_STATE_FILE_NAME);
    const logPath = path.join(resinHome, "logs", CRASH_RECOVERY_LOG_FILE_NAME);
    const rawState = await fs.readFile(statePath, "utf8");
    const rawLog = await fs.readFile(logPath, "utf8");
    const records = rawLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(rawState).not.toContain("super-secret-token");
    expect(rawState).not.toContain("private transcript content");
    expect(rawState).not.toContain("rtk_refresh_secret");
    expect(rawLog).not.toContain("super-secret-token");
    expect(rawLog).not.toContain("private transcript content");
    expect(rawLog).not.toContain("rtk_refresh_secret");
    for (const privateContent of Object.values(privateDiagnosticContent)) {
      expect(rawState).not.toContain(privateContent);
      expect(rawLog).not.toContain(privateContent);
    }
    for (const credential of Object.values(diagnosticSecrets)) {
      expect(rawState).not.toContain(credential);
      expect(rawLog).not.toContain(credential);
    }
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      event: "runtime_crash",
      status: "DEGRADED",
      category: "AUTHENTICATION",
      remediation: RECOVERY_REMEDIATIONS.AUTHENTICATION,
      exitCode: 1,
      restartScheduled: true,
      environmentSignature: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      },
    });
    expect(records[0]?.detail).toContain("[REDACTED_");
    expect(records[0]?.detail).toContain("[REDACTED_TRANSCRIPT_LINE]");
    expect(records[1]?.detail).toContain("[REDACTED_TRANSCRIPT]");
    expect(records[1]?.detail).toContain("[REDACTED_TOOL_OUTPUT]");
  });

  it("routes systemd, launchd, and WSL fallback through the shared supervisor", () => {
    const systemd = new SystemdUserServiceManager({
      homeDir: "/home/testuser",
      resinHome: "/home/testuser/.resin",
      nodePath: "/usr/bin/node",
    });
    const launchd = new LaunchdUserServiceManager({
      homeDir: "/Users/testuser",
      resinHome: "/Users/testuser/.resin",
      nodePath: "/usr/local/bin/node",
    });
    const wsl = new WslUserServiceManager({
      homeDir: "/home/testuser",
      resinHome: "/home/testuser/.resin",
      nodePath: "/usr/bin/node",
    });

    const systemdDefinition = systemd.getUnitDefinition({
      daemonPath: "/home/testuser/.resin/bin/resin-daemon",
    });
    const launchdDefinition = launchd.getUnitDefinition({
      daemonPath: "/Users/testuser/.resin/bin/resin-daemon",
    });
    const wslDefinition = wsl.getUnitDefinition({
      daemonPath: "/home/testuser/.resin/bin/resin-daemon",
    });

    expect(systemdDefinition).toMatch(
      /ExecStart=.*index\.js __service-supervisor .* -- .*resin-daemon --foreground/,
    );
    expect(systemdDefinition).toContain("Restart=on-failure");
    expect(systemdDefinition).toContain("StartLimitIntervalSec=300s");
    expect(systemdDefinition).toContain("StartLimitBurst=6");
    expect(launchdDefinition).toContain(`<string>${SERVICE_SUPERVISOR_COMMAND}</string>`);
    expect(launchdDefinition).toContain("<string>/Users/testuser/.resin/bin/resin-daemon</string>");
    expect(launchdDefinition).toContain("<key>KeepAlive</key>");
    expect(wslDefinition).toContain(`'${SERVICE_SUPERVISOR_COMMAND}'`);
    expect(wslDefinition).toContain("'/home/testuser/.resin/bin/resin-daemon' '--foreground'");
  });
});
