import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { DEFAULT_BANNER, buildInstallHelper } from "./build-install-helper.mjs";

describe("build-install-helper", () => {
  const rootDir = process.cwd();

  it("builds the standalone install helper deterministically without writing when write=false", async () => {
    const build1 = await buildInstallHelper({ rootDir, write: false });
    const build2 = await buildInstallHelper({ rootDir, write: false });

    expect(build1.code).toBeDefined();
    expect(build1.code.length).toBeGreaterThan(0);
    expect(build1.sha256).toBe(build2.sha256);
    expect(Buffer.compare(build1.bytes, build2.bytes)).toBe(0);
  });

  it("embeds the production trust root record in the bundled output", async () => {
    const result = await buildInstallHelper({ rootDir, write: false });

    expect(result.code).toContain("resin-release-2026a");
    expect(result.code).toContain(
      "f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851",
    );
    expect(result.code).toContain(
      "a702d0d424e5797ecb672afabd275548c1ef6e1e95d1ea9651916e147e784359",
    );
    expect(result.code).toContain(DEFAULT_BANNER.trim());
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
