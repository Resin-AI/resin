import { z } from "zod";

/**
 * Every harness Resin knows by id. This is the single id list: protocol schemas, CLI flag
 * parsing, status, and health caches derive from it. An id here does not mean an adapter ships;
 * the app registries list only the harnesses whose adapter packages are present.
 */
export const HARNESS_IDS = [
  "claude-code",
  "codex-cli",
  "omp",
  "pi",
  "cursor-cli",
  "grok-build",
  "muse-code",
  "opencode",
  "copilot-cli",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const HarnessIdSchema = z.enum(HARNESS_IDS);

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}
