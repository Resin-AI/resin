import fs from "node:fs";
import path from "node:path";
import { type AclDescription, nativeBinding } from "./native.js";

const WIN32_FILE_NOT_FOUND = "WIN32_2";
const WIN32_PATH_NOT_FOUND = "WIN32_3";

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * Win32 "file/path not found" failures surface as ENOENT, and a refused foreign owner as
 * EFOREIGNOWNER, so POSIX-style callers keep working.
 */
function translateNativeError(error: unknown, target: string): unknown {
  if (!(error instanceof Error)) return error;
  const code = errorCode(error);
  if (code === WIN32_FILE_NOT_FOUND || code === WIN32_PATH_NOT_FOUND || code === "ENOENT") {
    return Object.assign(new Error(`ENOENT: no such file or directory, '${target}'`), {
      code: "ENOENT",
      path: target,
      cause: error,
    });
  }
  if (code === "EEXIST") {
    return Object.assign(new Error(`EEXIST: file already exists, '${target}'`), {
      code: "EEXIST",
      path: target,
      cause: error,
    });
  }
  if (code === "EFOREIGNOWNER") {
    return Object.assign(
      new Error(
        `Refusing to make '${target}' private: it is owned by another principal (${error.message}).`,
      ),
      { code: "EFOREIGNOWNER", path: target, cause: error },
    );
  }
  return error;
}

/** String SID of the user running this process (for example `S-1-5-21-...-1001`). */
export function currentUserSid(): string {
  return nativeBinding().currentUserSid();
}

/** Owner and DACL of a file or directory (Windows only). */
export function readAcl(target: string): AclDescription {
  try {
    return nativeBinding().readAcl(target);
  } catch (error) {
    throw translateNativeError(error, target);
  }
}

/** Owner and DACL of a running named pipe (Windows only). */
export function readPipeAcl(name: string): AclDescription {
  return nativeBinding().readPipeAcl(name);
}

export interface OwnerOnlyOptions {
  /**
   * Require the object's own DACL to be protected from inheritance. Use it for security
   * boundaries (the Resin home, private directories, trust roots): an unprotected DACL can be
   * widened later by an inheritable ACE on any ancestor.
   */
  requireProtected?: boolean;
}

/**
 * Owners that do not widen access beyond the current user. An elevated administrator's token
 * makes BUILTIN\Administrators the default owner of every object it creates, and services
 * running as LocalSystem own theirs. Neither SID can be assigned as owner by a standard user,
 * and an administrator can take ownership of anything anyway, so accepting them keeps "only the
 * current user" meaningful. Any other principal as owner could re-grant itself access.
 */
const TRUSTED_NON_USER_OWNERS: ReadonlySet<string> = new Set([
  "S-1-5-32-544", // BUILTIN\Administrators
  "S-1-5-18", // NT AUTHORITY\SYSTEM
]);

/** Whether `owner` is the current user or an owner that cannot widen access beyond them. */
export function isAcceptableOwner(owner: string | null, userSid: string): boolean {
  if (owner === null) return false;
  const normalized = owner.toUpperCase();
  return normalized === userSid.toUpperCase() || TRUSTED_NON_USER_OWNERS.has(normalized);
}

/** Problems that make `acl` broader than "only `userSid`", empty when it is owner-only. */
export function ownerOnlyProblems(
  acl: AclDescription,
  userSid: string,
  options: OwnerOnlyOptions = {},
): string[] {
  const problems: string[] = [];
  const me = userSid.toUpperCase();
  if (acl.owner === null) {
    problems.push("has no owner");
  } else if (!isAcceptableOwner(acl.owner, userSid)) {
    problems.push(`is owned by ${acl.owner}, not the current user ${userSid}`);
  }
  if (!acl.daclPresent) {
    problems.push("has a NULL DACL (everyone has full access)");
    return problems;
  }
  if (options.requireProtected && !acl.protected) {
    problems.push("does not have a protected DACL (ancestors can widen it through inheritance)");
  }
  for (const entry of acl.entries) {
    if (entry.type === "deny") continue;
    if (entry.type === "other") {
      problems.push(
        `has an unsupported ACE type granting access to ${entry.sid ?? "an unknown SID"}`,
      );
      continue;
    }
    if (entry.sid !== null && entry.sid.toUpperCase() === me) continue;
    const scope = entry.inheritOnly ? " (inheritable to new children)" : "";
    problems.push(`grants access to ${entry.sid ?? "an unknown SID"}${scope}`);
  }
  return problems;
}

export interface OwnerOnlyCheck {
  ok: boolean;
  problems: string[];
  /**
   * Whether the current user (or an owner that cannot widen access beyond them, such as
   * BUILTIN\Administrators for an elevated run) owns the object. POSIX callers refuse
   * foreign-owned paths instead of repairing them; this lets Windows callers do the same.
   */
  ownedByCurrentUser: boolean;
}

function isOwner(acl: AclDescription, sid: string): boolean {
  return isAcceptableOwner(acl.owner, sid);
}

/**
 * Checks that `target` is owned by and accessible only to the current user, durably: an object
 * whose DACL is not protected must inherit from a chain of owner-only, current-user-owned
 * directories that ends at a protected one. With `requireProtected` the object itself must be
 * protected. Always ok off Windows (POSIX callers validate mode and uid themselves). Throws
 * ENOENT when the path is missing, like `fs.statSync`.
 */
export function checkOwnerOnly(target: string, options: OwnerOnlyOptions = {}): OwnerOnlyCheck {
  if (process.platform !== "win32") return { ok: true, problems: [], ownedByCurrentUser: true };
  const sid = currentUserSid();
  const acl = readAcl(target);
  const problems = ownerOnlyProblems(acl, sid, options);
  if (problems.length === 0 && !acl.protected) problems.push(...inheritanceProblems(target, sid));
  return { ok: problems.length === 0, problems, ownedByCurrentUser: isOwner(acl, sid) };
}

/** Walks up from an unprotected object until a protected, private ancestor vouches for it. */
function inheritanceProblems(target: string, sid: string): string[] {
  let current = path.resolve(target);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return ["inherits its DACL, but no ancestor has a protected owner-only DACL"];
    }
    current = parent;
    const acl = readAcl(current);
    const problems = ownerOnlyProblems(acl, sid);
    if (problems.length > 0) {
      return [`inherits its DACL from '${current}', which ${problems.join("; ")}`];
    }
    if (acl.protected) return [];
  }
}

/**
 * Makes `target` accessible only to the current user: sets the current user as owner and
 * replaces the DACL with a protected DACL holding one full-control ACE for that user. For
 * directories the ACE is inheritable, and Windows propagates it to existing children that do
 * not have their own protected DACL. Objects owned by another principal (other than the machine's
 * Administrators or SYSTEM, which own files an elevated installer created) are refused with
 * EFOREIGNOWNER. Verifies the result and throws unless the object ends up owned by the current
 * user with a protected owner-only DACL. No-op off Windows (callers keep using POSIX modes).
 */
export function ensureOwnerOnly(target: string, options: { directory: boolean }): void {
  if (process.platform !== "win32") return;
  try {
    nativeBinding().setOwnerOnlyAcl(target, options.directory);
  } catch (error) {
    throw translateNativeError(error, target);
  }
  const acl = readAcl(target);
  const problems = ownerOnlyProblems(acl, currentUserSid(), { requireProtected: true });
  if (problems.length > 0) {
    throw Object.assign(
      new Error(`Could not make '${target}' private: it ${problems.join("; ")}`),
      { code: "EACCES", path: target },
    );
  }
}

/**
 * Creates `target` as a new file holding `data`, private to the current user from the moment it
 * exists: on Windows the owner-only protected DACL is part of the create call; elsewhere the file
 * is created with mode 0600. Never opens an existing file (throws EEXIST).
 */
export function writePrivateFileExclusive(target: string, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (process.platform !== "win32") {
    const fd = fs.openSync(target, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  try {
    nativeBinding().writePrivateFileExclusive(target, bytes);
  } catch (error) {
    throw translateNativeError(error, target);
  }
}

/**
 * Creates the directory `target` (its parent must exist), private to the current user from the
 * moment it exists: on Windows with an inheritable, protected owner-only DACL in the create call;
 * elsewhere with mode 0700. Throws EEXIST when it exists.
 */
export function createPrivateDirectory(target: string): void {
  if (process.platform !== "win32") {
    fs.mkdirSync(target, { mode: 0o700 });
    return;
  }
  try {
    nativeBinding().createPrivateDirectory(target);
  } catch (error) {
    throw translateNativeError(error, target);
  }
}

/**
 * Makes sure `directory` exists as a private security boundary and returns once it is: missing
 * parents are created, the directory itself is created private (see
 * {@link createPrivateDirectory}), and an existing one is validated as owned by the current user
 * with a protected owner-only DACL, repaired when it is not, and refused (EFOREIGNOWNER) when
 * another principal owns it. Off Windows this is `mkdir -p` with mode 0700.
 */
export function ensurePrivateDirectoryBoundary(directory: string): void {
  if (process.platform !== "win32") {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  const resolved = path.resolve(directory);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    createPrivateDirectory(resolved);
    return;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`'${resolved}' is not a directory`), {
      code: "ENOTDIR",
      path: resolved,
    });
  }
  if (!checkOwnerOnly(resolved, { requireProtected: true }).ok) {
    ensureOwnerOnly(resolved, { directory: true });
  }
}
