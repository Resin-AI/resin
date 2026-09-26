import path from "node:path";
import type { HarnessInstallDefinition } from "@resin/harness-contracts";
import { PI_TESTED_VERSIONS, probePiInstallation } from "./discovery.js";
import { PI_RESIN_EXTENSION_FILE_NAME } from "./extension.js";
import { PI_DISPLAY_NAME, resolvePiAgentDir, resolvePiExtensionPath } from "./paths.js";
import {
  PI_GUIDANCE_MARKERS,
  PI_RESIN_GUIDANCE,
  planPiRegistration,
  removePiRegistration,
  resolvePiGuidancePath,
  verifyPiRegistration,
} from "./registration.js";

export const piInstallHarness: HarnessInstallDefinition = {
  id: "pi",
  displayName: PI_DISPLAY_NAME,
  shortName: PI_DISPLAY_NAME,
  adapterPackage: "@resin/adapter-pi",
  testedVersions: PI_TESTED_VERSIONS,
  knownLimits: [
    "Pi has no MCP client: Resin installs a Pi extension (<agent-dir>/extensions/resin.ts) that bridges `resin mcp`; runs with --no-extensions or -ne do not load it.",
    "Runs with --no-session write no transcript and cannot be captured.",
    "Sessions stored with --session-dir are only discovered when that directory is also set via PI_CODING_AGENT_SESSION_DIR or the sessionDir setting.",
    "Pi has no built-in subagents; nothing below the session is captured.",
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probePiInstallation({ env, configPath: targetPath, homePath: resolvePiAgentDir(home, env) }),
  mcpConfig: {
    resolvePath: resolvePiExtensionPath,
    uninstallPaths: (home, env) => [
      resolvePiExtensionPath(home, env),
      path.join(home, ".pi", "agent", "extensions", PI_RESIN_EXTENSION_FILE_NAME),
    ],
    format: "owned-file",
    serverKey: "resin",
    jsonContainerKeys: [],
    transports: ["stdio"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planPiRegistration({ targetPath, command, args, fsBridge }),
    verifyRegistration: ({ targetPath, command, fsBridge }) =>
      verifyPiRegistration({ targetPath, command, fsBridge }),
    removeRegistration: ({ home, env, fsBridge, dryRun }) =>
      removePiRegistration({
        paths: piInstallHarness.mcpConfig.uninstallPaths(home, env),
        fsBridge,
        dryRun,
      }),
  },
  guidance: {
    resolvePath: resolvePiGuidancePath,
    markers: PI_GUIDANCE_MARKERS,
    body: PI_RESIN_GUIDANCE,
  },
};
