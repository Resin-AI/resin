/**
 * A recorded workflow made of ordinary calls, executed by the real local executor.
 *
 * These tests drive `LocalArtifactExecutor` the way the gateway does, with a verified bundle whose
 * entrypoint is a frozen plan. They check the two things an ordinary call needs that a routed tool
 * call does not: the recorded program is run whole on the host, and the values the plan references —
 * including the program text itself — are resolved locally rather than uploaded.
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
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  createToolProtocolAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { resolveWorkspaceContext } from "../../src/workspace-resolver.js";

interface TestManifestInput {
  id: string;
  name: string;
  version: string;
  description: string;
  parameters: ToolManifest["parameters"];
  runtime: ToolManifest["runtime"];
  capabilities?: ToolManifest["capabilities"];
}

const WORKSPACE_ID = "ws_native_executor";

describe("recorded workflows of ordinary calls", () => {
  let tempDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-executor-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort.
    }
  });

  async function installPlan(
    manifestInput: TestManifestInput,
    plan: unknown,
  ): Promise<{ manifest: ToolManifest; artifactDigest: string; manifestDigest: string }> {
    const manifestWithDefaults = {
      capabilities: {},
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-09-02T00:00:00.000Z",
      ...manifestInput,
    };
    const manifestDigest = computeManifestDigest(manifestWithDefaults as ToolManifest);
    const fullManifest = { ...manifestWithDefaults, digest: manifestDigest } as ToolManifest;
    const entrypoint = JSON.stringify(compileRecordedWorkflow(plan as never).plan);
    const { archive } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(fullManifest) },
      { path: "src/index.ts", content: entrypoint },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(archive).digest("hex");
    const stagingDir = await cache.createStagingDirectory(artifactDigest);
    fs.mkdirSync(path.join(stagingDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(fullManifest), "utf8");
    fs.writeFileSync(path.join(stagingDir, "src", "index.ts"), entrypoint, "utf8");
    await cache.commitStagingDirectory(stagingDir, artifactDigest, {
      digest: artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: archive.length,
      entrypoint: "src/index.ts",
      verified: true,
    });
    return { manifest: fullManifest, artifactDigest, manifestDigest };
  }

  function execute(
    input: {
      manifest: ToolManifest;
      artifactDigest: string;
      privateValues: InMemoryPrivateValueStore;
      stepInvoker?: (request: {
        name: string;
        parameters: Record<string, unknown>;
      }) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
    },
    parameters: Record<string, unknown>,
    context = resolveWorkspaceContext({ cwd: workspaceDir }),
  ) {
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: input.privateValues,
      ...(input.stepInvoker ? { stepInvoker: input.stepInvoker } : {}),
      // The host runs the recorded program itself; the family names come from the recording.
      recordedWorkflowAdapters: (host) => [
        createProcessAdapter({ cwd: workspaceDir }),
        createProgramAdapter({ cwd: workspaceDir }),
        createToolProtocolAdapter({
          dispatch: async (request) => {
            const result = await host.routeToHost({
              name: request.name,
              ...(request.connection ? { connection: request.connection } : {}),
              parameters: request.arguments as Record<string, unknown>,
            });
            if (result.isError === true) {
              throw new Error(`callable '${request.name}' answered with an error`);
            }
            const text = result.content?.find((item) => item.type === "text")?.text;
            if (typeof text !== "string") return null;
            try {
              return JSON.parse(text) as never;
            } catch {
              return text as never;
            }
          },
        }),
      ],
    });
    return executor.execute({
      entry: {
        toolId: input.manifest.id,
        name: input.manifest.name,
        version: input.manifest.version,
        artifactDigest: input.artifactDigest,
      },
      manifest: input.manifest,
      parameters: parameters as never,
      context,
    });
  }

  it("runs the recorded program whole, with its operators and redirections", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program =
      "printf 'b\\na\\nc\\n' > seed.txt && sort seed.txt | tr 'a-z' 'A-Z' > upper.txt && wc -l < upper.txt";
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", program, { workspaceId: context.workspaceId });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_process",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_process_001",
        name: "wf_process",
        version: "1.0.0",
        description: "recorded process program",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      plan,
    );

    const result = await execute({ ...installed, privateValues }, {}, context);
    expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceDir, "upper.txt"), "utf8")).toBe("A\nB\nC\n");
    expect(result.content[0]?.text).toContain("3");
  });

  it("refuses to run a recorded program the manifest does not grant", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", "printf 'should-not-run' > leaked.txt", {
      workspaceId: context.workspaceId,
    });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_process_ungranted",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_process_002",
        name: "wf_process_ungranted",
        version: "1.0.0",
        description: "recorded process program without a grant",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
      },
      plan,
    );

    const result = await execute({ ...installed, privateValues }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("does not grant command execution");
    expect(fs.existsSync(path.join(workspaceDir, "leaked.txt"))).toBe(false);
  });

  it("runs a recorded program through its interpreter and dispatches a tool by name", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", "import json\nprint(json.dumps({'rows': [1, 2, 3]}))\n", {
      workspaceId: context.workspaceId,
    });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_program_and_tool",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROGRAM_RUNTIME,
            name: "eval",
            program: { kind: "python", source: "", argument: "code" },
          },
          arguments: [
            {
              name: "code",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
        {
          id: "step1",
          callId: "call_2",
          callable: {
            runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
            name: "vendor.score",
            connection: "vendor-srv",
          },
          arguments: [
            {
              name: "rows",
              source: {
                kind: "template",
                template: { type: "result", stepId: "step0", path: [] },
              },
            },
          ],
          dependsOn: ["step0"],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_program_001",
        name: "wf_program_and_tool",
        version: "1.0.0",
        description: "recorded program and a call reached over its connection",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 20_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      plan,
    );

    const seen: Array<{ name: string; parameters: Record<string, unknown> }> = [];
    const result = await execute(
      {
        ...installed,
        privateValues,
        stepInvoker: async (request) => {
          seen.push(request);
          return {
            content: [{ type: "text", text: JSON.stringify({ scored: 12 }) }],
          };
        },
      },
      {},
      context,
    );
    expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
    // The program's answer reached the callable exactly as the program printed it, and the
    // callable was reached by its own name through the host's routing.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe("vendor.score");
    expect(seen[0]!.parameters).toEqual({ rows: '{"rows": [1, 2, 3]}\n' });
  });
});
