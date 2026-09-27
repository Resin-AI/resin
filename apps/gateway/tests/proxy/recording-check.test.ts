/**
 * Validation checks a plan against this device's own recording and runs nothing it recorded.
 *
 * Recordings here are captured by the real recorder into a real store; the validator reads them back
 * through the real local-call identity. Only session discovery is supplied, as a harness adapter
 * would supply it.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  tokenizeProgram,
} from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  type RecordableEvent,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
} from "@resin/observer";
import { afterEach, describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor } from "./recorded-sessions.js";

const owner = "recording-check-owner";
const SESSION = "recording-check-session";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

type Turn =
  | { user: string }
  | {
      callId: string;
      toolName: string;
      parameters: Record<string, unknown>;
      result: string;
      connection?: string;
      failed?: boolean;
      /** Recorded through the OMP decoder's proven bash interface. */
      ompBash?: boolean;
    };

/** Records turns as one session would have produced them; nothing is executed. */
function record(
  store: InMemoryPrivateValueStore,
  turns: Turn[],
  workspaceId = owner,
  sessionId = SESSION,
) {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const events: NormalizedSessionEvent[] = [];
  let sequence = 0;
  const emit = (fields: Record<string, unknown>) =>
    events.push(
      projectEventToMetadataOnly(
        recorder.observe(
          NormalizedSessionEventSchema.parse({
            schemaVersion: "1.0.0",
            sessionId,
            eventId: `event-${sequence}`,
            timestamp: "2026-09-26T00:00:00.000Z",
            causalRef: { causalSequence: sequence++ },
            redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
            ...fields,
          }),
          { workspaceId },
        ),
      ),
    );
  for (const turn of turns) {
    if ("user" in turn) {
      emit({ type: "message", role: "user", content: turn.user });
      continue;
    }
    emit({
      type: "tool_call",
      callId: turn.callId,
      toolName: turn.toolName,
      parameters: turn.parameters,
      ...(turn.connection === undefined ? {} : { connection: turn.connection }),
      ...(turn.ompBash === true
        ? { metadata: { [RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY]: "omp-bash" } }
        : {}),
    });
    emit({
      type: "tool_result",
      callId: turn.callId,
      toolName: turn.toolName,
      result: turn.result,
      isError: turn.failed === true,
      executionDurationMs: 1,
    });
  }
  return recordCallsFromEvents("recording-check", events as RecordableEvent[])!.workflow;
}

function validator(
  store: InMemoryPrivateValueStore,
  options: { workspaceId?: string; sessions?: string[] } = {},
) {
  const workspaceId = options.workspaceId ?? owner;
  return createRecordingCheckValidator({
    workspaceId,
    privateValues: store,
    localCalls: localCallsFor(store, workspaceId, options.sessions ?? [SESSION]),
  });
}

/** A local listener that counts every connection made to it. */
async function listener(): Promise<{ port: number; connections: () => number; close(): void }> {
  let count = 0;
  const server = net.createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as net.AddressInfo;
  return { port: address.port, connections: () => count, close: () => server.close() };
}

/** Runs `check` with a fresh, empty temporary directory and reports whether it stayed empty. */
async function withEmptyTmp<T>(check: () => Promise<T>): Promise<{ value: T; created: string[] }> {
  const directory = scratch("resin-recording-check-tmp-");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    const value = await check();
    return { value, created: readdirSync(directory) };
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

describe("a recorded shell step with side effects", () => {
  it("verifies from the recording without creating the marker or connecting", async () => {
    const server = await listener();
    try {
      const marker = path.join(scratch("resin-recording-check-marker-"), "marker");
      const command = `touch ${marker} && node -e "require('net').connect(${server.port}, '127.0.0.1')" && echo done`;
      const store = new InMemoryPrivateValueStore();
      const plan = record(store, [
        { user: "Touch the marker and ping the listener" },
        { callId: "side-effect", toolName: "bash", parameters: { command }, result: "done\n" },
      ]);
      expect(plan.baseline).toBeDefined();

      const { value: answer, created } = await withEmptyTmp(() =>
        validator(store)({ ...plan, candidates: [] }),
      );

      expect(answer.verification?.status).toBe("verified");
      expect(answer.verification?.replay?.kind).toBe("recording");
      expect(existsSync(marker)).toBe(false);
      expect(server.connections()).toBe(0);
      expect(created).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("misses a step whose literal program text differs from the recording, running nothing", async () => {
    const marker = path.join(scratch("resin-recording-check-literal-"), "marker");
    const recorded = "echo recorded";
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, [
      { user: "Say it" },
      { callId: "say", toolName: "bash", parameters: { command: recorded }, result: "recorded\n" },
    ]);
    const withLiteral = (value: string): RecordedWorkflow => ({
      ...plan,
      candidates: [],
      steps: plan.steps.map((step) => ({
        ...step,
        arguments: step.arguments.map((argument) =>
          argument.name === "command"
            ? { ...argument, source: { kind: "literal", value } }
            : argument,
        ),
      })),
    });

    const forged = await validator(store)(withLiteral(`touch ${marker}`));
    expect(forged.verification?.status).not.toBe("verified");
    expect(forged.verification?.missed.map((entry) => entry.stepId)).toEqual([plan.steps[0]!.id]);
    expect(existsSync(marker)).toBe(false);

    const equal = await validator(store)(withLiteral(recorded));
    expect(equal.verification?.status).toBe("verified");
  });
});

describe("a recorded tool-protocol step", () => {
  it("verifies from the recording with no dispatch wiring", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, [
      { user: "Look up order A-1001" },
      {
        callId: "lookup",
        toolName: "lookup_order",
        connection: "shop",
        parameters: { order: "A-1001" },
        result: "A-1001 shipped",
      },
    ]);
    expect(plan.steps[0]!.callable.connection).toBe("shop");
    const answer = await validator(store)({ ...plan, candidates: [] });
    expect(answer.verification?.status).toBe("verified");
  });
});

describe("a recorded invoke_tool step", () => {
  it("verifies from the recording although its call and result were kept differently", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, [
      { user: "Look up order A-1001" },
      {
        callId: "invoke",
        toolName: "invoke_tool",
        parameters: { name: "lookup_order", arguments: { order: { value: "A-1001" } } },
        result: "A-1001 shipped",
      },
    ]);
    const answer = await validator(store)({ ...plan, candidates: [] });
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status).toBe("verified");
  });
});

describe("held-out demonstrations", () => {
  function repeated(store: InMemoryPrivateValueStore, secondRegion: string) {
    return record(store, [
      { user: "Look up order A-1001" },
      {
        callId: "first",
        toolName: "lookup_order",
        connection: "shop",
        parameters: { order: "A-1001", region: "eu" },
        result: "A-1001 shipped",
      },
      { user: "Look up order B-2002" },
      {
        callId: "second",
        toolName: "lookup_order",
        connection: "shop",
        parameters: { order: "B-2002", region: secondRegion },
        result: "B-2002 pending",
      },
    ]);
  }
  const orderOnly = (plan: RecordedWorkflow): RecordedWorkflow => ({
    ...plan,
    candidates: (plan.candidates ?? []).filter(
      (candidate) => candidate.argument === "order" && candidate.proposed.kind === "input",
    ),
  });

  it("confirms a candidate whose resolved call matches the held-out recorded call", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = orderOnly(repeated(store, "eu"));
    expect(plan.heldOut?.calls).toEqual([{ stepId: plan.steps[0]!.id, callIds: ["second"] }]);
    expect(plan.candidates).toHaveLength(1);
    const answer = await validator(store)(plan);
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([true]);
    expect(answer.verification?.status).toBe("verified");
  });

  it("rejects the candidate when a part it does not bind differs from the held-out call", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = orderOnly(repeated(store, "us"));
    const answer = await validator(store)(plan);
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([false]);
    expect(answer.verification?.status).not.toBe("verified");
  });

  it("is unavailable when the demonstration names no calls", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = orderOnly(repeated(store, "eu"));
    const { calls: _calls, ...heldOut } = plan.heldOut!;
    const answer = await validator(store)({ ...plan, heldOut });
    expect(answer.unavailable).toBeDefined();
    expect(answer.verification).toBeUndefined();
    expect(answer.verdicts.every((verdict) => !verdict.confirmed)).toBe(true);
  });
});

describe("which recorded calls make up one demonstration", () => {
  const lookup = (callId: string): Turn => ({
    callId,
    toolName: "lookup_order",
    connection: "shop",
    parameters: { order: "A-1001" },
    result: "A-1001 shipped",
  });
  const label = (callId: string): Turn => ({
    callId,
    toolName: "print_label",
    connection: "shop",
    parameters: { order: "A-1001" },
    result: "label printed",
  });
  const stepOf = (plan: RecordedWorkflow, toolName: string) =>
    plan.steps.find((step) => step.callable.name === toolName)!;

  it("is unavailable when one run's calls were recorded in two sessions", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, [{ user: "Handle order A-1001" }, lookup("l1"), label("p1")]);
    record(store, [{ user: "Handle order A-1001" }, lookup("l2"), label("p2")], owner, "other");
    const check = validator(store, { sessions: [SESSION, "other"] });
    expect((await check({ ...plan, candidates: [] })).verification?.status).toBe("verified");
    const spliced: RecordedWorkflow = {
      ...plan,
      candidates: [],
      steps: plan.steps.map((step) =>
        step.id === stepOf(plan, "print_label").id ? { ...step, callId: "p2" } : step,
      ),
    };
    const answer = await check(spliced);
    expect(answer.unavailable).toBeDefined();
    expect(answer.verification).toBeUndefined();
  });

  it("is not verified when the named calls ran in a different order than the plan's steps", async () => {
    const store = new InMemoryPrivateValueStore();
    // A label printed before the lookup, then the lookup and the label again.
    record(store, [{ user: "Print the label for A-1001" }, label("p0")]);
    const plan = record(store, [{ user: "Handle order A-1001" }, lookup("l1"), label("p1")]);
    const labelStep = stepOf(plan, "print_label").id;
    expect(plan.steps.map((step) => step.callId)).toEqual(["l1", "p1"]);
    const reordered: RecordedWorkflow = {
      ...plan,
      candidates: [],
      steps: plan.steps.map((step) => (step.id === labelStep ? { ...step, callId: "p0" } : step)),
    };
    const answer = await validator(store)(reordered);
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status).not.toBe("verified");
    expect(answer.verification?.missed.map((entry) => entry.stepId)).toContain(labelStep);
  });

  it("confirms nothing when the held-out run reuses the baseline's calls", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, [
      { user: "Look up order A-1001" },
      { ...lookup("first"), parameters: { order: "A-1001", region: "eu" } },
      { user: "Look up order B-2002" },
      {
        ...lookup("second"),
        parameters: { order: "B-2002", region: "eu" },
        result: "B-2002 pending",
      },
    ]);
    const candidates = (plan.candidates ?? []).filter(
      (candidate) => candidate.argument === "order" && candidate.proposed.kind === "input",
    );
    expect(candidates).toHaveLength(1);
    const heldOut = plan.heldOut!;
    const reused = {
      ...plan,
      candidates,
      heldOut: { ...heldOut, calls: [{ stepId: plan.steps[0]!.id, callIds: ["first"] }] },
    };
    const answer = await validator(store)(reused);
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([false]);
    expect(answer.verification?.status).not.toBe("verified");
  });
});

describe("demonstrations that ran once per item", () => {
  const lookup = (callId: string, order: string, region: string, status: string): Turn => ({
    callId,
    toolName: "lookup_order",
    connection: "shop",
    parameters: { order, region },
    result: `status: ${status}`,
  });
  const label = (callId: string, order: string): Turn => ({
    callId,
    toolName: "print_label",
    connection: "shop",
    parameters: { order },
    result: "label printed",
  });
  /** One order handled, then three more in one request: one iteration per order. */
  function iterated(store: InMemoryPrivateValueStore, secondRegion = "eu") {
    const plan = record(store, [
      { user: "Handle order A-1001" },
      lookup("a-lookup", "A-1001", "eu", "shipped"),
      label("a-label", "A-1001"),
      { user: "Handle orders B-2002, C-3003 and D-4004" },
      lookup("b-lookup", "B-2002", "eu", "pending"),
      label("b-label", "B-2002"),
      lookup("c-lookup", "C-3003", secondRegion, "shipped"),
      label("c-label", "C-3003"),
      lookup("d-lookup", "D-4004", "eu", "held"),
      label("d-label", "D-4004"),
    ]);
    return {
      ...plan,
      candidates: (plan.candidates ?? []).filter(
        (candidate) => candidate.argument === "order" && candidate.proposed.kind === "input",
      ),
    };
  }

  it("lists every iteration's call and confirms a candidate that reproduces all three", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = iterated(store);
    expect(plan.heldOut?.calls).toEqual([
      { stepId: plan.steps[0]!.id, callIds: ["b-lookup", "c-lookup", "d-lookup"] },
      { stepId: plan.steps[1]!.id, callIds: ["b-label", "c-label", "d-label"] },
    ]);
    expect(plan.candidates.length).toBeGreaterThan(0);
    const answer = await validator(store)(plan);
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status).toBe("verified");
    expect(answer.verdicts.every((verdict) => verdict.confirmed)).toBe(true);
  });

  it("misses the step when one iteration ran a different call", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = iterated(store, "us");
    const answer = await validator(store)(plan);
    expect(answer.verification?.status).not.toBe("verified");
    expect(answer.verification?.missed.map((entry) => entry.stepId)).toContain(plan.steps[0]!.id);
  });

  it("is not verified when a step's call count differs from the item count", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = iterated(store);
    const heldOut = plan.heldOut!;
    const calls = heldOut.calls!.map((entry, index) =>
      index === 1 ? { ...entry, callIds: entry.callIds.slice(0, 2) } : entry,
    );
    const answer = await validator(store)({ ...plan, heldOut: { ...heldOut, calls } });
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status).not.toBe("verified");
    expect(answer.verification?.missed.map((entry) => entry.stepId)).toEqual([plan.steps[1]!.id]);
    expect(answer.verdicts.some((verdict) => verdict.confirmed)).toBe(false);
  });

  it("is unavailable when an iteration's call cannot be identified", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = iterated(store);
    const heldOut = plan.heldOut!;
    const calls = heldOut.calls!.map((entry, index) =>
      index === 0
        ? { ...entry, callIds: [entry.callIds[0]!, "unknown", entry.callIds[2]!] }
        : entry,
    );
    const answer = await validator(store)({ ...plan, heldOut: { ...heldOut, calls } });
    expect(answer.unavailable).toBeDefined();
  });
});

describe("local call identity", () => {
  const turns: Turn[] = [
    { user: "Look up order A-1001" },
    {
      callId: "lookup",
      toolName: "lookup_order",
      connection: "shop",
      parameters: { order: "A-1001" },
      result: "A-1001 shipped",
    },
  ];

  it("resolves nothing from a session this device did not discover", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, turns);
    const answer = await validator(store, { sessions: ["some-other-session"] })(plan);
    expect(answer.unavailable).toBeDefined();
    expect(answer.verification?.status).not.toBe("verified");
  });

  it("resolves nothing another workspace recorded", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = record(store, turns, "another-workspace");
    const answer = await validator(store)(plan);
    expect(answer.unavailable).toBeDefined();
    expect(answer.verification?.status).not.toBe("verified");
  });
});

describe("a held-out demonstration recorded in another session", () => {
  const OTHER = "recording-check-other-session";
  /** One read → edit → bash job, as a harness records it: every argument private. */
  const job = (prefix: string, file: string, replace = "DONE", limit: unknown = 40): Turn[] => [
    { user: `Finish the TODO in ${file} and run its tests` },
    {
      callId: `${prefix}-read`,
      toolName: "read",
      parameters: { path: file, limit },
      result: `TODO in ${file}`,
    },
    {
      callId: `${prefix}-edit`,
      toolName: "edit",
      parameters: { path: file, find: "TODO", replace },
      result: "edited",
    },
    {
      callId: `${prefix}-bash`,
      toolName: "bash",
      parameters: { command: `pnpm vitest run ${file}` },
      result: "1 passed",
    },
  ];
  const input = (
    plan: RecordedWorkflow,
    toolName: string,
    argument: string,
    type: "string" | "number" | "unknown",
  ): WorkflowBindingCandidate => ({
    stepId: plan.steps.find((step) => step.callable.name === toolName)!.id,
    argument,
    path: [],
    proposed: { kind: "input", name: argument === "limit" ? "limit" : "file", type },
    reason: "varies-across-executions",
    missing: "a demonstration with a different value",
  });
  function crossSession(store: InMemoryPrivateValueStore, heldOutTurns: Turn[]) {
    const recorded = record(store, job("a", "src/alpha.ts"));
    record(store, heldOutTurns, owner, OTHER);
    const plan: RecordedWorkflow = { ...recorded, candidates: [] };
    delete (plan as { heldOut?: unknown }).heldOut;
    const heldOutCalls = ["read", "edit", "bash"].map((toolName) => ({
      stepId: plan.steps.find((step) => step.callable.name === toolName)!.id,
      callIds: [`b-${toolName}`],
    }));
    const commandStep = plan.steps.find((step) => step.callable.name === "bash")!;
    const fileToken = tokenizeProgram("shell", "pnpm vitest run src/alpha.ts").findIndex(
      (token) => token.raw === "src/alpha.ts",
    );
    const token: WorkflowBindingCandidate = {
      stepId: commandStep.id,
      argument: "command",
      path: ["tokens", fileToken],
      proposed: { kind: "input", name: "file", type: "string" },
      reason: "varies-across-executions",
      missing: "a demonstration with a different value",
    };
    return {
      plan: { ...plan, heldOut: { inputs: [], observed: [], calls: heldOutCalls } },
      token,
      check: validator(store, { sessions: [SESSION, OTHER] }),
    };
  }

  it("confirms the job's bindings, reporting each untyped input's JSON type", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan, token, check } = crossSession(store, job("b", "src/beta.ts"));
    const candidates = [
      input(plan, "read", "path", "unknown"),
      input(plan, "edit", "path", "unknown"),
      token,
    ];
    const answer = await check({ ...plan, candidates });
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([true, true, true]);
    expect(answer.verdicts.map((verdict) => verdict.confirmedType)).toEqual([
      "string",
      "string",
      undefined,
    ]);
    expect(answer.verdicts[0]!.candidate.proposed).toMatchObject({ type: "unknown" });
    expect(answer.verification?.status).toBe("verified");
    expect(JSON.stringify(answer)).not.toContain("beta");
  });

  it("drops the bindings when the other session ran a different job", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan, token, check } = crossSession(store, job("b", "src/beta.ts", "REMOVED", 99));
    const candidates = [
      input(plan, "read", "path", "unknown"),
      input(plan, "edit", "path", "unknown"),
      token,
    ];
    const answer = await check({ ...plan, candidates });
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([false, false, false]);
    expect(answer.verdicts.every((verdict) => verdict.confirmedType === undefined)).toBe(true);
    expect(answer.verification?.status).not.toBe("verified");
  });

  it("drops an untyped proposal whose values disagree on JSON type", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan, check } = crossSession(store, job("b", "src/alpha.ts", "DONE", "40"));
    const answer = await check({ ...plan, candidates: [input(plan, "read", "limit", "unknown")] });
    expect(answer.verdicts).toHaveLength(1);
    expect(answer.verdicts[0]!.confirmed).toBe(false);
    expect(answer.verdicts[0]!.confirmedType).toBeUndefined();
    expect(answer.verdicts[0]!.reason).toBeDefined();
  });

  it("confirms an untyped number proposal as a number", async () => {
    const store = new InMemoryPrivateValueStore();
    const { plan, check } = crossSession(store, job("b", "src/alpha.ts", "DONE", 80));
    const answer = await check({ ...plan, candidates: [input(plan, "read", "limit", "unknown")] });
    expect(answer.verdicts[0]).toMatchObject({ confirmed: true, confirmedType: "number" });
  });
});

describe("a held-out command whose harness chose its own non-program arguments", () => {
  const OTHER = "recording-check-labelled-session";
  /** One `./dbtool check` call as an OMP bash call records it: an intent label beside the program. */
  const check = (callId: string, database: string, label: string, cwd = "."): Turn[] => [
    { user: `Check the ${database} database` },
    {
      callId,
      toolName: "bash",
      parameters: { i: label, command: `./dbtool check ${database}`, cwd, timeout: 60 },
      result: `${database}: ok\n`,
    },
  ];
  function heldOutAsk(store: InMemoryPrivateValueStore, heldOut: Turn[]) {
    const recorded = record(store, check("billing-check", "billing", "Checking billing database"));
    record(store, heldOut, owner, OTHER);
    const step = recorded.steps[0]!;
    const candidate: WorkflowBindingCandidate = {
      stepId: step.id,
      argument: "command",
      path: ["tokens", 2],
      proposed: { kind: "input", name: "text", type: "string", recordedDefault: true },
      reason: "native-data-argument",
      missing: "one recording does not establish that this value varies",
    };
    const plan: RecordedWorkflow = {
      ...recorded,
      candidates: [candidate],
      heldOut: {
        inputs: [],
        observed: [],
        calls: [{ stepId: step.id, callIds: [heldOut[1]!.callId as string] }],
      },
    };
    return validator(store, { sessions: [SESSION, OTHER] })(plan);
  }

  it("reproduces the other session's call although its intent label differs", async () => {
    const store = new InMemoryPrivateValueStore();
    const answer = await heldOutAsk(
      store,
      check("inventory-check", "inventory", "Checking inventory integrity"),
    );
    expect(answer.verification?.status).toBe("verified");
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([true]);
  });

  it("reproduces the other session's call when it spelled the project directory absolutely", async () => {
    const store = new InMemoryPrivateValueStore();
    // The harness adapter discovers every session under the workspace root `/nonexistent`.
    const answer = await heldOutAsk(
      store,
      check("inventory-check", "inventory", "Checking inventory integrity", "/nonexistent"),
    );
    expect(answer.verification?.status).toBe("verified");
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([true]);
  });

  it("still misses the call when the other session ran it in another directory", async () => {
    const store = new InMemoryPrivateValueStore();
    const answer = await heldOutAsk(
      store,
      check("inventory-check", "inventory", "Checking billing database", "services/db"),
    );
    expect(answer.verification?.status).not.toBe("verified");
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([false]);
  });
});

describe("a held-out run of one segment of a recorded && chain", () => {
  const OTHER = "recording-check-chain-session";
  /** The report job as one OMP bash call ran it: a setup segment, then the report itself. */
  const report = (callId: string, chain: string, failed = false, ompBash = true): Turn[] => [
    { user: "Produce the monthly report" },
    {
      callId,
      toolName: "bash",
      parameters: { command: chain },
      result: "done\n",
      failed,
      ompBash,
    },
  ];
  const EMEA = "mkdir -p out && ./reportctl render --region EMEA";
  /** The plan's one chain step split into its segments, as the cloud projects and splits it. */
  function segmented(plan: RecordedWorkflow, texts: string[], version = 1): RecordedWorkflow {
    const step = plan.steps[0]!;
    const argument = step.arguments.find((entry) => entry.name === "command")!;
    const source = argument.source as { kind: "template"; template: { reference: string } };
    const steps = texts.map((text, index) => ({
      ...step,
      id: `${step.id}-${index}`,
      segment: { index, count: texts.length, version },
      callable: { ...step.callable, program: { ...step.callable.program!, source: text } },
      arguments: [
        {
          ...argument,
          source: {
            kind: "template" as const,
            template: {
              type: "program" as const,
              language: "shell" as const,
              source: { type: "literal" as const, value: text },
              sourceReference: source.template.reference,
              protectedTokens: [],
              holes: [],
            },
          },
        },
      ],
    }));
    return { ...plan, steps, candidates: [] };
  }
  async function ask(heldOut: Turn[], version = 1) {
    const store = new InMemoryPrivateValueStore();
    const recorded = record(store, report("emea", EMEA));
    record(store, heldOut, owner, OTHER);
    const plan = segmented(recorded, ["mkdir -p out", "./reportctl render --region EMEA"], version);
    delete (plan as { baseline?: unknown }).baseline;
    const region = tokenizeProgram("shell", plan.steps[1]!.callable.program!.source).findIndex(
      (token) => token.raw === "EMEA",
    );
    const candidate: WorkflowBindingCandidate = {
      stepId: plan.steps[1]!.id,
      argument: "command",
      path: ["tokens", region],
      proposed: { kind: "input", name: "region", type: "string" },
      reason: "varies-across-executions",
      missing: "a demonstration with a different value",
    };
    return validator(store, { sessions: [SESSION, OTHER] })({
      ...plan,
      candidates: [candidate],
      heldOut: {
        inputs: [],
        observed: [],
        calls: plan.steps.map((step) => ({
          stepId: step.id,
          callIds: [heldOut[1]!.callId as string],
        })),
      },
    });
  }
  const second = (answer: Awaited<ReturnType<typeof ask>>) =>
    answer.verification?.missed.map((entry) => entry.stepId).some((id) => id.endsWith("-1"));

  it("confirms the report segment's region from the other session's chain", async () => {
    const answer = await ask(report("apac", "mkdir -p out && ./reportctl render --region APAC"));
    expect(answer.verification?.status).toBe("verified");
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([true]);
  });

  it.each([
    [
      "the chain exited non-zero",
      report("apac", "mkdir -p out && ./reportctl render --region APAC", true),
      1,
    ],
    [
      "the harness recorded no exit status",
      report("apac", "mkdir -p out && ./reportctl render --region APAC", false, false),
      1,
    ],
    [
      "the chain split into another count",
      report("apac", "mkdir -p out && ./reportctl render --region APAC && ls"),
      1,
    ],
    [
      "the segment ran other text",
      report("apac", "mkdir -p out && ./reportctl draw --region APAC"),
      1,
    ],
    [
      "the plan was split by another splitter version",
      report("apac", "mkdir -p out && ./reportctl render --region APAC"),
      2,
    ],
  ])("misses the segment when %s", async (_, heldOut, version) => {
    const answer = await ask(heldOut, version);
    expect(answer.verification?.status).not.toBe("verified");
    expect(second(answer)).toBe(true);
    expect(answer.verdicts.map((verdict) => verdict.confirmed)).toEqual([false]);
  });
});
