import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsCapability } from "@resin/contracts";
import {
  expandWorkspacePlaceholder,
  isExplicitNonWildcardMatch,
  isPathInsideRoot,
  isSensitivePath,
  matchesPathPattern,
  normalizeSlashes,
  resolvePlatformAliases,
  validatePathCharacters,
} from "../policy/canonicalizers.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";

export interface FileStatResult {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtime: string;
  mode?: number;
}

export interface ReadFileParams {
  path: string;
  encoding?: "utf-8" | "utf-8-strict" | "base64" | "buffer";
}

export interface ReadFileResult {
  content: string;
  encoding: string;
  size: number;
}

export interface WriteFileParams {
  path: string;
  content: string | Uint8Array;
  encoding?: "utf-8" | "base64";
  atomic?: boolean;
}

export interface AppendFileParams {
  path: string;
  content: string | Uint8Array;
  encoding?: "utf-8" | "base64";
}

export interface RenameParams {
  oldPath: string;
  newPath: string;
}

export interface DeleteParams {
  path: string;
  recursive?: boolean;
}

export interface CreateDirectoryParams {
  path: string;
  recursive?: boolean;
}

export interface ListDirectoryParams {
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
}

/**
 * Checks whether a path targets sensitive credential trees or files.
 * Denies .ssh, .aws, .git credential trees and exact credential files (.env*, .npmrc, .netrc, .docker/config.json)
 * regardless of workspace placement.
 */
export function isCredentialOrSensitivePath(targetPath: string, workspaceRoot?: string): boolean {
  if (!targetPath || String(targetPath) !== targetPath) {
    return false;
  }

  if (isSensitivePath(targetPath, workspaceRoot)) {
    return true;
  }

  const normalized = normalizeSlashes(targetPath);
  const aliasPath = resolvePlatformAliases(normalized);

  for (const p of [normalized, aliasPath, targetPath]) {
    const clean = p.replace(/\\+/g, "/").replace(/^\.\//, "");
    const parts = clean.split("/").filter(Boolean);
    const base = path.posix.basename(clean);

    // Trees: .git, .ssh, .aws
    if (parts.some((part) => part === ".git" || part === ".ssh" || part === ".aws")) {
      return true;
    }

    // .docker/config.json and .docker directory
    if (
      clean === ".docker" ||
      clean === ".docker/config.json" ||
      clean.endsWith("/.docker") ||
      clean.endsWith("/.docker/config.json") ||
      clean.includes("/.docker/")
    ) {
      return true;
    }
    const dockerIdx = parts.indexOf(".docker");
    if (dockerIdx !== -1) {
      return true;
    }

    // Credential files: .env*, .npmrc, .netrc
    if (base === ".env" || base.startsWith(".env.") || base.startsWith(".env")) {
      return true;
    }
    if (base === ".npmrc" || base === ".netrc") {
      return true;
    }

    // SSH / TLS private keys
    if (
      base.startsWith("id_rsa") ||
      base.startsWith("id_ed25519") ||
      base.startsWith("id_ecdsa") ||
      base.startsWith("id_dsa")
    ) {
      return true;
    }

    // System credential files
    if (
      clean === "/etc/shadow" ||
      clean === "/etc/passwd" ||
      clean === "/etc/sudoers" ||
      clean === "/private/etc/shadow" ||
      clean === "/private/etc/passwd" ||
      clean === "/private/etc/sudoers" ||
      clean.endsWith("/etc/shadow") ||
      clean.endsWith("/etc/passwd") ||
      clean.endsWith("/etc/sudoers")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Capability broker for all filesystem access.
 * Enforces grant presence, allowed/denied roots, traversal containment,
 * symlink verification, max file size limits, and atomic writes.
 */
export class FilesystemBroker extends BaseCapabilityBroker {
  readonly serviceName = "fs" as const;

  constructor(options: BaseCapabilityBrokerOptions = {}) {
    super(options);
  }

  /**
   * Resolves and verifies that a target path is allowed for read or write operations.
   */
  private resolveAndAuthorizePath(
    rawPath: string,
    mode: "read" | "write" | "delete",
    context: BrokerContext,
    fsCap: FsCapability,
  ): string {
    if (!rawPath || String(rawPath) !== rawPath) {
      throw new BrokerSecurityError("INVALID_PATH", "Path must be a non-empty string");
    }

    validatePathCharacters(rawPath);

    const workspaceRoot = normalizeSlashes(path.resolve(context.workspaceRoot ?? process.cwd()));
    const scratchDir = context.scratchDir
      ? normalizeSlashes(path.resolve(context.scratchDir))
      : undefined;

    // Expand placeholders
    const expanded = expandWorkspacePlaceholder(rawPath, workspaceRoot);

    // Resolve target path
    const resolvedPath = path.isAbsolute(expanded)
      ? normalizeSlashes(path.resolve(expanded))
      : normalizeSlashes(path.resolve(workspaceRoot, expanded));

    // Unicode normalization
    const canonicalTarget = resolvedPath.normalize("NFC");

    // Check denied paths on canonicalTarget (strict precedence)
    const denyPatterns = fsCap.denyPaths ?? [];
    for (const denyPattern of denyPatterns) {
      if (
        matchesPathPattern(canonicalTarget, denyPattern, workspaceRoot) ||
        matchesPathPattern(resolvePlatformAliases(canonicalTarget), denyPattern, workspaceRoot)
      ) {
        throw new BrokerSecurityError(
          "PATH_DENIED",
          `Path is explicitly denied by capability policy: ${rawPath}`,
          { path: rawPath, deniedByPattern: denyPattern },
        );
      }
    }

    // Check sensitive / hidden paths on canonicalTarget unless explicitly allowed via non-wildcard match
    if (
      isCredentialOrSensitivePath(rawPath, workspaceRoot) ||
      isCredentialOrSensitivePath(canonicalTarget, workspaceRoot)
    ) {
      const explicitPatterns = mode === "read" ? fsCap.readPaths : fsCap.writePaths;
      const isExplicit = explicitPatterns?.some((pattern) =>
        isExplicitNonWildcardMatch(pattern, canonicalTarget, workspaceRoot),
      );
      if (!isExplicit) {
        throw new BrokerSecurityError(
          "HIDDEN_FILE_DENIED",
          `Access to sensitive or hidden path is denied: ${rawPath}`,
          { path: rawPath },
        );
      }
    }
    // Check allowed roots
    let isAllowed = false;

    // 1. Workspace root allowed
    if (fsCap.allowWorkspaceRoot && isPathInsideRoot(canonicalTarget, workspaceRoot)) {
      isAllowed = true;
    }

    // 2. Temp scratch dir allowed
    if (fsCap.allowTemp && scratchDir && isPathInsideRoot(canonicalTarget, scratchDir)) {
      isAllowed = true;
    }

    // 3. Explicit readPaths / writePaths
    const explicitPatterns = mode === "read" ? fsCap.readPaths : fsCap.writePaths;
    if (explicitPatterns && explicitPatterns.length > 0) {
      for (const pattern of explicitPatterns) {
        if (
          matchesPathPattern(canonicalTarget, pattern, workspaceRoot) ||
          matchesPathPattern(resolvePlatformAliases(canonicalTarget), pattern, workspaceRoot)
        ) {
          isAllowed = true;
          break;
        }
      }
    }

    if (!isAllowed) {
      // Check if it was an escape attempt outside roots
      if (
        !isPathInsideRoot(canonicalTarget, workspaceRoot) &&
        (!scratchDir || !isPathInsideRoot(canonicalTarget, scratchDir))
      ) {
        throw new BrokerSecurityError(
          "OUTSIDE_ALLOWED_ROOT",
          `Path escapes authorized root directories: ${rawPath}`,
          { path: rawPath, resolvedPath: canonicalTarget, workspaceRoot },
        );
      }
      throw new BrokerSecurityError(
        "OPERATION_NOT_PERMITTED",
        `Access to path is not granted by capability grant: ${rawPath}`,
        { path: rawPath, mode },
      );
    }

    // 4. Verify symlink containment and check real target
    this.verifySymlinkContainment(resolvedPath, workspaceRoot, scratchDir, fsCap);

    return resolvedPath;
  }

  /**
   * Verifies that symlinks do not target paths outside authorized roots or sensitive targets.
   */
  private verifySymlinkContainment(
    targetPath: string,
    workspaceRoot: string,
    scratchDir: string | undefined,
    fsCap: FsCapability,
  ): string {
    let checkPath = targetPath;
    const trailingSegments: string[] = [];

    // Find the deepest existing parent or the path itself
    while (!fs.existsSync(checkPath)) {
      const parent = path.dirname(checkPath);
      if (parent === checkPath) break;
      trailingSegments.unshift(path.basename(checkPath));
      checkPath = parent;
    }

    let realTarget = targetPath;
    if (fs.existsSync(checkPath)) {
      try {
        const realCheck = normalizeSlashes(fs.realpathSync(checkPath));
        realTarget =
          trailingSegments.length > 0
            ? normalizeSlashes(path.join(realCheck, ...trailingSegments))
            : realCheck;
      } catch (err) {
        if (err instanceof BrokerSecurityError) throw err;
        throw new BrokerSecurityError(
          "INVALID_PATH",
          `Failed to resolve real path for ${checkPath}`,
          { targetPath, checkPath },
        );
      }
    }

    const realWorkspaceRoot = normalizeSlashes(
      fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : workspaceRoot,
    );
    const realScratchDir =
      scratchDir && fs.existsSync(scratchDir)
        ? normalizeSlashes(fs.realpathSync(scratchDir))
        : scratchDir;

    // Check deny paths on realTarget
    const denyPatterns = fsCap.denyPaths ?? [];
    for (const denyPattern of denyPatterns) {
      if (
        matchesPathPattern(realTarget, denyPattern, realWorkspaceRoot) ||
        matchesPathPattern(resolvePlatformAliases(realTarget), denyPattern, realWorkspaceRoot)
      ) {
        throw new BrokerSecurityError(
          "PATH_DENIED",
          `Resolved target path is explicitly denied by capability policy: ${targetPath} -> ${realTarget}`,
          { targetPath, realTarget, deniedByPattern: denyPattern },
        );
      }
    }

    // Check sensitive paths on realTarget
    if (isCredentialOrSensitivePath(realTarget, realWorkspaceRoot)) {
      const explicitPatterns = [...(fsCap.readPaths ?? []), ...(fsCap.writePaths ?? [])];
      const isExplicit = explicitPatterns.some((pattern) =>
        isExplicitNonWildcardMatch(pattern, realTarget, realWorkspaceRoot),
      );
      if (!isExplicit) {
        throw new BrokerSecurityError(
          "HIDDEN_FILE_DENIED",
          `Resolved target points to sensitive or hidden path: ${targetPath} -> ${realTarget}`,
          { targetPath, realTarget },
        );
      }
    }

    // Verify containment within authorized roots
    let realAllowed = false;
    if (fsCap.allowWorkspaceRoot && isPathInsideRoot(realTarget, realWorkspaceRoot)) {
      realAllowed = true;
    }
    if (fsCap.allowTemp && realScratchDir && isPathInsideRoot(realTarget, realScratchDir)) {
      realAllowed = true;
    }

    const allExplicit = [...(fsCap.readPaths ?? []), ...(fsCap.writePaths ?? [])];
    if (
      allExplicit.some(
        (pattern) =>
          matchesPathPattern(realTarget, pattern, realWorkspaceRoot) ||
          matchesPathPattern(resolvePlatformAliases(realTarget), pattern, realWorkspaceRoot),
      )
    ) {
      realAllowed = true;
    }

    if (!realAllowed) {
      throw new BrokerSecurityError(
        "SYMLINK_ESCAPE",
        `Symlink points outside authorized roots: ${targetPath} -> ${realTarget}`,
        { targetPath, realTarget },
      );
    }

    return realTarget;
  }

  /**
   * Stat a file or directory.
   */
  async stat(params: { path: string }, context: BrokerContext): Promise<FileStatResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "read", context, fsCap);
      if (!fs.existsSync(targetPath)) {
        throw new BrokerSecurityError(
          "FILE_NOT_FOUND",
          `File or directory not found: ${params.path}`,
        );
      }

      const stat = fs.statSync(targetPath);
      const lstat = fs.lstatSync(targetPath);

      const result: FileStatResult = {
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: lstat.isSymbolicLink(),
        mtime: stat.mtime.toISOString(),
        mode: stat.mode,
      };

      this.recordAudit(
        "stat",
        context,
        "allowed",
        { path: params.path, size: stat.size },
        {
          durationMs: Date.now() - startTime,
        },
      );

      return result;
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "stat",
        context,
        "denied",
        { path: params.path },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Check if a path exists.
   */
  async exists(params: { path: string }, context: BrokerContext): Promise<{ exists: boolean }> {
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "read", context, fsCap);
      const exists = fs.existsSync(targetPath);
      return { exists };
    } catch (error) {
      if (
        error instanceof BrokerSecurityError &&
        (error.code === "PATH_DENIED" || error.code === "OUTSIDE_ALLOWED_ROOT")
      ) {
        throw error;
      }
      return { exists: false };
    }
  }

  /**
   * Read file contents with max size enforcement.
   */
  async readFile(params: ReadFileParams, context: BrokerContext): Promise<ReadFileResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const maxSizeBytes = fsCap.maxFileSizeBytes ?? 10485760; // 10MB default

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "read", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `File not found: ${params.path}`);
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) {
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Cannot readFile on non-regular file: ${params.path}`,
        );
      }

      if (stat.size > maxSizeBytes) {
        throw new BrokerSecurityError(
          "MAX_FILE_SIZE_EXCEEDED",
          `File size ${stat.size} bytes exceeds maximum allowed limit ${maxSizeBytes} bytes`,
          { size: stat.size, maxSizeBytes },
        );
      }

      // Track output budget
      this.trackOutputBytes(context.invocationId, stat.size, grant.capabilities.limits);

      const encoding = params.encoding ?? "utf-8";
      const buffer = fs.readFileSync(targetPath);
      const content =
        encoding === "base64"
          ? buffer.toString("base64")
          : encoding === "utf-8-strict"
            ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer)
            : buffer.toString("utf-8");

      this.recordAudit(
        "readFile",
        context,
        "allowed",
        {
          path: params.path,
          size: stat.size,
          encoding,
        },
        { durationMs: Date.now() - startTime },
      );

      return {
        content,
        encoding,
        size: stat.size,
      };
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "readFile",
        context,
        "denied",
        { path: params.path },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Write file contents atomically with max size enforcement.
   */
  async writeFile(
    params: WriteFileParams,
    context: BrokerContext,
  ): Promise<{ bytesWritten: number }> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const maxSizeBytes = fsCap.maxFileSizeBytes ?? 10485760;

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "write", context, fsCap);

      const buffer =
        String(params.content) === params.content
          ? params.encoding === "base64"
            ? Buffer.from(params.content, "base64")
            : Buffer.from(params.content, "utf-8")
          : Buffer.from(params.content);

      if (buffer.length > maxSizeBytes) {
        throw new BrokerSecurityError(
          "MAX_FILE_SIZE_EXCEEDED",
          `Content size ${buffer.length} bytes exceeds maximum allowed limit ${maxSizeBytes} bytes`,
          { size: buffer.length, maxSizeBytes },
        );
      }

      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const isAtomic = params.atomic !== false;
      if (isAtomic) {
        const tempPath = path.join(parentDir, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tempPath, buffer);
          fs.renameSync(tempPath, targetPath);
        } catch (writeErr) {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch {}
          throw writeErr;
        }
      } else {
        fs.writeFileSync(targetPath, buffer);
      }

      this.recordAudit(
        "writeFile",
        context,
        "allowed",
        {
          path: params.path,
          bytesWritten: buffer.length,
          atomic: isAtomic,
        },
        { durationMs: Date.now() - startTime },
      );

      return { bytesWritten: buffer.length };
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "writeFile",
        context,
        "denied",
        { path: params.path },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Append content to a file.
   */
  async appendFile(
    params: AppendFileParams,
    context: BrokerContext,
  ): Promise<{ bytesWritten: number }> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};
    const maxSizeBytes = fsCap.maxFileSizeBytes ?? 10485760;

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "write", context, fsCap);

      const buffer =
        String(params.content) === params.content
          ? params.encoding === "base64"
            ? Buffer.from(params.content, "base64")
            : Buffer.from(params.content, "utf-8")
          : Buffer.from(params.content);

      const existingSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
      if (existingSize + buffer.length > maxSizeBytes) {
        throw new BrokerSecurityError(
          "MAX_FILE_SIZE_EXCEEDED",
          `Total file size ${existingSize + buffer.length} bytes would exceed maximum allowed limit ${maxSizeBytes} bytes`,
          { totalSize: existingSize + buffer.length, maxSizeBytes },
        );
      }

      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.appendFileSync(targetPath, buffer);

      this.recordAudit(
        "appendFile",
        context,
        "allowed",
        {
          path: params.path,
          bytesWritten: buffer.length,
        },
        { durationMs: Date.now() - startTime },
      );

      return { bytesWritten: buffer.length };
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "appendFile",
        context,
        "denied",
        { path: params.path },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Rename a file or directory within authorized roots.
   */
  async rename(params: RenameParams, context: BrokerContext): Promise<void> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const oldTarget = this.resolveAndAuthorizePath(params.oldPath, "delete", context, fsCap);
      const newTarget = this.resolveAndAuthorizePath(params.newPath, "write", context, fsCap);

      if (!fs.existsSync(oldTarget)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `Source path not found: ${params.oldPath}`);
      }

      const parentDir = path.dirname(newTarget);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.renameSync(oldTarget, newTarget);

      this.recordAudit(
        "rename",
        context,
        "allowed",
        {
          oldPath: params.oldPath,
          newPath: params.newPath,
        },
        { durationMs: Date.now() - startTime },
      );
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "rename",
        context,
        "denied",
        { oldPath: params.oldPath, newPath: params.newPath },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Delete a file or directory.
   */
  async delete(params: DeleteParams, context: BrokerContext): Promise<void> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "delete", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        return; // Idempotent delete
      }

      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: params.recursive ?? false, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }

      this.recordAudit(
        "delete",
        context,
        "allowed",
        {
          path: params.path,
          recursive: params.recursive,
        },
        { durationMs: Date.now() - startTime },
      );
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "delete",
        context,
        "denied",
        { path: params.path },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Alias for delete.
   */
  async removeFile(params: { path: string }, context: BrokerContext): Promise<void> {
    return this.delete(params, context);
  }

  /**
   * Create directory.
   */
  async createDirectory(params: CreateDirectoryParams, context: BrokerContext): Promise<void> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap = grant.capabilities.fs ?? {};

    try {
      const targetPath = this.resolveAndAuthorizePath(params.path, "write", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: params.recursive !== false });
      }

      this.recordAudit(
        "createDirectory",
        context,
        "allowed",
        {
          path: params.path,
          recursive: params.recursive,
        },
        { durationMs: Date.now() - startTime },
      );
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "createDirectory",
        context,
        "denied",
        { path: params.path },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * List directory contents.
   */
  async listDirectory(params: ListDirectoryParams, context: BrokerContext): Promise<string[]> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const fsCap: FsCapability = grant.capabilities.fs ?? {};
    const dirPath = params.path ?? ".";
    const maxEntries = params.maxEntries ?? 10000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000)
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", "Invalid directory entry bound");

    try {
      const targetPath = this.resolveAndAuthorizePath(dirPath, "read", context, fsCap);

      if (!fs.existsSync(targetPath)) {
        throw new BrokerSecurityError("FILE_NOT_FOUND", `Directory not found: ${dirPath}`);
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        throw new BrokerSecurityError(
          "OPERATION_NOT_PERMITTED",
          `Path is not a directory: ${dirPath}`,
        );
      }
      const workspaceRoot = normalizeSlashes(path.resolve(context.workspaceRoot ?? process.cwd()));
      const entries: string[] = [];
      const readEntries = (currentDir: string, relativePrefix: string) => {
        const directory = fs.opendirSync(currentDir);
        try {
          for (let dirent = directory.readSync(); dirent; dirent = directory.readSync()) {
            const entryRel = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
            const fullEntryPath = normalizeSlashes(path.join(currentDir, dirent.name));

            const denyPaths: readonly string[] = fsCap.denyPaths ?? [];
            const isDenied = denyPaths.some(
              (p) =>
                matchesPathPattern(fullEntryPath, p, workspaceRoot) ||
                matchesPathPattern(entryRel, p, workspaceRoot),
            );
            const isSensitive =
              isCredentialOrSensitivePath(fullEntryPath, workspaceRoot) ||
              isCredentialOrSensitivePath(entryRel, workspaceRoot);
            const readPaths: readonly string[] = fsCap.readPaths ?? [];
            const isExplicitAllowed = readPaths.some((p) =>
              isExplicitNonWildcardMatch(p, fullEntryPath, workspaceRoot),
            );

            if (isDenied || (isSensitive && !isExplicitAllowed)) {
              continue;
            }

            entries.push(entryRel);
            if (entries.length > maxEntries)
              throw new BrokerSecurityError(
                "MAX_OUTPUT_EXCEEDED",
                "Directory listing exceeds entry bound",
              );
            if (params.recursive && dirent.isDirectory()) {
              readEntries(path.join(currentDir, dirent.name), entryRel);
            }
          }
        } finally {
          directory.closeSync();
        }
      };

      readEntries(targetPath, "");
      this.recordAudit(
        "listDirectory",
        context,
        "allowed",
        {
          path: dirPath,
          entryCount: entries.length,
          recursive: params.recursive,
        },
        { durationMs: Date.now() - startTime },
      );

      return entries;
    } catch (error) {
      const err =
        error instanceof BrokerSecurityError
          ? error
          : new BrokerSecurityError(
              "OPERATION_NOT_PERMITTED",
              error instanceof Error ? error.message : String(error),
            );
      this.recordAudit(
        "listDirectory",
        context,
        "denied",
        { path: dirPath },
        {
          error: { code: err.code, message: err.message },
          durationMs: Date.now() - startTime,
        },
      );
      throw err;
    }
  }

  /**
   * Alias for listDirectory.
   */
  async listDir(params: ListDirectoryParams, context: BrokerContext): Promise<string[]> {
    return this.listDirectory(params, context);
  }
}
