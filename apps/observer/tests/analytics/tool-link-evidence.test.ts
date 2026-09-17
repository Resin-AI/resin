import { createHash } from "node:crypto";
import { RESIN_LOCAL_OMP_NATIVE_CALL_KEY } from "@resin/adapter-omp";
import {
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  type NormalizedSessionLifecycleEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_TOOL_LINK_EVIDENCE_KEY,
  type ToolLinkEvidenceV1,
  readToolLinkEvidence,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { ToolLinkEvidenceRecorder } from "../../src/analytics/tool-links/recorder.js";

// ============================================================================
// Independently authored synthetic canaries
//
// Every value below is invented for this test: the checklist body, the repository, the issue number
// and the scratch paths exist nowhere else, so a carrier that echoed any of them would be caught.
// ============================================================================

const CANARY_ISSUE = "4242";
const CANARY_REPO = "canary-org/canary-repo";
const CANARY_DIR = "/tmp/rtl-canary-scratch";
const CANARY_DRAFT = `${CANARY_DIR}/draft.md`;
const CANARY_NEXT = `${CANARY_DIR}/next.md`;
const CANARY_OLD_TASKS = "- [ ] alpha task\n- [ ] beta task";
const CANARY_NEW_TASKS = "- [x] alpha task\n- [ ] beta task";
const CANARY_SECRET = "rk_live_CANARY_do_not_publish_0001";
const CANARIES = [
  CANARY_ISSUE,
  CANARY_REPO,
  CANARY_DIR,
  "draft.md",
  "next.md",
  "alpha task",
  "beta task",
  CANARY_SECRET,
];

function expectNoCanaries(value: unknown): void {
  const json = JSON.stringify(value) ?? "";
  for (const canary of CANARIES) {
    expect(json).not.toContain(canary);
    // No digest of a private value may stand in for the value either.
    const digest = createHash("sha256").update(canary).digest("hex");
    expect(json).not.toContain(digest);
  }
}

const SCHEMA_VERSION = "1.0.0" as const;

function causal(sequence: number): NormalizedSessionEvent["causalRef"] {
  return { parentId: null, causalSequence: sequence };
}

function redaction(fields: string[] = []): NormalizedSessionEvent["redaction"] {
  return {
    isRedacted: fields.length > 0,
    redactedFields: fields,
    redactionStrategy: fields.length > 0 ? "drop" : "none",
    scrubbedPatterns: [],
  };
}

function toolCall(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  sequence: number;
}): NormalizedToolCallEvent {
  return {
    eventId: `evt_call_${options.sessionId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 5, 30, 0, 0, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["parameters"]),
    metadata: { scenarioId: options.sessionId },
    type: "tool_call",
    callId: options.callId,
    toolName: options.toolName,
    parameters: options.parameters,
    isShadow: false,
  };
}

function toolResult(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  sequence: number;
  isError?: boolean;
  result?: unknown;
  metadata?: Record<string, unknown>;
}): NormalizedToolResultEvent {
  return {
    eventId: `evt_result_${options.sessionId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 5, 30, 0, 1, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["result"]),
    metadata: { scenarioId: options.sessionId, ...(options.metadata ?? {}) },
    type: "tool_result",
    callId: options.callId,
    toolName: options.toolName,
    result: options.result ?? "ok",
    isError: options.isError ?? false,
    executionDurationMs: 5,
  };
}

function commandExec(options: {
  sessionId: string;
  command: string;
  sequence: number;
  exitCode?: number;
  stdout?: string;
  cwd?: string;
}): NormalizedCommandExecEvent {
  return {
    eventId: `evt_command_${options.sessionId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 5, 30, 0, 2, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["stdout", "stderr"]),
    metadata: { scenarioId: options.sessionId },
    type: "command_exec",
    command: options.command,
    args: [],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    exitCode: options.exitCode ?? 0,
    stdout: options.stdout ?? "",
    durationMs: 4,
  };
}

function lifecycle(options: {
  sessionId: string;
  sequence: number;
  lifecycleType: "end" | "start";
}): NormalizedSessionLifecycleEvent {
  return {
    eventId: `evt_lifecycle_${options.sessionId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 5, 30, 0, 3, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(),
    metadata: { scenarioId: options.sessionId },
    type: "session_lifecycle",
    lifecycleType: options.lifecycleType,
  };
}

function carrierOf(event: NormalizedSessionEvent): ToolLinkEvidenceV1 | undefined {
  return readToolLinkEvidence(event.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]);
}

function rawCarrierOf(event: NormalizedSessionEvent): unknown {
  return event.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY];
}

const VIEW_COMMAND = `gh issue view ${CANARY_ISSUE} --repo ${CANARY_REPO} --json number,title,body --jq '.body' > ${CANARY_DRAFT}`;
const EDIT_COMMAND = `gh issue edit ${CANARY_ISSUE} --repo ${CANARY_REPO} --body-file ${CANARY_NEXT}`;

/**
 * The shape one checklist cycle really has: an issue read that redirects its body to a scratch file,
 * a Python transform that reads that file and writes the new body to another one, and an issue update
 * that publishes the new body file. The task text is authored for this test.
 */
function transformSource(): string {
  return [
    "from pathlib import Path",
    `body_path = Path('${CANARY_DRAFT}')`,
    "body = body_path.read_text(encoding='utf-8')",
    `old = """${CANARY_OLD_TASKS}"""`,
    `new = """${CANARY_NEW_TASKS}"""`,
    `assert old in body, '${CANARY_SECRET}'`,
    `Path('${CANARY_NEXT}').write_text(body.replace(old, new), encoding='utf-8')`,
    "print('transformed')",
  ].join("\n");
}

interface CycleEvents {
  readonly viewCall: NormalizedToolCallEvent;
  readonly viewResult: NormalizedToolResultEvent;
  readonly transformCall: NormalizedToolCallEvent;
  readonly transformResult: NormalizedToolResultEvent;
  readonly editCall: NormalizedToolCallEvent;
  readonly editResult: NormalizedToolResultEvent;
}

function checklistCycle(options: {
  sessionId: string;
  cycle: number;
  startSequence: number;
  draftPath?: string;
  nextPath?: string;
}): CycleEvents {
  const draft = options.draftPath ?? CANARY_DRAFT;
  const next = options.nextPath ?? CANARY_NEXT;
  const viewCommand = `gh issue view ${CANARY_ISSUE} --repo ${CANARY_REPO} --json number,title,body --jq '.body' > ${draft}`;
  const editCommand = `gh issue edit ${CANARY_ISSUE} --repo ${CANARY_REPO} --body-file ${next}`;
  const source = transformSource().split(CANARY_DRAFT).join(draft).split(CANARY_NEXT).join(next);
  const base = options.startSequence;
  return {
    viewCall: toolCall({
      sessionId: options.sessionId,
      callId: `call_view_${options.cycle}`,
      toolName: "bash",
      parameters: { command: viewCommand, timeout: 30 },
      sequence: base,
    }),
    viewResult: toolResult({
      sessionId: options.sessionId,
      callId: `call_view_${options.cycle}`,
      toolName: "bash",
      sequence: base + 1,
      result: [{ type: "text", text: CANARY_OLD_TASKS }],
    }),
    transformCall: toolCall({
      sessionId: options.sessionId,
      callId: `call_transform_${options.cycle}`,
      toolName: "eval",
      parameters: {
        code: source,
        language: "py",
        reset: false,
        timeout: 30,
        title: `checklist-${options.cycle}`,
      },
      sequence: base + 2,
    }),
    transformResult: toolResult({
      sessionId: options.sessionId,
      callId: `call_transform_${options.cycle}`,
      toolName: "eval",
      sequence: base + 3,
      result: [{ type: "text", text: `details.cells[0].output=${CANARY_NEXT}` }],
      metadata: {
        details: { language: "python", cells: [{ index: 0, exitCode: 0, status: "complete" }] },
      },
    }),
    editCall: toolCall({
      sessionId: options.sessionId,
      callId: `call_edit_${options.cycle}`,
      toolName: "bash",
      parameters: { command: editCommand, timeout: 30 },
      sequence: base + 4,
    }),
    editResult: toolResult({
      sessionId: options.sessionId,
      callId: `call_edit_${options.cycle}`,
      toolName: "bash",
      sequence: base + 5,
      result: [{ type: "text", text: `https://example.invalid/${CANARY_ISSUE}` }],
    }),
  };
}

function cycleEvents(events: CycleEvents): NormalizedSessionEvent[] {
  return [
    events.viewCall,
    events.viewResult,
    events.transformCall,
    events.transformResult,
    events.editCall,
    events.editResult,
  ];
}

function observeAll(
  recorder: ToolLinkEvidenceRecorder,
  events: readonly NormalizedSessionEvent[],
): Map<string, NormalizedSessionEvent> {
  const observed = new Map<string, NormalizedSessionEvent>();
  for (const event of events) {
    observed.set(event.eventId, recorder.observe(event));
  }
  return observed;
}

describe("tool link capture", () => {
  const SESSION = "sess_tool_link_canary";

  it("links three same-session checklist cycles through shared resource refs", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const cycles = [1, 2, 3].map((cycle) =>
      checklistCycle({ sessionId: SESSION, cycle, startSequence: 1 + (cycle - 1) * 6 }),
    );
    const observed = observeAll(recorder, cycles.flatMap(cycleEvents));

    const issueRefs = new Set<string>();
    const draftRefs = new Set<string>();
    const nextRefs = new Set<string>();
    for (const cycle of cycles) {
      const viewPending = carrierOf(observed.get(cycle.viewCall.eventId)!);
      const viewDone = carrierOf(observed.get(cycle.viewResult.eventId)!);
      const transformPending = carrierOf(observed.get(cycle.transformCall.eventId)!);
      const transformDone = carrierOf(observed.get(cycle.transformResult.eventId)!);
      const editPending = carrierOf(observed.get(cycle.editCall.eventId)!);
      const editDone = carrierOf(observed.get(cycle.editResult.eventId)!);

      expect(viewPending).toMatchObject({
        operation: "github.issue.read",
        observation: { callId: cycle.viewCall.callId, status: "pending" },
      });
      expect(viewDone).toMatchObject({
        operation: "github.issue.read",
        observation: {
          callId: cycle.viewCall.callId,
          callEventId: cycle.viewCall.eventId,
          resultEventId: cycle.viewResult.eventId,
          status: "success",
        },
      });
      expect(transformDone).toMatchObject({
        operation: "file.transform",
        contentKinds: ["markdown_checklist"],
        observation: {
          callEventId: cycle.transformCall.eventId,
          resultEventId: cycle.transformResult.eventId,
          status: "success",
        },
      });
      expect(transformPending?.observation.status).toBe("pending");
      expect(editDone).toMatchObject({
        operation: "github.issue.update",
        observation: {
          callEventId: cycle.editCall.eventId,
          resultEventId: cycle.editResult.eventId,
          status: "success",
        },
      });
      expect(editPending?.observation.status).toBe("pending");
      expect(editDone?.inputs).toEqual(
        expect.arrayContaining([
          {
            name: "changes",
            ref: nextRefs.size === 0 ? editDone?.reads[0]?.ref : editDone?.reads[0]?.ref,
          },
        ]),
      );

      // The declared chain is connected by identity: the file the read wrote is the file the
      // transform read, and the file the transform wrote is the file the update consumed.
      const issueRef = viewDone?.reads[0]?.ref;
      const draftRef = viewDone?.writes[0]?.ref;
      const nextRef = transformDone?.writes[0]?.ref;
      expect(transformDone?.reads[0]?.ref).toBe(draftRef);
      expect(editDone?.reads[0]?.ref).toBe(nextRef);
      expect(editDone?.writes[0]?.ref).toBe(issueRef);
      expect(issueRef).toBeDefined();
      issueRefs.add(issueRef!);
      draftRefs.add(draftRef!);
      nextRefs.add(nextRef!);
    }

    // One scope, so the same issue and the same scratch files keep one identity across all cycles,
    // while each cycle keeps its own call and result ids (three completions, not one component).
    expect(issueRefs.size).toBe(1);
    expect(draftRefs.size).toBe(1);
    expect(nextRefs.size).toBe(1);
    const callIds = cycles.map((cycle) => cycle.editCall.callId);
    expect(new Set(callIds).size).toBe(3);
    expect(new Set(cycles.map((cycle) => cycle.editResult.eventId)).size).toBe(3);
  });

  it("keeps every carrier privacy-free of the declared values", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const cycle = checklistCycle({ sessionId: SESSION, cycle: 1, startSequence: 1 });
    const observed = observeAll(recorder, cycleEvents(cycle));

    for (const event of observed.values()) {
      const raw = rawCarrierOf(event);
      if (raw !== undefined) {
        expectNoCanaries(raw);
        expect(readToolLinkEvidence(raw)).toBeDefined();
      }
    }
    // The events themselves still carry their own declared arguments; only the carrier is projected.
    expect(rawCarrierOf(observed.get(cycle.transformCall.eventId)!)).toBeDefined();
  });

  it("is deterministic for a full replay of the same sequence", () => {
    const events = [1, 2, 3].flatMap((cycle) =>
      cycleEvents(
        checklistCycle({ sessionId: SESSION, cycle, startSequence: 1 + (cycle - 1) * 6 }),
      ),
    );
    const first = observeAll(new ToolLinkEvidenceRecorder(), events);
    const replay = observeAll(
      new ToolLinkEvidenceRecorder(),
      JSON.parse(JSON.stringify(events)) as NormalizedSessionEvent[],
    );

    const carriersOf = (observed: Map<string, NormalizedSessionEvent>) =>
      [...observed.entries()].map(([eventId, event]) => [eventId, rawCarrierOf(event)]);
    expect(carriersOf(replay)).toEqual(carriersOf(first));

    // A full replay re-observes the same first call, so it reconstructs the SAME scope id and the
    // same ordinal map rather than merely an equivalent one.
    const scopeOf = (observed: Map<string, NormalizedSessionEvent>) => {
      const event = observed.get(events[0]!.eventId)!;
      const carrier = carrierOf(event)!;
      return {
        scopeId: carrier.scopeId,
        refs: [carrier.reads[0]?.ref, carrier.writes[0]?.ref],
      };
    };
    expect(scopeOf(replay)).toEqual(scopeOf(first));
    expect(scopeOf(first).scopeId).toBe(events[0]!.eventId);
    expect(scopeOf(first).refs).toEqual(["r0", "r1"]);

    // Re-observing the very same event is idempotent and does not consume ordinals either.
    const recorder = new ToolLinkEvidenceRecorder();
    const all = events;
    const single = observeAll(recorder, all);
    const again = all.map((event) => recorder.observe(event));
    expect(again.map((event) => rawCarrierOf(event))).toEqual(
      all.map((event) => rawCarrierOf(single.get(event.eventId)!)),
    );
  });

  it("loses the earlier scope when a capture resumes at a later call", () => {
    const events = [1, 2, 3].flatMap((cycle) =>
      cycleEvents(
        checklistCycle({ sessionId: SESSION, cycle, startSequence: 1 + (cycle - 1) * 6 }),
      ),
    );
    const fullCapture = observeAll(new ToolLinkEvidenceRecorder(), events);
    const fullScope = carrierOf(fullCapture.get(events[0]!.eventId)!)!.scopeId;
    expect(fullScope).toBe(events[0]!.eventId);

    // A restart that lost local state resumes mid-session: the first call it observes is a later one,
    // so it must not reuse the earlier scope (or its ordinal numbering) at all.
    const resumed = new ToolLinkEvidenceRecorder();
    const resumedEvents = events.slice(6);
    const resumedObserved = observeAll(resumed, resumedEvents);
    const resumedCarrier = carrierOf(resumedObserved.get(resumedEvents[0]!.eventId)!);
    expect(resumedCarrier?.scopeId).toBe(resumedEvents[0]!.eventId);
    expect(resumedCarrier?.scopeId).not.toBe(fullScope);
    expect(resumedCarrier?.reads[0]?.ref).toBe("r0");
  });

  it("produces identical carriers when the same events arrive across split batches", () => {
    const events = cycleEvents(checklistCycle({ sessionId: SESSION, cycle: 1, startSequence: 1 }));
    const whole = observeAll(new ToolLinkEvidenceRecorder(), events);

    const split = new ToolLinkEvidenceRecorder();
    const parts: NormalizedSessionEvent[] = [];
    for (const event of events) {
      parts.push(split.observe(event));
    }
    expect(parts.map((event) => rawCarrierOf(event))).toEqual(
      events.map((event) => rawCarrierOf(whole.get(event.eventId)!)),
    );

    // A batch boundary between a call and its result (and before the completing batch) changes
    // nothing: the pending call is retained per session until its result arrives.
    const boundary = new ToolLinkEvidenceRecorder();
    const viewCall = boundary.observe(events[0]!);
    const transformCall = boundary.observe(events[2]!);
    const results = events.slice(4).map((event) => boundary.observe(event));
    const late = events.slice(1, 4).map((event) => boundary.observe(event));
    expect(rawCarrierOf(viewCall)).toEqual(rawCarrierOf(whole.get(events[0]!.eventId)!));
    expect(rawCarrierOf(transformCall)).toEqual(rawCarrierOf(whole.get(events[2]!.eventId)!));
    expect([...results, ...late].map((event) => rawCarrierOf(event))).toEqual(
      [...events.slice(4), ...events.slice(1, 4)].map((event) =>
        rawCarrierOf(whole.get(event.eventId)!),
      ),
    );
  });

  it("reports failure from the actual outcome instead of trusting isError", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const evalCall = (callId: string, sequence: number) =>
      toolCall({
        sessionId: SESSION,
        callId,
        toolName: "eval",
        parameters: { code: transformSource(), language: "py" },
        sequence,
      });

    // A result that embeds an execution record with a nonzero exit code and an error status.
    const structuredCall = evalCall("call_structured", 1);
    const structuredFailure = toolResult({
      sessionId: SESSION,
      callId: "call_structured",
      toolName: "eval",
      sequence: 2,
      isError: false,
      result: {
        details: {
          language: "python",
          isError: true,
          cells: [{ index: 0, exitCode: 1, status: "error", durationMs: 4 }],
        },
      },
    });
    expect(carrierOf(recorder.observe(structuredCall))?.observation.status).toBe("pending");
    expect(carrierOf(recorder.observe(structuredFailure))?.observation.status).toBe("failure");

    // The shape normalization really produces: the interpreter's own output, with the harness still
    // reporting `isError: false`.
    const tracebackCall = evalCall("call_traceback", 3);
    const tracebackFailure = toolResult({
      sessionId: SESSION,
      callId: "call_traceback",
      toolName: "eval",
      sequence: 4,
      isError: false,
      result:
        "Traceback (most recent call last):\n  File \"x.py\", line 3, in <module>\nKeyError: 'body'",
    });
    expect(carrierOf(recorder.observe(tracebackCall))?.observation.status).toBe("pending");
    expect(carrierOf(recorder.observe(tracebackFailure))?.observation.status).toBe("failure");

    const errorLineCall = evalCall("call_error_line", 5);
    const errorLineFailure = toolResult({
      sessionId: SESSION,
      callId: "call_error_line",
      toolName: "eval",
      sequence: 6,
      isError: false,
      result: "ModuleNotFoundError: No module named 'yaml'",
    });
    recorder.observe(errorLineCall);
    expect(carrierOf(recorder.observe(errorLineFailure))?.observation.status).toBe("failure");

    // A successful interpreter run: an explicit zero exit code, and output that is not a traceback.
    const okCall = evalCall("call_ok", 7);
    const okResult = toolResult({
      sessionId: SESSION,
      callId: "call_ok",
      toolName: "eval",
      sequence: 8,
      result: {
        details: { cells: [{ index: 0, exitCode: 0, status: "complete", durationMs: 3 }] },
      },
    });
    recorder.observe(okCall);
    expect(carrierOf(recorder.observe(okResult))?.observation.status).toBe("success");

    const errorCall = evalCall("call_error", 9);
    const errorResult = toolResult({
      sessionId: SESSION,
      callId: "call_error",
      toolName: "eval",
      sequence: 10,
      isError: true,
      result: "boom",
    });
    recorder.observe(errorCall);
    expect(carrierOf(recorder.observe(errorResult))?.observation.status).toBe("failure");

    // Fetched content that merely quotes a failure is not the call's outcome: a file read whose body
    // contains a traceback stays a successful read.
    const reads = new ToolLinkEvidenceRecorder();
    const readCall = toolCall({
      sessionId: "sess_read_canary",
      callId: "call_read_log",
      toolName: "read",
      parameters: { path: "/tmp/rtl-canary-scratch/crash.log" },
      sequence: 1,
    });
    const readResult = toolResult({
      sessionId: "sess_read_canary",
      callId: "call_read_log",
      toolName: "read",
      sequence: 2,
      isError: false,
      result: 'Traceback (most recent call last):\n  File "y.py", line 1\nValueError: quoted',
    });
    reads.observe(readCall);
    const readCarrier = carrierOf(reads.observe(readResult));
    expect(readCarrier).toMatchObject({
      operation: "file.read",
      observation: { status: "success" },
    });
  });

  it("does not decide a long program stream it has only partly read", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const longOutput = "x".repeat(20_000);
    const evalCall = (callId: string, sequence: number) =>
      toolCall({
        sessionId: "sess_long_output",
        callId,
        toolName: "eval",
        parameters: { code: transformSource(), language: "py" },
        sequence,
      });

    // A diagnostic at the END of a long stream is still the program's outcome, even though the
    // harness reported `isError: false`.
    const footerCall = evalCall("call_footer", 1);
    const footerResult = toolResult({
      sessionId: "sess_long_output",
      callId: "call_footer",
      toolName: "eval",
      sequence: 2,
      isError: false,
      result: [
        { type: "text", text: longOutput },
        {
          type: "text",
          text: `Traceback (most recent call last):\n  File "x.py", line 4\nValueError: boom`,
        },
      ],
    });
    recorder.observe(footerCall);
    expect(carrierOf(recorder.observe(footerResult))?.observation.status).toBe("failure");

    // A long stream with no diagnostic and no authoritative completion proves nothing: no carrier,
    // rather than a success claim about output this recorder never read.
    const unknownCall = evalCall("call_unknown", 3);
    const unknownResult = toolResult({
      sessionId: "sess_long_output",
      callId: "call_unknown",
      toolName: "eval",
      sequence: 4,
      isError: false,
      result: [{ type: "text", text: longOutput }],
    });
    const pending = carrierOf(recorder.observe(unknownCall));
    expect(pending?.observation.status).toBe("pending");
    const unknownObserved = recorder.observe(unknownResult);
    expect(carrierOf(unknownObserved)).toBeUndefined();
    expect(unknownObserved.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]).toBeUndefined();

    // An authoritative zero exit code decides it: the stream length no longer matters.
    const authoritativeCall = evalCall("call_authoritative", 5);
    const authoritativeResult = toolResult({
      sessionId: "sess_long_output",
      callId: "call_authoritative",
      toolName: "eval",
      sequence: 6,
      isError: false,
      result: {
        output: longOutput,
        details: { cells: [{ index: 0, exitCode: 0, status: "complete", durationMs: 9 }] },
      },
    });
    recorder.observe(authoritativeCall);
    expect(carrierOf(recorder.observe(authoritativeResult))?.observation.status).toBe("success");

    // Fetched content is not an outcome: a long, truncated file body stays a successful read.
    const readRecorder = new ToolLinkEvidenceRecorder();
    const readCall = toolCall({
      sessionId: "sess_long_read",
      callId: "call_long_read",
      toolName: "read",
      parameters: { path: "/tmp/rtl-canary-scratch/crash.log" },
      sequence: 1,
    });
    const readResult = toolResult({
      sessionId: "sess_long_read",
      callId: "call_long_read",
      toolName: "read",
      sequence: 2,
      isError: false,
      result: `${longOutput}\nTraceback (most recent call last):\n  File "z.py", line 1\nValueError: quoted`,
    });
    readRecorder.observe(readCall);
    expect(carrierOf(readRecorder.observe(readResult))).toMatchObject({
      operation: "file.read",
      observation: { status: "success" },
    });
  });

  it("never lets unexecuted or conditional code rebind a declared path", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const scriptCall = (callId: string, code: string, sequence: number) =>
      toolCall({
        sessionId: "sess_control_flow_bindings",
        callId,
        toolName: "eval",
        parameters: { code, language: "py" },
        sequence,
      });

    const reboundElsewhere = [
      ["if False:", "    p = Path('/tmp/rtl-canary-scratch/other.md')"],
      ["if enabled:", "    p = Path('/tmp/rtl-canary-scratch/other.md')"],
      ["def rewrite():", "    p = Path('/tmp/rtl-canary-scratch/other.md')"],
    ];
    for (const [index, block] of reboundElsewhere.entries()) {
      const call = scriptCall(
        `call_rebound_${index}`,
        [
          "from pathlib import Path",
          `p = Path('${CANARY_DRAFT}')`,
          ...block,
          "data = p.read_text()",
        ].join("\n"),
        1 + index * 2,
      );
      // The unexecuted assignment must not turn this into a read of the other file, and the walk
      // cannot prove which file it is any more, so nothing is claimed at all.
      expect(carrierOf(recorder.observe(call))).toBeUndefined();
    }

    // Control: without that block the same straight-line read is captured.
    const control = scriptCall(
      "call_control",
      ["from pathlib import Path", `p = Path('${CANARY_DRAFT}')`, "data = p.read_text()"].join(
        "\n",
      ),
      9,
    );
    expect(carrierOf(recorder.observe(control))).toMatchObject({
      operation: "file.read",
      reads: [{ kind: "file" }],
    });
  });

  it("inherits a read origin only through concatenation, never through other operators", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const scriptCall = (callId: string, code: string, sequence: number) =>
      toolCall({
        sessionId: "sess_operators",
        callId,
        toolName: "eval",
        parameters: { code, language: "py" },
        sequence,
      });
    const writeWith = (callId: string, payload: string, sequence: number) =>
      scriptCall(
        callId,
        [
          "from pathlib import Path",
          `body = Path('${CANARY_DRAFT}').read_text()`,
          `Path('${CANARY_NEXT}').write_text(${payload}, encoding='utf-8')`,
        ].join("\n"),
        sequence,
      );

    for (const [index, payload] of [
      "'constant' or body",
      "'constant' and body",
      "'constant' == body",
      "body * 3",
      "'%s' % body",
      "len(body)",
    ].entries()) {
      const carrier = carrierOf(
        recorder.observe(writeWith(`call_op_${index}`, payload, 1 + index * 2)),
      );
      // The payload depends on the read in a way this walk cannot follow, so it is not a transform;
      // the read itself stays a read, and the write is not presented as connected to it.
      expect(carrier).toMatchObject({ operation: "file.read", writes: [] });
    }

    // Control: concatenation (and the closed deriving methods) do carry the origin.
    expect(
      carrierOf(recorder.observe(writeWith("call_op_concat", "'prefix\\n' + body", 20))),
    ).toMatchObject({ operation: "file.transform" });
    expect(
      carrierOf(recorder.observe(writeWith("call_op_method", "body.replace('a', 'b')", 22))),
    ).toMatchObject({ operation: "file.transform" });
  });

  it("refuses a chained or multi-line command instead of capturing a part that may not run", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const bashCall = (callId: string, command: string, sequence: number) =>
      toolCall({
        sessionId: "sess_shell_control_flow",
        callId,
        toolName: "bash",
        parameters: { command },
        sequence,
      });

    for (const [index, command] of [
      `true || ${EDIT_COMMAND}`,
      `true && ${EDIT_COMMAND}`,
      `false; ${EDIT_COMMAND}`,
      `cd ${CANARY_DIR} && ${VIEW_COMMAND}`,
      `${VIEW_COMMAND} | tee ${CANARY_NEXT}`,
      `${VIEW_COMMAND} &`,
      `${VIEW_COMMAND}\nrm ${CANARY_DRAFT}`,
      `$(echo gh) issue edit ${CANARY_ISSUE} --repo ${CANARY_REPO} --body-file ${CANARY_NEXT}`,
    ].entries()) {
      expect(
        carrierOf(recorder.observe(bashCall(`call_shell_${index}`, command, 1 + index * 2))),
      ).toBeUndefined();
    }

    // Control: the same commands without the chain are still captured, and a harmless trailing
    // newline or comment does not make a line unparseable.
    expect(
      carrierOf(recorder.observe(bashCall("call_shell_plain_edit", EDIT_COMMAND, 40))),
    ).toMatchObject({
      operation: "github.issue.update",
    });
    expect(
      carrierOf(recorder.observe(bashCall("call_shell_plain_view", `${VIEW_COMMAND}\n`, 42))),
    ).toMatchObject({ operation: "github.issue.read" });
  });

  it("omits evidence for ambiguous declarations and unmatched results", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const dynamicCall = toolCall({
      sessionId: SESSION,
      callId: "call_dynamic",
      toolName: "eval",
      parameters: {
        code: [
          "import sys",
          "from pathlib import Path",
          "body = Path(sys.argv[1]).read_text()",
          "Path(sys.argv[2]).write_text(body)",
        ].join("\n"),
        language: "py",
      },
      sequence: 1,
    });
    expect(carrierOf(recorder.observe(dynamicCall))).toBeUndefined();

    const reboundCall = toolCall({
      sessionId: SESSION,
      callId: "call_rebound",
      toolName: "eval",
      parameters: {
        code: [
          "from pathlib import Path",
          "p = Path('a.md')",
          "p = chr(120)",
          "p.read_text()",
        ].join("\n"),
        language: "py",
      },
      sequence: 2,
    });
    expect(carrierOf(recorder.observe(reboundCall))).toBeUndefined();

    const noFileCall = toolCall({
      sessionId: SESSION,
      callId: "call_nofiles",
      toolName: "eval",
      parameters: { code: "print('hello')", language: "py" },
      sequence: 3,
    });
    expect(carrierOf(recorder.observe(noFileCall))).toBeUndefined();

    // An unpaired result, and a result that is not causally later than its call, are not evidence.
    const orphan = toolResult({
      sessionId: SESSION,
      callId: "call_never_seen",
      toolName: "eval",
      sequence: 9,
      result: [{ type: "text", text: "ok" }],
    });
    expect(carrierOf(recorder.observe(orphan))).toBeUndefined();

    const notLater = toolResult({
      sessionId: SESSION,
      callId: "call_dynamic",
      toolName: "eval",
      sequence: 1,
      result: [{ type: "text", text: "ok" }],
    });
    expect(carrierOf(recorder.observe(notLater))).toBeUndefined();
  });

  it("connects a transform only when the written payload derives from the read value", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const scriptCall = (callId: string, code: string, sequence: number) =>
      toolCall({
        sessionId: "sess_derivation",
        callId,
        toolName: "eval",
        parameters: { code, language: "py" },
        sequence,
      });

    // Derivation through aliasing, a deriving method and concatenation.
    const derived = carrierOf(
      recorder.observe(
        scriptCall(
          "call_derived",
          [
            "from pathlib import Path",
            `body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
            "text = body",
            "out = text.replace('- [ ] alpha task', '- [x] alpha task').strip() + '\n'",
            `Path('${CANARY_NEXT}').write_text(out, encoding='utf-8')`,
          ].join("\n"),
          1,
        ),
      ),
    );
    expect(derived).toMatchObject({
      operation: "file.transform",
      contentKinds: ["markdown_checklist"],
      inputs: [{ name: "source" }, { name: "target" }],
    });
    expect(derived?.reads).toHaveLength(1);
    expect(derived?.writes).toHaveLength(1);
    expect(derived?.inputs[0]?.ref).toBe(derived?.reads[0]?.ref);
    expect(derived?.inputs[1]?.ref).toBe(derived?.writes[0]?.ref);

    // A write whose payload is a constant is NOT connected to the read it merely follows.
    const unrelated = carrierOf(
      recorder.observe(
        scriptCall(
          "call_unrelated",
          [
            "from pathlib import Path",
            `body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
            `Path('${CANARY_NEXT}').write_text('static replacement text', encoding='utf-8')`,
          ].join("\n"),
          3,
        ),
      ),
    );
    expect(unrelated).toMatchObject({ operation: "file.read", writes: [] });
    expect(unrelated?.reads).toHaveLength(1);

    // An untracked payload (a call this walk cannot follow) is not a derivation either.
    const untracked = carrierOf(
      recorder.observe(
        scriptCall(
          "call_untracked",
          [
            "from pathlib import Path",
            `body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
            "rendered = render(body)",
            `Path('${CANARY_NEXT}').write_text(rendered, encoding='utf-8')`,
          ].join("\n"),
          5,
        ),
      ),
    );
    expect(untracked).toMatchObject({ operation: "file.read", writes: [] });
  });

  it("reads an escaped literal's value, and never a raw literal's text", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const scriptCall = (callId: string, code: string, sequence: number) =>
      toolCall({
        sessionId: "sess_literal_values",
        callId,
        toolName: "eval",
        parameters: { code, language: "py" },
        sequence,
      });

    // `'\\n- [ ] escaped task\\n'` is a real line-start marker once decoded, so the appended section
    // is recognised as a checklist even though the source spells the newline as an escape.
    const escaped = carrierOf(
      recorder.observe(
        scriptCall(
          "call_escaped",
          [
            "from pathlib import Path",
            `body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
            `Path('${CANARY_NEXT}').write_text(body + '\\n- [ ] escaped task\\n', encoding='utf-8')`,
          ].join("\n"),
          1,
        ),
      ),
    );
    expect(escaped).toMatchObject({
      operation: "file.transform",
      contentKinds: ["markdown_checklist"],
    });

    // The same text in a RAW literal keeps its backslashes, so there is no line start and no shape
    // fact; the payload is a constant as well, so it is not connected to any read.
    const raw = carrierOf(
      recorder.observe(
        scriptCall(
          "call_raw",
          [
            "from pathlib import Path",
            `Path('${CANARY_NEXT}').write_text(r'\\n- [ ] raw task\\n', encoding='utf-8')`,
          ].join("\n"),
          3,
        ),
      ),
    );
    expect(raw).toMatchObject({ operation: "file.write", reads: [], contentKinds: [] });

    // An escape this decoder does not define is refused outright: no value, no shape, no path.
    const unknownEscape = carrierOf(
      recorder.observe(
        scriptCall(
          "call_unknown_escape",
          [
            "from pathlib import Path",
            `Path('${CANARY_NEXT}').write_text('a\\qb- [ ] unrelated', encoding='utf-8')`,
          ].join("\n"),
          5,
        ),
      ),
    );
    expect(unknownEscape).toMatchObject({ operation: "file.write", contentKinds: [] });

    // Two adjacent literals are one runtime value this walk does not join: the path is not claimed.
    const concatenated = carrierOf(
      recorder.observe(
        scriptCall(
          "call_concatenated",
          [
            "from pathlib import Path",
            `Path('${CANARY_DIR}/' 'joined.md').write_text('x', encoding='utf-8')`,
          ].join("\n"),
          7,
        ),
      ),
    );
    expect(concatenated).toBeUndefined();
  });

  it("omits a frame whose file operation is not provably executed", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const scriptCall = (callId: string, code: string, sequence: number) =>
      toolCall({
        sessionId: "sess_control_flow",
        callId,
        toolName: "eval",
        parameters: { code, language: "py" },
        sequence,
      });

    const conditional = scriptCall(
      "call_conditional",
      [
        "from pathlib import Path",
        `body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
        "if body:",
        `    Path('${CANARY_NEXT}').write_text(body, encoding='utf-8')`,
      ].join("\n"),
      1,
    );
    expect(carrierOf(recorder.observe(conditional))).toBeUndefined();

    const looped = scriptCall(
      "call_looped",
      [
        "from pathlib import Path",
        `body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
        "for chunk in body.split('\n'):",
        `    Path('${CANARY_NEXT}').write_text(chunk, encoding='utf-8')`,
      ].join("\n"),
      2,
    );
    expect(carrierOf(recorder.observe(looped))).toBeUndefined();

    const deadFunction = scriptCall(
      "call_dead",
      [
        "from pathlib import Path",
        "def rewrite():",
        `    body = Path('${CANARY_DRAFT}').read_text(encoding='utf-8')`,
        `    Path('${CANARY_NEXT}').write_text(body, encoding='utf-8')`,
        "print('never called')",
      ].join("\n"),
      3,
    );
    expect(carrierOf(recorder.observe(deadFunction))).toBeUndefined();

    // Quoted code is a string, not a program: no file operation is claimed from it.
    const quoted = scriptCall(
      "call_quoted",
      [
        "from pathlib import Path",
        `source = "Path('${CANARY_DRAFT}').read_text()"`,
        `Path('${CANARY_NEXT}').write_text(source, encoding='utf-8')`,
      ].join("\n"),
      4,
    );
    expect(carrierOf(recorder.observe(quoted))).toMatchObject({
      operation: "file.write",
      reads: [],
      contentKinds: [],
    });

    // A shadowed `Path` name is not the pathlib constructor any more, so nothing is claimed.
    const shadowed = scriptCall(
      "call_shadowed",
      [
        "from pathlib import Path",
        "Path = object()",
        `body = Path('${CANARY_DRAFT}').read_text()`,
        `Path('${CANARY_NEXT}').write_text(body)`,
      ].join("\n"),
      5,
    );
    expect(carrierOf(recorder.observe(shadowed))).toBeUndefined();
  });

  it("recovers the declared flow from an embedded native call when the call carries none", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const call = toolCall({
      sessionId: SESSION,
      callId: "call_embedded",
      toolName: "eval",
      parameters: {},
      sequence: 1,
    });
    const result = toolResult({
      sessionId: SESSION,
      callId: "call_embedded",
      toolName: "eval",
      sequence: 2,
      result: [{ type: "text", text: "transformed" }],
      metadata: {
        [RESIN_LOCAL_OMP_NATIVE_CALL_KEY]: {
          callId: "call_embedded",
          toolName: "eval",
          parameters: { code: transformSource(), language: "py" },
        },
      },
    });
    recorder.observe(call);
    const observedResult = recorder.observe(result);
    const carrier = carrierOf(observedResult);
    expect(carrier).toMatchObject({
      operation: "file.transform",
      contentKinds: ["markdown_checklist"],
      observation: { callEventId: call.eventId, resultEventId: result.eventId, status: "success" },
    });
    expectNoCanaries(rawCarrierOf(observedResult));

    // A handoff that names a different call is never used.
    const forged = new ToolLinkEvidenceRecorder();
    forged.observe(call);
    const forgedResult = toolResult({
      sessionId: SESSION,
      callId: "call_embedded",
      toolName: "eval",
      sequence: 2,
      result: [{ type: "text", text: "transformed" }],
      metadata: {
        [RESIN_LOCAL_OMP_NATIVE_CALL_KEY]: {
          callId: "call_someone_else",
          toolName: "eval",
          parameters: { code: transformSource(), language: "py" },
        },
      },
    });
    expect(carrierOf(forged.observe(forgedResult))).toBeUndefined();
  });

  it("scopes ordinals per session and per capture epoch", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const sessionA = checklistCycle({ sessionId: "sess_a", cycle: 1, startSequence: 1 });
    const sessionB = checklistCycle({ sessionId: "sess_b", cycle: 1, startSequence: 1 });
    const observedA = observeAll(recorder, cycleEvents(sessionA));
    const observedB = observeAll(recorder, cycleEvents(sessionB));

    const carrierA = carrierOf(observedA.get(sessionA.viewResult.eventId)!);
    const carrierB = carrierOf(observedB.get(sessionB.viewResult.eventId)!);
    expect(carrierA?.scopeId).toBe(sessionA.viewCall.eventId);
    expect(carrierB?.scopeId).toBe(sessionB.viewCall.eventId);
    // Two sessions spell the same scratch paths, and each gets its own namespace rather than sharing
    // an identity that only ever existed inside one session.
    expect(carrierA?.reads[0]?.ref).toBe("r0");
    expect(carrierB?.reads[0]?.ref).toBe("r0");
    expect(carrierA?.scopeId).not.toBe(carrierB?.scopeId);

    // A new capture epoch for the same session id (a restart) starts from a fresh scope and fresh
    // ordinals, so a ref can never name a resource of an earlier epoch.
    recorder.observe(lifecycle({ sessionId: "sess_a", sequence: 40, lifecycleType: "end" }));
    const restarted = checklistCycle({ sessionId: "sess_a", cycle: 2, startSequence: 41 });
    const observedRestart = observeAll(recorder, cycleEvents(restarted));
    const restartedCarrier = carrierOf(observedRestart.get(restarted.viewResult.eventId)!);
    expect(restartedCarrier?.scopeId).toBe(restarted.viewCall.eventId);
    expect(restartedCarrier?.scopeId).not.toBe(carrierA?.scopeId);
    expect(restartedCarrier?.reads[0]?.ref).toBe("r0");
  });

  it("attaches a carrier as metadata without changing event identity", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const cycle = checklistCycle({ sessionId: SESSION, cycle: 1, startSequence: 1 });
    const observed = observeAll(recorder, cycleEvents(cycle));

    for (const event of cycleEvents(cycle)) {
      const after = observed.get(event.eventId)!;
      expect(after.eventId).toBe(event.eventId);
      expect(after.sessionId).toBe(event.sessionId);
      expect(after.timestamp).toBe(event.timestamp);
      expect(after.causalRef).toEqual(event.causalRef);
      expect(after.type).toBe(event.type);
      expect(after.redaction).toEqual(event.redaction);
      if (event.type === "tool_call") {
        expect((after as NormalizedToolCallEvent).callId).toBe(event.callId);
      }
      if (event.type === "tool_result") {
        expect((after as NormalizedToolResultEvent).callId).toBe(event.callId);
      }
      const extraKeys = Object.keys(after.metadata ?? {}).filter(
        (key) => !Object.prototype.hasOwnProperty.call(event.metadata ?? {}, key),
      );
      expect(extraKeys).toEqual(
        rawCarrierOf(after) === undefined ? [] : [RESIN_TOOL_LINK_EVIDENCE_KEY],
      );
    }
  });

  it("survives metadata-only projection with identical ids and no raw content", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const cycle = checklistCycle({ sessionId: SESSION, cycle: 1, startSequence: 1 });
    const observed = observeAll(recorder, cycleEvents(cycle));

    for (const event of cycleEvents(cycle)) {
      const after = observed.get(event.eventId)!;
      const projected = projectEventToMetadataOnly(after);
      expect(projected.eventId).toBe(event.eventId);
      expect(projected.causalRef).toEqual(event.causalRef);
      expect(projected.sessionId).toBe(event.sessionId);
      const carrier = carrierOf(after);
      if (carrier === undefined) {
        continue;
      }
      // Enrichment re-reads the carrier and copies it by value: the projected carrier is identical,
      // and the raw result never reaches the projected surface.
      expect(carrierOf(projected)).toEqual(carrier);
      expect(projected.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]).toBeDefined();
      if (projected.type === "tool_result") {
        expect(projected.result).toBeUndefined();
      }
      expectNoCanaries(rawCarrierOf(projected));
      expectNoCanaries(carrier);
    }

    // The authored program of the transform never rides along either: only its shape survives.
    const projectedTransform = projectEventToMetadataOnly(
      observed.get(cycle.transformCall.eventId)!,
    );
    expect(JSON.stringify(projectedTransform.parameters)).not.toContain(CANARY_SECRET);
  });

  it("records file tool declarations and never merges an issue read into an issue update", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const read = toolCall({
      sessionId: "sess_files",
      callId: "call_read",
      toolName: "read",
      parameters: { path: CANARY_DRAFT, offset: 1, limit: 20 },
      sequence: 1,
    });
    const write = toolCall({
      sessionId: "sess_files",
      callId: "call_write",
      toolName: "write",
      parameters: { path: CANARY_NEXT, content: `${CANARY_NEW_TASKS}\n` },
      sequence: 2,
    });
    const edit = toolCall({
      sessionId: "sess_files",
      callId: "call_edit",
      toolName: "edit",
      parameters: {
        file_path: CANARY_NEXT,
        old_string: CANARY_OLD_TASKS,
        new_string: CANARY_NEW_TASKS,
      },
      sequence: 3,
    });

    const readCarrier = carrierOf(recorder.observe(read));
    const writeCarrier = carrierOf(recorder.observe(write));
    const editCarrier = carrierOf(recorder.observe(edit));
    expect(readCarrier).toMatchObject({
      operation: "file.read",
      reads: [{ kind: "file" }],
      writes: [],
    });
    expect(writeCarrier).toMatchObject({
      operation: "file.write",
      reads: [],
      writes: [{ kind: "file" }],
      contentKinds: ["markdown_checklist"],
    });
    expect(editCarrier).toMatchObject({
      operation: "file.transform",
      contentKinds: ["markdown_checklist"],
    });
    expect(editCarrier?.reads[0]?.ref).toBe(editCarrier?.writes[0]?.ref);
    expect(writeCarrier?.writes[0]?.ref).toBe(editCarrier?.writes[0]?.ref);
  });

  it("dedupes a command record by evidence event, and keeps independent executions", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const call = toolCall({
      sessionId: "sess_command",
      callId: "call_view",
      toolName: "bash",
      parameters: { command: VIEW_COMMAND },
      sequence: 1,
    });
    const paired = carrierOf(recorder.observe(call));
    expect(paired?.observation).toMatchObject({
      callId: call.callId,
      callEventId: call.eventId,
      status: "pending",
    });

    // A separate command record is a separate observed execution, even with identical text: it keeps
    // its own carrier and its own completion.
    const separate = commandExec({
      sessionId: "sess_command",
      command: VIEW_COMMAND,
      sequence: 2,
      exitCode: 0,
    });
    const separateObserved = recorder.observe(separate);
    expect(carrierOf(separateObserved)).toMatchObject({
      operation: "github.issue.read",
      observation: {
        callId: separate.eventId,
        callEventId: separate.eventId,
        resultEventId: separate.eventId,
        status: "success",
      },
    });

    // Re-observing the SAME event is idempotent by its evidence event id and consumes no ordinal.
    const replayed = recorder.observe(separate);
    expect(rawCarrierOf(replayed)).toEqual(rawCarrierOf(separateObserved));
    const control = new ToolLinkEvidenceRecorder();
    control.observe(call);
    const controlCarrier = carrierOf(control.observe(separate));
    expect(rawCarrierOf(replayed)).toEqual(controlCarrier);

    // A command record that observed a nonzero exit is a failure, not a skipped duplicate.
    const failing = commandExec({
      sessionId: "sess_command",
      command: `gh issue edit ${CANARY_ISSUE} --repo ${CANARY_REPO} --body-file ${CANARY_DRAFT}`,
      sequence: 4,
      exitCode: 1,
    });
    expect(carrierOf(recorder.observe(failing))).toMatchObject({
      operation: "github.issue.update",
      observation: { status: "failure" },
    });
  });

  it("scopes a relative path to the witnessed working directory, or omits it", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const viewHere = commandExec({
      sessionId: "sess_cwd",
      command: `gh issue view ${CANARY_ISSUE} --repo ${CANARY_REPO} > draft.md`,
      sequence: 1,
      cwd: "/work/a",
    });
    const editOther = commandExec({
      sessionId: "sess_cwd",
      command: `gh issue edit ${CANARY_ISSUE} --repo ${CANARY_REPO} --body-file draft.md`,
      sequence: 2,
      cwd: "/work/b",
    });
    const editHere = commandExec({
      sessionId: "sess_cwd",
      command: `gh issue edit ${CANARY_ISSUE} --repo ${CANARY_REPO} --body-file draft.md`,
      sequence: 3,
      cwd: "/work/a",
    });
    const viewCarrier = carrierOf(recorder.observe(viewHere));
    const otherCarrier = carrierOf(recorder.observe(editOther));
    const hereCarrier = carrierOf(recorder.observe(editHere));
    expect(viewCarrier?.writes[0]?.ref).toBeDefined();
    // Two same-spelled relative paths under different witnessed directories are different resources;
    // the same directory under the same spelling is the same resource.
    expect(otherCarrier?.reads[0]?.ref).not.toBe(viewCarrier?.writes[0]?.ref);
    expect(hereCarrier?.reads[0]?.ref).toBe(viewCarrier?.writes[0]?.ref);

    // Without a witnessed directory a relative path is unresolvable: nothing is claimed at all.
    const noCwd = commandExec({
      sessionId: "sess_cwd_unknown",
      command: `gh issue view ${CANARY_ISSUE} --repo ${CANARY_REPO} > draft.md`,
      sequence: 1,
    });
    expect(carrierOf(recorder.observe(noCwd))).toBeUndefined();
    const relativeRead = toolCall({
      sessionId: "sess_cwd_unknown",
      callId: "call_relative_read",
      toolName: "read",
      parameters: { path: "src/relative.md" },
      sequence: 2,
    });
    expect(carrierOf(recorder.observe(relativeRead))).toBeUndefined();
    const relativeScript = toolCall({
      sessionId: "sess_cwd_unknown",
      callId: "call_relative_script",
      toolName: "eval",
      parameters: {
        code: ["from pathlib import Path", "body = Path('relative-body.md').read_text()"].join(
          "\n",
        ),
        language: "py",
      },
      sequence: 3,
    });
    expect(carrierOf(recorder.observe(relativeScript))).toBeUndefined();
  });

  it("quarantines a call id that two unresolved calls claimed", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const first = toolCall({
      sessionId: "sess_duplicate_ids",
      callId: "call_shared",
      toolName: "eval",
      parameters: {
        code: "from pathlib import Path\nPath('/tmp/rtl-canary-scratch/first.md').read_text()",
        language: "py",
      },
      sequence: 1,
    });
    const second = toolCall({
      sessionId: "sess_duplicate_ids",
      callId: "call_shared",
      toolName: "eval",
      parameters: {
        code: "from pathlib import Path\nPath('/tmp/rtl-canary-scratch/second.md').read_text()",
        language: "py",
      },
      sequence: 2,
    });
    const firstCarrier = carrierOf(recorder.observe(first));
    expect(firstCarrier?.reads[0]?.ref).toBe("r0");
    // The replacement is refused outright, so no carrier attributes the second declaration.
    expect(carrierOf(recorder.observe(second))).toBeUndefined();

    // A late result for the id pairs with neither call.
    const late = toolResult({
      sessionId: "sess_duplicate_ids",
      callId: "call_shared",
      toolName: "eval",
      sequence: 3,
      result: [{ type: "text", text: "ok" }],
    });
    expect(carrierOf(recorder.observe(late))).toBeUndefined();

    // The id stays quarantined for the scope.
    const third = toolCall({
      sessionId: "sess_duplicate_ids",
      callId: "call_shared",
      toolName: "eval",
      parameters: {
        code: "from pathlib import Path\nPath('/tmp/rtl-canary-scratch/third.md').read_text()",
        language: "py",
      },
      sequence: 4,
    });
    expect(carrierOf(recorder.observe(third))).toBeUndefined();
  });

  it("keeps a call pending across an unfinished result and completes it once, terminally", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const call = toolCall({
      sessionId: "sess_unfinished",
      callId: "call_running",
      toolName: "eval",
      parameters: { code: transformSource(), language: "py" },
      sequence: 1,
    });
    const pendingObserved = recorder.observe(call);
    const pendingCarrier = carrierOf(pendingObserved);
    expect(pendingCarrier?.observation.status).toBe("pending");

    // The harness reports the execution as still running: that is not a completion, so no carrier is
    // attached to it (and the call is not completed).
    const running = toolResult({
      sessionId: "sess_unfinished",
      callId: "call_running",
      toolName: "eval",
      sequence: 2,
      isError: false,
      result: { status: "running", durationMs: 1, output: "job started" },
    });
    const runningObserved = recorder.observe(running);
    expect(carrierOf(runningObserved)).toBeUndefined();

    // The same unfinished observation replayed is idempotent: still nothing, and the call is still
    // open for a real completion.
    const runningReplay = recorder.observe(
      toolResult({
        sessionId: "sess_unfinished",
        callId: "call_running",
        toolName: "eval",
        sequence: 2,
        isError: false,
        result: { status: "running", durationMs: 1, output: "job started" },
      }),
    );
    expect(carrierOf(runningReplay)).toBeUndefined();

    // The terminal result of the SAME call completes it, with the refs the pending carrier announced.
    const terminal = toolResult({
      sessionId: "sess_unfinished",
      callId: "call_running",
      toolName: "eval",
      sequence: 3,
      isError: false,
      result: { status: "complete", exitCode: 0, output: "done" },
    });
    const completedObserved = recorder.observe(terminal);
    const completed = carrierOf(completedObserved);
    expect(completed).toMatchObject({
      operation: "file.transform",
      observation: {
        callId: call.callId,
        callEventId: call.eventId,
        resultEventId: terminal.eventId,
        status: "success",
      },
    });
    expect(completed?.reads[0]?.ref).toBe(pendingCarrier?.reads[0]?.ref);
    expect(completed?.writes[0]?.ref).toBe(pendingCarrier?.writes[0]?.ref);

    // The completion released the call: the earlier unfinished result cannot complete a second time.
    const afterCompletion = recorder.observe(
      toolResult({
        sessionId: "sess_unfinished",
        callId: "call_running",
        toolName: "eval",
        sequence: 4,
        isError: false,
        result: { status: "running", durationMs: 1, output: "job started" },
      }),
    );
    expect(carrierOf(afterCompletion)).toBeUndefined();

    const statuses = [
      pendingObserved,
      runningObserved,
      runningReplay,
      completedObserved,
      afterCompletion,
    ]
      .map((event) => carrierOf(event)?.observation.status)
      .filter((status) => status === "success");
    expect(statuses).toHaveLength(1);
  });

  it("refuses a Path constructor call that names more than one static part", () => {
    const recorder = new ToolLinkEvidenceRecorder();
    const scriptCall = (callId: string, code: string, sequence: number) =>
      toolCall({
        sessionId: "sess_multiarg_path",
        callId,
        toolName: "eval",
        parameters: { code, language: "py" },
        sequence,
      });

    const multiArgument = scriptCall(
      "call_multi",
      ["from pathlib import Path", "body = Path('dir', 'body.md').read_text()"].join("\n"),
      1,
    );
    expect(carrierOf(recorder.observe(multiArgument))).toBeUndefined();

    const adjacent = scriptCall(
      "call_adjacent",
      ["from pathlib import Path", "body = Path('dir/' 'body.md').read_text()"].join("\n"),
      2,
    );
    expect(carrierOf(recorder.observe(adjacent))).toBeUndefined();

    // Control: one literal is still resolved, and the write keeps its own single argument.
    const single = scriptCall(
      "call_single",
      [
        "from pathlib import Path",
        `body = Path('${CANARY_DRAFT}').read_text()`,
        `Path('${CANARY_NEXT}').write_text(body.strip(), encoding='utf-8')`,
      ].join("\n"),
      3,
    );
    expect(carrierOf(recorder.observe(single))).toMatchObject({ operation: "file.transform" });
  });
});
