import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, writeFully } from "../../src/installer/bootstrap-entry.js";

const telemetryDist = fileURLToPath(
  new URL("../../dist/installer/install-telemetry.js", import.meta.url),
);
const TEST_KEY = "phc_testKey0123456789abcdef";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-helper-output-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Accepts connections and never answers: an ingest host that hangs, without leaving loopback. */
async function silentHost(): Promise<number> {
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
  return typeof address === "object" && address ? address.port : 0;
}

describe.skipIf(!fs.existsSync(telemetryDist))(
  "install telemetry never cuts off helper output",
  () => {
    it("keeps the process alive through a hanging send, then writes the result", async () => {
      const port = await silentHost();
      const home = tempDir();
      // Mirrors runCli's success path: send, then write the JSON result the installers require.
      // Before the fix, the unref'd request left nothing to keep the event loop alive, so Node
      // exited with code 0 in the middle of the send and the result was never written.
      const script = `
      const { createInstallTelemetry } = await import(${JSON.stringify(pathToFileURL(telemetryDist).href)});
      await createInstallTelemetry({ resinHome: ${JSON.stringify(home)} }).send("install_completed", { step: "complete" });
      process.stdout.write('{"success":true}\\n');
    `;
      const started = performance.now();
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VITEST: "",
          VITEST_WORKER_ID: "",
          NODE_ENV: "production",
          RESIN_POSTHOG_KEY: TEST_KEY,
          RESIN_POSTHOG_HOST: `http://127.0.0.1:${port}`,
          RESIN_ERROR_REPORTING: "1",
          // Clear the suite-wide opt-out: this test exercises sending, against a loopback host.
          DO_NOT_TRACK: "",
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(exitCode).toBe(0);
      expect(stdout).toBe('{"success":true}\n');
      expect(performance.now() - started).toBeLessThan(6_000);
    });
  },
);

describe("runCli result and exit handling", () => {
  it("reports a failed install through exitCode without process.exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit must not be called");
    });
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk, encodingOrCallback, callback) => {
      stderr.push(String(chunk));
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      done?.();
      return true;
    });
    const stdout = vi.spyOn(process.stdout, "write");
    const home = tempDir();
    await runCli([
      "--resin-home",
      path.join(home, ".resin"),
      // A missing trust file fails inside the install step, with no network involved.
      "--trusted-keys-file",
      path.join(home, "missing-trust.json"),
      "--allow-insecure-loopback",
      "--no-onboarding",
      "--non-interactive",
      "--no-path-update",
    ]);
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("Installation failed");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writeFully resolves only after the stream accepted the chunk", async () => {
    const order: string[] = [];
    let flush: () => void = () => undefined;
    const stream = {
      write: (_chunk: string, callback: (error?: Error | null) => void) => {
        order.push("write");
        flush = () => {
          order.push("flushed");
          callback();
        };
        return false;
      },
    };
    const done = writeFully(stream, "{}").then(() => order.push("resolved"));
    await Promise.resolve();
    expect(order).toEqual(["write"]);
    flush();
    await done;
    expect(order).toEqual(["write", "flushed", "resolved"]);
  });
});
