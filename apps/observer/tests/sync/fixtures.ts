import crypto from "node:crypto";
import { type CapabilityEnvelope, type ToolManifest, canonicalJson } from "@resin/contracts";
import type { SigningKeyEntry } from "../../src/sync/types.js";

/**
 * Creates a USTAR tar archive header block for a file entry.
 */
export function createTarHeader(name: string, size: number, mode = 0o644): Buffer {
  const header = Buffer.alloc(512, 0);

  // File name: 0..99
  header.write(name.slice(0, 100), 0, 100, "utf8");

  // File mode: 100..107 (octal ascii)
  const modeStr = mode.toString(8).padStart(7, "0");
  header.write(modeStr, 100, 7, "utf8");

  // UID & GID: 108..123
  header.write("0001000", 108, 7, "utf8");
  header.write("0001000", 116, 7, "utf8");

  // Size: 124..135 (octal ascii)
  const sizeStr = size.toString(8).padStart(11, "0");
  header.write(sizeStr, 124, 11, "utf8");

  // Mtime: 136..147
  const mtimeStr = Math.floor(Date.now() / 1000)
    .toString(8)
    .padStart(11, "0");
  header.write(mtimeStr, 136, 11, "utf8");

  // Typeflag: 156 ('0' = regular file)
  header.write("0", 156, 1, "utf8");

  // Magic & version: 257..264 ("ustar\000")
  header.write("ustar", 257, 5, "utf8");
  header.write("00", 263, 2, "utf8");

  // Checksum calculation (with checksum field treated as 8 spaces)
  header.fill(32, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }

  const checksumStr = checksum.toString(8).padStart(6, "0");
  header.write(checksumStr, 148, 6, "utf8");
  header[154] = 0;
  header[155] = 32;

  return header;
}

/**
 * Builds an in-memory tar archive from file entries.
 */
export function buildTarArchive(files: Array<{ name: string; content: string | Buffer }>): Buffer {
  const buffers: Buffer[] = [];

  for (const file of files) {
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const header = createTarHeader(file.name, data.length);
    buffers.push(header);
    buffers.push(data);

    // Padding to 512 bytes
    const padBytes = (512 - (data.length % 512)) % 512;
    if (padBytes > 0) {
      buffers.push(Buffer.alloc(padBytes, 0));
    }
  }

  // Two 512-byte zero blocks at end of archive
  buffers.push(Buffer.alloc(1024, 0));

  return Buffer.concat(buffers);
}

/**
 * Generates an Ed25519 signing key pair and key store entry.
 */
export function generateTestSigningKey(
  keyId = `key_${crypto.randomUUID()}`,
  trustLevel: "production" | "development" | "revoked" = "production",
): {
  keyId: string;
  keyEntry: SigningKeyEntry;
  privateKeyPem: string;
  signPayload: (payload: string | Buffer) => string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const keyEntry: SigningKeyEntry = {
    keyId,
    algorithm: "ed25519",
    publicKeyPem: publicKey,
    trustLevel,
    createdAt: new Date().toISOString(),
  };

  const signPayload = (payload: string | Buffer): string => {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const signature = crypto.sign(null, buf, privateKey);
    return signature.toString("hex");
  };

  return { keyId, keyEntry, privateKeyPem: privateKey, signPayload };
}

/**
 * Creates a sample valid tool manifest for tests.
 */
export function createSampleToolManifest(
  id = "test-tool",
  version = "1.0.0",
  overrides: Partial<ToolManifest> = {},
): ToolManifest {
  const manifest: ToolManifest = {
    schemaVersion: "1.0.0",
    id,
    name: id,
    version,
    description: "Sample tool for testing deployment sync",
    scope: "workspace",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        result: { type: "string" },
      },
    },
    runtime: {
      runtime: "node",
      minRuntimeVersion: "22.0.0",
      memoryLimitMb: 128,
      timeoutMs: 15000,
      cpuLimitPercent: 80,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: ["src", "dist"],
        writePaths: ["dist"],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [".env", ".git"],
        maxFileSizeBytes: 1048576,
      },
      net: {
        allowOutbound: true,
        allowedDomains: ["api.example.com", "*.trusted.org"],
        allowedHosts: ["api.example.com"],
        allowedPorts: [443, 8443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["git status", "pnpm test"],
        allowedBinaries: ["git", "pnpm"],
        forbiddenPatterns: ["rm -rf", "sudo"],
        allowEnvPassthrough: ["NODE_ENV", "APP_ENV"],
      },
      secrets: {
        allowedSecretNames: ["API_TOKEN", "GITHUB_TOKEN"],
        allowedPrefixes: ["TOOL_"],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 80,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 15000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 15000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
    },
    digest: "",
    metadata: {
      author: "Resin Test Suite",
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };

  manifest.digest = crypto.createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  return manifest;
}

/**
 * Creates a sample workspace capability envelope.
 */
export function createSampleCapabilityEnvelope(
  workspaceId = "ws-test",
  overrides: Partial<CapabilityEnvelope> = {},
): CapabilityEnvelope {
  return {
    envelopeId: `env_${workspaceId}`,
    workspaceId,
    version: "1.0.0",
    fs: {
      readPaths: ["."],
      writePaths: ["dist", "build", "tmp"],
      allowWorkspaceRoot: true,
      allowTemp: true,
      denyPaths: [".env", ".git", "/etc/passwd"],
      maxFileSizeBytes: 10485760,
    },
    net: {
      allowOutbound: true,
      allowedDomains: ["api.example.com", "*.trusted.org", "github.com"],
      allowedHosts: ["api.example.com"],
      allowedPorts: [80, 443, 8080, 8443],
      allowedProtocols: ["https", "http"],
      allowLocalhost: false,
      denyPrivateRanges: true,
    },
    command: {
      allowShellExecution: false,
      allowedCommands: ["git status", "git diff", "pnpm test", "pnpm build"],
      allowedBinaries: ["git", "pnpm", "node"],
      forbiddenPatterns: ["rm -rf", "sudo", ":(){ :|:& };:"],
      allowEnvPassthrough: ["NODE_ENV", "PATH", "HOME", "APP_ENV"],
    },
    secrets: {
      allowedSecretNames: ["API_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"],
      allowedPrefixes: ["TOOL_", "TEST_"],
      denyDirectRead: true,
      injectAsEnv: true,
    },
    limits: {
      maxConcurrentExecutions: 8,
      maxCpuUsagePercent: 100,
      maxMemoryMb: 256,
      maxExecutionTimeMs: 30000,
      maxOutputSizeBytes: 2097152,
    },
    isFrozen: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Creates a complete signed test bundle archive buffer.
 */
export function createSignedTestBundle(
  manifest: ToolManifest,
  signer?: {
    keyId?: string;
    keyEntry?: { keyId: string };
    signPayload: (payload: string | Buffer) => string;
  },
): { archiveBuffer: Buffer; digest: string } {
  const indexJs = 'export default function run(args) { return { result: "ok" }; }';
  const packageJson = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    main: "index.js",
  });

  const files = [
    { name: "index.js", content: indexJs },
    { name: "package.json", content: packageJson },
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
  ];

  // Temporary bundle to compute digests
  const tempArchive = buildTarArchive(files);
  const bundleDigest = crypto.createHash("sha256").update(tempArchive).digest("hex");

  if (signer) {
    const fileDigests: Record<string, string> = {
      "index.js": crypto.createHash("sha256").update(indexJs).digest("hex"),
      "package.json": crypto.createHash("sha256").update(packageJson).digest("hex"),
      "manifest.json": crypto
        .createHash("sha256")
        .update(JSON.stringify(manifest, null, 2))
        .digest("hex"),
    };

    const signedAt = new Date().toISOString();
    const algorithm = "ed25519";

    const canonicalString = canonicalJson({
      algorithm,
      bundleDigest,
      fileDigests,
      keyId: signer.keyId ?? signer.keyEntry?.keyId ?? "unknown",
      signedAt,
    });

    const signatureHex = signer.signPayload(canonicalString);
    const signatureJson = JSON.stringify({
      keyId: signer.keyId ?? signer.keyEntry?.keyId ?? "unknown",
      algorithm,
      signature: signatureHex,
      signatureHex,
      signedAt,
      timestamp: signedAt,
      fileDigests,
      bundleDigest,
    });

    files.push({ name: "signature.json", content: signatureJson });
  }

  const finalArchive = buildTarArchive(files);
  const finalDigest = crypto.createHash("sha256").update(finalArchive).digest("hex");

  return { archiveBuffer: finalArchive, digest: finalDigest };
}
