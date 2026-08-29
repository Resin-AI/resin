import type {
  CausalRef,
  DiscoveredToolEntry,
  FileDiffStats,
  MessageContentPart,
  ProviderReportedUsage,
  RedactionMeta,
  SessionEventType,
} from "@resin/contracts";
import type { RawHarnessRecord } from "./types.js";

export type DecoderMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DecoderMetadataRecord
  | DecoderMetadataValue[];

export interface DecoderMetadataRecord {
  [key: string]: DecoderMetadataValue;
}

/**
 * Base fields shared across all intermediate session events prior to final normalization.
 */
export interface BaseIntermediateEventFields {
  sessionId: string;
  timestamp: string;
  schemaVersion?: string;
  causalRef?: Partial<CausalRef> & { causalSequence?: number };
  metadata?: DecoderMetadataRecord;
  redaction?: Partial<RedactionMeta>;
  providerUsage?: ProviderReportedUsage;
  eventId?: string;
}

export interface IntermediateMessageEvent extends BaseIntermediateEventFields {
  type: "message";
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  contentParts?: MessageContentPart[];
  parentEventId?: string;
  model?: string;
  isError?: boolean;
}

export interface IntermediateModelReasoningEvent extends BaseIntermediateEventFields {
  type: "model_reasoning";
  reasoningText?: string;
  reasoningContent?: string;
  signature?: string;
  visibility?: "internal" | "visible";
  redacted?: boolean;
  model?: string;
  tokenCount?: number;
  durationMs?: number;
}

export interface IntermediateToolDiscoveryEvent extends BaseIntermediateEventFields {
  type: "tool_discovery";
  tools: DiscoveredToolEntry[];
  provider?: string;
  source?: "mcp" | "builtin" | "dynamic" | "harness";
}

export interface IntermediateToolCallEvent extends BaseIntermediateEventFields {
  type: "tool_call";
  toolCallId?: string;
  callId?: string;
  toolName: string;
  toolVersion?: string;
  input?: DecoderMetadataRecord;
  parameters?: DecoderMetadataRecord;
  rawInput?: string;
  candidateRef?: string;
  isShadow?: boolean;
}

export interface IntermediateToolResultEvent extends BaseIntermediateEventFields {
  type: "tool_result";
  toolCallId?: string;
  callId?: string;
  toolName?: string;
  result?: unknown;
  output?: unknown;
  isError?: boolean;
  error?: string;
  executionDurationMs?: number;
  durationMs?: number;
  outputSizeBytes?: number;
  isShadow?: boolean;
  rawResult?: string;
}

export interface IntermediateCommandExecEvent extends BaseIntermediateEventFields {
  type: "command_exec";
  command: string;
  args?: string[];
  cwd?: string;
  workingDirectory?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface IntermediateFileEditEvent extends BaseIntermediateEventFields {
  type: "file_edit";
  filePath: string;
  operation?: "create" | "update" | "delete" | "read" | "patch";
  action?: "create" | "update" | "delete";
  beforeHash?: string;
  afterHash?: string;
  diff?: string;
  patch?: string;
  stats?: FileDiffStats;
  diffStats?: FileDiffStats;
  linesAdded?: number;
  linesRemoved?: number;
  bytesAdded?: number;
  bytesRemoved?: number;
}

export interface IntermediateCompactionEvent extends BaseIntermediateEventFields {
  type: "compaction";
  summary?: string;
  triggerReason?: "context_limit" | "manual" | "scheduled" | "turn_threshold";
  tokensBefore?: number;
  tokensAfter?: number;
  originalTokenCount?: number;
  compactedTokenCount?: number;
  preservedContextSummary?: string;
  rangeStart?: number;
  rangeEnd?: number;
  compactedEventIds?: string[];
  retainedEventCount?: number;
}

export interface IntermediateBranchForkEvent extends BaseIntermediateEventFields {
  type: "branch_fork";
  branchId?: string;
  parentBranchId?: string;
  sourceSessionId?: string;
  branchPointEventId?: string;
  divergenceSequence?: number;
  forkReason?: string;
  branchName?: string;
}

export interface IntermediateErrorEvent extends BaseIntermediateEventFields {
  type: "error";
  errorType: string;
  message: string;
  stack?: string;
  stackTrace?: string;
  recoverable?: boolean;
  isFatal?: boolean;
  fatal?: boolean;
}

export interface IntermediateSubagentLifecycleEvent extends BaseIntermediateEventFields {
  type: "subagent_lifecycle";
  subagentId: string;
  lifecycleType: "spawn" | "start" | "pause" | "resume" | "terminate" | "settle" | "end" | "crash";
  parentId?: string;
  role?: string;
  reason?: string;
}

export interface IntermediateSessionLifecycleEvent extends BaseIntermediateEventFields {
  type: "session_lifecycle";
  lifecycleType: "start" | "pause" | "resume" | "end" | "crash";
  exitReason?: string;
  harnessName?: string;
  workspaceId?: string;
}

export interface IntermediateUnknownPassthroughEvent extends BaseIntermediateEventFields {
  type: "unknown_passthrough";
  rawEventType: string;
  rawPayload: DecoderMetadataRecord;
}

/**
 * Union of all intermediate session events produced by harness decoders.
 */
export type IntermediateSessionEvent =
  | IntermediateMessageEvent
  | IntermediateModelReasoningEvent
  | IntermediateToolDiscoveryEvent
  | IntermediateToolCallEvent
  | IntermediateToolResultEvent
  | IntermediateCommandExecEvent
  | IntermediateFileEditEvent
  | IntermediateErrorEvent
  | IntermediateCompactionEvent
  | IntermediateBranchForkEvent
  | IntermediateSubagentLifecycleEvent
  | IntermediateSessionLifecycleEvent
  | IntermediateUnknownPassthroughEvent;

/**
 * Context provided to record decoders.
 */
export interface RecordDecoderContext {
  sessionId?: string;
  harnessId?: string;
  lastCausalSequence?: number;
  parentEventId?: string;
  metadata?: DecoderMetadataRecord;
  [key: string]: DecoderMetadataValue;
}

/**
 * Interface mapping raw harness records to typed intermediate events.
 */
export interface HarnessRecordDecoder {
  readonly harnessId: string;
  readonly decoderVersion: string;
  canDecode(record: RawHarnessRecord): boolean;
  decode(
    record: RawHarnessRecord,
    context?: RecordDecoderContext,
  ):
    | Promise<IntermediateSessionEvent | IntermediateSessionEvent[] | null>
    | IntermediateSessionEvent
    | IntermediateSessionEvent[]
    | null;
}

/**
 * Custom error thrown during decoding failures.
 */
export class DecodeError extends Error {
  readonly recordId?: string;
  readonly recordType?: string;

  constructor(
    message: string,
    options?: { recordId?: string; recordType?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "DecodeError";
    this.recordId = options?.recordId;
    this.recordType = options?.recordType;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}
