#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(currentFile), "..");

async function loadCompiledTrustRecord(rootDir) {
  const trustRecordModulePath = path.resolve(rootDir, "apps/cli/dist/release-trust.js");
  const releaseClientPath = path.resolve(rootDir, "apps/cli/dist/installer/release-client.js");
  if (!fs.existsSync(trustRecordModulePath) || !fs.existsSync(releaseClientPath)) {
    throw new Error("The compiled CLI is unavailable. Run the TypeScript build first.");
  }

  const [trustRecordModule, releaseClient] = await Promise.all([
    import(pathToFileURL(trustRecordModulePath).href),
    import(pathToFileURL(releaseClientPath).href),
  ]);
  if (!trustRecordModule.PRODUCTION_RELEASE_TRUST_RECORD) {
    throw new Error("The compiled CLI does not export its production release trust record.");
  }
  if (!(releaseClient.parseBundledReleaseTrust instanceof Function)) {
    throw new Error("The compiled CLI does not export its release trust validator.");
  }

  return {
    trustRecord: trustRecordModule.PRODUCTION_RELEASE_TRUST_RECORD,
    validateTrustRecord: releaseClient.parseBundledReleaseTrust,
  };
}

export async function writeCliBundledReleaseTrust(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? repositoryRoot);
  let trustRecord = options.trustRecord;
  let validateTrustRecord = options.validateTrustRecord;

  if (trustRecord === undefined || validateTrustRecord === undefined) {
    const compiledTrust = await loadCompiledTrustRecord(rootDir);
    trustRecord ??= compiledTrust.trustRecord;
    validateTrustRecord ??= compiledTrust.validateTrustRecord;
  }

  validateTrustRecord(trustRecord);
  const outputPath = path.resolve(rootDir, "apps/cli/dist/release-trust.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(trustRecord, null, 2)}\n`, "utf8");
  return { outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  try {
    const result = await writeCliBundledReleaseTrust();
    process.stdout.write(`Wrote bundled CLI release trust to ${result.outputPath}.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to write bundled CLI release trust: ${message}\n`);
    process.exitCode = 1;
  }
}
