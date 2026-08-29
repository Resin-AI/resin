#!/usr/bin/env node

/**
 * Deterministic Offline Savings Proof Generator
 *
 * Responsibilities:
 * 1. Accepts exported V1SavingsEvidence JSON.
 * 2. Validates immutable rows, candidate/baseline/model/runtime identity, and cryptographic digests.
 * 3. Enforces correctness-gated calibration accounting (zero/negative for non-equivalent, strict net token sums).
 * 4. Removes tenant identifiers (account, user, workspace, project IDs) and confirms no raw prompt texts.
 * 5. Deterministically and canonically sorts calibration rows and object keys.
 * 6. Emits reproducible, byte-identical de-identified proof JSON, Markdown report, and SHA-256 digest without running prompts.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ============================================================================
// Canonical JSON & Hashing Utilities
// ============================================================================

/**
 * Deterministically serializes a JavaScript value to a canonical JSON string.
 *
 * Invariants:
 * 1. Object keys are sorted lexicographically by UTF-16 code unit order.
 * 2. No extraneous whitespace.
 * 3. Properties with undefined, symbol, or function values are omitted.
 * 4. Non-finite numbers (NaN, Infinity) throw errors.
 * 5. Circular references throw errors.
 */
export function canonicalJsonStringify(value) {
  const seen = new WeakSet();

  function serialize(val) {
    if (val === null || typeof val === "boolean" || typeof val === "string") {
      return JSON.stringify(val);
    }

    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new TypeError(`Cannot canonically serialize non-finite number: ${val}`);
      }
      return JSON.stringify(val);
    }

    if (typeof val === "bigint") {
      return JSON.stringify(Number(val));
    }

    if (typeof val === "undefined" || typeof val === "symbol" || typeof val === "function") {
      return undefined;
    }

    if (val instanceof Date) {
      return JSON.stringify(val.toISOString());
    }

    if (typeof val === "object") {
      if (seen.has(val)) {
        throw new TypeError("Cannot canonically serialize circular object reference");
      }
      seen.add(val);

      try {
        if (Array.isArray(val)) {
          const elements = val.map((elem) => {
            const res = serialize(elem);
            return res === undefined ? "null" : res;
          });
          return `[${elements.join(",")}]`;
        }

        const sortedKeys = Object.keys(val).sort();
        const entries = [];
        for (const key of sortedKeys) {
          const v = val[key];
          const serializedV = serialize(v);
          if (serializedV !== undefined) {
            entries.push(`${JSON.stringify(key)}:${serializedV}`);
          }
        }
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(val);
      }
    }

    return JSON.stringify(val);
  }

  const result = serialize(value);
  return result === undefined ? "" : result;
}

/**
 * Computes SHA-256 hex digest for a string or buffer.
 */
export function computeSha256(data) {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Computes canonical SHA-256 digest of any JSON-serializable value.
 */
export function computeCanonicalDigest(value, options = {}) {
  const canonicalJson = canonicalJsonStringify(value);
  const hex = computeSha256(canonicalJson);
  return options.prefix ? `sha256:${hex}` : hex;
}

// ============================================================================
// Errors
// ============================================================================

export class SavingsProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "SavingsProofError";
  }
}

export class SavingsProofValidationError extends SavingsProofError {
  constructor(message) {
    super(message);
    this.name = "SavingsProofValidationError";
  }
}

// ============================================================================
// Boundary Checks: Forbidden Private / Raw Input Content
// ============================================================================

const FORBIDDEN_RAW_INPUT_KEYS = new Set([
  // Prompts, transcripts, and model interaction payloads
  "prompt",
  "prompts",
  "rawprompt",
  "rawprompts",
  "userprompt",
  "userprompts",
  "systemprompt",
  "systemprompts",
  "completion",
  "completions",
  "rawcompletion",
  "rawcompletions",
  "transcript",
  "transcripts",
  "rawtranscript",
  "rawtranscripts",
  "source",
  "rawsource",
  "sourcecode",
  "source_code",
  "sessioncontent",
  "session_content",
  "sessionlog",
  "session_log",
  "chatlog",
  "chat_log",
  "historylog",
  "history_log",
  "message",
  "messages",
  "usermessage",
  "user_message",
  "assistantmessage",
  "assistant_message",
  "rawresponse",
  "raw_response",
  "rawrequest",
  "raw_request",
  "payloadcontent",
  "payload_content",
  "codeblob",
  "code_blob",
  // Credentials & secrets
  "apikey",
  "api_key",
  "token_secret",
  "secret",
  "secrets",
  "password",
  "passwords",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "bearer",
  "privatekey",
  "private_key",
]);

/**
 * Recursively asserts that no forbidden prompt, source, transcript, session content,
 * or credentials exist in the input evidence object before de-identification.
 */
export function assertNoForbiddenRawContent(obj, pathContext = "evidence") {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoForbiddenRawContent(obj[i], `${pathContext}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_RAW_INPUT_KEYS.has(normalizedKey)) {
      throw new SavingsProofError(
        `Forbidden private content key '${key}' found at '${pathContext}.${key}' (prompts, transcripts, source code, session content, and credentials violate evidence boundaries)`,
      );
    }
    if (value && typeof value === "object") {
      assertNoForbiddenRawContent(value, `${pathContext}.${key}`);
    }
  }
}

// ============================================================================
// Validation & Integrity Verification
// ============================================================================

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXACT_SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validates the exported V1SavingsEvidence object.
 * Enforces correctness gates, accounting consistency, and row integrity.
 */
export function validateSavingsEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new SavingsProofValidationError("Savings evidence must be a non-null object");
  }

  // Strictly reject raw private input (prompts, transcripts, source code, credentials)
  assertNoForbiddenRawContent(evidence, "evidence");

  // Schema identification
  const validSchemaKinds = ["resin.v1.savings_evidence", "savings_evidence"];
  if (!validSchemaKinds.includes(evidence.schemaKind)) {
    throw new SavingsProofValidationError(
      `Invalid schemaKind '${evidence.schemaKind}'; expected one of: ${validSchemaKinds.join(", ")}`,
    );
  }
  if (evidence.schemaVersion !== "1.0.0") {
    throw new SavingsProofValidationError(
      `Unsupported schemaVersion '${evidence.schemaVersion}'; expected '1.0.0'`,
    );
  }

  if (!evidence.evidenceId || typeof evidence.evidenceId !== "string") {
    throw new SavingsProofValidationError("Missing or invalid 'evidenceId'");
  }

  if (!evidence.toolId || typeof evidence.toolId !== "string") {
    throw new SavingsProofValidationError("Missing or invalid 'toolId'");
  }

  if (
    !evidence.toolVersion ||
    typeof evidence.toolVersion !== "string" ||
    !EXACT_SEMVER_REGEX.test(evidence.toolVersion)
  ) {
    throw new SavingsProofValidationError(
      `Invalid semver 'toolVersion': '${evidence.toolVersion}'`,
    );
  }

  const validStatuses = ["unavailable", "preliminary", "measured"];
  if (!validStatuses.includes(evidence.status)) {
    throw new SavingsProofValidationError(
      `Invalid status '${evidence.status}'; must be one of: ${validStatuses.join(", ")}`,
    );
  }

  if (!Array.isArray(evidence.calibrationRows)) {
    throw new SavingsProofValidationError("'calibrationRows' must be an array");
  }

  if (!evidence.summary || typeof evidence.summary !== "object") {
    throw new SavingsProofValidationError("Missing or invalid 'summary' object");
  }

  if (
    !evidence.evidenceDigest ||
    typeof evidence.evidenceDigest !== "string" ||
    !SHA256_HEX_REGEX.test(evidence.evidenceDigest.replace(/^sha256:/, ""))
  ) {
    throw new SavingsProofValidationError(`Invalid 'evidenceDigest': '${evidence.evidenceDigest}'`);
  }

  const rawDigest = evidence.evidenceDigest.replace(/^sha256:/, "").toLowerCase();

  // Validate Summary Fields
  const summary = evidence.summary;
  if (!validStatuses.includes(summary.status)) {
    throw new SavingsProofValidationError(`Invalid summary status '${summary.status}'`);
  }
  if (summary.status !== evidence.status) {
    throw new SavingsProofValidationError(
      `Summary status mismatch: evidence status is '${evidence.status}' but summary.status is '${summary.status}'`,
    );
  }

  if (!Number.isInteger(summary.totalSamples) || summary.totalSamples < 0) {
    throw new SavingsProofValidationError("summary.totalSamples must be a non-negative integer");
  }

  if (!Number.isInteger(summary.equivalentSamples) || summary.equivalentSamples < 0) {
    throw new SavingsProofValidationError(
      "summary.equivalentSamples must be a non-negative integer",
    );
  }

  if (evidence.status === "unavailable") {
    if (summary.tokenSavingsNet != null || summary.tokenSavingsPercentage != null) {
      throw new SavingsProofValidationError(
        "Unavailable evidence must not contain numeric savings claims",
      );
    }
  } else if (
    !Number.isFinite(summary.tokenSavingsNet) ||
    !Number.isFinite(summary.tokenSavingsPercentage)
  ) {
    throw new SavingsProofValidationError(
      "Available evidence requires numeric token savings and percentage",
    );
  }

  if (!Number.isInteger(summary.catalogExposureTokenSum) || summary.catalogExposureTokenSum < 0) {
    throw new SavingsProofValidationError(
      "summary.catalogExposureTokenSum must be a non-negative integer",
    );
  }

  // Row validation & Accounting verification
  const rows = evidence.calibrationRows;
  let computedEquivalentCount = 0;
  let computedCatalogExposureSum = 0;
  let computedTokenSavingsNet = 0;
  let boundIdentity = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") {
      throw new SavingsProofValidationError(
        `Calibration row at index ${i} must be a non-null object`,
      );
    }

    if (!row.rowId || typeof row.rowId !== "string") {
      throw new SavingsProofValidationError(`Row at index ${i} is missing 'rowId'`);
    }

    if (!row.workloadId || typeof row.workloadId !== "string") {
      throw new SavingsProofValidationError(`Row '${row.rowId}' is missing 'workloadId'`);
    }

    if (!row.benchmarkId || typeof row.benchmarkId !== "string") {
      throw new SavingsProofValidationError(`Row '${row.rowId}' is missing 'benchmarkId'`);
    }

    if (!row.baselineModel || typeof row.baselineModel !== "string") {
      throw new SavingsProofValidationError(`Row '${row.rowId}' is missing 'baselineModel'`);
    }

    if (!row.candidateModel || typeof row.candidateModel !== "string") {
      throw new SavingsProofValidationError(`Row '${row.rowId}' is missing 'candidateModel'`);
    }

    if (
      !row.runtimeVersion ||
      typeof row.runtimeVersion !== "string" ||
      !EXACT_SEMVER_REGEX.test(row.runtimeVersion)
    ) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid semver 'runtimeVersion': '${row.runtimeVersion}'`,
      );
    }

    if (
      !row.candidateVersion ||
      typeof row.candidateVersion !== "string" ||
      !EXACT_SEMVER_REGEX.test(row.candidateVersion)
    ) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid semver 'candidateVersion': '${row.candidateVersion}'`,
      );
    }

    if (row.candidateVersion !== evidence.toolVersion) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' candidateVersion '${row.candidateVersion}' does not match evidence toolVersion '${evidence.toolVersion}'`,
      );
    }

    if (row.toolId && row.toolId !== evidence.toolId) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' toolId '${row.toolId}' does not match evidence toolId '${evidence.toolId}'`,
      );
    }

    const rowIdentity = {
      baselineModel: row.baselineModel,
      candidateModel: row.candidateModel,
      runtimeVersion: row.runtimeVersion,
    };
    if (boundIdentity === null) {
      boundIdentity = rowIdentity;
    } else if (
      rowIdentity.baselineModel !== boundIdentity.baselineModel ||
      rowIdentity.candidateModel !== boundIdentity.candidateModel ||
      rowIdentity.runtimeVersion !== boundIdentity.runtimeVersion
    ) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' model/runtime identity does not match the evidence bundle`,
      );
    }

    if (!validStatuses.includes(row.status)) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid status '${row.status}'`,
      );
    }

    if (typeof row.isEquivalent !== "boolean") {
      throw new SavingsProofValidationError(`Row '${row.rowId}' is missing boolean 'isEquivalent'`);
    }

    const baselineTotalTokens = row.baselineUsage?.totalTokens;
    const candidateTotalTokens = row.candidateUsage?.totalTokens;
    const baselineTokensMissing = baselineTotalTokens === null || baselineTotalTokens === undefined;
    const candidateTokensMissing =
      candidateTotalTokens === null || candidateTotalTokens === undefined;
    if (
      (!baselineTokensMissing &&
        (typeof baselineTotalTokens !== "number" || baselineTotalTokens < 0)) ||
      (baselineTokensMissing && row.status !== "unavailable")
    ) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid 'baselineUsage.totalTokens'`,
      );
    }
    if (
      (!candidateTokensMissing &&
        (typeof candidateTotalTokens !== "number" || candidateTotalTokens < 0)) ||
      (candidateTokensMissing && row.status !== "unavailable")
    ) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid 'candidateUsage.totalTokens'`,
      );
    }
    const hasCompleteTokenUsage = !baselineTokensMissing && !candidateTokensMissing;

    if (!Number.isInteger(row.catalogExposureTokens) || row.catalogExposureTokens < 0) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid 'catalogExposureTokens'`,
      );
    }
    const exposure = row.catalogExposureTokens;

    if (evidence.status === "measured" && row.status === "unavailable") {
      throw new SavingsProofValidationError(
        `Calibration row '${row.rowId}' has status 'unavailable', which cannot contribute to measured evidence`,
      );
    }

    if (row.digest && !SHA256_HEX_REGEX.test(row.digest.replace(/^sha256:/, ""))) {
      throw new SavingsProofValidationError(
        `Row '${row.rowId}' has invalid digest format: '${row.digest}'`,
      );
    }

    // Correctness-gated Token Accounting per contract:
    computedCatalogExposureSum += exposure;
    if (!hasCompleteTokenUsage) {
      continue;
    }

    // Correctness failures cannot contribute positive usage savings; exposure is always overhead.
    const usageDelta = baselineTotalTokens - candidateTotalTokens;
    const correctnessGatedDelta = row.isEquivalent ? usageDelta : Math.min(0, usageDelta);
    if (row.isEquivalent) {
      computedEquivalentCount++;
    }
    computedTokenSavingsNet += correctnessGatedDelta - exposure;
  }

  // Enforce summary consistency
  if (summary.totalSamples !== rows.length) {
    throw new SavingsProofValidationError(
      `Summary totalSamples mismatch: summary states ${summary.totalSamples} but calibrationRows count is ${rows.length}`,
    );
  }

  if (summary.equivalentSamples !== computedEquivalentCount) {
    throw new SavingsProofValidationError(
      `Summary equivalentSamples mismatch: summary states ${summary.equivalentSamples} but computed equivalent rows count is ${computedEquivalentCount}`,
    );
  }

  if (summary.catalogExposureTokenSum !== computedCatalogExposureSum) {
    throw new SavingsProofValidationError(
      `Summary catalogExposureTokenSum mismatch: summary states ${summary.catalogExposureTokenSum} but computed sum is ${computedCatalogExposureSum}`,
    );
  }

  if (evidence.status !== "unavailable" && summary.tokenSavingsNet !== computedTokenSavingsNet) {
    throw new SavingsProofValidationError(
      `Summary tokenSavingsNet mismatch: summary states ${summary.tokenSavingsNet} but computed net savings is ${computedTokenSavingsNet}`,
    );
  }

  if (evidence.status === "measured") {
    if (rows.length === 0) {
      throw new SavingsProofValidationError(
        "Measured savings evidence must have at least 1 calibration row",
      );
    }
    if (computedEquivalentCount === 0) {
      throw new SavingsProofValidationError(
        "Cannot claim 'measured' savings status when zero calibration samples achieved correctness equivalence",
      );
    }
  }

  return {
    ...evidence,
    evidenceDigest: rawDigest,
  };
}

// ============================================================================
// De-identification & Sanitization
// ============================================================================

/**
 * Removes tenant identifiers from savings evidence and calibration rows.
 * Validates that no prompt texts or sensitive secrets are leaked.
 */
export function deidentifySavingsEvidence(evidence) {
  const deidentified = {
    schemaKind: "resin.v1.savings_evidence",
    schemaVersion: "1.0.0",
    evidenceId: evidence.evidenceId,
    toolId: evidence.toolId,
    toolVersion: evidence.toolVersion,
    status: evidence.status,
    createdAt: evidence.createdAt,
    evidenceDigest: evidence.evidenceDigest,
    summary: {
      status: evidence.summary.status,
      totalSamples: evidence.summary.totalSamples,
      equivalentSamples: evidence.summary.equivalentSamples,
      tokenSavingsNet: evidence.summary.tokenSavingsNet,
      tokenSavingsPercentage: evidence.summary.tokenSavingsPercentage,
      catalogExposureTokenSum: evidence.summary.catalogExposureTokenSum,
      ...(evidence.summary.costSavingsMicroUsdNet !== undefined
        ? { costSavingsMicroUsdNet: evidence.summary.costSavingsMicroUsdNet }
        : {}),
      ...(evidence.summary.confidenceInterval
        ? {
            confidenceInterval: {
              low: evidence.summary.confidenceInterval.low,
              high: evidence.summary.confidenceInterval.high,
              confidenceLevel: evidence.summary.confidenceInterval.confidenceLevel,
            },
          }
        : {}),
    },
    calibrationRows: (evidence.calibrationRows || []).map((row) => {
      const cleanRow = {
        rowId: row.rowId,
        workloadId: row.workloadId,
        benchmarkId: row.benchmarkId,
        baselineModel: row.baselineModel,
        candidateModel: row.candidateModel,
        runtimeVersion: row.runtimeVersion,
        candidateVersion: row.candidateVersion,
        toolId: row.toolId || evidence.toolId,
        baselineUsage: {
          totalTokens: row.baselineUsage.totalTokens,
          ...(row.baselineUsage.inputTokens !== undefined
            ? { inputTokens: row.baselineUsage.inputTokens }
            : {}),
          ...(row.baselineUsage.outputTokens !== undefined
            ? { outputTokens: row.baselineUsage.outputTokens }
            : {}),
          ...(row.baselineUsage.reasoningTokens !== undefined
            ? { reasoningTokens: row.baselineUsage.reasoningTokens }
            : {}),
          ...(row.baselineUsage.cachedInputTokens !== undefined
            ? { cachedInputTokens: row.baselineUsage.cachedInputTokens }
            : {}),
          ...(row.baselineUsage.costMicroUsd !== undefined
            ? { costMicroUsd: row.baselineUsage.costMicroUsd }
            : {}),
          ...(row.baselineUsage.durationMs !== undefined
            ? { durationMs: row.baselineUsage.durationMs }
            : {}),
        },
        candidateUsage: {
          totalTokens: row.candidateUsage.totalTokens,
          ...(row.candidateUsage.inputTokens !== undefined
            ? { inputTokens: row.candidateUsage.inputTokens }
            : {}),
          ...(row.candidateUsage.outputTokens !== undefined
            ? { outputTokens: row.candidateUsage.outputTokens }
            : {}),
          ...(row.candidateUsage.reasoningTokens !== undefined
            ? { reasoningTokens: row.candidateUsage.reasoningTokens }
            : {}),
          ...(row.candidateUsage.cachedInputTokens !== undefined
            ? { cachedInputTokens: row.candidateUsage.cachedInputTokens }
            : {}),
          ...(row.candidateUsage.costMicroUsd !== undefined
            ? { costMicroUsd: row.candidateUsage.costMicroUsd }
            : {}),
          ...(row.candidateUsage.durationMs !== undefined
            ? { durationMs: row.candidateUsage.durationMs }
            : {}),
        },
        catalogExposureTokens: row.catalogExposureTokens,
        isEquivalent: row.isEquivalent,
        status: row.status,
        measuredAt: row.measuredAt,
        digest:
          row.digest ||
          computeSha256(
            canonicalJsonStringify({
              rowId: row.rowId,
              workloadId: row.workloadId,
              benchmarkId: row.benchmarkId,
              baselineModel: row.baselineModel,
              candidateModel: row.candidateModel,
              runtimeVersion: row.runtimeVersion,
              candidateVersion: row.candidateVersion,
              toolId: row.toolId || evidence.toolId,
              baselineUsage: row.baselineUsage,
              candidateUsage: row.candidateUsage,
              catalogExposureTokens: row.catalogExposureTokens,
              isEquivalent: row.isEquivalent,
              status: row.status,
              measuredAt: row.measuredAt,
            }),
          ),
      };
      return cleanRow;
    }),
  };

  assertNoForbiddenRawContent(deidentified, "evidence");
  return deidentified;
}

// ============================================================================
// Canonical Sorting
// ============================================================================

/**
 * Deterministically sorts calibration rows to ensure byte-identical order.
 * Sort order: workloadId ASC -> benchmarkId ASC -> measuredAt ASC -> rowId ASC
 */
export function sortCalibrationRowsCanonically(rows) {
  return [...rows].sort((a, b) => {
    if (a.workloadId !== b.workloadId) {
      return a.workloadId.localeCompare(b.workloadId);
    }
    if (a.benchmarkId !== b.benchmarkId) {
      return a.benchmarkId.localeCompare(b.benchmarkId);
    }
    if (a.measuredAt !== b.measuredAt) {
      return a.measuredAt.localeCompare(b.measuredAt);
    }
    return a.rowId.localeCompare(b.rowId);
  });
}

// ============================================================================
// Proof Generation
// ============================================================================

/**
 * Generates a deterministic, reproducible, de-identified savings proof from V1SavingsEvidence.
 *
 * @param {object} rawEvidence - Exported V1SavingsEvidence object or parsed JSON.
 * @param {object} [options]
 * @param {string} [options.generatedAt] - Deterministic timestamp override (defaults to evidence.createdAt).
 * @returns {{ proof: object, proofJson: string, proofDigest: string, markdown: string }}
 */
export function generateSavingsProof(rawEvidence, options = {}) {
  // 1. Validate incoming evidence
  const validated = validateSavingsEvidence(rawEvidence);

  // 2. De-identify and remove tenant identifiers
  const deidentified = deidentifySavingsEvidence(validated);

  // 3. Canonically sort calibration rows
  const sortedRows = sortCalibrationRowsCanonically(deidentified.calibrationRows);

  // Extract identity attributes from rows or evidence
  const primaryRow = sortedRows[0] || null;
  const candidateModel = primaryRow ? primaryRow.candidateModel : "unknown";
  const baselineModel = primaryRow ? primaryRow.baselineModel : "unknown";
  const runtimeVersion = primaryRow ? primaryRow.runtimeVersion : "unknown";

  // 4. Construct canonical Proof object
  const deterministicTimestamp = options.generatedAt || validated.createdAt;
  const sourceEvidenceDigest = validated.evidenceDigest.replace(/^sha256:/, "");

  const proof = {
    schemaKind: "resin.v1.savings_proof",
    schemaVersion: "1.0.0",
    proofId: computeSha256(`${sourceEvidenceDigest}:${validated.toolId}:${validated.toolVersion}`),
    sourceEvidenceId: validated.evidenceId,
    sourceEvidenceDigest,
    toolId: validated.toolId,
    toolVersion: validated.toolVersion,
    candidateModel,
    baselineModel,
    runtimeVersion,
    candidateVersion: validated.toolVersion,
    status: validated.status,
    summary: {
      status: validated.summary.status,
      totalSamples: validated.summary.totalSamples,
      equivalentSamples: validated.summary.equivalentSamples,
      tokenSavingsNet: validated.summary.tokenSavingsNet,
      tokenSavingsPercentage: validated.summary.tokenSavingsPercentage,
      catalogExposureTokenSum: validated.summary.catalogExposureTokenSum,
      ...(validated.summary.costSavingsMicroUsdNet !== undefined
        ? { costSavingsMicroUsdNet: validated.summary.costSavingsMicroUsdNet }
        : {}),
      ...(validated.summary.confidenceInterval
        ? {
            confidenceInterval: {
              low: validated.summary.confidenceInterval.low,
              high: validated.summary.confidenceInterval.high,
              confidenceLevel: validated.summary.confidenceInterval.confidenceLevel,
            },
          }
        : {}),
    },
    calibrationRows: sortedRows,
    generatedAt: deterministicTimestamp,
  };

  // 5. Deterministic canonical JSON serialization
  const proofJson = canonicalJsonStringify(proof);

  // 6. SHA-256 Digest of canonical proof
  const proofDigest = computeSha256(proofJson);

  // 7. Deterministic Markdown Report
  const markdown = formatSavingsProofMarkdown(proof, proofDigest);

  return {
    proof,
    proofJson,
    proofDigest,
    markdown,
  };
}

/**
 * Formats deterministic, reproducible Markdown documentation of the savings proof.
 */
export function formatSavingsProofMarkdown(proof, proofDigest) {
  const lines = [];

  lines.push("# Resin V1 Truthful Savings Proof");
  lines.push("");
  lines.push(
    "Deterministic, provider-reported, correctness-gated calibration proof generated without running prompts.",
  );
  lines.push("");

  lines.push("## Target & Candidate Identity");
  lines.push("");
  lines.push(`- **Tool ID:** \`${proof.toolId}\``);
  lines.push(`- **Tool Version:** \`${proof.toolVersion}\``);
  lines.push(`- **Candidate Model:** \`${proof.candidateModel}\``);
  lines.push(`- **Baseline Model:** \`${proof.baselineModel}\``);
  lines.push(`- **Runtime Version:** \`${proof.runtimeVersion}\``);
  lines.push(`- **Calibration Status:** \`${proof.status.toUpperCase()}\``);
  lines.push(`- **Proof SHA-256:** \`sha256:${proofDigest}\``);
  lines.push(`- **Source Evidence Digest:** \`sha256:${proof.sourceEvidenceDigest}\``);
  lines.push(`- **Proof Generated At:** \`${proof.generatedAt}\``);
  lines.push("");

  lines.push("## Calibration Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| :--- | :--- |");
  lines.push(`| Status | \`${proof.summary.status}\` |`);
  lines.push(`| Total Qualification Samples | ${proof.summary.totalSamples} |`);
  lines.push(`| Equivalent Samples | ${proof.summary.equivalentSamples} |`);
  if (typeof proof.summary.tokenSavingsNet === "number") {
    lines.push(
      `| Net Token Savings | ${proof.summary.tokenSavingsNet > 0 ? "+" : ""}${proof.summary.tokenSavingsNet.toLocaleString()} tokens |`,
    );
    lines.push(
      `| Token Savings Percentage | ${proof.summary.tokenSavingsPercentage.toFixed(2)}% |`,
    );
  } else {
    lines.push("| Net Token Savings | N/A (unavailable) |");
    lines.push("| Token Savings Percentage | N/A (unavailable) |");
  }
  lines.push(
    `| Catalog Exposure Tokens | ${proof.summary.catalogExposureTokenSum.toLocaleString()} tokens |`,
  );

  if (proof.summary.costSavingsMicroUsdNet !== undefined) {
    const costUsd = (proof.summary.costSavingsMicroUsdNet / 1_000_000).toFixed(4);
    lines.push(`| Estimated Cost Savings | $${costUsd} USD |`);
  }

  if (proof.summary.confidenceInterval) {
    const { low, high, confidenceLevel } = proof.summary.confidenceInterval;
    lines.push(
      `| ${(confidenceLevel * 100).toFixed(0)}% Confidence Interval | [${low.toFixed(2)}%, ${high.toFixed(2)}%] |`,
    );
  }
  lines.push("");

  lines.push("## Held-Out Calibration Rows");
  lines.push("");

  if (!proof.calibrationRows || proof.calibrationRows.length === 0) {
    lines.push("*No held-out calibration rows recorded (status is unavailable or preliminary).*");
  } else {
    lines.push(
      "| Workload | Benchmark | Baseline Tokens | Candidate Tokens | Exposure | Net Savings | Equiv? | Status | Row Digest |",
    );
    lines.push("| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |");

    for (const row of proof.calibrationRows) {
      const bTokens = row.baselineUsage.totalTokens;
      const cTokens = row.candidateUsage.totalTokens;
      const exposure = row.catalogExposureTokens;
      const netTokens = bTokens - (cTokens + exposure);
      const netStr = netTokens > 0 ? `+${netTokens}` : `${netTokens}`;
      const equivStr = row.isEquivalent ? "Yes" : "No";
      const shortDigest = row.digest
        ? `${row.digest.replace(/^sha256:/, "").slice(0, 12)}...`
        : "n/a";

      lines.push(
        `| \`${row.workloadId}\` | \`${row.benchmarkId}\` | ${bTokens} | ${cTokens} | ${exposure} | ${netStr} | ${equivStr} | \`${row.status}\` | \`${shortDigest}\` |`,
      );
    }
  }
  lines.push("");

  lines.push("## Verification & Reproducibility");
  lines.push("");
  lines.push(
    "This proof was generated deterministically from provider-reported trajectory observations without executing prompts.",
  );
  lines.push("To verify and reproduce byte-for-byte:");
  lines.push("```bash");
  lines.push("pnpm savings:proof <path-to-v1-savings-evidence.json>");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function runCli() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Deterministic Offline Savings Proof Generator

Usage:
  node scripts/generate-savings-proof.mjs <evidence.json> [options]
  cat evidence.json | node scripts/generate-savings-proof.mjs [options]

Options:
  --out-json <path>    Write canonical de-identified proof JSON to path
  --out-md <path>      Write Markdown report to path
  --stdout             Print canonical proof JSON to stdout (default)
  --help, -h           Show this help message
`);
    process.exit(0);
  }

  let inputJson = "";
  let jsonOutPath = null;
  let mdOutPath = null;
  let forceStdout = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-json" && args[i + 1]) {
      jsonOutPath = args[++i];
    } else if (args[i] === "--out-md" && args[i + 1]) {
      mdOutPath = args[++i];
    } else if (args[i] === "--stdout") {
      forceStdout = true;
    } else if (!args[i].startsWith("--") && !inputJson) {
      const filePath = path.resolve(process.cwd(), args[i]);
      if (fs.existsSync(filePath)) {
        inputJson = fs.readFileSync(filePath, "utf8");
      } else {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }
    }
  }

  if (!inputJson) {
    if (!process.stdin.isTTY) {
      // Read from stdin
      inputJson = await new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          data += chunk;
        });
        process.stdin.on("end", () => {
          resolve(data);
        });
        process.stdin.on("error", reject);
      });
    }
  }

  if (!inputJson.trim()) {
    console.error("Error: No savings evidence input provided via argument or stdin.");
    process.exit(1);
  }

  try {
    const rawData = JSON.parse(inputJson);
    const result = generateSavingsProof(rawData);

    if (jsonOutPath) {
      const resolved = path.resolve(process.cwd(), jsonOutPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, result.proofJson, "utf8");
      console.error(`Wrote canonical proof JSON to ${resolved}`);
    }

    if (mdOutPath) {
      const resolved = path.resolve(process.cwd(), mdOutPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, result.markdown, "utf8");
      console.error(`Wrote Markdown report to ${resolved}`);
    }

    if (forceStdout || (!jsonOutPath && !mdOutPath)) {
      console.log(result.proofJson);
    }
    console.error(`SHA-256 Digest: sha256:${result.proofDigest}`);
  } catch (err) {
    console.error(`Savings proof generation failed: ${err.message}`);
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  runCli().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
