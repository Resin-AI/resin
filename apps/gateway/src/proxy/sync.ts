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
import {
  type AccountToolAccessResponse,
  type CatalogSnapshotResponse,
  DEVICE_SYNC_SAFETY_REFRESH_MS,
  DEVICE_SYNC_SCHEMA_VERSION,
  type StreamCatalogInvalidation,
  ValidationError,
} from "@resin/protocol";
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
import type { CatalogSnapshotFetchResult, CloudCatalogClient } from "./client.js";
import type { CloudInvocationRouter } from "./router.js";
import type { PublishedDeviceSync, SharedCloudSync } from "./shared-sync.js";
import type { ManagedToolAccess, ManagedToolConfirmation } from "./tool-access.js";
import type { ToolCertificateReporter } from "./tool-certificate-verifier.js";

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
  isPinned?: (toolId: string) => boolean;
  managedToolAccess?: ManagedToolAccess;
  /**
   * Shares catalog and tool-access answers with the other gateways of this OS user, so one cloud
   * call per interval serves all of them. Without it every sync calls the cloud directly.
   */
  sharedSync?: SharedCloudSync;
  /**
   * Report-only verification of cloud-issued tool certificates for every locked artifact that
   * passed its digest check. Outcomes are recorded; activation is never affected unless the
   * reporter's internal enforce mode is on.
   */
  toolCertificates?: ToolCertificateReporter;
  /**
   * How often the gateway checks, locally, for the daemon's device sync answer (see
   * `followDeviceSync`). Reading it never calls the cloud. Default 5 s.
   */
  deviceSyncWatchIntervalMs?: number;
}

/** Default for `CloudCatalogSyncOptions.deviceSyncWatchIntervalMs`. */
export const DEFAULT_DEVICE_SYNC_WATCH_INTERVAL_MS = 5_000;

/** What a gateway last followed from the daemon's device sync. */
interface FollowedDeviceSync {
  accountId: string;
  userId: string;
  fetchedAt: number;
  /** Catalog token the last successful catalog sync covered; undefined until one succeeds. */
  catalogToken: string | null | undefined;
}

/** The account tool-access answer a device sync answer carries. */
function toolAccessFromDeviceSync(published: PublishedDeviceSync): AccountToolAccessResponse {
  return {
    schemaVersion: DEVICE_SYNC_SCHEMA_VERSION,
    accountId: published.sync.accountId,
    userId: published.sync.userId,
    toolAccess: published.sync.toolAccess,
  };
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

/** A tool the last clean reconciliation left active, with the digests it was activated under. */
interface SettledTool {
  toolId: string;
  version: string;
  expected?: { manifestDigest?: string; artifactDigest?: string; envelopeDigest?: string };
}

interface SettledReconcile {
  fingerprint: string;
  activeTools: SettledTool[];
}

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
  private deviceSyncTimer: NodeJS.Timeout | null = null;
  private readonly deviceSyncWatchIntervalMs: number;
  /** The daemon device sync answer this gateway last acted on, while it follows one. */
  private followedDeviceSync?: FollowedDeviceSync;
  /** When the catalog was last synced from the cloud, for the device sync safety refresh. */
  private lastCatalogSyncAt = Number.NEGATIVE_INFINITY;
  private isRunningPeriodic = false;
  private inFlightSync: Promise<CatalogSnapshotResponse> | null = null;
  private readonly options: CloudCatalogSyncOptions;
  private catalogSyncEnabled = true;
  /**
   * Fingerprint of everything the last downstream reconciliation read, recorded only when it
   * left nothing to retry. An unchanged catalog skips reconciliation while this still matches.
   */
  private settledReconcile?: SettledReconcile;
  /**
   * Settles once the cloud has answered for the bound workspace's catalog. Until then an empty
   * registry means "not loaded yet", not "no tools".
   */
  private catalogLoaded = Promise.withResolvers<void>();

  constructor(options: CloudCatalogSyncOptions) {
    this.options = options;
    this.client = options.client;
    this.cache = options.cache;
    this.router = options.router;
    this.registry = options.registry;
    this.workspaceId = options.workspaceId;
    this.autoRegisterInRegistry = options.autoRegisterInRegistry ?? true;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.deviceSyncWatchIntervalMs =
      options.deviceSyncWatchIntervalMs ?? DEFAULT_DEVICE_SYNC_WATCH_INTERVAL_MS;
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

  private activeConfirmation?: ManagedToolConfirmation;
  getTransferClient(): ArtifactBytesDownloader | undefined {
    return this.transferClient;
  }

  /**
   * Binds the coordinator to the workspace a connection resolved. The standalone gateway
   * creates one runtime per process but serves one project per connection, so the lock
   * manager and workspace scope are supplied when the workspace becomes ready.
   */
  bindWorkspace(binding: WorkspaceSyncBinding): void {
    this.settledReconcile = undefined;
    if (binding.workspaceId !== undefined && binding.workspaceId !== this.workspaceId) {
      this.catalogLoaded = Promise.withResolvers<void>();
    }
    if (binding.workspaceId !== undefined) {
      this.workspaceId = binding.workspaceId;
    }
    if (binding.lockManager !== undefined) {
      this.lockManager = binding.lockManager;
      if (
        this.router &&
        "setLockManager" in this.router &&
        typeof this.router.setLockManager === "function"
      ) {
        this.router.setLockManager(binding.lockManager);
      }
    }
  }

  /**
   * Performs an immediate sync cycle (deduplicating concurrent callers). `fresh` refuses a peer
   * gateway's shared answer that predates this call, for example after an invalidation.
   */
  async sync(options: { fresh?: boolean } = {}): Promise<CatalogSnapshotResponse> {
    return this.runSync(true, options.fresh === true);
  }

  /** Resolves once the cloud has answered for the bound workspace's catalog; see `catalogLoaded`. */
  whenCatalogLoaded(): Promise<void> {
    return this.catalogLoaded.promise;
  }

  setCatalogSyncEnabled(enabled: boolean): void {
    this.catalogSyncEnabled = enabled;
  }

  async checkToolAccess(): Promise<void> {
    await this.runSync(false);
  }

  private emptySnapshot(): CatalogSnapshotResponse {
    return {
      snapshotVersion: "local",
      generatedAt: new Date().toISOString(),
      tools: [],
      activeDeployments: [],
      checksum: hashCanonicalContent({ tools: [], activeDeployments: [] }),
    };
  }

  /**
   * `published`: a tool-access answer the daemon's device sync already read from the cloud; it is
   * confirmed exactly like one this gateway fetched, and nothing is fetched for access.
   */
  private async runSync(
    includeCatalog: boolean,
    fresh = false,
    published?: PublishedDeviceSync,
  ): Promise<CatalogSnapshotResponse> {
    if (this.inFlightSync) return this.inFlightSync;
    this.inFlightSync = (async () => {
      const access = this.options.managedToolAccess;
      if (access) {
        try {
          await this.registry?.hydrateFromStore();
          access.adopt(this.registry, this.lockManager);
        } catch (error) {
          this.options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
        }
        const observedConfirmation = access.captureConfirmation?.();
        let confirmation: AccountToolAccessResponse | null = null;
        try {
          if (published) {
            const expected = access.identity;
            // An answer for another login proves nothing about this one: treat access as unknown.
            confirmation =
              !expected ||
              (expected.cloudUrl === published.cloudUrl &&
                expected.accountId === published.sync.accountId &&
                expected.userId === published.sync.userId)
                ? toolAccessFromDeviceSync(published)
                : null;
          } else {
            confirmation = this.options.sharedSync
              ? await this.options.sharedSync.fetchToolAccess(access.identity, this.intervalMs)
              : await this.client.fetchToolAccess(access.identity);
          }
        } catch (error) {
          this.options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
        }
        let acceptedConfirmation: ManagedToolConfirmation | undefined = undefined;
        let confirmationRejected = false;
        if (confirmation) {
          try {
            acceptedConfirmation = access.confirm(confirmation, observedConfirmation);
          } catch (error) {
            this.options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
          }
          if (!acceptedConfirmation) {
            confirmationRejected = true;
          }
          // Stale allowance protection: confirm() returns undefined when stale.
          // Must NOT fall back to observed confirmation; activeConfirmation remains undefined
          // so new activations are skipped.
          this.activeConfirmation = acceptedConfirmation;
        } else {
          // Offline or network error: retain captured proof under existing offline trust guards
          this.activeConfirmation = observedConfirmation;
        }
        if (access.isInactive()) {
          this.settledReconcile = undefined;
          this.cache.clear();
          try {
            await access.cleanup(this.registry);
          } catch (error) {
            this.options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
          }
          // The cloud confirmed this account has no tool access: the catalog is known to be empty.
          this.catalogLoaded.resolve();
          return this.emptySnapshot();
        }
        if (confirmationRejected) {
          // A non-null cloud confirmation was rejected as stale/invalid (e.g. CAS mismatch against intervening revocation).
          // Do NOT enter new catalog activation or stamp new epochs.
          // Restore ONLY already authorized verified local tools without mutable record/adopt.
          if (includeCatalog && this.lockManager) {
            return await this.executeOfflineSync();
          }
          return this.emptySnapshot();
        }
      }
      if (includeCatalog && this.catalogSyncEnabled) {
        // A peer's catalog answer serves a device sync only if its cloud read began after the sync
        // read that reported the catalog token.
        return await this.syncCatalogOnce(fresh, published?.fetchedAt);
      }
      if (includeCatalog && this.lockManager) {
        return await this.executeOfflineSync();
      }
      return this.emptySnapshot();
    })().finally(() => {
      this.inFlightSync = null;
    });
    return this.inFlightSync;
  }

  /**
   * Executes a single synchronization pass.
   */
  async syncOnce(): Promise<CatalogSnapshotResponse> {
    return this.sync();
  }

  private async syncCatalogOnce(
    fresh = false,
    notBefore?: number,
  ): Promise<CatalogSnapshotResponse> {
    if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
      this.options.onSyncCircuitBroken?.();
      return this.executeOfflineSync();
    }

    try {
      const cachedSnapshot = this.cache.getSnapshot(this.workspaceId) ?? undefined;
      let fetched: { snapshot: CatalogSnapshotResponse; unchanged: boolean };
      try {
        fetched = await this.fetchCatalog(cachedSnapshot, fresh, notBefore);
      } catch (fetchError: unknown) {
        this.options.onSyncError?.(
          fetchError instanceof Error ? fetchError : new Error(String(fetchError)),
        );
        return await this.executeOfflineSync();
      }
      const { snapshot, unchanged } = fetched;

      // An unchanged answer is a current sync too: re-ingesting the held snapshot restarts its
      // freshness windows exactly as a refetch of the same bytes would.
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

      if (!unchanged || !this.reconcileSettled(snapshot)) {
        await this.reconcileSnapshot(snapshot);
      }

      this.lastCatalogSyncAt = Date.now();
      this.catalogLoaded.resolve();
      this.options.onSyncSuccess?.(snapshot);

      return snapshot;
    } catch (error: unknown) {
      this.settledReconcile = undefined;
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      if (this.circuitBreaker) {
        this.circuitBreaker.recordFailure(normalizedError);
      }

      this.options.onSyncError?.(normalizedError);

      return await this.executeOfflineSync();
    }
  }

  /**
   * Fetches the catalog relative to the snapshot this gateway holds. `unchanged` is accepted only
   * for exactly that version; any other `unchanged` is a protocol error, answered by one full
   * refetch that does not advertise the capability.
   */
  private async fetchCatalog(
    held: CatalogSnapshotResponse | undefined,
    fresh: boolean,
    notBefore?: number,
  ): Promise<{ snapshot: CatalogSnapshotResponse; unchanged: boolean }> {
    const result: CatalogSnapshotFetchResult = this.options.sharedSync
      ? await this.options.sharedSync.fetchCatalog({
          current: held,
          maxAgeMs: this.intervalMs,
          fresh,
          ...(notBefore === undefined ? {} : { notBefore }),
        })
      : await this.client.fetchCatalogSnapshotResult({
          currentVersion: held?.snapshotVersion,
          acceptUnchanged: true,
        });
    if (result.kind === "snapshot") {
      return { snapshot: result.snapshot, unchanged: false };
    }
    if (held && result.snapshotVersion === held.snapshotVersion) {
      return { snapshot: held, unchanged: true };
    }
    this.options.onSyncError?.(
      new ValidationError(
        `Cloud answered 'unchanged' for catalog version '${result.snapshotVersion}' but this gateway ${
          held ? `holds '${held.snapshotVersion}'` : "holds no snapshot"
        }; refetching the full snapshot`,
      ),
    );
    const snapshot = await this.client.fetchCatalogSnapshot({
      currentVersion: held?.snapshotVersion,
    });
    return { snapshot, unchanged: false };
  }

  /**
   * Runs downstream reconciliation for a snapshot and, when it leaves nothing to retry (no failed,
   * degraded or held-back tool), records what it read so an unchanged catalog can skip the next one.
   */
  private async reconcileSnapshot(snapshot: CatalogSnapshotResponse): Promise<void> {
    this.settledReconcile = undefined;
    let activeTools: SettledTool[];
    if (this.lockManager) {
      const summary = await this.syncLockedToolsWithCatalog(snapshot);
      if (
        summary.failed.length > 0 ||
        summary.degraded.length > 0 ||
        summary.newerAvailable.length > 0
      ) {
        return;
      }
      // Fingerprint the lock this reconciliation ended with instead of reading it again.
      const reconciledLock = summary.lock;
      const inputs = reconciledLock && this.reconcileInputs(snapshot, reconciledLock);
      if (!reconciledLock || !inputs) return;
      activeTools = summary.activated.flatMap((name) => {
        const entry = reconciledLock.tools[name];
        return entry
          ? [
              {
                toolId: entry.toolId,
                version: entry.version,
                expected: {
                  manifestDigest: entry.manifestDigest,
                  artifactDigest: entry.artifactDigest,
                  envelopeDigest: entry.envelopeDigest,
                },
              },
            ]
          : [];
      });
      this.settledReconcile = { fingerprint: inputs.fingerprint, activeTools };
      return;
    }
    if (this.autoRegisterInRegistry && this.registry && snapshot.tools) {
      if (!(await this.reconcileRegistry(snapshot))) return;
      activeTools = snapshot.tools.map((tool) => ({ toolId: tool.id, version: tool.version }));
    } else {
      activeTools = [];
    }
    const inputs = this.reconcileInputs(snapshot);
    if (inputs) {
      this.settledReconcile = { fingerprint: inputs.fingerprint, activeTools };
    }
  }

  /**
   * Whether reconciling `snapshot` again would change nothing: the last clean reconciliation read
   * the same snapshot, lock, workspace and access proof, and every tool it activated is still active.
   */
  private reconcileSettled(snapshot: CatalogSnapshotResponse): boolean {
    const settled = this.settledReconcile;
    const workspaceId = this.workspaceId;
    if (!settled || !workspaceId) return false;
    const inputs = this.reconcileInputs(snapshot);
    if (!inputs || inputs.fingerprint !== settled.fingerprint) return false;
    const registry = this.registry;
    if (!registry) return true;
    return settled.activeTools.every(
      (tool) =>
        registry.isToolActiveForWorkspace?.(
          tool.toolId,
          tool.version,
          workspaceId,
          tool.expected,
        ) === true,
    );
  }

  private reconcileInputs(
    snapshot: CatalogSnapshotResponse,
    reconciledLock?: V1ToolLock,
  ): { fingerprint: string } | undefined {
    if (!this.workspaceId) return undefined;
    let lock: V1ToolLock | undefined = reconciledLock;
    if (this.lockManager && !lock) {
      try {
        lock = this.lockManager.read();
      } catch {
        return undefined;
      }
    }
    const confirmation = this.activeConfirmation;
    const fingerprint = hashCanonicalContent({
      snapshotVersion: snapshot.snapshotVersion,
      checksum: snapshot.checksum,
      workspaceId: this.workspaceId,
      lockPath: this.lockManager?.lockPath,
      // Only what reconciliation acts on, so an equal lock fingerprints equally however it was read.
      lock: lock && {
        projectId: lock.projectId,
        tools: Object.fromEntries(
          Object.entries(lock.tools).map(([name, entry]) => [
            name,
            {
              toolId: entry.toolId,
              version: entry.version,
              manifestDigest: entry.manifestDigest,
              artifactDigest: entry.artifactDigest,
              envelopeDigest: entry.envelopeDigest,
              status: entry.status,
            },
          ]),
        ),
      },
      confirmation: confirmation && {
        cloudUrl: confirmation.cloudUrl,
        accountId: confirmation.accountId,
        userId: confirmation.userId,
        toolAccess: confirmation.toolAccess,
        revocationId: confirmation.revocationId,
      },
    });
    return { fingerprint };
  }

  /**
   * Executes offline synchronization using local lockfile, cached artifacts, and trust store.
   */
  private async executeOfflineSync(): Promise<CatalogSnapshotResponse> {
    this.settledReconcile = undefined;
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
          } else {
            const regTool =
              this.registry?.getToolVersion(entry.toolId, entry.version) ??
              this.registry?.getToolVersion(entry.name, entry.version);
            if (regTool?.manifest) {
              tools.push(regTool.manifest);
            } else if (this.artifactCache) {
              const manifest = this.artifactCache.getArtifactManifest(entry.artifactDigest);
              if (manifest && manifest.id === entry.toolId && manifest.version === entry.version) {
                tools.push(manifest);
              }
            }
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
  ): Promise<LockedToolSyncSummary & { lock?: V1ToolLock }> {
    if (!this.lockManager) {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    let currentLock = await this.retireToolsMissingFrom(this.lockManager.read(), snapshot);
    this.bindRegistryLock(currentLock);

    const newerAvailable: string[] = [];
    const reconcileFailures: string[] = [];

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

        // Receipt renewal and lockfile reconciliation are independent concerns: the
        // confirmation only authorizes recording activation proof, it does not require
        // touching the lockfile. Record first when proof is present, then decide whether
        // the lockfile actually needs work.
        if (this.activeConfirmation) {
          this.options.managedToolAccess?.record(
            candidateEntry,
            this.workspaceId,
            this.lockManager,
            false,
            this.activeConfirmation,
          );
        }

        let result: ReconcileResult;
        // Exact-match fast path: the candidate already matches the committed entry, so
        // reconcileQualified() can only return "unchanged". Resolve it against the lock
        // this loop already holds instead of re-reading and re-cloning the whole lockfile
        // (and acquiring its mutex) once per manifest.
        const committed = currentLock.tools[candidateEntry.name];
        const isExactlyCommitted =
          committed !== undefined &&
          committed.version === candidateEntry.version &&
          committed.manifestDigest === candidateEntry.manifestDigest &&
          committed.artifactDigest === candidateEntry.artifactDigest &&
          committed.envelopeDigest === candidateEntry.envelopeDigest;

        if (isExactlyCommitted) {
          result = { outcome: "unchanged", lock: currentLock };
        } else {
          try {
            result = this.lockManager.reconcileQualified(candidateEntry);
          } catch (reconcileError: unknown) {
            this.options.onToolSyncError?.(
              manifest.name,
              reconcileError instanceof Error ? reconcileError : new Error(String(reconcileError)),
            );
            reconcileFailures.push(manifest.name);
            continue;
          }
        }
        if (result.outcome === "added") {
          currentLock = result.lock;
          this.options.onToolQualified?.(candidateEntry, "added");
        } else if (result.outcome === "newer_available") {
          const isPinned = Boolean(
            this.options.isPinned?.(candidateEntry.toolId) ||
              this.options.isPinned?.(candidateEntry.name) ||
              currentLock.tools[manifest.name]?.status === "pinned",
          );
          if (isPinned) {
            newerAvailable.push(manifest.name);
            this.options.onToolQualified?.(candidateEntry, "newer_available");
          } else {
            result = this.lockManager.advance(candidateEntry);
            currentLock = result.lock;
            this.options.onToolQualified?.(candidateEntry, "updated");
          }
        }
        const managedEntry = currentLock.tools[manifest.name];
        if (
          managedEntry?.toolId === candidateEntry.toolId &&
          managedEntry.version === candidateEntry.version &&
          managedEntry.artifactDigest === candidateEntry.artifactDigest &&
          managedEntry.manifestDigest === candidateEntry.manifestDigest
        ) {
          if (this.activeConfirmation) {
            this.options.managedToolAccess?.record(
              managedEntry,
              this.workspaceId,
              this.lockManager,
              false,
              this.activeConfirmation,
            );
          }
        }
      }
    }
    this.bindRegistryLock(currentLock);
    const summary = await this.activateLockedEntries(currentLock, snapshot, true);
    return {
      ...summary,
      failed: [...summary.failed, ...reconcileFailures],
      newerAvailable,
      lock: currentLock,
    };
  }

  /**
   * Synchronizes locked tools in offline mode.
   */
  async reconcileLockedToolsOffline(): Promise<LockedToolSyncSummary> {
    if (!this.lockManager) {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    let currentLock: V1ToolLock;
    try {
      currentLock = this.lockManager.read();
    } catch {
      return { activated: [], failed: [], degraded: [], newerAvailable: [] };
    }

    // Offline, the last verified snapshot stays authoritative: a lock entry it no longer carries
    // is not revived from local artifacts.
    const verified = this.cache.getSnapshot(this.workspaceId);
    if (verified) currentLock = await this.retireToolsMissingFrom(currentLock, verified);

    this.bindRegistryLock(currentLock);
    return await this.activateLockedEntries(currentLock, undefined, false);
  }

  /**
   * The tool ids a verified snapshot authoritatively publishes, or undefined when it cannot
   * justify retiring anything: without an explicit tools array the catalog is unknown, and an
   * empty catalog while the account still has tool access is suspicious rather than a purge.
   */
  private publishedToolIds(snapshot: CatalogSnapshotResponse): Set<string> | undefined {
    if (!Array.isArray(snapshot.tools)) return undefined;
    if (snapshot.tools.length === 0 && !this.options.managedToolAccess?.isInactive()) {
      return undefined;
    }
    return new Set(snapshot.tools.map((tool) => tool.id));
  }

  /**
   * Hides every lock entry whose tool the verified snapshot no longer carries (at any version):
   * it is left out of the lock this workspace binds and activates, and retired in the registry
   * for this workspace only. Entries this workspace owns (a receipt proves this account recorded
   * them into this lock for this workspace) are also removed from the lock file and their stored
   * manifest and artifact reference released. Entries it does not own (written before receipts
   * named their lock, or by another workspace) stay byte-identical on disk and reappear when the
   * owning workspace binds. The lock only ever holds cloud-published tools, so local-only state
   * is never affected.
   */
  private async retireToolsMissingFrom(
    lock: V1ToolLock,
    snapshot: CatalogSnapshotResponse,
  ): Promise<V1ToolLock> {
    const lockManager = this.lockManager;
    const workspaceId = this.workspaceId;
    const access = this.options.managedToolAccess;
    const published = this.publishedToolIds(snapshot);
    if (workspaceId) this.registry?.reinstateCloudTools(workspaceId, snapshot.tools ?? []);
    if (!lockManager || !workspaceId || !published) return lock;
    const dropped = Object.values(lock.tools).filter((entry) => !published.has(entry.toolId));
    if (dropped.length === 0) return lock;
    const owned = dropped.filter((entry) =>
      access?.ownsLockEntry(entry, workspaceId, lockManager.lockPath),
    );

    let nextLock = lock;
    for (const entry of owned) {
      try {
        nextLock = lockManager.remove(entry.name, entry);
      } catch (error: unknown) {
        this.options.onToolSyncError?.(
          entry.name,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    const tools = { ...nextLock.tools };
    for (const entry of dropped) delete tools[entry.name];
    const visibleLock: V1ToolLock = { ...nextLock, tools };
    await this.registry?.retireCloudTools(
      workspaceId,
      dropped.map((entry) => ({ toolId: entry.toolId, name: entry.name })),
    );
    // Garbage collection runs inside the serialized sync and only for tools still retired, so a
    // republish that reinstated one cannot lose the manifest or reference it reuses. The lock and
    // registry above already make the tool inert, so a failed release is only reported.
    for (const entry of owned) {
      if (this.registry && !this.registry.isCloudToolRetired(workspaceId, entry.toolId)) continue;
      try {
        await this.registry?.removeManagedTool(entry, workspaceId);
        await this.artifactCache?.removeOwnedArtifactReference(
          entry.artifactDigest,
          `${lock.projectId}:${entry.name}`,
          entry.toolId,
          entry.version,
        );
      } catch (error: unknown) {
        this.options.onToolSyncError?.(
          entry.name,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return visibleLock;
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

    // Pre-filter blocked/inactive entries under a single owner snapshot. The snapshot
    // is opened and released synchronously here — it must NOT span the async download
    // loop below, or a revocation landing mid-await would be masked. This collapses
    // the per-tool readOwners() statx calls into one directory read.
    const eligible: Array<[string, (typeof entries)[number][1]]> = [];
    const releaseOwners = this.options.managedToolAccess?.beginOwnerSnapshot?.();
    try {
      for (const [toolName, entry] of entries) {
        if (
          this.options.managedToolAccess?.isInactive() ||
          this.options.managedToolAccess?.isBlocked(entry)
        )
          continue;
        if (entry.status === "disabled") {
          continue;
        }
        // Hidden: this workspace's latest verified snapshot dropped the tool.
        if (this.registry?.isCloudToolRetired(this.workspaceId, entry.toolId)) continue;
        eligible.push([toolName, entry]);
      }
    } finally {
      releaseOwners?.();
    }

    // Report-only: outcomes are recorded, never acted on (see ToolCertificateReporter).
    const certificatePass = this.options.toolCertificates?.beginPass({
      online: isOnline,
      projectId: lock.projectId,
    });

    for (const [toolName, entry] of eligible) {
      try {
        // Digest the artifact bytes on disk were verified against, when they are available.
        let verifiedArtifactDigest: string | undefined;
        if (this.artifactCache) {
          let isArtifactCached = this.artifactCache.isArtifactCached(entry.artifactDigest);
          // Cached artifacts were digest-verified when they were committed to the cache.
          if (isArtifactCached) verifiedArtifactDigest = entry.artifactDigest;

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
              verifiedArtifactDigest = computedDigest;

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

        if (certificatePass && verifiedArtifactDigest) {
          const outcome = await certificatePass.check(entry, verifiedArtifactDigest);
          if (certificatePass.blocks(outcome)) {
            failed.push(toolName);
            this.options.onToolSyncError?.(
              toolName,
              new Error(`Tool certificate check did not verify '${entry.name}'`),
            );
            continue;
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
        let isArtifactBundleFallback = false;
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
            isArtifactBundleFallback = true;
          }
        }
        if (resolvedManifest) {
          if (isArtifactBundleFallback) {
            const idMatches = resolvedManifest.id === entry.toolId;
            const versionMatches = resolvedManifest.version === entry.version;
            const nameMatches = resolvedManifest.name === entry.name;
            const hasArtifactDigest = Boolean(entry.artifactDigest);

            if (!idMatches || !versionMatches || !nameMatches || !hasArtifactDigest) {
              failed.push(toolName);
              const err = new Error(
                `Artifact-bundle fallback manifest mismatch for '${entry.name}': expected id=${entry.toolId}, name=${entry.name}, version=${entry.version}, got id=${resolvedManifest.id}, name=${resolvedManifest.name}, version=${resolvedManifest.version}`,
              );
              this.options.onToolSyncError?.(toolName, err);
              this.options.onOfflineDegraded?.(
                toolName,
                `Artifact-bundle manifest mismatch for '${entry.name}'`,
              );
              continue;
            }
          } else if (entry.manifestDigest) {
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

        // Fast path: already registered and active at the locked version — skip the
        // redundant registerToolSync + activateToolVersion, which would rebuild the
        // whole catalog per tool (O(n²) over a large unchanged lock).
        const alreadyActive =
          this.workspaceId &&
          this.registry?.isToolActiveForWorkspace?.(entry.toolId, entry.version, this.workspaceId, {
            manifestDigest: entry.manifestDigest,
            artifactDigest: entry.artifactDigest,
            envelopeDigest: entry.envelopeDigest,
          });

        if (this.registry && !alreadyActive) {
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

    await certificatePass?.finish();
    return { activated, failed, degraded, newerAvailable: [] };
  }

  /**
   * Starts periodic catalog synchronization on the configured interval. With shared sync, a gateway
   * whose daemon publishes device sync answers follows them instead (see `followDeviceSync`); the
   * interval then only takes over again once the daemon's answers stop.
   */
  startPeriodicSync(): void {
    if (this.isRunningPeriodic) {
      return;
    }

    this.isRunningPeriodic = true;
    this.syncTimer = setInterval(async () => {
      try {
        if (await this.followDeviceSync()) return;
        await this.sync();
      } catch {
        // Errors handled in syncOnce / onSyncError
      }
    }, this.intervalMs);

    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }

    if (this.options.sharedSync) {
      this.deviceSyncTimer = setInterval(() => {
        void this.followDeviceSync().catch(() => undefined);
      }, this.deviceSyncWatchIntervalMs);
      this.deviceSyncTimer.unref?.();
    }
  }

  /**
   * Acts on the daemon's latest device sync answer, if a recent one exists, and reports whether it
   * did. Each new answer confirms tool access from the answer itself (no cloud call); the catalog is
   * fetched only when its token moved, on the first answer this gateway follows (or after an
   * identity change), or once the safety refresh is due. A gateway with no recent answer returns
   * false and keeps its own interval, exactly as without a daemon.
   */
  async followDeviceSync(): Promise<boolean> {
    const shared = this.options.sharedSync;
    if (!shared) return false;
    let published: PublishedDeviceSync | undefined;
    try {
      published = await shared.readDeviceSync();
    } catch {
      published = undefined;
    }
    if (!published) {
      this.followedDeviceSync = undefined;
      return false;
    }
    const previous = this.followedDeviceSync;
    const sameIdentity =
      previous !== undefined &&
      previous.accountId === published.sync.accountId &&
      previous.userId === published.sync.userId;
    if (sameIdentity && previous.fetchedAt === published.fetchedAt) return true;
    const catalogDue =
      !sameIdentity ||
      previous.catalogToken !== published.sync.catalogToken ||
      Date.now() - this.lastCatalogSyncAt >= DEVICE_SYNC_SAFETY_REFRESH_MS;
    const followed: FollowedDeviceSync = {
      accountId: published.sync.accountId,
      userId: published.sync.userId,
      fetchedAt: published.fetchedAt,
      // The token is recorded only once a catalog sync covering it succeeds, so a failed fetch is
      // retried on the next answer instead of waiting for the safety refresh.
      catalogToken: catalogDue
        ? sameIdentity
          ? previous.catalogToken
          : undefined
        : published.sync.catalogToken,
    };
    this.followedDeviceSync = followed;
    const startedAt = Date.now();
    try {
      // A sync already running was not given this answer; let it finish, then apply this one.
      while (this.inFlightSync) await this.inFlightSync.catch(() => undefined);
      await this.runSync(catalogDue, false, published);
      if (catalogDue && this.lastCatalogSyncAt >= startedAt) {
        followed.catalogToken = published.sync.catalogToken;
      }
    } catch (error) {
      this.options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
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
    clearInterval(this.deviceSyncTimer ?? undefined);
    this.deviceSyncTimer = null;
    this.followedDeviceSync = undefined;
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
    this.settledReconcile = undefined;

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
      await this.sync({ fresh: true });
    }
  }

  /**
   * Registers/updates all cloud tools in ToolRegistry (legacy/unlocked helper). Returns whether
   * every tool was registered and activated in a bound workspace.
   */
  private async reconcileRegistry(snapshot: CatalogSnapshotResponse): Promise<boolean> {
    if (!this.registry) {
      return false;
    }

    const tools = snapshot.tools ?? [];
    const workspaceId = this.workspaceId;
    let allActivated = workspaceId !== undefined;
    const published = this.publishedToolIds(snapshot);
    if (workspaceId) {
      this.registry.reinstateCloudTools(workspaceId, tools);
      if (published) {
        await this.registry.retireCloudTools(
          workspaceId,
          this.registry
            .getAllRegisteredTools()
            .filter(
              (registered) =>
                registered.metadata?.source === "cloud" &&
                registered.workspaceId === workspaceId &&
                !published.has(registered.toolId),
            )
            .map((registered) => ({ toolId: registered.toolId, name: registered.name })),
        );
      }
    }
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
        accountId: this.options.managedToolAccess?.identity?.accountId,
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
      const managedEntry = V1LockedToolEntrySchema.safeParse({
        toolId: tool.id,
        name: tool.name,
        version: tool.version,
        manifestDigest,
        artifactDigest,
        status: "active",
      });
      if (managedEntry.success && this.activeConfirmation) {
        this.options.managedToolAccess?.record(
          managedEntry.data,
          workspaceId,
          undefined,
          false,
          this.activeConfirmation,
        );
      }

      this.registry.registerToolSync(registryTool);

      if (workspaceId) {
        try {
          await this.registry.activateToolVersion(tool.id, tool.version, workspaceId);
        } catch {
          // Ignore activation failure for legacy reconcile
          allActivated = false;
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
    return allActivated;
  }
}

// Export LockedProjectSyncCoordinator as alias/specialization
export { CloudCatalogSyncCoordinator as LockedProjectSyncCoordinator };
