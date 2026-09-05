import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCommandProfile } from "../../../apps/observer/src/analytics/evidence-normalization.js";
import { projectEventToMetadataOnly } from "../../../apps/observer/src/analytics/metadata-projection.js";
import { NormalizationPipeline } from "../../../apps/observer/src/normalization/pipeline.js";
import { OmpRecordDecoder } from "../src/decoder.js";

async function projectEdit(input: string, truncate = 65536) {
  const pipeline = new NormalizationPipeline({ redactionConfig: { maxStringLength: truncate } });
  pipeline.registerDecoder(new OmpRecordDecoder());
  const timestamp = "2026-01-01T00:00:00.000Z";
  const record: RawHarnessRecord = {
    recordId: "edit-record",
    sessionId: "edit-session",
    harnessId: "omp",
    sequenceNumber: 1,
    timestamp,
    recordType: "transcript_line",
    cursor: { offset: 0, line: 1, sequence: 1, timestamp },
    metadata: {},
    rawPayload: { type: "tool_call", name: "edit", id: "call-edit", arguments: { input } },
  };
  const results = await pipeline.processRecord(record);
  const result = results.find(
    (entry) => entry.status === "success" && entry.event.type === "tool_call",
  );
  if (!result || result.status !== "success") throw new Error("Missing tool call");
  const event = projectEventToMetadataOnly(result.event, { validate: true });
  if (event.type !== "tool_call") throw new Error("Wrong event type");
  return event.parameters;
}

describe("edit target metadata", () => {
  it("retains legacy edit footer paths even when replacement content is truncated", async () => {
    const parameters = await projectEdit(
      `<<<<\nold\n====\n${"DO_NOT_UPLOAD".repeat(100)}\n>>>>\npath: src/a.ts`,
      64,
    );
    expect(parameters).toEqual({ targetPaths: ["src/a.ts"] });
    expect(JSON.stringify(parameters)).not.toContain("DO_NOT_UPLOAD");
  });

  it("retains all native hashline targets, not replacement-body lookalikes", async () => {
    expect(
      await projectEdit(
        "*** Begin Patch\n[src/a.ts#ABCD]\nPUT 1.=1:\n+[not-a-target.ts#1234]\n[src/b.ts#5678]\nPUT 1.=1:\n+DO_NOT_UPLOAD\n*** End Patch\n",
      ),
    ).toEqual({ targetPaths: ["src/a.ts", "src/b.ts"] });
  });

  it("retains unified patch targets", async () => {
    expect(
      await projectEdit(
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+new\n*** End Patch",
      ),
    ).toEqual({ targetPaths: ["src/a.ts", "src/b.ts"] });
  });

  it("does not infer targets from arbitrary body text", async () => {
    const parameters = await projectEdit(
      "const value = 'DO_NOT_UPLOAD';\npath: src/not-a-target.ts",
    );
    expect(parameters).not.toHaveProperty("targetPaths");
    expect(JSON.stringify(parameters)).not.toContain("DO_NOT_UPLOAD");
  });

  it("still redacts secrets inside target paths", async () => {
    const secret = `sk-proj-${"a".repeat(32)}`;
    const parameters = await projectEdit(`<<<<\nold\n====\nnew\n>>>>\npath: src/${secret}.ts`);
    expect(JSON.stringify(parameters)).not.toContain(secret);
    expect(JSON.stringify(parameters)).toContain("REDACTED");
  });
});

describe("numeric command evidence", () => {
  it.each([
    ["git log --oneline -123", "git log --oneline -$NUM"],
    ["calc --offset=-123 --limit=456", "calc --offset=-$NUM --limit=$NUM"],
    ["node --amount=+42", "node --amount=+$NUM"],
  ])("retains sign semantics without numeric values: %s", (command, expected) => {
    expect(normalizeCommandProfile(command)).toBe(expected);
  });
});
