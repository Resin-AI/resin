import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMS, RELEASE_VERSION } from "./package-release.mjs";
import { PROPRIETARY_CLOUD_IDENTIFIERS, verifyReleaseFiles } from "./verify-release.mjs";

describe("standalone platform release artifact", () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-standalone-"));
  const releaseDir = path.join(tempRoot, "release");
  const extractDir = path.join(tempRoot, "extract");
  const outsideCwd = path.join(tempRoot, "outside-workspace");

  beforeAll(async () => {
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(outsideCwd, { recursive: true });
    // Packaging every platform is about a minute of synchronous CPU work. Running it in a child
    // process keeps this test worker responsive to the runner, which otherwise times out its RPC.
    const packageRelease = pathToFileURL(path.join(rootDir, "scripts", "package-release.mjs")).href;
    const options = { rootDir, distDir: releaseDir, skipBuild: true, testOnly: true };
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { packageRelease } = await import(${JSON.stringify(packageRelease)});\npackageRelease(${JSON.stringify(options)});`,
      ],
      { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 },
    );
  }, 240_000);

  afterAll(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
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
    expect(binFiles).not.toContain("resin-mcp");
    expect(binFiles.some((b) => b === "resin-gateway" || b === "gateway.js")).toBe(true);
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

  it("reports the release version over IPC from a daemon started through the packaged entry", async () => {
    const hostAsset =
      PLATFORMS.find(
        (candidate) =>
          candidate.os === process.platform && candidate.arch === process.arch && !candidate.isWsl,
      ) ?? PLATFORMS.find((candidate) => candidate.id === "linux-x64");
    const daemonExtractDir = path.join(tempRoot, "daemon-extract");
    const home = path.join(tempRoot, "daemon-home");
    fs.mkdirSync(daemonExtractDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(releaseDir, hostAsset.filename),
      "-C",
      daemonExtractDir,
    ]);
    const daemon = path.join(daemonExtractDir, "resin", "bin", "resin-daemon");
    // The daemon must not borrow a version from its environment: the release it runs from decides.
    const env = { ...process.env, NODE_ENV: "production", HOME: home };
    delete env.NODE_PATH;
    delete env.RESIN_RELEASE_VERSION;
    delete env.RESIN_HOME;
    const run = (args) =>
      promisify(execFile)(process.execPath, [daemon, ...args, "--home", home], {
        cwd: outsideCwd,
        env,
      });

    // A package version (0.1.0) here fails the update engine's probation health gate.
    expect(RELEASE_VERSION).not.toBe("0.1.0");
    const child = spawn(process.execPath, [daemon, "--foreground", "--home", home], {
      cwd: outsideCwd,
      env,
      stdio: "ignore",
    });
    try {
      let health;
      for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const { stdout } = await run(["--status"]).catch(() => ({ stdout: "" }));
        const start = stdout.indexOf("{");
        if (start >= 0) health = JSON.parse(stdout.slice(start));
      }
      expect(health).toMatchObject({ status: "fully-ready", version: RELEASE_VERSION });
    } finally {
      await run(["--stop"]).catch(() => {});
      if (child.exitCode === null) child.kill();
    }
  });
});
