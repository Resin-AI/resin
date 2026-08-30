import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type QualificationArtifactBundle,
  type ToolManifest,
  ToolManifestSchema,
  canonicalJson,
} from "@resin/contracts";
import {
  type BundleSignatureData,
  type SignBundleOptions,
  signBundlePayload,
} from "./signature.js";
import {
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_PACKAGE,
  BUNDLE_FILE_QUALIFICATION,
  BUNDLE_FILE_SIGNATURE,
  BUNDLE_FILE_TESTS_TS,
  type BundleFileEntry,
  type BundleFormat,
  type ToolBundleSpec,
} from "./spec.js";

export { BUNDLE_FILE_QUALIFICATION };

/**
 * Raw input file definition for bundle construction.
 */
export interface BundleFileInput {
  path: string;
  content: Buffer | string;
  mode?: number;
  executable?: boolean;
}

/**
 * Options for building a deterministic tool bundle.
 */
export interface BuildToolBundleOptions {
  manifest: ToolManifest;
  files?: BundleFileInput[];
  sourceDir?: string;
  entrypoint?: string;
  testsPath?: string;
  packageJson?: ToolBundleSpec["packageJson"] | string;
  format?: BundleFormat;
  signOptions?: SignBundleOptions;
  createdAt?: string;
  qualification?: QualificationArtifactBundle | string | Buffer;
  qualificationBundle?: QualificationArtifactBundle | string | Buffer;
}

/**
 * Result of building a tool bundle.
 */
export interface BuiltToolBundle {
  spec: ToolBundleSpec;
  archiveBuffer: Buffer;
  bundleDigest: string;
  digest: string;
  fileDigests: Record<string, string>;
  files: BundleFileEntry[];
  signature?: BundleSignatureData;
  qualification?: QualificationArtifactBundle;
}

/**
 * Computes SHA-256 hex digest for arbitrary buffer or string.
 */
export function computeSha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Normalizes relative path to forward slashes without leading/trailing slashes.
 */
export function normalizeTarPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized;
}

/**
 * Creates a single 512-byte POSIX ustar tar header.
 */
function createTarHeader(filePath: string, size: number, typeflag = "0", mode = 0o644): Buffer {
  const header = Buffer.alloc(512, 0);

  // name: 100 bytes
  let name = filePath;
  let prefix = "";

  if (Buffer.byteLength(name, "utf8") > 100) {
    // Attempt ustar prefix split
    const splitIndex = name.lastIndexOf("/", 155);
    if (splitIndex > 0 && splitIndex <= 155) {
      prefix = name.slice(0, splitIndex);
      name = name.slice(splitIndex + 1);
    }
  }

  header.write(name, 0, 100, "utf8");

  // mode: 8 bytes (octal string e.g. "0000644\0")
  const modeOctal = (mode & 0o7777).toString(8).padStart(6, "0");
  header.write(`${modeOctal}\0 `, 100, 8, "ascii");

  // uid: 8 bytes
  header.write("0000000\0", 108, 8, "ascii");

  // gid: 8 bytes
  header.write("0000000\0", 116, 8, "ascii");

  // size: 12 bytes (octal string)
  const sizeOctal = size.toString(8).padStart(11, "0");
  header.write(`${sizeOctal} `, 124, 12, "ascii");

  // mtime: 12 bytes (deterministic: 0)
  header.write("00000000000 ", 136, 12, "ascii");

  // typeflag: 1 byte
  header.write(typeflag, 156, 1, "ascii");

  // linkname: 100 bytes (already 0)

  // magic: 6 bytes ("ustar\0")
  header.write("ustar\0", 257, 6, "ascii");

  // version: 2 bytes ("00")
  header.write("00", 263, 2, "ascii");

  // uname & gname: 32 bytes (already 0)

  // prefix: 155 bytes
  if (prefix) {
    header.write(prefix, 345, 155, "utf8");
  }

  // Calculate checksum
  // In POSIX tar, the checksum field is treated as 8 ASCII spaces (0x20) during calculation
  header.fill(0x20, 148, 156);

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }

  const checksumOctal = checksum.toString(8).padStart(6, "0");
  header.write(`${checksumOctal}\0 `, 148, 8, "ascii");

  return header;
}

/**
 * Creates GNU @LongLink tar entry for paths exceeding ustar header limit.
 */
export interface GnuLongLinkEntry {
  header: Buffer;
  body: Buffer;
}

function createGnuLongLink(filePath: string): GnuLongLinkEntry {
  const pathBuf = Buffer.from(filePath, "utf8");
  // Null-terminated path body
  const bodyBuf = Buffer.concat([pathBuf, Buffer.from([0])]);
  const paddingBytes = (512 - (bodyBuf.length % 512)) % 512;
  const paddedBody =
    paddingBytes > 0 ? Buffer.concat([bodyBuf, Buffer.alloc(paddingBytes, 0)]) : bodyBuf;

  const header = createTarHeader("././@LongLink", bodyBuf.length, "L", 0o644);
  return { header, body: paddedBody };
}

/**
 * Encodes an array of files into a deterministic POSIX tar archive buffer.
 *
 * Invariants:
 * 1. File entries are sorted strictly by lexicographical path order.
 * 2. mtime is normalized to 0.
 * 3. uid and gid are normalized to 0.
 * 4. File modes are normalized to 0o644 (or 0o755 if executable).
 */
export interface DeterministicTarResult {
  archive: Buffer;
  fileDigests: Record<string, string>;
  fileEntries: BundleFileEntry[];
}

export function encodeDeterministicTar(files: BundleFileInput[]): DeterministicTarResult {
  // Sort files strictly by lexicographical path order (UTF-8 code unit / code point comparison)
  const sortedFiles = [...files]
    .map((f) => {
      const isExec = Boolean(f.executable || (f.mode && (f.mode & 0o111) !== 0));
      return {
        path: normalizeTarPath(f.path),
        content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8"),
        mode: isExec ? 0o755 : 0o644,
        executable: isExec,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const chunks: Buffer[] = [];
  const fileDigests: Record<string, string> = {};
  const fileEntries: BundleFileEntry[] = [];

  for (const file of sortedFiles) {
    const fileDigest = computeSha256(file.content);
    fileDigests[file.path] = fileDigest;
    fileEntries.push({
      path: file.path,
      sizeBytes: file.content.length,
      digest: fileDigest,
      mode: file.mode,
      executable: file.executable,
    });

    // If path is longer than 100 characters and cannot fit ustar prefix, emit GNU @LongLink
    if (Buffer.byteLength(file.path, "utf8") > 100) {
      const longLink = createGnuLongLink(file.path);
      chunks.push(longLink.header, longLink.body);
    }

    const header = createTarHeader(file.path, file.content.length, "0", file.mode);
    chunks.push(header);

    if (file.content.length > 0) {
      chunks.push(file.content);
      const paddingBytes = (512 - (file.content.length % 512)) % 512;
      if (paddingBytes > 0) {
        chunks.push(Buffer.alloc(paddingBytes, 0));
      }
    }
  }

  // End of archive: two 512-byte blocks of zeros
  chunks.push(Buffer.alloc(1024, 0));

  const archive = Buffer.concat(chunks);
  return { archive, fileDigests, fileEntries };
}

export interface ExtractedTarEntry {
  path: string;
  content: Buffer;
  mode: number;
  typeflag: string;
  size: number;
}

/**
 * Parses a tar archive buffer into a list of file entries.
 */
export function parseTarArchive(archiveBuffer: Buffer): ExtractedTarEntry[] {
  const entries: ExtractedTarEntry[] = [];
  let offset = 0;
  let nextOverridePath: string | null = null;

  while (offset + 512 <= archiveBuffer.length) {
    const header = archiveBuffer.subarray(offset, offset + 512);

    // Check for end of archive (512 consecutive zero bytes)
    const isZeroHeader = header.every((byte) => byte === 0);
    if (isZeroHeader) {
      offset += 512;
      break;
    }

    // Read name
    let name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    if (prefix) {
      name = `${prefix}/${name}`;
    }

    // Read size (octal)
    const sizeStr = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    // Read mode
    const modeStr = header.toString("ascii", 100, 108).replace(/\0.*$/, "").trim();
    const mode = Number.parseInt(modeStr, 8) || 0o644;

    // Read typeflag
    const typeflag = header.toString("ascii", 156, 157) || "0";

    offset += 512;

    if (offset + size > archiveBuffer.length) {
      throw new Error(`Corrupted tar archive: file ${name} truncated`);
    }

    const content = archiveBuffer.subarray(offset, offset + size);
    const padding = (512 - (size % 512)) % 512;
    offset += size + padding;

    if (typeflag === "L") {
      // GNU LongLink
      nextOverridePath = content.toString("utf8").replace(/\0.*$/, "");
      continue;
    }

    const finalPath = nextOverridePath ?? name;
    nextOverridePath = null;

    if (typeflag === "0" || typeflag === "\0") {
      entries.push({
        path: normalizeTarPath(finalPath),
        content: Buffer.from(content),
        mode,
        typeflag: "0",
        size,
      });
    }
  }

  return entries;
}

/**
 * Recursively collects files from a local directory.
 */
export function collectDirectoryFiles(dirPath: string): BundleFileInput[] {
  const files: BundleFileInput[] = [];

  function walk(currentDir: string, relativeBase: string) {
    const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(currentDir, dirent.name);
      const relativePath = relativeBase ? `${relativeBase}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (dirent.isFile()) {
        const stats = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath);
        const executable = (stats.mode & 0o111) !== 0;
        files.push({
          path: relativePath,
          content,
          mode: stats.mode & 0o777,
          executable,
        });
      }
    }
  }

  walk(dirPath, "");
  return files;
}

/**
 * Builds a deterministic tool bundle from manifest and source files.
 */
export async function buildToolBundle(options: BuildToolBundleOptions): Promise<BuiltToolBundle> {
  const validatedManifest = ToolManifestSchema.parse(options.manifest);
  const fileMap = new Map<string, BundleFileInput>();

  // If sourceDir is provided, collect all files from directory
  if (options.sourceDir) {
    const dirFiles = collectDirectoryFiles(options.sourceDir);
    for (const file of dirFiles) {
      fileMap.set(normalizeTarPath(file.path), file);
    }
  }

  // Merge explicit files
  if (options.files) {
    for (const file of options.files) {
      fileMap.set(normalizeTarPath(file.path), file);
    }
  }

  // Ensure manifest.json is present and canonicalized
  const canonicalManifestContent = canonicalJson(validatedManifest);
  fileMap.set(BUNDLE_FILE_MANIFEST, {
    path: BUNDLE_FILE_MANIFEST,
    content: canonicalManifestContent,
    mode: 0o644,
  });

  // Ensure package.json is present
  if (options.packageJson && !fileMap.has(BUNDLE_FILE_PACKAGE)) {
    const pkg = options.packageJson;
    // SAFETY: Object tag check confirms package.json is a raw JSON string.
    const pkgContent =
      Object.prototype.toString.call(pkg) === "[object String]"
        ? (pkg as string)
        : canonicalJson(pkg);
    fileMap.set(BUNDLE_FILE_PACKAGE, {
      path: BUNDLE_FILE_PACKAGE,
      content: pkgContent,
      mode: 0o644,
    });
  } else if (!fileMap.has(BUNDLE_FILE_PACKAGE)) {
    const defaultPackageJson = canonicalJson({
      name: `@resin/generated-${validatedManifest.name}`,
      version: validatedManifest.version,
      type: "module",
      main: options.entrypoint ?? BUNDLE_FILE_ENTRYPOINT_TS,
    });
    fileMap.set(BUNDLE_FILE_PACKAGE, {
      path: BUNDLE_FILE_PACKAGE,
      content: defaultPackageJson,
      mode: 0o644,
    });
  }
  // Ensure qualification.json is present if provided
  const qualificationInput = options.qualification ?? options.qualificationBundle;
  if (qualificationInput) {
    const qual = qualificationInput;
    let qualContent: string | Buffer;
    if (Buffer.isBuffer(qual)) {
      qualContent = qual;
    } else if (Object.prototype.toString.call(qual) === "[object String]") {
      // SAFETY: Object tag check confirms qualification bundle is a serialized string.
      qualContent = qual as string;
    } else {
      qualContent = canonicalJson(qual);
    }
    fileMap.set(BUNDLE_FILE_QUALIFICATION, {
      path: BUNDLE_FILE_QUALIFICATION,
      content: qualContent,
      mode: 0o644,
    });
  }

  // Remove any pre-existing signature.json before computing digest
  fileMap.delete(BUNDLE_FILE_SIGNATURE);

  // Construct initial unsigned deterministic archive to compute canonical bundle digest
  const initialFiles = Array.from(fileMap.values());
  const { archive: unsignedArchive, fileDigests } = encodeDeterministicTar(initialFiles);
  const bundleDigest = computeSha256(unsignedArchive);

  let signatureData: BundleSignatureData | undefined;

  // Sign if signing options are provided
  if (options.signOptions) {
    signatureData = signBundlePayload(bundleDigest, fileDigests, options.signOptions);
    // Embed canonical signature.json in the bundle
    fileMap.set(BUNDLE_FILE_SIGNATURE, {
      path: BUNDLE_FILE_SIGNATURE,
      content: canonicalJson(signatureData),
      mode: 0o644,
    });
  }

  // Final archive build (including signature.json if signed)
  const finalFiles = Array.from(fileMap.values());
  const {
    archive: finalArchive,
    fileDigests: finalDigests,
    fileEntries,
  } = encodeDeterministicTar(finalFiles);
  const finalBundleDigest = signatureData?.bundleDigest ?? computeSha256(finalArchive);
  const createdAt = options.createdAt ?? new Date(0).toISOString();

  const spec: ToolBundleSpec = {
    format: options.format ?? "tar",
    manifest: validatedManifest,
    entrypoint: options.entrypoint ?? BUNDLE_FILE_ENTRYPOINT_TS,
    testsPath:
      options.testsPath ?? (fileMap.has(BUNDLE_FILE_TESTS_TS) ? BUNDLE_FILE_TESTS_TS : undefined),
    // SAFETY: Object tag check confirms packageJson is a parsed record object.
    packageJson:
      options.packageJson &&
      Object.prototype.toString.call(options.packageJson) === "[object Object]"
        ? (options.packageJson as ToolBundleSpec["packageJson"])
        : undefined,
    files: fileEntries,
    bundleDigest: finalBundleDigest,
    signature: signatureData,
    createdAt,
    totalSizeBytes: finalArchive.length,
  };
  let parsedQualification: QualificationArtifactBundle | undefined;
  const qualFile = fileMap.get(BUNDLE_FILE_QUALIFICATION);
  if (qualFile) {
    try {
      const rawQual = Buffer.isBuffer(qualFile.content)
        ? qualFile.content.toString("utf8")
        : qualFile.content;
      parsedQualification = JSON.parse(rawQual);
    } catch {
      parsedQualification = undefined;
    }
  }

  return {
    spec,
    archiveBuffer: finalArchive,
    bundleDigest: finalBundleDigest,
    digest: finalBundleDigest,
    fileDigests: finalDigests,
    files: fileEntries,
    signature: signatureData,
    qualification: parsedQualification,
  };
}

/**
 * Convenience helper to create a bundle directly from a directory path.
 */
export async function createBundleFromDirectory(
  dirPath: string,
  options?: Omit<BuildToolBundleOptions, "sourceDir">,
): Promise<BuiltToolBundle> {
  const manifestPath = path.join(dirPath, BUNDLE_FILE_MANIFEST);
  let manifest: ToolManifest;

  if (options?.manifest) {
    manifest = options.manifest;
  } else if (fs.existsSync(manifestPath)) {
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest = ToolManifestSchema.parse(rawManifest);
  } else {
    throw new Error(
      `Cannot create bundle from directory: missing ${BUNDLE_FILE_MANIFEST} in ${dirPath}`,
    );
  }

  return buildToolBundle({
    ...options,
    manifest,
    sourceDir: dirPath,
  });
}

export { parseTarArchive as extractTarball };
