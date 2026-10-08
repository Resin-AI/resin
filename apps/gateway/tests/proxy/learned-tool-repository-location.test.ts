/**
 * A learned tool whose steps carry a repository `location` runs in the caller's own checkout of
 * that repository — any clone or worktree — and nowhere else.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecordedWorkflow, ToolManifest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  clearRepositoryIdentityCache,
  repositoryIdentity,
} from "@resin/observer/repository-identity";
import {
  ArtifactCache,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { recordedWorkflowRuntimeAdapters } from "../../src/proxy/runtime.js";
import { callerRepository, toolRunnableHere } from "../../src/proxy/tool-location.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};
const savedEnv: Record<string, string | undefined> = {};

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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
}

describe("learned tools located in the caller's repository", () => {
  let tempDir: string;
  let recordedRepo: string;
  let callerWorktree: string;
  let otherRepo: string;
  let cache: ArtifactCache;

  beforeEach(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "learned-tool-repo-")));
    recordedRepo = path.join(tempDir, "recorded");
    callerWorktree = path.join(tempDir, "caller-worktree");
    otherRepo = path.join(tempDir, "other");
    for (const [root, marker] of [
      [recordedRepo, "recorded"],
      [otherRepo, "other"],
    ] as const) {
      fs.mkdirSync(path.join(root, "packages", "app"), { recursive: true });
      fs.writeFileSync(path.join(root, "packages", "app", "marker.txt"), `${marker}\n`);
      git(root, "init", "-q");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", marker);
    }
    git(recordedRepo, "worktree", "add", "-q", callerWorktree);
    fs.writeFileSync(path.join(callerWorktree, "packages", "app", "marker.txt"), "caller\n");
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
  });

  afterEach(() => {
    clearRepositoryIdentityCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function locatedPlan(repository: string): RecordedWorkflow {
    return {
      schemaVersion: 1,
      workflowId: "wf_located",
      inputs: [],
      steps: [
        {
          id: "step0",
          callId: "call_cat",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "literal",
                value: "cd /synthetic/deleted-scratch/wt/packages/app && cat marker.txt",
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
          location: { base: "repository", repository, path: "packages/app", leadingCd: true },
        },
        {
          id: "step1",
          callId: "call_harness",
          callable: {
            runtime: RESIN_HARNESS_TOOL_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            { name: "command", source: { kind: "literal", value: "pwd" } },
            { name: "cwd", source: { kind: "literal", value: "/synthetic/deleted-scratch/wt" } },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
          location: { base: "repository", repository, path: "" },
        },
      ],
    };
  }

  async function install(plan: RecordedWorkflow) {
    const withDefaults = {
      id: "tool_located",
      name: "wf_located",
      version: "1.0.0",
      description: "a plan located in its repository",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      runtime: {
        runtime: "recorded-workflow",
        memoryLimitMb: 64,
        timeoutMs: 10_000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 65_536,
      },
      capabilities: { command: { allowShellExecution: true } },
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    const manifestDigest = computeManifestDigest(withDefaults as unknown as ToolManifest);
    const manifest = { ...withDefaults, digest: manifestDigest } as unknown as ToolManifest;
    const entrypoint = JSON.stringify(plan);
    const { archive } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(manifest) },
      { path: "src/index.ts", content: entrypoint },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(archive).digest("hex");
    const stagingDir = await cache.createStagingDirectory(artifactDigest);
    fs.mkdirSync(path.join(stagingDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    fs.writeFileSync(path.join(stagingDir, "src", "index.ts"), entrypoint, "utf8");
    await cache.commitStagingDirectory(stagingDir, artifactDigest, {
      digest: artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: archive.length,
      entrypoint: "src/index.ts",
      verified: true,
    });
    return { manifest, artifactDigest };
  }

  async function run(context: WorkspaceContext) {
    const installed = await install(locatedPlan(repositoryIdentity(recordedRepo)!.id));
    const harnessCalls: Array<{ cwd: string; parameters: Record<string, unknown> }> = [];
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: context.projectRoot,
      development: true,
      allowDevKeys: true,
      privateValueStore: new InMemoryPrivateValueStore(),
      recordedWorkflowAdapters: (host) =>
        recordedWorkflowRuntimeAdapters(host, {
          recordedHarnessToolInvoker: async (request) => {
            harnessCalls.push({ cwd: request.cwd, parameters: request.parameters });
            return { content: [{ type: "text", text: "ok" }] };
          },
        }),
    });
    const result = await executor.execute({
      entry: {
        toolId: installed.manifest.id,
        name: installed.manifest.name,
        version: installed.manifest.version,
        artifactDigest: installed.artifactDigest,
      },
      manifest: installed.manifest,
      parameters: {},
      context,
    });
    const text = result.content.map((part) => part.text ?? "").join("\n");
    const availability = executor.recordedWorkflowAvailability(installed.artifactDigest, context);
    return { result, text, harnessCalls, availability };
  }

  it("runs every located step in the caller's worktree, ignoring the recorded directories", async () => {
    const context = resolveWorkspaceContext({ cwd: path.join(callerWorktree, "packages") });
    expect(callerRepository(context)).toEqual({
      id: repositoryIdentity(recordedRepo)!.id,
      root: callerWorktree,
    });

    const { result, text, harnessCalls, availability } = await run(context);

    expect(result.isError, text).toBeUndefined();
    expect(text).toContain("caller");
    expect(text).not.toContain("recorded\n");
    expect(harnessCalls).toEqual([
      { cwd: callerWorktree, parameters: { command: "pwd", cwd: callerWorktree } },
    ]);
    expect(availability).toEqual({ available: true });
  });

  it("refuses to run, and reports the tool unavailable, in another repository", async () => {
    const context = resolveWorkspaceContext({ cwd: otherRepo });

    const { result, text, harnessCalls, availability } = await run(context);

    expect(result.isError).toBe(true);
    expect(text).toContain("This tool cannot run here");
    expect(text).toContain("different repository");
    expect(harnessCalls).toEqual([]);
    expect(availability?.available).toBe(false);
  });

  it("is unavailable outside any git checkout", () => {
    const plain = path.join(tempDir, "plain");
    fs.mkdirSync(plain);
    const context = resolveWorkspaceContext({ cwd: plain });
    expect(callerRepository(context)).toBeUndefined();
    expect(toolRunnableHere(locatedPlan(repositoryIdentity(recordedRepo)!.id), context)).toEqual({
      available: false,
      reason:
        "it runs inside a git repository, and the caller's working directory is not in a git checkout with commits",
    });
  });
});
