import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";
import type { ManifestAsset } from "./channel-verifier.js";
import type { ReleaseProvenance } from "./release-client.js";

export interface AssetDownloadOptions {
  readonly asset: ManifestAsset;
  readonly downloadDir: string;
  readonly sourceUrlOrPath?: string;
  readonly sourceBuffer?: Buffer;
  readonly fsBridge?: ConfigFsBridge;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: (message: string) => void;
}

export interface DownloadedAssetResult {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly verified: boolean;
}

export interface VersionInstallOptions {
  readonly version: string;
  readonly tarballPathOrBuffer: string | Buffer;
  readonly resinHome: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (message: string) => void;
  readonly provenance?: ReleaseProvenance;
  readonly denoRuntime?: {
    readonly archivePathOrBuffer: string | Buffer;
    readonly version: string;
    readonly sha256?: string;
    readonly executable?: string;
  };
  readonly force?: boolean;
}

export interface VersionInstallResult {
  readonly version: string;
  readonly versionDir: string;
  readonly installedFiles: string[];
  readonly entryPoints: {
    readonly daemon: string;
    readonly mcpShim: string;
    readonly cli: string;
    readonly deno?: string;
  };
}

export interface VersionSwitchOptions {
  readonly resinHome: string;
  readonly targetVersion: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (message: string) => void;
}

export interface VersionSwitchResult {
  readonly activeVersion: string;
  readonly previousVersion: string | null;
  readonly activePath: string;
  readonly rollbackRetained: boolean;
}

export interface RollbackOptions {
  readonly resinHome: string;
  readonly targetVersion?: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (message: string) => void;
}

export interface VersionRollbackResult {
  readonly restoredVersion: string;
  readonly previousVersion: string;
  readonly activePath: string;
}

export interface InstalledVersionJson {
  version?: string;
  denoRuntime?: { version?: string; sha256?: string };
  provenance?: ReleaseProvenance;
  [key: string]:
    | string
    | number
    | boolean
    | null
    | undefined
    | ReleaseProvenance
    | { version?: string; sha256?: string };
}

export interface VersionStateRecord {
  activeVersion: string;
  previousVersion: string | null;
  updatedAt: string;
  installedVersions: string[];
  provenanceByVersion?: Record<string, ReleaseProvenance>;
}

/**
 * Calculates SHA-256 of a Buffer.
 */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const RELEASE_DIRECTORY_MODE = 0o755;
const RELEASE_FILE_MODE = 0o644;
const RELEASE_EXECUTABLE_MODE = 0o755;
const RELEASE_MODE_MASK = 0o7777;
const TAR_BLOCK_SIZE = 512;
const EXACT_RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function normalizeReleaseVersion(version: string): string {
  if (!version || String(version) !== version || version !== version.trim()) {
    throw new Error(
      "Security violation: release version must be a non-empty exact SemVer segment.",
    );
  }

  const cleanVersion = version.startsWith("v") ? version.slice(1) : version;
  if (
    cleanVersion.includes("/") ||
    cleanVersion.includes("\\") ||
    cleanVersion.includes("\0") ||
    cleanVersion === "." ||
    cleanVersion === ".." ||
    !EXACT_RELEASE_VERSION_PATTERN.test(cleanVersion)
  ) {
    throw new Error(
      `Security violation: release version must be one safe exact SemVer segment: '${version}'.`,
    );
  }
  return cleanVersion;
}

function assertDirectChildPath(
  parentDir: string,
  candidatePath: string,
  description: string,
): string {
  const parentRoot = path.resolve(parentDir);
  const candidateRoot = path.resolve(candidatePath);
  const relativePath = path.relative(parentRoot, candidateRoot);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    path.dirname(candidateRoot) !== parentRoot
  ) {
    throw new Error(
      `Security violation: ${description} must be a direct child of '${parentRoot}': '${candidatePath}'.`,
    );
  }
  return candidateRoot;
}

function resolveVersionChildPath(
  versionsDir: string,
  childName: string,
  description: string,
): string {
  if (
    childName.length === 0 ||
    childName === "." ||
    childName === ".." ||
    path.basename(childName) !== childName ||
    childName.includes("/") ||
    childName.includes("\\") ||
    childName.includes("\0")
  ) {
    throw new Error(
      `Security violation: ${description} must use one safe direct-child segment: '${childName}'.`,
    );
  }
  return assertDirectChildPath(versionsDir, path.resolve(versionsDir, childName), description);
}

interface ParsedTarEntry {
  readonly relativePath: string;
  readonly isDirectory: boolean;
  readonly fileSize: number;
  readonly dataOffset: number;
  readonly sanitizedArchiveMode: number;
  readonly archiveMarksExecutable: boolean;
}

function lstatIfExists(filePath: string, fsSync: typeof fs): fs.Stats | null {
  try {
    return fsSync.lstatSync(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      Boolean(error) &&
      error instanceof Object &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function parseTarString(field: Buffer, fieldName: string, headerOffset: number): string {
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  if (terminator !== -1) {
    for (let index = terminator; index < field.length; index += 1) {
      if (field[index] !== 0 && field[index] !== 32) {
        throw new Error(
          `Invalid tar archive: ${fieldName} contains data after its terminator at header offset ${headerOffset}.`,
        );
      }
    }
  }

  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error(
      `Invalid tar archive: ${fieldName} is not valid UTF-8 at header offset ${headerOffset}.`,
    );
  }
  return value;
}

function parseTarOctalField(field: Buffer, fieldName: string, headerOffset: number): number {
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 32)) end -= 1;

  let start = 0;
  while (start < end && field[start] === 32) start += 1;
  if (start === end) return 0;

  let value = 0;
  for (let index = start; index < end; index += 1) {
    const byte = field[index];
    if (byte < 48 || byte > 55) {
      throw new Error(
        `Invalid tar archive: ${fieldName} must be a non-negative octal value at header offset ${headerOffset}.`,
      );
    }
    value = value * 8 + (byte - 48);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Invalid tar archive: ${fieldName} exceeds the safe integer range at header offset ${headerOffset}.`,
      );
    }
  }
  return value;
}

function validateTarHeaderChecksum(headerBlock: Buffer, headerOffset: number): void {
  const expectedChecksum = parseTarOctalField(
    headerBlock.subarray(148, 156),
    "header checksum",
    headerOffset,
  );
  let actualChecksum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : headerBlock[index];
  }
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Invalid tar archive: header checksum mismatch at offset ${headerOffset}; expected ${expectedChecksum}, computed ${actualChecksum}.`,
    );
  }
}

interface ValidatedTarMemberPath {
  relativePath: string;
  directoryHint: boolean;
}

function validateTarMemberPath(fullName: string): ValidatedTarMemberPath {
  const directoryHint = fullName.endsWith("/");
  const pathWithoutTrailingSlash = directoryHint ? fullName.slice(0, -1) : fullName;
  if (
    pathWithoutTrailingSlash.length === 0 ||
    pathWithoutTrailingSlash.startsWith("/") ||
    fullName.includes("\\") ||
    fullName.includes("\0")
  ) {
    throw new Error(
      `Security violation: tar member contains illegal path traversal or a non-portable separator: '${fullName}'.`,
    );
  }

  const segments = pathWithoutTrailingSlash.split("/");
  for (const segment of segments) {
    const windowsBaseName = segment.split(".", 1)[0]?.toUpperCase();
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment !== segment.trim() ||
      segment.endsWith(".") ||
      segment.includes(":") ||
      /[\u0000-\u001f\u007f]/.test(segment) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsBaseName ?? "")
    ) {
      throw new Error(
        `Security violation: tar member contains illegal path traversal or a non-portable segment: '${fullName}'.`,
      );
    }
  }

  return { relativePath: segments.join("/"), directoryHint };
}

function isAllZeroTarBlock(block: Buffer): boolean {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
}

function parseTarEntries(tarData: Buffer): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;
  let foundEndMarker = false;

  while (offset < tarData.length) {
    if (tarData.length - offset < TAR_BLOCK_SIZE) {
      throw new Error(`Invalid tar archive: truncated header at offset ${offset}.`);
    }

    const headerBlock = tarData.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isAllZeroTarBlock(headerBlock)) {
      if (tarData.length - offset < TAR_BLOCK_SIZE * 2) {
        throw new Error("Invalid tar archive: truncated end-of-archive marker.");
      }
      const secondEndBlock = tarData.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2);
      if (!isAllZeroTarBlock(secondEndBlock)) {
        throw new Error(`Invalid tar archive: isolated zero header block at offset ${offset}.`);
      }
      for (let index = offset + TAR_BLOCK_SIZE * 2; index < tarData.length; index += 1) {
        if (tarData[index] !== 0) {
          throw new Error("Invalid tar archive: non-zero data follows the end-of-archive marker.");
        }
      }
      foundEndMarker = true;
      break;
    }

    validateTarHeaderChecksum(headerBlock, offset);
    const rawName = parseTarString(headerBlock.subarray(0, 100), "member name", offset);
    const rawPrefix = parseTarString(headerBlock.subarray(345, 500), "member prefix", offset);
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    if (!fullName) {
      throw new Error(`Invalid tar archive: empty member name at header offset ${offset}.`);
    }
    const { relativePath, directoryHint } = validateTarMemberPath(fullName);

    const parsedMode = parseTarOctalField(headerBlock.subarray(100, 108), "mode", offset);
    const sanitizedArchiveMode = parsedMode & 0o777;
    const archiveMarksExecutable = Boolean(sanitizedArchiveMode & 0o111);
    const fileSize = parseTarOctalField(headerBlock.subarray(124, 136), "size", offset);

    const rawTypeFlag = headerBlock[156];
    const typeFlag = rawTypeFlag === 0 ? "\0" : String.fromCharCode(rawTypeFlag);
    if (typeFlag === "1" || typeFlag === "2") {
      throw new Error(
        `Security violation: symlink or hardlink entry in tar archive is not permitted: '${fullName}'.`,
      );
    }
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "5") {
      throw new Error(
        `Security violation: unsupported or dangerous entry type '${typeFlag}' in tar archive: '${fullName}'.`,
      );
    }
    const isDirectory = typeFlag === "5" || directoryHint;

    const dataOffset = offset + TAR_BLOCK_SIZE;
    const remainingData = tarData.length - dataOffset;
    if (fileSize > remainingData) {
      throw new Error(
        `Invalid tar archive: member '${fullName}' declares ${fileSize} bytes but its payload is truncated.`,
      );
    }
    const paddedSize = Math.ceil(fileSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (!Number.isSafeInteger(paddedSize) || paddedSize < fileSize) {
      throw new Error(`Invalid tar archive: padded size overflows for member '${fullName}'.`);
    }
    if (paddedSize > remainingData) {
      throw new Error(
        `Invalid tar archive: member '${fullName}' has truncated 512-byte payload padding.`,
      );
    }

    entries.push({
      relativePath,
      isDirectory,
      fileSize,
      dataOffset,
      sanitizedArchiveMode,
      archiveMarksExecutable,
    });
    offset = dataOffset + paddedSize;
  }

  if (!foundEndMarker) {
    throw new Error("Invalid tar archive: missing end-of-archive marker.");
  }

  const seenPortablePaths = new Set<string>();
  const regularFilePaths = new Set<string>();
  for (const entry of entries) {
    const portableKey = entry.relativePath.toLowerCase();
    if (seenPortablePaths.has(portableKey)) {
      throw new Error(
        `Invalid tar archive: duplicate or case-colliding member path '${entry.relativePath}'.`,
      );
    }
    seenPortablePaths.add(portableKey);
    if (!entry.isDirectory) regularFilePaths.add(portableKey);
  }
  for (const entry of entries) {
    const segments = entry.relativePath.toLowerCase().split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (regularFilePaths.has(ancestor)) {
        throw new Error(
          `Invalid tar archive: regular file '${ancestor}' is an ancestor of '${entry.relativePath}'.`,
        );
      }
    }
  }

  return entries;
}

function resolveContainedArchivePath(root: string, relativePath: string): string {
  const candidatePath = path.resolve(root, ...relativePath.split("/"));
  const nativeRelativePath = path.relative(root, candidatePath);
  if (
    nativeRelativePath === "" ||
    nativeRelativePath === ".." ||
    nativeRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(nativeRelativePath)
  ) {
    throw new Error(
      `Security violation: archive member resolves outside the extraction root: '${relativePath}'.`,
    );
  }
  return candidatePath;
}

function setSafeDirectoryMode(directoryPath: string, desiredMode: number, fsSync: typeof fs): void {
  const stats = fsSync.lstatSync(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Security violation: archive extraction encountered a linked or non-directory component: '${directoryPath}'.`,
    );
  }
  if (process.platform !== "win32" && (stats.mode & RELEASE_MODE_MASK) !== desiredMode) {
    fsSync.chmodSync(directoryPath, desiredMode);
  }
}

function ensureSafeDirectoryPath(
  root: string,
  relativeDirectory: string,
  explicitDirectoryModes: ReadonlyMap<string, number>,
  fsSync: typeof fs,
): string {
  const rootStats = fsSync.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `Security violation: archive extraction root is no longer a real directory: '${root}'.`,
    );
  }
  if (!relativeDirectory) return root;

  resolveContainedArchivePath(root, relativeDirectory);
  let currentPath = root;
  let portablePath = "";
  for (const segment of relativeDirectory.split("/")) {
    portablePath = portablePath ? `${portablePath}/${segment}` : segment;
    currentPath = path.join(currentPath, segment);
    let stats = lstatIfExists(currentPath, fsSync);
    if (!stats) {
      const desiredMode =
        process.platform === "win32"
          ? (explicitDirectoryModes.get(portablePath) ?? RELEASE_DIRECTORY_MODE)
          : RELEASE_DIRECTORY_MODE;
      try {
        fsSync.mkdirSync(currentPath, { recursive: false, mode: desiredMode });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            Boolean(error) &&
            error instanceof Object &&
            "code" in error &&
            error.code === "EEXIST"
          )
        ) {
          throw error;
        }
      }
      stats = fsSync.lstatSync(currentPath);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Security violation: archive extraction encountered a linked or non-directory component: '${portablePath}'.`,
      );
    }
    const desiredMode =
      process.platform === "win32"
        ? (explicitDirectoryModes.get(portablePath) ?? RELEASE_DIRECTORY_MODE)
        : RELEASE_DIRECTORY_MODE;
    setSafeDirectoryMode(currentPath, desiredMode, fsSync);
  }
  return currentPath;
}

function writeExclusiveRegularFile(
  targetPath: string,
  fileData: Buffer,
  mode: number,
  fsSync: typeof fs,
): void {
  const noFollowFlag = fsSync.constants.O_NOFOLLOW ?? 0;
  const descriptor = fsSync.openSync(
    targetPath,
    fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY | noFollowFlag,
    mode,
  );
  try {
    if (!fsSync.fstatSync(descriptor).isFile()) {
      throw new Error(
        `Security violation: archive extraction did not create a regular file: '${targetPath}'.`,
      );
    }
    fsSync.writeFileSync(descriptor, fileData);
    if (process.platform !== "win32") {
      fsSync.fchmodSync(descriptor, mode);
      if ((fsSync.fstatSync(descriptor).mode & RELEASE_MODE_MASK) !== mode) {
        throw new Error(
          `Integrity violation: archive extraction could not apply mode 0o${mode.toString(8)} to '${targetPath}'.`,
        );
      }
    }
  } finally {
    fsSync.closeSync(descriptor);
  }
}

/**
 * Safe in-memory and on-disk USTAR tar parser and extractor.
 * Avoids any external CLI `tar` dependencies, prevents directory traversal attacks,
 * and rejects dangerous or unsupported tar entry types (symlinks, hardlinks, devices, fifos).
 */
export interface ExtractedTarArchiveResult {
  extractedFiles: string[];
  extractedDirs: string[];
  executableFiles: string[];
}

export function extractTarArchive(
  tarData: Buffer,
  destinationDir: string,
  fsSync = fs,
): ExtractedTarArchiveResult {
  // Validate the complete archive before touching the destination so a malformed later
  // header cannot leave a partially extracted tree behind.
  const entries = parseTarEntries(tarData);
  const root = path.resolve(destinationDir);
  let rootStats = lstatIfExists(root, fsSync);
  if (!rootStats) {
    const parentStats = fsSync.lstatSync(path.dirname(root));
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new Error(
        `Security violation: archive extraction parent must be a real directory: '${path.dirname(root)}'.`,
      );
    }
    fsSync.mkdirSync(root, { recursive: false, mode: 0o700 });
    rootStats = fsSync.lstatSync(root);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `Security violation: archive extraction root must be a real directory: '${destinationDir}'.`,
    );
  }

  const existingTree = scanDirectoryTree(root, fsSync);
  if (existingTree.symlinks.length > 0) {
    throw new Error(
      `Security violation: archive extraction root contains a pre-existing link at '${existingTree.symlinks[0].relativePath}'.`,
    );
  }
  if (existingTree.nonRegularNonDirs.length > 0) {
    throw new Error(
      `Security violation: archive extraction root contains a pre-existing non-regular entry at '${existingTree.nonRegularNonDirs[0].relativePath}'.`,
    );
  }
  if (existingTree.entries.length > 0) {
    throw new Error(
      `Security violation: archive extraction requires an exclusive empty staging directory: '${destinationDir}'.`,
    );
  }

  const extractedFiles: string[] = [];
  const extractedDirs: string[] = [];
  const executableFiles: string[] = [];
  const explicitDirectoryModes = new Map<string, number>();

  for (const entry of entries) {
    const targetPath = resolveContainedArchivePath(root, entry.relativePath);
    if (entry.isDirectory) {
      const directoryMode =
        process.platform === "win32"
          ? entry.sanitizedArchiveMode || RELEASE_DIRECTORY_MODE
          : RELEASE_DIRECTORY_MODE;
      explicitDirectoryModes.set(entry.relativePath, directoryMode);
      ensureSafeDirectoryPath(root, entry.relativePath, explicitDirectoryModes, fsSync);
      setSafeDirectoryMode(targetPath, directoryMode, fsSync);
      extractedDirs.push(targetPath);
      continue;
    }

    const separatorIndex = entry.relativePath.lastIndexOf("/");
    const parentRelativePath =
      separatorIndex === -1 ? "" : entry.relativePath.slice(0, separatorIndex);
    const parentPath = ensureSafeDirectoryPath(
      root,
      parentRelativePath,
      explicitDirectoryModes,
      fsSync,
    );
    if (path.dirname(targetPath) !== parentPath) {
      throw new Error(
        `Security violation: archive file parent escaped the extraction root: '${entry.relativePath}'.`,
      );
    }

    const fileMode =
      process.platform === "win32"
        ? entry.sanitizedArchiveMode || RELEASE_FILE_MODE
        : entry.archiveMarksExecutable
          ? RELEASE_EXECUTABLE_MODE
          : RELEASE_FILE_MODE;
    const fileData = tarData.subarray(entry.dataOffset, entry.dataOffset + entry.fileSize);
    writeExclusiveRegularFile(targetPath, fileData, fileMode, fsSync);
    extractedFiles.push(targetPath);
    if (entry.archiveMarksExecutable) executableFiles.push(targetPath);
  }

  setSafeDirectoryMode(root, RELEASE_DIRECTORY_MODE, fsSync);
  return { extractedFiles, extractedDirs, executableFiles };
}

/**
 * Extracts a .tar.gz (gzipped tarball) buffer into a destination directory.
 */
export function extractTarGzBuffer(
  tarGzBuffer: Buffer,
  destinationDir: string,
  fsSync = fs,
): { extractedFiles: string[]; extractedDirs: string[]; executableFiles: string[] } {
  const decompressedTar = zlib.gunzipSync(tarGzBuffer);
  return extractTarArchive(decompressedTar, destinationDir, fsSync);
}

/**
 * Downloads and verifies a signed release asset.
 */
export async function downloadAndVerifyAsset(
  options: AssetDownloadOptions,
): Promise<DownloadedAssetResult> {
  const { asset, downloadDir } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {});

  await fsBridge.mkdirp(downloadDir);
  await fsPromises.chmod(downloadDir, 0o755).catch(() => {});

  const destinationPath = path.join(downloadDir, asset.filename);
  const tempPath = path.join(downloadDir, `${asset.filename}.download.tmp`);

  let fileBuffer: Buffer;

  if (options.sourceBuffer) {
    fileBuffer = options.sourceBuffer;
  } else if (options.sourceUrlOrPath && !options.sourceUrlOrPath.startsWith("http")) {
    // Local file path
    fileBuffer = await fsPromises.readFile(options.sourceUrlOrPath);
  } else if (options.sourceUrlOrPath && options.sourceUrlOrPath.startsWith("http")) {
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error("No fetch implementation available for asset download.");
    }

    log(`Downloading ${asset.filename} from ${options.sourceUrlOrPath}...`);

    const timeout = options.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetchFn(options.sourceUrlOrPath, {
        signal: controller.signal,
        headers: {
          "User-Agent": "resin-installer/1.0",
          Accept: "application/octet-stream, application/gzip, */*",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to download asset ${asset.filename}: HTTP ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuffer);
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    throw new Error(
      `No source buffer, local path, or URL provided to download asset ${asset.filename}`,
    );
  }

  // Digest verification
  const actualDigest = sha256Hex(fileBuffer);
  if (actualDigest.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error(
      `Cryptographic digest mismatch for asset ${asset.filename}: expected ${asset.sha256}, calculated ${actualDigest}. Download rejected.`,
    );
  }

  // Atomic write to destination via temp file
  await fsPromises.writeFile(tempPath, fileBuffer);
  await fsPromises.chmod(tempPath, 0o644);
  await fsPromises.rename(tempPath, destinationPath);

  log(`Asset ${asset.filename} downloaded and verified successfully (${fileBuffer.length} bytes).`);

  return {
    path: destinationPath,
    sha256: actualDigest,
    sizeBytes: fileBuffer.length,
    verified: true,
  };
}

/**
 * Extracts one named file from a ZIP archive using the central directory. Deno
 * release archives contain one executable and use either store or deflate.
 */
export function extractSingleFileZip(zipBuffer: Buffer, expectedBasename: string): Buffer {
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while (offset < zipBuffer.length - 46) {
    const central = zipBuffer.indexOf(centralSignature, offset);
    if (central < 0) break;
    if (central + 46 > zipBuffer.length) break;

    const method = zipBuffer.readUInt16LE(central + 10);
    const compressedSize = zipBuffer.readUInt32LE(central + 20);
    const nameLength = zipBuffer.readUInt16LE(central + 28);
    const extraLength = zipBuffer.readUInt16LE(central + 30);
    const commentLength = zipBuffer.readUInt16LE(central + 32);
    const localOffset = zipBuffer.readUInt32LE(central + 42);

    const fileName = zipBuffer
      .subarray(central + 46, central + 46 + nameLength)
      .toString("utf8")
      .replace(/\\/g, "/");
    const basename = path.posix.basename(fileName);
    if (basename === expectedBasename) {
      if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error("Deno runtime ZIP contains an invalid local file header.");
      }
      const localNameLength = zipBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
      let output: Buffer;
      if (method === 0) output = Buffer.from(compressed);
      else if (method === 8) output = zlib.inflateRawSync(compressed);
      else throw new Error(`Unsupported ZIP compression method: ${method}`);
      return output;
    }

    offset = central + 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Executable '${expectedBasename}' was not found in runtime archive.`);
}

interface TreeScanEntry {
  readonly relativePath: string;
  readonly fullPath: string;
}

interface TreeScanResult {
  readonly entries: TreeScanEntry[];
  readonly symlinks: TreeScanEntry[];
  readonly nonRegularNonDirs: TreeScanEntry[];
}

function scanDirectoryTree(baseDir: string, fsSync: typeof fs = fs): TreeScanResult {
  const root = path.resolve(baseDir);
  const entries: TreeScanEntry[] = [];
  const symlinks: TreeScanEntry[] = [];
  const nonRegularNonDirs: TreeScanEntry[] = [];

  function traverse(currentDir: string): void {
    if (!fsSync.existsSync(currentDir)) return;
    const directoryEntries = fsSync.readdirSync(currentDir, { withFileTypes: true });
    for (const directoryEntry of directoryEntries) {
      const fullPath = path.join(currentDir, directoryEntry.name);
      const nativeRelativePath = path.relative(root, fullPath);
      if (
        nativeRelativePath === "" ||
        nativeRelativePath === ".." ||
        nativeRelativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(nativeRelativePath)
      ) {
        throw new Error(
          `Security violation: scanned release entry escaped its root: '${fullPath}'.`,
        );
      }
      const relativePath = nativeRelativePath.split(path.sep).join("/");
      if (
        relativePath.includes("\\") ||
        relativePath.split("/").some((segment) => segment === "..")
      ) {
        throw new Error(
          `Security violation: scanned release entry contains a non-portable path: '${nativeRelativePath}'.`,
        );
      }

      let stats: fs.Stats;
      try {
        stats = fsSync.lstatSync(fullPath);
      } catch {
        continue;
      }

      const scannedEntry = { relativePath, fullPath };
      entries.push(scannedEntry);
      if (stats.isSymbolicLink()) {
        symlinks.push(scannedEntry);
      } else if (stats.isDirectory()) {
        traverse(fullPath);
      } else if (!stats.isFile()) {
        nonRegularNonDirs.push(scannedEntry);
      }
    }
  }

  traverse(root);
  return { entries, symlinks, nonRegularNonDirs };
}

function normalizeReleaseTreeModes(
  baseDir: string,
  executablePaths: ReadonlySet<string>,
): ReadonlySet<string> {
  const root = path.resolve(baseDir);
  const executableRelativePaths = new Set<string>();

  for (const executablePath of executablePaths) {
    const relativePath = path.relative(root, path.resolve(executablePath));
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(
        `Security violation: executable permission policy points outside the release tree: '${executablePath}'.`,
      );
    }
    const portableRelativePath = relativePath.split(path.sep).join("/");
    if (portableRelativePath.includes("\\")) {
      throw new Error(
        `Security violation: executable permission policy contains a non-portable path: '${executablePath}'.`,
      );
    }
    executableRelativePaths.add(portableRelativePath);
  }

  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `Security violation: release staging root must be a real directory: '${baseDir}'.`,
    );
  }

  const scan = scanDirectoryTree(root);
  if (scan.symlinks.length > 0) {
    throw new Error(
      `Security violation: symlink detected in release staging tree at '${scan.symlinks[0].relativePath}'.`,
    );
  }
  if (scan.nonRegularNonDirs.length > 0) {
    throw new Error(
      `Security violation: non-regular file detected in release staging tree at '${scan.nonRegularNonDirs[0].relativePath}'.`,
    );
  }

  // Windows permission bits are not meaningful, but the link/non-regular scan above is.
  if (process.platform === "win32") return executableRelativePaths;

  if ((rootStats.mode & RELEASE_MODE_MASK) !== RELEASE_DIRECTORY_MODE) {
    fs.chmodSync(root, RELEASE_DIRECTORY_MODE);
  }
  for (const entry of scan.entries) {
    const stats = fs.lstatSync(entry.fullPath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new Error(
        `Security violation: release entry changed type during mode normalization at '${entry.relativePath}'.`,
      );
    }
    const expectedMode = stats.isDirectory()
      ? RELEASE_DIRECTORY_MODE
      : executableRelativePaths.has(entry.relativePath)
        ? RELEASE_EXECUTABLE_MODE
        : RELEASE_FILE_MODE;
    if ((stats.mode & RELEASE_MODE_MASK) !== expectedMode) {
      fs.chmodSync(entry.fullPath, expectedMode);
    }
  }

  return executableRelativePaths;
}

function verifyInstalledVersionTree(
  targetDir: string,
  stagingDir: string,
  cleanVersion: string,
  expectedTarSha256: string,
  expectedExecutableFiles: ReadonlySet<string>,
  expectedProvenance?: ReleaseProvenance,
  expectedDenoRuntime?: { version: string; sha256?: string },
): void {
  const targetRootStat = fs.lstatSync(targetDir);
  if (targetRootStat.isSymbolicLink() || !targetRootStat.isDirectory()) {
    throw new Error(
      `Security violation: installed version root must be a real directory: '${targetDir}'.`,
    );
  }
  if (
    process.platform !== "win32" &&
    (targetRootStat.mode & RELEASE_MODE_MASK) !== RELEASE_DIRECTORY_MODE
  ) {
    throw new Error(
      `Integrity violation: directory permission mode drift at '.': expected 0o${RELEASE_DIRECTORY_MODE.toString(8)}, got 0o${(targetRootStat.mode & RELEASE_MODE_MASK).toString(8)}.`,
    );
  }

  const targetScan = scanDirectoryTree(targetDir);

  if (targetScan.symlinks.length > 0) {
    throw new Error(
      `Security violation: symlink detected in installed version tree at '${targetScan.symlinks[0].relativePath}'. Existing installation is untrusted.`,
    );
  }
  if (targetScan.nonRegularNonDirs.length > 0) {
    throw new Error(
      `Security violation: non-regular file detected in installed version tree at '${targetScan.nonRegularNonDirs[0].relativePath}'. Existing installation is untrusted.`,
    );
  }

  const stagingScan = scanDirectoryTree(stagingDir);
  if (stagingScan.symlinks.length > 0 || stagingScan.nonRegularNonDirs.length > 0) {
    throw new Error("Security violation: release staging tree changed type during verification.");
  }

  const stagingEntriesByPath = new Map<string, TreeScanEntry>();
  for (const stagingEntry of stagingScan.entries) {
    stagingEntriesByPath.set(stagingEntry.relativePath, stagingEntry);
  }
  for (const targetEntry of targetScan.entries) {
    if (!stagingEntriesByPath.has(targetEntry.relativePath)) {
      throw new Error(
        `Integrity violation: extra unexpected file or directory detected in installed version tree at '${targetEntry.relativePath}'.`,
      );
    }
  }

  const targetEntriesByPath = new Map<string, TreeScanEntry>();
  for (const targetEntry of targetScan.entries) {
    targetEntriesByPath.set(targetEntry.relativePath, targetEntry);
  }
  for (const stagingEntry of stagingScan.entries) {
    if (!targetEntriesByPath.has(stagingEntry.relativePath)) {
      throw new Error(
        `Integrity violation: missing file or directory in installed version tree at '${stagingEntry.relativePath}'.`,
      );
    }
  }

  for (const stagingEntry of stagingScan.entries) {
    const relPath = stagingEntry.relativePath;
    const targetEntry = targetEntriesByPath.get(relPath);
    if (!targetEntry) {
      throw new Error(`Integrity violation: missing installed release entry '${relPath}'.`);
    }
    const targetPath = targetEntry.fullPath;
    const stagingPath = stagingEntry.fullPath;

    const targetStat = fs.lstatSync(targetPath);
    const stagingStat = fs.lstatSync(stagingPath);

    if (stagingStat.isDirectory()) {
      if (!targetStat.isDirectory()) {
        throw new Error(
          `Integrity violation: expected directory at '${relPath}', but found non-directory in installed version tree.`,
        );
      }
      if (
        process.platform !== "win32" &&
        (targetStat.mode & RELEASE_MODE_MASK) !== RELEASE_DIRECTORY_MODE
      ) {
        throw new Error(
          `Integrity violation: directory permission mode drift at '${relPath}': expected 0o${RELEASE_DIRECTORY_MODE.toString(8)}, got 0o${(targetStat.mode & RELEASE_MODE_MASK).toString(8)}.`,
        );
      }
      continue;
    }

    if (!targetStat.isFile()) {
      throw new Error(
        `Integrity violation: expected regular file at '${relPath}', but found non-regular file in installed version tree.`,
      );
    }

    if (process.platform !== "win32") {
      const targetMode = targetStat.mode & RELEASE_MODE_MASK;
      const expectedMode = expectedExecutableFiles.has(relPath)
        ? RELEASE_EXECUTABLE_MODE
        : RELEASE_FILE_MODE;
      if (targetMode !== expectedMode) {
        throw new Error(
          `Integrity violation: file permission mode drift at '${relPath}': expected 0o${expectedMode.toString(8)}, got 0o${targetMode.toString(8)}.`,
        );
      }
    }

    if (relPath === "version.json") {
      let parsedTarget: InstalledVersionJson;
      try {
        parsedTarget = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      } catch (parseErr) {
        throw new Error(
          `Integrity violation: installed version.json metadata is corrupted or invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
      }

      if (parsedTarget.version !== cleanVersion) {
        throw new Error(
          `Integrity violation: version.json version mismatch: expected '${cleanVersion}', got '${parsedTarget.version}'`,
        );
      }

      if (parsedTarget.sha256 !== expectedTarSha256) {
        throw new Error(
          `Integrity violation: version.json SHA-256 mismatch: expected '${expectedTarSha256}', got '${parsedTarget.sha256}'`,
        );
      }

      if (expectedProvenance) {
        const targetProv = JSON.stringify(parsedTarget.provenance ?? null);
        const expProv = JSON.stringify(expectedProvenance);
        if (targetProv !== expProv) {
          throw new Error(
            `Integrity violation: version.json provenance mismatch against expected release provenance.`,
          );
        }
      }

      if (expectedDenoRuntime) {
        const targetDeno = parsedTarget.denoRuntime;
        if (!targetDeno || targetDeno.version !== expectedDenoRuntime.version) {
          throw new Error(
            `Integrity violation: version.json denoRuntime version mismatch: expected '${expectedDenoRuntime.version}', got '${targetDeno?.version}'`,
          );
        }
        if (expectedDenoRuntime.sha256 && targetDeno.sha256 !== expectedDenoRuntime.sha256) {
          throw new Error(
            `Integrity violation: version.json denoRuntime digest mismatch: expected '${expectedDenoRuntime.sha256}', got '${targetDeno?.sha256}'`,
          );
        }
      } else if (parsedTarget.denoRuntime) {
        throw new Error(
          `Integrity violation: version.json contains unexpected denoRuntime metadata.`,
        );
      }
      continue;
    }

    if (targetStat.size !== stagingStat.size) {
      throw new Error(
        `Integrity violation: file size mismatch at '${relPath}': expected ${stagingStat.size} bytes, got ${targetStat.size} bytes.`,
      );
    }

    const targetBytes = fs.readFileSync(targetPath);
    const stagingBytes = fs.readFileSync(stagingPath);
    if (Buffer.compare(targetBytes, stagingBytes) !== 0) {
      throw new Error(
        `Integrity violation: byte-for-byte content mismatch at '${relPath}'. Installed file does not match verified release payload.`,
      );
    }
  }
}

/**
 * Installs a release package into the versioned installation directory layout.
 * Enforces byte-for-byte and release-policy mode validation on existing-version idempotence.
 * Replaces target version directories atomically via temp + rename without dropping active state.
 */
export async function installReleaseVersion(
  options: VersionInstallOptions,
): Promise<VersionInstallResult> {
  const { version, tarballPathOrBuffer, resinHome } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {});

  const cleanVersion = normalizeReleaseVersion(version);
  const versionsDir = path.resolve(resinHome, "versions");
  const targetVersionDir = resolveVersionChildPath(
    versionsDir,
    `v${cleanVersion}`,
    "release version directory",
  );

  await fsBridge.mkdirp(versionsDir);
  const versionsDirStats = await fsPromises.lstat(versionsDir);
  if (versionsDirStats.isSymbolicLink() || !versionsDirStats.isDirectory()) {
    throw new Error(
      `Security violation: release versions path must be a real directory: '${versionsDir}'.`,
    );
  }
  if (process.platform !== "win32") {
    await fsPromises.chmod(versionsDir, RELEASE_DIRECTORY_MODE);
  }

  const stagingDir = resolveVersionChildPath(
    versionsDir,
    `.staging-v${cleanVersion}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    "release staging directory",
  );

  let tarGzBuffer: Buffer;
  if (Buffer.isBuffer(tarballPathOrBuffer)) {
    tarGzBuffer = tarballPathOrBuffer;
  } else {
    tarGzBuffer = await fsPromises.readFile(tarballPathOrBuffer);
  }
  const tarSha256 = sha256Hex(tarGzBuffer);
  let stagingCreated = false;

  try {
    log(`Extracting release archive for version v${cleanVersion} into staging directory...`);
    await fsPromises.mkdir(stagingDir, { recursive: false, mode: 0o700 });
    stagingCreated = true;
    if (process.platform !== "win32") {
      await fsPromises.chmod(stagingDir, 0o700);
    }

    let { extractedFiles, executableFiles } = extractTarGzBuffer(tarGzBuffer, stagingDir);

    const stagingEntries = await fsPromises.readdir(stagingDir, { withFileTypes: true });
    if (
      stagingEntries.length === 1 &&
      stagingEntries[0].name === "resin" &&
      stagingEntries[0].isDirectory()
    ) {
      const packagedRoot = path.join(stagingDir, "resin");
      for (const entry of await fsPromises.readdir(packagedRoot)) {
        await fsPromises.rename(path.join(packagedRoot, entry), path.join(stagingDir, entry));
      }
      await fsPromises.rmdir(packagedRoot);
      extractedFiles = extractedFiles.map((filePath) =>
        path.join(stagingDir, path.relative(packagedRoot, filePath)),
      );
      executableFiles = executableFiles.map((filePath) =>
        path.join(stagingDir, path.relative(packagedRoot, filePath)),
      );
    }

    const trustedExecutablePaths = new Set(
      executableFiles.map((filePath) => path.resolve(filePath)),
    );

    if (options.denoRuntime) {
      const runtimeBuffer = Buffer.isBuffer(options.denoRuntime.archivePathOrBuffer)
        ? options.denoRuntime.archivePathOrBuffer
        : await fsPromises.readFile(options.denoRuntime.archivePathOrBuffer);
      const runtimeDigest = sha256Hex(runtimeBuffer);

      if (
        options.denoRuntime.sha256 &&
        runtimeDigest.toLowerCase() !== options.denoRuntime.sha256.toLowerCase()
      ) {
        throw new Error(
          `Deno runtime digest mismatch: expected ${options.denoRuntime.sha256}, got ${runtimeDigest}`,
        );
      }

      const denoDir = path.join(stagingDir, "deno");
      await fsBridge.mkdirp(denoDir);
      await fsPromises.chmod(denoDir, 0o755).catch(() => {});

      const denoExecutableName = process.platform === "win32" ? "deno.exe" : "deno";
      const denoExecutable = extractSingleFileZip(runtimeBuffer, denoExecutableName);
      const denoTarget = path.join(denoDir, denoExecutableName);
      await fsPromises.writeFile(denoTarget, denoExecutable, {
        mode: 0o755,
      });
      await fsPromises.chmod(denoTarget, 0o755);
      extractedFiles.push(denoTarget);
      trustedExecutablePaths.add(path.resolve(denoTarget));
    }

    const stagingBin = path.join(stagingDir, "bin");
    await fsBridge.mkdirp(stagingBin);
    await fsPromises.chmod(stagingBin, 0o755).catch(() => {});

    const expectedCli = path.join(stagingDir, "bin", "resin");
    const expectedDaemon = path.join(stagingDir, "bin", "resin-daemon");
    const expectedMcp = path.join(stagingDir, "bin", "resin-mcp");
    trustedExecutablePaths.add(path.resolve(expectedCli));
    trustedExecutablePaths.add(path.resolve(expectedDaemon));
    trustedExecutablePaths.add(path.resolve(expectedMcp));

    if (!fs.existsSync(expectedCli)) {
      await fsPromises.writeFile(
        expectedCli,
        `#!/usr/bin/env node\nimport path from "node:path";\nimport process from "node:process";\nimport { fileURLToPath } from "node:url";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst { main } = await import(path.resolve(__dirname, "../apps/cli/dist/bin/cli.js"));\nif (main instanceof Function) {\n  try {\n    const exitCode = await main(process.argv.slice(2));\n    if (Number.isInteger(exitCode) && exitCode !== 0) {\n      process.exit(exitCode);\n    }\n  } catch (err) {\n    process.stderr.write(\`Fatal error: \${err instanceof Error ? err.message : String(err)}\\n\`);\n    process.exit(1);\n  }\n}\n`,
        { mode: 0o755 },
      );
      await fsPromises.chmod(expectedCli, 0o755);
      extractedFiles.push(expectedCli);
    }

    if (!fs.existsSync(expectedDaemon)) {
      await fsPromises.writeFile(
        expectedDaemon,
        `#!/usr/bin/env node\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nawait import(path.resolve(__dirname, "../apps/daemon/dist/bin/resin-daemon.js"));\n`,
        { mode: 0o755 },
      );
      extractedFiles.push(expectedDaemon);
      await fsPromises.chmod(expectedDaemon, 0o755);
    }

    if (!fs.existsSync(expectedMcp)) {
      await fsPromises.writeFile(
        expectedMcp,
        `#!/usr/bin/env node\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nawait import(path.resolve(__dirname, "../apps/gateway/dist/bin/mcp-shim.js"));\n`,
        { mode: 0o755 },
      );
      extractedFiles.push(expectedMcp);
      await fsPromises.chmod(expectedMcp, 0o755);
    }

    const versionMetadataPath = path.join(stagingDir, "version.json");
    const versionInfo = {
      version: cleanVersion,
      installedAt: new Date().toISOString(),
      sha256: tarSha256,
      provenance: options.provenance,
      denoRuntime: options.denoRuntime
        ? { version: options.denoRuntime.version, sha256: options.denoRuntime.sha256 }
        : undefined,
    };
    await fsPromises.writeFile(versionMetadataPath, JSON.stringify(versionInfo, null, 2), {
      mode: 0o644,
      encoding: "utf8",
    });
    extractedFiles.push(versionMetadataPath);
    await fsPromises.chmod(versionMetadataPath, 0o644);
    trustedExecutablePaths.delete(path.resolve(versionMetadataPath));
    const expectedExecutableFiles = normalizeReleaseTreeModes(stagingDir, trustedExecutablePaths);

    const targetStats = lstatIfExists(targetVersionDir, fs);
    const targetExists = targetStats !== null;
    if (targetStats && (targetStats.isSymbolicLink() || !targetStats.isDirectory())) {
      throw new Error(
        `Security violation: release version target must be a real directory: '${targetVersionDir}'.`,
      );
    }

    if (targetExists && !options.force) {
      log(`Validating existing installation at ${targetVersionDir}...`);
      verifyInstalledVersionTree(
        targetVersionDir,
        stagingDir,
        cleanVersion,
        tarSha256,
        expectedExecutableFiles,
        options.provenance,
        options.denoRuntime
          ? { version: options.denoRuntime.version, sha256: options.denoRuntime.sha256 }
          : undefined,
      );

      await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      stagingCreated = false;
      log(
        `Version v${cleanVersion} is already installed and verified valid, reusing existing files.`,
      );

      const scanResult = scanDirectoryTree(targetVersionDir);
      const installedFilePaths = scanResult.entries
        .map((entry) => entry.fullPath)
        .filter((installedPath) => {
          try {
            return fs.lstatSync(installedPath).isFile();
          } catch {
            return false;
          }
        });

      return {
        version: cleanVersion,
        versionDir: targetVersionDir,
        installedFiles: installedFilePaths,
        entryPoints: {
          daemon: path.join(targetVersionDir, "bin", "resin-daemon"),
          mcpShim: path.join(targetVersionDir, "bin", "resin-mcp"),
          cli: path.join(targetVersionDir, "bin", "resin"),
          deno: fs.existsSync(
            path.join(targetVersionDir, "deno", process.platform === "win32" ? "deno.exe" : "deno"),
          )
            ? path.join(
                targetVersionDir,
                "deno",
                process.platform === "win32" ? "deno.exe" : "deno",
              )
            : undefined,
        },
      };
    }

    if (targetExists) {
      const backupDir = resolveVersionChildPath(
        versionsDir,
        `.backup-v${cleanVersion}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
        "release backup directory",
      );
      await fsPromises.rename(targetVersionDir, backupDir);
      try {
        await fsPromises.rename(stagingDir, targetVersionDir);
        stagingCreated = false;
      } catch (renameErr) {
        await fsPromises.rename(backupDir, targetVersionDir).catch(() => {});
        throw renameErr;
      }
      await fsPromises.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await fsPromises.rename(stagingDir, targetVersionDir);
      stagingCreated = false;
    }

    log(`Release version v${cleanVersion} installed successfully at ${targetVersionDir}.`);

    return {
      version: cleanVersion,
      versionDir: targetVersionDir,
      installedFiles: extractedFiles.map((f) => f.replace(stagingDir, targetVersionDir)),
      entryPoints: {
        daemon: path.join(targetVersionDir, "bin", "resin-daemon"),
        mcpShim: path.join(targetVersionDir, "bin", "resin-mcp"),
        cli: path.join(targetVersionDir, "bin", "resin"),
        deno: fs.existsSync(
          path.join(targetVersionDir, "deno", process.platform === "win32" ? "deno.exe" : "deno"),
        )
          ? path.join(targetVersionDir, "deno", process.platform === "win32" ? "deno.exe" : "deno")
          : undefined,
      },
    };
  } catch (error) {
    if (stagingCreated) {
      await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Atomically switches the active version pointer to a new version, retaining the previous known good version for rollback.
 * Updates current/previous pointers, global bin shims, and version-state.json atomically via temp + rename with full rollback on failure.
 */
export async function switchActiveVersion(
  options: VersionSwitchOptions,
): Promise<VersionSwitchResult> {
  const { resinHome, targetVersion } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {});

  const cleanTarget = normalizeReleaseVersion(targetVersion);
  const versionsDir = path.resolve(resinHome, "versions");
  const targetVersionDir = resolveVersionChildPath(
    versionsDir,
    `v${cleanTarget}`,
    "active release version directory",
  );

  const versionsStats = lstatIfExists(versionsDir, fs);
  if (!versionsStats || versionsStats.isSymbolicLink() || !versionsStats.isDirectory()) {
    throw new Error(
      `Security violation: release versions path must be a real directory: '${versionsDir}'.`,
    );
  }
  if (!(await fsBridge.exists(targetVersionDir)) || !fs.existsSync(targetVersionDir)) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: directory does not exist at ${targetVersionDir}`,
    );
  }
  const targetStats = fs.lstatSync(targetVersionDir);
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new Error(
      `Security violation: active release target must be a real direct-child directory: '${targetVersionDir}'.`,
    );
  }

  const targetVersionJson = path.join(targetVersionDir, "version.json");
  if (!fs.existsSync(targetVersionJson)) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: missing version.json metadata at ${targetVersionJson}`,
    );
  }
  const metaStat = fs.lstatSync(targetVersionJson);
  if (metaStat.isSymbolicLink() || !metaStat.isFile()) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: version.json in target directory must be a regular file`,
    );
  }

  const currentPointer = path.join(resinHome, "current");
  const previousPointer = path.join(resinHome, "previous");
  const versionStatePath = path.join(resinHome, "version-state.json");
  const globalBinDir = path.join(resinHome, "bin");

  // Snapshot complete prior state before any mutations for full transactional rollback
  const priorActiveVersionRaw = getActiveVersion(resinHome);
  const priorActiveVersion =
    priorActiveVersionRaw === null ? null : normalizeReleaseVersion(priorActiveVersionRaw);

  const hadCurrentSymlink =
    fs.existsSync(currentPointer) && fs.lstatSync(currentPointer).isSymbolicLink();
  const priorCurrentTarget = hadCurrentSymlink ? fs.readlinkSync(currentPointer) : null;
  const hadCurrentVersionFile = fs.existsSync(path.join(resinHome, "current-version"));
  const priorCurrentVersionContent = hadCurrentVersionFile
    ? fs.readFileSync(path.join(resinHome, "current-version"), "utf8")
    : null;

  const hadPreviousSymlink =
    fs.existsSync(previousPointer) && fs.lstatSync(previousPointer).isSymbolicLink();
  const priorPreviousTarget = hadPreviousSymlink ? fs.readlinkSync(previousPointer) : null;
  const hadPreviousVersionFile = fs.existsSync(path.join(resinHome, "previous-version"));
  const priorPreviousVersionContent = hadPreviousVersionFile
    ? fs.readFileSync(path.join(resinHome, "previous-version"), "utf8")
    : null;

  const hadVersionState = fs.existsSync(versionStatePath);
  let priorVersionStateRaw: string | null = null;
  if (hadVersionState) {
    try {
      priorVersionStateRaw = fs.readFileSync(versionStatePath, "utf8");
    } catch {}
  }

  const hadGlobalBinDir = fs.existsSync(globalBinDir);
  const stagingBinDir = path.join(
    resinHome,
    `.bin.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
  );
  let backupBinDir: string | null = null;

  try {
    // Step 1: Update previous pointer / rollback target if different
    if (priorActiveVersion && priorActiveVersion !== cleanTarget) {
      const prevTargetDir = resolveVersionChildPath(
        versionsDir,
        `v${priorActiveVersion}`,
        "previous release version directory",
      );
      if (fs.existsSync(prevTargetDir)) {
        const tmpPrevSymlink = path.join(
          resinHome,
          `.previous.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
        );
        try {
          if (fs.existsSync(tmpPrevSymlink)) fs.unlinkSync(tmpPrevSymlink);
          fs.symlinkSync(prevTargetDir, tmpPrevSymlink, "dir");
          if (fs.existsSync(previousPointer) && fs.lstatSync(previousPointer).isDirectory()) {
            fs.rmSync(previousPointer, { recursive: true, force: true });
          }
          fs.renameSync(tmpPrevSymlink, previousPointer);
        } catch {
          const tmpPrevFile = path.join(
            resinHome,
            `.previous-version.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
          );
          fs.writeFileSync(tmpPrevFile, priorActiveVersion, "utf8");
          fs.chmodSync(tmpPrevFile, 0o644);
          fs.renameSync(tmpPrevFile, path.join(resinHome, "previous-version"));
        }
      }
    }

    // Step 2: Atomically update current pointer using temporary symlink and rename
    const tmpSymlink = path.join(
      resinHome,
      `.current.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    );
    try {
      if (fs.existsSync(tmpSymlink)) fs.unlinkSync(tmpSymlink);
      fs.symlinkSync(targetVersionDir, tmpSymlink, "dir");
      if (fs.existsSync(currentPointer) && fs.lstatSync(currentPointer).isDirectory()) {
        fs.rmSync(currentPointer, { recursive: true, force: true });
      }
      fs.renameSync(tmpSymlink, currentPointer);
    } catch {
      const tmpCurrFile = path.join(
        resinHome,
        `.current-version.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
      );
      fs.writeFileSync(tmpCurrFile, cleanTarget, "utf8");
      fs.chmodSync(tmpCurrFile, 0o644);
      fs.renameSync(tmpCurrFile, path.join(resinHome, "current-version"));
    }

    // Step 3: Populate staging bin directory for atomic publication (preventing mixed global command set)
    await fsBridge.mkdirp(stagingBinDir);
    await fsPromises.chmod(stagingBinDir, 0o755).catch(() => {});
    const targetBinDir = path.join(targetVersionDir, "bin");
    const binNames = new Set<string>(["resin", "resin-daemon", "resin-mcp"]);
    if (fs.existsSync(targetBinDir)) {
      const files = fs.readdirSync(targetBinDir);
      for (const f of files) {
        binNames.add(f);
      }
    }

    for (const binName of binNames) {
      const binTarget = path.join(targetVersionDir, "bin", binName);
      const stagedBinPath = path.join(stagingBinDir, binName);

      if (fs.existsSync(binTarget)) {
        try {
          fs.symlinkSync(binTarget, stagedBinPath);
        } catch {
          fs.writeFileSync(
            stagedBinPath,
            `#!/usr/bin/env node\nimport "${path.resolve(binTarget)}";\n`,
            { mode: 0o755 },
          );
          fs.chmodSync(stagedBinPath, 0o755);
        }
      }
    }

    if (hadGlobalBinDir) {
      backupBinDir = path.join(
        resinHome,
        `.bin.backup-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
      );
      await fsPromises.rename(globalBinDir, backupBinDir);
    }
    try {
      await fsPromises.rename(stagingBinDir, globalBinDir);
    } catch (binRenameErr) {
      if (backupBinDir && fs.existsSync(backupBinDir)) {
        await fsPromises.rename(backupBinDir, globalBinDir).catch(() => {});
        backupBinDir = null;
      }
      throw binRenameErr;
    }
    // Keep backupBinDir intact until version-state.json is committed and verified!

    // Step 4: Record version state atomically via temp + rename
    const installedList = fs.existsSync(versionsDir)
      ? fs
          .readdirSync(versionsDir)
          .filter((d) => d.startsWith("v") && !d.startsWith("."))
          .map((d) => d.replace(/^v/, ""))
      : [cleanTarget];

    let existingProvenance: NonNullable<VersionStateRecord["provenanceByVersion"]> = {};
    if (priorVersionStateRaw) {
      try {
        // SAFETY: Prior version state parsed from valid version-state.json structure.
        const state = JSON.parse(priorVersionStateRaw) as VersionStateRecord;
        if (state.provenanceByVersion) {
          existingProvenance = { ...state.provenanceByVersion };
        }
      } catch {}
    }
    try {
      // SAFETY: JSON parsed from version.json metadata adhering to InstalledVersionJson structure.
      const versionMetadata = JSON.parse(
        fs.readFileSync(targetVersionJson, "utf8"),
      ) as InstalledVersionJson;
      if (versionMetadata.provenance) existingProvenance[cleanTarget] = versionMetadata.provenance;
    } catch {}

    const newState: VersionStateRecord = {
      activeVersion: cleanTarget,
      previousVersion: priorActiveVersion,
      updatedAt: new Date().toISOString(),
      installedVersions: installedList,
      provenanceByVersion: existingProvenance,
    };

    const tmpStatePath = path.join(
      resinHome,
      `.version-state.json.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    );
    await fsPromises.writeFile(tmpStatePath, JSON.stringify(newState, null, 2), "utf8");
    await fsPromises.chmod(tmpStatePath, 0o644);
    await fsPromises.rename(tmpStatePath, versionStatePath);

    // Step 5: Verification of the newly committed state
    const verifiedActive = getActiveVersion(resinHome);
    if (verifiedActive !== cleanTarget) {
      throw new Error(
        `Atomic activation failed post-commit check: expected active version v${cleanTarget}, but resolved ${verifiedActive ? `v${verifiedActive}` : "none"}`,
      );
    }

    // Step 6: All commits succeeded and passed verification — safely clean up backupBinDir
    if (backupBinDir && fs.existsSync(backupBinDir)) {
      await fsPromises.rm(backupBinDir, { recursive: true, force: true }).catch(() => {});
      backupBinDir = null;
    }

    log(
      `Successfully switched active version to v${cleanTarget} (previous: ${priorActiveVersion ? `v${priorActiveVersion}` : "none"}).`,
    );

    return {
      activeVersion: cleanTarget,
      previousVersion: priorActiveVersion,
      activePath: targetVersionDir,
      rollbackRetained: Boolean(priorActiveVersion && priorActiveVersion !== cleanTarget),
    };
  } catch (error) {
    if (fs.existsSync(stagingBinDir)) {
      await fsPromises.rm(stagingBinDir, { recursive: true, force: true }).catch(() => {});
    }

    if (priorActiveVersion !== null) {
      if (backupBinDir && fs.existsSync(backupBinDir)) {
        if (fs.existsSync(globalBinDir)) {
          fs.rmSync(globalBinDir, { recursive: true, force: true });
        }
        await fsPromises.rename(backupBinDir, globalBinDir).catch(() => {});
        backupBinDir = null;
      } else if (!hadGlobalBinDir && fs.existsSync(globalBinDir)) {
        fs.rmSync(globalBinDir, { recursive: true, force: true });
      }

      if (hadCurrentSymlink && priorCurrentTarget) {
        try {
          const tmpRestoreSymlink = path.join(
            resinHome,
            `.current.tmp-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
          );
          if (fs.existsSync(tmpRestoreSymlink)) fs.unlinkSync(tmpRestoreSymlink);
          fs.symlinkSync(priorCurrentTarget, tmpRestoreSymlink, "dir");
          fs.renameSync(tmpRestoreSymlink, currentPointer);
        } catch {
          fs.writeFileSync(path.join(resinHome, "current-version"), priorActiveVersion, "utf8");
        }
      } else if (hadCurrentVersionFile && priorCurrentVersionContent) {
        fs.writeFileSync(
          path.join(resinHome, "current-version"),
          priorCurrentVersionContent,
          "utf8",
        );
        if (fs.existsSync(currentPointer)) {
          fs.rmSync(currentPointer, { recursive: true, force: true });
        }
      } else {
        const prevTargetDir = resolveVersionChildPath(
          versionsDir,
          `v${priorActiveVersion}`,
          "restored previous release version directory",
        );
        if (fs.existsSync(prevTargetDir)) {
          try {
            const tmpRestoreSymlink = path.join(
              resinHome,
              `.current.tmp-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
            );
            if (fs.existsSync(tmpRestoreSymlink)) fs.unlinkSync(tmpRestoreSymlink);
            fs.symlinkSync(prevTargetDir, tmpRestoreSymlink, "dir");
            fs.renameSync(tmpRestoreSymlink, currentPointer);
          } catch {
            fs.writeFileSync(path.join(resinHome, "current-version"), priorActiveVersion, "utf8");
          }
        }
      }

      if (hadPreviousSymlink && priorPreviousTarget) {
        try {
          const tmpRestorePrev = path.join(
            resinHome,
            `.previous.tmp-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
          );
          if (fs.existsSync(tmpRestorePrev)) fs.unlinkSync(tmpRestorePrev);
          fs.symlinkSync(priorPreviousTarget, tmpRestorePrev, "dir");
          fs.renameSync(tmpRestorePrev, previousPointer);
        } catch {}
      } else if (!hadPreviousSymlink && fs.existsSync(previousPointer)) {
        fs.rmSync(previousPointer, { recursive: true, force: true });
      }

      if (hadPreviousVersionFile && priorPreviousVersionContent) {
        fs.writeFileSync(
          path.join(resinHome, "previous-version"),
          priorPreviousVersionContent,
          "utf8",
        );
        fs.chmodSync(path.join(resinHome, "previous-version"), 0o644);
      } else if (
        !hadPreviousVersionFile &&
        fs.existsSync(path.join(resinHome, "previous-version"))
      ) {
        fs.rmSync(path.join(resinHome, "previous-version"), { force: true });
      }

      if (hadVersionState && priorVersionStateRaw) {
        fs.writeFileSync(versionStatePath, priorVersionStateRaw, "utf8");
        fs.chmodSync(versionStatePath, 0o644);
      } else if (!hadVersionState && fs.existsSync(versionStatePath)) {
        fs.rmSync(versionStatePath, { force: true });
      }

      const restoredActive = getActiveVersion(resinHome);
      if (restoredActive !== priorActiveVersion) {
        log(
          `Warning: Post-rollback active version mismatch: expected v${priorActiveVersion}, got ${restoredActive ? `v${restoredActive}` : "none"}`,
        );
      }
    } else {
      if (backupBinDir && fs.existsSync(backupBinDir)) {
        fs.rmSync(backupBinDir, { recursive: true, force: true });
        backupBinDir = null;
      }
      if (fs.existsSync(globalBinDir)) {
        fs.rmSync(globalBinDir, { recursive: true, force: true });
      }
      if (fs.existsSync(currentPointer)) {
        fs.rmSync(currentPointer, { recursive: true, force: true });
      }
      if (fs.existsSync(path.join(resinHome, "current-version"))) {
        fs.rmSync(path.join(resinHome, "current-version"), { force: true });
      }
      if (fs.existsSync(previousPointer)) {
        fs.rmSync(previousPointer, { recursive: true, force: true });
      }
      if (fs.existsSync(path.join(resinHome, "previous-version"))) {
        fs.rmSync(path.join(resinHome, "previous-version"), { force: true });
      }
      if (fs.existsSync(versionStatePath)) {
        fs.rmSync(versionStatePath, { force: true });
      }

      const restoredActive = getActiveVersion(resinHome);
      if (restoredActive !== null) {
        fs.rmSync(currentPointer, { recursive: true, force: true });
        fs.rmSync(path.join(resinHome, "current-version"), { force: true });
      }
    }

    throw error;
  }
}

/**
 * Rolls back the active version pointer to the previous known good version.
 */
export async function rollbackActiveVersion(
  options: RollbackOptions,
): Promise<VersionRollbackResult> {
  const { resinHome } = options;
  const log = options.logger ?? (() => {});

  const versionStatePath = path.join(resinHome, "version-state.json");
  const previousPointer = path.join(resinHome, "previous");

  let targetRollbackVersion = options.targetVersion;

  if (!targetRollbackVersion && fs.existsSync(previousPointer)) {
    try {
      const stats = fs.lstatSync(previousPointer);
      if (stats.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(previousPointer);
        const match = linkTarget.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) {
          targetRollbackVersion = match[1];
        }
      }
    } catch {}
  }

  if (!targetRollbackVersion && fs.existsSync(path.join(resinHome, "previous-version"))) {
    try {
      targetRollbackVersion = fs
        .readFileSync(path.join(resinHome, "previous-version"), "utf8")
        .trim();
    } catch {}
  }

  if (!targetRollbackVersion && fs.existsSync(versionStatePath)) {
    try {
      // SAFETY: Prior version state parsed from valid version-state.json structure.
      const state = JSON.parse(fs.readFileSync(versionStatePath, "utf8")) as VersionStateRecord;
      targetRollbackVersion = state.previousVersion || undefined;
    } catch {}
  }

  if (!targetRollbackVersion) {
    throw new Error("Cannot rollback: no previous known good version found in resin home state.");
  }

  const cleanTarget = normalizeReleaseVersion(targetRollbackVersion);
  const versionsDir = path.resolve(resinHome, "versions");
  const targetVersionDir = resolveVersionChildPath(
    versionsDir,
    `v${cleanTarget}`,
    "rollback release version directory",
  );

  if (!fs.existsSync(targetVersionDir)) {
    throw new Error(
      `Cannot rollback to v${cleanTarget}: target version directory does not exist at ${targetVersionDir}`,
    );
  }

  const switchResult = await switchActiveVersion({
    resinHome,
    targetVersion: cleanTarget,
    fsBridge: options.fsBridge,
    logger: options.logger,
  });

  log(`Rollback completed: active version restored to v${cleanTarget}.`);

  return {
    restoredVersion: cleanTarget,
    previousVersion: switchResult.previousVersion || "unknown",
    activePath: switchResult.activePath,
  };
}

/**
 * Reads the currently active version from the resin directory.
 */
export function getActiveVersion(resinHome: string): string | null {
  const currentPointer = path.join(resinHome, "current");
  if (fs.existsSync(currentPointer)) {
    try {
      const stats = fs.lstatSync(currentPointer);
      if (stats.isSymbolicLink()) {
        const target = fs.readlinkSync(currentPointer);
        const match = target.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) return match[1];
      }
    } catch {}
  }

  const currentVersionFile = path.join(resinHome, "current-version");
  if (fs.existsSync(currentVersionFile)) {
    try {
      const val = fs.readFileSync(currentVersionFile, "utf8").trim().replace(/^v/, "");
      if (val) return val;
    } catch {}
  }

  const versionStatePath = path.join(resinHome, "version-state.json");
  if (fs.existsSync(versionStatePath)) {
    try {
      // SAFETY: Prior version state parsed from valid version-state.json structure.
      const state = JSON.parse(fs.readFileSync(versionStatePath, "utf8")) as VersionStateRecord;
      return state.activeVersion || null;
    } catch {}
  }

  return null;
}
