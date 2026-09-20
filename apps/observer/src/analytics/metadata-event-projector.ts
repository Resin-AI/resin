import { createHash } from "node:crypto";
import {
  type DeterministicCommandSequence,
  type NormalizedSessionEvent,
  RESIN_COMMAND_SEQUENCE_METADATA_KEY,
  safeParseDeterministicCommandSequence,
} from "@resin/contracts";
import { projectEventToMetadataOnly } from "./metadata-projection.js";

const MAX_ENTRIES = 1024;
const MAX_RETAINED_BYTES = 2 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 256;

interface CompletionEvidence {
  sequence: DeterministicCommandSequence;
  cwd?: ".";
}

interface CallEntry {
  kind: "call";
  sessionId: string;
  eventId: string;
  toolName: string;
  causalSequence: number;
  stepIndex: number;
  timestampMs: number;
  evidence?: CompletionEvidence;
}

interface ReplayEntry {
  kind: "replay";
  sessionId: string;
  callKey: string;
  fingerprint: string;
  evidence?: CompletionEvidence;
}

interface StoredEntry {
  value: CallEntry | ReplayEntry;
  bytes: number;
}

function isSourceExecution(event: NormalizedSessionEvent): boolean {
  if (event.redaction.redactionStrategy === "synthetic") return false;
  if ("isShadow" in event && event.isShadow === true) return false;
  const metadata = event.metadata;
  if (!metadata) return true;
  for (const flag of ["synthetic", "isSynthetic", "replay", "isReplay", "isInternal"]) {
    if (metadata[flag] === true) return false;
  }
  for (const key of ["sessionKind", "origin", "source"]) {
    const value = metadata[key];
    if (
      value === "internal" ||
      value === "synthetic" ||
      value === "replay" ||
      value === "generated_tool"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Metadata-only projection with bounded, same-session command completion provenance.
 *
 * Only the pure projector's derived, schema-validated sequence and explicit safe root survive a
 * call. No command, argument value, result body or incoming result carrier enters retained state.
 * Event identities make redelivery idempotent; call identities are single-use until eviction.
 * Eviction fails closed. Retention is capped by both entry count and serialized UTF-8 bytes.
 */
export class MetadataEventProjector {
  private readonly entries = new Map<string, StoredEntry>();
  private retainedBytes = 0;

  public project(event: NormalizedSessionEvent): NormalizedSessionEvent {
    const projected = projectEventToMetadataOnly(event);
    // Processing time is not source evidence and must not change a retry's payload.
    delete projected.redaction.redactedAt;
    const metadata = projected.metadata ?? {};
    projected.metadata = metadata;
    const sourceExecution = isSourceExecution(event);
    if (!sourceExecution) delete metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY];

    if (event.type === "session_lifecycle") {
      if (event.lifecycleType === "end" || event.lifecycleType === "crash") {
        this.endSession(event.sessionId);
      }
      return projected;
    }
    if (event.type === "command_exec") {
      if (event.exitCode !== 0) delete metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
      return projected;
    }
    if (event.type !== "tool_call" && event.type !== "tool_result") return projected;

    // Even a schema-valid user-supplied result carrier is never completion provenance.
    if (event.type === "tool_result") {
      delete metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
      delete metadata.cwd;
    }
    if (
      !event.sessionId ||
      event.sessionId.length > MAX_ID_LENGTH ||
      !event.eventId ||
      event.eventId.length > MAX_ID_LENGTH ||
      !event.callId ||
      event.callId.length > MAX_ID_LENGTH ||
      !event.toolName ||
      event.toolName.length > MAX_TOOL_NAME_LENGTH
    ) {
      delete metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
      return projected;
    }

    const parsedSequence = safeParseDeterministicCommandSequence(
      metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY],
    );
    const callEvidence: CompletionEvidence | undefined =
      event.type === "tool_call" && sourceExecution && parsedSequence.success
        ? {
            sequence: parsedSequence.data,
            ...(metadata.cwd === "." ? { cwd: "." as const } : {}),
          }
        : undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([projected, sourceExecution]))
      .digest("hex");
    const replayKey = `event\0${event.sessionId}\0${event.eventId}`;
    const callKey = `call\0${event.sessionId}\0${event.callId}`;
    const replay = this.entries.get(replayKey)?.value;
    if (replay?.kind === "replay") {
      if (replay.fingerprint !== fingerprint) {
        this.closeCall(replay.callKey);
        this.closeCall(callKey);
        this.remember(replayKey, {
          kind: "replay",
          sessionId: event.sessionId,
          callKey,
          fingerprint: "conflict",
        });
        delete metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
        return projected;
      }
      if (event.type === "tool_result" && replay.evidence) this.attach(projected, replay.evidence);
      return projected;
    }

    const call = this.entries.get(callKey)?.value;
    let completion: CompletionEvidence | undefined;
    if (event.type === "tool_call") {
      if (call) {
        // A distinct event reusing a call id is ambiguous, even when its projected shape agrees.
        this.closeCall(callKey);
      } else {
        this.remember(callKey, {
          kind: "call",
          sessionId: event.sessionId,
          eventId: event.eventId,
          toolName: event.toolName,
          causalSequence: event.causalRef.causalSequence,
          stepIndex: event.causalRef.stepIndex ?? 0,
          timestampMs: Date.parse(event.timestamp),
          evidence: callEvidence,
        });
      }
    } else {
      if (
        sourceExecution &&
        event.isError === false &&
        call?.kind === "call" &&
        call.evidence &&
        call.toolName === event.toolName &&
        call.eventId !== event.eventId &&
        (event.causalRef.causalSequence > call.causalSequence ||
          (event.causalRef.causalSequence === call.causalSequence &&
            (event.causalRef.stepIndex ?? 0) > call.stepIndex)) &&
        Date.parse(event.timestamp) >= call.timestampMs
      ) {
        completion = call.evidence;
        this.attach(projected, completion);
      }
      if (call) {
        this.closeCall(callKey);
      } else {
        // Remember an unmatched result so an out-of-order call cannot revive it later.
        this.remember(callKey, {
          kind: "call",
          sessionId: event.sessionId,
          eventId: event.eventId,
          toolName: event.toolName,
          causalSequence: event.causalRef.causalSequence,
          stepIndex: event.causalRef.stepIndex ?? 0,
          timestampMs: Date.parse(event.timestamp),
        });
      }
    }
    this.remember(replayKey, {
      kind: "replay",
      sessionId: event.sessionId,
      callKey,
      fingerprint,
      evidence: completion,
    });
    return projected;
  }

  /** Drops live pairing state on terminal transitions, retaining only bounded retry evidence. */
  public endSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.value.sessionId === sessionId && entry.value.kind === "call") this.closeCall(key);
    }
  }

  /** Privacy boundaries and stop/dispose discard both pending calls and completed retry evidence. */
  public clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.entries.clear();
      this.retainedBytes = 0;
      return;
    }
    for (const [key, entry] of this.entries) {
      if (entry.value.sessionId === sessionId) this.remove(key);
    }
  }

  private attach(event: NormalizedSessionEvent, evidence: CompletionEvidence): void {
    event.metadata ??= {};
    // Consumers may mutate their event; retained provenance must remain immutable to them.
    event.metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY] = structuredClone(evidence.sequence);
    if (evidence.cwd !== undefined) event.metadata.cwd = evidence.cwd;
  }

  private closeCall(key: string): void {
    const call = this.entries.get(key)?.value;
    if (call?.kind !== "call" || call.evidence === undefined) return;
    const { evidence: _evidence, ...closed } = call;
    this.remember(key, closed);
  }

  private remember(key: string, value: CallEntry | ReplayEntry): void {
    this.remove(key);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_RETAINED_BYTES) return;
    this.entries.set(key, { value, bytes });
    this.retainedBytes += bytes;
    while (this.entries.size > MAX_ENTRIES || this.retainedBytes > MAX_RETAINED_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedBytes -= entry.bytes;
    this.entries.delete(key);
  }
}
