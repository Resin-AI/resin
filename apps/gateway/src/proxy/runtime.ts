import path from "node:path";
import type {
  V1ActivationCertificate,
  V1LockedToolEntry,
  V1ProjectMetadata,
  V1RevocationMetadata,
  V1ToolLock,
} from "@resin/contracts";
import type { SecretManager } from "@resin/crypto";
import {
  type CloudCredentialLoadResult,
  type CloudCredentialStatus,
  CloudCredentialStore,
  type CloudCredentialStoreOptions,
  type CloudRequestIdentity,
  resolvePaths,
} from "@resin/observer";
import {
  type CatalogSnapshotResponse,
  PROTOCOL_VERSION,
  type ProjectRegistrationRequest,
  ProtocolError,
  ValidationError,
} from "@resin/protocol";
import { ArtifactCache, type RuntimeTrustStore } from "@resin/runtime";
import { ProjectLockManager, type ReconcileOutcome } from "../project/lock-manager.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import { CloudCatalogClient, type CloudIdentityProvider } from "./client.js";
import { LocalArtifactExecutor } from "./local-executor.js";
import { CloudInvocationRouter } from "./router.js";
import {
  type ArtifactBytesDownloader,
  CloudCatalogSyncCoordinator,
  type CloudCatalogSyncOptions,
  type LockedSyncIdentity,
} from "./sync.js";
import { ManagedToolAccess } from "./tool-access.js";

export interface ProductionProxyRuntimeOptions {
  credentialStore?: CloudCredentialStore;
  home?: string;
  resinHome?: string;
  tokenFilePath?: string;
  secretManager?: SecretManager;
  fetchFn?: typeof fetch;
  circuitBreaker?: CloudCircuitBreaker;
  cache?: CloudCatalogCache;
  registry?: ToolRegistry;
  lockManager?: ProjectLockManager;
  /**
   * When true (default), each ready workspace with a `.resin/resin.lock` gets its own
   * ProjectLockManager so published tools are activated from verified local artifacts.
   */
  bindWorkspaceLocks?: boolean;
  syncIntervalMs?: number;
  artifactCache?: ArtifactCache;
  transferClient?: ArtifactBytesDownloader;
  trustStore?: RuntimeTrustStore;
  identity?: LockedSyncIdentity;
  certificateProvider?: (
    toolId: string,
    version: string,
  ) => Promise<V1ActivationCertificate | null> | V1ActivationCertificate | null;
  revocationProvider?: () => Promise<V1RevocationMetadata | null> | V1RevocationMetadata | null;
  allowDevKeys?: boolean;
  executor?: LocalArtifactExecutor;
  onToolQualified?: (tool: V1LockedToolEntry, outcome: ReconcileOutcome) => void;
  onToolSyncError?: (toolName: string, error: Error) => void;
  onOfflineDegraded?: (toolName: string, reason: string) => void;
  isPinned?: (toolId: string) => boolean;
}

export interface ProductionProxyRuntime {
  status: CloudCredentialStatus;
  isCloudEnabled: boolean;
  identity: CloudRequestIdentity | null;
  credentialStore: CloudCredentialStore;
  circuitBreaker?: CloudCircuitBreaker;
  client?: CloudCatalogClient;
  cache?: CloudCatalogCache;
  router?: CloudInvocationRouter;
  coordinator?: CloudCatalogSyncCoordinator;
  registry?: ToolRegistry;
  lockManager?: ProjectLockManager;
  executor?: LocalArtifactExecutor;
  onWorkspaceReady(workspace: WorkspaceContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(options?: { force?: boolean }): Promise<CatalogSnapshotResponse | null>;
}

/**
 * Production runtime composition factory.
 * Loads CloudCredentialStore and, only for valid identity, constructs one shared
 * circuit breaker, CloudCatalogClient, CloudCatalogCache, CloudInvocationRouter,
 * and CloudCatalogSyncCoordinator with registry auto-registration.
 *
 * Missing/expired/offline/revoked credentials produce a safe local-only runtime state,
 * never throwing an uncaught exception.
 */
export async function createProductionProxyRuntime(
  options: ProductionProxyRuntimeOptions = {},
): Promise<ProductionProxyRuntime> {
  const credentialStore =
    options.credentialStore ??
    new CloudCredentialStore({
      home: options.home,
      resinHome: options.resinHome,
      tokenFilePath: options.tokenFilePath,
      secretManager: options.secretManager,
      fetchImpl: options.fetchFn,
    });

  let loadResult: CloudCredentialLoadResult;
  try {
    loadResult = await credentialStore.load();
  } catch {
    loadResult = { status: "missing" };
  }

  let identity: CloudRequestIdentity | null = null;
  if (loadResult.status === "valid") {
    try {
      identity = await credentialStore.getRequestIdentity();
    } catch {
      identity = null;
    }
  }
  const paths = resolvePaths({ home: options.home, resinHome: options.resinHome });
  const artifactCache =
    options.artifactCache ??
    new ArtifactCache({
      cacheDir: path.join(paths.dataDir, "artifacts"),
    });
  const managedToolAccess = new ManagedToolAccess(
    path.join(paths.stateDir, "managed-tool-access"),
    artifactCache,
    identity ?? undefined,
  );
  options.registry?.setManagedToolAccess(managedToolAccess);

  if (loadResult.status === "valid" && identity) {
    const circuitBreaker = options.circuitBreaker ?? new CloudCircuitBreaker();
    const identityProvider: CloudIdentityProvider = async (opts) => {
      return await credentialStore.getRequestIdentity(opts);
    };

    const client = new CloudCatalogClient({
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      baseUrl: identity.cloudUrl,
      identityProvider,
      circuitBreaker,
      fetchFn: options.fetchFn,
    });

    const cache = options.cache ?? new CloudCatalogCache();

    const executor =
      options.executor ??
      new LocalArtifactExecutor({
        cache: artifactCache,
        workspaceRoot: process.cwd(),
        allowDevKeys: options.allowDevKeys ?? false,
        resinHome:
          options.resinHome ?? (options.home ? path.join(options.home, ".resin") : undefined),
      });
    executor.setManagedToolAccess(managedToolAccess);

    const router = new CloudInvocationRouter({
      circuitBreaker,
      catalogCache: cache,
      baseUrl: identity.cloudUrl,
      identityProvider,
      fetchFn: options.fetchFn,
      localExecutor: executor,
      lockManager: options.lockManager,
    });
    router.setManagedToolAccess(managedToolAccess);
    const transferClient: ArtifactBytesDownloader = options.transferClient ?? {
      async downloadArtifact(digest: string) {
        const downloaded = await client.downloadArtifact(digest);
        return { bytes: downloaded.bytes };
      },
    };
    const bindWorkspaceLocks = options.bindWorkspaceLocks ?? true;

    const coordinator = new CloudCatalogSyncCoordinator({
      managedToolAccess,
      client,
      cache,
      router,
      circuitBreaker,
      registry: options.registry,
      workspaceId: undefined,
      lockManager: options.lockManager,
      transferClient,
      artifactCache,
      intervalMs: options.syncIntervalMs,
      trustStore: options.trustStore,
      identity: options.identity,
      certificateProvider: options.certificateProvider,
      revocationProvider: options.revocationProvider,
      allowDevKeys: options.allowDevKeys ?? false,
      onToolQualified: options.onToolQualified,
      onToolSyncError: options.onToolSyncError,
      onOfflineDegraded: options.onOfflineDegraded,
      isPinned: options.isPinned,
    });

    const runtime: ProductionProxyRuntime = {
      status: "valid",
      isCloudEnabled: true,
      identity,
      credentialStore,
      circuitBreaker,
      client,
      cache,
      router,
      executor,
      coordinator,
      registry: options.registry,
      lockManager: options.lockManager,
      async onWorkspaceReady(workspace: WorkspaceContext): Promise<void> {
        const workspaceRoot =
          workspace.projectRoot ??
          workspace.canonicalRoot ??
          (workspace.lockPath ? path.dirname(path.dirname(workspace.lockPath)) : undefined) ??
          workspace.roots?.[0]?.path;
        if (workspaceRoot) {
          executor.setWorkspaceRoot(workspaceRoot);
        }
        // 1. Hydrate registry with locked tools before any cloud operations
        if (workspace.lock && options.registry) {
          if (
            "bindWorkspaceLock" in options.registry &&
            options.registry.bindWorkspaceLock instanceof Function
          ) {
            options.registry.bindWorkspaceLock(workspace.workspaceId, workspace.lock);
          }
        }

        // 1b. Bind the coordinator to this workspace so registry entries are scoped to it and,
        //     when the project has a lock file, activation reconciles the catalog into
        //     `.resin/resin.lock` and verified local artifacts.
        if (bindWorkspaceLocks && !options.lockManager) {
          let lockManager: ProjectLockManager | undefined;
          if (workspace.lockPath) {
            try {
              lockManager = new ProjectLockManager({
                lockPath: workspace.lockPath,
                projectId: workspace.projectId,
                readOnly: workspace.isReadOnly,
              });
            } catch {
              lockManager = undefined;
            }
          }
          coordinator.bindWorkspace({ workspaceId: workspace.workspaceId, lockManager });
          if (lockManager) {
            router.setLockManager(lockManager);
          }
        }

        // Entitlement checks must not depend on plan-gated project registration or catalog.
        try {
          await coordinator.checkToolAccess();
        } catch {
          // Unknown access preserves local tools; the next background cycle retries.
        }
        coordinator.startPeriodicSync();
        // 2. Register project if metadata exists
        let allowCloudSync = true;
        if (workspace.project && client) {
          try {
            const regRequest: ProjectRegistrationRequest = {
              project: workspace.project,
              visibility: "workspace",
            };
            const regResponse = await client.registerProject(regRequest);

            if (regResponse.outcome === "fork_required") {
              // Foreign / fork-required registration: never substitute stable local project identity,
              // transition cloud runtime to local-only/paused and disable cloud sync without throwing.
              allowCloudSync = false;
              runtime.isCloudEnabled = false;
            } else if (regResponse.projectId !== workspace.project.projectId) {
              // ID substitution: transition to local-only/paused without throwing, preserve local project
              allowCloudSync = false;
              runtime.isCloudEnabled = false;
            }
          } catch {
            // Cloud registration failures (offline, network error, foreign project ID substitution, etc.)
            // degrade safely to local-only without disrupting local MCP initialization.
            allowCloudSync = false;
            runtime.isCloudEnabled = false;
          }
        }

        coordinator.setCatalogSyncEnabled(allowCloudSync);
        // 3. Perform initial sync and start periodic background sync
        if (coordinator && allowCloudSync && runtime.isCloudEnabled) {
          try {
            await coordinator.sync();
          } catch {
            // Offline degradation handled internally in sync coordinator
          }
          coordinator.startPeriodicSync();
        }
      },

      async start(): Promise<void> {
        coordinator.startPeriodicSync();
      },

      async stop(): Promise<void> {
        coordinator.stopPeriodicSync();
      },

      async sync(_syncOpts?: { force?: boolean }): Promise<CatalogSnapshotResponse | null> {
        return await coordinator.sync();
      },
    };

    return runtime;
  }

  const localExecutor =
    options.executor ??
    new LocalArtifactExecutor({
      cache: artifactCache,
      workspaceRoot: process.cwd(),
      allowDevKeys: options.allowDevKeys ?? false,
      resinHome: paths.homeDir,
    });
  localExecutor.setManagedToolAccess(managedToolAccess);
  // Persisted positive denial remains effective even if credentials are now unavailable.
  try {
    const release = managedToolAccess.acquireSync();
    if (release) {
      try {
        await managedToolAccess.cleanup(options.registry);
      } finally {
        release();
      }
    }
  } catch {
    // Invocation/discovery guards remain in place; retry on the next runtime lifecycle.
  }
  return {
    status: loadResult.status,
    isCloudEnabled: false,
    identity: null,
    credentialStore,
    registry: options.registry,
    lockManager: options.lockManager,
    executor: localExecutor,

    async onWorkspaceReady(workspace: WorkspaceContext): Promise<void> {
      // Hydrate registry with locked tools locally
      if (workspace.lock && options.registry) {
        if (
          "bindWorkspaceLock" in options.registry &&
          options.registry.bindWorkspaceLock instanceof Function
        ) {
          options.registry.bindWorkspaceLock(workspace.workspaceId, workspace.lock);
        }
      }
    },

    async start(): Promise<void> {
      // Safe no-op
    },

    async stop(): Promise<void> {
      // Safe no-op
    },

    async sync(): Promise<CatalogSnapshotResponse | null> {
      return null;
    },
  };
}
