import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { CloudCredentialStore } from "@resin/observer";
import {
  ArtifactCache,
  type GeneratedKeyPair,
  encodeDeterministicTar,
  generateBundleKeyPair,
  signBundlePayload,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalArtifactTrustConfigurationError } from "../../src/proxy/local-artifact-trust.js";
import { resolveDenoExecutable } from "../../src/proxy/local-executor.js";
import { createProductionProxyRuntime } from "../../src/proxy/runtime.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const cloudOrigin = "http://127.0.0.1:43123";
const hasDeno = resolveDenoExecutable() !== undefined;

// Local trust intentionally requires POSIX file ownership rather than guessing Windows ACLs.
describe.skipIf(process.getuid === undefined)(
  "explicit local artifact trust through runtime factory",
  () => {
    let root: string;
    let resinHome: string;
    let trustFile: string;
    let key: GeneratedKeyPair;
    let store: CloudCredentialStore;

    beforeEach(async () => {
      vi.stubEnv("RESIN_LOCAL_ARTIFACT_TRUST_FILE", undefined);
      root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-local-trust-"));
      resinHome = path.join(root, ".resin");
      fs.mkdirSync(resinHome, { mode: 0o700 });
      trustFile = path.join(resinHome, "local-artifact-trust.json");
      key = generateBundleKeyPair("ed25519", "local-pinned-key");
      store = new CloudCredentialStore({
        tokenFilePath: path.join(resinHome, "device-token.json"),
      });
      await persistOrigin(cloudOrigin);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    });

    async function persistOrigin(origin: string): Promise<void> {
      const claims = {
        schemaVersion: 1,
        accountId: "acc_local_trust",
        workspaceId: "ws_local_trust",
        deviceId: "dev_local_trust",
        installationId: "inst_local_trust",
        userId: "usr_local_trust",
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["catalog:read", "device:connect"],
      };
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      );
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      await store.persist({
        cloudUrl: origin,
        accessToken: `${header}.${body}.mock-signature`,
        deviceId: claims.deviceId,
        workspaceId: claims.workspaceId,
      });
    }

    function configure(overrides: Record<string, unknown> = {}): void {
      fs.writeFileSync(
        trustFile,
        JSON.stringify({
          version: 1,
          cloudOrigin,
          keyId: key.keyId,
          algorithm: key.algorithm,
          publicKeyPem: key.publicKeyPem,
          ...overrides,
        }),
        { mode: 0o600 },
      );
      vi.stubEnv("RESIN_LOCAL_ARTIFACT_TRUST_FILE", trustFile);
    }

    function createRuntime() {
      return createProductionProxyRuntime({ resinHome, credentialStore: store });
    }

    async function installSignedTool(
      signingKey = key,
      options: { unsigned?: boolean; replaySignature?: boolean } = {},
    ) {
      const manifestBase = {
        id: "local-signed-tool",
        name: "local_signed_tool",
        version: "1.0.0",
        description: "Returns a locally signed result",
        parameters: { type: "object" as const, properties: {} },
        runtime: {
          runtime: "deno" as const,
          memoryLimitMb: 128,
          timeoutMs: 5000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 1048576,
        },
        capabilities: {},
        limits: {
          timeoutMs: 5000,
          maxOutputBytes: 1048576,
          maxMemoryBytes: 134217728,
          maxConcurrentInvocations: 1,
        },
        scope: "workspace" as const,
        createdAt: "2026-09-01T00:00:00.000Z",
      };
      const manifest: ToolManifest = {
        ...manifestBase,
        digest: computeManifestDigest(manifestBase),
      };
      const files = [
        { path: "manifest.json", content: JSON.stringify(manifest) },
        {
          path: "src/index.ts",
          content: "export default async () => ({ localSignature: 'verified' });",
        },
      ];
      const digest = (bytes: string | Buffer) =>
        crypto.createHash("sha256").update(bytes).digest("hex");
      const unsigned = encodeDeterministicTar(files).archive;
      const signature = signBundlePayload(
        digest(unsigned),
        Object.fromEntries(files.map((file) => [file.path, digest(file.content)])),
        signingKey,
      );
      if (options.replaySignature) {
        files[1].content = "export default async () => ({ localSignature: 'forged' });";
      }
      if (!options.unsigned) {
        files.push({ path: "signature.json", content: JSON.stringify(signature) });
      }
      const archive = encodeDeterministicTar(files).archive;
      const artifactDigest = digest(archive);
      const cache = new ArtifactCache({ cacheDir: path.join(resinHome, "data", "artifacts") });
      const staging = await cache.createStagingDirectory(artifactDigest);
      for (const file of files) {
        const target = path.join(staging, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content);
      }
      await cache.commitStagingDirectory(staging, artifactDigest, {
        digest: artifactDigest,
        extractedAt: new Date().toISOString(),
        fileCount: files.length,
        totalSizeBytes: archive.length,
        entrypoint: "src/index.ts",
        verified: true,
      });
      return {
        entry: {
          toolId: manifest.id,
          name: manifest.name,
          version: manifest.version,
          artifactDigest,
          manifestDigest: manifest.digest,
        },
        manifest,
        parameters: {},
        context: resolveWorkspaceContext({ cwd: root }),
      };
    }

    it("does not trust a provisioned development key without explicit opt-in", async () => {
      configure();
      vi.stubEnv("RESIN_LOCAL_ARTIFACT_TRUST_FILE", undefined);
      const request = await installSignedTool();
      const runtime = await createRuntime();
      try {
        const result = await runtime.executor!.execute(request);
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({
            text: expect.stringMatching(/signature verification failed/i),
          }),
        ]);
      } finally {
        await runtime.stop();
      }
    });

    it.each([
      "http://127.0.0.1:43124",
      "http://localhost:43123",
      "https://api.resin.sh",
      "http://127.0.0.1:43123/path",
    ])("refuses a nonmatching or nonloopback pin origin %s", async (origin) => {
      configure({ cloudOrigin: origin });
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it("refuses a matching nonloopback cloud even with an explicit pin", async () => {
      await persistOrigin("https://api.resin.sh");
      configure({ cloudOrigin: "https://api.resin.sh" });
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it.each([
      { version: 2 },
      { allowDevKeys: true },
      { algorithm: "rsa_pss_sha256" },
      { publicKeyPem: "not a public key" },
    ])("rejects malformed or unknown configuration %j", async (override) => {
      configure(override);
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it("rejects private key material instead of silently deriving a public key", async () => {
      configure({ publicKeyPem: key.privateKeyPem });
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it("rejects a public key with the wrong cryptographic algorithm", async () => {
      configure({ publicKeyPem: generateBundleKeyPair("ecdsa_p256_sha256").publicKeyPem });
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it("rejects group-readable trust files and writable profile directories", async () => {
      configure();
      fs.chmodSync(trustFile, 0o640);
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
      fs.chmodSync(trustFile, 0o600);
      fs.chmodSync(resinHome, 0o770);
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it("rejects trust files outside the private profile and symlinked files", async () => {
      configure();
      const outside = path.join(root, "outside.json");
      fs.renameSync(trustFile, outside);
      vi.stubEnv("RESIN_LOCAL_ARTIFACT_TRUST_FILE", outside);
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
      fs.symlinkSync(outside, trustFile);
      vi.stubEnv("RESIN_LOCAL_ARTIFACT_TRUST_FILE", trustFile);
      await expect(createRuntime()).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it("does not activate local trust without a credential origin", async () => {
      configure();
      const missingStore = new CloudCredentialStore({
        tokenFilePath: path.join(resinHome, "missing.json"),
      });
      await expect(
        createProductionProxyRuntime({ resinHome, credentialStore: missingStore }),
      ).rejects.toBeInstanceOf(LocalArtifactTrustConfigurationError);
    });

    it.each(["unprovisioned", "local-pinned-key"])(
      "rejects an unprovisioned signer even when it claims key ID %s",
      async (keyId) => {
        configure();
        const request = await installSignedTool(generateBundleKeyPair("ed25519", keyId));
        const runtime = await createRuntime();
        try {
          const result = await runtime.executor!.execute(request);
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([
            expect.objectContaining({
              text: expect.stringMatching(/signature verification failed/i),
            }),
          ]);
        } finally {
          await runtime.stop();
        }
      },
    );

    it.each([{ unsigned: true }, { replaySignature: true }])(
      "refuses unsigned artifacts and signature replay with a recomputed outer digest: %j",
      async (options) => {
        configure();
        const request = await installSignedTool(key, options);
        const runtime = await createRuntime();
        try {
          const result = await runtime.executor!.execute(request);
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([
            expect.objectContaining({
              text: expect.stringMatching(/signature verification failed/i),
            }),
          ]);
        } finally {
          await runtime.stop();
        }
      },
    );

    it("rejects broader unsigned catalog capabilities beside a correctly signed artifact", async () => {
      configure();
      const request = await installSignedTool();
      const runtime = await createRuntime();
      try {
        const result = await runtime.executor!.execute({
          ...request,
          manifest: {
            ...request.manifest,
            capabilities: {
              ...request.manifest.capabilities,
              command: {
                allowShellExecution: true,
                allowedCommands: ["*"],
                allowedBinaries: ["*"],
                forbiddenPatterns: [],
                allowEnvPassthrough: [],
              },
            },
          },
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          {
            type: "text",
            text: expect.stringMatching(/manifest.*does not match.*manifest/i),
          },
        ]);
      } finally {
        await runtime.stop();
      }
    });

    it.skipIf(!hasDeno)(
      "executes the pinned signed artifact with catalog delivery metadata and no injected executor",
      async () => {
        configure();
        const request = await installSignedTool();
        const catalogManifest = {
          ...request.manifest,
          metadata: { ...request.manifest.metadata, source: "registry" },
        };
        catalogManifest.digest = computeManifestDigest(catalogManifest);
        const runtime = await createRuntime();
        try {
          const result = await runtime.executor!.execute({
            ...request,
            manifest: catalogManifest,
            entry: { ...request.entry, manifestDigest: catalogManifest.digest },
          });
          expect(result.isError).not.toBe(true);
          expect(result.content).toEqual([
            { type: "text", text: JSON.stringify({ localSignature: "verified" }) },
          ]);
        } finally {
          await runtime.stop();
        }
      },
    );
  },
);
