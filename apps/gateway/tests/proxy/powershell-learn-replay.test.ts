/**
 * End to end in Windows PowerShell 5.1: Codex ran the same report job twice through
 * `powershell.exe -Command` (`.\report.ps1 -Region emea -Month 2025-03`, then with apac and
 * 2025-04). The two runs become one tool whose inputs are named after the script's parameters, a
 * recording made in another shell dialect is never checked against it, and calling the tool runs
 * it in real `powershell.exe` on Windows (and is refused anywhere else).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import {
  CMD_NOT_LEARNABLE_REASON,
  type NormalizedSessionEvent,
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  programNotLearnableReason,
  validateRecordedWorkflow,
} from "@resin/contracts";
import {
  InMemoryPrivateValueStore,
  NormalizationPipeline,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
  resolvePrivateReference,
} from "@resin/observer";
import {
  RuntimeAdapterRegistry,
  applyAcceptedBindings,
  createProcessAdapter,
  executeRecordedWorkflow,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor } from "./recorded-sessions.js";

const WORKSPACE = "workspace-powershell-learn-replay";
const WINDOWS = process.platform === "win32";
const POWERSHELL = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

/** The report script both runs call; its parameters name what the job varies. */
const REPORT_SCRIPT = [
  "param([string]$Region, [string]$Month)",
  "New-Item -ItemType Directory -Force -Path out | Out-Null",
  '$line = "report region=$Region month=$Month"',
  'Set-Content -Path (Join-Path out "$Region-$Month.txt") -Value $line',
  "Write-Output $line",
].join("\r\n");

const job = (region: string, month: string) => `.\\report.ps1 -Region ${region} -Month ${month}`;
const request = (region: string, month: string) =>
  `Build the monthly report for region ${region}, month ${month}`;

/** What `powershell.exe -Command` printed for a run: really run on Windows, as the script prints elsewhere. */
function run(root: string, command: string, region: string, month: string): string {
  if (!WINDOWS) return `report region=${region} month=${month}\r\n`;
  const ran = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  expect(ran.status, ran.stderr).toBe(0);
  return ran.stdout;
}

/** One Codex session that ran `command` in `executable -Command`, through the real decoder. */
async function record(
  store: InMemoryPrivateValueStore,
  session: {
    id: string;
    root: string;
    executable: string;
    region: string;
    month: string;
    /** The recorded argv after the executable; `-Command <job>` by default. */
    args?: string[];
    stdout?: string;
  },
): Promise<RecordedWorkflow> {
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const command = job(session.region, session.month);
  const args = session.args ?? ["-Command", command];
  const stdout = session.stdout ?? run(session.root, command, session.region, session.month);
  const timestamp = "2026-09-26T12:00:00.000Z";
  const native = [
    {
      type: "session_meta",
      payload: { session_id: session.id, id: session.id, cwd: session.root },
    },
    { type: "turn_context", payload: { turn_id: "turn", cwd: session.root, model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request(session.region, session.month) }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: `exec-${session.id}`,
          command: [session.executable, ...args],
          cwd: pathToFileURL(session.root).href,
          status: "completed",
          stdout,
          stderr: "",
          exit_code: 0,
          duration: { secs: 0, nanos: 5_000_000 },
        },
        started_at_ms: 1_000,
        completed_at_ms: 1_005,
      },
    },
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${session.id}_${ordinal}`,
        sessionId: session.id,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ordinal, ...entry }),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId: session.id, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  const recipe = recordCallsFromEvents(
    session.id,
    observed.map((entry) => projectEventToMetadataOnly(entry)),
  );
  if (recipe === undefined) throw new Error("expected a recording");
  expect(validateRecordedWorkflow(recipe.workflow)).toEqual({ valid: true, errors: [] });
  return recipe.workflow;
}

/** The plan asked to confirm its input candidates against the other session's call. */
function asked(plan: RecordedWorkflow, heldOutCallId: string): RecordedWorkflow {
  const step = plan.steps[0]!;
  return {
    ...plan,
    heldOut: { inputs: [], observed: [], calls: [{ stepId: step.id, callIds: [heldOutCallId] }] },
  };
}

function inputCandidates(plan: RecordedWorkflow): WorkflowBindingCandidate[] {
  return (plan.candidates ?? []).filter((candidate) => candidate.proposed.kind === "input");
}

describe("a PowerShell job run twice", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-powershell-learn-"));
    fs.writeFileSync(path.join(root, "report.ps1"), REPORT_SCRIPT);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("becomes one tool with named inputs that runs in Windows PowerShell", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await record(store, {
      id: "ps-emea",
      root,
      executable: POWERSHELL,
      region: "emea",
      month: "2025-03",
    });
    await record(store, {
      id: "ps-apac",
      root,
      executable: POWERSHELL,
      region: "apac",
      month: "2025-04",
    });

    // One recorded step, proven Windows PowerShell 5.1, read in its own grammar.
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.callable.program).toMatchObject({ kind: "shell", dialect: "powershell" });
    const template = step.arguments.find((argument) => argument.name === "cmd")?.source;
    expect(template).toMatchObject({ kind: "template", template: { language: "powershell" } });
    const offered = inputCandidates(plan);
    expect(
      offered
        .map((candidate) => candidate.proposed.kind === "input" && candidate.proposed.name)
        .sort(),
    ).toEqual(["month", "region"]);

    // The other run confirms both inputs.
    const answer = await createRecordingCheckValidator({
      workspaceId: WORKSPACE,
      privateValues: store,
      localCalls: localCallsFor(store, WORKSPACE, ["ps-emea", "ps-apac"]),
    })(asked(plan, "exec-ps-apac"));
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status, JSON.stringify(answer)).toBe("verified");
    const confirmed = answer.verdicts.filter((verdict) => verdict.confirmed);
    expect(
      confirmed
        .map(
          (verdict) =>
            verdict.candidate.proposed.kind === "input" && verdict.candidate.proposed.name,
        )
        .sort(),
    ).toEqual(["month", "region"]);

    const tool = applyAcceptedBindings(
      plan,
      offered.filter((candidate) =>
        confirmed.some(
          (verdict) =>
            verdict.candidate.stepId === candidate.stepId &&
            JSON.stringify(verdict.candidate.path) === JSON.stringify(candidate.path),
        ),
      ),
    );
    expect(tool.inputs.map((input) => input.name).sort()).toEqual(["month", "region"]);
    expect(validateRecordedWorkflow(tool)).toEqual({ valid: true, errors: [] });

    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: root }));
    const called = await executeRecordedWorkflow(tool, {
      inputs: { region: "latam", month: "2026-01" },
      adapters,
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as never,
      access: { workspaceId: WORKSPACE },
    });
    if (WINDOWS) {
      expect(called.status, JSON.stringify(called.steps)).toBe("completed");
      expect(String(called.result).trim()).toBe("report region=latam month=2026-01");
      expect(fs.readFileSync(path.join(root, "out", "latam-2026-01.txt"), "utf8").trim()).toBe(
        "report region=latam month=2026-01",
      );
    } else {
      // Windows PowerShell 5.1 exists only on Windows; the tool is refused, never run in a POSIX shell.
      expect(called.status).not.toBe("completed");
      expect(JSON.stringify(called.steps)).toMatch(/runs only on Windows/);
    }
  });

  it.each([
    ["PowerShell 7", PWSH, [], "pwsh"],
    ["bash", "/bin/bash", ["-lc", job("apac", "2025-04")], "bash"],
  ] as const)(
    "never checks a PowerShell 5.1 plan against a %s run of the same job",
    async (_, executable, args, dialect) => {
      const store = new InMemoryPrivateValueStore();
      const plan = await record(store, {
        id: "ps-emea",
        root,
        executable: POWERSHELL,
        region: "emea",
        month: "2025-03",
      });
      const other = await record(store, {
        id: "other-apac",
        root,
        executable,
        region: "apac",
        month: "2025-04",
        ...(args.length === 0 ? {} : { args: [...args] }),
      });
      expect(other.steps[0]?.callable.program).toMatchObject({ dialect });
      const answer = await createRecordingCheckValidator({
        workspaceId: WORKSPACE,
        privateValues: store,
        localCalls: localCallsFor(store, WORKSPACE, ["ps-emea", "other-apac"]),
      })(asked(plan, "exec-other-apac"));
      expect(answer.unavailable).toMatch(/recorded with a different tool/);
      expect(answer.verdicts.some((verdict) => verdict.confirmed)).toBe(false);
    },
  );

  it("captures a cmd.exe run but reports it as not learnable and never replays it", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await record(store, {
      id: "cmd-emea",
      root,
      executable: "C:\\WINDOWS\\system32\\cmd.exe",
      region: "emea",
      month: "2025-03",
      args: ["/c", "report.cmd emea 2025-03"],
      stdout: "report region=emea month=2025-03\r\n",
    });
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.callable.program).toMatchObject({ kind: "shell", dialect: "cmd", source: "" });
    expect(programNotLearnableReason(step.callable.program!)).toBe(CMD_NOT_LEARNABLE_REASON);
    // Never tokenized: no candidate, and its text stays private rather than projected.
    expect(inputCandidates(plan)).toEqual([]);
    expect(step.arguments.find((argument) => argument.name === "cmd")?.source).toMatchObject({
      kind: "template",
      template: { type: "private" },
    });
    // A binding asked for inside it is refused with the reason, never checked.
    await record(store, {
      id: "cmd-apac",
      root,
      executable: "C:\\WINDOWS\\system32\\cmd.exe",
      region: "apac",
      month: "2025-04",
      args: ["/c", "report.cmd apac 2025-04"],
      stdout: "report region=apac month=2025-04\r\n",
    });
    const answer = await createRecordingCheckValidator({
      workspaceId: WORKSPACE,
      privateValues: store,
      localCalls: localCallsFor(store, WORKSPACE, ["cmd-emea", "cmd-apac"]),
    })({
      ...asked(plan, "exec-cmd-apac"),
      candidates: [
        {
          stepId: step.id,
          argument: "cmd",
          path: ["tokens", 1],
          proposed: { kind: "input", name: "region", type: "string" },
          reason: "varies-across-executions",
          missing: "a demonstration with a different value",
        },
      ],
    });
    expect(answer.verdicts).toEqual([
      expect.objectContaining({ confirmed: false, reason: CMD_NOT_LEARNABLE_REASON }),
    ]);

    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: root }));
    const called = await executeRecordedWorkflow(plan, {
      inputs: {},
      adapters,
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as never,
      access: { workspaceId: WORKSPACE },
    });
    expect(called.status).not.toBe("completed");
    expect(JSON.stringify(called.steps), JSON.stringify(called.steps)).toContain(
      "cmd.exe programs are captured but not learnable",
    );
  });
});

/**
 * One Codex session that called `shell_command` (or `exec_command`) with `job(region, month)` from a
 * Windows working directory, whose end event names the executable that ran it — or no end event.
 */
async function recordToolCall(
  store: InMemoryPrivateValueStore,
  session: {
    id: string;
    root: string;
    tool: "shell_command" | "exec_command";
    region: string;
    month: string;
    /** The argv Codex's end event recorded; absent when the rollout has no end event. */
    executable?: string;
  },
): Promise<RecordedWorkflow> {
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets: [], sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const command = job(session.region, session.month);
  const stdout = run(session.root, command, session.region, session.month);
  // Codex records a Windows session's working directory as the Windows path it is.
  const cwd = WINDOWS ? session.root : "C:\\work\\reports";
  const callId = `call-${session.id}`;
  const timestamp = "2026-09-26T12:00:00.000Z";
  const native = [
    { type: "session_meta", payload: { id: session.id, cwd } },
    { type: "turn_context", payload: { turn_id: "turn", cwd, model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request(session.region, session.month) }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: session.tool,
        call_id: callId,
        arguments: JSON.stringify(
          session.tool === "shell_command"
            ? { command, workdir: cwd }
            : { cmd: command, workdir: cwd },
        ),
      },
    },
    ...(session.executable === undefined
      ? []
      : [
          {
            type: "event_msg",
            payload: {
              type: "exec_command_end",
              call_id: callId,
              command: [session.executable, "-NoProfile", "-Command", command],
              cwd,
              stdout,
              stderr: "",
              aggregated_output: stdout,
              exit_code: 0,
              duration: { secs: 0, nanos: 5_000_000 },
            },
          },
        ]),
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: `Exit code: 0\nWall time: 0.4 seconds\nOutput:\n${stdout}`,
      },
    },
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${session.id}_${ordinal}`,
        sessionId: session.id,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ordinal, ...entry }),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId: session.id, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  const recipe = recordCallsFromEvents(
    session.id,
    observed.map((entry) => projectEventToMetadataOnly(entry)),
  );
  if (recipe === undefined) throw new Error("expected a recording");
  expect(validateRecordedWorkflow(recipe.workflow)).toEqual({ valid: true, errors: [] });
  return recipe.workflow;
}

describe("a Codex shell tool call on Windows", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-codex-shell-command-"));
    fs.writeFileSync(path.join(root, "report.ps1"), REPORT_SCRIPT);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("learns shell_command run twice in Windows PowerShell 5.1, as its end events prove, and replays it there", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await recordToolCall(store, {
      id: "sc-emea",
      root,
      tool: "shell_command",
      region: "emea",
      month: "2025-03",
      executable: POWERSHELL,
    });
    await recordToolCall(store, {
      id: "sc-apac",
      root,
      tool: "shell_command",
      region: "apac",
      month: "2025-04",
      executable: POWERSHELL,
    });
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.callable).toMatchObject({
      name: "shell_command",
      program: { kind: "shell", argument: "command", dialect: "powershell" },
    });
    expect(step.callable.program).not.toHaveProperty("unprovenDialect");
    const offered = inputCandidates(plan);
    expect(
      offered
        .map((candidate) => candidate.proposed.kind === "input" && candidate.proposed.name)
        .sort(),
    ).toEqual(["month", "region"]);

    const answer = await createRecordingCheckValidator({
      workspaceId: WORKSPACE,
      privateValues: store,
      localCalls: localCallsFor(store, WORKSPACE, ["sc-emea", "sc-apac"]),
    })(asked(plan, "call-sc-apac"));
    expect(answer.verification?.status, JSON.stringify(answer)).toBe("verified");
    const confirmed = answer.verdicts.filter((verdict) => verdict.confirmed);
    expect(confirmed).toHaveLength(2);

    const tool = applyAcceptedBindings(plan, offered);
    expect(tool.inputs.map((input) => input.name).sort()).toEqual(["month", "region"]);
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: root }));
    const called = await executeRecordedWorkflow(tool, {
      inputs: { region: "latam", month: "2026-01" },
      adapters,
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as never,
      access: { workspaceId: WORKSPACE },
    });
    if (WINDOWS) {
      expect(called.status, JSON.stringify(called.steps)).toBe("completed");
      expect(String(called.result).trim()).toBe("report region=latam month=2026-01");
      expect(fs.readFileSync(path.join(root, "out", "latam-2026-01.txt"), "utf8").trim()).toBe(
        "report region=latam month=2026-01",
      );
    } else {
      expect(called.status).not.toBe("completed");
      expect(JSON.stringify(called.steps)).toMatch(/runs only on Windows/);
    }
  });

  it("proves PowerShell 7 from an exec_command end event", async () => {
    const plan = await recordToolCall(new InMemoryPrivateValueStore(), {
      id: "ec-pwsh",
      root,
      tool: "exec_command",
      region: "emea",
      month: "2025-03",
      executable: PWSH,
    });
    expect(plan.steps[0]?.callable.program).toMatchObject({ argument: "cmd", dialect: "pwsh" });
    expect(inputCandidates(plan).length).toBeGreaterThan(0);
  });

  it("keeps a call with no end event unproven: captured, never learned", async () => {
    const plan = await recordToolCall(new InMemoryPrivateValueStore(), {
      id: "sc-none",
      root,
      tool: "shell_command",
      region: "emea",
      month: "2025-03",
    });
    expect(plan.steps[0]?.callable.program).toMatchObject({ unprovenDialect: true });
    expect(plan.steps[0]?.callable.program).not.toHaveProperty("dialect");
    expect(inputCandidates(plan)).toEqual([]);
  });

  it("never checks a run its end event proved PowerShell 7 against a 5.1 plan", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = await recordToolCall(store, {
      id: "sc-51",
      root,
      tool: "shell_command",
      region: "emea",
      month: "2025-03",
      executable: POWERSHELL,
    });
    await recordToolCall(store, {
      id: "sc-7",
      root,
      tool: "shell_command",
      region: "apac",
      month: "2025-04",
      executable: PWSH,
    });
    const answer = await createRecordingCheckValidator({
      workspaceId: WORKSPACE,
      privateValues: store,
      localCalls: localCallsFor(store, WORKSPACE, ["sc-51", "sc-7"]),
    })(asked(plan, "call-sc-7"));
    expect(answer.unavailable).toMatch(/recorded with a different tool/);
    expect(answer.verdicts.some((verdict) => verdict.confirmed)).toBe(false);
  });
});
