/**
 * The gateway's answer side of a recorded workflow's validation.
 *
 * These tests drive the real client over a fake connection and the real local validator over a plan
 * whose calls are dispatched to a stand-in, so what is exercised is the wiring: which ask is
 * answered, under which identity, with which digests, and what happens when an ask cannot be
 * substantiated or an answer is refused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  WORKFLOW_VALIDATION_SCHEMA_VERSION,
  type WorkflowBindingCandidate,
  type WorkflowValidationDecision,
  type WorkflowValidationRequest,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  CloudCredentialStore,
  type CloudRequestIdentity,
  InMemoryPrivateValueStore,
} from "@resin/observer";
import { PROTOCOL_VERSION } from "@resin/protocol";
import { RESIN_TOOL_PROTOCOL_RUNTIME, type ToolProtocolDispatchRequest } from "@resin/runtime";
import { describe, expect, it, vi } from "vitest";
import { ReplayWorkspaceUnavailableError } from "../../src/proxy/replay-workspace-snapshot.js";
import { createProductionProxyRuntime } from "../../src/proxy/runtime.js";
import {
  DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT,
  WorkflowValidationClient,
  WorkflowValidationClientError,
  type WorkflowValidationPassSummary,
  type WorkflowValidationTransport,
  WorkflowValidationWorker,
} from "../../src/proxy/validation-worker.js";

const WORKSPACE_ID = "ws_recorder_a1";
const OTHER_WORKSPACE_ID = "ws_recorder_b2";
const DEVICE_ID = "dev_validation_01";
const INSTALLATION_ID = "install_validation_01";
const ACCOUNT_ID = "acct_validation_01";
const ATTEMPT = "attempt-01";
const EVIDENCE_DIGEST = "evidence-digest-01";
const DECIDED_AT = "2026-09-18T12:00:00.000Z";

const IDENTITY: CloudRequestIdentity = {
  cloudUrl: "https://cloud.test",
  accessToken: "access-token-1",
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  deviceId: DEVICE_ID,
  installationId: INSTALLATION_ID,
  userId: "user_validation_01",
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A connection that answers from `handler` and remembers what was asked of it. */
function recordingFetch(handler: (url: string, init: RequestInit) => Response): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const request = init ?? {};
    calls.push({ url, init: request });
    return handler(url, request);
  });
  // SAFETY: Test fixture provides a fetch-shaped function.
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: String(status) });
}

function headerOf(call: RecordedCall, name: string): string | null {
  return new Headers(call.init.headers as HeadersInit).get(name);
}

/** The decision the worker delivered; the tests read it the way the cloud would. */
function postedDecision(calls: RecordedCall[]): WorkflowValidationDecision {
  const post = calls.find((call) => call.init.method === "POST");
  if (post === undefined) throw new Error("no decision was posted");
  const body = JSON.parse(String(post.init.body)) as { decision: WorkflowValidationDecision };
  return body.decision;
}

/**
 * The two tools the recording calls. `produce` turns the seed into a token, `consume` acts on the
 * text it is handed; both are deterministic, so a replay's outcome depends only on what bound.
 */
function dispatchStub() {
  return vi.fn(async (request: ToolProtocolDispatchRequest) => {
    if (request.name === "vendor.produce") {
      return { token: `tok(${String(request.arguments.seed ?? "")})` };
    }
    if (request.name === "vendor.consume") {
      return { echoed: request.arguments.text ?? null };
    }
    throw new Error(`unexpected callable '${request.name}'`);
  });
}

/**
 * The demonstration's values, kept where every value of a recording is kept: locally, and stamped
 * with the workspace that recorded them — which is what lets a replay resolve them and nothing
 * else.
 */
function privateValues(workspaceId: string = WORKSPACE_ID): InMemoryPrivateValueStore {
  const store = new InMemoryPrivateValueStore();
  store.set("private:replay:seed", "held-out-seed", { workspaceId });
  store.set("private:replay:produced", { token: "tok(held-out-seed)" }, { workspaceId });
  store.set("private:replay:consumed", { echoed: "tok(held-out-seed)" }, { workspaceId });
  return store;
}

const inputCandidate: WorkflowBindingCandidate = {
  stepId: "produce",
  argument: "seed",
  path: [],
  proposed: { kind: "input", name: "seed", type: "string" },
  reason: "declared-by-the-callable",
  missing: "the recording never showed which caller-supplied value reached the call",
};

const tokenCandidate: WorkflowBindingCandidate = {
  stepId: "consume",
  argument: "text",
  path: [],
  proposed: { kind: "result", stepId: "produce", path: ["token"] },
  reason: "tracks-earlier-result-across-executions",
  missing: "the recording never showed the text moving with the earlier result",
};

/**
 * A recording whose second step froze the first one's token as a literal, with a demonstration on
 * a different seed that shows the text moving with the result.
 */
function recordedPlan(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf_validation_worker",
    inputs: [{ name: "seed", type: "string" }],
    privateReferences: [
      "private:replay:seed",
      "private:replay:produced",
      "private:replay:consumed",
    ],
    candidates: [inputCandidate, tokenCandidate],
    heldOut: {
      inputs: [{ stepId: "produce", argument: "seed", reference: "private:replay:seed" }],
      observed: [
        { stepId: "produce", reference: "private:replay:produced" },
        { stepId: "consume", reference: "private:replay:consumed" },
      ],
    },
    steps: [
      {
        id: "produce",
        callId: "call_produce",
        callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "vendor.produce" },
        arguments: [
          {
            name: "seed",
            source: { kind: "template", template: { type: "literal", value: "recorded-seed" } },
          },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "consume",
        callId: "call_consume",
        callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "vendor.consume" },
        arguments: [
          {
            name: "text",
            source: { kind: "template", template: { type: "literal", value: "frozen-text" } },
          },
        ],
        dependsOn: ["produce"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

function requestFor(
  plan: RecordedWorkflow,
  overrides: Partial<WorkflowValidationRequest> = {},
): WorkflowValidationRequest {
  return {
    schemaVersion: WORKFLOW_VALIDATION_SCHEMA_VERSION,
    requestId: "req-01",
    workspaceId: WORKSPACE_ID,
    deviceId: DEVICE_ID,
    attempt: ATTEMPT,
    planDigest: workflowValidationPlanDigest(plan),
    evidenceDigest: EVIDENCE_DIGEST,
    createdAt: "2026-09-18T11:59:00.000Z",
    plan,
    ...overrides,
  };
}

function clientOver(fetchImpl: typeof fetch): WorkflowValidationClient {
  return new WorkflowValidationClient({
    identityProvider: async () => IDENTITY,
    fetchImpl,
  });
}

describe("WorkflowValidationClient", () => {
  it("lists the pending asks for this device on the authenticated connection", async () => {
    const plan = recordedPlan();
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ requests: [requestFor(plan), { not: "a request" }] }),
    );
    const client = clientOver(fetchImpl);

    const requests = await client.listPending(DEVICE_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://cloud.test/v1/evolution/workflow-validation/pending?deviceId=${DEVICE_ID}`,
    );
    const call = calls[0] as RecordedCall;
    expect(call.init.method).toBe("GET");
    expect(headerOf(call, "authorization")).toBe("Bearer access-token-1");
    expect(headerOf(call, "x-account-id")).toBe(ACCOUNT_ID);
    expect(headerOf(call, "x-workspace-id")).toBe(WORKSPACE_ID);
    expect(headerOf(call, "x-device-id")).toBe(DEVICE_ID);
    expect(headerOf(call, "x-installation-id")).toBe(INSTALLATION_ID);
    expect(headerOf(call, "x-protocol-version")).toBe(PROTOCOL_VERSION);
    expect(headerOf(call, "x-resin-workflow-validation-capabilities")).toBe("workspace-inputs-v1");
    // An entry that is not a well-formed ask cannot be replayed; it is left out, not guessed at.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestId).toBe("req-01");
  });

  it("refreshes the stored identity once when the connection refuses it", async () => {
    const identityProvider = vi.fn(async () => IDENTITY);
    let served = 0;
    const { fetchImpl } = recordingFetch(() => {
      served += 1;
      return served === 1
        ? jsonResponse({ error: "expired" }, 401)
        : jsonResponse({ requests: [] });
    });
    const client = new WorkflowValidationClient({ identityProvider, fetchImpl });

    await expect(client.listPending(DEVICE_ID)).resolves.toEqual([]);

    expect(served).toBe(2);
    expect(identityProvider.mock.calls[0]?.[0]).toBeUndefined();
    expect(identityProvider.mock.calls[1]?.[0]).toEqual({ forceRefresh: true });
  });

  it("reports a delivery failure as an error rather than an outcome", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: "busy" }, 503));
    const client = clientOver(fetchImpl);
    const decision: WorkflowValidationDecision = {
      schemaVersion: WORKFLOW_VALIDATION_SCHEMA_VERSION,
      requestId: "req-01",
      attempt: ATTEMPT,
      planDigest: workflowValidationPlanDigest(recordedPlan()),
      evidenceDigest: EVIDENCE_DIGEST,
      environment: DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT,
      verdicts: [],
      accepted: [],
      decidedAt: DECIDED_AT,
    };

    await expect(client.submitDecision(decision)).rejects.toThrow(WorkflowValidationClientError);
  });
});

describe("WorkflowValidationWorker", () => {
  it("validates a pending ask locally and posts the decision with the ask's digests and this identity's headers", async () => {
    const plan = recordedPlan();
    const dispatch = dispatchStub();
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes("/pending")
        ? jsonResponse({ requests: [requestFor(plan)] })
        : jsonResponse({ status: "recorded", requestId: "req-01" }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      privateValues: privateValues(),
      dispatch,
      now: () => new Date(DECIDED_AT),
    });

    const summary = await worker.runOnce();

    expect(summary).toEqual({
      pending: 1,
      answered: 1,
      refused: 0,
      rejected: 0,
      deferred: 0,
    });
    expect(calls).toHaveLength(2);
    const post = calls[1] as RecordedCall;
    expect(post.url).toBe("https://cloud.test/v1/evolution/workflow-validation/decisions");
    expect(post.init.method).toBe("POST");
    expect(headerOf(post, "authorization")).toBe("Bearer access-token-1");
    expect(headerOf(post, "x-workspace-id")).toBe(WORKSPACE_ID);
    expect(headerOf(post, "x-device-id")).toBe(DEVICE_ID);
    expect(headerOf(post, "x-protocol-version")).toBe(PROTOCOL_VERSION);
    expect(headerOf(post, "x-resin-workflow-validation-capabilities")).toBe("workspace-inputs-v1");
    expect(headerOf(post, "content-type")).toBe("application/json");

    const decision = postedDecision(calls);
    expect(decision.requestId).toBe("req-01");
    expect(decision.attempt).toBe(ATTEMPT);
    expect(decision.planDigest).toBe(workflowValidationPlanDigest(plan));
    expect(decision.evidenceDigest).toBe(EVIDENCE_DIGEST);
    expect(decision.environment).toBe(DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT);
    expect(decision.decidedAt).toBe(DECIDED_AT);
    // Both proposals held on inputs the recording never contained.
    expect(decision.verdicts.map((verdict) => verdict.confirmed)).toEqual([true, true]);
    expect(decision.accepted).toEqual([
      { stepId: "produce", argument: "seed", path: [] },
      { stepId: "consume", argument: "text", path: [] },
    ]);
    expect(decision.verification?.status).toBe("verified");
    expect(dispatch).toHaveBeenCalled();
  });

  it("records an explicit failed decision when a replay cannot resolve its references", async () => {
    // The same recording, but its values were recorded by a different workspace: a reference is a
    // name, not a capability, so the replay must not resolve them even though the strings match.
    const plan = recordedPlan();
    const dispatch = dispatchStub();
    const logs: string[] = [];
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes("/pending")
        ? jsonResponse({ requests: [requestFor(plan)] })
        : jsonResponse({ status: "recorded" }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      privateValues: privateValues(OTHER_WORKSPACE_ID),
      dispatch,
      now: () => new Date(DECIDED_AT),
      log: (message) => logs.push(message),
    });

    const summary = await worker.runOnce();

    expect(summary).toMatchObject({ pending: 1, answered: 1, refused: 0 });
    const decision = postedDecision(calls);
    expect(decision.verification?.status).toBe("failed");
    expect(decision.verdicts.every((verdict) => !verdict.confirmed)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("replay failed");
  });

  it("does not submit a decision before its trusted workspace is ready", async () => {
    const plan = recordedPlan();
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ requests: [requestFor(plan)] }),
    );
    const logs: string[] = [];
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      createValidator: () => async () => {
        throw new ReplayWorkspaceUnavailableError();
      },
      log: (message) => logs.push(message),
    });

    const summary = await worker.runOnce();

    expect(summary).toMatchObject({ pending: 1, answered: 0, refused: 1 });
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
    expect(logs.join(" ")).toContain("deferred because trusted replay inputs are unavailable");
  });

  it("refuses an ask that names another workspace, without posting anything", async () => {
    const plan = recordedPlan();
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ requests: [requestFor(plan, { workspaceId: OTHER_WORKSPACE_ID })] }),
    );
    const validate = vi.fn(async () => ({ verdicts: [] }));
    const logs: string[] = [];
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      createValidator: () => validate,
      log: (message) => logs.push(message),
    });

    const summary = await worker.runOnce();

    expect(summary).toEqual({
      pending: 1,
      answered: 0,
      refused: 1,
      rejected: 0,
      deferred: 0,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
    expect(logs.some((message) => message.includes(OTHER_WORKSPACE_ID))).toBe(true);
  });

  it("refuses an ask whose plan does not match the digest it carries, without posting anything", async () => {
    const plan = recordedPlan();
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ requests: [requestFor(plan, { planDigest: "some-other-plan" })] }),
    );
    const validate = vi.fn(async () => ({ verdicts: [] }));
    const logs: string[] = [];
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      createValidator: () => validate,
      log: (message) => logs.push(message),
    });

    const summary = await worker.runOnce();

    expect(summary.refused).toBe(1);
    expect(summary.answered).toBe(0);
    expect(validate).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
    expect(logs.some((message) => message.includes("digests to"))).toBe(true);
  });

  it("tolerates a duplicate delivery", async () => {
    const plan = recordedPlan();
    const dispatch = dispatchStub();
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes("/pending")
        ? jsonResponse({ requests: [requestFor(plan)] })
        : jsonResponse({ status: "duplicate", requestId: "req-01" }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      privateValues: privateValues(),
      dispatch,
    });

    const summary = await worker.runOnce();

    expect(summary.answered).toBe(1);
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
  });

  const declined = [
    {
      httpStatus: 409,
      outcome: "conflict",
      body: { status: "conflict", reason: "the ask moved on" },
    },
    { httpStatus: 410, outcome: "stale", body: { status: "stale", reason: "the ask expired" } },
    { httpStatus: 404, outcome: "unknown", body: { status: "unknown_request" } },
    { httpStatus: 400, outcome: "rejected", body: { error: "INVALID_REQUEST" } },
  ] as const;

  it.each(declined)(
    "reports a decision the cloud declines as $outcome and does not retry it in the same pass",
    async ({ httpStatus, outcome, body }) => {
      const plan = recordedPlan();
      const { calls, fetchImpl } = recordingFetch((url) =>
        url.includes("/pending")
          ? jsonResponse({ requests: [requestFor(plan)] })
          : jsonResponse(body, httpStatus),
      );
      const logs: string[] = [];
      const worker = new WorkflowValidationWorker({
        client: clientOver(fetchImpl),
        identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
        privateValues: privateValues(),
        dispatch: dispatchStub(),
        log: (message) => logs.push(message),
      });

      const summary = await worker.runOnce();

      expect(summary).toEqual({
        pending: 1,
        answered: 0,
        refused: 0,
        rejected: 1,
        deferred: 0,
      });
      expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
      expect(logs.some((message) => message.includes(`(${outcome}`))).toBe(true);
    },
  );

  it("defers an ask when the decision route fails and answers it on the next pass", async () => {
    const plan = recordedPlan();
    let posts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.includes("/pending")) return jsonResponse({ requests: [requestFor(plan)] });
      posts += 1;
      return posts === 1
        ? jsonResponse({ error: "busy" }, 503)
        : jsonResponse({ status: "recorded" });
    });
    const logs: string[] = [];
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      privateValues: privateValues(),
      dispatch: dispatchStub(),
      log: (message) => logs.push(message),
    });

    const first: WorkflowValidationPassSummary = await worker.runOnce();
    const second = await worker.runOnce();

    expect(first).toEqual({
      pending: 1,
      answered: 0,
      refused: 0,
      rejected: 0,
      deferred: 1,
    });
    expect(second.answered).toBe(1);
    expect(posts).toBe(2);
    expect(logs.some((message) => message.includes("next pass"))).toBe(true);
  });

  it("runs one pass at a time", async () => {
    const gate = Promise.withResolvers<void>();
    const listPending = vi.fn(async () => {
      await gate.promise;
      return [];
    });
    const transport: WorkflowValidationTransport = {
      listPending,
      submitDecision: vi.fn(async () => ({ status: "recorded" as const })),
    };
    const worker = new WorkflowValidationWorker({
      client: transport,
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(listPending).toHaveBeenCalledTimes(1);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(listPending).toHaveBeenCalledTimes(1);
  });

  it("bounds the replay so a slow callable is refused rather than run on", async () => {
    vi.useFakeTimers();
    try {
      const plan = recordedPlan();
      const dispatch = vi.fn(async () => {
        const held = Promise.withResolvers<void>();
        setTimeout(held.resolve, 200);
        await held.promise;
        return { token: "tok(never-returned-in-time)" };
      });
      const { calls, fetchImpl } = recordingFetch((url) =>
        url.includes("/pending")
          ? jsonResponse({ requests: [requestFor(plan)] })
          : jsonResponse({ status: "recorded" }),
      );
      const worker = new WorkflowValidationWorker({
        client: clientOver(fetchImpl),
        identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
        privateValues: privateValues(),
        dispatch,
        timeoutMs: 20,
      });

      const pass = worker.runOnce();
      // The replay's own bound, not a guessed wait: advance until every run has been refused.
      let settled = false;
      void pass.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      while (!settled) await vi.advanceTimersByTimeAsync(25);
      const summary = await pass;

      expect(summary.answered).toBe(1);
      const decision = postedDecision(calls);
      expect(decision.verdicts.every((verdict) => verdict.confirmed)).toBe(false);
      expect(decision.verdicts.some((verdict) => verdict.reason?.includes("20ms bound"))).toBe(
        true,
      );
      expect(decision.accepted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls on the interval, spread by jitter, and stops when stopped", async () => {
    vi.useFakeTimers();
    try {
      const listPending = vi.fn(async () => []);
      const transport: WorkflowValidationTransport = {
        listPending,
        submitDecision: vi.fn(async () => ({ status: "recorded" as const })),
      };
      const worker = new WorkflowValidationWorker({
        client: transport,
        identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
        pollIntervalMs: 1000,
        pollJitterRatio: 0.5,
        random: () => 1,
      });

      expect(worker.isRunning()).toBe(false);
      worker.start();
      expect(worker.isRunning()).toBe(true);

      await vi.advanceTimersByTimeAsync(1499);
      expect(listPending).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(listPending).toHaveBeenCalledTimes(1);

      worker.stop();
      expect(worker.isRunning()).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(listPending).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the validation worker's place in the runtime", () => {
  it("is constructed with valid credentials and follows the runtime's start and stop", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-validation-worker-"));
    try {
      const tokenFile = path.join(tempDir, "device-token.json");
      const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
      await store.persist({
        cloudUrl: "https://cloud.custom-origin.io",
        accessToken: makeJwt({
          schemaVersion: 1,
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          deviceId: DEVICE_ID,
          installationId: INSTALLATION_ID,
          userId: "user_validation_01",
          issuedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scopes: ["device:connect"],
        }),
        refreshToken: "refresh-token-1",
        deviceId: DEVICE_ID,
        workspaceId: WORKSPACE_ID,
      });
      const runtime = await createProductionProxyRuntime({
        credentialStore: store,
        fetchFn: async () => {
          throw new Error("this test must not reach the network");
        },
      });

      expect(runtime.validationWorker).toBeDefined();
      expect(runtime.validationWorker?.isRunning()).toBe(false);

      await runtime.start();
      expect(runtime.validationWorker?.isRunning()).toBe(true);

      await runtime.stop();
      expect(runtime.validationWorker?.isRunning()).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("has no worker while there are no valid credentials", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-validation-worker-local-"));
    try {
      const store = new CloudCredentialStore({
        tokenFilePath: path.join(tempDir, "device-token.json"),
      });
      const runtime = await createProductionProxyRuntime({ credentialStore: store });

      expect(runtime.validationWorker).toBeUndefined();
      await expect(runtime.start()).resolves.toBeUndefined();
      await expect(runtime.stop()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}
