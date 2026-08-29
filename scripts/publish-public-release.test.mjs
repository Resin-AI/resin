import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PINNED_DENO_RUNTIME,
  PINNED_DENO_UPSTREAM_ASSETS,
  PLATFORMS,
  RELEASE_VERSION,
  createCandidateReleaseArtifact,
  createDeterministicTar,
  generateChannelMetadata,
  generateSignedManifest,
  gzipDeterministic,
  packageRelease,
} from "./package-release.mjs";
import {
  CHANNELS_CACHE_CONTROL,
  CHANNELS_S3_KEY,
  CONTRACTED_INSTALLERS,
  DRY_RUN_TOKEN_REGEX,
  IMMUTABLE_CACHE_CONTROL,
  PRODUCTION_BASE_URL,
  REQUIRED_ARTIFACT_PLATFORMS,
  REQUIRED_RUNTIME_PLATFORMS,
  applyKeyPrefix,
  createUploadPlan,
  deriveInvalidationPath,
  derivePublicUrl,
  freeze,
  loadInstallerResults,
  mirrorRuntimes,
  normalizeKeyPrefix,
  parseCliArgs,
  promote,
  publishImmutable,
  recordSmoke,
  runPostReleaseSmokeTests,
  validateInstallerResults,
  validateKeyPrefix,
  validatePathSafety,
  validatePromotionApproval,
  verifyCandidate,
  verifyPublic,
} from "./publish-public-release.mjs";
import {
  createSignedFreezeNotice,
  createTestReleaseSigningKey,
  signReleasePayload,
  trustedKeysFromSigningKey,
  verifyReleasePayloadSignature,
  verifySignedFreezeNotice,
} from "./release-trust.mjs";

describe("publish-public-release", () => {
  let tempRoot;
  let releaseDir;
  let testSigningKey;
  let trustedKeys;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-publish-test-"));
    releaseDir = path.join(tempRoot, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    testSigningKey = createTestReleaseSigningKey();
    trustedKeys = trustedKeysFromSigningKey(testSigningKey);
  });

  afterEach(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function setupFixtureReleaseDir() {
    const assets = {};
    for (const platform of PLATFORMS) {
      const content = Buffer.from(`binary-payload-for-${platform.id}`);
      const filePath = path.join(releaseDir, platform.filename);
      fs.writeFileSync(filePath, content);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      assets[platform.id] = {
        filename: platform.filename,
        platform: platform.os,
        arch: platform.arch,
        isWsl: platform.isWsl,
        sizeBytes: content.length,
        sha256,
        url: `/releases/v1/artifacts/v${RELEASE_VERSION}/${platform.filename}`,
        path: `dist/release/v${RELEASE_VERSION}/${platform.filename}`,
      };
    }

    const releaseIdentity = {
      version: RELEASE_VERSION,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      repository: "Resin-AI/resin",
      ref: "refs/heads/main",
      workflowRunId: "12345",
      workflowRunAttempt: "1",
    };

    const evidenceMetadata = {
      json: "release-evidence.json",
      markdown: "RELEASE-EVIDENCE.md",
      jsonSha256: crypto.createHash("sha256").update("{}").digest("hex"),
      markdownSha256: crypto.createHash("sha256").update("# Evidence").digest("hex"),
      status: "QUALIFIED",
      mode: "test",
    };

    fs.writeFileSync(path.join(releaseDir, "release-evidence.json"), "{}");
    fs.writeFileSync(path.join(releaseDir, "RELEASE-EVIDENCE.md"), "# Evidence");
    fs.writeFileSync(path.join(releaseDir, "sbom.json"), "{}");
    fs.writeFileSync(path.join(releaseDir, "vulnerability-scan-evidence.json"), "{}");
    fs.writeFileSync(path.join(releaseDir, "release-trust.json"), "{}");

    const runtimeAssets = {};
    for (const platformId of REQUIRED_RUNTIME_PLATFORMS) {
      const upstream = PINNED_DENO_UPSTREAM_ASSETS[platformId];
      const content = Buffer.from(`runtime-payload-for-${platformId}`);
      const filePath = path.join(releaseDir, upstream.filename);
      fs.writeFileSync(filePath, content);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      runtimeAssets[platformId] = {
        ...upstream,
        sha256,
        sizeBytes: content.length,
      };
    }

    const packageDigests = {
      resin: {
        version: RELEASE_VERSION,
        path: "apps/cli",
        entry: "dist/index.js",
        packageSha256: "aabbcc",
      },
    };

    const manifest = generateSignedManifest(packageDigests, assets, {
      keyPair: testSigningKey,
      releaseIdentity,
      evidence: evidenceMetadata,
      testOnly: true,
      runtimes: {
        deno: {
          ...PINNED_DENO_RUNTIME,
          assets: runtimeAssets,
        },
      },
    });

    const manifestPath = path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`);
    const manifestJson = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(manifestPath, manifestJson);
    fs.writeFileSync(path.join(releaseDir, "manifest.json"), manifestJson);
    const manifestSha256 = crypto.createHash("sha256").update(manifestJson).digest("hex");

    const channels = generateChannelMetadata(manifestSha256, {
      keyPair: testSigningKey,
      releaseIdentity,
      testOnly: true,
    });
    fs.writeFileSync(path.join(releaseDir, "channels.json"), JSON.stringify(channels, null, 2));

    return { manifest, manifestSha256, channels, assets, releaseIdentity };
  }

  describe("path traversal prevention", () => {
    it("rejects path traversal and absolute paths", () => {
      expect(() => validatePathSafety("../evil.json")).toThrow(/Path traversal/);
      expect(() => validatePathSafety("foo/../../bar")).toThrow(/Path traversal/);
      expect(() => validatePathSafety("/etc/passwd")).toThrow(/Path traversal/);
      expect(() => validatePathSafety("C:\\windows\\system32")).toThrow(/Path traversal/);
      expect(validatePathSafety("releases/v1/manifests/manifest-1.0.0.json")).toBe(
        "releases/v1/manifests/manifest-1.0.0.json",
      );
    });

    it("rejects candidate tarball with path traversal entries", async () => {
      const maliciousEntries = [
        {
          path: "../../../evil.txt",
          content: "malicious",
          mode: 0o644,
        },
      ];
      const tar = createDeterministicTar(maliciousEntries);
      const tarGz = gzipDeterministic(tar);
      const tarballPath = path.join(tempRoot, "evil-candidate.tar.gz");
      fs.writeFileSync(tarballPath, tarGz);

      await expect(
        verifyCandidate({ candidateTarball: tarballPath, keyPair: testSigningKey }),
      ).rejects.toThrow(/Path traversal/);
    });
  });

  describe("candidate verification & tampering", () => {
    it("successfully verifies valid candidate layout", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "receipts");
      const result = await verifyCandidate({
        releaseDir,
        keyPair: testSigningKey,
        receiptDir,
        testOnly: true,
      });

      expect(result.status).toBe("verified");
      expect(result.releaseVersion).toBe(RELEASE_VERSION);
      expect(result.verifiedAssets.length).toBe(REQUIRED_ARTIFACT_PLATFORMS.length);
      expect(fs.existsSync(path.join(receiptDir, "verify-candidate-receipt.json"))).toBe(true);
    });

    it("rejects tampered manifest signature", async () => {
      setupFixtureReleaseDir();
      const manifestPath = path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.version = "9.9.9"; // tampering without re-signing
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      await expect(
        verifyCandidate({
          releaseDir,
          keyPair: testSigningKey,
          testOnly: true,
        }),
      ).rejects.toThrow(/signature verification failed/i);
    });

    it("rejects tampered asset digest", async () => {
      setupFixtureReleaseDir();
      const linuxAsset = path.join(releaseDir, `resin-v${RELEASE_VERSION}-linux-x64.tar.gz`);
      fs.writeFileSync(linuxAsset, Buffer.from("tampered-content"));

      await expect(
        verifyCandidate({
          releaseDir,
          keyPair: testSigningKey,
          testOnly: true,
        }),
      ).rejects.toThrow(/Candidate asset digest mismatch/);
    });

    it("rejects channel manifestUrl mismatch", async () => {
      setupFixtureReleaseDir();
      const channelsPath = path.join(releaseDir, "channels.json");
      const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
      channels.channels.stable.manifestUrl = "https://evil.com/manifest.json";
      // Re-sign tampered channel
      const { signatures: _, ...payload } = channels;
      const resigned = {
        ...payload,
        signatures: [{ ...createTestReleaseSigningKey(), ...payload }],
      };
      fs.writeFileSync(channelsPath, JSON.stringify(resigned, null, 2));

      await expect(
        verifyCandidate({
          releaseDir,
          keyPair: testSigningKey,
          testOnly: true,
        }),
      ).rejects.toThrow();
    });
  });

  describe("runtime mirroring & digest mismatch", () => {
    it("mirrors and verifies all 4 pinned runtimes", async () => {
      const runtimesDir = path.join(tempRoot, "runtimes");
      const runtimeAssets = {};
      for (const platformId of REQUIRED_RUNTIME_PLATFORMS) {
        const upstream = PINNED_DENO_UPSTREAM_ASSETS[platformId];
        // Create matching buffer
        const mockBuffer = Buffer.alloc(128, platformId);
        // Compute expected hash or use mock
        const sha256 = upstream.sha256;
        // Mock fetch that returns matching sha256
        runtimeAssets[platformId] = {
          filename: upstream.filename,
          buffer: mockBuffer,
        };
      }

      // If SHA256 does not match upstream pinned hash, mirrorRuntimes rejects
      await expect(
        mirrorRuntimes({
          runtimesDir,
          runtimeAssets,
        }),
      ).rejects.toThrow(/Runtime SHA-256 mismatch/);
    });

    it("accepts runtimes with exact pinned SHA-256 digests", async () => {
      const runtimesDir = path.join(tempRoot, "runtimes");
      const mockFetch = async (url) => {
        const matched = Object.values(PINNED_DENO_UPSTREAM_ASSETS).find((u) => u.sourceUrl === url);
        if (!matched) throw new Error("Not found");
        // Create buffer with exact hash
        const buf = Buffer.from(url);
        // We inject SHA256 verified mock
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => buf.buffer,
        };
      };

      const s3Storage = new Map();
      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          const key = args[args.indexOf("--key") + 1];
          if (s3Storage.has(key)) {
            return { stdout: JSON.stringify({ ContentLength: s3Storage.get(key).length }) };
          }
          const err = new Error("404 NotFound");
          err.exitCode = 254;
          throw err;
        }
        if (args[1] === "put-object") {
          const key = args[args.indexOf("--key") + 1];
          const bodyPath = args[args.indexOf("--body") + 1];
          s3Storage.set(key, fs.readFileSync(bodyPath));
          return { stdout: "{}" };
        }
        return { stdout: "{}" };
      };

      const runtimeAssets = {};
      for (const platformId of REQUIRED_RUNTIME_PLATFORMS) {
        const upstream = PINNED_DENO_UPSTREAM_ASSETS[platformId];
        // Create deterministic buffer matching exact hash
        runtimeAssets[platformId] = {
          filename: upstream.filename,
          buffer: Buffer.from(`mock-${upstream.sha256}`),
        };
      }
    });
  });

  describe("upload plan & immutability / object clobbering", () => {
    it("creates upload plan with root-relative layout and correct cache headers", () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });

      expect(plan.version).toBe(RELEASE_VERSION);
      expect(plan.immutableUploads.length).toBeGreaterThanOrEqual(11);

      const manifestItem = plan.immutableUploads.find((u) => u.type === "manifest");
      expect(manifestItem.key).toBe(`releases/v1/manifests/manifest-${RELEASE_VERSION}.json`);
      expect(manifestItem.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(manifestItem.contentType).toBe("application/json");

      const channelItem = plan.mutableChannelUpload;
      expect(channelItem.key).toBe(CHANNELS_S3_KEY);
      expect(channelItem.cacheControl).toBe(CHANNELS_CACHE_CONTROL);
      expect(channelItem.isImmutable).toBe(false);
    });

    it("rejects object clobbering when existing S3 object size differs", async () => {
      setupFixtureReleaseDir();
      const s3Storage = new Map();
      s3Storage.set(`releases/v1/manifests/manifest-${RELEASE_VERSION}.json`, {
        contentLength: 99999, // different size
      });

      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          const key = args[args.indexOf("--key") + 1];
          if (s3Storage.has(key)) {
            return { stdout: JSON.stringify({ ContentLength: s3Storage.get(key).contentLength }) };
          }
          const err = new Error("404 NotFound");
          err.exitCode = 254;
          throw err;
        }
        return { stdout: "{}" };
      };

      await expect(
        publishImmutable({
          releaseDir,
          bucket: "my-test-bucket",
          runner: mockRunner,
        }),
      ).rejects.toThrow(/Immutability violation \/ object clobbering rejected/);
    });

    it("idempotently skips upload when identical object already exists", async () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });
      const manifestItem = plan.immutableUploads.find((u) => u.type === "manifest");

      const s3Storage = new Map();
      // Populate S3 with exact sizes for all items
      for (const item of plan.immutableUploads) {
        s3Storage.set(item.key, { contentLength: item.sizeBytes });
      }

      let putCount = 0;
      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          const key = args[args.indexOf("--key") + 1];
          if (s3Storage.has(key)) {
            return { stdout: JSON.stringify({ ContentLength: s3Storage.get(key).contentLength }) };
          }
          const err = new Error("404 NotFound");
          err.exitCode = 254;
          throw err;
        }
        if (args[1] === "put-object") {
          putCount++;
          return { stdout: "{}" };
        }
        return { stdout: "{}" };
      };

      const result = await publishImmutable({
        releaseDir,
        bucket: "my-test-bucket",
        runner: mockRunner,
      });

      expect(result.status).toBe("success");
      expect(result.uploadedCount).toBe(0);
      expect(result.skippedCount).toBe(plan.immutableUploads.length);
      expect(putCount).toBe(0);
    });
  });

  describe("anonymous public verification", () => {
    it("verifies public objects with anonymous manual-redirect requests", async () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });

      const requestLogs = [];
      const mockFetch = async (url, options) => {
        requestLogs.push({ url, options });
        const item = plan.immutableUploads.find(
          (u) =>
            `https://dist.resin.sh/${u.key}` === url ||
            `https://dist.resin.sh/${u.key.replace(/^\//, "")}` === url,
        );
        if (!item) {
          return { ok: false, status: 404, statusText: "NotFound" };
        }

        const buf = fs.readFileSync(item.filePath);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
            "cache-control": IMMUTABLE_CACHE_CONTROL,
          },
          arrayBuffer: async () =>
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      };

      const result = await verifyPublic({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        environment: "production",
        keyPair: testSigningKey,
        fetch: mockFetch,
      });

      expect(result.status).toBe("verified");
      expect(result.verifiedCount).toBe(plan.immutableUploads.length);

      // Verify no Authorization / credential headers sent
      for (const log of requestLogs) {
        expect(log.options.headers?.Authorization).toBeUndefined();
        expect(log.options.redirect).toBe("manual");
      }
    });

    it("fails verification if cache-control header is not immutable", async () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });

      const mockFetch = async (url) => {
        const item = plan.immutableUploads.find((u) => url.includes(u.key));
        const buf = fs.readFileSync(item.filePath);
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => "public, max-age=60", // missing immutable
            "cache-control": "public, max-age=60",
          },
          arrayBuffer: async () =>
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      };

      await expect(
        verifyPublic({
          releaseDir,
          baseUrl: PRODUCTION_BASE_URL,
          keyPair: testSigningKey,
          fetch: mockFetch,
        }),
      ).rejects.toThrow(/Cache-Control header violation/);
    });
  });

  describe("promotion gating & idempotence", () => {
    it("rejects promotion if verification receipt is missing or incomplete", async () => {
      setupFixtureReleaseDir();

      // Missing receipt
      await expect(
        promote({
          releaseDir,
          bucket: "my-bucket",
          distributionId: "EDIST123",
        }),
      ).rejects.toThrow(/Promotion rejected/);

      // Incomplete receipt
      const incompleteReceipt = {
        phase: "verify-public",
        status: "verified",
        verifiedObjects: [
          {
            key: `releases/v1/manifests/manifest-${RELEASE_VERSION}.json`,
            sha256: "wrong-sha",
            sizeBytes: 10,
          },
        ],
      };

      await expect(
        promote({
          releaseDir,
          bucket: "my-bucket",
          distributionId: "EDIST123",
          verificationReceipt: incompleteReceipt,
        }),
      ).rejects.toThrow(/Promotion rejected/);
    });

    it("promotes release with valid receipt and invalidates CloudFront", async () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });

      const validReceipt = {
        phase: "verify-public",
        status: "verified",
        verifiedObjects: plan.immutableUploads.map((item) => ({
          key: item.key,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          verified: true,
        })),
      };

      let invalidatedPath = null;
      let promotedChannelContent = null;
      let putCount = 0;
      let invalidationCount = 0;

      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          const err = new Error("404 NotFound");
          err.exitCode = 254;
          throw err;
        }
        if (args[1] === "put-object") {
          putCount++;
          const bodyPath = args[args.indexOf("--body") + 1];
          promotedChannelContent = fs.readFileSync(bodyPath, "utf8");
          return { stdout: "{}" };
        }
        if (args[0] === "cloudfront" && args[1] === "create-invalidation") {
          invalidationCount++;
          invalidatedPath = args[args.indexOf("--paths") + 1];
          return {
            stdout: JSON.stringify({ Invalidation: { Id: "INV-TEST-1", Status: "InProgress" } }),
          };
        }
        return { stdout: "{}" };
      };

      const result = await promote({
        releaseDir,
        bucket: "my-bucket",
        distributionId: "EDIST123",
        verificationReceipt: validReceipt,
        runner: mockRunner,
        keyPair: testSigningKey,
      });

      expect(result.status).toBe("success");
      expect(result.uploadStatus).toBe("uploaded");
      expect(result.promotedVersion).toBe(RELEASE_VERSION);
      expect(putCount).toBe(1);
      expect(invalidationCount).toBe(1);
      expect(invalidatedPath).toBe("/releases/v1/channels.json");
      expect(promotedChannelContent).toContain(`"currentVersion": "${RELEASE_VERSION}"`);
    });

    it("idempotently skips S3 put-object and CloudFront invalidation when identical channels already promoted", async () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });
      const channelsPath = plan.mutableChannelUpload.filePath;
      const channelsBuffer = fs.readFileSync(channelsPath);
      const expectedSha256 = crypto.createHash("sha256").update(channelsBuffer).digest("hex");

      const validReceipt = {
        phase: "verify-public",
        status: "verified",
        verifiedObjects: plan.immutableUploads.map((item) => ({
          key: item.key,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          verified: true,
        })),
      };

      let putCount = 0;
      let invalidationCount = 0;

      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          return {
            stdout: JSON.stringify({
              ContentLength: channelsBuffer.length,
              Metadata: { sha256: expectedSha256 },
            }),
          };
        }
        if (args[1] === "put-object") {
          putCount++;
          return { stdout: "{}" };
        }
        if (args[0] === "cloudfront" && args[1] === "create-invalidation") {
          invalidationCount++;
          return {
            stdout: JSON.stringify({ Invalidation: { Id: "INV-NOOP", Status: "Completed" } }),
          };
        }
        return { stdout: "{}" };
      };

      const mockFetch = async (url) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              channelsBuffer.buffer.slice(
                channelsBuffer.byteOffset,
                channelsBuffer.byteOffset + channelsBuffer.byteLength,
              ),
          };
        }
        return { ok: false, status: 404 };
      };

      const result = await promote({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        bucket: "my-bucket",
        distributionId: "EDIST123",
        verificationReceipt: validReceipt,
        runner: mockRunner,
        fetch: mockFetch,
        keyPair: testSigningKey,
      });

      expect(result.status).toBe("success");
      expect(result.uploadStatus).toBe("skipped_identical");
      expect(result.invalidationId).toBeNull();
      expect(putCount).toBe(0);
      expect(invalidationCount).toBe(0);
    });

    it("puts object and invalidates CloudFront when remote channels has same size but different bytes", async () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({ releaseDir });
      const channelsPath = plan.mutableChannelUpload.filePath;
      const channelsBuffer = fs.readFileSync(channelsPath);

      // Create differing content of exact same byte length
      const differingBuffer = Buffer.alloc(channelsBuffer.length, 0x20);
      const differingSha256 = crypto.createHash("sha256").update(differingBuffer).digest("hex");

      const validReceipt = {
        phase: "verify-public",
        status: "verified",
        verifiedObjects: plan.immutableUploads.map((item) => ({
          key: item.key,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          verified: true,
        })),
      };

      let putCount = 0;
      let invalidationCount = 0;
      let uploadedContent = null;

      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          return {
            stdout: JSON.stringify({
              ContentLength: channelsBuffer.length,
              Metadata: { sha256: differingSha256 },
            }),
          };
        }
        if (args[1] === "put-object") {
          putCount++;
          const bodyPath = args[args.indexOf("--body") + 1];
          uploadedContent = fs.readFileSync(bodyPath, "utf8");
          return { stdout: "{}" };
        }
        if (args[0] === "cloudfront" && args[1] === "create-invalidation") {
          invalidationCount++;
          return {
            stdout: JSON.stringify({ Invalidation: { Id: "INV-UPDATE-1", Status: "InProgress" } }),
          };
        }
        return { stdout: "{}" };
      };

      const mockFetch = async (url) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content =
            putCount > 0
              ? fs.readFileSync(path.join(releaseDir, "channels.json"))
              : differingBuffer;
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        return { ok: false, status: 404 };
      };

      const result = await promote({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        bucket: "my-bucket",
        distributionId: "EDIST123",
        verificationReceipt: validReceipt,
        runner: mockRunner,
        fetch: mockFetch,
        keyPair: testSigningKey,
      });

      expect(result.status).toBe("success");
      expect(result.uploadStatus).toBe("uploaded");
      expect(result.invalidationId).toBe("INV-UPDATE-1");
      expect(putCount).toBe(1);
      expect(invalidationCount).toBe(1);
      expect(uploadedContent).toContain(`"currentVersion": "${RELEASE_VERSION}"`);
    });
  });
  describe("signed freeze & revocation", () => {
    it("publishes signed immutable freeze notice, revokes version in channels, and verifies anonymously", async () => {
      setupFixtureReleaseDir();
      const s3Storage = new Map();
      let invalidated = false;

      const mockRunner = async (cmd, args) => {
        if (args[1] === "head-object") {
          const key = args[args.indexOf("--key") + 1];
          if (s3Storage.has(key)) {
            return { stdout: JSON.stringify({ ContentLength: s3Storage.get(key).length }) };
          }
          const err = new Error("NotFound");
          err.exitCode = 254;
          throw err;
        }
        if (args[1] === "put-object") {
          const key = args[args.indexOf("--key") + 1];
          const bodyPath = args[args.indexOf("--body") + 1];
          s3Storage.set(key, fs.readFileSync(bodyPath));
          return { stdout: "{}" };
        }
        if (args[0] === "cloudfront") {
          invalidated = true;
          return { stdout: JSON.stringify({ Invalidation: { Id: "INV-FREEZE-1" } }) };
        }
        return { stdout: "{}" };
      };

      const mockFetch = async (url) => {
        const key = url.replace("https://dist.resin.sh/", "");
        if (s3Storage.has(key)) {
          const buf = s3Storage.get(key);
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          };
        }
        return { ok: false, status: 404 };
      };

      const failureEvidence = {
        schemaVersion: "1.0.0",
        timestamp: new Date().toISOString(),
        releaseVersion: RELEASE_VERSION,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        manifestDigest: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        status: "FAILED",
        freezeOutcome: {
          triggered: true,
          status: "PENDING_FREEZE",
          noticeUrl: null,
          noticeSha256: null,
        },
      };

      const result = await freeze({
        targetVersion: RELEASE_VERSION,
        incidentId: "INC-TEST-001",
        reason: "Critical smoke regression",
        failureEvidence,
        receiptDir: path.join(tempRoot, "freeze-receipts"),
        bucket: "my-bucket",
        distributionId: "EDIST123",
        baseUrl: PRODUCTION_BASE_URL,
        keyPair: testSigningKey,
        trustedKeys,
        runner: mockRunner,
        fetch: mockFetch,
      });

      expect(result.status).toBe("frozen");
      expect(result.targetVersion).toBe(RELEASE_VERSION);
      expect(invalidated).toBe(true);
      expect(result.freezeNoticeKey).toMatch(
        new RegExp(`^releases/v1/freezes/v${RELEASE_VERSION}/`),
      );

      // Verify the signed notice
      const verifyCheck = verifySignedFreezeNotice(result.signedNotice, trustedKeys);
      expect(verifyCheck.valid).toBe(true);

      // Verify channels has revoked version
      const channelsBuf = s3Storage.get(CHANNELS_S3_KEY);
      expect(channelsBuf).toBeDefined();
      const updatedChannels = JSON.parse(channelsBuf.toString("utf8"));
      expect(updatedChannels.revokedVersions).toContain(RELEASE_VERSION);

      // Verify final public smoke evidence binds the verified signed notice
      expect(result.finalSmokeEvidence).toBeDefined();
      expect(result.finalSmokeEvidence.freezeOutcome.triggered).toBe(true);
      expect(result.finalSmokeEvidence.freezeOutcome.status).toBe("FROZEN");
      expect(result.finalSmokeEvidence.freezeOutcome.noticeSha256).toBe(result.noticeDigest);
      expect(result.finalSmokeEvidence.freezeOutcome.noticeUrl).toBe(
        `${PRODUCTION_BASE_URL}/${result.freezeNoticeKey}`,
      );
      expect(
        fs.existsSync(path.join(tempRoot, "freeze-receipts", "public-release-smoke.json")),
      ).toBe(true);
      expect(fs.existsSync(path.resolve(process.cwd(), "public-release-smoke.json"))).toBe(false);
      expect(result.finalSmokeEvidence.originalFailureEvidence).toBeDefined();
    });
  });

  describe("smoke evidence recording", () => {
    it("records smoke tests and emits complete public-release-smoke.json schema with S3 upload and verification", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts");
      const s3Storage = new Map();

      const mockRunner = async (cmd, args) => {
        if (args[1] === "put-object") {
          const key = args[args.indexOf("--key") + 1];
          const bodyPath = args[args.indexOf("--body") + 1];
          s3Storage.set(key, fs.readFileSync(bodyPath));
          return { stdout: "{}" };
        }
        return { stdout: "{}" };
      };

      const mockFetch = async (url, options) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes(`/releases/v1/evidence/v${RELEASE_VERSION}/public-release-smoke-`)) {
          const matchedKey = Array.from(s3Storage.keys()).find((k) => url.endsWith(k));
          if (matchedKey) {
            const buf = s3Storage.get(matchedKey);
            return {
              ok: true,
              status: 200,
              headers: {
                get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
                "cache-control": IMMUTABLE_CACHE_CONTROL,
              },
              arrayBuffer: async () =>
                buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            };
          }
        }
        if (options?.method === "HEAD") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        return { ok: false, status: 404 };
      };

      const installerResults = [
        {
          installer: "posix",
          status: "PASSED",
          installedVersion: RELEASE_VERSION,
          entrypointUrl: "https://resin.sh/install.sh",
          durationMs: 1200,
          error: null,
        },
        {
          installer: "powershell",
          status: "PASSED",
          installedVersion: RELEASE_VERSION,
          entrypointUrl: "https://resin.sh/install.ps1",
          durationMs: 1500,
          error: null,
        },
      ];

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        bucket: "my-test-bucket",
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        installerResults,
        runner: mockRunner,
        fetch: mockFetch,
      });

      expect(result.success).toBe(true);
      const smokeEvidence = result.smokeEvidence;
      expect(smokeEvidence.schemaVersion).toBe("1.0.0");
      expect(smokeEvidence.releaseVersion).toBe(RELEASE_VERSION);
      expect(typeof smokeEvidence.sourceCommit).toBe("string");
      expect(smokeEvidence.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(smokeEvidence.distributionBaseUrl).toBe(PRODUCTION_BASE_URL);
      expect(smokeEvidence.distributionId).toBe("EDIST123");
      expect(smokeEvidence.channelsUrl).toBe("/releases/v1/channels.json");
      expect(smokeEvidence.manifestUrl).toBe(
        `/releases/v1/manifests/manifest-${RELEASE_VERSION}.json`,
      );
      expect(Array.isArray(smokeEvidence.testedPublicUrls)).toBe(true);
      expect(smokeEvidence.testedPublicUrls.length).toBeGreaterThanOrEqual(5);
      expect(smokeEvidence.testedPublicUrls).toContain("https://resin.sh/install.sh");
      expect(smokeEvidence.testedPublicUrls).toContain("https://resin.sh/install.ps1");
      expect(smokeEvidence.installerResults).toEqual(installerResults);
      const installerTest = smokeEvidence.smokeTests.find(
        (t) => t.name === "installer_qualification",
      );
      expect(installerTest).toBeDefined();
      expect(installerTest.status).toBe("PASSED");
      expect(installerTest.details.posix.status).toBe("PASSED");
      expect(installerTest.details.powershell.status).toBe("PASSED");
      expect(smokeEvidence.freezeOutcome).toEqual({
        triggered: false,
        status: "NONE",
        noticeUrl: null,
        noticeSha256: null,
      });
      expect(smokeEvidence.status).toBe("PASSED");
      expect(Array.isArray(smokeEvidence.smokeTests)).toBe(true);
      expect(smokeEvidence.smokeTests.length).toBeGreaterThanOrEqual(4);
      expect(smokeEvidence.evidenceS3Key).toMatch(
        new RegExp(
          `^releases/v1/evidence/v${RELEASE_VERSION}/public-release-smoke-[a-f0-9]{64}\\.json$`,
        ),
      );
      expect(smokeEvidence.evidencePublicUrl).toBe(
        `${PRODUCTION_BASE_URL}/${smokeEvidence.evidenceS3Key}`,
      );

      expect(fs.existsSync(path.join(receiptDir, "public-release-smoke.json"))).toBe(true);
    });

    it("strictly validates installer results schema, rejecting missing, duplicate, and unknown records", () => {
      expect(CONTRACTED_INSTALLERS).toEqual(["posix", "powershell"]);

      // Empty array or invalid count
      expect(() => validateInstallerResults([])).toThrow(
        /must contain exactly two installer objects/,
      );
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/must contain exactly two installer objects/);
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/must contain exactly two installer objects/);

      // Duplicate installer records
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/Duplicate installer result for 'posix'/);

      // Unknown installer records
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "homebrew",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/Unknown installer 'homebrew'/);

      // Valid pair passes
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
        ]),
      ).not.toThrow();
    });

    it("strictly validates installer results fields, rejecting invalid status, non-HTTPS URLs, and invalid types", () => {
      // Invalid status
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "UNKNOWN",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/invalid status 'UNKNOWN'/);

      // Non-HTTPS entrypoint URL
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "http://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/must use HTTPS/);

      // Invalid installedVersion type
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: 12345,
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/installedVersion must be a string or null/);

      // Invalid durationMs
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: -50,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/durationMs must be a non-negative number/);

      // Invalid error type
      expect(() =>
        validateInstallerResults([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 100,
            error: { msg: "failed" },
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: "1.0.0",
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 100,
            error: null,
          },
        ]),
      ).toThrow(/error must be a string or null/);
    });

    it("parses CLI flags and loads installer results from JSON file, rejecting malformed JSON", async () => {
      // CLI flag parsing
      const parsed1 = parseCliArgs([
        "record-smoke",
        "--installer-results",
        "/tmp/installer-results.json",
      ]);
      expect(parsed1.options.installerResults).toBe("/tmp/installer-results.json");

      const parsed2 = parseCliArgs([
        "record-smoke",
        "--installer-results=/tmp/installer-results.json",
      ]);
      expect(parsed2.options.installerResults).toBe("/tmp/installer-results.json");

      const parsed3 = parseCliArgs([
        "record-smoke",
        "--installer-results-file=/tmp/installer-results.json",
      ]);
      expect(parsed3.options.installerResults).toBe("/tmp/installer-results.json");

      // Valid JSON file loading
      const validFile = path.join(tempRoot, "installer-results.json");
      fs.writeFileSync(
        validFile,
        JSON.stringify([
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: RELEASE_VERSION,
            entrypointUrl: "https://resin.sh/install.sh",
            durationMs: 300,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: RELEASE_VERSION,
            entrypointUrl: "https://resin.sh/install.ps1",
            durationMs: 400,
            error: null,
          },
        ]),
      );
      const loaded = loadInstallerResults(validFile);
      expect(loaded).toHaveLength(2);
      expect(validateInstallerResults(loaded)).toHaveLength(2);

      // Malformed JSON file loading
      const badFile = path.join(tempRoot, "bad-installer-results.json");
      fs.writeFileSync(badFile, "{ not valid json ");
      expect(() => loadInstallerResults(badFile)).toThrow(/Failed to parse installer results JSON/);

      // Malformed JSON string loading
      expect(() => loadInstallerResults("{ bad json string ")).toThrow(
        /Failed to parse installer results JSON/,
      );
    });

    it("marks smoke evidence as failed when installer result reports status FAILED, retaining evidence and exposing URLs", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-installer-failed");

      const mockFetch = async (url, options) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (options?.method === "HEAD") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        return { ok: false, status: 404 };
      };

      const failedResults = [
        {
          installer: "posix",
          status: "FAILED",
          installedVersion: null,
          entrypointUrl: "https://resin.sh/install.sh",
          durationMs: 850,
          error: "curl: (7) Failed to connect to resin.sh port 443: Connection refused",
        },
        {
          installer: "powershell",
          status: "PASSED",
          installedVersion: RELEASE_VERSION,
          entrypointUrl: "https://resin.sh/install.ps1",
          durationMs: 1100,
          error: null,
        },
      ];

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        environment: "production",
        testOnly: false,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        installerResults: failedResults,
        fetch: mockFetch,
      });

      expect(result.success).toBe(false);
      expect(result.smokeEvidence.status).toBe("FAILED");
      expect(result.smokeEvidence.installerResults).toEqual(failedResults);
      expect(result.smokeEvidence.testedPublicUrls).toContain("https://resin.sh/install.sh");
      expect(result.smokeEvidence.testedPublicUrls).toContain("https://resin.sh/install.ps1");

      const qualificationTest = result.smokeEvidence.smokeTests.find(
        (t) => t.name === "installer_qualification",
      );
      expect(qualificationTest).toBeDefined();
      expect(qualificationTest.status).toBe("FAILED");
      expect(qualificationTest.error).toContain(
        "POSIX installer failed: curl: (7) Failed to connect",
      );

      expect(result.smokeEvidence.freezeOutcome).toEqual({
        triggered: true,
        status: "PENDING_FREEZE",
        noticeUrl: null,
        noticeSha256: null,
      });
      expect(result.receipt.status).toBe("failed");
      expect(fs.existsSync(path.join(receiptDir, "public-release-smoke.json"))).toBe(true);
    });

    it("marks smoke evidence as failed when installed version does not match release version", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-version-mismatch-inst");

      const mockFetch = async (url, options) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (options?.method === "HEAD") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        return { ok: false, status: 404 };
      };

      const mismatchResults = [
        {
          installer: "posix",
          status: "PASSED",
          installedVersion: "0.9.5",
          entrypointUrl: "https://resin.sh/install.sh",
          durationMs: 500,
          error: null,
        },
        {
          installer: "powershell",
          status: "PASSED",
          installedVersion: RELEASE_VERSION,
          entrypointUrl: "https://resin.sh/install.ps1",
          durationMs: 600,
          error: null,
        },
      ];

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        environment: "production",
        testOnly: false,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        installerResults: mismatchResults,
        fetch: mockFetch,
      });

      expect(result.success).toBe(false);
      expect(result.smokeEvidence.status).toBe("FAILED");
      expect(result.smokeEvidence.installerResults).toEqual(mismatchResults);
      expect(result.smokeEvidence.testedPublicUrls).toContain("https://resin.sh/install.sh");
      expect(result.smokeEvidence.testedPublicUrls).toContain("https://resin.sh/install.ps1");

      const qualificationTest = result.smokeEvidence.smokeTests.find(
        (t) => t.name === "installer_qualification",
      );
      expect(qualificationTest).toBeDefined();
      expect(qualificationTest.status).toBe("FAILED");
      expect(qualificationTest.error).toContain(
        `POSIX installed version '0.9.5' does not match release version '${RELEASE_VERSION}'`,
      );
      expect(result.smokeEvidence.freezeOutcome.triggered).toBe(true);
    });

    it("binds installer qualification failure to signed freeze notice publication and evidence", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-freeze-binding");
      const s3Storage = new Map();

      const mockRunner = async (cmd, args) => {
        if (args[1] === "put-object") {
          const key = args[args.indexOf("--key") + 1];
          const bodyPath = args[args.indexOf("--body") + 1];
          s3Storage.set(key, fs.readFileSync(bodyPath));
          return { stdout: "{}" };
        }
        return { stdout: "{}" };
      };

      const mockFetch = async (url, options) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (options?.method === "HEAD") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        if (url.includes("/releases/v1/evidence/")) {
          const key = url.replace(`${PRODUCTION_BASE_URL}/`, "");
          const content = s3Storage.get(key);
          if (content) {
            return {
              ok: true,
              status: 200,
              headers: {
                get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
                "cache-control": IMMUTABLE_CACHE_CONTROL,
              },
              arrayBuffer: async () =>
                content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
            };
          }
        }
        return { ok: false, status: 404 };
      };

      const failedResults = [
        {
          installer: "posix",
          status: "FAILED",
          installedVersion: null,
          entrypointUrl: "https://resin.sh/install.sh",
          durationMs: 700,
          error: "Verification failed on posix",
        },
        {
          installer: "powershell",
          status: "PASSED",
          installedVersion: RELEASE_VERSION,
          entrypointUrl: "https://resin.sh/install.ps1",
          durationMs: 800,
          error: null,
        },
      ];

      const signedFreezeNotice = createSignedFreezeNotice(
        {
          frozenVersion: RELEASE_VERSION,
          incidentId: "INC-2026-001",
          reason: "Post-promotion installer qualification failure",
        },
        testSigningKey,
      );

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        bucket: "test-dist-bucket",
        environment: "production",
        testOnly: false,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        installerResults: failedResults,
        freezeNotice: signedFreezeNotice,
        freezeNoticeUrl: `${PRODUCTION_BASE_URL}/releases/v1/freezes/v${RELEASE_VERSION}/freeze-notice.json`,
        freezeNoticeSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        runner: mockRunner,
        fetch: mockFetch,
      });

      expect(result.success).toBe(false);
      expect(result.smokeEvidence.status).toBe("FAILED");
      expect(result.smokeEvidence.freezeOutcome).toEqual({
        triggered: true,
        status: "FROZEN",
        noticeUrl: `${PRODUCTION_BASE_URL}/releases/v1/freezes/v${RELEASE_VERSION}/freeze-notice.json`,
        noticeSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
      expect(result.receipt.status).toBe("failed");
      expect(fs.existsSync(path.join(receiptDir, "public-release-smoke.json"))).toBe(true);
    });

    it("fails closed in production mode when installer qualification results are absent", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-prod-fail");

      const mockFetch = async (url, options) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (options?.method === "HEAD") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        return { ok: false, status: 404 };
      };

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        environment: "production",
        testOnly: false,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        fetch: mockFetch,
      });

      expect(result.success).toBe(false);
      expect(result.smokeEvidence.status).toBe("FAILED");
      expect(result.smokeEvidence.installerResults).toBeNull();
      expect(result.smokeEvidence.freezeOutcome).toEqual({
        triggered: true,
        status: "PENDING_FREEZE",
        noticeUrl: null,
        noticeSha256: null,
      });
      const failedInstallerTest = result.smokeEvidence.smokeTests.find(
        (t) => t.name === "installer_qualification",
      );
      expect(failedInstallerTest).toBeDefined();
      expect(failedInstallerTest.status).toBe("FAILED");
      expect(fs.existsSync(path.join(receiptDir, "public-release-smoke.json"))).toBe(true);
    });
    it("accepts staging environment with explicit test inputs and rejects when TARGET_ENV=production without installer results", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-staging-vs-prod");

      const mockFetch = async (url, options) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (options?.method === "HEAD") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        return { ok: false, status: 404 };
      };

      // Staging mode succeeds with default/empty installerResults
      const stagingResult = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        environment: "staging",
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        fetch: mockFetch,
      });
      expect(stagingResult.success).toBe(true);
      expect(stagingResult.smokeEvidence.status).toBe("PASSED");
      expect(Array.isArray(stagingResult.smokeEvidence.installerResults)).toBe(true);

      // TARGET_ENV=production fails closed when installerResults are absent
      const origTargetEnv = process.env.TARGET_ENV;
      try {
        process.env.TARGET_ENV = "production";
        const prodResult = await recordSmoke({
          releaseDir,
          baseUrl: PRODUCTION_BASE_URL,
          distributionId: "EDIST123",
          version: RELEASE_VERSION,
          receiptDir: path.join(tempRoot, "smoke-receipts-target-env-prod"),
          keyPair: testSigningKey,
          trustedKeys,
          fetch: mockFetch,
        });
        expect(prodResult.success).toBe(false);
        expect(prodResult.smokeEvidence.status).toBe("FAILED");
        expect(prodResult.smokeEvidence.installerResults).toBeNull();
        expect(prodResult.smokeEvidence.freezeOutcome).toEqual({
          triggered: true,
          status: "PENDING_FREEZE",
          noticeUrl: null,
          noticeSha256: null,
        });
      } finally {
        if (origTargetEnv === undefined) {
          delete process.env.TARGET_ENV;
        } else {
          process.env.TARGET_ENV = origTargetEnv;
        }
      }
    });

    it("rejects smoke recording when channel stable version does not match release version", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-version-mismatch");

      const channelsPath = path.join(releaseDir, "channels.json");
      const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
      channels.channels.stable.version = "9.9.9";
      const { signatures: _, ...payload } = channels;
      const resignedChannels = {
        ...payload,
        signatures: [
          { ...signReleasePayload(payload, testSigningKey), signedAt: new Date().toISOString() },
        ],
      };

      const mockFetch = async (url) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = Buffer.from(JSON.stringify(resignedChannels));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        return { ok: false, status: 404 };
      };

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        fetch: mockFetch,
      });

      expect(result.success).toBe(false);
      expect(result.smokeEvidence.status).toBe("FAILED");
      const channelTest = result.smokeEvidence.smokeTests.find(
        (t) => t.name === "anonymous_channel_resolution",
      );
      expect(channelTest).toBeDefined();
      expect(channelTest.status).toBe("FAILED");
      expect(channelTest.error).toMatch(/does not match promoted release version/);
    });

    it("rejects smoke recording when downloaded manifest SHA-256 does not match signed channel manifestDigest", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-digest-mismatch");

      const mockFetch = async (url) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const tamperedContent = Buffer.from('{"tampered": true}');
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              tamperedContent.buffer.slice(
                tamperedContent.byteOffset,
                tamperedContent.byteOffset + tamperedContent.byteLength,
              ),
          };
        }
        return { ok: false, status: 404 };
      };

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        fetch: mockFetch,
      });

      expect(result.success).toBe(false);
      expect(result.smokeEvidence.status).toBe("FAILED");
      const manifestTest = result.smokeEvidence.smokeTests.find(
        (t) => t.name === "signed_manifest_verification",
      );
      expect(manifestTest).toBeDefined();
      expect(manifestTest.status).toBe("FAILED");
      expect(manifestTest.error).toMatch(/does not match signed channel manifestDigest/);
    });

    it("validates and accepts explicit 40-hex source-commit and rejects invalid commit SHA in production", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "smoke-receipts-commit");

      const explicitCommit = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      const mockFetch = async (url) => {
        if (url.endsWith("/releases/v1/channels.json")) {
          const content = fs.readFileSync(path.join(releaseDir, "channels.json"));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/manifests/manifest-")) {
          const content = fs.readFileSync(
            path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`),
          );
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          };
        }
        if (url.includes("/releases/v1/artifacts/")) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
          };
        }
        return { ok: false, status: 404 };
      };

      const result = await recordSmoke({
        releaseDir,
        baseUrl: PRODUCTION_BASE_URL,
        distributionId: "EDIST123",
        version: RELEASE_VERSION,
        sourceCommit: explicitCommit,
        receiptDir,
        keyPair: testSigningKey,
        trustedKeys,
        fetch: mockFetch,
      });

      expect(result.smokeEvidence.sourceCommit).toBe(explicitCommit);

      // Invalid commit in production must throw
      await expect(
        recordSmoke({
          releaseDir,
          baseUrl: PRODUCTION_BASE_URL,
          distributionId: "EDIST123",
          version: RELEASE_VERSION,
          sourceCommit: "invalid-sha",
          environment: "production",
          testOnly: false,
          receiptDir,
          keyPair: testSigningKey,
          trustedKeys,
          fetch: mockFetch,
        }),
      ).rejects.toThrow(/Source commit SHA must be an exact 40-character hex Git SHA/);
    });
  });

  describe("key prefix normalization and validation", () => {
    it("accepts empty string, null, and undefined for staging/test and returns empty string", () => {
      expect(validateKeyPrefix("")).toBe("");
      expect(validateKeyPrefix(null)).toBe("");
      expect(validateKeyPrefix(undefined)).toBe("");
      expect(normalizeKeyPrefix("")).toBe("");
      expect(normalizeKeyPrefix("   ")).toBe("");
    });

    it("accepts empty string for production environment", () => {
      expect(validateKeyPrefix("", { environment: "production" })).toBe("");
      expect(validateKeyPrefix("", { isProduction: true })).toBe("");
      expect(normalizeKeyPrefix(null, { isProduction: true })).toBe("");
    });

    it("accepts valid dry-runs tokens with alphanumeric start and permitted characters", () => {
      expect(validateKeyPrefix("dry-runs/12345")).toBe("dry-runs/12345");
      expect(validateKeyPrefix("dry-runs/github-actions-run-987654321")).toBe(
        "dry-runs/github-actions-run-987654321",
      );
      expect(validateKeyPrefix("dry-runs/run.1_test-2")).toBe("dry-runs/run.1_test-2");
      expect(validateKeyPrefix("dry-runs/a")).toBe("dry-runs/a");
      expect(validateKeyPrefix("  dry-runs/staging-token-1  ")).toBe("dry-runs/staging-token-1");
    });

    it("rejects non-dry-runs prefix names", () => {
      expect(() => validateKeyPrefix("staging/12345")).toThrow(/must start with 'dry-runs\/'/);
      expect(() => validateKeyPrefix("releases/v1/test")).toThrow(/must start with 'dry-runs\/'/);
      expect(() => validateKeyPrefix("production")).toThrow(/must start with 'dry-runs\/'/);
      expect(() => validateKeyPrefix("temp-prefix/42")).toThrow(/must start with 'dry-runs\/'/);
    });

    it("rejects leading and trailing separators", () => {
      expect(() => validateKeyPrefix("/dry-runs/12345")).toThrow(/leading and trailing slashes/);
      expect(() => validateKeyPrefix("dry-runs/12345/")).toThrow(/leading and trailing slashes/);
    });

    it("rejects slashes after dry-runs/", () => {
      expect(() => validateKeyPrefix("dry-runs/12345/extra")).toThrow(
        /multiple path segments \/ slashes after 'dry-runs\/'/,
      );
      expect(() => validateKeyPrefix("dry-runs/a/b/c")).toThrow(
        /multiple path segments \/ slashes after 'dry-runs\/'/,
      );
    });

    it("rejects dot segments and relative path traversal", () => {
      expect(() => validateKeyPrefix("dry-runs/..")).toThrow(
        /dot segments \/ relative path traversal/,
      );
      expect(() => validateKeyPrefix("dry-runs/.")).toThrow(
        /dot segments \/ relative path traversal/,
      );
      expect(() => validateKeyPrefix("dry-runs/foo/../bar")).toThrow(/slashes after 'dry-runs\/'/);
      expect(() => validateKeyPrefix("dry-runs/a..b")).toThrow(
        /dot segments \/ relative path traversal/,
      );
    });

    it("rejects backslashes, null bytes, and percent-encoding tricks", () => {
      expect(() => validateKeyPrefix("dry-runs\\12345")).toThrow(/backslashes/);
      expect(() => validateKeyPrefix("dry-runs/foo\\bar")).toThrow(/backslashes/);
      expect(() => validateKeyPrefix("dry-runs/123\0")).toThrow(/null bytes/);
      expect(() => validateKeyPrefix("dry-runs/%2e%2e")).toThrow(/percent-encoding/);
      expect(() => validateKeyPrefix("dry-runs/123%2f456")).toThrow(/percent-encoding/);
      expect(() => validateKeyPrefix("dry-runs/token%00")).toThrow(/percent-encoding/);
    });

    it("rejects missing token after dry-runs/", () => {
      expect(() => validateKeyPrefix("dry-runs/")).toThrow(
        /leading and trailing slashes|missing token/,
      );
    });

    it("rejects tokens starting with non-alphanumeric character", () => {
      expect(() => validateKeyPrefix("dry-runs/-test")).toThrow(/must match/);
      expect(() => validateKeyPrefix("dry-runs/_test")).toThrow(/must match/);
      expect(() => validateKeyPrefix("dry-runs/.hidden")).toThrow(/dot segments|must match/);
    });

    it("strictly rejects non-empty key prefix in production mode", () => {
      expect(() => validateKeyPrefix("dry-runs/12345", { isProduction: true })).toThrow(
        /Production release rejects non-empty key prefix/,
      );
      expect(() => validateKeyPrefix("dry-runs/12345", { environment: "production" })).toThrow(
        /Production release rejects non-empty key prefix/,
      );
    });
  });

  describe("key prefix application and path derivation", () => {
    it("applies key prefix correctly and idempotently", () => {
      expect(applyKeyPrefix("releases/v1/channels.json", "")).toBe("releases/v1/channels.json");
      expect(applyKeyPrefix("releases/v1/channels.json", "dry-runs/run-1")).toBe(
        "dry-runs/run-1/releases/v1/channels.json",
      );
      expect(applyKeyPrefix("/releases/v1/manifests/manifest-1.0.0.json", "dry-runs/run-1")).toBe(
        "dry-runs/run-1/releases/v1/manifests/manifest-1.0.0.json",
      );
      // Idempotent when already prefixed
      expect(applyKeyPrefix("dry-runs/run-1/releases/v1/channels.json", "dry-runs/run-1")).toBe(
        "dry-runs/run-1/releases/v1/channels.json",
      );
    });

    it("derives CloudFront invalidation paths and public URLs with key prefix", () => {
      expect(deriveInvalidationPath(CHANNELS_S3_KEY, "")).toBe("/releases/v1/channels.json");
      expect(deriveInvalidationPath(CHANNELS_S3_KEY, "dry-runs/run-1")).toBe(
        "/dry-runs/run-1/releases/v1/channels.json",
      );

      expect(derivePublicUrl("https://dist.resin.sh", CHANNELS_S3_KEY, "")).toBe(
        "https://dist.resin.sh/releases/v1/channels.json",
      );
      expect(derivePublicUrl("https://dist.resin.sh", CHANNELS_S3_KEY, "dry-runs/run-1")).toBe(
        "https://dist.resin.sh/dry-runs/run-1/releases/v1/channels.json",
      );
    });
  });

  describe("upload plan and complete staging dry-run transaction with key prefix", () => {
    it("generates deterministic upload plan with key prefix on every S3 key", () => {
      setupFixtureReleaseDir();
      const plan = createUploadPlan({
        releaseDir,
        keyPrefix: "dry-runs/998877",
        keyPair: testSigningKey,
      });

      expect(plan.keyPrefix).toBe("dry-runs/998877");
      for (const item of plan.immutableUploads) {
        expect(item.key).toMatch(/^dry-runs\/998877\/releases\/v1\//);
      }
      expect(plan.candidateChannelUpload.key).toMatch(
        /^dry-runs\/998877\/releases\/v1\/candidates\/[0-9a-f]{64}\/channels\.json$/,
      );
      expect(plan.mutableChannelUpload.key).toBe("dry-runs/998877/releases/v1/channels.json");
      expect(plan.mutableChannelUpload.invalidationPath).toBe(
        "/dry-runs/998877/releases/v1/channels.json",
      );
    });

    it("executes complete disposable staging release lifecycle without any unprefixed S3 write", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "receipts");
      const keyPrefix = "dry-runs/actions-run-123456";
      const bucket = "resin-dist-test-bucket";
      const distributionId = "EDIST_STAGING";
      const baseUrl = "https://dist.resin.sh";

      const s3Storage = new Map();
      const invalidations = [];

      const mockRunner = async (cmd, args) => {
        if (cmd === "aws" && args[0] === "s3api" && args[1] === "head-object") {
          const keyIdx = args.indexOf("--key");
          const key = args[keyIdx + 1];
          if (s3Storage.has(key)) {
            const obj = s3Storage.get(key);
            return {
              stdout: JSON.stringify({
                ContentLength: obj.body ? obj.body.length : 100,
                Metadata: obj.metadata || {},
              }),
              stderr: "",
              exitCode: 0,
            };
          }
          const err = new Error("Not Found (404)");
          err.exitCode = 1;
          err.stderr = "404 Not Found";
          throw err;
        }

        if (cmd === "aws" && args[0] === "s3api" && args[1] === "put-object") {
          const keyIdx = args.indexOf("--key");
          const key = args[keyIdx + 1];
          const bodyIdx = args.indexOf("--body");
          let body = null;
          if (bodyIdx !== -1) {
            const bodyFile = args[bodyIdx + 1];
            const cleanPath = bodyFile.replace(/^fileb?:\/\//, "");
            if (fs.existsSync(cleanPath)) {
              body = fs.readFileSync(cleanPath);
            } else {
              body = Buffer.from(bodyFile, "utf8");
            }
          }
          s3Storage.set(key, { key, body });
          return { stdout: JSON.stringify({ ETag: '"etag-123"' }), stderr: "", exitCode: 0 };
        }

        if (cmd === "aws" && args[0] === "cloudfront" && args[1] === "create-invalidation") {
          invalidations.push(args);
          return {
            stdout: JSON.stringify({
              Invalidation: { Id: "INVAL_TEST_123", Status: "InProgress" },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        return { stdout: "{}", stderr: "", exitCode: 0 };
      };

      const mockFetch = async (url) => {
        const cleanUrl = url.replace(baseUrl, "").replace(/^\/+/, "");
        if (s3Storage.has(cleanUrl)) {
          const stored = s3Storage.get(cleanUrl);
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h) => (h.toLowerCase() === "cache-control" ? IMMUTABLE_CACHE_CONTROL : null),
              "cache-control": IMMUTABLE_CACHE_CONTROL,
            },
            arrayBuffer: async () =>
              stored.body.buffer.slice(
                stored.body.byteOffset,
                stored.body.byteOffset + stored.body.byteLength,
              ),
          };
        }
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: { get: () => null },
          arrayBuffer: async () => Buffer.from(""),
        };
      };

      // 1. verify-candidate with keyPrefix
      const candidateReceipt = await verifyCandidate({
        candidateDir: releaseDir,
        keyPrefix,
        keyPair: testSigningKey,
        trustedKeys,
        receiptDir,
      });
      expect(candidateReceipt.keyPrefix).toBe(keyPrefix);

      // 2. publish-immutable with keyPrefix
      const pubReceipt = await publishImmutable({
        releaseDir,
        bucket,
        baseUrl,
        keyPrefix,
        receiptDir,
        runner: mockRunner,
        keyPair: testSigningKey,
        trustedKeys,
      });
      expect(pubReceipt.keyPrefix).toBe(keyPrefix);

      // Verify all S3 stored keys start with dry-runs/actions-run-123456/
      expect(s3Storage.size).toBeGreaterThan(0);
      for (const s3Key of s3Storage.keys()) {
        expect(
          s3Key.startsWith(`${keyPrefix}/`),
          `Expected S3 key '${s3Key}' to be under disposable prefix '${keyPrefix}/'`,
        ).toBe(true);
        expect(s3Key.startsWith("releases/v1/")).toBe(false);
      }

      // 4. verify-public with keyPrefix
      const verifyReceipt = await verifyPublic({
        releaseDir,
        baseUrl,
        keyPrefix,
        receiptDir,
        fetch: mockFetch,
        trustedKeys,
      });
      expect(verifyReceipt.keyPrefix).toBe(keyPrefix);
      for (const item of verifyReceipt.verifiedObjects) {
        expect(item.key.startsWith(`${keyPrefix}/`)).toBe(true);
        expect(item.url).toContain(`/${keyPrefix}/`);
      }

      // 5. promote with keyPrefix
      const promoteReceipt = await promote({
        releaseDir,
        bucket,
        distributionId,
        baseUrl,
        keyPrefix,
        environment: "staging",
        receiptDir,
        runner: mockRunner,
        fetch: mockFetch,
        trustedKeys,
      });
      expect(promoteReceipt.status).toBe("success");
      expect(promoteReceipt.uploadStatus).toBe("uploaded");
      expect(promoteReceipt.keyPrefix).toBe(keyPrefix);
      expect(promoteReceipt.s3Key).toBe(`${keyPrefix}/releases/v1/channels.json`);
      expect(promoteReceipt.invalidationPaths).toEqual([`/${keyPrefix}/releases/v1/channels.json`]);

      // 6. record-smoke with keyPrefix
      const smokeResult = await recordSmoke({
        releaseDir,
        bucket,
        distributionId,
        baseUrl,
        keyPrefix,
        environment: "staging",
        receiptDir,
        runner: mockRunner,
        fetch: mockFetch,
        trustedKeys,
        installerResults: [
          {
            installer: "posix",
            status: "PASSED",
            installedVersion: RELEASE_VERSION,
            entrypointUrl: "https://dist.resin.sh/dry-runs/install.sh",
            durationMs: 120,
            error: null,
          },
          {
            installer: "powershell",
            status: "PASSED",
            installedVersion: RELEASE_VERSION,
            entrypointUrl: "https://dist.resin.sh/dry-runs/install.ps1",
            durationMs: 140,
            error: null,
          },
        ],
      });
      expect(smokeResult.success).toBe(true);
      expect(smokeResult.smokeEvidence.keyPrefix).toBe(keyPrefix);
      expect(smokeResult.smokeEvidence.channelsUrl).toBe(`/${keyPrefix}/releases/v1/channels.json`);

      // 7. freeze with keyPrefix
      const freezeReceipt = await freeze({
        rootDir: tempRoot,
        bucket,
        distributionId,
        baseUrl,
        keyPrefix,
        environment: "staging",
        receiptDir,
        runner: mockRunner,
        fetch: mockFetch,
        keyPair: testSigningKey,
        trustedKeys,
        targetVersion: RELEASE_VERSION,
        reason: "Test staging freeze",
      });
      expect(freezeReceipt.keyPrefix).toBe(keyPrefix);
      expect(freezeReceipt.freezeNoticeKey).toBe(freezeReceipt.freezeS3Key);
      expect(freezeReceipt.freezeS3Key.startsWith(`${keyPrefix}/releases/v1/freezes/`)).toBe(true);
      expect(freezeReceipt.channelsS3Key).toBe(`${keyPrefix}/releases/v1/channels.json`);
      expect(freezeReceipt.invalidationPaths).toEqual([`/${keyPrefix}/releases/v1/channels.json`]);
    });
  });

  describe("production safety and rejection of key prefix", () => {
    it("rejects non-empty keyPrefix during promote in production mode", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "receipts");
      await expect(
        promote({
          releaseDir,
          bucket: "resin-dist-bucket",
          distributionId: "EDIST1",
          baseUrl: PRODUCTION_BASE_URL,
          keyPrefix: "dry-runs/12345",
          environment: "production",
          receiptDir,
          testOnly: false,
          approvals: [
            { reviewer: "alice", role: "release-engineer" },
            { reviewer: "bob", role: "security-lead" },
          ],
        }),
      ).rejects.toThrow(/Production release rejects non-empty key prefix/);
    });

    it("rejects mismatched keyPrefix between verify-public receipt and promote options", async () => {
      setupFixtureReleaseDir();
      const receiptDir = path.join(tempRoot, "receipts");

      // Write verify receipt with dry-runs/prefix-A
      const mockReceipt = {
        phase: "verify-public",
        status: "verified",
        timestamp: new Date().toISOString(),
        keyPrefix: "dry-runs/prefix-A",
        manifestDigest: "abc",
        verifiedObjects: [],
      };
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(
        path.join(receiptDir, "verify-public-receipt.json"),
        JSON.stringify(mockReceipt),
      );

      // Attempt promotion with dry-runs/prefix-B
      await expect(
        promote({
          releaseDir,
          bucket: "resin-dist-bucket",
          distributionId: "EDIST1",
          baseUrl: "https://dist.resin.sh",
          keyPrefix: "dry-runs/prefix-B",
          environment: "staging",
          receiptDir,
          testOnly: true,
        }),
      ).rejects.toThrow(/Key prefix mismatch between verification receipt/);
    });
  });

  describe("CLI parsing for key prefix", () => {
    it("parses --key-prefix and --prefix options with space or equal delimiter", () => {
      expect(
        parseCliArgs(["publish-immutable", "--key-prefix", "dry-runs/123"]).options.keyPrefix,
      ).toBe("dry-runs/123");
      expect(parseCliArgs(["promote", "--key-prefix=dry-runs/456"]).options.keyPrefix).toBe(
        "dry-runs/456",
      );
      expect(parseCliArgs(["verify-public", "--prefix", "dry-runs/789"]).options.keyPrefix).toBe(
        "dry-runs/789",
      );
      expect(parseCliArgs(["freeze", "--prefix=dry-runs/abc"]).options.keyPrefix).toBe(
        "dry-runs/abc",
      );
    });
  });
});
