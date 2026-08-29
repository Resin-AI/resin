import type {
  V1ActivationCertificate,
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
} from "@resin/observer";
import {
  type CatalogSnapshotResponse,
  PROTOCOL_VERSION,
  type ProjectRegistrationRequest,
  ProtocolError,
  ValidationError,
} from "@resin/protocol";
import type { ArtifactCache, RuntimeTrustStore } from "@resin/runtime";
import type { ProjectLockManager } from "../project/lock-manager.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import { CloudCatalogClient, type CloudIdentityProvider } from "./client.js";
import { CloudInvocationRouter } from "./router.js";
import {
  CloudCatalogSyncCoordinator,
  type CloudCatalogSyncOptions,
  type LockedSyncIdentity,
} from "./sync.js";

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
  syncIntervalMs?: number;
  artifactCache?: ArtifactCache;
  trustStore?: RuntimeTrustStore;
  identity?: LockedSyncIdentity;
  certificateProvider?: (
    toolId: string,
    version: string,
  ) => Promise<V1ActivationCertificate | null> | V1ActivationCertificate | null;
  revocationProvider?: () => Promise<V1RevocationMetadata | null> | V1RevocationMetadata | null;
  allowDevKeys?: boolean;
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

    const router = new CloudInvocationRouter({
      circuitBreaker,
      catalogCache: cache,
      baseUrl: identity.cloudUrl,
      identityProvider,
      fetchFn: options.fetchFn,
    });

    const coordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      circuitBreaker,
      registry: options.registry,
      lockManager: options.lockManager,
      intervalMs: options.syncIntervalMs,
      artifactCache: options.artifactCache,
      trustStore: options.trustStore,
      identity: options.identity,
      certificateProvider: options.certificateProvider,
      revocationProvider: options.revocationProvider,
      allowDevKeys: options.allowDevKeys ?? false,
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
      coordinator,
      registry: options.registry,
      lockManager: options.lockManager,

      async onWorkspaceReady(workspace: WorkspaceContext): Promise<void> {
        // 1. Hydrate registry with locked tools before any cloud operations
        if (workspace.lock && options.registry) {
          if (typeof options.registry.bindWorkspaceLock === "function") {
            options.registry.bindWorkspaceLock(workspace.workspaceId, workspace.lock);
          }
        }

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
        if (coordinator && runtime.isCloudEnabled) {
          coordinator.startPeriodicSync();
        }
      },

      async stop(): Promise<void> {
        coordinator.stopPeriodicSync();
      },

      async sync(syncOpts?: { force?: boolean }): Promise<CatalogSnapshotResponse | null> {
        if (!runtime.isCloudEnabled) {
          return null;
        }
        return await coordinator.sync();
      },
    };

    return runtime;
  }

  // Safe local-only runtime state for missing / expired / offline / invalid / revoked credentials
  return {
    status: loadResult.status,
    isCloudEnabled: false,
    identity: null,
    credentialStore,
    registry: options.registry,
    lockManager: options.lockManager,

    async onWorkspaceReady(workspace: WorkspaceContext): Promise<void> {
      // Hydrate registry with locked tools locally
      if (workspace.lock && options.registry) {
        if (typeof options.registry.bindWorkspaceLock === "function") {
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
