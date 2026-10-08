/**
 * The device-independent identity of the git repository enclosing a directory: the lowercase hex
 * SHA-256 of its sorted, newline-joined root commit ids. Every clone and worktree of a repository
 * shares it; different repositories do not. Undefined outside a repository, in one without
 * commits, or when git is unavailable.
 *
 * Interim gateway copy of the shared `repositoryIdentity` the observer exports; integration
 * replaces this module's body with a re-export of that function, keeping the same signature.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

export interface RepositoryIdentity {
  /** 64 lowercase hex characters. */
  id: string;
  /** The repository's working tree root. */
  root: string;
}

/** How long one git query may take: discovery never waits on a slow or hung git. */
const GIT_TIMEOUT_MS = 1_500;

const byDirectory = new Map<string, RepositoryIdentity | null>();
const byRoot = new Map<string, RepositoryIdentity | null>();

function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The identity of the repository enclosing `dir`, cached per directory and per root. */
export function repositoryIdentity(dir: string): RepositoryIdentity | undefined {
  const directory = path.resolve(dir);
  const known = byDirectory.get(directory);
  if (known !== undefined) return known ?? undefined;
  const root = git(directory, ["rev-parse", "--show-toplevel"])?.trim();
  let identity: RepositoryIdentity | null = null;
  if (root) {
    const cached = byRoot.get(root);
    if (cached !== undefined) {
      identity = cached;
    } else {
      const commits = (git(root, ["rev-list", "--max-parents=0", "HEAD"]) ?? "")
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter((line) => /^[0-9a-f]{40,64}$/.test(line))
        .sort();
      identity =
        commits.length === 0
          ? null
          : { id: crypto.createHash("sha256").update(commits.join("\n")).digest("hex"), root };
      byRoot.set(root, identity);
    }
  }
  byDirectory.set(directory, identity);
  return identity ?? undefined;
}
