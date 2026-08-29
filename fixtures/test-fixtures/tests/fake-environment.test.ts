import { describe, expect, it } from "vitest";
import {
  DeterministicIdGenerator,
  FakeClock,
  FakeControlStream,
  FakeTranscriptSource,
  InMemoryArtifactStore,
  InMemoryFileSystem,
  createDeterministicEnvironment,
} from "../src/fake-environment.js";

describe("Deterministic Fake Environment", () => {
  describe("FakeClock", () => {
    it("provides deterministic controllable time", () => {
      const clock = new FakeClock("2026-08-17T12:00:00.000Z");
      expect(clock.iso()).toBe("2026-08-17T12:00:00.000Z");

      clock.advance(5000);
      expect(clock.iso()).toBe("2026-08-17T12:00:05.000Z");

      clock.advanceTo("2026-08-17T12:01:00.000Z");
      expect(clock.iso()).toBe("2026-08-17T12:01:00.000Z");

      clock.reset();
      expect(clock.iso()).toBe("2026-08-17T12:00:00.000Z");
    });

    it("prevents moving backwards in advance() or advanceTo()", () => {
      const clock = new FakeClock("2026-08-17T12:00:00.000Z");
      expect(() => clock.advance(-100)).toThrow();
      expect(() => clock.advanceTo("2026-08-17T11:59:00.000Z")).toThrow();
    });
  });

  describe("DeterministicIdGenerator", () => {
    it("generates sequential prefixed identifiers", () => {
      const idGen = new DeterministicIdGenerator();
      expect(idGen.nextId("evt")).toBe("evt_000001");
      expect(idGen.nextId("evt")).toBe("evt_000002");
    });

    it("generates reproducible deterministic UUIDs and ULIDs", () => {
      const idGen1 = new DeterministicIdGenerator(12345);
      const uuid1 = idGen1.nextUuid();
      const ulid1 = idGen1.nextUlid();

      const idGen2 = new DeterministicIdGenerator(12345);
      const uuid2 = idGen2.nextUuid();
      const ulid2 = idGen2.nextUlid();

      expect(uuid1).toBe(uuid2);
      expect(ulid1).toBe(ulid2);
      expect(uuid1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(ulid1.length).toBe(26);
    });
  });

  describe("InMemoryFileSystem", () => {
    it("supports writing, reading, existence checking, and directory creation", () => {
      const fs = new InMemoryFileSystem();
      expect(fs.exists("/src/index.ts")).toBe(false);

      fs.writeFile("/src/index.ts", 'console.log("hello");');
      expect(fs.exists("/src/index.ts")).toBe(true);
      expect(fs.readFile("/src/index.ts", "utf8")).toBe('console.log("hello");');

      const stat = fs.stat("/src/index.ts");
      expect(stat.isFile).toBe(true);
      expect(stat.size).toBeGreaterThan(0);

      const dirContents = fs.readdir("/src");
      expect(dirContents).toContain("index.ts");
    });

    it("supports directory listing and recursive removal", () => {
      const fs = new InMemoryFileSystem();
      fs.writeFile("/project/src/a.ts", "export const a = 1;");
      fs.writeFile("/project/src/b.ts", "export const b = 2;");
      fs.writeFile("/project/README.md", "# Project");

      expect(fs.readdir("/project")).toEqual(["README.md", "src"]);
      expect(fs.readdir("/project/src")).toEqual(["a.ts", "b.ts"]);

      fs.rm("/project/src", { recursive: true });
      expect(fs.exists("/project/src/a.ts")).toBe(false);
      expect(fs.exists("/project/README.md")).toBe(true);
    });

    it("triggers watcher callbacks on file changes", () => {
      const fs = new InMemoryFileSystem();
      let eventCount = 0;

      const unwatch = fs.watch("/workspace", () => {
        eventCount++;
      });

      fs.writeFile("/workspace/file.txt", "content 1");
      fs.writeFile("/workspace/sub/file2.txt", "content 2");

      expect(eventCount).toBe(2);
      unwatch();

      fs.writeFile("/workspace/file.txt", "content 3");
      expect(eventCount).toBe(2);
    });
  });

  describe("InMemoryArtifactStore", () => {
    it("stores content addressable artifacts with sha256 digests", async () => {
      const store = new InMemoryArtifactStore();
      const content = 'export function test() { return "ok"; }';

      const { digest, size } = await store.put(content, { format: "js" });
      expect(digest.length).toBe(64);
      expect(size).toBe(content.length);

      expect(await store.has(digest)).toBe(true);
      expect(await store.getText(digest)).toBe(content);
      expect(await store.verifyIntegrity(digest)).toBe(true);

      const items = await store.list();
      expect(items.length).toBe(1);
      expect(items[0].digest).toBe(digest);

      await store.delete(digest);
      expect(await store.has(digest)).toBe(false);
    });
  });

  describe("FakeControlStream", () => {
    it("sends and listens to sequenced stream messages", () => {
      const stream = new FakeControlStream();
      const received: unknown[] = [];

      const unsubscribe = stream.onMessage((msg) => {
        received.push(msg);
      });

      const msg1 = stream.send({ type: "client.heartbeat", uptimeMs: 1000 });
      expect(msg1.sequence).toBe(1);
      expect(received.length).toBe(1);

      const msg2 = stream.send({ type: "client.heartbeat", uptimeMs: 2000 });
      expect(msg2.sequence).toBe(2);
      expect(received.length).toBe(2);

      expect(stream.getHistory().length).toBe(2);
      unsubscribe();
    });

    it("handles disconnect and reconnect states", () => {
      const stream = new FakeControlStream();
      stream.disconnect();
      expect(stream.isConnected()).toBe(false);
      expect(() => stream.send({ ping: true })).toThrow();

      stream.reconnect();
      expect(stream.isConnected()).toBe(true);
      expect(() => stream.send({ ping: true })).not.toThrow();
    });
  });

  describe("FakeTranscriptSource", () => {
    it("streams events deterministically and supports cursor / seeking", () => {
      const source = new FakeTranscriptSource();
      expect(source.hasNext()).toBe(true);

      const evt1 = source.next();
      expect(evt1).toBeDefined();
      expect(evt1?.type).toBe("message");

      const batch = source.nextBatch(3);
      expect(batch.length).toBe(3);

      source.seek(0);
      const rewindEvt = source.next();
      expect(rewindEvt?.eventId).toBe(evt1?.eventId);
    });
  });

  describe("createDeterministicEnvironment Factory", () => {
    it("bundles all deterministic mock services with unified reset", () => {
      const env = createDeterministicEnvironment({
        initialTime: "2026-08-17T12:00:00.000Z",
        seed: 999,
      });

      expect(env.clock.iso()).toBe("2026-08-17T12:00:00.000Z");
      expect(env.idGen.nextId("t")).toBe("t_000001");
      env.fs.writeFile("/test.txt", "data");

      env.reset();
      expect(env.fs.exists("/test.txt")).toBe(false);
      expect(env.clock.iso()).toBe("2026-08-17T12:00:00.000Z");
    });
  });
});
