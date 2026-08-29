import fs from "node:fs";
import path from "node:path";
import {
  type CapabilityManifest,
  type ToolManifest,
  ToolManifestSchema,
  type ToolRuntimeRequirement,
  canonicalJson,
} from "@resin/contracts";
import { computeSha256, parseTarArchive } from "../bundle/builder.js";
import {
  type BundleSignatureData,
  type KeyStore,
  type SignatureVerificationResult,
  createDevelopmentKeyStore,
  verifyBundleSignature,
} from "../bundle/signature.js";
import {
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_PACKAGE,
  BUNDLE_FILE_SIGNATURE,
  BUNDLE_FILE_TESTS_JS,
  BUNDLE_FILE_TESTS_TS,
  type BundleFileEntry,
  type ToolBundleSpec,
} from "../bundle/spec.js";

/**
 * Result of statically inspecting a tool bundle without evaluating any code.
 */
export interface BundleInspectionResult {
  manifest: ToolManifest;
  bundleDigest: string;
  files: BundleFileEntry[];
  totalSizeBytes: number;
  entrypoint: string;
  hasTests: boolean;
  signature?: BundleSignatureData;
  signatureVerification?: SignatureVerificationResult;
  capabilities: CapabilityManifest;
  runtime: ToolRuntimeRequirement;
  packageJson?: ToolBundleSpec["packageJson"];
}

export interface InspectBundleOptions {
  keyStore?: KeyStore;
  allowDevKeys?: boolean;
  verifySignature?: boolean;
}

/**
 * Statically inspects a tar archive buffer or file path without executing code.
 */
export async function inspectBundleArchive(
  archiveBufferOrPath: Buffer | string,
  options: InspectBundleOptions = {},
): Promise<BundleInspectionResult> {
  const archiveBuffer = Buffer.isBuffer(archiveBufferOrPath)
    ? archiveBufferOrPath
    : await fs.promises.readFile(archiveBufferOrPath);

  const bundleDigest = computeSha256(archiveBuffer);
  const rawEntries = parseTarArchive(archiveBuffer);

  const fileMap = new Map<string, Buffer>();
  const files: BundleFileEntry[] = [];

  for (const entry of rawEntries) {
    const fileDigest = computeSha256(entry.content);
    fileMap.set(entry.path, entry.content);
    files.push({
      path: entry.path,
      sizeBytes: entry.size,
      digest: fileDigest,
      mode: entry.mode,
      executable: (entry.mode & 0o111) !== 0,
    });
  }

  // Read and validate manifest.json
  const manifestBuf = fileMap.get(BUNDLE_FILE_MANIFEST);
  if (!manifestBuf) {
    throw new Error(`Bundle is missing required ${BUNDLE_FILE_MANIFEST}`);
  }

  const manifestJson = JSON.parse(manifestBuf.toString("utf8"));
  const manifest = ToolManifestSchema.parse(manifestJson);

  // Read package.json if present
  let packageJson: ToolBundleSpec["packageJson"];
  const pkgBuf = fileMap.get(BUNDLE_FILE_PACKAGE);
  if (pkgBuf) {
    try {
      packageJson = JSON.parse(pkgBuf.toString("utf8"));
    } catch {
      // Ignore package.json parsing error
    }
  }

  // Detect entrypoint
  const entrypoint = fileMap.has(BUNDLE_FILE_ENTRYPOINT_TS)
    ? BUNDLE_FILE_ENTRYPOINT_TS
    : fileMap.has(BUNDLE_FILE_ENTRYPOINT_JS)
      ? BUNDLE_FILE_ENTRYPOINT_JS
      : BUNDLE_FILE_ENTRYPOINT_TS;

  const hasTests = fileMap.has(BUNDLE_FILE_TESTS_TS) || fileMap.has(BUNDLE_FILE_TESTS_JS);

  // Read and optionally verify signature.json
  let signature: BundleSignatureData | undefined;
  let signatureVerification: SignatureVerificationResult | undefined;

  const sigBuf = fileMap.get(BUNDLE_FILE_SIGNATURE);
  if (sigBuf) {
    try {
      signature = JSON.parse(sigBuf.toString("utf8"));
      if (options.verifySignature !== false && signature) {
        const keyStore = options.keyStore ?? createDevelopmentKeyStore();
        signatureVerification = await verifyBundleSignature(signature, keyStore, {
          allowDevKeys: options.allowDevKeys ?? true,
        });
      }
    } catch {
      // Signature parsing failed
    }
  }

  return {
    manifest,
    bundleDigest,
    files,
    totalSizeBytes: archiveBuffer.length,
    entrypoint,
    hasTests,
    signature,
    signatureVerification,
    capabilities: manifest.capabilities,
    runtime: manifest.runtime,
    packageJson,
  };
}

/**
 * Statically inspects an extracted artifact directory without executing code.
 */
export async function inspectBundleDirectory(
  dirPath: string,
  options: InspectBundleOptions = {},
): Promise<BundleInspectionResult> {
  const resolvedDir = path.resolve(dirPath);
  const manifestPath = path.join(resolvedDir, BUNDLE_FILE_MANIFEST);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Directory is missing ${BUNDLE_FILE_MANIFEST}: ${dirPath}`);
  }

  const manifestRaw = await fs.promises.readFile(manifestPath, "utf8");
  const manifest = ToolManifestSchema.parse(JSON.parse(manifestRaw));

  // Collect files
  const files: BundleFileEntry[] = [];
  let totalSizeBytes = 0;

  async function walk(currentDir: string, relativeBase: string) {
    const dirents = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(currentDir, dirent.name);
      const relativePath = relativeBase ? `${relativeBase}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (dirent.isFile()) {
        const content = await fs.promises.readFile(fullPath);
        const stats = await fs.promises.stat(fullPath);
        const digest = computeSha256(content);
        totalSizeBytes += content.length;
        files.push({
          path: relativePath,
          sizeBytes: content.length,
          digest,
          mode: stats.mode & 0o777,
          executable: (stats.mode & 0o111) !== 0,
        });
      }
    }
  }

  await walk(resolvedDir, "");

  // Sort files lexicographically
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Read package.json if present
  let packageJson: ToolBundleSpec["packageJson"];
  const pkgPath = path.join(resolvedDir, BUNDLE_FILE_PACKAGE);
  if (fs.existsSync(pkgPath)) {
    try {
      packageJson = JSON.parse(await fs.promises.readFile(pkgPath, "utf8"));
    } catch {
      // Ignore
    }
  }

  const hasEntrypointTs = fs.existsSync(path.join(resolvedDir, BUNDLE_FILE_ENTRYPOINT_TS));
  const hasEntrypointJs = fs.existsSync(path.join(resolvedDir, BUNDLE_FILE_ENTRYPOINT_JS));
  const entrypoint = hasEntrypointTs
    ? BUNDLE_FILE_ENTRYPOINT_TS
    : hasEntrypointJs
      ? BUNDLE_FILE_ENTRYPOINT_JS
      : BUNDLE_FILE_ENTRYPOINT_TS;

  const hasTests =
    fs.existsSync(path.join(resolvedDir, BUNDLE_FILE_TESTS_TS)) ||
    fs.existsSync(path.join(resolvedDir, BUNDLE_FILE_TESTS_JS));

  // Signature check
  let signature: BundleSignatureData | undefined;
  let signatureVerification: SignatureVerificationResult | undefined;
  const sigPath = path.join(resolvedDir, BUNDLE_FILE_SIGNATURE);
  if (fs.existsSync(sigPath)) {
    try {
      signature = JSON.parse(await fs.promises.readFile(sigPath, "utf8"));
      if (options.verifySignature !== false && signature) {
        const keyStore = options.keyStore ?? createDevelopmentKeyStore();
        signatureVerification = await verifyBundleSignature(signature, keyStore, {
          allowDevKeys: options.allowDevKeys ?? true,
        });
      }
    } catch {
      // Ignore
    }
  }

  const bundleDigest = manifest.digest;

  return {
    manifest,
    bundleDigest,
    files,
    totalSizeBytes,
    entrypoint,
    hasTests,
    signature,
    signatureVerification,
    capabilities: manifest.capabilities,
    runtime: manifest.runtime,
    packageJson,
  };
}

/**
 * Universal inspection entrypoint supporting archives, buffers, and directories.
 */
export async function inspectBundle(
  target: Buffer | string,
  options: InspectBundleOptions = {},
): Promise<BundleInspectionResult> {
  if (!Buffer.isBuffer(target) && fs.existsSync(target)) {
    const stats = await fs.promises.stat(target);
    if (stats.isDirectory()) {
      return inspectBundleDirectory(target, options);
    }
    return inspectBundleArchive(target, options);
  }
  return inspectBundleArchive(target, options);
}

/**
 * Formats inspection result as human-readable diagnostic text.
 */
export function formatInspectionSummary(result: BundleInspectionResult): string {
  const lines: string[] = [
    `Tool Bundle: ${result.manifest.name} (v${result.manifest.version})`,
    `Tool ID: ${result.manifest.id}`,
    `Description: ${result.manifest.description}`,
    `Bundle Digest: ${result.bundleDigest}`,
    `Total Size: ${(result.totalSizeBytes / 1024).toFixed(2)} KB (${result.files.length} files)`,
    `Entrypoint: ${result.entrypoint}`,
    `Has Tests: ${result.hasTests ? "Yes" : "No"}`,
    `Runtime: ${result.runtime.runtime} (Memory: ${result.runtime.memoryLimitMb}MB, Timeout: ${result.runtime.timeoutMs}ms)`,
    `Scope: ${result.manifest.scope}`,
  ];

  if (result.signature) {
    const status = result.signatureVerification?.valid ? "VALID" : "INVALID / UNVERIFIED";
    lines.push(
      `Signature: ${status} (Key: ${result.signature.keyId}, Algorithm: ${result.signature.algorithm})`,
    );
  } else {
    lines.push("Signature: None (unsigned)");
  }

  lines.push("Files:");
  for (const file of result.files) {
    lines.push(
      `  - ${file.path} (${file.sizeBytes} bytes, digest: ${file.digest.slice(0, 12)}...)`,
    );
  }

  return lines.join("\n");
}

/**
 * Formats inspection result as structured canonical JSON.
 */
export function formatInspectionJson(result: BundleInspectionResult): string {
  return canonicalJson(result);
}

/**
 * CLI command runner for static bundle inspection.
 */
export async function cliInspect(argv: string[]): Promise<number> {
  const targetPath = argv[0];
  if (!targetPath) {
    process.stderr.write("Usage: resin-inspect <bundle.tar | artifact-dir>\n");
    return 1;
  }

  try {
    const isJson = argv.includes("--json");
    const result = await inspectBundle(targetPath);

    if (isJson) {
      process.stdout.write(`${formatInspectionJson(result)}\n`);
    } else {
      process.stdout.write(`${formatInspectionSummary(result)}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `Inspection failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
