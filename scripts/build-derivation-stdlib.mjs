#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(currentFile), "..");

const METADATA_PATH = "packages/runtime/src/workflow/derivation-assets.json";
const RUNTIME_PACKAGE_PATH = "packages/runtime/package.json";
const OUTPUT_PATH = "packages/runtime/dist/workflow/python_stdlib.zip";

// Deterministic recipe: keep every source entry, add an unchecked-hash .pyc beside each module.
const COMPILE_STDLIB = `
import zipfile, importlib.util, importlib._bootstrap_external
with zipfile.ZipFile('/lib/python314.zip') as source:
    with zipfile.ZipFile('/tmp/precompiled-stdlib.zip', 'w') as output:
        for entry in source.infolist():
            data = source.read(entry)
            output.writestr(entry, data)
            if not entry.filename.endswith('.py'):
                continue
            code = compile(data, '/lib/python314.zip/' + entry.filename, 'exec', dont_inherit=True, optimize=0)
            bytecode = importlib._bootstrap_external._code_to_hash_pyc(code, importlib.util.source_hash(data), checked=False)
            compiled = zipfile.ZipInfo(entry.filename + 'c', (1980, 1, 1, 0, 0, 0))
            compiled.compress_type = zipfile.ZIP_DEFLATED
            compiled.create_system = 3
            compiled.external_attr = 0o100644 << 16
            output.writestr(compiled, bytecode)
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** Resolves the installed Pyodide and verifies it is the exact pinned release before any of it executes. */
function verifyPinnedPyodide(rootDir) {
  const runtimePackagePath = path.resolve(rootDir, RUNTIME_PACKAGE_PATH);
  const metadata = readJson(path.resolve(rootDir, METADATA_PATH));
  const pinnedVersion = readJson(runtimePackagePath).dependencies?.pyodide;
  if (typeof pinnedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(pinnedVersion)) {
    throw new Error("The runtime package must pin an exact pyodide dependency.");
  }

  const requireFromRuntime = createRequire(runtimePackagePath);
  const pyodidePackagePath = requireFromRuntime.resolve("pyodide/package.json");
  const installedVersion = readJson(pyodidePackagePath).version;
  if (installedVersion !== pinnedVersion) {
    throw new Error(
      `Installed pyodide ${installedVersion} does not match pinned ${pinnedVersion}.`,
    );
  }

  const indexDir = path.dirname(pyodidePackagePath);
  const sources = Object.entries(metadata.sources ?? {});
  if (sources.length === 0) {
    throw new Error("Derivation asset metadata lists no pinned sources.");
  }
  for (const [name, expected] of sources) {
    const actual = sha256(fs.readFileSync(path.join(indexDir, name)));
    if (actual !== expected) {
      throw new Error(`Pinned Pyodide asset ${name} has digest ${actual}, expected ${expected}.`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(metadata.compiledStdlibSha256 ?? "")) {
    throw new Error("Derivation asset metadata lacks a compiled stdlib digest.");
  }
  return { indexDir, expectedSha256: metadata.compiledStdlibSha256 };
}

async function compileStdlib(indexDir) {
  const { loadPyodide } = await import(pathToFileURL(path.join(indexDir, "pyodide.mjs")).href);
  const pyodide = await loadPyodide({
    indexURL: `${indexDir}${path.sep}`,
    env: { PYTHONHASHSEED: "0" },
    packages: [],
  });
  pyodide.runPython(COMPILE_STDLIB);
  return Buffer.from(pyodide.FS.readFile("/tmp/precompiled-stdlib.zip"));
}

export async function buildDerivationStdlib(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? repositoryRoot);
  const outputPath = path.resolve(rootDir, OUTPUT_PATH);
  const { indexDir, expectedSha256 } = verifyPinnedPyodide(rootDir);

  if (fs.existsSync(outputPath) && sha256(fs.readFileSync(outputPath)) === expectedSha256) {
    return { outputPath, reused: true };
  }

  const bytes = await compileStdlib(indexDir);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`Compiled stdlib digest ${actual} does not match expected ${expectedSha256}.`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return { outputPath, reused: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  try {
    const result = await buildDerivationStdlib();
    process.stdout.write(
      `${result.reused ? "Reused" : "Wrote"} precompiled derivation stdlib at ${result.outputPath}.\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to build derivation stdlib: ${message}\n`);
    process.exitCode = 1;
  }
}
