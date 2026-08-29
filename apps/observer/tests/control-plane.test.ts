import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ControlPlaneDeviceReport, ControlPlaneReportRequestSchema } from "@resin/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_DEVICE_STATE_FILE_NAME,
  type ControlPlaneApplyAdapter,
  ControlPlaneClient,
  ControlPlaneRuntimeModule,
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
    ) as { revisionToken: string };
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

  it("retries an uncommitted ETag after transient apply and report failures", async () => {
    const context = await testContext();
    const conditionalEtags: Array<string | null> = [];
    let reportAttempts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        reportAttempts += 1;
        return new Response(null, { status: reportAttempts === 1 ? 503 : 200 });
      }
      conditionalEtags.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(
        JSON.stringify({
          deviceId: "device-1",
          workspace: null,
          device: null,
          desiredState: { configuration: { logLevel: "warn" } },
          revisions: { workspace: 4, device: 2 },
          revisionToken: "w:4:d:2",
          report: null,
          connectivity: "never_reported",
        }),
        { status: 200, headers: { ETag: '"w:4:d:2"' } },
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
        if (applyAttempts === 1) throw new Error("transient apply failure");
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
    expect(module.getState()).toBe("degraded");
    await module.reconcileNow();
    expect(module.getState()).toBe("ready");
    await module.stop();

    expect(applyAttempts).toBe(3);
    expect(reportAttempts).toBe(2);
    expect(conditionalEtags).toEqual([null, null, null]);
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
