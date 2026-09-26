import type { HarnessInstallDefinition } from "@resin/harness-contracts";
import { planMuseMcpConfig } from "./config-planner.js";
import {
  MUSE_DISPLAY_NAME,
  MUSE_TESTED_VERSIONS,
  probeMuseInstallation,
  resolveMuseSettingsPath,
  resolveMuseUserRulesPath,
} from "./discovery.js";
import { MUSE_GUIDANCE_MARKERS, MUSE_RESIN_GUIDANCE } from "./instructions.js";

export const museCodeInstallHarness: HarnessInstallDefinition = {
  id: "muse-code",
  displayName: MUSE_DISPLAY_NAME,
  shortName: "Muse",
  adapterPackage: "@resin/adapter-muse-code",
  testedVersions: MUSE_TESTED_VERSIONS,
  knownLimits: [
    "Background skill-reminder observer model calls are not written to muse 1.4.0 session logs, so their token usage cannot be counted; the verify-reminder observer's calls are.",
    "The muse launcher updates itself hourly; set MUSE_NO_AUTO_UPDATE=1 to stay on a tested version.",
    "Sessions run with --no-session-log leave no log and are not captured.",
    "Resin catalog changes reach muse at the next session start.",
    "Context compaction is not decoded: no muse 1.4.0 compaction record was captured.",
  ],
  probeInstallation: ({ home, env }) => probeMuseInstallation({ home, env }),
  mcpConfig: {
    resolvePath: resolveMuseSettingsPath,
    uninstallPaths: (home, env) => [resolveMuseSettingsPath(home, env)],
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcp_servers"],
    transports: ["stdio"],
    planRegistration: ({ targetPath, command, args, gatewayUrl, fsBridge }) =>
      planMuseMcpConfig({ targetPath, command, args, gatewayUrl, fsBridge }),
  },
  guidance: {
    resolvePath: resolveMuseUserRulesPath,
    markers: MUSE_GUIDANCE_MARKERS,
    body: MUSE_RESIN_GUIDANCE.trimEnd(),
  },
};
