import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ConfigPreconditionFailedError, HarnessPermissionError } from "./errors.js";
import type { ConfigBackup, ConfigMutationPlan } from "./types.js";

/**
 * Computes deterministic SHA-256 hash of a string content.
 */
export function computeConfigHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Verifies whether the current configuration content matches the expected precondition hash.
 */
export function verifyPreconditionHash(
  currentContent: string | null,
  expectedHash: string,
): boolean {
  if (currentContent === null) {
    return expectedHash === "" || expectedHash === "sha256:empty";
  }
  const actualHash = computeConfigHash(currentContent);
  const normalizedExpected = expectedHash.startsWith("sha256:")
    ? expectedHash.slice(7)
    : expectedHash;
  return actualHash.toLowerCase() === normalizedExpected.toLowerCase();
}

/**
 * Filesystem abstraction bridge for configuration planning and mutation.
 */
export interface ConfigFsBridge {
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  mkdirp(dirPath: string): Promise<void>;
  copyFile(srcPath: string, destPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

/**
 * Default Node.js filesystem implementation of ConfigFsBridge.
 */
export class NodeConfigFsBridge implements ConfigFsBridge {
  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      if (err instanceof Error && "code" in err && err.code === "EACCES") {
        throw new HarnessPermissionError(`Permission denied reading ${filePath}`, {
          targetPath: filePath,
          cause: err,
        });
      }
      throw err;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "EACCES") {
        throw new HarnessPermissionError(`Permission denied writing ${filePath}`, {
          targetPath: filePath,
          cause: err,
        });
      }
      throw err;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    await this.mkdirp(path.dirname(destPath));
    await fs.copyFile(srcPath, destPath);
  }

  async unlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

/**
 * In-memory filesystem bridge for fast, deterministic unit testing and mocking.
 */
export class InMemoryConfigFsBridge implements ConfigFsBridge {
  private files = new Map<string, string>();

  async readFile(filePath: string): Promise<string | null> {
    const normalized = path.normalize(filePath);
    return this.files.get(normalized) ?? null;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const normalized = path.normalize(filePath);
    this.files.set(normalized, content);
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = path.normalize(filePath);
    return this.files.has(normalized);
  }

  async mkdirp(_dirPath: string): Promise<void> {
    // No-op for in-memory flat map
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const src = path.normalize(srcPath);
    const dest = path.normalize(destPath);
    const content = this.files.get(src);
    if (content === undefined) {
      throw new Error(`Source file ${srcPath} does not exist`);
    }
    this.files.set(dest, content);
  }

  async unlink(filePath: string): Promise<void> {
    const normalized = path.normalize(filePath);
    this.files.delete(normalized);
  }

  clear(): void {
    this.files.clear();
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }
}

export const defaultFsBridge = new NodeConfigFsBridge();

export type ConfigMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ConfigMetadataRecord
  | ConfigMetadataValue[];

export interface ConfigMetadataRecord {
  [key: string]: ConfigMetadataValue;
}

export interface McpServerRegistry<T extends ConfigMetadataRecord = ConfigMetadataRecord> {
  [serverKey: string]: T;
}

/**
 * Plans a configuration modification, capturing the current precondition hash.
 */
export function planConfigMutation(options: {
  harnessId: string;
  targetPath: string;
  currentContent: string | null;
  plannedContent: string;
  description?: string;
  backupPath?: string;
  metadata?: ConfigMetadataRecord;
}): ConfigMutationPlan {
  const planId = randomUUID();
  const preconditionHash =
    options.currentContent === null ? "" : computeConfigHash(options.currentContent);
  const now = new Date().toISOString();
  const defaultBackupPath = `${options.targetPath}.backup.${Date.now()}`;

  return {
    planId,
    harnessId: options.harnessId,
    targetPath: options.targetPath,
    preconditionHash,
    plannedContent: options.plannedContent,
    backupPath: options.backupPath ?? defaultBackupPath,
    description: options.description ?? `Update configuration for ${options.harnessId}`,
    createdAt: now,
    metadata: options.metadata ?? {},
  };
}

/**
 * Applies a planned configuration mutation with precondition checking and atomic backup creation.
 */
export async function applyConfigMutation(
  plan: ConfigMutationPlan,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<ConfigBackup> {
  const currentContent = await fsBridge.readFile(plan.targetPath);

  if (!verifyPreconditionHash(currentContent, plan.preconditionHash)) {
    const actualHash = currentContent === null ? "empty" : computeConfigHash(currentContent);
    throw new ConfigPreconditionFailedError(
      `Precondition failed for ${plan.targetPath}: expected hash ${plan.preconditionHash || "empty"}, got ${actualHash}`,
      {
        harnessId: plan.harnessId,
        targetPath: plan.targetPath,
        expectedHash: plan.preconditionHash,
        actualHash,
      },
    );
  }

  const backupId = randomUUID();
  const now = new Date().toISOString();
  const backupPath = plan.backupPath ?? `${plan.targetPath}.backup.${Date.now()}`;
  const originalContent = currentContent ?? "";
  const contentHash = computeConfigHash(originalContent);

  // If previous content existed, write backup
  if (currentContent !== null) {
    await fsBridge.writeFile(backupPath, originalContent);
  }

  // Apply new content
  await fsBridge.writeFile(plan.targetPath, plan.plannedContent);

  return {
    backupId,
    targetPath: plan.targetPath,
    backupPath,
    contentHash,
    originalContent,
    createdAt: now,
    restored: false,
  };
}

/**
 * Rolls back a previously applied configuration mutation from a backup record.
 */
export async function rollbackConfigMutation(
  backup: ConfigBackup,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<void> {
  if (backup.restored) {
    return;
  }

  if (backup.originalContent === "") {
    // If the original file did not exist, delete target
    await fsBridge.unlink(backup.targetPath);
  } else {
    // Restore original content
    await fsBridge.writeFile(backup.targetPath, backup.originalContent);
  }

  backup.restored = true;
  backup.restoredAt = new Date().toISOString();
}

/**
 * Verifies that the configuration at targetPath matches expected content or expected hash.
 */
export async function verifyConfigIntegrity(
  targetPath: string,
  expectedContentOrHash: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<boolean> {
  const content = await fsBridge.readFile(targetPath);
  if (content === null) {
    return false;
  }
  if (content === expectedContentOrHash) {
    return true;
  }
  const hash = computeConfigHash(content);
  const normalizedExpected = expectedContentOrHash.startsWith("sha256:")
    ? expectedContentOrHash.slice(7)
    : expectedContentOrHash;
  return hash.toLowerCase() === normalizedExpected.toLowerCase();
}

/**
 * Canonical MCP server key for Resin across all agent harnesses.
 */
export const CANONICAL_RESIN_MCP_SERVER_KEY = "resin";
export const CANONICAL_RESIN_MCP_KEY = CANONICAL_RESIN_MCP_SERVER_KEY;

/**
 * Canonical MCP stdio command for Resin.
 */
export const CANONICAL_RESIN_MCP_COMMAND = "resin-mcp";
export const DEFAULT_RESIN_MCP_COMMAND = CANONICAL_RESIN_MCP_COMMAND;

/**
 * Known legacy MCP server keys used by earlier versions of Resin harnesses.
 */
export const LEGACY_RESIN_MCP_SERVER_ALIASES = ["resin_gateway", "resin-gateway"] as const;

/**
 * Legacy loopback SSE endpoint for Resin Gateway.
 */
export const LEGACY_RESIN_GATEWAY_URL = "http://127.0.0.1:9400/mcp/sse";
export const DEFAULT_RESIN_GATEWAY_URL = LEGACY_RESIN_GATEWAY_URL;
export const RESIN_MCP_SERVER_URL = LEGACY_RESIN_GATEWAY_URL;

/**
 * Checks whether a command string resolves or ends in "resin-mcp".
 */
export function isResinMcpCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed === "resin-mcp" ||
    trimmed.endsWith("/resin-mcp") ||
    trimmed.endsWith("\\resin-mcp") ||
    /(?:^|[/\\])resin-mcp(?:\.(?:exe|cmd|bat|js|mjs|cjs))?$/i.test(trimmed)
  ) {
    return true;
  }
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    if (
      token === "resin-mcp" ||
      token.endsWith("/resin-mcp") ||
      token.endsWith("\\resin-mcp") ||
      /(?:^|[/\\])resin-mcp(?:\.(?:exe|cmd|bat|js|mjs|cjs))?$/i.test(token)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a given MCP server entry object/table is recognizably Resin-owned.
 * An entry is recognizably Resin-owned if:
 * 1. Its URL matches the configured gateway URL, the legacy Resin gateway URL, or localhost:9400.
 * 2. Its command or arguments resolve/end in "resin-mcp".
 */
export function isRecognizedResinMcpEntry(
  entry: ConfigMetadataRecord | null | undefined,
  configuredGatewayUrl?: string,
): boolean {
  if (
    entry === null ||
    entry === undefined ||
    Object.prototype.toString.call(entry) !== "[object Object]"
  ) {
    return false;
  }

  // SAFETY: entry is confirmed to be a non-null object record.
  const record = entry as ConfigMetadataRecord;

  const urlCandidate =
    Object.prototype.toString.call(record.url) === "[object String]"
      ? String(record.url)
      : Object.prototype.toString.call(record.endpoint) === "[object String]"
        ? String(record.endpoint)
        : null;

  if (urlCandidate !== null) {
    const trimmedUrl = urlCandidate.trim();
    if (configuredGatewayUrl && trimmedUrl === configuredGatewayUrl.trim()) {
      return true;
    }
    if (
      trimmedUrl === LEGACY_RESIN_GATEWAY_URL ||
      trimmedUrl === DEFAULT_RESIN_GATEWAY_URL ||
      /^https?:\/\/(?:127\.0\.0\.1|localhost):9400(?:\/.*)?$/i.test(trimmedUrl)
    ) {
      return true;
    }
  }

  const commandCandidate =
    Object.prototype.toString.call(record.command) === "[object String]"
      ? String(record.command)
      : null;
  if (commandCandidate && isResinMcpCommand(commandCandidate)) {
    return true;
  }

  if (Array.isArray(record.args)) {
    for (const arg of record.args) {
      if (typeof arg === "string" && isResinMcpCommand(arg)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Migrates a JSON dictionary of MCP servers, updating or injecting the canonical Resin server key.
 * Invariant guarantees:
 * - If canonical already exists, its extra fields win over legacy entries.
 * - For known legacy aliases ("resin_gateway", "resin-gateway"):
 *   - If the existing entry is recognizably Resin-owned, removes it.
 *   - If the existing entry is NOT recognizably Resin-owned, preserves it.
 * - If canonical "resin" and legacy Resin-owned entries coexist,
 *   canonical wins and owned legacy aliases are removed.
 */
export function migrateJsonMcpServers<T extends ConfigMetadataRecord = ConfigMetadataRecord>(
  existingServers: McpServerRegistry<T> | Record<string, T> | null | undefined,
  newServerConfig: T,
  configuredGatewayUrl?: string,
  canonicalKey: string = CANONICAL_RESIN_MCP_SERVER_KEY,
): McpServerRegistry<T> {
  const result: McpServerRegistry<T> = { ...existingServers };
  const transportFieldNames = ["type", "url", "command", "args", "endpoint"];

  const canonicalExisting = result[canonicalKey];
  const inheritedExtras: ConfigMetadataRecord = {};

  if (
    canonicalExisting &&
    Object.prototype.toString.call(canonicalExisting) === "[object Object]"
  ) {
    // SAFETY: Canonical existing entry is an object record.
    const canonicalObj = canonicalExisting as ConfigMetadataRecord;
    for (const [k, v] of Object.entries(canonicalObj)) {
      if (!transportFieldNames.includes(k)) {
        inheritedExtras[k] = v;
      }
    }
  } else {
    for (const [key, entry] of Object.entries(result)) {
      if (
        key !== canonicalKey &&
        isRecognizedResinMcpEntry(entry, configuredGatewayUrl) &&
        entry &&
        Object.prototype.toString.call(entry) === "[object Object]"
      ) {
        const entryObj = entry as ConfigMetadataRecord;
        for (const [k, v] of Object.entries(entryObj)) {
          if (!transportFieldNames.includes(k) && !(k in inheritedExtras)) {
            inheritedExtras[k] = v;
          }
        }
      }
    }
  }

  for (const [key, entry] of Object.entries(result)) {
    if (key !== canonicalKey && isRecognizedResinMcpEntry(entry, configuredGatewayUrl)) {
      delete result[key];
    }
  }

  for (const legacyAlias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    if (legacyAlias in result && legacyAlias !== canonicalKey) {
      const entry = result[legacyAlias];
      if (isRecognizedResinMcpEntry(entry, configuredGatewayUrl)) {
        delete result[legacyAlias];
      }
    }
  }

  if (newServerConfig && Object.prototype.toString.call(newServerConfig) === "[object Object]") {
    // SAFETY: Merged server configuration preserves generic server config record type T.
    result[canonicalKey] = {
      ...inheritedExtras,
      ...newServerConfig,
    } as T;
  } else {
    result[canonicalKey] = newServerConfig;
  }

  return result;
}
