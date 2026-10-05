#!/usr/bin/env node

/**
 * The packaged background daemon: `@resin/observer`'s daemon with the gateway services it cannot
 * import itself, because `@resin/gateway` depends on `@resin/observer`. Providers are registered
 * before the daemon command line runs.
 */
// Must stay first: suppresses the node:sqlite ExperimentalWarning before anything loads it.
import "@resin/db/node-warning-filter";
import { fileURLToPath } from "node:url";
import { registerDaemonModuleProvider } from "@resin/observer";
import { runDaemonCli } from "@resin/observer/daemon";
import { GATEWAY_DAEMON_MODULE_PROVIDERS } from "../daemon-module-providers.js";
import { resolveDaemonReleaseVersion } from "../daemon-release-version.js";

for (const provider of GATEWAY_DAEMON_MODULE_PROVIDERS) {
  registerDaemonModuleProvider(provider);
}

const entryFile = fileURLToPath(import.meta.url);
await runDaemonCli({ entryFile, version: resolveDaemonReleaseVersion(entryFile) });
