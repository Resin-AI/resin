/**
 * Runs model-written derivation steps as Python in Pyodide inside Deno. The Deno process may read
 * the pinned local Pyodide assets and nothing else: no network, environment, subprocesses, FFI,
 * system information, writes, or remote and npm imports. A derivation therefore sees only its
 * inputs (templated into its source), and returns the JSON object its final expression evaluates
 * to. Missing Deno or assets, or assets that differ from the pinned release, fail the step.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkflowJsonValue } from "@resin/contracts";
import { resolveDenoExecutable } from "../worker/deno-executable.js";

/** Pinned Pyodide release; must equal the exact `pyodide` dependency of this package. */
export const PYODIDE_VERSION = "314.0.7";

/** SHA-256 of every Pyodide asset a derivation loads, from the pinned release. */
const PYODIDE_ASSET_SHA256: Readonly<Record<string, string>> = {
  "pyodide.mjs": "6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109",
  "pyodide.asm.mjs": "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635",
  "pyodide.asm.wasm": "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6",
  "python_stdlib.zip": "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a",
  "pyodide-lock.json": "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010",
};

/** Modules a derivation may import: pre-imported before the derivation runs. */
export const DERIVATION_MODULES = [
  "json",
  "csv",
  "math",
  "statistics",
  "collections",
  "collections.abc",
  "datetime",
  "_strptime",
  "time",
  "calendar",
  "re",
  "itertools",
  "functools",
  "operator",
  "decimal",
  "fractions",
  "numbers",
  "string",
  "bisect",
  "heapq",
  "copy",
  "unicodedata",
  "textwrap",
  "typing",
  "enum",
  "dataclasses",
] as const;

/** Pre-imported only when the interpreter has them; otherwise simply unavailable. */
const DERIVATION_OPTIONAL_MODULES = ["numpy", "pandas"] as const;

/** Heap bounds for the Deno isolate and Pyodide's WebAssembly memory (64 KiB pages: 2 GiB). */
const DERIVATION_V8_FLAGS = "--max-old-space-size=512,--wasm-max-mem-pages=32768";

export interface DerivationRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Deno executable override; otherwise `resolveDenoExecutable`. */
  denoExecutable?: string;
}

interface PyodideAssets {
  /** Private per-process directory holding verified copies of the assets and the driver. */
  directory: string;
  moduleUrl: string;
  driver: string;
  /** SHA-256 of every file in `directory`, checked before each run. */
  digests: Readonly<Record<string, string>>;
}

let privateAssets: PyodideAssets | undefined;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The Deno entrypoint: compiled JavaScript when packaged, TypeScript when run from source. */
function driverPath(): string {
  const compiled = fileURLToPath(new URL("./derivation-driver.js", import.meta.url));
  return existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL("./derivation-driver.ts", import.meta.url));
}

/**
 * Copies the pinned Pyodide assets, verified against their pins, and the driver into a private
 * (0700) per-process directory, once per process.
 */
function copyAssets(): PyodideAssets {
  const manifest = createRequire(import.meta.url).resolve("pyodide/package.json");
  const source = path.dirname(manifest);
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
  if (version !== PYODIDE_VERSION) {
    throw new Error(`found Pyodide ${String(version)}, expected ${PYODIDE_VERSION}`);
  }
  const directory = mkdtempSync(path.join(tmpdir(), "resin-derivation-"));
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o700);
  const digests: Record<string, string> = {};
  for (const [file, expected] of Object.entries(PYODIDE_ASSET_SHA256)) {
    const target = path.join(directory, file);
    copyFileSync(path.join(source, file), target);
    // The copy is what Deno reads, so the copy is what must match the pin.
    if (sha256(target) !== expected)
      throw new Error(`Pyodide asset '${file}' does not match its pin`);
    digests[file] = expected;
  }
  const driverSource = driverPath();
  const driver = path.join(directory, path.basename(driverSource));
  copyFileSync(driverSource, driver);
  digests[path.basename(driver)] = sha256(driver);
  return {
    directory,
    moduleUrl: pathToFileURL(path.join(directory, "pyodide.mjs")).href,
    driver,
    digests,
  };
}

/**
 * The private copies Deno will read, verified before every run: the directory must still be a
 * private directory and every copy must still hash to what was verified when it was made.
 */
function pyodideAssets(): PyodideAssets {
  try {
    privateAssets ??= copyAssets();
    const assets = privateAssets;
    const stat = lstatSync(assets.directory);
    if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("the private asset directory is not private");
    }
    for (const [file, expected] of Object.entries(assets.digests)) {
      if (sha256(path.join(assets.directory, file)) !== expected) {
        throw new Error(`asset copy '${file}' changed after it was verified`);
      }
    }
    return assets;
  } catch (error) {
    throw new Error(
      `derivation sandbox unavailable: the pinned Pyodide ${PYODIDE_VERSION} assets are missing or altered (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The private directory the derivation sandbox reads from, once a derivation has run. */
export function derivationSandboxDirectory(): string | undefined {
  return privateAssets?.directory;
}

/** Environment Deno itself needs; the sandboxed code cannot read any of it (`--deny-env`). */
function denoEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" };
  for (const name of [
    "HOME",
    "USERPROFILE",
    "DENO_DIR",
    "XDG_CACHE_HOME",
    "SYSTEMROOT",
    "TMPDIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Runs one derivation and returns the JSON object of its final expression. Throws when the
 * sandbox is unavailable, the derivation fails, is refused an import, exceeds its time or output
 * bound, or its final expression is not a JSON object.
 */
export async function runDerivation(
  source: string,
  options: DerivationRunOptions,
): Promise<WorkflowJsonValue> {
  const deno = resolveDenoExecutable(
    options.denoExecutable === undefined ? undefined : { denoExecutable: options.denoExecutable },
  );
  if (deno === undefined) {
    throw new Error(
      "derivation sandbox unavailable: Deno was not found (install Resin's bundled Deno or set RESIN_DENO_EXECUTABLE)",
    );
  }
  const assets = pyodideAssets();
  if (options.signal?.aborted) throw new Error("derivation was cancelled");
  const nonce = randomBytes(16).toString("hex");
  const request = JSON.stringify({
    nonce,
    source,
    modules: DERIVATION_MODULES,
    optionalModules: DERIVATION_OPTIONAL_MODULES,
    maxOutputBytes: options.maxOutputBytes,
  });
  // A result line is at most the escaped JSON of the bounded result plus its envelope.
  const maxStdoutBytes = options.maxOutputBytes * 6 + 4096;
  const args = [
    "run",
    "--quiet",
    "--no-prompt",
    "--no-config",
    "--no-lock",
    "--no-remote",
    "--no-npm",
    `--allow-read=${assets.directory}`,
    "--deny-net",
    "--deny-env",
    "--deny-run",
    "--deny-ffi",
    "--deny-sys",
    "--deny-write",
    "--deny-import",
    `--v8-flags=${DERIVATION_V8_FLAGS}`,
    assets.driver,
    `${assets.directory}${path.sep}`,
    assets.moduleUrl,
  ];
  const { stdout, stderr, exit } = await new Promise<{
    stdout: string;
    stderr: string;
    exit: string | undefined;
  }>((resolve, reject) => {
    const child = spawn(deno, args, {
      cwd: assets.directory,
      env: denoEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let failure: string | undefined;
    const stop = (reason: string): void => {
      failure ??= reason;
      // A child that failed to spawn has no pid; kill() on it would signal an arbitrary process.
      if (child.pid !== undefined) child.kill("SIGKILL");
    };
    const onAbort = (): void => stop("derivation was cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => stop(`derivation exceeded its ${options.timeoutMs}ms time budget and was stopped`),
      options.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdoutBytes) stop("derivation exceeded its output bound");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request, "utf8");
    child.on("error", (error) => {
      failure ??= `derivation sandbox unavailable: Deno could not be started (${error.message})`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure !== undefined) {
        reject(new Error(failure));
        return;
      }
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: err,
        exit: code === 0 ? undefined : `exit ${String(code ?? signal)}`,
      });
    });
  });
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(nonce));
  if (line === undefined) {
    const detail = stderr.trim().slice(-800);
    throw new Error(
      `derivation produced no result (${exit ?? "exit 0"})${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
  const frame = JSON.parse(line.slice(nonce.length)) as { result?: string | null; error?: string };
  if (typeof frame.error === "string") {
    throw new Error(`derivation failed: ${frame.error.slice(-800)}`);
  }
  let parsed: unknown;
  try {
    parsed = typeof frame.result === "string" ? JSON.parse(frame.result) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the derivation's final expression is not a JSON object");
  }
  return parsed as WorkflowJsonValue;
}
