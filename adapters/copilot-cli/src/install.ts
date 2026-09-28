import type { HarnessInstallDefinition } from "@resin/harness-contracts";
import {
  planCopilotMcpRegistration,
  removeCopilotMcpRegistration,
  verifyCopilotMcpRegistration,
} from "./config-planner.js";
import {
  COPILOT_DISPLAY_NAME,
  COPILOT_HARNESS_ID,
  COPILOT_TESTED_VERSIONS,
  probeCopilotInstallation,
  resolveCopilotInstructionsPath,
  resolveCopilotMcpConfigPath,
} from "./discovery.js";
import { COPILOT_GUIDANCE_MARKERS, COPILOT_RESIN_GUIDANCE } from "./instructions.js";

export const copilotInstallHarness: HarnessInstallDefinition = {
  id: COPILOT_HARNESS_ID,
  displayName: COPILOT_DISPLAY_NAME,
  shortName: "Copilot CLI",
  adapterPackage: "@resin/adapter-copilot-cli",
  testedVersions: COPILOT_TESTED_VERSIONS,
  knownLimits: [
    "Token usage is recorded per Copilot process run (session.shutdown), not per model call: per-call usage events are ephemeral and never written to session-state.",
    "A Copilot process killed outright (not Ctrl+C, which still shuts down cleanly) writes no session.shutdown, so that run's token usage is not captured.",
    "File edits are decoded from apply_patch (the tool GPT-family models use); other models' edit tools are captured as exact tool calls/results without file_edit events.",
  ],
  probeInstallation: ({ home, env }) => probeCopilotInstallation({ home, env }),
  mcpConfig: {
    resolvePath: resolveCopilotMcpConfigPath,
    uninstallPaths: (home, env) => [resolveCopilotMcpConfigPath(home, env)],
    format: "json",
    serverKey: "resin",
    jsonContainerKeys: ["mcpServers"],
    transports: ["stdio", "http", "sse"],
    planRegistration: ({ targetPath, command, args, gatewayUrl, fsBridge }) =>
      planCopilotMcpRegistration({ targetPath, command, args, gatewayUrl, fsBridge }),
    verifyRegistration: ({ targetPath, command, args, fsBridge }) =>
      verifyCopilotMcpRegistration({ targetPath, command, args, fsBridge }),
    removeRegistration: ({ home, env, fsBridge, dryRun }) =>
      removeCopilotMcpRegistration({
        targetPath: resolveCopilotMcpConfigPath(home, env),
        fsBridge,
        dryRun,
      }),
  },
  guidance: {
    resolvePath: resolveCopilotInstructionsPath,
    markers: COPILOT_GUIDANCE_MARKERS,
    body: COPILOT_RESIN_GUIDANCE,
  },
};
