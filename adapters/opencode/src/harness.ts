import * as os from "node:os";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { OpencodeHarnessAdapter } from "./adapter.js";
import {
  opencodeUninstallPaths,
  planOpencodeMcpConfig,
  removeOpencodeMcpConfig,
  verifyOpencodeMcpConfig,
} from "./config-planner.js";
import { OpencodeRecordDecoder } from "./decoder.js";
import {
  OPENCODE_TESTED_VERSIONS,
  probeOpencodeInstallation,
  readOpencodeMcpServers,
  resolveOpencodeMcpServer,
} from "./discovery.js";
import { OPENCODE_GUIDANCE_MARKERS, OPENCODE_RESIN_GUIDANCE } from "./instructions.js";
import { resolveOpencodeGuidancePath, resolveOpencodeMcpConfigPath } from "./paths.js";

export const opencodeHarness: HarnessDefinition = {
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
    verifyRegistration: ({ targetPath, command, fsBridge }) =>
      verifyOpencodeMcpConfig({ targetPath, command, fsBridge }),
    removeRegistration: ({ home, env, fsBridge, dryRun }) =>
      removeOpencodeMcpConfig({ home, env, fsBridge, dryRun }),
  },
  guidance: {
    resolvePath: resolveOpencodeGuidancePath,
    markers: OPENCODE_GUIDANCE_MARKERS,
    body: OPENCODE_RESIN_GUIDANCE.trimEnd(),
  },
  createAdapter: () => new OpencodeHarnessAdapter(),
  // Server keys are read when the decoder is created so `<server>_<tool>` calls are attributed.
  createDecoder: () =>
    new OpencodeRecordDecoder({
      mcpServers: Object.keys(readOpencodeMcpServers({ home: os.homedir(), env: process.env })),
    }),
  sessionCapture: "file-activity",
  resolveMcpServer: (name, workspaceRoot) =>
    resolveOpencodeMcpServer(name, workspaceRoot, os.homedir(), process.env),
};
