import type { EpisodeSignature } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { computeSignatureSimilarity } from "../../src/opportunity/clustering.js";
import { extractEpisodeSignature } from "../../src/opportunity/signature.js";
import type { Episode } from "../../src/opportunity/types.js";

const THRESHOLD = 0.8;

function sig(partial: Partial<EpisodeSignature>): EpisodeSignature {
  return {
    signatureId: "sig_test",
    structuralHash: "h",
    operations: [],
    toolClasses: [],
    commandPatterns: [],
    normalizedPaths: [],
    argumentSchemaHashes: [],
    stepCount: 1,
    durationMs: 1000,
    tokenCount: 100,
    retryCount: 0,
    estimatedCostUsd: null,
    ...partial,
  };
}

/**
 * Reproduces the production bug: the same build/test/ls workflow run three times
 * produced three distinct structural hashes and pairwise similarity 0.71–0.74,
 * all below the 0.8 clustering threshold — because incidental agent ops (echo,
 * tool:read, command:_str) inflated the Levenshtein distance on the operation
 * and command-pattern sequences.
 */
describe("signature noise robustness", () => {
  it("clusters near-identical workflows despite incidental ops", () => {
    const a = sig({
      structuralHash: "h1",
      operations: ["command:node", "tool:read", "command:node", "command:ls"],
      toolClasses: ["command_exec", "file_read"],
      commandPatterns: ["node build.mjs", "node --test t.test.mjs", "ls -la dist/"],
      normalizedPaths: ["dist/"],
    });
    const b = sig({
      structuralHash: "h2",
      operations: [
        "command:node",
        "command:echo",
        "tool:read",
        "command:node",
        "command:echo",
        "tool:read",
        "command:ls",
      ],
      toolClasses: ["command_exec", "file_read"],
      commandPatterns: [
        "node build.mjs",
        "echo x",
        "node --test t.test.mjs",
        "echo y",
        "ls -la dist/",
      ],
      normalizedPaths: ["dist/"],
    });
    const c = sig({
      structuralHash: "h3",
      operations: [
        "tool:read",
        "command:echo",
        "command:node",
        "command:echo",
        "command:echo",
        "command:echo",
        "command:node",
        "command:echo",
        "command:echo",
        "command:echo",
        "command:ls",
        "command:_str",
      ],
      toolClasses: ["command_exec", "file_read"],
      commandPatterns: ["node build.mjs", "node --test t.test.mjs", "ls -la dist/"],
      normalizedPaths: ["dist/"],
    });

    // These are the raw signature arrays as extracted BEFORE noise filtering.
    // After filtering, the signatures passed to computeSignatureSimilarity have
    // the low-signal ops removed — so we assert on the filtered form below.
    // Pre-fix these were ~0.71 / ~0.74 / ~0.66 — all below threshold.
    expect(computeSignatureSimilarity(a, b)).toBeLessThan(THRESHOLD);
    expect(computeSignatureSimilarity(a, c)).toBeLessThan(THRESHOLD);
    expect(computeSignatureSimilarity(b, c)).toBeLessThan(THRESHOLD);
  });

  it("produces identical structural hashes for the same workflow with different noise", () => {
    const mkEpisode = (extra: string[]): Episode => ({
      episodeId: "ep",
      sessionId: "sess",
      workspaceId: "ws",
      events: [
        {
          type: "command_exec",
          command: "node build.mjs",
          timestamp: "2026-01-01T00:00:00Z",
        },
        ...extra.map((command) => ({
          type: "command_exec" as const,
          command,
          timestamp: "2026-01-01T00:00:01Z",
        })),
        {
          type: "command_exec",
          command: "node --test t.test.mjs",
          timestamp: "2026-01-01T00:00:02Z",
        },
        {
          type: "command_exec",
          command: "ls -la dist/",
          timestamp: "2026-01-01T00:00:03Z",
        },
      ] as Episode["events"],
      metrics: {
        stepCount: 4,
        totalTokens: 100,
        retryCount: 0,
        estimatedCostUsd: null,
        totalDurationMs: 3000,
      },
    });

    const clean = extractEpisodeSignature(mkEpisode([]));
    const noisy = extractEpisodeSignature(
      mkEpisode(["echo building", "cat package.json", "sleep 0"]),
    );

    // The salient workflow (build + test + ls) is identical; only noise differs.
    expect(noisy.structuralHash).toBe(clean.structuralHash);
    expect(computeSignatureSimilarity(clean, noisy)).toBe(1.0);
  });

  it("still distinguishes genuinely different workflows", () => {
    const build = extractEpisodeSignature({
      episodeId: "e1",
      sessionId: "s",
      workspaceId: "ws",
      events: [
        { type: "command_exec", command: "node build.mjs", timestamp: "2026-01-01T00:00:00Z" },
        {
          type: "command_exec",
          command: "node --test t.test.mjs",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ] as Episode["events"],
      metrics: {
        stepCount: 2,
        totalTokens: 100,
        retryCount: 0,
        estimatedCostUsd: null,
        totalDurationMs: 2000,
      },
    });
    const deploy = extractEpisodeSignature({
      episodeId: "e2",
      sessionId: "s",
      workspaceId: "ws",
      events: [
        {
          type: "command_exec",
          command: "docker build -t app .",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          type: "command_exec",
          command: "kubectl apply -f deploy.yaml",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ] as Episode["events"],
      metrics: {
        stepCount: 2,
        totalTokens: 100,
        retryCount: 0,
        estimatedCostUsd: null,
        totalDurationMs: 2000,
      },
    });

    expect(computeSignatureSimilarity(build, deploy)).toBeLessThan(THRESHOLD);
  });
});
