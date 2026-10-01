import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RecordedWorkflow,
} from "@resin/contracts";
import {
  type LocalCallIdentity,
  type PrivateValueStore,
  type RecordableEvent,
  WorkflowCallRecorder,
  createLocalCallIdentity,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
} from "@resin/observer";

export type RecordedTurn =
  | { user: string }
  | {
      callId: string;
      toolName: string;
      parameters: Record<string, unknown>;
      result: string;
      connection?: string;
      /** Tool-call metadata as the harness decoder set it (e.g. a built-in shell's marker). */
      metadata?: Record<string, unknown>;
    };

/**
 * Captures turns through the real recorder as one session would have produced them, values owned by
 * `workspaceId`, and returns the recorded plan. Nothing is executed.
 */
export function recordSession(
  store: PrivateValueStore,
  params: { workspaceId: string; sessionId: string; workflowId: string },
  turns: readonly RecordedTurn[],
): RecordedWorkflow {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const emit = (fields: Record<string, unknown>) =>
    events.push(
      projectEventToMetadataOnly(
        recorder.observe(
          NormalizedSessionEventSchema.parse({
            schemaVersion: "1.0.0",
            sessionId: params.sessionId,
            eventId: `event-${sequence}`,
            timestamp: "2026-09-26T00:00:00.000Z",
            causalRef: { causalSequence: sequence++ },
            redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
            ...fields,
          }),
          { workspaceId: params.workspaceId },
        ),
      ),
    );
  for (const turn of turns) {
    if ("user" in turn) {
      emit({ type: "message", role: "user", content: turn.user });
      continue;
    }
    emit({
      type: "tool_call",
      callId: turn.callId,
      toolName: turn.toolName,
      parameters: turn.parameters,
      ...(turn.connection === undefined ? {} : { connection: turn.connection }),
      ...(turn.metadata === undefined ? {} : { metadata: turn.metadata }),
    });
    emit({
      type: "tool_result",
      callId: turn.callId,
      toolName: turn.toolName,
      result: turn.result,
      isError: false,
      executionDurationMs: 1,
    });
  }
  return recordCallsFromEvents(params.workflowId, events as RecordableEvent[])!.workflow;
}

/**
 * This device's recorded-call identity over the given session ids, as a harness adapter would list
 * them. Everything else — references, ownership, values — is read from the real store.
 */
export function localCallsFor(
  store: PrivateValueStore,
  workspaceId: string,
  sessionIds: readonly string[],
  /** The workspace root the harness lists the sessions under. */
  rootPath = "/nonexistent",
): LocalCallIdentity {
  return createLocalCallIdentity({
    workspaceId,
    privateValues: store,
    cacheTtlMs: 0,
    adapters: [
      {
        async listWorkspaces() {
          return [{ workspaceId: "harness-workspace", rootPath }];
        },
        async listSessions() {
          return sessionIds.map((sessionId) => ({ sessionId, workspaceId: "harness-workspace" }));
        },
      } as never,
    ],
  });
}
