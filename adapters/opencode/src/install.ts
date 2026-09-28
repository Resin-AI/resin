import type { HarnessInstallDefinition } from "@resin/harness-contracts";
import {
  opencodeUninstallPaths,
  planOpencodeMcpConfig,
  removeOpencodeMcpConfig,
  verifyOpencodeMcpConfig,
} from "./config-planner.js";
import { OPENCODE_TESTED_VERSIONS, probeOpencodeInstallation } from "./discovery.js";
import { OPENCODE_GUIDANCE_MARKERS, OPENCODE_RESIN_GUIDANCE } from "./instructions.js";
import { resolveOpencodeGuidancePath, resolveOpencodeMcpConfigPath } from "./paths.js";

export const opencodeInstallHarness: HarnessInstallDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  shortName: "OpenCode",
  adapterPackage: "@resin/adapter-opencode",
  testedVersions: OPENCODE_TESTED_VERSIONS,
  knownLimits: [
    "MCP tool list changes are picked up by the next OpenCode session.",
    "Only the default release-channel database (opencode.db, or OPENCODE_DB) is observed.",
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probeOpencodeInstallation({ home, env, configPath: targetPath }),
  mcpConfig: {
    resolvePath: resolveOpencodeMcpConfigPath,
    uninstallPaths: opencodeUninstallPaths,
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcp"],
    transports: ["stdio", "http"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planOpencodeMcpConfig({ targetPath, command, args, fsBridge }),
    verifyRegistration: ({ targetPath, command, args, fsBridge }) =>
      verifyOpencodeMcpConfig({ targetPath, command, args, fsBridge }),
    removeRegistration: ({ home, env, fsBridge, dryRun }) =>
      removeOpencodeMcpConfig({ home, env, fsBridge, dryRun }),
  },
  guidance: {
    resolvePath: resolveOpencodeGuidancePath,
    markers: OPENCODE_GUIDANCE_MARKERS,
    body: OPENCODE_RESIN_GUIDANCE.trimEnd(),
  },
};
