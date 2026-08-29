import type {
  ContextNudgeSupport,
  McpListChangeSupport,
  ObservationFidelity,
  SubagentVisibility,
  TranscriptAvailability,
  VisibilityLevel,
} from "./types.js";

/**
 * Weights for calculating overall observation fidelity score (0 - 100).
 */
const FIDELITY_WEIGHTS = {
  transcriptAvailability: {
    none: 0,
    polling: 10,
    file_tail: 20,
    stream: 25,
    websocket: 25,
  } satisfies Record<TranscriptAvailability, number>,
  toolCallVisibility: {
    none: 0,
    partial: 10,
    sanitized: 15,
    full: 20,
  } satisfies Record<VisibilityLevel, number>,
  toolResultVisibility: {
    none: 0,
    partial: 10,
    sanitized: 15,
    full: 20,
  } satisfies Record<VisibilityLevel, number>,
  subagentVisibility: {
    none: 0,
    shallow: 10,
    full: 15,
  } satisfies Record<SubagentVisibility, number>,
  mcpListChange: {
    unsupported: 0,
    requires_restart: 5,
    supported: 10,
  } satisfies Record<McpListChangeSupport, number>,
  contextNudge: {
    unsupported: 0,
    via_file: 5,
    via_prompt: 8,
    supported: 10,
  } satisfies Record<ContextNudgeSupport, number>,
};

/**
 * Computes an overall fidelity score (0-100) based on weighted observation characteristics.
 */
export function calculateFidelityScore(
  components: Omit<ObservationFidelity, "overallScore" | "notes">,
): number {
  const transcriptScore =
    FIDELITY_WEIGHTS.transcriptAvailability[components.transcriptAvailability] ?? 0;
  const callScore = FIDELITY_WEIGHTS.toolCallVisibility[components.toolCallVisibility] ?? 0;
  const resultScore = FIDELITY_WEIGHTS.toolResultVisibility[components.toolResultVisibility] ?? 0;
  const subagentScore = FIDELITY_WEIGHTS.subagentVisibility[components.subagentVisibility] ?? 0;
  const listChangeScore = FIDELITY_WEIGHTS.mcpListChange[components.mcpListChange] ?? 0;
  const nudgeScore = FIDELITY_WEIGHTS.contextNudge[components.contextNudge] ?? 0;

  const total =
    transcriptScore + callScore + resultScore + subagentScore + listChangeScore + nudgeScore;
  return Math.min(100, Math.max(0, total));
}

/**
 * Constructs a complete ObservationFidelity descriptor, computing the overall score automatically.
 */
export function createObservationFidelity(
  components: Omit<ObservationFidelity, "overallScore"> & { overallScore?: number },
): ObservationFidelity {
  const computedScore = components.overallScore ?? calculateFidelityScore(components);
  return {
    transcriptAvailability: components.transcriptAvailability,
    toolCallVisibility: components.toolCallVisibility,
    toolResultVisibility: components.toolResultVisibility,
    subagentVisibility: components.subagentVisibility,
    mcpListChange: components.mcpListChange,
    contextNudge: components.contextNudge,
    overallScore: computedScore,
    notes: components.notes,
  };
}

/**
 * Standard Tier-1 High Fidelity preset (e.g. Oh My Pi with native streaming and full visibility).
 */
export const TIER1_HIGH_FIDELITY: ObservationFidelity = Object.freeze({
  transcriptAvailability: "stream",
  toolCallVisibility: "full",
  toolResultVisibility: "full",
  subagentVisibility: "full",
  mcpListChange: "supported",
  contextNudge: "supported",
  overallScore: 100,
  notes:
    "Full real-time streaming, bi-directional tool invocation inspection, subagent visibility, dynamic catalog reload.",
});

/**
 * Standard Tier-2 Medium Fidelity preset (e.g. Claude Code with JSON log tailing and context nudge).
 */
export const TIER2_MEDIUM_FIDELITY: ObservationFidelity = Object.freeze({
  transcriptAvailability: "file_tail",
  toolCallVisibility: "full",
  toolResultVisibility: "full",
  subagentVisibility: "shallow",
  mcpListChange: "unsupported",
  contextNudge: "via_prompt",
  overallScore: 78,
  notes:
    "Session log file tailing, full tool call capture, shallow subagent visibility, prompt-based context injection.",
});

/**
 * Standard Tier-3 Low Fidelity preset (e.g. Codex CLI or minimal CLI harnesses).
 */
export const TIER3_LOW_FIDELITY: ObservationFidelity = Object.freeze({
  transcriptAvailability: "polling",
  toolCallVisibility: "partial",
  toolResultVisibility: "partial",
  subagentVisibility: "none",
  mcpListChange: "requires_restart",
  contextNudge: "unsupported",
  overallScore: 35,
  notes: "Periodic polling, partial tool visibility, session restart required for catalog updates.",
});
