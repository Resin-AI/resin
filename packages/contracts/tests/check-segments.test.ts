import { describe, expect, it } from "vitest";
import {
  OPTIONAL_CHECK_SEGMENTS_CAPABILITY,
  RECORDED_WORKFLOW_SCHEMA_VERSION,
  isCheckSegment,
  optionalSegmentProblem,
  validateRecordedWorkflow,
} from "../src/index.js";

describe("check segments", () => {
  it.each([
    "cargo fmt --check",
    "cargo fmt --all -- --check",
    "cargo clippy --all-targets -- -D warnings",
    "cargo +nightly clippy",
    "cargo test -p resin-core",
    "cargo test 2>&1 | tail -30",
    "cargo nextest run",
    "go test ./...",
    "go vet ./...",
    "pytest -q tests/test_a.py",
    "python -m pytest -x",
    "ruff check src",
    "ruff format --check src",
    "npx tsc --noEmit -p .",
    "pnpm exec eslint src",
    "pnpm test",
    "npm run lint",
    "pnpm run check:types",
    "pnpm test:coverage",
    "pnpm vitest run src/x.test.ts",
    "pnpm tsc --noEmit",
    "make test",
    "biome check src",
    "prettier --check .",
    "cat out/summary.txt",
    "git diff --stat",
  ])("is a check: %s", (text) => {
    expect(isCheckSegment(text)).toBe(true);
  });

  it.each([
    "cargo fmt",
    "cargo clippy --fix --allow-dirty",
    "cargo publish",
    "cargo test > out.txt",
    "go build ./...",
    "ruff check --fix src",
    "tsc -p .",
    "eslint --fix src",
    "prettier --write .",
    "biome check --write src",
    "npm run build",
    "npm install",
    "pnpm install",
    "make deploy",
    "vitest -u",
    "git push",
    "cargo test | tee log.txt",
    "./scripts/check.sh",
    "rm -rf target",
    "mkdir -p out",
  ])("is not a check: %s", (text) => {
    expect(isCheckSegment(text)).toBe(false);
  });

  it("lets a check be optional only when everything after it in the chain only checks", () => {
    expect(OPTIONAL_CHECK_SEGMENTS_CAPABILITY).toBe("optional-check-segments-v1");
    expect(optionalSegmentProblem("cargo fmt --check", ["cargo clippy", "cargo test"])).toBe(
      undefined,
    );
    expect(optionalSegmentProblem("mkdir -p out", ["./render out"])).toBe(undefined);
    expect(optionalSegmentProblem("cargo test", ["git push"])).toMatch(/not a check/);
    expect(optionalSegmentProblem("git push", [])).toMatch(/neither a mkdir -p setup nor a check/);
  });
});

/** Segment `index` of the recorded `cargo fmt --check && cargo clippy && cargo test && …` chain. */
const segment = (index: number, text: string, count: number, optional?: string) => ({
  id: `s${index}`,
  callId: "chain",
  callable: {
    runtime: "resin-process",
    name: "bash",
    program: { kind: "shell", source: text, argument: "command", dialect: "bash" },
  },
  arguments: [
    {
      name: "command",
      source: {
        kind: "template",
        template: {
          type: "program",
          language: "shell",
          source: { type: "literal", value: text },
          sourceReference: "private:chain",
          protectedTokens: [],
          holes: [],
        },
      },
    },
  ],
  dependsOn: [],
  failurePolicy: { onError: "abort", policy: "default" },
  observed: { outcome: "succeeded" },
  segment: { index, count, version: 4 },
  ...(optional === undefined ? {} : { optional: { input: optional } }),
});

function plan(texts: readonly string[], optional: Record<number, string>) {
  return {
    schemaVersion: RECORDED_WORKFLOW_SCHEMA_VERSION,
    workflowId: "wf",
    inputs: Object.values(optional).map((name) => ({ name, type: "boolean", default: true })),
    steps: texts.map((text, index) => segment(index, text, texts.length, optional[index])),
    privateReferences: ["private:chain"],
  };
}

describe("optional segment steps", () => {
  const checks = ["cargo fmt --check", "cargo clippy -- -D warnings", "cargo test"];

  it("accepts any check of a chain of checks as optional", () => {
    expect(validateRecordedWorkflow(plan(checks, { 0: "fmt", 1: "clippy" })).errors).toEqual([]);
    expect(validateRecordedWorkflow(plan(checks, { 2: "test" })).errors).toEqual([]);
  });

  it("refuses an optional check that gates a later command that is not a check", () => {
    const result = validateRecordedWorkflow(
      plan([...checks, "gh pr merge 18 --squash"], { 1: "clippy" }),
    );
    expect(result.errors).toEqual([
      "step s1 is a check segment followed by a segment that is not a check, so it cannot be optional",
    ]);
  });

  it("refuses an optional segment that changes state", () => {
    const result = validateRecordedWorkflow(plan(["cargo fmt", "cargo test"], { 0: "fmt" }));
    expect(result.errors).toEqual([
      "step s0 is a segment that is neither a mkdir -p setup nor a check, so it cannot be optional",
    ]);
  });

  it("refuses an optional check whose result another step reads", () => {
    const workflow = plan(checks, { 2: "test" });
    const reader = {
      ...segment(9, "x", 2),
      id: "read",
      callId: "reader",
      segment: undefined,
      arguments: [{ name: "path", source: { kind: "result", stepId: "s2", path: [] } }],
      callable: { runtime: "resin-harness-tool", name: "read" },
    };
    const { segment: _segment, ...unsegmented } = reader;
    const result = validateRecordedWorkflow({
      ...workflow,
      steps: [...workflow.steps, unsegmented],
    });
    expect(result.errors.join("\n")).toMatch(/binds the result of optional step s2/);
  });
});
