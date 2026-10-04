/**
 * The background daemon's answer side of a recorded workflow's validation: asks are answered with
 * no agent session running, and never by two processes on the same device.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  WORKFLOW_VALIDATION_SCHEMA_VERSION,
  type WorkflowValidationRequest,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  CloudCredentialStore,
  type DaemonModuleProviderContext,
  DeviceSyncSignal,
  type DeviceSyncSnapshot,
  InMemoryPrivateValueStore,
  type ModuleContext,
  resolvePaths,
} from "@resin/observer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceSyncRelayDaemonModule } from "../../src/proxy/device-sync-daemon-module.js";
import { DeviceSyncStore } from "../../src/proxy/device-sync-store.js";
import { SharedDeviceSync } from "../../src/proxy/shared-sync.js";
import { createWorkflowValidationDaemonModule } from "../../src/proxy/validation-daemon-module.js";
import {
  FileWorkflowValidationPassLease,
  WORKFLOW_VALIDATION_LEASE_FILE_NAME,
} from "../../src/proxy/validation-lease.js";
import {
  WorkflowValidationClient,
  WorkflowValidationWorker,
} from "../../src/proxy/validation-worker.js";
import { localCallsFor, recordSession } from "./recorded-sessions.js";

const CLOUD_URL = "https://cloud.daemon.test";
const WORKSPACE_ID = "ws_daemon_a1";
const OTHER_WORKSPACE_ID = "ws_daemon_b2";
const DEVICE_ID = "dev_daemon_01";
const SESSION_ID = "daemon-validation-session";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}

function recording(): { plan: RecordedWorkflow; store: InMemoryPrivateValueStore } {
  const store = new InMemoryPrivateValueStore();
  const plan = recordSession(
    store,
    { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, workflowId: "wf_daemon_validation" },
    ["recorded-seed", "held-out-seed"].flatMap((seed, round) => [
      { user: `Produce and hand on a token for ${seed}` },
      {
        callId: `produce-${round}`,
        toolName: "produce",
        connection: "vendor",
        parameters: { seed },
        result: JSON.stringify({ token: `tok(${seed})` }),
      },
      {
        callId: `consume-${round}`,
        toolName: "consume",
        connection: "vendor",
        parameters: { text: `tok(${seed})` },
        result: JSON.stringify({ echoed: `tok(${seed})` }),
      },
    ]),
  );
  return { plan, store };
}

function askFor(
  plan: RecordedWorkflow,
  overrides: Partial<WorkflowValidationRequest> = {},
): WorkflowValidationRequest {
  return {
    schemaVersion: WORKFLOW_VALIDATION_SCHEMA_VERSION,
    requestId: "req-daemon-01",
    workspaceId: WORKSPACE_ID,
    deviceId: DEVICE_ID,
    attempt: "attempt-01",
    planDigest: workflowValidationPlanDigest(plan),
    evidenceDigest: "evidence-digest-01",
    createdAt: "2026-09-27T12:00:00.000Z",
    plan,
    ...overrides,
  };
}

/**
 * The cloud's two validation routes for one ask: it is listed until a decision is recorded, and a
 * second decision for it is a conflict, as in the cloud's repository.
 */
function fakeCloud(ask: WorkflowValidationRequest, listGate?: Promise<void>) {
  const decisions: unknown[] = [];
  let gate = listGate;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (!url.startsWith(CLOUD_URL)) throw new Error(`unexpected origin ${url}`);
    if (init?.method === "POST") {
      decisions.push(JSON.parse(String(init.body)));
      const status = decisions.length === 1 ? "recorded" : "conflict";
      return new Response(JSON.stringify({ status }), {
        status: status === "recorded" ? 200 : 409,
      });
    }
    const held = gate;
    gate = undefined;
    if (held) await held;
    return new Response(JSON.stringify({ requests: decisions.length === 0 ? [ask] : [] }), {
      status: 200,
    });
  });
  return { decisions, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("the daemon's validation module", () => {
  let tempDir: string;
  let context: DaemonModuleProviderContext;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-daemon-validation-"));
    const paths = resolvePaths({ resinHome: tempDir });
    const credentialStore = new CloudCredentialStore({
      tokenFilePath: path.join(paths.stateDir, "device-token.json"),
    });
    await credentialStore.persist({
      cloudUrl: CLOUD_URL,
      accessToken: makeJwt({
        schemaVersion: 1,
        accountId: "acct_daemon_01",
        workspaceId: WORKSPACE_ID,
        deviceId: DEVICE_ID,
        installationId: "install_daemon_01",
        userId: "user_daemon_01",
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["device:connect"],
      }),
      refreshToken: "refresh-token-1",
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
    });
    const loaded = await credentialStore.load();
    if (!loaded.credentials) throw new Error("the fixture credentials did not load");
    const noop = () => undefined;
    context = {
      paths,
      logger: { debug: noop, info: noop, warn: noop, error: noop },
      credentialStore,
      credentials: loaded.credentials,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function moduleContext(): ModuleContext {
    return { paths: context.paths, logger: context.logger, getModule: () => undefined } as never;
  }

  it("answers a pending ask on its own poll, with no gateway running, as the enrolled device", async () => {
    const recorded = recording();
    const cloud = fakeCloud(askFor(recorded.plan));
    vi.stubGlobal("fetch", cloud.fetchImpl);
    const module = createWorkflowValidationDaemonModule(context, {
      privateValues: recorded.store,
      localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
      pollIntervalMs: 10,
      pollJitterRatio: 0,
    });

    await module.start(moduleContext());
    try {
      await vi.waitFor(() => expect(cloud.decisions).toHaveLength(1));
    } finally {
      await module.stop(moduleContext());
    }

    const [delivery] = cloud.decisions as Array<{
      decision: { requestId: string; planDigest: string; accepted: unknown[] };
    }>;
    expect(delivery?.decision.requestId).toBe("req-daemon-01");
    expect(delivery?.decision.planDigest).toBe(workflowValidationPlanDigest(recorded.plan));
    expect(delivery?.decision.accepted.length).toBeGreaterThan(0);
    const [listUrl, listInit] = vi.mocked(cloud.fetchImpl).mock.calls[0] ?? [];
    expect(String(listUrl)).toBe(
      `${CLOUD_URL}/v1/evolution/workflow-validation/pending?deviceId=${DEVICE_ID}`,
    );
    expect(new Headers(listInit?.headers as HeadersInit).get("x-workspace-id")).toBe(WORKSPACE_ID);
  });

  it("answers an ask that names no device, as the cloud lists them for this device", async () => {
    const recorded = recording();
    const cloud = fakeCloud(askFor(recorded.plan, { deviceId: undefined }));
    vi.stubGlobal("fetch", cloud.fetchImpl);
    const module = createWorkflowValidationDaemonModule(context, {
      privateValues: recorded.store,
      localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
      pollIntervalMs: 10,
      pollJitterRatio: 0,
    });

    await module.start(moduleContext());
    try {
      await vi.waitFor(() => expect(cloud.decisions).toHaveLength(1));
    } finally {
      await module.stop(moduleContext());
    }
  });

  it("stops only after a pass in flight has finished writing its state", async () => {
    const recorded = recording();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const module = createWorkflowValidationDaemonModule(context, {
      client: {
        listPending: async () => {
          await held;
          return [];
        },
        submitDecision: async () => ({ status: "recorded" }),
      },
      privateValues: recorded.store,
      localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
      pollIntervalMs: 1,
      pollJitterRatio: 0,
    });
    await module.start(moduleContext());
    await new Promise((resolve) => setTimeout(resolve, 20));
    let stopped = false;
    const stopping = module.stop(moduleContext()).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it.each([
    ["a workspace the device is not enrolled in", { workspaceId: OTHER_WORKSPACE_ID }],
    ["another device", { deviceId: "dev_daemon_other" }],
    ["a plan other than the one its digest names", { planDigest: "sha256:not-this-plan" }],
  ] as const)("refuses an ask for %s, posting nothing", async (_label, overrides) => {
    const recorded = recording();
    const cloud = fakeCloud(askFor(recorded.plan, overrides));
    vi.stubGlobal("fetch", cloud.fetchImpl);
    const module = createWorkflowValidationDaemonModule(context, {
      privateValues: recorded.store,
      localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
      pollIntervalMs: 10,
      pollJitterRatio: 0,
    });

    await module.start(moduleContext());
    try {
      await vi.waitFor(() =>
        expect(vi.mocked(cloud.fetchImpl).mock.calls.length).toBeGreaterThan(1),
      );
    } finally {
      await module.stop(moduleContext());
    }

    expect(cloud.decisions).toHaveLength(0);
  });

  it("never answers an ask a gateway on the same device is already answering", async () => {
    const recorded = recording();
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    // The gateway's first listing is held open, so its pass holds the lease while the daemon polls.
    const cloud = fakeCloud(askFor(recorded.plan), gate);
    const leasePath = path.join(context.paths.stateDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    const checked = {
      privateValues: recorded.store,
      localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
    };
    const gateway = new WorkflowValidationWorker({
      client: new WorkflowValidationClient({
        identityProvider: (options) => context.credentialStore.getRequestIdentity(options),
        fetchImpl: cloud.fetchImpl,
      }),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      passLease: new FileWorkflowValidationPassLease({ filePath: leasePath }),
      ...checked,
    });
    const gatewayPass = gateway.runOnce();
    await vi.waitFor(() => expect(fs.existsSync(leasePath)).toBe(true));

    vi.stubGlobal("fetch", cloud.fetchImpl);
    const daemonLease = new FileWorkflowValidationPassLease({ filePath: leasePath });
    let daemonSkips = 0;
    const module = createWorkflowValidationDaemonModule(context, {
      ...checked,
      passLease: {
        maxHoldMs: daemonLease.maxHoldMs,
        async tryAcquire() {
          const release = await daemonLease.tryAcquire();
          if (release === undefined) daemonSkips += 1;
          return release;
        },
      },
      pollIntervalMs: 10,
      pollJitterRatio: 0,
    });
    await module.start(moduleContext());
    try {
      // The daemon's passes while the gateway holds the lease list nothing and post nothing.
      await vi.waitFor(() => expect(daemonSkips).toBeGreaterThanOrEqual(2));
      expect(vi.mocked(cloud.fetchImpl).mock.calls).toHaveLength(1);

      openGate();
      expect(await gatewayPass).toMatchObject({ answered: 1, skipped: false });
      // Once the gateway released, the daemon polls again and finds the ask already decided.
      await vi.waitFor(() =>
        expect(vi.mocked(cloud.fetchImpl).mock.calls.length).toBeGreaterThan(3),
      );
    } finally {
      await module.stop(moduleContext());
    }

    expect(cloud.decisions).toHaveLength(1);
  });

  function syncAnswer(validationToken: string | null): DeviceSyncSnapshot {
    return {
      requestedAt: Date.now(),
      sync: {
        schemaVersion: "1.0.0",
        deviceId: DEVICE_ID,
        accountId: "acct_daemon_01",
        userId: "user_daemon_01",
        toolAccess: validationToken === null ? "subscription_inactive" : "allowed",
        checkedAt: new Date().toISOString(),
        desired: null,
        catalogToken: validationToken === null ? null : "c:1",
        validationToken,
      },
    };
  }

  it("runs a pass at once whenever the device sync's ask token changes, and only then", async () => {
    const recorded = recording();
    const cloud = fakeCloud(askFor(recorded.plan));
    vi.stubGlobal("fetch", cloud.fetchImpl);
    const deviceSync = new DeviceSyncSignal();
    const module = createWorkflowValidationDaemonModule(
      { ...context, deviceSync },
      {
        privateValues: recorded.store,
        localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
        // Far beyond the test: every listing below comes from the device sync.
        pollIntervalMs: 3_600_000,
      },
    );
    const listings = () =>
      vi.mocked(cloud.fetchImpl).mock.calls.filter(([, init]) => init?.method !== "POST").length;

    await module.start(moduleContext());
    try {
      deviceSync.publish(syncAnswer("v:1"));
      await vi.waitFor(() => expect(cloud.decisions).toHaveLength(1));
      expect(listings()).toBe(1);

      // The same token again lists nothing.
      deviceSync.publish(syncAnswer("v:1"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(listings()).toBe(1);

      // The decision moved the token: the next answer runs another pass.
      deviceSync.publish(syncAnswer("v:2"));
      await vi.waitFor(() => expect(listings()).toBe(2));

      // Without tool access there is no token and nothing is listed; regaining it runs a pass.
      deviceSync.publish(syncAnswer(null));
      await new Promise((resolve) => setImmediate(resolve));
      expect(listings()).toBe(2);
      deviceSync.publish(syncAnswer("v:2"));
      await vi.waitFor(() => expect(listings()).toBe(3));
    } finally {
      await module.stop(moduleContext());
    }
  });

  it("keeps a token owed while another process holds the shared lease, and lists once it frees", async () => {
    const recorded = recording();
    const { promise: listingHeld, resolve: releaseListing } = Promise.withResolvers<void>();
    // Skipped passes list nothing, so the first listing is the one after the lease frees.
    const cloud = fakeCloud(askFor(recorded.plan), listingHeld);
    vi.stubGlobal("fetch", cloud.fetchImpl);
    const leasePath = path.join(context.paths.stateDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    await fsPromises.mkdir(path.dirname(leasePath), { recursive: true });
    const other = await new FileWorkflowValidationPassLease({ filePath: leasePath }).tryAcquire();
    if (!other) throw new Error("the test could not take the shared lease");
    const deviceSync = new DeviceSyncSignal();
    let skips = 0;
    const daemonLease = new FileWorkflowValidationPassLease({ filePath: leasePath });
    const module = createWorkflowValidationDaemonModule(
      { ...context, deviceSync },
      {
        privateValues: recorded.store,
        localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
        // Far beyond the test: only the module's retry may list.
        pollIntervalMs: 3_600_000,
        passLease: {
          maxHoldMs: daemonLease.maxHoldMs,
          async tryAcquire() {
            const handle = await daemonLease.tryAcquire();
            if (handle === undefined) skips += 1;
            return handle;
          },
        },
      },
      { retryDelayMs: 20 },
    );
    const listings = () =>
      vi.mocked(cloud.fetchImpl).mock.calls.filter(([, init]) => init?.method !== "POST").length;

    await module.start(moduleContext());
    try {
      deviceSync.publish(syncAnswer("v:1"));
      // Skipped passes list nothing, and the token stays owed: the module keeps retrying.
      await vi.waitFor(() => expect(skips).toBeGreaterThanOrEqual(2));
      expect(listings()).toBe(0);

      await other.release();
      // The pass that took the freed lease is listing; the same token arriving meanwhile is
      // already covered by it and must not start another pass.
      await vi.waitFor(() => expect(listings()).toBe(1));
      deviceSync.publish(syncAnswer("v:1"));
      releaseListing();
      await vi.waitFor(() => expect(cloud.decisions).toHaveLength(1));
      // Once listed, the same token lists nothing more either. Asserting that nothing happens
      // needs a real window: no signal fires for a pass that is (correctly) never started.
      deviceSync.publish(syncAnswer("v:1"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listings()).toBe(1);
    } finally {
      await module.stop(moduleContext());
    }
  });

  it("publishes the device sync for gateways and withdraws it on stop", async () => {
    const deviceSync = new DeviceSyncSignal();
    const relay = createDeviceSyncRelayDaemonModule({ ...context, deviceSync });
    if (!relay) throw new Error("the relay needs a device sync signal");
    const syncDir = path.join(
      path.dirname(context.credentialStore.getTokenFilePath()),
      "cloud-sync",
    );
    const identity = await context.credentialStore.getRequestIdentity();
    if (!identity) throw new Error("the fixture identity did not load");
    const gatewayView = new SharedDeviceSync({
      store: new DeviceSyncStore({ dir: syncDir }),
      identityProvider: async () => identity,
    });

    await relay.start(moduleContext());
    try {
      const answer = syncAnswer("v:7");
      deviceSync.publish(answer);
      await vi.waitFor(async () =>
        expect((await gatewayView.read())?.sync.validationToken).toBe("v:7"),
      );
      expect((await gatewayView.read())?.fetchedAt).toBe(answer.requestedAt);

      // A stopped sync loop withdraws its answer at once.
      deviceSync.clear();
      await vi.waitFor(async () => expect(await gatewayView.read()).toBeUndefined());
      deviceSync.publish(syncAnswer("v:8"));
      await vi.waitFor(async () =>
        expect((await gatewayView.read())?.sync.validationToken).toBe("v:8"),
      );
    } finally {
      await relay.stop(moduleContext());
    }
    expect(await gatewayView.read()).toBeUndefined();
  });

  it("adds no relay to a daemon without a device sync loop", () => {
    expect(createDeviceSyncRelayDaemonModule(context)).toBeUndefined();
  });
});

describe("the validation pass lease", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-validation-lease-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("is held by one process at a time and free again once released", async () => {
    const filePath = path.join(tempDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    const first = new FileWorkflowValidationPassLease({ filePath, isAlive: () => true });
    const second = new FileWorkflowValidationPassLease({ filePath, isAlive: () => true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ pid: 999_999, token: "other", acquiredAt: Date.now() }),
    );

    expect(await second.tryAcquire()).toBeUndefined();
    fs.rmSync(filePath);
    const held = await first.tryAcquire();
    expect(held).toBeDefined();
    await held?.release();
    expect(await second.tryAcquire()).toBeDefined();
  });

  it("takes over a lease its holder died with, or one past the stale bound", async () => {
    const filePath = path.join(tempDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ pid: 999_999, token: "dead", acquiredAt: Date.now() }),
    );
    const dead = new FileWorkflowValidationPassLease({ filePath, isAlive: () => false });
    expect(await dead.tryAcquire()).toBeDefined();

    fs.writeFileSync(filePath, JSON.stringify({ pid: 999_999, token: "old", acquiredAt: 0 }));
    const stale = new FileWorkflowValidationPassLease({
      filePath,
      isAlive: () => true,
      staleMs: 1000,
    });
    expect(await stale.tryAcquire()).toBeDefined();
  });

  it("renews a held lease, so a long pass is not taken over as stale", async () => {
    const filePath = path.join(tempDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    let clock = 0;
    const holder = new FileWorkflowValidationPassLease({
      filePath,
      staleMs: 1000,
      now: () => clock,
    });
    const contender = new FileWorkflowValidationPassLease({
      filePath,
      staleMs: 1000,
      now: () => clock,
      isAlive: () => true,
    });
    const held = await holder.tryAcquire();
    clock = 900;
    await held?.renew();
    clock = 1500;
    expect(await contender.tryAcquire()).toBeUndefined();
    clock = 2000;
    expect(await contender.tryAcquire()).toBeDefined();
  });

  it("lets one of several processes take over the same abandoned lease", async () => {
    const filePath = path.join(tempDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ pid: 999_999, token: "dead", acquiredAt: Date.now() }),
    );
    const contenders = Array.from(
      { length: 6 },
      () => new FileWorkflowValidationPassLease({ filePath, isAlive: (pid) => pid !== 999_999 }),
    );

    const taken = await Promise.all(contenders.map((lease) => lease.tryAcquire()));

    expect(taken.filter((held) => held !== undefined)).toHaveLength(1);
    expect(fs.readdirSync(tempDir)).toEqual([WORKFLOW_VALIDATION_LEASE_FILE_NAME]);
  });

  // Windows refuses to replace a file any process has open, so a renew racing another gateway or the
  // daemon reading the lease used to fail the holder's whole pass with EPERM.
  it("renews while another process is reading the lease", async () => {
    const filePath = path.join(tempDir, WORKFLOW_VALIDATION_LEASE_FILE_NAME);
    const held = await new FileWorkflowValidationPassLease({ filePath }).tryAcquire();
    if (held === undefined) throw new Error("the lease was not acquired");
    const rename = fsPromises.rename;
    const attempts: Array<NodeJS.ErrnoException | undefined> = [];
    const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      try {
        await rename(from, to);
        attempts.push(undefined);
      } catch (error) {
        attempts.push(error as NodeJS.ErrnoException);
        throw error;
      }
    });
    vi.useFakeTimers();
    let reader: number | undefined = fs.openSync(filePath, "r");
    try {
      const renewed = held.renew().then(
        () => undefined,
        (error: unknown) => error,
      );
      // POSIX replaces the open file at once; Windows refuses while the reader holds it.
      await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0));
      fs.closeSync(reader);
      reader = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await renewed).toBeUndefined();
      expect(attempts.at(-1)).toBeUndefined();
      expect(fs.readdirSync(tempDir)).toEqual([WORKFLOW_VALIDATION_LEASE_FILE_NAME]);
    } finally {
      if (reader !== undefined) fs.closeSync(reader);
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
});
