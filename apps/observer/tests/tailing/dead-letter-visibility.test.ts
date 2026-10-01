import type { HarnessSession } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../../src/normalization/redaction.js";
import { ObserverCoordinator } from "../../src/tailing/coordinator.js";
import { type TailerDeadLetterBatch, TranscriptTailer } from "../../src/tailing/tailer.js";
import { FakeSessionEventSource } from "../fake-harness.js";

/**
 * A batch the capture handler fails is dead-lettered whole and the next acknowledged batch moves
 * the cursor past it, so those records are never captured. That loss is logged and counted.
 */
describe("dead-lettered capture batches", () => {
  it("are logged with session, count and error, never content, and counted in diagnostics", async () => {
    const tailer = new TranscriptTailer({ defaultBatchSize: 3 });
    const warn = vi.fn<(message: string, meta?: JsonObject) => void>();
    const coordinator = new ObserverCoordinator({ tailer, logger: { debug: vi.fn(), warn } });
    const session: HarnessSession = {
      sessionId: "session-dead-letter",
      workspaceId: "ws-1",
      harnessId: "codex-cli",
      transcriptPath: "/tmp/fake-dead-letter.jsonl",
      status: "active",
      startedAt: new Date().toISOString(),
    };
    const source = new FakeSessionEventSource(session.sessionId);
    coordinator.onRecords(async () => {
      throw new Error(
        "private value reference 'private:v2:demonstration:abc' already exists with different content or origin (different value or owner)",
      );
    });
    const deadLettered = Promise.withResolvers<TailerDeadLetterBatch>();
    tailer.once("deadLetter:batch", deadLettered.resolve);
    for (const secret of ["SECRET-ONE", "SECRET-TWO", "SECRET-THREE"]) {
      source.appendRecord({ item: secret });
    }
    await tailer.attachSession(session, source);
    const batch = await deadLettered.promise;

    expect(batch).toMatchObject({
      sessionId: session.sessionId,
      harnessId: "codex-cli",
      recordCount: 3,
      reason: "UNHANDLED_ERROR",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0]!;
    expect(message).toContain(session.sessionId);
    expect(meta).toMatchObject({
      sessionId: session.sessionId,
      harnessId: "codex-cli",
      recordCount: 3,
      reason: "UNHANDLED_ERROR",
      error: expect.stringContaining("already exists with different content"),
    });
    expect(JSON.stringify([message, meta])).not.toContain("SECRET");
    expect(coordinator.getDiagnostics()).toMatchObject({
      deadLetteredBatches: 1,
      deadLetteredRecords: 3,
    });
    await coordinator.stop();
  });
});
