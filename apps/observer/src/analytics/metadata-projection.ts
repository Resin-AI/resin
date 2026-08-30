import {
  type DiscoveredToolEntry,
  type NormalizedBranchForkEvent,
  type NormalizedCommandExecEvent,
  type NormalizedCompactionEvent,
  type NormalizedErrorEvent,
  type NormalizedFileEditEvent,
  type NormalizedMessageEvent,
  type NormalizedModelReasoningEvent,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type NormalizedSessionLifecycleEvent,
  type NormalizedSubagentLifecycleEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolDiscoveryEvent,
  type NormalizedToolResultEvent,
  type NormalizedUnknownPassthroughEvent,
  type RedactionMeta,
  nowIso,
} from "@resin/contracts";

/**
 * Exhaustive metadata-only projection for normalized session events.
 *
 * Strips all prompt/response text, reasoning tokens, tool parameters/results,
 * command strings/arguments/output, diff patches, error messages/stacks/details,
 * and unknown payload contents while remaining 100% schema-valid.
 *
 * Operational fields (event identity, lifecycle transitions, tool/model names,
 * token/usage metrics, exit codes, durations) are strictly preserved.
 *
 * Redaction metadata is enriched to reflect synthetic redaction across all stripped fields.
 */
export function projectEventToMetadataOnly(
  event: NormalizedSessionEvent,
  options: { validate?: boolean } = {},
): NormalizedSessionEvent {
  const { validate = false } = options;

  const buildRedaction = (fieldsToRedact: readonly string[]): RedactionMeta => {
    const existingFields = event.redaction?.redactedFields ?? [];
    const fieldsSet = new Set<string>(existingFields);
    for (const field of fieldsToRedact) {
      fieldsSet.add(field);
    }
    return {
      isRedacted: true,
      redactedFields: Array.from(fieldsSet).sort(),
      redactionStrategy: "drop",
      scrubbedPatterns: event.redaction?.scrubbedPatterns ?? [],
      redactedAt: event.redaction?.redactedAt || nowIso(),
    };
  };

  const baseHeaders = {
    eventId: event.eventId,
    schemaVersion: event.schemaVersion,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    causalRef: event.causalRef,
    providerUsage: event.providerUsage,
  };

  let projected: NormalizedSessionEvent;

  switch (event.type) {
    case "message": {
      const msgEvent: NormalizedMessageEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["content", "contentParts"]),
        type: "message",
        role: event.role,
        content: "",
      };
      if (event.model !== undefined) {
        msgEvent.model = event.model;
      }
      projected = msgEvent;
      break;
    }

    case "model_reasoning": {
      const reasonEvent: NormalizedModelReasoningEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["reasoningContent", "signature"]),
        type: "model_reasoning",
        reasoningContent: "",
      };
      if (event.tokenCount !== undefined) reasonEvent.tokenCount = event.tokenCount;
      if (event.model !== undefined) reasonEvent.model = event.model;
      if (event.durationMs !== undefined) reasonEvent.durationMs = event.durationMs;
      projected = reasonEvent;
      break;
    }

    case "tool_discovery": {
      const tools: DiscoveredToolEntry[] = event.tools.map((t) => {
        const item: DiscoveredToolEntry = {
          name: t.name,
        };
        if (t.provider !== undefined) item.provider = t.provider;
        return item;
      });
      const discEvent: NormalizedToolDiscoveryEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["tools[].description", "tools[].inputSchema"]),
        type: "tool_discovery",
        tools,
        source: event.source,
      };
      if (event.provider !== undefined) discEvent.provider = event.provider;
      projected = discEvent;
      break;
    }

    case "tool_call": {
      const callEvent: NormalizedToolCallEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["parameters"]),
        type: "tool_call",
        callId: event.callId,
        toolName: event.toolName,
        parameters: {},
        isShadow: event.isShadow,
      };
      if (event.candidateRef !== undefined) callEvent.candidateRef = event.candidateRef;
      projected = callEvent;
      break;
    }

    case "tool_result": {
      const resEvent: NormalizedToolResultEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["result"]),
        type: "tool_result",
        callId: event.callId,
        toolName: event.toolName,
        result: undefined,
        isError: event.isError,
        executionDurationMs: event.executionDurationMs,
        isShadow: event.isShadow,
      };
      if (event.outputSizeBytes !== undefined) resEvent.outputSizeBytes = event.outputSizeBytes;
      projected = resEvent;
      break;
    }

    case "command_exec": {
      const cmdEvent: NormalizedCommandExecEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["command", "args", "cwd", "stdout", "stderr"]),
        type: "command_exec",
        command: "",
        args: [],
        exitCode: event.exitCode,
        durationMs: event.durationMs,
      };
      projected = cmdEvent;
      break;
    }

    case "file_edit": {
      const editEvent: NormalizedFileEditEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["patch"]),
        type: "file_edit",
        filePath: event.filePath,
        operation: event.operation,
      };
      if (event.beforeHash !== undefined) editEvent.beforeHash = event.beforeHash;
      if (event.afterHash !== undefined) editEvent.afterHash = event.afterHash;
      if (event.diffStats !== undefined) editEvent.diffStats = event.diffStats;
      projected = editEvent;
      break;
    }

    case "error": {
      const errEvent: NormalizedErrorEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["message", "stack", "details"]),
        type: "error",
        errorType: event.errorType,
        message: "",
        recoverable: event.recoverable,
      };
      projected = errEvent;
      break;
    }

    case "compaction": {
      const compEvent: NormalizedCompactionEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["preservedContextSummary"]),
        type: "compaction",
        triggerReason: event.triggerReason,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      };
      projected = compEvent;
      break;
    }

    case "branch_fork": {
      const forkEvent: NormalizedBranchForkEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["forkReason"]),
        type: "branch_fork",
        sourceSessionId: event.sourceSessionId,
        branchPointEventId: event.branchPointEventId,
      };
      if (event.branchName !== undefined) forkEvent.branchName = event.branchName;
      projected = forkEvent;
      break;
    }

    case "subagent_lifecycle": {
      const subagentEvent: NormalizedSubagentLifecycleEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["reason"]),
        type: "subagent_lifecycle",
        subagentId: event.subagentId,
        lifecycleType: event.lifecycleType,
      };
      if (event.parentId !== undefined) subagentEvent.parentId = event.parentId;
      if (event.role !== undefined) subagentEvent.role = event.role;
      projected = subagentEvent;
      break;
    }

    case "session_lifecycle": {
      const lifeEvent: NormalizedSessionLifecycleEvent = {
        ...baseHeaders,
        redaction: buildRedaction([]),
        type: "session_lifecycle",
        lifecycleType: event.lifecycleType,
      };
      if (event.exitReason !== undefined) lifeEvent.exitReason = event.exitReason;
      if (event.harnessName !== undefined) lifeEvent.harnessName = event.harnessName;
      if (event.workspaceId !== undefined) lifeEvent.workspaceId = event.workspaceId;
      projected = lifeEvent;
      break;
    }

    case "unknown_passthrough": {
      const passEvent: NormalizedUnknownPassthroughEvent = {
        ...baseHeaders,
        redaction: buildRedaction(["rawPayload"]),
        type: "unknown_passthrough",
        rawEventType: event.rawEventType,
        rawPayload: {},
      };
      projected = passEvent;
      break;
    }

    default: {
      const exhaustiveCheck: never = event;
      throw new Error(`Unhandled event type: ${String(exhaustiveCheck)}`);
    }
  }

  if (validate) {
    return NormalizedSessionEventSchema.parse(projected);
  }
  return projected;
}

export { projectEventToMetadataOnly as projectEventMetadataOnly };
