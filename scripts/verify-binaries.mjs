#!/usr/bin/env node

/**
 * Resin Binary Smoke Verification Tool
 *
 * Validates:
 * 1. Existence and integrity of all built binary entry points across workspace packages.
 * 2. Package manifest (`package.json`) "bin" declaration alignment.
 * 3. Shebang integrity (`#!/usr/bin/env node`).
 * 4. Successful execution of smoke test commands (`--help`) with zero exit codes and expected outputs.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {Object} BinarySpec
 * @property {string} packageName - NPM package name
 * @property {string} packageDir - Relative directory path of package
 * @property {string} binKey - Key name in package.json "bin" field
 * @property {string} binPath - Relative path to the compiled JS binary
 * @property {string[]} testArgs - CLI arguments for smoke verification
 * @property {RegExp} expectedOutputPattern - Regex pattern that stdout must match
 */

/** @type {BinarySpec[]} */
export const BINARY_SPECS = [
  {
    packageName: "resin",
    packageDir: "apps/cli",
    binKey: "resin",
    binPath: "apps/cli/bin/resin.mjs",
    testArgs: ["--help"],
    expectedOutputPattern: /Resin CLI/i,
  },
  {
    packageName: "@resin/observer",
    packageDir: "apps/observer",
    binKey: "resin-daemon",
    binPath: "apps/observer/bin/daemon.mjs",
    testArgs: ["--help"],
    expectedOutputPattern: /Resin Daemon/i,
  },
  {
    packageName: "@resin/gateway",
    packageDir: "apps/gateway",
    binKey: "resin-mcp",
    binPath: "apps/gateway/bin/mcp-shim.mjs",
    testArgs: ["--help"],
    expectedOutputPattern: /Resin MCP Shim/i,
  },
  {
    packageName: "@resin/test-fixtures",
    packageDir: "fixtures/test-fixtures",
    binKey: "resin-conformance",
    binPath: "fixtures/test-fixtures/bin/conformance.mjs",
    testArgs: ["--help"],
    expectedOutputPattern: /Conformance Runner/i,
  },
];

/**
 * @typedef {Object} VerifyResult
 * @property {BinarySpec} spec
 * @property {"pass" | "fail"} status
 * @property {string} [output]
 * @property {string} [error]
 */

/**
 * Verifies all specified binary entry points.
 *
 * @param {Object} [options]
 * @param {string} [options.rootDir] - Root directory of the repository
 * @param {BinarySpec[]} [options.specs] - Binary specifications to check
 * @returns {Promise<{ success: boolean, results: VerifyResult[], errors: string[] }>}
 */
export async function verifyBinaries(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const specs = options.specs || BINARY_SPECS;
  const results = [];
  const errors = [];

  for (const spec of specs) {
    const pkgJsonPath = path.join(rootDir, spec.packageDir, "package.json");
    const fullBinPath = path.join(rootDir, spec.binPath);

    // 1. Verify package.json exists and has bin declaration
    if (!fs.existsSync(pkgJsonPath)) {
      const msg = `Package manifest not found for ${spec.packageName}: ${spec.packageDir}/package.json`;
      errors.push(msg);
      results.push({ spec, status: "fail", error: msg });
      continue;
    }

    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const binField = pkgJson.bin;

      if (!binField) {
        throw new Error(`Package ${spec.packageName} is missing "bin" field in package.json`);
      }

      let declaredBinRelative = "";
      if (typeof binField === "string") {
        declaredBinRelative = binField;
      } else if (typeof binField === "object" && binField !== null) {
        if (!binField[spec.binKey]) {
          throw new Error(`Package ${spec.packageName} "bin" field missing key "${spec.binKey}"`);
        }
        declaredBinRelative = binField[spec.binKey];
      } else {
        throw new Error(`Invalid "bin" declaration in ${spec.packageName}/package.json`);
      }

      const expectedFull = path.resolve(rootDir, spec.binPath);
      const declaredFull = path.resolve(rootDir, spec.packageDir, declaredBinRelative);
      if (expectedFull !== declaredFull) {
        throw new Error(
          `Bin path mismatch in ${spec.packageName}: package.json points to ${declaredBinRelative}, expected ${spec.binPath}`,
        );
      }
    } catch (err) {
      const msg = `Manifest validation failed for ${spec.packageName}: ${err.message}`;
      errors.push(msg);
      results.push({ spec, status: "fail", error: msg });
      continue;
    }

    // 2. Verify binary file existence on disk
    if (!fs.existsSync(fullBinPath)) {
      const msg = `Compiled binary not found for ${spec.packageName}: ${spec.binPath}. Run 'pnpm run build' first.`;
      errors.push(msg);
      results.push({ spec, status: "fail", error: msg });
      continue;
    }
    // 3. Verify shebang
    const content = fs.readFileSync(fullBinPath, "utf-8");
    if (!content.startsWith("#!/usr/bin/env node")) {
      const msg = `Binary file ${spec.binPath} missing '#!/usr/bin/env node' shebang header`;
      errors.push(msg);
      results.push({ spec, status: "fail", error: msg });
      continue;
    }

    // 4. Execute smoke test command
    try {
      const smokeEnv = { ...process.env };
      delete smokeEnv.NODE_ENV;
      delete smokeEnv.VITEST;
      const output = execFileSync(process.execPath, [fullBinPath, ...spec.testArgs], {
        encoding: "utf-8",
        timeout: 10000,
        env: smokeEnv,
      });

      if (!spec.expectedOutputPattern.test(output)) {
        throw new Error(
          `Smoke output did not match expected pattern (${spec.expectedOutputPattern}):\n${output.slice(0, 300)}`,
        );
      }

      results.push({ spec, status: "pass", output });
    } catch (err) {
      const msg = `Smoke execution failed for ${spec.packageName} (${spec.binPath} ${spec.testArgs.join(" ")}): ${err.message}`;
      errors.push(msg);
      results.push({ spec, status: "fail", error: msg });
    }
  }

  return {
    success: errors.length === 0,
    results,
    errors,
  };
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  console.log("🔍 Verifying built workspace binary entry points...\n");

  verifyBinaries()
    .then(({ success, results, errors }) => {
      for (const res of results) {
        if (res.status === "pass") {
          console.log(`  ✅ [PASS] ${res.spec.packageName} -> ${res.spec.binPath}`);
        } else {
          console.error(`  ❌ [FAIL] ${res.spec.packageName} -> ${res.spec.binPath}`);
          console.error(`     Reason: ${res.error}\n`);
        }
      }

      if (!success) {
        console.error(`\n❌ Binary verification failed with ${errors.length} error(s).\n`);
        process.exit(1);
      }

      console.log(`\n✨ All ${results.length} binary entry points verified successfully!\n`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Fatal verification error: ${err.message}`);
      process.exit(1);
    });
}
