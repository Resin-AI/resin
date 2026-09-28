import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SecurePipeSocket,
  checkOwnerOnly,
  connectVerifiedPipe,
  createPrivateDirectory,
  createSecurePipeServer,
  currentUserSid,
  ensureOwnerOnly,
  ensurePrivateDirectoryBoundary,
  isWindowsSecurityAvailable,
  readAcl,
  readPipeAcl,
  serviceHostExecutablePath,
  verifyPipeServer,
  windowsDaemonPipeName,
  writePrivateFileExclusive,
} from "../src/index.js";
import { PROBE_ACCESS, probeOpenWithUserSidDisabled, squatPipeForTesting } from "../src/testing.js";

const ERROR_ACCESS_DENIED = 5;
const FILE_ALL_ACCESS = 0x1f01ff;
const EVERYONE = "S-1-1-0";
const NETWORK = "S-1-5-2";

function uniquePipeName(): string {
  return `\\\\.\\pipe\\resin-test-${process.pid}-${crypto.randomUUID()}`;
}

function connect(name: string): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  const socket = net.createConnection(name);
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
  return promise;
}

function readExactly(socket: Duplex, length: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let received = 0;
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    received += chunk.length;
    if (received >= length) resolve(Buffer.concat(chunks));
  });
  socket.once("error", reject);
  socket.once("close", () => reject(new Error(`closed after ${received} of ${length} bytes`)));
  return promise;
}

function readAll(socket: net.Socket): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.once("end", () => resolve(Buffer.concat(chunks)));
  socket.once("error", reject);
  return promise;
}

describe.runIf(process.platform === "win32")("Windows security helper (native)", () => {
  let tempDir: string;
  let sid: string;

  beforeEach(() => {
    expect(isWindowsSecurityAvailable()).toBe(true);
    sid = currentUserSid();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-winsec-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports the current user's SID", () => {
    expect(sid).toMatch(/^S-1-5-\d+(-\d+)*$/);
    expect(windowsDaemonPipeName(tempDir)).toBe(windowsDaemonPipeName(tempDir, sid));
  });

  it("gives directories an inheritable owner-only DACL that denies every other principal", () => {
    const privateDir = path.join(tempDir, "private");
    fs.mkdirSync(privateDir);
    ensureOwnerOnly(privateDir, { directory: true });

    const acl = readAcl(privateDir);
    expect(acl.owner).toBe(sid);
    expect(acl.protected).toBe(true);
    expect(acl.entries).toEqual([
      { type: "allow", sid, mask: FILE_ALL_ACCESS, inherited: false, inheritOnly: false },
    ]);
    expect(checkOwnerOnly(privateDir)).toMatchObject({ ok: true, problems: [] });

    // Files created later inherit owner-only access without any extra call.
    const secret = path.join(privateDir, "secret.json");
    fs.writeFileSync(secret, "{}");
    const fileAcl = readAcl(secret);
    expect(fileAcl.entries.every((entry) => entry.sid === sid)).toBe(true);
    expect(fileAcl.entries.some((entry) => entry.inherited)).toBe(true);
    expect(checkOwnerOnly(secret)).toMatchObject({ ok: true, problems: [] });

    for (const target of [privateDir, secret]) {
      for (const access of [PROBE_ACCESS.read, PROBE_ACCESS.write, PROBE_ACCESS.readControl]) {
        expect(probeOpenWithUserSidDisabled(target, access)).toEqual({
          ok: false,
          win32Error: ERROR_ACCESS_DENIED,
        });
      }
    }
  });

  it("detects and repairs files readable by other principals", () => {
    const exposed = path.join(tempDir, "exposed.txt");
    fs.writeFileSync(exposed, "token");
    execFileSync("icacls", [exposed, "/grant", `*${EVERYONE}:(R)`], { stdio: "ignore" });

    // Positive control: the probe really can open objects that other principals may open.
    expect(probeOpenWithUserSidDisabled(exposed, PROBE_ACCESS.read).ok).toBe(true);
    const before = checkOwnerOnly(exposed);
    expect(before.ok).toBe(false);
    expect(before.problems).toContain(`grants access to ${EVERYONE}`);

    ensureOwnerOnly(exposed, { directory: false });
    expect(checkOwnerOnly(exposed)).toMatchObject({ ok: true, problems: [] });
    expect(probeOpenWithUserSidDisabled(exposed, PROBE_ACCESS.read)).toEqual({
      ok: false,
      win32Error: ERROR_ACCESS_DENIED,
    });
    expect(fs.readFileSync(exposed, "utf8")).toBe("token");
  });

  it("propagates a directory repair to existing children", () => {
    const home = path.join(tempDir, "home");
    const nested = path.join(home, "state", "queue");
    fs.mkdirSync(nested, { recursive: true });
    const child = path.join(nested, "pending.jsonl");
    fs.writeFileSync(child, "{}\n");
    execFileSync("icacls", [home, "/grant", `*${EVERYONE}:(OI)(CI)(R)`], { stdio: "ignore" });
    expect(checkOwnerOnly(child).ok).toBe(false);
    expect(probeOpenWithUserSidDisabled(child, PROBE_ACCESS.read).ok).toBe(true);

    ensureOwnerOnly(home, { directory: true });
    expect(checkOwnerOnly(nested)).toMatchObject({ ok: true, problems: [] });
    expect(checkOwnerOnly(child)).toMatchObject({ ok: true, problems: [] });
    expect(probeOpenWithUserSidDisabled(child, PROBE_ACCESS.read).win32Error).toBe(
      ERROR_ACCESS_DENIED,
    );
  });

  it("keeps owner-only access across hardlinks and same-volume renames", () => {
    const privateDir = path.join(tempDir, "private");
    fs.mkdirSync(privateDir);
    ensureOwnerOnly(privateDir, { directory: true });
    const temp = path.join(privateDir, "value.tmp");
    fs.writeFileSync(temp, "v");
    const published = path.join(privateDir, "value");
    fs.linkSync(temp, published);
    fs.renameSync(temp, path.join(privateDir, "value.renamed"));
    expect(checkOwnerOnly(published).ok).toBe(true);
    expect(checkOwnerOnly(path.join(privateDir, "value.renamed")).ok).toBe(true);

    // A file renamed in from a broader directory keeps its old DACL, so callers must fix it.
    const outside = path.join(tempDir, "outside.tmp");
    fs.writeFileSync(outside, "v");
    execFileSync("icacls", [outside, "/grant", `*${EVERYONE}:(R)`], { stdio: "ignore" });
    const movedIn = path.join(privateDir, "moved-in");
    fs.renameSync(outside, movedIn);
    expect(checkOwnerOnly(movedIn).ok).toBe(false);
    ensureOwnerOnly(movedIn, { directory: false });
    expect(checkOwnerOnly(movedIn).ok).toBe(true);
  });

  it("refuses to adopt an object owned by another principal, changing nothing", () => {
    // Owned by TrustedInstaller on every supported Windows; readable, never writable by us.
    const foreign = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe");
    const before = readAcl(foreign);
    expect(before.owner).not.toBe(sid);
    expect(before.owner).toMatch(/^S-1-5-80-/);
    expect(checkOwnerOnly(foreign)).toMatchObject({ ok: false, ownedByCurrentUser: false });
    expect(() => ensureOwnerOnly(foreign, { directory: false })).toThrow(
      expect.objectContaining({ code: "EFOREIGNOWNER" }),
    );
    expect(readAcl(foreign)).toEqual(before);
  });

  it("repairs a file it owns even when its DACL withholds WRITE_OWNER", () => {
    const file = path.join(tempDir, "owned-read-only");
    fs.writeFileSync(file, "v");
    // Only read access for us; as owner we still hold READ_CONTROL and WRITE_DAC implicitly.
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `*${sid}:(R)`], {
      stdio: "ignore",
    });
    ensureOwnerOnly(file, { directory: false });
    const acl = readAcl(file);
    expect(acl).toMatchObject({ owner: sid, protected: true });
    expect(acl.entries).toEqual([
      { type: "allow", sid, mask: FILE_ALL_ACCESS, inherited: false, inheritOnly: false },
    ]);
  });

  it("requires protected DACLs for boundaries and a protected ancestor for descendants", () => {
    const boundary = path.join(tempDir, "boundary");
    createPrivateDirectory(boundary);
    const nested = path.join(boundary, "nested");
    fs.mkdirSync(nested);
    const file = path.join(nested, "value");
    fs.writeFileSync(file, "v");
    expect(readAcl(nested).protected).toBe(false);
    // Durable through the protected, private ancestor.
    expect(checkOwnerOnly(nested)).toMatchObject({ ok: true });
    expect(checkOwnerOnly(file)).toMatchObject({ ok: true });
    // Not a boundary by itself until it is protected.
    expect(checkOwnerOnly(nested, { requireProtected: true }).problems).toEqual([
      "does not have a protected DACL (ancestors can widen it through inheritance)",
    ]);
    ensurePrivateDirectoryBoundary(nested);
    expect(checkOwnerOnly(nested, { requireProtected: true })).toMatchObject({ ok: true });

    // An owner-only DACL that inherits from the shared temp directory is not durable.
    const exposedParent = path.join(tempDir, "exposed-parent");
    fs.mkdirSync(exposedParent);
    expect(checkOwnerOnly(exposedParent).ok).toBe(false);
    expect(checkOwnerOnly(tempDir, { requireProtected: true }).ok).toBe(false);
  });

  it("creates files and directories private from the first instant, even in a shared directory", () => {
    const shared = path.join(tempDir, "shared");
    fs.mkdirSync(shared);
    execFileSync("icacls", [shared, "/grant", `*${EVERYONE}:(OI)(CI)(F)`], { stdio: "ignore" });
    const file = path.join(shared, "secret.tmp");
    writePrivateFileExclusive(file, "token");
    expect(fs.readFileSync(file, "utf8")).toBe("token");
    const fileAcl = readAcl(file);
    expect(fileAcl).toMatchObject({ owner: sid, protected: true });
    expect(fileAcl.entries).toEqual([
      { type: "allow", sid, mask: FILE_ALL_ACCESS, inherited: false, inheritOnly: false },
    ]);
    expect(probeOpenWithUserSidDisabled(file, PROBE_ACCESS.read).win32Error).toBe(
      ERROR_ACCESS_DENIED,
    );
    expect(() => writePrivateFileExclusive(file, "again")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );

    const dir = path.join(shared, "private-dir");
    createPrivateDirectory(dir);
    expect(checkOwnerOnly(dir, { requireProtected: true })).toMatchObject({ ok: true });
    expect(probeOpenWithUserSidDisabled(dir, PROBE_ACCESS.read).win32Error).toBe(
      ERROR_ACCESS_DENIED,
    );
    expect(() => createPrivateDirectory(dir)).toThrow(expect.objectContaining({ code: "EEXIST" }));

    // An existing, exposed directory is hardened into a boundary; a file is refused.
    const existing = path.join(shared, "existing");
    fs.mkdirSync(existing);
    expect(checkOwnerOnly(existing).ok).toBe(false);
    ensurePrivateDirectoryBoundary(existing);
    expect(checkOwnerOnly(existing, { requireProtected: true })).toMatchObject({ ok: true });
    expect(() => ensurePrivateDirectoryBoundary(file)).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("reports missing paths as ENOENT", () => {
    const missing = path.join(tempDir, "missing");
    expect(() => checkOwnerOnly(missing)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => ensureOwnerOnly(missing, { directory: false })).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("locates the service host next to the addon", () => {
    const host = serviceHostExecutablePath();
    expect(path.basename(host)).toBe("resin-service-host.exe");
    expect(fs.existsSync(host)).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("secure named pipe server (native)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function serve(name: string, onConnection: (socket: SecurePipeSocket) => void) {
    const server = createSecurePipeServer(name, onConnection);
    cleanups.push(() => server.close());
    return server;
  }

  it("creates the pipe with an owner-only DACL that denies network logons", () => {
    const name = uniquePipeName();
    serve(name, (socket) => socket.destroy());
    const sid = currentUserSid();
    const acl = readPipeAcl(name);
    expect(acl.owner).toBe(sid);
    expect(acl.protected).toBe(true);
    expect(acl.entries.map((entry) => [entry.type, entry.sid])).toEqual([
      ["deny", NETWORK],
      ["allow", sid],
    ]);
  });

  it("denies clients that are not the current user", () => {
    const name = uniquePipeName();
    serve(name, (socket) => socket.destroy());
    expect(probeOpenWithUserSidDisabled(name, PROBE_ACCESS.readWrite)).toEqual({
      ok: false,
      win32Error: ERROR_ACCESS_DENIED,
    });
    expect(probeOpenWithUserSidDisabled(name, PROBE_ACCESS.read).win32Error).toBe(
      ERROR_ACCESS_DENIED,
    );
  });

  it("verifies the server and carries large payloads both ways over net clients", async () => {
    const name = uniquePipeName();
    const clientPids: number[] = [];
    serve(name, (socket) => {
      clientPids.push(socket.clientPid);
      const chunks: Buffer[] = [];
      let received = 0;
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (received === 300 * 1024) socket.end(Buffer.concat(chunks).reverse());
      });
    });

    const verification = verifyPipeServer(name);
    expect(verification).toMatchObject({ ok: true, serverPid: process.pid });

    const socket = await connect(name);
    const payload = crypto.randomBytes(300 * 1024);
    const response = readAll(socket);
    socket.write(payload);
    expect((await response).equals(Buffer.from(payload).reverse())).toBe(true);
    expect(clientPids.at(-1)).toBe(process.pid);
    socket.destroy();
  });

  it("never lets the name lapse while clients connect and vanish", async () => {
    const name = uniquePipeName();
    serve(name, (socket) => socket.on("data", (chunk: Buffer) => socket.end(chunk)));
    // Each verification connects and disconnects immediately, often before the server has
    // accepted; the server must keep a listening instance so the name is never free to claim.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(verifyPipeServer(name)).toMatchObject({ ok: true });
    }
    const socket = await connect(name);
    const reply = readAll(socket);
    socket.write("still-here");
    expect((await reply).toString()).toBe("still-here");
  });

  it("serves several concurrent clients", async () => {
    const name = uniquePipeName();
    serve(name, (socket) => {
      socket.once("data", (chunk: Buffer) => socket.end(`echo:${chunk.toString()}`));
    });
    const replies = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const socket = await connect(name);
        const reply = readAll(socket);
        socket.write(`client-${index}`);
        return (await reply).toString();
      }),
    );
    expect(replies).toEqual(Array.from({ length: 8 }, (_, index) => `echo:client-${index}`));
  });

  it("refuses a second server on the same name", () => {
    const name = uniquePipeName();
    serve(name, (socket) => socket.destroy());
    expect(() => createSecurePipeServer(name, () => {})).toThrow(
      expect.objectContaining({ code: "EADDRINUSE" }),
    );
  });

  it("reports a missing server and stops serving after close", async () => {
    const name = uniquePipeName();
    expect(verifyPipeServer(name)).toMatchObject({ ok: false, reason: "not-running" });
    const server = createSecurePipeServer(name, (socket) => socket.destroy());
    expect(verifyPipeServer(name).ok).toBe(true);
    await server.close();
    expect(verifyPipeServer(name)).toMatchObject({ ok: false, reason: "not-running" });
  });

  it("fails closed when another principal holds the name, and clients refuse it", () => {
    const name = uniquePipeName();
    const squatter = squatPipeForTesting(name, "D:P(A;;GA;;;SY)");
    cleanups.push(() => squatter.release());
    expect(verifyPipeServer(name)).toMatchObject({ ok: false, reason: "access-denied" });
    expect(() => createSecurePipeServer(name, () => {})).toThrow(
      expect.objectContaining({ code: "EADDRINUSE" }),
    );
  });

  it("verifies the server on the very connection it then talks over", async () => {
    const name = uniquePipeName();
    serve(name, (socket) => {
      const chunks: Buffer[] = [];
      let received = 0;
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (received === 300 * 1024) socket.write(Buffer.concat(chunks).reverse());
      });
    });
    const socket = await connectVerifiedPipe(name);
    cleanups.push(() => void socket.destroy());
    expect(socket.serverPid).toBe(process.pid);
    const payload = crypto.randomBytes(300 * 1024);
    const reply = readExactly(socket, payload.length);
    socket.write(payload);
    expect((await reply).equals(Buffer.from(payload).reverse())).toBe(true);
  });

  it("refuses missing and foreign servers before sending anything", async () => {
    const missing = uniquePipeName();
    await expect(connectVerifiedPipe(missing)).rejects.toMatchObject({
      code: "ENOENT",
      reason: "not-running",
    });
    const squatted = uniquePipeName();
    const squatter = squatPipeForTesting(squatted, "D:P(A;;GA;;;SY)");
    cleanups.push(() => squatter.release());
    await expect(connectVerifiedPipe(squatted)).rejects.toMatchObject({
      code: "EACCES",
      reason: "access-denied",
    });
  });

  it("survives connections opening, writing and closing while the server shuts down", async () => {
    for (let round = 0; round < 50; round += 1) {
      const name = uniquePipeName();
      const server = createSecurePipeServer(name, (socket) => {
        socket.on("error", () => {});
        socket.on("data", (chunk: Buffer) => socket.write(chunk));
      });
      const settled = await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          index % 2 === 0 ? connectVerifiedPipe(name) : connect(name),
        ),
      );
      const clients = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(clients.length).toBeGreaterThan(0);
      const echoes = clients.map((client) => {
        client.on("error", () => {});
        const echoed = Promise.withResolvers<void>();
        client.once("data", () => echoed.resolve());
        client.once("close", () => echoed.resolve());
        client.write(crypto.randomBytes(128 * 1024));
        return echoed.promise;
      });
      await Promise.race(echoes);
      // Connect attempts racing the shutdown, too.
      const late = Array.from({ length: 4 }, () => connectVerifiedPipe(name).catch(() => null));
      await server.close();
      for (const client of clients) client.destroy();
      for (const client of await Promise.all(late)) client?.destroy();
      await Promise.all(echoes);
    }
    // The helper is still healthy afterwards.
    const name = uniquePipeName();
    serve(name, (socket) => socket.on("data", (chunk: Buffer) => socket.end(chunk)));
    const socket = await connectVerifiedPipe(name);
    const reply = readExactly(socket, 2);
    socket.write("ok");
    expect((await reply).toString()).toBe("ok");
    socket.destroy();
  });

  it("rejects non-local pipe names", () => {
    expect(() => createSecurePipeServer("\\\\server\\pipe\\resin", () => {})).toThrow(
      /must start with/,
    );
    expect(verifyPipeServer("\\\\server\\pipe\\resin")).toMatchObject({
      ok: false,
      reason: "open-failed",
    });
  });
});
