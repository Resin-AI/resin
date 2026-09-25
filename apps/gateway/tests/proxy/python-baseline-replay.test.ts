import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import { InMemoryPrivateValueStore, resolvePrivateReference } from "@resin/observer";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RuntimeAdapterRegistry,
  applyConfirmedWorkflowBinding,
  createProcessAdapter,
  executeRecordedWorkflow,
  recordedWorkflowInputSchema,
} from "@resin/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  ReplayWorkspaceUnavailableError,
  type WorkspaceSnapshotSource,
  createWorkspaceSnapshotValidator,
} from "../../src/proxy/replay-workspace-snapshot.js";
import { createLocalWorkflowValidator } from "../../src/proxy/workflow-validation.js";

const workspaceId = "python-baseline-owner";

function recording(source: string, observed: string, setup?: string) {
  const privateValues = new InMemoryPrivateValueStore();
  privateValues.set("private:source", source, { workspaceId });
  privateValues.set("private:observed", observed, { workspaceId });
  if (setup !== undefined) privateValues.set("private:setup", setup, { workspaceId });
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "python-baseline",
    inputs: [],
    steps: [
      {
        id: "target",
        callId: "target-call",
        callable: {
          runtime: RESIN_PROGRAM_RUNTIME,
          name: "eval",
          program: {
            kind: "python",
            source: "",
            argument: "code",
            pythonState: {
              schemaVersion: 1,
              status: "closed",
              unresolvedReadCount: 0,
              setup:
                setup === undefined
                  ? []
                  : [
                      {
                        callId: "setup-call",
                        sourceEventId: "setup-event",
                        resultEventId: "setup-result",
                        reference: "private:setup",
                      },
                    ],
            },
          },
        },
        arguments: [{ name: "code", source: { kind: "private", reference: "private:source" } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
    baseline: { inputs: [], observed: [{ stepId: "target", reference: "private:observed" }] },
  };
  return {
    plan,
    privateValues,
    validate: createLocalWorkflowValidator({ workspaceId, privateValues, timeoutMs: 5_000 }),
  };
}

function shellRecording(
  workdir: string,
  source: string,
  observed: string,
  profile: "bash-login-v1" | "bash-login-native-v1",
) {
  const { plan, privateValues } = recording(source, observed);
  const step = plan.steps[0]!;
  step.callable = {
    runtime: RESIN_PROCESS_RUNTIME,
    name: profile === "bash-login-v1" ? "exec" : "command_exec",
    program: { kind: "shell", source: "", argument: "cmd" },
  };
  step.arguments = [
    { name: "cmd", source: { kind: "private", reference: "private:source" } },
    { name: "workdir", source: { kind: "literal", value: workdir } },
    { name: "resinCodexShellProfile", source: { kind: "literal", value: profile } },
    ...(profile === "bash-login-v1"
      ? [
          {
            name: "raw",
            source: {
              kind: "literal" as const,
              value: `const r=await tools.exec_command(${JSON.stringify({ cmd: source, workdir })});text(r.output);`,
            },
          },
        ]
      : []),
  ];
  return { plan, privateValues };
}

describe("fresh-process baseline replay", () => {
  it("reproduces a zero-candidate cell with setup, without retaining mutations between replays", async () => {
    const { plan, validate } = recording(
      "values.append(4)\nprint(sum(values))",
      "10\n",
      "values = [1, 2, 3]\nprint('setup output is not the target output')",
    );
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const result = await validate(plan);
      expect(result.verification).toMatchObject({
        status: "verified",
        reproduced: ["target"],
        missed: [],
        replay: { kind: "fresh-process", planDigest: workflowValidationPlanDigest(plan) },
      });
    }
  });

  it("replays setup from a disposable snapshot of the ready workspace and omits unsafe inputs", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-workspace-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-outside-"));
    const manifest = '{"name":"workspace-inputs"}';
    const lockfile = "lock-version: 9";
    try {
      const projectDir = path.join(sourceRoot, "sample-project");
      fs.mkdirSync(projectDir);
      fs.writeFileSync(path.join(projectDir, "package.json"), manifest);
      fs.writeFileSync(path.join(projectDir, "pnpm-lock.yaml"), lockfile);
      fs.writeFileSync(path.join(sourceRoot, ".env.local"), "hidden secret");
      fs.writeFileSync(path.join(sourceRoot, "id_rsa"), "sensitive key");
      fs.writeFileSync(path.join(outsideRoot, "outside.txt"), "outside");
      for (const directory of [
        "node_modules",
        "dist",
        "build",
        "coverage",
        "__pycache__",
        "venv",
      ]) {
        fs.mkdirSync(path.join(sourceRoot, directory));
        fs.writeFileSync(path.join(sourceRoot, directory, "excluded.txt"), "cache");
      }
      fs.symlinkSync(path.join(outsideRoot, "outside.txt"), path.join(sourceRoot, "linked.txt"));
      fs.symlinkSync("cycle", path.join(sourceRoot, "cycle"));
      fs.symlinkSync(outsideRoot, path.join(sourceRoot, "linked-directory"), "dir");

      const sourceManifestPath = JSON.stringify(path.join(projectDir, "package.json"));
      const sourceRootPath = JSON.stringify(sourceRoot);
      const setup = [
        "from pathlib import Path",
        "cache_dirs = ('node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv')",
        "manifest = Path('sample-project/package.json').read_text().strip()",
        "lock_contents = Path('sample-project/pnpm-lock.yaml').read_text().strip()",
      ].join("\n");
      const source = [
        "from pathlib import Path",
        "import os",
        "Path('sample-project/pnpm-lock.yaml').write_text('replay mutation')",
        "Path('replay-created.txt').write_text('only in replay')",
        "print('|'.join([",
        "    manifest,",
        "    lock_contents,",
        "    str(Path('.env.local').exists()),",
        "    str(Path('id_rsa').exists()),",
        "    str(any(Path(name).exists() for name in cache_dirs)),",
        "    str(Path('linked.txt').exists()),",
        "    str(Path('cycle').exists()),",
        "    str(Path('linked-directory').exists()),",
        `    str(not os.path.samefile('sample-project/package.json', ${sourceManifestPath})),`,
        `    str(Path.cwd().resolve() != Path(${sourceRootPath}).resolve()),`,
        "]))",
      ].join("\n");
      const observed = `${manifest}|${lockfile}|False|False|False|False|False|False|True|True\n`;
      const { plan, privateValues } = recording(source, observed, setup);
      let sourceWorkspace: WorkspaceSnapshotSource = { ready: false };
      const validate = createWorkspaceSnapshotValidator(() => sourceWorkspace, {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });
      sourceWorkspace = { ready: true, root: sourceRoot };

      const result = await validate(plan);

      expect(result.verification).toMatchObject({
        status: "verified",
        reproduced: ["target"],
        missed: [],
        replay: {
          kind: "fresh-process",
          planDigest: workflowValidationPlanDigest(plan),
        },
      });
      expect(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")).toBe(manifest);
      expect(fs.readFileSync(path.join(projectDir, "pnpm-lock.yaml"), "utf8")).toBe(lockfile);
      expect(fs.existsSync(path.join(sourceRoot, "replay-created.txt"))).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("replays recorded shell working directories inside the snapshot, never the source", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shell-snapshot-"));
    try {
      const projectDir = path.join(sourceRoot, "nested");
      fs.mkdirSync(projectDir);
      fs.writeFileSync(path.join(projectDir, "input.txt"), "recorded input");
      for (const profile of ["bash-login-v1", "bash-login-native-v1"] as const) {
        const { plan, privateValues } = shellRecording(
          projectDir,
          "cat input.txt; printf mutated > input.txt; printf created > replay-only.txt",
          "recorded input",
          profile,
        );
        const result = await createWorkspaceSnapshotValidator(
          () => ({ ready: true, root: sourceRoot }),
          { workspaceId, privateValues, timeoutMs: 5_000 },
        )(plan);
        expect(result.verification).toMatchObject({
          status: "verified",
          reproduced: ["target"],
          replay: { kind: "fresh-process", planDigest: workflowValidationPlanDigest(plan) },
        });
        expect(fs.readFileSync(path.join(projectDir, "input.txt"), "utf8")).toBe("recorded input");
        expect(fs.existsSync(path.join(projectDir, "replay-only.txt"))).toBe(false);
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("confirms a program value as an optional input that keeps the recorded value when omitted", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shell-default-"));
    try {
      fs.writeFileSync(path.join(sourceRoot, "alpha.txt"), "alpha\n");
      fs.writeFileSync(path.join(sourceRoot, "bravo.txt"), "bravo\n");
      const { plan, privateValues } = shellRecording(
        sourceRoot,
        "cat alpha.txt",
        "alpha\n",
        "bash-login-native-v1",
      );
      const candidate: WorkflowBindingCandidate = {
        stepId: "target",
        argument: "cmd",
        path: ["tokens", 1],
        proposed: { kind: "input", name: "path", type: "string", recordedDefault: true },
        reason: "native-data-argument",
        missing: "one recording does not establish that this value varies",
      };
      plan.candidates = [candidate];

      const result = await createWorkspaceSnapshotValidator(
        () => ({ ready: true, root: sourceRoot }),
        { workspaceId, privateValues, timeoutMs: 5_000 },
      )(plan);
      expect(result.verdicts.map(({ confirmed }) => confirmed)).toEqual([true]);

      // The replay attests exactly the plan the cloud gets by applying the confirmed proposal.
      const promoted = applyConfirmedWorkflowBinding(plan, candidate)!;
      expect(result.verification?.replay?.planDigest).toBe(workflowValidationPlanDigest(promoted));
      expect(recordedWorkflowInputSchema(promoted)).toMatchObject({
        properties: { path: { type: "string" } },
        required: [],
      });

      const adapters = new RuntimeAdapterRegistry();
      adapters.register(createProcessAdapter({ cwd: sourceRoot }));
      const run = (inputs: Record<string, WorkflowJsonValue>) =>
        executeRecordedWorkflow(promoted, {
          inputs,
          adapters,
          access: { workspaceId },
          resolvePrivate: (reference) =>
            resolvePrivateReference(privateValues, reference) as WorkflowJsonValue,
        });
      expect((await run({})).result).toBe("alpha\n");
      expect((await run({ path: "bravo.txt" })).result).toBe("bravo\n");
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("refuses recorded shell directories outside the trusted root or without one", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shell-root-"));
    const outsideRoot = `${sourceRoot}-sibling`;
    fs.mkdirSync(outsideRoot);
    try {
      fs.writeFileSync(path.join(outsideRoot, "marker.txt"), "original");
      const { plan, privateValues } = shellRecording(
        outsideRoot,
        "printf mutated > marker.txt; printf done",
        "done",
        "bash-login-native-v1",
      );
      for (const source of [{ ready: true, root: sourceRoot }, { ready: true }] as const) {
        const result = await createWorkspaceSnapshotValidator(() => source, {
          workspaceId,
          privateValues,
          timeoutMs: 5_000,
        })(plan);
        expect(result.verification?.status).toBe("failed");
        expect(result.verification?.replay).toBeUndefined();
        expect(fs.readFileSync(path.join(outsideRoot, "marker.txt"), "utf8")).toBe("original");
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("snapshots current bytes on each attempt, so a program that no longer holds fails", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-current-bytes-"));
    try {
      const input = path.join(sourceRoot, "input.txt");
      fs.writeFileSync(input, "recorded");
      const { plan, privateValues } = recording(
        "from pathlib import Path\nassert Path('input.txt').read_text() == 'recorded'\nprint('ok')",
        "ok\n",
      );
      const validate = createWorkspaceSnapshotValidator(() => ({ ready: true, root: sourceRoot }), {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });

      expect((await validate(plan)).verification?.status).toBe("verified");
      fs.writeFileSync(input, "changed");

      const changed = await validate(plan);

      expect(changed.verification?.status).not.toBe("verified");
      expect(changed.verification?.replay).toBeUndefined();
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("keeps a program isolated when a ready context has no host-owned root", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-rootless-"));
    try {
      fs.writeFileSync(path.join(sourceRoot, "input.txt"), "workspace only");
      const { plan, privateValues } = recording(
        "from pathlib import Path\nprint(Path('input.txt').read_text())",
        "workspace only\n",
      );
      const validate = createWorkspaceSnapshotValidator(() => ({ ready: true }), {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });

      const result = await validate(plan);

      expect(result.verification?.status).not.toBe("verified");
      expect(result.verification?.replay).toBeUndefined();
      expect(fs.readFileSync(path.join(sourceRoot, "input.txt"), "utf8")).toBe("workspace only");
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
  it("defers recorded-program validation until the trusted workspace context is ready", async () => {
    const { plan, privateValues } = recording("print('unused')", "unused\n");
    const validate = createWorkspaceSnapshotValidator(() => ({ ready: false }), {
      workspaceId,
      privateValues,
      timeoutMs: 5_000,
    });

    await expect(validate(plan)).rejects.toBeInstanceOf(ReplayWorkspaceUnavailableError);
  });

  it("defers when asynchronous recorded-project discovery fails", async () => {
    const { plan, privateValues } = recording("print('unused')", "unused\n");
    const validate = createWorkspaceSnapshotValidator(
      async () => {
        throw new Error("local session discovery is inaccessible");
      },
      { workspaceId, privateValues },
    );

    await expect(validate(plan)).rejects.toBeInstanceOf(ReplayWorkspaceUnavailableError);
  });

  it("replays a protocol-only baseline without inspecting the host workspace", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    privateValues.set("private:protocol-observed", "protocol result", { workspaceId });
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "protocol-only",
      inputs: [],
      steps: [
        {
          id: "target",
          callId: "protocol-call",
          callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "echo" },
          arguments: [{ name: "value", source: { kind: "literal", value: "protocol result" } }],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
      ],
      baseline: {
        inputs: [],
        observed: [{ stepId: "target", reference: "private:protocol-observed" }],
      },
    };
    const inspectHost = vi.spyOn(fsPromises, "lstat");
    const dispatch = vi.fn(async () => "protocol result");
    try {
      const validate = createWorkspaceSnapshotValidator(
        () => ({ ready: true, root: path.join(os.tmpdir(), "missing-workspace-root") }),
        { workspaceId, privateValues, dispatch },
      );
      const result = await validate(plan);

      expect(result.verification).toMatchObject({
        status: "verified",
        reproduced: ["target"],
        missed: [],
        replay: { kind: "host-replay", planDigest: workflowValidationPlanDigest(plan) },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(inspectHost).not.toHaveBeenCalled();
    } finally {
      inspectHost.mockRestore();
    }
  });

  it("rejects a source file exceeding the snapshot bound without treating it as transient", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-oversize-"));
    try {
      fs.closeSync(fs.openSync(path.join(sourceRoot, "too-large.bin"), "w"));
      fs.truncateSync(path.join(sourceRoot, "too-large.bin"), 10 * 1024 * 1024 + 1);
      const { plan, privateValues } = recording("print('unused')", "unused\n");
      const validate = createWorkspaceSnapshotValidator(() => ({ ready: true, root: sourceRoot }), {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });

      await expect(validate(plan)).rejects.toThrow("per-file size limit");
      expect(fs.existsSync(path.join(sourceRoot, "too-large.bin"))).toBe(true);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("bounds enumerated entries even when every entry is omitted", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-entry-limit-"));
    try {
      for (let index = 0; index < 20_001; index += 1) {
        fs.writeFileSync(path.join(sourceRoot, `.hidden-${index}`), "");
      }
      const { plan, privateValues } = recording("print('unused')", "unused\n");
      const validate = createWorkspaceSnapshotValidator(() => ({ ready: true, root: sourceRoot }), {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });

      await expect(validate(plan)).rejects.toThrow("entry-count limit");
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects a workspace root replaced between lstat and realpath", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-root-race-"));
    const replacedRoot = `${sourceRoot}-original`;
    const alternateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-root-target-"));
    let swapped = false;
    const originalRealpath = fsPromises.realpath.bind(fsPromises);
    const realpathSpy = vi.spyOn(fsPromises, "realpath").mockImplementation(async (entryPath) => {
      if (!swapped && path.resolve(String(entryPath)) === sourceRoot) {
        fs.renameSync(sourceRoot, replacedRoot);
        fs.symlinkSync(alternateRoot, sourceRoot, "dir");
        swapped = true;
      }
      return originalRealpath(entryPath);
    });

    try {
      const { plan, privateValues } = recording("print('unused')", "unused\n");
      const validate = createWorkspaceSnapshotValidator(() => ({ ready: true, root: sourceRoot }), {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });

      await expect(validate(plan)).rejects.toBeInstanceOf(ReplayWorkspaceUnavailableError);
      expect(swapped).toBe(true);
    } finally {
      realpathSpy.mockRestore();
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(replacedRoot, { recursive: true, force: true });
      fs.rmSync(alternateRoot, { recursive: true, force: true });
    }
  });

  it("rejects overlapping source and replay roots before traversing the source", async () => {
    const { plan, privateValues } = recording("print('unused')", "unused\n");
    const validate = createWorkspaceSnapshotValidator(() => ({ ready: true, root: os.tmpdir() }), {
      workspaceId,
      privateValues,
      timeoutMs: 5_000,
    });

    await expect(validate(plan)).rejects.toBeInstanceOf(ReplayWorkspaceUnavailableError);
  });

  it("does not attest a cell whose recorded success depended on missing session globals", async () => {
    const { plan, validate } = recording("print(lock_data['packages'])", "{'resin': '1.0.78'}\n");
    const result = await validate(plan);
    expect(result.verification?.status).not.toBe("verified");
    expect(result.verification?.missed.map(({ stepId }) => stepId)).toEqual(["target"]);
    expect(result.verification?.replay).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("lock_data");
  });

  it("verifies a recorded program that completes even though its printed output changed", async () => {
    const { plan, validate } = recording("print(sum([1, 2, 3]))", "999\n");
    const result = await validate(plan);
    expect(result.verification?.status).toBe("verified");
    expect(result.verification?.reproduced).toEqual(["target"]);
  });

  it("does not use the original baseline to promote a proposed input", async () => {
    const { plan, validate } = recording("print(6 * 7)", "42\n");
    plan.candidates = [
      {
        stepId: "target",
        argument: "code",
        path: ["tokens", 2],
        proposed: { kind: "input", name: "factor", type: "number" },
        reason: "varies-across-executions",
        missing: "another input must establish the binding",
      },
    ];
    const result = await validate(plan);
    expect(result.verification?.status).toBe("verified");
    expect(result.verdicts.map(({ confirmed }) => confirmed)).toEqual([false]);
    expect(plan.inputs).toEqual([]);
  });
});
