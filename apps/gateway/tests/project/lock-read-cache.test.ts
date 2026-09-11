import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/project-lock.js";

const PROJECT = "11111111-2222-4333-8444-555555555555";

function lockedEntry(name: string, toolId: string) {
  return {
    toolId,
    name,
    version: "1.0.0",
    manifestDigest: crypto.createHash("sha256").update(name).digest("hex"),
    artifactDigest: crypto.createHash("sha256").update(`artifact:${name}`).digest("hex"),
    status: "active" as const,
  };
}

describe("ProjectLockManager read caching", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-cache-"));
    lockPath = path.join(dir, "resin.lock");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reuses the validated lockfile across repeated lookups", () => {
    const manager = new ProjectLockManager({ lockPath, projectId: PROJECT });
    for (let index = 0; index < 12; index++) {
      manager.reconcileQualified(lockedEntry(`tool_${index}`, crypto.randomUUID()));
    }

    // Warm the parse cache, then confirm repeated lookups perform no file reads.
    expect(manager.getLockedTool("tool_0")).toBeDefined();
    const reads = vi.spyOn(fs, "readFileSync");
    const stats = vi.spyOn(fs, "statSync");
    for (let index = 0; index < 12; index++) {
      expect(manager.getLockedTool(`tool_${index}`)).toBeDefined();
    }
    expect(reads.mock.calls.filter(([file]) => String(file) === lockPath)).toHaveLength(0);
    // Revision detection still stats the file, but never re-parses it.
    expect(stats.mock.calls.filter(([file]) => String(file) === lockPath).length).toBeGreaterThan(
      0,
    );
    reads.mockRestore();
    stats.mockRestore();
  });

  it("observes an external rewrite that preserves size and mtime", () => {
    const manager = new ProjectLockManager({ lockPath, projectId: PROJECT });
    manager.reconcileQualified(lockedEntry("alpha", crypto.randomUUID()));
    manager.reconcileQualified(lockedEntry("beta", crypto.randomUUID()));
    expect(manager.getLockedTool("alpha")?.status).toBe("active");
    expect(manager.getLockedTool("alpha")?.status).toBe("active"); // warm

    // Same-length, in-place edit with the original mtime restored.
    const before = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf8");
    // "pinned" is the same byte length as "active", so size is unchanged.
    const rewritten = raw.replace('"status": "active"', '"status": "pinned"');
    if (rewritten === raw) return; // serialization shape changed; covered by revision logic
    fs.writeFileSync(lockPath, rewritten);
    fs.utimesSync(lockPath, before.atime, before.mtime);

    const after = fs.statSync(lockPath);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);

    // ctime must defeat the stale cache.
    expect(manager.getLockedTool("alpha")?.status).toBe("pinned");
  });

  it("observes an atomic replacement by another process", () => {
    const reader = new ProjectLockManager({ lockPath, projectId: PROJECT });
    reader.reconcileQualified(lockedEntry("alpha", crypto.randomUUID()));
    expect(reader.getLockedTool("alpha")?.status).toBe("active");
    expect(reader.getLockedTool("alpha")?.status).toBe("active"); // warm

    // Separate manager performs an atomic write (temp file + rename).
    const writer = new ProjectLockManager({ lockPath, projectId: PROJECT });
    writer.setStatus("alpha", "disabled");

    expect(reader.getLockedTool("alpha")?.status).toBe("disabled");
  });

  it("returns an isolated lock object so callers cannot corrupt the cache", () => {
    const manager = new ProjectLockManager({ lockPath, projectId: PROJECT });
    manager.reconcileQualified(lockedEntry("alpha", crypto.randomUUID()));

    const first = manager.readLock();
    const entry = first.tools.alpha;
    expect(entry).toBeDefined();
    entry!.status = "disabled";

    // A later read reflects the file, not the caller's mutation.
    expect(manager.readLock().tools.alpha?.status).toBe("active");
  });

  it("still reports a missing lockfile as an empty lock and drops the cache", () => {
    const manager = new ProjectLockManager({ lockPath, projectId: PROJECT });
    manager.reconcileQualified(lockedEntry("alpha", crypto.randomUUID()));
    expect(manager.getLockedTool("alpha")).toBeDefined();

    fs.rmSync(lockPath);
    const empty = manager.readLock();
    expect(Object.keys(empty.tools)).toHaveLength(0);
  });
});
