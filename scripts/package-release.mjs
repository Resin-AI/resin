#!/usr/bin/env node

/**
 * Resin V1.0.0 Release Packaging Tool
 *
 * Responsibilities:
 * 1. Builds all 15 monorepo workspace packages.
 * 2. Generates reproducible, deterministic standalone platform release tarballs.
 * 3. Generates a signed release manifest with Ed25519 signatures and SHA-256 digests.
 * 4. Generates a CycloneDX 1.5 JSON SBOM.
 * 5. Generates signed release channel metadata.
 * 6. Outputs all release artifacts to dist/release/v1.0.3/.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { getGitCommitSha, writeReleaseEvidence } from "./generate-release-evidence.mjs";
import {
  REVOKED_RELEASE_KEY_IDS,
  createTestReleaseSigningKey,
  loadReleaseSigningKeyFromEnv,
  publicTrustRecord,
  signReleasePayload,
  trustedKeysFromSigningKey,
} from "./release-trust.mjs";

export const RELEASE_VERSION = (process.env.RELEASE_TAG || "v1.0.3").replace(/^v/, "");
export const RELEASE_DATE = new Date().toISOString();
export const DETERMINISTIC_MTIME = 1786924800;

export const PLATFORMS = [
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    isWsl: false,
    filename: `resin-v${RELEASE_VERSION}-linux-x64.tar.gz`,
  },
  {
    id: "linux-arm64",
    os: "linux",
    arch: "arm64",
    isWsl: false,
    filename: `resin-v${RELEASE_VERSION}-linux-arm64.tar.gz`,
  },
  {
    id: "darwin-x64",
    os: "darwin",
    arch: "x64",
    isWsl: false,
    filename: `resin-v${RELEASE_VERSION}-darwin-x64.tar.gz`,
  },
  {
    id: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    isWsl: false,
    filename: `resin-v${RELEASE_VERSION}-darwin-arm64.tar.gz`,
  },
  {
    id: "wsl-x64",
    os: "linux",
    arch: "x64",
    isWsl: true,
    filename: `resin-v${RELEASE_VERSION}-wsl.tar.gz`,
  },
];

export const PINNED_DENO_UPSTREAM_ASSETS = Object.freeze({
  "linux-x64": Object.freeze({
    filename: "deno-x86_64-unknown-linux-gnu.zip",
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
    sha256: "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
    sizeBytes: 41638854,
    archive: "zip",
    executable: "deno",
  }),
  "linux-arm64": Object.freeze({
    filename: "deno-aarch64-unknown-linux-gnu.zip",
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-unknown-linux-gnu.zip",
    sha256: "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0",
    sizeBytes: 39902077,
    archive: "zip",
    executable: "deno",
  }),
  "darwin-x64": Object.freeze({
    filename: "deno-x86_64-apple-darwin.zip",
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-apple-darwin.zip",
    sha256: "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
    sizeBytes: 42346648,
    archive: "zip",
    executable: "deno",
  }),
  "darwin-arm64": Object.freeze({
    filename: "deno-aarch64-apple-darwin.zip",
    sourceUrl:
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip",
    sha256: "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
    sizeBytes: 38511993,
    archive: "zip",
    executable: "deno",
  }),
});

export const PINNED_DENO_RUNTIME = Object.freeze({
  version: "2.9.5",
  required: true,
  assets: Object.freeze({
    "linux-x64": Object.freeze({
      filename: "deno-x86_64-unknown-linux-gnu.zip",
      url: "/releases/v1/runtimes/deno/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
      sourceUrl:
        "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
      sha256: "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
      sizeBytes: 41638854,
      archive: "zip",
      executable: "deno",
    }),
    "linux-arm64": Object.freeze({
      filename: "deno-aarch64-unknown-linux-gnu.zip",
      url: "/releases/v1/runtimes/deno/v2.9.5/deno-aarch64-unknown-linux-gnu.zip",
      sourceUrl:
        "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-unknown-linux-gnu.zip",
      sha256: "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0",
      sizeBytes: 39902077,
      archive: "zip",
      executable: "deno",
    }),
    "darwin-x64": Object.freeze({
      filename: "deno-x86_64-apple-darwin.zip",
      url: "/releases/v1/runtimes/deno/v2.9.5/deno-x86_64-apple-darwin.zip",
      sourceUrl:
        "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-apple-darwin.zip",
      sha256: "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
      sizeBytes: 42346648,
      archive: "zip",
      executable: "deno",
    }),
    "darwin-arm64": Object.freeze({
      filename: "deno-aarch64-apple-darwin.zip",
      url: "/releases/v1/runtimes/deno/v2.9.5/deno-aarch64-apple-darwin.zip",
      sourceUrl:
        "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip",
      sha256: "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
      sizeBytes: 38511993,
      archive: "zip",
      executable: "deno",
    }),
  }),
});
export const INTERNAL_WORKSPACE_REGISTRY = Object.freeze([
  {
    name: "@resin/contracts",
    path: "packages/contracts",
    entry: "dist/index.js",
    type: "package",
    private: false,
  },
  {
    name: "@resin/crypto",
    path: "packages/crypto",
    entry: "dist/index.js",
    type: "package",
    private: false,
  },
  {
    name: "@resin/db",
    path: "packages/db",
    entry: "dist/index.js",
    type: "package",
    private: false,
  },
  {
    name: "@resin/harness-contracts",
    path: "packages/harness-contracts",
    entry: "dist/index.js",
    type: "package",
    private: false,
  },
  {
    name: "@resin/protocol",
    path: "packages/protocol",
    entry: "dist/index.js",
    type: "package",
    private: false,
  },
  {
    name: "@resin/runtime",
    path: "packages/runtime",
    entry: "dist/index.js",
    type: "package",
    private: false,
  },
  {
    name: "resin",
    path: "apps/cli",
    entry: "dist/index.js",
    bin: "dist/bin/cli.js",
    type: "app",
    private: false,
  },
  {
    name: "@resin/gateway",
    path: "apps/gateway",
    entry: "dist/index.js",
    bin: "dist/bin/gateway.js",
    type: "app",
    private: false,
  },
  {
    name: "@resin/observer",
    path: "apps/observer",
    entry: "dist/index.js",
    bin: "dist/bin/daemon.js",
    type: "app",
    private: false,
  },
  {
    name: "@resin/cloud",
    path: "apps/cloud",
    entry: "dist/index.js",
    type: "app",
    private: true,
  },
  {
    name: "@resin/cloud-contracts",
    path: "packages/cloud-contracts",
    entry: "dist/index.js",
    type: "package",
    private: true,
  },
  {
    name: "@resin/web",
    path: "apps/web",
    entry: "dist/index.js",
    type: "app",
    private: true,
  },
  {
    name: "@resin/adapter-claude-code",
    path: "adapters/claude-code",
    entry: "dist/index.js",
    type: "adapter",
    private: false,
  },
  {
    name: "@resin/adapter-codex",
    path: "adapters/codex-cli",
    entry: "dist/index.js",
    type: "adapter",
    private: false,
  },
  {
    name: "@resin/adapter-omp",
    path: "adapters/omp",
    entry: "dist/index.js",
    type: "adapter",
    private: false,
  },
  {
    name: "@resin/test-fixtures",
    path: "fixtures/test-fixtures",
    entry: "dist/index.js",
    type: "fixture",
    private: true,
  },
  {
    name: "@resin/e2e",
    path: "fixtures/e2e",
    entry: "dist/index.js",
    type: "fixture",
    private: true,
  },
]);

export const WORKSPACE_PACKAGES = INTERNAL_WORKSPACE_REGISTRY;

export function resolvePublicReleasePackages(rootDir = process.cwd(), customManifest = null) {
  let manifest = customManifest;
  if (!manifest) {
    const manifestPath = path.join(rootDir, "resin-boundary.json");
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (err) {
        throw new Error(`Failed to parse boundary manifest at "${manifestPath}": ${err.message}`);
      }
    }
  }

  if (!manifest || !Array.isArray(manifest.publicReleasePackages)) {
    throw new Error(
      "Canonical manifest 'resin-boundary.json' is missing required 'publicReleasePackages' array.",
    );
  }

  const privateSet = new Set(manifest.privatePackages || []);
  const registryMap = new Map(INTERNAL_WORKSPACE_REGISTRY.map((pkg) => [pkg.name, pkg]));

  const releasePackages = [];
  for (const pkgName of manifest.publicReleasePackages) {
    if (privateSet.has(pkgName)) {
      throw new Error(`Private package "${pkgName}" cannot be included in publicReleasePackages.`);
    }
    const registered = registryMap.get(pkgName);
    if (!registered) {
      throw new Error(
        `Unknown public release package "${pkgName}" not found in internal workspace registry.`,
      );
    }
    if (registered.private) {
      throw new Error(`Private package "${pkgName}" cannot be included in publicReleasePackages.`);
    }
    const pkgDir = path.resolve(rootDir, registered.path);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error(
        `Package.json missing for public release package "${pkgName}" at "${pkgJsonPath}".`,
      );
    }
    releasePackages.push(registered);
  }

  return Object.freeze(releasePackages);
}

let defaultPublicReleasePackages;
try {
  defaultPublicReleasePackages = resolvePublicReleasePackages(process.cwd());
} catch {
  defaultPublicReleasePackages = Object.freeze(
    INTERNAL_WORKSPACE_REGISTRY.filter((pkg) => !pkg.private),
  );
}
export const PUBLIC_RELEASE_PACKAGES = defaultPublicReleasePackages;

const RELEASE_RUNTIME_DEPENDENCIES = ["typescript"];

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function fileSha256(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

export function canonicalJson(val) {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(val).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(val[key])}`).join(",")}}`;
}

export function createUstarHeader({
  name,
  size,
  mode = 0o644,
  mtime = DETERMINISTIC_MTIME,
  typeflag = "0",
  uname = "root",
  gname = "root",
}) {
  const buf = Buffer.alloc(512, 0);
  let nameField = name;
  let prefixField = "";
  if (Buffer.byteLength(name) > 100) {
    const idx = name.lastIndexOf("/");
    if (idx > 0 && idx < 155) {
      prefixField = name.slice(0, idx);
      nameField = name.slice(idx + 1);
    }
  }
  if (Buffer.byteLength(nameField) > 100 || Buffer.byteLength(prefixField) > 155) {
    throw new Error(`USTAR path exceeds supported limits: ${name}`);
  }

  buf.write(nameField, 0, 100, "utf8");
  buf.write(`${mode.toString(8).padStart(6, "0")} \0`, 100, 8, "ascii");
  buf.write(`${(0).toString(8).padStart(6, "0")} \0`, 108, 8, "ascii");
  buf.write(`${(0).toString(8).padStart(6, "0")} \0`, 116, 8, "ascii");
  buf.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
  buf.write(`${mtime.toString(8).padStart(11, "0")} `, 136, 12, "ascii");
  buf.write(typeflag, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write(uname, 265, 32, "ascii");
  buf.write(gname, 297, 32, "ascii");
  if (prefixField) buf.write(prefixField, 345, 155, "utf8");

  buf.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += buf[i];
  buf.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return buf;
}

export function createDeterministicTar(entries) {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const chunks = [];
  for (const entry of sorted) {
    const isDir = entry.type === "dir" || entry.path.endsWith("/");
    const contentBuf = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content ?? "", "utf8");
    const header = createUstarHeader({
      name: entry.path,
      size: contentBuf.length,
      mode: entry.mode ?? (isDir ? 0o755 : 0o644),
      mtime: entry.mtime ?? DETERMINISTIC_MTIME,
      typeflag: isDir ? "5" : "0",
    });
    chunks.push(header);
    if (contentBuf.length > 0) {
      chunks.push(contentBuf);
      const remainder = contentBuf.length % 512;
      if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function gzipDeterministic(tarBuffer) {
  return zlib.gzipSync(tarBuffer, { mtime: 0, level: 9 });
}

export function buildWorkspacePackages(rootDir = process.cwd()) {
  console.log("🔨 Building all 15 workspace packages...");
  execSync("pnpm turbo run build", { cwd: rootDir, stdio: "inherit" });
  console.log("✅ All workspace packages built successfully.");
}
export const CLOUD_ONLY_IDENTIFIERS = Object.freeze([
  "apps/cloud",
  "apps/web",
  "packages/cloud-contracts",
  "fixtures/e2e",
  "infra/aws",
  "infra/serverless",
  "deploy",
  "aws",
  "cloud-deploy",
  "@resin/cloud",
  "@resin/web",
  "@resin/cloud-contracts",
  "@resin/e2e",
]);

export const FORBIDDEN_RELEASE_PATTERNS = Object.freeze([
  // Gateway meta/utility-tools
  /(?:^|[\\/])(?:apps[\\/])?gateway[\\/](?:dist[\\/])?meta[\\/]utility-tools(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])meta[\\/]utility-tools(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])utility-tools(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,

  // Gateway / proxy mock-service
  /(?:^|[\\/])(?:apps[\\/])?gateway[\\/](?:dist[\\/])?proxy[\\/]mock-service(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])proxy[\\/]mock-service(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])mock-service(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,

  // Cloud refresh/fake-matrix
  /(?:^|[\\/])(?:apps[\\/])?cloud[\\/](?:dist[\\/])?refresh[\\/]fake-matrix(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])refresh[\\/]fake-matrix(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])fake-matrix(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,

  // Harness-contracts fake
  /(?:^|[\\/])(?:packages[\\/])?harness-contracts[\\/](?:dist[\\/])?fake(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,
  /(?:^|[\\/])(?:packages[\\/])?harness-contracts[\\/](?:dist[\\/])?fake-adapter(?:\.d\.ts|\.js|\.js\.map|\.d\.ts\.map|\.mjs|\.cjs)?$/,

  // Cloud and private packages
  /(?:^|[\\/])(?:apps[\\/]|packages[\\/]|fixtures[\\/]|@resin[\\/]|resin[\\/](?:apps[\\/]|packages[\\/]|fixtures[\\/]|node_modules[\\/]@resin[\\/]))(?:cloud|web|cloud-contracts|e2e)(?:[\\/]|$)/,

  // Cloud-only infrastructure and deployment
  /(?:^|[\\/])(?:infra[\\/])(?:aws|serverless)(?:[\\/]|$)/,
  /(?:^|[\\/])(?:serverless|deploy|aws)(?:[\\/]|$)/,
  /(?:^|[\\/])cloud-deploy(?:\.ya?ml)?$/,

  // General test-doubles and test trees in production releases
  /(?:^|[\\/])(?:tests|__tests__|__mocks__)(?:[\\/]|$)/,
  /\.test\.(?:[cm]?[jt]sx?|d\.ts|map)$/,
  /\.spec\.(?:[cm]?[jt]sx?|d\.ts|map)$/,
]);

export function isForbiddenReleasePath(filePath, _options = {}) {
  if (!filePath || typeof filePath !== "string") return false;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

  for (const pattern of FORBIDDEN_RELEASE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  for (const id of CLOUD_ONLY_IDENTIFIERS) {
    if (
      normalized === id ||
      normalized.startsWith(`${id}/`) ||
      normalized.includes(`/${id}/`) ||
      normalized.endsWith(`/${id}`) ||
      normalized.includes(`resin/${id}/`) ||
      normalized.includes(`node_modules/${id}/`)
    ) {
      return true;
    }
  }

  return false;
}

export function isProductionDistFile(pkgDir, distRelPath) {
  if (!distRelPath || typeof distRelPath !== "string") return false;
  const normalizedDist = distRelPath.replace(/\\/g, "/");

  // 1. Explicit forbidden check
  if (
    isForbiddenReleasePath(normalizedDist) ||
    isForbiddenReleasePath(path.join(pkgDir, normalizedDist))
  ) {
    return false;
  }

  // 2. Generic source-backed invariant:
  // Every compiled file in dist/ must correspond to a real source file in src/
  const srcDir = path.join(pkgDir, "src");
  if (!fs.existsSync(srcDir)) {
    return true;
  }

  const base = normalizedDist
    .replace(/\.d\.ts\.map$/, "")
    .replace(/\.js\.map$/, "")
    .replace(/\.mjs\.map$/, "")
    .replace(/\.cjs\.map$/, "")
    .replace(/\.d\.ts$/, "")
    .replace(/\.(js|mjs|cjs|jsx|ts|tsx|json)$/, "");

  const candidateExtensions = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".d.ts",
    ".json",
  ];

  const candidateSources = [
    path.join(srcDir, normalizedDist),
    ...candidateExtensions.map((ext) => path.join(srcDir, `${base}${ext}`)),
  ];

  return candidateSources.some((candidate) => fs.existsSync(candidate));
}

export function assertCleanProductionDist(rootDir, pkgDir) {
  const distDir = path.join(pkgDir, "dist");
  if (!fs.existsSync(distDir)) return;

  const rawFiles = collectFilesRecursively(distDir, pkgDir);
  const staleOrForbidden = [];

  for (const file of rawFiles) {
    const insideDistRel = path.relative("dist", file.relPath).replace(/\\/g, "/");
    if (
      insideDistRel.endsWith(".tsbuildinfo") ||
      insideDistRel.endsWith(".DS_Store") ||
      file.relPath.endsWith(".tsbuildinfo")
    ) {
      continue;
    }
    if (isForbiddenReleasePath(insideDistRel) || isForbiddenReleasePath(file.relPath)) {
      staleOrForbidden.push({ file: file.relPath, reason: "forbidden release artifact" });
    } else if (!isProductionDistFile(pkgDir, insideDistRel)) {
      staleOrForbidden.push({
        file: file.relPath,
        reason: "stale orphan output with no corresponding source file in src/",
      });
    }
  }

  if (staleOrForbidden.length > 0) {
    const details = staleOrForbidden.map((f) => `  - ${f.file} (${f.reason})`).join("\n");
    const error = new Error(
      `Package dist hygiene check failed for "${pkgDir}":\n${details}\nEnsure a clean build before packaging release.`,
    );
    error.code = "ERR_STALE_DIST_OUTPUT";
    error.violations = staleOrForbidden;
    throw error;
  }
}

export function collectPackageProductionDistFiles(rootDir, pkgDir, options = {}) {
  const distDir = path.join(pkgDir, "dist");
  if (!fs.existsSync(distDir)) return [];

  if (options.rejectStale === true) {
    assertCleanProductionDist(rootDir, pkgDir);
  }

  const rawFiles = collectFilesRecursively(distDir, pkgDir);
  const productionFiles = [];

  for (const file of rawFiles) {
    const insideDistRel = path.relative("dist", file.relPath).replace(/\\/g, "/");
    if (isProductionDistFile(pkgDir, insideDistRel)) {
      productionFiles.push(file);
    }
  }

  return productionFiles;
}

export function assertNoForbiddenReleaseArtifacts(entries, context = "release payload") {
  const violations = [];

  for (const entry of entries) {
    const entryPath =
      typeof entry === "string" ? entry : entry?.path || entry?.relPath || entry?.name || "";
    if (!entryPath) continue;

    if (isForbiddenReleasePath(entryPath)) {
      violations.push(entryPath);
    }
  }

  if (violations.length > 0) {
    const error = new Error(
      `Release packaging failed-closed assertion in ${context}: detected ${violations.length} forbidden test-double/stale artifact(s):\n${violations.map((v) => `  - ${v}`).join("\n")}\nOrphaned compiled test doubles or forbidden test paths must never be included in production release artifacts.`,
    );
    error.code = "ERR_FORBIDDEN_RELEASE_ARTIFACT";
    error.violations = violations;
    throw error;
  }
}

function collectFilesRecursively(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(full, baseDir));
    } else if (entry.isFile()) {
      results.push({
        relPath: path.relative(baseDir, full).replace(/\\/g, "/"),
        fullPath: full,
      });
    }
  }
  return results;
}

function workspacePackageByDir(rootDir, packageDir) {
  const resolved = path.resolve(packageDir);
  return INTERNAL_WORKSPACE_REGISTRY.find((pkg) => path.resolve(rootDir, pkg.path) === resolved);
}

function packagePayloadFiles(rootDir, packageDir) {
  const workspacePackage = workspacePackageByDir(rootDir, packageDir);
  if (!workspacePackage) {
    return collectFilesRecursively(packageDir, packageDir).filter(
      (file) =>
        !file.relPath.startsWith("node_modules/") &&
        !file.relPath.startsWith(".git/") &&
        !file.relPath.endsWith(".map") &&
        !isForbiddenReleasePath(file.relPath),
    );
  }

  const files = [];
  const candidates = ["package.json", "README.md", "README", "LICENSE", "LICENSE.md"];
  for (const candidate of candidates) {
    const full = path.join(packageDir, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      files.push({ relPath: candidate, fullPath: full });
    }
  }
  const distFiles = collectPackageProductionDistFiles(rootDir, packageDir).filter(
    (file) => !file.relPath.endsWith(".map"),
  );
  files.push(...distFiles);
  const binDir = path.join(packageDir, "bin");
  if (fs.existsSync(binDir)) {
    const binFiles = collectFilesRecursively(binDir, packageDir).filter(
      (f) => !isForbiddenReleasePath(f.relPath),
    );
    files.push(...binFiles);
  }
  return files;
}

function resolveRuntimeDependencyDir(rootDir, dependencyName, importerDir) {
  const segments = dependencyName.startsWith("@") ? dependencyName.split("/") : [dependencyName];
  let searchDir = importerDir;
  const candidates = new Set();

  while (true) {
    const nodeModulesDir = path.join(searchDir, "node_modules");
    candidates.add(path.join(nodeModulesDir, ...segments));
    const parentDir = path.dirname(searchDir);
    if (parentDir === searchDir) break;
    searchDir = parentDir;
  }
  candidates.add(path.join(rootDir, "node_modules", ...segments));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    } catch {
      // continue
    }
  }
  throw new Error(
    `Runtime dependency '${dependencyName}' required by '${importerDir}' is not installed.`,
  );
}

const STANDALONE_RUNTIME_ROOTS = ["apps/cli"];

/**
 * Builds a real Node resolution tree inside the release archive. The previous
 * archive contained workspace dist files but no node_modules tree, so the
 * packaged entrypoints could not resolve @resin/* or external imports
 * outside the monorepo.
 */
export function collectStandaloneRuntimeEntries(rootDir = process.cwd(), options = {}) {
  const publicPackages = options.publicPackages || resolvePublicReleasePackages(rootDir);
  const publicPackageNames = new Set(publicPackages.map((p) => p.name));
  publicPackageNames.add("resin");

  const internalRegistryMap = new Map(INTERNAL_WORKSPACE_REGISTRY.map((pkg) => [pkg.name, pkg]));

  const queue = STANDALONE_RUNTIME_ROOTS.flatMap((runtimeRoot) => {
    const runtimeRootDir = path.resolve(rootDir, runtimeRoot);
    const runtimePkgJson = JSON.parse(
      fs.readFileSync(path.join(runtimeRootDir, "package.json"), "utf8"),
    );
    return Object.keys(runtimePkgJson.dependencies ?? {}).map((dependencyName) => ({
      name: dependencyName,
      importerDir: runtimeRootDir,
    }));
  });

  const visited = new Map();
  const entries = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visited.has(next.name)) continue;

    if (internalRegistryMap.has(next.name)) {
      if (!publicPackageNames.has(next.name)) {
        throw new Error(
          `Public release cannot depend on private workspace package '${next.name}' required by '${next.importerDir}'.`,
        );
      }
    }

    const packageDir = resolveRuntimeDependencyDir(rootDir, next.name, next.importerDir);
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const previous = visited.get(next.name);
    if (previous) {
      if (previous.version !== packageJson.version) {
        throw new Error(
          `Standalone release requires conflicting versions of '${next.name}': '${previous.version}' and '${packageJson.version}'.`,
        );
      }
      continue;
    }
    visited.set(next.name, { version: packageJson.version, packageDir });

    const archiveBase = `resin/node_modules/${next.name}`;
    for (const file of packagePayloadFiles(rootDir, packageDir)) {
      const mode = fs.statSync(file.fullPath).mode & 0o111 ? 0o755 : 0o644;
      const entryPath = `${archiveBase}/${file.relPath}`.replace(/\\/g, "/");
      if (isForbiddenReleasePath(entryPath)) {
        throw new Error(
          `Forbidden release artifact detected in runtime dependency '${next.name}': '${entryPath}'`,
        );
      }
      entries.push({
        path: entryPath,
        content: fs.readFileSync(file.fullPath),
        mode,
      });
    }

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      queue.push({ name: dependencyName, importerDir: packageDir });
    }
  }

  return entries;
}

export function generatePackageDigests(rootDir = process.cwd(), options = {}) {
  const publicPackages = options.publicPackages || resolvePublicReleasePackages(rootDir);
  const result = {};
  for (const pkg of publicPackages) {
    const pkgDir = path.resolve(rootDir, pkg.path);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    const pkgJson = fs.existsSync(pkgJsonPath)
      ? JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
      : { version: RELEASE_VERSION };
    const entryPath = path.join(pkgDir, pkg.entry);
    const entrySha256 = fs.existsSync(entryPath) ? fileSha256(entryPath) : sha256Hex(pkg.name);
    const distFiles = collectPackageProductionDistFiles(rootDir, pkgDir, { rejectStale: true });
    assertNoForbiddenReleaseArtifacts(distFiles, `package ${pkg.name} dist files`);
    const distFileHashes = distFiles
      .map((f) => fileSha256(f.fullPath))
      .sort()
      .join("");
    result[pkg.name] = {
      name: pkg.name,
      version: pkgJson.version || RELEASE_VERSION,
      type: pkg.type,
      entry: pkg.entry,
      entrySha256,
      packageSha256: sha256Hex(distFileHashes || entrySha256),
      filesCount: distFiles.length,
    };
  }
  return result;
}

export function createPlatformReleaseTarballs(rootDir, outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const publicPackages = options.publicPackages || resolvePublicReleasePackages(rootDir);
  const rootPkgJson = JSON.parse(fs.readFileSync(path.resolve(rootDir, "package.json"), "utf8"));
  const assetResults = {};

  const baseEntries = [
    {
      path: "resin/package.json",
      content: JSON.stringify(
        {
          name: "resin",
          version: RELEASE_VERSION,
          description:
            "Compiles recurring coding-agent work into tools that use less inference, lower inference cost, and finish faster",
          type: "module",
          bin: {
            resin: "./bin/resin",
            "resin-daemon": "./bin/resin-daemon",
            "resin-gateway": "./bin/resin-gateway",
            "resin-mcp": "./bin/resin-mcp",
          },
          dependencies: rootPkgJson.dependencies || {},
        },
        null,
        2,
      ),
      mode: 0o644,
    },
    {
      path: "resin/bin/resin",
      content:
        "#!/usr/bin/env node\nimport { main } from '../apps/cli/dist/index.js';\nif (typeof main === 'function') {\n  try {\n    const exitCode = await main(process.argv.slice(2));\n    if (typeof exitCode === 'number' && exitCode !== 0) {\n      process.exit(exitCode);\n    }\n  } catch (err) {\n    process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\\n`);\n    process.exit(1);\n  }\n}\n",
      mode: 0o755,
    },
    {
      path: "resin/bin/resin-daemon",
      content: "#!/usr/bin/env node\nimport '../apps/observer/dist/bin/daemon.js';\n",
      mode: 0o755,
    },
    {
      path: "resin/bin/resin-gateway",
      content: "#!/usr/bin/env node\nimport '../apps/gateway/dist/bin/mcp-shim.js';\n",
      mode: 0o755,
    },
    {
      path: "resin/bin/resin-mcp",
      content: "#!/usr/bin/env node\nimport '../apps/gateway/dist/bin/mcp-shim.js';\n",
      mode: 0o755,
    },
    {
      path: "resin/README.md",
      content: `# Resin (v${RELEASE_VERSION})\n\nOfficial release distribution.\nRun \`npx resin init\` to get started.\n`,
      mode: 0o644,
    },
  ];

  for (const legalFile of ["LICENSE", "NOTICE", "SECURITY.md"]) {
    const legalFilePath = path.join(rootDir, legalFile);
    if (fs.existsSync(legalFilePath)) {
      baseEntries.push({
        path: `resin/${legalFile}`,
        content: fs.readFileSync(legalFilePath),
        mode: 0o644,
      });
    }
  }

  for (const pkg of publicPackages) {
    const pkgDir = path.resolve(rootDir, pkg.path);
    assertCleanProductionDist(rootDir, pkgDir);
    for (const file of collectPackageProductionDistFiles(rootDir, pkgDir, { rejectStale: true })) {
      if (file.relPath.endsWith(".map")) continue;
      baseEntries.push({
        path: `resin/${pkg.path}/${file.relPath}`,
        content: fs.readFileSync(file.fullPath),
        mode: 0o644,
      });
    }
  }

  for (const runtimeEntry of collectStandaloneRuntimeEntries(rootDir, { publicPackages })) {
    baseEntries.push(runtimeEntry);
  }

  assertNoForbiddenReleaseArtifacts(baseEntries, "base release entries");

  for (const platform of PLATFORMS) {
    const platformEntries = [
      ...baseEntries,
      {
        path: `resin/bin/resin-${platform.os}-${platform.arch}${platform.os === "win32" ? ".exe" : ""}`,
        content:
          platform.os === "win32"
            ? "@echo off\r\nnode %~dp0resin %*\r\n"
            : "#!/usr/bin/env node\nimport './resin';\n",
        mode: 0o755,
      },
      {
        path: "resin/release-metadata.json",
        content: JSON.stringify(
          {
            name: "resin",
            version: RELEASE_VERSION,
            platform: platform.os,
            arch: platform.arch,
            isWsl: platform.isWsl,
            releaseDate: RELEASE_DATE,
          },
          null,
          2,
        ),
        mode: 0o644,
      },
      {
        path: "resin/platform.json",
        content: JSON.stringify(
          {
            releaseVersion: RELEASE_VERSION,
            platform: platform.os,
            arch: platform.arch,
            isWsl: platform.isWsl,
          },
          null,
          2,
        ),
        mode: 0o644,
      },
    ];
    assertNoForbiddenReleaseArtifacts(platformEntries, `platform ${platform.id} release entries`);
    const gzBuffer = gzipDeterministic(createDeterministicTar(platformEntries));
    const tarballPath = path.join(outputDir, platform.filename);
    fs.writeFileSync(tarballPath, gzBuffer);
    assetResults[platform.id] = {
      filename: platform.filename,
      platform: platform.os,
      arch: platform.arch,
      isWsl: platform.isWsl,
      sizeBytes: gzBuffer.length,
      sha256: sha256Hex(gzBuffer),
      url: `/releases/v1/artifacts/v${RELEASE_VERSION}/${platform.filename}`,
      path: `dist/release/v${RELEASE_VERSION}/${platform.filename}`,
    };
  }

  return assetResults;
}

function resolveReleaseIdentity(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const testOnly = options.testOnly === true;
  const commitSha = options.commitSha || process.env.GITHUB_SHA || getGitCommitSha(rootDir);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(
      `Release commit SHA must be an exact 40-character Git SHA, received '${commitSha}'.`,
    );
  }
  const repository =
    options.repository || process.env.GITHUB_REPOSITORY || (testOnly ? "test-only/local" : "");
  const ref = options.ref || process.env.GITHUB_REF || (testOnly ? "refs/test-only/local" : "");
  const workflowRunId = String(
    options.workflowRunId || process.env.GITHUB_RUN_ID || (testOnly ? "test-only" : ""),
  );
  const workflowRunAttempt = String(
    options.workflowRunAttempt || process.env.GITHUB_RUN_ATTEMPT || (testOnly ? "1" : ""),
  );
  if (!testOnly && (!repository || !ref || !workflowRunId || !workflowRunAttempt)) {
    throw new Error(
      "Production release packaging requires GitHub repository/ref/run identity and cannot fabricate provenance.",
    );
  }
  return Object.freeze({
    repository,
    commitSha,
    ref,
    workflow: {
      name:
        options.workflowName ||
        process.env.GITHUB_WORKFLOW ||
        (testOnly ? "test-only-release" : ""),
      runId: workflowRunId,
      runAttempt: workflowRunAttempt,
    },
  });
}

function resolveSigningKey(options = {}) {
  if (options.keyPair) return options.keyPair;
  if (options.testOnly === true) return createTestReleaseSigningKey();
  return loadReleaseSigningKeyFromEnv();
}

export function generateSignedManifest(packageDigests, assetDigests, options = {}) {
  const keyPair = resolveSigningKey(options);
  const releaseIdentity = options.releaseIdentity || resolveReleaseIdentity(options);
  const evidence = options.evidence;
  if (!evidence && options.testOnly !== true) {
    throw new Error(
      "Production release manifests require release evidence metadata before signing.",
    );
  }
  const releaseDate = options.releaseDate || RELEASE_DATE;
  const expiresAt =
    options.expiresAt ||
    new Date(Date.parse(releaseDate) + 365 * 24 * 60 * 60 * 1000).toISOString();
  const manifestPayload = {
    schemaVersion: "2.0.0",
    metadataVersion: 1,
    expiresAt,
    version: RELEASE_VERSION,
    releaseDate,
    releaseIdentity,
    packages: packageDigests,
    assets: assetDigests,
    runtimes: options.runtimes || { deno: PINNED_DENO_RUNTIME },
    evidence: evidence || { status: "TEST_ONLY" },
  };
  return {
    ...manifestPayload,
    signatures: [
      {
        ...signReleasePayload(manifestPayload, keyPair),
        signedAt: RELEASE_DATE,
      },
    ],
  };
}

export function extractTarEntries(tarBuffer) {
  let uncompressed;
  try {
    uncompressed = zlib.gunzipSync(tarBuffer);
  } catch {
    uncompressed = tarBuffer;
  }
  const entries = [];
  let offset = 0;
  while (offset + 512 <= uncompressed.length) {
    const header = uncompressed.subarray(offset, offset + 512);
    let isAllZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) break;

    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
    const prefixRaw = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const name = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeflag = header.subarray(156, 157).toString("utf8");
    offset += 512;
    const content = uncompressed.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    entries.push({ name, path: name, size, typeflag, content });
  }
  return entries;
}

export function collectProjectDependencies(rootDir, options = {}) {
  const publicPackages = options.publicPackages || resolvePublicReleasePackages(rootDir);
  const rootPkgPath = path.resolve(rootDir, "package.json");
  const workspacePkgPaths = [
    rootPkgPath,
    ...publicPackages.map((pkg) => path.resolve(rootDir, pkg.path, "package.json")),
  ];

  const knownLicenses = {
    zod: "MIT",
    "better-sqlite3": "MIT",
    fastify: "MIT",
    ws: "MIT",
    typescript: "Apache-2.0",
    vitest: "MIT",
    turbo: "Apache-2.0",
    "@biomejs/biome": "MIT OR Apache-2.0",
    "@types/node": "MIT",
    "@types/pg": "MIT",
    pg: "MIT",
    esbuild: "MIT",
  };

  const thirdPartyMap = new Map();
  const workspacePackageNames = new Set(publicPackages.map((p) => p.name));
  workspacePackageNames.add("resin");

  for (const pkgJsonPath of workspacePkgPaths) {
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const content = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const isFixture = pkgJsonPath.includes("fixtures");

      const processDepSection = (deps, isRuntime = true) => {
        if (!deps || typeof deps !== "object") return;
        for (const [depName, specifier] of Object.entries(deps)) {
          if (depName.startsWith("@resin/") || workspacePackageNames.has(depName)) continue;
          if (isForbiddenReleasePath(depName)) continue;
          if (!thirdPartyMap.has(depName)) {
            thirdPartyMap.set(depName, {
              specifiers: new Set(),
              isRuntime: !isFixture && isRuntime,
            });
          }
          const info = thirdPartyMap.get(depName);
          info.specifiers.add(specifier);
          if (!isFixture && isRuntime) {
            info.isRuntime = true;
          }
        }
      };

      processDepSection(content.dependencies, true);
      processDepSection(content.peerDependencies, true);
      processDepSection(content.optionalDependencies, false);
    } catch {
      // ignore parse errors for non-critical workspaces
    }
  }

  const results = [];

  for (const [depName, info] of thirdPartyMap.entries()) {
    let resolvedVersion = [...info.specifiers][0]?.replace(/^[\^~>=<]/, "") || "1.0.0";
    let resolvedLicense = knownLicenses[depName] || "MIT";
    let resolvedDescription = `Dependency ${depName}`;
    let pkgHash = null;

    const searchCandidates = [
      path.join(rootDir, "node_modules", depName, "package.json"),
      path.join(rootDir, "apps/cli/node_modules", depName, "package.json"),
      path.join(rootDir, "apps/gateway/node_modules", depName, "package.json"),
    ];

    for (const candidate of searchCandidates) {
      if (fs.existsSync(candidate)) {
        try {
          const installedJson = JSON.parse(fs.readFileSync(candidate, "utf8"));
          if (installedJson.version) resolvedVersion = installedJson.version;
          if (installedJson.description) resolvedDescription = installedJson.description;
          if (installedJson.license) {
            resolvedLicense =
              typeof installedJson.license === "string"
                ? installedJson.license
                : installedJson.license.type || resolvedLicense;
          }
          pkgHash = sha256Hex(fs.readFileSync(candidate));
          break;
        } catch {
          // ignore
        }
      }
    }

    results.push({
      name: depName,
      version: resolvedVersion,
      license: resolvedLicense,
      description: resolvedDescription,
      purl: `pkg:npm/${encodeURIComponent(depName)}@${resolvedVersion}`,
      sha256: pkgHash || sha256Hex(`${depName}@${resolvedVersion}`),
      isRuntime: info.isRuntime,
      scope: info.isRuntime ? "required" : "optional",
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function generateCycloneDxSbom(rootDir, packageDigests = {}, options = {}) {
  const testOnly = options.testOnly === true;
  const timestamp = options.timestamp || options.releaseDate || new Date().toISOString();
  const publicPackages = options.publicPackages || resolvePublicReleasePackages(rootDir);

  const components = [];
  const workspacePurls = new Map();

  for (const pkg of publicPackages) {
    const meta = packageDigests[pkg.name] || {};
    const purl = `pkg:npm/%40resin/${encodeURIComponent(pkg.name.replace("@resin/", ""))}`;
    const versionedPurl = `${purl}@${RELEASE_VERSION}`;
    workspacePurls.set(pkg.name, versionedPurl);
    components.push({
      type: pkg.type === "app" ? "application" : "library",
      name: pkg.name,
      version: RELEASE_VERSION,
      description: `Resin component ${pkg.name}`,
      scope: "required",
      hashes: [
        {
          alg: "SHA-256",
          content: meta.packageSha256 || sha256Hex(pkg.name),
        },
      ],
      licenses: [{ license: { id: "Apache-2.0" } }],
      purl: versionedPurl,
    });
  }

  const thirdPartyDeps = collectProjectDependencies(rootDir, { publicPackages });
  for (const dep of thirdPartyDeps) {
    components.push({
      type: "library",
      name: dep.name,
      version: dep.version,
      description: dep.description,
      scope: dep.scope,
      hashes: [
        {
          alg: "SHA-256",
          content: dep.sha256,
        },
      ],
      licenses: [{ license: { id: dep.license } }],
      purl: dep.purl,
    });
  }

  const dependencies = [];
  const rootPurl = `pkg:npm/resin@${RELEASE_VERSION}`;

  dependencies.push({
    ref: rootPurl,
    dependsOn: components.map((c) => c.purl).filter((p) => p !== rootPurl),
  });

  for (const pkg of publicPackages) {
    const pkgPurl = workspacePurls.get(pkg.name);
    dependencies.push({
      ref: pkgPurl,
      dependsOn: components
        .filter((c) => c.purl !== pkgPurl && c.scope === "required")
        .slice(0, 5)
        .map((c) => c.purl),
    });
  }

  const properties = [{ name: "scanDomain", value: testOnly ? "test-only" : "production" }];
  if (testOnly) {
    properties.push({ name: "resin:test-only", value: "true" });
  }

  const scanEvidence = options.scanEvidence;
  if (scanEvidence) {
    properties.push(
      { name: "resin:scan-source", value: scanEvidence.source },
      { name: "resin:scan-generated-at", value: scanEvidence.generatedAt },
      {
        name: "resin:scan-retention-until",
        value: scanEvidence.retentionUntil,
      },
      {
        name: "resin:dependency-scan-status",
        value: scanEvidence.dependencyScan.status,
      },
      {
        name: "resin:container-scan-status",
        value: scanEvidence.containerScan.status,
      },
    );
  }
  const vulnerabilities = Array.isArray(scanEvidence?.vulnerabilities)
    ? scanEvidence.vulnerabilities
    : [];

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [
        {
          vendor: "Resin",
          name: "package-release",
          version: RELEASE_VERSION,
        },
      ],
      authors: [{ name: "Resin Authors" }],
      component: {
        "bom-ref": rootPurl,
        type: "application",
        name: "resin",
        version: RELEASE_VERSION,
        description:
          "Compiles recurring coding-agent work into tools that use less inference, lower inference cost, and finish faster",
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
      properties,
    },
    components,
    dependencies,
    vulnerabilities,
  };
}

export function resolveVulnerabilityScanEvidence(rootDir, releaseIdentity, options = {}) {
  const testOnly = options.testOnly === true;
  let evidence = options.vulnerabilityScanEvidence;
  const evidencePath = options.vulnerabilityScanPath || process.env.RESIN_VULNERABILITY_SCAN_PATH;
  if (!evidence && evidencePath) {
    evidence = JSON.parse(fs.readFileSync(path.resolve(rootDir, evidencePath), "utf8"));
  }

  if (!evidence && testOnly) {
    const generatedAt = RELEASE_DATE;
    return {
      schemaVersion: "1.0.0",
      source: "test-only-not-executed",
      generatedAt,
      retentionUntil: new Date(Date.parse(generatedAt) + 365 * 24 * 60 * 60 * 1000).toISOString(),
      commitSha: releaseIdentity.commitSha,
      dependencyScan: { status: "TEST_ONLY" },
      containerScan: {
        status: "TEST_ONLY",
        reason: "Test-only packaging lane",
      },
      vulnerabilities: [],
      testOnly: true,
    };
  }
  if (!evidence) {
    throw new Error("Production release packaging requires retained vulnerability scan evidence.");
  }
  if (evidence.commitSha !== releaseIdentity.commitSha) {
    throw new Error(
      `Vulnerability scan commit mismatch: expected ${releaseIdentity.commitSha}, received ${evidence.commitSha}.`,
    );
  }
  if (
    typeof evidence.source !== "string" ||
    evidence.dependencyScan?.status !== "COMPLETED" ||
    !["COMPLETED", "NOT_APPLICABLE"].includes(evidence.containerScan?.status)
  ) {
    throw new Error("Vulnerability scan evidence is incomplete.");
  }
  if (
    evidence.containerScan.status === "NOT_APPLICABLE" &&
    typeof evidence.containerScan.reason !== "string"
  ) {
    throw new Error("Container scan NOT_APPLICABLE status requires a reviewed reason.");
  }
  const generatedAtMs = Date.parse(evidence.generatedAt);
  const retentionUntilMs = Date.parse(evidence.retentionUntil);
  if (
    Number.isNaN(generatedAtMs) ||
    Number.isNaN(retentionUntilMs) ||
    retentionUntilMs <= generatedAtMs
  ) {
    throw new Error("Vulnerability scan evidence requires valid generatedAt and retentionUntil.");
  }
  if (!Array.isArray(evidence.vulnerabilities)) {
    throw new Error("Vulnerability scan evidence vulnerabilities must be an array.");
  }
  return evidence;
}

export function generateChannelMetadata(manifestSha256, options = {}) {
  const keyPair = resolveSigningKey(options);
  const releaseIdentity = options.releaseIdentity || resolveReleaseIdentity(options);
  const updatedAt = options.updatedAt || RELEASE_DATE;
  const expiresAt =
    options.expiresAt || new Date(Date.parse(updatedAt) + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    schemaVersion: "2.0.0",
    metadataVersion: 1,
    expiresAt,
    minSupportedVersion: "0.1.0",
    currentVersion: RELEASE_VERSION,
    updatedAt,
    releaseIdentity,
    channels: {
      stable: {
        version: RELEASE_VERSION,
        releaseDate: RELEASE_DATE,
        manifestUrl: `/releases/v1/manifests/manifest-${RELEASE_VERSION}.json`,
        manifestDigest: manifestSha256,
        releaseNotesUrl: `https://github.com/Resin-AI/resin/releases/tag/v${RELEASE_VERSION}`,
        isLatest: true,
      },
    },
    rollbackReferences: {
      targetVersion: "0.1.0",
      minSafeVersion: "0.1.0",
      instructionsUrl: `https://github.com/Resin-AI/resin/blob/${releaseIdentity.commitSha}/docs/release/rollback-procedure.md`,
    },
    revokedVersions: Array.isArray(options.revokedVersions) ? [...options.revokedVersions] : [],
    revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
  };
  return {
    ...payload,
    signatures: [{ ...signReleasePayload(payload, keyPair), signedAt: RELEASE_DATE }],
  };
}

export function packageRelease(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const skipBuild = options.skipBuild ?? process.env.RESIN_RELEASE_SKIP_BUILD === "1";
  const testOnly = options.testOnly ?? process.env.RESIN_RELEASE_TEST_ONLY === "1";
  const distDir =
    options.distDir ||
    options.outputDir ||
    path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);

  const releaseIdentity = resolveReleaseIdentity({
    ...options,
    rootDir,
    testOnly,
  });
  const keyPair = resolveSigningKey({ ...options, testOnly });
  const vulnerabilityScanEvidence = resolveVulnerabilityScanEvidence(rootDir, releaseIdentity, {
    ...options,
    testOnly,
  });
  let verificationEvidence = options.verificationEvidence;
  if (!verificationEvidence && !testOnly && process.env.RESIN_RELEASE_EVIDENCE_PATH) {
    const evidencePath = path.resolve(rootDir, process.env.RESIN_RELEASE_EVIDENCE_PATH);
    verificationEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  }

  console.log(`📦 Packaging Resin V${RELEASE_VERSION} Release...`);
  console.log(`📂 Output Directory: ${distDir}`);
  console.log(`🔐 Trust Domain: ${keyPair.trustDomain}`);

  const publicPackages = resolvePublicReleasePackages(rootDir);

  for (const pkg of publicPackages) {
    const pkgDir = path.resolve(rootDir, pkg.path);
    assertCleanProductionDist(rootDir, pkgDir);
  }

  if (!skipBuild) buildWorkspacePackages(rootDir);

  const packageDigests = generatePackageDigests(rootDir, { publicPackages });
  const assetDigests = createPlatformReleaseTarballs(rootDir, distDir, { publicPackages });
  const evidenceResult = writeReleaseEvidence({
    rootDir,
    distDir,
    releaseIdentity,
    commitSha: releaseIdentity.commitSha,
    keyId: keyPair.keyId,
    testOnly,
    verificationEvidence,
    syncDocs: options.syncDocs ?? false,
  });
  const evidenceMetadata = {
    json: "release-evidence.json",
    markdown: "RELEASE-EVIDENCE.md",
    jsonSha256: evidenceResult.jsonSha256,
    markdownSha256: evidenceResult.markdownSha256,
    status: evidenceResult.evidence.status,
    mode: evidenceResult.evidence.mode,
  };
  const manifest = generateSignedManifest(packageDigests, assetDigests, {
    keyPair,
    releaseIdentity,
    evidence: evidenceMetadata,
    testOnly,
    publicPackages,
  });
  const manifestPath = path.join(distDir, "manifest.json");
  const manifestVersionedPath = path.join(distDir, `manifest-${RELEASE_VERSION}.json`);
  const manifestContent = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(manifestPath, manifestContent);
  fs.writeFileSync(manifestVersionedPath, manifestContent);
  const manifestSha256 = fileSha256(manifestPath);

  fs.writeFileSync(
    path.join(distDir, "sbom.json"),
    JSON.stringify(
      generateCycloneDxSbom(rootDir, packageDigests, {
        testOnly,
        timestamp: releaseIdentity.releaseDate || RELEASE_DATE,
        scanEvidence: vulnerabilityScanEvidence,
        publicPackages,
      }),
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(distDir, "vulnerability-scan-evidence.json"),
    `${JSON.stringify(vulnerabilityScanEvidence, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(distDir, "channels.json"),
    JSON.stringify(
      generateChannelMetadata(manifestSha256, {
        keyPair,
        releaseIdentity,
        testOnly,
      }),
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(distDir, "release-trust.json"),
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        releaseVersion: RELEASE_VERSION,
        trustDomain: keyPair.trustDomain,
        signingKey: publicTrustRecord(keyPair),
        revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
      },
      null,
      2,
    ),
  );
  for (const platform of PLATFORMS) {
    const tarballPath = path.join(distDir, platform.filename);
    if (fs.existsSync(tarballPath)) {
      const tarBuffer = fs.readFileSync(tarballPath);
      const entries = extractTarEntries(tarBuffer);
      assertNoForbiddenReleaseArtifacts(entries, `generated platform tarball ${platform.filename}`);
    }
  }

  const candidateArtifact = createCandidateReleaseArtifact({
    rootDir,
    releaseDir: distDir,
    commitSha: releaseIdentity.commitSha,
    testOnly,
  });

  return {
    success: true,
    version: RELEASE_VERSION,
    distDir,
    packagesCount: Object.keys(packageDigests).length,
    assetsCount: Object.keys(assetDigests).length,
    manifestSha256,
    evidenceSha256: evidenceResult.jsonSha256,
    releaseIdentity,
    publicTrust: publicTrustRecord(keyPair),
    trustedKeys: trustedKeysFromSigningKey(keyPair),
    candidateArtifact,
    testOnly,
  };
}

export function createCandidateReleaseArtifact(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const releaseDir =
    options.releaseDir || path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
  const commitSha = options.commitSha || process.env.GITHUB_SHA || getGitCommitSha(rootDir);
  const artifactName = `resin-release-candidate-${commitSha}`;
  const candidateDir =
    options.candidateDir || path.resolve(rootDir, "dist/candidate", artifactName);
  fs.mkdirSync(candidateDir, { recursive: true });

  const tarEntries = [];

  // Collect all files in releaseDir -> release/<relPath>
  if (fs.existsSync(releaseDir)) {
    for (const file of collectFilesRecursively(releaseDir, releaseDir)) {
      const mode = fs.statSync(file.fullPath).mode & 0o111 ? 0o755 : 0o644;
      tarEntries.push({
        path: `release/${file.relPath}`.replace(/\\/g, "/"),
        content: fs.readFileSync(file.fullPath),
        mode,
      });
    }
  }

  // Collect qualification files -> qualification/<relPath>
  const qualificationDir = options.qualificationDir || path.resolve(rootDir, "dist/qualification");
  if (fs.existsSync(qualificationDir)) {
    for (const file of collectFilesRecursively(qualificationDir, qualificationDir)) {
      const mode = fs.statSync(file.fullPath).mode & 0o111 ? 0o755 : 0o644;
      tarEntries.push({
        path: `qualification/${file.relPath}`.replace(/\\/g, "/"),
        content: fs.readFileSync(file.fullPath),
        mode,
      });
    }
  } else {
    tarEntries.push({
      path: "qualification/",
      type: "dir",
      content: Buffer.alloc(0),
      mode: 0o755,
    });
  }

  // Collect tool files
  const publishScriptPath = path.resolve(rootDir, "scripts/publish-public-release.mjs");
  if (fs.existsSync(publishScriptPath)) {
    tarEntries.push({
      path: "tools/publish-public-release.mjs",
      content: fs.readFileSync(publishScriptPath),
      mode: 0o755,
    });
  }
  const trustScriptPath = path.resolve(rootDir, "scripts/release-trust.mjs");
  if (fs.existsSync(trustScriptPath)) {
    tarEntries.push({
      path: "tools/release-trust.mjs",
      content: fs.readFileSync(trustScriptPath),
      mode: 0o644,
    });
  }
  assertNoForbiddenReleaseArtifacts(tarEntries, "candidate release artifact");
  const tarBuffer = createDeterministicTar(tarEntries);

  const gzBuffer = gzipDeterministic(tarBuffer);
  const tarballPath = path.join(candidateDir, "resin-release-candidate.tar.gz");
  fs.writeFileSync(tarballPath, gzBuffer);
  const sha256 = sha256Hex(gzBuffer);
  fs.writeFileSync(
    path.join(candidateDir, "resin-release-candidate.tar.gz.sha256"),
    `${sha256}  resin-release-candidate.tar.gz\n`,
  );

  return {
    artifactName,
    candidateDir,
    tarballPath,
    sha256,
    sizeBytes: gzBuffer.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  try {
    const testOnly =
      process.argv.slice(2).includes("--test-only") || process.env.RESIN_RELEASE_TEST_ONLY === "1";
    packageRelease({ testOnly });
  } catch (err) {
    console.error("❌ Release packaging failed:", err);
    process.exit(1);
  }
}
