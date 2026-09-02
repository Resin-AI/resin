import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { BINARY_SPECS, verifyBinaries } from "./verify-binaries.mjs";

describe("verify-binaries", () => {
  const rootDir = process.cwd();

  describe("BINARY_SPECS", () => {
    it("defines specifications for all 4 primary entry points", () => {
      expect(BINARY_SPECS).toHaveLength(4);

      const packageNames = BINARY_SPECS.map((s) => s.packageName);
      expect(packageNames).toContain("resin");
      expect(packageNames).toContain("@resin/observer");
      expect(packageNames).toContain("@resin/test-fixtures");

      const resinSpecs = BINARY_SPECS.filter((s) => s.packageName === "resin");
      expect(resinSpecs).toHaveLength(2);
      expect(resinSpecs.some((s) => s.testArgs.includes("mcp"))).toBe(true);
    });

    it("has valid configurations for each binary spec", () => {
      for (const spec of BINARY_SPECS) {
        expect(spec.packageName).toBeTruthy();
        expect(spec.packageDir).toBeTruthy();
        expect(spec.binKey).toBeTruthy();
        expect(spec.binPath).toBeTruthy();
        expect(spec.testArgs).toBeInstanceOf(Array);
        expect(spec.expectedOutputPattern).toBeInstanceOf(RegExp);
      }
    });
  });

  describe("verifyBinaries live suite", () => {
    it("successfully validates all 4 workspace binaries", async () => {
      const result = await verifyBinaries({ rootDir });

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(4);

      for (const res of result.results) {
        expect(res.status).toBe("pass");
        expect(res.output).toBeTruthy();
        expect(res.spec.expectedOutputPattern.test(res.output || "")).toBe(true);
      }
    });
  });

  describe("Error handling and edge cases", () => {
    it("fails gracefully when package.json does not exist", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-missing-pkg-"));
      try {
        const testSpec = {
          packageName: "@test/missing",
          packageDir: "packages/missing",
          binKey: "test-bin",
          binPath: "packages/missing/dist/bin.js",
          testArgs: ["--help"],
          expectedOutputPattern: /test/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain("Package manifest not found");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails when package.json is missing bin declaration", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-no-bin-"));
      try {
        const pkgDir = path.join(tempDir, "packages/no-bin");
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name: "@test/no-bin", version: "1.0.0" }),
        );

        const testSpec = {
          packageName: "@test/no-bin",
          packageDir: "packages/no-bin",
          binKey: "test-bin",
          binPath: "packages/no-bin/dist/bin.js",
          testArgs: ["--help"],
          expectedOutputPattern: /test/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain('missing "bin" field');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails when bin path in package.json does not match expected spec", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-mismatch-"));
      try {
        const pkgDir = path.join(tempDir, "packages/mismatch");
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@test/mismatch",
            bin: { "test-bin": "./wrong/path.js" },
          }),
        );

        const testSpec = {
          packageName: "@test/mismatch",
          packageDir: "packages/mismatch",
          binKey: "test-bin",
          binPath: "packages/mismatch/dist/bin.js",
          testArgs: ["--help"],
          expectedOutputPattern: /test/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("Bin path mismatch");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails when compiled binary file is missing from disk", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-missing-file-"));
      try {
        const pkgDir = path.join(tempDir, "packages/missing-file");
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@test/missing-file",
            bin: { "test-bin": "./dist/bin.js" },
          }),
        );

        const testSpec = {
          packageName: "@test/missing-file",
          packageDir: "packages/missing-file",
          binKey: "test-bin",
          binPath: "packages/missing-file/dist/bin.js",
          testArgs: ["--help"],
          expectedOutputPattern: /test/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("Compiled binary not found");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails when a binary runtime file is missing", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-missing-runtime-"));
      try {
        const pkgDir = path.join(tempDir, "packages/missing-runtime");
        const binDist = path.join(pkgDir, "dist");
        fs.mkdirSync(binDist, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@test/missing-runtime",
            bin: { "test-bin": "./dist/bin.js" },
          }),
        );
        fs.writeFileSync(
          path.join(binDist, "bin.js"),
          '#!/usr/bin/env node\nconsole.log("test");\n',
        );

        const testSpec = {
          packageName: "@test/missing-runtime",
          packageDir: "packages/missing-runtime",
          binKey: "test-bin",
          binPath: "packages/missing-runtime/dist/bin.js",
          requiredRuntimePaths: ["packages/missing-runtime/dist/release-trust.json"],
          testArgs: ["--help"],
          expectedOutputPattern: /test/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("Required runtime file not found");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails when binary file lacks node shebang", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-no-shebang-"));
      try {
        const pkgDir = path.join(tempDir, "packages/no-shebang");
        const binDist = path.join(pkgDir, "dist");
        fs.mkdirSync(binDist, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@test/no-shebang",
            bin: { "test-bin": "./dist/bin.js" },
          }),
        );
        fs.writeFileSync(path.join(binDist, "bin.js"), 'console.log("no shebang");\n');

        const testSpec = {
          packageName: "@test/no-shebang",
          packageDir: "packages/no-shebang",
          binKey: "test-bin",
          binPath: "packages/no-shebang/dist/bin.js",
          testArgs: ["--help"],
          expectedOutputPattern: /no shebang/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("missing '#!/usr/bin/env node' shebang header");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("fails when smoke execution output does not match expected pattern", async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-test-bad-output-"));
      try {
        const pkgDir = path.join(tempDir, "packages/bad-output");
        const binDist = path.join(pkgDir, "dist");
        fs.mkdirSync(binDist, { recursive: true });
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@test/bad-output",
            bin: { "test-bin": "./dist/bin.js" },
          }),
        );
        fs.writeFileSync(
          path.join(binDist, "bin.js"),
          '#!/usr/bin/env node\nconsole.log("unexpected output");\n',
        );

        const testSpec = {
          packageName: "@test/bad-output",
          packageDir: "packages/bad-output",
          binKey: "test-bin",
          binPath: "packages/bad-output/dist/bin.js",
          testArgs: ["--help"],
          expectedOutputPattern: /expected specific string/i,
        };

        const result = await verifyBinaries({ rootDir: tempDir, specs: [testSpec] });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("Smoke output did not match expected pattern");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
