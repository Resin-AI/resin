import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectReleaseBinding, runSystemQualification } from "./system-qualification.mjs";

const tempDirs = [];
const COMMIT_SHA = "a".repeat(40);

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function createReleaseFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-system-qualification-"));
  tempDirs.push(rootDir);
  const releaseDir = path.join(rootDir, "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  const asset = Buffer.from("qualified-public-core-asset", "utf8");
  fs.writeFileSync(path.join(releaseDir, "resin-test.bin"), asset);
  fs.writeFileSync(
    path.join(releaseDir, "manifest.json"),
    `${JSON.stringify(
      {
        version: "1.0.3",
        releaseIdentity: { commitSha: COMMIT_SHA, trustDomain: "test" },
        assets: {
          test: { filename: "resin-test.bin", sha256: sha256(asset) },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { rootDir, releaseDir };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("public core system qualification", () => {
  it("binds evidence to the exact manifest, asset digest, and commit", () => {
    const { rootDir, releaseDir } = createReleaseFixture();
    const output = path.join(rootDir, "evidence", "system-e2e.json");
    const evidence = runSystemQualification({
      rootDir,
      releaseDir,
      output,
      commitSha: COMMIT_SHA,
      testOnly: true,
      suites: [],
      spawnSync: () => ({ status: 0, stdout: "passed", stderr: "" }),
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.commitSha).toBe(COMMIT_SHA);
    expect(evidence.release.assets.test.sha256).toHaveLength(64);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      kind: "resin-public-core-system-qualification",
      status: "passed",
      commitSha: COMMIT_SHA,
    });
  });

  it("rejects a release asset whose bytes do not match its manifest digest", () => {
    const { releaseDir } = createReleaseFixture();
    fs.writeFileSync(path.join(releaseDir, "resin-test.bin"), "tampered");
    expect(() => collectReleaseBinding(releaseDir)).toThrow("Release asset digest mismatch");
  });

  it("rejects qualification evidence for a different commit", () => {
    const { rootDir, releaseDir } = createReleaseFixture();
    expect(() =>
      runSystemQualification({
        rootDir,
        releaseDir,
        commitSha: "b".repeat(40),
        testOnly: true,
        suites: [],
        spawnSync: () => ({ status: 0, stdout: "passed", stderr: "" }),
      }),
    ).toThrow("Release commit SHA mismatch");
  });
});
