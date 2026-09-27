#!/usr/bin/env node

/**
 * The packaged background daemon: `@resin/observer`'s daemon with the gateway services it cannot
 * import itself, because `@resin/gateway` depends on `@resin/observer`. Providers are registered
 * before the daemon command line runs.
 */
import { fileURLToPath } from "node:url";
import { registerDaemonModuleProvider } from "@resin/observer";
import { runDaemonCli } from "@resin/observer/daemon";
import { createWorkflowValidationDaemonModule } from "../proxy/validation-daemon-module.js";

registerDaemonModuleProvider((context) => createWorkflowValidationDaemonModule(context));

await runDaemonCli({ entryFile: fileURLToPath(import.meta.url) });
