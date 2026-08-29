import { describe, expect, it } from "vitest";
import {
  TIER1_HIGH_FIDELITY,
  TIER2_MEDIUM_FIDELITY,
  TIER3_LOW_FIDELITY,
  calculateFidelityScore,
  createObservationFidelity,
} from "../src/fidelity.js";
import { ObservationFidelitySchema } from "../src/types.js";

describe("Observation Fidelity Scoring & Presets", () => {
  it("calculates fidelity score accurately based on components", () => {
    // Maximum fidelity components
    const maxScore = calculateFidelityScore({
      transcriptAvailability: "stream", // 25
      toolCallVisibility: "full", // 20
      toolResultVisibility: "full", // 20
      subagentVisibility: "full", // 15
      mcpListChange: "supported", // 10
      contextNudge: "supported", // 10
    });
    expect(maxScore).toBe(100);

    // Minimum fidelity components
    const minScore = calculateFidelityScore({
      transcriptAvailability: "none",
      toolCallVisibility: "none",
      toolResultVisibility: "none",
      subagentVisibility: "none",
      mcpListChange: "unsupported",
      contextNudge: "unsupported",
    });
    expect(minScore).toBe(0);
  });

  it("constructs complete ObservationFidelity descriptor", () => {
    const desc = createObservationFidelity({
      transcriptAvailability: "file_tail",
      toolCallVisibility: "sanitized",
      toolResultVisibility: "partial",
      subagentVisibility: "shallow",
      mcpListChange: "requires_restart",
      contextNudge: "via_prompt",
      notes: "Custom setup",
    });

    expect(desc.overallScore).toBeGreaterThan(0);
    expect(desc.overallScore).toBeLessThan(100);
    expect(ObservationFidelitySchema.parse(desc)).toEqual(desc);
  });

  it("exports valid standard fidelity presets", () => {
    expect(ObservationFidelitySchema.parse(TIER1_HIGH_FIDELITY).overallScore).toBe(100);
    expect(ObservationFidelitySchema.parse(TIER2_MEDIUM_FIDELITY).overallScore).toBe(78);
    expect(ObservationFidelitySchema.parse(TIER3_LOW_FIDELITY).overallScore).toBe(35);
  });
});
