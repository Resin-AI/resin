import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  buildToolBundle,
  computeSha256,
  createBundleFromDirectory,
  encodeDeterministicTar,
  parseTarArchive,
} from "../src/bundle/builder.js";
import { generateBundleKeyPair } from "../src/bundle/signature.js";
import {
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_PACKAGE,
  BUNDLE_FILE_SIGNATURE,
  BUNDLE_FILE_TESTS_TS,
} from "../src/bundle/spec.js";

const sampleManifest: ToolManifest = {
  id: "test-tool-calculator",
  name: "calculator",
  version: "1.0.0",
  description: "A deterministic arithmetic calculation tool",
  parameters: {
    type: "object",
    properties: {
      a: { type: "number", description: "First operand" },
      b: { type: "number", description: "Second operand" },
      op: { type: "string", description: "Operation" },
    },
    required: ["a", "b", "op"],
    additionalProperties: false,
  },
  runtime: {
    runtime: "deno",
    memoryLimitMb: 128,
    timeoutMs: 5000,
    cpuLimitPercent: 100,
    maxOutputSizeBytes: 1048576,
  },
  capabilities: {
    version: "1.0.0",
    description: "Calculator capabilities",
    fs: {
      read: [],
      write: [],
    },
    net: {
      allowedHosts: [],
      allowDns: false,
    },
    exec: {
      allowedCommands: [],
      allowPipes: false,
    },
    harness: {
      allowRegistration: false,
      allowTelemetry: false,
    },
  },
  limits: {
    timeoutMs: 5000,
    maxOutputBytes: 1048576,
    maxMemoryBytes: 134217728,
    maxConcurrentInvocations: 2,
  },
  scope: "workspace",
  digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  metadata: {},
  createdAt: "2026-08-17T00:00:00.000Z",
};

describe("bundle builder", () => {
  it("produces 100% deterministic archives for identical inputs in different order", async () => {
    const filesSetA = [
      {
        path: "src/index.ts",
        content: "export function add(a: number, b: number) { return a + b; }",
      },
      { path: "tests/index.test.ts", content: "import { add } from '../src/index.js';" },
      { path: "README.txt", content: "Deterministic tool bundle" },
    ];

    const filesSetB = [
      { path: "README.txt", content: "Deterministic tool bundle" },
      { path: "tests/index.test.ts", content: "import { add } from '../src/index.js';" },
      {
        path: "src/index.ts",
        content: "export function add(a: number, b: number) { return a + b; }",
      },
    ];

    const bundleA = await buildToolBundle({
      manifest: sampleManifest,
      files: filesSetA,
      createdAt: "2026-08-17T00:00:00.000Z",
    });

    const bundleB = await buildToolBundle({
      manifest: sampleManifest,
      files: filesSetB,
      createdAt: "2026-08-17T00:00:00.000Z",
    });

    expect(bundleA.bundleDigest).toBe(bundleB.bundleDigest);
    expect(bundleA.archiveBuffer.equals(bundleB.archiveBuffer)).toBe(true);
    expect(bundleA.fileDigests).toEqual(bundleB.fileDigests);
    expect(bundleA.spec.files.length).toBe(bundleB.spec.files.length);
  });

  it("handles long file paths exceeding standard 100-character tar header limit", () => {
    const longPath =
      "src/nested/deeply/sub/submodule/very/long/directory/structure/that/exceeds/one/hundred/characters/index.ts";
    expect(longPath.length).toBeGreaterThan(100);

    const files = [
      { path: longPath, content: "export const deeplyNested = true;" },
      { path: "manifest.json", content: "{}" },
    ];

    const { archive } = encodeDeterministicTar(files);
    const parsed = parseTarArchive(archive);

    expect(parsed.length).toBe(2);
    const longEntry = parsed.find((e) => e.path === longPath);
    expect(longEntry).toBeDefined();
    expect(longEntry?.content.toString("utf8")).toBe("export const deeplyNested = true;");
  });

  it("embeds and validates signature when signing options are provided", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "test-key-001");

    const bundle = await buildToolBundle({
      manifest: sampleManifest,
      files: [{ path: "src/index.ts", content: "export const value = 42;" }],
      signOptions: {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
        signedAt: "2026-08-17T00:00:00.000Z",
      },
      createdAt: "2026-08-17T00:00:00.000Z",
    });

    expect(bundle.signature).toBeDefined();
    expect(bundle.signature?.keyId).toBe("test-key-001");
    expect(bundle.signature?.algorithm).toBe("ed25519");

    const parsedEntries = parseTarArchive(bundle.archiveBuffer);
    const sigEntry = parsedEntries.find((e) => e.path === BUNDLE_FILE_SIGNATURE);
    expect(sigEntry).toBeDefined();

    const parsedSig = JSON.parse(sigEntry!.content.toString("utf8"));
    expect(parsedSig.keyId).toBe("test-key-001");
    expect(parsedSig.signature).toBe(bundle.signature?.signature);
  });

  it("builds a bundle from a local directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-builder-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, BUNDLE_FILE_MANIFEST), JSON.stringify(sampleManifest));
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "export const hello = 'world';");

      const bundle = await createBundleFromDirectory(tempDir);
      expect(bundle.bundleDigest).toBeDefined();
      expect(bundle.files.some((f) => f.path === "src/index.ts")).toBe(true);
      expect(bundle.files.some((f) => f.path === BUNDLE_FILE_MANIFEST)).toBe(true);
      expect(bundle.files.some((f) => f.path === BUNDLE_FILE_PACKAGE)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
