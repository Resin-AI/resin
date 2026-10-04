import { execFileSync } from "node:child_process";
import fs, { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  REAL_RESIN_ROOTS,
  realResinRootFor,
  takeRealHomeViolations,
  withIsolatedHome,
} from "./real-home-guard.js";

const realResin = path.join(os.userInfo().homedir, ".resin");
// A directory that does not exist, so even an unguarded call could not create anything.
const missing = path.join(realResin, `guard-probe-${process.pid}-missing`);

describe("real-home guard", () => {
  afterEach(() => {
    // The guard's own probes are expected violations; drain them so its afterEach stays quiet.
    takeRealHomeViolations();
  });

  it("protects the password-database home, not the test HOME", () => {
    expect(REAL_RESIN_ROOTS).toContain(path.resolve(realResin));
    expect(process.env.HOME).not.toBe(os.userInfo().homedir);
    expect(realResinRootFor(path.join(realResin, "data", "state.db"))).toBeDefined();
    expect(
      realResinRootFor(`file:${path.join(realResin, "data", "state.db")}?mode=ro`),
    ).toBeDefined();
    expect(realResinRootFor(`${realResin}-sibling/state.db`)).toBeUndefined();
    expect(realResinRootFor(path.join(os.tmpdir(), ".resin", "state.db"))).toBeUndefined();
    expect(realResinRootFor(":memory:")).toBeUndefined();
  });

  it("rejects fs writes under the real ~/.resin, including named imports and promises", async () => {
    const target = path.join(missing, "state.db");
    expect(() => writeFileSync(target, "x")).toThrow(/real user Resin home: writeFile/);
    expect(() => fs.mkdirSync(missing, { recursive: true })).toThrow(/real user Resin home: mkdir/);
    expect(() => fs.openSync(target, "a")).toThrow(/real user Resin home: open/);
    expect(() => fs.rmSync(missing, { recursive: true, force: true })).toThrow(/rm/);
    await expect(fs.promises.writeFile(target, "x")).rejects.toThrow(/real user Resin home/);
    expect(() => fs.createWriteStream(target)).toThrow(/createWriteStream/);
    expect(fs.existsSync(missing)).toBe(false);
    expect(takeRealHomeViolations()).toHaveLength(6);
  });

  it("rejects opening a SQLite database under the real ~/.resin", () => {
    expect(() => new DatabaseSync(path.join(missing, "state.db"))).toThrow(
      /real user Resin home: DatabaseSync/,
    );
  });

  it("records swallowed violations so the running test still fails", () => {
    try {
      fs.writeFileSync(path.join(missing, "swallowed"), "x");
    } catch {
      // Production code that ignores the error must not hide the leak.
    }
    expect(takeRealHomeViolations()).toEqual([
      expect.stringContaining(path.join(missing, "swallowed")),
    ]);
  });

  it("allows temp-dir writes and databases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-guard-"));
    try {
      fs.writeFileSync(path.join(dir, "file"), "ok");
      const db = new DatabaseSync(path.join(dir, "state.db"));
      db.exec("CREATE TABLE t (x INTEGER)");
      db.close();
      expect(takeRealHomeViolations()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives children with a constructed env the isolated HOME", () => {
    expect(withIsolatedHome(["node", [], { env: { PATH: "/bin" } }])).toEqual([
      "node",
      [],
      { env: { PATH: "/bin", HOME: process.env.HOME } },
    ]);
    const own = { env: { PATH: "/bin", RESIN_HOME: "/tmp/r" } };
    expect(withIsolatedHome(["node", [], own])[2]).toBe(own);
    const out = execFileSync(process.execPath, ["-p", "require('node:os').homedir()"], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(out.trim()).toBe(process.env.HOME);
  });
});
