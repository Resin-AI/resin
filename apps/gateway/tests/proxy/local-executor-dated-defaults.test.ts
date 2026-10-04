/**
 * A recorded-default input whose recorded value is a date, run by the real local executor: it is
 * described as required, a call without it is refused before anything runs, and a call with it
 * runs the recorded program with the caller's value. A plain recorded default still falls back on
 * its recorded value.
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
import { FAILURE_REASON_META_KEY } from "../../src/meta/invocation-failure.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const RECORDED_PROGRAM =
  "printf '%s %s\\n' acme-production Start=2026-10-01,End=2026-10-05 > period.txt";

describe("recorded defaults that name a date", () => {
  let tempDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;
  let context: WorkspaceContext;
  let privateValues: InMemoryPrivateValueStore;
  let installed: { manifest: ToolManifest; artifactDigest: string };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dated-defaults-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues = new InMemoryPrivateValueStore();
    privateValues.set("private:cost", RECORDED_PROGRAM, { workspaceId: context.workspaceId });
    installed = await installPlan();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function installPlan(): Promise<{ manifest: ToolManifest; artifactDigest: string }> {
    const raw = {
      id: "tool_cost_usage",
      name: "verify_identity_and_get_cost_usage",
      version: "1.0.0",
      description: "reports cost and usage",
      parameters: {
        type: "object",
        properties: {
          aws_profile: { type: "string" },
          cost_time_period: { type: "string" },
        },
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
      workflowId: "wf_cost_usage",
      inputs: [
        { name: "aws_profile", type: "string", recordedDefault: true },
        { name: "cost_time_period", type: "string", recordedDefault: true },
      ],
      privateReferences: ["private:cost"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: RECORDED_PROGRAM, argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: {
                  type: "program",
                  language: "shell",
                  // A projected program: its sanitized text (here nothing was redacted) is what the
                  // plan carries and what is shown; the original runs from the private store.
                  source: { type: "literal", value: RECORDED_PROGRAM },
                  sourceReference: "private:cost",
                  protectedTokens: [],
                  holes: [
                    { token: 2, binding: { type: "input", name: "aws_profile" } },
                    { token: 3, binding: { type: "input", name: "cost_time_period" } },
                  ],
                },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
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

  function executor(): LocalArtifactExecutor {
    return new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
      recordedWorkflowAdapters: () => [
        createProcessAdapter({ cwd: workspaceDir }),
        createProgramAdapter({ cwd: workspaceDir }),
      ],
    });
  }

  function run(parameters: Record<string, unknown>) {
    return executor().execute({
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
  }

  it("reads the dated input and its recorded value; the plain one is not dated", () => {
    expect([...executor().recordedWorkflowDatedInputs(installed.artifactDigest, context)]).toEqual([
      ["cost_time_period", "Start=2026-10-01,End=2026-10-05"],
    ]);
  });

  it("describes the dated input as required and the plain one as defaulted", () => {
    const description = executor().describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain(
      "printf '%s %s\\n' {aws_profile} {cost_time_period} > period.txt",
    );
    expect(description).toContain(
      "\nParameters (each replaces its {name} above; omitted, the recorded value runs): aws_profile = acme-production",
    );
    expect(description).toContain(
      "\nRequired parameters (each replaces its {name} above; its recorded value was a date, so pass the current one in the same form): cost_time_period (recorded: Start=2026-10-01,End=2026-10-05)",
    );
    expect(description).not.toContain("cost_time_period = ");
  });

  it("refuses a call without the dated input before anything runs", async () => {
    const result = await run({});
    expect(result.isError).toBe(true);
    expect(result._meta?.[FAILURE_REASON_META_KEY]).toBe("validation_error");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Missing required input cost_time_period (recorded: Start=2026-10-01,End=2026-10-05)",
    );
    expect(fs.existsSync(path.join(workspaceDir, "period.txt"))).toBe(false);
  });

  it("runs with the caller's date, the omitted plain input keeping its recorded value", async () => {
    const result = await run({ cost_time_period: "Start=2026-11-01,End=2026-11-30" });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceDir, "period.txt"), "utf8")).toBe(
      "acme-production Start=2026-11-01,End=2026-11-30\n",
    );
  });
});
