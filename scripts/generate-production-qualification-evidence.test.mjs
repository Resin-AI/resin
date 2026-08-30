import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateProductionQualificationEvidence } from "./generate-production-qualification-evidence.mjs";
import { resolveReleaseMilestones } from "./generate-release-evidence.mjs";

const COMMIT_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const RUN_IDS = {
  ciRunId: "101",
  platformRunId: "102",
  systemRunId: "103",
  securityRunId: "104",
};
const PLATFORM_STATUSES = {
  "linux-x64": "QUALIFIED",
  "linux-arm64": "QUALIFIED",
  "darwin-x64": "ARTIFACT_VALIDATED",
  "darwin-arm64": "ARTIFACT_VALIDATED",
  wsl: "ARTIFACT_VALIDATED",
};
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-public-qualification-"));
  tempRoots.push(rootDir);

  const suitePaths = new Set(
    resolveReleaseMilestones(rootDir).flatMap((milestone) => milestone.suites),
  );
  for (const suitePath of suitePaths) {
    const filePath = path.join(rootDir, suitePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export {};\n");
  }

  for (const [lane, status] of Object.entries(PLATFORM_STATUSES)) {
    if (lane === options.omitLane) continue;
    writeJson(
      path.join(
        rootDir,
        "dist",
        "upstream-qualification",
        "platform",
        `artifact-${lane}`,
        `${lane}.json`,
      ),
      {
        lane,
        passed: true,
        status,
        execution: { native: status === "QUALIFIED" },
        release: {
          commitSha: COMMIT_SHA,
          assetSha256: lane.padEnd(64, "0").slice(0, 64),
        },
      },
    );
  }

  const systemCommitSha = options.systemCommitSha || COMMIT_SHA;
  writeJson(path.join(rootDir, "dist", "upstream-qualification", "system", "system-e2e.json"), {
    kind: "resin-public-core-system-qualification",
    status: "passed",
    durationMs: 1234,
    commitSha: systemCommitSha,
    release: {
      commitSha: systemCommitSha,
      releaseIdentity: { workflow: { runId: RUN_IDS.systemRunId } },
    },
    suites: ["apps/cli/tests/installer/production-release-transaction.test.ts"],
  });

  return rootDir;
}

function generate(rootDir, options = {}) {
  return generateProductionQualificationEvidence({
    rootDir,
    commitSha: COMMIT_SHA,
    ...RUN_IDS,
    env: {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "Resin-AI/resin",
    },
    ...options,
  });
}

describe("public production qualification evidence", () => {
  it("binds every public gate and suite to the exact release commit", () => {
    const rootDir = createFixture();
    const evidence = generate(rootDir, { outputPath: "dist/qualification/evidence.json" });

    expect(evidence.commitSha).toBe(COMMIT_SHA);
    expect(evidence.qualification.platforms).toMatchObject({
      totalLanes: 5,
      passedLanes: 5,
      qualifiedLanes: 2,
      artifactValidatedLanes: 3,
      runId: RUN_IDS.platformRunId,
      status: "PASSED",
    });
    expect(evidence.qualification.harnesses).toMatchObject({
      totalHarnesses: 3,
      qualifiedHarnesses: 3,
      status: "PASSED",
    });
    expect(evidence.qualification.system).toMatchObject({
      status: "PASSED",
      runId: RUN_IDS.systemRunId,
    });
    expect(evidence.qualification.securityAudit).toMatchObject({
      status: "PASSED",
      runId: RUN_IDS.securityRunId,
    });
    expect(Object.values(evidence.suites).every((suite) => suite.status === "PASSED")).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/cloudStaging|apps\/cloud|operational-evidence/);
    expect(fs.existsSync(path.join(rootDir, "dist", "qualification", "evidence.json"))).toBe(true);
  });

  it("rejects incomplete platform evidence", () => {
    const rootDir = createFixture({ omitLane: "wsl" });
    expect(() => generate(rootDir)).toThrow("Missing qualification evidence for platform 'wsl'");
  });

  it("rejects system evidence from a different commit", () => {
    const rootDir = createFixture({ systemCommitSha: "b".repeat(40) });
    expect(() => generate(rootDir)).toThrow(
      `System qualification evidence is not bound to '${COMMIT_SHA}'`,
    );
  });
});
