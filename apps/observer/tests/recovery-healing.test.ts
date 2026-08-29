import child_process, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecoveryAwareDaemonSupervisor,
  type RecoveryAwareHealthReport,
  awaitBackgroundDaemonStartup,
  getRecoverySnapshot,
  handleIpcCommand,
  persistAndSurfaceConfigRecoveryWarning,
} from "../src/bin/daemon.js";
import {
  CONFIG_RECOVERY_WARNING_STATE_FILE_NAME,
  type ConfigRecoveryWarning,
  DaemonConfigSchema,
  loadDaemonConfig,
  readPersistedConfigRecoveryWarning,
} from "../src/config.js";
import { IpcClient } from "../src/ipc/client.js";
import { FrameDecoder, encodeFrame } from "../src/ipc/framing.js";
import { IpcServer } from "../src/ipc/server.js";
import { DaemonLock } from "../src/lock.js";
import { ensureDaemonDirectories, resolvePaths } from "../src/paths.js";

const temporaryDirectories = new Set<string>();
const childProcesses = new Set<ChildProcess>();
const socketServers = new Set<net.Server>();
const childClosePromises = new Map<ChildProcess, Promise<void>>();
const serverConnections = new Map<net.Server, Set<net.Socket>>();

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resin-recovery-healing-"));
  temporaryDirectories.add(directory);
  return directory;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  const closePromise = childClosePromises.get(child);
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closePromise;
  } finally {
    childProcesses.delete(child);
    childClosePromises.delete(child);
  }
}

async function createStaleUnixSocket(socketPath: string): Promise<void> {
  const script = [
    'const net = require("node:net");',
    "const server = net.createServer();",
    'server.listen(process.argv[1], () => process.stdout.write("READY\\n"));',
  ].join("\n");
  const child = child_process.spawn(process.execPath, ["-e", script, socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcesses.add(child);
  const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
  childClosePromises.set(child, closePromise);
  child.once("close", () => resolveClose());

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onReady = (): void => resolve();
  const onError = (error: Error): void => reject(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    reject(
      new Error(
        `Socket fixture exited before listening (code: ${code ?? "none"}, signal: ${signal ?? "none"})`,
      ),
    );
  };
  child.stdout?.once("data", onReady);
  child.once("error", onError);
  child.once("exit", onExit);
  try {
    await promise;
  } finally {
    child.stdout?.off("data", onReady);
    child.off("error", onError);
    child.off("exit", onExit);
    await terminateChild(child);
  }
  expect((await fs.promises.lstat(socketPath)).isSocket()).toBe(true);
}

async function startResponsiveIpcSocket(socketPath: string): Promise<net.Server> {
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => undefined);

    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        const request = frame as {
          id?: unknown;
          params?: { nonce?: unknown };
        };
        socket.write(
          encodeFrame({
            id: request.id,
            result: {
              pong: true,
              nonce: request.params?.nonce,
              timestamp: Date.now(),
            },
          }),
        );
      }
    });
  });
  socketServers.add(server);
  serverConnections.set(server, connections);

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(socketPath, () => {
    server.off("error", reject);
    resolve();
  });
  await promise;
  return server;
}

async function closeSocketServer(server: net.Server): Promise<void> {
  const connections = serverConnections.get(server) ?? [];
  socketServers.delete(server);
  serverConnections.delete(server);
  if (!server.listening) {
    for (const socket of connections) socket.destroy();
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  for (const socket of connections) socket.destroy();
  await promise;
}

afterEach(async () => {
  for (const server of socketServers) {
    await closeSocketServer(server);
  }
  for (const child of childProcesses) {
    await terminateChild(child);
  }
  childProcesses.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
  vi.restoreAllMocks();
});

describe("runtime state healing", () => {
  it("replaces a dead-PID lock and acquires a permission-safe live lock", async () => {
    const directory = await createTemporaryDirectory();
    const lockPath = path.join(directory, "daemon.lock");
    const socketPath = path.join(directory, "daemon.sock");
    const stalePayload = {
      pid: 2_000_000_000,
      startedAt: Date.now() - 60_000,
      lastHeartbeat: Date.now(),
      version: "0.1.0",
      socketPath,
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(stalePayload), { mode: 0o600 });

    const lock = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 25 });
    try {
      const result = await lock.acquire();

      expect(result.status).toBe("stale_recovered");
      expect(result.previousLockData).toEqual(stalePayload);
      expect(result.quarantinedLockPath).toMatch(/daemon\.lock\.stale\./);
      expect(
        JSON.parse(await fs.promises.readFile(result.quarantinedLockPath as string, "utf-8")),
      ).toEqual(stalePayload);
      expect(result.lockData?.pid).toBe(process.pid);
      expect(JSON.parse(await fs.promises.readFile(lockPath, "utf-8"))).toMatchObject({
        pid: process.pid,
        socketPath,
      });
      expect((await fs.promises.stat(lockPath)).mode & 0o077).toBe(0);
    } finally {
      await lock.release();
    }
  });

  it("recovers when an unrelated live process has reused the recorded PID", async () => {
    const directory = await createTemporaryDirectory();
    const lockPath = path.join(directory, "daemon.lock");
    const socketPath = path.join(directory, "missing.sock");
    const reusedPidPayload = {
      pid: process.pid,
      startedAt: Date.now() - 60_000,
      lastHeartbeat: Date.now() - 60_000,
      version: "0.1.0",
      socketPath,
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(reusedPidPayload), { mode: 0o600 });

    const lock = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 50 });
    try {
      const result = await lock.acquire();
      expect(result.status).toBe("stale_recovered");
      expect(result.previousLockData).toEqual(reusedPidPayload);
      expect(result.lockData?.pid).toBe(process.pid);
    } finally {
      await lock.release();
    }
  });

  it("preserves a fresh live-PID lock when first startup outlasts the IPC probe", async () => {
    const directory = await createTemporaryDirectory();
    const lockPath = path.join(directory, "daemon.lock");
    const socketPath = path.join(directory, "not-listening-yet.sock");
    const startupPayload = {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      version: "0.1.0",
      socketPath,
    };
    const originalLockContent = JSON.stringify(startupPayload);
    await fs.promises.writeFile(lockPath, originalLockContent, { mode: 0o600 });
    const originalStat = await fs.promises.stat(lockPath);

    const contender = new DaemonLock({
      lockPath,
      socketPath,
      ipcProbeTimeoutMs: 1,
      staleThresholdMs: 10_000,
    });
    const result = await contender.acquire();
    const finalStat = await fs.promises.stat(lockPath);

    expect(result.status).toBe("already_running");
    expect(result.pid).toBe(process.pid);
    expect(contender.isLocked).toBe(false);
    expect(await fs.promises.readFile(lockPath, "utf-8")).toBe(originalLockContent);
    expect(finalStat.ino).toBe(originalStat.ino);
    expect(finalStat.mtimeMs).toBe(originalStat.mtimeMs);
    await expect(fs.promises.lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32")(
    "preserves a live lock and socket when the daemon answers IPC",
    async () => {
      const directory = await createTemporaryDirectory();
      const lockPath = path.join(directory, "daemon.lock");
      const socketPath = path.join(directory, "daemon.sock");
      const server = await startResponsiveIpcSocket(socketPath);
      const livePayload = {
        pid: process.pid,
        startedAt: Date.now() - 60_000,
        lastHeartbeat: Date.now() - 60_000,
        version: "0.1.0",
        socketPath,
      };
      const originalLockContent = `${JSON.stringify(livePayload, null, 2)}\n`;
      await fs.promises.writeFile(lockPath, originalLockContent, { mode: 0o600 });
      const beforeStat = await fs.promises.stat(lockPath);

      try {
        const contender = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 100 });
        const result = await contender.acquire();
        const afterStat = await fs.promises.stat(lockPath);

        expect(result.status).toBe("already_running");
        expect(result.pid).toBe(process.pid);
        expect(contender.isLocked).toBe(false);
        expect(await fs.promises.readFile(lockPath, "utf-8")).toBe(originalLockContent);
        expect((await fs.promises.lstat(socketPath)).isSocket()).toBe(true);
        expect(afterStat.ino).toBe(beforeStat.ino);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
      } finally {
        await closeSocketServer(server);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses takeover when a daemon answers IPC despite a missing or corrupt lock",
    async () => {
      for (const lockState of ["missing", "corrupt"] as const) {
        const directory = await createTemporaryDirectory();
        const lockPath = path.join(directory, `${lockState}.lock`);
        const socketPath = path.join(directory, `${lockState}.sock`);
        const server = await startResponsiveIpcSocket(socketPath);
        if (lockState === "corrupt") {
          await fs.promises.writeFile(lockPath, "{corrupt-lock", { mode: 0o600 });
        }

        try {
          const contender = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 100 });
          const result = await contender.acquire();

          expect(result.status).toBe("already_running");
          expect(contender.isLocked).toBe(false);
          expect((await fs.promises.lstat(socketPath)).isSocket()).toBe(true);
          if (lockState === "missing") {
            await expect(fs.promises.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(await fs.promises.readFile(lockPath, "utf-8")).toBe("{corrupt-lock");
          }
        } finally {
          await closeSocketServer(server);
        }
      }
    },
  );

  it("preserves an ordinary file configured as the socket and rolls back its lock", async () => {
    const directory = await createTemporaryDirectory();
    const lockPath = path.join(directory, "daemon.lock");
    const socketPath = path.join(directory, "config.json");
    const sentinel = '{"authToken":"must-not-be-deleted"}';
    await fs.promises.writeFile(socketPath, sentinel, { mode: 0o600 });

    const lock = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 25 });
    await expect(lock.acquire()).rejects.toThrow("Refusing to remove non-socket path");

    expect(await fs.promises.readFile(socketPath, "utf-8")).toBe(sentinel);
    expect((await fs.promises.lstat(socketPath)).isFile()).toBe(true);
    await expect(fs.promises.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "preserves a symlink configured as the socket without following it",
    async () => {
      const directory = await createTemporaryDirectory();
      const lockPath = path.join(directory, "daemon.lock");
      const targetPath = path.join(directory, "target.json");
      const socketPath = path.join(directory, "daemon.sock");
      await fs.promises.writeFile(targetPath, "preserve-target", { mode: 0o600 });
      await fs.promises.symlink(targetPath, socketPath);

      const lock = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 25 });
      await expect(lock.acquire()).rejects.toThrow("Refusing to remove non-socket path");

      expect((await fs.promises.lstat(socketPath)).isSymbolicLink()).toBe(true);
      expect(await fs.promises.readFile(targetPath, "utf-8")).toBe("preserve-target");
      await expect(fs.promises.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes a verified non-responsive Unix socket after acquiring the lock",
    async () => {
      const directory = await createTemporaryDirectory();
      const lockPath = path.join(directory, "daemon.lock");
      const socketPath = path.join(directory, "daemon.sock");
      await createStaleUnixSocket(socketPath);

      const lock = new DaemonLock({ lockPath, socketPath, ipcProbeTimeoutMs: 50 });
      try {
        const result = await lock.acquire();

        expect(result.status).toBe("acquired");
        expect(result.recoveredSocketPaths).toEqual([path.resolve(socketPath)]);
        await expect(fs.promises.lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await lock.release();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses the prior lock socket path for orphan cleanup after configuration changes",
    async () => {
      const directory = await createTemporaryDirectory();
      const lockPath = path.join(directory, "daemon.lock");
      const previousSocketPath = path.join(directory, "previous.sock");
      const currentSocketPath = path.join(directory, "current.sock");
      await createStaleUnixSocket(previousSocketPath);
      const stalePayload = {
        pid: 2_000_000_000,
        startedAt: Date.now() - 60_000,
        lastHeartbeat: Date.now() - 60_000,
        version: "0.1.0",
        socketPath: previousSocketPath,
      };
      await fs.promises.writeFile(lockPath, JSON.stringify(stalePayload), { mode: 0o600 });

      const lock = new DaemonLock({
        lockPath,
        socketPath: currentSocketPath,
        ipcProbeTimeoutMs: 50,
      });
      try {
        const result = await lock.acquire();

        expect(result.status).toBe("stale_recovered");
        expect(result.recoveredSocketPaths).toEqual([path.resolve(previousSocketPath)]);
        await expect(fs.promises.lstat(previousSocketPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.promises.lstat(currentSocketPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await lock.release();
      }
    },
  );

  it("preserves an unexpected regular file referenced by the prior lock payload", async () => {
    const directory = await createTemporaryDirectory();
    const lockPath = path.join(directory, "daemon.lock");
    const previousSocketPath = path.join(directory, "user-config.json");
    const currentSocketPath = path.join(directory, "current.sock");
    const sentinel = '{"custom":"preserve-me"}';
    await fs.promises.writeFile(previousSocketPath, sentinel, { mode: 0o600 });
    await fs.promises.writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_000_000_000,
        startedAt: Date.now() - 60_000,
        lastHeartbeat: Date.now() - 60_000,
        version: "0.1.0",
        socketPath: previousSocketPath,
      }),
      { mode: 0o600 },
    );

    const lock = new DaemonLock({
      lockPath,
      socketPath: currentSocketPath,
      ipcProbeTimeoutMs: 25,
    });
    try {
      const result = await lock.acquire();
      expect(result.status).toBe("stale_recovered");
      expect(result.recoveredSocketPaths).toBeUndefined();
      expect(await fs.promises.readFile(previousSocketPath, "utf-8")).toBe(sentinel);
    } finally {
      await lock.release();
    }
  });
});

describe("recovery observability", () => {
  it.skipIf(process.platform === "win32")(
    "includes persisted recovery in the live IPC health response",
    async () => {
      const directory = await createTemporaryDirectory();
      const paths = resolvePaths({
        resinHome: directory,
        socketPath: path.join(directory, "state", "daemon.sock"),
      });
      await ensureDaemonDirectories(paths);
      await fs.promises.writeFile(
        path.join(paths.stateDir, "recovery-state.json"),
        JSON.stringify({
          version: 1,
          status: "TRIPPED",
          restartCount: 6,
          crashTimestamps: [1, 2, 3, 4, 5, 6],
          trippedAt: Date.now(),
          lastFailure: { timestamp: Date.now(), category: "RUNTIME" },
        }),
        { mode: 0o600 },
      );

      const supervisor = new RecoveryAwareDaemonSupervisor({
        config: DaemonConfigSchema.parse({ socketPath: paths.socketPath }),
        paths,
        enableSignalHandlers: false,
      });
      const server = new IpcServer({
        supervisor,
        socketPath: paths.socketPath,
        authToken: "test-ipc-token",
      });
      const client = new IpcClient({
        socketPath: paths.socketPath,
        authToken: "test-ipc-token",
        timeoutMs: 500,
      });

      await server.start();
      try {
        await client.connect();
        const health = (await client.getHealth()) as RecoveryAwareHealthReport;
        expect(health.recovery).toMatchObject({
          restartCount: 6,
          circuitBreaker: "TRIPPED",
          circuitBreakerTripped: true,
        });
        expect(health.recovery.lastFailure?.remediation).toContain("resin doctor");
      } finally {
        await client.close();
        await server.stop();
      }
    },
  );

  it("surfaces TRIPPED recovery state even when the daemon is down", async () => {
    const directory = await createTemporaryDirectory();
    const paths = resolvePaths({
      resinHome: directory,
      socketPath: path.join(directory, "state", "missing.sock"),
    });
    await ensureDaemonDirectories(paths);
    await fs.promises.writeFile(
      path.join(paths.stateDir, "recovery-state.json"),
      JSON.stringify({
        version: 1,
        status: "TRIPPED",
        restartCount: 7,
        crashTimestamps: [1, 2, 3, 4, 5, 6],
        trippedAt: Date.now(),
        lastFailure: { timestamp: Date.now(), category: "RUNTIME" },
      }),
      { mode: 0o600 },
    );
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await handleIpcCommand("status", paths);
    const rendered = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as {
      daemonReachable: boolean;
      recovery: {
        circuitBreaker: string;
        circuitBreakerTripped: boolean;
        lastFailure?: { remediation?: string };
      };
    };

    expect(exitCode).toBe(1);
    expect(rendered.daemonReachable).toBe(false);
    expect(rendered.recovery.circuitBreaker).toBe("TRIPPED");
    expect(rendered.recovery.circuitBreakerTripped).toBe(true);
    expect(rendered.recovery.lastFailure?.remediation).toContain("resin doctor");
  });
});

describe("configuration healing", () => {
  it("backfills defaults in memory while preserving partial custom configuration verbatim", async () => {
    const directory = await createTemporaryDirectory();
    const configPath = path.join(directory, "config.json");
    const partialConfig = {
      port: 9751,
      logLevel: "debug",
      telemetryEnabled: false,
      moduleConfigs: {
        customAdapter: {
          endpoint: "http://127.0.0.1:7777/mcp",
          transport: "http",
        },
      },
      custom: {
        toolDefinitions: {
          localOnly: {
            command: "/opt/resin/custom-tool",
            args: ["--local"],
          },
        },
      },
    };
    const originalContent = `${JSON.stringify(partialConfig, null, 2)}\n`;
    await fs.promises.writeFile(configPath, originalContent, { mode: 0o600 });

    const config = loadDaemonConfig({
      configPath,
      env: {},
      overrides: { port: undefined, storageDir: undefined },
    });

    expect(config.port).toBe(partialConfig.port);
    expect(config.logLevel).toBe(partialConfig.logLevel);
    expect(config.telemetryEnabled).toBe(false);
    expect(config.moduleConfigs).toEqual(partialConfig.moduleConfigs);
    expect(config.custom).toEqual(partialConfig.custom);
    expect(config.version).toBe("0.1.0");
    expect(config.heartbeatIntervalMs).toBe(3000);
    expect(config.workerExecutionTimeoutMs).toBe(30_000);
    expect(await fs.promises.readFile(configPath, "utf-8")).toBe(originalContent);
  });

  it("persists and visibly relays malformed-config remediation without changing the source", async () => {
    const directory = await createTemporaryDirectory();
    const configPath = path.join(directory, "config.json");
    const malformedContent = '{"port":9751,"authToken":"sentinel-secret"';
    await fs.promises.writeFile(configPath, malformedContent, { mode: 0o640 });
    const originalStat = await fs.promises.stat(configPath);
    const warnings: ConfigRecoveryWarning[] = [];

    const config = loadDaemonConfig({
      configPath,
      env: {},
      onWarning: (warning) => warnings.push(warning),
    });
    expect(config).toEqual(DaemonConfigSchema.parse({}));
    expect(warnings).toHaveLength(1);

    const paths = resolvePaths({
      resinHome: directory,
      configFile: configPath,
      socketPath: path.join(directory, "state", "daemon.sock"),
    });
    await ensureDaemonDirectories(paths);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await persistAndSurfaceConfigRecoveryWarning(paths, warnings[0] as ConfigRecoveryWarning);

    const visibleMessages = stderr.mock.calls.flat().join("\n");
    expect(visibleMessages).toContain("malformed JSON");
    expect(visibleMessages).toContain("restart Resin");
    expect(visibleMessages).not.toContain("sentinel-secret");

    const warningStatePath = path.join(paths.stateDir, CONFIG_RECOVERY_WARNING_STATE_FILE_NAME);
    expect(await readPersistedConfigRecoveryWarning(warningStatePath)).toEqual(warnings[0]);
    expect((await fs.promises.stat(warningStatePath)).mode & 0o077).toBe(0);
    const recovery = await getRecoverySnapshot(paths);
    expect(recovery.circuitBreaker).toBe("DEGRADED");
    expect(recovery.configurationWarning).toEqual(warnings[0]);

    const entries = await fs.promises.readdir(directory);
    const backups = entries.filter((entry) => /^config\.json\.corrupt\.\d+$/.test(entry));
    expect(backups).toHaveLength(1);
    const backupPath = path.join(directory, backups[0] as string);
    expect(await fs.promises.readFile(backupPath, "utf-8")).toBe(malformedContent);
    expect((await fs.promises.stat(backupPath)).mode & 0o077).toBe(0);

    const finalStat = await fs.promises.stat(configPath);
    expect(await fs.promises.readFile(configPath, "utf-8")).toBe(malformedContent);
    expect(finalStat.ino).toBe(originalStat.ino);
    expect(finalStat.mode & 0o777).toBe(originalStat.mode & 0o777);
    expect(finalStat.mtimeMs).toBe(originalStat.mtimeMs);
  });

  it("relays the structured remediation through the detached startup handshake", async () => {
    const warning: ConfigRecoveryWarning = {
      category: "MALFORMED_CONFIG",
      detectedAt: Date.now(),
      configPath: "/private/config.json",
      backupPath: "/private/config.json.corrupt.1",
      remediation: "Inspect the backup, repair the config, then restart Resin.",
      message: "WARNING: malformed JSON; inspect the backup and restart Resin.",
    };
    const fakeChild = new EventEmitter() as unknown as ChildProcess;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const startup = awaitBackgroundDaemonStartup(fakeChild, {
      timeoutMs: 500,
      onWarning: (receivedWarning) => console.error(receivedWarning.message),
    });

    fakeChild.emit("message", {
      type: "config-recovery-warning",
      warning,
    });
    fakeChild.emit("message", { type: "ready", pid: 4321 });

    await expect(startup).resolves.toBe(4321);
    expect(stderr).toHaveBeenCalledWith(warning.message);
  });
});
