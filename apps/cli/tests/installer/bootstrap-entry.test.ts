import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { getActiveVersion } from "../../src/installer/asset-downloader.js";
import {
  DEFAULT_HEALTH_CHECK_MAX_OUTPUT_BYTES,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_ONBOARDING_MAX_OUTPUT_BYTES,
  DEFAULT_ONBOARDING_TIMEOUT_MS,
  PRODUCTION_RELEASE_TRUST_RECORD,
  bootstrapInstall,
  configureShellPath,
  defaultHealthCheckRunner,
  defaultOnboardingRunner,
  detectOnboardingSkipReason,
  isAlreadyInitialized,
  isMainModule,
  resolveCandidateProfiles,
  resolveTrustedReleaseKeys,
  runCli,
  validateChannelUrl,
} from "../../src/installer/bootstrap-entry.js";
import { canonicalJson } from "../../src/installer/channel-verifier.js";
import { type PlatformInfo, UnsupportedPlatformError } from "../../src/platform/index.js";

interface ReleaseSignatureItem {
  keyId: string;
  algorithm: string;
  publicKeyHex: string;
  signatureHex: string;
}
function sign(payload: Parameters<typeof canonicalJson>[0], privateKey: crypto.KeyObject): string {
  const json = canonicalJson(payload);
  return crypto.sign(null, Buffer.from(json, "utf8"), privateKey).toString("hex");
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

type TarGzFixture = string | { readonly content: string; readonly mode?: number };

function tarGz(files: Record<string, TarGzFixture> = {}): Buffer {
  const fileEntries = Object.entries(files);
  const defaultEntries: Array<[string, TarGzFixture]> =
    fileEntries.length > 0
      ? fileEntries
      : [
          ["bin/resin", "#!/bin/sh\necho resin 1.0.0\n"],
          ["bin/resin-daemon", "#!/bin/sh\nexit 0\n"],
          ["bin/resin-mcp", "#!/bin/sh\nexit 0\n"],
        ];

  const tarBuffers: Buffer[] = [];

  for (const [name, fixture] of defaultEntries) {
    const content = String(fixture) === fixture ? fixture : fixture.content;
    const mode = String(fixture) === fixture ? 0o755 : (fixture.mode ?? 0o755);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(mode.toString(8).padStart(7, "0"), 100, 8, "utf8");
    header.write("0001750", 108, 8, "utf8");
    header.write("0001750", 116, 8, "utf8");
    const size = Buffer.byteLength(content);
    header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "utf8");
    const mtime = `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")} `;
    header.write(mtime, 136, 12, "utf8");
    header.write("0", 156, 1, "utf8");

    header.fill(32, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

    tarBuffers.push(header);
    const contentBuf = Buffer.from(content, "utf8");
    tarBuffers.push(contentBuf);
    const remainder = size % 512;
    if (remainder !== 0) {
      tarBuffers.push(Buffer.alloc(512 - remainder));
    }
  }

  tarBuffers.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(tarBuffers));
}

function zipStored(filename: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const crc = 0;
  const size = content.length;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(size, 18);
  localHeader.writeUInt32LE(size, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localOffset = 0;
  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 8);
  cdHeader.writeUInt16LE(0, 10);
  cdHeader.writeUInt16LE(0, 12);
  cdHeader.writeUInt16LE(0, 14);
  cdHeader.writeUInt32LE(crc, 16);
  cdHeader.writeUInt32LE(size, 20);
  cdHeader.writeUInt32LE(size, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt16LE(0, 30);
  cdHeader.writeUInt16LE(0, 32);
  cdHeader.writeUInt16LE(0, 34);
  cdHeader.writeUInt16LE(0, 36);
  cdHeader.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  cdHeader.writeUInt32LE(localOffset, 42);

  const cdSize = cdHeader.length + nameBuf.length;
  const cdOffset = localHeader.length + nameBuf.length + content.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, nameBuf, content, cdHeader, nameBuf, eocd]);
}

interface SignedReleaseFixturesOptions {
  version: string;
  keyId: string;
  publicKeyHex: string;
  privateKey: crypto.KeyObject;
  releaseBytes: Buffer;
  denoBytes?: Buffer;
  corruptManifestAssetSha256?: string;
  corruptManifestAssetSizeBytes?: number;
}

function createSignedReleaseFixtures(options: SignedReleaseFixturesOptions) {
  const {
    version,
    keyId,
    publicKeyHex,
    privateKey,
    releaseBytes,
    corruptManifestAssetSha256,
    corruptManifestAssetSizeBytes,
  } = options;

  const defaultDenoBytes = zipStored("deno", Buffer.from("#!/bin/sh\nexit 0\n"));
  const activeDenoBytes = options.denoBytes ?? defaultDenoBytes;

  const releaseAssetSha256 = corruptManifestAssetSha256 ?? sha256Hex(releaseBytes);
  const releaseAssetSize = corruptManifestAssetSizeBytes ?? releaseBytes.length;

  const manifestSignatures: ReleaseSignatureItem[] = [];
  const manifestDoc = {
    schemaVersion: "2.0.0",
    metadataVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    version,
    releaseDate: new Date().toISOString(),
    releaseIdentity: {
      repository: "github.com/resin/resin",
      commitSha: "a".repeat(40),
    },
    packages: {
      daemon: { version, path: "bin/resin-daemon" },
      mcp: { version, path: "bin/resin-mcp" },
      cli: { version, path: "bin/resin" },
    },
    runtimes: {
      deno: {
        version: "2.9.5",
        required: true,
        assets: {
          "linux-x64": {
            filename: "deno-linux-x64.zip",
            url: `/releases/v${version}/deno-linux-x64.zip`,
            sha256: sha256Hex(activeDenoBytes),
            sizeBytes: activeDenoBytes.length,
            archive: "zip" as const,
            executable: "deno",
          },
        },
      },
    },
    assets: {
      "linux-x64": {
        filename: "resin-linux-x64.tar.gz",
        platform: "linux",
        arch: "x64",
        path: `/releases/v${version}/resin-linux-x64.tar.gz`,
        sha256: releaseAssetSha256,
        sizeBytes: releaseAssetSize,
      },
    },
    signatures: manifestSignatures,
  };

  const manifestPayload = {
    schemaVersion: manifestDoc.schemaVersion,
    metadataVersion: manifestDoc.metadataVersion,
    expiresAt: manifestDoc.expiresAt,
    version: manifestDoc.version,
    releaseDate: manifestDoc.releaseDate,
    releaseIdentity: manifestDoc.releaseIdentity,
    packages: manifestDoc.packages,
    runtimes: manifestDoc.runtimes,
    assets: manifestDoc.assets,
  };
  const manifestSig = sign(manifestPayload, privateKey);
  manifestDoc.signatures = [
    {
      keyId,
      algorithm: "Ed25519",
      publicKeyHex,
      signatureHex: manifestSig,
    },
  ];

  const manifestBytes = Buffer.from(JSON.stringify(manifestDoc, null, 2), "utf8");
  const manifestDigest = sha256Hex(manifestBytes);

  const nowIso = new Date().toISOString();
  const channelSignatures: ReleaseSignatureItem[] = [];
  const channelDoc = {
    schemaVersion: "2.0.0",
    metadataVersion: 1,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    minSupportedVersion: "0.1.0",
    currentVersion: version,
    updatedAt: nowIso,
    channels: {
      stable: {
        version,
        releaseDate: nowIso,
        manifestUrl: `/releases/v${version}/manifest.json`,
        manifestDigest,
        isLatest: true,
      },
    },
    signatures: channelSignatures,
  };

  const channelPayload = {
    schemaVersion: channelDoc.schemaVersion,
    metadataVersion: channelDoc.metadataVersion,
    expiresAt: channelDoc.expiresAt,
    minSupportedVersion: channelDoc.minSupportedVersion,
    currentVersion: channelDoc.currentVersion,
    updatedAt: channelDoc.updatedAt,
    channels: channelDoc.channels,
  };
  const channelSig = sign(channelPayload, privateKey);
  channelDoc.signatures = [
    {
      keyId,
      algorithm: "Ed25519",
      publicKeyHex,
      signatureHex: channelSig,
    },
  ];

  const channelBytes = Buffer.from(JSON.stringify(channelDoc, null, 2), "utf8");

  return {
    manifestBytes,
    manifestDigest,
    channelBytes,
    denoBytes: activeDenoBytes,
    manifestPath: `/releases/v${version}/manifest.json`,
    tarballPath: `/releases/v${version}/resin-linux-x64.tar.gz`,
    denoPath: `/releases/v${version}/deno-linux-x64.zip`,
  };
}

const testHomes: string[] = [];
afterEach(() => {
  for (const home of testHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const defaultTestPlatform: PlatformInfo = {
  os: "linux",
  platform: "linux",
  arch: "x64",
  isSupported: true,
  isWsl: false,
  nodeVersion: process.version,
};

describe("bootstrap-entry", () => {
  it("rejects unsupported platforms before any downloads or mutations occur", async () => {
    const unsupportedPlatform: PlatformInfo = {
      os: "linux",
      platform: "linux",
      arch: "s390x",
      isSupported: false,
      isWsl: false,
      nodeVersion: process.version,
      rejectionReason: "Unsupported architecture s390x",
    };

    await expect(
      bootstrapInstall({
        platform: unsupportedPlatform,
        allowOverrides: true,
        trustedReleaseKeys: [{ keyId: "test", publicKeyHex: "00".repeat(32) }],
      }),
    ).rejects.toThrow(UnsupportedPlatformError);
  });

  it("prohibits ambient environment variables from overriding trust root or channel origin", async () => {
    const origKeys = process.env.RESIN_TRUSTED_RELEASE_PUBLIC_KEYS;
    const origOverride = process.env.RESIN_INSTALL_ALLOW_OVERRIDE;
    const origTestOnly = process.env.RESIN_INSTALL_TEST_ONLY;
    const origChannelUrl = process.env.RESIN_RELEASE_CHANNEL_URL;

    try {
      process.env.RESIN_TRUSTED_RELEASE_PUBLIC_KEYS = JSON.stringify([
        { keyId: "attacker-key", publicKeyHex: "aa".repeat(32) },
      ]);
      process.env.RESIN_INSTALL_ALLOW_OVERRIDE = "1";
      process.env.RESIN_INSTALL_TEST_ONLY = "1";
      process.env.RESIN_RELEASE_CHANNEL_URL = "http://evil.example.com/channels.json";

      // Ambient env should NOT override bundled production keys
      const keys = resolveTrustedReleaseKeys({});
      expect(keys.length).toBe(1);
      expect(keys[0].keyId).toBe("resin-release-2026a");
      expect(keys[0].publicKeyHex).toBe(
        "f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851",
      );

      // Custom trusted release keys passed in options without programmatic override flag are rejected
      expect(() =>
        resolveTrustedReleaseKeys({
          trustedReleaseKeys: [{ keyId: "custom", publicKeyHex: "bb".repeat(32) }],
        }),
      ).toThrow(/Custom trusted release keys require explicit programmatic override opt-in/);

      // Custom channel URL without programmatic override flag is rejected
      expect(() =>
        validateChannelUrl("https://evil.example.com/channels.json", false, false),
      ).toThrow(/Custom release channel URL .* requires explicit override opt-in/);
    } finally {
      if (origKeys !== undefined) process.env.RESIN_TRUSTED_RELEASE_PUBLIC_KEYS = origKeys;
      else delete process.env.RESIN_TRUSTED_RELEASE_PUBLIC_KEYS;

      if (origOverride !== undefined) process.env.RESIN_INSTALL_ALLOW_OVERRIDE = origOverride;
      else delete process.env.RESIN_INSTALL_ALLOW_OVERRIDE;

      if (origTestOnly !== undefined) process.env.RESIN_INSTALL_TEST_ONLY = origTestOnly;
      else delete process.env.RESIN_INSTALL_TEST_ONLY;

      if (origChannelUrl !== undefined) process.env.RESIN_RELEASE_CHANNEL_URL = origChannelUrl;
      else delete process.env.RESIN_RELEASE_CHANNEL_URL;
    }
  });

  it("correctly identifies entrypoint with spaces, URL-escaped characters, and unicode paths using pathToFileURL", () => {
    // Standard path
    const p1 = "/tmp/test/bootstrap-entry.ts";
    const u1 = pathToFileURL(path.resolve(p1)).href;
    expect(isMainModule(u1, p1)).toBe(true);

    // Path with spaces
    const p2 = "/tmp/path with spaces/bootstrap-entry.ts";
    const u2 = pathToFileURL(path.resolve(p2)).href;
    expect(isMainModule(u2, p2)).toBe(true);

    // Path with special URL characters like # and %
    const p3 = "/tmp/path#special%20dir/bootstrap-entry.ts";
    const u3 = pathToFileURL(path.resolve(p3)).href;
    expect(isMainModule(u3, p3)).toBe(true);

    // Path with unicode emojis
    const p4 = "/tmp/✨resin/bootstrap-entry.ts";
    const u4 = pathToFileURL(path.resolve(p4)).href;
    expect(isMainModule(u4, p4)).toBe(true);

    // Non-matching path returns false
    expect(isMainModule(u1, "/tmp/other/script.ts")).toBe(false);
  });

  it("performs end-to-end verified bootstrap installation against local signed server", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bootstrap-home-"));
    testHomes.push(home);

    const releaseBytes = tarGz();
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const keyId = "test-bootstrap-signer";
    const trustedKey = { keyId, publicKeyHex };

    const fixtures = createSignedReleaseFixtures({
      version: "1.0.0",
      keyId,
      publicKeyHex,
      privateKey,
      releaseBytes,
    });

    let checkedCliPath: string | undefined;

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.channelBytes);
        return;
      }
      if (req.url === fixtures.manifestPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.manifestBytes);
        return;
      }
      if (req.url === fixtures.tarballPath) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(releaseBytes);
        return;
      }
      if (req.url === fixtures.denoPath) {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fixtures.denoBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let resolveListen: (port: number) => void;
    const listenPromise = new Promise<number>((resolve) => {
      resolveListen = resolve;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveListen(addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0);
    });
    const port = await listenPromise;

    try {
      const channelUrl = `http://127.0.0.1:${port}/channels.json`;

      const result = await bootstrapInstall({
        channelUrl,
        allowInsecureHttpForTests: true,
        allowOverrides: true,
        trustedReleaseKeys: [trustedKey],
        resinHome: home,
        platform: defaultTestPlatform,
        healthCheckRunner: async (cliPath) => {
          checkedCliPath = cliPath;
          return {
            passed: true,
            exitCode: 0,
            stdout: "resin 1.0.0",
          };
        },
      });

      expect(result.success).toBe(true);
      expect(result.version).toBe("1.0.0");
      expect(result.previousVersion).toBe(null);
      expect(result.healthCheck.passed).toBe(true);

      // Verify health check targeted public bin path
      expect(checkedCliPath).toBe(path.join(home, "bin", "resin"));

      // Verify active version
      expect(getActiveVersion(home)).toBe("1.0.0");

      // Verify installed files exist
      const activeCli = path.join(home, "versions", "v1.0.0", "bin", "resin");
      expect(fs.existsSync(activeCli)).toBe(true);
    } finally {
      let resolveClose: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      server.close(() => resolveClose());
      await closePromise;
    }
  });

  it("fails and aborts installation when release asset digest or size mismatch occurs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bootstrap-corrupt-"));
    testHomes.push(home);

    const corruptBytes = tarGz({ "bin/resin": "corrupted payload" });
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const keyId = "test-bootstrap-signer";
    const trustedKey = { keyId, publicKeyHex };

    const fixtures = createSignedReleaseFixtures({
      version: "1.0.0",
      keyId,
      publicKeyHex,
      privateKey,
      releaseBytes: corruptBytes,
      corruptManifestAssetSha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    });

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.channelBytes);
        return;
      }
      if (req.url === fixtures.manifestPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.manifestBytes);
        return;
      }
      if (req.url === fixtures.tarballPath) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(corruptBytes);
        return;
      }
      if (req.url === fixtures.denoPath) {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fixtures.denoBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let resolveListen: (port: number) => void;
    const listenPromise = new Promise<number>((resolve) => {
      resolveListen = resolve;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveListen(addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0);
    });
    const port = await listenPromise;

    try {
      const channelUrl = `http://127.0.0.1:${port}/channels.json`;

      await expect(
        bootstrapInstall({
          channelUrl,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
        }),
      ).rejects.toThrow(/Cryptographic digest mismatch/);

      // Verify no active version was established
      expect(getActiveVersion(home)).toBe(null);
    } finally {
      let resolveClose: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      server.close(() => resolveClose());
      await closePromise;
    }
  });

  it("rolls back to previous active version when health check times out, throws, or exceeds output cap", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bootstrap-health-fail-"));
    testHomes.push(home);

    // Seed previous v1.0.0 installation
    const versionsDir = path.join(home, "versions");
    const v1Dir = path.join(versionsDir, "v1.0.0");
    fs.mkdirSync(path.join(v1Dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(v1Dir, "bin", "resin"), "#!/bin/sh\necho 1.0.0\n", {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(v1Dir, "bin", "resin-daemon"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(v1Dir, "bin", "resin-mcp"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(v1Dir, "version.json"),
      JSON.stringify({ version: "1.0.0", installedAt: new Date().toISOString() }),
      "utf8",
    );
    fs.symlinkSync(v1Dir, path.join(home, "current"));
    fs.writeFileSync(
      path.join(home, "version-state.json"),
      JSON.stringify({ activeVersion: "1.0.0", previousVersion: null }),
      "utf8",
    );
    const releaseBytes = tarGz({
      "bin/resin": "#!/bin/sh\necho 1.1.0\n",
      "bin/resin-daemon": "#!/bin/sh\nexit 0\n",
      "bin/resin-mcp": "#!/bin/sh\nexit 0\n",
    });

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const keyId = "test-bootstrap-signer";
    const trustedKey = { keyId, publicKeyHex };

    const fixtures = createSignedReleaseFixtures({
      version: "1.1.0",
      keyId,
      publicKeyHex,
      privateKey,
      releaseBytes,
    });

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.channelBytes);
        return;
      }
      if (req.url === fixtures.manifestPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.manifestBytes);
        return;
      }
      if (req.url === fixtures.tarballPath) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(releaseBytes);
        return;
      }
      if (req.url === fixtures.denoPath) {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fixtures.denoBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let resolveListen: (port: number) => void;
    const listenPromise = new Promise<number>((resolve) => {
      resolveListen = resolve;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveListen(addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0);
    });
    const port = await listenPromise;

    try {
      const channelUrl = `http://127.0.0.1:${port}/channels.json`;

      // 1. Health check failure (exitCode !== 0)
      await expect(
        bootstrapInstall({
          channelUrl,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({
            passed: false,
            exitCode: 1,
            stderr: "Segmentation fault during initialization",
          }),
        }),
      ).rejects.toThrow(/Installation health check failed/);
      expect(getActiveVersion(home)).toBe("1.0.0");

      // 2. Health check exception / throw
      await expect(
        bootstrapInstall({
          channelUrl,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => {
            throw new Error("Process killed by OS");
          },
        }),
      ).rejects.toThrow(/Health check threw exception: Process killed by OS/);
      expect(getActiveVersion(home)).toBe("1.0.0");

      // 3. Health check timeout
      await expect(
        bootstrapInstall({
          channelUrl,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({
            passed: false,
            exitCode: 1,
            timedOut: true,
            stderr: "Health check timed out after 15000ms",
          }),
        }),
      ).rejects.toThrow(/health check timed out/);
      expect(getActiveVersion(home)).toBe("1.0.0");

      // 4. Health check output overflow
      await expect(
        bootstrapInstall({
          channelUrl,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({
            passed: false,
            exitCode: 1,
            outputOverflow: true,
            stderr: "Health check output exceeded maximum size",
          }),
        }),
      ).rejects.toThrow(/health check output overflowed/);
      expect(getActiveVersion(home)).toBe("1.0.0");
    } finally {
      let resolveClose: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      server.close(() => resolveClose());
      await closePromise;
    }
  });

  it("honestly handles fresh installation rollback without previous version", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bootstrap-fresh-fail-"));
    testHomes.push(home);

    const releaseBytes = tarGz();
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const keyId = "test-bootstrap-signer";
    const trustedKey = { keyId, publicKeyHex };

    const fixtures = createSignedReleaseFixtures({
      version: "1.0.0",
      keyId,
      publicKeyHex,
      privateKey,
      releaseBytes,
    });

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.channelBytes);
        return;
      }
      if (req.url === fixtures.manifestPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.manifestBytes);
        return;
      }
      if (req.url === fixtures.tarballPath) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(releaseBytes);
        return;
      }
      if (req.url === fixtures.denoPath) {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fixtures.denoBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let resolveListen: (port: number) => void;
    const listenPromise = new Promise<number>((resolve) => {
      resolveListen = resolve;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveListen(addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0);
    });
    const port = await listenPromise;

    try {
      const channelUrl = `http://127.0.0.1:${port}/channels.json`;

      await expect(
        bootstrapInstall({
          channelUrl,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({
            passed: false,
            exitCode: 1,
            stderr: "Binary failed to execute",
          }),
        }),
      ).rejects.toThrow(/Active version rolled back to none/);

      // Active state was cleaned up
      expect(getActiveVersion(home)).toBe(null);
    } finally {
      let resolveClose: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      server.close(() => resolveClose());
      await closePromise;
    }
  });

  it("handles defaultHealthCheckRunner execution, timeout, and output capping", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-healthcheck-test-"));
    testHomes.push(tmpDir);

    // 1. Successful execution
    const okScript = path.join(tmpDir, "resin-ok.sh");
    fs.writeFileSync(okScript, "#!/bin/sh\necho resin 1.0.0\nexit 0\n", { mode: 0o755 });
    const okResult = await defaultHealthCheckRunner(okScript, []);
    expect(okResult.passed).toBe(true);
    expect(okResult.exitCode).toBe(0);
    expect(okResult.stdout).toBe("resin 1.0.0");

    // 2. Failing execution
    const failScript = path.join(tmpDir, "resin-fail.sh");
    fs.writeFileSync(failScript, "#!/bin/sh\necho crash >&2\nexit 2\n", { mode: 0o755 });
    const failResult = await defaultHealthCheckRunner(failScript, []);
    expect(failResult.passed).toBe(false);
    expect(failResult.exitCode).toBe(2);
    expect(failResult.stderr).toBe("crash");

    // 3. Non-existent script
    const missingResult = await defaultHealthCheckRunner(path.join(tmpDir, "nonexistent"));
    expect(missingResult.passed).toBe(false);
    expect(missingResult.exitCode).toBe(1);

    // 4. Output overflow capping
    const overflowScript = path.join(tmpDir, "resin-overflow.sh");
    fs.writeFileSync(overflowScript, "#!/bin/sh\nhead -c 2000 /dev/zero | tr '\\0' 'A'\nexit 0\n", {
      mode: 0o755,
    });
    const overflowResult = await defaultHealthCheckRunner(overflowScript, [], {
      maxOutputBytes: 100,
    });
    expect(overflowResult.passed).toBe(false);
    expect(overflowResult.outputOverflow).toBe(true);

    // 5. Execution timeout
    const hangScript = path.join(tmpDir, "resin-hang.sh");
    fs.writeFileSync(hangScript, "#!/bin/sh\nsleep 10\nexit 0\n", { mode: 0o755 });
    const timeoutResult = await defaultHealthCheckRunner(hangScript, [], {
      timeoutMs: 100,
    });
    expect(timeoutResult.passed).toBe(false);
    expect(timeoutResult.timedOut).toBe(true);
  });

  it("normalizes bootstrap release modes across umasks and reuses the installation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bootstrap-idempotent-"));
    testHomes.push(home);
    fs.chmodSync(home, 0o700);

    const configDir = path.join(home, "config");
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
    const privateConfigPath = path.join(configDir, "user.json");
    const privateConfigContents = JSON.stringify({ private: true });
    fs.writeFileSync(privateConfigPath, privateConfigContents, { mode: 0o600 });
    fs.chmodSync(privateConfigPath, 0o600);

    const releaseBytes = tarGz({
      "bin/resin": {
        content: "#!/bin/sh\necho resin 1.0.0\n",
        mode: 0o600,
      },
      "bin/resin-daemon": {
        content: "#!/bin/sh\nexit 0\n",
        mode: 0o600,
      },
      "bin/resin-mcp": {
        content: "#!/bin/sh\nexit 0\n",
        mode: 0o600,
      },
      "bin/release-notes.txt": {
        content: "not an executable\n",
        mode: 0o600,
      },
      LICENSE: {
        content: "release license\n",
        mode: 0o600,
      },
      "share/docs/guide.txt": {
        content: "release guide\n",
        mode: 0o600,
      },
      "scripts/archive-tool": {
        content: "#!/bin/sh\nexit 0\n",
        mode: 0o700,
      },
    });
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");

    const keyId = "test-bootstrap-signer";
    const trustedKey = { keyId, publicKeyHex };

    const fixtures = createSignedReleaseFixtures({
      version: "1.0.0",
      keyId,
      publicKeyHex,
      privateKey,
      releaseBytes,
    });

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.channelBytes);
        return;
      }
      if (req.url === fixtures.manifestPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fixtures.manifestBytes);
        return;
      }
      if (req.url === fixtures.tarballPath) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(releaseBytes);
        return;
      }
      if (req.url === fixtures.denoPath) {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fixtures.denoBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let resolveListen: (port: number) => void;
    const listenPromise = new Promise<number>((resolve) => {
      resolveListen = resolve;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveListen(addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0);
    });
    const port = await listenPromise;
    const originalUmask = process.platform === "win32" ? undefined : process.umask();

    try {
      const channelUrl = `http://127.0.0.1:${port}/channels.json`;
      if (originalUmask !== undefined) {
        process.umask(0o077);
      }

      const firstRun = await bootstrapInstall({
        channelUrl,
        allowInsecureHttpForTests: true,
        allowOverrides: true,
        trustedReleaseKeys: [trustedKey],
        resinHome: home,
        platform: defaultTestPlatform,
        healthCheckRunner: async () => ({ passed: true, exitCode: 0 }),
      });

      expect(firstRun.success).toBe(true);
      const versionMetadataBefore = fs.readFileSync(
        path.join(firstRun.activePath, "version.json"),
        "utf8",
      );

      if (originalUmask !== undefined) {
        expect(fs.statSync(path.join(home, "versions")).mode & 0o7777).toBe(0o755);
        expect(fs.statSync(firstRun.activePath).mode & 0o7777).toBe(0o755);
        expect(fs.statSync(path.join(firstRun.activePath, "share")).mode & 0o7777).toBe(0o755);
        expect(fs.statSync(path.join(firstRun.activePath, "share", "docs")).mode & 0o7777).toBe(
          0o755,
        );
        expect(fs.statSync(path.join(firstRun.activePath, "LICENSE")).mode & 0o7777).toBe(0o644);
        expect(
          fs.statSync(path.join(firstRun.activePath, "share", "docs", "guide.txt")).mode & 0o7777,
        ).toBe(0o644);
        expect(
          fs.statSync(path.join(firstRun.activePath, "bin", "release-notes.txt")).mode & 0o7777,
        ).toBe(0o644);
        expect(fs.statSync(path.join(firstRun.activePath, "bin", "resin")).mode & 0o7777).toBe(
          0o755,
        );
        expect(
          fs.statSync(path.join(firstRun.activePath, "bin", "resin-daemon")).mode & 0o7777,
        ).toBe(0o755);
        expect(fs.statSync(path.join(firstRun.activePath, "bin", "resin-mcp")).mode & 0o7777).toBe(
          0o755,
        );
        expect(
          fs.statSync(path.join(firstRun.activePath, "scripts", "archive-tool")).mode & 0o7777,
        ).toBe(0o755);
        expect(fs.statSync(path.join(firstRun.activePath, "deno", "deno")).mode & 0o7777).toBe(
          0o755,
        );

        process.umask(0o022);
      }

      const secondRun = await bootstrapInstall({
        channelUrl,
        allowInsecureHttpForTests: true,
        allowOverrides: true,
        trustedReleaseKeys: [trustedKey],
        resinHome: home,
        platform: defaultTestPlatform,
        healthCheckRunner: async () => ({ passed: true, exitCode: 0 }),
      });

      expect(secondRun.success).toBe(true);
      expect(secondRun.activePath).toBe(firstRun.activePath);
      expect(getActiveVersion(home)).toBe("1.0.0");
      expect(fs.readFileSync(path.join(secondRun.activePath, "version.json"), "utf8")).toBe(
        versionMetadataBefore,
      );
      expect(fs.readFileSync(privateConfigPath, "utf8")).toBe(privateConfigContents);

      if (originalUmask !== undefined) {
        expect(fs.statSync(home).mode & 0o7777).toBe(0o700);
        expect(fs.statSync(configDir).mode & 0o7777).toBe(0o700);
        expect(fs.statSync(privateConfigPath).mode & 0o7777).toBe(0o600);
      }
    } finally {
      if (originalUmask !== undefined) {
        process.umask(originalUmask);
      }
      let resolveClose: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      server.close(() => resolveClose());
      await closePromise;
    }
  });

  it("enforces key revocation and channel override restrictions", () => {
    // Revoked key rejection
    expect(() =>
      resolveTrustedReleaseKeys({
        allowOverrides: true,
        trustedReleaseKeys: [{ keyId: "resin-release-v1", publicKeyHex: "00".repeat(32) }],
      }),
    ).toThrow(/is revoked/);

    // Custom trusted keys without override opt-in rejected
    expect(() =>
      resolveTrustedReleaseKeys({
        trustedReleaseKeys: [{ keyId: "custom-key", publicKeyHex: "00".repeat(32) }],
      }),
    ).toThrow(/Custom trusted release keys require explicit programmatic override opt-in/);

    // Channel URL validation: non-loopback HTTP rejected
    expect(() =>
      validateChannelUrl("http://dist.resin.sh/releases/v1/channels.json", true, true),
    ).toThrow(/Insecure HTTP channel URL .* is prohibited/);

    // Loopback HTTP rejected without allowInsecureHttpForTests
    expect(() => validateChannelUrl("http://127.0.0.1:8080/channels.json", false, true)).toThrow(
      /Insecure HTTP channel URL .* is prohibited/,
    );

    // Loopback HTTP allowed with allowInsecureHttpForTests and override allowed
    expect(validateChannelUrl("http://127.0.0.1:8080/channels.json", true, true)).toBe(
      "http://127.0.0.1:8080/channels.json",
    );

    // Custom URL without override opt-in rejected
    expect(() => validateChannelUrl("https://example.com/channels.json", false, false)).toThrow(
      /Custom release channel URL .* requires explicit override opt-in/,
    );

    // Default URL valid without explicit override opt-in
    expect(
      validateChannelUrl("https://dist.resin.sh/releases/v1/channels.json", false, false),
    ).toBe("https://dist.resin.sh/releases/v1/channels.json");
  });

  it("fails CLI invocation on unknown flags or missing argument values", async () => {
    await expect(runCli(["--unknown-flag"])).rejects.toThrow(/Unknown argument: --unknown-flag/);
    await expect(runCli(["--channel"])).rejects.toThrow(/Missing value for argument: --channel/);
    await expect(runCli(["--channel-url"])).rejects.toThrow(
      /Missing value for argument: --channel-url/,
    );
    await expect(runCli(["--resin-home"])).rejects.toThrow(
      /Missing value for argument: --resin-home/,
    );
  });

  it("exposes the production trust root record matching specification", () => {
    expect(PRODUCTION_RELEASE_TRUST_RECORD.schemaVersion).toBe("2.0.0");
    expect(PRODUCTION_RELEASE_TRUST_RECORD.trustDomain).toBe("production");
    const key = PRODUCTION_RELEASE_TRUST_RECORD.trustedKeys[0];
    expect(key.keyId).toBe("resin-release-2026a");
    expect(key.publicKeyHex).toBe(
      "f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851",
    );
    expect(key.publicKeyFingerprintSha256).toBe(
      "a702d0d424e5797ecb672afabd275548c1ef6e1e95d1ea9651916e147e784359",
    );
  });

  describe("automatic onboarding & device linking", () => {
    it("detects skip reasons under non-interactive, CI, or override conditions", async () => {
      const home = path.join(
        os.tmpdir(),
        `resin-onboard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      testHomes.push(home);

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          skipOnboarding: true,
        }),
      ).toBe("Explicitly skipped via skipOnboarding option");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          autoOnboard: false,
        }),
      ).toBe("Explicitly disabled via autoOnboard option");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          localOnly: true,
          env: {},
          isRoot: false,
        }),
      ).toBe(null);

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          env: { CI: "true" },
        }),
      ).toBe("CI environment detected");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          env: { CONTINUOUS_INTEGRATION: "1" },
        }),
      ).toBe("CI environment detected");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          env: { RESIN_NO_ONBOARD: "1" },
        }),
      ).toBe("Disabled via RESIN_NO_ONBOARD environment variable");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          env: { RESIN_SKIP_ONBOARDING: "1" },
        }),
      ).toBe("Disabled via RESIN_SKIP_ONBOARDING environment variable");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          env: { DEBIAN_FRONTEND: "noninteractive" },
        }),
      ).toBe("Non-interactive environment detected");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          isInteractive: false,
        }),
      ).toBe("Explicitly marked non-interactive");

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          isInteractive: true,
          env: {},
          isRoot: false,
        }),
      ).toBe(null);

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          autoOnboard: true,
          isInteractive: true,
          env: {},
          isRoot: false,
        }),
      ).toBe(null);

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          autoOnboard: true,
          env: { CI: "true" },
          isRoot: false,
        }),
      ).toBe("CI environment detected");
    });

    it("recognizes existing state but still permits an idempotent onboarding rerun", async () => {
      const home = path.join(
        os.tmpdir(),
        `resin-init-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      testHomes.push(home);
      fs.mkdirSync(home, { recursive: true });

      expect(await isAlreadyInitialized(home)).toBe(false);

      const stateDir = path.join(home, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "device-token.json"),
        JSON.stringify({ token: "test" }),
        "utf8",
      );

      expect(await isAlreadyInitialized(home)).toBe(true);

      expect(
        await detectOnboardingSkipReason({
          resinHome: home,
          autoOnboard: true,
          isInteractive: true,
          env: {},
          isRoot: false,
        }),
      ).toBe(null);
    });

    it("detects existing install journal as initialized", async () => {
      const home = path.join(
        os.tmpdir(),
        `resin-journal-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      testHomes.push(home);
      const stateDir = path.join(home, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "install-journal.json"),
        JSON.stringify({ completed: true }),
        "utf8",
      );

      expect(await isAlreadyInitialized(home)).toBe(true);
    });

    it("defaultOnboardingRunner fails cleanly if binary does not exist", async () => {
      const result = await defaultOnboardingRunner("/non/existent/path/to/resin", ["init"]);
      expect(result.attempted).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toMatch(/Failed to spawn onboarding process/);
    });

    it("streams the browser URL and device code during headless continuation", async () => {
      const streamed: string[] = [];
      const result = await defaultOnboardingRunner(
        process.execPath,
        [
          "-e",
          'process.stdout.write("Navigate to: https://resin.sh/device?user_code=ABCD-1234\\nEnter code: ABCD-1234\\n");',
        ],
        {
          interactive: false,
          timeoutMs: 1_000,
          logger: (message) => streamed.push(message),
        },
      );

      expect(result.success).toBe(true);
      expect(streamed.join("\n")).toContain("https://resin.sh/device?user_code=ABCD-1234");
      expect(streamed.join("\n")).toContain("ABCD-1234");
    });

    it("terminates and reports a timed-out onboarding child", async () => {
      const result = await defaultOnboardingRunner(
        process.execPath,
        ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)"],
        { interactive: false, timeoutMs: 25 },
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(124);
      expect(result.error).toContain("timed out");
    });

    it("executes auto-onboarding when interactive and uninitialized on fresh install", async () => {
      const home = path.join(
        os.tmpdir(),
        `resin-auto-onboard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      testHomes.push(home);

      const releaseBytes = tarGz({
        "bin/resin": "#!/bin/sh\necho resin-binary\n",
        "package.json": JSON.stringify({ name: "resin", version: "1.0.0" }),
      });

      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyHex = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(12)
        .toString("hex");

      const keyId = "test-onboard-signer";
      const trustedKey = { keyId, publicKeyHex };

      const fixtures = createSignedReleaseFixtures({
        version: "1.0.0",
        keyId,
        publicKeyHex,
        privateKey,
        releaseBytes,
      });

      let serverPort = 0;
      const server = http.createServer((req, res) => {
        if (req.url === "/channels.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.channelBytes);
          return;
        }
        if (req.url === fixtures.manifestPath) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.manifestBytes);
          return;
        }
        if (req.url === fixtures.tarballPath) {
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(releaseBytes);
          return;
        }
        if (req.url === fixtures.denoPath) {
          res.writeHead(200, { "content-type": "application/zip" });
          res.end(fixtures.denoBytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          serverPort = addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0;
          resolve();
        });
      });

      try {
        let onboardingInvoked = false;
        let invokedCliPath = "";
        let invokedArgs: string[] = [];

        const result = await bootstrapInstall({
          channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({ passed: true, exitCode: 0, stdout: "1.0.0" }),
          autoOnboard: true,
          isInteractive: true,
          env: { RESIN_ALLOW_ROOT: "1" },
          onboardingRunner: async (cliPath, args) => {
            onboardingInvoked = true;
            invokedCliPath = cliPath;
            invokedArgs = args ?? [];
            return {
              attempted: true,
              skipped: false,
              success: true,
              exitCode: 0,
            };
          },
        });

        expect(result.success).toBe(true);
        expect(onboardingInvoked).toBe(true);
        expect(invokedCliPath).toBe(path.join(home, "bin", "resin"));
        expect(invokedArgs).toEqual(["init", "--auto-approve"]);
        expect(result.onboarding?.attempted).toBe(true);
        expect(result.onboarding?.success).toBe(true);
      } finally {
        server.close();
      }
    });

    it("fails the install and rolls back activation when onboarding is cancelled", async () => {
      const home = path.join(
        os.tmpdir(),
        `resin-onboard-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      testHomes.push(home);

      const releaseBytes = tarGz({
        "bin/resin": "#!/bin/sh\necho resin-binary\n",
      });

      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyHex = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(12)
        .toString("hex");

      const keyId = "test-onboard-fail-signer";
      const trustedKey = { keyId, publicKeyHex };

      const fixtures = createSignedReleaseFixtures({
        version: "1.0.0",
        keyId,
        publicKeyHex,
        privateKey,
        releaseBytes,
      });

      let serverPort = 0;
      const server = http.createServer((req, res) => {
        if (req.url === "/channels.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.channelBytes);
          return;
        }
        if (req.url === fixtures.manifestPath) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.manifestBytes);
          return;
        }
        if (req.url === fixtures.tarballPath) {
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(releaseBytes);
          return;
        }
        if (req.url === fixtures.denoPath) {
          res.writeHead(200, { "content-type": "application/zip" });
          res.end(fixtures.denoBytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          serverPort = addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0;
          resolve();
        });
      });

      try {
        await expect(
          bootstrapInstall({
            channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
            allowInsecureHttpForTests: true,
            allowOverrides: true,
            trustedReleaseKeys: [trustedKey],
            resinHome: home,
            platform: defaultTestPlatform,
            healthCheckRunner: async () => ({
              passed: true,
              exitCode: 0,
              stdout: "1.0.0",
            }),
            autoOnboard: true,
            isInteractive: true,
            env: { RESIN_ALLOW_ROOT: "1" },
            onboardingRunner: async () => {
              throw new Error("Device linking browser closed by user");
            },
          }),
        ).rejects.toThrow(/Automatic onboarding failed.*no separate Resin command/i);
        expect(getActiveVersion(home)).toBeNull();
        expect(fs.existsSync(path.join(home, "bin", "resin"))).toBe(false);
      } finally {
        server.close();
      }
    });

    it("honors an explicit skip while local-only still completes local setup", async () => {
      const home = path.join(
        os.tmpdir(),
        `resin-skip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      testHomes.push(home);

      const releaseBytes = tarGz({
        "bin/resin": "#!/bin/sh\necho resin-binary\n",
      });

      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyHex = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(12)
        .toString("hex");

      const keyId = "test-skip-signer";
      const trustedKey = { keyId, publicKeyHex };

      const fixtures = createSignedReleaseFixtures({
        version: "1.0.0",
        keyId,
        publicKeyHex,
        privateKey,
        releaseBytes,
      });

      let serverPort = 0;
      const server = http.createServer((req, res) => {
        if (req.url === "/channels.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.channelBytes);
          return;
        }
        if (req.url === fixtures.manifestPath) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.manifestBytes);
          return;
        }
        if (req.url === fixtures.tarballPath) {
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(releaseBytes);
          return;
        }
        if (req.url === fixtures.denoPath) {
          res.writeHead(200, { "content-type": "application/zip" });
          res.end(fixtures.denoBytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          serverPort = addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0;
          resolve();
        });
      });

      try {
        let runnerCalled = false;
        const result = await bootstrapInstall({
          channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: home,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({ passed: true, exitCode: 0, stdout: "1.0.0" }),
          skipOnboarding: true,
          onboardingRunner: async () => {
            runnerCalled = true;
            return { attempted: true, skipped: false, success: true };
          },
        });

        expect(result.success).toBe(true);
        expect(runnerCalled).toBe(false);
        expect(result.onboarding?.attempted).toBe(false);
        expect(result.onboarding?.skipped).toBe(true);

        const localHome = `${home}-local`;
        testHomes.push(localHome);
        let localArgs: string[] = [];
        const localResult = await bootstrapInstall({
          channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome: localHome,
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({ passed: true, exitCode: 0, stdout: "1.0.0" }),
          localOnly: true,
          env: { RESIN_ALLOW_ROOT: "1" },
          onboardingRunner: async (_cliPath, args) => {
            localArgs = args ?? [];
            return { attempted: true, skipped: false, success: true };
          },
        });

        expect(localResult.success).toBe(true);
        expect(localArgs).toEqual(["init", "--auto-approve", "--local-only"]);
      } finally {
        server.close();
      }
    });
  });
  describe("shell PATH configuration & concise output", () => {
    it("resolves candidate profiles and defaults according to detected shell", () => {
      const zsh = resolveCandidateProfiles("zsh");
      expect(zsh.defaultProfile).toBe(".zshrc");
      expect(zsh.candidates).toContain(".zshrc");
      expect(zsh.candidates).toContain(".zprofile");

      const bash = resolveCandidateProfiles("bash");
      expect(bash.defaultProfile).toBe(".bashrc");
      expect(bash.candidates).toContain(".bashrc");
      expect(bash.candidates).toContain(".bash_profile");

      const generic = resolveCandidateProfiles("sh");
      expect(generic.defaultProfile).toBe(".profile");
      expect(generic.candidates).toContain(".profile");
    });

    it("creates ~/.zshrc on clean home for zsh shell and adds exactly one PATH line", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-test-"));
      testHomes.push(tmpHome);

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });

      expect(res.attempted).toBe(true);
      expect(res.updated).toBe(true);
      expect(res.alreadyConfigured).toBe(false);
      expect(res.profileName).toBe("~/.zshrc");
      expect(res.reloadCommand).toBe("source ~/.zshrc");

      const zshrcPath = path.join(tmpHome, ".zshrc");
      expect(fs.existsSync(zshrcPath)).toBe(true);
      const content = fs.readFileSync(zshrcPath, "utf8");
      expect(content).toBe('export PATH="$HOME/.resin/bin:$PATH"\n');
    });

    it("creates ~/.bashrc on clean home for bash shell", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-bash-"));
      testHomes.push(tmpHome);

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/bash",
        env: { HOME: tmpHome, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" },
      });

      expect(res.updated).toBe(true);
      expect(res.profileName).toBe("~/.bashrc");
      const bashrcPath = path.join(tmpHome, ".bashrc");
      expect(fs.existsSync(bashrcPath)).toBe(true);
      expect(fs.readFileSync(bashrcPath, "utf8")).toBe('export PATH="$HOME/.resin/bin:$PATH"\n');
    });

    it("creates ~/.profile on clean home for generic POSIX shell", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-sh-"));
      testHomes.push(tmpHome);

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/sh",
        env: { HOME: tmpHome, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
      });

      expect(res.updated).toBe(true);
      expect(res.profileName).toBe("~/.profile");
      const profilePath = path.join(tmpHome, ".profile");
      expect(fs.existsSync(profilePath)).toBe(true);
      expect(fs.readFileSync(profilePath, "utf8")).toBe('export PATH="$HOME/.resin/bin:$PATH"\n');
    });

    it("prefers existing ~/.bash_profile over creating a new ~/.bashrc when bash is detected", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-bashprof-"));
      testHomes.push(tmpHome);

      const bashProfilePath = path.join(tmpHome, ".bash_profile");
      fs.writeFileSync(
        bashProfilePath,
        "# Existing user configuration\nexport EDITOR=nano\n",
        "utf8",
      );

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/bash",
        env: { HOME: tmpHome, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" },
      });

      expect(res.updated).toBe(true);
      expect(res.profileName).toBe("~/.bash_profile");
      expect(fs.existsSync(path.join(tmpHome, ".bashrc"))).toBe(false);

      const content = fs.readFileSync(bashProfilePath, "utf8");
      expect(content).toContain("# Existing user configuration\nexport EDITOR=nano\n");
      expect(content).toContain('export PATH="$HOME/.resin/bin:$PATH"\n');
    });

    it("prefers existing ~/.zprofile over creating a new ~/.zshrc when zsh is detected", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-zprof-"));
      testHomes.push(tmpHome);

      const zprofilePath = path.join(tmpHome, ".zprofile");
      fs.writeFileSync(zprofilePath, "export FOO=bar\n", "utf8");

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });

      expect(res.updated).toBe(true);
      expect(res.profileName).toBe("~/.zprofile");
      expect(fs.existsSync(path.join(tmpHome, ".zshrc"))).toBe(false);
    });

    it("is strictly idempotent and does not duplicate PATH entry on repeat install", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-idempotent-"));
      testHomes.push(tmpHome);

      const resinHome = path.join(tmpHome, ".resin");
      const res1 = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(res1.updated).toBe(true);

      const zshrcPath = path.join(tmpHome, ".zshrc");
      const contentAfterRun1 = fs.readFileSync(zshrcPath, "utf8");

      // Run 2: repeat install
      const res2 = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(res2.updated).toBe(false);
      expect(res2.alreadyConfigured).toBe(true);

      const contentAfterRun2 = fs.readFileSync(zshrcPath, "utf8");
      expect(contentAfterRun2).toBe(contentAfterRun1);

      const matches = contentAfterRun2.match(/resin\/bin/g);
      expect(matches).toHaveLength(1);
    });

    it("leaves all profiles untouched if already configured in another profile candidate", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-existingprof-"));
      testHomes.push(tmpHome);

      const profilePath = path.join(tmpHome, ".profile");
      fs.writeFileSync(profilePath, 'export PATH="$HOME/.resin/bin:$PATH"\n', "utf8");

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });

      expect(res.updated).toBe(false);
      expect(res.alreadyConfigured).toBe(true);
      expect(res.profileName).toBe("~/.profile");
      expect(fs.existsSync(path.join(tmpHome, ".zshrc"))).toBe(false);
    });

    it("safely handles profile missing trailing newline without corrupting existing content", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-nonewline-"));
      testHomes.push(tmpHome);

      const zshrcPath = path.join(tmpHome, ".zshrc");
      fs.writeFileSync(zshrcPath, "alias ll='ls -la'", "utf8"); // Note: NO trailing newline

      const resinHome = path.join(tmpHome, ".resin");
      const res = await configureShellPath({
        resinHome,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });

      expect(res.updated).toBe(true);
      const content = fs.readFileSync(zshrcPath, "utf8");
      expect(content).toBe("alias ll='ls -la'\nexport PATH=\"$HOME/.resin/bin:$PATH\"\n");
    });

    it("formats PATH export correctly for custom resinHome locations", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-custom-"));
      testHomes.push(tmpHome);

      // Custom directory outside HOME
      const customOutside = path.join(os.tmpdir(), `custom-resin-${Date.now()}`);
      const resOutside = await configureShellPath({
        resinHome: customOutside,
        homeDir: tmpHome,
        shell: "/bin/zsh",
        env: { HOME: tmpHome, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(resOutside.updated).toBe(true);
      const content = fs.readFileSync(path.join(tmpHome, ".zshrc"), "utf8");
      expect(content).toContain(`export PATH="${path.join(customOutside, "bin")}:$PATH"\n`);
    });

    it("bypasses mutation on non-POSIX platforms", async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-path-nonposix-"));
      testHomes.push(tmpHome);

      const res = await configureShellPath({
        resinHome: path.join(tmpHome, ".resin"),
        homeDir: tmpHome,
        isPosix: false,
      });
      expect(res.attempted).toBe(false);
      expect(res.updated).toBe(false);
      expect(res.reason).toBe("non-posix");
      expect(fs.readdirSync(tmpHome)).toHaveLength(0);
    });

    it("executes concise bootstrap installation with shell PATH updates and reload guidance", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-e2e-path-home-"));
      testHomes.push(home);

      const releaseBytes = tarGz();
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyHex = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");

      const trustedKey = {
        keyId: "test-key-path",
        algorithm: "Ed25519",
        publicKeyHex,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      };

      const fixtures = createSignedReleaseFixtures({
        version: "1.0.0",
        keyId: "test-key-path",
        publicKeyHex,
        privateKey,
        releaseBytes,
      });

      const server = http.createServer((req, res) => {
        if (req.url === "/channels.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.channelBytes);
          return;
        }
        if (req.url === fixtures.manifestPath) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(fixtures.manifestBytes);
          return;
        }
        if (req.url === fixtures.tarballPath) {
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(releaseBytes);
          return;
        }
        if (req.url === fixtures.denoPath) {
          res.writeHead(200, { "content-type": "application/zip" });
          res.end(fixtures.denoBytes);
          return;
        }
        res.writeHead(404);
        res.end();
      });

      let resolveListen!: (port: number) => void;
      const listenPromise = new Promise<number>((resolve) => {
        resolveListen = resolve;
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolveListen(addr && !Array.isArray(addr) && "port" in addr ? addr.port : 0);
      });
      const serverPort = await listenPromise;

      try {
        const logs: string[] = [];
        const resinHome = path.join(home, ".resin");
        const result = await bootstrapInstall({
          channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome,
          customHome: home,
          shell: "/bin/zsh",
          env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", RESIN_ALLOW_ROOT: "1" },
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({ passed: true, exitCode: 0, stdout: "1.0.0" }),
          skipOnboarding: true,
          logger: (msg) => logs.push(msg),
        });

        expect(result.success).toBe(true);
        expect(result.pathConfig?.updated).toBe(true);
        expect(result.pathConfig?.profileName).toBe("~/.zshrc");

        const zshrcPath = path.join(home, ".zshrc");
        expect(fs.existsSync(zshrcPath)).toBe(true);
        expect(fs.readFileSync(zshrcPath, "utf8")).toBe('export PATH="$HOME/.resin/bin:$PATH"\n');

        const logOutput = logs.join("\n");
        // Concise default output checks
        expect(logOutput).toContain("✔ Verified Resin v1.0.0 for linux");
        expect(logOutput).toContain("✔ Installed Resin v1.0.0");
        expect(logOutput).toContain("✔ Added ~/.resin/bin to PATH in ~/.zshrc");
        expect(logOutput).toContain("source ~/.zshrc");
        expect(logOutput).toContain("resin");
        // Must NOT contain low-level debug steps in normal mode
        expect(logOutput).not.toContain("==> Resolving release metadata");
        expect(logOutput).not.toContain("==> Fetching release asset");
        expect(logOutput).not.toContain("==> Installing release");

        // Repeat install test on same directory
        const repeatLogs: string[] = [];
        const repeatResult = await bootstrapInstall({
          channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome,
          customHome: home,
          shell: "/bin/zsh",
          env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", RESIN_ALLOW_ROOT: "1" },
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({ passed: true, exitCode: 0, stdout: "1.0.0" }),
          skipOnboarding: true,
          logger: (msg) => repeatLogs.push(msg),
        });

        expect(repeatResult.success).toBe(true);
        expect(repeatResult.pathConfig?.updated).toBe(false);
        expect(repeatResult.pathConfig?.alreadyConfigured).toBe(true);
        expect(repeatLogs.join("\n")).toContain("Run 'resin' to get started.");

        // Exactly one occurrence in profile
        const zshrcFinal = fs.readFileSync(zshrcPath, "utf8");
        expect(zshrcFinal.match(/resin\/bin/g)).toHaveLength(1);

        // Verbose mode test
        const verboseLogs: string[] = [];
        await bootstrapInstall({
          channelUrl: `http://127.0.0.1:${serverPort}/channels.json`,
          allowInsecureHttpForTests: true,
          allowOverrides: true,
          trustedReleaseKeys: [trustedKey],
          resinHome,
          customHome: home,
          shell: "/bin/zsh",
          env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", RESIN_ALLOW_ROOT: "1" },
          platform: defaultTestPlatform,
          healthCheckRunner: async () => ({ passed: true, exitCode: 0, stdout: "1.0.0" }),
          skipOnboarding: true,
          verbose: true,
          logger: (msg) => verboseLogs.push(msg),
        });
        const verboseOutput = verboseLogs.join("\n");
        expect(verboseOutput).toContain("==> Resolving release metadata");
        expect(verboseOutput).toContain("==> Fetching release asset");
        expect(verboseOutput).toContain("==> Installing release");
      } finally {
        server.close();
      }
    });
  });
});
