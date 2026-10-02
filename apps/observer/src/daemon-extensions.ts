import type { CloudCredentialStore, StoredCloudCredentials } from "./cloud-credentials.js";
import type { DeviceSyncSignal } from "./device-sync-signal.js";
import type { DaemonModule, Logger } from "./lifecycle.js";
import type { DaemonPaths } from "./paths.js";

/** What a module provider may build its module from: the daemon's own paths and device identity. */
export interface DaemonModuleProviderContext {
  readonly paths: DaemonPaths;
  readonly logger: Logger;
  readonly credentialStore: CloudCredentialStore;
  readonly credentials: StoredCloudCredentials;
  /**
   * The daemon's consolidated device sync, when the cloud offers it. Modules that would poll the
   * cloud for their own state subscribe and refetch only when their change token moves.
   */
  readonly deviceSync?: DeviceSyncSignal;
}

/**
 * Builds a daemon module from a package the observer cannot depend on.
 *
 * `@resin/gateway` depends on `@resin/observer`, so the daemon cannot import gateway services
 * directly. The packaged daemon entry (`@resin/gateway`'s `bin/daemon`) registers its providers
 * here before it loads the daemon, and the daemon registers each provider's module once the device
 * is enrolled. A provider that returns `undefined` contributes nothing.
 */
export type DaemonModuleProvider = (
  context: DaemonModuleProviderContext,
) => DaemonModule | undefined;

const providers: DaemonModuleProvider[] = [];

export function registerDaemonModuleProvider(provider: DaemonModuleProvider): void {
  providers.push(provider);
}

export function registeredDaemonModuleProviders(): readonly DaemonModuleProvider[] {
  return providers;
}
