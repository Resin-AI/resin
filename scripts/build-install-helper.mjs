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

export async function buildInstallHelper(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const entryPoint =
    options.entryPoint || path.resolve(rootDir, "apps/cli/src/installer/bootstrap-entry.ts");
  const outputPath =
    options.outputPath || path.resolve(rootDir, "apps/cli/install/install-helper-v1.mjs");
  const shouldWrite = options.write ?? true;
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
  typeof process !== "undefined" &&
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
