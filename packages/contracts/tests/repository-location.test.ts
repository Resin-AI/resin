import { describe, expect, it } from "vitest";
import {
  type RecordedWorkflow,
  type WorkflowStep,
  isRepositoryRelativePath,
  readRepositoryLocationMetadata,
  splitLeadingCd,
  validateRecordedWorkflow,
  workflowLocationRepositories,
} from "../src/index.js";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function step(id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id,
    callId: `call-${id}`,
    callable: {
      runtime: "resin-process",
      name: "bash",
      program: { kind: "shell", source: "pnpm test" },
    },
    arguments: [],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
    ...extra,
  };
}

function plan(...steps: WorkflowStep[]): RecordedWorkflow {
  return { schemaVersion: 1, workflowId: "wf", inputs: [], steps } as RecordedWorkflow;
}

describe("splitLeadingCd", () => {
  it.each([
    ["cd /work/repo/apps/web && npx vitest run", "/work/repo/apps/web", false, "npx vitest run"],
    [
      "cd $HOME/.cache/x/wt/apps/cloud && npx vitest",
      "/.cache/x/wt/apps/cloud",
      true,
      "npx vitest",
    ],
    ["cd ${HOME}/src; make", "/src", true, "make"],
    ["cd ~/src/app\nmake test", "/src/app", true, "make test"],
    ["cd ~ && ls", "", true, "ls"],
    ["  cd -- '/with space/dir' && ls -la", "/with space/dir", false, "ls -la"],
    ['cd "$HOME/my dir" && ls', "/my dir", true, "ls"],
    ["cd apps/web && pnpm build", "apps/web", false, "pnpm build"],
    ["cd /a&&b", "/a", false, "b"],
  ])("splits %j", (program, directory, home, rest) => {
    expect(splitLeadingCd(program)).toEqual({ directory, home, rest });
  });

  it.each([
    "cd /a",
    "cd /a && ",
    "cd - && ls",
    "cd $DIR && ls",
    "cd $HOMEDIR && ls",
    "cd ~other/x && ls",
    'cd "~/x" && ls',
    "cd /a /b && ls",
    "cd /a || ls",
    "cd /a | ls",
    "cd `pwd` && ls",
    "cd /a* && ls",
    "pushd /a && ls",
    "ls && cd /a && ls",
    "cd $HOME/a$b && ls",
  ])("leaves %j as written", (program) => {
    expect(splitLeadingCd(program)).toBeUndefined();
  });
});

describe("repository location carrier", () => {
  it("admits exactly the frozen shape", () => {
    expect(readRepositoryLocationMetadata({ id: ID_A, path: "" })).toEqual({ id: ID_A, path: "" });
    expect(readRepositoryLocationMetadata({ id: ID_A, path: "a/b", leadingCd: true })).toEqual({
      id: ID_A,
      path: "a/b",
      leadingCd: true,
    });
    for (const bad of [
      { id: ID_A.slice(1), path: "" },
      { id: ID_A, path: "/abs" },
      { id: ID_A, path: "a/../b" },
      { id: ID_A, path: "a//b" },
      { id: ID_A, path: "a/" },
      { id: ID_A, path: "a\\b" },
      { id: ID_A, path: "a\nb" },
      { id: ID_A, path: "x".repeat(1025) },
      { id: ID_A, path: "", extra: 1 },
    ]) {
      expect(readRepositoryLocationMetadata(bad)).toBeUndefined();
    }
    expect(isRepositoryRelativePath("apps/web")).toBe(true);
    expect(isRepositoryRelativePath("./apps")).toBe(false);
  });
});

describe("WorkflowStep.location validation", () => {
  it("accepts a located program step and plans without any location", () => {
    expect(validateRecordedWorkflow(plan(step("s1"))).errors).toEqual([]);
    const located = plan(
      step("s1", { location: { base: "repository", repository: ID_A, path: "apps/web" } }),
      step("s2", {
        location: { base: "repository", repository: ID_A, path: "", leadingCd: true },
      }),
    );
    expect(validateRecordedWorkflow(located).errors).toEqual([]);
    expect(workflowLocationRepositories(located)).toEqual([ID_A]);
  });

  it("refuses malformed locations, locations off program steps and mixed repositories", () => {
    const cases: Array<[RecordedWorkflow, RegExp]> = [
      [
        plan(step("s1", { location: { base: "workspace", repository: ID_A, path: "" } as never })),
        /location base must be 'repository'/,
      ],
      [
        plan(step("s1", { location: { base: "repository", repository: ID_A, path: "/abs" } })),
        /location path must be/,
      ],
      [
        plan(
          step("s1", {
            callable: { runtime: "resin-invoke-tool", name: "search" },
            location: { base: "repository", repository: ID_A, path: "" },
          }),
        ),
        /only valid on a recorded program step/,
      ],
      [
        plan(
          step("s1", { location: { base: "repository", repository: ID_A, path: "" } }),
          step("s2", { location: { base: "repository", repository: ID_B, path: "" } }),
        ),
        /same repository/,
      ],
    ];
    for (const [workflow, error] of cases) {
      const result = validateRecordedWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.join("\n")).toMatch(error);
    }
  });
});
