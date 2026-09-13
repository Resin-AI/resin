import { ComputationProgramV1Schema, computeComputationProgramDigest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { parseJavaScriptComputation } from "../../../src/analytics/computation/javascript.js";

function timestampProgram(value: string, method = "toISOString") {
  return parseJavaScriptComputation(
    `function formatTimestamp(value) {
      const date = new Date(value);
      return date.${method}();
    }
    console.log(formatTimestamp(${JSON.stringify(value)}));`,
  ).program;
}

describe("native JavaScript timestamp formatting", () => {
  it("represents ISO formatting as a distinct finite API with its receiver", () => {
    const program = timestampProgram("2026-01-01T00:00:00.000Z");
    expect(ComputationProgramV1Schema.safeParse(program).success).toBe(true);
    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    const formatting = program.nodes.find(
      (node) => node.kind === "call" && node.api === "clock.iso_format",
    );
    expect(formatting).toMatchObject({ kind: "call", api: "clock.iso_format" });
    expect(formatting).toHaveProperty("receiver");
  });

  it("keeps timestamp values private and canonicalizes value-only changes", () => {
    const first = timestampProgram("2026-01-01T00:00:00.000Z");
    const second = timestampProgram("2027-08-09T10:11:12.000Z");
    expect(JSON.stringify(first)).not.toContain("2026-01-01");
    expect(JSON.stringify(second)).not.toContain("2027-08-09");
    expect(computeComputationProgramDigest(first)).toBe(computeComputationProgramDigest(second));
  });

  it("does not conflate ISO formatting with timestamp parsing", () => {
    const iso = timestampProgram("2026-01-01T00:00:00.000Z");
    const parsed = parseJavaScriptComputation(
      'function parseTimestamp(value) { return Date.parse(value); } console.log(parseTimestamp("2026-01-01T00:00:00.000Z"));',
    ).program;
    expect(parsed.complete).toBe(true);
    expect(computeComputationProgramDigest(iso)).not.toBe(computeComputationProgramDigest(parsed));
  });

  it("continues to reject an unknown timestamp formatter", () => {
    const program = timestampProgram("2026-01-01T00:00:00.000Z", "formatPrivateTimestamp");
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_api");
  });
});
