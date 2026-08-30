import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  computeConfigHash,
  isRecognizedResinMcpEntry,
} from "@resin/harness-contracts";
import type {
  ConfigBackup,
  ConfigFsBridge,
  ConfigMutationPlan,
  HarnessInstallation,
} from "@resin/harness-contracts";
import { z } from "zod";
import {
  DEFAULT_GATEWAY_URL,
  HARNESS_DISPLAY_NAMES,
  RESIN_MCP_SERVER_KEYS,
  SUPPORTED_HARNESS_IDS,
  findCodexTomlServerConfig,
  parseCodexTomlConfig,
  planHarnessRegistration,
  probeHarnessInstallation,
  projectCodexTomlUserConfig,
  resolveHarnessConfigPath,
  verifyHarnessRegistration,
} from "./harness-config.js";
import type { HarnessProbeOptions, SupportedHarnessId } from "./harness-config.js";

export const DEFAULT_HARNESS_AUTO_REPAIR = true;
export const HARNESS_BACKUP_RETENTION = 5;

export type HarnessJsonValue =
  | string
  | number
  | boolean
  | null
  | HarnessJsonValue[]
  | { [key: string]: HarnessJsonValue };

export type HarnessJsonObject = Record<string, HarnessJsonValue>;

const HarnessJsonValueSchema: z.ZodType<HarnessJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(HarnessJsonValueSchema),
    z.record(HarnessJsonValueSchema),
  ]),
);

const HarnessJsonObjectSchema: z.ZodType<HarnessJsonObject> = z.record(HarnessJsonValueSchema);

const RESIN_OWNED_SERVER_FIELDS = ["type", "url", "command", "args"] as const;
const BACKUP_FORMAT = "resin-harness-backup/v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OwnedBackupMetadataSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    backupId: z.string().uuid(),
    targetPath: z.string().min(1),
    backupPath: z.string().min(1),
    metadataPath: z.string().min(1),
    originalContentHash: z.string().regex(SHA256_PATTERN),
    plannedContentHash: z.string().regex(SHA256_PATTERN),
    originalExisted: z.boolean(),
    createdAt: z.string().datetime(),
    timestamp: z.number().int().nonnegative(),
  })
  .strict();
type OwnedBackupMetadata = z.infer<typeof OwnedBackupMetadataSchema>;

export type HarnessRegistrationStatus =
  | "registered"
  | "unregistered"
  | "reconciled"
  | "drift_detected";

export type HarnessRegistrationCondition =
  | "healthy"
  | "missing"
  | "drifted"
  | "corrupt"
  | "not_installed";

/**
 * ConfigFsBridge extension used for durable backup discovery. Plain ConfigFsBridge
 * implementations remain supported; the reconciler tracks backups it creates in-memory.
 */
export interface HarnessReconcileFsBridge extends ConfigFsBridge {
  listFiles?(directoryPath: string): Promise<readonly string[]>;
  writeFileExclusive?(filePath: string, content: string): Promise<boolean>;
  compareAndSwapFile?(
    filePath: string,
    expectedContent: string | null,
    content: string,
  ): Promise<boolean>;
  unlinkIfUnchanged?(filePath: string, expectedContent: string): Promise<boolean>;
  withFileLock?<T>(filePath: string, action: () => Promise<T>): Promise<T>;
  dump?(): Record<string, string>;
}

export type HarnessInstallationProbe = (
  options: HarnessProbeOptions,
) => Promise<HarnessInstallation | null>;

export interface HarnessReconcileOptions {
  readonly autoRepair?: boolean;
  readonly dryRun?: boolean;
  readonly harnesses?: readonly SupportedHarnessId[];
  readonly installedHarnesses?: readonly SupportedHarnessId[];
  readonly customHome?: string;
  readonly workspacePath?: string;
  readonly gatewayUrl?: string;
  readonly fsBridge?: HarnessReconcileFsBridge;
  readonly probeHarness?: HarnessInstallationProbe;
  readonly now?: () => Date;
  readonly onHarnessDiscovered?: (harness: HarnessInstallation) => void;
  readonly onPlanCreated?: (plan: ConfigMutationPlan) => void;
}

export interface HarnessReconciliationResult {
  readonly harnessId: SupportedHarnessId;
  readonly displayName: string;
  readonly installed: boolean;
  readonly targetPath: string;
  readonly status: HarnessRegistrationStatus;
  readonly condition: HarnessRegistrationCondition;
  readonly configured: boolean;
  readonly changed: boolean;
  readonly backup?: ConfigBackup;
  readonly rolledBack?: boolean;
  readonly diagnostic?: string;
  readonly plan?: ConfigMutationPlan;
  readonly error?: string;
}

export interface HarnessReconciliationReport {
  readonly success: boolean;
  readonly autoRepair: boolean;
  readonly checkedAt: string;
  readonly hasDrift: boolean;
  readonly results: readonly HarnessReconciliationResult[];
}

interface ResolvedReconcileOptions {
  readonly autoRepair: boolean;
  readonly dryRun: boolean;
  readonly installedHarnesses: ReadonlySet<SupportedHarnessId>;
  readonly customHome: string;
  readonly workspacePath: string;
  readonly gatewayUrl: string;
  readonly fsBridge: HarnessReconcileFsBridge;
  readonly probeHarness: HarnessInstallationProbe;
  readonly now: () => Date;
  readonly onHarnessDiscovered?: (harness: HarnessInstallation) => void;
  readonly onPlanCreated?: (plan: ConfigMutationPlan) => void;
}

interface MutationOutcome {
  readonly success: boolean;
  readonly backup?: ConfigBackup;
  readonly rolledBack?: boolean;
  readonly warning?: string;
  readonly error?: string;
}
const RECONCILIATION_LOCK_FORMAT = "resin-harness-lock/v2" as const;
const RECONCILIATION_LOCK_LEASE_MS = 30_000;
const RECONCILIATION_LOCK_WAIT_MS = 2_000;
const RECONCILIATION_LOCK_RETRY_MS = 25;
const LOCK_CLAIM_SUFFIX = ".claim";
const PROCESS_FALLBACK_INCARNATION = randomUUID();

const ReconciliationLockClaimSchema = z
  .object({
    format: z.literal(RECONCILIATION_LOCK_FORMAT),
    token: z.string().uuid(),
    fenceToken: z.string().min(1),
    targetPath: z.string().min(1),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    createdMonotonicNs: z.string().regex(/^\d+$/),
    leaseExpiresAt: z.number().int().nonnegative(),
    leaseExpiresMonotonicNs: z.string().regex(/^\d+$/),
  })
  .strict();

type ReconciliationLockClaim = z.infer<typeof ReconciliationLockClaimSchema>;

interface StableFileSnapshot {
  readonly content: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
  readonly mode: number;
  readonly uid: bigint;
}

interface TransactionTarget {
  readonly requestedPath: string;
  readonly effectivePath: string;
  readonly symbolicLink?: {
    readonly device: bigint;
    readonly inode: bigint;
    readonly linkTarget: string;
  };
}

interface ReconciliationTransaction {
  readonly directoryPath: string;
  readonly plannedPath: string;
  readonly capturedPath: string;
  readonly probePath: string;
}

interface ActiveReconciliationLock {
  readonly requestedPath: string;
  readonly canonicalTarget: string;
  readonly lockPath: string;
  readonly claimPath: string;
  claim: ReconciliationLockClaim;
  heartbeat?: NodeJS.Timeout;
  leaseError?: unknown;
  refreshTail: Promise<void>;
  releaseStarted: boolean;
}

interface ScannedLockClaim {
  readonly claimPath: string;
  readonly claim: ReconciliationLockClaim;
  readonly snapshot: StableFileSnapshot;
}

/**
 * Node filesystem bridge with atomic replacement, private new-file permissions, and
 * private backups. Existing target permissions are retained across reconciliation.
 */
export class ReconciliationNodeFsBridge implements HarnessReconcileFsBridge {
  private readonly activeLocks = new Map<string, ActiveReconciliationLock>();

  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const targetPath = await this.resolveAtomicWriteTarget(filePath);
    const directoryPath = path.dirname(targetPath);
    await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });

    let targetMode = 0o600;
    try {
      targetMode = (await fs.stat(targetPath)).mode & 0o777;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const temporaryPath = path.join(
      directoryPath,
      `.${path.basename(targetPath)}.resin-${randomUUID()}.tmp`,
    );
    let replaced = false;
    try {
      const handle = await fs.open(temporaryPath, "wx", targetMode);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.chmod(targetMode);
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, targetPath);
      replaced = true;
    } finally {
      if (!replaced) {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  async writeFileExclusive(filePath: string, content: string): Promise<boolean> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let handle: fs.FileHandle | undefined;
    let created = false;
    try {
      handle = await fs.open(filePath, "wx", 0o600);
      created = true;
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      return true;
    } catch (error: unknown) {
      if (!created && isAlreadyExistsError(error)) {
        return false;
      }
      if (created) {
        await fs.unlink(filePath).catch(() => undefined);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async compareAndSwapFile(
    filePath: string,
    expectedContent: string | null,
    content: string,
  ): Promise<boolean> {
    const target = await this.resolveTransactionTarget(filePath);
    const activeLock = this.activeLocks.get(path.resolve(filePath));

    if (expectedContent === null) {
      try {
        await fs.lstat(target.effectivePath);
        return false;
      } catch (error: unknown) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }

      const transaction = await this.prepareTransaction(target.effectivePath, content, 0o600);
      try {
        await this.verifyHardLinkSupport(transaction);
        await this.assertActiveLock(activeLock);
        await this.assertTransactionTargetUnchanged(target);
        try {
          await this.linkTransactionFile(transaction.plannedPath, target.effectivePath);
        } catch (error: unknown) {
          if (isAlreadyExistsError(error)) {
            throw new Error(
              `A concurrent writer created ${filePath} at Resin's final mutation boundary`,
            );
          }
          throw error;
        }
        const persisted = await this.readStableFile(target.effectivePath);
        if (persisted.content !== content) {
          throw new Error(`Concurrent modification detected after creating ${filePath}`);
        }
        await this.assertTransactionTargetUnchanged(target);
        await this.cleanupTransaction(transaction);
        return true;
      } catch (error: unknown) {
        throw this.preservedTransactionError(filePath, transaction, error);
      }
    }

    let original: StableFileSnapshot;
    try {
      original = await this.readStableFile(target.effectivePath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    if (original.content !== expectedContent) {
      return false;
    }

    const transaction = await this.prepareTransaction(target.effectivePath, content, original.mode);
    let captured = false;
    try {
      await this.verifyHardLinkSupport(transaction);
      await this.assertActiveLock(activeLock);
      await this.assertTransactionTargetUnchanged(target);

      const finalVersion = await fs.lstat(target.effectivePath, { bigint: true });
      if (
        !finalVersion.isFile() ||
        finalVersion.dev !== original.device ||
        finalVersion.ino !== original.inode
      ) {
        throw new Error(`Configuration identity changed immediately before writing ${filePath}`);
      }

      await fs.rename(target.effectivePath, transaction.capturedPath);
      captured = true;
      const capturedSnapshot = await this.readStableFile(transaction.capturedPath);
      if (
        capturedSnapshot.device !== original.device ||
        capturedSnapshot.inode !== original.inode ||
        capturedSnapshot.content !== expectedContent
      ) {
        throw new Error(`A concurrent writer reached ${filePath} while Resin fenced the target`);
      }

      await this.assertActiveLock(activeLock);
      await this.assertTransactionTargetUnchanged(target);
      try {
        await this.linkTransactionFile(transaction.plannedPath, target.effectivePath);
      } catch (error: unknown) {
        if (isAlreadyExistsError(error)) {
          throw new Error(
            `A concurrent writer recreated ${filePath} at Resin's final mutation boundary`,
          );
        }
        throw error;
      }

      const [persisted, capturedAfterWrite] = await Promise.all([
        this.readStableFile(target.effectivePath),
        this.readStableFile(transaction.capturedPath),
      ]);
      if (persisted.content !== content) {
        throw new Error(`Concurrent modification detected after writing ${filePath}`);
      }
      if (
        capturedAfterWrite.device !== capturedSnapshot.device ||
        capturedAfterWrite.inode !== capturedSnapshot.inode ||
        capturedAfterWrite.content !== capturedSnapshot.content ||
        capturedAfterWrite.modifiedNs !== capturedSnapshot.modifiedNs
      ) {
        throw new Error(
          `Concurrent bytes reached Resin's captured pre-write version of ${filePath}`,
        );
      }
      await this.assertTransactionTargetUnchanged(target);
      await this.cleanupTransaction(transaction);
      return true;
    } catch (error: unknown) {
      if (captured) {
        await this.restoreCapturedIfTargetMissing(transaction, target.effectivePath).catch(
          () => undefined,
        );
      }
      throw this.preservedTransactionError(filePath, transaction, error);
    }
  }

  async unlinkIfUnchanged(filePath: string, expectedContent: string): Promise<boolean> {
    const target = await this.resolveTransactionTarget(filePath);
    const activeLock = this.activeLocks.get(path.resolve(filePath));
    let original: StableFileSnapshot;
    try {
      original = await this.readStableFile(target.effectivePath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    if (original.content !== expectedContent) {
      return false;
    }

    const transaction = await this.prepareTransaction(target.effectivePath, "", 0o600);
    let captured = false;
    try {
      await this.verifyHardLinkSupport(transaction);
      await this.assertActiveLock(activeLock);
      await this.assertTransactionTargetUnchanged(target);
      const finalVersion = await fs.lstat(target.effectivePath, { bigint: true });
      if (
        !finalVersion.isFile() ||
        finalVersion.dev !== original.device ||
        finalVersion.ino !== original.inode
      ) {
        throw new Error(`Configuration identity changed immediately before removing ${filePath}`);
      }

      await fs.rename(target.effectivePath, transaction.capturedPath);
      captured = true;
      const capturedSnapshot = await this.readStableFile(transaction.capturedPath);
      if (
        capturedSnapshot.device !== original.device ||
        capturedSnapshot.inode !== original.inode ||
        capturedSnapshot.content !== expectedContent
      ) {
        throw new Error(`A concurrent writer reached ${filePath} while Resin fenced its removal`);
      }
      await this.assertActiveLock(activeLock);
      await this.assertTransactionTargetUnchanged(target);
      try {
        await fs.lstat(target.effectivePath);
        throw new Error(
          `A concurrent writer recreated ${filePath} at Resin's final removal boundary`,
        );
      } catch (error: unknown) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      const capturedBeforeDelete = await this.readStableFile(transaction.capturedPath);
      if (
        capturedBeforeDelete.content !== capturedSnapshot.content ||
        capturedBeforeDelete.modifiedNs !== capturedSnapshot.modifiedNs
      ) {
        throw new Error(`Concurrent bytes reached the captured removal version of ${filePath}`);
      }
      await this.cleanupTransaction(transaction);
      return (await this.readFile(target.effectivePath)) === null;
    } catch (error: unknown) {
      if (captured) {
        await this.restoreCapturedIfTargetMissing(transaction, target.effectivePath).catch(
          () => undefined,
        );
      }
      throw this.preservedTransactionError(filePath, transaction, error);
    }
  }

  async withFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
    const requestedPath = path.resolve(filePath);
    const canonicalTarget = await this.resolveLockTarget(filePath);
    const lockPath = path.join(
      path.dirname(canonicalTarget),
      `.${path.basename(canonicalTarget)}.resin-reconcile.lock`,
    );
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    const deadline = process.hrtime.bigint() + BigInt(RECONCILIATION_LOCK_WAIT_MS) * 1_000_000n;
    await this.waitForLockDirectory(lockPath, canonicalTarget, deadline);
    const claim = await this.createLockClaim(lockPath, canonicalTarget);
    const activeLock: ActiveReconciliationLock = {
      requestedPath,
      canonicalTarget,
      lockPath,
      claimPath: path.join(lockPath, `${claim.token}${LOCK_CLAIM_SUFFIX}`),
      claim,
      refreshTail: Promise.resolve(),
      releaseStarted: false,
    };

    let result: T | undefined;
    let actionError: unknown;
    let cleanupError: unknown;
    try {
      await this.waitUntilClaimIsElected(activeLock, deadline);
      this.activeLocks.set(requestedPath, activeLock);
      activeLock.heartbeat = setInterval(
        () => {
          void this.refreshLockLease(activeLock).catch(() => undefined);
        },
        Math.floor(RECONCILIATION_LOCK_LEASE_MS / 3),
      );
      activeLock.heartbeat.unref();
      result = await action();
    } catch (error: unknown) {
      actionError = error;
    } finally {
      activeLock.releaseStarted = true;
      clearInterval(activeLock.heartbeat);
      this.activeLocks.delete(requestedPath);
      await activeLock.refreshTail;
      try {
        await this.removeOwnedClaim(activeLock);
        await fs.rmdir(lockPath).catch((error: Error | { code?: string }) => {
          const code = "code" in error ? error.code : undefined;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
            throw error;
          }
        });
      } catch (error: unknown) {
        cleanupError = error;
      }
    }

    if (actionError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [actionError, cleanupError],
        `Reconciliation and lock cleanup both failed for ${filePath}`,
      );
    }
    if (actionError !== undefined) {
      throw actionError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
    // SAFETY: Locked action result returned to caller.
    return result as T;
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
  }

  async mkdirp(directoryPath: string): Promise<void> {
    await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    try {
      await fs.copyFile(sourcePath, destinationPath);
      await fs.chmod(destinationPath, 0o600);
    } catch (error: unknown) {
      await fs.unlink(destinationPath).catch(() => undefined);
      throw error;
    }
  }

  async unlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  async listFiles(directoryPath: string): Promise<readonly string[]> {
    try {
      const entries = await fs.readdir(directoryPath);
      return entries.map((entry) => path.join(directoryPath, entry));
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  protected async linkTransactionFile(sourcePath: string, destinationPath: string): Promise<void> {
    await fs.link(sourcePath, destinationPath);
  }

  private async prepareTransaction(
    targetPath: string,
    plannedContent: string,
    mode: number,
  ): Promise<ReconciliationTransaction> {
    const parentPath = path.dirname(targetPath);
    await fs.mkdir(parentPath, { recursive: true, mode: 0o700 });
    const directoryPath = path.join(
      parentPath,
      `.${path.basename(targetPath)}.resin-transaction-${randomUUID()}`,
    );
    await fs.mkdir(directoryPath, { mode: 0o700 });
    const transaction = {
      directoryPath,
      plannedPath: path.join(directoryPath, "planned"),
      capturedPath: path.join(directoryPath, "captured"),
      probePath: path.join(directoryPath, "link-probe"),
    };
    const handle = await fs.open(transaction.plannedPath, "wx", mode);
    try {
      await handle.writeFile(plannedContent, "utf8");
      await handle.sync();
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    return transaction;
  }

  private async verifyHardLinkSupport(transaction: ReconciliationTransaction): Promise<void> {
    try {
      await this.linkTransactionFile(transaction.plannedPath, transaction.probePath);
      await fs.unlink(transaction.probePath);
    } catch (error: unknown) {
      throw new Error(`Atomic filesystem compare-and-swap is unavailable: ${describeError(error)}`);
    }
  }

  private async cleanupTransaction(transaction: ReconciliationTransaction): Promise<void> {
    for (const ownedPath of [
      transaction.probePath,
      transaction.plannedPath,
      transaction.capturedPath,
    ]) {
      await fs.unlink(ownedPath).catch((error: Error | { code?: string }) => {
        if (!isMissingFileError(error)) {
          throw error;
        }
      });
    }
    await fs.rmdir(transaction.directoryPath);
  }

  private async restoreCapturedIfTargetMissing(
    transaction: ReconciliationTransaction,
    targetPath: string,
  ): Promise<void> {
    try {
      await this.linkTransactionFile(transaction.capturedPath, targetPath);
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private preservedTransactionError<TError>(
    filePath: string,
    transaction: ReconciliationTransaction,
    error: TError,
  ): Error {
    return new Error(
      `${describeError(error)}; Resin preserved both transaction versions at ${transaction.directoryPath} and did not claim reconciliation of ${filePath}`,
    );
  }

  private async readStableFile(filePath: string): Promise<StableFileSnapshot> {
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new Error(`Refusing to use non-regular file ${filePath}`);
      }
      const content = await handle.readFile("utf8");
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error(`File changed while Resin was taking a stable snapshot of ${filePath}`);
      }
      return {
        content,
        device: after.dev,
        inode: after.ino,
        size: after.size,
        modifiedNs: after.mtimeNs,
        changedNs: after.ctimeNs,
        mode: Number(after.mode & 0o777n),
        uid: after.uid,
      };
    } finally {
      await handle.close();
    }
  }

  private async resolveTransactionTarget(filePath: string): Promise<TransactionTarget> {
    const requestedPath = path.resolve(filePath);
    try {
      const entry = await fs.lstat(requestedPath, { bigint: true });
      if (!entry.isSymbolicLink()) {
        return { requestedPath, effectivePath: requestedPath };
      }
      let effectivePath: string;
      try {
        effectivePath = await fs.realpath(requestedPath);
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          throw new Error(`Refusing to reconcile broken symbolic link ${filePath}`);
        }
        throw error;
      }
      return {
        requestedPath,
        effectivePath,
        symbolicLink: {
          device: entry.dev,
          inode: entry.ino,
          linkTarget: await fs.readlink(requestedPath),
        },
      };
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { requestedPath, effectivePath: requestedPath };
      }
      throw error;
    }
  }

  private async assertTransactionTargetUnchanged(target: TransactionTarget): Promise<void> {
    if (target.symbolicLink === undefined) {
      return;
    }
    const entry = await fs.lstat(target.requestedPath, { bigint: true });
    if (
      !entry.isSymbolicLink() ||
      entry.dev !== target.symbolicLink.device ||
      entry.ino !== target.symbolicLink.inode ||
      (await fs.readlink(target.requestedPath)) !== target.symbolicLink.linkTarget
    ) {
      throw new Error(`Symbolic link changed while reconciling ${target.requestedPath}`);
    }
  }

  private async waitForLockDirectory(
    lockPath: string,
    canonicalTarget: string,
    deadline: bigint,
  ): Promise<void> {
    while (true) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        return;
      } catch (error: unknown) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }

      const entry = await fs.lstat(lockPath);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link reconciliation lock ${lockPath}`);
      }
      this.assertPrivateLockEntry(lockPath, entry.mode, entry.uid);
      if (entry.isDirectory()) {
        return;
      }
      if (!entry.isFile()) {
        throw new Error(`Refusing non-regular reconciliation lock ${lockPath}`);
      }

      const legacy = await this.readStableFile(lockPath);
      let active =
        Date.now() <= Number(legacy.modifiedNs / 1_000_000n) + RECONCILIATION_LOCK_LEASE_MS;
      try {
        const parsed = ReconciliationLockClaimSchema.safeParse(JSON.parse(legacy.content));
        if (parsed.success && parsed.data.targetPath === canonicalTarget) {
          active = await this.isLockClaimActive(parsed.data);
        }
      } catch {
        // A legacy v1 or malformed recent lock is conservatively leased by its mtime.
      }
      if (!active) {
        await this.fenceLegacyLock(lockPath, legacy);
        continue;
      }
      if (process.hrtime.bigint() >= deadline) {
        throw new Error(`Configuration reconciliation lock is already held: ${lockPath}`);
      }
      await this.waitForRetry();
    }
  }

  private async fenceLegacyLock(lockPath: string, expected: StableFileSnapshot): Promise<void> {
    const retiredPath = `${lockPath}.stale-${randomUUID()}`;
    await fs.rename(lockPath, retiredPath);
    const captured = await this.readStableFile(retiredPath);
    if (captured.device !== expected.device || captured.inode !== expected.inode) {
      await this.linkTransactionFile(retiredPath, lockPath).catch(() => undefined);
      throw new Error(
        `Reconciliation lock changed while fencing it; preserved replacement at ${retiredPath}`,
      );
    }
    await fs.unlink(retiredPath);
  }

  private async createLockClaim(
    lockPath: string,
    canonicalTarget: string,
  ): Promise<ReconciliationLockClaim> {
    const token = randomUUID();
    const createdMonotonicNs = process.hrtime.bigint();
    const claim: ReconciliationLockClaim = {
      format: RECONCILIATION_LOCK_FORMAT,
      token,
      fenceToken: `${createdMonotonicNs}:${token}`,
      targetPath: canonicalTarget,
      pid: process.pid,
      processStartIdentity:
        (await this.readProcessStartIdentity(process.pid)) ??
        `fallback:${process.pid}:${PROCESS_FALLBACK_INCARNATION}`,
      createdAt: Date.now(),
      createdMonotonicNs: createdMonotonicNs.toString(),
      leaseExpiresAt: Date.now() + RECONCILIATION_LOCK_LEASE_MS,
      leaseExpiresMonotonicNs: (
        createdMonotonicNs +
        BigInt(RECONCILIATION_LOCK_LEASE_MS) * 1_000_000n
      ).toString(),
    };
    const claimPath = path.join(lockPath, `${token}${LOCK_CLAIM_SUFFIX}`);
    await this.publishClaimFile(claimPath, claim);
    return claim;
  }

  private async publishClaimFile(claimPath: string, claim: ReconciliationLockClaim): Promise<void> {
    const temporaryPath = path.join(
      path.dirname(claimPath),
      `.${path.basename(claimPath)}.${randomUUID()}.tmp`,
    );
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(claim), "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    try {
      await this.linkTransactionFile(temporaryPath, claimPath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async waitUntilClaimIsElected(
    activeLock: ActiveReconciliationLock,
    deadline: bigint,
  ): Promise<void> {
    while (true) {
      const election = await this.scanLockClaims(activeLock.lockPath, activeLock.canonicalTarget);
      if (!election.blocked && election.winner?.claim.token === activeLock.claim.token) {
        return;
      }
      if (process.hrtime.bigint() >= deadline) {
        throw new Error(
          `Configuration reconciliation lock is already held: ${activeLock.lockPath}`,
        );
      }
      await this.waitForRetry();
    }
  }

  private async scanLockClaims(
    lockPath: string,
    canonicalTarget: string,
  ): Promise<{ readonly winner: ScannedLockClaim | null; readonly blocked: boolean }> {
    const directory = await fs.lstat(lockPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error(`Reconciliation lock directory was replaced: ${lockPath}`);
    }
    this.assertPrivateLockEntry(lockPath, directory.mode, directory.uid);

    const activeClaims: ScannedLockClaim[] = [];
    let blocked = false;
    for (const entryName of await fs.readdir(lockPath)) {
      if (!entryName.endsWith(LOCK_CLAIM_SUFFIX)) {
        continue;
      }
      const claimPath = path.join(lockPath, entryName);
      let snapshot: StableFileSnapshot;
      try {
        snapshot = await this.readStableFile(claimPath);
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw new Error(`Unsafe reconciliation lock claim ${claimPath}: ${describeError(error)}`);
      }
      this.assertPrivateLockEntry(claimPath, snapshot.mode, Number(snapshot.uid));
      let parsedClaim: ReconciliationLockClaim | null = null;
      try {
        const parsed = ReconciliationLockClaimSchema.safeParse(JSON.parse(snapshot.content));
        parsedClaim = parsed.success ? parsed.data : null;
      } catch {
        parsedClaim = null;
      }
      if (parsedClaim === null) {
        const leaseEnd = Number(snapshot.modifiedNs / 1_000_000n) + RECONCILIATION_LOCK_LEASE_MS;
        if (Date.now() <= leaseEnd) {
          blocked = true;
        } else {
          await this.retireStaleClaim(claimPath, snapshot, null);
        }
        continue;
      }
      if (parsedClaim.targetPath !== canonicalTarget) {
        throw new Error(`Reconciliation lock claim targets a different file: ${claimPath}`);
      }
      if (await this.isLockClaimActive(parsedClaim)) {
        activeClaims.push({ claimPath, claim: parsedClaim, snapshot });
      } else {
        await this.retireStaleClaim(claimPath, snapshot, parsedClaim.token);
      }
    }
    activeClaims.sort((left, right) => {
      const byTime = BigInt(left.claim.createdMonotonicNs) - BigInt(right.claim.createdMonotonicNs);
      return byTime < 0n
        ? -1
        : byTime > 0n
          ? 1
          : left.claim.fenceToken.localeCompare(right.claim.fenceToken);
    });
    return { winner: activeClaims[0] ?? null, blocked };
  }

  private async retireStaleClaim(
    claimPath: string,
    expected: StableFileSnapshot,
    expectedToken: string | null,
  ): Promise<void> {
    const retiredPath = `${claimPath}.retired-${randomUUID()}`;
    try {
      await fs.rename(claimPath, retiredPath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    const captured = await this.readStableFile(retiredPath);
    let capturedToken: string | null = null;
    try {
      const parsed = ReconciliationLockClaimSchema.safeParse(JSON.parse(captured.content));
      capturedToken = parsed.success ? parsed.data.token : null;
    } catch {
      capturedToken = null;
    }
    if (
      captured.device !== expected.device ||
      captured.inode !== expected.inode ||
      capturedToken !== expectedToken
    ) {
      throw new Error(
        `Reconciliation lock claim changed while fencing it; preserved at ${retiredPath}`,
      );
    }
    await fs.unlink(retiredPath);
  }

  private async isLockClaimActive(claim: ReconciliationLockClaim): Promise<boolean> {
    if (!this.isProcessAlive(claim.pid)) {
      return false;
    }
    if (claim.processStartIdentity.startsWith("proc:")) {
      const currentIdentity = await this.readProcessStartIdentity(claim.pid);
      if (currentIdentity !== null) {
        return currentIdentity === claim.processStartIdentity;
      }
    }
    return process.hrtime.bigint() <= BigInt(claim.leaseExpiresMonotonicNs);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return Boolean(error) && error instanceof Object && "code" in error && error.code === "EPERM";
    }
  }

  private async readProcessStartIdentity(pid: number): Promise<string | null> {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const closingParenthesis = stat.lastIndexOf(")");
      if (closingParenthesis < 0) {
        return null;
      }
      const fields = stat
        .slice(closingParenthesis + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      return startTime === undefined ? null : `proc:${startTime}`;
    } catch {
      return null;
    }
  }

  private refreshLockLease(activeLock: ActiveReconciliationLock): Promise<void> {
    if (activeLock.releaseStarted || activeLock.leaseError !== undefined) {
      return activeLock.refreshTail;
    }

    const refresh = activeLock.refreshTail.then(async () => {
      if (activeLock.releaseStarted || activeLock.leaseError !== undefined) {
        return;
      }
      await this.refreshLockLeaseNow(activeLock);
    });
    activeLock.refreshTail = refresh.catch((error: Error | string | { message?: string }) => {
      if (activeLock.leaseError === undefined) {
        activeLock.leaseError = error;
      }
    });
    return refresh;
  }

  private async refreshLockLeaseNow(activeLock: ActiveReconciliationLock): Promise<void> {
    const currentSnapshot = await this.readStableFile(activeLock.claimPath);
    const parsed = ReconciliationLockClaimSchema.parse(JSON.parse(currentSnapshot.content));
    if (
      parsed.token !== activeLock.claim.token ||
      parsed.fenceToken !== activeLock.claim.fenceToken
    ) {
      throw new Error(`Reconciliation lock claim was replaced: ${activeLock.claimPath}`);
    }
    if (!(await this.isLockClaimActive(parsed))) {
      throw new Error(`Reconciliation lock lease expired before it could be renewed`);
    }
    const now = process.hrtime.bigint();
    const refreshed: ReconciliationLockClaim = {
      ...parsed,
      leaseExpiresAt: Date.now() + RECONCILIATION_LOCK_LEASE_MS,
      leaseExpiresMonotonicNs: (now + BigInt(RECONCILIATION_LOCK_LEASE_MS) * 1_000_000n).toString(),
    };
    const temporaryPath = `${activeLock.claimPath}.refresh-${randomUUID()}`;
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(refreshed), "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    if (activeLock.releaseStarted) {
      await fs.unlink(temporaryPath);
      return;
    }
    await fs.rename(temporaryPath, activeLock.claimPath);
    activeLock.claim = refreshed;
  }

  private async assertActiveLock(activeLock: ActiveReconciliationLock | undefined): Promise<void> {
    if (activeLock === undefined) {
      return;
    }
    if (activeLock.leaseError !== undefined) {
      throw activeLock.leaseError;
    }
    await this.refreshLockLease(activeLock);
    const election = await this.scanLockClaims(activeLock.lockPath, activeLock.canonicalTarget);
    if (election.blocked || election.winner?.claim.fenceToken !== activeLock.claim.fenceToken) {
      throw new Error(`Reconciliation lock fence was lost for ${activeLock.requestedPath}`);
    }
  }

  private async removeOwnedClaim(activeLock: ActiveReconciliationLock): Promise<void> {
    let snapshot: StableFileSnapshot;
    try {
      snapshot = await this.readStableFile(activeLock.claimPath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    const parsed = ReconciliationLockClaimSchema.parse(JSON.parse(snapshot.content));
    if (
      parsed.token !== activeLock.claim.token ||
      parsed.fenceToken !== activeLock.claim.fenceToken
    ) {
      throw new Error(`Refusing to remove a reconciliation lock no longer owned by this process`);
    }
    await this.retireStaleClaim(activeLock.claimPath, snapshot, activeLock.claim.token);
  }

  private assertPrivateLockEntry(entryPath: string, mode: number, uid: number): void {
    if ((mode & 0o077) !== 0) {
      throw new Error(`Refusing reconciliation lock with unsafe permissions: ${entryPath}`);
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && uid !== currentUid) {
      throw new Error(`Refusing reconciliation lock owned by another user: ${entryPath}`);
    }
  }

  private async waitForRetry(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, RECONCILIATION_LOCK_RETRY_MS);
    });
  }

  private async resolveAtomicWriteTarget(filePath: string): Promise<string> {
    try {
      const entry = await fs.lstat(filePath);
      if (!entry.isSymbolicLink()) {
        return filePath;
      }
      try {
        return await fs.realpath(filePath);
      } catch (error: unknown) {
        if (isMissingFileError(error)) {
          throw new Error(`Refusing to replace broken symbolic link ${filePath}`);
        }
        throw error;
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return filePath;
      }
      throw error;
    }
  }

  private async resolveLockTarget(filePath: string): Promise<string> {
    try {
      return await fs.realpath(filePath);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      try {
        const entry = await fs.lstat(filePath);
        if (entry.isSymbolicLink()) {
          throw new Error(`Refusing to reconcile broken symbolic link ${filePath}`);
        }
      } catch (lstatError: unknown) {
        if (!isMissingFileError(lstatError)) {
          throw lstatError;
        }
      }
      const canonicalDirectory = await fs
        .realpath(path.dirname(filePath))
        .catch(() => path.resolve(path.dirname(filePath)));
      return path.join(canonicalDirectory, path.basename(filePath));
    }
  }
}

const defaultReconciliationFsBridge = new ReconciliationNodeFsBridge();

/**
 * Noninteractive, adapter-backed reconciliation for global Resin harness registrations.
 */
export class HarnessReconciler {
  private static readonly processLocks = new WeakMap<
    HarnessReconcileFsBridge,
    Map<string, Promise<void>>
  >();

  private lastBackupTimestamp = 0;
  private readonly knownBackups = new Map<string, Set<string>>();

  async reconcile(options: HarnessReconcileOptions = {}): Promise<HarnessReconciliationReport> {
    const now = options.now ?? (() => new Date());
    const autoRepair = options.autoRepair ?? DEFAULT_HARNESS_AUTO_REPAIR;
    const harnesses = [...new Set(options.harnesses ?? SUPPORTED_HARNESS_IDS)];
    const resolved: ResolvedReconcileOptions = {
      autoRepair,
      dryRun: options.dryRun ?? false,
      installedHarnesses: new Set(options.installedHarnesses ?? []),
      customHome: options.customHome ?? process.env.HOME ?? os.homedir(),
      workspacePath: options.workspacePath ?? process.cwd(),
      gatewayUrl: options.gatewayUrl ?? DEFAULT_GATEWAY_URL,
      fsBridge: options.fsBridge ?? defaultReconciliationFsBridge,
      probeHarness: options.probeHarness ?? probeHarnessInstallation,
      now,
      onHarnessDiscovered: options.onHarnessDiscovered,
      onPlanCreated: options.onPlanCreated,
    };

    const results: HarnessReconciliationResult[] = [];
    for (const harnessId of harnesses) {
      results.push(await this.reconcileHarness(harnessId, resolved));
    }

    return {
      success: results.every((result) => result.error === undefined),
      autoRepair,
      checkedAt: now().toISOString(),
      hasDrift: results.some(
        (result) =>
          result.installed &&
          (result.status === "unregistered" || result.status === "drift_detected"),
      ),
      results,
    };
  }

  async rollbackBackups(
    backups: readonly ConfigBackup[],
    fsBridge: ConfigFsBridge = defaultReconciliationFsBridge,
  ): Promise<void> {
    // SAFETY: fsBridge satisfies HarnessReconcileFsBridge required by reconciler.
    const reconciliationBridge = fsBridge as HarnessReconcileFsBridge;
    const failures: Error[] = [];
    for (const backup of [...backups].reverse()) {
      try {
        await this.withConfigLock(reconciliationBridge, backup.targetPath, async () => {
          await this.restoreAuthenticatedBackup(backup, reconciliationBridge);
        });
      } catch (error: unknown) {
        failures.push(
          new Error(
            `Unable to restore ${backup.targetPath} from ${backup.backupPath}: ${describeError(error)}`,
          ),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} harness configuration rollback(s) failed`,
      );
    }
  }

  private async reconcileHarness(
    harnessId: SupportedHarnessId,
    options: ResolvedReconcileOptions,
  ): Promise<HarnessReconciliationResult> {
    const targetPath = resolveHarnessConfigPath(harnessId, options.customHome);
    const displayName = HARNESS_DISPLAY_NAMES[harnessId];
    let configExists: boolean;

    try {
      configExists = await options.fsBridge.exists(targetPath);
    } catch (error: unknown) {
      return {
        harnessId,
        displayName,
        installed: false,
        targetPath,
        status: "drift_detected",
        condition: "not_installed",
        configured: false,
        changed: false,
        error: describeError(error),
      };
    }

    const installationAlreadyKnown = options.installedHarnesses.has(harnessId);
    let installation: HarnessInstallation | null = null;
    let probeDiagnostic: string | undefined;
    if (!installationAlreadyKnown) {
      try {
        installation = await options.probeHarness({
          harnessId,
          targetPath,
          customHome: options.customHome,
          fsBridge: options.fsBridge,
        });
        if (installation !== null) {
          options.onHarnessDiscovered?.(installation);
        }
      } catch (error: unknown) {
        probeDiagnostic = `Harness probe failed: ${describeError(error)}`;
      }
    }

    const installed =
      installationAlreadyKnown || installation?.isInstalled === true || configExists;
    if (!installed) {
      return {
        harnessId,
        displayName,
        installed: false,
        targetPath,
        status: "unregistered",
        condition: "not_installed",
        configured: false,
        changed: false,
        diagnostic: probeDiagnostic,
      };
    }

    let currentContent: string | null;
    try {
      currentContent = await options.fsBridge.readFile(targetPath);
    } catch (error: unknown) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "drift_detected",
        condition: "drifted",
        configured: false,
        changed: false,
        diagnostic: probeDiagnostic,
        error: describeError(error),
      };
    }

    const corruption = validateHarnessConfig(harnessId, targetPath, currentContent);
    if (corruption !== null) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "drift_detected",
        condition: "corrupt",
        configured: false,
        changed: false,
        diagnostic: probeDiagnostic,
        error: corruption,
      };
    }

    const adapterOptions = {
      harnessId,
      targetPath,
      workspacePath: options.workspacePath,
      gatewayUrl: options.gatewayUrl,
      fsBridge: options.fsBridge,
    } as const;

    let configured: boolean;
    try {
      configured = await verifyHarnessRegistration(adapterOptions);
    } catch (error: unknown) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "drift_detected",
        condition: "drifted",
        configured: false,
        changed: false,
        diagnostic: probeDiagnostic,
        error: describeError(error),
      };
    }

    if (configured) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "registered",
        condition: "healthy",
        configured: true,
        changed: false,
        diagnostic: probeDiagnostic,
      };
    }

    const condition: HarnessRegistrationCondition = hasResinRegistration(
      harnessId,
      targetPath,
      currentContent,
    )
      ? "drifted"
      : "missing";
    const detectedStatus: HarnessRegistrationStatus =
      condition === "missing" ? "unregistered" : "drift_detected";

    if (!options.autoRepair && !options.dryRun) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: detectedStatus,
        condition,
        configured: false,
        changed: false,
        diagnostic: probeDiagnostic,
      };
    }

    let plan: ConfigMutationPlan;
    try {
      const adapterPlan = await planHarnessRegistration(adapterOptions);
      plan = preserveUserOwnedServerFields(harnessId, targetPath, currentContent, adapterPlan);
      options.onPlanCreated?.(plan);
    } catch (error: unknown) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "drift_detected",
        condition,
        configured: false,
        changed: false,
        diagnostic: probeDiagnostic,
        error: describeError(error),
      };
    }

    const planError = validateMutationPlan(harnessId, targetPath, currentContent, plan);
    if (planError !== null) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "drift_detected",
        condition,
        configured: false,
        changed: false,
        plan,
        diagnostic: probeDiagnostic,
        error: planError,
      };
    }

    if (options.dryRun) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "reconciled",
        condition,
        configured: true,
        changed: false,
        plan,
        diagnostic: probeDiagnostic,
      };
    }

    const outcome = await this.applyAndVerifyPlan(
      plan,
      currentContent,
      adapterOptions,
      options.now,
    );
    if (!outcome.success) {
      return {
        harnessId,
        displayName,
        installed: true,
        targetPath,
        status: "drift_detected",
        condition,
        configured: false,
        changed: false,
        plan,
        backup: outcome.backup,
        rolledBack: outcome.rolledBack,
        diagnostic: combineDiagnostics(probeDiagnostic, outcome.warning),
        error: outcome.error ?? "Harness reconciliation failed",
      };
    }

    return {
      harnessId,
      displayName,
      installed: true,
      targetPath,
      status: "reconciled",
      condition,
      configured: true,
      changed: true,
      plan,
      backup: outcome.backup,
      diagnostic: combineDiagnostics(probeDiagnostic, outcome.warning),
    };
  }

  private async applyAndVerifyPlan(
    plan: ConfigMutationPlan,
    originalContent: string | null,
    adapterOptions: {
      readonly harnessId: SupportedHarnessId;
      readonly targetPath: string;
      readonly workspacePath: string;
      readonly gatewayUrl: string;
      readonly fsBridge: HarnessReconcileFsBridge;
    },
    now: () => Date,
  ): Promise<MutationOutcome> {
    const expectedHash = originalContent === null ? "" : computeConfigHash(originalContent);
    if (plan.preconditionHash !== expectedHash) {
      return {
        success: false,
        error: `Adapter plan precondition does not match ${plan.targetPath}`,
      };
    }

    try {
      return await this.withConfigLock(adapterOptions.fsBridge, plan.targetPath, async () =>
        this.applyAndVerifyPlanLocked(plan, originalContent, adapterOptions, now),
      );
    } catch (error: unknown) {
      return {
        success: false,
        error: `Unable to safely lock ${plan.targetPath}: ${describeError(error)}`,
      };
    }
  }

  private async applyAndVerifyPlanLocked(
    plan: ConfigMutationPlan,
    originalContent: string | null,
    adapterOptions: {
      readonly harnessId: SupportedHarnessId;
      readonly targetPath: string;
      readonly workspacePath: string;
      readonly gatewayUrl: string;
      readonly fsBridge: HarnessReconcileFsBridge;
    },
    now: () => Date,
  ): Promise<MutationOutcome> {
    let latestContent: string | null;
    try {
      latestContent = await adapterOptions.fsBridge.readFile(plan.targetPath);
    } catch (error: unknown) {
      return { success: false, error: describeError(error) };
    }
    if (latestContent !== originalContent) {
      return {
        success: false,
        error: `Configuration changed while planning ${plan.targetPath}; reconciliation was not applied`,
      };
    }

    let backup: ConfigBackup;
    try {
      backup = await this.createAuthenticatedBackup(
        plan,
        originalContent,
        now,
        adapterOptions.fsBridge,
      );
    } catch (error: unknown) {
      return {
        success: false,
        error: `Unable to create a safe backup for ${plan.targetPath}: ${describeError(error)}`,
      };
    }

    try {
      const beforeWrite = await adapterOptions.fsBridge.readFile(plan.targetPath);
      if (beforeWrite !== originalContent) {
        return {
          success: false,
          backup,
          error: `Configuration changed after backup creation for ${plan.targetPath}; reconciliation was not applied`,
        };
      }

      const applied = await this.compareAndSwap(
        adapterOptions.fsBridge,
        plan.targetPath,
        originalContent,
        plan.plannedContent,
      );
      if (!applied) {
        return {
          success: false,
          backup,
          error: `Configuration changed immediately before writing ${plan.targetPath}; reconciliation was not applied`,
        };
      }

      const persistedContent = await adapterOptions.fsBridge.readFile(plan.targetPath);
      if (persistedContent !== plan.plannedContent) {
        throw new Error(`Post-write content verification failed for ${plan.targetPath}`);
      }

      const corruption = validateHarnessConfig(
        adapterOptions.harnessId,
        adapterOptions.targetPath,
        persistedContent,
      );
      if (corruption !== null) {
        throw new Error(corruption);
      }
      if (!(await verifyHarnessRegistration(adapterOptions))) {
        throw new Error(`Adapter verification failed for ${plan.targetPath}`);
      }

      let warning: string | undefined;
      try {
        await this.pruneBackups(plan.targetPath, adapterOptions.fsBridge);
      } catch (error: unknown) {
        warning = `Backup retention cleanup failed: ${describeError(error)}`;
      }
      return { success: true, backup, warning };
    } catch (error: unknown) {
      let rolledBack = false;
      let rollbackError: string | undefined;
      try {
        await this.restoreAuthenticatedBackup(backup, adapterOptions.fsBridge);
        rolledBack = true;
      } catch (rollbackFailure: unknown) {
        rollbackError = describeError(rollbackFailure);
      }

      let warning: string | undefined;
      try {
        await this.pruneBackups(plan.targetPath, adapterOptions.fsBridge);
      } catch (retentionError: unknown) {
        warning = `Backup retention cleanup failed: ${describeError(retentionError)}`;
      }

      const primaryError = describeError(error);
      return {
        success: false,
        backup: rolledBack
          ? { ...backup, restored: true, restoredAt: now().toISOString() }
          : backup,
        rolledBack,
        warning,
        error:
          rollbackError === undefined
            ? `${primaryError}; original configuration restored`
            : `${primaryError}; rollback failed: ${rollbackError}`,
      };
    }
  }

  private async createAuthenticatedBackup(
    plan: ConfigMutationPlan,
    originalContent: string | null,
    now: () => Date,
    fsBridge: HarnessReconcileFsBridge,
  ): Promise<ConfigBackup> {
    let timestamp = Math.max(now().getTime(), this.lastBackupTimestamp + 1);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const backupId = randomUUID();
      const plannedContentHash = computeConfigHash(plan.plannedContent);
      const backupPath = `${plan.targetPath}.resin-backup.${timestamp}.${backupId}.${plannedContentHash}.bak`;
      const metadataPath = `${backupPath}.metadata.json`;
      const createdAt = new Date(timestamp).toISOString();
      const originalBytes = originalContent ?? "";
      const metadata: OwnedBackupMetadata = {
        format: BACKUP_FORMAT,
        backupId,
        targetPath: plan.targetPath,
        backupPath,
        metadataPath,
        originalContentHash: computeConfigHash(originalBytes),
        plannedContentHash,
        originalExisted: originalContent !== null,
        createdAt,
        timestamp,
      };

      if (!(await this.createExclusiveFile(fsBridge, backupPath, originalBytes))) {
        timestamp += 1;
        continue;
      }
      let metadataCreated = false;
      try {
        metadataCreated = await this.createExclusiveFile(
          fsBridge,
          metadataPath,
          `${JSON.stringify(metadata, null, 2)}\n`,
        );
        if (!metadataCreated) {
          throw new Error(`Backup metadata path already exists: ${metadataPath}`);
        }
        const backup: ConfigBackup = {
          backupId,
          targetPath: plan.targetPath,
          backupPath,
          contentHash: metadata.originalContentHash,
          originalContent: originalBytes,
          createdAt,
          restored: false,
        };
        await this.readOwnedBackupMetadata(plan.targetPath, backupPath, fsBridge, backup);
        this.lastBackupTimestamp = timestamp;
        this.rememberBackup(plan.targetPath, backupPath);
        return backup;
      } catch (error: unknown) {
        if (metadataCreated) {
          await fsBridge.unlink(metadataPath).catch(() => undefined);
        }
        await fsBridge.unlink(backupPath).catch(() => undefined);
        throw error;
      }
    }
    throw new Error(`Unable to exclusively claim a backup name for ${plan.targetPath}`);
  }

  private async restoreAuthenticatedBackup(
    backup: ConfigBackup,
    fsBridge: HarnessReconcileFsBridge,
  ): Promise<void> {
    if (computeConfigHash(backup.originalContent) !== backup.contentHash) {
      throw new Error(`Backup descriptor content hash is invalid for ${backup.backupPath}`);
    }
    const metadata = await this.readOwnedBackupMetadata(
      backup.targetPath,
      backup.backupPath,
      fsBridge,
      backup,
    );
    const currentContent = await fsBridge.readFile(backup.targetPath);
    const expectedOriginal = metadata.originalExisted ? backup.originalContent : null;
    if (currentContent === expectedOriginal) {
      return;
    }
    if (
      currentContent === null ||
      computeConfigHash(currentContent) !== metadata.plannedContentHash
    ) {
      throw new Error(
        `Configuration changed after Resin's write; refusing to overwrite ${backup.targetPath}`,
      );
    }

    const restored = metadata.originalExisted
      ? await this.compareAndSwap(
          fsBridge,
          backup.targetPath,
          currentContent,
          backup.originalContent,
        )
      : await this.unlinkIfUnchanged(fsBridge, backup.targetPath, currentContent);
    if (!restored || (await fsBridge.readFile(backup.targetPath)) !== expectedOriginal) {
      throw new Error(`Rollback compare-and-swap failed for ${backup.targetPath}`);
    }
  }

  private async readOwnedBackupMetadata(
    targetPath: string,
    backupPath: string,
    fsBridge: HarnessReconcileFsBridge,
    descriptor?: ConfigBackup,
  ): Promise<OwnedBackupMetadata> {
    const ownedName = parseOwnedBackupName(targetPath, backupPath);
    if (ownedName === null) {
      throw new Error(`Backup name is not Resin-owned: ${backupPath}`);
    }
    const metadataPath = `${backupPath}.metadata.json`;
    const [backupContent, metadataContent] = await Promise.all([
      fsBridge.readFile(backupPath),
      fsBridge.readFile(metadataPath),
    ]);
    if (backupContent === null || metadataContent === null) {
      throw new Error(`Backup or authenticated metadata is missing for ${backupPath}`);
    }

    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(metadataContent);
    } catch (error: unknown) {
      throw new Error(`Backup metadata is corrupt for ${backupPath}: ${describeError(error)}`);
    }
    const metadata = OwnedBackupMetadataSchema.parse(parsedMetadata);
    if (
      metadata.targetPath !== targetPath ||
      metadata.backupPath !== backupPath ||
      metadata.metadataPath !== metadataPath ||
      metadata.backupId !== ownedName.backupId ||
      metadata.timestamp !== ownedName.timestamp ||
      metadata.plannedContentHash !== ownedName.plannedContentHash ||
      metadata.originalContentHash !== computeConfigHash(backupContent)
    ) {
      throw new Error(`Backup ownership metadata does not authenticate ${backupPath}`);
    }
    if (
      descriptor !== undefined &&
      (descriptor.backupId !== metadata.backupId ||
        descriptor.targetPath !== metadata.targetPath ||
        descriptor.backupPath !== metadata.backupPath ||
        descriptor.contentHash !== metadata.originalContentHash ||
        descriptor.originalContent !== backupContent ||
        descriptor.createdAt !== metadata.createdAt)
    ) {
      throw new Error(`Backup descriptor does not match authenticated metadata for ${backupPath}`);
    }
    return metadata;
  }

  private async createExclusiveFile(
    fsBridge: HarnessReconcileFsBridge,
    filePath: string,
    content: string,
  ): Promise<boolean> {
    if (fsBridge.writeFileExclusive !== undefined) {
      return fsBridge.writeFileExclusive(filePath, content);
    }
    await fsBridge.mkdirp(path.dirname(filePath)).catch(() => {});
    if (await fsBridge.exists(filePath)) {
      return false;
    }
    await fsBridge.writeFile(filePath, content);
    if ((await fsBridge.readFile(filePath)) !== content) {
      throw new Error(`Exclusive file verification failed for ${filePath}`);
    }
    return true;
  }

  private async compareAndSwap(
    fsBridge: HarnessReconcileFsBridge,
    filePath: string,
    expectedContent: string | null,
    content: string,
  ): Promise<boolean> {
    if (fsBridge.compareAndSwapFile !== undefined) {
      return fsBridge.compareAndSwapFile(filePath, expectedContent, content);
    }
    if ((await fsBridge.readFile(filePath)) !== expectedContent) {
      return false;
    }
    await fsBridge.writeFile(filePath, content);
    return (await fsBridge.readFile(filePath)) === content;
  }

  private async unlinkIfUnchanged(
    fsBridge: HarnessReconcileFsBridge,
    filePath: string,
    expectedContent: string,
  ): Promise<boolean> {
    if (fsBridge.unlinkIfUnchanged !== undefined) {
      return fsBridge.unlinkIfUnchanged(filePath, expectedContent);
    }
    if ((await fsBridge.readFile(filePath)) !== expectedContent) {
      return false;
    }
    await fsBridge.unlink(filePath);
    return (await fsBridge.readFile(filePath)) === null;
  }

  private async withConfigLock<T>(
    fsBridge: HarnessReconcileFsBridge,
    targetPath: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (fsBridge.withFileLock !== undefined) {
      return fsBridge.withFileLock(targetPath, action);
    }

    const locks = HarnessReconciler.processLocks.get(fsBridge) ?? new Map<string, Promise<void>>();
    HarnessReconciler.processLocks.set(fsBridge, locks);
    const predecessor = locks.get(targetPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => current);
    locks.set(targetPath, tail);
    await predecessor;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(targetPath) === tail) {
        locks.delete(targetPath);
      }
    }
  }

  private rememberBackup(targetPath: string, backupPath: string): void {
    const paths = this.knownBackups.get(targetPath) ?? new Set<string>();
    paths.add(backupPath);
    this.knownBackups.set(targetPath, paths);
  }

  private async pruneBackups(
    targetPath: string,
    fsBridge: HarnessReconcileFsBridge,
  ): Promise<void> {
    const directoryPath = path.dirname(targetPath);
    const candidates = new Set(this.knownBackups.get(targetPath) ?? []);
    if (fsBridge.listFiles !== undefined) {
      for (const listedPath of await fsBridge.listFiles(directoryPath)) {
        const absolutePath = path.isAbsolute(listedPath)
          ? listedPath
          : path.join(directoryPath, listedPath);
        if (parseOwnedBackupName(targetPath, absolutePath) !== null) {
          candidates.add(absolutePath);
        }
      }
    } else if (fsBridge.dump !== undefined) {
      const dump = fsBridge.dump();
      for (const filePath of Object.keys(dump)) {
        if (parseOwnedBackupName(targetPath, filePath) !== null) {
          candidates.add(filePath);
        }
      }
    }

    const authenticated: Array<{
      readonly backupPath: string;
      readonly metadata: OwnedBackupMetadata;
    }> = [];
    for (const backupPath of candidates) {
      try {
        authenticated.push({
          backupPath,
          metadata: await this.readOwnedBackupMetadata(targetPath, backupPath, fsBridge),
        });
      } catch {
        // Unknown or tampered files are never eligible for retention deletion.
      }
    }
    authenticated.sort(
      (left, right) =>
        right.metadata.timestamp - left.metadata.timestamp ||
        right.backupPath.localeCompare(left.backupPath),
    );

    for (const obsolete of authenticated.slice(HARNESS_BACKUP_RETENTION)) {
      await fsBridge.unlink(obsolete.metadata.metadataPath);
      await fsBridge.unlink(obsolete.backupPath);
      candidates.delete(obsolete.backupPath);
    }
    this.knownBackups.set(
      targetPath,
      new Set(
        authenticated.slice(0, HARNESS_BACKUP_RETENTION).map((candidate) => candidate.backupPath),
      ),
    );
  }
}

/**
 * Convenience entry point for callers that do not need to retain a reconciler instance.
 */
export async function reconcileHarnessConfigs(
  options: HarnessReconcileOptions = {},
): Promise<HarnessReconciliationReport> {
  return new HarnessReconciler().reconcile(options);
}

function validateHarnessConfig(
  harnessId: SupportedHarnessId,
  targetPath: string,
  content: string | null,
): string | null {
  if (content === null || content.trim().length === 0) {
    return null;
  }

  const isJson = harnessId !== "codex-cli" || targetPath.endsWith(".json");
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      return `Corrupt ${harnessId} JSON configuration at ${targetPath}: ${describeError(error)}`;
    }

    const configResult = HarnessJsonObjectSchema.safeParse(parsed);
    if (!configResult.success) {
      return `Corrupt ${harnessId} configuration at ${targetPath}: expected a JSON object`;
    }
    const serverContainerKeys =
      harnessId === "codex-cli" ? ["mcpServers", "mcp_servers"] : ["mcpServers"];
    for (const key of serverContainerKeys) {
      if (
        key in configResult.data &&
        !HarnessJsonObjectSchema.safeParse(configResult.data[key]).success
      ) {
        return `Corrupt ${harnessId} configuration at ${targetPath}: ${key} must be an object`;
      }
    }
    return null;
  }

  try {
    parseCodexTomlConfig(content);
    return null;
  } catch (error: unknown) {
    return `Corrupt codex-cli TOML configuration at ${targetPath}: ${describeError(error)}`;
  }
}

function hasResinRegistration(
  harnessId: SupportedHarnessId,
  targetPath: string,
  content: string | null,
): boolean {
  if (content === null || content.trim().length === 0) {
    return false;
  }

  const serverName = RESIN_MCP_SERVER_KEYS[harnessId];
  if (harnessId !== "codex-cli" || targetPath.endsWith(".json")) {
    const parsed = HarnessJsonObjectSchema.parse(JSON.parse(content));
    const containerKeys =
      harnessId === "codex-cli" ? ["mcpServers", "mcp_servers"] : ["mcpServers"];
    return containerKeys.some((key) => {
      const serversResult = HarnessJsonObjectSchema.safeParse(parsed[key]);
      return serversResult.success && serverName in serversResult.data;
    });
  }

  return findCodexTomlServerConfig(parseCodexTomlConfig(content), serverName) !== null;
}

function preserveUserOwnedServerFields(
  harnessId: SupportedHarnessId,
  targetPath: string,
  currentContent: string | null,
  plan: ConfigMutationPlan,
): ConfigMutationPlan {
  if (currentContent === null || currentContent.trim().length === 0) {
    return plan;
  }
  if (harnessId === "codex-cli" && !targetPath.endsWith(".json")) {
    return plan;
  }

  const serverName = RESIN_MCP_SERVER_KEYS[harnessId];
  const currentConfig = HarnessJsonObjectSchema.parse(JSON.parse(currentContent));
  const plannedConfig = HarnessJsonObjectSchema.parse(JSON.parse(plan.plannedContent));
  const containerKeys = harnessId === "codex-cli" ? ["mcpServers", "mcp_servers"] : ["mcpServers"];

  for (const key of containerKeys) {
    const currentServersResult = HarnessJsonObjectSchema.safeParse(currentConfig[key]);
    const plannedServersResult = HarnessJsonObjectSchema.safeParse(plannedConfig[key]);
    if (!currentServersResult.success || !plannedServersResult.success) {
      continue;
    }
    let currentRawEntry = currentServersResult.data[serverName];
    if (!currentRawEntry) {
      for (const legacyAlias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
        const candidateResult = HarnessJsonObjectSchema.safeParse(
          currentServersResult.data[legacyAlias],
        );
        if (candidateResult.success && isRecognizedResinMcpEntry(candidateResult.data)) {
          currentRawEntry = candidateResult.data;
          break;
        }
      }
    }

    const currentEntryResult = HarnessJsonObjectSchema.safeParse(currentRawEntry);
    const plannedEntryResult = HarnessJsonObjectSchema.safeParse(
      plannedServersResult.data[serverName],
    );
    if (!currentEntryResult.success || !plannedEntryResult.success) {
      continue;
    }

    const mergedEntry = { ...currentEntryResult.data };
    for (const field of RESIN_OWNED_SERVER_FIELDS) {
      delete mergedEntry[field];
    }
    Object.assign(mergedEntry, plannedEntryResult.data);
    plannedConfig[key] = {
      ...plannedServersResult.data,
      [serverName]: mergedEntry,
    };
  }

  return {
    ...plan,
    plannedContent: `${JSON.stringify(plannedConfig, null, 2)}\n`,
  };
}

function validateMutationPlan(
  harnessId: SupportedHarnessId,
  targetPath: string,
  currentContent: string | null,
  plan: ConfigMutationPlan,
): string | null {
  if (plan.harnessId !== harnessId || plan.targetPath !== targetPath) {
    return `Adapter returned a mutation plan for the wrong harness or target path`;
  }

  const plannedCorruption = validateHarnessConfig(harnessId, targetPath, plan.plannedContent);
  if (plannedCorruption !== null) {
    return `Adapter produced an invalid configuration: ${plannedCorruption}`;
  }
  if (currentContent === null || currentContent.trim().length === 0) {
    return null;
  }

  if (harnessId === "codex-cli" && !targetPath.endsWith(".json")) {
    const before = projectCodexTomlUserConfig(currentContent, RESIN_MCP_SERVER_KEYS[harnessId]);
    const after = projectCodexTomlUserConfig(plan.plannedContent, RESIN_MCP_SERVER_KEYS[harnessId]);
    return isDeepStrictEqual(before, after)
      ? null
      : "Adapter mutation would modify user-owned Codex settings";
  }

  const before = projectUserOwnedJson(currentContent, harnessId);
  const after = projectUserOwnedJson(plan.plannedContent, harnessId);
  return isDeepStrictEqual(before, after)
    ? null
    : `Adapter mutation would modify user-owned ${harnessId} settings`;
}

function projectUserOwnedJson(content: string, harnessId: SupportedHarnessId): HarnessJsonObject {
  const projected = HarnessJsonObjectSchema.parse(JSON.parse(content));
  const serverName: string = RESIN_MCP_SERVER_KEYS[harnessId];
  const containerKeys = harnessId === "codex-cli" ? ["mcpServers", "mcp_servers"] : ["mcpServers"];

  for (const key of containerKeys) {
    const serversResult = HarnessJsonObjectSchema.safeParse(projected[key]);
    if (!serversResult.success) {
      continue;
    }

    const userServers = { ...serversResult.data };

    let legacyExtras: HarnessJsonObject | null = null;
    for (const legacyAlias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
      if (legacyAlias in userServers && legacyAlias !== serverName) {
        const legacyEntryResult = HarnessJsonObjectSchema.safeParse(userServers[legacyAlias]);
        if (legacyEntryResult.success && isRecognizedResinMcpEntry(legacyEntryResult.data)) {
          const userEntry = { ...legacyEntryResult.data };
          for (const field of RESIN_OWNED_SERVER_FIELDS) {
            delete userEntry[field];
          }
          if (Object.keys(userEntry).length > 0 && legacyExtras === null) {
            legacyExtras = userEntry;
          }
          delete userServers[legacyAlias];
        }
      }
    }

    const entryResult = HarnessJsonObjectSchema.safeParse(userServers[serverName]);
    if (entryResult.success) {
      const userEntry = { ...entryResult.data };
      for (const field of RESIN_OWNED_SERVER_FIELDS) {
        delete userEntry[field];
      }
      if (Object.keys(userEntry).length === 0) {
        delete userServers[serverName];
      } else {
        userServers[serverName] = userEntry;
      }
    } else {
      delete userServers[serverName];
    }

    if (legacyExtras !== null && !(serverName in userServers)) {
      userServers[serverName] = legacyExtras;
    }

    if (Object.keys(userServers).length === 0) {
      delete projected[key];
    } else {
      projected[key] = userServers;
    }
  }

  return projected;
}

function parseOwnedBackupName(
  targetPath: string,
  backupPath: string,
): {
  readonly timestamp: number;
  readonly backupId: string;
  readonly plannedContentHash: string;
} | null {
  if (path.dirname(backupPath) !== path.dirname(targetPath)) {
    return null;
  }
  const prefix = `${path.basename(targetPath)}.resin-backup.`;
  const basename = path.basename(backupPath);
  if (!basename.startsWith(prefix)) {
    return null;
  }
  const match =
    /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})\.bak$/.exec(
      basename.slice(prefix.length),
    );
  if (match === null) {
    return null;
  }
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp)
    ? {
        timestamp,
        backupId: match[2]!,
        plannedContentHash: match[3]!,
      }
    : null;
}

function combineDiagnostics(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (first && second) {
    return `${first}; ${second}`;
  }
  return first ?? second;
}

function isAlreadyExistsError(cause: unknown): cause is NodeJS.ErrnoException {
  return Boolean(cause) && cause instanceof Object && "code" in cause && cause.code === "EEXIST";
}

function isMissingFileError(cause: unknown): cause is NodeJS.ErrnoException {
  return Boolean(cause) && cause instanceof Object && "code" in cause && cause.code === "ENOENT";
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause ?? "");
}
