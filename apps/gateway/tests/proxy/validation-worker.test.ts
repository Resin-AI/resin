/**
 * The gateway's answer side of a recorded workflow's validation.
 *
 * These tests drive the real client over a fake connection and the real recording check over a plan
 * captured by the real recorder, so what is exercised is the wiring: which ask is answered, under
 * which identity, with which digests, and what happens when an ask cannot be substantiated or an
 * answer is refused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  WORKFLOW_VALIDATION_SCHEMA_VERSION,
  type WorkflowValidationDecision,
  type WorkflowValidationRequest,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  CloudCredentialStore,
  type CloudRequestIdentity,
  InMemoryPrivateValueStore,
  LocalSessionDiscoveryUnavailableError,
} from "@resin/observer";
import { PROTOCOL_VERSION } from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProductionProxyRuntime } from "../../src/proxy/runtime.js";
import {
  DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT,
  DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS,
  DEFAULT_WORKFLOW_VALIDATION_QUIET_POLL_INTERVAL_MS,
  WorkflowValidationClient,
  WorkflowValidationClientError,
  type WorkflowValidationPassSummary,
  type WorkflowValidationTransport,
  WorkflowValidationWorker,
  type WorkflowValidationWorkerOptions,
} from "../../src/proxy/validation-worker.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { localCallsFor, recordSession } from "./recorded-sessions.js";

const WORKSPACE_ID = "ws_recorder_a1";
const OTHER_WORKSPACE_ID = "ws_recorder_b2";
const DEVICE_ID = "dev_validation_01";
const SESSION_ID = "validation-worker-session";
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
 * One session that produced a token from a seed and handed it on, twice: the first run is the plan,
 * the second the held-out demonstration. Its values are kept where every recording's values are
 * kept — locally, stamped with the workspace that recorded them.
 */
function recording(workspaceId: string = WORKSPACE_ID): {
  plan: RecordedWorkflow;
  store: InMemoryPrivateValueStore;
} {
  const store = new InMemoryPrivateValueStore();
  const plan = recordSession(
    store,
    { workspaceId, sessionId: SESSION_ID, workflowId: "wf_validation_worker" },
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

function recordedPlan(): RecordedWorkflow {
  return recording().plan;
}

/** Worker options that check asks against `recorded`'s store and session on this device. */
function checkedAgainst(recorded: { store: InMemoryPrivateValueStore }) {
  return {
    privateValues: recorded.store,
    localCalls: localCallsFor(recorded.store, WORKSPACE_ID, [SESSION_ID]),
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
    expect(headerOf(call, "x-resin-workflow-validation-capabilities")?.split(",")).toEqual([
      "workspace-inputs-v1",
      "unknown-typed-proposals-v1",
      "cross-session-held-out-v1",
    ]);
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
    const recorded = recording();
    const { plan } = recorded;
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes("/pending")
        ? jsonResponse({ requests: [requestFor(plan)] })
        : jsonResponse({ status: "recorded", requestId: "req-01" }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      ...checkedAgainst(recorded),
      now: () => new Date(DECIDED_AT),
    });

    const summary = await worker.runOnce();

    expect(summary).toEqual({
      pending: 1,
      answered: 1,
      refused: 0,
      rejected: 0,
      deferred: 0,
      skipped: false,
    });
    expect(calls).toHaveLength(2);
    const post = calls[1] as RecordedCall;
    expect(post.url).toBe("https://cloud.test/v1/evolution/workflow-validation/decisions");
    expect(post.init.method).toBe("POST");
    expect(headerOf(post, "authorization")).toBe("Bearer access-token-1");
    expect(headerOf(post, "x-workspace-id")).toBe(WORKSPACE_ID);
    expect(headerOf(post, "x-device-id")).toBe(DEVICE_ID);
    expect(headerOf(post, "x-protocol-version")).toBe(PROTOCOL_VERSION);
    expect(headerOf(post, "x-resin-workflow-validation-capabilities")?.split(",")).toEqual([
      "workspace-inputs-v1",
      "unknown-typed-proposals-v1",
      "cross-session-held-out-v1",
    ]);
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
      { stepId: "step0", argument: "seed", path: [] },
      { stepId: "step1", argument: "text", path: [] },
    ]);
    expect(decision.verification?.status).toBe("verified");
  });

  it("records an explicit failed decision when the check cannot resolve its references", async () => {
    // The same recording, but its values were recorded by a different workspace: a reference is a
    // name, not a capability, so the check must not resolve them even though the strings match.
    const recorded = recording(OTHER_WORKSPACE_ID);
    const { plan } = recorded;
    const logs: string[] = [];
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes("/pending")
        ? jsonResponse({ requests: [requestFor(plan)] })
        : jsonResponse({ status: "recorded" }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      ...checkedAgainst(recorded),
      now: () => new Date(DECIDED_AT),
      log: (message) => logs.push(message),
    });

    const summary = await worker.runOnce();

    expect(summary).toMatchObject({ pending: 1, answered: 1, refused: 0 });
    const decision = postedDecision(calls);
    expect(decision.verification?.status).toBe("failed");
    expect(decision.verdicts.every((verdict) => !verdict.confirmed)).toBe(true);
  });

  it("does not submit a decision while local session discovery is unavailable", async () => {
    const plan = recordedPlan();
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse({ requests: [requestFor(plan)] }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      createValidator: () => async () => {
        throw new LocalSessionDiscoveryUnavailableError();
      },
    });

    const summary = await worker.runOnce();

    expect(summary).toMatchObject({ pending: 1, answered: 0 });
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
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
      skipped: false,
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
    const recorded = recording();
    const { plan } = recorded;
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes("/pending")
        ? jsonResponse({ requests: [requestFor(plan)] })
        : jsonResponse({ status: "duplicate", requestId: "req-01" }),
    );
    const worker = new WorkflowValidationWorker({
      client: clientOver(fetchImpl),
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      ...checkedAgainst(recorded),
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
        ...checkedAgainst(recording()),
        log: (message) => logs.push(message),
      });

      const summary = await worker.runOnce();

      expect(summary).toEqual({
        pending: 1,
        answered: 0,
        refused: 0,
        rejected: 1,
        deferred: 0,
        skipped: false,
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
      ...checkedAgainst(recording()),
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
      skipped: false,
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

describe("the validation worker's poll cadence", () => {
  const FAST = DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS;
  const QUIET = DEFAULT_WORKFLOW_VALIDATION_QUIET_POLL_INTERVAL_MS;
  /** The gaps a fresh worker takes while every poll comes back empty: fast three times, then doubling to quiet. */
  const BACKING_OFF = [FAST, FAST, FAST, 2 * FAST, 4 * FAST, QUIET, QUIET];
  let plan: RecordedWorkflow;

  beforeEach(() => {
    plan = recordedPlan();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function ask(requestId: string, overrides: Partial<WorkflowValidationRequest> = {}) {
    return requestFor(plan, { requestId, ...overrides });
  }

  /**
   * A started worker over a transport whose listing for poll `n` (from 1) is `script(n)`, thrown when
   * it is an error. `gaps()` is the time before each poll, from the start for the first.
   */
  function polling(
    script: (poll: number) => WorkflowValidationRequest[] | Error,
    options: Partial<WorkflowValidationWorkerOptions> = {},
  ) {
    const startedAt = Date.now();
    const polledAt: number[] = [];
    const worker = new WorkflowValidationWorker({
      client: {
        listPending: async () => {
          polledAt.push(Date.now());
          const listed = script(polledAt.length);
          if (listed instanceof Error) throw listed;
          return listed;
        },
        submitDecision: async () => ({ status: "recorded" }),
      },
      identity: { workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID },
      createValidator: () => async () => ({ verdicts: [], unavailable: "stubbed check" }),
      random: () => 0,
      ...options,
    });
    worker.start();
    const gaps = () => polledAt.map((at, index) => at - (polledAt[index - 1] ?? startedAt));
    return { worker, polledAt, gaps };
  }

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  it("stays on the fast cadence while asks keep arriving", async () => {
    const { worker, gaps } = polling((poll) => [ask(`req-${poll}`)]);

    await vi.advanceTimersByTimeAsync(10 * FAST);

    expect(gaps()).toEqual(Array(10).fill(FAST));
    worker.stop();
  });

  it("backs off stepwise to the quiet cadence after three consecutive empty polls", async () => {
    const { worker, gaps } = polling(() => []);

    await vi.advanceTimersByTimeAsync(sum(BACKING_OFF) + 2 * QUIET);

    expect(gaps()).toEqual([...BACKING_OFF, QUIET, QUIET]);
    worker.stop();
  });

  it("returns to the fast cadence at once when a quiet poll lists an ask", async () => {
    const { worker, gaps } = polling((poll) => (poll === 7 ? [ask("req-late")] : []));

    await vi.advanceTimersByTimeAsync(sum(BACKING_OFF) + 3 * FAST + 2 * FAST);

    expect(gaps()).toEqual([...BACKING_OFF, FAST, FAST, FAST, 2 * FAST]);
    worker.stop();
  });

  it("keeps the fast retry after a failed poll", async () => {
    const { worker, gaps } = polling((poll) =>
      poll === 7 ? new WorkflowValidationClientError("cloud unavailable") : [],
    );

    await vi.advanceTimersByTimeAsync(sum(BACKING_OFF) + 3 * FAST + 2 * FAST);

    expect(gaps()).toEqual([...BACKING_OFF, FAST, FAST, FAST, 2 * FAST]);
    worker.stop();
  });

  it("counts a re-listed ask it already refused as an empty poll", async () => {
    const { worker, gaps } = polling(() => [
      ask("req-foreign", { workspaceId: OTHER_WORKSPACE_ID }),
    ]);

    // The first listing is new, so the fourth poll is still fast; from then on it backs off.
    await vi.advanceTimersByTimeAsync(FAST + sum(BACKING_OFF));

    expect(gaps()).toEqual([FAST, ...BACKING_OFF]);
    worker.stop();
  });

  it("pulls a quiet timer in to one fast interval on a wake, however many wakes arrive", async () => {
    const { worker, polledAt, gaps } = polling(() => []);
    await vi.advanceTimersByTimeAsync(sum(BACKING_OFF.slice(0, 6)));
    expect(gaps()).toEqual(BACKING_OFF.slice(0, 6));
    const lastQuietPoll = polledAt.at(-1) ?? 0;

    await vi.advanceTimersByTimeAsync(10_000);
    const wokenAt = Date.now();
    worker.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    // A second wake would put the poll later than the one already pulled in; it changes nothing.
    worker.wake();
    await vi.advanceTimersByTimeAsync(FAST - 5_000 - 1);
    expect(polledAt.at(-1)).toBe(lastQuietPoll);
    await vi.advanceTimersByTimeAsync(1);
    expect(polledAt.at(-1)).toBe(wokenAt + FAST);

    // Woken, the cadence starts over: the woken poll and two more at fast, then the backoff.
    await vi.advanceTimersByTimeAsync(4 * FAST);
    expect(gaps().slice(6)).toEqual([10_000 + FAST, FAST, FAST, 2 * FAST]);
    worker.stop();
  });

  it("leaves a timer already due within a fast interval alone on a wake", async () => {
    const { worker, polledAt } = polling(() => []);

    await vi.advanceTimersByTimeAsync(5_000);
    worker.wake();
    await vi.advanceTimersByTimeAsync(FAST - 5_000);

    expect(polledAt).toHaveLength(1);
    worker.stop();
  });

  it.each([
    ["the least", 0, 1],
    ["the most", 1, 1.2],
    ["the most, for a source out of range above", 7, 1.2],
    ["the least, for a source out of range below", -3, 1],
  ])("jitter lengthens both cadences by %s", async (_label, random, factor) => {
    const fast = polling((poll) => [ask(`req-${poll}`)], { random: () => random });
    const quiet = polling(() => [], { random: () => random });

    await vi.advanceTimersByTimeAsync(1.2 * (sum(BACKING_OFF) + QUIET));

    expect(fast.gaps()[0]).toBe(FAST * factor);
    expect(quiet.gaps().slice(5, 7)).toEqual([QUIET * factor, QUIET * factor]);
    fast.worker.stop();
    quiet.worker.stop();
  });
});

describe("the validation worker's place in the runtime", () => {
  async function validCredentials(tempDir: string): Promise<CloudCredentialStore> {
    const store = new CloudCredentialStore({
      tokenFilePath: path.join(tempDir, "device-token.json"),
    });
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
    return store;
  }

  it("is constructed with valid credentials and follows the runtime's start and stop", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-validation-worker-"));
    try {
      const store = await validCredentials(tempDir);
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

  it("wakes the worker when the catalog revision changes, not when a sync repeats it", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-validation-worker-wake-"));
    try {
      const registry = new ToolRegistry();
      const runtime = await createProductionProxyRuntime({
        credentialStore: await validCredentials(tempDir),
        registry,
        fetchFn: async () => {
          throw new Error("this test must not reach the network");
        },
      });
      const worker = runtime.validationWorker;
      if (worker === undefined) throw new Error("the runtime built no validation worker");
      const wake = vi.spyOn(worker, "wake");
      const snapshot = await registry.resolveCatalog(WORKSPACE_ID);
      const announce = (revision: number) =>
        registry.events.emitImmediate({
          workspaceId: WORKSPACE_ID,
          revision,
          snapshot,
          changedToolIds: [],
          timestamp: DECIDED_AT,
        });

      await runtime.start();
      announce(4);
      announce(4);
      expect(wake).toHaveBeenCalledTimes(1);
      announce(5);
      expect(wake).toHaveBeenCalledTimes(2);

      await runtime.stop();
      announce(6);
      expect(wake).toHaveBeenCalledTimes(2);
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
