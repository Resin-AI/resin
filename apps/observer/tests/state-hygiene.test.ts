import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_STATE_FILE_MAX_AGE_MS, pruneStaleStateFiles } from "../src/state-hygiene.js";

describe("pruneStaleStateFiles", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes only quarantined locks and temporary files older than the age limit", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-state-hygiene-"));
    roots.push(stateDir);
    const now = Date.parse("2026-10-04T12:00:00.000Z");
    const old = new Date(now - STALE_STATE_FILE_MAX_AGE_MS - 60_000);
    const recent = new Date(now - 60_000);
    const write = (name: string, mtime: Date): void => {
      fs.writeFileSync(path.join(stateDir, name), "{}");
      fs.utimesSync(path.join(stateDir, name), mtime, mtime);
    };

    write("daemon.lock.stale.1788374946000.52347.aa8595f8", old);
    write(".harness-health.json.2766209.0b1c.tmp", old);
    write("daemon.lock.2766209.0b1c.tmp", old);
    write("daemon.lock.stale.1791068919277.115672.43a12032", recent);
    write("tool-signatures.json.115672.9f00.tmp", recent);
    // Old files that do not match the leftover shapes stay.
    write("daemon.lock", old);
    write("auth.token.stale-20260830", old);
    write("config.json", old);
    write(".tmp", old);
    write("daemon.lock.stale.", old);
    fs.mkdirSync(path.join(stateDir, "staging.tmp"));
    fs.utimesSync(path.join(stateDir, "staging.tmp"), old, old);
    // Windows needs a privilege to create symlinks; the symlink case is POSIX-only.
    const withSymlink = process.platform !== "win32";
    const outside = path.join(os.tmpdir(), `resin-state-hygiene-target-${process.pid}`);
    if (withSymlink) {
      fs.writeFileSync(outside, "keep");
      roots.push(outside);
      fs.symlinkSync(outside, path.join(stateDir, "linked.tmp"));
      fs.lutimesSync(path.join(stateDir, "linked.tmp"), old, old);
      fs.utimesSync(outside, old, old);
    }

    const removed = await pruneStaleStateFiles(stateDir, { now });

    expect(removed.sort()).toEqual([
      ".harness-health.json.2766209.0b1c.tmp",
      "daemon.lock.2766209.0b1c.tmp",
      "daemon.lock.stale.1788374946000.52347.aa8595f8",
    ]);
    expect(fs.readdirSync(stateDir).sort()).toEqual(
      [
        ".tmp",
        "auth.token.stale-20260830",
        "config.json",
        "daemon.lock",
        "daemon.lock.stale.",
        "daemon.lock.stale.1791068919277.115672.43a12032",
        ...(withSymlink ? ["linked.tmp"] : []),
        "staging.tmp",
        "tool-signatures.json.115672.9f00.tmp",
      ].sort(),
    );
    if (withSymlink) expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("returns nothing for a missing state directory", async () => {
    await expect(
      pruneStaleStateFiles(path.join(os.tmpdir(), `resin-missing-state-${process.pid}-x`)),
    ).resolves.toEqual([]);
  });
});
