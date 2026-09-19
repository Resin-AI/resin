import path from "node:path";
import type {
  V1ActivationCertificate,
  V1LockedToolEntry,
  V1ProjectMetadata,
  V1RevocationMetadata,
  V1ToolLock,
  WorkflowJsonValue,
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
import {
  ArtifactCache,
  type McpServerDescriptor,
  type McpToolConnection,
  type RuntimeTrustStore,
  type ToolProtocolDispatchRequest,
  connectMcpServer,
  createProcessAdapter,
  createProgramAdapter,
  createToolProtocolAdapter,
} from "@resin/runtime";
import { composedResultValue } from "../meta/invoke-tool.js";
import { ProjectLockManager, type ReconcileOutcome } from "../project/lock-manager.js";
import type { JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import { CloudCatalogClient, type CloudIdentityProvider } from "./client.js";
import { loadLocalArtifactTrust } from "./local-artifact-trust.js";
import { LocalArtifactExecutor } from "./local-executor.js";
import { CloudInvocationRouter } from "./router.js";
import {
  type ArtifactBytesDownloader,
  CloudCatalogSyncCoordinator,
  type CloudCatalogSyncOptions,
  type LockedSyncIdentity,
} from "./sync.js";
import { ManagedToolAccess } from "./tool-access.js";
import { WorkflowValidationClient, WorkflowValidationWorker } from "./validation-worker.js";

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
  /**
   * Protocol connections the host can dial by the name a recording carries, for a step whose
   * callable was reached over a protocol rather than through this host's own routing. A name the
   * host cannot resolve is refused by the step, never answered from a remembered value.
   */
  recordedWorkflowConnections?: (name: string) => McpServerDescriptor | undefined;
  onToolQualified?: (tool: V1LockedToolEntry, outcome: ReconcileOutcome) => void;
  onToolSyncError?: (toolName: string, error: Error) => void;
  onOfflineDegraded?: (toolName: string, reason: string) => void;
  /** Where the validation worker reports an ask it would not answer and an answer the cloud declined. */
  onValidationLog?: (message: string) => void;
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
  /**
   * Answers the cloud's pending validation asks from this machine. Present only when credentials
   * are valid: whether a recording's proposals hold is decided where its values are, on the
   * authenticated connection that recorded them.
   */
  validationWorker?: WorkflowValidationWorker;
  onWorkspaceReady(workspace: WorkspaceContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(options?: { force?: boolean }): Promise<CatalogSnapshotResponse | null>;
}

/**
 * A resolver of protocol connections, dialed on first use and reused afterwards.
 *
 * A step that runs mid-workflow must not pay a fresh handshake, so an opened connection is kept for
 * the life of the process. A connection that fails to open is NOT cached: the failure is the step's
 * failure, and a later attempt may still succeed once the server is back.
 */
function memoizedConnections(
  resolve: (name: string) => McpServerDescriptor | undefined,
): (name: string) => Promise<McpToolConnection | undefined> {
  const live = new Map<string, McpToolConnection>();
  const opening = new Map<string, Promise<McpToolConnection | undefined>>();
  return async (name: string): Promise<McpToolConnection | undefined> => {
    const existing = live.get(name);
    if (existing !== undefined) return existing;
    const inFlight = opening.get(name);
    if (inFlight !== undefined) return await inFlight;
    const descriptor = resolve(name);
    if (descriptor === undefined) return undefined;
    const attempt = connectMcpServer(descriptor)
      .then((connection) => {
        live.set(name, connection);
        return connection;
      })
      .finally(() => {
        opening.delete(name);
      });
    opening.set(name, attempt);
    return await attempt;
  };
}

/**
 * Production runtime composition factory.
 * Loads CloudCredentialStore and, only for valid identity, constructs one shared
 * circuit breaker, CloudCatalogClient, CloudCatalogCache, CloudInvocationRouter,
 * and CloudCatalogSyncCoordinator with registry auto-registration.
 *
 * Missing/expired/offline/revoked credentials normally produce a safe local-only state.
 * RESIN_LOCAL_ARTIFACT_TRUST_FILE explicitly pins one development signing key to the
 * credential's exact loopback origin. Invalid local trust configuration fails closed,
 * including when no valid credential origin is available.
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
  const localKeyStore = loadLocalArtifactTrust(paths.homeDir, identity?.cloudUrl);
  const allowDevKeys = localKeyStore !== undefined || (options.allowDevKeys ?? false);
  const artifactCache =
    options.artifactCache ??
    new ArtifactCache({
      cacheDir: path.join(paths.dataDir, "artifacts"),
      keyStore: localKeyStore,
    });
  const managedToolAccess = new ManagedToolAccess(
    path.join(paths.stateDir, "managed-tool-access"),
    artifactCache,
    identity ?? undefined,
  );
  options.registry?.setManagedToolAccess(managedToolAccess);

  if (loadResult.status === "valid" && identity) {
    const lifecycleAbort = new AbortController();
    const fetchWithLifecycle: typeof fetch = async (input, init) => {
      lifecycleAbort.signal.throwIfAborted();
      return await (options.fetchFn ?? globalThis.fetch)(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, lifecycleAbort.signal])
          : lifecycleAbort.signal,
      });
    };
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
      fetchFn: fetchWithLifecycle,
    });

    const cache = options.cache ?? new CloudCatalogCache();

    // The protocol connections a recording can name, dialed on first use and kept for the life of
    // the process. The same resolver serves the executor's recorded-workflow steps, this host's own
    // routing of a named connection, and the replay the validation worker runs: every path that
    // re-makes a recorded call reaches the server the record names, or fails naming it.
    const resolveConnection =
      options.recordedWorkflowConnections === undefined
        ? undefined
        : memoizedConnections(options.recordedWorkflowConnections);

    // The executor's stepInvoker resolves the router lazily: the router is constructed
    // after the executor because it takes the executor as its local dispatcher.
    const routerBox: { current?: CloudInvocationRouter } = {};
    const executor =
      options.executor ??
      new LocalArtifactExecutor({
        cache: artifactCache,
        workspaceRoot: process.cwd(),
        keyStore: localKeyStore,
        allowDevKeys,
        requireSignature: localKeyStore ? true : undefined,
        resinHome:
          options.resinHome ?? (options.home ? path.join(options.home, ".resin") : undefined),
        privateValueOwnerWorkspaceId: identity.workspaceId,
        // A plan recorded from ordinary tools runs through the families this host can really
        // reach: a recorded program on the host, and a tool by name either over the connection the
        // recording names or through the same router the original call used, so scope, pins and
        // permissions apply identically.
        recordedWorkflowAdapters: (host) => {
          const workspaceRoot =
            host.workspace.projectRoot ??
            host.workspace.canonicalRoot ??
            host.workspace.roots?.[0]?.path;
          const bounds = {
            ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
            ...(host.timeoutMs === undefined ? {} : { timeoutMs: host.timeoutMs }),
          };
          return [
            createProcessAdapter(bounds),
            createProgramAdapter(bounds),
            createToolProtocolAdapter({
              ...(resolveConnection === undefined ? {} : { openConnection: resolveConnection }),
              dispatch: async (request) => {
                const result = await host.routeToHost({
                  name: request.name,
                  ...(request.connection ? { connection: request.connection } : {}),
                  parameters: request.arguments as Record<string, unknown>,
                });
                if (result.isError) {
                  const text =
                    result.content?.[0]?.type === "text" ? result.content[0].text : undefined;
                  throw new Error(text ?? `callable '${request.name}' answered with an error`);
                }
                return composedResultValue(result);
              },
            }),
          ];
        },
        stepInvoker: async (request) => {
          const router = routerBox.current;
          if (!router) {
            return {
              isError: true,
              content: [{ type: "text", text: "Step dispatcher is not ready" }],
            };
          }
          return await router.invoke({
            toolId: request.name,
            name: request.name,
            version: "",
            ...(request.connection ? { connection: request.connection } : {}),
            parameters: request.parameters as JsonRpcParams,
            context: request.context,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          });
        },
      });
    executor.setManagedToolAccess(managedToolAccess);
    routerBox.current = new CloudInvocationRouter({
      circuitBreaker,
      catalogCache: cache,
      baseUrl: identity.cloudUrl,
      identityProvider,
      fetchFn: options.fetchFn,
      localExecutor: executor,
      lockManager: options.lockManager,
      ...(resolveConnection === undefined ? {} : { connectionResolver: resolveConnection }),
    });
    routerBox.current.setManagedToolAccess(managedToolAccess);
    // The validation worker answers the cloud's asks where the recording's values are: the plan's
    // private references resolve from the same store the executor resolves them from, and a step
    // that calls a tool goes back through this host's own routing — the same entry the original
    // call used — while the recorded programs run in the validator's own disposable directory.
    const readyWorkspace: { current?: WorkspaceContext } = {};
    const validationWorker = new WorkflowValidationWorker({
      client: new WorkflowValidationClient({
        identityProvider,
        fetchImpl: fetchWithLifecycle,
      }),
      identity: { workspaceId: identity.workspaceId, deviceId: identity.deviceId },
      privateValues: executor.getPrivateValueStore(),
      dispatch: async (request: ToolProtocolDispatchRequest): Promise<WorkflowJsonValue> => {
        const router = routerBox.current;
        if (router === undefined) throw new Error("Step dispatcher is not ready");
        const workspace = readyWorkspace.current;
        if (workspace === undefined) {
          throw new Error(
            "the workspace is not ready, so a recorded tool step cannot be routed through this host",
          );
        }
        const result = await router.invoke({
          toolId: request.name,
          name: request.name,
          version: "",
          ...(request.connection ? { connection: request.connection } : {}),
          parameters: request.arguments as JsonRpcParams,
          context: workspace,
        });
        if (result.isError) {
          const text = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;
          throw new Error(text ?? `callable '${request.name}' answered with an error`);
        }
        return composedResultValue(result);
      },
      ...(resolveConnection === undefined ? {} : { openConnection: resolveConnection }),
      ...(options.onValidationLog === undefined ? {} : { log: options.onValidationLog }),
    });
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
      router: routerBox.current,
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
      allowDevKeys,
      onToolQualified: options.onToolQualified,
      onToolSyncError: options.onToolSyncError,
      onOfflineDegraded: options.onOfflineDegraded,
      isPinned: options.isPinned,
    });
    const backgroundTasks = new Set<Promise<unknown>>();

    const runtime: ProductionProxyRuntime = {
      status: "valid",
      isCloudEnabled: true,
      identity,
      credentialStore,
      circuitBreaker,
      client,
      cache,
      router: routerBox.current,
      executor,
      validationWorker,
      coordinator,
      registry: options.registry,
      lockManager: options.lockManager,
      async onWorkspaceReady(workspace: WorkspaceContext): Promise<void> {
        readyWorkspace.current = workspace;
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
            routerBox.current?.setLockManager(lockManager);
          }
        }

        // 1c. Reconcile verified local locked tools immediately on workspace ready
        //     so tools are available on cold start before network calls, even under contention or offline
        try {
          await coordinator.reconcileLockedToolsOffline();
        } catch {
          // Non-fatal for initial local restore
        }

        // 2. Start periodic background sync for ongoing retries/refresh
        coordinator.startPeriodicSync();

        // 3. Entitlement check, project registration, and online catalog sync run in a
        //    tracked background task so onWorkspaceReady returns promptly without blocking MCP initialization.
        if (!lifecycleAbort.signal.aborted) {
          const bgTask = (async () => {
            if (lifecycleAbort.signal.aborted) return;

            // Step A: Entitlement check
            try {
              await coordinator.checkToolAccess();
            } catch {
              // Unknown access preserves local tools; periodic retries handle refresh
            }

            if (lifecycleAbort.signal.aborted) return;

            // Step B: Project registration if metadata exists
            let allowCloudSync = true;
            if (workspace.project && client) {
              try {
                const regRequest: ProjectRegistrationRequest = {
                  project: workspace.project,
                  visibility: "workspace",
                };
                const regResponse = await client.registerProject(regRequest, {
                  signal: lifecycleAbort.signal,
                });

                if (regResponse.outcome === "fork_required") {
                  allowCloudSync = false;
                  runtime.isCloudEnabled = false;
                } else if (regResponse.projectId !== workspace.project.projectId) {
                  allowCloudSync = false;
                  runtime.isCloudEnabled = false;
                }
              } catch {
                allowCloudSync = false;
                runtime.isCloudEnabled = false;
              }
            }

            coordinator.setCatalogSyncEnabled(allowCloudSync);

            if (lifecycleAbort.signal.aborted) return;

            // Step C: Initial online sync with fallback
            if (coordinator && allowCloudSync && runtime.isCloudEnabled) {
              try {
                await coordinator.sync();
              } catch {
                try {
                  await coordinator.reconcileLockedToolsOffline();
                } catch {
                  // Non-fatal
                }
              }
            } else if (coordinator) {
              try {
                await coordinator.reconcileLockedToolsOffline();
              } catch {
                // Non-fatal
              }
            }
          })();

          backgroundTasks.add(bgTask);
          void bgTask.then(
            () => backgroundTasks.delete(bgTask),
            () => backgroundTasks.delete(bgTask),
          );
        }
      },

      async start(): Promise<void> {
        coordinator.startPeriodicSync();
        validationWorker.start();
      },

      async stop(): Promise<void> {
        lifecycleAbort.abort();
        validationWorker.stop();
        coordinator.stopPeriodicSync();
        if (backgroundTasks.size > 0) {
          await Promise.allSettled([...backgroundTasks]);
          backgroundTasks.clear();
        }
      },
      async sync(_syncOpts?: { force?: boolean }): Promise<CatalogSnapshotResponse | null> {
        await Promise.all([...backgroundTasks]);
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
      keyStore: localKeyStore,
      allowDevKeys,
      requireSignature: localKeyStore ? true : undefined,
      resinHome: paths.homeDir,
    });
  localExecutor.setManagedToolAccess(managedToolAccess);

  // Persisted positive denial remains effective even if credentials are now unavailable.
  try {
    await managedToolAccess.cleanup(options.registry);
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
      const workspaceRoot =
        workspace.projectRoot ??
        workspace.canonicalRoot ??
        (workspace.lockPath ? path.dirname(path.dirname(workspace.lockPath)) : undefined) ??
        workspace.roots?.[0]?.path;
      if (workspaceRoot) {
        localExecutor.setWorkspaceRoot(workspaceRoot);
      }
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
