import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NormalizedSessionEvent,
  RESIN_WORKING_DIRECTORY_METADATA_KEY,
  WORKING_DIRECTORY_IDENTITY_HEX_LENGTH,
  type WorkingDirectoryIdentity,
} from "@resin/contracts";
import { localCallWorkingDirectory } from "../normalization/local-workflow-payload.js";

/** Domain label of the key derived from the device secret; distinct from every other use of it. */
const KEY_DERIVATION_LABEL = "resin:working-directory-identity:v1";
const MAX_CACHED_DIRECTORIES = 1024;
const MAX_ANCESTORS = 128;

type PathFlavor = "posix" | "win32";

/** A Windows drive (`C:\`, `c:/`) or UNC (`\\server\share`) absolute path. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/;

/** The flavor of an absolute path, or undefined when it is not absolute in either. */
function absoluteFlavor(value: string): PathFlavor | undefined {
  if (WINDOWS_ABSOLUTE.test(value)) return "win32";
  if (value.startsWith("/")) return "posix";
  return undefined;
}

function nativeFlavor(): PathFlavor {
  return process.platform === "win32" ? "win32" : "posix";
}

/** A recorded `file:` URL names a path; anything else is taken as the path itself. */
function recordedPath(value: string): string | undefined {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

/** Expands a leading `~` the way a shell would, against this device's home. */
function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

export interface EffectiveDirectory {
  /** Normalized absolute path in its own flavor, still in its recorded case. */
  path: string;
  flavor: PathFlavor;
}

/**
 * The directory a call ran in: its own working-directory argument resolved against the session's
 * directory, or the session's directory when the call names none. Pure path arithmetic: nothing is
 * read from disk, so the same recording yields the same directory anywhere. Undefined when the
 * directory cannot be established (a relative argument, or none, without an absolute session
 * directory).
 */
export function effectiveWorkingDirectory(
  callDirectory: string | undefined,
  sessionDirectory: string | undefined,
  homeDir: string = os.homedir(),
): EffectiveDirectory | undefined {
  const session = sessionDirectory === undefined ? undefined : recordedPath(sessionDirectory);
  const sessionFlavor = session === undefined ? undefined : absoluteFlavor(session);
  const base =
    session !== undefined && sessionFlavor !== undefined
      ? { path: path[sessionFlavor].resolve(session), flavor: sessionFlavor }
      : undefined;
  if (callDirectory === undefined || callDirectory.length === 0) return base;
  const recorded = recordedPath(callDirectory);
  if (recorded === undefined) return undefined;
  const expanded = expandHome(recorded, homeDir);
  const flavor = absoluteFlavor(expanded);
  if (flavor !== undefined) return { path: path[flavor].resolve(expanded), flavor };
  if (base === undefined) return undefined;
  return { path: path[base.flavor].resolve(base.path, expanded), flavor: base.flavor };
}

/** Windows paths name the same directory in any case; compare them case-folded. */
function canonicalText(directory: EffectiveDirectory): string {
  return directory.flavor === "win32" ? directory.path.toLowerCase() : directory.path;
}

/**
 * The nearest ancestor (or the directory itself) holding a `.git` entry — a directory for a
 * repository, a file for a worktree or submodule. Only this device's own filesystem is consulted,
 * and only for a path in its native flavor; no git command runs and nothing is fetched.
 */
export function findRepositoryRoot(directory: EffectiveDirectory): string | undefined {
  if (directory.flavor !== nativeFlavor()) return undefined;
  const flavorPath = path[directory.flavor];
  let current = directory.path;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    try {
      if (fs.lstatSync(flavorPath.join(current, ".git"), { throwIfNoEntry: false }) !== undefined) {
        return current;
      }
    } catch {
      return undefined;
    }
    const parent = flavorPath.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

export interface WorkingDirectoryIdentifierOptions {
  /**
   * The device-local secret (the redaction key under the Resin data directory, mode 0600). It is
   * never uploaded; only a key derived from it under a fixed label keys the identities. Without it
   * no identity is produced.
   */
  deviceKey: () => Uint8Array | undefined;
  /** Locates a directory's repository root; defaults to the local `.git` walk. */
  findRepositoryRoot?: (directory: EffectiveDirectory) => string | undefined;
  homeDir?: string;
}

/**
 * Gives recorded calls a value-free working-directory identity the cloud can compare for equality
 * only: a truncated HMAC-SHA256 of the normalized absolute path under a key derived from the
 * device secret. No path text, and nothing from which one could be recovered or confirmed without
 * that secret, is attached.
 */
export class WorkingDirectoryIdentifier {
  private readonly deviceKey: () => Uint8Array | undefined;
  private readonly locateRepository: (directory: EffectiveDirectory) => string | undefined;
  private readonly homeDir: string;
  private derived: { source: Uint8Array; key: Buffer } | undefined;
  /** Repository root per canonical directory (null: none), least recently used first. */
  private readonly repositories = new Map<string, string | null>();

  constructor(options: WorkingDirectoryIdentifierOptions) {
    this.deviceKey = options.deviceKey;
    this.locateRepository = options.findRepositoryRoot ?? findRepositoryRoot;
    this.homeDir = options.homeDir ?? os.homedir();
  }

  /** The identity of a directory, or undefined without a device secret. */
  identify(directory: EffectiveDirectory): WorkingDirectoryIdentity | undefined {
    const key = this.key();
    if (key === undefined) return undefined;
    const canonical = canonicalText(directory);
    const identity: WorkingDirectoryIdentity = { directory: digest(key, canonical) };
    const root = this.repositoryRoot(canonical, directory);
    if (root !== undefined) {
      identity.repository = digest(
        key,
        canonicalText({ path: path[directory.flavor].resolve(root), flavor: directory.flavor }),
      );
    }
    return identity;
  }

  /**
   * Attaches the identity of the directory `source` ran in to `target`'s metadata (`target` is the
   * event `source` became after the recorders; they may be the same object). `source` must be the
   * normalization pipeline's own event, which alone holds the call's unredacted working directory.
   * Only calls (`tool_call`, `command_exec`) are identified; an unknown directory attaches nothing.
   */
  annotate(
    source: NormalizedSessionEvent,
    target: NormalizedSessionEvent,
    sessionDirectory: string | undefined,
  ): void {
    if (target.metadata !== undefined) delete target.metadata[RESIN_WORKING_DIRECTORY_METADATA_KEY];
    if (source.type !== "tool_call" && source.type !== "command_exec") return;
    const named = localCallWorkingDirectory(source);
    if (named === undefined) return;
    const directory = effectiveWorkingDirectory(named.directory, sessionDirectory, this.homeDir);
    if (directory === undefined) return;
    const identity = this.identify(directory);
    if (identity === undefined) return;
    target.metadata ??= {};
    target.metadata[RESIN_WORKING_DIRECTORY_METADATA_KEY] = identity;
  }

  private key(): Buffer | undefined {
    let source: Uint8Array | undefined;
    try {
      source = this.deviceKey();
    } catch {
      return undefined;
    }
    if (source === undefined || source.length === 0) return undefined;
    if (this.derived?.source !== source) {
      this.derived = {
        source,
        key: createHmac("sha256", source).update(KEY_DERIVATION_LABEL).digest(),
      };
    }
    return this.derived.key;
  }

  private repositoryRoot(canonical: string, directory: EffectiveDirectory): string | undefined {
    const cached = this.repositories.get(canonical);
    if (cached !== undefined) {
      this.repositories.delete(canonical);
      this.repositories.set(canonical, cached);
      return cached ?? undefined;
    }
    let root: string | undefined;
    try {
      root = this.locateRepository(directory);
    } catch {
      root = undefined;
    }
    this.repositories.set(canonical, root ?? null);
    while (this.repositories.size > MAX_CACHED_DIRECTORIES) {
      const oldest = this.repositories.keys().next();
      if (oldest.done) break;
      this.repositories.delete(oldest.value);
    }
    return root;
  }
}

function digest(key: Buffer, canonicalPath: string): string {
  return createHmac("sha256", key)
    .update(canonicalPath, "utf8")
    .digest("hex")
    .slice(0, WORKING_DIRECTORY_IDENTITY_HEX_LENGTH);
}
