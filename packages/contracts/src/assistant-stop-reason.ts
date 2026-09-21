import { z } from "zod";

/** Metadata key carrying a source-observed assistant completion reason. */
export const RESIN_ASSISTANT_STOP_REASON_METADATA_KEY = "stopReason" as const;

/**
 * Provider stop reasons that explicitly complete an assistant turn. Tool-use, truncation, error and
 * unknown reasons are deliberately absent: only these bounded values may influence settlement.
 */
export const ASSISTANT_STOP_REASONS = ["stop", "end_turn", "completed"] as const;

export const AssistantStopReasonSchema = z.enum(ASSISTANT_STOP_REASONS);
export type AssistantStopReason = z.infer<typeof AssistantStopReasonSchema>;

/**
 * Canonicalizes a source or correction value onto the small successful-turn vocabulary. Unknown,
 * empty and non-string values fail closed. The returned value is safe to retain in metadata.
 */
export function parseAssistantStopReason(value: unknown): AssistantStopReason | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = AssistantStopReasonSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

/**
 * Correction transport envelope. Cloud correction entities require record-shaped metadata, while
 * projected event metadata carries the reason itself under `metadata.stopReason`.
 */
export const AssistantStopReasonCorrectionSchema = z
  .object({ stopReason: AssistantStopReasonSchema })
  .strict();
export type AssistantStopReasonCorrection = z.infer<typeof AssistantStopReasonCorrectionSchema>;

export function readAssistantStopReasonCorrection(
  value: unknown,
): AssistantStopReasonCorrection | undefined {
  const parsed = AssistantStopReasonCorrectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
