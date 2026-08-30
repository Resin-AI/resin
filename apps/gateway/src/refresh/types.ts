import { ISOTimestampSchema, SchemaVersionSchema } from "@resin/contracts";
import type {
  CatalogChangeSummary,
  HarnessWorkspace,
  RefreshCapability,
  RefreshResult,
} from "@resin/harness-contracts";
import { z } from "zod";

/**
 * Standard refresh outcome variants when catalog updates occur in the gateway.
 */
export const RefreshOutcomeSchema = z.enum([
  "native_sent",
  "native_observed",
  "nudge_queued",
  "nudge_delivered",
  "meta_tools_only",
  "next_session_required",
  "unsupported",
  "failed",
]);
export type RefreshOutcome = z.infer<typeof RefreshOutcomeSchema>;

/**
 * Scope identifying the target workspace and optional session for a nudge.
 */
export const NudgeScopeSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().optional(),
  accountRoot: z.string().optional(),
});
export type NudgeScope = z.infer<typeof NudgeScopeSchema>;

/**
 * Safe, sanitized context notice payload.
 * Guarantees zero untrusted candidate prompt text or executable code.
 */
export const NudgePayloadSchema = z.object({
  catalogRevision: z.number().int().nonnegative(),
  scope: NudgeScopeSchema,
  addedToolIds: z.array(z.string()).default([]),
  updatedToolIds: z.array(z.string()).default([]),
  removedToolIds: z.array(z.string()).default([]),
  metaToolsReminder: z.string().min(1),
  noticeMessage: z.string().min(1),
  timestamp: ISOTimestampSchema,
});
export type NudgePayload = z.infer<typeof NudgePayloadSchema>;

/**
 * Verification lifecycle states for an attempted catalog refresh.
 */
export const RefreshVerificationStatusSchema = z.enum([
  "pending",
  "observed",
  "unverified",
  "timeout",
  "skipped",
]);
export type RefreshVerificationStatus = z.infer<typeof RefreshVerificationStatusSchema>;

/**
 * Record of an opportunistic verification for a refresh attempt.
 */
export const RefreshVerificationSchema = z.object({
  verificationId: z.string().min(1),
  attemptId: z.string().min(1),
  connectionId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().optional(),
  revision: z.number().int().nonnegative(),
  status: RefreshVerificationStatusSchema,
  notifiedAt: ISOTimestampSchema,
  verifiedAt: ISOTimestampSchema.optional(),
  observedVia: z.enum(["tools_list", "meta_tool", "explicit_ack", "none"]).default("none"),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type RefreshVerification = z.infer<typeof RefreshVerificationSchema>;

/**
 * Complete record of a refresh attempt dispatched to an active MCP connection.
 */
export const RefreshAttemptSchema = z.object({
  attemptId: z.string().min(1),
  connectionId: z.string().min(1),
  harnessId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().optional(),
  revision: z.number().int().nonnegative(),
  primaryOutcome: RefreshOutcomeSchema,
  outcomes: z.array(RefreshOutcomeSchema),
  mcpNotificationSent: z.boolean().default(false),
  adapterNudgeSent: z.boolean().default(false),
  nudgePayload: NudgePayloadSchema.optional(),
  error: z.string().optional(),
  timestamp: ISOTimestampSchema,
  verificationStatus: RefreshVerificationStatusSchema.default("pending"),
});
export type RefreshAttempt = z.infer<typeof RefreshAttemptSchema>;

/**
 * Interface for harness adapters that can handle tool catalog refresh notifications.
 */
export interface RefreshAdapterHandler {
  harnessId: string;
  notifyCatalogRefresh?(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult>;
  getCapabilities?(): RefreshCapability;
}

export type RefreshLogMeta =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | readonly (string | number | boolean | null | undefined)[]
  | { readonly [key: string]: string | number | boolean | null | undefined };

/**
 * Options for configuring the CatalogRefreshCoordinator.
 */
export interface RefreshCoordinatorOptions {
  /**
   * Debounce window in milliseconds for bundling rapid catalog change events.
   * Default: 50ms.
   */
  debounceMs?: number;
  /**
   * Timeout in milliseconds before an unacknowledged native notification is marked unverified.
   * Default: 30,000ms.
   */
  verificationTimeoutMs?: number;
  /**
   * Maximum allowed nudges per minute per scope (rate limiting).
   * Default: 60.
   */
  rateLimitMaxNudgesPerMinute?: number;
  /**
   * Optional harness adapter handlers keyed by harness ID (e.g. 'claude-code', 'codex', 'omp').
   */
  adapters?: Map<string, RefreshAdapterHandler> | Record<string, RefreshAdapterHandler>;
  /**
   * Custom logger callback.
   */
  logger?: (level: string, message: string, meta?: RefreshLogMeta) => void;
  /**
   * Custom invariant meta-tools reminder text.
   */
  metaToolsReminder?: string;
  /**
   * Optional gateway instance providing connection management and notification dispatch.
   */
  gateway?: any;
  /**
   * Optional registry instance providing catalog change events.
   */
  registry?: any;
}

/**
 * Coordinator telemetry and aggregation statistics.
 */
export interface RefreshCoordinatorStats {
  totalEventsReceived: number;
  totalAttempts: number;
  totalNativeSent: number;
  totalNativeObserved: number;
  totalNudgesDelivered: number;
  totalMetaToolsOnly: number;
  totalNextSessionRequired: number;
  totalUnsupported: number;
  totalFailed: number;
  totalVerificationsPending: number;
  totalVerificationsObserved: number;
  totalVerificationsTimedOut: number;
}
