import {
  type NormalizedSessionEvent,
  ProvenPatternDtoSchema,
  hashCanonicalContent,
} from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import type { HarnessSession } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionOpportunityTracker } from "../../src/opportunity/session-opportunity-tracker.js";

const WORKSPACE_ID = "ws_opportunity_tracker";
const ACCOUNT_ID = "acct_opportunity_tracker";
const EPISODE_COST_MICRO_USD = 200_000;

/**
 * Builds one deterministic 3-step workflow episode worth of events.
 */
function buildWorkflowEvents(
  sessionId: string,
  sequenceOffset: number,
  timestampMs: number,
  withPricedUsage = true,
): NormalizedSessionEvent[] {
  // Distinct commands per step: repeated identical actions would read as retries.
  const steps = [
    "tsc --noEmit",
    "vitest run",
    "biome check",
    "oxlint",
    "tsx scripts/build.ts",
    "luau-lsp analyze",
    "rojo build",
    "wally install",
    "stylua",
  ];
  return steps.map((step, index) => {
    const causalSequence = sequenceOffset + index;
    const timestamp = new Date(timestampMs + index * 1_000).toISOString();
    return {
      schemaVersion: "1.0.0",
      eventId: `evt_${hashCanonicalContent({ sessionId, causalSequence }).slice(0, 24)}`,
      sessionId,
      timestamp,
      type: "command_exec",
      command: step,
      args: [],
      exitCode: 0,
      durationMs: 900,
      causalRef: { causalSequence },
      redaction: {
        isRedacted: true,
        redactedFields: [],
        redactionStrategy: "drop",
        scrubbedPatterns: [],
        redactedAt: timestamp,
      },
      metadata: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
      // Usage is attributed once per episode, on the final step.
      ...(withPricedUsage && index === steps.length - 1
        ? {
            providerUsage: {
              provider: "openai",
              accountingVersion: "1.0.0",
              availability: "complete",
              totalTokens: 5_000,
              costMicroUsd: EPISODE_COST_MICRO_USD,
              costProvenance: "source_reported",
              durationMs: 8_000,
            },
          }
        : {}),
    } as unknown as NormalizedSessionEvent;
  });
}

function buildTerminalEvent(
  sessionId: string,
  causalSequence: number,
  timestampMs: number,
): NormalizedSessionEvent {
  const timestamp = new Date(timestampMs).toISOString();
  return {
    schemaVersion: "1.0.0",
    eventId: `evt_${hashCanonicalContent({ sessionId, causalSequence, terminal: true }).slice(0, 24)}`,
    sessionId,
    timestamp,
    type: "session_lifecycle",
    lifecycleType: "end",
    exitReason: "completed",
    causalRef: { causalSequence },
    redaction: {
      isRedacted: true,
      redactedFields: [],
      redactionStrategy: "drop",
      scrubbedPatterns: [],
      redactedAt: timestamp,
    },
    metadata: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
  } as unknown as NormalizedSessionEvent;
}

function buildHarnessSession(sessionId: string): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: WORKSPACE_ID,
    // The normalization pipeline does not stamp tenant identity onto normalized events, so the
    // tracker must attribute episodes from the session itself.

    harnessId: "omp",
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    status: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

describe("SessionOpportunityTracker", () => {
  let store: LocalStateStore;
  let tracker: SessionOpportunityTracker;

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    tracker = new SessionOpportunityTracker({ opportunities: store.opportunities });
  });

  afterEach(() => {
    tracker.reset();
    store.close();
  });

  /** Feeds one full session: workflow events, then the terminal lifecycle event. */
  async function feedSession(
    target: SessionOpportunityTracker,
    sessionId: string,
    baseMs: number,
    withPricedUsage = true,
  ): Promise<void> {
    const session = buildHarnessSession(sessionId);
    const events = buildWorkflowEvents(sessionId, 1, baseMs, withPricedUsage);
    await target.handleSessionEvents(session, events, {
      isTerminal: false,
      isAttributed: true,
    });
    await target.handleSessionEvents(
      session,
      [buildTerminalEvent(sessionId, events.length + 1, baseMs + 4_000)],
      { isTerminal: true, isAttributed: true },
    );
  }

  it("dispatches on the first occurrence regardless of predicted cost savings", async () => {
    const baseMs = Date.parse("2026-01-05T10:00:00.000Z");
    await feedSession(tracker, "sess_opp_alpha", baseMs);

    // The trigger, not the derived dollar estimate, decides dispatch.
    const pending = await store.opportunities.listPendingPatterns();
    expect(pending).toHaveLength(1);
    const payload = ProvenPatternDtoSchema.parse(pending[0]?.payload);
    // Episode attribution comes from the session, not from an event field.
    expect(payload.workspaceId).toBe(WORKSPACE_ID);
    expect(payload.localVerdicts.coverage.status).toBe("net_new");
    expect(payload.accountId).toBe(ACCOUNT_ID);
    expect(payload.idempotencyKey).toBe(pending[0]?.idempotencyKey);
    expect(payload.localVerdicts.trigger.triggered).toBe(true);
    expect(payload.localVerdicts.trigger.triggerType).toBe("normal_frequency");
    expect(payload.localVerdicts.suppression.suppressed).toBe(false);
    // Priced usage is present, so the advisory estimate is still derived and recorded.
    expect(payload.localVerdicts.estimatedSavedWork.estimatedCostSavedUsd).toBeGreaterThan(0);
    expect(payload.localVerdicts.estimatedSavedWork.confidence).toBeLessThanOrEqual(1);
    expect(tracker.getDiagnostics().patternsProven).toBe(1);

    // The same structural pattern in a later session is deduplicated, not re-dispatched.
    await feedSession(tracker, "sess_opp_bravo", baseMs + 60_000);
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(1);
    expect(tracker.getDiagnostics().patternsProven).toBe(1);
  });

  it.each([103, 104, 128])(
    "dispatches schema-valid patterns for a %i-character workspace identifier",
    async (length) => {
      const workspaceId = "w".repeat(length);
      const sessionId = `sess_workspace_length_${length}`;
      const events = buildWorkflowEvents(sessionId, 1, Date.parse("2026-01-05T10:00:00Z")).map(
        (event) => ({
          ...event,
          metadata: { ...event.metadata, workspaceId },
        }),
      );

      await tracker.handleSessionEvents(
        { ...buildHarnessSession(sessionId), workspaceId },
        events,
        { isTerminal: true, isAttributed: true },
      );

      const pending = await store.opportunities.listPendingPatterns();
      expect(pending).toHaveLength(1);
      const payload = ProvenPatternDtoSchema.parse(pending[0]?.payload);
      expect(payload.workspaceId).toBe(workspaceId);
      expect(payload.cluster.clusterId.length).toBeLessThanOrEqual(128);
      expect(tracker.getDiagnostics().patternsProven).toBe(1);
    },
  );

  it("keeps dispatching when the predicted savings estimate is unknown", async () => {
    const unknownSavings = new SessionOpportunityTracker({ opportunities: store.opportunities });
    const baseMs = Date.parse("2026-01-05T11:00:00.000Z");
    await feedSession(unknownSavings, "sess_opp_zero_a", baseMs, false);

    const pending = await store.opportunities.listPendingPatterns();
    expect(pending).toHaveLength(1);
    const estimate = ProvenPatternDtoSchema.parse(pending[0]?.payload).localVerdicts
      .estimatedSavedWork;
    // Unknown cost stays unknown: it is never invented, and it never withholds dispatch.
    expect(estimate.estimatedCostSavedUsd).toBeUndefined();
    expect(estimate.savedCostUsd).toBeUndefined();

    await feedSession(unknownSavings, "sess_opp_zero_b", baseMs + 60_000, false);
    expect(unknownSavings.getDiagnostics().patternsProven).toBe(1);
    unknownSavings.reset();
  });

  it("withholds a pattern whose evidence maturity is below the dispatch confidence floor", async () => {
    const floored = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      minDispatchConfidence: 1,
    });
    const baseMs = Date.parse("2026-01-05T11:30:00.000Z");
    await feedSession(floored, "sess_opp_floor_a", baseMs);

    // A single occurrence carries 0.5 evidence-maturity confidence; only a second one reaches 1.
    expect(floored.getDiagnostics().patternsProven).toBe(0);
    expect(floored.getDiagnostics().clustersEvaluated).toBeGreaterThan(0);

    await feedSession(floored, "sess_opp_floor_b", baseMs + 60_000);

    expect(floored.getDiagnostics().patternsProven).toBe(1);
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(1);
    floored.reset();
  });

  it("does not re-dispatch a pattern already recorded in the hash cache", async () => {
    const baseMs = Date.parse("2026-01-05T12:00:00.000Z");
    await feedSession(tracker, "sess_opp_cached_a", baseMs);
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(1);
    tracker.reset();

    // A fresh tracker has no in-memory dispatch memory: only the persisted hash cache can block.
    const restarted = new SessionOpportunityTracker({ opportunities: store.opportunities });
    await feedSession(restarted, "sess_opp_cached_c", baseMs + 120_000);
    await feedSession(restarted, "sess_opp_cached_d", baseMs + 180_000);

    expect(await store.opportunities.listPendingPatterns()).toHaveLength(1);
    expect(restarted.getDiagnostics().skippedByHashCache).toBeGreaterThan(0);
    expect(restarted.getDiagnostics().patternsProven).toBe(0);
    restarted.reset();
  });

  it("releases the in-memory window once a session is terminal", async () => {
    await feedSession(tracker, "sess_opp_terminal", Date.parse("2026-01-05T13:00:00.000Z"));
    expect(tracker.getTrackedSessionIds()).not.toContain("sess_opp_terminal");
    expect(tracker.getDiagnostics().trackedSessions).toBe(0);
  });

  it("skips detection while the evolution kill switch is paused", async () => {
    const gated = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      killSwitches: {
        canEvolve: () => ({ allowed: false, reason: "paused" }),
      } as never,
    });
    await feedSession(gated, "sess_opp_paused_a", Date.parse("2026-01-05T14:00:00.000Z"));
    await feedSession(gated, "sess_opp_paused_b", Date.parse("2026-01-05T14:01:00.000Z"));

    expect(gated.getDiagnostics().killSwitchBlocked).toBeGreaterThan(0);
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(0);
    expect(gated.getTrackedSessionIds()).toHaveLength(0);
    gated.reset();
  });

  it("bounds the workspace episode window", async () => {
    const bounded = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      maxEpisodesPerSession: 1,
      maxEpisodesPerWorkspace: 2,
    });
    const baseMs = Date.parse("2026-01-05T15:00:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      await feedSession(bounded, `sess_opp_bounded_${index}`, baseMs + index * 60_000);
    }
    expect(bounded.getDiagnostics().droppedEpisodes).toBeGreaterThan(0);
    bounded.reset();
  });
});
