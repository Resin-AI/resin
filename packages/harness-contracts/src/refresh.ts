import { ISOTimestampSchema, SchemaVersionSchema } from "@resin/contracts";
import { z } from "zod";
import type { RefreshCapability } from "./types.js";

/**
 * Standard refresh outcome variants when catalog updates occur.
 */
export const RefreshOutcomeSchema = z.enum([
  "native_list_change",
  "context_nudge",
  "next_session_required",
  "unsupported",
  "failed",
]);
export type RefreshOutcome = z.infer<typeof RefreshOutcomeSchema>;

/**
 * Structured outcome returned by notifyCatalogRefresh.
 */
export const RefreshResultSchema = z.object({
  outcome: RefreshOutcomeSchema,
  appliedAt: ISOTimestampSchema,
  message: z.string().min(1),
  catalogVersion: SchemaVersionSchema,
  affectedToolCount: z.number().int().nonnegative().default(0),
  requiresRestart: z.boolean().default(false),
  details: z.record(z.unknown()).default({}),
});
export type RefreshResult = z.infer<typeof RefreshResultSchema>;

export type RefreshDetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | RefreshDetailRecord
  | RefreshDetailValue[];

export interface RefreshDetailRecord {
  [key: string]: RefreshDetailValue;
}

/**
 * Helper to construct a validated RefreshResult.
 */
export function createRefreshResult(
  outcome: RefreshOutcome,
  options: {
    message: string;
    catalogVersion: string;
    affectedToolCount?: number;
    requiresRestart?: boolean;
    appliedAt?: string;
    details?: RefreshDetailRecord;
  },
): RefreshResult {
  return RefreshResultSchema.parse({
    outcome,
    appliedAt: options.appliedAt ?? new Date().toISOString(),
    message: options.message,
    catalogVersion: options.catalogVersion,
    affectedToolCount: options.affectedToolCount ?? 0,
    requiresRestart: options.requiresRestart ?? outcome === "next_session_required",
    details: options.details ?? {},
  });
}

/**
 * Determines the expected refresh outcome given an adapter's refresh capability
 * and runtime context (e.g. whether a session is currently active).
 */
export function determineRefreshOutcome(
  capability: RefreshCapability,
  options?: {
    hasActiveSession?: boolean;
  },
): RefreshOutcome {
  if (capability.supportsNativeListChange) {
    return "native_list_change";
  }

  if (capability.supportsContextNudge && options?.hasActiveSession) {
    return "context_nudge";
  }

  if (capability.requiresSessionRestart) {
    return "next_session_required";
  }

  if (capability.supportsContextNudge) {
    return "context_nudge";
  }

  return "unsupported";
}
