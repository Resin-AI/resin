import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactInspectionError,
  ArtifactTransferClient,
  DecompressionBombError,
  DigestMismatchError,
  InMemoryKeyStore,
  InvalidSignatureError,
  RevokedSigningKeyError,
  UnknownSigningKeyError,
  UntrustedSigningKeyError,
  parseTarBuffer,
} from "../../src/sync/client.js";
import {
  buildTarArchive,
  createSampleToolManifest,
  createSignedTestBundle,
  generateTestSigningKey,
} from "./fixtures.js";

describe("ArtifactTransferClient", () => {
  it("downloads exact immutable artifact by digest and performs non-executing inspection", async () => {
    const manifest = createSampleToolManifest("formatter-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest);

    const client = new ArtifactTransferClient({
      downloadHandler: async (reqDigest) => {
        if (reqDigest === digest) return archiveBuffer;
        throw new Error("Not found");
      },
    });

    const result = await client.downloadArtifact(digest);
    expect(result.digest).toBe(digest);
    expect(result.sizeBytes).toBe(archiveBuffer.length);
    expect(result.manifest.id).toBe("formatter-tool");
    expect(result.manifest.version).toBe("1.0.0");
    expect(result.inspection.files.length).toBeGreaterThanOrEqual(3);
    expect(result.inspection.files.some((f) => f.path === "manifest.json")).toBe(true);
    expect(result.inspection.files.some((f) => f.path === "index.js")).toBe(true);
  });

  it("throws DigestMismatchError when downloaded bytes do not match expected SHA-256 digest", async () => {
    const manifest = createSampleToolManifest("tampered-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest);

    // Tamper with the buffer
    const corruptedBuffer = Buffer.from(archiveBuffer);
    corruptedBuffer[20] ^= 0xff;

    const client = new ArtifactTransferClient({
      downloadHandler: async () => corruptedBuffer,
    });

    await expect(client.downloadArtifact(digest)).rejects.toThrow(DigestMismatchError);
  });

  it("enforces decompression bomb and max artifact size limit protection", async () => {
    const manifest = createSampleToolManifest("large-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest);

    const client = new ArtifactTransferClient({
      maxArtifactSizeBytes: 100, // Very small limit to trigger error
      downloadHandler: async () => archiveBuffer,
    });

    await expect(client.downloadArtifact(digest)).rejects.toThrow(DecompressionBombError);
  });

  it("verifies Ed25519 cryptographic signature with trusted production key", async () => {
    const { keyEntry, signPayload } = generateTestSigningKey("prod-key-1", "production");
    const keyStore = new InMemoryKeyStore([keyEntry]);

    const manifest = createSampleToolManifest("signed-tool", "2.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, {
      keyId: keyEntry.keyId,
      signPayload,
    });

    const client = new ArtifactTransferClient({
      keyStore,
      verifySignature: true,
      requireSignature: true,
      downloadHandler: async () => archiveBuffer,
    });

    const result = await client.downloadArtifact(digest);
    expect(result.inspection.signature?.valid).toBe(true);
    expect(result.inspection.signature?.keyId).toBe("prod-key-1");
    expect(result.inspection.signature?.trustLevel).toBe("production");
  });

  it("allows development signing keys when allowDevKeys is true and blocks when false", async () => {
    const { keyEntry, signPayload } = generateTestSigningKey("dev-key-1", "development");
    const keyStore = new InMemoryKeyStore([keyEntry]);

    const manifest = createSampleToolManifest("dev-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, {
      keyId: keyEntry.keyId,
      signPayload,
    });

    // 1. With allowDevKeys: true -> succeeds
    const devClient = new ArtifactTransferClient({
      keyStore,
      allowDevKeys: true,
      verifySignature: true,
      downloadHandler: async () => archiveBuffer,
    });

    const result = await devClient.downloadArtifact(digest);
    expect(result.inspection.signature?.valid).toBe(true);
    expect(result.inspection.signature?.trustLevel).toBe("development");

    // 2. With allowDevKeys: false (production mode) -> throws UntrustedSigningKeyError
    const prodClient = new ArtifactTransferClient({
      keyStore,
      allowDevKeys: false,
      verifySignature: true,
      downloadHandler: async () => archiveBuffer,
    });

    await expect(prodClient.downloadArtifact(digest)).rejects.toThrow(UntrustedSigningKeyError);
  });

  it("rejects artifacts signed with revoked keys throwing RevokedSigningKeyError", async () => {
    const { keyEntry, signPayload } = generateTestSigningKey("compromised-key-1", "production");
    const keyStore = new InMemoryKeyStore([keyEntry]);

    const manifest = createSampleToolManifest("compromised-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, {
      keyId: keyEntry.keyId,
      signPayload,
    });

    // Revoke the key in the key store
    await keyStore.revokeKey(keyEntry.keyId);

    const client = new ArtifactTransferClient({
      keyStore,
      verifySignature: true,
      downloadHandler: async () => archiveBuffer,
    });

    await expect(client.downloadArtifact(digest)).rejects.toThrow(RevokedSigningKeyError);
  });

  it("rejects artifacts signed with unknown keys throwing UnknownSigningKeyError", async () => {
    const { signPayload } = generateTestSigningKey("unknown-key-999", "production");
    const keyStore = new InMemoryKeyStore([]); // Empty key store

    const manifest = createSampleToolManifest("unknown-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest, {
      keyId: "unknown-key-999",
      signPayload,
    });

    const client = new ArtifactTransferClient({
      keyStore,
      verifySignature: true,
      downloadHandler: async () => archiveBuffer,
    });

    await expect(client.downloadArtifact(digest)).rejects.toThrow(UnknownSigningKeyError);
  });

  it("detects and rejects dangerous path traversal in bundle tar archive", async () => {
    const manifest = createSampleToolManifest("malicious-tool", "1.0.0");
    const files = [
      { name: "manifest.json", content: JSON.stringify(manifest) },
      { name: "../../../etc/passwd", content: "root:x:0:0:root:/root:/bin/bash" },
    ];
    const archiveBuffer = buildTarArchive(files);
    const digest = crypto.createHash("sha256").update(archiveBuffer).digest("hex");

    const client = new ArtifactTransferClient({
      downloadHandler: async () => archiveBuffer,
    });

    await expect(client.downloadArtifact(digest)).rejects.toThrow(ArtifactInspectionError);
  });

  it("detects and rejects archives missing manifest.json", async () => {
    const files = [{ name: "index.js", content: "console.log('hello');" }];
    const archiveBuffer = buildTarArchive(files);
    const digest = crypto.createHash("sha256").update(archiveBuffer).digest("hex");

    const client = new ArtifactTransferClient({
      downloadHandler: async () => archiveBuffer,
    });

    await expect(client.downloadArtifact(digest)).rejects.toThrow(
      /Archive does not contain manifest\.json/,
    );
  });

  it("caches downloaded artifacts in-memory to prevent redundant network downloads", async () => {
    const manifest = createSampleToolManifest("cached-tool", "1.0.0");
    const { archiveBuffer, digest } = createSignedTestBundle(manifest);

    let downloadCount = 0;
    const client = new ArtifactTransferClient({
      downloadHandler: async () => {
        downloadCount++;
        return archiveBuffer;
      },
    });

    const res1 = await client.downloadArtifact(digest);
    const res2 = await client.downloadArtifact(digest);

    expect(downloadCount).toBe(1);
    expect(res1).toBe(res2);
  });
});
