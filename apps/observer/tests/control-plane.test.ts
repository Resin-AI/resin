import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_PLANE_ADAPTIVE_CADENCE,
  CONTROL_PLANE_CADENCE_HEADER,
  type ControlPlaneDeviceReport,
  ControlPlaneReportRequestSchema,
} from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_DEVICE_STATE_FILE_NAME,
  type ControlPlaneApplyAdapter,
  ControlPlaneClient,
  ControlPlaneRuntimeModule,
  type ControlPlaneRuntimeModuleOptions,
  FileControlPlaneApplyAdapter,
} from "../src/control-plane.js";
import type { ModuleContext } from "../src/lifecycle.js";

const temporaryDirectories: string[] = [];

async function testContext(): Promise<ModuleContext> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-control-plane-"));
  temporaryDirectories.push(home);
  const configDir = path.join(home, "config");
  const stateDir = path.join(home, "state");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
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
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
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

describe("observer desired-state reconciliation", () => {
  it("applies safe configuration and honestly reports device-runtime pending fields", async () => {
    const context = await testContext();
    await fs.writeFile(
      context.paths.configFile,
      JSON.stringify({ telemetryEnabled: true, logLevel: "info", userSetting: "preserved" }),
      { mode: 0o600 },
    );
    let reloads = 0;
    const adapter = new FileControlPlaneApplyAdapter({
      reloadConfig: async () => {
        reloads += 1;
      },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    const result = await adapter.apply(
      {
        privacy: { metadataTelemetryEnabled: false, retentionDays: 30 },
        configuration: { logLevel: "warn", heartbeatIntervalMs: 5000 },
        harnesses: { omp: { enabled: true, autoRepair: true } },
        updates: { channel: "beta" },
      },
      { workspace: 2, device: 1 },
      "w:2:d:1",
      context,
    );

    expect(JSON.parse(await fs.readFile(context.paths.configFile, "utf8"))).toEqual({
      telemetryEnabled: true,
      logLevel: "warn",
      userSetting: "preserved",
      heartbeatIntervalMs: 5000,
    });
    expect(reloads).toBe(1);
    expect(result.status).toBe("degraded");
    expect(result.fields["configuration.logLevel"]?.status).toBe("applied");
    expect(result.fields["harnesses.omp"]?.status).toBe("pending");
    expect(result.fields["privacy.metadataTelemetryEnabled"]).toMatchObject({
      status: "unsupported",
      code: "PRIVACY_AUTHORITY_REQUIRED",
    });
    expect(result.fields["privacy.retentionDays"]).toMatchObject({
      status: "unsupported",
      code: "PRIVACY_AUTHORITY_REQUIRED",
    });
    const staged = JSON.parse(
      await fs.readFile(
        path.join(context.paths.stateDir, CONTROL_PLANE_DEVICE_STATE_FILE_NAME),
        "utf8",
      ),
    );
    expect(staged.revisionToken).toBe("w:2:d:1");
  });

  it("rolls back configuration and reports an explicit error when reload rejects the update", async () => {
    const context = await testContext();
    const original = { telemetryEnabled: true, logLevel: "info", userSetting: "preserved" };
    await fs.writeFile(context.paths.configFile, JSON.stringify(original), { mode: 0o600 });
    const adapter = new FileControlPlaneApplyAdapter({
      reloadConfig: async () => ({ success: false, error: "invalid runtime configuration" }),
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });

    const result = await adapter.apply(
      { configuration: { telemetryEnabled: false, logLevel: "warn" } },
      { workspace: 3, device: 0 },
      "w:3:d:0",
      context,
    );

    expect(JSON.parse(await fs.readFile(context.paths.configFile, "utf8"))).toEqual(original);
    expect(result).toMatchObject({
      status: "error",
      appliedAt: null,
      fields: {
        "configuration.telemetryEnabled": {
          status: "error",
          code: "CONFIG_RELOAD_FAILED",
        },
        "configuration.logLevel": {
          status: "error",
          code: "CONFIG_RELOAD_FAILED",
        },
      },
    });
  });

  it("polls immediately and reports the applied revision through the authenticated client", async () => {
    const context = await testContext();
    const reports: ControlPlaneDeviceReport[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        reports.push(ControlPlaneReportRequestSchema.parse(JSON.parse(String(init.body))).report);
        return new Response(JSON.stringify({ report: reports.at(-1) }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          deviceId: "device-1",
          workspace: null,
          device: null,
          desiredState: { configuration: { logLevel: "warn" } },
          revisions: { workspace: 3, device: 4 },
          revisionToken: "w:3:d:4",
          report: null,
          connectivity: "never_reported",
        }),
        { status: 200, headers: { ETag: '"w:3:d:4"' } },
      );
    };
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "not-recorded",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl,
    });
    const adapter: ControlPlaneApplyAdapter = {
      async apply() {
        return {
          status: "applied",
          fields: { "configuration.logLevel": { status: "applied" } },
          appliedAt: "2026-08-28T12:00:00.000Z",
        };
      },
    };
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: adapter,
      pollIntervalMs: 60_000,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    await module.start(context);
    await module.stop();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      deviceId: "device-1",
      revisionToken: "w:3:d:4",
      status: "applied",
    });
  });

  it("rejects stale revision vectors while continuing heartbeats", async () => {
    const context = await testContext();
    const replies = [
      {
        revisions: { workspace: 5, device: 5 },
        revisionToken: "w:5:d:5",
        logLevel: "warn",
      },
      {
        revisions: { workspace: 4, device: 4 },
        revisionToken: "w:4:d:4",
        logLevel: "error",
      },
      {
        revisions: { workspace: 6, device: 4 },
        revisionToken: "w:6:d:4",
        logLevel: "debug",
      },
      {
        revisions: { workspace: 6, device: 6 },
        revisionToken: "w:6:d:6",
        logLevel: "info",
      },
    ];
    const conditionalEtags: Array<string | null> = [];
    const reports: ControlPlaneDeviceReport[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        reports.push(ControlPlaneReportRequestSchema.parse(JSON.parse(String(init.body))).report);
        return new Response(null, { status: 200 });
      }
      conditionalEtags.push(new Headers(init?.headers).get("if-none-match"));
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected desired-state request");
      return new Response(
        JSON.stringify({
          deviceId: "device-1",
          workspace: null,
          device: null,
          desiredState: { configuration: { logLevel: reply.logLevel } },
          revisions: reply.revisions,
          revisionToken: reply.revisionToken,
          report: null,
          connectivity: "never_reported",
        }),
        { status: 200, headers: { ETag: `"${reply.revisionToken}"` } },
      );
    };
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "not-recorded",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl,
    });
    const appliedTokens: string[] = [];
    const adapter: ControlPlaneApplyAdapter = {
      async apply(_desiredState, _revisions, revisionToken) {
        appliedTokens.push(revisionToken);
        return {
          status: "applied",
          fields: { "configuration.logLevel": { status: "applied" } },
          appliedAt: "2026-08-28T12:00:00.000Z",
        };
      },
    };
    let currentTime = Date.parse("2026-08-28T12:00:00.000Z");
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: adapter,
      pollIntervalMs: 60_000,
      reportIntervalMs: 60_000,
      now: () => new Date(currentTime),
    });

    await module.start(context);
    currentTime += 60_000;
    await module.reconcileNow();
    currentTime += 60_000;
    await module.reconcileNow();
    currentTime += 60_000;
    await module.reconcileNow();
    await module.stop();

    expect(appliedTokens).toEqual(["w:5:d:5", "w:6:d:6"]);
    expect(conditionalEtags).toEqual([null, '"w:5:d:5"', '"w:5:d:5"', '"w:5:d:5"']);
    expect(reports.map((report) => report.revisionToken)).toEqual([
      "w:5:d:5",
      "w:5:d:5",
      "w:5:d:5",
      "w:6:d:6",
    ]);
    expect(reports.slice(0, 3).map((report) => report.revisions)).toEqual([
      { workspace: 5, device: 5 },
      { workspace: 5, device: 5 },
      { workspace: 5, device: 5 },
    ]);
    expect(new Set(reports.map((report) => report.observedAt)).size).toBe(4);
  });

  it("keeps the applied revision guard when reporting fails", async () => {
    const context = await testContext();
    const replies = [
      { revisions: { workspace: 4, device: 2 }, revisionToken: "w:4:d:2", logLevel: "warn" },
      { revisions: { workspace: 3, device: 2 }, revisionToken: "w:3:d:2", logLevel: "error" },
      { revisions: { workspace: 4, device: 2 }, revisionToken: "w:4:d:2", logLevel: "warn" },
    ];
    const conditionalEtags: Array<string | null> = [];
    const reportTokens: string[] = [];
    let reportAttempts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        reportAttempts += 1;
        reportTokens.push(
          ControlPlaneReportRequestSchema.parse(JSON.parse(String(init.body))).report.revisionToken,
        );
        return new Response(null, { status: reportAttempts === 1 ? 503 : 200 });
      }
      conditionalEtags.push(new Headers(init?.headers).get("if-none-match"));
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected desired-state request");
      return new Response(
        JSON.stringify({
          deviceId: "device-1",
          workspace: null,
          device: null,
          desiredState: { configuration: { logLevel: reply.logLevel } },
          revisions: reply.revisions,
          revisionToken: reply.revisionToken,
          report: null,
          connectivity: "never_reported",
        }),
        { status: 200, headers: { ETag: `"${reply.revisionToken}"` } },
      );
    };
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "not-recorded",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl,
    });
    const appliedTokens: string[] = [];
    const adapter: ControlPlaneApplyAdapter = {
      async apply(_desiredState, _revisions, revisionToken) {
        appliedTokens.push(revisionToken);
        return {
          status: "applied",
          fields: { "configuration.logLevel": { status: "applied" } },
          appliedAt: "2026-08-28T12:00:00.000Z",
        };
      },
    };
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: adapter,
      pollIntervalMs: 60_000,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });

    await module.start(context);
    expect(module.getState()).toBe("degraded");
    await module.reconcileNow();
    await module.reconcileNow();
    expect(module.getState()).toBe("ready");
    await module.stop();

    expect(appliedTokens).toEqual(["w:4:d:2", "w:4:d:2"]);
    expect(reportTokens).toEqual(["w:4:d:2", "w:4:d:2"]);
    expect(conditionalEtags).toEqual([null, null, null]);
  });

  it("retries the same revision after an apply result reports an error", async () => {
    const context = await testContext();
    const conditionalEtags: Array<string | null> = [];
    const reportStatuses: ControlPlaneDeviceReport["status"][] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        reportStatuses.push(
          ControlPlaneReportRequestSchema.parse(JSON.parse(String(init.body))).report.status,
        );
        return new Response(null, { status: 200 });
      }
      conditionalEtags.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(
        JSON.stringify({
          deviceId: "device-1",
          workspace: null,
          device: null,
          desiredState: { configuration: { logLevel: "warn" } },
          revisions: { workspace: 7, device: 1 },
          revisionToken: "w:7:d:1",
          report: null,
          connectivity: "never_reported",
        }),
        { status: 200, headers: { ETag: '"w:7:d:1"' } },
      );
    };
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "not-recorded",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl,
    });
    let applyAttempts = 0;
    const adapter: ControlPlaneApplyAdapter = {
      async apply() {
        applyAttempts += 1;
        if (applyAttempts === 1) {
          return {
            status: "error",
            fields: { "configuration.logLevel": { status: "error" } },
            appliedAt: null,
          };
        }
        return {
          status: "applied",
          fields: { "configuration.logLevel": { status: "applied" } },
          appliedAt: "2026-08-28T12:00:00.000Z",
        };
      },
    };
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: adapter,
      pollIntervalMs: 60_000,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });

    await module.start(context);
    expect(module.getState()).toBe("degraded");
    expect(await module.getDiagnostics()).toMatchObject({ revisionToken: null });
    await module.reconcileNow();
    expect(module.getState()).toBe("ready");
    await module.stop();

    expect(applyAttempts).toBe(2);
    expect(reportStatuses).toEqual(["error", "applied"]);
    expect(conditionalEtags).toEqual([null, null]);
  });

  it("degrades without blocking local startup when Cloud is offline", async () => {
    const context = await testContext();
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "not-recorded",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl: async () => {
        throw new TypeError("network offline");
      },
    });
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: new FileControlPlaneApplyAdapter(),
      pollIntervalMs: 60_000,
    });
    await module.start(context);
    expect(module.getState()).toBe("degraded");
    expect((await module.healthCheck()).status).toBe("degraded");
    await module.stop();
  });
});

describe("adaptive control-plane deadlines", () => {
  const modules: ControlPlaneRuntimeModule[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    await Promise.all(modules.splice(0).map((module) => module.stop()));
    vi.useRealTimers();
  });

  async function fixture(
    options: Partial<
      Pick<ControlPlaneRuntimeModuleOptions, "pollIntervalMs" | "reportIntervalMs" | "random">
    > = {},
  ) {
    const context = await testContext();
    const server = {
      capability: CONTROL_PLANE_ADAPTIVE_CADENCE as string | null,
      revision: 1,
      force200: false,
      getOverride: null as ((init: RequestInit) => Promise<Response>) | null,
      reportOverride: null as
        | ((report: ControlPlaneDeviceReport, init: RequestInit) => Promise<Response>)
        | null,
      applyOverride: null as ControlPlaneApplyAdapter["apply"] | null,
    };
    const polls: Array<{ at: number; etag: string | null }> = [];
    const reports: Array<{ at: number; report: ControlPlaneDeviceReport }> = [];
    const appliedTokens: string[] = [];
    const response = () => {
      const headers = new Headers({ ETag: `"w:${server.revision}:d:0"` });
      if (server.capability !== null) headers.set(CONTROL_PLANE_CADENCE_HEADER, server.capability);
      if (!server.force200 && polls.at(-1)?.etag === headers.get("etag")) {
        return new Response(null, { status: 304, headers });
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
        { status: 200, headers },
      );
    };
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "test-token",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl: async (_input, init = {}) => {
        if (init.method === "POST") {
          const report = ControlPlaneReportRequestSchema.parse(
            JSON.parse(String(init.body)),
          ).report;
          reports.push({ at: Date.now(), report });
          return server.reportOverride
            ? server.reportOverride(report, init)
            : new Response(null, { status: 200 });
        }
        polls.push({ at: Date.now(), etag: new Headers(init.headers).get("if-none-match") });
        return server.getOverride ? server.getOverride(init) : response();
      },
    });
    const module = new ControlPlaneRuntimeModule({
      client,
      deviceId: "device-1",
      applyAdapter: {
        async apply(desired, revisions, token, applyContext) {
          appliedTokens.push(token);
          if (server.applyOverride)
            return server.applyOverride(desired, revisions, token, applyContext);
          return { status: "applied", fields: {}, appliedAt: new Date().toISOString() };
        },
      },
      random: () => 0,
      ...options,
    });
    modules.push(module);
    return { module, context, server, polls, reports, appliedTokens, response };
  }

  it.each([false, true])(
    "quiets only after three successful unchanged polls (200=%s)",
    async (force200) => {
      const f = await fixture();
      f.server.force200 = force200;
      await f.module.start(f.context);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.polls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.polls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(f.polls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.polls).toHaveLength(5);
      expect(f.appliedTokens).toEqual(["w:1:d:0"]);
      expect(f.reports.map(({ report }) => report.revisionToken)).toEqual(["w:1:d:0"]);
      expect(f.polls.slice(1).every(({ etag }) => etag === '"w:1:d:0"')).toBe(true);
    },
  );

  it.each([null, "adaptive-v2"])(
    "uses legacy deadlines without a recognized capability (%s)",
    async (capability) => {
      const f = await fixture();
      f.server.capability = capability;
      await f.module.start(f.context);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.polls.map(({ at }) => at - f.polls[0].at)).toEqual([
        0, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000,
      ]);
      expect(f.reports.map(({ at }) => at - f.reports[0].at)).toEqual([
        0, 60_000, 120_000, 180_000,
      ]);
    },
  );

  it.each([null, "unknown"])(
    "falls back immediately on a 304 losing capability (%s)",
    async (capability) => {
      const f = await fixture();
      await f.module.start(f.context);
      await vi.advanceTimersByTimeAsync(90_000);
      f.server.capability = capability;
      await vi.advanceTimersByTimeAsync(120_000);
      // The old 60-second heartbeat deadline is already due at the fallback read.
      expect(f.reports.map(({ at }) => at - f.reports[0].at)).toEqual([0, 210_000]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.polls.map(({ at }) => at - f.polls[0].at)).toEqual([
        0, 30_000, 60_000, 90_000, 210_000, 240_000, 270_000,
      ]);
      expect(f.reports.at(-1)?.at).toBe(f.reports[0].at + 270_000);
    },
  );

  it("negotiates adaptive cadence on a 304 from a legacy server", async () => {
    const f = await fixture();
    f.server.capability = null;
    await f.module.start(f.context);
    f.server.capability = CONTROL_PLANE_ADAPTIVE_CADENCE;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(f.polls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.polls).toHaveLength(5);
  });

  it("posts an independently due heartbeat without reading or acknowledging unseen desired state", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(210_000);
    f.server.revision = 2;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.polls).toHaveLength(5);
    expect(f.appliedTokens).toEqual(["w:1:d:0"]);
    expect(f.reports.map(({ at, report }) => [at - f.reports[0].at, report.revisionToken])).toEqual(
      [
        [0, "w:1:d:0"],
        [300_000, "w:1:d:0"],
      ],
    );
    expect(f.reports[1].report.appliedAt).toBe(f.reports[0].report.appliedAt);
    expect(f.reports[1].report.observedAt).not.toBe(f.reports[0].report.observedAt);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.appliedTokens).toEqual(["w:1:d:0", "w:2:d:0"]);
    expect(f.reports.at(-1)?.report.revisionToken).toBe("w:2:d:0");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.polls.at(-1)?.at).toBe(f.polls[0].at + 360_000);
  });

  it("resets quiet cadence on a manual wake and coalesces bursts while a read is inflight", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(90_000);
    const gate = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    f.server.getOverride = async () => {
      entered.resolve();
      return gate.promise;
    };
    const wake = f.module.reconcileNow();
    await entered.promise;
    const burst = Array.from({ length: 100 }, () => f.module.reconcileNow());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.polls).toHaveLength(5);
    f.server.getOverride = null;
    gate.resolve(f.response());
    await Promise.all([wake, ...burst]);
    expect(f.polls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.polls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.polls).toHaveLength(7);
  });

  it("does not accumulate timer work while a heartbeat POST is inflight", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    const gate = Promise.withResolvers<Response>();
    f.server.reportOverride = async () => gate.promise;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.polls).toHaveLength(5);
    expect(f.reports).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.polls).toHaveLength(5);
    const wake = f.module.reconcileNow();
    f.server.reportOverride = null;
    gate.resolve(new Response(null, { status: 200 }));
    await wake;
    expect(f.polls).toHaveLength(6);
    expect(f.reports).toHaveLength(2);
  });

  it("bounds jitter positively for fast polls, quiet polls and heartbeats", async () => {
    const f = await fixture({ random: () => 1 });
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(31_499);
    expect(f.polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.polls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(189_000);
    expect(f.polls.map(({ at }) => at - f.polls[0].at)).toEqual([
      0, 31_500, 63_000, 94_500, 220_500,
    ]);
    await vi.advanceTimersByTimeAsync(94_499);
    expect(f.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reports[1].at - f.reports[0].at).toBe(315_000);
    expect(f.polls).toHaveLength(5);
  });

  it("preserves explicit cadence overrides without jitter or quiet-mode scaling", async () => {
    const f = await fixture({ pollIntervalMs: 100, reportIntervalMs: 250, random: () => 1 });
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.polls.map(({ at }) => at - f.polls[0].at)).toEqual([0, 100, 200, 300, 400, 500]);
    expect(f.reports.map(({ at }) => at - f.reports[0].at)).toEqual([0, 250, 500]);
  });

  it("resets fast on read errors while due heartbeats continue independently", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(90_000);
    f.server.getOverride = async () => {
      throw new Error("offline read");
    };
    await vi.advanceTimersByTimeAsync(210_000);
    expect(f.polls.map(({ at }) => at - f.polls[0].at)).toEqual([
      0, 30_000, 60_000, 90_000, 210_000, 240_000, 270_000, 300_000,
    ]);
    expect(f.reports.map(({ at }) => at - f.reports[0].at)).toEqual([0, 300_000]);
    expect(f.module.getState()).toBe("degraded");
    f.server.getOverride = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.module.getState()).toBe("ready");
  });

  it.each(["read", "apply"])(
    "keeps an unresolved %s failure degraded across an unaligned heartbeat",
    async (operation) => {
      const f = await fixture({ pollIntervalMs: 100, reportIntervalMs: 250 });
      await f.module.start(f.context);
      if (operation === "read") {
        f.server.getOverride = async () => {
          throw new Error("desired state unavailable");
        };
      } else {
        f.server.revision = 2;
        f.server.applyOverride = async () => {
          throw new Error("configuration apply failed");
        };
      }
      await vi.advanceTimersByTimeAsync(200);
      const failed = await f.module.getDiagnostics();
      expect(failed.state).toBe("degraded");
      await vi.advanceTimersByTimeAsync(50);
      expect(f.polls).toHaveLength(3);
      expect(f.reports.map(({ at }) => at - f.reports[0].at)).toEqual([0, 250]);
      expect(await f.module.getDiagnostics()).toMatchObject({
        state: "degraded",
        lastError: failed.lastError,
        lastSuccessAt: failed.lastSuccessAt,
      });
      expect((await f.module.healthCheck()).status).toBe("degraded");
      f.server.getOverride = null;
      f.server.applyOverride = null;
      await vi.advanceTimersByTimeAsync(50);
      expect(await f.module.getDiagnostics()).toMatchObject({ state: "ready", lastError: null });
    },
  );

  it("requires report recovery rather than a successful intervening poll to clear report degradation", async () => {
    const f = await fixture({ pollIntervalMs: 100, reportIntervalMs: 250 });
    await f.module.start(f.context);
    f.server.reportOverride = async () => new Response(null, { status: 503 });
    await vi.advanceTimersByTimeAsync(250);
    const failed = await f.module.getDiagnostics();
    expect(failed.state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(50);
    expect(f.polls).toHaveLength(4);
    expect(f.reports).toHaveLength(2);
    expect(await f.module.getDiagnostics()).toMatchObject({
      state: "degraded",
      lastError: failed.lastError,
      lastSuccessAt: failed.lastSuccessAt,
    });
    f.server.reportOverride = null;
    await vi.advanceTimersByTimeAsync(50);
    expect(f.polls).toHaveLength(4);
    expect(f.reports).toHaveLength(3);
    expect(await f.module.getDiagnostics()).toMatchObject({ state: "ready", lastError: null });
  });

  it("does not postpone a due poll when a slow heartbeat fails", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    const gate = Promise.withResolvers<Response>();
    f.server.reportOverride = async () => gate.promise;
    await vi.advanceTimersByTimeAsync(340_000);
    expect(f.polls).toHaveLength(5);
    gate.resolve(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.polls).toHaveLength(6);
    expect(f.polls.at(-1)?.at).toBeLessThanOrEqual(f.polls[0].at + 340_001);
    f.server.reportOverride = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reports.at(-1)?.report.revisionToken).toBe("w:1:d:0");
    expect(f.module.getState()).toBe("ready");
  });

  it("retries failed apply results before acknowledging an ETag", async () => {
    const f = await fixture();
    f.server.applyOverride = async () => ({ status: "error", fields: {}, appliedAt: null });
    await f.module.start(f.context);
    expect(await f.module.getDiagnostics()).toMatchObject({ revisionToken: null });
    f.server.applyOverride = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.polls.map(({ etag }) => etag)).toEqual([null, null]);
    expect(f.reports.map(({ report }) => report.status)).toEqual(["error", "applied"]);
    expect(await f.module.getDiagnostics()).toMatchObject({ revisionToken: "w:1:d:0" });
  });

  it("retries thrown apply errors without reporting success", async () => {
    const f = await fixture();
    f.server.applyOverride = async () => {
      throw new Error("apply failed");
    };
    await f.module.start(f.context);
    expect(f.reports).toHaveLength(0);
    f.server.applyOverride = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.polls.map(({ etag }) => etag)).toEqual([null, null]);
    expect(f.reports.map(({ report }) => report.status)).toEqual(["applied"]);
  });

  it("never sends an older cached report after a newer apply succeeds but its report fails", async () => {
    const f = await fixture({ reportIntervalMs: 60_000 });
    await f.module.start(f.context);
    f.server.revision = 2;
    f.server.reportOverride = async () => new Response(null, { status: 503 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await f.module.getDiagnostics()).toMatchObject({ revisionToken: "w:1:d:0" });
    f.server.revision = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reports.map(({ report }) => report.revisionToken)).toEqual(["w:1:d:0", "w:2:d:0"]);
    f.server.revision = 2;
    f.server.reportOverride = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reports.at(-1)?.report.revisionToken).toBe("w:2:d:0");
    expect(await f.module.getDiagnostics()).toMatchObject({ revisionToken: "w:2:d:0" });
  });

  it("retries an initial report failure without spinning on an unusable heartbeat deadline", async () => {
    const f = await fixture();
    f.server.reportOverride = async () => new Response(null, { status: 503 });
    await f.module.start(f.context);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.polls).toHaveLength(4);
    expect(f.reports).toHaveLength(4);
    expect(f.polls.every(({ etag }) => etag === null)).toBe(true);
    f.server.reportOverride = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await f.module.getDiagnostics()).toMatchObject({ revisionToken: "w:1:d:0" });
  });

  it.each(["stop", "abort"])(
    "does not rearm or apply after %s during startup GET",
    async (action) => {
      const f = await fixture();
      const controller = new AbortController();
      f.context.signal = controller.signal;
      const gate = Promise.withResolvers<Response>();
      const entered = Promise.withResolvers<AbortSignal | null | undefined>();
      f.server.getOverride = async (init) => {
        entered.resolve(init.signal);
        return gate.promise;
      };
      const starting = f.module.start(f.context);
      const signal = await entered.promise;
      const pendingWake = f.module.reconcileNow();
      const stopping = action === "stop" ? f.module.stop() : undefined;
      if (action === "abort") controller.abort();
      expect(signal?.aborted).toBe(true);
      gate.resolve(f.response());
      await Promise.all([starting, pendingWake, stopping]);
      await vi.advanceTimersByTimeAsync(1_000_000);
      await f.module.reconcileNow();
      expect(f.polls).toHaveLength(1);
      expect(f.appliedTokens).toHaveLength(0);
      expect(f.reports).toHaveLength(0);
      if (action === "stop") expect(f.module.getState()).toBe("stopped");
    },
  );

  it("does not report or rearm when stopped during apply", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.server.applyOverride = async () => {
      entered.resolve();
      await gate.promise;
      return { status: "applied", fields: {}, appliedAt: new Date().toISOString() };
    };
    const starting = f.module.start(f.context);
    await entered.promise;
    const stopping = f.module.stop();
    gate.resolve();
    await Promise.all([starting, stopping]);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(f.reports).toHaveLength(0);
    expect(f.polls).toHaveLength(1);
    expect(f.module.getState()).toBe("stopped");
  });

  it("does not acknowledge an inflight report or rearm after stop", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    f.server.reportOverride = async () => {
      entered.resolve();
      return gate.promise;
    };
    const starting = f.module.start(f.context);
    await entered.promise;
    const stopping = f.module.stop();
    gate.resolve(new Response(null, { status: 200 }));
    await Promise.all([starting, stopping]);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(await f.module.getDiagnostics()).toMatchObject({
      state: "stopped",
      revisionToken: null,
    });
    expect(f.polls).toHaveLength(1);
    expect(f.reports).toHaveLength(1);
  });

  it("clears an idle scheduled wake on abort", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.context.signal = controller.signal;
    await f.module.start(f.context);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(f.polls).toHaveLength(1);
    expect(f.reports).toHaveLength(1);
  });

  it("restarts with an unconditional apply/report against the new context", async () => {
    const f = await fixture();
    await f.module.start(f.context);
    await f.module.stop();
    await f.module.start({ ...f.context, config: { ...f.context.config, logLevel: "debug" } });
    expect(f.polls.map(({ etag }) => etag)).toEqual([null, null]);
    expect(f.appliedTokens).toEqual(["w:1:d:0", "w:1:d:0"]);
    expect(f.reports.map(({ report }) => report.revisionToken)).toEqual(["w:1:d:0", "w:1:d:0"]);
  });
});

describe("control-plane capability wire compatibility", () => {
  it("recognizes the documented case-insensitive HTTP header on a 304", async () => {
    const client = new ControlPlaneClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.test",
        accessToken: "test-token",
        accountId: "account-1",
        workspaceId: "workspace-1",
        deviceId: "device-1",
        installationId: "installation-1",
        userId: "user-1",
      }),
      fetchImpl: async () =>
        new Response(null, {
          status: 304,
          headers: { "resin-control-plane-cadence": "adaptive-v1" },
        }),
    });
    expect(await client.getEffectiveState("device-1", '"w:1:d:0"')).toMatchObject({
      adaptiveCadence: true,
      notModified: true,
      etag: '"w:1:d:0"',
    });
  });
});
