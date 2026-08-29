#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { RELEASE_VERSION } from "./package-release.mjs";
import { verifyRelease } from "./verify-release.mjs";

function parseArgs(argv) {
  const options = {
    allowTestEvidence: false,
    requireProductionKeys: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--test-only") {
      options.allowTestEvidence = true;
    } else if (arg === "--require-production-keys" || arg === "--production") {
      options.requireProductionKeys = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--release-dir") {
      options.releaseDir = argv[++i];
    } else if (arg.startsWith("--release-dir=")) {
      options.releaseDir = arg.slice("--release-dir=".length);
    } else if (arg === "--root-dir") {
      options.rootDir = argv[++i];
    } else if (arg.startsWith("--root-dir=")) {
      options.rootDir = arg.slice("--root-dir=".length);
    } else if (arg === "--commit-sha") {
      options.expectedCommitSha = argv[++i];
    } else if (arg.startsWith("--commit-sha=")) {
      options.expectedCommitSha = arg.slice("--commit-sha=".length);
    }
  }

  if (process.env.RESIN_RELEASE_TEST_ONLY === "1") {
    options.allowTestEvidence = true;
  }

  return options;
}

const cliOptions = parseArgs(process.argv.slice(2));
const rootDir = cliOptions.rootDir || process.cwd();
const releaseDir =
  cliOptions.releaseDir || path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);

const result = verifyRelease({
  rootDir,
  releaseDir,
  allowTestEvidence: cliOptions.allowTestEvidence,
  expectedCommitSha: cliOptions.expectedCommitSha,
});

if (cliOptions.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  if (result.valid) {
    console.log("✅ Release verification passed successfully.");
    console.log(`   Packages verified: ${result.stats.packagesCount}`);
    console.log(`   Platforms verified: ${result.stats.platformsCount}`);
    console.log(`   SBOM components: ${result.stats.sbomComponentsCount}`);
  } else {
    console.error(`❌ Release verification failed with ${result.violations.length} violation(s):`);
    for (const v of result.violations) {
      console.error(`   [${v.rule}] ${v.file ? `${v.file}: ` : ""}${v.message}`);
    }
  }
}

if (!result.valid) {
  process.exit(1);
}
