import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMS, RELEASE_VERSION, packageRelease } from "./package-release.mjs";
import { PROPRIETARY_CLOUD_IDENTIFIERS, verifyReleaseFiles } from "./verify-release.mjs";

describe("standalone platform release artifact", () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-standalone-"));
  const releaseDir = path.join(tempRoot, "release");
  const extractDir = path.join(tempRoot, "extract");
  const outsideCwd = path.join(tempRoot, "outside-workspace");

  beforeAll(() => {
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(outsideCwd, { recursive: true });
    packageRelease({ rootDir, distDir: releaseDir, skipBuild: true, testOnly: true });
  }, 30_000);

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("packages and extracts standalone release with strictly public artifacts", () => {
    const hostAsset =
      PLATFORMS.find(
        (candidate) =>
          candidate.os === process.platform && candidate.arch === process.arch && !candidate.isWsl,
      ) ?? PLATFORMS.find((candidate) => candidate.id === "linux-x64");

    expect(hostAsset).toBeDefined();
    const tarball = path.join(releaseDir, hostAsset.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "pipe" });

    const installedRoot = path.join(extractDir, "resin");
    expect(fs.existsSync(path.join(installedRoot, "LICENSE"))).toBe(true);
    expect(fs.readFileSync(path.join(installedRoot, "LICENSE"), "utf8")).toContain(
      "Apache License",
    );
    expect(fs.existsSync(path.join(installedRoot, "NOTICE"))).toBe(true);
    expect(fs.readFileSync(path.join(installedRoot, "NOTICE"), "utf8")).toContain(
      "Third-Party Software Notices",
    );
    expect(fs.existsSync(path.join(installedRoot, "SECURITY.md"))).toBe(true);
    expect(fs.existsSync(path.join(installedRoot, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(installedRoot, "README.md"))).toBe(true);

    // Negative assertions: absence of cloud, web, serverless, cloud-contracts, workflows, fixtures
    expect(fs.existsSync(path.join(installedRoot, "apps/cloud"))).toBe(false);
    expect(fs.existsSync(path.join(installedRoot, "apps/web"))).toBe(false);
    expect(fs.existsSync(path.join(installedRoot, "packages/cloud-contracts"))).toBe(false);
    expect(fs.existsSync(path.join(installedRoot, "infra/serverless"))).toBe(false);
    expect(fs.existsSync(path.join(installedRoot, "infra/aws"))).toBe(false);
    expect(fs.existsSync(path.join(installedRoot, ".github"))).toBe(false);
    expect(fs.existsSync(path.join(installedRoot, "workflows"))).toBe(false);

    // Binaries verification: expected binaries only
    const binDir = path.join(installedRoot, "bin");
    expect(fs.existsSync(binDir)).toBe(true);
    const binFiles = fs.readdirSync(binDir);
    expect(binFiles).toContain("resin");
    expect(binFiles).toContain("resin-daemon");
    expect(
      binFiles.some((b) => b === "resin-gateway" || b === "resin-mcp" || b === "gateway.js"),
    ).toBe(true);
    expect(binFiles.filter((b) => b.includes("cloud"))).toEqual([]);

    // Scan all extracted files to ensure no source maps and no proprietary cloud identifiers
    function scanFiles(dir) {
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanFiles(full));
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
      return results;
    }

    const allExtractedFiles = scanFiles(installedRoot);

    // No source maps in release artifact
    const sourceMapFiles = allExtractedFiles.filter((f) => f.endsWith(".map"));
    expect(sourceMapFiles).toEqual([]);

    // No proprietary cloud identifiers in text/code payload
    for (const filePath of allExtractedFiles) {
      const ext = path.extname(filePath).toLowerCase();
      if ([".js", ".mjs", ".cjs", ".ts", ".d.ts", ".json", ".txt", ".md", ".sh"].includes(ext)) {
        const content = fs.readFileSync(filePath, "utf8");
        for (const identifier of PROPRIETARY_CLOUD_IDENTIFIERS) {
          expect(
            content.includes(identifier),
            `Extracted file ${path.relative(installedRoot, filePath)} should not contain proprietary identifier '${identifier}'`,
          ).toBe(false);
        }
      }
    }

    // Verify release files pass verification
    const releaseViolations = verifyReleaseFiles(releaseDir, {
      rootDir,
      allowTestEvidence: true,
    });
    expect(releaseViolations).toEqual([]);

    // Verify standalone CLI execution
    const cli = path.join(installedRoot, "bin", "resin");
    const env = { ...process.env, NODE_ENV: "production" };
    delete env.NODE_PATH;

    const version = execFileSync(process.execPath, [cli, "version"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });
    expect(version.trim()).toBe(`resin v${RELEASE_VERSION}`);

    const help = execFileSync(process.execPath, [cli, "help"], {
      cwd: outsideCwd,
      env,
      encoding: "utf8",
    });
    expect(help).toContain("Resin CLI");
    expect(help).toContain("upgrade");
  });
});
