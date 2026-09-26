import { claudeCodeHarness } from "@resin/adapter-claude-code";
import { codexHarness } from "@resin/adapter-codex";
import { ompHarness } from "@resin/adapter-omp";
import type { HarnessDefinition } from "@resin/harness-contracts";

/**
 * Harnesses whose sessions the observer discovers and decodes. One entry per adapter package;
 * an id from `HARNESS_IDS` whose adapter is not listed here is not observed.
 */
export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  claudeCodeHarness,
  codexHarness,
  ompHarness,
];
