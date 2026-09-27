import path from "node:path";
import {
  type DaemonModule,
  type DaemonModuleProviderContext,
  FilePrivateValueStore,
  type ModuleContext,
  type ModuleHealth,
  type ModuleLifecycleState,
  createLocalCallIdentity,
} from "@resin/observer";
import {
  FileWorkflowValidationPassLease,
  WORKFLOW_VALIDATION_LEASE_FILE_NAME,
} from "./validation-lease.js";
import {
  DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS,
  WorkflowValidationClient,
  WorkflowValidationWorker,
  type WorkflowValidationWorkerOptions,
} from "./validation-worker.js";

export const WORKFLOW_VALIDATION_DAEMON_MODULE_ID = "workflow-validation";

/**
 * Answers the cloud's validation asks from the background daemon, so a learned tool is checked and
 * published without any agent session running `resin mcp`.
 *
 * It is the gateway's worker, built the way the gateway builds it: the same transport, the same
 * recording check over this device's own sessions and private-value store, the same workspace and
 * plan-digest refusals. It never runs a recorded program. The device-wide pass lease it shares with
 * every gateway keeps one process answering at a time.
 */
export class WorkflowValidationDaemonModule implements DaemonModule {
  readonly id = WORKFLOW_VALIDATION_DAEMON_MODULE_ID;
  readonly name = "Workflow Validation Answers";
  readonly dependencies = ["cloud-runtime"] as const;
  readonly critical = false;

  private readonly worker: WorkflowValidationWorker;
  private state: ModuleLifecycleState = "uninitialized";

  constructor(worker: WorkflowValidationWorker) {
    this.worker = worker;
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(_context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.worker.start();
    this.state = "ready";
  }

  async stop(_context: ModuleContext): Promise<void> {
    this.state = "stopping";
    this.worker.stop();
    this.state = "stopped";
  }

  async healthCheck(): Promise<ModuleHealth> {
    return this.worker.isRunning()
      ? { status: "ready", lastCheckTime: Date.now() }
      : { status: "degraded", message: "validation polling is stopped", lastCheckTime: Date.now() };
  }
}

/**
 * The daemon's module for an enrolled device. `overrides` exist for tests and the local smoke;
 * the packaged daemon passes none.
 */
export function createWorkflowValidationDaemonModule(
  context: DaemonModuleProviderContext,
  overrides: Partial<Omit<WorkflowValidationWorkerOptions, "identity">> = {},
): WorkflowValidationDaemonModule {
  const privateValues = overrides.privateValues ?? FilePrivateValueStore.default();
  const workspaceId = context.credentials.workspaceId;
  return new WorkflowValidationDaemonModule(
    new WorkflowValidationWorker({
      client: new WorkflowValidationClient({
        identityProvider: (identityOptions) =>
          context.credentialStore.getRequestIdentity(identityOptions),
      }),
      privateValues,
      localCalls: createLocalCallIdentity({ workspaceId, privateValues }),
      timeoutMs: DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS,
      passLease: new FileWorkflowValidationPassLease({
        filePath: path.join(context.paths.stateDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME),
      }),
      log: (message) => context.logger.info(message),
      ...overrides,
      identity: { workspaceId, deviceId: context.credentials.deviceId },
    }),
  );
}
