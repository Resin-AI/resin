#!/usr/bin/env node

/**
 * Helpers for the release candidate's native Windows lanes (`release-candidate.yml`).
 *
 *   serve           Serve a packaged release directory on 127.0.0.1 at the CDN layout the
 *                   installer resolves (/releases/v1/channels.json, manifests/, artifacts/,
 *                   runtimes/deno/), so install.ps1 installs the exact candidate offline.
 *   fetch-runtime   Download the lane's pinned Deno ZIP from its upstream URL and verify it
 *                   against the pinned SHA-256 and size.
 *   pipe-name       Print the daemon's named pipe for a Resin home (as the owner derives it).
 *   verify-prebuilds
 *                   In the signing job: prove the downloaded Windows prebuilds are the exact
 *                   bytes each native Windows lane qualified.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PINNED_DENO_RUNTIME,
  PINNED_DENO_UPSTREAM_ASSETS,
  WINDOWS_PREBUILD_FILES,
} from "./package-release.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const WINDOWS_LANE_ARCH = Object.freeze({ "windows-x64": "x64", "windows-arm64": "arm64" });

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Map a request path to a file in the release (or runtime) directory. Only single, plain
 * file names are served; anything else resolves to null.
 */
export function resolveReleaseRequest(urlPath, { releaseDir, runtimeDir, version }) {
  const pathname = decodeURIComponent(urlPath.split("?")[0] ?? "");
  const routes = [
    [/^\/releases\/v1\/channels\.json$/, () => path.join(releaseDir, "channels.json")],
    [
      /^\/releases\/v1\/manifests\/manifest-([^/]+)\.json$/,
      (match) => (match[1] === version ? path.join(releaseDir, "manifest.json") : null),
    ],
    [
      /^\/releases\/v1\/artifacts\/v([^/]+)\/([^/]+)$/,
      (match) =>
        match[1] === version && SAFE_FILENAME.test(match[2])
          ? path.join(releaseDir, match[2])
          : null,
    ],
    [
      /^\/releases\/v1\/runtimes\/deno\/v([^/]+)\/([^/]+)$/,
      (match) =>
        runtimeDir && match[1] === PINNED_DENO_RUNTIME.version && SAFE_FILENAME.test(match[2])
          ? path.join(runtimeDir, match[2])
          : null,
    ],
  ];
  for (const [pattern, resolve] of routes) {
    const match = pattern.exec(pathname);
    if (match) return resolve(match);
  }
  return null;
}

export function createReleaseServer({ releaseDir, runtimeDir }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "manifest.json"), "utf8"));
  const options = { releaseDir, runtimeDir, version: manifest.version };
  return http.createServer((request, response) => {
    const filePath =
      request.method === "GET" ? resolveReleaseRequest(request.url ?? "", options) : null;
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      filePath.endsWith(".json") ? "application/json" : "application/octet-stream",
    );
    response.setHeader("Content-Length", fs.statSync(filePath).size);
    fs.createReadStream(filePath).pipe(response);
  });
}

export async function fetchPinnedRuntime(lane, outDir, fetchImpl = globalThis.fetch) {
  const upstream = PINNED_DENO_UPSTREAM_ASSETS[lane];
  if (!upstream) throw new Error(`No pinned Deno runtime for lane '${lane}'`);
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, upstream.filename);
  let buffer = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!buffer) {
    const response = await fetchImpl(upstream.sourceUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Downloading ${upstream.sourceUrl} failed: HTTP ${response.status}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  }
  const digest = sha256(buffer);
  if (digest !== upstream.sha256 || buffer.length !== upstream.sizeBytes) {
    throw new Error(
      `Pinned Deno runtime ${upstream.filename} mismatch: expected ${upstream.sha256} (${upstream.sizeBytes} B), got ${digest} (${buffer.length} B)`,
    );
  }
  fs.writeFileSync(target, buffer);
  return { path: target, sha256: digest, sizeBytes: buffer.length };
}

/**
 * Compare the prebuilds staged for signing (`<prebuildsDir>/win32-<arch>/<file>`) with the
 * digests each Windows lane recorded in its qualification evidence. Every Windows lane must
 * have evidence, every prebuild must be present, and every byte must match.
 */
export function verifyPrebuildsAgainstEvidence({ evidenceDir, prebuildsDir }) {
  const evidenceByLane = new Map();
  for (const entry of fs.readdirSync(evidenceDir, { recursive: true })) {
    const filePath = path.join(evidenceDir, String(entry));
    if (!filePath.endsWith(".json") || !fs.statSync(filePath).isFile()) continue;
    const evidence = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (evidence.lane in WINDOWS_LANE_ARCH) evidenceByLane.set(evidence.lane, evidence);
  }
  const problems = [];
  const verified = [];
  for (const [lane, arch] of Object.entries(WINDOWS_LANE_ARCH)) {
    const evidence = evidenceByLane.get(lane);
    if (!evidence) {
      problems.push(`no qualification evidence for ${lane}`);
      continue;
    }
    if (evidence.passed !== true || evidence.status !== "QUALIFIED") {
      problems.push(`${lane} evidence is ${evidence.status}, not a passing native qualification`);
      continue;
    }
    const recorded = evidence.checks?.artifactLayout?.nativePrebuilds ?? {};
    for (const file of WINDOWS_PREBUILD_FILES) {
      const staged = path.join(prebuildsDir, `win32-${arch}`, file);
      const expected = recorded[file]?.sha256;
      if (!expected) {
        problems.push(`${lane} evidence records no digest for ${file}`);
      } else if (!fs.existsSync(staged)) {
        problems.push(`staged prebuild missing: ${staged}`);
      } else {
        const actual = sha256(fs.readFileSync(staged));
        if (actual !== expected) {
          problems.push(`${staged} is ${actual}, but ${lane} qualified ${expected}`);
        } else {
          verified.push({ lane, file, sha256: actual });
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, verified };
}

async function windowsDaemonPipeName(resinHome) {
  const entry = path.join(REPO_ROOT, "packages", "windows-security", "dist", "index.js");
  // Built output of the workspace package; only present after `pnpm build`.
  const security = await import(pathToFileURL(entry).href);
  return security.windowsDaemonPipeName(resinHome);
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      const next = argv[++index];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = next;
    }
  }
  return flags;
}

function requireFlag(flags, name) {
  if (!flags[name]) throw new Error(`--${name} is required`);
  return flags[name];
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === "serve") {
    const server = createReleaseServer({
      releaseDir: path.resolve(requireFlag(flags, "release-dir")),
      runtimeDir: flags["runtime-dir"] ? path.resolve(flags["runtime-dir"]) : undefined,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(flags.port ?? 0), "127.0.0.1", resolve);
    });
    const { port } = server.address();
    if (flags["port-file"]) fs.writeFileSync(flags["port-file"], String(port), "utf8");
    process.stdout.write(`Serving release on http://127.0.0.1:${port}/releases/v1/\n`);
    return 0;
  }
  if (command === "fetch-runtime") {
    const result = await fetchPinnedRuntime(
      requireFlag(flags, "lane"),
      path.resolve(requireFlag(flags, "out")),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === "pipe-name") {
    process.stdout.write(`${await windowsDaemonPipeName(requireFlag(flags, "resin-home"))}\n`);
    return 0;
  }
  if (command === "verify-prebuilds") {
    const result = verifyPrebuildsAgainstEvidence({
      evidenceDir: path.resolve(requireFlag(flags, "evidence-dir")),
      prebuildsDir: path.resolve(requireFlag(flags, "prebuilds-dir")),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  throw new Error(
    `Unknown command '${command}' (expected serve | fetch-runtime | pipe-name | verify-prebuilds)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await main(process.argv.slice(2));
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
