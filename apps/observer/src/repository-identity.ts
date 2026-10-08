/**
 * Device-independent identity of the git repository enclosing a directory.
 *
 * Lean on purpose: only Node builtins, so a per-command hook can import it (as
 * `@resin/observer/repository-identity`) without loading the observer.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RepositoryIdentity {
  /**
   * Lowercase hex SHA-256 of the repository's root commit ids (lowercased, sorted, joined by
   * `\n`, no trailing newline). The same for every clone and worktree of one repository.
   */
  id: string;
  /** Real path of the checkout's root: the nearest ancestor holding `.git`. */
  root: string;
}

/** How long one `git` call may take before the repository counts as unknown. */
const GIT_TIMEOUT_MS = 1500;
/** How long an unknown answer is remembered before git is asked again. */
const UNKNOWN_TTL_MS = 30_000;
const MAX_CACHED = 1024;
const MAX_ANCESTORS = 128;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type CachedId = { id: string } | { unknownUntil: number };
const idsByRoot = new Map<string, CachedId>();

function remember(root: string, value: CachedId): void {
  idsByRoot.delete(root);
  idsByRoot.set(root, value);
  while (idsByRoot.size > MAX_CACHED) {
    const oldest = idsByRoot.keys().next();
    if (oldest.done) break;
    idsByRoot.delete(oldest.value);
  }
}

/** Forgets every cached identity; for tests. */
export function clearRepositoryIdentityCache(): void {
  idsByRoot.clear();
}

/** The nearest ancestor of a real directory (or itself) holding a `.git` entry. */
function checkoutRoot(realDirectory: string): string | undefined {
  let current = realDirectory;
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    try {
      if (fs.lstatSync(path.join(current, ".git"), { throwIfNoEntry: false }) !== undefined) {
        return current;
      }
    } catch {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * The common git directory of a checkout: `.git` itself, or for a worktree or submodule the
 * directory its `.git` file names, followed through `commondir`. Read without running git.
 */
function commonGitDirectory(root: string): string | undefined {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.statSync(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (match === null) return undefined;
      gitDir = path.resolve(root, match[1]!);
    }
    const commonFile = path.join(gitDir, "commondir");
    if (fs.existsSync(commonFile)) {
      return path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim());
    }
    return gitDir;
  } catch {
    return undefined;
  }
}

function computeId(root: string): string | undefined {
  const common = commonGitDirectory(root);
  // A shallow clone's boundary commits look parentless: its "roots" depend on the clone depth.
  if (common === undefined || fs.existsSync(path.join(common, "shallow"))) return undefined;
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return undefined;
  }
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const commits = result.stdout
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);
  if (commits.length === 0 || !commits.every((commit) => COMMIT_ID.test(commit))) return undefined;
  const unique = [...new Set(commits)].sort();
  return createHash("sha256").update(unique.join("\n"), "utf8").digest("hex");
}

/**
 * The repository enclosing `directory`: its device-independent id and the checkout root. Undefined
 * outside a git checkout, for a repository without commits or a shallow clone, or when git is
 * unavailable or slower than a short timeout. Synchronous; git runs at most once per checkout
 * root (unknown answers are retried after a while).
 */
export function repositoryIdentity(directory: string): RepositoryIdentity | undefined {
  let real: string;
  try {
    real = fs.realpathSync.native(directory);
    if (!fs.statSync(real).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const root = checkoutRoot(real);
  if (root === undefined) return undefined;
  const cached = idsByRoot.get(root);
  if (cached !== undefined) {
    if ("id" in cached) {
      remember(root, cached);
      return { id: cached.id, root };
    }
    if (cached.unknownUntil > Date.now()) return undefined;
  }
  const id = computeId(root);
  remember(root, id === undefined ? { unknownUntil: Date.now() + UNKNOWN_TTL_MS } : { id });
  return id === undefined ? undefined : { id, root };
}

/**
 * `directory` relative to `root`, POSIX separators, `""` at the root; undefined when it is not
 * inside `root`. Both are resolved through the filesystem, so symlinked spellings agree.
 */
export function repositoryRelativeDirectory(root: string, directory: string): string | undefined {
  let realRoot: string;
  let realDirectory: string;
  try {
    realRoot = fs.realpathSync.native(root);
    realDirectory = fs.realpathSync.native(directory);
  } catch {
    return undefined;
  }
  const relative = path.relative(realRoot, realDirectory);
  if (relative === "") return "";
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}
