import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OmpHarnessAdapter } from "@resin/adapter-omp";
import type { RecordedWorkflow } from "@resin/contracts";
import type { HarnessAdapter, HarnessSession, HarnessWorkspace } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryPrivateValueStore,
  type PrivateValueRepresentation,
} from "../../src/analytics/private-value-store.js";
import { createRecordedWorkflowWorkspaceResolver } from "../../src/analytics/recorded-workflow-workspace-resolver.js";
import { workflowPrivateReference } from "../../src/analytics/workflow-private-reference.js";

const ownerWorkspaceId = "paired-cloud-workspace";
const timestamp = "2026-09-22T00:00:00.000Z";

type ProjectFixture = {
  localWorkspaceId: string;
  rootPath: string;
  sessionIds: string[];
};

function discoveredAdapter(projects: readonly ProjectFixture[]) {
  const workspaces: HarnessWorkspace[] = projects.map((project) => ({
    workspaceId: project.localWorkspaceId,
    rootPath: project.rootPath,
    name: project.localWorkspaceId,
    harnessId: "fake-harness",
    configPath: `${project.rootPath}/harness.json`,
    metadata: {},
  }));
  const sessionsByWorkspace = new Map<string, HarnessSession[]>();
  for (const project of projects) {
    sessionsByWorkspace.set(
      project.localWorkspaceId,
      project.sessionIds.map((sessionId) => ({
        sessionId,
        workspaceId: project.localWorkspaceId,
        harnessId: "fake-harness",
        transcriptPath: `${project.rootPath}/${sessionId}.jsonl`,
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      })),
    );
  }
  const adapter: HarnessAdapter = {
    version: "test",
    async listWorkspaces() {
      return workspaces;
    },
    async listSessions(workspace) {
      return sessionsByWorkspace.get(workspace.workspaceId) ?? [];
    },
  };
  return { adapter };
}

function programPlan(
  store: InMemoryPrivateValueStore,
  sessionId: string,
  label: string,
  options: {
    sourceSessionId?: string;
    setupSessionId?: string;
    sourceWorkspaceId?: string;
    setupWorkspaceId?: string;
    baselineWorkspaceId?: string;
    sourceRepresentation?: PrivateValueRepresentation;
    privateSource?: boolean;
    omitSource?: boolean;
    baselineSlot?: "result" | "native-result:v1:exact" | "native-result:v1:text-trim";
  } = {},
): RecordedWorkflow {
  const sourceSessionId = options.sourceSessionId ?? sessionId;
  const setupSessionId = options.setupSessionId ?? sessionId;
  const targetCallId = `${label}-target-call`;
  const setupCallId = `${label}-setup-call`;
  const sourceRepresentation = options.sourceRepresentation ?? "literal";
  const baselineSlot = options.baselineSlot ?? "native-result:v1:exact";
  const sourceReference = workflowPrivateReference(
    "value",
    ownerWorkspaceId,
    sourceRepresentation,
    [sourceSessionId, targetCallId, ["code"]],
  );
  const setupReference = workflowPrivateReference("value", ownerWorkspaceId, "literal", [
    setupSessionId,
    setupCallId,
    ["code"],
  ]);
  const baselineReference = workflowPrivateReference("demonstration", ownerWorkspaceId, "literal", [
    sourceSessionId,
    targetCallId,
    baselineSlot,
  ]);

  if (!options.omitSource) {
    store.set(
      sourceReference,
      "print('recorded source')",
      { workspaceId: options.sourceWorkspaceId ?? ownerWorkspaceId },
      sourceRepresentation,
    );
  }
  store.set(
    setupReference,
    "import json",
    { workspaceId: options.setupWorkspaceId ?? ownerWorkspaceId },
    "literal",
  );
  store.set(
    baselineReference,
    "recorded result",
    { workspaceId: options.baselineWorkspaceId ?? ownerWorkspaceId },
    "literal",
  );

  const argumentSource =
    options.privateSource === false
      ? { kind: "template" as const, template: { type: "literal" as const, value: "print(1)" } }
      : {
          kind: "template" as const,
          template: { type: "private" as const, reference: sourceReference },
        };
  const privateReferences = [setupReference, baselineReference];
  if (options.privateSource !== false) privateReferences.push(sourceReference);

  return {
    schemaVersion: 1,
    workflowId: `workflow-${label}`,
    inputs: [],
    privateReferences,
    steps: [
      {
        id: "step0",
        callId: targetCallId,
        callable: {
          runtime: "program",
          name: "python-runner",
          program: {
            kind: "python",
            source: "",
            argument: "code",
            // Caller-provided cwd must not influence the resolver's host-discovered result.
            cwd: "/polling-project/not-the-recorded-root",
            pythonState: {
              schemaVersion: 1,
              status: "closed",
              unresolvedReadCount: 0,
              setup: [
                {
                  callId: setupCallId,
                  sourceEventId: `${label}-setup-source-event`,
                  resultEventId: `${label}-setup-result-event`,
                  reference: setupReference,
                },
              ],
            },
          },
        },
        arguments: [{ name: "code", source: argumentSource }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded" },
      },
    ],
    baseline: {
      inputs: [],
      observed: [
        {
          stepId: "step0",
          reference: baselineReference,
          ...(baselineSlot === "native-result:v1:text-trim"
            ? { comparison: "text-trim" as const }
            : {}),
        },
      ],
    },
  };
}

describe("recorded workflow workspace resolution", () => {
  it("binds real OMP recordings to their own roots when workspace labels collide", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recorded-omp-projects-"));
    try {
      const ompHome = path.join(directory, ".omp");
      const sessionDirectory = path.join(ompHome, "agent", "sessions", "shared-project");
      await fs.mkdir(sessionDirectory, { recursive: true });
      const projectA = path.join(directory, "project-a");
      const projectB = path.join(directory, "project", "a");
      const projects = [
        { root: projectA, sessionId: "recorded-session-a" },
        { root: projectB, sessionId: "recorded-session-b" },
      ];
      for (const project of projects) {
        await fs.mkdir(project.root, { recursive: true });
        await fs.writeFile(
          path.join(sessionDirectory, `${project.sessionId}.jsonl`),
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: project.sessionId,
            cwd: project.root,
            timestamp,
          })}\n`,
        );
      }
      const adapter = new OmpHarnessAdapter({ ompHome, cwd: directory, activeOnly: false });
      const workspaces = await adapter.listWorkspaces();
      expect(workspaces.find((workspace) => workspace.rootPath === projectA)?.workspaceId).toBe(
        workspaces.find((workspace) => workspace.rootPath === projectB)?.workspaceId,
      );
      const store = new InMemoryPrivateValueStore();
      const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
        workspaceId: ownerWorkspaceId,
        privateValues: store,
        adapters: [adapter],
      });
      for (const project of projects) {
        const plan = programPlan(store, project.sessionId, project.sessionId);
        expect(await resolveWorkspace(plan)).toBe(await fs.realpath(project.root));
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "isolates a healthy project from deleted OMP root aliases (registered: %s)",
    async (registered) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recorded-omp-aliases-"));
      try {
        const ompHome = path.join(directory, ".omp");
        const legacyRoot = path.basename(directory);
        const deletedRoot = path.resolve(legacyRoot);
        const healthyRoot = path.join(directory, "healthy-project");
        const sessionDirectory = path.join(ompHome, "agent", "sessions", legacyRoot);
        await fs.mkdir(sessionDirectory, { recursive: true });
        await fs.mkdir(healthyRoot, { recursive: true });
        for (const project of [
          { root: deletedRoot, sessionId: "deleted-session" },
          { root: healthyRoot, sessionId: "healthy-session" },
        ]) {
          await fs.writeFile(
            path.join(sessionDirectory, `${project.sessionId}.jsonl`),
            `${JSON.stringify({
              type: "session",
              version: 3,
              id: project.sessionId,
              cwd: project.root,
              timestamp,
            })}\n`,
          );
        }
        if (registered) {
          await fs.writeFile(
            path.join(ompHome, "workspaces.json"),
            JSON.stringify([{ path: deletedRoot, workspaceId: "registered-deleted-project" }]),
          );
        }
        const adapter = new OmpHarnessAdapter({ ompHome, cwd: directory, activeOnly: false });
        const store = new InMemoryPrivateValueStore();
        const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
          workspaceId: ownerWorkspaceId,
          privateValues: store,
          adapters: [adapter],
        });
        const healthyPlan = programPlan(store, "healthy-session", "healthy-project");
        const deletedPlan = programPlan(store, "deleted-session", "deleted-project");
        expect(await resolveWorkspace(healthyPlan)).toBe(await fs.realpath(healthyRoot));
        expect(await resolveWorkspace(deletedPlan)).toBeUndefined();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("isolates project bindings without blocking unrelated projects whose cwd is known", async () => {
    const store = new InMemoryPrivateValueStore();
    const projectA = programPlan(store, "session-project-a", "project-a");
    const projectB = programPlan(store, "session-project-b", "project-b");
    const unknownProject = programPlan(store, "session-unknown", "unknown-project");
    const discovery = discoveredAdapter([
      {
        localWorkspaceId: "local-project-a",
        rootPath: path.resolve("/projects/project-a"),
        sessionIds: ["session-project-a"],
      },
      {
        localWorkspaceId: "local-project-b",
        rootPath: path.resolve("/projects/project-b"),
        sessionIds: ["session-project-b"],
      },
      {
        localWorkspaceId: "local-unknown",
        rootPath: "discovery-fallback-label",
        sessionIds: ["session-unknown"],
      },
    ]);
    const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: store,
      adapters: [discovery.adapter],
    });

    expect(await resolveWorkspace(projectB)).toBe(path.resolve("/projects/project-b"));
    expect(await resolveWorkspace(projectA)).toBe(path.resolve("/projects/project-a"));
    expect(await resolveWorkspace(unknownProject)).toBeUndefined();
  });

  it("defers when a V2 source ref is missing or owned by another cloud workspace", async () => {
    const missingStore = new InMemoryPrivateValueStore();
    const missingPlan = programPlan(missingStore, "session-project", "missing-source", {
      omitSource: true,
    });
    const discovery = discoveredAdapter([
      {
        localWorkspaceId: "local-project",
        rootPath: path.resolve("/projects/project"),
        sessionIds: ["session-project"],
      },
    ]);
    const resolveMissing = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: missingStore,
      adapters: [discovery.adapter],
    });
    expect(await resolveMissing(missingPlan)).toBeUndefined();

    const wrongOwnerStore = new InMemoryPrivateValueStore();
    const wrongOwnerPlan = programPlan(wrongOwnerStore, "session-project", "wrong-owner-source", {
      sourceWorkspaceId: "another-cloud-workspace",
    });
    const resolveWrongOwner = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: wrongOwnerStore,
      adapters: [discovery.adapter],
    });
    expect(await resolveWrongOwner(wrongOwnerPlan)).toBeUndefined();
  });

  it("requires every Python setup reference to belong to the program's recorded project", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = programPlan(store, "session-project-b", "setup-from-a", {
      setupSessionId: "session-project-a",
    });
    const discovery = discoveredAdapter([
      {
        localWorkspaceId: "local-project-a",
        rootPath: path.resolve("/projects/project-a"),
        sessionIds: ["session-project-a"],
      },
      {
        localWorkspaceId: "local-project-b",
        rootPath: path.resolve("/projects/project-b"),
        sessionIds: ["session-project-b"],
      },
    ]);
    const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: store,
      adapters: [discovery.adapter],
    });

    expect(await resolveWorkspace(plan)).toBeUndefined();

    const wrongOwnerStore = new InMemoryPrivateValueStore();
    const wrongOwnerSetup = programPlan(wrongOwnerStore, "session-project-b", "wrong-owner-setup", {
      setupWorkspaceId: "another-cloud-workspace",
    });
    const resolveWrongOwner = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: wrongOwnerStore,
      adapters: [discovery.adapter],
    });
    expect(await resolveWrongOwner(wrongOwnerSetup)).toBeUndefined();
  });

  it("refuses plans whose program steps resolve to multiple roots", async () => {
    const store = new InMemoryPrivateValueStore();
    const projectA = programPlan(store, "session-project-a", "program-a");
    const projectB = programPlan(store, "session-project-b", "program-b");
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "multiple-roots",
      inputs: [],
      privateReferences: [...projectA.privateReferences!, ...projectB.privateReferences!],
      steps: [
        { ...projectA.steps[0]!, id: "step0" },
        { ...projectB.steps[0]!, id: "step1" },
      ],
      baseline: {
        inputs: [],
        observed: [
          { ...projectA.baseline!.observed[0]!, stepId: "step0" },
          { ...projectB.baseline!.observed[0]!, stepId: "step1" },
        ],
      },
    };
    const discovery = discoveredAdapter([
      {
        localWorkspaceId: "local-project-a",
        rootPath: path.resolve("/projects/project-a"),
        sessionIds: ["session-project-a"],
      },
      {
        localWorkspaceId: "local-project-b",
        rootPath: path.resolve("/projects/project-b"),
        sessionIds: ["session-project-b"],
      },
    ]);
    const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: store,
      adapters: [discovery.adapter],
    });

    expect(await resolveWorkspace(plan)).toBeUndefined();
  });

  it("refuses a session ID discovered under more than one project root", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = programPlan(store, "duplicated-session", "ambiguous-session");
    const discovery = discoveredAdapter([
      {
        localWorkspaceId: "local-project-a",
        rootPath: path.resolve("/projects/project-a"),
        sessionIds: ["duplicated-session"],
      },
      {
        localWorkspaceId: "local-project-b",
        rootPath: path.resolve("/projects/project-b"),
        sessionIds: ["duplicated-session"],
      },
    ]);
    const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: store,
      adapters: [discovery.adapter],
    });

    expect(await resolveWorkspace(plan)).toBeUndefined();
  });

  it.each(["result", "native-result:v1:exact", "native-result:v1:text-trim"] as const)(
    "uses the original baseline result reference for code without a V2 source binding (%s)",
    async (baselineSlot) => {
      const store = new InMemoryPrivateValueStore();
      const plan = programPlan(store, "session-project", `baseline-${baselineSlot}`, {
        privateSource: false,
        baselineSlot,
      });
      const withoutRepresentation = Object.assign(store, {
        representation: undefined,
      }) as unknown as InMemoryPrivateValueStore;
      const discovery = discoveredAdapter([
        {
          localWorkspaceId: "local-project",
          rootPath: path.resolve("/projects/project"),
          sessionIds: ["session-project"],
        },
      ]);
      const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
        workspaceId: ownerWorkspaceId,
        privateValues: withoutRepresentation,
        adapters: [discovery.adapter],
      });

      expect(await resolveWorkspace(plan)).toBe(path.resolve("/projects/project"));
    },
  );

  it("matches the redacted identity when the store omits representation metadata", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = programPlan(store, "session-project", "redacted-source", {
      sourceRepresentation: "redacted",
    });
    const withoutRepresentation = Object.assign(store, {
      representation: undefined,
    }) as unknown as InMemoryPrivateValueStore;
    const discovery = discoveredAdapter([
      {
        localWorkspaceId: "local-project",
        rootPath: path.resolve("/projects/project"),
        sessionIds: ["session-project"],
      },
    ]);
    const resolveWorkspace = createRecordedWorkflowWorkspaceResolver({
      workspaceId: ownerWorkspaceId,
      privateValues: withoutRepresentation,
      adapters: [discovery.adapter],
    });

    expect(await resolveWorkspace(plan)).toBe(path.resolve("/projects/project"));
  });
});
