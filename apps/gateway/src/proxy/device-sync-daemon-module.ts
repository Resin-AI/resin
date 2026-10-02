import path from "node:path";
import type {
  DaemonModule,
  DaemonModuleProviderContext,
  DeviceSyncSignal,
  DeviceSyncSnapshot,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "@resin/observer";
import { DeviceSyncStore } from "./device-sync-store.js";
import { SharedDeviceSync } from "./shared-sync.js";

export const DEVICE_SYNC_RELAY_DAEMON_MODULE_ID = "device-sync-relay";

/**
 * Relays the daemon's consolidated device sync to the gateways of the same login.
 *
 * Gateways already share cloud answers through the per-user `cloud-sync` store next to the
 * credential file. This module publishes every device sync answer there and withdraws it when the
 * daemon's answers stop, so a running gateway follows the daemon's one sync loop instead of polling
 * the cloud on its own timer, and returns to that timer as soon as the daemon goes away.
 */
export class DeviceSyncRelayDaemonModule implements DaemonModule {
  readonly id = DEVICE_SYNC_RELAY_DAEMON_MODULE_ID;
  readonly name = "Gateway Device Sync Relay";
  readonly dependencies = ["cloud-runtime"] as const;
  readonly critical = false;

  private readonly signal: DeviceSyncSignal;
  private readonly shared: SharedDeviceSync;
  private state: ModuleLifecycleState = "uninitialized";
  private unsubscribe?: () => void;
  /** Serializes writes so answers reach the store in the order the loop produced them. */
  private queue: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(signal: DeviceSyncSignal, shared: SharedDeviceSync) {
    this.signal = signal;
    this.shared = shared;
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(_context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.unsubscribe ??= this.signal.subscribe((snapshot) => this.relay(snapshot));
    const current = this.signal.current();
    if (current) await this.relay(current);
    this.state = "ready";
  }

  async stop(_context: ModuleContext): Promise<void> {
    this.state = "stopping";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.relay(null);
    this.state = "stopped";
  }

  /** Publishes an answer, or withdraws the published one when answers stop. */
  relay(snapshot: DeviceSyncSnapshot | null): Promise<void> {
    const next = this.queue.then(async () => {
      try {
        if (snapshot) await this.shared.publish(snapshot.sync, snapshot.requestedAt);
        else await this.shared.withdraw();
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    });
    this.queue = next;
    return next;
  }

  async healthCheck(): Promise<ModuleHealth> {
    return this.lastError === null
      ? { status: "ready", lastCheckTime: Date.now() }
      : { status: "degraded", message: this.lastError, lastCheckTime: Date.now() };
  }
}

/** The relay for an enrolled daemon; nothing when the daemon runs no device sync loop. */
export function createDeviceSyncRelayDaemonModule(
  context: DaemonModuleProviderContext,
): DeviceSyncRelayDaemonModule | undefined {
  if (!context.deviceSync) return undefined;
  const shared = new SharedDeviceSync({
    // The gateways' shared store: next to the credential file they and the daemon both read.
    store: new DeviceSyncStore({
      dir: path.join(path.dirname(context.credentialStore.getTokenFilePath()), "cloud-sync"),
    }),
    identityProvider: () => context.credentialStore.getRequestIdentity(),
    onError: (error) =>
      context.logger.warn("Device sync answer could not be shared with gateways", {
        reason: error.message,
      }),
  });
  return new DeviceSyncRelayDaemonModule(context.deviceSync, shared);
}
