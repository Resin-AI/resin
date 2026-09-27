import { claudeCodeHarness } from "@resin/adapter-claude-code";
import { codexHarness } from "@resin/adapter-codex";
import { copilotHarness } from "@resin/adapter-copilot-cli";
import { cursorHarness } from "@resin/adapter-cursor-cli";
import { grokBuildHarness } from "@resin/adapter-grok-build";
import { museCodeHarness } from "@resin/adapter-muse-code";
import { ompHarness } from "@resin/adapter-omp";
import { opencodeHarness } from "@resin/adapter-opencode";
import { piHarness } from "@resin/adapter-pi";
import type { HarnessDefinition } from "@resin/harness-contracts";

/**
 * Full harness definitions for `resin mcp`, which replays recorded MCP and native-tool steps.
 * Installer, status, and uninstall paths use the lighter {@link ./harness-registry}.
 */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  claudeCodeHarness,
  codexHarness,
  ompHarness,
  piHarness,
  cursorHarness,
  grokBuildHarness,
  museCodeHarness,
  opencodeHarness,
  copilotHarness,
];

export function findHarnessDefinition(id: string | undefined): HarnessDefinition | undefined {
  return HARNESS_DEFINITIONS.find((definition) => definition.id === id);
}
