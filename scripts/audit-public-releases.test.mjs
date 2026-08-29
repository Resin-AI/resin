import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUDIT_DATE,
  CANONICAL_PRIVATE_PACKAGES,
  CANONICAL_PUBLIC_RELEASE_PACKAGES,
  FORBIDDEN_PATH_SUBSTRINGS,
  auditArtifact,
  auditChannels,
  auditManifest,
  auditSbom,
  auditTarball,
  extractTarEntriesSafely,
  extractZipEntriesSafely,
  generateAuditJsonReport,
  generateAuditTextReport,
  inventoryDirectory,
  loadBoundaryConfig,
  scanContentForSecrets,
  sha256Hex,
} from "./audit-public-releases.mjs";

/**
 * Creates a synthetic in-memory ustar tarball buffer for testing.
 */
function createSyntheticTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const name = entry.name || entry.path;
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || "");
    const size = content.length;
    const isDir = entry.type === "dir" || name.endsWith("/");

    const header = Buffer.alloc(512, 0);
    header.write(name.slice(0, 100), 0, 100, "utf8");
    header.write(`${(isDir ? 0o755 : 0o644).toString(8).padStart(6, "0")} \0`, 100, 8, "ascii");
    header.write(`${(0).toString(8).padStart(6, "0")} \0`, 108, 8, "ascii");
    header.write(`${(0).toString(8).padStart(6, "0")} \0`, 116, 8, "ascii");
    header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
    header.write(`${(1786924800).toString(8).padStart(11, "0")} `, 136, 12, "ascii");
    header.write(isDir ? "5" : "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write("root", 265, 32, "ascii");
    header.write("root", 297, 32, "ascii");

    // Calculate checksum
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

    chunks.push(header);
    if (content.length > 0) {
      chunks.push(content);
      const remainder = content.length % 512;
      if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

/**
 * Creates a synthetic zip buffer with simple central directory for testing.
 */
function createSyntheticZip(files) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const dataBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || "");
    const crc = 0;

    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // compression (store)
    lfh.writeUInt16LE(0, 10); // time
    lfh.writeUInt16LE(0, 12); // date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBuf.length, 18); // comp size
    lfh.writeUInt32LE(dataBuf.length, 22); // uncomp size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localChunks.push(lfh, nameBuf, dataBuf);

    // Central directory header
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(dataBuf.length, 20);
    cdh.writeUInt32LE(dataBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);

    cdChunks.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + dataBuf.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of cdChunks) cdSize += c.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}

describe("audit-public-releases", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-audit-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Boundary & Config Loading", () => {
    it("loads canonical boundary config from resin-boundary.json if present", () => {
      const config = loadBoundaryConfig();
      expect(config.publicReleasePackages).toBeDefined();
      expect(config.publicReleasePackages).toContain("resin");
      expect(config.publicReleasePackages).toContain("@resin/gateway");
      expect(config.privatePackages).toContain("@resin/cloud");
      expect(config.cloudOnlyPaths).toContain("apps/cloud");
    });

    it("falls back cleanly when boundary config is absent", () => {
      const config = loadBoundaryConfig("/tmp/nonexistent-boundary-path");
      expect(config.publicReleasePackages).toEqual(CANONICAL_PUBLIC_RELEASE_PACKAGES);
      expect(config.privatePackages).toEqual(CANONICAL_PRIVATE_PACKAGES);
      expect(config.cloudOnlyPaths).toEqual(FORBIDDEN_PATH_SUBSTRINGS);
    });

    it("computes deterministic SHA-256 digests", () => {
      const digest = sha256Hex("hello resin audit");
      expect(digest).toHaveLength(64);
      expect(sha256Hex("hello resin audit")).toBe(digest);
    });
  });

  describe("Safe Archive Parsing", () => {
    it("extracts uncompressed tar entries safely in memory", () => {
      const tar = createSyntheticTar([
        { name: "resin/apps/cli/dist/index.js", content: "console.log('cli');" },
        { name: "resin/LICENSE", content: "Apache-2.0" },
      ]);
      const entries = extractTarEntriesSafely(tar);
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe("resin/apps/cli/dist/index.js");
      expect(entries[0].content.toString("utf8")).toBe("console.log('cli');");
      expect(entries[1].name).toBe("resin/LICENSE");
    });

    it("extracts gzip-compressed tar.gz entries safely", () => {
      const tar = createSyntheticTar([
        { name: "resin/apps/cli/dist/index.js", content: "console.log('cli');" },
      ]);
      const gzipped = zlib.gzipSync(tar);
      const entries = extractTarEntriesSafely(gzipped);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("resin/apps/cli/dist/index.js");
    });

    it("handles corrupted/truncated tar buffer gracefully without throwing", () => {
      const corrupted = Buffer.from("this is not a valid tar stream");
      const entries = extractTarEntriesSafely(corrupted);
      expect(Array.isArray(entries)).toBe(true);
    });

    it("extracts synthetic zip entries safely without executing code", () => {
      const zip = createSyntheticZip([{ name: "deno", content: "binary-executable-payload" }]);
      const entries = extractZipEntriesSafely(zip);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("deno");
      expect(entries[0].size).toBe(25);
    });
  });

  describe("Secret Scanning", () => {
    it("detects cleartext AWS access key in file content", () => {
      const content = "const awsKey = 'AKIAIOSFODNN7EXAMPLE';";
      const findings = scanContentForSecrets(content, "config.js");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].rule).toBe("AWS Access Key ID");
    });

    it("detects private key PEM header in file content", () => {
      const content =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
      const findings = scanContentForSecrets(content, "server.js");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].rule).toBe("Private Key Header");
    });

    it("ignores parser patterns in standard jose / AWS SDK node_modules", () => {
      const content = "const regex = /(?:AKIA)[A-Z0-9]{16}/;";
      const findings = scanContentForSecrets(
        content,
        "resin/node_modules/@aws-sdk/credential-provider/index.js",
      );
      expect(findings).toHaveLength(0);
    });
  });

  describe("Tarball Security & Boundary Audit", () => {
    it("approves a clean public release tarball with zero violations", () => {
      const cleanTar = createSyntheticTar([
        { name: "resin/adapters/omp/dist/index.js", content: "export const omp = true;" },
        { name: "resin/apps/cli/dist/index.js", content: "console.log('cli');" },
        { name: "resin/packages/protocol/dist/index.js", content: "export const proto = 1;" },
        { name: "resin/LICENSE", content: "Apache-2.0" },
      ]);
      const gzipped = zlib.gzipSync(cleanTar);
      const result = auditTarball(gzipped, "resin-v1.0.3-linux-x64.tar.gz");

      expect(result.isClean).toBe(true);
      expect(result.cloudFilesCount).toBe(0);
      expect(result.sourceMapsCount).toBe(0);
      expect(result.secretsCount).toBe(0);
      expect(result.totalEntries).toBe(4);
    });

    it("detects disclosed apps/cloud files in tainted tarball", () => {
      const taintedTar = createSyntheticTar([
        { name: "resin/apps/cli/dist/index.js", content: "console.log('cli');" },
        { name: "resin/apps/cloud/dist/orchestrator.js", content: "export class Orchestrator {}" },
        {
          name: "resin/apps/cloud/dist/analytics/anomaly.js",
          content: "export function detectAnomaly() {}",
        },
      ]);
      const gzipped = zlib.gzipSync(taintedTar);
      const result = auditTarball(gzipped, "resin-v1.0.3-linux-x64.tar.gz");

      expect(result.isClean).toBe(false);
      expect(result.cloudFilesCount).toBe(2);
      expect(result.cloudFilesSample).toContain("resin/apps/cloud/dist/orchestrator.js");
    });

    it("detects disclosed source maps in tainted tarball", () => {
      const taintedTar = createSyntheticTar([
        { name: "resin/apps/cli/dist/index.js", content: "console.log('cli');" },
        {
          name: "resin/apps/cli/dist/index.js.map",
          content: '{"version":3,"sources":["index.ts"]}',
        },
        { name: "resin/apps/cli/dist/index.d.ts.map", content: '{"version":3}' },
      ]);
      const gzipped = zlib.gzipSync(taintedTar);
      const result = auditTarball(gzipped, "resin-v1.0.3-linux-x64.tar.gz");

      expect(result.isClean).toBe(false);
      expect(result.sourceMapsCount).toBe(2);
      expect(result.sourceMapsSample).toContain("resin/apps/cli/dist/index.js.map");
    });

    it("detects test double / fixture entries in tarball", () => {
      const taintedTar = createSyntheticTar([
        { name: "resin/fixtures/test-fixtures/dist/index.js", content: "fixtures" },
        { name: "resin/packages/protocol/dist/message.test.js", content: "test" },
      ]);
      const gzipped = zlib.gzipSync(taintedTar);
      const result = auditTarball(gzipped, "resin-v1.0.3-linux-x64.tar.gz");

      expect(result.isClean).toBe(false);
      expect(result.fixtureFilesCount).toBe(1);
      expect(result.testDoubleFilesCount).toBe(1);
    });
  });

  describe("Manifest Security & Package Allowlist Audit", () => {
    it("approves a clean manifest containing only allowlisted public packages", () => {
      const cleanManifest = {
        schemaVersion: "2.0.0",
        version: "1.0.3",
        releaseDate: "2026-08-28T00:00:00Z",
        packages: {
          "@resin/contracts": { version: "0.1.0" },
          "@resin/runtime": { version: "0.1.0" },
          resin: { version: "0.1.0" },
        },
      };

      const result = auditManifest(cleanManifest, "manifest-1.0.3.json");
      expect(result.isClean).toBe(true);
      expect(result.privatePackagesFound).toHaveLength(0);
      expect(result.unallowlistedPackages).toHaveLength(0);
    });

    it("flags private and unallowlisted packages declared in release manifest", () => {
      const taintedManifest = {
        schemaVersion: "2.0.0",
        version: "1.0.3",
        packages: {
          "@resin/contracts": { version: "0.1.0" },
          "@resin/cloud": { version: "0.1.0" },
          "@resin/cloud-contracts": { version: "0.1.0" },
          "@resin/test-fixtures": { version: "0.1.0" },
        },
      };

      const result = auditManifest(taintedManifest, "manifest-1.0.3.json");
      expect(result.isClean).toBe(false);
      expect(result.privatePackagesFound).toContain("@resin/cloud");
      expect(result.privatePackagesFound).toContain("@resin/cloud-contracts");
      expect(result.unallowlistedPackages).toContain("@resin/test-fixtures");
    });
  });

  describe("CycloneDX SBOM Audit", () => {
    it("approves a clean SBOM with only public release components", () => {
      const cleanSbom = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          { name: "@resin/contracts", version: "0.1.0" },
          { name: "@resin/runtime", version: "0.1.0" },
          { name: "zod", version: "3.24.1" },
        ],
      };

      const result = auditSbom(cleanSbom, "sbom.json");
      expect(result.isClean).toBe(true);
      expect(result.privateComponentsFound).toHaveLength(0);
    });

    it("flags cloud packages and cloud dependencies in SBOM", () => {
      const taintedSbom = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          { name: "@resin/contracts", version: "0.1.0" },
          { name: "@resin/cloud", version: "0.1.0" },
          { name: "@aws-sdk/client-s3", version: "3.700.0" },
        ],
      };

      const result = auditSbom(taintedSbom, "sbom.json");
      expect(result.isClean).toBe(false);
      expect(result.privateComponentsFound).toContain("@resin/cloud");
      expect(result.cloudDependenciesCount).toBe(1);
    });
  });

  describe("Channels & Artifact Routing", () => {
    it("audits channels.json metadata", () => {
      const channelsData = {
        schemaVersion: "2.0.0",
        currentVersion: "1.0.10",
        channels: {
          stable: {
            version: "1.0.10",
            manifestUrl: "/releases/v1/manifests/manifest-1.0.10.json",
            manifestDigest: "3db146f8a517f358464fe19ae9873c965c7806f2734cb6ba789bedae9554ef9b",
          },
        },
      };

      const result = auditChannels(channelsData);
      expect(result.validJson).toBe(true);
      expect(result.currentVersion).toBe("1.0.10");
      expect(result.stableChannel.version).toBe("1.0.10");
    });

    it("routes different file types correctly via auditArtifact", () => {
      const tar = createSyntheticTar([{ name: "resin/apps/cli/dist/index.js", content: "cli" }]);
      const tarResult = auditArtifact(tar, "resin-v1.0.3-linux-x64.tar.gz");
      expect(tarResult.type).toBe("tarball");

      const zip = createSyntheticZip([{ name: "deno", content: "bin" }]);
      const zipResult = auditArtifact(zip, "deno-x86_64-unknown-linux-gnu.zip");
      expect(zipResult.type).toBe("zip");

      const manifestResult = auditArtifact(
        Buffer.from(JSON.stringify({ packages: {} })),
        "manifest-1.0.3.json",
      );
      expect(manifestResult.type).toBe("manifest");

      const sbomResult = auditArtifact(
        Buffer.from(JSON.stringify({ components: [] })),
        "sbom.json",
      );
      expect(sbomResult.type).toBe("sbom");

      const channelsResult = auditArtifact(
        Buffer.from(JSON.stringify({ currentVersion: "1.0.0" })),
        "channels.json",
      );
      expect(channelsResult.type).toBe("channels");
    });
  });

  describe("Directory Scanning & Report Generation", () => {
    it("scans a local release directory with multiple artifacts", () => {
      const tarBuf = createSyntheticTar([{ name: "resin/apps/cli/dist/index.js", content: "cli" }]);
      fs.writeFileSync(path.join(tempDir, "resin-v1.0.3-linux-x64.tar.gz"), tarBuf);
      fs.writeFileSync(
        path.join(tempDir, "manifest-1.0.3.json"),
        JSON.stringify({ packages: { "@resin/contracts": {} } }),
      );

      const scan = inventoryDirectory(tempDir);
      expect(scan.accessible).toBe(true);
      expect(scan.totalFiles).toBe(2);
      expect(scan.artifacts).toHaveLength(2);
    });

    it("generates deterministic JSON and human-readable Markdown reports", () => {
      const auditResult = {
        auditDate: AUDIT_DATE,
        timestamp: "2026-08-28T23:00:00.000Z",
        channels: {
          github: {
            repo: "Resin-AI/resin",
            accessible: true,
            releasesCount: 1,
            releases: [
              {
                tagName: "v1.0.3",
                publishedAt: "2026-08-27T21:09:41Z",
                assetsCount: 0,
                noAssetsDisclosed: true,
              },
            ],
          },
          s3: {
            bucket: "resin-dist-synthetic-bucket",
            accessible: true,
            totalObjects: 137,
            versionsFound: ["v1.0.3"],
            channelsAudit: {
              stableChannel: {
                version: "1.0.10",
                manifestUrl: "/releases/v1/manifests/manifest-1.0.10.json",
              },
            },
            versions: {
              "v1.0.3": {
                totalArtifacts: 1,
                artifacts: [
                  {
                    filename: "resin-v1.0.3-linux-x64.tar.gz",
                    type: "tarball",
                    sizeBytes: 13775372,
                    digest: "00c7324ee76fcfc27301c238b72f2324e9ecba9a22e86d9a9cb84e7a2b9ee37b",
                    totalEntries: 9643,
                    cloudFilesCount: 839,
                    sourceMapsCount: 1568,
                    fixtureFilesCount: 120,
                    secretsCount: 0,
                  },
                ],
              },
            },
          },
        },
      };

      const jsonStr = generateAuditJsonReport(auditResult);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.auditDate).toBe(AUDIT_DATE);
      expect(parsed.channels.s3.bucket).toBe("resin-dist-synthetic-bucket");

      const markdown = generateAuditTextReport(auditResult);
      expect(markdown).toContain("# Resin Public Release Artifact Security Audit");
      expect(markdown).toContain("GitHub Releases Channel");
      expect(markdown).toContain("Release Distribution S3 Storage");
      expect(markdown).toContain("resin-v1.0.3-linux-x64.tar.gz");
      expect(markdown).toContain("Cloud Files Disclosed: 839");
    });
  });
});
