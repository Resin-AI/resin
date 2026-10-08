import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RecordedWorkflow, WorkflowStep } from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileRecordedWorkflow,
  instantiateRecordedWorkflow,
} from "../../src/workflow/compile-recorded-workflow.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "resin-workflow-cancellation-"));
  workspaces.push(workspace);
  return workspace;
}

/** A recorded bash step running `source` through its `command` argument. */
function shellStep(id: string, source: string, dependsOn: string[] = []): WorkflowStep {
  return {
    id,
    callId: `call-${id}`,
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source, argument: "command", dialect: "bash" },
    },
    arguments: [{ name: "command", source: { kind: "literal", value: source } }],
    dependsOn,
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  };
}

/**
 * A step whose program starts a `sleep 30` in the background, records its pid and waits for it —
 * so the sleep is a descendant of the step's shell, not the shell itself — then a step that
 * leaves a file behind if it ever runs.
 */
const PLAN: RecordedWorkflow = {
  schemaVersion: 1,
  workflowId: "wf_sleep_then_touch",
  inputs: [],
  steps: [
    shellStep("sleep", "sleep 30 & echo $! > sleep.pid; wait"),
    shellStep("after", "touch ran", ["sleep"]),
  ],
};

// The steps run real process trees: neither a file another process writes nor the exit of a
// process that is not this one's child emits an event to await, so both are polled briefly.

/** The pid the sleep step wrote, once it wrote it. */
async function sleepPid(workspace: string): Promise<number> {
  const file = join(workspace, "sleep.pid");
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(file)) {
      const text = (await readFile(file, "utf8")).trim();
      if (/^\d+$/.test(text)) return Number(text);
    }
    if (Date.now() > deadline) throw new Error("the sleep step never started");
    await delay(20);
  }
}

/** Whether `pid` still runs: a zombie waiting to be reaped has already been killed. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return process.platform !== "linux";
  }
}

async function expectGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (running(pid) && Date.now() < deadline) {
    await delay(20);
  }
  expect(running(pid), `process ${pid} survived`).toBe(false);
}

describe.skipIf(process.platform === "win32")("cancelling a recorded workflow", () => {
  it("kills the running step's process tree when the invocation's signal fires, and runs no later step", async () => {
    const workspace = await makeWorkspace();
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const tool = instantiateRecordedWorkflow(compileRecordedWorkflow(PLAN), { adapters });
    const controller = new AbortController();
    const invocation = tool.invoke({}, { signal: controller.signal });
    const pid = await sleepPid(workspace);
    expect(running(pid)).toBe(true);
    const cancelledAt = Date.now();
    controller.abort(new Error("Request cancelled"));
    const execution = await invocation;
    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
    expect(execution.status).toBe("failed");
    expect(execution.error).toBe("recorded program replay was cancelled (Request cancelled)");
    expect(execution.steps).toEqual([
      {
        stepId: "sleep",
        status: "failed",
        error: "recorded program replay was cancelled (Request cancelled)",
      },
      {
        stepId: "after",
        status: "skipped",
        reason: "the invocation was cancelled (Request cancelled)",
      },
    ]);
    await expectGone(pid);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
  });

  it("never reads as completed when cancelled before a step starts", async () => {
    const workspace = await makeWorkspace();
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const controller = new AbortController();
    controller.abort(new Error("Request timed out after 600000ms"));
    const execution = await executeRecordedWorkflow(PLAN, {
      inputs: {},
      adapters,
      signal: controller.signal,
    });
    expect(execution.status).toBe("failed");
    expect(execution.error).toBe("the invocation was cancelled (Request timed out after 600000ms)");
    expect(execution.steps.map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
    expect(existsSync(join(workspace, "sleep.pid"))).toBe(false);
  });

  // The step's own time budget is a real timer in the runner, so this run takes its 1s budget.
  it("still kills a step that exceeds its own time budget and reports the timeout", async () => {
    const workspace = await makeWorkspace();
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace, timeoutMs: 1_000 }));
    const execution = await executeRecordedWorkflow(PLAN, { inputs: {}, adapters });
    const pid = await sleepPid(workspace);
    expect(execution.status).toBe("failed");
    expect(execution.steps).toEqual([
      {
        stepId: "sleep",
        status: "failed",
        error: "recorded program exceeded its 1000ms time budget and was killed",
      },
      { stepId: "after", status: "skipped", reason: "an earlier step failed" },
    ]);
    await expectGone(pid);
    expect(existsSync(join(workspace, "ran"))).toBe(false);
  });
});
