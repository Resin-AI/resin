import { type Stats, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecordedWorkflow } from "@resin/contracts";
import { RESIN_PROCESS_RUNTIME, RESIN_PROGRAM_RUNTIME, isSensitivePath } from "@resin/runtime";
import {
  type LocalWorkflowValidationResult,
  type LocalWorkflowValidatorOptions,
  createLocalWorkflowValidator,
} from "./workflow-validation.js";

const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const COPY_CHUNK_BYTES = 64 * 1024;
const OMITTED_DIRECTORY_NAMES: Record<string, true> = {
  node_modules: true,
  dist: true,
  build: true,
  coverage: true,
  __pycache__: true,
  venv: true,
};

interface SnapshotState {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly buffer: Buffer;
  entries: number;
  files: number;
  bytes: number;
}

/** A runtime process exists before the host has supplied a trusted workspace context. */
export type WorkspaceSnapshotSource = { ready: false } | { ready: true; root?: string };

export class ReplayWorkspaceUnavailableError extends Error {
  constructor() {
    super("trusted replay workspace inputs are unavailable");
    this.name = "ReplayWorkspaceUnavailableError";
  }
}

/**
 * Builds the production validator around a lazy, trusted recorded-project lookup. Relative project
 * inputs are copied once per program replay; an unavailable binding remains pending.
 */
export function createWorkspaceSnapshotValidator(
  sourceWorkspace: (
    plan: RecordedWorkflow,
  ) => WorkspaceSnapshotSource | Promise<WorkspaceSnapshotSource>,
  options: LocalWorkflowValidatorOptions,
): (plan: RecordedWorkflow) => Promise<LocalWorkflowValidationResult> {
  const isolatedValidator = createLocalWorkflowValidator(options);
  return async (plan) => {
    if (options.workspaceDir !== undefined) return await isolatedValidator(plan);

    let source: WorkspaceSnapshotSource;
    try {
      source = await sourceWorkspace(plan);
    } catch {
      throw new ReplayWorkspaceUnavailableError();
    }
    if (!source.ready) throw new ReplayWorkspaceUnavailableError();
    if (!containsRecordedProgram(plan)) return await isolatedValidator(plan);
    if (source.root === undefined || source.root.length === 0) {
      return await isolatedValidator(plan);
    }

    let workspaceDir: string;
    try {
      workspaceDir = await createSnapshot(source.root);
    } catch {
      throw new ReplayWorkspaceUnavailableError();
    }
    try {
      return await createLocalWorkflowValidator({ ...options, workspaceDir })(plan);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

function containsRecordedProgram(plan: RecordedWorkflow): boolean {
  return plan.steps.some(
    (step) =>
      step.callable.program !== undefined &&
      (step.callable.runtime === RESIN_PROGRAM_RUNTIME ||
        step.callable.runtime === RESIN_PROCESS_RUNTIME),
  );
}

async function createSnapshot(sourceWorkspaceRoot: string): Promise<string> {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "resin-replay-snapshot-"));
  try {
    const sourcePath = path.resolve(sourceWorkspaceRoot);
    const sourceEntry = await fs.lstat(sourcePath);
    if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) {
      throw new Error("the ready workspace root is not a regular directory");
    }
    const sourceRoot = await fs.realpath(sourcePath);
    const destinationRoot = await fs.realpath(destination);
    const [sourceStat, destinationStat] = await Promise.all([
      fs.stat(sourceRoot),
      fs.stat(destinationRoot),
    ]);
    if (
      !sourceStat.isDirectory() ||
      !destinationStat.isDirectory() ||
      sourceStat.dev !== sourceEntry.dev ||
      sourceStat.ino !== sourceEntry.ino
    ) {
      throw new Error("the ready workspace root changed during snapshot preparation");
    }
    if (
      overlaps(sourceRoot, destinationRoot) ||
      (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino)
    ) {
      throw new Error("the ready workspace and replay destination overlap");
    }

    const state: SnapshotState = {
      sourceRoot,
      destinationRoot,
      buffer: Buffer.alloc(COPY_CHUNK_BYTES),
      files: 0,
      bytes: 0,
      entries: 0,
    };
    await copyDirectory(sourceRoot, destinationRoot, "", state);
    return destination;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory: string,
  state: SnapshotState,
): Promise<void> {
  const canonicalDirectory = await fs.realpath(sourceDirectory);
  if (canonicalDirectory !== sourceDirectory) {
    throw new Error("the ready workspace changed through a symlink during snapshotting");
  }

  const entries = await fs.opendir(sourceDirectory);
  for await (const entry of entries) {
    state.entries += 1;
    if (state.entries > MAX_SNAPSHOT_ENTRIES) {
      throw new Error("the ready workspace exceeds the replay snapshot entry-count limit");
    }
    if (entry.name.startsWith(".")) continue;

    const relativePath = path.join(relativeDirectory, entry.name);
    const sourcePath = containedPath(state.sourceRoot, relativePath);
    const destinationPath = containedPath(state.destinationRoot, relativePath);
    if (isSensitivePath(relativePath, state.sourceRoot)) continue;

    const sourceStat = await fs.lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) continue;
    if (sourceStat.isDirectory()) {
      if (Object.hasOwn(OMITTED_DIRECTORY_NAMES, entry.name)) continue;
      const realDirectory = await fs.realpath(sourcePath);
      if (realDirectory !== sourcePath) {
        throw new Error("the ready workspace changed through a symlink during snapshotting");
      }
      await fs.mkdir(destinationPath, { mode: 0o700 });
      await copyDirectory(sourcePath, destinationPath, relativePath, state);
      continue;
    }
    if (!sourceStat.isFile()) continue;
    await copyRegularFile(sourcePath, destinationPath, sourceStat, state);
  }
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  discoveredStat: Stats,
  state: SnapshotState,
): Promise<void> {
  if (state.files >= MAX_SNAPSHOT_FILES) {
    throw new Error("the ready workspace exceeds the replay snapshot file-count limit");
  }
  if (discoveredStat.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw new Error("a ready workspace file exceeds the replay snapshot per-file size limit");
  }
  if (state.bytes + discoveredStat.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("the ready workspace exceeds the replay snapshot total size limit");
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fsConstants.O_NONBLOCK ?? 0;
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | noFollow | nonBlocking);
  let destination: FileHandle | undefined;
  try {
    const openedStat = await source.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== discoveredStat.dev ||
      openedStat.ino !== discoveredStat.ino
    ) {
      throw new Error("a ready workspace file changed during replay snapshotting");
    }
    if (openedStat.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error("a ready workspace file exceeds the replay snapshot per-file size limit");
    }
    if (state.bytes + openedStat.size > MAX_SNAPSHOT_BYTES) {
      throw new Error("the ready workspace exceeds the replay snapshot total size limit");
    }

    const realSourcePath = await fs.realpath(sourcePath);
    if (realSourcePath !== sourcePath) {
      throw new Error("the ready workspace changed through a symlink during snapshotting");
    }
    destination = await fs.open(destinationPath, "wx", 0o600);

    let copiedBytes = 0;
    while (true) {
      const { bytesRead } = await source.read(state.buffer, 0, state.buffer.length, null);
      if (bytesRead === 0) break;
      if (
        copiedBytes + bytesRead > MAX_SNAPSHOT_FILE_BYTES ||
        state.bytes + copiedBytes + bytesRead > MAX_SNAPSHOT_BYTES
      ) {
        throw new Error("the ready workspace exceeds a replay snapshot size limit");
      }

      let writtenBytes = 0;
      while (writtenBytes < bytesRead) {
        const { bytesWritten } = await destination.write(
          state.buffer,
          writtenBytes,
          bytesRead - writtenBytes,
          null,
        );
        if (bytesWritten === 0) throw new Error("could not write the replay workspace snapshot");
        writtenBytes += bytesWritten;
      }
      copiedBytes += bytesRead;
    }

    const finalStat = await source.stat();
    if (
      copiedBytes !== openedStat.size ||
      finalStat.size !== openedStat.size ||
      finalStat.mtimeMs !== openedStat.mtimeMs ||
      finalStat.ctimeMs !== openedStat.ctimeMs
    ) {
      throw new Error("a ready workspace file changed during replay snapshotting");
    }
    await destination.chmod((openedStat.mode & 0o111) | 0o600);
    state.files += 1;
    state.bytes += copiedBytes;
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

function containedPath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("a replay workspace path escaped its snapshot root");
  }
  return resolved;
}

function overlaps(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
