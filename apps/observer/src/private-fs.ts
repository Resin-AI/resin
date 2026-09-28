import fs from "node:fs";
import {
  checkOwnerOnly,
  ensureOwnerOnly,
  ensurePrivateDirectoryBoundary,
  writePrivateFileExclusive,
} from "@resin/windows-security";

/**
 * Makes sure `directory` exists as a private boundary before anything private is stored in it.
 * POSIX: `mkdir -p` with mode 0700. Windows: a missing directory is created with an inheritable,
 * protected owner-only DACL in the create call; an existing one must be owned by the current user
 * with a protected owner-only DACL, is repaired when it is not, and is refused (throws) when
 * another principal owns it or the repair does not hold. Files created inside afterwards inherit
 * owner-only access at creation, which covers temporary files and their link/rename publication.
 */
export function ensurePrivateDirectorySync(directory: string): void {
  if (process.platform !== "win32") {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  ensurePrivateDirectoryBoundary(directory);
}

/** Async form of {@link ensurePrivateDirectorySync}. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    return;
  }
  ensurePrivateDirectoryBoundary(directory);
}

/**
 * Windows counterpart of the POSIX "owned by this uid and mode & 0o077 === 0" check: why `target`
 * is not durably private to the current user, or undefined when it is. Always undefined off
 * Windows, where callers keep their mode/uid checks. Throws ENOENT for missing paths.
 */
export function windowsPrivacyProblem(target: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = checkOwnerOnly(target);
  return result.ok ? undefined : `not private to the current user: ${result.problems.join("; ")}`;
}

/**
 * Windows counterpart of `chmod 0600` for an existing file inside a private directory: owner-only
 * protected DACL, verified afterwards (throws when it does not hold). No-op elsewhere.
 */
export function restrictPrivateFileSync(target: string): void {
  ensureOwnerOnly(target, { directory: false });
}

/**
 * Creates `target` holding `data`, private from the moment it exists (Windows: owner-only DACL in
 * the create call; POSIX: mode 0600). Never opens an existing file (throws EEXIST).
 */
export function writeNewPrivateFileSync(target: string, data: string | Uint8Array): void {
  writePrivateFileExclusive(target, data);
}
