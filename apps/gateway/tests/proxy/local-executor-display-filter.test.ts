/**
 * A plan step marked `displayFilter` (`display-filter-v1`), run by the real local executor: an
 * invocation returns the recorded command's whole output without the trailing display filter the
 * recording piped it through, and the step's boolean input switches the recorded pipeline back on.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_PROCESS_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const RECORDED_PROGRAM = "./emit | tail -1";

describe.skipIf(process.platform === "win32")("display-filter steps in the gateway", () => {
  let tempDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;
  let context: WorkspaceContext;
  let installed: { manifest: ToolManifest; artifactDigest: string };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "display-filter-gateway-"));
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "emit"), "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\n", {
      mode: 0o755,
    });
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    context = resolveWorkspaceContext({ cwd: workspaceDir });
    installed = await installPlan();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function installPlan(): Promise<{ manifest: ToolManifest; artifactDigest: string }> {
    const raw = {
      id: "tool_emit_lines",
      name: "emit_lines",
      version: "1.0.0",
      description: "emits lines",
      parameters: {
        type: "object",
        properties: { filter_output: { type: "boolean" } },
        additionalProperties: false,
      },
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
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const manifest = { ...raw, digest: computeManifestDigest(raw as ToolManifest) } as ToolManifest;
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_emit_lines",
      inputs: [{ name: "filter_output", type: "boolean", default: false }],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: RECORDED_PROGRAM, argument: "command" },
          },
          arguments: [{ name: "command", source: { kind: "literal", value: RECORDED_PROGRAM } }],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
          displayFilter: { version: 1, input: "filter_output" },
        },
      ],
    };
    const entrypoint = JSON.stringify(compileRecordedWorkflow(plan as never).plan);
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

  async function run(parameters: Record<string, unknown>): Promise<string> {
    const result = await new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: new InMemoryPrivateValueStore(),
      recordedWorkflowAdapters: () => [
        createProcessAdapter({ cwd: workspaceDir }),
        createProgramAdapter({ cwd: workspaceDir }),
      ],
    }).execute({
      entry: {
        toolId: installed.manifest.id,
        name: installed.manifest.name,
        version: installed.manifest.version,
        artifactDigest: installed.artifactDigest,
      },
      manifest: installed.manifest,
      parameters: parameters as never,
      context,
    });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }

  it("returns the command's whole output without the recorded display filter", async () => {
    // The tool result carries the step's string result as JSON text.
    expect(await run({})).toBe(JSON.stringify("a\nb\nc\n"));
    expect(await run({ filter_output: false })).toBe(JSON.stringify("a\nb\nc\n"));
  });

  it("runs the recorded pipeline when the caller switches the filter on", async () => {
    expect(await run({ filter_output: true })).toBe(JSON.stringify("c\n"));
  });
});
