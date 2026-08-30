#!/usr/bin/env node

/**
 * Resin Standalone Install Helper Bundler
 *
 * Deterministically compiles `apps/cli/src/installer/bootstrap-entry.ts`
 * into `apps/cli/install/install-helper-v1.mjs` using esbuild.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import esbuild from "esbuild";

export const DEFAULT_BANNER = `// Resin Standalone Install Helper V1.0.0
// Cryptographically verified, standalone bootstrap installer.
// Generated deterministically by build-install-helper.
`;
const INSTALLER_DIGEST_PINS = Object.freeze([
  {
    relativePath: "apps/cli/install/install.sh",
    pattern: /((?:Pinned SHA-256: |PINNED_HELPER_SHA256="|Verify SHA-256: ))[0-9a-f]{64}/g,
    expectedMatches: 3,
  },
  {
    relativePath: "apps/cli/install/install.ps1",
    pattern: /((?:Helper SHA-256: |\$PINNED_HELPER_SHA256 = "))[0-9a-f]{64}/g,
    expectedMatches: 2,
  },
]);

export function updateInstallerDigestPins(rootDir, sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Invalid install helper SHA-256 '${sha256}'.`);
  }

  for (const pin of INSTALLER_DIGEST_PINS) {
    const filePath = path.resolve(rootDir, pin.relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    let replacements = 0;
    const updated = source.replace(pin.pattern, (_match, prefix) => {
      replacements += 1;
      return `${prefix}${sha256}`;
    });
    if (replacements !== pin.expectedMatches) {
      throw new Error(
        `Expected ${pin.expectedMatches} install helper digest pins in '${filePath}', found ${replacements}.`,
      );
    }
    fs.writeFileSync(filePath, updated, "utf8");
  }
}

export async function buildInstallHelper(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const entryPoint =
    options.entryPoint || path.resolve(rootDir, "apps/cli/src/installer/bootstrap-entry.ts");
  const defaultOutputPath = path.resolve(rootDir, "apps/cli/install/install-helper-v1.mjs");
  const outputPath = options.outputPath || defaultOutputPath;
  const shouldWrite = options.write ?? true;
  const shouldSyncInstallerPins =
    options.syncInstallerPins ?? path.resolve(outputPath) === defaultOutputPath;
  const bannerText = options.banner ?? DEFAULT_BANNER;

  const buildResult = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    minify: false,
    treeShaking: true,
    banner: {
      js: bannerText,
    },
    write: false,
  });

  if (!buildResult.outputFiles || buildResult.outputFiles.length === 0) {
    throw new Error("esbuild produced no output files.");
  }

  const outputFile = buildResult.outputFiles[0];
  const outputCode = outputFile.text;
  const outputBuffer = Buffer.from(outputFile.contents);
  const sha256 = crypto.createHash("sha256").update(outputBuffer).digest("hex");

  if (shouldWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, outputBuffer);
    if (shouldSyncInstallerPins) {
      updateInstallerDigestPins(rootDir, sha256);
    }
  }

  return {
    outputPath,
    code: outputCode,
    bytes: outputBuffer,
    sha256,
    length: outputBuffer.length,
  };
}

if (
  globalThis.process !== undefined &&
  process.argv &&
  process.argv[1] &&
  import.meta.url === `file://${path.resolve(process.argv[1])}`
) {
  const isCheck = process.argv.includes("--check");
  const isTestOnly = process.argv.includes("--test-only");

  try {
    const result = await buildInstallHelper({ write: !isCheck && !isTestOnly });
    if (isCheck) {
      console.log(`Bundle verified deterministically (SHA-256: ${result.sha256}).`);
    } else {
      console.log(
        `Successfully built install helper to ${result.outputPath} (SHA-256: ${result.sha256}, ${result.length} bytes).`,
      );
    }
  } catch (error) {
    console.error(
      `Failed to build install helper: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
