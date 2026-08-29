import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkReleaseCompatibility,
  generateCompatibilityManifest,
  loadCompatibilityManifest,
  saveCompatibilityManifest,
  validateCompatibilityManifest,
} from "../src/compatibility-manifest.js";

describe("Release Compatibility Manifest", () => {
  describe("Manifest Generation", () => {
    it("generates deterministic default compatibility manifest", () => {
      const manifest = generateCompatibilityManifest({ releaseVersion: "0.1.0" });

      expect(manifest.manifestVersion).toBe("1.0.0");
      expect(manifest.releaseVersion).toBe("0.1.0");
      expect(manifest.schemas.NormalizedSessionEvent).toBeDefined();
      expect(manifest.schemas.ToolManifest).toBeDefined();
      expect(manifest.protocols.wireProtocolVersion).toBe("1.0.0");
      expect(manifest.adapterSdks.length).toBeGreaterThan(0);
      expect(manifest.runtimes.operatingSystems).toContain("darwin");
      expect(manifest.runtimes.operatingSystems).toContain("linux");
      expect(manifest.artifactFormats.checksumAlgorithm).toBe("sha256");
    });

    it("allows custom schemas and adapters in generation", () => {
      const manifest = generateCompatibilityManifest({
        releaseVersion: "0.2.0",
        customSchemas: {
          CustomEvent: {
            version: "2.0.0",
            stability: "stable",
          },
        },
      });

      expect(manifest.schemas.CustomEvent).toBeDefined();
      expect(manifest.schemas.CustomEvent.version).toBe("2.0.0");
    });
  });

  describe("Manifest Validation", () => {
    it("validates valid manifest successfully", () => {
      const manifest = generateCompatibilityManifest();
      const result = validateCompatibilityManifest(manifest);

      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.errors).toBeUndefined();
    });

    it("detects and reports schema validation errors in invalid manifest", () => {
      const invalid = {
        manifestVersion: "99.0.0", // invalid literal
        releaseVersion: "not-a-semver",
      };

      const result = validateCompatibilityManifest(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors && result.errors.length > 0).toBe(true);
    });
  });

  describe("Compatibility Target Checks", () => {
    const manifest = generateCompatibilityManifest({ releaseVersion: "0.1.0" });

    it("confirms compatibility for supported target profile", () => {
      const target = {
        clientProtocolVersion: "1.0.0",
        adapterId: "cline",
        adapterVersion: "3.2.0",
        nodeVersion: "22.2.0",
        os: "darwin",
        arch: "arm64",
      };

      const result = checkReleaseCompatibility(manifest, target);
      expect(result.compatible).toBe(true);
      expect(result.issues.length).toBe(0);
    });

    it("detects unsupported OS / platform", () => {
      const target = {
        os: "solaris",
      };

      const result = checkReleaseCompatibility(manifest, target);
      expect(result.compatible).toBe(false);
      expect(result.issues.some((i) => i.includes("Operating system 'solaris'"))).toBe(true);
    });

    it("detects outdated node runtime version", () => {
      const target = {
        nodeVersion: "18.0.0",
      };

      const result = checkReleaseCompatibility(manifest, target);
      expect(result.compatible).toBe(false);
      expect(result.issues.some((i) => i.includes("Node version 18.0.0"))).toBe(true);
    });

    it("detects unrecognized or outdated adapter SDKs", () => {
      const target = {
        adapterId: "unrecognized_adapter",
      };

      const result = checkReleaseCompatibility(manifest, target);
      expect(result.compatible).toBe(false);
      expect(result.issues.some((i) => i.includes("unrecognized_adapter"))).toBe(true);
    });

    it("warns on deprecated schema usage", () => {
      const customManifest = generateCompatibilityManifest({
        customSchemas: {
          LegacyContract: {
            version: "1.0.0",
            stability: "deprecated",
          },
        },
      });

      const target = {
        schemaVersions: { LegacyContract: "1.0.0" },
      };

      const result = checkReleaseCompatibility(customManifest, target);
      expect(result.compatible).toBe(true); // Warnings don't fail compatibility
      expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(true);
    });
  });

  describe("File Serialization & Loading", () => {
    it("saves and loads compatibility manifest to and from disk", async () => {
      const tmpPath = join(process.cwd(), "tmp", `test-manifest-${Date.now()}.json`);
      try {
        const manifest = generateCompatibilityManifest({ releaseVersion: "0.1.0" });
        await saveCompatibilityManifest(manifest, tmpPath);

        const loaded = await loadCompatibilityManifest(tmpPath);
        expect(loaded.releaseVersion).toBe("0.1.0");
        expect(loaded.manifestVersion).toBe("1.0.0");
        expect(loaded.schemas.NormalizedSessionEvent.canonicalDigest).toBe(
          manifest.schemas.NormalizedSessionEvent.canonicalDigest,
        );
      } finally {
        await fs.rm(tmpPath, { force: true });
      }
    });
  });
});
