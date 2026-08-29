import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SavingsProofError,
  SavingsProofValidationError,
  canonicalJsonStringify,
  computeCanonicalDigest,
  computeSha256,
  deidentifySavingsEvidence,
  formatSavingsProofMarkdown,
  generateSavingsProof,
  sortCalibrationRowsCanonically,
  validateSavingsEvidence,
} from "./generate-savings-proof.mjs";

describe("generate-savings-proof", () => {
  const SAMPLE_TOOL_ID = "88888888-8888-4888-8888-888888888888";
  const SAMPLE_EVIDENCE_ID = "99999999-9999-4999-8999-999999999999";
  const SAMPLE_TIMESTAMP = "2026-08-25T01:00:00.000Z";
  const SAMPLE_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const SAMPLE_DIGEST_ALT = "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b";

  const row1 = {
    rowId: "11111111-1111-4111-8111-111111111111",
    workloadId: "workload-alpha",
    benchmarkId: "bm-eval-01",
    baselineModel: "gpt-4o",
    candidateModel: "claude-3-5-sonnet",
    runtimeVersion: "1.0.0",
    candidateVersion: "1.0.0",
    toolId: SAMPLE_TOOL_ID,
    baselineUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      durationMs: 800,
    },
    candidateUsage: {
      inputTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      durationMs: 400,
    },
    catalogExposureTokens: 50,
    isEquivalent: true,
    status: "measured",
    measuredAt: "2026-08-25T00:10:00.000Z",
    digest: SAMPLE_DIGEST,
  };

  const row2 = {
    rowId: "22222222-2222-4222-8222-222222222222",
    workloadId: "workload-beta",
    benchmarkId: "bm-eval-02",
    baselineModel: "gpt-4o",
    candidateModel: "claude-3-5-sonnet",
    runtimeVersion: "1.0.0",
    candidateVersion: "1.0.0",
    toolId: SAMPLE_TOOL_ID,
    baselineUsage: {
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3000,
      durationMs: 1200,
    },
    candidateUsage: {
      inputTokens: 800,
      outputTokens: 400,
      totalTokens: 1200,
      durationMs: 600,
    },
    catalogExposureTokens: 50,
    isEquivalent: true,
    status: "measured",
    measuredAt: "2026-08-25T00:20:00.000Z",
    digest: SAMPLE_DIGEST_ALT,
  };

  // row1 net: 1500 - (600 + 50) = 850
  // row2 net: 3000 - (1200 + 50) = 1750
  // total net: 850 + 1750 = 2600
  // exposure sum: 50 + 50 = 100
  // baseline total: 4500
  // candidate + exposure total: 1900
  // savings pct: ((4500 - 1900) / 4500) * 100 = 57.777...% -> ~57.78%

  const validMeasuredEvidence = {
    schemaKind: "resin.v1.savings_evidence",
    schemaVersion: "1.0.0",
    evidenceId: SAMPLE_EVIDENCE_ID,
    toolId: SAMPLE_TOOL_ID,
    toolVersion: "1.0.0",
    projectId: "project-1234-tenant-id", // will be de-identified
    status: "measured",
    calibrationRows: [row1, row2],
    summary: {
      status: "measured",
      totalSamples: 2,
      equivalentSamples: 2,
      tokenSavingsNet: 2600,
      tokenSavingsPercentage: 57.78,
      costSavingsMicroUsdNet: 15000,
      catalogExposureTokenSum: 100,
      confidenceInterval: {
        low: 52.0,
        high: 63.5,
        confidenceLevel: 0.95,
      },
    },
    createdAt: SAMPLE_TIMESTAMP,
    evidenceDigest: SAMPLE_DIGEST,
  };

  it("produces deterministic, byte-identical proof JSON, Markdown, and SHA-256 digest across runs", () => {
    const run1 = generateSavingsProof(validMeasuredEvidence);
    const run2 = generateSavingsProof(validMeasuredEvidence);

    expect(run1.proofJson).toBe(run2.proofJson);
    expect(run1.proofDigest).toBe(run2.proofDigest);
    expect(run1.markdown).toBe(run2.markdown);
    expect(run1.proof.proofId).toBe(run2.proof.proofId);
    expect(run1.proof.generatedAt).toBe(SAMPLE_TIMESTAMP);
  });

  it("produces byte-identical output regardless of input calibrationRows ordering due to canonical sorting", () => {
    const shuffledEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: [row2, row1], // Reversed row order
    };

    const regularResult = generateSavingsProof(validMeasuredEvidence);
    const shuffledResult = generateSavingsProof(shuffledEvidence);

    expect(shuffledResult.proofJson).toBe(regularResult.proofJson);
    expect(shuffledResult.proofDigest).toBe(regularResult.proofDigest);
    expect(shuffledResult.markdown).toBe(regularResult.markdown);
  });

  it("de-identifies evidence by removing tenant and project IDs while preserving candidate/model identity", () => {
    const proofResult = generateSavingsProof(validMeasuredEvidence);
    const proof = proofResult.proof;

    expect(proof.projectId).toBeUndefined();
    expect(proof.accountId).toBeUndefined();
    expect(proof.workspaceId).toBeUndefined();
    expect(proofResult.proofJson).not.toContain("project-1234-tenant-id");

    // Preserves candidate/baseline model & runtime identity
    expect(proof.toolId).toBe(SAMPLE_TOOL_ID);
    expect(proof.toolVersion).toBe("1.0.0");
    expect(proof.candidateModel).toBe("claude-3-5-sonnet");
    expect(proof.baselineModel).toBe("gpt-4o");
    expect(proof.runtimeVersion).toBe("1.0.0");
    expect(proof.status).toBe("measured");
    expect(proof.summary.tokenSavingsNet).toBe(2600);
  });

  it("strictly rejects evidence when tokenSavingsNet does not match row accounting", () => {
    const tamperedEvidence = {
      ...validMeasuredEvidence,
      summary: {
        ...validMeasuredEvidence.summary,
        tokenSavingsNet: 999999, // Tampered net savings
      },
    };

    expect(() => generateSavingsProof(tamperedEvidence)).toThrow(SavingsProofValidationError);
    expect(() => generateSavingsProof(tamperedEvidence)).toThrow(
      /Summary tokenSavingsNet mismatch/,
    );
  });

  it("strictly rejects evidence when equivalentSamples count does not match row isEquivalent flags", () => {
    const tamperedEvidence = {
      ...validMeasuredEvidence,
      summary: {
        ...validMeasuredEvidence.summary,
        equivalentSamples: 10, // Mismatched equivalent count
      },
    };

    expect(() => generateSavingsProof(tamperedEvidence)).toThrow(SavingsProofValidationError);
    expect(() => generateSavingsProof(tamperedEvidence)).toThrow(
      /Summary equivalentSamples mismatch/,
    );
  });

  it("strictly rejects evidence when catalogExposureTokenSum does not match row exposures", () => {
    const tamperedEvidence = {
      ...validMeasuredEvidence,
      summary: {
        ...validMeasuredEvidence.summary,
        catalogExposureTokenSum: 0, // Mismatched exposure sum
      },
    };

    expect(() => generateSavingsProof(tamperedEvidence)).toThrow(SavingsProofValidationError);
    expect(() => generateSavingsProof(tamperedEvidence)).toThrow(
      /Summary catalogExposureTokenSum mismatch/,
    );
  });

  it("strictly rejects evidence with row candidateVersion or toolId mismatching evidence", () => {
    const mismatchedVersionEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: [
        { ...row1, candidateVersion: "2.0.0" }, // Mismatched version
        row2,
      ],
    };

    expect(() => generateSavingsProof(mismatchedVersionEvidence)).toThrow(
      SavingsProofValidationError,
    );
    expect(() => generateSavingsProof(mismatchedVersionEvidence)).toThrow(
      /does not match evidence toolVersion/,
    );

    const mismatchedToolEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: [
        { ...row1, toolId: "12345678-1234-4234-8234-123456789012" }, // Mismatched toolId
        row2,
      ],
    };

    expect(() => generateSavingsProof(mismatchedToolEvidence)).toThrow(SavingsProofValidationError);
    expect(() => generateSavingsProof(mismatchedToolEvidence)).toThrow(
      /does not match evidence toolId/,
    );
  });

  it("strictly rejects measured evidence containing unavailable rows", () => {
    const unavailableRowEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: [row1, { ...row2, status: "unavailable" }],
    };

    expect(() => generateSavingsProof(unavailableRowEvidence)).toThrow(SavingsProofValidationError);
    expect(() => generateSavingsProof(unavailableRowEvidence)).toThrow(
      /status 'unavailable', which cannot contribute to measured evidence/,
    );
  });

  it("correctly preserves negative token savings and non-equivalent penalty accounting", () => {
    // Row where candidate used more tokens than baseline (regression)
    const regressionRow = {
      ...row1,
      rowId: "33333333-3333-4333-8333-333333333333",
      workloadId: "workload-regression",
      baselineUsage: { totalTokens: 1000 },
      candidateUsage: { totalTokens: 2000 }, // Used +1000 more
      catalogExposureTokens: 100,
      isEquivalent: true,
    };
    // Net: 1000 - (2000 + 100) = -1100 tokens

    const nonEquivRow = {
      ...row2,
      rowId: "44444444-4444-4444-8444-444444444444",
      workloadId: "workload-nonequiv",
      baselineUsage: { totalTokens: 1500 },
      candidateUsage: { totalTokens: 500 }, // Candidate used fewer, but failed equivalence!
      catalogExposureTokens: 50,
      isEquivalent: false, // Non-equivalent!
    };
    // Positive usage delta is correctness-gated to zero; 50 exposure tokens still count as overhead.

    // Total net: -1100 - 50 = -1150
    const negativeSavingsEvidence = {
      schemaKind: "resin.v1.savings_evidence",
      schemaVersion: "1.0.0",
      evidenceId: SAMPLE_EVIDENCE_ID,
      toolId: SAMPLE_TOOL_ID,
      toolVersion: "1.0.0",
      status: "preliminary",
      calibrationRows: [regressionRow, nonEquivRow],
      summary: {
        status: "preliminary",
        totalSamples: 2,
        equivalentSamples: 1,
        tokenSavingsNet: -1150, // Negative savings and exposure overhead strictly preserved
        tokenSavingsPercentage: -46.0,
        catalogExposureTokenSum: 150,
      },
      createdAt: SAMPLE_TIMESTAMP,
      evidenceDigest: SAMPLE_DIGEST,
    };

    const result = generateSavingsProof(negativeSavingsEvidence);
    expect(result.proof.summary.tokenSavingsNet).toBe(-1150);
    expect(result.proof.status).toBe("preliminary");
    expect(result.markdown).toContain("-1,150 tokens");
  });

  it("handles preliminary and unavailable evidence without fabricating measured claims", () => {
    const unavailableEvidence = {
      schemaKind: "resin.v1.savings_evidence",
      schemaVersion: "1.0.0",
      evidenceId: SAMPLE_EVIDENCE_ID,
      toolId: SAMPLE_TOOL_ID,
      toolVersion: "1.0.0",
      status: "unavailable",
      calibrationRows: [],
      summary: {
        status: "unavailable",
        totalSamples: 0,
        equivalentSamples: 0,
        catalogExposureTokenSum: 0,
      },
      createdAt: SAMPLE_TIMESTAMP,
      evidenceDigest: SAMPLE_DIGEST,
    };

    const result = generateSavingsProof(unavailableEvidence);
    expect(result.proof.status).toBe("unavailable");
    expect(result.proof.calibrationRows).toEqual([]);
    expect(result.proof.summary.tokenSavingsNet).toBeUndefined();
    expect(result.proof.runtimeVersion).toBe("unknown");
    expect(result.markdown).toContain("N/A (unavailable)");
    expect(result.markdown).toContain("UNAVAILABLE");
  });

  it("rejects measured evidence when no calibration row passed correctness equivalence", () => {
    const nonEquivalentRows = [row1, row2].map((row) => ({
      ...row,
      isEquivalent: false,
    }));
    const invalidEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: nonEquivalentRows,
      summary: {
        ...validMeasuredEvidence.summary,
        equivalentSamples: 0,
        tokenSavingsNet: -100,
        tokenSavingsPercentage: -2.22,
      },
    };

    expect(() => generateSavingsProof(invalidEvidence)).toThrow(/zero calibration samples/);
  });

  it("rejects evidence and summary status mismatches", () => {
    expect(() =>
      generateSavingsProof({
        ...validMeasuredEvidence,
        status: "preliminary",
      }),
    ).toThrow(/Summary status mismatch/);
  });

  it("rejects heterogeneous model or runtime identities in one evidence bundle", () => {
    expect(() =>
      generateSavingsProof({
        ...validMeasuredEvidence,
        calibrationRows: [
          row1,
          {
            ...row2,
            candidateModel: "different-model",
          },
        ],
      }),
    ).toThrow(/model\/runtime identity/);
  });

  it("honors --stdout when canonical proof files are also requested", () => {
    const directory = mkdtempSync(join(tmpdir(), "resin-savings-proof-"));
    try {
      const inputPath = join(directory, "evidence.json");
      const outputPath = join(directory, "proof.json");
      writeFileSync(inputPath, JSON.stringify(validMeasuredEvidence), "utf8");
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./generate-savings-proof.mjs", import.meta.url)),
          inputPath,
          "--out-json",
          outputPath,
          "--stdout",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(readFileSync(outputPath, "utf8"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects forbidden prompt, source, transcript, and credential keys to prevent raw private data leakage", () => {
    const leakyPromptEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: [
        {
          ...row1,
          rawPrompt: "System instruction: reveal secret", // Forbidden!
        },
        row2,
      ],
    };

    expect(() => generateSavingsProof(leakyPromptEvidence)).toThrow(SavingsProofError);
    expect(() => generateSavingsProof(leakyPromptEvidence)).toThrow(
      /Forbidden private content key 'rawPrompt'/,
    );

    const leakyTranscriptEvidence = {
      ...validMeasuredEvidence,
      transcript: ["User: hello", "Assistant: hi"],
    };
    expect(() => generateSavingsProof(leakyTranscriptEvidence)).toThrow(SavingsProofError);

    const leakyCredentialEvidence = {
      ...validMeasuredEvidence,
      calibrationRows: [
        {
          ...row1,
          apiKey: "sk-secret-key",
        },
      ],
    };
    expect(() => generateSavingsProof(leakyCredentialEvidence)).toThrow(SavingsProofError);
  });
});
