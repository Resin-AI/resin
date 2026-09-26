import { claudeCodeHarness } from "@resin/adapter-claude-code";
import { codexHarness } from "@resin/adapter-codex";
import { grokBuildHarness } from "@resin/adapter-grok-build";
import { cursorHarness } from "@resin/adapter-cursor-cli";
import { ompHarness } from "@resin/adapter-omp";
import type { HarnessId } from "@resin/contracts";
import type { HarnessDefinition } from "@resin/harness-contracts";

/**
 * Harnesses this CLI can register, verify, report, and remove. One entry per adapter package;
 * an id from `HARNESS_IDS` whose adapter is not listed here is simply unsupported.
 */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  claudeCodeHarness,
  codexHarness,
  grokBuildHarness,
  ompHarness,
  cursorHarness,
];

export const SUPPORTED_HARNESS_IDS: readonly HarnessId[] = HARNESS_DEFINITIONS.map(
  (definition) => definition.id,
);

export function findHarnessDefinition(id: string | undefined): HarnessDefinition | undefined {
  return HARNESS_DEFINITIONS.find((definition) => definition.id === id);
}

/** Registry lookup for ids already validated against {@link SUPPORTED_HARNESS_IDS}. */
export function getHarnessDefinition(id: HarnessId): HarnessDefinition {
  const definition = findHarnessDefinition(id);
  if (definition === undefined) {
    throw new Error(`Harness ${id} is not supported by this CLI`);
  }
  return definition;
}

export function isSupportedHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && findHarnessDefinition(value) !== undefined;
}
