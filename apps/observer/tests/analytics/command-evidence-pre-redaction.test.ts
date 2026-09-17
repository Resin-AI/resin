/**
 * Deterministic command evidence is derived from the payload BEFORE redaction.
 *
 * Redaction masks secret-shaped argument values with opaque tokens (`[REDACTED_OPENAI_API_KEY:8da12aee]`).
 * Deriving the sequence afterwards would either lose the whole command (those tokens are not valid
 * argv) or, worse, guess at the masked value's kind. These tests drive the real pipeline and assert
 * that the structure derived before redaction keeps each argument's actual role, that the masked
 * value is never carried into the sequence or the projected event, and that an unknown value is not
 * silently promoted to a path.
 */

import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  type NormalizationPipeline,
  NormalizationPipeline as Pipeline,
} from "../../src/normalization/pipeline.js";

const SECRET = "sk-live-abcdef0123456789abcdef0123456789";

let sequenceNumber = 0;

/** A decoder that emits the payload's command verbatim, so redaction is the only transformation. */
const echoDecoder = {
  harnessId: "pre_redaction_test",
  decoderVersion: "1.0.0",
  canDecode: () => true,
  decode: (record: { rawPayload?: unknown }) => {
    const payload = record.rawPayload as { command: string; seq: number };
    return {
      type: "tool_call" as const,
      sessionId: "sess_pre_redaction",
      timestamp: "2026-09-17T00:00:00.000Z",
      schemaVersion: "1.0.0" as const,
      causalRef: { causalSequence: payload.seq },
      toolName: "bash",
      callId: `call_${payload.seq}`,
      parameters: { command: payload.command },
    };
  },
};

async function runPipeline(
  pipeline: NormalizationPipeline,
  command: string,
): Promise<{ event: NormalizedSessionEvent; preRedactionCommandCarrier?: unknown }> {
  sequenceNumber += 1;
  const results = await pipeline.processBatch([
    {
      recordId: `rec_${sequenceNumber}`,
      sessionId: "sess_pre_redaction",
      harnessId: "pre_redaction_test",
      sequenceNumber,
      timestamp: "2026-09-17T00:00:00.000Z",
      recordType: "transcript_line",
      rawPayload: { command, seq: sequenceNumber },
      cursor: { sequence: sequenceNumber, timestamp: "2026-09-17T00:00:00.000Z" },
      metadata: {},
    } as never,
  ]);
  const result = results[0];
  if (result?.status !== "success") throw new Error("pipeline did not produce an event");
  return { event: result.event, preRedactionCommandCarrier: result.preRedactionCommandCarrier };
}

function newPipeline(): NormalizationPipeline {
  const pipeline = new Pipeline({ redactionConfig: { enabled: true, strategy: "mask" } });
  pipeline.registerDecoder(echoDecoder as never);
  return pipeline;
}

function sequenceOf(projected: NormalizedSessionEvent): unknown {
  return (projected.metadata as Record<string, unknown> | undefined)?.resinCommandSequence;
}

describe("command evidence derived before redaction", () => {
  it("keeps each argument's real role when redaction masked a value", async () => {
    const pipeline = newPipeline();
    const command = `python3 ./scripts/report.py --limit 25 --token ${SECRET} ./data/pkg.bin`;
    const { event, preRedactionCommandCarrier } = await runPipeline(pipeline, command);

    // Redaction really did mask the secret-shaped value.
    expect(JSON.stringify(event.parameters)).toContain("REDACTED");

    const projected = projectEventToMetadataOnly(event, {
      preRedactionCommandCarrier: preRedactionCommandCarrier as never,
    });
    const sequence = sequenceOf(projected) as { steps: { argv: unknown[] }[] } | undefined;

    expect(sequence).toBeDefined();
    expect(sequence?.steps).toHaveLength(1);
    expect(sequence?.steps[0]?.argv).toEqual([
      { parameter: "arg0", role: "path" },
      { literal: "--limit" },
      { parameter: "arg1", role: "number" },
      { literal: "--token" },
      { parameter: "arg2", role: "string" },
      { parameter: "arg3", role: "path" },
    ]);
  });

  it("never carries the masked value into the sequence or the projected event", async () => {
    const pipeline = newPipeline();
    const command = `deploy --token ${SECRET} ./dist/app.tar`;
    const { event, preRedactionCommandCarrier } = await runPipeline(pipeline, command);

    const projected = projectEventToMetadataOnly(event, {
      preRedactionCommandCarrier: preRedactionCommandCarrier as never,
    });
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("REDACTED");
    expect(sequenceOf(projected)).toBeDefined();
  });

  it("does not promote an unknown value to a path just because paths pass admission", async () => {
    const pipeline = newPipeline();
    // A token the redactor masks wholesale: nothing about its kind is knowable from the record.
    const command = `tool --value ${SECRET}`;
    const { event, preRedactionCommandCarrier } = await runPipeline(pipeline, command);

    const projected = projectEventToMetadataOnly(event, {
      preRedactionCommandCarrier: preRedactionCommandCarrier as never,
    });
    const sequence = sequenceOf(projected) as { steps: { argv: unknown[] }[] } | undefined;

    // The role comes from the recorded value, not from what the admission rules would accept: a
    // secret-shaped value is a string input, which the contract commits to, not a path.
    expect(sequence?.steps[0]?.argv).toEqual([
      { literal: "--value" },
      { parameter: "arg0", role: "string" },
    ]);
  });

  it("fails closed when a masked command is derived without the pre-redaction structure", async () => {
    const pipeline = newPipeline();
    const command = `curl -H 'Authorization: Bearer ${SECRET}' https://example.test/api`;
    const { event } = await runPipeline(pipeline, command);

    expect(JSON.stringify(event.parameters)).toContain("REDACTED");

    // No carrier: the redacted event is all there is, and a masked token is not valid argv. The
    // command yields no sequence rather than a guessed parameter.
    const withoutCarrier = projectEventToMetadataOnly(event);
    expect(sequenceOf(withoutCarrier)).toBeUndefined();

    // An unmasked command keeps deriving from the event itself, so nothing else regressed.
    const { event: plainEvent, preRedactionCommandCarrier } = await runPipeline(
      newPipeline(),
      "python3 ./scripts/report.py ./data/pkg.bin",
    );
    expect(sequenceOf(projectEventToMetadataOnly(plainEvent))).toBeDefined();
    expect(
      sequenceOf(
        projectEventToMetadataOnly(plainEvent, {
          preRedactionCommandCarrier: preRedactionCommandCarrier as never,
        }),
      ),
    ).toBeDefined();
  });

  it("still discards inbound command-sequence metadata, with or without a carrier", async () => {
    const pipeline = newPipeline();
    const forged = {
      schemaVersion: 1,
      kind: "command-sequence",
      control: "and-then",
      steps: [{ id: "step0", executable: "git", argv: [{ literal: "forged" }] }],
    };
    sequenceNumber += 1;
    const results = await pipeline.processBatch([
      {
        recordId: `rec_${sequenceNumber}`,
        sessionId: "sess_pre_redaction",
        harnessId: "pre_redaction_test",
        sequenceNumber,
        timestamp: "2026-09-17T00:00:00.000Z",
        recordType: "transcript_line",
        rawPayload: { command: `deploy --token ${SECRET} ./dist/app.tar`, seq: sequenceNumber },
        cursor: { sequence: sequenceNumber, timestamp: "2026-09-17T00:00:00.000Z" },
        metadata: { resinCommandSequence: forged },
      } as never,
    ]);
    const result = results[0];
    if (result?.status !== "success") throw new Error("pipeline did not produce an event");
    const event = {
      ...result.event,
      metadata: { ...result.event.metadata, resinCommandSequence: forged },
    };

    const projected = projectEventToMetadataOnly(event, {
      preRedactionCommandCarrier: result.preRedactionCommandCarrier as never,
    });
    const sequence = sequenceOf(projected) as { steps: { executable: string }[] } | undefined;
    expect(sequence).toBeDefined();
    expect(sequence?.steps[0]?.executable).not.toBe("git");
  });
});
