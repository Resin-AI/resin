/**
 * End to end: a harness-style `resin mcp` session in a temp HOME switches to a newly activated
 * release without restarting. Two releases are laid out as the installer does
 * (`~/.resin/versions/v<version>` with the packaged `bin/resin` launcher, `current` and the global
 * `bin/resin` link), each a copy of this checkout's built CLI and gateway. Needs `pnpm build`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSupervisorRegistration } from "../apps/gateway/dist/mcp-supervisor/index.js";
import { RESIN_CLI_LAUNCHER } from "./package-release.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OLD = "1.0.0";
const NEW = "1.0.1";

/** One release directory: copies of the built apps, links to the shared workspace packages. */
function installRelease(resinHome, version) {
  const releaseDir = path.join(resinHome, "versions", `v${version}`);
  for (const app of ["cli", "gateway"]) {
    for (const entry of ["package.json", "dist", "node_modules"]) {
      fs.cpSync(path.join(ROOT, "apps", app, entry), path.join(releaseDir, "apps", app, entry), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
  fs.symlinkSync(path.join(ROOT, "apps", "observer"), path.join(releaseDir, "apps", "observer"));
  for (const shared of ["packages", "adapters", "node_modules"]) {
    fs.symlinkSync(path.join(ROOT, shared), path.join(releaseDir, shared));
  }
  fs.writeFileSync(
    path.join(releaseDir, "package.json"),
    `${JSON.stringify({ name: "resin", version, type: "module" })}\n`,
  );
  fs.writeFileSync(path.join(releaseDir, "version.json"), `${JSON.stringify({ version })}\n`);
  fs.mkdirSync(path.join(releaseDir, "bin"));
  fs.writeFileSync(path.join(releaseDir, "bin", "resin"), RESIN_CLI_LAUNCHER, { mode: 0o755 });
}

/** Moves `current` the way activation does: a temporary link renamed over the old one. */
function activate(resinHome, version) {
  const temp = path.join(resinHome, `.current.tmp-${version}`);
  fs.symlinkSync(path.join(resinHome, "versions", `v${version}`), temp, "dir");
  fs.renameSync(temp, path.join(resinHome, "current"));
}

/** The harness side of the stdio connection. */
class Harness {
  messages = [];
  stderr = "";
  #buffer = "";
  #waiters = [];

  constructor(child) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() !== "") this.#receive(JSON.parse(line));
        index = this.#buffer.indexOf("\n");
      }
    });
    const { promise, resolve } = Promise.withResolvers();
    child.on("close", (code) => resolve(code));
    this.exited = promise;
  }

  #receive(message) {
    this.messages.push(message);
    for (const waiter of this.#waiters.slice()) {
      if (waiter.match(message)) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  waitFor(match) {
    const found = this.messages.find(match);
    if (found) return Promise.resolve(found);
    const { promise, resolve } = Promise.withResolvers();
    this.#waiters.push({ match, resolve });
    return promise;
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(id, method, params) {
    this.send({ id, method, ...(params === undefined ? {} : { params }) });
    return this.waitFor((message) => message.id === id && !("method" in message));
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("resin mcp release switching (end to end)", () => {
  it.skipIf(process.platform === "win32")(
    "serves a running session from a newly activated release and tells the client",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-mcp-hotswap-e2e-"));
      const resinHome = path.join(home, ".resin");
      installRelease(resinHome, OLD);
      installRelease(resinHome, NEW);
      activate(resinHome, OLD);
      fs.mkdirSync(path.join(resinHome, "bin"));
      fs.symlinkSync(
        path.join(resinHome, "versions", `v${OLD}`, "bin", "resin"),
        path.join(resinHome, "bin", "resin"),
      );
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(workspace);

      // As a harness registers it: `<home>/.resin/bin/resin mcp`, with the harness's environment.
      const child = spawn(process.execPath, [path.join(resinHome, "bin", "resin"), "mcp"], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          TMPDIR: os.tmpdir(),
          DO_NOT_TRACK: "1",
          RESIN_ERROR_REPORTING: "0",
          RESIN_TELEMETRY_ENABLED: "0",
          RESIN_COMMAND_SUGGEST: "0",
          RESIN_MCP_HOTSWAP_POLL_MS: "100",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const harness = new Harness(child);
      cleanups.push(() => {
        child.kill("SIGKILL");
        fs.rmSync(home, { recursive: true, force: true });
      });

      const init = await harness.request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "synthetic-harness", version: "1.0.0" },
      });
      expect(init.result).toBeDefined();
      harness.send({ method: "notifications/initialized" });
      const listed = await harness.request(2, "tools/list");
      expect(listed.result).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "search_tools" })]),
      });

      const registrationPath = path.join(resinHome, "run", "mcp-supervisors", `${child.pid}.json`);
      expect(readJson(registrationPath)).toMatchObject({ protocol: 1, activeVersion: OLD });

      activate(resinHome, NEW);
      await harness.waitFor((message) => message.method === "notifications/tools/list_changed");

      const called = await harness.request(3, "tools/call", {
        name: "search_tools",
        arguments: { query: "synthetic" },
      });
      expect(called.error).toBeUndefined();
      expect(called.result).toBeDefined();
      // The replayed initialize was not answered to the client.
      expect(harness.messages.filter((message) => message.id === 1)).toHaveLength(1);
      expect(harness.stderr).toContain(`switched this session from v${OLD} to v${NEW}`);

      // The gateway that serves the session now is the new release's.
      const registration = parseSupervisorRegistration(readJson(registrationPath));
      expect(registration).toMatchObject({ activeVersion: NEW, version: OLD });
      const activeChildPid = registration?.childPids[0];
      expect(
        readJson(path.join(resinHome, "run", "mcp-gateways", `${activeChildPid}.json`)),
      ).toMatchObject({ version: NEW });

      // `resin status` (the new release's CLI) does not ask for a restart of this session.
      const status = spawn(
        process.execPath,
        [path.join(resinHome, "versions", `v${NEW}`, "bin", "resin"), "status", "--json"],
        {
          cwd: workspace,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            USERPROFILE: home,
            DO_NOT_TRACK: "1",
            RESIN_ERROR_REPORTING: "0",
            RESIN_TELEMETRY_ENABLED: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let statusOut = "";
      status.stdout.setEncoding("utf8");
      status.stdout.on("data", (chunk) => {
        statusOut += chunk;
      });
      const statusClosed = Promise.withResolvers();
      status.on("close", statusClosed.resolve);
      await statusClosed.promise;
      const summary = JSON.parse(statusOut);
      expect(summary.update.staleMcpGateways).toMatchObject({ count: 0, unknownVersionCount: 0 });

      child.stdin.end();
      expect(await harness.exited).toBe(0);
      expect(fs.existsSync(registrationPath)).toBe(false);
    },
    120_000,
  );
});
