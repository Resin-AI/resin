import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Whether this host lets the current user create file symlinks. Windows requires Developer Mode or
 * the symlink privilege; directory aliases there use junctions instead (`fs.symlink(..., "junction")`,
 * a type POSIX ignores).
 */
export const FILE_SYMLINKS_SUPPORTED: boolean = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
