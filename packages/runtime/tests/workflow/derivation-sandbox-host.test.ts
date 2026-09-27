/**
 * The derivation sandbox: Python in Pyodide inside Deno sees only its inputs. It cannot reach the home directory, spawn processes, write files or use the network.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST,
  LOOKUP,
  directories,
  js,
  removeDirectories,
  runDerivation,
} from "./derivation-fixtures.js";

afterEach(removeDirectories);

describe("the derivation sandbox", { timeout: 60_000 }, () => {
  it("cannot read a file under the home directory", async () => {
    const secretDir = mkdtempSync(path.join(homedir(), ".resin-derivation-secret-"));
    directories.push(secretDir);
    const secret = path.join(secretDir, "secret.json");
    writeFileSync(secret, JSON.stringify({ account_type: "R", mcc: 5942 }));
    const viaOpen = await runDerivation(
      `import json\njson.load(open(${JSON.stringify(secret)}))\n`,
    );
    expect(viaOpen.step.status).toBe("failed");
    const viaHost = await runDerivation(
      `${HOST}${js(`JSON.parse(Deno.readTextFileSync(${JSON.stringify(secret)}))`)}{}\n`,
    );
    expect(viaHost.step.status).toBe("failed");
  });

  it("cannot spawn a process", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "resin-derivation-outside-"));
    directories.push(outside);
    const marker = path.join(outside, "spawned.txt");
    const spawnCode = `new Deno.Command("/bin/sh", { args: ["-c", ${JSON.stringify(`: > ${marker}`)}] }).outputSync()`;
    const { step } = await runDerivation(`${HOST}${js(spawnCode)}${LOOKUP}`);
    expect(step.status).toBe("failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("never writes a marker file, directly or through the host", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "resin-derivation-outside-"));
    directories.push(outside);
    const direct = path.join(outside, "direct.txt");
    const host = path.join(outside, "host.txt");
    const first = await runDerivation(`open(${JSON.stringify(direct)}, "w").write("x")\n${LOOKUP}`);
    expect(first.step.status).toBe("failed");
    const second = await runDerivation(
      `${HOST}${js(`Deno.writeTextFileSync(${JSON.stringify(host)}, "x")`)}${LOOKUP}`,
    );
    expect(second.step.status).toBe("failed");
    expect(existsSync(direct)).toBe(false);
    expect(existsSync(host)).toBe(false);
  });

  it("cannot open a socket or fetch", async () => {
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
      socket.on("error", () => undefined);
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const socket = await runDerivation(
        `${HOST}s = sys.modules["_socket"].socket()\ns.connect(("127.0.0.1", ${port}))\ns.send(b"resin-marker")\n${LOOKUP}`,
      );
      expect(socket.step.status).toBe("failed");
      const fetching = await runDerivation(
        `${HOST}sys.modules["pyodide.ffi"].run_sync(${js(`fetch("http://127.0.0.1:${port}/resin-marker")`).trimEnd()})\n${LOOKUP}`,
      );
      expect(fetching.step.status).toBe("failed");
      // The Deno process itself holds no network permission a later event-loop turn could use.
      const permissions = await runDerivation(
        `${HOST}{n: str(run_js('Deno.permissions.querySync({name: "' + n + '"}).state')) for n in ["net", "env", "run", "ffi", "sys", "write"]}\n`,
      );
      expect(permissions.step).toMatchObject({
        status: "completed",
        result: {
          net: "denied",
          env: "denied",
          run: "denied",
          ffi: "denied",
          sys: "denied",
          write: "denied",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.join("")).not.toContain("resin-marker");
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      server.unref();
      await Promise.race([closed.promise, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  });
});
