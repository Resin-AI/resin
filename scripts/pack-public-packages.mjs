#!/usr/bin/env node

/**
 * Deterministic public package packager for Resin.
 *
 * Packages all 13 public packages into standalone release tarballs,
 * rewriting workspace:* references to immutable HTTPS artifact release URLs
 * and emitting a machine-readable JSON artifact manifest with SHA-256 digests.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PUBLIC_PACKAGE_COUNT = 13;
export const DEFAULT_MANIFEST_FILENAME = "packages-manifest.json";
export const REQUIRED_METADATA_FILES = ["LICENSE", "NOTICE"];
export const OPTIONAL_METADATA_FILES = ["README.md", "SECURITY.md"];

export const FORBIDDEN_DIR_NAMES = new Set([
  "src",
  "tests",
  "__tests__",
  "__mocks__",
  "node_modules",
  ".turbo",
  ".git",
]);

export const FORBIDDEN_FILE_PATTERNS = Object.freeze([
  /\.tsbuildinfo$/,
  /\.map$/,
  /^\.env(?:\..+)?$/,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
]);

/**
 * Generate standard tarball filename from package name and version.
 */
export function getTarballFilename(name, version) {
  if (!name || typeof name !== "string") {
    throw new Error(`Invalid package name: ${name}`);
  }
  if (!version || typeof version !== "string") {
    throw new Error(`Invalid package version for ${name}: ${version}`);
  }
  const sanitized = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${sanitized}-${version}.tgz`;
}

/**
 * Check if a relative file path matches forbidden release patterns.
 */
export function isForbiddenReleaseEntry(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/");

  for (const part of parts) {
    if (FORBIDDEN_DIR_NAMES.has(part)) return true;
  }

  const fileName = parts[parts.length - 1];
  for (const pattern of FORBIDDEN_FILE_PATTERNS) {
    if (pattern.test(fileName)) return true;
  }

  return false;
}

/**
 * Rewrite all workspace:* dependencies in a package manifest to immutable artifact URLs.
 */
export function rewriteManifestDependencies(manifest, publicPackageMap, artifactBaseUrl) {
  if (!artifactBaseUrl || typeof artifactBaseUrl !== "string") {
    throw new Error("Artifact base URL is required");
  }
  const normalizedBaseUrl = artifactBaseUrl.trim();
  if (!normalizedBaseUrl.startsWith("https://")) {
    throw new Error(`Artifact base URL must be an HTTPS URL, got: "${artifactBaseUrl}"`);
  }
  const baseUrl = normalizedBaseUrl.replace(/\/+$/, "");

  const pkg = JSON.parse(JSON.stringify(manifest));
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  for (const section of sections) {
    if (!pkg[section] || typeof pkg[section] !== "object") continue;
    for (const [depName, depVer] of Object.entries(pkg[section])) {
      if (publicPackageMap[depName]) {
        const tarball = publicPackageMap[depName].tarball;
        pkg[section][depName] = `${baseUrl}/${tarball}`;
      } else if (typeof depVer === "string" && depVer.includes("workspace:")) {
        throw new Error(
          `Unresolved workspace dependency in package "${pkg.name || "unknown"}" (${section}): ${depName} -> ${depVer}`,
        );
      }
    }
  }

  // Reject any remaining workspace:* specifiers across all dependency sections
  for (const section of sections) {
    if (!pkg[section] || typeof pkg[section] !== "object") continue;
    for (const [depName, depVer] of Object.entries(pkg[section])) {
      if (typeof depVer === "string" && depVer.includes("workspace:")) {
        throw new Error(
          `Unresolved workspace:* dependency remaining in staged manifest for "${pkg.name}": ${section}.${depName} = "${depVer}"`,
        );
      }
    }
  }

  return pkg;
}

/**
 * Recursively collect files from a directory.
 */
function collectFilesRecursively(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push({ fullPath, relPath });
    }
  }

  return results;
}

/**
 * Validate staged package directory before packing.
 */
export function validateStagedPackage(stagedDir, pkgName) {
  const manifestPath = path.join(stagedDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing package.json in staged package directory for "${pkgName}"`);
  }

  const distDir = path.join(stagedDir, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`Missing dist directory in staged package directory for "${pkgName}"`);
  }

  const distFiles = collectFilesRecursively(distDir, stagedDir);
  if (distFiles.length === 0) {
    throw new Error(`Empty dist directory in staged package directory for "${pkgName}"`);
  }

  for (const meta of REQUIRED_METADATA_FILES) {
    const metaPath = path.join(stagedDir, meta);
    if (!fs.existsSync(metaPath)) {
      throw new Error(
        `Missing required metadata file "${meta}" in staged package directory for "${pkgName}"`,
      );
    }
  }

  const allFiles = collectFilesRecursively(stagedDir, stagedDir);
  for (const file of allFiles) {
    if (isForbiddenReleaseEntry(file.relPath)) {
      throw new Error(
        `Forbidden release entry "${file.relPath}" detected in staged package directory for "${pkgName}"`,
      );
    }
  }
}

/**
 * Stage a public package for packaging.
 */
export function stagePackage(sourcePkgDir, stagedPkgDir, rewrittenManifest, rootDir) {
  fs.mkdirSync(stagedPkgDir, { recursive: true });

  // 1. Write rewritten package.json
  fs.writeFileSync(
    path.join(stagedPkgDir, "package.json"),
    `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
  );

  // 2. Validate and copy dist/
  const sourceDistDir = path.join(sourcePkgDir, "dist");
  if (!fs.existsSync(sourceDistDir)) {
    throw new Error(
      `Missing dist directory for package "${rewrittenManifest.name}" at "${sourcePkgDir}"`,
    );
  }
  const sourceDistFiles = collectFilesRecursively(sourceDistDir, sourceDistDir);
  if (sourceDistFiles.length === 0) {
    throw new Error(
      `Empty dist directory for package "${rewrittenManifest.name}" at "${sourcePkgDir}"`,
    );
  }

  const destDistDir = path.join(stagedPkgDir, "dist");
  fs.mkdirSync(destDistDir, { recursive: true });

  for (const file of sourceDistFiles) {
    if (isForbiddenReleaseEntry(`dist/${file.relPath}`)) continue;
    const destFile = path.join(destDistDir, file.relPath);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(file.fullPath, destFile);
  }

  // 3. Copy bin/ if exists or defined in manifest
  const sourceBinDir = path.join(sourcePkgDir, "bin");
  if (fs.existsSync(sourceBinDir)) {
    const binFiles = collectFilesRecursively(sourceBinDir, sourceBinDir);
    const destBinDir = path.join(stagedPkgDir, "bin");
    fs.mkdirSync(destBinDir, { recursive: true });

    for (const file of binFiles) {
      if (isForbiddenReleaseEntry(`bin/${file.relPath}`)) continue;
      const destFile = path.join(destBinDir, file.relPath);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(file.fullPath, destFile);
      try {
        const stat = fs.statSync(file.fullPath);
        fs.chmodSync(destFile, stat.mode);
      } catch {
        // ignore chmod failures
      }
    }
  }

  // 4. Copy metadata files (LICENSE, NOTICE, README.md, SECURITY.md)
  const metadataFiles = [...REQUIRED_METADATA_FILES, ...OPTIONAL_METADATA_FILES];
  for (const meta of metadataFiles) {
    const pkgMetaPath = path.join(sourcePkgDir, meta);
    const rootMetaPath = path.join(rootDir, meta);
    const destMetaPath = path.join(stagedPkgDir, meta);

    if (fs.existsSync(pkgMetaPath)) {
      fs.copyFileSync(pkgMetaPath, destMetaPath);
    } else if (fs.existsSync(rootMetaPath)) {
      fs.copyFileSync(rootMetaPath, destMetaPath);
    }
  }

  // Validate staged output
  validateStagedPackage(stagedPkgDir, rewrittenManifest.name);
}

/**
 * Audit tarball contents for forbidden entries and required metadata.
 */
export function auditTarballContents(tarballPath, pkgName) {
  const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
  const listing = execFileSync(tarCmd, ["-tzf", tarballPath], { encoding: "utf-8" });
  const entries = listing
    .split("\n")
    .map((e) => e.trim())
    .filter(Boolean);

  const prefix = "package/";
  const relEntries = entries.map((e) => (e.startsWith(prefix) ? e.slice(prefix.length) : e));

  for (const entry of relEntries) {
    if (isForbiddenReleaseEntry(entry)) {
      throw new Error(
        `Forbidden release entry "${entry}" detected in tarball for "${pkgName}": ${tarballPath}`,
      );
    }
  }

  // Verify package.json, LICENSE, and NOTICE exist
  const hasPkgJson = relEntries.includes("package.json");
  const hasLicense = relEntries.includes("LICENSE");
  const hasNotice = relEntries.includes("NOTICE");

  if (!hasPkgJson) {
    throw new Error(`Tarball for "${pkgName}" is missing package.json: ${tarballPath}`);
  }
  if (!hasLicense) {
    throw new Error(`Tarball for "${pkgName}" is missing LICENSE: ${tarballPath}`);
  }
  if (!hasNotice) {
    throw new Error(`Tarball for "${pkgName}" is missing NOTICE: ${tarballPath}`);
  }
}

/**
 * Compute SHA-256 hex digest of a file.
 */
export function computeFileSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Main packager function.
 */
export function packPublicPackages(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const outputDir = path.resolve(rootDir, options.outputDir ?? "dist/packages");
  const manifestFilename = options.manifest ?? DEFAULT_MANIFEST_FILENAME;
  const splitConfigFile = path.resolve(rootDir, options.splitConfig ?? "repository-split.json");

  // 1. Validate Base URL
  const artifactBaseUrl = options.artifactBaseUrl;
  if (!artifactBaseUrl || typeof artifactBaseUrl !== "string") {
    throw new Error("Artifact base URL is required (--artifact-base-url <https-url>)");
  }
  const normalizedBaseUrl = artifactBaseUrl.trim();
  if (!normalizedBaseUrl.startsWith("https://")) {
    throw new Error(`Artifact base URL must be an HTTPS URL, got: "${artifactBaseUrl}"`);
  }
  const baseUrl = normalizedBaseUrl.replace(/\/+$/, "");

  // 2. Load and validate repository-split.json
  if (!fs.existsSync(splitConfigFile)) {
    throw new Error(`Repository split configuration not found: ${splitConfigFile}`);
  }
  const splitConfig = JSON.parse(fs.readFileSync(splitConfigFile, "utf-8"));

  if (
    !Array.isArray(splitConfig.publicPackageManifests) ||
    splitConfig.publicPackageManifests.length !== PUBLIC_PACKAGE_COUNT
  ) {
    throw new Error(
      `Unexpected public package count: expected ${PUBLIC_PACKAGE_COUNT}, found ${splitConfig.publicPackageManifests?.length ?? 0}`,
    );
  }

  // 3. Build public package registry & check for collisions/root package
  const publicPackageMap = {};
  const tarballNames = new Set();

  for (const manifestRelPath of splitConfig.publicPackageManifests) {
    // Reject root workspace packaging
    if (
      manifestRelPath === "package.json" ||
      path.resolve(rootDir, manifestRelPath) === path.resolve(rootDir, "package.json")
    ) {
      throw new Error("Root workspace package must not be packaged as a public release package");
    }

    const fullManifestPath = path.resolve(rootDir, manifestRelPath);
    if (!fs.existsSync(fullManifestPath)) {
      throw new Error(`Public package manifest not found: ${manifestRelPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(fullManifestPath, "utf-8"));
    if (manifest.private === true) {
      throw new Error(
        `Private package "${manifest.name}" must not be included in public package manifests`,
      );
    }

    const tarball = getTarballFilename(manifest.name, manifest.version);
    if (tarballNames.has(tarball)) {
      throw new Error(`Duplicate tarball name detected: "${tarball}" for "${manifest.name}"`);
    }
    tarballNames.add(tarball);

    publicPackageMap[manifest.name] = {
      name: manifest.name,
      version: manifest.version,
      tarball,
      manifestRelPath,
      sourcePkgDir: path.dirname(fullManifestPath),
      manifest,
    };
  }

  if (Object.keys(publicPackageMap).length !== PUBLIC_PACKAGE_COUNT) {
    throw new Error(
      `Expected exactly ${PUBLIC_PACKAGE_COUNT} public packages in map, got ${Object.keys(publicPackageMap).length}`,
    );
  }

  // 4. Prepare staging and output directories
  fs.mkdirSync(outputDir, { recursive: true });
  const ownsStaging = !options.stagingDir;
  const stagingBaseDir = path.resolve(
    options.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "resin-pack-public-")),
  );
  fs.mkdirSync(stagingBaseDir, { recursive: true });

  const packagedList = [];

  try {
    // 5. Stage, rewrite, pack, and audit each package
    for (const info of Object.values(publicPackageMap)) {
      const sanitizedName = info.tarball.replace(/\.tgz$/, "");
      const stagedPkgDir = path.join(stagingBaseDir, sanitizedName);

      // Rewrite dependencies to immutable artifact URLs
      const rewrittenManifest = rewriteManifestDependencies(
        info.manifest,
        publicPackageMap,
        baseUrl,
      );

      // Stage package
      stagePackage(info.sourcePkgDir, stagedPkgDir, rewrittenManifest, rootDir);

      // Pack using npm pack
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      execFileSync(npmCmd, ["pack", stagedPkgDir, "--pack-destination", outputDir, "--json"], {
        stdio: "pipe",
        encoding: "utf-8",
      });

      const tarballPath = path.join(outputDir, info.tarball);
      if (!fs.existsSync(tarballPath)) {
        throw new Error(
          `Expected tarball "${info.tarball}" was not generated in output directory "${outputDir}"`,
        );
      }

      // Audit tarball entries
      auditTarballContents(tarballPath, info.name);

      // Compute SHA-256 digest
      const sha256 = computeFileSha256(tarballPath);
      const url = `${baseUrl}/${info.tarball}`;

      packagedList.push({
        name: info.name,
        version: info.version,
        tarball: info.tarball,
        url,
        sha256,
        integrity: `sha256-${sha256}`,
        manifestPath: info.manifestRelPath,
      });
    }

    // 6. Emit manifest
    const manifestData = {
      version: "1.0.0",
      artifactBaseUrl: baseUrl,
      count: packagedList.length,
      packages: packagedList,
    };

    const manifestPath = path.isAbsolute(manifestFilename)
      ? manifestFilename
      : path.join(outputDir, manifestFilename);

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifestData, null, 2)}\n`);

    return {
      success: true,
      count: packagedList.length,
      outputDir,
      manifestPath,
      packages: packagedList,
    };
  } finally {
    if (ownsStaging && options.cleanStaging !== false) {
      try {
        fs.rmSync(stagingBaseDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/**
 * Parse CLI arguments.
 */
export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact-base-url" && i + 1 < argv.length) {
      options.artifactBaseUrl = argv[++i];
    } else if (arg.startsWith("--artifact-base-url=")) {
      options.artifactBaseUrl = arg.slice("--artifact-base-url=".length);
    } else if (arg === "--output-dir" && i + 1 < argv.length) {
      options.outputDir = argv[++i];
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--manifest" && i + 1 < argv.length) {
      options.manifest = argv[++i];
    } else if (arg.startsWith("--manifest=")) {
      options.manifest = arg.slice("--manifest=".length);
    } else if (arg === "--root-dir" && i + 1 < argv.length) {
      options.rootDir = argv[++i];
    } else if (arg.startsWith("--root-dir=")) {
      options.rootDir = arg.slice("--root-dir=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: release:packages [options]

Options:
  --artifact-base-url <url>  Base HTTPS URL for immutable release tarballs (required)
  --output-dir <dir>         Output directory for tarballs and manifest (default: dist/packages)
  --manifest <filename>      Manifest filename (default: packages-manifest.json)
  --root-dir <dir>           Root workspace directory (default: cwd)
  --help, -h                 Show this help message
`);
      process.exit(0);
    }
  }
  return options;
}

// CLI entrypoint
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = packPublicPackages(args);
    console.log(`Successfully packaged ${result.count} public packages to ${result.outputDir}`);
    console.log(`Artifact manifest written to ${result.manifestPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
