import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectorySync } from "./private-fs.js";

/**
 * Durable record of a deliberate `resin logout`, in the daemon state directory. `resin logout`
 * writes it after purging the credentials; it stays until a daemon verifies Resin Cloud consent
 * with credentials that were saved after the logout (a later `resin login`). Every verification
 * that finds it moves the privacy cutoff to the verification time, so nothing observed during
 * the signed-out window is ever uploaded, even by a daemon that missed the logout's IPC signal.
 */
export const SIGN_OUT_BOUNDARY_FILE_NAME = "sign-out-boundary.json";

/** Largest marker accepted as one; anything bigger still counts as a (corrupt) boundary. */
const MAX_SIGN_OUT_BOUNDARY_BYTES = 4 * 1024;

/**
 * Records a deliberate sign-out. Each call writes a fresh marker, so a daemon can tell whether a
 * new logout happened while it was verifying consent. Throws when the marker cannot be written.
 */
export function writeSignOutBoundary(stateDir: string): void {
  const filePath = path.join(stateDir, SIGN_OUT_BOUNDARY_FILE_NAME);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  ensurePrivateDirectorySync(stateDir);
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, id: randomUUID(), signedOutAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * The marker's exact contents, or null when no sign-out is pending. An unreadable or oversized
 * marker is still a boundary: it reads as a stable placeholder so it applies, and is consumed by
 * the next verification like any other.
 */
export function readSignOutBoundary(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_SIGN_OUT_BOUNDARY_BYTES) {
      return `invalid:${stats.size}:${stats.mtimeMs}`;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return "unreadable";
  }
}

/**
 * Removes the marker if it still holds `expected`; a marker rewritten by a newer logout stays.
 * Returns whether the boundary is gone.
 */
export function consumeSignOutBoundary(filePath: string, expected: string): boolean {
  if (readSignOutBoundary(filePath) !== expected) {
    return false;
  }
  try {
    fs.rmSync(filePath, { force: true, recursive: false });
    return true;
  } catch {
    return false;
  }
}
