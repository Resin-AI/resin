import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilePrivateValueStore,
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";

const directories: string[] = [];
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
});
