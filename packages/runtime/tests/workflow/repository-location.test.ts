import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RecordedWorkflow,
  WorkflowArgument,
  WorkflowStep,
  WorkflowStepLocation,
} from "@resin/contracts";
import {
  clearRepositoryIdentityCache,
  repositoryIdentity,
} from "@resin/observer/repository-identity";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";
import { workflowLocationAvailability } from "../../src/workflow/repository-location.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/workflow/runtime-families.js";

const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};

beforeAll(() => {
  for (const [name, value] of Object.entries(GIT_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  clearRepositoryIdentityCache();
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `resin-loc-${label}-`)));
  scratch.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

/** A repository with one commit and a `pkg/app` directory; `seed` makes its root commit unique. */
function makeRepository(seed: string): string {
  const root = tempDir(`repo-${seed}`);
  git(root, "init", "-q");
  fs.mkdirSync(path.join(root, "pkg", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "app", "README"), `${seed}\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", `seed ${seed}`);
  return root;
}

function addWorktree(repository: string): string {
  const parent = tempDir("worktree");
  const worktree = path.join(parent, "checkout");
  git(repository, "worktree", "add", "-q", worktree);
  return worktree;
}

function shellStep(
  id: string,
  source: string,
  options: { location?: WorkflowStepLocation; arguments?: WorkflowArgument[] } = {},
): WorkflowStep {
  return {
    id,
    callId: `call-${id}`,
    callable: { runtime: RESIN_PROCESS_RUNTIME, name: "bash", program: { kind: "shell", source } },
    arguments: options.arguments ?? [],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
    ...(options.location === undefined ? {} : { location: options.location }),
  };
}

function plan(...steps: WorkflowStep[]): RecordedWorkflow {
  return { schemaVersion: 1, workflowId: "wf-location", inputs: [], steps } as RecordedWorkflow;
}

function adapters(cwd: string): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register(createProcessAdapter({ cwd }));
  return registry;
}

describe("located steps run in the caller's checkout", () => {
  it("runs a location step at <caller root>/<path> of another worktree of the same repository", async () => {
    const recorded = makeRepository("alpha");
    const caller = addWorktree(recorded);
    const identity = repositoryIdentity(caller);
    expect(identity?.id).toBe(repositoryIdentity(recorded)?.id);
    const elsewhere = tempDir("elsewhere");

    const run = await executeRecordedWorkflow(
      plan(
        shellStep("where", "pwd", {
          location: { base: "repository", repository: identity!.id, path: "pkg/app" },
        }),
      ),
      { inputs: {}, adapters: adapters(elsewhere), repository: { caller: identity } },
    );

    expect(run.status).toBe("completed");
    expect(String(run.result).trim()).toBe(path.join(caller, "pkg", "app"));
  });

  it("overrides a recorded working-directory argument with the located directory", async () => {
    const recorded = makeRepository("beta");
    const identity = repositoryIdentity(recorded)!;
    const step: WorkflowStep = {
      ...shellStep("where", "", {
        location: { base: "repository", repository: identity.id, path: "pkg" },
        arguments: [
          { name: "cmd", source: { kind: "literal", value: "pwd" } },
          { name: "workdir", source: { kind: "literal", value: "/synthetic/deleted/checkout" } },
        ],
      }),
    };
    step.callable = {
      ...step.callable,
      name: "command_exec",
      program: { kind: "shell", source: "", argument: "cmd" },
    };
    const seen: Array<Record<string, unknown>> = [];
    const registry = new RuntimeAdapterRegistry();
    const inner = createProcessAdapter({ cwd: tempDir("default") });
    registry.register({
      runtime: RESIN_PROCESS_RUNTIME,
      call: async (request) => {
        seen.push({ ...request.arguments, workingDirectory: request.workingDirectory });
        return inner.call(request);
      },
    });

    const run = await executeRecordedWorkflow(plan(step), {
      inputs: {},
      adapters: registry,
      repository: { caller: identity },
    });

    expect(run.status).toBe("completed");
    expect(String(run.result).trim()).toBe(path.join(recorded, "pkg"));
    expect(seen[0]?.workdir).toBe(path.join(recorded, "pkg"));
    expect(seen[0]?.workingDirectory).toBe(path.join(recorded, "pkg"));
  });

  it("drops a recorded absolute leading cd and runs the rest in the caller's checkout", async () => {
    const recorded = makeRepository("gamma");
    const caller = addWorktree(recorded);
    const identity = repositoryIdentity(caller)!;
    // The recording's checkout is gone: the absolute cd would fail anywhere.
    const program = "cd /synthetic/deleted-scratch/worktree/pkg/app && pwd && ls";

    const run = await executeRecordedWorkflow(
      plan(
        shellStep("relocated", program, {
          location: {
            base: "repository",
            repository: identity.id,
            path: "pkg/app",
            leadingCd: true,
          },
        }),
      ),
      { inputs: {}, adapters: adapters(tempDir("elsewhere")), repository: { caller: identity } },
    );

    expect(run.status).toBe("completed");
    expect(String(run.result)).toBe(`${path.join(caller, "pkg", "app")}\nREADME\n`);
  });

  it("refuses to run anything when the caller is in another repository", async () => {
    const recorded = makeRepository("delta");
    const other = makeRepository("epsilon");
    const marker = path.join(tempDir("marker"), "ran");
    const located = plan(
      shellStep("first", `touch ${marker}`),
      shellStep("where", "pwd", {
        location: {
          base: "repository",
          repository: repositoryIdentity(recorded)!.id,
          path: "pkg",
        },
      }),
    );

    const run = await executeRecordedWorkflow(located, {
      inputs: {},
      adapters: adapters(other),
      repository: { caller: repositoryIdentity(other) },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/cannot run here: .*different repository/);
    expect(run.steps.every((step) => step.status === "skipped")).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("is unavailable when the caller is outside git or the directory is missing", () => {
    const recorded = makeRepository("zeta");
    const identity = repositoryIdentity(recorded)!;
    const missing = plan(
      shellStep("where", "pwd", {
        location: { base: "repository", repository: identity.id, path: "pkg/missing" },
      }),
    );
    expect(workflowLocationAvailability(missing, { repository: identity })).toEqual({
      available: false,
      reason: "its directory 'pkg/missing' does not exist in the caller's checkout",
    });
    const present = plan(
      shellStep("where", "pwd", {
        location: { base: "repository", repository: identity.id, path: "pkg" },
      }),
    );
    expect(workflowLocationAvailability(present, { repository: identity })).toEqual({
      available: true,
    });
    const outside = workflowLocationAvailability(present, {
      repository: repositoryIdentity(tempDir("plain")),
    });
    expect(outside.available).toBe(false);
  });
});

describe("plans without a location", () => {
  it("run exactly as before, with or without a caller checkout", async () => {
    const workspace = tempDir("legacy");
    const legacy = plan(shellStep("where", "pwd"));
    for (const options of [{}, { repository: { caller: undefined } }]) {
      const run = await executeRecordedWorkflow(legacy, {
        inputs: {},
        adapters: adapters(workspace),
        ...options,
      });
      expect(run.status).toBe("completed");
      expect(String(run.result).trim()).toBe(workspace);
    }
  });

  it("ignores locations in replays that give no caller checkout", async () => {
    const workspace = tempDir("replay");
    const run = await executeRecordedWorkflow(
      plan(
        shellStep("where", "pwd", {
          location: { base: "repository", repository: "a".repeat(64), path: "pkg" },
        }),
      ),
      { inputs: {}, adapters: adapters(workspace) },
    );
    expect(String(run.result).trim()).toBe(workspace);
  });

  it("are unavailable when pinned to a recorded directory that no longer exists", () => {
    const caller = repositoryIdentity(makeRepository("eta"));
    expect(
      workflowLocationAvailability(
        plan(shellStep("tests", "cd /synthetic/deleted-scratch/wt/apps/web && npx vitest run")),
        { repository: caller },
      ),
    ).toEqual({
      available: false,
      reason: "it runs in a directory recorded on another checkout that does not exist here",
    });
    const pinnedArgument = plan(
      shellStep("tests", "npx vitest run", {
        arguments: [{ name: "cwd", source: { kind: "private", reference: "ref:scope:cwd" } }],
      }),
    );
    expect(
      workflowLocationAvailability(
        pinnedArgument,
        { repository: caller },
        { resolvePrivate: () => "/synthetic/deleted-scratch/wt" },
      ).available,
    ).toBe(false);
  });

  it("are unavailable when pinned to a checkout of another repository, available in their own", () => {
    const pinned = makeRepository("theta");
    const legacy = plan(shellStep("tests", `cd ${pinned}/pkg && pwd`));
    expect(
      workflowLocationAvailability(legacy, {
        repository: repositoryIdentity(makeRepository("iota")),
      }),
    ).toEqual({
      available: false,
      reason: "it runs in a checkout of a different repository than the caller's",
    });
    expect(
      workflowLocationAvailability(legacy, { repository: repositoryIdentity(addWorktree(pinned)) }),
    ).toEqual({ available: true });
    // A plan that names no directory is runnable anywhere, as before.
    expect(
      workflowLocationAvailability(plan(shellStep("ls", "ls")), { repository: undefined }),
    ).toEqual({ available: true });
  });
});
