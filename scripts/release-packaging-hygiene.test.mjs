import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLOUD_ONLY_IDENTIFIERS,
  FORBIDDEN_RELEASE_PATTERNS,
  INTERNAL_WORKSPACE_REGISTRY,
  PLATFORMS,
  PUBLIC_RELEASE_PACKAGES,
  RELEASE_VERSION,
  assertCleanProductionDist,
  assertNoForbiddenReleaseArtifacts,
  collectPackageProductionDistFiles,
  collectProjectDependencies,
  collectStandaloneRuntimeEntries,
  createDeterministicTar,
  createPlatformReleaseTarballs,
  extractTarEntries,
  generateCycloneDxSbom,
  generatePackageDigests,
  gzipDeterministic,
  isForbiddenReleasePath,
  isProductionDistFile,
  resolvePublicReleasePackages,
} from "./package-release.mjs";
import { verifyReleaseFiles } from "./verify-release.mjs";

describe("Release Packaging Hygiene & Forbidden Artifact Protection", () => {
  const rootDir = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-packaging-hygiene-"));

  const FORBIDDEN_SAMPLE_PATHS = [
    // Gateway meta/utility-tools
    "apps/gateway/dist/meta/utility-tools.js",
    "apps/gateway/dist/meta/utility-tools.d.ts",
    "apps/gateway/dist/meta/utility-tools.js.map",
    "apps/gateway/dist/meta/utility-tools.d.ts.map",
    "resin/apps/gateway/dist/meta/utility-tools.js",
    "dist/meta/utility-tools.js",
    "meta/utility-tools.js",

    // Proxy mock-service
    "apps/gateway/dist/proxy/mock-service.js",
    "apps/gateway/dist/proxy/mock-service.d.ts",
    "apps/gateway/dist/proxy/mock-service.js.map",
    "apps/gateway/dist/proxy/mock-service.d.ts.map",
    "resin/apps/gateway/dist/proxy/mock-service.d.ts",
    "proxy/mock-service.js",
    "mock-service.js",

    // Cloud refresh/fake-matrix
    "apps/cloud/dist/refresh/fake-matrix.js",
    "apps/cloud/dist/refresh/fake-matrix.d.ts",
    "apps/cloud/dist/refresh/fake-matrix.js.map",
    "apps/cloud/dist/refresh/fake-matrix.d.ts.map",
    "resin/apps/cloud/dist/refresh/fake-matrix.js",
    "refresh/fake-matrix.js",
    "fake-matrix.js",

    // Harness-contracts fake
    "packages/harness-contracts/dist/fake.js",
    "packages/harness-contracts/dist/fake.d.ts",
    "packages/harness-contracts/dist/fake.js.map",
    "packages/harness-contracts/dist/fake.d.ts.map",
    "packages/harness-contracts/dist/fake-adapter.js",
    "resin/packages/harness-contracts/dist/fake.js",
    "node_modules/@resin/harness-contracts/dist/fake.d.ts",

    // General test paths
    "apps/gateway/dist/tests/helper.js",
    "packages/contracts/dist/something.test.js",
    "packages/runtime/dist/__tests__/stub.js",
  ];

  const ALLOWED_SAMPLE_PATHS = [
    "packages/contracts/dist/index.js",
    "packages/contracts/dist/index.d.ts",
    "apps/gateway/dist/index.js",
    "apps/cli/dist/index.js",
    "apps/observer/dist/index.js",
    "packages/runtime/dist/loader/retention.js",
    "packages/crypto/dist/index.js",
    "packages/protocol/dist/mock.js",
    "packages/protocol/dist/mock.d.ts",
    "packages/protocol/dist/mock.js.map",
    "resin/package.json",
    "resin/LICENSE",
    "resin/NOTICE",
  ];

  describe("isForbiddenReleasePath classifier", () => {
    it("identifies all forbidden test-double, mock, and fake paths across all extensions", () => {
      for (const samplePath of FORBIDDEN_SAMPLE_PATHS) {
        expect(
          isForbiddenReleasePath(samplePath),
          `Expected '${samplePath}' to be classified as forbidden`,
        ).toBe(true);
      }
    });

    it("allows valid production release artifacts and documentation", () => {
      for (const samplePath of ALLOWED_SAMPLE_PATHS) {
        expect(isForbiddenReleasePath(samplePath), `Expected '${samplePath}' to be allowed`).toBe(
          false,
        );
      }
    });
  });

  describe("isProductionDistFile source-backed invariant (Isolated Fixtures)", () => {
    const fixturePkgDir = path.join(tempDir, "fixture-pkg");

    beforeAll(() => {
      // Set up an isolated package with real sources in src/
      fs.mkdirSync(path.join(fixturePkgDir, "src/nested"), { recursive: true });
      fs.mkdirSync(path.join(fixturePkgDir, "dist/nested"), { recursive: true });
      fs.mkdirSync(path.join(fixturePkgDir, "dist/meta"), { recursive: true });
      fs.mkdirSync(path.join(fixturePkgDir, "dist/proxy"), { recursive: true });

      fs.writeFileSync(path.join(fixturePkgDir, "src/index.ts"), "export const ok = true;\n");
      fs.writeFileSync(
        path.join(fixturePkgDir, "src/nested/valid.ts"),
        "export const valid = 1;\n",
      );
      fs.writeFileSync(path.join(fixturePkgDir, "src/mock.ts"), "export const mockServer = {};\n");
    });

    it("rejects forbidden test-double patterns even if staged in dist", () => {
      expect(isProductionDistFile(fixturePkgDir, "meta/utility-tools.js")).toBe(false);
      expect(isProductionDistFile(fixturePkgDir, "meta/utility-tools.d.ts")).toBe(false);
      expect(isProductionDistFile(fixturePkgDir, "meta/utility-tools.js.map")).toBe(false);
      expect(isProductionDistFile(fixturePkgDir, "proxy/mock-service.js")).toBe(false);
      expect(isProductionDistFile(fixturePkgDir, "refresh/fake-matrix.js")).toBe(false);
    });

    it("rejects orphaned compiled files with no corresponding src/ entry", () => {
      expect(isProductionDistFile(fixturePkgDir, "orphaned-ghost-module.js")).toBe(false);
      expect(isProductionDistFile(fixturePkgDir, "nested/stale-output.d.ts")).toBe(false);
      expect(isProductionDistFile(fixturePkgDir, "no-such-source.js.map")).toBe(false);
    });

    it("accepts valid compiled files with corresponding src/ entries including protocol mock.js", () => {
      expect(isProductionDistFile(fixturePkgDir, "index.js")).toBe(true);
      expect(isProductionDistFile(fixturePkgDir, "index.d.ts")).toBe(true);
      expect(isProductionDistFile(fixturePkgDir, "index.js.map")).toBe(true);
      expect(isProductionDistFile(fixturePkgDir, "nested/valid.js")).toBe(true);
      expect(isProductionDistFile(fixturePkgDir, "mock.js")).toBe(true);
      expect(isProductionDistFile(fixturePkgDir, "mock.d.ts")).toBe(true);
      expect(isProductionDistFile(fixturePkgDir, "mock.js.map")).toBe(true);

      // Verify against real protocol package in workspace without mutating it
      const protocolDir = path.join(rootDir, "packages/protocol");
      expect(isProductionDistFile(protocolDir, "mock.js")).toBe(true);
    });
  });

  describe("assertNoForbiddenReleaseArtifacts fail-closed guard", () => {
    it("throws ERR_FORBIDDEN_RELEASE_ARTIFACT when forbidden artifacts are present in entry list", () => {
      const dirtyEntries = [
        { path: "resin/package.json", content: "{}" },
        { path: "resin/apps/gateway/dist/meta/utility-tools.js", content: "export {}" },
      ];

      expect(() => {
        assertNoForbiddenReleaseArtifacts(dirtyEntries, "test payload");
      }).toThrow(/Release packaging failed-closed assertion/);
    });

    it("passes cleanly when entry list contains only legitimate release artifacts", () => {
      const cleanEntries = [
        { path: "resin/package.json", content: "{}" },
        { path: "resin/packages/contracts/dist/index.js", content: "export {}" },
        { path: "resin/LICENSE", content: "Apache License" },
      ];

      expect(() => {
        assertNoForbiddenReleaseArtifacts(cleanEntries, "clean payload");
      }).not.toThrow();
    });
  });

  describe("Isolated Staging & Non-Destructive Packaging Verification", () => {
    const dirtyPkgDir = path.join(tempDir, "dirty-pkg");

    beforeAll(() => {
      // Create isolated dirty package with a valid file and stale forbidden files
      fs.mkdirSync(path.join(dirtyPkgDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(dirtyPkgDir, "dist/meta"), { recursive: true });
      fs.mkdirSync(path.join(dirtyPkgDir, "dist/proxy"), { recursive: true });

      fs.writeFileSync(
        path.join(dirtyPkgDir, "package.json"),
        JSON.stringify({ name: "@resin/dirty-pkg", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dirtyPkgDir, "src/index.ts"), "export const ok = true;\n");
      fs.writeFileSync(path.join(dirtyPkgDir, "dist/index.js"), "export const ok = true;\n");
      fs.writeFileSync(
        path.join(dirtyPkgDir, "dist/index.d.ts"),
        "export declare const ok: boolean;\n",
      );

      // Stale outputs
      fs.writeFileSync(path.join(dirtyPkgDir, "dist/meta/utility-tools.js"), "// stale\n");
      fs.writeFileSync(path.join(dirtyPkgDir, "dist/meta/utility-tools.d.ts"), "// stale\n");
      fs.writeFileSync(path.join(dirtyPkgDir, "dist/proxy/mock-service.js"), "// stale\n");
      fs.writeFileSync(path.join(dirtyPkgDir, "dist/orphaned-legacy.js"), "// stale\n");
    });

    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("collectPackageProductionDistFiles filters out all stale/forbidden outputs in isolated package", () => {
      const files = collectPackageProductionDistFiles(dirtyPkgDir, dirtyPkgDir);
      const relPaths = files.map((f) => f.relPath);

      expect(relPaths).toContain("dist/index.js");
      expect(relPaths).toContain("dist/index.d.ts");
      expect(relPaths.some((p) => p.includes("utility-tools"))).toBe(false);
      expect(relPaths.some((p) => p.includes("mock-service"))).toBe(false);
      expect(relPaths.some((p) => p.includes("orphaned-legacy"))).toBe(false);
    });

    it("generatePackageDigests executes cleanly on public release packages without mutation", () => {
      const digests = generatePackageDigests(rootDir);
      expect(digests["@resin/gateway"]).toBeDefined();
      expect(digests["@resin/contracts"]).toBeDefined();
      expect(digests["@resin/harness-contracts"]).toBeDefined();
      expect(digests.resin).toBeDefined();
      expect(digests["@resin/cloud"]).toBeUndefined();
      expect(digests["@resin/web"]).toBeUndefined();
      expect(digests["@resin/cloud-contracts"]).toBeUndefined();
      expect(digests["@resin/e2e"]).toBeUndefined();
    });

    it("createPlatformReleaseTarballs packages release with non-destructive guarantees", () => {
      const outputDir = path.join(tempDir, "release-output");
      fs.mkdirSync(outputDir, { recursive: true });

      const assetResults = createPlatformReleaseTarballs(rootDir, outputDir);
      expect(Object.keys(assetResults)).toHaveLength(PLATFORMS.length);

      for (const platform of PLATFORMS) {
        const tarballPath = path.join(outputDir, platform.filename);
        expect(fs.existsSync(tarballPath)).toBe(true);

        const tarBuffer = fs.readFileSync(tarballPath);
        const entries = extractTarEntries(tarBuffer);
        const entryNames = entries.map((e) => e.name);

        expect(entryNames.some((n) => n.includes("utility-tools"))).toBe(false);
        expect(entryNames.some((n) => n.includes("mock-service"))).toBe(false);
        expect(entryNames.some((n) => n.includes("fake-matrix"))).toBe(false);
        expect(entryNames.some((n) => n.includes("harness-contracts/dist/fake"))).toBe(false);
        expect(entryNames.some((n) => n.includes("apps/cloud"))).toBe(false);
        expect(entryNames.some((n) => n.includes("apps/web"))).toBe(false);
        expect(entryNames.some((n) => n.includes("@resin/cloud"))).toBe(false);
        expect(entryNames.some((n) => n.includes("@resin/web"))).toBe(false);
        expect(entryNames.some((n) => n.includes("@resin/cloud-contracts"))).toBe(false);
        expect(entryNames.some((n) => n.includes("@resin/e2e"))).toBe(false);

        expect(() => {
          assertNoForbiddenReleaseArtifacts(entries, platform.filename);
        }).not.toThrow();
      }
    }, 60_000);

    it("verifyReleaseFiles reports FORBIDDEN_RELEASE_ARTIFACT if a tarball contains seeded forbidden files", () => {
      const corruptedReleaseDir = path.join(tempDir, "corrupted-release");
      fs.mkdirSync(corruptedReleaseDir, { recursive: true });

      const dirtyEntries = [
        { path: "resin/package.json", content: '{"name":"resin","version":"1.0.0"}' },
        { path: "resin/LICENSE", content: "Apache License Version 2.0\n" },
        { path: "resin/NOTICE", content: "Resin Authors\n" },
        { path: "resin/apps/gateway/dist/meta/utility-tools.js", content: "export {}" },
      ];
      const dirtyTarGz = gzipDeterministic(createDeterministicTar(dirtyEntries));

      for (const platform of PLATFORMS) {
        fs.writeFileSync(path.join(corruptedReleaseDir, platform.filename), dirtyTarGz);
      }

      const violations = verifyReleaseFiles(corruptedReleaseDir);
      const forbiddenViolations = violations.filter((v) => v.rule === "FORBIDDEN_RELEASE_ARTIFACT");

      expect(forbiddenViolations.length).toBeGreaterThan(0);
      expect(forbiddenViolations[0].message).toContain("contains forbidden path");
    });
    it("assertNoForbiddenReleaseArtifacts rejects npm bootstrap staging if contaminated with test doubles", () => {
      const dirtyPortableFiles = [
        { path: "package.json", fullPath: path.join(tempDir, "package.json") },
        {
          path: "node_modules/@resin/gateway/dist/meta/utility-tools.js",
          fullPath: path.join(tempDir, "node_modules/@resin/gateway/dist/meta/utility-tools.js"),
        },
      ];
      expect(() => {
        assertNoForbiddenReleaseArtifacts(dirtyPortableFiles, "npm bootstrap portable package");
      }).toThrow(/Release packaging failed-closed assertion/);
    });

    it("verifies explicit coverage for all contract paths including .js, .d.ts, and maps", () => {
      const contractPaths = [
        "apps/gateway/dist/meta/utility-tools",
        "apps/gateway/dist/proxy/mock-service",
        "apps/cloud/dist/refresh/fake-matrix",
        "packages/harness-contracts/dist/fake",
      ];
      const extensions = [".js", ".d.ts", ".js.map", ".d.ts.map", ".mjs", ".cjs"];

      for (const basePath of contractPaths) {
        for (const ext of extensions) {
          const testPath = `${basePath}${ext}`;
          expect(
            isForbiddenReleasePath(testPath),
            `Contract path '${testPath}' must be rejected as forbidden`,
          ).toBe(true);
        }
      }
    });

    it("extractTarEntries correctly advances across multi-entry variable body/padding offsets and detects forbidden later entries", () => {
      const multiEntries = [
        {
          path: "resin/01-large-config.json",
          content: JSON.stringify({ name: "resin", version: "1.0.0", payload: "A".repeat(600) }),
        },
        {
          path: "resin/02-large-license.txt",
          content: `Apache License Version 2.0\n${"Detailed terms...\n".repeat(80)}`,
        },

        {
          path: "resin/03-apps/cloud/dist/refresh/fake-matrix.d.ts",
          content: "export declare const fakeMatrix: unknown;\n",
        },
        {
          path: "resin/04-final-notice.txt",
          content: "Resin Authors\n",
        },
      ];

      const tarBuf = createDeterministicTar(multiEntries);
      const extracted = extractTarEntries(tarBuf);

      expect(extracted).toHaveLength(4);

      const entryMap = new Map(extracted.map((e) => [e.name, e]));
      for (const original of multiEntries) {
        const found = entryMap.get(original.path);
        expect(found, `Entry '${original.path}' must be extracted`).toBeDefined();
        expect(found.content.length).toBe(Buffer.byteLength(original.content));
        expect(found.content.toString("utf8")).toBe(original.content);
      }

      expect(extracted[0].name).toBe("resin/01-large-config.json");
      expect(extracted[1].name).toBe("resin/02-large-license.txt");
      expect(extracted[2].name).toBe("resin/03-apps/cloud/dist/refresh/fake-matrix.d.ts");
      expect(extracted[3].name).toBe("resin/04-final-notice.txt");

      expect(() => {
        assertNoForbiddenReleaseArtifacts(extracted, "multi-entry tar test");
      }).toThrow(/fake-matrix/);
    });
  });

  describe("Canonical Manifest Authority & Public Release Package Classification", () => {
    it("exports PUBLIC_RELEASE_PACKAGES derived from canonical resin-boundary.json", () => {
      const expectedPublicPackages = [
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
      ];
      const actualNames = PUBLIC_RELEASE_PACKAGES.map((p) => p.name);
      expect(actualNames).toEqual(expectedPublicPackages);
      expect(PUBLIC_RELEASE_PACKAGES).toHaveLength(12);
    });

    it("ensures no private package is included in PUBLIC_RELEASE_PACKAGES", () => {
      const privatePackageNames = [
        "@resin/cloud",
        "@resin/web",
        "@resin/cloud-contracts",
        "@resin/e2e",
        "@resin/test-fixtures",
      ];
      const actualNames = new Set(PUBLIC_RELEASE_PACKAGES.map((p) => p.name));
      for (const priv of privatePackageNames) {
        expect(
          actualNames.has(priv),
          `Private package ${priv} must not be in PUBLIC_RELEASE_PACKAGES`,
        ).toBe(false);
      }
    });

    it("resolvePublicReleasePackages throws when private package is present in publicReleasePackages", () => {
      const badManifest = {
        publicReleasePackages: ["resin", "@resin/cloud", "@resin/contracts"],
        privatePackages: ["@resin/cloud"],
      };
      expect(() => {
        resolvePublicReleasePackages(rootDir, badManifest);
      }).toThrow(/Private package "@resin\/cloud" cannot be included in publicReleasePackages/);
    });

    it("resolvePublicReleasePackages throws when an unknown package is in publicReleasePackages", () => {
      const badManifest = {
        publicReleasePackages: ["resin", "@resin/unknown-nonexistent-pkg"],
        privatePackages: [],
      };
      expect(() => {
        resolvePublicReleasePackages(rootDir, badManifest);
      }).toThrow(/Unknown public release package "@resin\/unknown-nonexistent-pkg"/);
    });

    it("resolvePublicReleasePackages throws when publicReleasePackages is missing", () => {
      expect(() => {
        resolvePublicReleasePackages(rootDir, {});
      }).toThrow(/missing required 'publicReleasePackages' array/);
    });

    it("INTERNAL_WORKSPACE_REGISTRY separates public and private packages explicitly", () => {
      expect(INTERNAL_WORKSPACE_REGISTRY.length).toBeGreaterThanOrEqual(15);
      const cloudPkg = INTERNAL_WORKSPACE_REGISTRY.find((p) => p.name === "@resin/cloud");
      expect(cloudPkg).toBeDefined();
      expect(cloudPkg.private).toBe(true);

      const contractsPkg = INTERNAL_WORKSPACE_REGISTRY.find((p) => p.name === "@resin/contracts");
      expect(contractsPkg).toBeDefined();
      expect(contractsPkg.private).toBe(false);
    });
  });

  describe("Cloud Leakage & Private Package Isolation", () => {
    it("isForbiddenReleasePath rejects all cloud and private package paths", () => {
      const cloudPaths = [
        "apps/cloud/dist/index.js",
        "resin/apps/cloud/dist/index.js",
        "apps/web/dist/index.js",
        "resin/apps/web/dist/index.js",
        "packages/cloud-contracts/dist/index.js",
        "resin/packages/cloud-contracts/dist/index.js",
        "fixtures/e2e/tests/e2e.test.ts",
        "resin/fixtures/e2e/package.json",
        "infra/aws/stack.ts",
        "infra/serverless/serverless.yml",
        "deploy/publish.sh",
        "aws/deploy.sh",
        ".github/workflows/cloud-deploy.yml",
        "cloud-deploy.yml",
        "resin/node_modules/@resin/cloud/package.json",
        "resin/node_modules/@resin/web/package.json",
        "resin/node_modules/@resin/cloud-contracts/package.json",
        "resin/node_modules/@resin/e2e/package.json",
      ];
      for (const cp of cloudPaths) {
        expect(isForbiddenReleasePath(cp), `Cloud path ${cp} must be identified as forbidden`).toBe(
          true,
        );
      }
    });

    it("assertNoForbiddenReleaseArtifacts rejects payloads containing cloud package paths", () => {
      const entriesWithCloud = [
        { path: "resin/package.json", content: "{}" },
        { path: "resin/apps/cloud/dist/index.js", content: "export const cloud = true;" },
      ];
      expect(() => {
        assertNoForbiddenReleaseArtifacts(entriesWithCloud, "cloud leak test");
      }).toThrow(/Release packaging failed-closed assertion/);
    });

    it("collectStandaloneRuntimeEntries excludes private packages and checks dependencies", () => {
      const runtimeEntries = collectStandaloneRuntimeEntries(rootDir);
      const runtimePaths = runtimeEntries.map((e) => e.path);

      expect(runtimePaths.some((p) => p.includes("@resin/cloud"))).toBe(false);
      expect(runtimePaths.some((p) => p.includes("@resin/web"))).toBe(false);
      expect(runtimePaths.some((p) => p.includes("@resin/cloud-contracts"))).toBe(false);
      expect(runtimePaths.some((p) => p.includes("@resin/e2e"))).toBe(false);
    });
  });

  describe("Stale Dist Output Rejection & Source-Backed Clean Build Flow", () => {
    it("assertCleanProductionDist throws ERR_STALE_DIST_OUTPUT when orphan files exist in dist/", () => {
      const stalePkgDir = path.join(tempDir, "stale-pkg");
      fs.mkdirSync(path.join(stalePkgDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(stalePkgDir, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(stalePkgDir, "package.json"),
        JSON.stringify({ name: "stale-pkg", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(stalePkgDir, "src/index.ts"), "export const a = 1;");
      fs.writeFileSync(path.join(stalePkgDir, "dist/index.js"), "export const a = 1;");
      fs.writeFileSync(path.join(stalePkgDir, "dist/stale-ghost.js"), "export const stale = true;");

      expect(() => {
        assertCleanProductionDist(tempDir, stalePkgDir);
      }).toThrow(/Package dist hygiene check failed/);
    });

    it("assertCleanProductionDist throws when forbidden artifacts exist in dist/", () => {
      const dirtyPkgDir = path.join(tempDir, "dirty-pkg");
      fs.mkdirSync(path.join(dirtyPkgDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(dirtyPkgDir, "dist/meta"), { recursive: true });
      fs.writeFileSync(
        path.join(dirtyPkgDir, "package.json"),
        JSON.stringify({ name: "dirty-pkg", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dirtyPkgDir, "src/index.ts"), "export const a = 1;");
      fs.writeFileSync(path.join(dirtyPkgDir, "dist/index.js"), "export const a = 1;");
      fs.writeFileSync(
        path.join(dirtyPkgDir, "dist/meta/utility-tools.js"),
        "export const tool = 1;",
      );

      expect(() => {
        assertCleanProductionDist(tempDir, dirtyPkgDir);
      }).toThrow(/Package dist hygiene check failed/);
    });

    it("assertCleanProductionDist passes cleanly for valid source-backed dist files", () => {
      const cleanPkgDir = path.join(tempDir, "clean-pkg");
      fs.mkdirSync(path.join(cleanPkgDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(cleanPkgDir, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(cleanPkgDir, "package.json"),
        JSON.stringify({ name: "clean-pkg", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(cleanPkgDir, "src/index.ts"), "export const a = 1;");
      fs.writeFileSync(path.join(cleanPkgDir, "dist/index.js"), "export const a = 1;");
      fs.writeFileSync(
        path.join(cleanPkgDir, "dist/index.d.ts"),
        "export declare const a: number;",
      );

      expect(() => {
        assertCleanProductionDist(tempDir, cleanPkgDir);
      }).not.toThrow();
    });

    it("collectPackageProductionDistFiles rejects stale dist output when rejectStale is true", () => {
      const stalePkgDir = path.join(tempDir, "stale-collect-pkg");
      fs.mkdirSync(path.join(stalePkgDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(stalePkgDir, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(stalePkgDir, "package.json"),
        JSON.stringify({ name: "stale-collect-pkg", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(stalePkgDir, "src/index.ts"), "export const a = 1;");
      fs.writeFileSync(path.join(stalePkgDir, "dist/index.js"), "export const a = 1;");
      fs.writeFileSync(path.join(stalePkgDir, "dist/stale.js"), "export const stale = true;");

      expect(() => {
        collectPackageProductionDistFiles(tempDir, stalePkgDir, { rejectStale: true });
      }).toThrow(/Package dist hygiene check failed/);
    });
  });

  describe("CycloneDX SBOM Scope & Third-Party Dependency Isolation", () => {
    it("generateCycloneDxSbom components contain only public release packages and no private packages", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests, { testOnly: true });

      expect(sbom.bomFormat).toBe("CycloneDX");
      expect(sbom.specVersion).toBe("1.5");
      expect(Array.isArray(sbom.components)).toBe(true);

      const componentNames = sbom.components.map((c) => c.name);

      // Verify all public release packages are present
      for (const pkg of PUBLIC_RELEASE_PACKAGES) {
        expect(componentNames, `SBOM must contain public package ${pkg.name}`).toContain(pkg.name);
      }

      // Verify NO private package is present
      const privatePackages = [
        "@resin/cloud",
        "@resin/web",
        "@resin/cloud-contracts",
        "@resin/e2e",
        "@resin/test-fixtures",
      ];
      for (const priv of privatePackages) {
        expect(componentNames, `SBOM must NOT contain private package ${priv}`).not.toContain(priv);
      }

      // Check dependency graph
      expect(Array.isArray(sbom.dependencies)).toBe(true);
      const dependencyRefs = sbom.dependencies.map((d) => d.ref);
      for (const priv of privatePackages) {
        const privEscaped = encodeURIComponent(priv.replace("@resin/", ""));
        expect(dependencyRefs.some((ref) => ref.includes(privEscaped))).toBe(false);
      }
    });

    it("collectProjectDependencies excludes cloud-only packages and their dependencies", () => {
      const deps = collectProjectDependencies(rootDir);
      const depNames = deps.map((d) => d.name);

      expect(depNames).toContain("zod");
      expect(depNames.some((d) => d.startsWith("@resin/cloud"))).toBe(false);
      expect(depNames.some((d) => d.startsWith("@resin/web"))).toBe(false);
    });
  });
});
