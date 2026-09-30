import { describe, expect, it } from "vitest";
import { type RecordedStep, renderRecordedSteps } from "../../src/proxy/local-executor.js";

const program = (index: number, size: number): RecordedStep => ({
  head: `Step ${index} runs this recorded shell program:`,
  body: `echo ${index}; `.padEnd(size, "x"),
});

describe("renderRecordedSteps", () => {
  it("shows steps whole when they fit the budget", () => {
    const steps = [program(1, 300), program(2, 200)];
    expect(renderRecordedSteps(steps, 2000)).toBe(
      `${steps[0]!.head}\n${steps[0]!.body}\n${steps[1]!.head}\n${steps[1]!.body}`,
    );
  });

  it("shrinks every step's preview together so the last step is still listed", () => {
    const steps = Array.from({ length: 6 }, (_, index) => program(index + 1, 900));
    const shown = renderRecordedSteps(steps, 2000);
    expect(shown.length).toBeLessThanOrEqual(2000);
    for (let index = 1; index <= 6; index += 1) {
      expect(shown).toContain(`Step ${index} runs this recorded shell program:\necho ${index}; `);
    }
    expect(shown).toContain("\n[...]");
  });

  it("counts the steps that cannot fit even at the smallest preview", () => {
    const steps = Array.from({ length: 30 }, (_, index) => program(index + 1, 900));
    const shown = renderRecordedSteps(steps, 1000);
    expect(shown).toContain("Step 1 runs this recorded shell program:");
    expect(shown).not.toContain("Step 30 runs");
    const counted = /\[(\d+) more steps not shown\]$/.exec(shown);
    expect(counted).not.toBeNull();
    const listed = shown.match(/^Step \d+ runs/gm)?.length ?? 0;
    expect(listed + Number(counted![1])).toBe(30);
    expect(shown.length).toBeLessThanOrEqual(1000 + "\n[29 more steps not shown]".length);
  });

  it("keeps the first step even when it alone exceeds the budget", () => {
    const shown = renderRecordedSteps([program(1, 900), program(2, 900)], 60);
    expect(shown.startsWith("Step 1 runs this recorded shell program:")).toBe(true);
    expect(shown.endsWith("[1 more step not shown]")).toBe(true);
  });
});
