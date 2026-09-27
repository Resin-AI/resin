#!/usr/bin/env node

/**
 * The packaged background daemon: `@resin/observer`'s daemon with the gateway services it cannot
 * import itself, because `@resin/gateway` depends on `@resin/observer`. Providers are registered
 * before the daemon module is loaded, since loading it starts the daemon.
 */
import { registerDaemonModuleProvider } from "@resin/observer";
import { createWorkflowValidationDaemonModule } from "../proxy/validation-daemon-module.js";

registerDaemonModuleProvider((context) => createWorkflowValidationDaemonModule(context));

await import("@resin/observer/daemon");
