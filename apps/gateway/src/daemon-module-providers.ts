import type { DaemonModuleProvider } from "@resin/observer";
import { createDeviceSyncRelayDaemonModule } from "./proxy/device-sync-daemon-module.js";
import { createStoredToolGcDaemonModule } from "./proxy/stored-tool-gc-daemon-module.js";
import { createWorkflowValidationDaemonModule } from "./proxy/validation-daemon-module.js";

/**
 * The gateway services the packaged daemon runs. The daemon calls every provider at startup, signed
 * in or not: cloud-dependent providers return nothing without credentials, local-only maintenance
 * (stored-tool GC) always registers.
 */
export const GATEWAY_DAEMON_MODULE_PROVIDERS: readonly DaemonModuleProvider[] = [
  ({ credentials, ...context }) =>
    credentials ? createWorkflowValidationDaemonModule({ ...context, credentials }) : undefined,
  (context) => createDeviceSyncRelayDaemonModule(context),
  (context) => createStoredToolGcDaemonModule(context),
];
