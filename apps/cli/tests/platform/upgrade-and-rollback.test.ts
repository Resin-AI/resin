import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { type DaemonSupervisor, IpcServer } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProductionRelease } from "../../src/installer/release-client.js";
import { detectPlatform, resolvePlatformPaths } from "../../src/platform/index.js";
import {
  UpdateEngine,
  type UpdateEngineOptions,
  readUpdateStatusSnapshot,
} from "../../src/updates/engine.js";
import { UpdateLockUnavailableError } from "../../src/updates/update-lock.js";

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
    onSnapshot?: UpdateEngineOptions["onSnapshot"];
    useDefaultHealthProbe?: boolean;
    failStatusAfter?: number;
  } = {},
) {
  const homeDir = "/home/update-test";
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
    platformInfo: detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" }),
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
    },
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

  it("preserves and reports concurrent configuration changes during rollback", async () => {
    const configPath = path.join("/home/update-test", ".resin", "config.json");
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
    const journalPath = path.join("/home/update-test", ".resin", "journal.json");
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
      "/home/update-test",
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
        platformInfo: detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" }),
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
            expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o700);
            const configBackupPath = path.join(backupPath, "config.json");
            expect((await fs.stat(configBackupPath)).mode & 0o777).toBe(0o600);
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
    const homeDir = "/home/reinstall-recovery";
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
      platformInfo: detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" }),
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
    const platformInfo = detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" });
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
      tokenFilePath: platformPaths.tokenFilePath,
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
        drainTimeoutMs: 100,
        healthProbeIntervalMs: 1,
        sleep: async () => {},
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
});
