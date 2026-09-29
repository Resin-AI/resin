import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createUnrefTransport } from "../../src/error-reporting/transport.js";

const distEntry = fileURLToPath(new URL("../../dist/error-reporting/index.js", import.meta.url));
const TEST_KEY = "phc_testKey0123456789abcdef";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A loopback host that accepts connections and never answers stands in for a black-holed ingest
 * host (no packets leave the machine). The child flushes with a 500 ms bound and must exit right
 * after it, although its request is still in flight.
 */
describe.skipIf(!fs.existsSync(distEntry))("bounded shutdown against a dead ingest host", () => {
  it("does not keep a short-lived process alive after the bounded flush", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-er-bound-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));

    const script = `
      const { ErrorReporter } = await import(${JSON.stringify(pathToFileURL(distEntry).href)});
      const reporter = new ErrorReporter({
        surface: "cli",
        version: "0.0.0-test",
        home: ${JSON.stringify(home)},
        env: {
          RESIN_HOME: ${JSON.stringify(path.join(home, ".resin"))},
          RESIN_POSTHOG_KEY: ${JSON.stringify(TEST_KEY)},
          RESIN_POSTHOG_HOST: "http://127.0.0.1:${port}",
          RESIN_ERROR_REPORTING: "1",
        },
      });
      reporter.capture("cli_command_completed", { command: "status", exit_code: 0 });
      await reporter.flush(500);
      process.stderr.write("flushed\\n");
    `;
    const started = performance.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    const elapsed = performance.now() - started;

    expect(exitCode).toBe(0);
    expect(stderr).toContain("flushed");
    expect(stdout).toBe("");
    expect(sockets.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_500);
  });
});

describe("createUnrefTransport", () => {
  it("cancelPending destroys in-flight requests", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const transport = createUnrefTransport(60_000);
    const request = transport(`http://127.0.0.1:${port}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await new Promise<void>((resolve) => server.once("connection", () => resolve()));
    transport.cancelPending();
    await expect(request).rejects.toThrow("request cancelled");
  });
});
