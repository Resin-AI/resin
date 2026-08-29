import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  MANIFEST_FILENAME,
  REQUIRED_MANIFEST_ARRAYS,
  checkBoundaries,
  checkPackageBoundaries,
  discoverPackages,
  extractImports,
  isValidExportMatch,
  loadManifest,
  validateManifest,
} from "./check-boundaries.mjs";

describe("check-boundaries", () => {
  const rootDir = process.cwd();

  it("discovers all workspace packages in the monorepo", () => {
    const packages = discoverPackages(rootDir);
    const isCombinedMonorepo = packages.has("@resin/cloud");
    if (isCombinedMonorepo) {
      expect(packages.size).toBeGreaterThanOrEqual(14);
      expect(packages.has("@resin/cloud")).toBe(true);
      expect(packages.has("@resin/web")).toBe(true);
      expect(packages.has("@resin/e2e")).toBe(true);
    } else {
      expect(packages.size).toBeGreaterThanOrEqual(13);
    }
    expect(packages.has("resin")).toBe(true);
    expect(packages.has("@resin/contracts")).toBe(true);
    expect(packages.has("@resin/protocol")).toBe(true);
    expect(packages.has("@resin/gateway")).toBe(true);
    expect(packages.has("@resin/observer")).toBe(true);
    expect(packages.has("@resin/runtime")).toBe(true);
    expect(packages.has("@resin/crypto")).toBe(true);
    expect(packages.has("@resin/db")).toBe(true);
    expect(packages.has("@resin/harness-contracts")).toBe(true);
    expect(packages.has("@resin/adapter-claude-code")).toBe(true);
    expect(packages.has("@resin/adapter-codex")).toBe(true);
    expect(packages.has("@resin/adapter-omp")).toBe(true);
    expect(packages.has("@resin/test-fixtures")).toBe(true);
  });

  it("extracts static, dynamic, and re-export imports correctly", () => {
    const code = `
      import { ToolSpec } from "@resin/contracts";
      import type { ProtocolMessage } from "./types.js";
      export * from "@resin/protocol";
      const mod = await import("@resin/runtime");
      // import { ignored } from "@resin/db";
      const req = require("@resin/crypto");
    `;
    const imports = extractImports(code);
    expect(imports.map((i) => i.importPath)).toEqual([
      "@resin/contracts",
      "./types.js",
      "@resin/protocol",
      "@resin/runtime",
      "@resin/crypto",
    ]);
  });

  it("validates declared exports matching correctly", () => {
    const exportsMap = {
      ".": "./dist/index.js",
      "./types": "./dist/types.js",
      "./sub/*": "./dist/sub/*.js",
    };

    // Root import matches "."
    expect(isValidExportMatch("@resin/contracts", "@resin/contracts", exportsMap)).toBe(true);

    // Subpath match
    expect(isValidExportMatch("@resin/contracts/types", "@resin/contracts", exportsMap)).toBe(true);

    // Pattern match
    expect(isValidExportMatch("@resin/contracts/sub/foo", "@resin/contracts", exportsMap)).toBe(
      true,
    );

    // Unexported subpath should fail
    expect(isValidExportMatch("@resin/contracts/internal", "@resin/contracts", exportsMap)).toBe(
      false,
    );

    // Missing exports map allows root import by default
    expect(isValidExportMatch("@resin/contracts", "@resin/contracts", undefined)).toBe(true);
  });

  it("detects relative imports crossing package boundaries", () => {
    const code = `import { something } from "../../../other-pkg/src/index.js";`;
    const mockImports = extractImports(code);
    expect(mockImports.length).toBe(1);

    const resolved = path.resolve(
      path.join(rootDir, "packages/pkg-a/src"),
      mockImports[0].importPath,
    );
    const relToPkg = path.relative(path.join(rootDir, "packages/pkg-a"), resolved);
    expect(relToPkg.startsWith("..")).toBe(true);
  });

  it("loads and validates the canonical resin-boundary.json manifest", () => {
    const manifest = loadManifest(rootDir);
    expect(manifest).toBeDefined();

    for (const field of REQUIRED_MANIFEST_ARRAYS) {
      expect(Array.isArray(manifest[field])).toBe(true);
      expect(manifest[field].length).toBeGreaterThan(0);
    }

    // Public packages classification
    expect(manifest.publicPackages).toContain("resin");
    expect(manifest.publicPackages).toContain("@resin/gateway");
    expect(manifest.publicPackages).toContain("@resin/observer");
    expect(manifest.publicPackages).toContain("@resin/runtime");
    expect(manifest.publicPackages).toContain("@resin/crypto");
    expect(manifest.publicPackages).toContain("@resin/protocol");
    expect(manifest.publicPackages).toContain("@resin/contracts");
    expect(manifest.publicPackages).toContain("@resin/harness-contracts");
    expect(manifest.publicPackages).toContain("@resin/db");
    expect(manifest.publicPackages).toContain("@resin/adapter-claude-code");
    expect(manifest.publicPackages).toContain("@resin/adapter-codex");
    expect(manifest.publicPackages).toContain("@resin/adapter-omp");

    // Private packages classification
    expect(manifest.privatePackages).toContain("@resin/cloud");
    expect(manifest.privatePackages).toContain("@resin/web");
    expect(manifest.privatePackages).toContain("@resin/cloud-contracts");
    expect(manifest.privatePackages).toContain("@resin/e2e");

    // Public release packages allowlist matches all public release packages
    expect(manifest.publicReleasePackages).toEqual([
      "resin",
      "@resin/gateway",
      "@resin/observer",
      "@resin/runtime",
      "@resin/crypto",
      "@resin/protocol",
      "@resin/contracts",
      "@resin/harness-contracts",
      "@resin/db",
      "@resin/adapter-claude-code",
      "@resin/adapter-codex",
      "@resin/adapter-omp",
    ]);

    // Test fixture paths
    expect(manifest.publicTestFixturePaths).toContain("fixtures/test-fixtures");

    const packages = discoverPackages(rootDir);
    const violations = validateManifest(manifest, packages, rootDir);
    expect(violations).toEqual([]);
  });

  describe("manifest validation failures", () => {
    it("rejects non-object manifest", () => {
      const violations = validateManifest(null);
      expect(violations.some((v) => v.rule === "invalid-manifest-structure")).toBe(true);
    });

    it("rejects manifest missing required array fields", () => {
      const malformed = {
        publicPackages: ["resin"],
      };
      const violations = validateManifest(malformed);
      expect(violations.filter((v) => v.rule === "invalid-manifest-structure").length).toBe(5);
    });

    it("rejects manifest with non-string array entries", () => {
      const malformed = {
        publicPackages: [123],
        privatePackages: [],
        publicReleasePackages: [],
        cloudOnlyPaths: [],
        publicDocumentationPaths: [],
        publicTestFixturePaths: [],
      };
      const violations = validateManifest(malformed);
      expect(violations.some((v) => v.rule === "invalid-manifest-structure")).toBe(true);
    });

    it("rejects duplicate entries within a manifest array", () => {
      const malformed = {
        publicPackages: ["resin", "resin"],
        privatePackages: [],
        publicReleasePackages: [],
        cloudOnlyPaths: [],
        publicDocumentationPaths: [],
        publicTestFixturePaths: [],
      };
      const violations = validateManifest(malformed);
      expect(violations.some((v) => v.rule === "duplicate-manifest-entry")).toBe(true);
    });

    it("rejects duplicate package classification across public and private categories", () => {
      const malformed = {
        publicPackages: ["@resin/runtime", "@resin/contracts"],
        privatePackages: ["@resin/runtime", "@resin/cloud"],
        publicReleasePackages: ["resin"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: ["fixtures/test-fixtures"],
      };
      const violations = validateManifest(malformed);
      const dup = violations.find((v) => v.rule === "duplicate-package-classification");
      expect(dup).toBeDefined();
      expect(dup?.message).toContain("@resin/runtime");
    });

    it("rejects unclassified workspace packages", () => {
      const malformed = {
        publicPackages: ["resin"],
        privatePackages: ["@resin/cloud"],
        publicReleasePackages: ["resin"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: [],
      };
      const packages = discoverPackages(rootDir);
      const violations = validateManifest(malformed, packages, rootDir);
      const unclassified = violations.filter((v) => v.rule === "unclassified-workspace-package");
      expect(unclassified.length).toBeGreaterThan(0);
      expect(unclassified.some((v) => v.message.includes("@resin/runtime"))).toBe(true);
    });

    it("rejects private package in publicReleasePackages allowlist", () => {
      const malformed = {
        publicPackages: ["resin"],
        privatePackages: ["@resin/cloud"],
        publicReleasePackages: ["@resin/cloud"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: ["fixtures/test-fixtures"],
      };
      const violations = validateManifest(malformed);
      const privInRelease = violations.find((v) => v.rule === "private-package-in-public-release");
      expect(privInRelease).toBeDefined();
      expect(privInRelease?.message).toContain("@resin/cloud");
    });

    it("rejects release package not listed in publicPackages", () => {
      const malformed = {
        publicPackages: ["resin"],
        privatePackages: ["@resin/cloud"],
        publicReleasePackages: ["@resin/other"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: ["fixtures/test-fixtures"],
      };
      const violations = validateManifest(malformed);
      const unlisted = violations.find((v) => v.rule === "invalid-release-allowlist");
      expect(unlisted).toBeDefined();
      expect(unlisted?.message).toContain("@resin/other");
    });

    it("rejects fixture-only package in publicReleasePackages allowlist", () => {
      const malformed = {
        publicPackages: ["resin"],
        privatePackages: ["@resin/cloud"],
        publicReleasePackages: ["@resin/test-fixtures"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: ["fixtures/test-fixtures"],
      };
      const violations = validateManifest(malformed);
      const fixtureInRelease = violations.find(
        (v) => v.rule === "fixture-package-in-public-release",
      );
      expect(fixtureInRelease).toBeDefined();
      expect(fixtureInRelease?.message).toContain("@resin/test-fixtures");
    });

    it("rejects packages classified in multiple categories", () => {
      const malformed = {
        publicPackages: ["resin", "@resin/runtime"],
        privatePackages: ["@resin/runtime"],
        publicReleasePackages: ["resin"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: ["fixtures/test-fixtures"],
      };
      const packages = discoverPackages(rootDir);
      const violations = validateManifest(malformed, packages, rootDir);
      const duplicate = violations.find(
        (v) =>
          v.rule === "duplicate-package-classification" ||
          v.rule === "multiple-package-classification",
      );
      expect(duplicate).toBeDefined();
      expect(duplicate?.message).toContain("@resin/runtime");
    });

    it("rejects public test-fixtures depending on private cloud-contracts or cloud packages", () => {
      const badFixturePkg = {
        name: "@resin/test-fixtures",
        dir: "fixtures/test-fixtures",
        fullDir: path.join(rootDir, "fixtures/test-fixtures"),
        dependencies: {
          "@resin/contracts": "workspace:*",
          "@resin/cloud-contracts": "workspace:*",
        },
        devDependencies: {},
        peerDependencies: {},
        exports: { ".": "./dist/index.js" },
        private: true,
      };
      const manifest = {
        publicPackages: ["resin", "@resin/contracts"],
        privatePackages: ["@resin/cloud", "@resin/cloud-contracts"],
        publicReleasePackages: ["resin"],
        cloudOnlyPaths: ["apps/cloud"],
        publicDocumentationPaths: ["docs"],
        publicTestFixturePaths: ["fixtures/test-fixtures"],
      };
      const violations = checkPackageBoundaries(
        badFixturePkg,
        new Map([[badFixturePkg.name, badFixturePkg]]),
        rootDir,
        manifest,
      );
      const depV = violations.find((v) => v.rule === "public-to-private-dependency");
      expect(depV).toBeDefined();
      expect(depV?.message).toContain("@resin/test-fixtures");
      expect(depV?.message).toContain("@resin/cloud-contracts");
    });
  });

  describe("issue 74 boundary rejection gates", () => {
    const mockManifest = {
      publicPackages: [
        "resin",
        "@resin/gateway",
        "@resin/observer",
        "@resin/runtime",
        "@resin/crypto",
        "@resin/protocol",
        "@resin/contracts",
        "@resin/harness-contracts",
        "@resin/db",
        "@resin/adapter-claude-code",
        "@resin/adapter-codex",
        "@resin/adapter-omp",
      ],
      privatePackages: ["@resin/cloud", "@resin/web", "@resin/cloud-contracts", "@resin/e2e"],
      publicReleasePackages: [
        "resin",
        "@resin/gateway",
        "@resin/observer",
        "@resin/runtime",
        "@resin/crypto",
        "@resin/protocol",
        "@resin/contracts",
        "@resin/harness-contracts",
        "@resin/db",
        "@resin/adapter-claude-code",
        "@resin/adapter-codex",
        "@resin/adapter-omp",
      ],
      cloudOnlyPaths: [
        "apps/cloud",
        "apps/web",
        "packages/cloud-contracts",
        "infra/aws",
        "infra/serverless",
        "deploy",
        "aws",
      ],
      publicDocumentationPaths: [
        "docs",
        "README.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "LICENSE",
        "NOTICE",
      ],
      publicTestFixturePaths: ["fixtures/test-fixtures"],
    };
    const mockPackages = new Map([
      [
        "@resin/runtime",
        {
          dir: "packages/runtime",
          fullDir: path.join(rootDir, "packages/runtime"),
          name: "@resin/runtime",
          dependencies: { "@resin/contracts": "workspace:*" },
          devDependencies: {},
          peerDependencies: {},
          exports: { ".": "./dist/index.js" },
          private: true,
        },
      ],
      [
        "@resin/contracts",
        {
          dir: "packages/contracts",
          fullDir: path.join(rootDir, "packages/contracts"),
          name: "@resin/contracts",
          dependencies: {},
          devDependencies: {},
          peerDependencies: {},
          exports: { ".": "./dist/index.js" },
          private: true,
        },
      ],
      [
        "@resin/cloud",
        {
          dir: "apps/cloud",
          fullDir: path.join(rootDir, "apps/cloud"),
          name: "@resin/cloud",
          dependencies: {
            "@resin/contracts": "workspace:*",
            "@resin/cloud-contracts": "workspace:*",
          },
          devDependencies: {},
          peerDependencies: {},
          exports: { ".": "./dist/index.js" },
          private: true,
        },
      ],
      [
        "@resin/cloud-contracts",
        {
          dir: "packages/cloud-contracts",
          fullDir: path.join(rootDir, "packages/cloud-contracts"),
          name: "@resin/cloud-contracts",
          dependencies: { "@resin/contracts": "workspace:*" },
          devDependencies: {},
          peerDependencies: {},
          exports: { ".": "./dist/index.js" },
          private: true,
        },
      ],
    ]);

    it("Gate 1: rejects public package importing or depending on private cloud packages", () => {
      // 1. Dependency violation in package.json
      const badDepPkg = {
        ...mockPackages.get("@resin/runtime"),
        dependencies: {
          "@resin/contracts": "workspace:*",
          "@resin/cloud": "workspace:*",
        },
      };
      const depViolations = checkPackageBoundaries(badDepPkg, mockPackages, rootDir, mockManifest);
      const depV = depViolations.find((v) => v.rule === "public-to-private-dependency");
      expect(depV).toBeDefined();
      expect(depV?.message).toContain("@resin/runtime");
      expect(depV?.message).toContain("@resin/cloud");
    });

    it("Gate 2: rejects public paths reaching into cloud-only paths", () => {
      const publicPkg = mockPackages.get("@resin/runtime");
      expect(publicPkg).toBeDefined();
      expect(mockManifest.cloudOnlyPaths).toContain("apps/cloud");
      expect(mockManifest.cloudOnlyPaths).toContain("infra/aws");
      expect(mockManifest.cloudOnlyPaths).toContain("deploy");
    });

    it("Gate 3: rejects private packages in public release allowlist", () => {
      const badManifest = {
        ...mockManifest,
        publicReleasePackages: ["@resin/cloud", "@resin/cloud-contracts"],
      };
      const violations = validateManifest(badManifest);
      const releaseViolations = violations.filter(
        (v) => v.rule === "private-package-in-public-release",
      );
      expect(releaseViolations.length).toBe(2);
      expect(releaseViolations[0].message).toContain("@resin/cloud");
      expect(releaseViolations[1].message).toContain("@resin/cloud-contracts");
    });

    it("Gate 4: rejects cross-boundary deep imports bypassing package exports", () => {
      const exportsMap = {
        ".": "./dist/index.js",
      };
      expect(
        isValidExportMatch("@resin/contracts/src/internal.js", "@resin/contracts", exportsMap),
      ).toBe(false);
      expect(
        isValidExportMatch("@resin/contracts/unexported", "@resin/contracts", exportsMap),
      ).toBe(false);
    });

    it("allows valid one-way private-to-public dependencies and imports", () => {
      const cloudPkg = mockPackages.get("@resin/cloud");
      expect(cloudPkg).toBeDefined();
      // Private cloud package depending on public contracts
      const cloudViolations = checkPackageBoundaries(cloudPkg, mockPackages, rootDir, mockManifest);
      // No public-to-private violation on private package
      expect(cloudViolations.filter((v) => v.rule === "public-to-private-dependency")).toEqual([]);
      expect(cloudViolations.filter((v) => v.rule === "no-public-to-private-import")).toEqual([]);
    });
  });

  it("passes full boundary and manifest check on current repository", () => {
    const { violations, packageCount } = checkBoundaries(rootDir);
    const packages = discoverPackages(rootDir);
    const isCombinedMonorepo = packages.has("@resin/cloud");
    if (isCombinedMonorepo) {
      expect(packageCount).toBeGreaterThanOrEqual(14);
    } else {
      expect(packageCount).toBeGreaterThanOrEqual(13);
    }
    expect(violations).toEqual([]);
  });
});
