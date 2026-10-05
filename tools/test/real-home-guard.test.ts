import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs, { writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  REAL_RESIN_ROOTS,
  realResinRootFor,
  resinRootsFor,
  socketConnectPath,
  stripResinLayoutOverrides,
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

  it("drops inherited Resin layout overrides, keeping unrelated RESIN_*_DIR settings", () => {
    const env: NodeJS.ProcessEnv = {
      RESIN_DATA_DIR: "/home/dev/.resin/data",
      RESIN_STATE_DIR: "/home/dev/.resin/state",
      RESIN_SOCKET_PATH: "/run/dev/resin.sock",
      RESIN_CONFIG_FILE: "/etc/dev/resin.json",
      RESIN_LOCK_FILE: "/run/dev/resin.lock",
      RESIN_PID_FILE: "/run/dev/resin.pid",
      RESIN_RELEASE_DIR: "/tmp/release",
      PATH: "/bin",
    };
    expect(stripResinLayoutOverrides(env).sort()).toEqual([
      "RESIN_CONFIG_FILE",
      "RESIN_DATA_DIR",
      "RESIN_LOCK_FILE",
      "RESIN_PID_FILE",
      "RESIN_SOCKET_PATH",
      "RESIN_STATE_DIR",
    ]);
    expect(env).toEqual({ RESIN_RELEASE_DIR: "/tmp/release", PATH: "/bin" });
    // This worker already started without them, so default paths follow the isolated HOME.
    expect(stripResinLayoutOverrides({ ...process.env })).toEqual([]);
  });

  it("protects the files named by inherited socket, config, lock and pid overrides", () => {
    const roots = resinRootsFor(
      {
        RESIN_SOCKET_PATH: "/run/dev/resin.sock",
        RESIN_CONFIG_FILE: "/etc/dev/resin.json",
        RESIN_LOCK_FILE: "/run/dev/resin.lock",
        RESIN_PID_FILE: "/run/dev/resin.pid",
        RESIN_RELEASE_DIR: "/tmp/release",
      },
      "/home/dev",
    );
    for (const file of [
      "/home/dev/.resin",
      "/run/dev/resin.sock",
      "/etc/dev/resin.json",
      "/run/dev/resin.lock",
      "/run/dev/resin.pid",
    ]) {
      expect(roots).toContain(path.resolve(file));
    }
    expect(roots).not.toContain(path.resolve("/tmp/release"));
    // Only the named files, not their (possibly shared) parent directories.
    expect(roots).not.toContain(path.resolve("/run/dev"));
  });

  it("reads the dialled IPC path from every Socket#connect argument shape", () => {
    expect(socketConnectPath(["/x/daemon.sock"])).toBe("/x/daemon.sock");
    expect(socketConnectPath([{ path: "/x/daemon.sock" }])).toBe("/x/daemon.sock");
    expect(socketConnectPath([[{ path: "/x/daemon.sock" }, null]])).toBe("/x/daemon.sock");
    expect(socketConnectPath([8080, "127.0.0.1"])).toBeUndefined();
    expect(socketConnectPath(["8080"])).toBeUndefined();
    expect(socketConnectPath([{ port: 8080, host: "127.0.0.1" }])).toBeUndefined();
  });

  it("refuses socket connects under the real ~/.resin with an ordinary error event", async () => {
    // Under the missing probe directory, so even an unguarded connect could reach no daemon.
    const socketPath = path.join(missing, "daemon.sock");
    const [error] = await once(net.connect(socketPath), "error");
    expect((error as Error).message).toMatch(/real user Resin home: connect/);
    const [viaOptions] = await once(net.createConnection({ path: socketPath }), "error");
    expect((viaOptions as Error).message).toMatch(/real user Resin home: connect/);
    expect(takeRealHomeViolations()).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")(
    "allows connects to a socket outside the real home",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-guard-sock-"));
      const socketPath = path.join(dir, "s.sock");
      const server = net.createServer((socket) => socket.end("ok"));
      server.listen(socketPath);
      await once(server, "listening");
      try {
        const client = net.connect(socketPath);
        client.setEncoding("utf8");
        const [reply] = await once(client, "data");
        expect(reply).toBe("ok");
        client.destroy();
        expect(takeRealHomeViolations()).toEqual([]);
      } finally {
        server.close();
        await once(server, "close");
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
