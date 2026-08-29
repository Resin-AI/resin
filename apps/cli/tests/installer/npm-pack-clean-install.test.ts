import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractTarArchive,
  extractTarGzBuffer,
  getActiveVersion,
  installReleaseVersion,
  rollbackActiveVersion,
  sha256Hex,
  switchActiveVersion,
} from "../../src/installer/asset-downloader.js";
import { ResinInstaller } from "../../src/installer/installer.js";

describe("npm-pack-clean-install: Public bootstrap package & clean environment installation", () => {
  let tempTestDir: string;
  let fakeHome: string;
  let cliPackageDir: string;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-pack-test-"));
    fakeHome = path.join(tempTestDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    cliPackageDir = fs.existsSync(path.join(process.cwd(), "apps", "cli", "package.json"))
      ? path.join(process.cwd(), "apps", "cli")
      : path.resolve(process.cwd());
  });

  afterEach(() => {
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    } catch {}
  });

  it("validates public package manifest name, privacy, bin, and files boundaries", () => {
    const pkgJsonPath = path.join(cliPackageDir, "package.json");
    expect(fs.existsSync(pkgJsonPath)).toBe(true);

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

    // Intended public name & command
    expect(pkgJson.name).toBe("resin");
    expect(pkgJson.private).toBe(false);
    expect(pkgJson.bin).toBeDefined();
    expect(pkgJson.bin.resin).toBe("./bin/resin.mjs");

    // Files allowlist
    expect(pkgJson.files).toBeDefined();
    expect(pkgJson.files).toContain("dist");
    expect(pkgJson.files).toContain("bin");

    // Exports
    expect(pkgJson.exports).toBeDefined();
    expect(pkgJson.exports["."]).toBeDefined();
    expect(pkgJson.exports["./installer/channel-verifier"]).toBeDefined();
    expect(pkgJson.exports["./installer/asset-downloader"]).toBeDefined();
    expect(pkgJson.exports["./installer/user-service"]).toBeDefined();
  });

  it("verifies compiled entry point shebang and existence on disk", () => {
    const binScriptPath = path.join(cliPackageDir, "bin", "resin.mjs");
    expect(fs.existsSync(binScriptPath)).toBe(true);

    const binContent = fs.readFileSync(binScriptPath, "utf8");
    expect(binContent.startsWith("#!/usr/bin/env node")).toBe(true);

    const distBinPath = path.join(cliPackageDir, "dist", "bin", "cli.js");
    expect(fs.existsSync(distBinPath)).toBe(true);
  });

  it("simulates npm pack and verifies published tarball contains only necessary artifacts", () => {
    // Run npm pack in a temporary directory
    const packOutDir = path.join(tempTestDir, "pack-output");
    fs.mkdirSync(packOutDir, { recursive: true });

    const packOutput = execSync(`npm pack ${cliPackageDir} --pack-destination ${packOutDir}`, {
      encoding: "utf8",
    }).trim();

    const lines = packOutput.split("\n");
    const tarballFileName = lines[lines.length - 1]?.trim();
    expect(tarballFileName).toMatch(/^resin-.*\.tgz$/);

    const tarballPath = path.join(packOutDir, tarballFileName);
    expect(fs.existsSync(tarballPath)).toBe(true);

    // Decompress and inspect tar archive members
    const tarGzBuffer = fs.readFileSync(tarballPath);
    const tarBuffer = zlib.gunzipSync(tarGzBuffer);
    const { extractedFiles } = extractTarArchive(tarBuffer, path.join(tempTestDir, "unpacked"));

    const relativeFiles = extractedFiles.map((f) =>
      path.relative(path.join(tempTestDir, "unpacked", "package"), f).replace(/\\/g, "/"),
    );

    // Ensure required files are present
    expect(relativeFiles).toContain("package.json");
    expect(relativeFiles).toContain("bin/resin.mjs");
    expect(relativeFiles).toContain("bin/postinstall.mjs");
    expect(relativeFiles).toContain("dist/index.js");
    expect(relativeFiles).toContain("dist/bin/cli.js");

    // Ensure unwanted source files and tests are NOT included
    const hasTests = relativeFiles.some((f) => f.includes("tests/") || f.endsWith(".test.ts"));
    const hasTsBuildInfo = relativeFiles.some((f) => f.endsWith(".tsbuildinfo"));
    const hasSrc = relativeFiles.some((f) => f.startsWith("src/"));

    expect(hasTests).toBe(false);
    expect(hasTsBuildInfo).toBe(false);
    expect(hasSrc).toBe(false);
  }, 15_000);

  it("rejects archive traversal paths before writing release content", () => {
    const destinationDir = path.join(tempTestDir, "traversal-destination");
    const escapedPath = path.join(tempTestDir, "escaped.txt");
    const traversalTar = createSimpleTarGz([
      {
        name: "../escaped.txt",
        content: "must not be written\n",
        mode: 0o644,
      },
    ]);

    expect(() => extractTarGzBuffer(traversalTar, destinationDir)).toThrow(
      /illegal path traversal/i,
    );
    expect(fs.existsSync(escapedPath)).toBe(false);
  });

  it("rejects backslash traversal before mode normalization and preserves outside files", () => {
    const resinHome = path.join(tempTestDir, "backslash-home");
    const destinationDir = path.join(resinHome, "versions", "staging");
    const configDir = path.join(resinHome, "config");
    const outsidePath = path.join(configDir, "user.json");
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(outsidePath, '{"private":true}\n', { mode: 0o600 });
    fs.chmodSync(outsidePath, 0o600);
    const outsideBytes = fs.readFileSync(outsidePath);
    const outsideMode = fs.statSync(outsidePath).mode & 0o7777;

    const traversalTar = createSimpleTarGz([
      {
        name: "..\\..\\config\\user.json",
        content: "must not be written\n",
        mode: 0o755,
      },
    ]);

    expect(() => extractTarGzBuffer(traversalTar, destinationDir)).toThrow(
      /illegal path traversal|non-portable/i,
    );
    expect(fs.readdirSync(destinationDir)).toEqual([]);
    expect(fs.readFileSync(outsidePath)).toEqual(outsideBytes);
    expect(fs.statSync(outsidePath).mode & 0o7777).toBe(outsideMode);
  });

  it("rejects pre-existing extraction root and component links without following them", () => {
    const outsideDir = path.join(tempTestDir, "outside-link-target");
    const outsidePath = path.join(outsideDir, "secret.txt");
    fs.mkdirSync(outsideDir, { mode: 0o700 });
    fs.writeFileSync(outsidePath, "private\n", { mode: 0o600 });
    fs.chmodSync(outsidePath, 0o600);
    const outsideBytes = fs.readFileSync(outsidePath);
    const outsideMode = fs.statSync(outsidePath).mode & 0o7777;
    const linkType = process.platform === "win32" ? "junction" : "dir";

    const linkedRoot = path.join(tempTestDir, "linked-extraction-root");
    fs.symlinkSync(outsideDir, linkedRoot, linkType);
    expect(() =>
      extractTarGzBuffer(
        createSimpleTarGz([{ name: "secret.txt", content: "overwrite\n", mode: 0o755 }]),
        linkedRoot,
      ),
    ).toThrow(/root must be a real directory/i);

    const componentRoot = path.join(tempTestDir, "component-link-root");
    fs.mkdirSync(componentRoot, { mode: 0o700 });
    fs.symlinkSync(outsideDir, path.join(componentRoot, "link"), linkType);
    expect(() =>
      extractTarGzBuffer(
        createSimpleTarGz([{ name: "link/secret.txt", content: "overwrite\n", mode: 0o755 }]),
        componentRoot,
      ),
    ).toThrow(/pre-existing link/i);

    expect(fs.readFileSync(outsidePath)).toEqual(outsideBytes);
    expect(fs.statSync(outsidePath).mode & 0o7777).toBe(outsideMode);
  });

  it("rejects invalid checksums and bounded malformed tar sizes before filesystem mutation", () => {
    const validTar = createSimpleTarBuffer([
      { name: "safe-prefix.txt", content: "safe\n", mode: 0o644 },
      { name: "malformed.txt", content: "payload", mode: 0o644 },
    ]);
    const secondHeaderOffset = 1024;

    const invalidChecksum = Buffer.from(validTar);
    invalidChecksum[secondHeaderOffset] ^= 1;

    const withSizeField = (sizeField: string): Buffer => {
      const malformedTar = Buffer.from(validTar);
      const header = malformedTar.subarray(secondHeaderOffset, secondHeaderOffset + 512);
      header.fill(0, 124, 136);
      header.write(sizeField, 124, 12, "ascii");
      writeTarHeaderChecksum(header);
      return malformedTar;
    };

    const malformedCases = [
      { name: "checksum", tar: invalidChecksum },
      { name: "negative-size", tar: withSizeField("-0000000001") },
      { name: "overflow-size", tar: withSizeField("77777777777\0") },
      {
        name: "truncated-payload",
        tar: validTar.subarray(0, secondHeaderOffset + 512 + 2),
      },
      {
        name: "truncated-padding",
        tar: validTar.subarray(0, secondHeaderOffset + 512 + 7),
      },
    ];

    const outsidePath = path.join(tempTestDir, "malformed-outside.txt");
    fs.writeFileSync(outsidePath, "unchanged\n", { mode: 0o600 });
    fs.chmodSync(outsidePath, 0o600);
    const outsideBytes = fs.readFileSync(outsidePath);
    const outsideMode = fs.statSync(outsidePath).mode & 0o7777;

    for (const malformedCase of malformedCases) {
      const destinationDir = path.join(tempTestDir, `malformed-${malformedCase.name}`);
      expect(() => extractTarGzBuffer(zlib.gzipSync(malformedCase.tar), destinationDir)).toThrow(
        /tar archive|checksum|truncated|overflow/i,
      );
      expect(fs.existsSync(destinationDir)).toBe(false);
      expect(fs.readFileSync(outsidePath)).toEqual(outsideBytes);
      expect(fs.statSync(outsidePath).mode & 0o7777).toBe(outsideMode);
    }
  });

  it("rejects traversal versions for normal and force installs before outside mutation", async () => {
    const releaseTar = createSimpleTarGz([
      { name: "bin/resin", content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
      { name: "bin/resin-daemon", content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
      { name: "bin/resin-mcp", content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    ]);
    for (const force of [false, true]) {
      const resinHome = path.join(tempTestDir, `install-version-${String(force)}`);
      const outsideDir = path.join(resinHome, "config");
      const outsidePath = path.join(outsideDir, "version.json");
      fs.mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(outsidePath, '{"outside":true}\n', { mode: 0o600 });
      fs.chmodSync(outsidePath, 0o600);
      const outsideBytes = fs.readFileSync(outsidePath);
      const outsideMode = fs.statSync(outsidePath).mode & 0o7777;

      await expect(
        installReleaseVersion({
          version: "x/../../config",
          tarballPathOrBuffer: releaseTar,
          resinHome,
          force,
        }),
      ).rejects.toThrow(/safe exact SemVer segment/i);

      expect(fs.readFileSync(outsidePath)).toEqual(outsideBytes);
      expect(fs.statSync(outsidePath).mode & 0o7777).toBe(outsideMode);
      expect(fs.existsSync(path.join(resinHome, "versions"))).toBe(false);
    }
  });

  it("rejects traversal versions for switching before outside mutation", async () => {
    const resinHome = path.join(tempTestDir, "switch-version-home");
    const outsideDir = path.join(resinHome, "config");
    const outsidePath = path.join(outsideDir, "version.json");
    fs.mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(outsidePath, '{"version":"outside"}\n', { mode: 0o600 });
    fs.chmodSync(outsidePath, 0o600);
    const outsideBytes = fs.readFileSync(outsidePath);
    const outsideMode = fs.statSync(outsidePath).mode & 0o7777;

    await expect(
      switchActiveVersion({ resinHome, targetVersion: "x/../../config" }),
    ).rejects.toThrow(/safe exact SemVer segment/i);

    expect(fs.readFileSync(outsidePath)).toEqual(outsideBytes);
    expect(fs.statSync(outsidePath).mode & 0o7777).toBe(outsideMode);
    expect(fs.existsSync(path.join(resinHome, "current"))).toBe(false);
    expect(fs.existsSync(path.join(resinHome, "current-version"))).toBe(false);
  });

  it("rejects traversal versions from rollback state before outside mutation", async () => {
    const resinHome = path.join(tempTestDir, "rollback-version-home");
    const outsideDir = path.join(resinHome, "config");
    const outsidePath = path.join(outsideDir, "version.json");
    const versionStatePath = path.join(resinHome, "version-state.json");
    fs.mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(outsidePath, '{"version":"outside"}\n', { mode: 0o600 });
    fs.writeFileSync(
      versionStatePath,
      JSON.stringify({
        activeVersion: "1.0.0",
        previousVersion: "x/../../config",
        updatedAt: new Date(0).toISOString(),
        installedVersions: ["1.0.0"],
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(outsidePath, 0o600);
    const outsideBytes = fs.readFileSync(outsidePath);
    const outsideMode = fs.statSync(outsidePath).mode & 0o7777;
    const versionStateBytes = fs.readFileSync(versionStatePath);

    await expect(rollbackActiveVersion({ resinHome })).rejects.toThrow(
      /safe exact SemVer segment/i,
    );

    expect(fs.readFileSync(outsidePath)).toEqual(outsideBytes);
    expect(fs.statSync(outsidePath).mode & 0o7777).toBe(outsideMode);
    expect(fs.readFileSync(versionStatePath)).toEqual(versionStateBytes);
    expect(fs.existsSync(path.join(resinHome, "current"))).toBe(false);
  });

  it("installs release versions into immutable directories and performs atomic version switching", async () => {
    const resinHome = path.join(fakeHome, ".resin");

    // Create a mock release tarball for v1.0.0
    const mockV1Dir = path.join(tempTestDir, "mock-release-v1");
    fs.mkdirSync(path.join(mockV1Dir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(mockV1Dir, "bin", "resin-daemon"),
      "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(mockV1Dir, "bin", "resin-mcp"),
      "#!/usr/bin/env node\nconsole.log('mcp v1.0.0');\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(mockV1Dir, "bin", "resin"),
      "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
      { mode: 0o755 },
    );

    // Pack into .tar.gz buffer
    const v1Tar = createSimpleTarGz([
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    // Install v1.0.0
    const install1 = await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });

    expect(install1.version).toBe("1.0.0");
    expect(fs.existsSync(install1.versionDir)).toBe(true);
    expect(fs.existsSync(path.join(install1.versionDir, "version.json"))).toBe(true);

    // Switch active version to v1.0.0
    const switch1 = await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });

    expect(switch1.activeVersion).toBe("1.0.0");
    expect(switch1.previousVersion).toBeNull();
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Global bin shims check
    const globalDaemonBin = path.join(resinHome, "bin", "resin-daemon");
    expect(fs.existsSync(globalDaemonBin)).toBe(true);

    // Create a mock release tarball for v1.1.0 (upgrade)
    const v2Tar = createSimpleTarGz([
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.1.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v1.1.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.1.0');\n",
        mode: 0o755,
      },
    ]);

    // Install v1.1.0
    const install2 = await installReleaseVersion({
      version: "1.1.0",
      tarballPathOrBuffer: v2Tar,
      resinHome,
    });

    expect(install2.version).toBe("1.1.0");

    // Switch active version to v1.1.0
    const switch2 = await switchActiveVersion({
      resinHome,
      targetVersion: "1.1.0",
    });

    expect(switch2.activeVersion).toBe("1.1.0");
    expect(switch2.previousVersion).toBe("1.0.0");
    expect(switch2.rollbackRetained).toBe(true);
    expect(getActiveVersion(resinHome)).toBe("1.1.0");

    // Rollback to previous version v1.0.0
    const rollback = await rollbackActiveVersion({
      resinHome,
    });

    expect(rollback.restoredVersion).toBe("1.0.0");
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
  });

  it("normalizes release modes across umasks without touching user config", async () => {
    const resinHome = path.join(fakeHome, ".resin");
    fs.mkdirSync(resinHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(resinHome, 0o700);

    const customConfigDir = path.join(resinHome, "config");
    fs.mkdirSync(customConfigDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(customConfigDir, 0o700);
    const userConfigPath = path.join(customConfigDir, "user-preferences.json");
    const userConfigContents = JSON.stringify({ customKey: "customValue" });
    fs.writeFileSync(userConfigPath, userConfigContents, { mode: 0o600 });
    fs.chmodSync(userConfigPath, 0o600);

    const v1Tar = createSimpleTarGz([
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
        mode: 0o600,
      },
      {
        name: "bin/resin-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v1.0.0');\n",
        mode: 0o600,
      },
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o600,
      },
      {
        name: "bin/release-notes.txt",
        content: "not an executable\n",
        mode: 0o600,
      },
      {
        name: "LICENSE",
        content: "release license\n",
        mode: 0o600,
      },
      {
        name: "docs/guides/install.txt",
        content: "installation guide\n",
        mode: 0o600,
      },
      {
        name: "scripts/archive-tool",
        content: "#!/bin/sh\nexit 0\n",
        mode: 0o700,
      },
    ]);

    const originalUmask = process.platform === "win32" ? undefined : process.umask();
    try {
      if (originalUmask !== undefined) {
        process.umask(0o077);
      }

      const firstInstall = await installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      });
      await switchActiveVersion({
        resinHome,
        targetVersion: "1.0.0",
      });

      const versionMetadataBefore = fs.readFileSync(
        path.join(firstInstall.versionDir, "version.json"),
        "utf8",
      );

      if (originalUmask !== undefined) {
        expect(fs.statSync(path.join(resinHome, "versions")).mode & 0o7777).toBe(0o755);
        expect(fs.statSync(firstInstall.versionDir).mode & 0o7777).toBe(0o755);
        expect(fs.statSync(path.join(firstInstall.versionDir, "docs")).mode & 0o7777).toBe(0o755);
        expect(
          fs.statSync(path.join(firstInstall.versionDir, "docs", "guides")).mode & 0o7777,
        ).toBe(0o755);
        expect(fs.statSync(path.join(firstInstall.versionDir, "LICENSE")).mode & 0o7777).toBe(
          0o644,
        );
        expect(
          fs.statSync(path.join(firstInstall.versionDir, "docs", "guides", "install.txt")).mode &
            0o7777,
        ).toBe(0o644);
        expect(
          fs.statSync(path.join(firstInstall.versionDir, "bin", "release-notes.txt")).mode & 0o7777,
        ).toBe(0o644);
        expect(fs.statSync(path.join(firstInstall.versionDir, "bin", "resin")).mode & 0o7777).toBe(
          0o755,
        );
        expect(
          fs.statSync(path.join(firstInstall.versionDir, "bin", "resin-daemon")).mode & 0o7777,
        ).toBe(0o755);
        expect(
          fs.statSync(path.join(firstInstall.versionDir, "bin", "resin-mcp")).mode & 0o7777,
        ).toBe(0o755);
        expect(
          fs.statSync(path.join(firstInstall.versionDir, "scripts", "archive-tool")).mode & 0o7777,
        ).toBe(0o755);

        const specialBitDrifts = [
          {
            releasePath: path.join(firstInstall.versionDir, "bin", "resin"),
            driftMode: 0o4755,
            expectedMode: 0o755,
          },
          {
            releasePath: path.join(firstInstall.versionDir, "bin", "resin-daemon"),
            driftMode: 0o2755,
            expectedMode: 0o755,
          },
          {
            releasePath: path.join(firstInstall.versionDir, "docs"),
            driftMode: 0o1755,
            expectedMode: 0o755,
          },
        ];
        for (const drift of specialBitDrifts) {
          fs.chmodSync(drift.releasePath, drift.driftMode);
          expect(fs.statSync(drift.releasePath).mode & 0o7777).toBe(drift.driftMode);
          await expect(
            installReleaseVersion({
              version: "1.0.0",
              tarballPathOrBuffer: v1Tar,
              resinHome,
            }),
          ).rejects.toThrow(/permission mode drift/i);
          expect(fs.readFileSync(userConfigPath, "utf8")).toBe(userConfigContents);
          expect(fs.statSync(userConfigPath).mode & 0o7777).toBe(0o600);
          fs.chmodSync(drift.releasePath, drift.expectedMode);
        }

        process.umask(0o022);
      }

      const repeatInstall = await installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      });

      expect(repeatInstall.version).toBe("1.0.0");
      expect(repeatInstall.versionDir).toBe(firstInstall.versionDir);
      expect(getActiveVersion(resinHome)).toBe("1.0.0");
      expect(fs.readFileSync(path.join(repeatInstall.versionDir, "version.json"), "utf8")).toBe(
        versionMetadataBefore,
      );
      expect(fs.readFileSync(userConfigPath, "utf8")).toBe(userConfigContents);

      if (originalUmask !== undefined) {
        expect(fs.statSync(resinHome).mode & 0o7777).toBe(0o700);
        expect(fs.statSync(customConfigDir).mode & 0o7777).toBe(0o700);
        expect(fs.statSync(userConfigPath).mode & 0o7777).toBe(0o600);
      }
    } finally {
      if (originalUmask !== undefined) {
        process.umask(originalUmask);
      }
    }
  });

  it("runs the full ResinInstaller in a disposable clean environment without workspace links", async () => {
    const workspace = path.join(tempTestDir, "isolated-workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const installer = new ResinInstaller({
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: fakeHome,
      workspace,
      dryRun: false,
      nonInteractive: true,
      autoApprove: true,
    });

    expect(summary.success).toBe(true);
    expect(summary.journal.status).toBe("completed");
    expect(summary.platform.isSupported).toBe(true);

    const stateJournalPath = path.join(fakeHome, ".resin", "state", "install-journal.json");
    expect(fs.existsSync(stateJournalPath)).toBe(true);
  });
});

/**
 * Helper to create a deterministic in-memory .tar.gz buffer.
 */
interface SimpleTarFile {
  readonly name: string;
  readonly content: string;
  readonly mode?: number;
}

function writeTarHeaderChecksum(header: Buffer): void {
  header.fill(32, 148, 156);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += header[index];
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
}

function createSimpleTarBuffer(files: SimpleTarFile[]): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const contentBuf = Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512);

    header.write(file.name, 0, 100, "utf8");
    const modeStr = (file.mode ?? 0o644).toString(8).padStart(7, "0");
    header.write(`${modeStr}\0`, 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    const sizeStr = contentBuf.length.toString(8).padStart(11, "0");
    header.write(`${sizeStr}\0`, 124, 12, "utf8");
    header.write("14000000000\0", 136, 12, "utf8");
    header[156] = 48;
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    writeTarHeaderChecksum(header);

    blocks.push(header, contentBuf);
    const padSize = (512 - (contentBuf.length % 512)) % 512;
    if (padSize > 0) blocks.push(Buffer.alloc(padSize));
  }

  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function createSimpleTarGz(files: SimpleTarFile[]): Buffer {
  return zlib.gzipSync(createSimpleTarBuffer(files));
}
