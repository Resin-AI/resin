import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_PLANE_ADAPTIVE_CADENCE,
  CONTROL_PLANE_CADENCE_HEADER,
  type ControlPlaneDeviceReport,
  ControlPlaneReportRequestSchema,
  DEVICE_SYNC_CAPABILITY,
  DEVICE_SYNC_CAPABILITY_HEADER,
  DEVICE_SYNC_SAFETY_REFRESH_MS,
} from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient, ControlPlaneRuntimeModule } from "../src/control-plane.js";
import { DeviceSyncSignal, type DeviceSyncSnapshot } from "../src/device-sync-signal.js";
import type { ModuleContext } from "../src/lifecycle.js";

const temporaryDirectories: string[] = [];

async function testContext(): Promise<ModuleContext> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-device-sync-"));
  temporaryDirectories.push(home);
  const stateDir = path.join(home, "state");
  const configDir = path.join(home, "config");
  return {
    config: {
      version: "0.1.0",
      logLevel: "info",
      host: "127.0.0.1",
      port: 9400,
      cloudUrl: "https://cloud.resin.test",
      telemetryEnabled: true,
      heartbeatIntervalMs: 3000,
      lockStaleThresholdMs: 15000,
      shutdownTimeoutMs: 10000,
      maxWorkerMemoryMb: 512,
      workerExecutionTimeoutMs: 30000,
      moduleConfigs: {},
      custom: {},
    },
    paths: {
      homeDir: home,
      configDir,
      dataDir: path.join(home, "data"),
      stateDir,
      logDir: path.join(home, "logs"),
      socketPath: path.join(home, "daemon.sock"),
      lockFilePath: path.join(stateDir, "daemon.lock"),
      pidFilePath: path.join(stateDir, "daemon.pid"),
      tokenFilePath: path.join(stateDir, "ipc-token"),
      configFile: path.join(configDir, "daemon.json"),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getModule: () => undefined,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("consolidated device sync", () => {
  const modules: ControlPlaneRuntimeModule[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    await Promise.all(modules.splice(0).map((module) => module.stop()));
    vi.useRealTimers();
  });

  async function fixture(options: { signal?: boolean } = {}) {
    const context = await testContext();
    const server = {
      offer: true as boolean,
      syncStatus: 200,
      /** Replaces the sync answer's body with this raw text (status 200). */
      syncRaw: null as string | null,
      revision: 1,
      accountId: "account-1",
      toolAccess: "allowed" as "allowed" | "subscription_inactive",
      catalogToken: "c:1:g:1",
      validationToken: "v:1",
    };
    const requests: Array<{ at: number; route: string }> = [];
    const reports: ControlPlaneDeviceReport[] = [];
    const appliedTokens: string[] = [];
    const headers = (): Headers => {
      const result = new Headers({
        ETag: `"w:${server.revision}:d:0"`,
        [CONTROL_PLANE_CADENCE_HEADER]: CONTROL_PLANE_ADAPTIVE_CADENCE,
      });
      if (server.offer) result.set(DEVICE_SYNC_CAPABILITY_HEADER, DEVICE_SYNC_CAPABILITY);
      return result;
    };
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "test-token",
        accountId: server.accountId,
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl: async (input, init = {}) => {
        const url = new URL(String(input));
        requests.push({ at: Date.now(), route: `${init.method} ${url.pathname}` });
        if (init.method === "POST") {
          reports.push(ControlPlaneReportRequestSchema.parse(JSON.parse(String(init.body))).report);
          return new Response(null, { status: 200 });
        }
        if (url.pathname === "/v1/device/sync") {
          if (server.syncStatus !== 200) return new Response(null, { status: server.syncStatus });
          if (server.syncRaw !== null) return new Response(server.syncRaw, { status: 200 });
          const allowed = server.toolAccess === "allowed";
          return Response.json({
            schemaVersion: "1.0.0",
            deviceId: "device-1",
            accountId: server.accountId,
            userId: "user-1",
            toolAccess: server.toolAccess,
            checkedAt: new Date().toISOString(),
            desired: allowed
              ? {
                  revisions: { workspace: server.revision, device: 0 },
                  revisionToken: `w:${server.revision}:d:0`,
                }
              : null,
            catalogToken: allowed ? server.catalogToken : null,
            validationToken: allowed ? server.validationToken : null,
          });
        }
        const etag = new Headers(init.headers).get("if-none-match");
        if (etag === `"w:${server.revision}:d:0"`) {
          return new Response(null, { status: 304, headers: headers() });
        }
        return new Response(
          JSON.stringify({
            deviceId: "device-1",
            workspace: null,
            device: null,
            desiredState: {},
            revisions: { workspace: server.revision, device: 0 },
            revisionToken: `w:${server.revision}:d:0`,
            report: null,
            connectivity: "never_reported",
          }),
          { status: 200, headers: headers() },
        );
      },
    });
    const signal = options.signal === false ? undefined : new DeviceSyncSignal();
    const published: Array<DeviceSyncSnapshot | null> = [];
    signal?.subscribe((snapshot) => {
      published.push(snapshot);
    });
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: {
        async apply(_desired, _revisions, token) {
          appliedTokens.push(token);
          return { status: "applied", fields: {}, appliedAt: new Date().toISOString() };
        },
      },
      random: () => 0,
      ...(signal ? { deviceSync: signal } : {}),
    });
    modules.push(module);
    const routes = (): string[] => requests.map(({ route }) => route);
    const count = (route: string): number => routes().filter((entry) => entry === route).length;
    return { module, context, server, requests, routes, count, reports, appliedTokens, published };
  }

  const SYNC = "GET /v1/device/sync";
  const EFFECTIVE = "GET /v1/control-plane/effective";
  const REPORT = "POST /v1/control-plane/reports";

  it("never reads the sync route without a consumer, even when offered", async () => {
    const f = await fixture({ signal: false });
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.count(SYNC)).toBe(0);
    expect(f.count(EFFECTIVE)).toBeGreaterThan(1);
  });

  it("negotiates from the effective-state header and reads desired state only when it changes", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    expect(f.routes()).toEqual([EFFECTIVE, REPORT]);
    // Three unchanged syncs at the fast cadence, then the quiet one.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.routes().slice(2)).toEqual([SYNC, SYNC, SYNC]);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(f.count(SYNC)).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.count(SYNC)).toBe(4);
    expect(f.count(EFFECTIVE)).toBe(1);
    expect(f.published.at(-1)?.sync).toMatchObject({
      toolAccess: "allowed",
      catalogToken: "c:1:g:1",
      validationToken: "v:1",
    });

    f.server.revision = 2;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.routes().slice(-3)).toEqual([SYNC, EFFECTIVE, REPORT]);
    expect(f.appliedTokens).toEqual(["w:1:d:0", "w:2:d:0"]);
    // A change returns the loop to the fast cadence.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.routes().at(-1)).toBe(SYNC);
  });

  it("keeps the 300 s heartbeat independent of sync reads", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.reports).toHaveLength(2);
    expect(f.requests.filter(({ route }) => route === REPORT).map(({ at }) => at)).toEqual([
      Date.parse("2026-09-01T00:00:00.000Z"),
      Date.parse("2026-09-01T00:05:00.000Z"),
    ]);
  });

  it("returns to the fast cadence when any token changes", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(90_000 + 120_000);
    const before = f.count(SYNC);
    f.server.validationToken = "v:2";
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.count(SYNC)).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.count(SYNC)).toBe(before + 2);
    expect(f.count(EFFECTIVE)).toBe(1);
  });

  it("idles an account without tool access and never reads its desired state", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    f.server.toolAccess = "subscription_inactive";
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.published.at(-1)?.sync).toMatchObject({
      toolAccess: "subscription_inactive",
      desired: null,
      catalogToken: null,
      validationToken: null,
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(f.count(SYNC)).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.count(SYNC)).toBe(4);
    expect(f.count(EFFECTIVE)).toBe(1);
  });

  it("rereads desired state once the safety refresh is due", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(DEVICE_SYNC_SAFETY_REFRESH_MS - 1_000);
    expect(f.count(EFFECTIVE)).toBe(1);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(f.count(EFFECTIVE)).toBe(2);
    // The refresh was a conditional read answered 304: nothing is reapplied.
    expect(f.appliedTokens).toEqual(["w:1:d:0"]);
  });

  it("rereads and reapplies desired state after an identity change", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(30_000);
    f.server.accountId = "account-2";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.routes().slice(-3)).toEqual([SYNC, EFFECTIVE, REPORT]);
    expect(f.appliedTokens).toEqual(["w:1:d:0", "w:1:d:0"]);
  });

  it.each([404, 405, 501])(
    "falls back to effective-state polling when the route answers %s",
    async (status) => {
      const f = await fixture();
      await f.module.start(f.context);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.published).toHaveLength(1);
      f.server.syncStatus = status;
      await vi.advanceTimersByTimeAsync(30_000);
      // The refused read is followed by the legacy read in the same cycle.
      expect(f.routes().slice(-2)).toEqual([SYNC, EFFECTIVE]);
      expect(f.published.at(-1)).toBeNull();
      // The advertisement is not retried until the safety interval passes.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.count(SYNC)).toBe(2);
      f.server.syncStatus = 200;
      await vi.advanceTimersByTimeAsync(DEVICE_SYNC_SAFETY_REFRESH_MS);
      expect(f.count(SYNC)).toBeGreaterThan(2);
      expect(f.published.at(-1)).not.toBeNull();
    },
  );

  it.each([
    ["an HTML page", "<html><body>gateway error</body></html>"],
    ["a truncated body", '{"schemaVersion":"1.0.0","deviceId":"device-1"'],
    ["an oversized body", `{"pad":"${"x".repeat(600 * 1024)}"}`],
  ])("falls back instead of retrying forever when the sync read answers %s", async (_name, raw) => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(30_000);
    f.server.syncRaw = raw;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.routes().slice(-2)).toEqual([SYNC, EFFECTIVE]);
    expect(f.published.at(-1)).toBeNull();
    const syncs = f.count(SYNC);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.count(SYNC)).toBe(syncs);
    expect(f.count(EFFECTIVE)).toBeGreaterThan(2);
  });

  it("falls back when the server stops advertising the capability", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(30_000);
    f.server.offer = false;
    f.server.revision = 2;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.routes().slice(-3)).toEqual([SYNC, EFFECTIVE, REPORT]);
    expect(f.published.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.routes().at(-1)).toBe(EFFECTIVE);
  });

  it("keeps legacy polling when the capability is never advertised", async () => {
    const f = await fixture();
    f.server.offer = false;
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.count(SYNC)).toBe(0);
    expect(f.published).toEqual([]);
  });

  it("withdraws its answer when stopped", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.published.at(-1)).not.toBeNull();
    await f.module.stop();
    expect(f.published.at(-1)).toBeNull();
  });
});

describe("device sync wire", () => {
  function client(response: () => Response) {
    return new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "test-token",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl: async () => response(),
    });
  }
  const body = {
    schemaVersion: "1.0.0",
    deviceId: "device-1",
    accountId: "account-1",
    userId: "user-1",
    toolAccess: "allowed",
    checkedAt: "2026-09-01T00:00:00.000Z",
    desired: null,
    catalogToken: "c:1",
    validationToken: "v:1",
  };

  it("parses a valid answer", async () => {
    expect(await client(() => Response.json(body)).getDeviceSync("device-1")).toMatchObject({
      kind: "sync",
      sync: { catalogToken: "c:1" },
    });
  });

  it.each([
    ["another device's answer", { ...body, deviceId: "device-2" }],
    ["an unknown field", { ...body, extra: true }],
  ])("treats %s as unsupported", async (_name, answer) => {
    expect(await client(() => Response.json(answer)).getDeviceSync("device-1")).toEqual({
      kind: "unsupported",
      status: 502,
    });
  });

  it("throws on a transient failure instead of falling back", async () => {
    await expect(
      client(() => new Response(null, { status: 503 })).getDeviceSync("device-1"),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("recognizes the advertisement on a 304", async () => {
    const result = await client(
      () =>
        new Response(null, {
          status: 304,
          headers: { "resin-device-sync": DEVICE_SYNC_CAPABILITY },
        }),
    ).getEffectiveState("device-1", '"w:1:d:0"');
    expect(result).toMatchObject({ deviceSync: true, notModified: true });
  });
});
