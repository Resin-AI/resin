import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
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
 * Redaction metadata is updated to mark `isRedacted: true` with strategy `"drop"`.
 */
export function projectEventToMetadataOnly(
  event: NormalizedSessionEvent,
  validate = true,
): NormalizedSessionEvent {
  const existingRedactedFields = event.redaction?.redactedFields ?? [];
  const newlyRedactedFields: string[] = [];

  const buildRedactionMeta = (fields: string[]): RedactionMeta => {
    const combined = Array.from(new Set([...existingRedactedFields, ...fields]));
    return {
      isRedacted: true,
      redactionStrategy: "drop",
      redactedFields: combined.length > 0 ? combined : ["metadata_only_projection"],
      scrubbedPatterns: event.redaction?.scrubbedPatterns ?? [],
      redactedAt: nowIso(),
    };
  };

  const { eventId, schemaVersion, sessionId, timestamp, causalRef, providerUsage } = event;

  const baseHeader = {
    eventId,
    schemaVersion,
    sessionId,
    timestamp,
    causalRef,
    ...(providerUsage ? { providerUsage } : {}),
  };

  let projected: NormalizedSessionEvent;

  switch (event.type) {
    case "message": {
      newlyRedactedFields.push("content");
      if (event.contentParts && event.contentParts.length > 0) {
        newlyRedactedFields.push("contentParts");
      }
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "message",
        role: event.role,
        content: "",
        ...(event.model ? { model: event.model } : {}),
      };
      break;
    }

    case "model_reasoning": {
      newlyRedactedFields.push("reasoningContent");
      if (event.signature) {
        newlyRedactedFields.push("signature");
      }
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "model_reasoning",
        reasoningContent: "",
        ...(event.tokenCount !== undefined ? { tokenCount: event.tokenCount } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      };
      break;
    }

    case "tool_discovery": {
      let hasDescription = false;
      let hasInputSchema = false;
      const sanitizedTools = event.tools.map((t) => {
        if (t.description) hasDescription = true;
        if (t.inputSchema && Object.keys(t.inputSchema).length > 0) hasInputSchema = true;
        return {
          name: t.name,
          ...(t.provider ? { provider: t.provider } : {}),
        };
      });
      if (hasDescription) newlyRedactedFields.push("tools[].description");
      if (hasInputSchema) newlyRedactedFields.push("tools[].inputSchema");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "tool_discovery",
        tools: sanitizedTools,
        ...(event.provider ? { provider: event.provider } : {}),
        source: event.source ?? "mcp",
      };
      break;
    }

    case "tool_call": {
      newlyRedactedFields.push("parameters");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "tool_call",
        callId: event.callId,
        toolName: event.toolName,
        parameters: {},
        ...(event.candidateRef ? { candidateRef: event.candidateRef } : {}),
        isShadow: event.isShadow ?? false,
      };
      break;
    }

    case "tool_result": {
      newlyRedactedFields.push("result");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "tool_result",
        callId: event.callId,
        toolName: event.toolName,
        isError: event.isError,
        executionDurationMs: event.executionDurationMs,
        ...(event.outputSizeBytes !== undefined ? { outputSizeBytes: event.outputSizeBytes } : {}),
        isShadow: event.isShadow ?? false,
      };
      break;
    }

    case "command_exec": {
      newlyRedactedFields.push("command");
      if (event.args && event.args.length > 0) newlyRedactedFields.push("args");
      if (event.cwd) newlyRedactedFields.push("cwd");
      if (event.stdout) newlyRedactedFields.push("stdout");
      if (event.stderr) newlyRedactedFields.push("stderr");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "command_exec",
        command: "",
        args: [],
        exitCode: event.exitCode,
        durationMs: event.durationMs,
      };
      break;
    }

    case "file_edit": {
      if (event.patch) newlyRedactedFields.push("patch");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "file_edit",
        filePath: event.filePath,
        operation: event.operation,
        ...(event.beforeHash ? { beforeHash: event.beforeHash } : {}),
        ...(event.afterHash ? { afterHash: event.afterHash } : {}),
        ...(event.diffStats ? { diffStats: event.diffStats } : {}),
      };
      break;
    }

    case "error": {
      newlyRedactedFields.push("message");
      if (event.stack) newlyRedactedFields.push("stack");
      if (event.details && Object.keys(event.details).length > 0)
        newlyRedactedFields.push("details");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "error",
        errorType: event.errorType,
        message: "",
        recoverable: event.recoverable,
      };
      break;
    }

    case "compaction": {
      if (event.preservedContextSummary) newlyRedactedFields.push("preservedContextSummary");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "compaction",
        triggerReason: event.triggerReason,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      };
      break;
    }

    case "branch_fork": {
      if (event.forkReason) newlyRedactedFields.push("forkReason");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "branch_fork",
        sourceSessionId: event.sourceSessionId,
        branchPointEventId: event.branchPointEventId,
        ...(event.branchName ? { branchName: event.branchName } : {}),
      };
      break;
    }

    case "subagent_lifecycle": {
      if (event.reason) newlyRedactedFields.push("reason");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "subagent_lifecycle",
        subagentId: event.subagentId,
        lifecycleType: event.lifecycleType,
        ...(event.parentId ? { parentId: event.parentId } : {}),
        ...(event.role ? { role: event.role } : {}),
      };
      break;
    }

    case "session_lifecycle": {
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "session_lifecycle",
        lifecycleType: event.lifecycleType,
        ...(event.exitReason ? { exitReason: event.exitReason } : {}),
        ...(event.harnessName ? { harnessName: event.harnessName } : {}),
        ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      };
      break;
    }

    case "unknown_passthrough": {
      newlyRedactedFields.push("rawPayload");
      projected = {
        ...baseHeader,
        redaction: buildRedactionMeta(newlyRedactedFields),
        type: "unknown_passthrough",
        rawEventType: event.rawEventType,
        rawPayload: {},
      };
      break;
    }

    default: {
      const exhaustiveCheck: never = event;
      throw new Error(`Unhandled event type: ${(exhaustiveCheck as NormalizedSessionEvent).type}`);
    }
  }

  if (validate) {
    return NormalizedSessionEventSchema.parse(projected);
  }
  return projected;
}
