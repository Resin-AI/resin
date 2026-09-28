import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether this process may create file symlinks. Windows allows that only to elevated users or with
 * Developer Mode on (CI runners are elevated); a plain user gets EPERM, so a file-symlink fixture
 * cannot be built there.
 */
export const canCreateFileSymlinks: boolean = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

/** A directory link any user can create: a junction on Windows, a symlink elsewhere. */
export const directoryLinkType: "junction" | "dir" =
  process.platform === "win32" ? "junction" : "dir";
