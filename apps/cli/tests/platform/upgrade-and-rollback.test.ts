import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { type DaemonSupervisor, IpcServer } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProductionRelease } from "../../src/installer/release-client.js";
import { detectPlatform, resolvePlatformPaths } from "../../src/platform/index.js";
import { runUpdateWorker } from "../../src/updates/auto-update.js";
import {
  UpdateEngine,
  type UpdateEngineOptions,
  activeWorkBlocker,
  readUpdateStatusSnapshot,
  updateFailureStageOf,
} from "../../src/updates/engine.js";
import { registerRunningGateway } from "../../src/updates/gateway-registry.js";
import { UpdateLockUnavailableError } from "../../src/updates/update-lock.js";
import { createFakeReporter, createTestTelemetry } from "../support/update-telemetry-fakes.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const bridge: ConfigFsBridge & { files: Map<string, string> } = {
    files,
    async readFile(filePath) {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath, content) {
      files.set(filePath, content);
    },
    async exists(filePath) {
      return files.has(filePath);
    },
    async mkdirp(dirPath) {
      files.set(dirPath, "dir");
    },
    async copyFile(srcPath, destPath) {
      const content = files.get(srcPath);
      if (content !== undefined) files.set(destPath, content);
    },
    async unlink(filePath) {
      files.delete(filePath);
    },
  };
  return bridge;
}

/**
 * The Linux lane for engine logic. A Windows host serves the real daemon IPC only on its named
 * pipe, so there the engine and test daemons use the host platform instead.
 */
const TEST_PLATFORM_INFO =
  process.platform === "win32"
    ? detectPlatform()
    : detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" });

const RELEASE_SHA = "a".repeat(64);
const DENO_SHA = "b".repeat(64);
const CHANNEL_SHA = "c".repeat(64);
const MANIFEST_SHA = "d".repeat(64);

function signedRelease(version = "1.1.0"): ResolvedProductionRelease {
  const release = {
    channel: {
      rollbackReferences: {
        targetVersion: "0.9.0",
        minSafeVersion: "0.9.0",
        rollbackSha256: RELEASE_SHA,
      },
    },
    manifest: {},
    version,
    releaseAsset: {
      filename: `resin-${version}.tar.gz`,
      platform: "linux",
      arch: "x64",
      isWsl: false,
      sizeBytes: 10,
      sha256: RELEASE_SHA,
      path: `resin-${version}.tar.gz`,
    },
    releaseAssetUrl: `https://dist.resin.sh/${version}/resin.tar.gz`,
    denoAsset: {
      filename: "deno.zip",
      platform: "linux",
      arch: "x64",
      isWsl: false,
      sizeBytes: 10,
      sha256: DENO_SHA,
      path: "deno.zip",
      url: "https://dist.resin.sh/deno.zip",
    },
    provenance: {
      version,
      channelUrl: "https://dist.resin.sh/channels.json",
      manifestUrl: `https://dist.resin.sh/${version}/manifest.json`,
      channelSha256: CHANNEL_SHA,
      manifestSha256: MANIFEST_SHA,
      releaseAssetUrl: `https://dist.resin.sh/${version}/resin.tar.gz`,
      releaseAssetSha256: RELEASE_SHA,
      releaseAssetSizeBytes: 10,
      signingKeyIds: ["release-key-1"],
      deno: {
        version: "2.2.0",
        url: "https://dist.resin.sh/deno.zip",
        sha256: DENO_SHA,
        executable: "deno",
      },
    },
  };
  return release as unknown as ResolvedProductionRelease;
}

function installedMetadata(version: string): string {
  const release = signedRelease(version);
  return JSON.stringify({
    version,
    sha256: release.provenance.releaseAssetSha256,
    provenance: release.provenance,
  });
}
function installedTreeDigest(files: Record<string, string>): string {
  const treeHash = crypto.createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    const content = Buffer.from(files[relativePath]!, "utf8");
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    treeHash.update(`${relativePath}\0${content.length}\0${contentHash}\n`, "utf8");
  }
  return treeHash.digest("hex");
}

interface TrustedInstalledRecord {
  readonly daemon: string;
  readonly metadata: string;
  readonly record: string;
}

function trustedInstalledRecord(version: string): TrustedInstalledRecord {
  const daemon = `daemon-${version}`;
  const metadata = installedMetadata(version);
  const files = { "bin/resin-daemon": daemon, "version.json": metadata };
  const release = signedRelease(version);
  return {
    daemon,
    metadata,
    record: JSON.stringify({
      schemaVersion: 1,
      version,
      physicalVersion: version,
      channel: "stable",
      treeSha256: installedTreeDigest(files),
      filePaths: Object.keys(files).sort(),
      provenance: release.provenance,
    }),
  };
}

function createEngineFixture(
  options: {
    currentVersion?: string;
    targetVersion?: string;
    policy?: unknown;
    sessionActivity?: UpdateEngineOptions["sessionActivity"];
    healthProbe?: UpdateEngineOptions["healthProbe"];
    resolveRelease?: UpdateEngineOptions["resolveRelease"];
    acquireLock?: UpdateEngineOptions["acquireLock"];
    initialFiles?: Record<string, string>;
    failJournalWrites?: () => boolean;
    failFirstStart?: boolean;
    /** Fails this many service starts in a row (the candidate, then the rollback restart). */
    failStartAttempts?: number;
    downloadAsset?: UpdateEngineOptions["downloadAsset"];
    onSnapshot?: UpdateEngineOptions["onSnapshot"];
    useDefaultHealthProbe?: boolean;
    failStatusAfter?: number;
    homeDir?: string;
    customFetch?: typeof fetch;
    removeVersion?: UpdateEngineOptions["removeVersion"];
    logger?: UpdateEngineOptions["logger"];
  } = {},
) {
  const homeDir = options.homeDir ?? path.resolve("/home/update-test");
  const resinHome = path.join(homeDir, ".resin");
  const versionPath = path.join(resinHome, "version.json");
  const configPath = path.join(resinHome, "config.json");
  const currentVersion = options.currentVersion ?? "1.0.0";
  const targetVersion = options.targetVersion ?? "1.1.0";
  const rollbackVersion = "0.9.0";
  const rollbackDir = path.join(resinHome, "versions", `v${rollbackVersion}`);
  const rollbackTrust = trustedInstalledRecord(rollbackVersion);
  const originalMetadata = JSON.stringify({
    version: currentVersion,
    previousVersion: rollbackVersion,
  });
  const fsBridge = createMockFsBridge({
    [versionPath]: originalMetadata,
    [path.join(rollbackDir, "version.json")]: rollbackTrust.metadata,
    [path.join(rollbackDir, "bin", "resin-daemon")]: rollbackTrust.daemon,
    [path.join(resinHome, "updates", "trusted-releases", `v${rollbackVersion}.json`)]:
      rollbackTrust.record,
    ...options.initialFiles,
  });
  const writeFile = fsBridge.writeFile.bind(fsBridge);
  fsBridge.writeFile = async (filePath, content) => {
    if (path.basename(filePath) === "journal.json" && options.failJournalWrites?.()) {
      throw new Error("simulated journal write failure");
    }
    await writeFile(filePath, content);
  };
  const events: string[] = [];
  let activeVersion = currentVersion;
  const downloadAsset = vi.fn(async (request) => {
    if (options.downloadAsset) return options.downloadAsset(request);
    events.push(`download:${request.asset.filename}`);
    return {
      path: path.join(resinHome, "downloads", request.asset.filename),
      sha256: request.asset.sha256,
      sizeBytes: request.asset.sizeBytes,
      verified: true,
    };
  });
  const installRelease = vi.fn(async (request) => {
    events.push(`install:${request.version}`);
    const versionDir = path.join(resinHome, "versions", `v${request.version}`);
    const daemonPath = path.join(versionDir, "bin", "resin-daemon");
    const metadataPath = path.join(versionDir, "version.json");
    await fsBridge.writeFile(daemonPath, `daemon-${request.version}`);
    await fsBridge.writeFile(
      metadataPath,
      JSON.stringify({
        version: request.version,
        sha256: request.provenance?.releaseAssetSha256 ?? RELEASE_SHA,
        provenance: request.provenance,
      }),
    );
    return {
      version: request.version,
      versionDir,
      installedFiles: [daemonPath, metadataPath],
      entryPoints: { daemon: daemonPath, mcpShim: "mcp", cli: "cli", deno: "deno" },
    };
  });
  const switchVersion = vi.fn(async (request) => {
    events.push(`switch:${request.targetVersion}`);
    const previousVersion = activeVersion;
    activeVersion = request.targetVersion;
    return {
      activeVersion,
      previousVersion,
      activePath: path.join(resinHome, "current"),
      rollbackRetained: true,
    };
  });
  let startAttempts = 0;
  let statusCalls = 0;
  const serviceManager = {
    async stop() {
      events.push("stop");
    },
    async start() {
      startAttempts += 1;
      events.push("start");
      if (options.failFirstStart && startAttempts === 1) {
        throw new Error("service manager start failed");
      }
      if (options.failStartAttempts !== undefined && startAttempts <= options.failStartAttempts) {
        throw new Error("service manager start failed");
      }
    },
    async status() {
      statusCalls += 1;
      if (options.failStatusAfter !== undefined && statusCalls >= options.failStatusAfter) {
        throw new Error("service status permission denied");
      }
      return {
        installed: true,
        active: true,
        enabled: true,
        serviceName: "resin",
        unitPath: "/unit",
      };
    },
  };
  const engine = new UpdateEngine({
    homeDir,
    resinHome,
    fsBridge,
    configPath,
    platformInfo: TEST_PLATFORM_INFO,
    policy: options.policy,
    acquireLock:
      options.acquireLock ??
      (async () => ({
        async release() {},
      })),
    resolveRelease: options.resolveRelease ?? (async () => signedRelease(targetVersion)),
    downloadAsset,
    installRelease,
    switchVersion,
    readActiveVersion: async () => activeVersion,
    removeVersion: async (versionDir) => {
      events.push(`remove:${path.basename(versionDir)}`);
      await options.removeVersion?.(versionDir);
    },
    logger: options.logger ?? (() => {}),
    serviceManager,
    sessionActivity: options.sessionActivity ?? (async () => false),
    healthProbe: options.useDefaultHealthProbe
      ? undefined
      : (options.healthProbe ??
        (async () => ({
          serviceActive: true,
          ipcResponsive: true,
          mcpResponsive: true,
          recoveryBreakerTripped: false,
        }))),
    probationMs: 0,
    clock: () => Date.parse("2026-08-28T00:00:00.000Z"),
    onSnapshot: options.onSnapshot,
    customFetch: options.customFetch,
  });
  return {
    engine,
    events,
    fsBridge,
    resinHome,
    versionPath,
    configPath,
    originalMetadata,
    downloadAsset,
    installRelease,
    switchVersion,
    get activeVersion() {
      return activeVersion;
    },
  };
}

describe("UpdateEngine staging, activation, and rollback", () => {
  it("verifies and stages both signed assets before stopping and atomically activating", async () => {
    const fixture = createEngineFixture();

    const result = await fixture.engine.run({ mode: "background" });
    expect(result).toMatchObject({
      success: true,
      status: "activated",
      currentVersion: "1.0.0",
      activeVersion: "1.1.0",
      staged: true,
      activated: true,
      healthGatePassed: true,
    });
    expect(fixture.events).toEqual([
      "download:resin-1.1.0.tar.gz",
      "download:deno.zip",
      "install:1.1.0",
      "stop",
      "switch:1.1.0",
      "start",
    ]);
    const metadata = JSON.parse((await fixture.fsBridge.readFile(fixture.versionPath))!);
    expect(metadata).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
    const status = await readUpdateStatusSnapshot({
      resinHome: fixture.resinHome,
      fsBridge: fixture.fsBridge,
    });
    expect(status).toMatchObject({
      currentVersion: "1.1.0",
      targetVersion: "1.1.0",
      pendingVersion: null,
      lastResult: "activated",
    });
  });

  it("uses one shared lock and refuses a concurrent manual run while background staging holds it", async () => {
    let held = false;
    const labels: Array<string | undefined> = [];
    const acquireLock: NonNullable<UpdateEngineOptions["acquireLock"]> = async (options) => {
      labels.push(options.label);
      if (held) throw new UpdateLockUnavailableError(options.lockPath!, null, options.timeoutMs!);
      held = true;
      return {
        async release() {
          held = false;
        },
      };
    };
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let resolverEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolverEntered = resolve;
    });
    const first = createEngineFixture({
      acquireLock,
      resolveRelease: async () => {
        resolverEntered();
        await resolverGate;
        return signedRelease();
      },
    });
    const second = createEngineFixture({ acquireLock });

    const background = first.engine.run({ mode: "background" });
    await entered;
    const manual = await second.engine.run({ mode: "manual" });
    releaseResolver();
    await background;

    expect(manual.status).toBe("locked");
    expect(labels).toEqual(["background-update", "manual-upgrade"]);
  });

  it("keeps the staged version pending and never stops service when sessions are active", async () => {
    const fixture = createEngineFixture({
      sessionActivity: async () => ({ state: "active", activeCount: 2 }),
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result).toMatchObject({
      success: true,
      status: "activation-deferred",
      deferralReason: "active-sessions",
      pendingVersion: "1.1.0",
      staged: true,
      activated: false,
    });
    expect(fixture.events).not.toContain("stop");
    expect(fixture.events).not.toContain("switch:1.1.0");
    expect(fixture.activeVersion).toBe("1.0.0");
  });

  it("rejects a corrupt channel signature before download or staging", async () => {
    const fixture = createEngineFixture({
      resolveRelease: async () => {
        throw new Error("Ed25519 channel signature verification failed");
      },
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("signature verification failed");
    expect(fixture.downloadAsset).not.toHaveBeenCalled();
    expect(fixture.installRelease).not.toHaveBeenCalled();
  });

  it("records offline deferral without staging, stopping, or spinning", async () => {
    const offline = new Error("fetch failed");
    Object.assign(offline, { code: "ENOTFOUND" });
    const fixture = createEngineFixture({
      resolveRelease: async () => {
        throw offline;
      },
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result).toMatchObject({ status: "offline", deferralReason: "offline" });
    expect(fixture.events).toEqual([]);
    const status = await readUpdateStatusSnapshot({
      resinHome: fixture.resinHome,
      fsBridge: fixture.fsBridge,
    });
    expect(status?.lastResult).toBe("offline");
  });

  it("rolls back exact metadata and service on a crash-loop, quarantines, and refuses repeat", async () => {
    const fixture = createEngineFixture({
      healthProbe: async () => ({
        serviceActive: false,
        ipcResponsive: false,
        mcpResponsive: false,
        recoveryBreakerTripped: true,
        message: "recovery breaker tripped after crash loop",
      }),
    });

    const failed = await fixture.engine.run({ mode: "background" });

    expect(failed).toMatchObject({
      success: false,
      status: "rolled-back",
      rolledBack: true,
      quarantined: true,
      activeVersion: "1.0.0",
    });
    expect(fixture.events).toContain("switch:1.1.0");
    expect(fixture.events).toContain("switch:1.0.0");
    expect(await fixture.fsBridge.readFile(fixture.versionPath)).toBe(fixture.originalMetadata);
    expect(failed.snapshot.quarantine).toEqual([
      expect.objectContaining({ version: "1.1.0", channel: "stable" }),
    ]);

    fixture.events.length = 0;
    const repeated = await fixture.engine.run({ mode: "manual", force: true });
    expect(repeated.status).toBe("quarantined");
    expect(fixture.events).toEqual([]);
  });

  it("honors a channel override but never downgrades unless policy allows it", async () => {
    const channels: string[] = [];
    const fixture = createEngineFixture({
      currentVersion: "2.0.0",
      targetVersion: "1.9.0",
      resolveRelease: async (options) => {
        channels.push(options.channel ?? "");
        return signedRelease("1.9.0");
      },
    });

    const result = await fixture.engine.run({ mode: "manual", channel: "beta", force: true });

    expect(channels).toEqual(["beta"]);
    expect(result).toMatchObject({
      status: "downgrade-blocked",
      channel: "beta",
      currentVersion: "2.0.0",
      targetVersion: "1.9.0",
    });
    expect(fixture.installRelease).not.toHaveBeenCalled();
    expect(fixture.switchVersion).not.toHaveBeenCalled();
  });
  it("rolls back before best-effort quarantine when journal persistence fails", async () => {
    let failJournal = false;
    const fixture = createEngineFixture({
      failJournalWrites: () => failJournal,
      healthProbe: async () => {
        failJournal = true;
        return {
          serviceActive: false,
          ipcResponsive: false,
          mcpResponsive: false,
          recoveryBreakerTripped: true,
          message: "candidate crash loop",
        };
      },
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result).toMatchObject({
      status: "rolled-back",
      rolledBack: true,
      quarantined: true,
      activeVersion: "1.0.0",
    });
    expect(fixture.events.indexOf("switch:1.0.0")).toBeGreaterThan(
      fixture.events.indexOf("switch:1.1.0"),
    );
    expect(fixture.events.at(-1)).toBe("start");
  });

  it("rolls back service-manager failures without quarantining the signed release", async () => {
    const fixture = createEngineFixture({ failFirstStart: true });

    const result = await fixture.engine.run({ mode: "manual" });

    expect(result).toMatchObject({
      status: "rolled-back",
      rolledBack: true,
      quarantined: false,
      activeVersion: "1.0.0",
    });
    expect(result.snapshot.quarantine).toEqual([]);
    expect(fixture.events.filter((event) => event === "start")).toHaveLength(2);
  });

  it("does not quarantine a candidate when the local probation probe cannot run", async () => {
    const fixture = createEngineFixture({
      useDefaultHealthProbe: true,
      failStatusAfter: 2,
    });

    const result = await fixture.engine.run({ mode: "manual" });

    expect(result).toMatchObject({
      status: "rolled-back",
      rolledBack: true,
      quarantined: false,
    });
    expect(result.error).toContain("health probe infrastructure failed");
    expect(result.snapshot.quarantine).toEqual([]);
  });

  it("quarantines a candidate whose daemon never becomes reachable so it is not retried", async () => {
    const fixture = createEngineFixture({ useDefaultHealthProbe: true });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result).toMatchObject({
      status: "rolled-back",
      rolledBack: true,
      quarantined: true,
    });
    expect(result.error).toContain("IPC/MCP probe failed");
    expect(result.snapshot.quarantine).toEqual([expect.objectContaining({ version: "1.1.0" })]);

    const retry = await fixture.engine.run({ mode: "background" });
    expect(retry.status).toBe("quarantined");
    expect(fixture.events.filter((event) => event === "switch:1.1.0")).toHaveLength(1);
  });

  describe("probation health gate against a real daemon IPC health response", () => {
    async function runAgainstCandidateReporting(daemonVersion: string) {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-health-gate-"));
      const platformInfo = TEST_PLATFORM_INFO;
      // SAFETY: Mock supervisor implements the subset of DaemonSupervisor the IPC health path reads.
      const supervisor = {
        getConfig() {
          return {};
        },
        async getHealth() {
          return {
            status: "fully-ready",
            uptimeSeconds: 1,
            startedAt: Date.now(),
            version: daemonVersion,
            modules: {},
            timestamp: Date.now(),
          };
        },
      } as unknown as DaemonSupervisor;
      const server = new IpcServer({
        supervisor,
        socketPath: resolvePlatformPaths({ home: homeDir, platformInfo }).socketPath,
      });
      try {
        await server.start();
        const fixture = createEngineFixture({
          useDefaultHealthProbe: true,
          homeDir,
          currentVersion: "1.0.92",
          targetVersion: "1.0.93",
          customFetch: (async () => Response.json({ status: "ok" })) as typeof fetch,
        });
        return await fixture.engine.run({ mode: "manual" });
      } finally {
        await server.stop().catch(() => {});
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    }

    it("activates a candidate whose daemon reports the target release version", async () => {
      const result = await runAgainstCandidateReporting("1.0.93");

      expect(result.status).toBe("activated");
      expect(result.error).toBeUndefined();
    });

    it("rolls back a candidate whose daemon reports a package version instead of the release", async () => {
      const result = await runAgainstCandidateReporting("0.1.0");

      expect(result).toMatchObject({ status: "rolled-back", rolledBack: true });
      expect(result.error).toContain("daemon reports v0.1.0 instead of v1.0.93");
    });
  });

  it("preserves and reports concurrent configuration changes during rollback", async () => {
    const configPath = path.join(path.resolve("/home/update-test"), ".resin", "config.json");
    interface BridgeHolder {
      current?: ConfigFsBridge;
    }
    const bridge: BridgeHolder = {};
    const fixture = createEngineFixture({
      initialFiles: {
        [configPath]: JSON.stringify({ authToken: "persistent-secret", updates: {} }),
      },
      healthProbe: async () => {
        if (!bridge.current) {
          throw new Error("fixture filesystem bridge was not initialized");
        }
        await bridge.current.writeFile(
          configPath,
          JSON.stringify({ authToken: "rotated-secret", updates: { channel: "beta" } }),
        );
        return {
          serviceActive: false,
          ipcResponsive: false,
          mcpResponsive: false,
          recoveryBreakerTripped: true,
        };
      },
    });
    bridge.current = fixture.fsBridge;

    const result = await fixture.engine.run({ mode: "manual" });

    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("concurrent user configuration was preserved");
    expect(await fixture.fsBridge.readFile(configPath)).toContain("rotated-secret");
  });

  it("recovers an interrupted journal write and continues from active metadata", async () => {
    const journalPath = path.join(path.resolve("/home/update-test"), ".resin", "journal.json");
    const fixture = createEngineFixture({
      currentVersion: "1.1.0",
      targetVersion: "1.1.0",
      initialFiles: { [journalPath]: '{"schemaVersion":' },
    });

    const result = await fixture.engine.run({ mode: "manual" });

    expect(result.status).toBe("already-current");
    expect(
      [...fixture.fsBridge.files.keys()].some((filePath) =>
        path.basename(filePath).startsWith("journal.corrupt-"),
      ),
    ).toBe(true);
    expect(
      await readUpdateStatusSnapshot({
        resinHome: fixture.resinHome,
        fsBridge: fixture.fsBridge,
      }),
    ).not.toBeNull();
  });

  it("treats snapshot callbacks as best-effort observers", async () => {
    const fixture = createEngineFixture({
      onSnapshot: async () => {
        throw new Error("snapshot observer unavailable");
      },
    });

    const result = await fixture.engine.run({ mode: "manual" });

    expect(result).toMatchObject({ status: "activated", success: true });
    expect(fixture.activeVersion).toBe("1.1.0");
  });

  it("rejects a rollback whose self-consistent installed provenance was forged", async () => {
    const trusted = createEngineFixture();
    const rollback = await trusted.engine.run({ mode: "manual", rollback: true });
    expect(rollback).toMatchObject({
      status: "rolled-back",
      success: true,
      activeVersion: "0.9.0",
    });
    expect(trusted.events).toContain("switch:0.9.0");

    const provenancePath = path.join(
      path.resolve("/home/update-test"),
      ".resin",
      "versions",
      "v0.9.0",
      "version.json",
    );
    const forgedSha = "f".repeat(64);
    const untrusted = createEngineFixture({
      initialFiles: {
        [provenancePath]: JSON.stringify({
          version: "0.9.0",
          sha256: forgedSha,
          provenance: {
            ...signedRelease("0.9.0").provenance,
            channelSha256: forgedSha,
            manifestSha256: forgedSha,
            releaseAssetSha256: forgedSha,
            signingKeyIds: ["attacker-key"],
          },
        }),
      },
    });
    const rejected = await untrusted.engine.run({ mode: "manual", rollback: true });
    expect(rejected.stepsCompleted).toContain("rollback_provenance_rejected");
    expect(untrusted.events).not.toContain("stop");
    expect(untrusted.events).not.toContain("switch:0.9.0");
  });

  it("stages a forced active-version reinstall immutably and keeps backups private", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-update-review-"));
    const resinHome = path.join(homeDir, ".resin");
    const configPath = path.join(resinHome, "config.json");
    const activeDir = path.join(resinHome, "versions", "v1.0.0");
    const events: string[] = [];
    let candidateDir = "";
    try {
      await fs.mkdir(activeDir, { recursive: true });
      await fs.writeFile(path.join(activeDir, "marker"), "original");
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0", previousVersion: "0.9.0" }),
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({
          authToken: "persistent-secret",
          updates: { channel: "stable", autoUpdate: true },
        }),
      );
      const release = signedRelease("1.0.0");
      const installRelease = vi.fn(async (request) => {
        candidateDir = path.join(resinHome, "versions", `v${request.version}`);
        expect(request.version).not.toBe("1.0.0");
        expect(request.force).toBe(false);
        expect(await fs.readFile(path.join(activeDir, "marker"), "utf8")).toBe("original");
        await fs.mkdir(candidateDir, { recursive: true });
        await fs.writeFile(path.join(candidateDir, "marker"), "candidate");
        await fs.writeFile(
          path.join(candidateDir, "version.json"),
          JSON.stringify({
            version: request.version,
            sha256: release.provenance.releaseAssetSha256,
            provenance: release.provenance,
          }),
        );
        return {
          version: request.version,
          versionDir: candidateDir,
          installedFiles: [],
          entryPoints: { daemon: "daemon", mcpShim: "mcp", cli: "cli" },
        };
      });
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath,
        platformInfo: TEST_PLATFORM_INFO,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease,
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: true,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("stop");
            expect(await fs.readFile(path.join(activeDir, "marker"), "utf8")).toBe("original");
            expect(await fs.readFile(path.join(candidateDir, "marker"), "utf8")).toBe("candidate");
            const [backupName] = await fs.readdir(path.join(resinHome, "backups"));
            const backupPath = path.join(resinHome, "backups", backupName!);
            const configBackupPath = path.join(backupPath, "config.json");
            // NTFS has no mode bits: on Windows the backups inherit the Resin home's private DACL.
            if (process.platform !== "win32") {
              expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o700);
              expect((await fs.stat(configBackupPath)).mode & 0o777).toBe(0o600);
            }
            expect(await fs.readFile(configBackupPath, "utf8")).not.toContain("authToken");
          },
          async start() {
            events.push("start");
          },
        },
        sessionActivity: async () => false,
        healthProbe: async () => ({
          serviceActive: true,
          ipcResponsive: true,
          mcpResponsive: true,
          recoveryBreakerTripped: false,
        }),
        probationMs: 0,
      });

      const result = await engine.run({ mode: "manual", force: true });

      expect(result).toMatchObject({ status: "activated", success: true });
      expect(events).toHaveLength(3);
      expect(events[0]).toBe("stop");
      expect(events[1]).toMatch(/^switch:1\.0\.0\+resin-reinstall\./);
      expect(events[2]).toBe("start");
      expect(await fs.readFile(path.join(activeDir, "marker"), "utf8")).toBe("original");
      expect(await fs.readFile(path.join(candidateDir, "marker"), "utf8")).toBe("candidate");
      expect(
        await fs
          .access(path.join(resinHome, "updates", "reinstall-recovery.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await fs.readdir(path.join(resinHome, "backups"))).toEqual([]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted same-version pointer switch before doing more work", async () => {
    const homeDir = path.resolve("/home/reinstall-recovery");
    const resinHome = path.join(homeDir, ".resin");
    const candidateVersion = "1.0.0+resin-reinstall.interrupted";
    const recoveryPath = path.join(resinHome, "updates", "reinstall-recovery.json");
    const bridge = createMockFsBridge({
      [path.join(resinHome, "version.json")]: JSON.stringify({ version: "1.0.0" }),
      [recoveryPath]: JSON.stringify({
        schemaVersion: 1,
        targetVersion: "1.0.0",
        candidateVersion,
        rollbackVersion: "1.0.0",
        phase: "activated",
      }),
    });
    let activeVersion = candidateVersion;
    const switches: string[] = [];
    const engine = new UpdateEngine({
      homeDir,
      resinHome,
      fsBridge: bridge,
      platformInfo: TEST_PLATFORM_INFO,
      acquireLock: async () => ({ async release() {} }),
      resolveRelease: async () => signedRelease("1.0.0"),
      readActiveVersion: async () => activeVersion,
      switchVersion: async ({ targetVersion }) => {
        switches.push(targetVersion);
        const previousVersion = activeVersion;
        activeVersion = targetVersion;
        return {
          activeVersion,
          previousVersion,
          activePath: path.join(resinHome, "current"),
          rollbackRetained: true,
        };
      },
    });

    const result = await engine.run({ mode: "manual" });

    expect(result.status).toBe("already-current");
    expect(activeVersion).toBe("1.0.0");
    expect(switches).toEqual(["1.0.0"]);
    expect(await bridge.readFile(recoveryPath)).toBeNull();
  });

  it("uses the real authenticated IPC health response to acquire a drain before switching", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let serviceActive = true;
    let shutdownStatus: "fully-ready" | "stopping" | "stopped" = "fully-ready";
    let activeSessions = 1;
    let drainPolls = 0;
    let completeDrain: (() => void) | undefined;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        if (shutdownStatus === "stopping") {
          // Real delay is required here to prove IPC latency may exceed the polling cadence.
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 10);
          await promise;
          drainPolls += 1;
          if (drainPolls >= 3) completeDrain?.();
        }
        return {
          status: shutdownStatus,
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            trajectory: {
              status: shutdownStatus === "stopped" ? "stopped" : "ready",
              details: { activeSessions, activeToolExecutions: 0 },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        shutdownStatus = "stopping";
        await new Promise<void>((resolve) => {
          completeDrain = () => {
            activeSessions = 0;
            shutdownStatus = "stopped";
            events.push("drain-complete");
            resolve();
          };
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(
            metadataPath,
            JSON.stringify({
              version: request.version,
              sha256: release.provenance.releaseAssetSha256,
              provenance: release.provenance,
            }),
          );
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "mcp", cli: "cli" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: serviceActive,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
            serviceActive = false;
          },
          async start() {
            events.push("start");
            serviceActive = true;
          },
        },
        healthProbe: async () => ({
          serviceActive: true,
          ipcResponsive: true,
          mcpResponsive: true,
          recoveryBreakerTripped: false,
        }),
        probationMs: 0,
        drainTimeoutMs: 1_000,
        healthProbeIntervalMs: 1,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("activated");
      expect(events.indexOf("ipc-drain")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("drain-complete")).toBeGreaterThan(events.indexOf("ipc-drain"));
      expect(events.indexOf("drain-complete")).toBeLessThan(events.indexOf("manager-stop"));
      expect(events.indexOf("manager-stop")).toBeLessThan(events.indexOf("switch:1.1.0"));
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  function yieldEventLoop(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    return promise;
  }

  it("proceeds to activation when daemon accepts gracefulShutdown, closes socket, and service reaches inactive", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-disconnect-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let serviceActive = true;
    let serverStopped = false;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: {
                activeSessions: 1,
              },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        setImmediate(async () => {
          if (!serverStopped) {
            serverStopped = true;
            await server.stop().catch(() => {});
            serviceActive = false;
            events.push("daemon-exited");
          }
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: serviceActive,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
            serviceActive = false;
          },
          async start() {
            events.push("manager-start");
            serviceActive = true;
          },
        },
        healthProbe: async () => ({
          serviceActive: true,
          ipcResponsive: true,
          mcpResponsive: true,
          recoveryBreakerTripped: false,
        }),
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 1,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("activated");
      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toContain("session_drain_completed");
      expect(events).toContain("ipc-drain");
      expect(events).toContain("daemon-exited");
      expect(events.indexOf("daemon-exited")).toBeLessThan(events.indexOf("manager-stop"));
      expect(events.indexOf("manager-stop")).toBeLessThan(events.indexOf("switch:1.1.0"));
      expect(events.indexOf("switch:1.1.0")).toBeLessThan(events.indexOf("manager-start"));
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("defers activation when daemon accepts gracefulShutdown and disconnects, but service remains active past timeout", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-active-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let serverStopped = false;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: {
                activeSessions: 1,
              },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        setImmediate(async () => {
          if (!serverStopped) {
            serverStopped = true;
            await server.stop().catch(() => {});
          }
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: true,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
          },
          async start() {
            events.push("manager-start");
          },
        },
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 10,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("activation-deferred");
      expect(result.deferralReason).toBe("active-sessions");
      expect(result.pendingVersion).toBe("1.1.0");
      expect(result.stepsCompleted).toContain("activation_deferred");
      expect(events).not.toContain("switch:1.1.0");
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("never drains in-flight work for background updates and retries later instead", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-background-idle-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC health tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: { activeSessions: 2 },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
      },
    } as DaemonSupervisor;
    const server = new IpcServer({ supervisor, socketPath: platformPaths.socketPath });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: true,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
          },
          async start() {
            events.push("manager-start");
          },
        },
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 10,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "background" });

      expect(result).toMatchObject({
        success: true,
        status: "activation-deferred",
        deferralReason: "active-sessions",
        deferralCode: "active_sessions",
        pendingVersion: "1.1.0",
        staged: true,
      });
      expect(events).toEqual([]);
      await expect(readUpdateStatusSnapshot({ resinHome })).resolves.toMatchObject({
        lastResult: "activation-deferred",
        pendingVersion: "1.1.0",
      });
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("drains active work once background activation has been deferred past the limit", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-deferral-limit-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let serviceActive = true;
    let shutdownStatus: "fully-ready" | "stopping" | "stopped" = "fully-ready";
    let activeSessions = 2;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC drain tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: shutdownStatus,
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            trajectory: {
              status: shutdownStatus === "stopped" ? "stopped" : "ready",
              details: { activeSessions },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        activeSessions = 0;
        shutdownStatus = "stopped";
      },
    } as DaemonSupervisor;
    const server = new IpcServer({ supervisor, socketPath: platformPaths.socketPath });
    const firstDeferralAt = Date.parse("2026-10-01T00:00:00.000Z");
    let now = firstDeferralAt;
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(
            metadataPath,
            JSON.stringify({
              version: request.version,
              sha256: release.provenance.releaseAssetSha256,
              provenance: release.provenance,
            }),
          );
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "mcp", cli: "cli" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: serviceActive,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
            serviceActive = false;
          },
          async start() {
            events.push("start");
            serviceActive = true;
          },
        },
        healthProbe: async () => ({
          serviceActive: true,
          ipcResponsive: true,
          mcpResponsive: true,
          recoveryBreakerTripped: false,
        }),
        probationMs: 0,
        drainTimeoutMs: 1_000,
        healthProbeIntervalMs: 1,
        maxActivationDeferralMs: 24 * 60 * 60_000,
        clock: () => now,
        sleep: async () => yieldEventLoop(),
      });
      const deferral = {
        targetVersion: "1.1.0",
        since: new Date(firstDeferralAt).toISOString(),
        activeCount: 2,
      };

      const first = await engine.run({ mode: "background" });
      expect(first).toMatchObject({ status: "activation-deferred", pendingVersion: "1.1.0" });
      await expect(readUpdateStatusSnapshot({ resinHome })).resolves.toMatchObject({ deferral });

      // Within the limit a later retry still leaves the busy daemon alone and keeps the start time.
      now += 23 * 60 * 60_000;
      const second = await engine.run({ mode: "background" });
      expect(second.status).toBe("activation-deferred");
      expect(events).toEqual([]);
      await expect(readUpdateStatusSnapshot({ resinHome })).resolves.toMatchObject({ deferral });

      now += 2 * 60 * 60_000;
      const third = await engine.run({ mode: "background" });

      expect(third).toMatchObject({ status: "activated", activeVersion: "1.1.0" });
      expect(third.stepsCompleted).toContain("deferral_limit_reached");
      expect(events.slice(0, 3)).toEqual(["ipc-drain", "manager-stop", "switch:1.1.0"]);
      await expect(readUpdateStatusSnapshot({ resinHome })).resolves.toMatchObject({
        lastResult: "activated",
        deferral: null,
      });
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rolls back and quarantines a candidate whose daemon does not report the target version", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-version-gate-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let activeVersion = "1.0.0";
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC health tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          // The previous build keeps answering, e.g. because the cutover did not take effect.
          version: "1.0.0",
          modules: {},
          timestamp: Date.now(),
        };
      },
      async stop() {},
    } as DaemonSupervisor;
    const server = new IpcServer({ supervisor, socketPath: platformPaths.socketPath });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        customFetch: async () => new Response("unavailable", { status: 503 }),
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          const previousVersion = activeVersion;
          activeVersion = request.targetVersion;
          return {
            activeVersion,
            previousVersion,
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => activeVersion,
        removeVersion: async (versionDir) => {
          events.push(`remove:${path.basename(versionDir)}`);
        },
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: true,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
          },
          async start() {
            events.push("manager-start");
          },
        },
        sessionActivity: async () => false,
        probationMs: 0,
        healthProbeIntervalMs: 1,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "background" });

      expect(result).toMatchObject({
        success: false,
        status: "rolled-back",
        rolledBack: true,
        quarantined: true,
        activeVersion: "1.0.0",
      });
      expect(result.error).toContain("daemon reports v1.0.0 instead of v1.1.0");
      expect(events).toContain("switch:1.1.0");
      expect(events.indexOf("switch:1.0.0")).toBeGreaterThan(events.indexOf("switch:1.1.0"));
      expect(events).toContain("remove:v1.1.0");
      await expect(readUpdateStatusSnapshot({ resinHome })).resolves.toMatchObject({
        quarantine: [expect.objectContaining({ version: "1.1.0" })],
      });
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("defers activation as session-activity-unavailable when daemon disconnects post-drain and service status check throws", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-status-fail-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let initialStatusChecked = false;
    let serverStopped = false;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: {
                activeSessions: 1,
              },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        setImmediate(async () => {
          if (!serverStopped) {
            serverStopped = true;
            await server.stop().catch(() => {});
          }
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            if (!initialStatusChecked) {
              initialStatusChecked = true;
              return {
                installed: true,
                active: true,
                enabled: true,
                serviceName: "resin",
                unitPath: "/unit",
              };
            }
            throw new Error("systemd status inspection failed");
          },
          async stop() {
            events.push("manager-stop");
          },
          async start() {
            events.push("manager-start");
          },
        },
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 1,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("activation-deferred");
      expect(result.deferralReason).toBe("session-activity-unavailable");
      expect(result.pendingVersion).toBe("1.1.0");
      expect(result.stepsCompleted).toContain("activation_deferred");
      expect(events).not.toContain("switch:1.1.0");
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("defers activation as session-activity-unavailable when post-drain service status probe hangs until timeout", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-status-hang-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let initialStatusChecked = false;
    let serverStopped = false;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: {
                activeSessions: 1,
              },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        setImmediate(async () => {
          if (!serverStopped) {
            serverStopped = true;
            await server.stop().catch(() => {});
          }
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            if (!initialStatusChecked) {
              initialStatusChecked = true;
              return {
                installed: true,
                active: true,
                enabled: true,
                serviceName: "resin",
                unitPath: "/unit",
              };
            }
            // Hung status call returns promise that never resolves
            const { promise } = Promise.withResolvers<ServiceStatusInfo>();
            return promise;
          },
          async stop() {
            events.push("manager-stop");
          },
          async start() {
            events.push("manager-start");
          },
        },
        probationMs: 0,
        drainTimeoutMs: 30,
        healthProbeIntervalMs: 5,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("activation-deferred");
      expect(result.deferralReason).toBe("session-activity-unavailable");
      expect(result.pendingVersion).toBe("1.1.0");
      expect(result.stepsCompleted).toContain("activation_deferred");
      expect(events).not.toContain("switch:1.1.0");
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("defers activation as session-activity-unavailable when pre-drain IPC communication fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-pre-drain-fail-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const events: string[] = [];
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: true,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
          },
          async start() {
            events.push("manager-start");
          },
        },
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 1,
        sleep: async () => {},
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("activation-deferred");
      expect(result.deferralReason).toBe("session-activity-unavailable");
      expect(result.pendingVersion).toBe("1.1.0");
      expect(result.stepsCompleted).toContain("activation_deferred");
      expect(events).not.toContain("switch:1.1.0");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("aborts activation when signal is aborted during post-drain inactivity polling", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-abort-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const ac = new AbortController();
    let initialStatusChecked = false;
    let serverStopped = false;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: {
                activeSessions: 1,
              },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        setImmediate(async () => {
          if (!serverStopped) {
            serverStopped = true;
            await server.stop().catch(() => {});
          }
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => ({
          activeVersion: request.targetVersion,
          previousVersion: "1.0.0",
          activePath: path.join(resinHome, "current"),
          rollbackRetained: true,
        }),
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            if (!initialStatusChecked) {
              initialStatusChecked = true;
              return {
                installed: true,
                active: true,
                enabled: true,
                serviceName: "resin",
                unitPath: "/unit",
              };
            }
            ac.abort(new Error("Update aborted by user during drain"));
            return {
              installed: true,
              active: true,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {},
          async start() {},
        },
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 1,
        sleep: async () => yieldEventLoop(),
      });

      await expect(engine.run({ mode: "manual", signal: ac.signal })).rejects.toThrow(
        "Update aborted by user during drain",
      );
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("fails activation and rolls back when authoritative serviceManager.stop fails during cutover", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-ipc-drain-stop-fail-"));
    const resinHome = path.join(homeDir, ".resin");
    const platformInfo = TEST_PLATFORM_INFO;
    const platformPaths = resolvePlatformPaths({ home: homeDir, platformInfo });
    const events: string[] = [];
    let serviceActive = true;
    let serverStopped = false;
    // SAFETY: Mock supervisor object implements subset of DaemonSupervisor required for IPC stop lifecycle tests.
    const supervisor = {
      getConfig() {
        return {};
      },
      async getHealth() {
        return {
          status: "fully-ready",
          uptimeSeconds: 1,
          startedAt: Date.now(),
          version: "1.0.0",
          modules: {
            session: {
              status: "healthy",
              details: {
                activeSessions: 1,
              },
              lastCheckTime: Date.now(),
            },
          },
          timestamp: Date.now(),
        };
      },
      async stop() {
        events.push("ipc-drain");
        setImmediate(async () => {
          if (!serverStopped) {
            serverStopped = true;
            serviceActive = false;
            events.push("daemon-exited");
            await server.stop().catch(() => {});
          }
        });
      },
    } as DaemonSupervisor;
    const server = new IpcServer({
      supervisor,
      socketPath: platformPaths.socketPath,
    });
    try {
      await fs.mkdir(resinHome, { recursive: true });
      await fs.writeFile(
        path.join(resinHome, "version.json"),
        JSON.stringify({ version: "1.0.0" }),
      );
      await server.start();
      const release = signedRelease("1.1.0");
      const engine = new UpdateEngine({
        homeDir,
        resinHome,
        configPath: path.join(resinHome, "config.json"),
        platformInfo,
        acquireLock: async () => ({ async release() {} }),
        resolveRelease: async () => release,
        downloadAsset: async (request) => ({
          path: path.join(resinHome, "downloads", request.asset.filename),
          sha256: request.asset.sha256,
          sizeBytes: request.asset.sizeBytes,
          verified: true,
        }),
        installRelease: async (request) => {
          const versionDir = path.join(resinHome, "versions", `v${request.version}`);
          const daemonPath = path.join(versionDir, "bin", "resin-daemon");
          const metadataPath = path.join(versionDir, "version.json");
          await fs.mkdir(path.dirname(daemonPath), { recursive: true });
          await fs.writeFile(daemonPath, "candidate");
          await fs.writeFile(metadataPath, JSON.stringify({ version: request.version }));
          return {
            version: request.version,
            versionDir,
            installedFiles: [daemonPath, metadataPath],
            entryPoints: { daemon: daemonPath, mcpShim: "", cli: "" },
          };
        },
        switchVersion: async (request) => {
          events.push(`switch:${request.targetVersion}`);
          return {
            activeVersion: request.targetVersion,
            previousVersion: "1.0.0",
            activePath: path.join(resinHome, "current"),
            rollbackRetained: true,
          };
        },
        readActiveVersion: async () => "1.0.0",
        serviceManager: {
          async status() {
            return {
              installed: true,
              active: serviceActive,
              enabled: true,
              serviceName: "resin",
              unitPath: "/unit",
            };
          },
          async stop() {
            events.push("manager-stop");
            throw new Error("systemctl stop failed: supervisor refusal");
          },
          async start() {
            events.push("manager-start");
          },
        },
        probationMs: 0,
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 1,
        sleep: async () => yieldEventLoop(),
      });

      const result = await engine.run({ mode: "manual" });

      expect(result.status).toBe("failed");
      expect(result.success).toBe(false);
      expect(events).toContain("manager-stop");
      expect(events).not.toContain("switch:1.1.0");
    } finally {
      await server.stop().catch(() => {});
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("UpdateEngine old release pruning", () => {
  async function createVersionsHome(versions: string[]) {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-version-gc-"));
    const resinHome = path.join(homeDir, ".resin");
    for (const version of versions) {
      await fs.mkdir(path.join(resinHome, "versions", version, "bin"), { recursive: true });
      await fs.writeFile(path.join(resinHome, "versions", version, "version.json"), "{}");
    }
    await fs.writeFile(
      path.join(resinHome, "version-state.json"),
      JSON.stringify({
        activeVersion: "1.0.0",
        previousVersion: null,
        updatedAt: "2026-08-27T00:00:00.000Z",
        installedVersions: versions.map((version) => version.slice(1)),
        provenanceByVersion: Object.fromEntries(
          versions.map((version) => [version.slice(1), { channel: "stable" }]),
        ),
      }),
    );
    return { homeDir, resinHome };
  }

  const removeForReal = async (versionDir: string) => {
    await fs.rm(versionDir, { recursive: true, force: true });
  };

  async function listVersions(resinHome: string): Promise<string[]> {
    return (await fs.readdir(path.join(resinHome, "versions"))).sort();
  }

  it("keeps only the active, previous and rollback-target versions after a healthy upgrade", async () => {
    const old = Array.from({ length: 12 }, (_, index) => `v0.1.${index}`);
    const { homeDir, resinHome } = await createVersionsHome([
      ...old,
      "v0.9.0",
      "v1.0.0",
      "v1.0.0+resin-reinstall.54d5b0120836",
      "v1.1.0",
    ]);
    try {
      // The live `current` pointer names a suffixed reinstall directory; it must survive too.
      // A junction on Windows (what Resin itself creates there); the type is ignored elsewhere.
      await fs.symlink(
        path.join(resinHome, "versions", "v1.0.0+resin-reinstall.54d5b0120836"),
        path.join(resinHome, "current"),
        "junction",
      );
      const fixture = createEngineFixture({ homeDir, removeVersion: removeForReal });

      const result = await fixture.engine.run({ mode: "background" });

      expect(result).toMatchObject({ success: true, status: "activated", activeVersion: "1.1.0" });
      expect(await listVersions(resinHome)).toEqual([
        "v0.9.0",
        "v1.0.0",
        "v1.0.0+resin-reinstall.54d5b0120836",
        "v1.1.0",
      ]);
      const state = JSON.parse(
        await fs.readFile(path.join(resinHome, "version-state.json"), "utf8"),
      );
      expect([...state.installedVersions].sort()).toEqual([
        "0.9.0",
        "1.0.0",
        "1.0.0+resin-reinstall.54d5b0120836",
        "1.1.0",
      ]);
      expect(Object.keys(state.provenanceByVersion).sort()).toEqual([
        "0.9.0",
        "1.0.0",
        "1.0.0+resin-reinstall.54d5b0120836",
        "1.1.0",
      ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps the versions live MCP gateways still run", async () => {
    const { homeDir, resinHome } = await createVersionsHome([
      "v0.5.0",
      "v0.6.0",
      "v0.9.0",
      "v1.0.0",
      "v1.1.0",
    ]);
    try {
      // A harness-owned `resin mcp` (this live test process) still runs v0.6.0.
      registerRunningGateway({ resinHome, version: "0.6.0", pid: process.pid });
      const fixture = createEngineFixture({ homeDir, removeVersion: removeForReal });

      const result = await fixture.engine.run({ mode: "background" });

      expect(result).toMatchObject({ success: true, status: "activated", activeVersion: "1.1.0" });
      expect(await listVersions(resinHome)).toEqual(["v0.6.0", "v0.9.0", "v1.0.0", "v1.1.0"]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("prunes downloaded artifacts of versions it does not retain", async () => {
    const { homeDir, resinHome } = await createVersionsHome([
      "v0.5.0",
      "v0.6.0",
      "v0.9.0",
      "v1.0.0",
      "v1.1.0",
    ]);
    const downloadsDir = path.join(resinHome, "downloads");
    try {
      registerRunningGateway({ resinHome, version: "0.6.0", pid: process.pid });
      await fs.mkdir(downloadsDir);
      const files = [
        "resin-v0.4.0-linux-x64.tar.gz",
        "resin-v0.5.0-linux-arm64.tar.gz",
        "resin-v0.6.0-linux-x64.tar.gz",
        "resin-v0.9.0-linux-x64.tar.gz",
        "resin-v1.0.0-linux-x64.tar.gz",
        "resin-v1.1.0-linux-x64.tar.gz",
        "resin-v1.1.0-linux-x64.tar.gz.download.tmp",
        // The fixture release installs from `deno.zip`; other Deno archives are stale.
        "deno.zip",
        "deno-2.9.5.zip",
        "deno-x86_64-unknown-linux-gnu.zip",
        "notes.txt",
      ];
      for (const file of files) await fs.writeFile(path.join(downloadsDir, file), "x");
      const fixture = createEngineFixture({ homeDir, removeVersion: removeForReal });

      const result = await fixture.engine.run({ mode: "background" });

      expect(result).toMatchObject({ success: true, status: "activated", activeVersion: "1.1.0" });
      expect((await fs.readdir(downloadsDir)).sort()).toEqual([
        "deno.zip",
        "notes.txt",
        "resin-v0.6.0-linux-x64.tar.gz",
        "resin-v0.9.0-linux-x64.tar.gz",
        "resin-v1.0.0-linux-x64.tar.gz",
        "resin-v1.1.0-linux-x64.tar.gz",
        "resin-v1.1.0-linux-x64.tar.gz.download.tmp",
      ]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("removes nothing when the upgrade fails its health gate and rolls back", async () => {
    const versions = ["v0.5.0", "v0.6.0", "v0.9.0", "v1.0.0", "v1.1.0"];
    const { homeDir, resinHome } = await createVersionsHome(versions);
    try {
      const fixture = createEngineFixture({
        homeDir,
        removeVersion: removeForReal,
        healthProbe: async () => ({
          serviceActive: false,
          ipcResponsive: false,
          mcpResponsive: false,
          recoveryBreakerTripped: true,
          message: "recovery breaker tripped after crash loop",
        }),
      });

      const result = await fixture.engine.run({ mode: "manual" });

      expect(result).toMatchObject({ success: false, status: "rolled-back" });
      // Only the rejected candidate itself is discarded; no older release is pruned.
      expect(fixture.events.filter((event) => event.startsWith("remove:"))).toEqual([
        "remove:v1.1.0",
      ]);
      expect(await listVersions(resinHome)).toEqual(["v0.5.0", "v0.6.0", "v0.9.0", "v1.0.0"]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("logs removal failures without failing the upgrade", async () => {
    const { homeDir, resinHome } = await createVersionsHome([
      "v0.5.0",
      "v0.6.0",
      "v0.9.0",
      "v1.0.0",
      "v1.1.0",
    ]);
    try {
      const logs: string[] = [];
      const fixture = createEngineFixture({
        homeDir,
        logger: (message) => logs.push(message),
        removeVersion: async (versionDir) => {
          if (path.basename(versionDir) === "v0.5.0") throw new Error("EBUSY: resource busy");
          await removeForReal(versionDir);
        },
      });

      const result = await fixture.engine.run({ mode: "manual" });

      expect(result).toMatchObject({ success: true, status: "activated" });
      expect(await listVersions(resinHome)).toEqual(["v0.5.0", "v0.9.0", "v1.0.0", "v1.1.0"]);
      expect(logs.join("\n")).toContain("EBUSY: resource busy");
      const state = JSON.parse(
        await fs.readFile(path.join(resinHome, "version-state.json"), "utf8"),
      );
      expect([...state.installedVersions].sort()).toEqual(["0.5.0", "0.9.0", "1.0.0", "1.1.0"]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("UpdateEngine telemetry detail", () => {
  it("reports the signed release date and the channel check duration on activation", async () => {
    const fixture = createEngineFixture({
      resolveRelease: async () => {
        const release = signedRelease("1.1.0");
        return {
          ...release,
          manifest: { ...release.manifest, releaseDate: "2026-08-27T06:00:00Z" },
        };
      },
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result).toMatchObject({
      status: "activated",
      releaseDate: "2026-08-27T06:00:00.000Z",
      checkDurationMs: 0,
    });
    expect(result.failure).toBeUndefined();
  });

  it("classifies a failed download without quarantining the release", async () => {
    const fixture = createEngineFixture({
      downloadAsset: async () => {
        throw new TypeError("unexpected end of stream from https://dist.resin.sh/1.1.0");
      },
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({
      stage: "download",
      errorCode: "TypeError",
      rollback: "not_attempted",
    });
    expect(result.quarantined).toBe(false);
  });

  it("classifies checksum and channel-signature failures as verify", async () => {
    const checksum = createEngineFixture({
      downloadAsset: async (request) => ({
        path: `/downloads/${request.asset.filename}`,
        sha256: "e".repeat(64),
        sizeBytes: 10,
        verified: true,
      }),
    });
    const signature = createEngineFixture({
      resolveRelease: async () => {
        throw new Error("Ed25519 channel signature verification failed");
      },
    });

    const staged = await checksum.engine.run({ mode: "background" });
    const resolved = await signature.engine.run({ mode: "background" });

    expect(staged.failure).toMatchObject({ stage: "verify", errorCode: "UpdateVerificationError" });
    expect(staged.quarantined).toBe(true);
    expect(resolved.failure).toMatchObject({ stage: "verify", errorCode: "verify_failed" });
  });

  it("classifies an install failure as stage", async () => {
    const fixture = createEngineFixture();
    fixture.installRelease.mockRejectedValueOnce(
      Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
    );

    const result = await fixture.engine.run({ mode: "background" });

    expect(result.failure).toMatchObject({ stage: "stage", errorCode: "ENOSPC" });
  });

  it("classifies restart and health-gate failures and whether rollback succeeded", async () => {
    const restart = createEngineFixture({ failFirstStart: true });
    const unhealthy = createEngineFixture({
      healthProbe: async () => ({
        serviceActive: false,
        ipcResponsive: false,
        mcpResponsive: false,
        recoveryBreakerTripped: true,
        message: "crash loop",
      }),
    });
    const rollbackFails = createEngineFixture({ failStartAttempts: 2 });

    const restarted = await restart.engine.run({ mode: "background" });
    const gated = await unhealthy.engine.run({ mode: "background" });
    const stuck = await rollbackFails.engine.run({ mode: "background" });

    expect(restarted).toMatchObject({ status: "rolled-back", rolledBack: true });
    expect(restarted.failure).toMatchObject({ stage: "restart", rollback: "succeeded" });
    expect(gated).toMatchObject({ status: "rolled-back", quarantined: true });
    expect(gated.failure).toMatchObject({
      stage: "health_check",
      errorCode: "CandidateHealthError",
      rollback: "succeeded",
    });
    expect(stuck).toMatchObject({ status: "failed", rolledBack: false });
    expect(stuck.failure).toMatchObject({ stage: "restart", rollback: "failed" });
  });

  it("classifies an explicit rollback failure as the rollback stage", async () => {
    const fixture = createEngineFixture({ failFirstStart: true });

    const result = await fixture.engine.run({ mode: "manual", rollback: true });

    expect(result.success).toBe(false);
    expect(result.failure).toMatchObject({ stage: "rollback" });
  });

  it("tags an error thrown while taking the lock with the lock stage", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const fixture = createEngineFixture({
      acquireLock: async () => {
        throw failure;
      },
    });

    await expect(fixture.engine.run({ mode: "background" })).rejects.toBe(failure);
    expect(updateFailureStageOf(failure)).toBe("lock");
  });

  it("reports a refused lock as a locked deferral", async () => {
    const fixture = createEngineFixture({
      acquireLock: async (options) => {
        throw new UpdateLockUnavailableError(options.lockPath!, null, 0);
      },
    });

    const result = await fixture.engine.run({ mode: "background" });

    expect(result).toMatchObject({ status: "locked", deferralCode: "locked" });
  });

  it("names what blocked activation", async () => {
    const counters = createEngineFixture({
      sessionActivity: async () => ({ state: "active", blocker: "active_tool_executions" }),
    });
    const legacy = createEngineFixture({ sessionActivity: async () => true });
    const unknown = createEngineFixture({
      sessionActivity: async () => {
        throw new Error("daemon unreachable");
      },
    });
    const noService = createEngineFixture({ failStatusAfter: 1 });

    const results = await Promise.all(
      [counters, legacy, unknown, noService].map((fixture) =>
        fixture.engine.run({ mode: "background" }),
      ),
    );

    expect(results.map((result) => result.deferralCode)).toEqual([
      "active_tool_executions",
      "active_sessions",
      "activity_unknown",
      "service_unavailable",
    ]);
  });

  it("classifies daemon work counters in drain-gate order", () => {
    const health = (details: Record<string, number>) => ({
      status: "fully-ready" as const,
      uptimeSeconds: 1,
      startedAt: 0,
      version: "1.0.0",
      modules: { session: { status: "healthy" as const, details, lastCheckTime: 0 } },
      timestamp: 0,
    });

    expect(activeWorkBlocker(health({ activeSessions: 0, activeToolExecutions: 1 }))).toBe(
      "active_tool_executions",
    );
    expect(activeWorkBlocker(health({ activeExecutions: 2, inFlightRequests: 1 }))).toBe(
      "active_executions",
    );
    expect(activeWorkBlocker(health({ inFlightRequests: 3 }))).toBe("in_flight_requests");
  });

  it("sends update_failed from a real worker run whose candidate fails the health gate", async () => {
    const reporter = createFakeReporter();
    const fixture = createEngineFixture({
      healthProbe: async () => ({
        serviceActive: false,
        ipcResponsive: false,
        mcpResponsive: false,
        recoveryBreakerTripped: true,
        message: "crash loop at /home/alice/.resin",
      }),
    });

    await runUpdateWorker({
      resinHome: fixture.resinHome,
      engine: fixture.engine,
      publishNotification: async () => undefined,
      report: () => undefined,
      telemetry: createTestTelemetry(reporter),
    });

    expect(reporter.eventsNamed("update_failed")).toEqual([
      {
        trigger: "auto",
        stage: "health_check",
        error_code: "CandidateHealthError",
        from_version: "1.0.0",
        target_version: "1.1.0",
        channel: "stable",
        rolled_back: true,
        rollback_outcome: "succeeded",
        quarantined: true,
      },
    ]);
    expect(reporter.exceptions).toEqual([
      expect.objectContaining({ failureClass: "update_failed", errorCode: "CandidateHealthError" }),
    ]);
    expect(JSON.stringify(reporter.events)).not.toContain("alice");
  });
});
