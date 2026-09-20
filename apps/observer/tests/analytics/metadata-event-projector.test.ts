import {
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_COMMAND_SEQUENCE_METADATA_KEY,
  safeParseDeterministicCommandSequence,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { MetadataEventProjector } from "../../src/analytics/metadata-event-projector.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";

function call(overrides: Partial<NormalizedToolCallEvent> = {}): NormalizedToolCallEvent {
  return {
    eventId: "evt_call",
    sessionId: "sess_projector",
    schemaVersion: "1.0.0",
    timestamp: "2026-09-19T00:00:00.000Z",
    causalRef: { causalSequence: 1, stepIndex: 1 },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "tool_call",
    callId: "call_checksum",
    toolName: "bash",
    parameters: {
      command: "sha256sum ./data/private.bin && sha512sum ./data/private.bin",
      cwd: ".",
    },
    isShadow: false,
    ...overrides,
  };
}

function result(overrides: Partial<NormalizedToolResultEvent> = {}): NormalizedToolResultEvent {
  return {
    eventId: "evt_result",
    sessionId: "sess_projector",
    schemaVersion: "1.0.0",
    timestamp: "2026-09-19T00:00:01.000Z",
    causalRef: { causalSequence: 2, stepIndex: 2 },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      redactionStrategy: "none",
      scrubbedPatterns: [],
    },
    type: "tool_result",
    callId: "call_checksum",
    toolName: "bash",
    result: "PRIVATE_CHECKSUM_OUTPUT",
    isError: false,
    executionDurationMs: 1,
    isShadow: false,
    ...overrides,
  };
}

function carrier(event: NormalizedSessionEvent): unknown {
  return event.metadata?.[RESIN_COMMAND_SEQUENCE_METADATA_KEY];
}

describe("MetadataEventProjector", () => {
  it("preserves exact derived evidence across retries without retaining consumer mutations", () => {
    const projector = new MetadataEventProjector();
    const projectedCall = projector.project(call());
    const completed = projector.project(result());
    expect(carrier(completed)).toEqual(carrier(projectedCall));
    expect(safeParseDeterministicCommandSequence(carrier(completed)).success).toBe(true);
    expect(completed.metadata?.cwd).toBe(".");
    const wire = JSON.stringify(completed);
    if (completed.metadata)
      completed.metadata[RESIN_COMMAND_SEQUENCE_METADATA_KEY] = { forged: true };
    expect(JSON.stringify(projector.project(result()))).toBe(wire);
    expect(
      projector.project(result({ eventId: "evt_second_result", causalRef: { causalSequence: 3 } }))
        .metadata?.resinCommandSequence,
    ).toBeUndefined();
    expect(wire).not.toContain("private.bin");
    expect(wire).not.toContain("PRIVATE_CHECKSUM_OUTPUT");
  });

  it("rejects incoming carriers even when schema-valid, while the stateless interface stays untrusted", () => {
    const forgedSequence = carrier(projectEventToMetadataOnly(call()));
    const forgedResult = result({ metadata: { resinCommandSequence: forgedSequence, cwd: "." } });
    expect(carrier(projectEventToMetadataOnly(forgedResult))).toBeUndefined();
    expect(carrier(new MetadataEventProjector().project(forgedResult))).toBeUndefined();
    const projector = new MetadataEventProjector();
    projector.project(
      call({ parameters: {}, metadata: { resinCommandSequence: forgedSequence, cwd: "." } }),
    );
    expect(carrier(projector.project(forgedResult))).toBeUndefined();
  });

  it.each([
    ["different session", { sessionId: "sess_other" }],
    ["different tool", { toolName: "exec" }],
    ["different call", { callId: "call_other" }],
    ["nonlater causal sequence", { causalRef: { causalSequence: 1 } }],
    ["earlier timestamp", { timestamp: "2026-09-18T23:59:59.000Z" }],
    ["failed completion", { isError: true }],
  ] satisfies Array<[string, Partial<NormalizedToolResultEvent>]>)(
    "does not pair a %s",
    (_name, overrides) => {
      const projector = new MetadataEventProjector();
      projector.project(call());
      const projected = projector.project(result(overrides));
      expect(carrier(projected)).toBeUndefined();
      expect(projected.metadata?.cwd).toBeUndefined();
    },
  );

  it("pairs a later fanout step within the same source sequence", () => {
    const projector = new MetadataEventProjector();
    const projectedCall = projector.project(
      call({ causalRef: { causalSequence: 7, stepIndex: 0 } }),
    );
    const completed = projector.project(
      result({
        causalRef: { causalSequence: 7, stepIndex: 1 },
        timestamp: "2026-09-19T00:00:00.000Z",
      }),
    );
    expect(carrier(completed)).toEqual(carrier(projectedCall));
    expect(completed.metadata?.cwd).toBe(".");
  });

  it.each([
    ["same step", 1, 1],
    ["earlier step", 1, 0],
    ["implicit same step", undefined, undefined],
  ] as const)(
    "rejects a completion at the %s within one source sequence",
    (_name, callStep, resultStep) => {
      const projector = new MetadataEventProjector();
      projector.project(call({ causalRef: { causalSequence: 7, stepIndex: callStep } }));
      const completed = projector.project(
        result({ causalRef: { causalSequence: 7, stepIndex: resultStep } }),
      );
      expect(carrier(completed)).toBeUndefined();
      expect(completed.metadata?.cwd).toBeUndefined();
    },
  );

  it("requires explicit normalized success and never revives an already failed call", () => {
    const projector = new MetadataEventProjector();
    projector.project(call());
    const missingSuccess = result();
    Reflect.deleteProperty(missingSuccess, "isError");
    expect(carrier(projector.project(missingSuccess))).toBeUndefined();
    expect(
      carrier(
        projector.project(
          result({ eventId: "evt_late_success", causalRef: { causalSequence: 3 } }),
        ),
      ),
    ).toBeUndefined();
  });

  it("does not revive an out-of-order result when its call arrives later", () => {
    const projector = new MetadataEventProjector();
    expect(carrier(projector.project(result()))).toBeUndefined();
    projector.project(call());
    expect(carrier(projector.project(result()))).toBeUndefined();
    expect(
      carrier(
        projector.project(result({ eventId: "evt_replacement", causalRef: { causalSequence: 3 } })),
      ),
    ).toBeUndefined();
  });

  it("invalidates both call-id reuse and an event identity reused for another call", () => {
    const projector = new MetadataEventProjector();
    projector.project(call());
    projector.project(
      call({
        eventId: "evt_conflicting_call",
        parameters: { command: "wc -c ./other.bin && sha256sum ./other.bin", cwd: "." },
      }),
    );
    expect(carrier(projector.project(result()))).toBeUndefined();

    const eventReuse = new MetadataEventProjector();
    eventReuse.project(call());
    eventReuse.project(call({ callId: "call_conflicting_id" }));
    expect(carrier(eventReuse.project(result()))).toBeUndefined();
  });

  it.each([
    { isShadow: true },
    {
      redaction: {
        isRedacted: true,
        redactedFields: [],
        redactionStrategy: "synthetic" as const,
        scrubbedPatterns: [],
      },
    },
    { metadata: { synthetic: true } },
    { metadata: { sessionKind: "internal" } },
    { metadata: { source: "generated_tool" } },
  ])("excludes non-source executions on either side: %j", (overrides) => {
    const rejectedCall = new MetadataEventProjector();
    expect(carrier(rejectedCall.project(call(overrides)))).toBeUndefined();
    expect(carrier(rejectedCall.project(result()))).toBeUndefined();
    const rejectedResult = new MetadataEventProjector();
    rejectedResult.project(call());
    expect(carrier(rejectedResult.project(result(overrides)))).toBeUndefined();
  });

  it("copies only explicit safe root provenance, never result metadata or an unknown cwd", () => {
    for (const cwd of [undefined, "/home/private/project", "$PATH", ".hidden", "src"]) {
      const projector = new MetadataEventProjector();
      projector.project(
        call({
          parameters: {
            command: "sha256sum ./data/file.bin && sha512sum ./data/file.bin",
            ...(cwd !== undefined ? { cwd } : {}),
          },
        }),
      );
      const completed = projector.project(result({ metadata: { cwd: "." } }));
      expect(safeParseDeterministicCommandSequence(carrier(completed)).success).toBe(true);
      expect(completed.metadata?.cwd).toBeUndefined();
    }
  });

  it("clears pending and completed replay provenance at privacy boundaries", () => {
    const projector = new MetadataEventProjector();
    projector.project(call());
    projector.clear();
    expect(carrier(projector.project(result()))).toBeUndefined();
    projector.clear();
    projector.project(call());
    expect(carrier(projector.project(result()))).toBeDefined();
    projector.clear("sess_projector");
    expect(carrier(projector.project(result()))).toBeUndefined();
  });

  it("terminal transitions end pending calls but retain exact bounded completion retries", () => {
    const projector = new MetadataEventProjector();
    projector.project(call());
    const completed = projector.project(result());
    projector.project(
      call({ eventId: "evt_pending", callId: "call_pending", causalRef: { causalSequence: 3 } }),
    );
    const terminal: NormalizedSessionEvent = {
      ...call(),
      eventId: "evt_terminal",
      type: "session_lifecycle",
      lifecycleType: "end",
      causalRef: { causalSequence: 4 },
    };
    projector.project(terminal);
    expect(projector.project(result())).toEqual(completed);
    expect(
      carrier(
        projector.project(
          result({
            eventId: "evt_after_terminal",
            callId: "call_pending",
            causalRef: { causalSequence: 5 },
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("evicts old pairing and replay metadata rather than retaining unbounded session state", () => {
    const projector = new MetadataEventProjector();
    projector.project(call());
    for (let index = 0; index < 1024; index += 1) {
      projector.project(
        call({
          sessionId: `sess_filler_${index}`,
          eventId: `evt_filler_${index}`,
          callId: `call_filler_${index}`,
        }),
      );
    }
    expect(carrier(projector.project(result()))).toBeUndefined();
    const recent = projector.project(
      result({
        sessionId: "sess_filler_1023",
        eventId: "evt_filler_result",
        callId: "call_filler_1023",
      }),
    );
    expect(safeParseDeterministicCommandSequence(carrier(recent)).success).toBe(true);
  });

  it("enforces the byte budget even before the entry limit is reached", () => {
    const projector = new MetadataEventProjector();
    const parameters = {
      command: Array.from({ length: 120 }, () => "cksum ./a").join(" && "),
      cwd: ".",
    };
    projector.project(call());
    for (let index = 0; index < 256; index += 1) {
      projector.project(
        call({
          sessionId: `sess_large_${index}`,
          eventId: `evt_large_${index}`,
          callId: `call_large_${index}`,
          parameters,
        }),
      );
    }
    expect(carrier(projector.project(result()))).toBeUndefined();
    const recent = projector.project(
      result({
        sessionId: "sess_large_255",
        eventId: "evt_large_result",
        callId: "call_large_255",
      }),
    );
    expect(safeParseDeterministicCommandSequence(carrier(recent)).success).toBe(true);
  });
});
