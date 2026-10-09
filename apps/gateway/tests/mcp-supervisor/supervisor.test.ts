import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type InstalledRelease,
  McpSupervisor,
  type McpSupervisorEvent,
  locateInstalledLauncher,
  parseSupervisorRegistration,
  readActiveRelease,
  runMcpSupervisor,
  supervisorRegistryDir,
} from "../../src/mcp-supervisor/index.js";
import { FakeClient, type FakeInstall, callPayload, createFakeInstall } from "./fake-release.js";

const release = (version: string): InstalledRelease => ({ directory: `v${version}`, version });
const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: { roots: { listChanged: true } },
  clientInfo: { name: "synthetic-harness", version: "9.9.9" },
};
const SESSION_ARGS = ["--harness", "omp", "--full-catalog"];

interface Session {
  readonly install: FakeInstall;
  readonly supervisor: McpSupervisor;
  readonly client: FakeClient;
  readonly stdin: PassThrough;
  readonly events: McpSupervisorEvent[];
  readonly stderr: string[];
  exitedPid: (version: string) => Promise<void>;
}

const sessions: Session[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.stdin.end();
    await session.supervisor.closed();
    session.install.cleanup();
  }
});

function startSession(install: FakeInstall, initial: string): Session {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events: McpSupervisorEvent[] = [];
  const stderr: string[] = [];
  const exitWaiters = new Map<string, () => void>();
  const supervisor = new McpSupervisor({
    resinHome: install.resinHome,
    initialRelease: release(initial),
    supervisorRelease: release(initial),
    args: SESSION_ARGS,
    stdin,
    stdout,
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    cwd: install.root,
    pollIntervalMs: 0,
    stopGraceMs: 60_000,
    registrationPid: process.pid,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "child_exited") exitWaiters.get(event.release.version)?.();
    },
  });
  supervisor.start();
  const session: Session = {
    install,
    supervisor,
    client: new FakeClient(stdin, stdout),
    stdin,
    events,
    stderr,
    exitedPid: (version) => {
      if (
        events.some((event) => event.type === "child_exited" && event.release.version === version)
      ) {
        return Promise.resolve();
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      exitWaiters.set(version, resolve);
      return promise;
    },
  };
  sessions.push(session);
  return session;
}

async function initialize(client: FakeClient): Promise<void> {
  await client.request(1, "initialize", INITIALIZE_PARAMS);
  client.send({ method: "notifications/initialized" });
}

function isListChanged(message: Record<string, unknown>): boolean {
  return message.method === "notifications/tools/list_changed";
}

function isRootsRequest(message: Record<string, unknown>): boolean {
  return message.method === "roots/list" && "id" in message;
}

describe("McpSupervisor release switching", () => {
  it("finishes in-flight requests on the old gateway and sends new ones to the new gateway", async () => {
    const install = createFakeInstall();
    install.install("1.0.0");
    install.install("2.0.0");
    install.activate("1.0.0");
    const { client, supervisor, events, exitedPid } = startSession(install, "1.0.0");
    await initialize(client);

    // An in-flight call on v1 that waits on a server-initiated request.
    client.send({ id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
    const rootsRequest = await client.waitFor(isRootsRequest);

    install.activate("2.0.0");
    await supervisor.checkForUpgrade();
    expect(events.filter((event) => event.type === "switched")).toHaveLength(1);
    expect(supervisor.activeRelease()?.version).toBe("2.0.0");
    expect(client.messages.filter(isListChanged)).toHaveLength(1);

    // The replayed initialize was answered by v2 but not forwarded.
    expect(client.responsesTo(1)).toHaveLength(1);
    const v2Received = install.receivedLines("2.0.0");
    expect(JSON.parse(v2Received[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: INITIALIZE_PARAMS,
    });
    expect(v2Received[0]).toBe(install.receivedLines("1.0.0")[0]);

    // New requests reach v2, which carries the session's identity.
    const whoami = callPayload(
      await client.request(3, "tools/call", { name: "whoami", arguments: {} }),
    );
    expect(whoami).toEqual({
      version: "2.0.0",
      initParams: INITIALIZE_PARAMS,
      sawInitialized: true,
      argv: ["mcp", ...SESSION_ARGS],
      cwd: fs.realpathSync(install.root),
      protocol: "1",
    });
    const tools = await client.request(4, "tools/list");
    expect(tools.result).toEqual({ tools: [{ name: "tool_2_0_0" }] });

    // The client's answer goes back to v1, which then finishes the in-flight call and stops.
    client.send({ id: rootsRequest.id, result: { roots: [{ uri: "file:///synthetic" }] } });
    const slow = callPayload(await client.response(2));
    expect(slow).toEqual({ version: "1.0.0", roots: [{ uri: "file:///synthetic" }] });
    await exitedPid("1.0.0");
    expect(client.responsesTo(2)).toHaveLength(1);
    expect(
      install.received("1.0.0").some((message) => JSON.stringify(message).includes('"id":3')),
    ).toBe(false);
  });

  it("stops an idle old gateway as soon as the new one takes over", async () => {
    const install = createFakeInstall();
    install.install("1.0.0");
    install.install("1.1.0");
    install.activate("1.0.0");
    const { client, supervisor, exitedPid } = startSession(install, "1.0.0");
    await initialize(client);
    install.activate("1.1.0");
    await supervisor.checkForUpgrade();
    await exitedPid("1.0.0");
    expect(supervisor.childPids()).toHaveLength(1);
    const registration = parseSupervisorRegistration(
      JSON.parse(
        fs.readFileSync(
          path.join(supervisorRegistryDir(install.resinHome), `${process.pid}.json`),
          "utf8",
        ),
      ),
    );
    expect(registration).toMatchObject({
      protocol: 1,
      version: "1.0.0",
      activeVersion: "1.1.0",
      childPids: supervisor.childPids(),
    });
  });

  it.each(["refuse-initialize", "exit-on-initialize"] as const)(
    "keeps the old gateway when the new one fails to start (%s) and logs once",
    async (mode) => {
      const install = createFakeInstall();
      install.install("1.0.0");
      install.install("2.0.0", mode);
      install.activate("1.0.0");
      const { client, supervisor, events, stderr } = startSession(install, "1.0.0");
      await initialize(client);

      install.activate("2.0.0");
      await supervisor.checkForUpgrade();
      await supervisor.checkForUpgrade();
      expect(events.filter((event) => event.type === "switch_failed")).toHaveLength(1);
      expect(stderr.filter((line) => line.includes("could not switch"))).toHaveLength(1);
      expect(stderr.join("")).toContain("keeps running v1.0.0");
      expect(client.messages.filter(isListChanged)).toHaveLength(0);
      expect(client.responsesTo(1)).toHaveLength(1);

      const whoami = callPayload(
        await client.request(2, "tools/call", { name: "whoami", arguments: {} }),
      );
      expect(whoami.version).toBe("1.0.0");
      expect(supervisor.activeRelease()?.version).toBe("1.0.0");
    },
  );

  it("waits for the initialize handshake before switching", async () => {
    const install = createFakeInstall();
    install.install("1.0.0");
    install.install("2.0.0");
    install.activate("2.0.0");
    const { client, supervisor } = startSession(install, "1.0.0");
    await supervisor.checkForUpgrade();
    expect(supervisor.activeRelease()?.version).toBe("1.0.0");
    await initialize(client);
    await supervisor.checkForUpgrade();
    expect(supervisor.activeRelease()?.version).toBe("2.0.0");
  });

  it("answers the old gateway's unanswered requests with errors when it stops", async () => {
    const install = createFakeInstall();
    install.install("1.0.0");
    install.install("2.0.0");
    install.activate("1.0.0");
    const { client, supervisor, exitedPid } = startSession(install, "1.0.0");
    await initialize(client);
    client.send({ id: "slow-1", method: "tools/call", params: { name: "slow", arguments: {} } });
    const rootsRequest = await client.waitFor(isRootsRequest);
    install.activate("2.0.0");
    await supervisor.checkForUpgrade();

    // The cancellation reaches v1 (the request's owner), which exits without answering.
    client.send({ method: "notifications/cancelled", params: { requestId: "slow-1" } });
    await exitedPid("1.0.0");
    const failed = await client.response("slow-1");
    expect(failed.error).toMatchObject({ code: -32603 });
    const cancelled = await client.waitFor(
      (message) =>
        message.method === "notifications/cancelled" &&
        JSON.stringify(message.params).includes(String(rootsRequest.id)),
    );
    expect(cancelled.params).toMatchObject({ requestId: rootsRequest.id });
    // A late answer to the dead gateway's request goes nowhere, and the session goes on.
    client.send({ id: rootsRequest.id, result: { roots: [] } });
    const whoami = callPayload(
      await client.request(5, "tools/call", { name: "whoami", arguments: {} }),
    );
    expect(whoami.version).toBe("2.0.0");
  });

  it("neither drops nor duplicates requests across a switch and keeps id types", async () => {
    const install = createFakeInstall();
    install.install("1.0.0");
    install.install("2.0.0");
    install.activate("1.0.0");
    const { client, supervisor } = startSession(install, "1.0.0");
    await initialize(client);

    const count = 100;
    const before = Array.from({ length: count }, (_, index) => index + 10);
    const after = before.map((id) => String(id));
    const late = before.map((id) => `late-${id}`);
    // v1 holds these until the client answers its roots/list request.
    for (const id of before) {
      client.send({
        id,
        method: "tools/call",
        params: { name: "echo", arguments: { deferred: true } },
      });
    }
    const rootsRequest = await client.waitFor(isRootsRequest);
    install.activate("2.0.0");
    const switching = supervisor.checkForUpgrade();
    await switching;
    for (const id of after) {
      client.send({ id, method: "tools/call", params: { name: "echo", arguments: {} } });
    }
    client.send({ id: rootsRequest.id, result: { roots: [] } });
    for (const id of late) {
      client.send({ id, method: "tools/call", params: { name: "echo", arguments: {} } });
    }
    const all = [...before, ...after, ...late];
    const responses = await Promise.all(all.map((id) => client.response(id)));

    const answered = client.messages.filter((message) => "id" in message && !("method" in message));
    const keys = answered.map((message) => `${typeof message.id}:${String(message.id)}`);
    // Every request answered exactly once (plus initialize), ids compared by type and value.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(all.length + 1);
    for (const [index, id] of all.entries()) {
      const response = responses[index];
      expect(typeof response?.id).toBe(typeof id);
      const payload = callPayload(response ?? {});
      expect(payload.version).toBe(
        before.includes(Number(id)) && typeof id === "number" ? "1.0.0" : "2.0.0",
      );
    }
  });
});

describe("pointer and layout (format 1)", () => {
  let install: FakeInstall | undefined;
  afterEach(() => install?.cleanup());

  it("reads the current link, then the current-version file, and ignores links outside versions", () => {
    install = createFakeInstall();
    install.install("1.2.3");
    expect(readActiveRelease(install.resinHome)).toBeNull();
    fs.writeFileSync(path.join(install.resinHome, "current-version"), "v1.2.3\n");
    expect(readActiveRelease(install.resinHome)).toEqual(release("1.2.3"));
    install.install("1.2.4");
    install.activate("1.2.4");
    expect(readActiveRelease(install.resinHome)).toEqual(release("1.2.4"));
    fs.rmSync(path.join(install.resinHome, "current"));
    fs.symlinkSync(install.root, path.join(install.resinHome, "current"), "dir");
    expect(readActiveRelease(install.resinHome)).toEqual(release("1.2.3"));
    fs.writeFileSync(path.join(install.resinHome, "current-version"), "../escape\n");
    expect(readActiveRelease(install.resinHome)).toBeNull();
  });

  it("locates only launchers in the installed layout", () => {
    install = createFakeInstall();
    install.install("1.2.3");
    const entry = path.join(install.resinHome, "versions", "v1.2.3", "bin", "resin");
    expect(locateInstalledLauncher(entry)).toEqual({
      resinHome: fs.realpathSync(install.resinHome),
      release: release("1.2.3"),
    });
    // A global `bin/resin` symlink resolves to its release.
    fs.mkdirSync(path.join(install.resinHome, "bin"));
    fs.symlinkSync(entry, path.join(install.resinHome, "bin", "resin"));
    expect(locateInstalledLauncher(path.join(install.resinHome, "bin", "resin"))?.release).toEqual(
      release("1.2.3"),
    );
    expect(locateInstalledLauncher(fileURLToPath(import.meta.url))).toBeNull();
  });

  it("declines to supervise outside the installed layout, when turned off, or for a child", async () => {
    install = createFakeInstall();
    install.install("1.2.3");
    const entry = path.join(install.resinHome, "versions", "v1.2.3", "bin", "resin");
    await expect(runMcpSupervisor({ entry: import.meta.url, args: [], env: {} })).resolves.toBe(
      undefined,
    );
    await expect(
      runMcpSupervisor({ entry, args: [], env: { RESIN_MCP_HOTSWAP: "0" } }),
    ).resolves.toBe(undefined);
    await expect(
      runMcpSupervisor({ entry, args: [], env: { RESIN_MCP_SUPERVISOR: "1" } }),
    ).resolves.toBe(undefined);
    await expect(runMcpSupervisor({ entry, args: ["--help"], env: {} })).resolves.toBe(undefined);
  });
});

describe("supervisor leanness", () => {
  it("imports only node builtins and its own modules", () => {
    const sourceDir = fileURLToPath(new URL("../../src/mcp-supervisor/", import.meta.url));
    for (const file of fs.readdirSync(sourceDir)) {
      const source = fs.readFileSync(path.join(sourceDir, file), "utf8");
      const specifiers = [...source.matchAll(/(?:from|import)\s+"([^"]+)"/gu)].map(
        (match) => match[1] ?? "",
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith("node:") || /^\.\/[a-z-]+\.js$/u.test(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
      expect(source).not.toMatch(/import\(/u);
    }
  });
});
