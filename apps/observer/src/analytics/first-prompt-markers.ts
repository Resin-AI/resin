import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ensurePrivateDirectorySync } from "../private-fs.js";

/** File under the Resin state dir holding each session's first-prompt marker (local only). */
export const LISTING_FOOTPRINT_FIRST_PROMPTS_FILE_NAME = "listing-footprint-first-prompts.json";

/** Markers last written longer ago than this are dropped on the next write. */
const MARKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const MarkerSchema = z.object({
  causalSequence: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  seenAt: z.string().datetime({ offset: true }),
});

const MarkerFileSchema = z.object({
  version: z.literal(1),
  sessions: z.record(MarkerSchema),
});

type Marker = z.infer<typeof MarkerSchema>;

/**
 * Remembers, per session, the causal position of its first user prompt, so the prompt that carries
 * the listing footprint is the same one across restarts and re-reads of unacknowledged batches.
 * Holds only session ids, causal positions and when each was recorded; never uploaded. Loaded once,
 * written atomically (owner-only temporary file, then rename) whenever a marker changes.
 */
export class FirstPromptMarkers {
  private readonly filePath: string;
  private readonly now: () => number;
  /** Undefined until loaded; null when the file exists but cannot be read (all prompts unknown). */
  private sessions: Record<string, Marker> | null | undefined;

  constructor(options: { filePath: string; now?: () => number }) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether the prompt at `position` is the session's first, recording it when it is. A prompt
   * before the recorded one (delivered out of order) replaces it. False when a prompt earlier than
   * this one is recorded, or when the marker cannot be read or written (the answer is unknown).
   */
  isFirstPrompt(
    sessionId: string,
    position: { causalSequence: number; stepIndex: number },
  ): boolean {
    const sessions = this.load();
    if (sessions === null) return false;
    const marker = sessions[sessionId];
    if (marker !== undefined) {
      if (
        marker.causalSequence === position.causalSequence &&
        marker.stepIndex === position.stepIndex
      ) {
        return true;
      }
      const markerIsEarlier =
        marker.causalSequence < position.causalSequence ||
        (marker.causalSequence === position.causalSequence &&
          marker.stepIndex < position.stepIndex);
      if (markerIsEarlier) return false;
    }
    const nowMs = this.now();
    const next: Record<string, Marker> = {};
    for (const [id, entry] of Object.entries(sessions)) {
      if (nowMs - Date.parse(entry.seenAt) <= MARKER_RETENTION_MS) next[id] = entry;
    }
    next[sessionId] = { ...position, seenAt: new Date(nowMs).toISOString() };
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      ensurePrivateDirectorySync(path.dirname(this.filePath));
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, sessions: next })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.filePath);
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      return false;
    }
    this.sessions = next;
    return true;
  }

  private load(): Record<string, Marker> | null {
    if (this.sessions !== undefined) return this.sessions;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      this.sessions = (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
      return this.sessions;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // An unrecognized file is replaced on the next write rather than disabling capture for good.
    this.sessions = MarkerFileSchema.safeParse(parsed).data?.sessions ?? {};
    return this.sessions;
  }
}
