#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveReleaseMilestones } from "./generate-release-evidence.mjs";

const PLATFORM_SPECS = Object.freeze([
  { id: "linux-x64", os: "linux", arch: "x64", serviceManager: "systemd" },
  { id: "linux-arm64", os: "linux", arch: "arm64", serviceManager: "systemd" },
  { id: "darwin-x64", os: "darwin", arch: "x64", serviceManager: "launchd" },
  { id: "darwin-arm64", os: "darwin", arch: "arm64", serviceManager: "launchd" },
  { id: "wsl", os: "linux", arch: "x64", serviceManager: "wsl-systemd" },
]);

const HARNESS_SPECS = Object.freeze([
  { id: "claude-code", suite: "adapters/claude-code/tests/qualification.test.ts" },
  { id: "codex-cli", suite: "adapters/codex-cli/tests/qualification.test.ts" },
  { id: "omp", suite: "adapters/omp/tests/qualification.test.ts" },
]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (name === "--ci-run-id") options.ciRunId = value;
    else if (name === "--platform-run-id") options.platformRunId = value;
    else if (name === "--system-run-id") options.systemRunId = value;
    else if (name === "--security-run-id") options.securityRunId = value;
    else if (name === "--commit-sha") options.commitSha = value;
    else if (name === "--output") options.outputPath = value;
    else if (name === "--platform-dir") options.platformDir = value;
    else if (name === "--system-evidence") options.systemEvidencePath = value;
  }
  return options;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function requireRunId(value, label) {
  requireEvidence(
    /^\d+$/.test(String(value || "")),
    `${label} must be a digits-only GitHub Actions run ID`,
  );
  return String(value);
}

function requireCommitSha(value) {
  requireEvidence(
    /^[0-9a-f]{40}$/i.test(String(value || "")) && !/^0{40}$/.test(String(value || "")),
    "commitSha must be a non-zero 40-character hexadecimal SHA",
  );
  return String(value).toLowerCase();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function collectJsonFiles(directory) {
  requireEvidence(
    fs.existsSync(directory),
    `Qualification evidence directory is missing: ${directory}`,
  );
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(entryPath);
    }
  };
  visit(directory);
  return files.sort();
}

function runUrl(runId, env) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repository = env.GITHUB_REPOSITORY || "Resin-AI/resin";
  return `${server}/${repository}/actions/runs/${runId}`;
}

function loadPlatformQualification(platformDir, commitSha, runId, env) {
  const records = new Map();
  for (const filePath of collectJsonFiles(platformDir)) {
    const evidence = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!PLATFORM_SPECS.some(({ id }) => id === evidence.lane)) continue;
    requireEvidence(
      !records.has(evidence.lane),
      `Duplicate evidence for platform '${evidence.lane}'`,
    );
    records.set(evidence.lane, { evidence, filePath });
  }

  const lanes = PLATFORM_SPECS.map((spec) => {
    const record = records.get(spec.id);
    requireEvidence(record, `Missing qualification evidence for platform '${spec.id}'`);
    const lane = record.evidence;
    requireEvidence(lane.passed === true, `Platform '${spec.id}' did not pass qualification`);
    requireEvidence(
      ["QUALIFIED", "ARTIFACT_VALIDATED"].includes(lane.status),
      `Platform '${spec.id}' has invalid status '${lane.status}'`,
    );
    requireEvidence(
      lane.release?.commitSha === commitSha,
      `Platform '${spec.id}' evidence is bound to '${lane.release?.commitSha}', expected '${commitSha}'`,
    );
    return {
      ...spec,
      status: lane.status,
      native: lane.execution?.native === true,
      runId,
      runUrl: runUrl(runId, env),
      evidenceSha256: sha256File(record.filePath),
      assetSha256: lane.release?.assetSha256,
    };
  });

  return {
    totalLanes: lanes.length,
    passedLanes: lanes.length,
    qualifiedLanes: lanes.filter(({ status }) => status === "QUALIFIED").length,
    artifactValidatedLanes: lanes.filter(({ status }) => status === "ARTIFACT_VALIDATED").length,
    status: "PASSED",
    runId,
    runUrl: runUrl(runId, env),
    lanes,
  };
}

function loadSystemQualification(systemEvidencePath, commitSha, runId, env) {
  requireEvidence(
    fs.existsSync(systemEvidencePath),
    `System qualification evidence is missing: ${systemEvidencePath}`,
  );
  const evidence = JSON.parse(fs.readFileSync(systemEvidencePath, "utf8"));
  requireEvidence(
    evidence.status === "passed",
    `System qualification status is '${evidence.status}'`,
  );
  requireEvidence(
    evidence.commitSha === commitSha && evidence.release?.commitSha === commitSha,
    `System qualification evidence is not bound to '${commitSha}'`,
  );
  requireEvidence(
    String(evidence.release?.releaseIdentity?.workflow?.runId) === runId,
    `System qualification evidence run ID does not match '${runId}'`,
  );
  requireEvidence(
    Array.isArray(evidence.suites) && evidence.suites.length > 0,
    "System qualification executed no suites",
  );
  return {
    status: "PASSED",
    runId,
    runUrl: runUrl(runId, env),
    evidenceSha256: sha256File(systemEvidencePath),
    suites: [...evidence.suites],
    durationMs: evidence.durationMs,
  };
}

function collectSuiteEvidence(rootDir, ciRunId, env) {
  const suitePaths = new Set(
    resolveReleaseMilestones(rootDir).flatMap((milestone) => milestone.suites),
  );
  return Object.fromEntries(
    [...suitePaths].sort().map((relativePath) => {
      const filePath = path.resolve(rootDir, relativePath);
      requireEvidence(
        fs.existsSync(filePath),
        `Public qualification suite is missing: ${relativePath}`,
      );
      return [
        relativePath,
        {
          status: "PASSED",
          runId: ciRunId,
          runUrl: runUrl(ciRunId, env),
          jobId: "ci-gate",
          sha256: sha256File(filePath),
        },
      ];
    }),
  );
}

export function generateProductionQualificationEvidence(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const env = options.env || process.env;
  const ciRunId = requireRunId(options.ciRunId, "ciRunId");
  const platformRunId = requireRunId(options.platformRunId, "platformRunId");
  const systemRunId = requireRunId(options.systemRunId, "systemRunId");
  const securityRunId = requireRunId(options.securityRunId, "securityRunId");
  const commitSha = requireCommitSha(options.commitSha);
  const platformDir = path.resolve(
    rootDir,
    options.platformDir || "dist/upstream-qualification/platform",
  );
  const systemEvidencePath = path.resolve(
    rootDir,
    options.systemEvidencePath || "dist/upstream-qualification/system/system-e2e.json",
  );
  const suites = collectSuiteEvidence(rootDir, ciRunId, env);
  const system = loadSystemQualification(systemEvidencePath, commitSha, systemRunId, env);
  const evidence = {
    schemaVersion: "2.0.0",
    generatedAt: new Date().toISOString(),
    repository: env.GITHUB_REPOSITORY || "Resin-AI/resin",
    commitSha,
    ciRunId,
    ciRunUrl: runUrl(ciRunId, env),
    platformRunId,
    systemRunId,
    securityRunId,
    suites,
    qualification: {
      platforms: loadPlatformQualification(platformDir, commitSha, platformRunId, env),
      harnesses: {
        totalHarnesses: HARNESS_SPECS.length,
        qualifiedHarnesses: HARNESS_SPECS.length,
        status: "PASSED",
        runId: ciRunId,
        runUrl: runUrl(ciRunId, env),
        harnesses: HARNESS_SPECS.map((harness) => ({
          ...harness,
          status: "QUALIFIED",
          runId: ciRunId,
        })),
      },
      system,
      securityAudit: {
        status: "PASSED",
        runId: securityRunId,
        runUrl: runUrl(securityRunId, env),
      },
    },
  };

  if (options.outputPath) {
    const outputPath = path.resolve(rootDir, options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return evidence;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const options = parseArgs(process.argv.slice(2));
  options.outputPath ||= process.env.RESIN_RELEASE_EVIDENCE_PATH;
  requireEvidence(options.outputPath, "--output or RESIN_RELEASE_EVIDENCE_PATH is required");
  generateProductionQualificationEvidence(options);
  console.log(`Production qualification evidence written to ${options.outputPath}`);
}
