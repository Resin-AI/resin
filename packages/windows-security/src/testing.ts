import { nativeBinding } from "./native.js";

/** Win32 access masks accepted by {@link probeOpenWithUserSidDisabled}. */
export const PROBE_ACCESS = {
  read: 0x80000000,
  write: 0x40000000,
  readWrite: 0xc0000000,
  readControl: 0x00020000,
} as const;

export interface AccessProbeResult {
  /** True when the object could be opened. */
  readonly ok: boolean;
  /** Win32 error of the failed open (5 = access denied), 0 on success. */
  readonly win32Error: number;
}

/**
 * TEST/DIAGNOSTIC PROBE. Tries to open `target` (a path or `\\.\pipe\` name) as "any other local
 * principal": the current process token with the current user's SID made deny-only, so only the
 * user's groups (Everyone, Users, Authenticated Users, INTERACTIVE, logon SID, ...) can grant
 * access. Lets tests prove an owner-only DACL denies everyone else without a second account.
 * Opens with OPEN_EXISTING and closes immediately; never modifies anything. Windows only.
 */
export function probeOpenWithUserSidDisabled(
  target: string,
  desiredAccess: number = PROBE_ACCESS.read,
): AccessProbeResult {
  return nativeBinding().probeOpenWithUserSidDisabled(target, desiredAccess);
}

export interface SquattedPipe {
  release(): void;
}

/**
 * TEST/DIAGNOSTIC PROBE. Claims `name` (first instance) with the given SDDL security descriptor to
 * stand in for a pipe planted by another principal, e.g. `D:P(A;;GA;;;SY)` (only SYSTEM may
 * connect). Release it to free the name. Windows only.
 */
export function squatPipeForTesting(name: string, sddl: string): SquattedPipe {
  const binding = nativeBinding();
  const handle = binding.squatPipeForTesting(name, sddl);
  return { release: () => binding.releaseSquattedPipe(handle) };
}
