#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadTrustedReleaseKeysFromEnv } from "./release-trust.mjs";

export function embedCliReleaseTrust(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const env = options.env || process.env;
  const activeKeyId =
    Object.prototype.toString.call(env.RESIN_RELEASE_KEY_ID) === "[object String]"
      ? env.RESIN_RELEASE_KEY_ID.trim()
      : "";
  const trusted = loadTrustedReleaseKeysFromEnv(env);

  if (!activeKeyId || !trusted[activeKeyId]) {
    throw new Error(
      `Active release key ID '${activeKeyId}' is missing from loaded trusted release records.`,
    );
  }

  const activeRecord = trusted[activeKeyId];
  const additionalRecords = Object.entries(trusted)
    .filter(([id]) => id !== activeKeyId)
    .map(([, record]) => record);
  const records = [activeRecord, ...additionalRecords];

  if (records.length < 1) {
    throw new Error(
      `Production bootstrap requires at least one active release trust root, found ${records.length}.`,
    );
  }
  const payload = {
    schemaVersion: "2.0.0",
    trustDomain: "production",
    trustedKeys: records,
  };
  const outputPath = path.resolve(rootDir, "apps/cli/dist/release-trust.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outputPath, trustedKeys: records, signingKey: records[0] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = embedCliReleaseTrust();
  const keyIds = result.trustedKeys.map((k) => k.keyId).join(", ");
  console.log(`Embedded production release trust roots '${keyIds}' into ${result.outputPath}.`);
}
