#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * @typedef {Object} PackageInfo
 * @property {string} dir - Relative directory path (e.g., "packages/contracts")
 * @property {string} fullDir - Absolute directory path
 * @property {string} name - Package name from package.json
 * @property {Record<string, string>} dependencies
 * @property {Record<string, string>} devDependencies
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, any>} exports
 * @property {boolean} [private]
 */

/**
 * @typedef {Object} BoundaryViolation
 * @property {string} file - Relative path to the offending file
 * @property {number} line - 1-based line number
 * @property {string} [importPath] - The imported specifier
 * @property {string} rule - Rule violated
 * @property {string} message - Description of the violation
 */

/**
 * @typedef {Object} BoundaryManifest
 * @property {string[]} publicPackages
 * @property {string[]} privatePackages
 * @property {string[]} publicReleasePackages
 * @property {string[]} cloudOnlyPaths
 * @property {string[]} publicDocumentationPaths
 * @property {string[]} publicTestFixturePaths
 */

export const MANIFEST_FILENAME = "resin-boundary.json";
export const REQUIRED_MANIFEST_ARRAYS = [
  "publicPackages",
  "privatePackages",
  "publicReleasePackages",
  "cloudOnlyPaths",
  "publicDocumentationPaths",
  "publicTestFixturePaths",
];

const WORKSPACE_PATTERNS = ["apps", "packages", "adapters", "fixtures"];

/**
 * Discover all workspace packages.
 * @param {string} rootDir
 * @returns {Map<string, PackageInfo>} Map from package name to PackageInfo
 */
export function discoverPackages(rootDir) {
  const packages = new Map();

  for (const group of WORKSPACE_PATTERNS) {
    const groupDir = path.join(rootDir, group);
    if (!fs.existsSync(groupDir)) continue;

    const entries = fs.readdirSync(groupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pkgDir = path.join(group, entry.name);
        const fullDir = path.join(groupDir, entry.name);
        const pkgJsonPath = path.join(fullDir, "package.json");

        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          packages.set(pkgJson.name, {
            dir: pkgDir,
            fullDir,
            name: pkgJson.name,
            dependencies: pkgJson.dependencies || {},
            devDependencies: pkgJson.devDependencies || {},
            peerDependencies: pkgJson.peerDependencies || {},
            exports: pkgJson.exports || {},
            private: pkgJson.private ?? false,
          });
        }
      }
    }
  }

  return packages;
}

/**
 * Load canonical boundary manifest from disk or custom path.
 * @param {string} [rootDir=process.cwd()]
 * @param {string} [manifestPath]
 * @returns {BoundaryManifest}
 */
export function loadManifest(rootDir = process.cwd(), manifestPath = undefined) {
  const targetPath = manifestPath || path.join(rootDir, MANIFEST_FILENAME);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Boundary manifest not found at "${targetPath}".`);
  }
  const raw = fs.readFileSync(targetPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Validate boundary manifest structure and classification consistency.
 * @param {BoundaryManifest} manifest
 * @param {Map<string, PackageInfo>} [allPackages]
 * @param {string} [rootDir]
 * @returns {BoundaryViolation[]}
 */
export function validateManifest(manifest, allPackages, rootDir) {
  const violations = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    violations.push({
      file: MANIFEST_FILENAME,
      line: 1,
      rule: "invalid-manifest-structure",
      message: `Manifest "${MANIFEST_FILENAME}" must be a JSON object.`,
    });
    return violations;
  }

  for (const field of REQUIRED_MANIFEST_ARRAYS) {
    if (!Array.isArray(manifest[field])) {
      violations.push({
        file: MANIFEST_FILENAME,
        line: 1,
        rule: "invalid-manifest-structure",
        message: `Manifest "${MANIFEST_FILENAME}" is missing required array field "${field}".`,
      });
    } else {
      const seen = new Set();
      for (const entry of manifest[field]) {
        if (typeof entry !== "string") {
          violations.push({
            file: MANIFEST_FILENAME,
            line: 1,
            rule: "invalid-manifest-structure",
            message: `Manifest array "${field}" must contain only strings, received ${typeof entry}.`,
          });
        } else if (seen.has(entry)) {
          violations.push({
            file: MANIFEST_FILENAME,
            line: 1,
            rule: "duplicate-manifest-entry",
            message: `Manifest array "${field}" contains duplicate entry "${entry}".`,
          });
        }
        seen.add(entry);
      }
    }
  }

  const publicSet = new Set(manifest.publicPackages || []);
  const privateSet = new Set(manifest.privatePackages || []);
  const publicReleaseSet = new Set(manifest.publicReleasePackages || []);
  const fixturePaths = new Set(manifest.publicTestFixturePaths || []);

  // Check duplicate classification across public and private
  for (const pkgName of publicSet) {
    if (privateSet.has(pkgName)) {
      violations.push({
        file: MANIFEST_FILENAME,
        line: 1,
        rule: "duplicate-package-classification",
        message: `Package "${pkgName}" is classified in both publicPackages and privatePackages.`,
      });
    }
  }

  // Check publicReleasePackages does not contain private packages or fixture-only packages
  for (const pkgName of publicReleaseSet) {
    if (privateSet.has(pkgName)) {
      violations.push({
        file: MANIFEST_FILENAME,
        line: 1,
        rule: "private-package-in-public-release",
        message: `Private package "${pkgName}" cannot be included in publicReleasePackages allowlist.`,
      });
    } else if (
      fixturePaths.has(pkgName) ||
      Array.from(fixturePaths).some(
        (p) =>
          p.endsWith(pkgName) ||
          pkgName.includes("test-fixtures") ||
          (allPackages &&
            allPackages.get(pkgName)?.dir &&
            fixturePaths.has(allPackages.get(pkgName).dir)),
      )
    ) {
      violations.push({
        file: MANIFEST_FILENAME,
        line: 1,
        rule: "fixture-package-in-public-release",
        message: `Test fixture package "${pkgName}" cannot be included in publicReleasePackages allowlist.`,
      });
    } else if (!publicSet.has(pkgName)) {
      violations.push({
        file: MANIFEST_FILENAME,
        line: 1,
        rule: "invalid-release-allowlist",
        message: `Release package "${pkgName}" is not listed in publicPackages.`,
      });
    }
  }

  // Validate workspace packages vs manifest: classified exactly once
  if (allPackages && allPackages instanceof Map) {
    for (const [pkgName, pkg] of allPackages) {
      const isPublic = publicSet.has(pkgName);
      const isPrivate = privateSet.has(pkgName);
      const isFixture = fixturePaths.has(pkg.dir) || fixturePaths.has(pkgName);

      const classifications = [isPublic, isPrivate, isFixture].filter(Boolean).length;

      if (classifications === 0) {
        violations.push({
          file: MANIFEST_FILENAME,
          line: 1,
          rule: "unclassified-workspace-package",
          message: `Workspace package "${pkgName}" in "${pkg.dir}" is not classified in the boundary manifest.`,
        });
      } else if (classifications > 1) {
        violations.push({
          file: MANIFEST_FILENAME,
          line: 1,
          rule: "multiple-package-classification",
          message: `Workspace package "${pkgName}" in "${pkg.dir}" is classified in multiple categories in the boundary manifest.`,
        });
      }
    }
  }
  return violations;
}

/**
 * Extract all import and export statements from a file's content.
 * @param {string} content
 * @returns {Array<{ importPath: string, line: number }>}
 */
export function extractImports(content) {
  const imports = [];
  const lines = content.split("\n");

  // Regex patterns for various import/export forms
  const importRegex = /(?:import\s+(?:[\s\w{},*]+\s+from\s+)?|import\s*\()['"]([^'"]+)['"]/g;
  const exportFromRegex = /export\s+(?:[\s\w{},*]+\s+from\s+)['"]([^'"]+)['"]/g;
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Skip comment lines
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    for (const match of line.matchAll(importRegex)) {
      imports.push({ importPath: match[1], line: i + 1 });
    }
    for (const match of line.matchAll(exportFromRegex)) {
      imports.push({ importPath: match[1], line: i + 1 });
    }
    for (const match of line.matchAll(requireRegex)) {
      imports.push({ importPath: match[1], line: i + 1 });
    }
  }

  return imports;
}

/**
 * Check if an import specifier matches a valid declared export of a package.
 * @param {string} importPath
 * @param {string} pkgName
 * @param {Record<string, any>} exports
 * @returns {boolean}
 */
export function isValidExportMatch(importPath, pkgName, exports) {
  if (!exports) return true;
  if (importPath === pkgName) {
    return "." in exports || typeof exports === "string";
  }

  if (typeof exports === "string") {
    return false;
  }

  const subpath = `.${importPath.slice(pkgName.length)}`;

  // Exact match in exports map
  if (subpath in exports) {
    return true;
  }

  // Pattern match (e.g., "./*": "./dist/*.js")
  for (const key of Object.keys(exports)) {
    if (key.includes("*")) {
      const prefix = key.slice(0, key.indexOf("*"));
      const suffix = key.slice(key.indexOf("*") + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check boundary rules for a single package.
 * @param {PackageInfo} pkg
 * @param {Map<string, PackageInfo>} allPackages
 * @param {string} rootDir
 * @param {BoundaryManifest} [manifest]
 * @returns {BoundaryViolation[]}
 */
export function checkPackageBoundaries(pkg, allPackages, rootDir, manifest) {
  const violations = [];
  const srcAndTestDirs = [path.join(pkg.fullDir, "src"), path.join(pkg.fullDir, "tests")];

  const files = [];
  function collectFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  for (const d of srcAndTestDirs) {
    collectFiles(d);
  }

  const allowedDeps = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ]);

  const isPublic = manifest
    ? (manifest.publicPackages && manifest.publicPackages.includes(pkg.name)) ||
      (manifest.publicTestFixturePaths &&
        (manifest.publicTestFixturePaths.includes(pkg.dir) ||
          manifest.publicTestFixturePaths.includes(pkg.name)))
    : false;

  // Rule: Public package must not depend on private packages in package.json
  if (isPublic && manifest && manifest.privatePackages) {
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };
    for (const dep of Object.keys(allDeps)) {
      if (manifest.privatePackages.includes(dep)) {
        violations.push({
          file: path.join(pkg.dir, "package.json"),
          line: 1,
          importPath: dep,
          rule: "public-to-private-dependency",
          message: `Public package "${pkg.name}" must not depend on private package "${dep}".`,
        });
      }
    }
  }

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    const imports = extractImports(content);
    const relFile = path.relative(rootDir, filePath).replace(/\\/g, "/");

    for (const { importPath, line } of imports) {
      // 1. Check relative imports crossing package boundary
      if (importPath.startsWith(".")) {
        const resolvedTarget = path.resolve(path.dirname(filePath), importPath);
        const relToRoot = path.relative(rootDir, resolvedTarget).replace(/\\/g, "/");
        const relToPkg = path.relative(pkg.fullDir, resolvedTarget).replace(/\\/g, "/");

        // If public, check if reaching into cloud-only paths
        if (isPublic && manifest && manifest.cloudOnlyPaths) {
          for (const cloudPath of manifest.cloudOnlyPaths) {
            const normalizedCloudPath = cloudPath.replace(/\\/g, "/");
            if (
              relToRoot === normalizedCloudPath ||
              relToRoot.startsWith(`${normalizedCloudPath}/`)
            ) {
              violations.push({
                file: relFile,
                line,
                importPath,
                rule: "forbidden-cloud-path-import",
                message: `Public file "${relFile}" imports forbidden cloud-only path "${relToRoot}".`,
              });
            }
          }
        }

        // If public, check if reaching into private package directories
        if (isPublic && manifest && manifest.privatePackages) {
          for (const privPkgName of manifest.privatePackages) {
            const privPkg = allPackages.get(privPkgName);
            if (privPkg) {
              const relToPriv = path.relative(privPkg.fullDir, resolvedTarget).replace(/\\/g, "/");
              if (!relToPriv.startsWith("..") && !path.isAbsolute(relToPriv)) {
                violations.push({
                  file: relFile,
                  line,
                  importPath,
                  rule: "no-public-to-private-import",
                  message: `Public package "${pkg.name}" (${relFile}:${line}) forbidden to import private package "${privPkgName}" via relative path "${importPath}".`,
                });
              }
            }
          }
        }

        // If relative import leaves the package root
        if (relToPkg.startsWith("..") || path.isAbsolute(relToPkg)) {
          violations.push({
            file: relFile,
            line,
            importPath,
            rule: "no-relative-cross-package",
            message: `Illegal relative import "${importPath}" crosses package boundary into "${relToPkg}". Use workspace package specifier instead.`,
          });
        }
      } else {
        // Non-relative import

        // If public, check if importing cloud-only path directly
        if (isPublic && manifest && manifest.cloudOnlyPaths) {
          for (const cloudPath of manifest.cloudOnlyPaths) {
            const normalizedCloudPath = cloudPath.replace(/\\/g, "/");
            if (
              importPath === normalizedCloudPath ||
              importPath.startsWith(`${normalizedCloudPath}/`)
            ) {
              violations.push({
                file: relFile,
                line,
                importPath,
                rule: "forbidden-cloud-path-import",
                message: `Public file "${relFile}" imports forbidden cloud-only path "${importPath}".`,
              });
            }
          }
        }

        // If public, check if importing private package
        if (isPublic && manifest && manifest.privatePackages) {
          for (const privPkgName of manifest.privatePackages) {
            if (importPath === privPkgName || importPath.startsWith(`${privPkgName}/`)) {
              violations.push({
                file: relFile,
                line,
                importPath,
                rule: "no-public-to-private-import",
                message: `Public package "${pkg.name}" (${relFile}:${line}) forbidden to import private package "${privPkgName}".`,
              });
            }
          }
        }

        // 2. Check workspace package imports
        for (const [targetPkgName, targetPkg] of allPackages) {
          if (importPath === targetPkgName || importPath.startsWith(`${targetPkgName}/`)) {
            // Self-import is allowed if configured, but relative is preferred in src
            if (targetPkgName === pkg.name) {
              continue;
            }

            // Rule: Must be declared in dependencies / devDependencies
            if (!allowedDeps.has(targetPkgName)) {
              violations.push({
                file: relFile,
                line,
                importPath,
                rule: "undeclared-workspace-dependency",
                message: `Package "${pkg.name}" imports "${targetPkgName}" but it is not listed in package.json dependencies.`,
              });
            }

            // Rule: Cannot import internal paths directly (e.g. /src/...)
            if (importPath.includes("/src/") || importPath.includes("/dist/")) {
              violations.push({
                file: relFile,
                line,
                importPath,
                rule: "no-deep-internal-import",
                message: `Deep import into internal path "${importPath}" is forbidden. Import from declared package exports.`,
              });
            } else if (!isValidExportMatch(importPath, targetPkgName, targetPkg.exports)) {
              violations.push({
                file: relFile,
                line,
                importPath,
                rule: "unexported-subpath-import",
                message: `Import "${importPath}" does not match any declared export in "${targetPkgName}".`,
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Main boundary check function.
 * @param {string} [rootDir=process.cwd()]
 * @param {Object} [options]
 * @param {BoundaryManifest} [options.manifest]
 * @param {string} [options.manifestPath]
 * @returns {{ violations: BoundaryViolation[], packageCount: number, manifest: BoundaryManifest | null }}
 */
export function checkBoundaries(rootDir = process.cwd(), options = {}) {
  const allViolations = [];
  const allPackages = discoverPackages(rootDir);

  let manifest = options.manifest;
  if (!manifest) {
    try {
      manifest = loadManifest(rootDir, options.manifestPath);
    } catch (err) {
      allViolations.push({
        file: MANIFEST_FILENAME,
        line: 1,
        rule: "invalid-manifest-structure",
        message: err.message,
      });
      return {
        violations: allViolations,
        packageCount: allPackages.size,
        manifest: null,
      };
    }
  }

  const manifestViolations = validateManifest(manifest, allPackages, rootDir);
  allViolations.push(...manifestViolations);

  for (const pkg of allPackages.values()) {
    const pkgViolations = checkPackageBoundaries(pkg, allPackages, rootDir, manifest);
    allViolations.push(...pkgViolations);
  }

  return {
    violations: allViolations,
    packageCount: allPackages.size,
    manifest,
  };
}

// If run directly from CLI
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  console.log("🔍 Checking monorepo package and repository boundaries...\n");
  const { violations, packageCount } = checkBoundaries();

  console.log(`Discovered ${packageCount} workspace packages.`);
  if (violations.length === 0) {
    console.log(
      "✅ All package boundaries, manifest integrity, and architectural rules are respected.\n",
    );
    process.exit(0);
  } else {
    console.error(`❌ Found ${violations.length} boundary violation(s):\n`);
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line}`);
      console.error(`    ${v.message}\n`);
    }
    process.exit(1);
  }
}
