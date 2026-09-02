import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  type ToolManifest,
  type V1ActivationCertificate,
  type V1LockedToolEntry,
  V1LockedToolEntrySchema,
  type V1RevocationMetadata,
  type V1ToolLock,
  hashCanonicalContent,
  normalizeSha256,
} from "@resin/contracts";
import type { LocalPreactivationChecker, SigningKeyStore } from "@resin/observer";
import type { CatalogSnapshotResponse, StreamCatalogInvalidation } from "@resin/protocol";
import {
  type ArtifactCache,
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  type RuntimeTrustStore,
  type TrustIdentity,
  parseTarArchive,
  validateBundleEntryPath,
} from "@resin/runtime";
import type {
  ProjectLockManager,
  ReconcileOutcome,
  ReconcileResult,
} from "../project/lock-manager.js";
import type { ToolRegistry } from "../registry/index.js";
import type { RegistryTool } from "../registry/types.js";
import { computeManifestDigest } from "../registry/validator.js";
import type { CloudCatalogCache } from "./cache.js";
import type { CloudCircuitBreaker } from "./circuit-breaker.js";
import type { CloudCatalogClient } from "./client.js";
import type { CloudInvocationRouter } from "./router.js";

export interface LockedSyncIdentity extends TrustIdentity {
  keyStore?: SigningKeyStore;
}

export interface LockedToolSyncSummary {
  activated: string[];
  failed: string[];
  degraded: string[];
  newerAvailable: string[];
}

/**
 * Minimal contract for fetching immutable artifact bytes by digest. Satisfied by
 * `@resin/observer` ArtifactTransferClient and by the cloud catalog client adapter.
 */
export interface ArtifactBytesDownloader {
  downloadArtifact(
    digest: string,
    options?: { metadata?: Record<string, string | number | boolean | null | undefined> },
  ): Promise<{ bytes: Buffer | Uint8Array }>;
}

/**
 * Per-workspace binding applied when a connection resolves its project lock.
 */
export interface WorkspaceSyncBinding {
  workspaceId?: string;
  lockManager?: ProjectLockManager;
}

export interface CloudCatalogSyncOptions {
  client: CloudCatalogClient;
  cache: CloudCatalogCache;
  router: CloudInvocationRouter;
  registry?: ToolRegistry;
  workspaceId?: string;
  autoRegisterInRegistry?: boolean;
  intervalMs?: number;
  circuitBreaker?: CloudCircuitBreaker;
  onSyncSuccess?: (snapshot: CatalogSnapshotResponse) => void;
  onSyncError?: (error: Error) => void;
  onSyncCircuitBroken?: () => void;

  // Locked project sync & offline trust options
  lockManager?: ProjectLockManager;
  transferClient?: ArtifactBytesDownloader;
  artifactCache?: ArtifactCache;
  trustStore?: RuntimeTrustStore;
  identity?: LockedSyncIdentity;
  certificateProvider?: (
    toolId: string,
    version: string,
  ) => Promise<V1ActivationCertificate | null> | V1ActivationCertificate | null;
  revocationProvider?: () => Promise<V1RevocationMetadata | null> | V1RevocationMetadata | null;
  preactivationChecker?: LocalPreactivationChecker;
  onToolQualified?: (tool: V1LockedToolEntry, outcome: ReconcileOutcome) => void;
  onToolSyncError?: (toolName: string, error: Error) => void;
  onOfflineDegraded?: (toolName: string, reason: string) => void;
  allowDevKeys?: boolean;
}

export interface ToolLockTuple {
  toolId: string;
  name: string;
  version: string;
  manifestDigest: string;
  artifactDigest: string;
  envelopeDigest?: string;
}

const ZERO_DIGEST = "0".repeat(64);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function workspaceScopeId(workspaceId: string | undefined): string {
  return workspaceId || "default";
}

/**
 * Bundle archives are served either as plain tar or gzip-compressed tar (`tar_gz`).
 * The artifact digest always covers the bytes as served; only extraction inflates.
 */
export function inflateArtifactArchive(bytes: Buffer): Buffer {
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
    return zlib.gunzipSync(bytes);
  }
  return bytes;
}

/**
 * Cloud Catalog Sync Coordinator.
 *
 * Coordinates cloud catalog fetching, cache updates, locked project synchronization,
 * cryptographic verification, offline trust degradation, and atomic registry registration.
 */
export class CloudCatalogSyncCoordinator {
  readonly client: CloudCatalogClient;
  readonly cache: CloudCatalogCache;
  readonly router: CloudInvocationRouter;
  readonly registry?: ToolRegistry;
  workspaceId?: string;
  readonly autoRegisterInRegistry: boolean;
  readonly intervalMs: number;
  readonly circuitBreaker?: CloudCircuitBreaker;

  lockManager?: ProjectLockManager;
  readonly transferClient?: ArtifactBytesDownloader;
  readonly artifactCache?: ArtifactCache;
  readonly trustStore?: RuntimeTrustStore;
  readonly identity?: LockedSyncIdentity;
  readonly certificateProvider?: (
    toolId: string,
    version: string,
  ) => Promise<V1ActivationCertificate | null> | V1ActivationCertificate | null;
  readonly revocationProvider?: () =>
    | Promise<V1RevocationMetadata | null>
    | V1RevocationMetadata
    | null;
  readonly preactivationChecker?: LocalPreactivationChecker;
  readonly allowDevKeys: boolean;

  private syncTimer: NodeJS.Timeout | null = null;
  private isRunningPeriodic = false;
  private inFlightSync: Promise<CatalogSnapshotResponse> | null = null;
  private readonly options: CloudCatalogSyncOptions;

  constructor(options: CloudCatalogSyncOptions) {
    this.options = options;
    this.client = options.client;
    this.cache = options.cache;
    this.router = options.router;
    this.registry = options.registry;
    this.workspaceId = options.workspaceId;
    this.autoRegisterInRegistry = options.autoRegisterInRegistry ?? true;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.circuitBreaker = options.circuitBreaker;

    this.lockManager = options.lockManager;
    this.transferClient = options.transferClient;
    this.artifactCache = options.artifactCache;
    this.trustStore = options.trustStore;
    this.identity = options.identity;
    this.certificateProvider = options.certificateProvider;
    this.revocationProvider = options.revocationProvider;
    this.preactivationChecker = options.preactivationChecker;
    this.allowDevKeys = options.allowDevKeys ?? false;
  }

  getLockManager(): ProjectLockManager | undefined {
    return this.lockManager;
  }

  getTrustStore(): RuntimeTrustStore | undefined {
    return this.trustStore;
  }

  getArtifactCache(): ArtifactCache | undefined {
    return this.artifactCache;
  }

  getTransferClient(): ArtifactBytesDownloader | undefined {
    return this.transferClient;
  }

  /**
   * Binds the coordinator to the workspace a connection resolved. The standalone gateway
   * creates one runtime per process but serves one project per connection, so the lock
   * manager and workspace scope are supplied when the workspace becomes ready.
   */
  bindWorkspace(binding: WorkspaceSyncBinding): void {
    if (binding.workspaceId !== undefined) {
      this.workspaceId = binding.workspaceId;
    }
    if (binding.lockManager !== undefined) {
      this.lockManager = binding.lockManager;
    }
  }

  /**
   * Performs an immediate sync cycle (deduplicating concurrent callers).
   */
  async sync(): Promise<CatalogSnapshotResponse> {
    if (this.inFlightSync) {
      return this.inFlightSync;
    }

    this.inFlightSync = this.syncOnce().finally(() => {
      this.inFlightSync = null;
    });

    return this.inFlightSync;
  }

  /**
   * Executes a single synchronization pass.
   */
  async syncOnce(): Promise<CatalogSnapshotResponse> {
    if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
      this.options.onSyncCircuitBroken?.();
      return this.executeOfflineSync();
    }

    try {
      const cachedSnapshot = this.cache.getSnapshot(this.workspaceId);
      let snapshot: CatalogSnapshotResponse;
      try {
        snapshot = await this.client.fetchCatalogSnapshot({
          currentVersion: cachedSnapshot?.snapshotVersion,
        });
      } catch (fetchError: unknown) {
        this.options.onSyncError?.(
          fetchError instanceof Error ? fetchError : new Error(String(fetchError)),
        );
        return await this.executeOfflineSync();
      }

      if (snapshot.tools && snapshot.tools.length > 0) {
        this.cache.setSnapshot(snapshot, { workspaceId: this.workspaceId });
      }

      if (this.trustStore && this.identity && this.revocationProvider) {
        try {
          const revocationMetadata = await this.revocationProvider();
          if (revocationMetadata) {
            await this.trustStore.recordRevocationMetadata(this.identity, revocationMetadata, {
              allowDevKeys: this.allowDevKeys,
            });
          }
        } catch (revError: unknown) {
          this.options.onSyncError?.(
            revError instanceof Error ? revError : new Error(String(revError)),
          );
        }
      }

      if (this.lockManager) {
        await this.syncLockedToolsWithCatalog(snapshot);
      } else if (this.autoRegisterInRegistry && this.registry && snapshot.tools) {
        await this.reconcileRegistry(snapshot.tools);
      }

      this.options.onSyncSuccess?.(snapshot);

      return snapshot;
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      if (this.circuitBreaker) {
        this.circuitBreaker.recordFailure(normalizedError);
      }

      this.options.onSyncError?.(normalizedError);

      return await this.executeOfflineSync();
    }
  }

  /**
   * Executes offline synchronization using local lockfile, cached artifacts, and trust store.
   */
  private async executeOfflineSync(): Promise<CatalogSnapshotResponse> {
    if (this.lockManager) {
      await this.reconcileLockedToolsOffline();
    }

    const cached = this.cache.getSnapshot(this.workspaceId);
    if (cached) {
      return cached;
    }

    const tools: ToolManifest[] = [];
    if (this.lockManager) {
      try {
        const lock = this.lockManager.read();
        for (const entry of Object.values(lock.tools)) {
          const cachedTool = this.cache.getTool(entry.toolId, this.workspaceId);
          if (cachedTool) {
            tools.push(cachedTool.manifest);
          }
        }
      } catch {
        // Ignore lock read errors during offline synthesis
      }
    }

    const activeDeployments: CatalogSnapshotResponse["activeDeployments"] = [];
    return {
      snapshotVersion: "offline",
      generatedAt: new Date().toISOString(),
      checksum: hashCanonicalContent({ tools, activeDeployments }),
      tools,
      activeDeployments,
    };
  }

  /**
   * Synchronizes locked tools using an online catalog snapshot and local ProjectLockManager.
   */
  private async syncLockedToolsWithCatalog(
    snapshot: CatalogSnapshotResponse,
  ): Promise<LockedToolSyncSummary> {
    if (!this.lockManager) {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    let currentLock = this.lockManager.read();
    this.bindRegistryLock(currentLock);

    const newerAvailable: string[] = [];

    if (snapshot.tools && snapshot.tools.length > 0) {
      for (const manifest of snapshot.tools) {
        const toolMeta =
          manifest.metadata && manifest.metadata instanceof Object ? manifest.metadata : undefined;
        const metaManifestDigest =
          toolMeta &&
          "manifestDigest" in toolMeta &&
          Object.prototype.toString.call(toolMeta.manifestDigest) === "[object String]"
            ? String(toolMeta.manifestDigest)
            : undefined;
        const manifestDigest = metaManifestDigest ?? computeManifestDigest(manifest);

        const metaArtifactDigest =
          toolMeta &&
          "artifactDigest" in toolMeta &&
          Object.prototype.toString.call(toolMeta.artifactDigest) === "[object String]"
            ? String(toolMeta.artifactDigest)
            : undefined;
        const artifactDigest = metaArtifactDigest ?? normalizeSha256(manifestDigest);

        const envelopeDigest =
          toolMeta &&
          "envelopeDigest" in toolMeta &&
          Object.prototype.toString.call(toolMeta.envelopeDigest) === "[object String]"
            ? String(toolMeta.envelopeDigest)
            : undefined;
        const candidateEntry: V1LockedToolEntry = {
          toolId: manifest.id,
          name: manifest.name,
          version: manifest.version,
          manifestDigest,
          artifactDigest,
          envelopeDigest,
          status: "active",
        };

        // One catalog entry that violates the lock contract (for example a legacy non-UUID
        // tool id) must not prevent every other published tool from activating.
        const contractCheck = V1LockedToolEntrySchema.safeParse(candidateEntry);
        if (!contractCheck.success) {
          this.options.onToolSyncError?.(
            manifest.name,
            new Error(
              `Catalog entry for '${manifest.name}' cannot be locked: ${contractCheck.error.issues
                .map((issue) => `${issue.path.join(".")} ${issue.message}`)
                .join("; ")}`,
            ),
          );
          continue;
        }

        let result: ReconcileResult;
        try {
          result = this.lockManager.reconcileQualified(candidateEntry);
        } catch (reconcileError: unknown) {
          this.options.onToolSyncError?.(
            manifest.name,
            reconcileError instanceof Error ? reconcileError : new Error(String(reconcileError)),
          );
          continue;
        }
        if (result.outcome === "added") {
          currentLock = result.lock;
          this.options.onToolQualified?.(candidateEntry, "added");
        } else if (result.outcome === "newer_available") {
          newerAvailable.push(manifest.name);
          this.options.onToolQualified?.(candidateEntry, "newer_available");
        }
      }
    }

    const summary = await this.activateLockedEntries(currentLock, snapshot, true);
    summary.newerAvailable = newerAvailable;
    return summary;
  }

  /**
   * Synchronizes locked tools in offline mode.
   */
  private async reconcileLockedToolsOffline(): Promise<LockedToolSyncSummary> {
    if (!this.lockManager) {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    let currentLock: V1ToolLock;
    try {
      currentLock = this.lockManager.read();
    } catch {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    this.bindRegistryLock(currentLock);
    return await this.activateLockedEntries(currentLock, undefined, false);
  }

  /**
   * Reconciles and activates locked tools in the registry.
   */
  async reconcileLockedTools(lock?: V1ToolLock): Promise<LockedToolSyncSummary> {
    const activeLock = lock ?? this.lockManager?.read();
    if (!activeLock) {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    this.bindRegistryLock(activeLock);
    return await this.activateLockedEntries(activeLock, undefined, true);
  }

  private bindRegistryLock(lock: V1ToolLock): void {
    if (!this.registry) {
      return;
    }
    const workspaceId = this.workspaceId ?? lock.projectId;
    if (
      "bindWorkspaceLock" in this.registry &&
      this.registry.bindWorkspaceLock instanceof Function
    ) {
      this.registry.bindWorkspaceLock(workspaceId, lock);
    } else if ("bindLock" in this.registry && this.registry.bindLock instanceof Function) {
      this.registry.bindLock(workspaceId, lock);
    }
  }

  /**
   * Internal orchestrator for verifying, downloading, trust-checking, and activating locked entries.
   */
  private async activateLockedEntries(
    lock: V1ToolLock,
    snapshot: CatalogSnapshotResponse | undefined,
    isOnline: boolean,
  ): Promise<LockedToolSyncSummary> {
    const activated: string[] = [];
    const failed: string[] = [];
    const degraded: string[] = [];

    const entries = Object.entries(lock.tools);

    for (const [toolName, entry] of entries) {
      if (entry.status === "disabled") {
        continue;
      }

      try {
        if (this.artifactCache) {
          let isArtifactCached = this.artifactCache.isArtifactCached(entry.artifactDigest);

          if (!isArtifactCached) {
            if (isOnline && this.transferClient) {
              const downloadResult = await this.transferClient.downloadArtifact(
                entry.artifactDigest,
                {
                  metadata: {
                    toolId: entry.toolId,
                    version: entry.version,
                    projectId: lock.projectId,
                  },
                },
              );

              const downloadedBytes = Buffer.isBuffer(downloadResult.bytes)
                ? downloadResult.bytes
                : Buffer.from(downloadResult.bytes);
              const computedDigest = crypto
                .createHash("sha256")
                .update(downloadedBytes)
                .digest("hex");

              if (normalizeSha256(computedDigest) !== normalizeSha256(entry.artifactDigest)) {
                throw new Error(
                  `Artifact digest mismatch for '${entry.name}': expected ${entry.artifactDigest}, got ${computedDigest}`,
                );
              }

              const stagingDir = await this.artifactCache.createStagingDirectory(
                entry.artifactDigest,
              );
              let fileCount = 0;
              let bundleEntrypoint: string = BUNDLE_FILE_ENTRYPOINT_JS;
              try {
                const tarEntries = parseTarArchive(inflateArtifactArchive(downloadedBytes));
                const entryPaths = new Set(tarEntries.map((entry) => entry.path));
                bundleEntrypoint = entryPaths.has(BUNDLE_FILE_ENTRYPOINT_JS)
                  ? BUNDLE_FILE_ENTRYPOINT_JS
                  : BUNDLE_FILE_ENTRYPOINT_TS;
                if (
                  tarEntries.length === 0 ||
                  !entryPaths.has(BUNDLE_FILE_MANIFEST) ||
                  !entryPaths.has(bundleEntrypoint)
                ) {
                  throw new Error(
                    `Artifact '${entry.name}' is not a complete signed bundle archive`,
                  );
                }
                fileCount = tarEntries.length;
                for (const ent of tarEntries) {
                  validateBundleEntryPath(ent.path.replace(/\\/g, "/"));
                  const targetFile = path.join(stagingDir, ent.path);
                  if (ent.typeflag === "5" || ent.path.endsWith("/")) {
                    await fs.promises.mkdir(targetFile, { recursive: true, mode: 0o700 });
                  } else {
                    await fs.promises.mkdir(path.dirname(targetFile), {
                      recursive: true,
                      mode: 0o700,
                    });
                    await fs.promises.writeFile(targetFile, ent.content ?? Buffer.alloc(0), {
                      mode: ent.mode ?? 0o600,
                    });
                  }
                }
              } catch (error) {
                await fs.promises.rm(stagingDir, { recursive: true, force: true });
                throw error;
              }

              await this.artifactCache.commitStagingDirectory(stagingDir, entry.artifactDigest, {
                digest: entry.artifactDigest,
                extractedAt: new Date().toISOString(),
                fileCount,
                totalSizeBytes: downloadedBytes.length,
                entrypoint: bundleEntrypoint,
                verified: true,
              });

              await this.artifactCache.addReference(entry.artifactDigest, {
                refId: `${lock.projectId}:${entry.name}`,
                refType: "active",
                toolId: entry.toolId,
                version: entry.version,
                createdAt: new Date().toISOString(),
              });

              isArtifactCached = true;
            } else {
              degraded.push(toolName);
              this.options.onOfflineDegraded?.(toolName, "Artifact bytes not cached locally");
              continue;
            }
          }
        }

        if (this.trustStore && this.identity) {
          if (isOnline && this.certificateProvider) {
            try {
              const cert = await this.certificateProvider(entry.toolId, entry.version);
              if (cert) {
                await this.trustStore.recordActivationCertificate(this.identity, cert, {
                  allowDevKeys: this.allowDevKeys,
                });
              }
            } catch (certError: unknown) {
              this.options.onToolSyncError?.(
                toolName,
                certError instanceof Error ? certError : new Error(String(certError)),
              );
            }
          }

          const trustResult = await this.trustStore.verifyToolTrust(
            this.identity,
            {
              toolId: entry.toolId,
              version: entry.version,
              manifestDigest: entry.manifestDigest,
              artifactDigest: entry.artifactDigest,
              capabilityEnvelopeDigest: entry.envelopeDigest ?? ZERO_DIGEST,
            },
            { allowDevKeys: this.allowDevKeys },
          );

          if (!trustResult.trusted) {
            failed.push(toolName);
            const err = new Error(
              trustResult.reason || `Trust verification failed for '${entry.name}'`,
            );
            this.options.onToolSyncError?.(toolName, err);
            this.options.onOfflineDegraded?.(
              toolName,
              trustResult.reason || "Trust verification failed",
            );
            continue;
          }
        }

        let resolvedManifest: ToolManifest | undefined;
        if (snapshot?.tools) {
          resolvedManifest = snapshot.tools.find(
            (t) => t.id === entry.toolId && t.version === entry.version,
          );
        }

        if (!resolvedManifest) {
          const cached = this.cache.getTool(entry.toolId, this.workspaceId);
          if (cached && cached.version === entry.version) {
            resolvedManifest = cached.manifest;
          }
        }

        if (!resolvedManifest && this.artifactCache) {
          const cachedManifest = this.artifactCache.getArtifactManifest(entry.artifactDigest);
          if (cachedManifest) {
            resolvedManifest = cachedManifest;
          }
        }
        if (resolvedManifest && entry.manifestDigest) {
          const computedManifestDigest = computeManifestDigest(resolvedManifest);
          if (
            normalizeSha256(computedManifestDigest, false) !==
            normalizeSha256(entry.manifestDigest, false)
          ) {
            failed.push(toolName);
            const err = new Error(
              `Manifest digest mismatch for '${entry.name}': expected ${entry.manifestDigest}, got ${computedManifestDigest}`,
            );
            this.options.onToolSyncError?.(toolName, err);
            this.options.onOfflineDegraded?.(
              toolName,
              `Manifest digest mismatch for '${entry.name}'`,
            );
            continue;
          }
        }

        if (!resolvedManifest) {
          degraded.push(toolName);
          this.options.onOfflineDegraded?.(
            toolName,
            `Manifest unavailable for locked tool '${entry.name}'`,
          );
          continue;
        }

        if (this.preactivationChecker) {
          const preactResult = await this.preactivationChecker.checkPreactivation({
            manifest: resolvedManifest,
            workspaceId: workspaceScopeId(this.workspaceId),
            projectId: lock.projectId,
            lockedEntry: entry,
            targetVersion: entry.version,
            targetDigest: entry.artifactDigest,
          });

          if (preactResult && !preactResult.eligible) {
            failed.push(toolName);
            const err = new Error(
              preactResult.violations?.[0]?.message ||
                `Preactivation check failed for '${entry.name}'`,
            );
            this.options.onToolSyncError?.(toolName, err);
            continue;
          }
        }

        if (this.registry) {
          const registryTool: RegistryTool = {
            toolId: entry.toolId,
            name: entry.name,
            version: entry.version,
            manifest: resolvedManifest,
            manifestDigest: entry.manifestDigest,
            artifactDigest: entry.artifactDigest,
            envelopeDigest: entry.envelopeDigest,
            scope: "workspace",
            status: "active",
            workspaceId: this.workspaceId,
            createdAt: new Date().toISOString(),
            metadata: {
              source: "cloud",
              availability: isOnline ? "fresh" : "stale",
              workspaceId: this.workspaceId,
              projectId: lock.projectId,
            },
          };

          this.registry.registerToolSync(registryTool);
          if (this.workspaceId) {
            try {
              await this.registry.activateToolVersion(
                entry.toolId,
                entry.version,
                this.workspaceId,
              );
            } catch {
              // Activation failure is non-fatal for remaining tools
            }
          }
        }

        activated.push(toolName);
      } catch (err: unknown) {
        failed.push(toolName);
        const errorObj = err instanceof Error ? err : new Error(String(err));
        this.options.onToolSyncError?.(toolName, errorObj);
      }
    }

    return { activated, failed, degraded, newerAvailable: [] };
  }

  /**
   * Starts periodic catalog synchronization on the configured interval.
   */
  startPeriodicSync(): void {
    if (this.isRunningPeriodic) {
      return;
    }

    this.isRunningPeriodic = true;
    this.syncTimer = setInterval(async () => {
      try {
        await this.sync();
      } catch {
        // Errors handled in syncOnce / onSyncError
      }
    }, this.intervalMs);

    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }
  }

  /**
   * Stops background periodic synchronization.
   */
  stopPeriodicSync(): void {
    this.isRunningPeriodic = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Returns whether periodic sync is currently active.
   */
  isPeriodicSyncRunning(): boolean {
    return this.isRunningPeriodic;
  }

  /**
   * Alias for isPeriodicSyncRunning.
   */
  isRunning(): boolean {
    return this.isRunningPeriodic;
  }

  /**
   * Handles stream invalidation events from the cloud platform.
   */
  async handleInvalidation(event: StreamCatalogInvalidation): Promise<void> {
    if (event.workspaceId && event.workspaceId !== this.workspaceId && event.workspaceId !== "*") {
      return;
    }

    if (event.reason === "emergency_revocation" || event.reason === "tool_deprecated") {
      const toolIds: string[] = Array.isArray(event.toolIds) ? event.toolIds : [];
      this.cache.invalidateTools(toolIds, this.workspaceId, event.reason);

      if (this.registry) {
        const workspaceId = workspaceScopeId(this.workspaceId);
        for (const toolId of toolIds) {
          try {
            await this.registry.deactivateTool(toolId, workspaceId);
          } catch {
            // Ignore deactivation errors
          }
        }
      }

      if (this.registry?.events) {
        const workspaceId = workspaceScopeId(this.workspaceId);
        const currentSnapshot = await this.registry.resolveCatalog(workspaceId);
        const revision =
          "revision" in currentSnapshot && Number.isFinite(currentSnapshot.revision)
            ? Number(currentSnapshot.revision)
            : 1;
        this.registry.events.emit({
          workspaceId,
          revision,
          snapshot: currentSnapshot,
          changedToolIds: toolIds,
          timestamp: new Date().toISOString(),
        });
      }
    } else if (this.autoRegisterInRegistry) {
      await this.sync();
    }
  }

  /**
   * Registers/updates all cloud tools in ToolRegistry (legacy/unlocked helper).
   */
  private async reconcileRegistry(tools: ToolManifest[]): Promise<void> {
    if (!this.registry) {
      return;
    }

    const workspaceId = this.workspaceId;
    for (const tool of tools) {
      const meta = tool.metadata && tool.metadata instanceof Object ? tool.metadata : undefined;
      const metaManifestDigest =
        meta &&
        "manifestDigest" in meta &&
        Object.prototype.toString.call(meta.manifestDigest) === "[object String]"
          ? String(meta.manifestDigest)
          : undefined;
      const manifestDigest = metaManifestDigest ?? computeManifestDigest(tool);

      const metaArtifactDigest =
        meta &&
        "artifactDigest" in meta &&
        Object.prototype.toString.call(meta.artifactDigest) === "[object String]"
          ? String(meta.artifactDigest)
          : undefined;
      const artifactDigest = metaArtifactDigest ?? normalizeSha256(manifestDigest);
      const registryTool: RegistryTool = {
        toolId: tool.id,
        name: tool.name,
        version: tool.version,
        manifest: tool,
        manifestDigest,
        artifactDigest,
        scope: "workspace",
        status: "active",
        workspaceId,
        handler: this.router.createToolHandler(tool.id),
        createdAt: tool.createdAt || new Date().toISOString(),
        metadata: {
          source: "cloud",
          availability: "fresh",
          workspaceId,
        },
      };

      this.registry.registerToolSync(registryTool);

      if (workspaceId) {
        try {
          await this.registry.activateToolVersion(tool.id, tool.version, workspaceId);
        } catch {
          // Ignore activation failure for legacy reconcile
        }
      }
    }

    const resolvedSnapshot = await this.registry.resolveCatalog(workspaceScopeId(workspaceId));
    this.registry.events?.emit({
      workspaceId: workspaceScopeId(workspaceId),
      revision:
        "revision" in resolvedSnapshot && Number.isFinite(resolvedSnapshot.revision)
          ? Number(resolvedSnapshot.revision)
          : 1,
      snapshot: resolvedSnapshot,
      changedToolIds: tools.map((t) => t.id),
      timestamp: new Date().toISOString(),
    });
  }
}

// Export LockedProjectSyncCoordinator as alias/specialization
export { CloudCatalogSyncCoordinator as LockedProjectSyncCoordinator };
