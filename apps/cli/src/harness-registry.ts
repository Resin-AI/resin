import { claudeCodeInstallHarness } from "@resin/adapter-claude-code/install";
import { codexInstallHarness } from "@resin/adapter-codex/install";
import { copilotInstallHarness } from "@resin/adapter-copilot-cli/install";
import { cursorInstallHarness } from "@resin/adapter-cursor-cli/install";
import { grokBuildInstallHarness } from "@resin/adapter-grok-build/install";
import { museCodeInstallHarness } from "@resin/adapter-muse-code/install";
import { ompInstallHarness } from "@resin/adapter-omp/install";
import { opencodeInstallHarness } from "@resin/adapter-opencode/install";
import { piInstallHarness } from "@resin/adapter-pi/install";
import type { HarnessId } from "@resin/contracts";
import type { HarnessInstallDefinition } from "@resin/harness-contracts";

/**
 * Harnesses this CLI can register, verify, report, and remove. One entry per adapter package;
 * an id from `HARNESS_IDS` whose adapter is not listed here is simply unsupported. Entries come
 * from each adapter's `./install` subpath so installer paths (and the standalone install helper)
 * never load session discovery or decoding; `resin mcp` uses {@link ./harness-runtime-registry}.
 */
export const HARNESS_DEFINITIONS: readonly HarnessInstallDefinition[] = [
  claudeCodeInstallHarness,
  codexInstallHarness,
  ompInstallHarness,
  piInstallHarness,
  cursorInstallHarness,
  grokBuildInstallHarness,
  museCodeInstallHarness,
  opencodeInstallHarness,
  copilotInstallHarness,
];

export const SUPPORTED_HARNESS_IDS: readonly HarnessId[] = HARNESS_DEFINITIONS.map(
  (definition) => definition.id,
);

export function findHarnessDefinition(
  id: string | undefined,
): HarnessInstallDefinition | undefined {
  return HARNESS_DEFINITIONS.find((definition) => definition.id === id);
}

/** Registry lookup for ids already validated against {@link SUPPORTED_HARNESS_IDS}. */
export function getHarnessDefinition(id: HarnessId): HarnessInstallDefinition {
  const definition = findHarnessDefinition(id);
  if (definition === undefined) {
    throw new Error(`Harness ${id} is not supported by this CLI`);
  }
  return definition;
}

export function isSupportedHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && findHarnessDefinition(value) !== undefined;
}
