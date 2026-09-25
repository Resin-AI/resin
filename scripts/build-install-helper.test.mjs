import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { buildInstallHelper, updateInstallerDigestPins } from "./build-install-helper.mjs";

describe("build-install-helper", () => {
  const rootDir = process.cwd();

  it("builds the standalone install helper deterministically without writing when write=false", async () => {
    const build1 = await buildInstallHelper({ rootDir, write: false });
    const build2 = await buildInstallHelper({ rootDir, write: false });

    expect(Buffer.compare(build1.bytes, build2.bytes)).toBe(0);
  });

  it("keeps the standalone helper within the bootstrapper's one-mebibyte download limit", async () => {
    const result = await buildInstallHelper({ rootDir, write: false });
    expect(result.bytes.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("check mode rejects a stale helper without overwriting it", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-helper-check-"));
    const outputPath = path.join(tmpDir, "helper.mjs");
    fs.writeFileSync(outputPath, "// stale helper\n");
    try {
      await expect(buildInstallHelper({ rootDir, outputPath, check: true })).rejects.toThrow(
        /out of date/,
      );
      expect(fs.readFileSync(outputPath, "utf8")).toBe("// stale helper\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("synchronizes POSIX and PowerShell installer digest pins", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-helper-digest-pins-"));
    const installDir = path.join(tmpRoot, "apps", "cli", "install");
    const previousDigest = "a".repeat(64);
    const nextDigest = "b".repeat(64);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "install.sh"),
      [
        `# Pinned SHA-256: ${previousDigest}`,
        `PINNED_HELPER_SHA256="${previousDigest}"`,
        `# Verify SHA-256: ${previousDigest}`,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(installDir, "install.ps1"),
      [`# Helper SHA-256: ${previousDigest}`, `$PINNED_HELPER_SHA256 = "${previousDigest}"`].join(
        "\n",
      ),
    );

    try {
      updateInstallerDigestPins(tmpRoot, nextDigest);
      expect(fs.readFileSync(path.join(installDir, "install.sh"), "utf8")).not.toContain(
        previousDigest,
      );
      expect(fs.readFileSync(path.join(installDir, "install.ps1"), "utf8")).not.toContain(
        previousDigest,
      );
      expect(fs.readFileSync(path.join(installDir, "install.sh"), "utf8")).toContain(nextDigest);
      expect(fs.readFileSync(path.join(installDir, "install.ps1"), "utf8")).toContain(nextDigest);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("supports writing to a custom temporary destination path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-build-helper-test-"));
    const customOut = path.join(tmpDir, "custom-helper.mjs");

    try {
      const result = await buildInstallHelper({
        rootDir,
        outputPath: customOut,
        write: true,
      });

      expect(fs.existsSync(customOut)).toBe(true);
      const fileContent = fs.readFileSync(customOut, "utf8");
      expect(fileContent).toBe(result.code);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not write to destination if write=false", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-build-helper-test-"));
    const customOut = path.join(tmpDir, "should-not-exist.mjs");

    try {
      await buildInstallHelper({
        rootDir,
        outputPath: customOut,
        write: false,
      });

      expect(fs.existsSync(customOut)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
