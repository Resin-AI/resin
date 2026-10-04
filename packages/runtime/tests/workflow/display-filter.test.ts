import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedWorkflow, WorkflowStep } from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPromotedPlan } from "../../src/workflow/binding-validation.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import { runRecordedCall } from "../../src/workflow/program-runner.js";
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

/** A workspace with `./emit` printing three lines and `./fail` printing them, then exiting 1. */
async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "resin-display-filter-"));
  workspaces.push(workspace);
  await writeFile(join(workspace, "emit"), "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\n", { mode: 0o755 });
  await writeFile(join(workspace, "fail"), "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\nexit 1\n", {
    mode: 0o755,
  });
  return workspace;
}

/** A recorded bash step running `source` through its `command` argument, dropping its filter. */
function filteredStep(source: string): WorkflowStep {
  return {
    id: "emit",
    callId: "call-emit",
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source, argument: "command", dialect: "bash" },
    },
    arguments: [{ name: "command", source: { kind: "literal", value: source } }],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
    displayFilter: { version: 1 },
  };
}

describe.skipIf(process.platform === "win32")("display-filter steps", () => {
  it("returns the command's whole output, and the filtered output only under replay", async () => {
    const workspace = await makeWorkspace();
    const step = filteredStep("./emit | tail -1");
    const request = { step, arguments: { command: "./emit | tail -1" } };
    expect(await runRecordedCall(request, { cwd: workspace })).toBe("a\nb\nc\n");
    expect(
      await runRecordedCall({ ...request, applyDisplayFilter: true }, { cwd: workspace }),
    ).toBe("c\n");
  });

  it("fails on the command's own exit status in both modes", async () => {
    const workspace = await makeWorkspace();
    const step = filteredStep("./fail | tail -1");
    const request = { step, arguments: { command: "./fail | tail -1" } };
    await expect(runRecordedCall(request, { cwd: workspace })).rejects.toThrow(
      "step 'emit' failed: recorded shell program exited with code 1",
    );
    await expect(
      runRecordedCall({ ...request, applyDisplayFilter: true }, { cwd: workspace }),
    ).rejects.toThrow("step 'emit' failed: recorded shell program exited with code 1");
  });

  it("answers an empty result when the replayed grep matches nothing, as the recording did", async () => {
    const workspace = await makeWorkspace();
    const step = filteredStep("./emit | grep zzz");
    const request = { step, arguments: { command: "./emit | grep zzz" }, applyDisplayFilter: true };
    expect(await runRecordedCall(request, { cwd: workspace })).toBe("");
  });

  it("splits the resolved program, refusing one that no longer ends in the dropped filter", async () => {
    const workspace = await makeWorkspace();
    const step = filteredStep("./emit | tail -1");
    await expect(
      runRecordedCall({ step, arguments: { command: "./emit | wc -l" } }, { cwd: workspace }),
    ).rejects.toThrow(
      "step 'emit' cannot run: the program does not end in the display filter this step drops",
    );
  });

  it("applies the filter only when the execution options ask for it", async () => {
    const workspace = await makeWorkspace();
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf-display-filter",
      inputs: [],
      steps: [filteredStep("./emit | tail -1")],
    };
    const invoked = await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(invoked.status).toBe("completed");
    expect(invoked.result).toBe("a\nb\nc\n");
    const replayed = await executeRecordedWorkflow(plan, {
      inputs: {},
      adapters,
      applyDisplayFilters: true,
    });
    expect(replayed.result).toBe("c\n");
  });

  it("confirms a plan against a recording whose reference is the filtered output", async () => {
    const workspace = await makeWorkspace();
    const environment = (observed: string) => {
      const adapters = new RuntimeAdapterRegistry();
      adapters.register(createProcessAdapter({ cwd: workspace }));
      return { adapters, inputs: {}, observed: { emit: observed }, timeoutMs: 10_000 };
    };
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf-display-filter-confirm",
      inputs: [],
      steps: [filteredStep("./emit | tail -1")],
    };

    const confirmed = await confirmPromotedPlan({
      plan,
      accepted: [],
      environment: environment("c\n"),
    });
    expect(confirmed.verification.status).toBe("verified");
    expect(confirmed.verification.reproduced).toEqual(["emit"]);

    // A recording that printed something else is still missed.
    const missed = await confirmPromotedPlan({
      plan,
      accepted: [],
      environment: environment("b\n"),
    });
    expect(missed.verification.status).toBe("failed");

    // The command failing is a miss, never accepted, even when the filter would print the output.
    const failing = await confirmPromotedPlan({
      plan: { ...plan, steps: [filteredStep("./fail | tail -1")] },
      accepted: [],
      environment: environment("c\n"),
    });
    expect(failing.verification.status).toBe("failed");
  });
});
