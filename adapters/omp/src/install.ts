import path from "node:path";
import {
  type HarnessInstallDefinition,
  type HarnessInstallExtension,
  applyManagedBlock,
} from "@resin/harness-contracts";
import { ompCommandSuggestExtension } from "./command-suggest.js";
import { planOmpMcpConfig } from "./config-planner.js";
import { OMP_TESTED_VERSIONS, probeOmpInstallation } from "./discovery.js";
import {
  DEFAULT_APPEND_SYSTEM_FILENAME,
  OMP_CATALOG_MARKERS,
  OMP_GUIDANCE_MARKERS,
  OMP_RESIN_GUIDANCE,
  resolveOmpConfigHome,
  resolveOmpGuidancePath,
} from "./instructions.js";

const removeCatalogBlock: HarnessInstallExtension["install"] = async ({
  home,
  env,
  fsBridge,
  dryRun,
}) => [
  await applyManagedBlock(
    fsBridge,
    path.join(resolveOmpConfigHome(home, env), DEFAULT_APPEND_SYSTEM_FILENAME),
    OMP_CATALOG_MARKERS,
    null,
    { dryRun },
  ),
];

export const ompInstallHarness: HarnessInstallDefinition = {
  id: "omp",
  displayName: "Oh My Pi (OMP)",
  shortName: "Oh My Pi",
  adapterPackage: "@resin/adapter-omp",
  testedVersions: OMP_TESTED_VERSIONS,
  knownLimits: [
    "Subagent sessions are learned as their own sessions; a workflow split between a parent and its subagents is not learned as one tool.",
    "Built-in tool replay runs the OMP SDK Resin pins (18.6.1) under Bun; a built-in that SDK does not export fails with an explicit error.",
  ],
  probeInstallation: ({ targetPath, home, env }) =>
    probeOmpInstallation({ customConfigPath: targetPath, env, homeDir: home }),
  mcpConfig: {
    resolvePath: (home, env) => path.join(resolveOmpConfigHome(home, env), "agent", "mcp.json"),
    uninstallPaths: (home, env) => {
      const activeHome = resolveOmpConfigHome(home, env);
      return [
        path.join(activeHome, "agent", "mcp.json"),
        path.join(activeHome, "config.json"),
        path.join(home, ".omp", "agent", "mcp.json"),
        path.join(home, ".omp", "config.json"),
      ];
    },
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcpServers"],
    transports: ["stdio", "sse", "websocket", "http"],
    planRegistration: ({ targetPath, command, args, fsBridge }) =>
      planOmpMcpConfig({ customConfigPath: targetPath, command, args: [...args], fsBridge }),
  },
  guidance: {
    resolvePath: resolveOmpGuidancePath,
    markers: OMP_GUIDANCE_MARKERS,
    body: OMP_RESIN_GUIDANCE,
  },
  installExtensions: [
    {
      // `resin mcp` lists only the meta tools, so the gateway writes no per-tool catalog into
      // OMP's appended system prompt. Install removes a block an earlier full listing left there,
      // and uninstall removes it too.
      name: "learned-tool catalog",
      install: removeCatalogBlock,
      uninstall: removeCatalogBlock,
      verify: async () => true,
    },
    // Suggests the learned tool that already runs a shell command, as the agent is about to run it.
    ompCommandSuggestExtension,
  ],
};

export {
  OMP_COMMAND_SUGGEST_EXTENSION_FILENAME,
  ompCommandSuggestExtension,
  renderOmpCommandSuggestExtension,
  resolveOmpCommandSuggestExtensionPath,
} from "./command-suggest.js";
