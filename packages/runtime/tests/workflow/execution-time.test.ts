import { setTimeout as sleep } from "node:timers/promises";
import type { WorkflowStep } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  RecordedExecutionClock,
  beginRecordedCall,
  timeRecordedCall,
} from "../../src/workflow/execution-time.js";
import { runRecordedCall } from "../../src/workflow/program-runner.js";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
} from "../../src/workflow/runtime-families.js";
import { createToolProtocolAdapter } from "../../src/workflow/tool-protocol-adapter.js";

function shellStep(source: string): WorkflowStep {
  return {
    id: "run",
    callId: "call-run",
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source, argument: "command", dialect: "sh" },
    },
    arguments: [{ name: "command", source: { kind: "literal", value: source } }],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  };
}

describe("RecordedExecutionClock", () => {
  it("times a recorded program from launch to completion, not the work around it", async () => {
    const clock = new RecordedExecutionClock();
    const started = performance.now();
    await clock.run(async () => {
      // Resin's own work before and after the call: setup, then report building.
      await sleep(150);
      const value = await runRecordedCall(
        { step: shellStep("sleep 0.2; echo done"), arguments: { command: "sleep 0.2; echo done" } },
        { cwd: process.cwd() },
      );
      expect(value).toBe("done\n");
      await sleep(300);
    });
    const total = performance.now() - started;
    const execution = clock.durationMs();
    expect(total).toBeGreaterThanOrEqual(640);
    expect(execution).toBeDefined();
    expect(execution).toBeGreaterThanOrEqual(190);
    // The 450 ms of surrounding work is never counted, however long the program takes under load.
    expect(total - (execution ?? 0)).toBeGreaterThanOrEqual(445);
    expect(Number.isInteger(execution)).toBe(true);
  });

  it("adds sequential calls and counts concurrent calls once", async () => {
    const sequential = new RecordedExecutionClock();
    await sequential.run(async () => {
      await timeRecordedCall(() => sleep(100));
      await timeRecordedCall(() => sleep(100));
    });
    expect(sequential.durationMs()).toBeGreaterThanOrEqual(195);

    const concurrent = new RecordedExecutionClock();
    await concurrent.run(async () => {
      await Promise.all([timeRecordedCall(() => sleep(150)), timeRecordedCall(() => sleep(150))]);
    });
    const union = concurrent.durationMs() ?? 0;
    expect(union).toBeGreaterThanOrEqual(145);
    expect(union).toBeLessThan(280);
  });

  it("reports nothing when no recorded call started, and records nothing outside a clock", async () => {
    const clock = new RecordedExecutionClock();
    await clock.run(async () => {
      await sleep(20);
    });
    expect(clock.durationMs()).toBeUndefined();

    // Outside any invocation the call still runs; there is just no clock to mark.
    expect(await timeRecordedCall(async () => "ran")).toBe("ran");
    beginRecordedCall()();
    expect(clock.durationMs()).toBeUndefined();
  });

  it("keeps concurrent invocations' clocks apart", async () => {
    const fast = new RecordedExecutionClock();
    const slow = new RecordedExecutionClock();
    await Promise.all([
      fast.run(() => timeRecordedCall(() => sleep(30))),
      slow.run(() => timeRecordedCall(() => sleep(200))),
    ]);
    expect(fast.durationMs()).toBeLessThan(150);
    expect(slow.durationMs()).toBeGreaterThanOrEqual(195);
  });

  it("times a recorded tool call through the host dispatcher, even when it fails", async () => {
    const adapter = createToolProtocolAdapter({
      dispatch: async () => {
        await sleep(120);
        throw new Error("upstream failed");
      },
    });
    const clock = new RecordedExecutionClock();
    await expect(
      clock.run(() =>
        adapter.call({
          step: {
            ...shellStep("unused"),
            callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "lint" },
          },
          arguments: {},
        }),
      ),
    ).rejects.toThrow("upstream failed");
    expect(clock.durationMs()).toBeGreaterThanOrEqual(115);
  });
});
