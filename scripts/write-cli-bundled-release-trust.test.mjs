import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCliBundledReleaseTrust } from "./write-cli-bundled-release-trust.mjs";

const temporaryDirectories = [];

function createTemporaryRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-cli-trust-"));
  temporaryDirectories.push(rootDir);
  return rootDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("writeCliBundledReleaseTrust", () => {
  it("writes the validated trust record into the locally built CLI", async () => {
    const rootDir = createTemporaryRoot();
    const trustRecord = {
      schemaVersion: "2.0.0",
      trustDomain: "production",
      trustedKeys: [{ keyId: "release-key" }],
    };
    const validateTrustRecord = vi.fn();

    const result = await writeCliBundledReleaseTrust({
      rootDir,
      trustRecord,
      validateTrustRecord,
    });

    const outputPath = path.join(rootDir, "apps/cli/dist/release-trust.json");
    expect(result.outputPath).toBe(outputPath);
    expect(validateTrustRecord).toHaveBeenCalledWith(trustRecord);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(trustRecord);
  });

  it("does not write an invalid trust record", async () => {
    const rootDir = createTemporaryRoot();
    const validateTrustRecord = vi.fn(() => {
      throw new Error("invalid release trust");
    });

    await expect(
      writeCliBundledReleaseTrust({
        rootDir,
        trustRecord: {},
        validateTrustRecord,
      }),
    ).rejects.toThrow("invalid release trust");

    expect(fs.existsSync(path.join(rootDir, "apps/cli/dist/release-trust.json"))).toBe(false);
  });

  it("runs as part of the CLI package build", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
    );

    expect(packageJson.scripts.build).toContain("write-cli-bundled-release-trust.mjs");
  });
});
