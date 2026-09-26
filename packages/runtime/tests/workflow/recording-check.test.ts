/**
 * A recorded position whose value came from an earlier step's output verifies only when the plan
 * reads it from that step (a result, extract or derivation binding) at exactly that position.
 */
import type { WorkflowStep, WorkflowValuePath, WorkflowValueTemplate } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createRecordingCheckAdapter } from "../../src/workflow/recording-check.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

const COMMAND = "./deployctl wait --id=dep-4f2a91";

type Hole = Extract<WorkflowValueTemplate, { type: "program" }>["holes"][number];

function step(holes: Hole[]): WorkflowStep {
  return {
    id: "wait",
    callId: "wait",
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source: COMMAND, argument: "command" },
    },
    arguments: [
      {
        name: "command",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "shell",
            source: { type: "literal", value: COMMAND },
            holes,
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
  } as unknown as WorkflowStep;
}

async function check(holes: Hole[], dependency: WorkflowValuePath): Promise<unknown> {
  const adapter = createRecordingCheckAdapter(
    RESIN_PROCESS_RUNTIME,
    new Map([
      [
        "wait",
        {
          callable: { name: "bash", program: { kind: "shell", argument: "command" } },
          arguments: { command: COMMAND },
          result: "healthy",
          hiddenDependencies: [{ argument: "command", path: dependency }],
        },
      ],
    ]),
  );
  return await adapter.call({ step: step(holes), arguments: { command: COMMAND } });
}

const FROM_CREATE: WorkflowValueTemplate = { type: "result", stepId: "create", path: [] };
const EXTRACTED: WorkflowValueTemplate = {
  type: "extract",
  stepId: "create",
  locator: "private:v2:value:locator",
};
const SPAN: WorkflowValuePath = ["tokens", 2, "span", 5, 15];

describe("a hidden dependency in the recording", () => {
  it("verifies when the hole at that token reads the earlier step", async () => {
    await expect(check([{ token: 2, binding: FROM_CREATE }], ["tokens", 2])).resolves.toBe(
      "healthy",
    );
    await expect(check([{ token: 2, binding: EXTRACTED }], ["tokens", 2])).resolves.toBe("healthy");
  });

  it("is refused when the hole at that token binds the recorded text or anything unbound", async () => {
    for (const binding of [
      { type: "literal", value: "--id=dep-4f2a91" },
      { type: "private", reference: "private:v2:value:x" },
      { type: "unresolved", reason: "unknown" },
    ] as WorkflowValueTemplate[]) {
      await expect(check([{ token: 2, binding }], ["tokens", 2])).rejects.toThrow(/earlier step/);
    }
  });

  it("is refused when the only hole at that token is an input, as a recorded default is", async () => {
    await expect(
      check([{ token: 2, binding: { type: "input", name: "id" } }], ["tokens", 2]),
    ).rejects.toThrow(/earlier step/);
  });

  it("requires the hole to cover the dependency's span", async () => {
    await expect(
      check([{ token: 2, span: { start: 0, end: 4 }, binding: EXTRACTED }], SPAN),
    ).rejects.toThrow(/earlier step/);
    await expect(
      check([{ token: 2, span: { start: 5, end: 15 }, binding: EXTRACTED }], SPAN),
    ).resolves.toBe("healthy");
    await expect(check([{ token: 2, binding: EXTRACTED }], SPAN)).resolves.toBe("healthy");
    // A span hole does not bind the whole token.
    await expect(
      check([{ token: 2, span: { start: 5, end: 15 }, binding: EXTRACTED }], ["tokens", 2]),
    ).rejects.toThrow(/earlier step/);
  });
});
