/**
 * The round-3 pair: a Codex `exec_command` run (the plan) and the same job as Claude Code `Bash`
 * calls (the held-out), both on this device. The held-out is replayed through the plan's program
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

const codexShell = { codexNative: { sourceInterface: "codex-exec-command" } };
const claudeShell = { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "claude-bash" };

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
): { plan: RecordedWorkflow; store: InMemoryPrivateValueStore } {
  const store = new InMemoryPrivateValueStore();
  const plan = recordSession(store, { workspaceId: owner, sessionId: CODEX, workflowId: "wf_x" }, [
    { user: "Build the brand report from sales.csv" },
    codexTurn("call_report", REPORT, ""),
    codexTurn("call_count", COUNT, "4 brand-report.txt\n"),
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
  it("verifies a Codex exec_command plan against Claude Code Bash calls", async () => {
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
          codexTurn("call_report", report, ""),
          codexTurn("call_count", COUNT, "4 brand-report.txt\n"),
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
                  argument.name === "cmd"
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
    const same = setup((callId, command, result) => codexTurn(callId, command, result));
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
});
