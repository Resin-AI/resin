import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedWorkflow, WorkflowStep } from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPromotedPlan } from "../../src/workflow/binding-validation.js";
import { displayFilterStages } from "../../src/workflow/display-filter-replay.js";
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

/**
 * A workspace with `./emit` printing three lines, `./fail` printing them, then exiting 1, and
 * `./diagnose` doing so with a diagnostic on stderr.
 */
async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "resin-display-filter-"));
  workspaces.push(workspace);
  await writeFile(join(workspace, "emit"), "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\n", { mode: 0o755 });
  await writeFile(join(workspace, "fail"), "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\nexit 1\n", {
    mode: 0o755,
  });
  await writeFile(
    join(workspace, "diagnose"),
    "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\necho 'diagnose: 2 tests failed' >&2\nexit 1\n",
    { mode: 0o755 },
  );
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
      await runRecordedCall({ ...request, displayFilter: "replay" as const }, { cwd: workspace }),
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
      runRecordedCall({ ...request, displayFilter: "replay" as const }, { cwd: workspace }),
    ).rejects.toThrow("step 'emit' failed: recorded shell program exited with code 1");
  });

  it("answers an empty result when the replayed grep matches nothing, as the recording did", async () => {
    const workspace = await makeWorkspace();
    const step = filteredStep("./emit | grep zzz");
    const request = {
      step,
      arguments: { command: "./emit | grep zzz" },
      displayFilter: "replay" as const,
    };
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

  it("pipes the command's output through the filter when the caller switches it on through its input", async () => {
    const workspace = await makeWorkspace();
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: workspace }));
    const step: WorkflowStep = {
      ...filteredStep("./emit | tail -1"),
      // The filter's own value is the caller's: `tail -{lines}`.
      arguments: [
        {
          name: "command",
          source: {
            kind: "template",
            template: {
              type: "text",
              parts: [
                { type: "literal", value: "./emit | tail -" },
                { type: "input", name: "lines" },
              ],
            },
          },
        },
      ],
      displayFilter: { version: 1, input: "filter_output" },
    };
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf-display-filter-input",
      inputs: [
        { name: "lines", type: "string", default: "1" },
        { name: "filter_output", type: "boolean", default: false },
      ],
      steps: [step],
    };
    const omitted = await executeRecordedWorkflow(plan, { inputs: { lines: "2" }, adapters });
    expect(omitted.result).toBe("a\nb\nc\n");
    const off = await executeRecordedWorkflow(plan, {
      inputs: { lines: "2", filter_output: false },
      adapters,
    });
    expect(off.result).toBe("a\nb\nc\n");
    const on = await executeRecordedWorkflow(plan, {
      inputs: { lines: "2", filter_output: true },
      adapters,
    });
    expect(on.result).toBe("b\nc\n");
    // Replay always pipes the command's output through the filter, whatever the input says.
    const replayed = await executeRecordedWorkflow(plan, {
      inputs: { lines: "2", filter_output: false },
      adapters,
      applyDisplayFilters: true,
    });
    expect(replayed.result).toBe("b\nc\n");
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

describe.skipIf(process.platform === "win32").each([1, 2])(
  "display-filter version %i step outcomes",
  (version) => {
    /** A step of `version` running `source`, its filter switched on through `filter_output`. */
    const call = async (source: string, displayFilter?: "whole" | "replay") => {
      const cwd = await makeWorkspace();
      return runRecordedCall(
        {
          step: { ...filteredStep(source), displayFilter: { version, input: "filter_output" } },
          arguments: { command: source },
          ...(displayFilter === undefined ? {} : { displayFilter }),
        },
        { cwd, invocationOutputRoot: join(cwd, ".invocation-output") },
      );
    };

    it("succeeds with empty output when a switched-on grep selects nothing", async () => {
      for (const mode of ["whole", "replay"] as const) {
        expect(await call("./emit | grep zzz", mode), mode).toBe("");
        // A grep in the middle of the filter selecting nothing leaves the rest nothing to print.
        expect(await call("./emit | grep zzz | head -2", mode), mode).toBe("");
      }
    });

    it("fails on the command's own status with its diagnostics, though the filter selects its output", async () => {
      for (const mode of version === 1
        ? (["whole", "replay", undefined] as const)
        : (["whole", "replay"] as const)) {
        await expect(call("./fail | grep a", mode), mode).rejects.toThrow(
          /^step 'emit' failed: recorded shell program exited with code 1: a\nb\nc$/,
        );
        await expect(call("./diagnose | grep a", mode), mode).rejects.toThrow(
          /^step 'emit' failed: recorded shell program exited with code 1: diagnose: 2 tests failed$/,
        );
      }
      if (version === 2) {
        // An invocation runs the filter inline: the command's own failure still fails the step.
        await expect(call("./fail | grep a")).rejects.toThrow(
          /^step 'emit' failed: command 1 \(\.\/fail\) exited 1; the program exited 0\.\n/,
        );
        await expect(call("./diagnose | grep a")).rejects.toThrow(/diagnose: 2 tests failed/);
      }
    });

    it("answers a normal invocation as the recorded program did", async () => {
      if (version === 1) {
        // Version 1 runs the command alone and returns its whole output.
        expect(await call("./emit | grep zzz")).toBe("a\nb\nc\n");
        expect(await call("./emit | grep -E '('")).toBe("a\nb\nc\n");
        return;
      }
      // Version 2 runs the filter inline: its status is the program's, as it was recorded.
      await expect(call("./emit | grep zzz")).rejects.toThrow(
        /^step 'emit' failed: the program exited 1\.\n[\s\S]*Output:\n\(none: the program printed nothing\)/,
      );
      await expect(call("./emit | grep -E '('")).rejects.toThrow(
        /^step 'emit' failed: the program exited 2\./,
      );
    });

    it("fails naming the filter stage when the filter itself errs", async () => {
      for (const mode of ["whole", "replay"] as const) {
        // grep exits 2 on an invalid pattern: an error, never "no lines selected".
        for (const source of ["./emit | grep -E '('", "./emit | grep -E '(' | head -5"]) {
          await expect(call(source, mode), `${mode}: ${source}`).rejects.toThrow(
            /^step 'emit' failed: its display filter `grep -E '\('` exited with code 2: .*grep/,
          );
        }
        // Any non-zero status of a filter that is not a grep is an error.
        await expect(call("./emit | head -2 | tail -n x", mode), mode).rejects.toThrow(
          /^step 'emit' failed: its display filter `tail -n x` exited with code 1: .*tail/,
        );
      }
    });
  },
);

describe("display-filter stages", () => {
  it("splits a dropped filter at its top-level pipes, naming each stage's command", () => {
    expect(displayFilterStages("tail -30")).toEqual([{ source: "tail -30", command: "tail" }]);
    expect(displayFilterStages(`grep -E "×|FAIL" | head -40`)).toEqual([
      { source: `grep -E "×|FAIL"`, command: "grep" },
      { source: "head -40", command: "head" },
    ]);
    expect(displayFilterStages("egrep 'a|b'|'fgrep' -v wip\t|tail -2")).toEqual([
      { source: "egrep 'a|b'", command: "egrep" },
      { source: "'fgrep' -v wip", command: "fgrep" },
      { source: "tail -2", command: "tail" },
    ]);
    // A version-2 filter may continue a line, break it after `|`, or carry a comment.
    expect(displayFilterStages("\\\n grep b |\n  head -n 1")).toEqual([
      { source: "\\\n grep b", command: "grep" },
      { source: "head -n 1", command: "head" },
    ]);
    expect(displayFilterStages("# c|d\n grep b | head -1")).toEqual([
      { source: "# c|d\n grep b", command: "grep" },
      { source: "head -1", command: "head" },
    ]);
  });

  it("refuses a text no splitter produces", () => {
    for (const filter of ["", "grep 'x", "grep x |", "| head"]) {
      expect(() => displayFilterStages(filter), filter).toThrow("is not a pipeline of commands");
    }
  });
});
