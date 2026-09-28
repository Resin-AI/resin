import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One access-control entry of a DACL as reported by the native helper. */
export interface AclEntry {
  readonly type: "allow" | "deny" | "other";
  readonly sid: string | null;
  readonly mask: number;
  readonly inherited: boolean;
  readonly inheritOnly: boolean;
}

/** Owner and DACL of a file, directory or pipe. */
export interface AclDescription {
  readonly owner: string | null;
  readonly protected: boolean;
  readonly daclPresent: boolean;
  readonly entries: readonly AclEntry[];
}

export interface NativeVerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly win32Error?: number;
  readonly serverPid?: number;
  readonly ownerSid?: string;
  readonly serverSid?: string;
}

export interface NativeProbeResult {
  readonly ok: boolean;
  readonly win32Error: number;
}

declare const nativeServerBrand: unique symbol;
declare const squatBrand: unique symbol;
/** Opaque handle to a pipe claimed by {@link NativeBinding.squatPipeForTesting}. */
export interface SquattedPipeHandle {
  readonly [squatBrand]: true;
}

/** Opaque handle to a native pipe endpoint (server, or verified client). */
export interface NativeServerHandle {
  readonly [nativeServerBrand]: true;
}

export type NativeConnectResult =
  | { readonly ok: true; readonly handle: NativeServerHandle; readonly serverPid: number }
  | { readonly ok: false; readonly reason: string; readonly win32Error: number };

export type NativePipeEventHandler = (
  kind: "connection" | "data" | "end" | "error",
  id: number,
  arg: number | Buffer | string | undefined,
) => void;

export interface NativeBinding {
  currentUserSid(): string;
  setOwnerOnlyAcl(target: string, isDirectory: boolean): void;
  readAcl(target: string): AclDescription;
  verifyPipeServer(name: string): NativeVerifyResult;
  readPipeAcl(name: string): AclDescription;
  createPipeServer(name: string, onEvent: NativePipeEventHandler): NativeServerHandle;
  pipeConnect(
    name: string,
    timeoutMs: number,
    onEvent: NativePipeEventHandler,
    callback: (error: Error | null, result: NativeConnectResult) => void,
  ): void;
  writePrivateFileExclusive(target: string, data: Buffer): void;
  createPrivateDirectory(target: string): void;
  pipeWrite(
    server: NativeServerHandle,
    id: number,
    data: Buffer,
    callback: (error: string | null) => void,
  ): void;
  pipeClose(server: NativeServerHandle, id: number, graceful: boolean): void;
  pipeServerClose(server: NativeServerHandle): void;
  probeOpenWithUserSidDisabled(target: string, desiredAccess: number): NativeProbeResult;
  squatPipeForTesting(name: string, sddl: string): SquattedPipeHandle;
  releaseSquattedPipe(handle: SquattedPipeHandle): void;
}

export const NATIVE_ADDON_FILE = "resin_windows_security.node";
export const SERVICE_HOST_FILE = "resin-service-host.exe";
const BUILD_HINT =
  "Build it with `node packages/windows-security/scripts/build-native.mjs` (needs Visual Studio Build Tools with the C++ workload) or reinstall the Resin release for this architecture.";

/** Directory of this package (works from both src/ under vitest and dist/). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

let prebuildDirectoryOverride: string | undefined;
let cachedBinding: NativeBinding | undefined;
let cachedLoadError: Error | undefined;

/** `prebuilds/<platform>-<arch>` directory for the running process. */
export function prebuildDirectory(): string {
  return (
    prebuildDirectoryOverride ??
    path.join(packageRoot(), "prebuilds", `${process.platform}-${process.arch}`)
  );
}

/**
 * Loads the native helpers from `directory` instead of this package's own `prebuilds/` (for
 * bundled code such as the install helper, pointing at the verified release it is installing).
 * Must run before the first native call; throws when `directory` has no addon.
 */
export function useWindowsSecurityPrebuildDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (cachedBinding !== undefined) {
    if (resolved === prebuildDirectory()) return;
    throw new Error(
      `@resin/windows-security already loaded its native helper from ${prebuildDirectory()}; set the prebuild directory before first use.`,
    );
  }
  const addonPath = path.join(resolved, NATIVE_ADDON_FILE);
  if (!fs.existsSync(addonPath)) {
    throw new Error(`Resin's Windows security helper is missing: ${addonPath} does not exist.`);
  }
  prebuildDirectoryOverride = resolved;
  cachedLoadError = undefined;
}

function loadBinding(): NativeBinding {
  if (cachedBinding) return cachedBinding;
  if (cachedLoadError) throw cachedLoadError;
  if (process.platform !== "win32") {
    cachedLoadError = new Error(
      `@resin/windows-security native helper is only available on Windows (current platform: ${process.platform}).`,
    );
    throw cachedLoadError;
  }
  const addonPath = path.join(prebuildDirectory(), NATIVE_ADDON_FILE);
  if (!fs.existsSync(addonPath)) {
    cachedLoadError = new Error(
      `Resin's Windows security helper is missing: ${addonPath} does not exist. ${BUILD_HINT}`,
    );
    throw cachedLoadError;
  }
  try {
    const require = createRequire(import.meta.url);
    // SAFETY: the addon at this fixed package-relative path is built from native/resin_windows_security.c,
    // whose exports are exactly NativeBinding.
    cachedBinding = require(addonPath) as NativeBinding;
    return cachedBinding;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    cachedLoadError = new Error(
      `Resin's Windows security helper at ${addonPath} failed to load: ${detail}. ${BUILD_HINT}`,
    );
    throw cachedLoadError;
  }
}

/** Returns the native binding, throwing an actionable error when it is unavailable. */
export function nativeBinding(): NativeBinding {
  return loadBinding();
}

/** True when running on Windows with a loadable native helper. Never throws. */
export function isWindowsSecurityAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    loadBinding();
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the windowless service host executable for this platform/arch. */
export function serviceHostExecutablePath(): string {
  if (process.platform !== "win32") {
    throw new Error(
      `resin-service-host.exe is only available on Windows (current platform: ${process.platform}).`,
    );
  }
  const hostPath = path.join(prebuildDirectory(), SERVICE_HOST_FILE);
  if (!fs.existsSync(hostPath)) {
    throw new Error(`Resin's Windows service host is missing: ${hostPath}. ${BUILD_HINT}`);
  }
  return hostPath;
}
