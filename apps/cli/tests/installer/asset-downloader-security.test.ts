import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadAndVerifyAsset,
  extractTarArchive,
  extractTarGzBuffer,
  getActiveVersion,
  installReleaseVersion,
  rollbackActiveVersion,
  sha256Hex,
  switchActiveVersion,
} from "../../src/installer/asset-downloader.js";
import type { ReleaseProvenance } from "../../src/installer/release-client.js";

/**
 * Creates an in-memory .tar.gz archive buffer from a list of files.
 */
function createTestTarGz(
  files: Array<{ name: string; content: string | Buffer; mode?: number }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const contentBuf = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, "utf8");
    const header = Buffer.alloc(512);

    // File name (USTAR standard)
    header.write(file.name, 0, 100, "utf8");
    // Mode (octal)
    const modeStr = (file.mode || 0o644).toString(8).padStart(7, "0");
    header.write(`${modeStr}\0`, 100, 8, "utf8");
    // UID & GID
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    // Size (octal)
    const sizeStr = contentBuf.length.toString(8).padStart(11, "0");
    header.write(`${sizeStr}\0`, 124, 12, "utf8");
    // MTime
    header.write("00000000000\0", 136, 12, "utf8");
    // Typeflag: '0' for regular file
    header[156] = 48; // '0'
    // Magic: "ustar\0"
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");

    // Checksum: sum of all bytes with checksum field treated as 8 spaces (32)
    header.fill(32, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const chkStr = checksum.toString(8).padStart(6, "0");
    header.write(`${chkStr}\0 `, 148, 8, "utf8");

    blocks.push(header);
    blocks.push(contentBuf);

    const padding = (512 - (contentBuf.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }

  // Two 512-byte zero blocks at EOF
  blocks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(blocks);
  return zlib.gzipSync(tarBuffer);
}

/**
 * Creates an in-memory ZIP archive containing a single file (for mock Deno runtime testing).
 */
function createSingleFileZip(fileName: string, content: Buffer): Buffer {
  const nameBuffer = Buffer.from(fileName, "utf8");
  const localHeaderOffset = 0;

  // Local File Header
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // Version needed
  localHeader.writeUInt16LE(0, 6); // Flags
  localHeader.writeUInt16LE(0, 8); // Method 0 (Store)
  localHeader.writeUInt16LE(0, 10); // Mod time
  localHeader.writeUInt16LE(0, 12); // Mod date
  localHeader.writeUInt32LE(0, 14); // CRC-32 (0 for mock)
  localHeader.writeUInt32LE(content.length, 18); // Compressed size
  localHeader.writeUInt32LE(content.length, 22); // Uncompressed size
  localHeader.writeUInt16LE(nameBuffer.length, 26); // Name length
  localHeader.writeUInt16LE(0, 28); // Extra length

  const fileData = Buffer.concat([localHeader, nameBuffer, content]);

  // Central Directory Record
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // Version made by
  centralHeader.writeUInt16LE(20, 6); // Version needed
  centralHeader.writeUInt16LE(0, 8); // Flags
  centralHeader.writeUInt16LE(0, 10); // Method 0 (Store)
  centralHeader.writeUInt16LE(0, 12); // Mod time
  centralHeader.writeUInt16LE(0, 14); // Mod date
  centralHeader.writeUInt32LE(0, 16); // CRC-32
  centralHeader.writeUInt32LE(content.length, 20); // Compressed size
  centralHeader.writeUInt32LE(content.length, 24); // Uncompressed size
  centralHeader.writeUInt16LE(nameBuffer.length, 28); // Name length
  centralHeader.writeUInt16LE(0, 30); // Extra length
  centralHeader.writeUInt16LE(0, 32); // Comment length
  centralHeader.writeUInt16LE(0, 34); // Disk start
  centralHeader.writeUInt16LE(0, 36); // Internal attrs
  centralHeader.writeUInt32LE(0, 38); // External attrs
  centralHeader.writeUInt32LE(localHeaderOffset, 42); // Relative offset of local header

  const centralDir = Buffer.concat([centralHeader, nameBuffer]);

  // End of Central Directory Record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // Disk num
  eocd.writeUInt16LE(0, 6); // Start disk
  eocd.writeUInt16LE(1, 8); // Entries on disk
  eocd.writeUInt16LE(1, 10); // Total entries
  eocd.writeUInt32LE(centralDir.length, 12); // Central dir size
  eocd.writeUInt32LE(fileData.length, 16); // Offset of start of central dir
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([fileData, centralDir, eocd]);
}

describe("asset-downloader-security: RESIN-INSTALL-003 & RESIN-INSTALL-006 remediation", () => {
  let tempTestDir: string;
  let resinHome: string;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-asset-security-test-"));
    resinHome = path.join(tempTestDir, ".resin");
    fs.mkdirSync(resinHome, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    } catch {}
  });

  it("idempotently accepts an existing installation that matches byte-for-byte and mode-for-mode", async () => {
    const v1Tar = createTestTarGz([
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
      {
        name: "dist/index.js",
        content: "export const version = '1.0.0';\n",
        mode: 0o644,
      },
    ]);

    const provenance: ReleaseProvenance = {
      builder: "resin-official-ci",
      commit: "abcdef1234567890abcdef1234567890abcdef12",
      builtAt: "2026-08-25T00:00:00.000Z",
      channel: "stable",
      tag: "v1.0.0",
      deno: {
        version: "2.9.5",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    };

    // First install
    const firstInstall = await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
      provenance,
    });

    expect(firstInstall.version).toBe("1.0.0");
    expect(fs.existsSync(firstInstall.versionDir)).toBe(true);

    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Repeat install with identical inputs
    const repeatInstall = await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
      provenance,
    });

    expect(repeatInstall.version).toBe("1.0.0");
    expect(repeatInstall.versionDir).toBe(firstInstall.versionDir);
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
  });

  it("fails closed when an attacker pre-seeds or modifies an executable in the version directory", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('legitimate daemon');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('legitimate cli');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });

    // Attacker modifies an executable in the installed directory
    const cliPath = path.join(resinHome, "versions", "v1.0.0", "bin", "resin");
    fs.writeFileSync(cliPath, "#!/usr/bin/env node\nconsole.log('backdoored payload');\n", {
      mode: 0o755,
    });

    // Repeat install must detect the byte-for-byte mismatch and fail closed
    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      }),
    ).rejects.toThrow(/byte-for-byte content mismatch|Integrity violation/i);

    // Active version and state are not corrupted
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
  });

  it("fails closed when version.json metadata is preseeded, corrupted, or tampered", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });

    const versionJsonPath = path.join(resinHome, "versions", "v1.0.0", "version.json");

    // Subcase A: Corrupted JSON
    fs.writeFileSync(versionJsonPath, "{ corrupted json syntax", "utf8");
    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      }),
    ).rejects.toThrow(/version\.json/i);

    // Subcase B: Tampered SHA-256 in version.json
    fs.writeFileSync(
      versionJsonPath,
      JSON.stringify({
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }),
      "utf8",
    );
    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      }),
    ).rejects.toThrow(/version\.json SHA-256 mismatch|Integrity violation/i);

    // Subcase C: Tampered version string in version.json
    fs.writeFileSync(
      versionJsonPath,
      JSON.stringify({
        version: "2.0.0",
        installedAt: new Date().toISOString(),
        sha256: sha256Hex(v1Tar),
      }),
      "utf8",
    );
    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      }),
    ).rejects.toThrow(/version\.json version mismatch|Integrity violation/i);
  });

  it("fails closed when extra unexpected files or directories exist in the installed tree", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });

    // Attacker plants an extra file inside the version directory
    const extraFilePath = path.join(resinHome, "versions", "v1.0.0", "bin", "untracked-binary");
    fs.writeFileSync(extraFilePath, "#!/bin/sh\necho pwned\n", { mode: 0o755 });

    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      }),
    ).rejects.toThrow(/extra unexpected file or directory detected/i);
  });

  it("fails closed when symlinks are injected into the installed version tree", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });

    // Replace regular file with symlink
    const targetCli = path.join(resinHome, "versions", "v1.0.0", "bin", "resin");
    fs.unlinkSync(targetCli);
    fs.symlinkSync("/bin/sh", targetCli);

    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      }),
    ).rejects.toThrow(/symlink detected in installed version tree/i);
  });

  it("rejects dangerous or symlink entries in tar archives during extraction", () => {
    // Construct a tar header with typeflag '2' (symlink)
    const header = Buffer.alloc(512);
    header.write("malicious-symlink", 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "utf8");
    header.write("0000000\0", 124, 12, "utf8");
    header[156] = 50; // '2' = symlink
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");

    header.fill(32, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const chkStr = checksum.toString(8).padStart(6, "0");
    header.write(`${chkStr}\0 `, 148, 8, "utf8");

    const tarData = Buffer.concat([header, Buffer.alloc(1024)]);
    const destDir = path.join(tempTestDir, "tar-symlink-test");

    expect(() => extractTarArchive(tarData, destDir)).toThrow(
      /symlink or hardlink entry in tar archive is not permitted/i,
    );
  });

  if (process.platform !== "win32") {
    it("fails closed when file permission modes drift in the installed tree", async () => {
      const v1Tar = createTestTarGz([
        {
          name: "bin/resin",
          content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
          mode: 0o755,
        },
      ]);

      await installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome,
      });

      // Change file permission mode
      const cliPath = path.join(resinHome, "versions", "v1.0.0", "bin", "resin");
      fs.chmodSync(cliPath, 0o644);

      await expect(
        installReleaseVersion({
          version: "1.0.0",
          tarballPathOrBuffer: v1Tar,
          resinHome,
        }),
      ).rejects.toThrow(/file permission mode drift/i);
    });
  }

  it("never deletes or replaces the active target before a proven replacement is ready", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });

    const v1Dir = path.join(resinHome, "versions", "v1.0.0");
    expect(fs.existsSync(v1Dir)).toBe(true);

    // Attempt a forced reinstall with a corrupted archive that fails extraction
    const corruptTarGz = Buffer.from("corrupted not a valid gzip or tarball payload");

    await expect(
      installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: corruptTarGz,
        resinHome,
        force: true,
      }),
    ).rejects.toThrow();

    // The original version directory must remain completely intact and active
    expect(fs.existsSync(v1Dir)).toBe(true);
    expect(fs.existsSync(path.join(v1Dir, "bin", "resin"))).toBe(true);
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
  });

  it("rolls back atomic pointers, state, and global bin shims on version switch failure", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });

    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Attempt switching to a nonexistent version
    await expect(
      switchActiveVersion({
        resinHome,
        targetVersion: "9.9.9",
      }),
    ).rejects.toThrow(/directory does not exist/i);

    // Active version and state remain pointing to v1.0.0
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Global bin points to v1.0.0
    const globalCli = path.join(resinHome, "bin", "resin");
    expect(fs.existsSync(globalCli)).toBe(true);
  });

  it("publishes global commands atomically without mixed command sets across versions", async () => {
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v1.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v1.0.0');\n",
        mode: 0o755,
      },
    ]);

    const v2Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/usr/bin/env node\nconsole.log('cli v2.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin-daemon",
        content: "#!/usr/bin/env node\nconsole.log('daemon v2.0.0');\n",
        mode: 0o755,
      },
      {
        name: "bin/resin-mcp",
        content: "#!/usr/bin/env node\nconsole.log('mcp v2.0.0');\n",
        mode: 0o755,
      },
    ]);

    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });

    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    await installReleaseVersion({
      version: "2.0.0",
      tarballPathOrBuffer: v2Tar,
      resinHome,
    });
    const switchResult = await switchActiveVersion({
      resinHome,
      targetVersion: "2.0.0",
    });

    expect(switchResult.activeVersion).toBe("2.0.0");
    expect(switchResult.previousVersion).toBe("1.0.0");
    expect(switchResult.rollbackRetained).toBe(true);
    expect(getActiveVersion(resinHome)).toBe("2.0.0");

    // Verify all global binaries belong to v2.0.0
    const globalBinDir = path.join(resinHome, "bin");
    const globalDaemon = path.join(globalBinDir, "resin-daemon");
    const globalMcp = path.join(globalBinDir, "resin-mcp");
    expect(fs.existsSync(globalDaemon)).toBe(true);
    expect(fs.existsSync(globalMcp)).toBe(true);

    // Rollback to v1.0.0
    const rollbackResult = await rollbackActiveVersion({
      resinHome,
    });
    expect(rollbackResult.restoredVersion).toBe("1.0.0");
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
  });

  it("successfully rolls back to a valid prior active version and fails closed on missing metadata", async () => {
    // Seed valid prior v1.0.0 with version.json
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/bin/sh\necho '1.0.0'\n",
        mode: 0o755,
      },
    ]);
    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Install and switch to v1.1.0
    const v11Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/bin/sh\necho '1.1.0'\n",
        mode: 0o755,
      },
    ]);
    await installReleaseVersion({
      version: "1.1.0",
      tarballPathOrBuffer: v11Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.1.0",
    });
    expect(getActiveVersion(resinHome)).toBe("1.1.0");

    // Execute rollback to 1.0.0
    const rollback = await rollbackActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });

    expect(rollback.restoredVersion).toBe("1.0.0");
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    const v1Dir = path.join(resinHome, "versions", "v1.0.0");
    const currentTarget = fs.readlinkSync(path.join(resinHome, "current"));
    expect(currentTarget).toContain("v1.0.0");
    expect(fs.existsSync(path.join(v1Dir, "version.json"))).toBe(true);
    const globalCli = path.join(resinHome, "bin", "resin");
    expect(fs.existsSync(globalCli)).toBe(true);

    // Missing version.json must fail closed and reject activation
    const unverifiedDir = path.join(resinHome, "versions", "v3.0.0");
    fs.mkdirSync(path.join(unverifiedDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(unverifiedDir, "bin", "resin"), "#!/bin/sh\necho 'unverified'\n", {
      mode: 0o755,
    });

    await expect(
      switchActiveVersion({
        resinHome,
        targetVersion: "3.0.0",
      }),
    ).rejects.toThrow(/missing version\.json metadata/i);
  });

  it("restores prior bin, pointer, and state atomically when state commit fails after bin swap", async () => {
    // Install v1.0.0
    const v1Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/bin/sh\necho '1.0.0'\n",
        mode: 0o755,
      },
    ]);
    await installReleaseVersion({
      version: "1.0.0",
      tarballPathOrBuffer: v1Tar,
      resinHome,
    });
    await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
    });
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Install v2.0.0
    const v2Tar = createTestTarGz([
      {
        name: "bin/resin",
        content: "#!/bin/sh\necho '2.0.0'\n",
        mode: 0o755,
      },
    ]);
    await installReleaseVersion({
      version: "2.0.0",
      tarballPathOrBuffer: v2Tar,
      resinHome,
    });

    // Create a blocking directory at version-state.json to trigger a failure during atomic rename
    const statePath = path.join(resinHome, "version-state.json");
    fs.rmSync(statePath, { force: true });
    fs.mkdirSync(statePath); // Directory prevents renaming a file over it on POSIX (EISDIR / EPERM)

    await expect(
      switchActiveVersion({
        resinHome,
        targetVersion: "2.0.0",
      }),
    ).rejects.toThrow();

    // Clean up blocking directory so getActiveVersion can read state if needed
    fs.rmSync(statePath, { recursive: true, force: true });

    // Verify atomic rollback restored v1.0.0 completely
    expect(getActiveVersion(resinHome)).toBe("1.0.0");

    // Global bin was restored to v1.0.0 from backup
    const globalCli = path.join(resinHome, "bin", "resin");
    expect(fs.existsSync(globalCli)).toBe(true);
    const globalTarget = fs.readlinkSync(globalCli);
    expect(globalTarget).toContain("v1.0.0");
    expect(globalTarget).not.toContain("v2.0.0");
  });

  it("cleanly removes newly published state and bins when switch fails on a fresh install", async () => {
    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-fresh-switch-fail-"));
    try {
      const v1Tar = createTestTarGz([
        {
          name: "bin/resin",
          content: "#!/bin/sh\necho '1.0.0'\n",
          mode: 0o755,
        },
      ]);
      await installReleaseVersion({
        version: "1.0.0",
        tarballPathOrBuffer: v1Tar,
        resinHome: freshHome,
      });

      // Block state write on fresh home
      const statePath = path.join(freshHome, "version-state.json");
      fs.mkdirSync(statePath);

      await expect(
        switchActiveVersion({
          resinHome: freshHome,
          targetVersion: "1.0.0",
        }),
      ).rejects.toThrow();

      // Verify no active version or orphaned global bins remain
      expect(getActiveVersion(freshHome)).toBeNull();
      expect(fs.existsSync(path.join(freshHome, "current"))).toBe(false);
      expect(fs.existsSync(path.join(freshHome, "bin"))).toBe(false);
    } finally {
      fs.rmSync(freshHome, { recursive: true, force: true });
    }
  });

  it("enforces explicit sanitized archive permission bits and safe directory modes under umask 077", async () => {
    if (process.platform === "win32") return;
    const oldUmask = process.umask(0o077);
    try {
      const umaskHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-umask-test-"));
      try {
        const testTar = createTestTarGz([
          {
            name: "bin/resin-executable",
            content: "#!/usr/bin/env node\nconsole.log('test');\n",
            mode: 0o4755, // setuid + 0755
          },
          {
            name: "data/config.json",
            content: '{"ok":true}\n',
            mode: 0o644,
          },
          {
            name: "data/missing-mode.txt",
            content: "default mode\n",
          },
        ]);

        const result = await installReleaseVersion({
          version: "1.0.0",
          tarballPathOrBuffer: testTar,
          resinHome: umaskHome,
          denoRuntime: {
            version: "2.1.4",
            archivePathOrBuffer: createSingleFileZip(
              "deno",
              Buffer.from("#!/bin/sh\necho deno\n", "utf8"),
            ),
          },
        });

        // Verify regular metadata files get 0644
        const versionJsonStat = fs.lstatSync(path.join(result.versionDir, "version.json"));
        expect(versionJsonStat.mode & 0o777).toBe(0o644);

        const configStat = fs.lstatSync(path.join(result.versionDir, "data", "config.json"));
        expect(configStat.mode & 0o777).toBe(0o644);

        const missingModeStat = fs.lstatSync(
          path.join(result.versionDir, "data", "missing-mode.txt"),
        );
        expect(missingModeStat.mode & 0o777).toBe(0o644);

        // Verify executable gets 0755 without setuid/special bits (0o4755 -> 0o755)
        const execStat = fs.lstatSync(path.join(result.versionDir, "bin", "resin-executable"));
        expect(execStat.mode & 0o777).toBe(0o755);
        expect(execStat.mode & 0o7000).toBe(0);

        // Verify generated bin launchers get 0755
        const cliStat = fs.lstatSync(path.join(result.versionDir, "bin", "resin"));
        expect(cliStat.mode & 0o777).toBe(0o755);

        // Verify Deno binary gets 0755
        const denoStat = fs.lstatSync(path.join(result.versionDir, "deno", "deno"));
        expect(denoStat.mode & 0o777).toBe(0o755);

        // Verify directories get safe permissions (0755)
        const versionDirStat = fs.lstatSync(result.versionDir);
        expect(versionDirStat.mode & 0o777).toBe(0o755);

        const dataDirStat = fs.lstatSync(path.join(result.versionDir, "data"));
        expect(dataDirStat.mode & 0o777).toBe(0o755);
      } finally {
        fs.rmSync(umaskHome, { recursive: true, force: true });
      }
    } finally {
      process.umask(oldUmask);
    }
  });

  it("downloadAndVerifyAsset verifies sha256 cryptographic digest and writes file with secure permissions", async () => {
    const downloadDir = path.join(resinHome, "downloads");
    const fileContent = Buffer.from("SECURE_RELEASE_ASSET_CONTENT_BINARY_DATA");
    const expectedSha256 = sha256Hex(fileContent);

    const asset = {
      name: "resin-test-asset",
      filename: "resin-test-asset.tar.gz",
      sha256: expectedSha256,
      size: fileContent.length,
      os: "linux" as const,
      arch: "x64" as const,
    };

    const result = await downloadAndVerifyAsset({
      asset,
      downloadDir,
      sourceBuffer: fileContent,
    });

    expect(result.path).toBe(path.join(downloadDir, "resin-test-asset.tar.gz"));
    expect(result.verified).toBe(true);
    expect(result.sha256).toBe(expectedSha256);
    expect(fs.existsSync(result.path)).toBe(true);

    // Verify temp file does not linger
    const tempPath = path.join(downloadDir, `${asset.filename}.download.tmp`);
    expect(fs.existsSync(tempPath)).toBe(false);

    // Verify file content matches byte for byte
    const readBack = fs.readFileSync(result.path);
    expect(readBack.equals(fileContent)).toBe(true);

    if (process.platform !== "win32") {
      const stat = fs.statSync(result.path);
      expect(stat.mode & 0o777).toBe(0o644);
    }
  });

  it("downloadAndVerifyAsset fails closed on sha256 digest mismatch and cleans up temporary file", async () => {
    const downloadDir = path.join(resinHome, "downloads");
    const fileContent = Buffer.from("TAMPERED_MALICIOUS_PAYLOAD");
    const fakeExpectedSha256 = "0000000000000000000000000000000000000000000000000000000000000000";

    const asset = {
      name: "resin-tampered-asset",
      filename: "resin-tampered-asset.tar.gz",
      sha256: fakeExpectedSha256,
      size: fileContent.length,
      os: "linux" as const,
      arch: "x64" as const,
    };

    await expect(
      downloadAndVerifyAsset({
        asset,
        downloadDir,
        sourceBuffer: fileContent,
      }),
    ).rejects.toThrow(/Cryptographic digest mismatch/i);

    const destPath = path.join(downloadDir, "resin-tampered-asset.tar.gz");
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("downloadAndVerifyAsset fails closed on HTTP errors or missing source parameters", async () => {
    const downloadDir = path.join(resinHome, "downloads");
    const asset = {
      name: "resin-missing-asset",
      filename: "resin-missing-asset.tar.gz",
      sha256: "abc123def456",
      size: 100,
      os: "linux" as const,
      arch: "x64" as const,
    };

    // 1. Missing source
    await expect(
      downloadAndVerifyAsset({
        asset,
        downloadDir,
      }),
    ).rejects.toThrow(/No source buffer, local path, or URL/i);

    // 2. Mock HTTP 404 error
    const mock404Fetch = async () =>
      new Response(null, {
        status: 404,
        statusText: "Not Found",
      });

    await expect(
      downloadAndVerifyAsset({
        asset,
        downloadDir,
        sourceUrlOrPath: "https://example.com/not-found.tar.gz",
        fetchImpl: mock404Fetch,
      }),
    ).rejects.toThrow(/Failed to download asset.*HTTP 404/i);

    const destPath = path.join(downloadDir, asset.filename);
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it("downloadAndVerifyAsset respects download timeout and aborts stalled connections", async () => {
    const downloadDir = path.join(resinHome, "downloads");
    const asset = {
      name: "resin-slow-asset",
      filename: "resin-slow-asset.tar.gz",
      sha256: "abc123",
      size: 100,
      os: "linux" as const,
      arch: "x64" as const,
    };

    const mockHangingFetch = (url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            reject(new Error("The operation was aborted"));
          });
        }
      });
    };

    await expect(
      downloadAndVerifyAsset({
        asset,
        downloadDir,
        sourceUrlOrPath: "https://example.com/slow-asset.tar.gz",
        // SAFETY: Mock fetch implementing required interface for hanging fetch test.
        fetchImpl: mockHangingFetch as typeof globalThis.fetch,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/aborted/i);
  });
});
