/**
 * Device-independent repository identity for command suggestions: the lowercase hex SHA-256 of the
 * sorted, newline-joined root commit IDs of the git repository enclosing a directory. The same for
 * every clone and worktree of a repository, different across repositories, and undefined outside a
 * git repository, in a shallow clone, or when git is unavailable.
 *
 * Integration note: this mirrors `repositoryIdentity` from `@resin/observer/repository-identity`
 * (the shared contract) and is replaced by that import once it is available on this branch. It
 * imports only node builtins, so the per-command suggestion hook stays fast.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

export interface RepositoryIdentity {
  /** 64 lowercase hex characters. */
  readonly id: string;
  /** Real path of the repository's top-level directory. */
  readonly root: string;
}

export type RepositoryIdentityResolver = (dir: string) => RepositoryIdentity | undefined;

const GIT_TIMEOUT_MS = 1_500;
const byRoot = new Map<string, RepositoryIdentity | undefined>();

function git(args: readonly string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  return result.stdout;
}

/** The repository enclosing `dir`, or undefined when it has no usable identity. */
export function repositoryIdentity(dir: string): RepositoryIdentity | undefined {
  const top = git(["rev-parse", "--show-toplevel", "--is-shallow-repository"], dir);
  if (top === undefined) return undefined;
  const [toplevel, shallow] = top.split(/\r?\n/u);
  if (toplevel === undefined || toplevel.length === 0 || shallow === "true") return undefined;
  let root: string;
  try {
    root = fs.realpathSync.native(toplevel);
  } catch {
    return undefined;
  }
  if (byRoot.has(root)) return byRoot.get(root);
  const roots = git(["rev-list", "--max-parents=0", "HEAD"], root)
    ?.split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{40,64}$/u.test(line));
  const identity =
    roots === undefined || roots.length === 0
      ? undefined
      : { id: createHash("sha256").update(roots.sort().join("\n")).digest("hex"), root };
  byRoot.set(root, identity);
  return identity;
}
