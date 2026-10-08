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
  createLocalCallIdentity,
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
  RESIN_HARNESS_TOOL_RUNTIME,
  type RuntimeAdapter,
  type RuntimeTrustStore,
  connectMcpServer,
  createProcessAdapter,
  createProgramAdapter,
  createToolProtocolAdapter,
} from "@resin/runtime";
import type { LocalToolDatedInputs, LocalToolRecordedDefaults } from "../meta/dated-defaults.js";
import { composedResultValue } from "../meta/invoke-tool.js";
import type { LocalToolCommands } from "../meta/learned-commands.js";
import type { LocalToolPrivateValues } from "../meta/private-values.js";
import type { LocalToolDescriber } from "../meta/search-tools.js";
import { ProjectLockManager, type ReconcileOutcome } from "../project/lock-manager.js";
import type { JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import { type WorkspaceContext, sessionWorkingDirectory } from "../workspace-resolver.js";
import { CloudCatalogCache } from "./cache.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";
import { CloudCatalogClient, type CloudIdentityProvider } from "./client.js";
import { DeviceSyncStore } from "./device-sync-store.js";
import { loadLocalArtifactTrust } from "./local-artifact-trust.js";
import { LocalArtifactExecutor, type RecordedWorkflowHostContext } from "./local-executor.js";
import { CloudInvocationRouter } from "./router.js";
import { SharedCloudSync } from "./shared-sync.js";
import {
  type ArtifactBytesDownloader,
  CloudCatalogSyncCoordinator,
  type CloudCatalogSyncOptions,
  type LockedSyncIdentity,
} from "./sync.js";
import { ManagedToolAccess } from "./tool-access.js";
import { ToolCertificateReporter } from "./tool-certificate-verifier.js";
import {
  TOOL_SIGNATURES_STATE_FILE_NAME,
  ToolSignatureStateStore,
} from "./tool-signature-state.js";
import {
  FileValidationAskLedger,
  WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME,
} from "./validation-ask-ledger.js";
import {
  FileWorkflowValidationPassLease,
  WORKFLOW_VALIDATION_LEASE_FILE_NAME,
} from "./validation-lease.js";
import {
  DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS,
  WorkflowValidationClient,
  WorkflowValidationWorker,
} from "./validation-worker.js";

export interface ProductionProxyRuntimeOptions {
  credentialStore?: CloudCredentialStore;
  home?: string;
  resinHome?: string;
  tokenFilePath?: string;
  /** The running release, reported on token rotation by the credential store this creates. */
  clientVersion?: string;
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
  /**
   * Share each catalog snapshot and tool-access answer with the other gateways that use the same
   * credential file, through `cloud-sync/` beside it (`<stateDir>/cloud-sync` by default), so one
   * cloud call per interval serves all of them. Default true.
   */
  sharedCloudSync?: boolean;
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
  /** Executes an ordinary builtin through the active harness's own implementation. */
  recordedHarnessToolInvoker?: (request: {
    name: string;
    parameters: Record<string, unknown>;
    cwd: string;
    signal?: AbortSignal;
  }) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
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
  /**
   * Resolves once the catalog sync that workspace-ready started in the background has settled, or
   * after `timeoutMs`, whichever is first. A client that reads its tool list once at startup
   * otherwise never sees tools a fresh install has not synced yet.
   */
  catalogSettled?(timeoutMs: number): Promise<void>;
  /**
   * Resolves once the workspace's catalog is known: the cloud answered, or there is no cloud and the
   * local registry is the whole catalog. Never resolves while the cloud stays unreachable.
   */
  whenCatalogLoaded?(): Promise<void>;
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

/** Local discovery detail for cached learned tools: the recorded program each one runs. */
function recordedProgramDescriber(executor: LocalArtifactExecutor): LocalToolDescriber {
  return (tool, context) =>
    tool.artifactDigest === undefined
      ? undefined
      : executor.describeRecordedWorkflow(tool.artifactDigest, context);
}

/** Local discovery detail for cached learned tools: the commands each one's programs run. */
function recordedProgramCommands(executor: LocalArtifactExecutor): LocalToolCommands {
  return (tool, context) =>
    tool.artifactDigest === undefined
      ? []
      : executor.recordedWorkflowCommands(tool.artifactDigest, context);
}

/** Local schema detail for cached learned tools: each one's dated recorded-default inputs. */
function recordedDatedInputs(executor: LocalArtifactExecutor): LocalToolDatedInputs {
  return (tool, context) =>
    tool.artifactDigest === undefined
      ? new Map()
      : executor.recordedWorkflowDatedInputs(tool.artifactDigest, context);
}

/** Defense in depth for meta-tool text: the private values each cached learned tool resolves. */
function recordedPrivateValues(executor: LocalArtifactExecutor): LocalToolPrivateValues {
  return (tool, context) =>
    tool.artifactDigest === undefined
      ? []
      : executor.recordedWorkflowPrivateValues(tool.artifactDigest, context);
}

/** Local schema detail for cached learned tools: each one's non-private recorded defaults. */
function recordedDefaults(executor: LocalArtifactExecutor): LocalToolRecordedDefaults {
  return (tool, context) =>
    tool.artifactDigest === undefined
      ? new Map()
      : executor.recordedWorkflowDefaults(tool.artifactDigest, context);
}

function workspaceRootFromContext(workspace: WorkspaceContext | undefined): string | undefined {
  return (
    workspace?.projectRoot ??
    workspace?.canonicalRoot ??
    (workspace?.lockPath ? path.dirname(path.dirname(workspace.lockPath)) : undefined) ??
    workspace?.roots?.[0]?.path
  );
}

/**
 * The runtime families a recorded plan runs through on this host: a recorded program on the host,
 * a harness builtin through the active harness, and a tool by name either over the connection the
 * recording names or through the invocation's own routing, so scope, pins and permissions apply
 * identically.
 *
 * Programs and harness builtins run in the session's own directory (see
 * `sessionWorkingDirectory`): a session launched in a subdirectory of its git project recorded its
 * commands relative to that subdirectory. Steps that carry their own recorded directory — a
 * patch's absolute `workdir`, a Codex shell profile's `workdir` — keep it.
 */
export function recordedWorkflowRuntimeAdapters(
  host: RecordedWorkflowHostContext,
  options: {
    resolveConnection?: (name: string) => Promise<McpToolConnection | undefined>;
    recordedHarnessToolInvoker?: ProductionProxyRuntimeOptions["recordedHarnessToolInvoker"];
  },
): RuntimeAdapter[] {
  const projectRoot =
    host.workspace.projectRoot ?? host.workspace.canonicalRoot ?? host.workspace.roots?.[0]?.path;
  const cwd = projectRoot ? sessionWorkingDirectory(host.workspace, projectRoot) : undefined;
  const bounds = {
    ...(cwd ? { cwd } : {}),
    ...(host.timeoutMs === undefined ? {} : { timeoutMs: host.timeoutMs }),
    ...(host.invocationOutputRoot === undefined
      ? {}
      : { invocationOutputRoot: host.invocationOutputRoot }),
  };
  const { recordedHarnessToolInvoker, resolveConnection } = options;
  return [
    createProcessAdapter(bounds),
    createProgramAdapter(bounds),
    ...(recordedHarnessToolInvoker === undefined
      ? []
      : ([
          {
            runtime: RESIN_HARNESS_TOOL_RUNTIME,
            call: async (request) => {
              const result = await recordedHarnessToolInvoker({
                name: request.step.callable.name,
                parameters: request.arguments as Record<string, unknown>,
                cwd: request.workingDirectory ?? cwd ?? process.cwd(),
                ...(host.signal ? { signal: host.signal } : {}),
              });
              if (result.isError) {
                throw new Error(
                  result.content[0]?.text ??
                    `harness tool '${request.step.callable.name}' answered with an error`,
                );
              }
              return composedResultValue(result);
            },
          },
        ] satisfies RuntimeAdapter[])),
    createToolProtocolAdapter({
      ...(resolveConnection === undefined ? {} : { openConnection: resolveConnection }),
      dispatch: async (request) => {
        const result = await host.routeToHost({
          name: request.name,
          ...(request.connection ? { connection: request.connection } : {}),
          parameters: request.arguments as Record<string, unknown>,
        });
        if (result.isError) {
          const text = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;
          throw new Error(text ?? `callable '${request.name}' answered with an error`);
        }
        return composedResultValue(result);
      },
    }),
  ];
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
      clientVersion: options.clientVersion,
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
        // The resolved home (RESIN_HOME included), as the daemon executor below uses.
        resinHome: paths.homeDir,
        privateValueOwnerWorkspaceId: identity.workspaceId,
        // A plan recorded from ordinary tools runs through the families this host can really
        // reach: a recorded program on the host, and a tool by name either over the connection the
        // recording names or through the same router the original call used, so scope, pins and
        // permissions apply identically.
        recordedWorkflowAdapters: (host) =>
          recordedWorkflowRuntimeAdapters(host, {
            ...(resolveConnection === undefined ? {} : { resolveConnection }),
            ...(options.recordedHarnessToolInvoker === undefined
              ? {}
              : { recordedHarnessToolInvoker: options.recordedHarnessToolInvoker }),
          }),
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
    options.registry?.setLocalToolDescriber(recordedProgramDescriber(executor));
    options.registry?.setLocalToolCommands(recordedProgramCommands(executor));
    options.registry?.setLocalToolDatedInputs(recordedDatedInputs(executor));
    options.registry?.setLocalToolPrivateValues(recordedPrivateValues(executor));
    options.registry?.setLocalToolRecordedDefaults(recordedDefaults(executor));
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
    const sharedSync =
      options.sharedCloudSync === false
        ? undefined
        : new SharedCloudSync({
            // Gateways that share a credential file share its identity, so they share answers.
            store: new DeviceSyncStore({
              dir: path.join(path.dirname(credentialStore.getTokenFilePath()), "cloud-sync"),
            }),
            client,
            identityProvider,
          });
    const validationWorker = new WorkflowValidationWorker({
      // While the daemon publishes device sync answers it runs the passes their ask token calls for
      // (one process at a time, under the shared lease); this worker then lists only to retry its
      // own local work or for the hourly safety refresh, and polls as before once answers stop.
      ...(sharedSync === undefined
        ? {}
        : {
            followsDeviceSync: async () => (await sharedSync.readDeviceSync()) !== undefined,
          }),
      client: new WorkflowValidationClient({
        identityProvider,
        fetchImpl: fetchWithLifecycle,
      }),
      identity: { workspaceId: identity.workspaceId, deviceId: identity.deviceId },
      // Validation checks plans against this device's own recording: it reads the executor's store
      // and discovers local sessions, and never runs a recorded program or dispatches a tool call.
      privateValues: executor.getPrivateValueStore(),
      localCalls: createLocalCallIdentity({
        workspaceId: identity.workspaceId,
        privateValues: executor.getPrivateValueStore(),
      }),
      timeoutMs: DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS,
      passLease: new FileWorkflowValidationPassLease({
        filePath: path.join(paths.stateDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME),
      }),
      askLedger: new FileValidationAskLedger({
        filePath: path.join(paths.stateDir, WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME),
        ...(options.onValidationLog === undefined ? {} : { log: options.onValidationLog }),
      }),
      ...(options.onValidationLog === undefined ? {} : { log: options.onValidationLog }),
    });

    // A catalog revision change means the cloud's evolution pipeline just acted on this workspace,
    // which is when validation asks arrive: it wakes the worker onto its fast cadence. Only a new
    // revision counts; a sync that re-announces the revision already seen does not.
    const seenCatalogRevisions = new Map<string, number>();
    let unsubscribeCatalogWake: (() => void) | undefined;

    const transferClient: ArtifactBytesDownloader = options.transferClient ?? {
      async downloadArtifact(digest: string) {
        const downloaded = await client.downloadArtifact(digest);
        return { bytes: downloaded.bytes };
      },
    };

    // Report-only tool certificate checks against the compiled-in pinned keys. The binding
    // identity is the device credential: the current one when online, the one this runtime
    // started with when a pass must stay offline.
    const startupIdentity = identity;
    const toolCertificates = new ToolCertificateReporter({
      identity: async (online) => {
        let current: CloudRequestIdentity | null = startupIdentity;
        if (online) {
          try {
            current = (await identityProvider()) ?? startupIdentity;
          } catch {
            current = startupIdentity;
          }
        }
        return {
          cloudUrl: current.cloudUrl,
          accountId: current.accountId,
          workspaceId: current.workspaceId,
        };
      },
      fetchCertificates: () => client.fetchToolCertificates(),
      store: new ToolSignatureStateStore({
        filePath: path.join(paths.stateDir, TOOL_SIGNATURES_STATE_FILE_NAME),
      }),
    });
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
      toolCertificates,
      ...(sharedSync === undefined ? {} : { sharedSync }),
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
        const workspaceRoot = workspaceRootFromContext(workspace);
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
        unsubscribeCatalogWake ??= options.registry?.events.onCatalogChanged((event) => {
          const scope = `${event.workspaceId}:${event.sessionId ?? "*"}`;
          if (seenCatalogRevisions.get(scope) === event.revision) return;
          seenCatalogRevisions.set(scope, event.revision);
          validationWorker.wake();
        });
      },

      async stop(): Promise<void> {
        lifecycleAbort.abort();
        unsubscribeCatalogWake?.();
        unsubscribeCatalogWake = undefined;
        await validationWorker.stop();
        coordinator.stopPeriodicSync();
        if (backgroundTasks.size > 0) {
          await Promise.allSettled([...backgroundTasks]);
          backgroundTasks.clear();
        }
        // Releases the SQLite handle on the home's tool-access.db: on Windows an open handle stops
        // anyone deleting the home (uninstall, a fresh reinstall) for as long as this process lives.
        managedToolAccess.close();
      },
      async catalogSettled(timeoutMs: number): Promise<void> {
        if (backgroundTasks.size === 0) return;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...backgroundTasks]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      },
      whenCatalogLoaded(): Promise<void> {
        return coordinator.whenCatalogLoaded();
      },
      async sync(syncOpts?: { force?: boolean }): Promise<CatalogSnapshotResponse | null> {
        await Promise.all([...backgroundTasks]);
        return await coordinator.sync({ fresh: syncOpts?.force === true });
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
  options.registry?.setLocalToolDescriber(recordedProgramDescriber(localExecutor));
  options.registry?.setLocalToolCommands(recordedProgramCommands(localExecutor));
  options.registry?.setLocalToolDatedInputs(recordedDatedInputs(localExecutor));
  options.registry?.setLocalToolPrivateValues(recordedPrivateValues(localExecutor));
  options.registry?.setLocalToolRecordedDefaults(recordedDefaults(localExecutor));

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
      const workspaceRoot = workspaceRootFromContext(workspace);
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
      // Cleanup at creation opened the tool-access.db; an open handle pins the home on Windows.
      managedToolAccess.close();
    },

    async whenCatalogLoaded(): Promise<void> {
      // Without cloud credentials the local registry is the whole catalog.
    },

    async sync(): Promise<CatalogSnapshotResponse | null> {
      return null;
    },
  };
}
