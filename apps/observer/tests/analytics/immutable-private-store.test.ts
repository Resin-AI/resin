import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FilePrivateValueStore,
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const value = mkdtempSync(path.join(os.tmpdir(), "resin-immutable-values-"));
  directories.push(value);
  return value;
}

describe("immutable private reference persistence", () => {
  it("does not overwrite a value or its owner, including through another store instance", () => {
    const root = directory();
    const first = new FilePrivateValueStore(root);
    const second = new FilePrivateValueStore(root);
    const key = "private:v2:stable";
    const original = { nested: [2, false, null, "literal [REDACTED_SECRET:example]"] };
    const origin = { workspaceId: "ws-original" };
    expect(second.get(key)).toBeUndefined();
    first.set(key, original, origin, "literal");
    expect(resolvePrivateReference(second, key)).toEqual(original);
    second.set(key, original, origin, "literal");
    expect(() => second.set(key, "replacement", origin, "literal")).toThrow(
      "different value or owner",
    );
    expect(() => second.set(key, original, { workspaceId: "ws-foreign" }, "literal")).toThrow(
      "different value or owner",
    );
    expect(new FilePrivateValueStore(root).origin(key)).toEqual(origin);
    const memory = new InMemoryPrivateValueStore();
    memory.set(key, original, origin, "literal");
    expect(() => memory.set(key, "replacement", origin, "literal")).toThrow(
      "different value or owner",
    );
  });

  it("does not rewrite the legacy file for an identical entry and shares writes across instances", () => {
    // A fixed clock keeps the re-set entry in the newer half of the retained window.
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = directory();
    const first = new FilePrivateValueStore(root);
    const second = new FilePrivateValueStore(root);
    for (let i = 0; i < 50; i++)
      first.set(`[REDACTED_SECRET:${i}]`, `secret-${i}`, { workspaceId: "ws-legacy" });
    const file = path.join(root, "private-values", "private-values.json");
    first.flush();
    const before = statSync(file, { bigint: true });
    first.set("[REDACTED_SECRET:7]", "secret-7", { workspaceId: "ws-legacy" });
    first.flush();
    const after = statSync(file, { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);

    for (let i = 0; i < 50; i++) expect(second.get(`[REDACTED_SECRET:${i}]`)).toBe(`secret-${i}`);
    second.set("[REDACTED_SECRET:second]", "from-second", { workspaceId: "ws-legacy" });
    first.set("[REDACTED_SECRET:first]", "from-first", { workspaceId: "ws-legacy" });
    second.set("[REDACTED_SECRET:7]", "changed", { workspaceId: "ws-legacy" });
    const reopened = new FilePrivateValueStore(root);
    for (const store of [first, second, reopened]) {
      expect(store.get("[REDACTED_SECRET:second]")).toBe("from-second");
      expect(store.get("[REDACTED_SECRET:first]")).toBe("from-first");
      expect(store.get("[REDACTED_SECRET:7]")).toBe("changed");
      expect(store.get("[REDACTED_SECRET:49]")).toBe("secret-49");
    }
  });

  it("keeps an identically re-set legacy key while untouched old keys are evicted", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = directory();
    const origin = { workspaceId: "ws-legacy" };
    let now = 1_000_000;
    // Seed a full legacy store (hot key oldest) in its on-disk format; 4096 set() calls would be slow.
    const seeded: Record<string, unknown> = {
      "[REDACTED_SECRET:hot]": { value: "hot", origin, at: now },
    };
    for (let i = 1; i < 4096; i++)
      seeded[`[REDACTED_SECRET:old-${i}]`] = { value: `old-${i}`, origin, at: now };
    mkdirSync(path.join(root, "private-values"), { recursive: true });
    writeFileSync(path.join(root, "private-values", "private-values.json"), JSON.stringify(seeded));
    const store = new FilePrivateValueStore(root);
    // A separate instance reads the file as another process would, after each capacity overflow.
    const reader = new FilePrivateValueStore(root);
    for (let i = 0; i < 200; i++) {
      vi.setSystemTime(++now);
      store.set("[REDACTED_SECRET:hot]", "hot", origin);
      store.set(`[REDACTED_SECRET:new-${i}]`, `new-${i}`, origin);
      expect(reader.get("[REDACTED_SECRET:hot]")).toBe("hot");
    }
    const reopened = new FilePrivateValueStore(root);
    expect(reopened.get("[REDACTED_SECRET:hot]")).toBe("hot");
    expect(reopened.get("[REDACTED_SECRET:old-1]")).toBeUndefined();
    expect(reopened.get("[REDACTED_SECRET:old-150]")).toBeUndefined();
    expect(reopened.get("[REDACTED_SECRET:old-4095]")).toBe("old-4095");
    expect(reopened.get("[REDACTED_SECRET:new-199]")).toBe("new-199");
  }, 30_000);

  it("retains all entries written by separate simultaneous processes", async () => {
    const root = directory();
    const moduleUrl = new URL("../../dist/analytics/private-value-store.js", import.meta.url).href;
    const source = `import {FilePrivateValueStore} from ${JSON.stringify(moduleUrl)};
      const store = new FilePrivateValueStore(process.argv[1]);
      for(let i=0;i<64;i++) store.set('private:v2:'+process.argv[2]+':'+i,
        {writer:process.argv[2],i},{workspaceId:'ws-concurrent'},'literal');`;
    await Promise.all(
      ["a", "b", "c"].map(
        (writer) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--input-type=module", "-e", source, root, writer],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            let diagnostic = "";
            child.stderr.on("data", (chunk: Buffer) => {
              diagnostic += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(diagnostic))));
          }),
      ),
    );
    const reopened = new FilePrivateValueStore(root);
    for (const writer of ["a", "b", "c"]) {
      for (let i = 0; i < 64; i++)
        expect(reopened.get(`private:v2:${writer}:${i}`)).toEqual({ writer, i });
    }
    const entries = path.join(root, "private-values", "entries-v2");
    expect(readdirSync(entries)).toHaveLength(192);
    if (process.platform !== "win32") {
      for (const name of readdirSync(entries))
        expect(statSync(path.join(entries, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("writes a burst of new legacy aliases back once, and before its process exits", async () => {
    const root = directory();
    const moduleUrl = new URL("../../dist/analytics/private-value-store.js", import.meta.url).href;
    // A capture burst: many new aliases, then a normal exit well before the write-back timer.
    // The store is imported dynamically so it loads after fs.renameSync is counted.
    const source = `import fs from 'node:fs';
      let renames = 0; const rename = fs.renameSync;
      fs.renameSync = (...args) => { renames++; return rename(...args); };
      const {FilePrivateValueStore} = await import(${JSON.stringify(moduleUrl)});
      const store = new FilePrivateValueStore(process.argv[1]);
      for (let i = 0; i < 2000; i++) store.set('[REDACTED_PATH:'+i+']', '/work/file-'+i, {workspaceId:'ws-burst'});
      process.on('exit', () => process.stderr.write('renames=' + renames));`;
    const diagnostic = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr))));
    });
    expect(diagnostic).toBe("renames=1");
    const reopened = new FilePrivateValueStore(root);
    for (const i of [0, 999, 1999])
      expect(reopened.get(`[REDACTED_PATH:${i}]`)).toBe(`/work/file-${i}`);
  });

  it("keeps a torn legacy store aside instead of treating it as empty", () => {
    const root = directory();
    const dir = path.join(root, "private-values");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "private-values.json"), '{"[REDACTED_SECRET:a]": {"value": "tor');
    const store = new FilePrivateValueStore(root);
    expect(() => store.get("[REDACTED_SECRET:a]")).toThrow("Corrupt local private value store");
    const preserved = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    expect(preserved).toHaveLength(1);
    store.set("[REDACTED_SECRET:b]", "fresh", { workspaceId: "ws-legacy" });
    store.flush();
    expect(new FilePrivateValueStore(root).get("[REDACTED_SECRET:b]")).toBe("fresh");
  });
});
