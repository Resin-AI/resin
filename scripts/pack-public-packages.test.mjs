import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MANIFEST_FILENAME,
  FORBIDDEN_DIR_NAMES,
  FORBIDDEN_FILE_PATTERNS,
  PUBLIC_PACKAGE_COUNT,
  REQUIRED_METADATA_FILES,
  auditTarballContents,
  getTarballFilename,
  isForbiddenReleaseEntry,
  packPublicPackages,
  parseArgs,
  rewriteManifestDependencies,
  stagePackage,
  validateStagedPackage,
} from "./pack-public-packages.mjs";

describe("Public Package Packager (pack-public-packages)", () => {
  const rootDir = process.cwd();
  const testBaseUrl = "https://github.com/Resin-AI/resin/releases/download/v1.0.0";
  let tempOutputDir;

  beforeAll(() => {
    tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-pack-test-out-"));
  });

  afterAll(() => {
    if (tempOutputDir && fs.existsSync(tempOutputDir)) {
      fs.rmSync(tempOutputDir, { recursive: true, force: true });
    }
  });

  describe("getTarballFilename", () => {
    it("generates sanitized tarball filenames according to release conventions", () => {
      expect(getTarballFilename("resin", "1.0.0")).toBe("resin-1.0.0.tgz");
      expect(getTarballFilename("@resin/runtime", "0.1.0")).toBe("resin-runtime-0.1.0.tgz");
      expect(getTarballFilename("@resin/contracts", "0.1.0")).toBe("resin-contracts-0.1.0.tgz");
      expect(getTarballFilename("@resin/adapter-claude-code", "0.1.0")).toBe(
        "resin-adapter-claude-code-0.1.0.tgz",
      );
      expect(getTarballFilename("@resin/test-fixtures", "0.1.0")).toBe(
        "resin-test-fixtures-0.1.0.tgz",
      );
    });

    it("rejects invalid package names or versions", () => {
      expect(() => getTarballFilename("", "1.0.0")).toThrow(/Invalid package name/);
      expect(() => getTarballFilename("@resin/runtime", "")).toThrow(/Invalid package version/);
      expect(() => getTarballFilename(null, "1.0.0")).toThrow(/Invalid package name/);
    });
  });

  describe("isForbiddenReleaseEntry", () => {
    it("identifies forbidden directories and files", () => {
      expect(isForbiddenReleaseEntry("src/index.ts")).toBe(true);
      expect(isForbiddenReleaseEntry("dist/index.tsbuildinfo")).toBe(true);
      expect(isForbiddenReleaseEntry("dist/index.js.map")).toBe(true);
      expect(isForbiddenReleaseEntry(".env")).toBe(true);
      expect(isForbiddenReleaseEntry(".env.local")).toBe(true);
      expect(isForbiddenReleaseEntry("tests/unit.test.ts")).toBe(true);
      expect(isForbiddenReleaseEntry("node_modules/foo")).toBe(true);
      expect(isForbiddenReleaseEntry(".turbo/cache")).toBe(true);
      expect(isForbiddenReleaseEntry("dist/foo.test.js")).toBe(true);
    });

    it("allows valid release files", () => {
      expect(isForbiddenReleaseEntry("dist/index.js")).toBe(false);
      expect(isForbiddenReleaseEntry("dist/index.d.ts")).toBe(false);
      expect(isForbiddenReleaseEntry("bin/resin.mjs")).toBe(false);
      expect(isForbiddenReleaseEntry("package.json")).toBe(false);
      expect(isForbiddenReleaseEntry("LICENSE")).toBe(false);
      expect(isForbiddenReleaseEntry("NOTICE")).toBe(false);
      expect(isForbiddenReleaseEntry("README.md")).toBe(false);
    });
  });

  describe("rewriteManifestDependencies", () => {
    it("rewrites public workspace:* dependencies in all sections to immutable release URLs", () => {
      const publicPackageMap = {
        "@resin/contracts": { tarball: "resin-contracts-0.1.0.tgz" },
        "@resin/crypto": { tarball: "resin-crypto-0.1.0.tgz" },
        "@resin/test-fixtures": { tarball: "resin-test-fixtures-0.1.0.tgz" },
      };

      const manifest = {
        name: "@resin/runtime",
        version: "0.1.0",
        dependencies: {
          "@resin/contracts": "workspace:*",
          "@resin/crypto": "workspace:*",
          typescript: "^5.7.3",
        },
        devDependencies: {
          "@resin/test-fixtures": "workspace:*",
        },
        peerDependencies: {
          "@resin/contracts": "workspace:*",
        },
      };

      const rewritten = rewriteManifestDependencies(manifest, publicPackageMap, testBaseUrl);

      expect(rewritten.dependencies["@resin/contracts"]).toBe(
        `${testBaseUrl}/resin-contracts-0.1.0.tgz`,
      );
      expect(rewritten.dependencies["@resin/crypto"]).toBe(`${testBaseUrl}/resin-crypto-0.1.0.tgz`);
      expect(rewritten.dependencies.typescript).toBe("^5.7.3");
      expect(rewritten.devDependencies["@resin/test-fixtures"]).toBe(
        `${testBaseUrl}/resin-test-fixtures-0.1.0.tgz`,
      );
      expect(rewritten.peerDependencies["@resin/contracts"]).toBe(
        `${testBaseUrl}/resin-contracts-0.1.0.tgz`,
      );
    });

    it("rejects non-HTTPS artifact base URLs", () => {
      const map = { "@resin/contracts": { tarball: "resin-contracts-0.1.0.tgz" } };
      const manifest = { name: "test", dependencies: { "@resin/contracts": "workspace:*" } };

      expect(() => rewriteManifestDependencies(manifest, map, "http://insecure.url")).toThrow(
        /Artifact base URL must be an HTTPS URL/,
      );
      expect(() => rewriteManifestDependencies(manifest, map, "")).toThrow(
        /Artifact base URL is required/,
      );
      expect(() => rewriteManifestDependencies(manifest, map, "ftp://example.com")).toThrow(
        /Artifact base URL must be an HTTPS URL/,
      );
    });

    it("rejects unresolved workspace dependencies not in public package map", () => {
      const map = { "@resin/contracts": { tarball: "resin-contracts-0.1.0.tgz" } };
      const manifest = {
        name: "@resin/invalid",
        dependencies: {
          "@resin/unknown-pkg": "workspace:*",
        },
      };

      expect(() => rewriteManifestDependencies(manifest, map, testBaseUrl)).toThrow(
        /Unresolved workspace dependency in package "@resin\/invalid"/,
      );
    });
  });

  describe("Validation & Staging Errors", () => {
    it("rejects non-HTTPS artifact base URLs in packPublicPackages", () => {
      expect(() =>
        packPublicPackages({
          rootDir,
          artifactBaseUrl: "http://insecure.url",
          outputDir: tempOutputDir,
        }),
      ).toThrow(/Artifact base URL must be an HTTPS URL/);
    });

    it("rejects missing artifact base URL", () => {
      expect(() =>
        packPublicPackages({
          rootDir,
          outputDir: tempOutputDir,
        }),
      ).toThrow(/Artifact base URL is required/);
    });

    it("rejects packaging if repository-split.json has unexpected package count", () => {
      const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-fake-split-"));
      try {
        fs.writeFileSync(
          path.join(fakeDir, "repository-split.json"),
          JSON.stringify({
            publicPackageManifests: ["apps/cli/package.json"],
          }),
        );

        expect(() =>
          packPublicPackages({
            rootDir: fakeDir,
            artifactBaseUrl: testBaseUrl,
            outputDir: tempOutputDir,
          }),
        ).toThrow(/Unexpected public package count: expected 13, found 1/);
      } finally {
        fs.rmSync(fakeDir, { recursive: true, force: true });
      }
    });

    it("rejects root workspace package in publicPackageManifests", () => {
      const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-fake-root-"));
      try {
        const fakeManifests = Array(13).fill("package.json");
        fs.writeFileSync(
          path.join(fakeDir, "repository-split.json"),
          JSON.stringify({ publicPackageManifests: fakeManifests }),
        );
        fs.writeFileSync(
          path.join(fakeDir, "package.json"),
          JSON.stringify({ name: "resin", private: true }),
        );

        expect(() =>
          packPublicPackages({
            rootDir: fakeDir,
            artifactBaseUrl: testBaseUrl,
            outputDir: tempOutputDir,
          }),
        ).toThrow(/Root workspace package must not be packaged/);
      } finally {
        fs.rmSync(fakeDir, { recursive: true, force: true });
      }
    });

    it("rejects private package in publicPackageManifests", () => {
      const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-fake-priv-"));
      try {
        const manifests = [
          "apps/cli/package.json",
          "apps/gateway/package.json",
          "apps/observer/package.json",
          "packages/runtime/package.json",
          "packages/crypto/package.json",
          "packages/protocol/package.json",
          "packages/contracts/package.json",
          "packages/harness-contracts/package.json",
          "packages/db/package.json",
          "adapters/claude-code/package.json",
          "adapters/codex-cli/package.json",
          "adapters/omp/package.json",
          "apps/cloud/package.json", // private!
        ];
        fs.writeFileSync(
          path.join(fakeDir, "repository-split.json"),
          JSON.stringify({ publicPackageManifests: manifests }),
        );
        for (const rel of manifests) {
          const full = path.join(fakeDir, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(
            full,
            JSON.stringify({
              name: rel.includes("cloud") ? "@resin/cloud" : path.basename(path.dirname(rel)),
              version: "0.1.0",
              private: rel.includes("cloud"),
            }),
          );
        }

        expect(() =>
          packPublicPackages({
            rootDir: fakeDir,
            artifactBaseUrl: testBaseUrl,
            outputDir: tempOutputDir,
          }),
        ).toThrow(/Private package "@resin\/cloud" must not be included/);
      } finally {
        fs.rmSync(fakeDir, { recursive: true, force: true });
      }
    });

    it("rejects package with missing dist directory", () => {
      const fakePkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-fake-nodist-"));
      const stagedDir = path.join(fakePkgDir, "staged");
      try {
        fs.writeFileSync(
          path.join(fakePkgDir, "package.json"),
          JSON.stringify({ name: "@resin/empty", version: "0.1.0" }),
        );
        expect(() =>
          stagePackage(
            fakePkgDir,
            stagedDir,
            { name: "@resin/empty", version: "0.1.0" },
            fakePkgDir,
          ),
        ).toThrow(/Missing dist directory/);
      } finally {
        fs.rmSync(fakePkgDir, { recursive: true, force: true });
      }
    });
  });
  describe("Full Packaging Execution & Acceptance", () => {
    let packResult;
    let outputDir;

    beforeAll(() => {
      outputDir = path.join(tempOutputDir, "dist-packages");
      packResult = packPublicPackages({
        rootDir,
        artifactBaseUrl: testBaseUrl,
        outputDir,
      });
    });

    it("produces exactly 13 audited public tarballs", () => {
      expect(packResult.success).toBe(true);
      expect(packResult.count).toBe(13);
      expect(packResult.packages).toHaveLength(13);

      const tgzFiles = fs.readdirSync(outputDir).filter((f) => f.endsWith(".tgz"));
      expect(tgzFiles).toHaveLength(13);

      const expectedTarballs = [
        "resin-1.0.0.tgz",
        "resin-gateway-0.1.0.tgz",
        "resin-observer-0.1.0.tgz",
        "resin-runtime-0.1.0.tgz",
        "resin-crypto-0.1.0.tgz",
        "resin-protocol-0.1.0.tgz",
        "resin-contracts-0.1.0.tgz",
        "resin-harness-contracts-0.1.0.tgz",
        "resin-db-0.1.0.tgz",
        "resin-adapter-claude-code-0.1.0.tgz",
        "resin-adapter-codex-0.1.0.tgz",
        "resin-adapter-omp-0.1.0.tgz",
        "resin-test-fixtures-0.1.0.tgz",
      ];

      for (const expected of expectedTarballs) {
        expect(tgzFiles).toContain(expected);
      }
    });

    it("emits machine-readable packages-manifest.json with valid SHA-256 digests and integrity strings", () => {
      const manifestPath = path.join(outputDir, DEFAULT_MANIFEST_FILENAME);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.artifactBaseUrl).toBe(testBaseUrl);
      expect(manifest.count).toBe(13);
      expect(manifest.packages).toHaveLength(13);

      for (const entry of manifest.packages) {
        expect(entry.name).toBeDefined();
        expect(entry.version).toBeDefined();
        expect(entry.tarball).toBeDefined();
        expect(entry.url).toBe(`${testBaseUrl}/${entry.tarball}`);
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.integrity).toBe(`sha256-${entry.sha256}`);

        // Verify hash matches actual tarball on disk
        const tarballPath = path.join(outputDir, entry.tarball);
        const actualHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(tarballPath))
          .digest("hex");
        expect(entry.sha256).toBe(actualHash);
      }
    });

    it("ensures transitive runtime -> contracts dependency resolves from release URL instead of npm", () => {
      const runtimeTarballPath = path.join(outputDir, "resin-runtime-0.1.0.tgz");
      expect(fs.existsSync(runtimeTarballPath)).toBe(true);

      const tempExtract = fs.mkdtempSync(path.join(os.tmpdir(), "resin-runtime-check-"));
      try {
        const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
        execFileSync(tarCmd, ["-xzf", runtimeTarballPath, "-C", tempExtract]);
        const runtimePkgJson = JSON.parse(
          fs.readFileSync(path.join(tempExtract, "package/package.json"), "utf-8"),
        );

        // Verify @resin/contracts is pinned to exact immutable release tarball URL
        expect(runtimePkgJson.dependencies["@resin/contracts"]).toBe(
          `${testBaseUrl}/resin-contracts-0.1.0.tgz`,
        );
        expect(runtimePkgJson.dependencies["@resin/crypto"]).toBe(
          `${testBaseUrl}/resin-crypto-0.1.0.tgz`,
        );
        expect(runtimePkgJson.dependencies["@resin/db"]).toBe(`${testBaseUrl}/resin-db-0.1.0.tgz`);
        expect(runtimePkgJson.dependencies["@resin/observer"]).toBe(
          `${testBaseUrl}/resin-observer-0.1.0.tgz`,
        );
        expect(runtimePkgJson.dependencies["@resin/protocol"]).toBe(
          `${testBaseUrl}/resin-protocol-0.1.0.tgz`,
        );

        // Non-monorepo dependencies are preserved
        expect(runtimePkgJson.dependencies.typescript).toBe("^5.7.3");
        expect(runtimePkgJson.dependencies.zod).toBe("^3.25.76");

        // No workspace:* specifiers exist anywhere
        const allDeps = {
          ...(runtimePkgJson.dependencies || {}),
          ...(runtimePkgJson.devDependencies || {}),
          ...(runtimePkgJson.peerDependencies || {}),
        };
        for (const [dep, ver] of Object.entries(allDeps)) {
          expect(ver).not.toContain("workspace:");
        }
      } finally {
        fs.rmSync(tempExtract, { recursive: true, force: true });
      }
    });

    it("audits every tarball to ensure no forbidden entries (src, tests, node_modules, .turbo, .tsbuildinfo, .map) are present", () => {
      for (const entry of packResult.packages) {
        const tarballPath = path.join(outputDir, entry.tarball);
        auditTarballContents(tarballPath, entry.name);
        const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
        const listing = execFileSync(tarCmd, ["-tzf", tarballPath], { encoding: "utf-8" })
          .split("\n")
          .filter(Boolean);

        for (const item of listing) {
          expect(item).not.toMatch(/package\/src\//);
          expect(item).not.toMatch(/package\/tests\//);
          expect(item).not.toMatch(/package\/node_modules\//);
          expect(item).not.toMatch(/package\/\.turbo\//);
          expect(item).not.toMatch(/\.tsbuildinfo$/);
          expect(item).not.toMatch(/\.map$/);
          expect(item).not.toMatch(/\.env/);
        }

        // Must include package.json, LICENSE, NOTICE, dist
        expect(listing).toContain("package/package.json");
        expect(listing).toContain("package/LICENSE");
        expect(listing).toContain("package/NOTICE");
        expect(listing.some((i) => i.startsWith("package/dist/"))).toBe(true);
      }
    });
    it("handles output directory paths with spaces and shell metacharacters safely", () => {
      const specialOutputDir = path.join(
        tempOutputDir,
        "out dir with spaces & $symbols 'quotes' (test)",
      );
      const result = packPublicPackages({
        rootDir,
        artifactBaseUrl: testBaseUrl,
        outputDir: specialOutputDir,
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(13);
      expect(fs.existsSync(path.join(specialOutputDir, "resin-1.0.0.tgz"))).toBe(true);
      expect(fs.existsSync(path.join(specialOutputDir, "packages-manifest.json"))).toBe(true);
    });
  });

  describe("parseArgs", () => {
    it("parses CLI flags correctly", () => {
      const parsed1 = parseArgs([
        "--artifact-base-url",
        "https://github.com/Resin-AI/resin/releases/download/v1.0.0",
        "--output-dir",
        "/tmp/custom-out",
        "--manifest",
        "custom-manifest.json",
      ]);

      expect(parsed1.artifactBaseUrl).toBe(
        "https://github.com/Resin-AI/resin/releases/download/v1.0.0",
      );
      expect(parsed1.outputDir).toBe("/tmp/custom-out");
      expect(parsed1.manifest).toBe("custom-manifest.json");

      const parsed2 = parseArgs([
        "--artifact-base-url=https://artifacts.resin.sh/packages",
        "--output-dir=dist/custom",
        "--root-dir=/workspace",
      ]);

      expect(parsed2.artifactBaseUrl).toBe("https://artifacts.resin.sh/packages");
      expect(parsed2.outputDir).toBe("dist/custom");
      expect(parsed2.rootDir).toBe("/workspace");
    });
  });
});
