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
 * A single occurrence is worth 0.1788 USD of estimated savings discounted by its 0.5 evidence
 * confidence (0.0894 USD); the second occurrence doubles that to 0.1788 USD. This threshold sits
 * between the two so the dispatch predicate is only satisfied once the pattern recurs.
 */
const DISCRIMINATING_SYNTHESIS_COST_USD = 0.12;

/** Builds one deterministic 3-step workflow episode worth of events. */
function buildWorkflowEvents(
  sessionId: string,
  sequenceOffset: number,
  timestampMs: number,
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
      ...(index === steps.length - 1
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
    tracker = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      synthesisCostUsd: DISCRIMINATING_SYNTHESIS_COST_USD,
    });
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
  ): Promise<void> {
    const session = buildHarnessSession(sessionId);
    const events = buildWorkflowEvents(sessionId, 1, baseMs);
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

  it("withholds a single occurrence and enqueues a ProvenPatternDto once the pattern recurs", async () => {
    const baseMs = Date.parse("2026-01-05T10:00:00.000Z");
    await feedSession(tracker, "sess_opp_alpha", baseMs);

    // One occurrence yields 0.0894 USD of discounted savings, below the 0.12 USD synthesis cost.
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(0);

    await feedSession(tracker, "sess_opp_bravo", baseMs + 60_000);

    const pending = await store.opportunities.listPendingPatterns();
    expect(pending).toHaveLength(1);
    const payload = ProvenPatternDtoSchema.parse(pending[0].payload);
    // Episode attribution comes from the session, not from an event field.
    expect(payload.workspaceId).toBe(WORKSPACE_ID);
    expect(payload.localVerdicts.coverage.status).toBe("net_new");
    expect(payload.accountId).toBe(ACCOUNT_ID);
    expect(payload.idempotencyKey).toBe(pending[0].idempotencyKey);
    expect(payload.localVerdicts.trigger.triggered).toBe(true);
    // Recurrence across sessions, not single-episode exceptional waste, is what proves it.
    expect(payload.localVerdicts.trigger.triggerType).toBe("normal_frequency");
    expect(payload.localVerdicts.suppression.suppressed).toBe(false);
    expect(payload.cluster.episodeCount).toBeGreaterThanOrEqual(2);
    expect(payload.cluster.distinctSessionIds.length).toBeGreaterThanOrEqual(2);
    // Two occurrences clear the threshold: 0.1788 USD discounted at confidence 1.0.
    expect(payload.localVerdicts.estimatedSavedWork.estimatedCostSavedUsd ?? 0).toBeGreaterThan(
      DISCRIMINATING_SYNTHESIS_COST_USD,
    );
    expect(payload.localVerdicts.estimatedSavedWork.confidence).toBeLessThanOrEqual(1);
    expect(tracker.getDiagnostics().patternsProven).toBe(1);
  });

  it("withholds dispatch while projected savings fail to beat synthesis cost", async () => {
    const expensive = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      synthesisCostUsd: 10_000,
    });
    await feedSession(expensive, "sess_opp_costly_a", Date.parse("2026-01-05T11:00:00.000Z"));
    await feedSession(expensive, "sess_opp_costly_b", Date.parse("2026-01-05T11:01:00.000Z"));

    expect(await store.opportunities.listPendingPatterns()).toHaveLength(0);
    expect(expensive.getDiagnostics().patternsProven).toBe(0);
    expensive.reset();
  });

  it("does not re-dispatch a pattern already recorded in the hash cache", async () => {
    const baseMs = Date.parse("2026-01-05T12:00:00.000Z");
    await feedSession(tracker, "sess_opp_cached_a", baseMs);
    await feedSession(tracker, "sess_opp_cached_b", baseMs + 60_000);
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(1);
    tracker.reset();

    // A fresh tracker has no in-memory dispatch memory: only the persisted hash cache can block.
    const restarted = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      synthesisCostUsd: DISCRIMINATING_SYNTHESIS_COST_USD,
    });
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
      synthesisCostUsd: DISCRIMINATING_SYNTHESIS_COST_USD,
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
      synthesisCostUsd: DISCRIMINATING_SYNTHESIS_COST_USD,
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
