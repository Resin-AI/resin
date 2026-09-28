/**
 * The round-3 job as an OMP `bash` run (the plan) and as Claude Code `Bash` calls (the held-out),
 * both on this device and both bash. The held-out is replayed through the plan's program
 * argument only when both calls are proven built-in shells.
 */
import type { RecordedWorkflow } from "@resin/contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { type RecordedTurn, localCallsFor, recordSession } from "./recorded-sessions.js";

const owner = "cross-harness-owner";
const CODEX = "codex-round3";
const CLAUDE = "claude-round3";
const REPORT = "tail -n +2 sales.csv | cut -d, -f1 | sort | uniq -c | sort -rn > brand-report.txt";
const COUNT = "wc -l brand-report.txt";

const ompShell = { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "omp-bash" };
const codexShell = { codexNative: { sourceInterface: "codex-exec-command" } };
const claudeShell = { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "claude-bash" };

function ompTurn(
  callId: string,
  command: string,
  result: string,
  parameters: Record<string, unknown> = {},
): RecordedTurn {
  return {
    callId,
    toolName: "bash",
    parameters: { command, timeout: 30, ...parameters },
    result,
    metadata: ompShell,
  };
}

function codexTurn(callId: string, cmd: string, result: string): RecordedTurn {
  return {
    callId,
    toolName: "exec_command",
    parameters: { cmd, workdir: "/tmp/resin-e2e/r2/cx", yield_time_ms: 10000 },
    result,
    metadata: codexShell,
  };
}

function claudeTurn(
  callId: string,
  command: string,
  result: string,
  metadata: Record<string, unknown> = claudeShell,
  toolName = "Bash",
): RecordedTurn {
  return {
    callId,
    toolName,
    parameters: { command, description: "Build the brand report" },
    result,
    metadata,
  };
}

function pair(
  claude: (callId: string, command: string, result: string) => RecordedTurn,
  report = REPORT,
  planParameters: Record<string, unknown> = {},
): { plan: RecordedWorkflow; store: InMemoryPrivateValueStore } {
  const store = new InMemoryPrivateValueStore();
  const plan = recordSession(store, { workspaceId: owner, sessionId: CODEX, workflowId: "wf_x" }, [
    { user: "Build the brand report from sales.csv" },
    ompTurn("call_report", REPORT, "", planParameters),
    ompTurn("call_count", COUNT, "4 brand-report.txt\n", planParameters),
  ]);
  recordSession(store, { workspaceId: owner, sessionId: CLAUDE, workflowId: "wf_y" }, [
    { user: "Build the brand report from sales.csv" },
    claude("toolu_report", report, ""),
    claude("toolu_count", COUNT, "4 brand-report.txt\n"),
  ]);
  const recorded = plan.steps.filter((step) => step.origin !== "derivation");
  return {
    store,
    plan: {
      ...plan,
      candidates: [],
      heldOut: {
        inputs: [],
        observed: [],
        calls: [
          { stepId: recorded[0]!.id, callIds: ["toolu_report"] },
          { stepId: recorded[1]!.id, callIds: ["toolu_count"] },
        ],
      },
    },
  };
}

const validate = (plan: RecordedWorkflow, store: InMemoryPrivateValueStore) =>
  createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [CODEX, CLAUDE]),
  })(plan);

describe("a held-out another harness's built-in shell recorded", () => {
  it("verifies an OMP bash plan against Claude Code Bash calls", async () => {
    const { plan, store } = pair(claudeTurn);
    const answer = await validate(plan, store);
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status).toBe("verified");
  });

  it("still misses a step whose Bash program differs", async () => {
    const { plan, store } = pair(claudeTurn, `${REPORT} && echo extra`);
    const answer = await validate(plan, store);
    expect(answer.verification?.status).not.toBe("verified");
  });

  it("keeps exact identity for a tool that is not a proven built-in shell", async () => {
    const { plan, store } = pair((callId, command, result) =>
      claudeTurn(callId, command, result, {}, "run_script"),
    );
    const answer = await validate(plan, store);
    expect(answer.unavailable).toMatch(/recorded with a different tool/);
  });

  it("treats a secret in a cross-harness held-out exactly as a same-harness one", async () => {
    const secret = "sk-proj-Zx9Kq2Lm7Pv4Tn8RwY3bQ1aC5dE";
    const report = `curl -s -H 'Authorization: Bearer ${secret}' https://api.example.com/sales > sales.csv`;
    // The same held-out run, once as Claude Code Bash calls and once as Codex exec_command calls.
    const setup = (heldOut: (callId: string, command: string, result: string) => RecordedTurn) => {
      const store = new InMemoryPrivateValueStore();
      const plan = recordSession(
        store,
        { workspaceId: owner, sessionId: CODEX, workflowId: "wf_x" },
        [
          { user: "Build the brand report from sales.csv" },
          ompTurn("call_report", report, ""),
          ompTurn("call_count", COUNT, "4 brand-report.txt\n"),
        ],
      );
      recordSession(store, { workspaceId: owner, sessionId: CLAUDE, workflowId: "wf_y" }, [
        { user: "Build the brand report from sales.csv" },
        heldOut("toolu_report", report, ""),
        heldOut("toolu_count", COUNT, "4 brand-report.txt\n"),
      ]);
      expect(JSON.stringify(plan)).not.toContain(secret);
      const recorded = plan.steps.filter((step) => step.origin !== "derivation");
      const asked: RecordedWorkflow = {
        ...plan,
        candidates: [],
        heldOut: {
          inputs: [],
          observed: [],
          calls: [
            { stepId: recorded[0]!.id, callIds: ["toolu_report"] },
            { stepId: recorded[1]!.id, callIds: ["toolu_count"] },
          ],
        },
      };
      const guessing = (value: string): RecordedWorkflow => ({
        ...asked,
        steps: asked.steps.map((step, index) =>
          index !== 0
            ? step
            : {
                ...step,
                arguments: step.arguments.map((argument) =>
                  argument.name === "command"
                    ? {
                        ...argument,
                        source: { kind: "literal" as const, value: report.replace(secret, value) },
                      }
                    : argument,
                ),
              },
        ),
      });
      return { store, asked, guessing };
    };
    const outcome = async (answer: Awaited<ReturnType<typeof validate>>) => ({
      unavailable: answer.unavailable,
      status: answer.verification?.status,
      missed: answer.verification?.missed.map((entry) => entry.stepId),
    });
    const cross = setup(claudeTurn);
    const same = setup((callId, command, result) => ompTurn(callId, command, result));
    for (const plan of [
      (x: typeof cross) => x.asked,
      (x: typeof cross) => x.guessing(secret),
      (x: typeof cross) => x.guessing("sk-proj-wrongwrongwrongwrongwrong"),
    ]) {
      expect(await outcome(await validate(plan(cross), cross.store))).toEqual(
        await outcome(await validate(plan(same), same.store)),
      );
    }
    expect((await validate(cross.asked, cross.store)).verification?.status).toBe("verified");
  });

  it("misses a held-out that ran in another working directory", async () => {
    // The plan's run changed into `reports/`; the Claude Code run did not.
    const { plan, store } = pair(claudeTurn, REPORT, { cwd: "reports" });
    const answer = await validate(plan, store);
    expect(answer.unavailable).toBeUndefined();
    expect(answer.verification?.status).not.toBe("verified");
  });

  it("refuses to cross between Cursor's sh-or-zsh shell and a bash harness", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recordSession(
      store,
      { workspaceId: owner, sessionId: CODEX, workflowId: "wf_x" },
      [
        { user: "Build the brand report from sales.csv" },
        codexTurn("call_report", REPORT, ""),
        codexTurn("call_count", COUNT, "4 brand-report.txt\n"),
      ],
    );
    const cursor = (callId: string, command: string, result: string): RecordedTurn => ({
      callId,
      toolName: "Shell",
      parameters: { command },
      result,
      metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "cursor-shell" },
    });
    recordSession(store, { workspaceId: owner, sessionId: CLAUDE, workflowId: "wf_y" }, [
      { user: "Build the brand report from sales.csv" },
      cursor("toolu_report", REPORT, ""),
      cursor("toolu_count", COUNT, "4 brand-report.txt\n"),
    ]);
    const recorded = plan.steps.filter((step) => step.origin !== "derivation");
    const answer = await validate(
      {
        ...plan,
        candidates: [],
        heldOut: {
          inputs: [],
          observed: [],
          calls: [
            { stepId: recorded[0]!.id, callIds: ["toolu_report"] },
            { stepId: recorded[1]!.id, callIds: ["toolu_count"] },
          ],
        },
      },
      store,
    );
    expect(answer.unavailable).toMatch(/recorded with a different tool/);
  });

  it("refuses a guess at a redacted working directory cross-harness exactly as same-harness", async () => {
    const DIR = "clients/acme-9f2a";
    const store = new InMemoryPrivateValueStore();
    store.set("private:v2:demonstration:cwd", DIR, { workspaceId: owner }, "literal");
    for (const id of ["plan_count", "held_count"]) {
      store.set(`private:v2:demonstration:${id}:command`, COUNT, { workspaceId: owner }, "literal");
      store.set(
        `private:v2:demonstration:${id}:result`,
        "4 brand-report.txt\n",
        { workspaceId: owner },
        "literal",
      );
    }
    // Only the held-out run's working directory was redacted from its upload.
    const call = (callId: string, name: string, sequence: number, redacted: boolean) => ({
      sessionId: "s",
      callId,
      callable: {
        name,
        program: { kind: "shell", argument: "command" },
        builtinShell: true as const,
      },
      arguments: { command: COUNT, cwd: DIR },
      argumentReferences: {
        command: `private:v2:demonstration:${callId}:command`,
        cwd: "private:v2:demonstration:cwd",
      },
      privatePositions: redacted ? [{ argument: "cwd", path: [], redacted: true }] : [],
      result: {
        value: "4 brand-report.txt\n",
        reference: `private:v2:demonstration:${callId}:result`,
      },
      sequence: { epoch: "e", index: sequence },
    });
    const answer = async (heldName: string, guess: string) => {
      const calls = new Map([
        ["plan_count", call("plan_count", "bash", 0, false)],
        ["held_count", call("held_count", heldName, 1, true)],
      ]);
      const plan: RecordedWorkflow = {
        schemaVersion: 1,
        workflowId: "wf_cwd",
        inputs: [],
        steps: [
          {
            id: "step0",
            callId: "plan_count",
            callable: {
              runtime: "resin-process",
              name: "bash",
              program: { kind: "shell", source: COUNT, argument: "command" },
            },
            arguments: [
              { name: "command", source: { kind: "literal", value: COUNT } },
              { name: "cwd", source: { kind: "literal", value: guess } },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
          },
        ],
        baseline: {
          inputs: [],
          observed: [],
          calls: [{ stepId: "step0", callIds: ["plan_count"] }],
        },
        heldOut: {
          inputs: [],
          observed: [],
          calls: [{ stepId: "step0", callIds: ["held_count"] }],
        },
        candidates: [],
      } as unknown as RecordedWorkflow;
      const result = await createRecordingCheckValidator({
        workspaceId: owner,
        privateValues: store,
        localCalls: { lookup: async (id) => calls.get(id) as never },
      })(plan);
      return {
        unavailable: result.unavailable,
        status: result.verification?.status,
        missed: result.verification?.missed.map((entry) => entry.stepId),
      };
    };
    for (const guess of [DIR, "clients/other"]) {
      const cross = await answer("Bash", guess);
      expect(cross.status).not.toBe("verified");
      expect(cross).toEqual(await answer("bash", guess));
    }
    expect(await answer("Bash", DIR)).toEqual(await answer("Bash", "clients/other"));
  });
});
