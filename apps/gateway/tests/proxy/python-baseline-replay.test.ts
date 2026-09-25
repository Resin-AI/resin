import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type RecordedWorkflow, workflowValidationPlanDigest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { RESIN_PROGRAM_RUNTIME, RESIN_TOOL_PROTOCOL_RUNTIME } from "@resin/runtime";
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

  it("snapshots current bytes on each attempt and still requires the recorded output to match", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-current-bytes-"));
    try {
      const input = path.join(sourceRoot, "input.txt");
      fs.writeFileSync(input, "recorded");
      const { plan, privateValues } = recording(
        "from pathlib import Path\nprint(Path('input.txt').read_text())",
        "recorded\n",
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

  it("defers when a source file exceeds the snapshot bound", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-python-oversize-"));
    try {
      fs.writeFileSync(path.join(sourceRoot, "too-large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
      const { plan, privateValues } = recording("print('unused')", "unused\n");
      const validate = createWorkspaceSnapshotValidator(() => ({ ready: true, root: sourceRoot }), {
        workspaceId,
        privateValues,
        timeoutMs: 5_000,
      });

      await expect(validate(plan)).rejects.toBeInstanceOf(ReplayWorkspaceUnavailableError);
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

      await expect(validate(plan)).rejects.toBeInstanceOf(ReplayWorkspaceUnavailableError);
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

  it("does not replace recorded expectations with a successful process exit", async () => {
    const { plan, validate } = recording("print(sum([1, 2, 3]))", "999\n");
    const result = await validate(plan);
    expect(result.verification?.status).not.toBe("verified");
    expect(result.verification?.reproduced).toEqual([]);
    expect(result.verification?.replay).toBeUndefined();
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
