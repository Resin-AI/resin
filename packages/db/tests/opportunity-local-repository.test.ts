import { CURRENT_PATTERN_SCHEMA_VERSION, type ProvenPatternDto } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInMemoryStateStore } from "../src/store.js";

const T1 = "2026-09-11T10:00:00.000Z";
const T2 = "2026-09-11T11:00:00.000Z";

const metrics = {
  totalTokens: 1200,
  totalCostUsd: 0.42,
  avgDurationMs: 900,
  avgTokens: 600,
  totalRetries: 2,
  avgStepCount: 4,
};

const signature = {
  signatureId: "sig_01",
  structuralHash: "hash_abc",
  operations: ["read", "edit"],
  toolClasses: ["fs"],
  commandPatterns: ["git status"],
  normalizedPaths: ["src/a.ts"],
  argumentSchemaHashes: ["arg_1"],
  stepCount: 2,
  durationMs: 900,
  tokenCount: 600,
  retryCount: 1,
  estimatedCostUsd: 0.21,
};

const clusterSummary = {
  clusterId: "clu_01",
  structuralHash: "hash_abc",
  episodeCount: 2,
  distinctSessionIds: ["sess_01"],
  scenarioIds: [],
  distinctScenarioCount: 0,
  completedOccurrences: 2,
  firstSeenAt: T1,
  lastSeenAt: T2,
  evidenceEventIds: ["evt_01"],
  metrics,
};

const pattern: ProvenPatternDto = {
  schemaVersion: CURRENT_PATTERN_SCHEMA_VERSION,
  patternId: "pat_01",
  idempotencyKey: "idem_01",
  accountId: "acct_01",
  workspaceId: "ws_01",
  engineVersion: "1.0.0",
  signature,
  cluster: clusterSummary,
  localVerdicts: {
    trigger: {
      triggered: true,
      triggerType: "normal_frequency",
      reason: "recurring",
      description: "seen twice",
      evidenceEventIds: ["evt_01"],
      metrics: {
        occurrenceCount: 2,
        durationMs: 900,
        tokenCount: 600,
        retryCount: 1,
        estimatedCostUsd: 0.21,
        stepCount: 2,
      },
    },
    suppression: { suppressed: false, reason: "none", details: "clear" },
    coverage: {
      status: "net_new",
      similarityScore: 0,
      overlapRatio: 0,
      reason: "no tool",
    },
    estimatedSavedWork: {
      estimatedDurationSavedMs: 100,
      estimatedTokensSaved: 50,
      estimatedStepsSaved: 1,
      savedDurationMs: 200,
      savedTokens: 100,
      estimatedCostSavedUsd: 0.05,
      savedCostUsd: 0.1,
      savedToolCalls: 3,
      confidence: 0.8,
    },
  },
  evidenceEventIds: ["evt_01"],
};

describe("OpportunityLocalRepository", () => {
  it("round-trips signatures, clusters, hash cache, and the pattern outbox", async () => {
    const store = await createInMemoryStateStore();
    const repo = store.opportunities;

    // signatures
    await repo.insertSignature({
      signatureId: "sig_01",
      sessionId: "sess_01",
      structuralHash: "hash_abc",
      episodeId: "ep_01",
      payload: signature,
      createdAt: T1,
    });
    await repo.insertSignature({
      signatureId: "sig_02",
      sessionId: "sess_01",
      structuralHash: "hash_other",
      payload: { ...signature, signatureId: "sig_02", structuralHash: "hash_other" },
      createdAt: T2,
    });
    await repo.insertSignature({
      signatureId: "sig_03",
      sessionId: "sess_02",
      structuralHash: "hash_abc",
      payload: { ...signature, signatureId: "sig_03" },
      createdAt: T2,
    });

    const bySession = await repo.getSignaturesBySession("sess_01");
    expect(bySession.map((s) => s.signatureId)).toEqual(["sig_01", "sig_02"]);
    expect(bySession[0].payload).toEqual(signature);
    expect(bySession[0].episodeId).toBe("ep_01");
    expect(bySession[1].episodeId).toBeUndefined();

    const byHash = await repo.getSignaturesByHash("hash_abc");
    expect(byHash.map((s) => s.signatureId)).toEqual(["sig_01", "sig_03"]);

    // clusters
    await repo.upsertCluster({
      clusterId: "clu_01",
      workspaceId: "ws_01",
      structuralHash: "hash_abc",
      firstSeenAt: T1,
      lastSeenAt: T1,
      occurrenceCount: 1,
      evidenceEventIds: ["evt_01"],
      metrics,
      engineVersion: "1.0.0",
    });
    await repo.upsertCluster({
      clusterId: "clu_01",
      workspaceId: "ws_01",
      structuralHash: "hash_abc",
      firstSeenAt: T1,
      lastSeenAt: T2,
      occurrenceCount: 2,
      evidenceEventIds: ["evt_01", "evt_02"],
      metrics,
      engineVersion: "1.0.0",
    });
    await repo.upsertCluster({
      clusterId: "clu_02",
      workspaceId: "ws_02",
      structuralHash: "hash_abc",
      firstSeenAt: T2,
      lastSeenAt: T2,
      occurrenceCount: 1,
      evidenceEventIds: [],
      metrics,
      engineVersion: "1.0.0",
    });

    const cluster = await repo.getCluster("clu_01");
    expect(cluster?.occurrenceCount).toBe(2);
    expect(cluster?.lastSeenAt).toBe(T2);
    expect(cluster?.evidenceEventIds).toEqual(["evt_01", "evt_02"]);
    expect(cluster?.metrics).toEqual(metrics);
    expect(await repo.getCluster("missing")).toBeNull();

    expect((await repo.listClustersByHash("hash_abc")).map((c) => c.clusterId)).toEqual([
      "clu_01",
      "clu_02",
    ]);
    expect((await repo.listClustersByWorkspace("ws_01")).map((c) => c.clusterId)).toEqual([
      "clu_01",
    ]);
    expect(await repo.listClustersByWorkspace("ws_missing")).toEqual([]);

    // cluster episodes
    await repo.linkClusterEpisode("clu_01", "ep_01", "sess_01");
    await repo.linkClusterEpisode("clu_01", "ep_01", "sess_01");
    await repo.linkClusterEpisode("clu_01", "ep_02");
    const episodes = store.getConnection().all<{ cluster_id: string; episode_id: string }>(
      "SELECT cluster_id, episode_id FROM cluster_episodes WHERE cluster_id = 'clu_01' ORDER BY episode_id;",
    );
    expect(episodes).toHaveLength(2);

    // hash cache
    await repo.upsertHashCacheEntry({
      structuralHash: "hash_abc",
      outcome: "in_progress",
      lastSeenAt: T1,
      attempts: 1,
      sourceRevision: "rev_a",
      syncedAt: null,
      expiresAt: "2026-10-01T00:00:00.000Z",
    });
    await repo.upsertHashCacheEntry({
      structuralHash: "hash_abc",
      outcome: "published",
      lastSeenAt: T2,
      attempts: 2,
      sourceRevision: "rev_b",
      syncedAt: T2,
      expiresAt: "2026-10-01T00:00:00.000Z",
    });
    await repo.upsertHashCacheEntry({
      structuralHash: "hash_expired",
      outcome: "rejected_on_merit",
      lastSeenAt: T1,
      attempts: 1,
      syncedAt: null,
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    const cacheEntry = await repo.getHashCacheEntry("hash_abc");
    expect(cacheEntry?.outcome).toBe("published");
    expect(cacheEntry?.attempts).toBe(2);
    expect(cacheEntry?.sourceRevision).toBe("rev_b");
    expect(cacheEntry?.syncedAt).toBe(T2);
    expect((await repo.getHashCacheEntry("hash_abc"))?.expiresAt).toBe("2026-10-01T00:00:00.000Z");
    expect(await repo.getHashCacheEntry("missing")).toBeNull();

    const recent = await repo.listRecentHashCache(T2);
    expect(recent.map((e) => e.structuralHash)).toEqual(["hash_abc"]);
    expect((await repo.listRecentHashCache(T1)).map((e) => e.structuralHash).sort()).toEqual([
      "hash_abc",
      "hash_expired",
    ]);

    expect(await repo.pruneHashCache(T2)).toBe(1);
    expect(await repo.getHashCacheEntry("hash_expired")).toBeNull();

    // pattern outbox
    const firstId = await repo.enqueuePattern({
      patternId: "pat_01",
      idempotencyKey: "idem_01",
      workspaceId: "ws_01",
      payload: pattern,
      createdAt: T1,
    });
    expect(firstId).toBe("pat_01");

    const duplicateId = await repo.enqueuePattern({
      patternId: "pat_01_dup",
      idempotencyKey: "idem_01",
      workspaceId: "ws_01",
      payload: pattern,
      createdAt: T2,
    });
    expect(duplicateId).toBe("pat_01");

    await repo.enqueuePattern({
      patternId: "pat_02",
      idempotencyKey: "idem_02",
      payload: pattern,
      createdAt: T2,
    });

    const pending = await repo.listPendingPatterns(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].patternId).toBe("pat_01");
    expect(pending[0].payload).toEqual(pattern);
    expect(pending[0].uploadedAt).toBeUndefined();

    const fetched = await repo.getPatternByIdempotencyKey("idem_01");
    expect(fetched?.payload).toEqual(pattern);
    expect(fetched?.workspaceId).toBe("ws_01");
    expect(await repo.getPatternByIdempotencyKey("missing")).toBeNull();

    await repo.markPatternUploaded("pat_01", T2);
    await repo.markPatternUploaded("pat_01", "2027-01-01T00:00:00.000Z");
    const remaining = await repo.listPendingPatterns();
    expect(remaining.map((p) => p.patternId)).toEqual(["pat_02"]);
    expect((await repo.getPatternByIdempotencyKey("idem_01"))?.uploadedAt).toBe(T2);

    store.close();
  });
});
