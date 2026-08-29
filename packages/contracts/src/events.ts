import { z } from "zod";
import {
  CausalRefSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  RedactionMetaSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
} from "./common.js";

/**
 * Availability state of provider-reported usage metrics.
 * - complete: provider returned authoritative accounting including totalTokens.
 * - partial: provider returned some usage metrics, but total or breakdown may be incomplete.
 * - unavailable: provider does not report token accounting; usage is never inferred.
 */
export const ProviderUsageAvailabilitySchema = z.enum(["complete", "partial", "unavailable"]);

export type ProviderUsageAvailability = z.infer<typeof ProviderUsageAvailabilitySchema>;

/**
 * Normalized provider-reported usage schema.
 * Records authoritative provider accounting for model executions.
 * Explicit nonnegative token, cost, and duration components matching cloud trajectory usage.
 * Missing/unsupported components remain absent/null rather than synthesized.
 */
export const ProviderReportedUsageSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional().nullable(),
    accountingVersion: z.string().min(1),
    availability: ProviderUsageAvailabilitySchema,
    inputTokens: z.number().int().nonnegative().optional().nullable(),
    outputTokens: z.number().int().nonnegative().optional().nullable(),
    reasoningTokens: z.number().int().nonnegative().optional().nullable(),
    cachedInputTokens: z.number().int().nonnegative().optional().nullable(),
    totalTokens: z.number().int().nonnegative().optional().nullable(),
    costMicroUsd: z.number().int().nonnegative().optional().nullable(),
    durationMs: z.number().int().nonnegative().optional().nullable(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.availability === "complete") {
      if (val.totalTokens === undefined || val.totalTokens === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Complete provider usage requires totalTokens to be present",
          path: ["totalTokens"],
        });
      }
    } else if (val.availability === "unavailable") {
      const metricFields = [
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cachedInputTokens",
        "totalTokens",
        "costMicroUsd",
        "durationMs",
      ] as const;

      for (const field of metricFields) {
        if (val[field] !== undefined && val[field] !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unavailable provider usage cannot specify ${field}`,
            path: [field],
          });
        }
      }
    }
  });

export type ProviderReportedUsage = z.infer<typeof ProviderReportedUsageSchema>;

/**
 * Base header fields present on every NormalizedSessionEvent.
 */
const BaseEventFields = {
  eventId: IdentifierSchema,
  schemaVersion: SchemaVersionSchema,
  sessionId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  causalRef: CausalRefSchema,
  redaction: RedactionMetaSchema,
  metadata: z.record(z.unknown()).optional(),
  providerUsage: ProviderReportedUsageSchema.optional(),
};
/**
 * Content part for multimodal or structured message content.
 */
export const MessageContentPartSchema = z.object({
  type: z.enum(["text", "image", "resource", "json"]),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type MessageContentPart = z.infer<typeof MessageContentPartSchema>;

/**
 * 1. NormalizedMessageEvent: Conversational turn from user, assistant, system, or tool.
 */
export const NormalizedMessageEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  contentParts: z.array(MessageContentPartSchema).optional(),
  model: z.string().optional(),
});

export type NormalizedMessageEvent = z.infer<typeof NormalizedMessageEventSchema>;

/**
 * 2. NormalizedModelReasoningEvent: Model internal chain-of-thought/reasoning output.
 */
export const NormalizedModelReasoningEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("model_reasoning"),
  reasoningContent: z.string(),
  signature: z.string().optional(),
  tokenCount: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export type NormalizedModelReasoningEvent = z.infer<typeof NormalizedModelReasoningEventSchema>;

/**
 * Discovered tool entry in ToolDiscoveryEvent.
 */
export const DiscoveredToolEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
  provider: z.string().optional(),
});

export type DiscoveredToolEntry = z.infer<typeof DiscoveredToolEntrySchema>;

/**
 * 3. NormalizedToolDiscoveryEvent: Manifestation or discovery of available tools.
 */
export const NormalizedToolDiscoveryEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool_discovery"),
  tools: z.array(DiscoveredToolEntrySchema),
  provider: z.string().optional(),
  source: z.enum(["mcp", "builtin", "dynamic", "harness"]).default("mcp"),
});

export type NormalizedToolDiscoveryEvent = z.infer<typeof NormalizedToolDiscoveryEventSchema>;

/**
 * 4. NormalizedToolCallEvent: Agent invoking a specific tool.
 */
export const NormalizedToolCallEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool_call"),
  callId: IdentifierSchema,
  toolName: z.string().min(1),
  parameters: z.record(z.unknown()),
  candidateRef: IdentifierSchema.optional(),
  isShadow: z.boolean().default(false),
});

export type NormalizedToolCallEvent = z.infer<typeof NormalizedToolCallEventSchema>;

/**
 * 5. NormalizedToolResultEvent: Execution result returned from a tool invocation.
 */
export const NormalizedToolResultEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("tool_result"),
  callId: IdentifierSchema,
  toolName: z.string().min(1),
  result: z.unknown(),
  isError: z.boolean(),
  executionDurationMs: z.number().nonnegative(),
  outputSizeBytes: z.number().int().nonnegative().optional(),
  isShadow: z.boolean().default(false),
});

export type NormalizedToolResultEvent = z.infer<typeof NormalizedToolResultEventSchema>;

/**
 * 6. NormalizedCommandExecEvent: Subprocess / shell command execution.
 */
export const NormalizedCommandExecEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("command_exec"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  exitCode: z.number().int(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export type NormalizedCommandExecEvent = z.infer<typeof NormalizedCommandExecEventSchema>;

/**
 * Diff stats for file edit operations.
 */
export const FileDiffStatsSchema = z.object({
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
});

export type FileDiffStats = z.infer<typeof FileDiffStatsSchema>;

/**
 * 7. NormalizedFileEditEvent: Filesystem file modification, creation, or deletion.
 */
export const NormalizedFileEditEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("file_edit"),
  filePath: z.string().min(1),
  operation: z.enum(["create", "update", "delete", "patch"]),
  patch: z.string().optional(),
  beforeHash: Sha256DigestSchema.optional(),
  afterHash: Sha256DigestSchema.optional(),
  diffStats: FileDiffStatsSchema.optional(),
});

export type NormalizedFileEditEvent = z.infer<typeof NormalizedFileEditEventSchema>;

/**
 * 8. NormalizedErrorEvent: Execution or system error encountered during session.
 */
export const NormalizedErrorEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("error"),
  errorType: z.string().min(1),
  message: z.string(),
  stack: z.string().optional(),
  recoverable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export type NormalizedErrorEvent = z.infer<typeof NormalizedErrorEventSchema>;

/**
 * 9. NormalizedCompactionEvent: Context compaction / summarization event.
 */
export const NormalizedCompactionEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("compaction"),
  triggerReason: z.enum(["context_limit", "manual", "scheduled", "turn_threshold"]),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
  preservedContextSummary: z.string().optional(),
});

export type NormalizedCompactionEvent = z.infer<typeof NormalizedCompactionEventSchema>;

/**
 * 10. NormalizedBranchForkEvent: Session branching or forking event.
 */
export const NormalizedBranchForkEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("branch_fork"),
  sourceSessionId: IdentifierSchema,
  branchPointEventId: IdentifierSchema,
  forkReason: z.string().optional(),
  branchName: z.string().optional(),
});

export type NormalizedBranchForkEvent = z.infer<typeof NormalizedBranchForkEventSchema>;

/**
 * 11. NormalizedSubagentLifecycleEvent: Subagent lifecycle transitions.
 */
export const NormalizedSubagentLifecycleEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("subagent_lifecycle"),
  subagentId: IdentifierSchema,
  lifecycleType: z.enum(["spawn", "start", "pause", "resume", "terminate", "settle"]),
  parentId: IdentifierSchema.optional(),
  role: z.string().optional(),
  reason: z.string().optional(),
});

export type NormalizedSubagentLifecycleEvent = z.infer<
  typeof NormalizedSubagentLifecycleEventSchema
>;

/**
 * 12. NormalizedSessionLifecycleEvent: Top-level session state transitions.
 */
export const NormalizedSessionLifecycleEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("session_lifecycle"),
  lifecycleType: z.enum(["start", "pause", "resume", "end", "crash"]),
  exitReason: z.string().optional(),
  harnessName: z.string().optional(),
  workspaceId: IdentifierSchema.optional(),
});

export type NormalizedSessionLifecycleEvent = z.infer<typeof NormalizedSessionLifecycleEventSchema>;

/**
 * 13. NormalizedUnknownPassthroughEvent: Future or harness-specific unparsed events.
 */
export const NormalizedUnknownPassthroughEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal("unknown_passthrough"),
  rawEventType: z.string().min(1),
  rawPayload: z.record(z.unknown()),
});

export type NormalizedUnknownPassthroughEvent = z.infer<
  typeof NormalizedUnknownPassthroughEventSchema
>;

/**
 * Complete discriminated union of all NormalizedSessionEvents.
 */
export const NormalizedSessionEventSchema = z.discriminatedUnion("type", [
  NormalizedMessageEventSchema,
  NormalizedModelReasoningEventSchema,
  NormalizedToolDiscoveryEventSchema,
  NormalizedToolCallEventSchema,
  NormalizedToolResultEventSchema,
  NormalizedCommandExecEventSchema,
  NormalizedFileEditEventSchema,
  NormalizedErrorEventSchema,
  NormalizedCompactionEventSchema,
  NormalizedBranchForkEventSchema,
  NormalizedSubagentLifecycleEventSchema,
  NormalizedSessionLifecycleEventSchema,
  NormalizedUnknownPassthroughEventSchema,
]);

export type NormalizedSessionEvent = z.infer<typeof NormalizedSessionEventSchema>;
export type SessionEventType = NormalizedSessionEvent["type"];
