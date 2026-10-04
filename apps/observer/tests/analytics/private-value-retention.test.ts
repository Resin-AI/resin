import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPrivateValueReferences,
  sweepPrivateValues,
} from "../../src/analytics/private-value-retention.js";
import {
  FilePrivateValueStore,
  privateValueEntriesDir,
  privateValueEntryName,
  privateValueEntryPath,
  privateValueIndexDir,
} from "../../src/analytics/private-value-store.js";
import {
  PrivateValueRetentionModule,
  daemonPrivateValueReferenceRoots,
} from "../../src/private-value-retention-module.js";

const DAY = 24 * 60 * 60 * 1000;
const OWNER = { workspaceId: "ws-retention" };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A daemon home: `data` holds the store and tool artifacts, `state` the daemon state. */
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-private-retention-"));
  roots.push(root);
  const paths = { dataDir: path.join(root, "data"), stateDir: path.join(root, "state") };
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { ...paths, entries: privateValueEntriesDir(paths.dataDir) };
}

const reference = (label: string) =>
  `private:v2:value:${Buffer.from(label).toString("hex").padEnd(64, "0")}`;
const shardedFile = (entries: string, key: string) =>
  privateValueEntryPath(entries, privateValueEntryName(key));

function age(file: string, days: number) {
  const at = new Date(Date.now() - days * DAY);
  fs.utimesSync(file, at, at);
}

function storedTool(dataDir: string, ...references: string[]) {
  const dir = path.join(dataDir, "artifacts", "a".repeat(64));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workflow.json"),
    JSON.stringify({ steps: [{ reference: references[0] }], privateReferences: references }),
  );
}

function allEntryFiles(entries: string): string[] {
  return fs
    .readdirSync(entries, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"));
}

describe("private value retention", () => {
  it("keeps referenced and young entries and deletes old unreferenced ones", async () => {
    const { dataDir, stateDir, entries } = home();
    const store = new FilePrivateValueStore(dataDir);
    const byTool = reference("tool");
    const byAsk = reference("ask");
    const unreferenced = reference("old");
    const young = reference("young");
    for (const key of [byTool, byAsk, unreferenced, young]) store.set(key, key, OWNER, "literal");
    for (const key of [byTool, byAsk, unreferenced]) age(shardedFile(entries, key), 30);
    age(shardedFile(entries, young), 3);
    storedTool(dataDir, byTool);
    fs.writeFileSync(
      path.join(stateDir, "workflow-validation-asks.jsonl"),
      `${JSON.stringify({ keys: ["call:1", `reference:${byAsk}`] })}\n`,
    );

    const keep = await collectPrivateValueReferences(
      daemonPrivateValueReferenceRoots({ dataDir, stateDir }),
    );
    expect(keep).toEqual(new Set([byTool, byAsk]));
    const result = await sweepPrivateValues({ dataDir, keep });

    expect(result).toMatchObject({ deleted: 1, migrated: 0 });
    const reopened = new FilePrivateValueStore(dataDir);
    expect(reopened.get(byTool)).toBe(byTool);
    expect(reopened.get(byAsk)).toBe(byAsk);
    expect(reopened.get(young)).toBe(young);
    expect(reopened.get(unreferenced)).toBeUndefined();
  });

  it("writes one file per reference and keeps a re-recorded old value", async () => {
    const { dataDir, entries } = home();
    const key = reference("repeat");
    new FilePrivateValueStore(dataDir).set(key, { exit: 0 }, OWNER, "literal");
    age(shardedFile(entries, key), 30);
    // Another process records the same call again: no second file, and the entry counts as fresh.
    new FilePrivateValueStore(dataDir).set(key, { exit: 0 }, OWNER, "literal");
    expect(allEntryFiles(entries)).toHaveLength(1);

    await sweepPrivateValues({ dataDir, keep: new Set() });
    expect(new FilePrivateValueStore(dataDir).get(key)).toEqual({ exit: 0 });
  });

  it("publishes an entry again when retention removed it after a process cached it", async () => {
    const { dataDir, entries } = home();
    const key = reference("cached");
    const store = new FilePrivateValueStore(dataDir);
    store.set(key, "value", OWNER, "literal");
    age(shardedFile(entries, key), 30);
    await sweepPrivateValues({ dataDir, keep: new Set() });
    expect(fs.existsSync(shardedFile(entries, key))).toBe(false);

    store.set(key, "value", OWNER, "literal");
    expect(new FilePrivateValueStore(dataDir).get(key)).toBe("value");
  });

  it("reads flat pre-sharding entries and moves kept ones into their shard", async () => {
    const { dataDir, entries } = home();
    const kept = reference("legacy-kept");
    const expired = reference("legacy-expired");
    fs.mkdirSync(entries, { recursive: true });
    for (const key of [kept, expired]) {
      const file = path.join(entries, privateValueEntryName(key));
      fs.writeFileSync(
        file,
        JSON.stringify({ key, value: key, origin: OWNER, representation: "literal", at: 1 }),
        { mode: 0o600 },
      );
      age(file, 30);
    }
    const store = new FilePrivateValueStore(dataDir);
    expect(store.get(kept)).toBe(kept);
    // Recording a value already held in the flat layout does not publish a sharded duplicate.
    store.set(kept, kept, OWNER, "literal");
    expect(allEntryFiles(entries)).toHaveLength(2);
    const legacyInode = fs.statSync(path.join(entries, privateValueEntryName(kept))).ino;
    const result = await sweepPrivateValues({ dataDir, keep: new Set([kept]) });

    expect(result).toMatchObject({ deleted: 1, migrated: 1 });
    expect(allEntryFiles(entries)).toEqual([path.relative(entries, shardedFile(entries, kept))]);
    // The same file, linked into its shard: its age and owner-only mode carry over.
    expect(fs.statSync(shardedFile(entries, kept)).ino).toBe(legacyInode);
    const reopened = new FilePrivateValueStore(dataDir);
    expect(reopened.get(kept)).toBe(kept);
    expect(reopened.get(expired)).toBeUndefined();
  });

  it("removes old leftover temporary files and leaves recent ones", async () => {
    const { dataDir, entries } = home();
    const shard = path.join(entries, "ab");
    fs.mkdirSync(shard, { recursive: true });
    const stale = path.join(shard, `${"ab".padEnd(64, "0")}.json.1.x.tmp`);
    const fresh = path.join(shard, `${"ab".padEnd(64, "1")}.json.2.y.tmp`);
    fs.writeFileSync(stale, "{}");
    fs.writeFileSync(fresh, "{}");
    age(stale, 30);

    await sweepPrivateValues({ dataDir, keep: new Set() });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("bounds each pass and continues where the previous one stopped", async () => {
    const { dataDir, entries } = home();
    const store = new FilePrivateValueStore(dataDir);
    const keys = Array.from({ length: 6 }, (_, index) => reference(`bounded-${index}`));
    for (const key of keys) {
      store.set(key, key, OWNER, "literal");
      age(shardedFile(entries, key), 30);
    }
    const module = new PrivateValueRetentionModule({
      dataDir,
      referenceRoots: [],
      maxEntriesPerPass: 1,
    });
    const first = await module.runOnce();
    expect(first?.scanned).toBeLessThan(keys.length);
    expect(allEntryFiles(entries).length).toBeGreaterThan(0);
    for (let pass = 0; pass < 256 && allEntryFiles(entries).length > 0; pass++) {
      await module.runOnce();
    }
    expect(allEntryFiles(entries)).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "deletes nothing when references cannot all be read",
    async () => {
      const { dataDir, stateDir, entries } = home();
      const key = reference("unmarked");
      new FilePrivateValueStore(dataDir).set(key, key, OWNER, "literal");
      age(shardedFile(entries, key), 30);
      const unreadable = path.join(stateDir, "locked");
      fs.mkdirSync(unreadable);
      fs.chmodSync(unreadable, 0o000);
      try {
        const module = new PrivateValueRetentionModule({
          dataDir,
          referenceRoots: daemonPrivateValueReferenceRoots({ dataDir, stateDir }),
        });
        expect(await module.runOnce()).toBeUndefined();
        expect((await module.healthCheck()).status).toBe("degraded");
        expect(new FilePrivateValueStore(dataDir).get(key)).toBe(key);
      } finally {
        fs.chmodSync(unreadable, 0o700);
      }
    },
  );
});

describe("recorded value index", () => {
  const markers = (dataDir: string) =>
    fs
      .readdirSync(privateValueIndexDir(dataDir), { recursive: true, encoding: "utf8" })
      .map((name) => path.join(privateValueIndexDir(dataDir), name))
      .filter((file) => fs.statSync(file).isFile());

  it("recognizes a recorded argument value by a keyed digest, per workspace", () => {
    const { dataDir } = home();
    const store = new FilePrivateValueStore(dataDir);
    store.set(reference("argument"), "release/2026-10", OWNER, "literal");
    store.set(`private:v2:demonstration:${"d".repeat(64)}`, "command output", OWNER, "literal");

    const reopened = new FilePrivateValueStore(dataDir);
    expect(reopened.holdsValue("release/2026-10", OWNER)).toBe(true);
    expect(reopened.holdsValue("release/2026-10", { workspaceId: "ws-other" })).toBe(false);
    expect(reopened.holdsValue("command output", OWNER)).toBe(false);
    expect(reopened.holdsValue("never recorded", OWNER)).toBe(false);
    // Marker names are keyed: neither the value nor its plain hash can be read off the disk.
    const names = markers(dataDir).map((file) => path.basename(file));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(createHash("sha256").update("release/2026-10").digest("hex"));
  });

  it("ages markers out with retention and restores one when its value is read back", async () => {
    const { dataDir } = home();
    const key = reference("restated");
    new FilePrivateValueStore(dataDir).set(key, "feature/old-branch", OWNER, "literal");
    for (const marker of markers(dataDir)) age(marker, 30);

    const result = await sweepPrivateValues({ dataDir, keep: new Set([key]) });
    expect(result).toMatchObject({ deleted: 0, indexDeleted: 1 });
    expect(markers(dataDir)).toHaveLength(0);
    expect(new FilePrivateValueStore(dataDir).holdsValue("feature/old-branch", OWNER)).toBe(false);

    // Running or describing the recorded step reads the value back, which marks it again.
    expect(new FilePrivateValueStore(dataDir).get(key)).toBe("feature/old-branch");
    expect(new FilePrivateValueStore(dataDir).holdsValue("feature/old-branch", OWNER)).toBe(true);
  });
});
