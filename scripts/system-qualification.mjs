#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const SYSTEM_QUALIFICATION_SUITES = Object.freeze([
  "apps/cli/tests/installer/production-release-transaction.test.ts",
  "apps/cli/tests/installer/signed-channel-verifier.test.ts",
  "apps/cli/tests/installer/packaged-cli-production-http.test.ts",
]);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release-dir") options.releaseDir = argv[++index];
    else if (arg.startsWith("--release-dir=")) options.releaseDir = arg.slice(14);
    else if (arg === "--output") options.output = argv[++index];
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg === "--commit-sha") options.commitSha = argv[++index];
    else if (arg.startsWith("--commit-sha=")) options.commitSha = arg.slice(13);
    else if (arg === "--test-only") options.testOnly = true;
    else if (arg === "--production") options.production = true;
  }
  return options;
}

export function collectReleaseBinding(releaseDir) {
  const manifestPath = path.join(releaseDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = Object.entries(manifest.assets ?? {});

  const assets = {};
  for (const [id, asset] of entries) {
    const assetPath = path.join(releaseDir, asset.filename);
    if (!fs.existsSync(assetPath)) {
      throw new Error(`Missing release asset ${id}: ${asset.filename}`);
    }
    const actualSha256 = sha256File(assetPath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        `Release asset digest mismatch for ${id}: expected ${asset.sha256}, got ${actualSha256}`,
      );
    }
    assets[id] = {
      filename: asset.filename,
      sha256: actualSha256,
      sizeBytes: fs.statSync(assetPath).size,
    };
  }

  return {
    version: manifest.version,
    commitSha: manifest.releaseIdentity?.commitSha ?? null,
    manifestSha256: sha256File(manifestPath),
    releaseIdentity: manifest.releaseIdentity ?? null,
    trust: manifest.trust ?? null,
    assets,
  };
}

export function runSystemQualification(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const releaseDir = path.resolve(rootDir, options.releaseDir ?? "dist/release/v1.0.3");
  const outputPath = path.resolve(rootDir, options.output ?? "dist/qualification/system-e2e.json");
  const suites = options.suites ?? SYSTEM_QUALIFICATION_SUITES;
  const release = collectReleaseBinding(releaseDir);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const testOnly =
    options.testOnly === true ||
    (!options.production && process.env.RESIN_RELEASE_TEST_ONLY === "1");

  if (!testOnly) {
    if (process.env.RESIN_RELEASE_TEST_ONLY === "1") {
      throw new Error("Production qualification cannot run with RESIN_RELEASE_TEST_ONLY=1");
    }
    const trustDomain = release.releaseIdentity?.trustDomain ?? release.trust?.trustDomain;
    if (trustDomain === "test") {
      throw new Error(
        "Production qualification requires a production-signed release candidate, found test trust domain",
      );
    }
  }

  if (!/^[0-9a-f]{40}$/i.test(release.commitSha ?? "")) {
    throw new Error(`Qualification release commit is invalid: ${release.commitSha}`);
  }
  const expectedCommitSha =
    options.commitSha ?? process.env.RESIN_RELEASE_SHA ?? process.env.GITHUB_SHA;
  if (expectedCommitSha && expectedCommitSha.toLowerCase() !== release.commitSha.toLowerCase()) {
    throw new Error(
      `Release commit SHA mismatch for full-system qualification: expected ${expectedCommitSha}, got ${release.commitSha}`,
    );
  }

  for (const suite of suites) {
    if (!fs.existsSync(path.join(rootDir, suite))) {
      throw new Error(`Missing system qualification suite: ${suite}`);
    }
  }

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const run = options.spawnSync ?? spawnSync;
  const env = {
    ...process.env,
    RESIN_RELEASE_DIR: releaseDir,
  };
  if (testOnly) {
    env.RESIN_RELEASE_TEST_ONLY = "1";
  }
  const result = run(
    command,
    ["exec", "vitest", "run", "--testTimeout=60000", "--hookTimeout=60000", ...suites],
    {
      cwd: rootDir,
      env,
      encoding: "utf8",
      timeout: 20 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `System qualification suites failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }

  const evidence = {
    schemaVersion: 1,
    kind: "resin-public-core-system-qualification",
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    commitSha: release.commitSha,
    release,
    suites,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      nodeVersion: process.version,
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`System qualification passed; evidence: ${outputPath}\n`);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runSystemQualification(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
