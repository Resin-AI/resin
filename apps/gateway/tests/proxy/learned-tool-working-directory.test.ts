/**
 * Where a learned tool's commands run.
 *
 * A session launched in a subdirectory of its git project recorded its commands relative to that
 * subdirectory (`stylua --check src`), so the learned tool must run them there too: in the
 * session's `startupPath` when it is the project root or inside it, else in the project root.
 * Capability grants stay rooted at the project root either way.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ToolManifest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  compileRecordedWorkflow,
  encodeDeterministicTar,
  resolveDenoExecutable,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import { McpFrameDecoder, encodeMcpMessage } from "../../src/protocol/framing.js";
import type { CallToolResult, JsonRpcParams, JsonRpcResponse } from "../../src/protocol/types.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { recordedWorkflowRuntimeAdapters } from "../../src/proxy/runtime.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";
import {
  type WorkspaceContext,
  resolveWorkspaceContext,
  sessionWorkingDirectory,
} from "../../src/workspace-resolver.js";

const hasDeno = resolveDenoExecutable() !== undefined;

describe("the directory a learned tool runs in", () => {
  let tempDir: string;
  let projectDir: string;
  let sessionDir: string;
  let outsideDir: string;
  let cache: ArtifactCache;

  beforeEach(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "learned-tool-cwd-")));
    projectDir = path.join(tempDir, "project");
    sessionDir = path.join(projectDir, "packages", "app");
    outsideDir = path.join(tempDir, "outside");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, "marker.txt"), "project-root\n");
    fs.writeFileSync(path.join(sessionDir, "marker.txt"), "session-dir\n");
    fs.writeFileSync(path.join(outsideDir, "marker.txt"), "outside\n");
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function install(
    manifestInput: Omit<ToolManifest, "digest" | "limits" | "scope" | "createdAt">,
    entrypoint: string,
  ): Promise<{ manifest: ToolManifest; artifactDigest: string; manifestDigest: string }> {
    const withDefaults = {
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-10-04T00:00:00.000Z",
      ...manifestInput,
    };
    const manifestDigest = computeManifestDigest(withDefaults as ToolManifest);
    const manifest = { ...withDefaults, digest: manifestDigest } as ToolManifest;
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
    return { manifest, artifactDigest, manifestDigest };
  }

  /**
   * Runs a recorded plan — a shell program `cat marker.txt`, then a harness builtin — through the
   * production adapter composition; answers what the program printed and the harness builtin's cwd.
   */
  async function runRecordedPlan(
    context: WorkspaceContext,
  ): Promise<{ printed: string | undefined; harnessCwd: string | undefined }> {
    const privateValues = new InMemoryPrivateValueStore();
    privateValues.set("private:sess:0", "cat marker.txt", { workspaceId: context.workspaceId });
    const installed = await install(
      {
        id: "tool_lint_session",
        name: "wf_lint_session",
        version: "1.0.0",
        description: "a program recorded relative to the session's directory",
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
      JSON.stringify(
        compileRecordedWorkflow({
          schemaVersion: 1,
          workflowId: "wf_lint_session",
          inputs: [],
          privateReferences: ["private:sess:0"],
          steps: [
            {
              id: "step0",
              callId: "call_read",
              callable: { runtime: RESIN_HARNESS_TOOL_RUNTIME, name: "read" },
              arguments: [{ name: "path", source: { kind: "literal", value: "marker.txt" } }],
              dependsOn: [],
              failurePolicy: { onError: "abort", policy: "default" },
              observed: { outcome: "succeeded" },
            },
            {
              id: "step1",
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
                    kind: "template",
                    template: { type: "private", reference: "private:sess:0" },
                  },
                },
              ],
              dependsOn: ["step0"],
              failurePolicy: { onError: "abort", policy: "default" },
              observed: { outcome: "succeeded" },
            },
          ],
        } as never).plan,
      ),
    );
    let harnessCwd: string | undefined;
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: projectDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
      recordedWorkflowAdapters: (host) =>
        recordedWorkflowRuntimeAdapters(host, {
          recordedHarnessToolInvoker: async (request) => {
            harnessCwd = request.cwd;
            return { content: [{ type: "text", text: "read" }] };
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
    expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
    const text = result.content.map((part) => part.text ?? "").join("\n");
    const printed = ["session-dir", "project-root", "outside"].find((marker) =>
      text.includes(marker),
    );
    return { printed, harnessCwd };
  }

  it("runs a recorded program and harness builtin in the session's subdirectory", async () => {
    const context = resolveWorkspaceContext({ cwd: sessionDir });
    expect(context.projectRoot).toBe(projectDir);
    expect(context.startupPath).toBe(sessionDir);

    const { printed, harnessCwd } = await runRecordedPlan(context);

    expect(printed).toBe("session-dir");
    expect(harnessCwd).toBe(sessionDir);
  });

  it("falls back to the project root for a startup path outside the project or absent", async () => {
    const atRoot = resolveWorkspaceContext({ cwd: projectDir });
    for (const startupPath of [outsideDir, path.join(projectDir, ".."), undefined]) {
      const context = { ...atRoot, startupPath } as WorkspaceContext;
      const { printed, harnessCwd } = await runRecordedPlan(context);
      expect(printed, String(startupPath)).toBe("project-root");
      expect(harnessCwd, String(startupPath)).toBe(projectDir);
    }
  });

  it("keeps the session's subdirectory through the gateway's initialize and invoke_tool", async () => {
    // A harness's MCP server process starts in the session's directory and sends no roots, as OMP
    // does: the workspace is resolved from that cwd at connection time and again on initialize.
    const registry = new ToolRegistry();
    const gateway = new LocalMcpGateway({
      router: createRegistryGatewayRouter(registry),
      registry,
      enableRefreshCoordinator: false,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new McpFrameDecoder();
    const responses = new Map<number, (response: JsonRpcResponse) => void>();
    output.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if ("id" in message && typeof message.id === "number" && !("method" in message)) {
          responses.get(message.id)?.(message);
          responses.delete(message.id);
        }
      }
    });
    const connection = await gateway.processStream(input, output, { cwd: sessionDir });
    let nextId = 0;
    const request = (method: string, params?: JsonRpcParams): Promise<JsonRpcResponse> => {
      const id = ++nextId;
      const pending = new Promise<JsonRpcResponse>((resolve) => responses.set(id, resolve));
      input.write(encodeMcpMessage({ jsonrpc: "2.0", id, method, params }));
      return pending;
    };
    try {
      const initialized = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-coding-agent", version: "18.6.0" },
      });
      expect(initialized.error).toBeUndefined();
      input.write(encodeMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
      const workspace = connection.workspaceContext;
      expect(workspace.projectRoot).toBe(projectDir);
      expect(workspace.startupPath).toBe(sessionDir);

      const privateValues = new InMemoryPrivateValueStore();
      privateValues.set("private:sess:0", "cat marker.txt", {
        workspaceId: workspace.workspaceId,
      });
      const installed = await install(
        {
          id: "tool_gateway_session",
          name: "check_session_marker",
          version: "1.0.0",
          description: "a program recorded relative to the session's directory",
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
        JSON.stringify(
          compileRecordedWorkflow({
            schemaVersion: 1,
            workflowId: "check_session_marker",
            inputs: [],
            privateReferences: ["private:sess:0"],
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
          } as never).plan,
        ),
      );
      const { manifest, artifactDigest } = installed;
      // The production path: the learned tool's handler is the invocation router's, which runs
      // the locked, cached artifact on the local executor with the connection's workspace.
      const invocationRouter = new CloudInvocationRouter({
        localExecutor: new LocalArtifactExecutor({
          cache,
          workspaceRoot: projectDir,
          development: true,
          allowDevKeys: true,
          privateValueStore: privateValues,
          recordedWorkflowAdapters: (host) => recordedWorkflowRuntimeAdapters(host, {}),
        }),
        lockManager: {
          read: () => ({
            tools: {
              [manifest.id]: {
                toolId: manifest.id,
                name: manifest.name,
                version: manifest.version,
                artifactDigest,
                status: "active",
              },
            },
          }),
        } as never,
      });
      await registry.registerTool({
        toolId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifest,
        description: manifest.description,
        scope: "workspace",
        status: "active",
        handler: invocationRouter.createToolHandler(manifest.id),
      });
      await registry.activateToolVersion(manifest.id, manifest.version, workspace.workspaceId);

      const invoked = await request("tools/call", {
        name: "invoke_tool",
        arguments: { name: manifest.name, parameters: {} },
      });
      expect(invoked.error).toBeUndefined();
      const result = invoked.result as CallToolResult;
      const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
      expect(result.isError, text).toBeFalsy();
      expect(text).toContain("session-dir");
    } finally {
      input.end();
      gateway.close();
    }
  });

  it("does not follow a symlink inside the project that resolves outside it", () => {
    const link = path.join(projectDir, "escape");
    try {
      fs.symlinkSync(outsideDir, link, "junction");
    } catch {
      return; // Symlinks need privileges this host does not grant.
    }
    expect(sessionWorkingDirectory({ startupPath: link }, projectDir)).toBe(projectDir);
    expect(sessionWorkingDirectory({ startupPath: sessionDir }, projectDir)).toBe(sessionDir);
  });

  it.skipIf(!hasDeno)(
    "runs a generated tool's broker commands in the session's subdirectory",
    async () => {
      const printer = path.join(projectDir, "print-marker.cjs");
      fs.writeFileSync(
        printer,
        'process.stdout.write(require("node:fs").readFileSync("marker.txt", "utf8"));',
      );
      const installed = await install(
        {
          id: "tool_generated_session",
          name: "generated_session",
          version: "1.0.0",
          description: "a generated tool running a command",
          parameters: {
            type: "object",
            properties: { script: { type: "string" } },
            required: ["script"],
          },
          runtime: {
            runtime: "deno",
            entrypoint: "src/index.ts",
            memoryLimitMb: 128,
            timeoutMs: 10_000,
            cpuLimitPercent: 100,
            maxOutputSizeBytes: 65_536,
          },
          capabilities: {
            command: { allowShellExecution: false, allowedBinaries: ["node"] },
          },
        },
        `
import { defineTool } from "@resin/runtime";
export default defineTool(async (context) => {
  const result = await context.broker.cmd.exec("node", [context.input.script]);
  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
});`,
      );
      const executor = new LocalArtifactExecutor({
        cache,
        workspaceRoot: projectDir,
        allowDevKeys: true,
      });
      const invoke = (context: WorkspaceContext) =>
        executor.execute({
          entry: {
            toolId: installed.manifest.id,
            name: installed.manifest.name,
            version: installed.manifest.version,
            artifactDigest: installed.artifactDigest,
            manifestDigest: installed.manifestDigest,
          },
          manifest: installed.manifest,
          parameters: { script: printer },
          context,
        });

      const inSession = await invoke(resolveWorkspaceContext({ cwd: sessionDir }));
      expect(inSession.isError, String(inSession.content[0]?.text)).toBeFalsy();
      expect(JSON.parse(inSession.content[0]?.text ?? "{}")).toEqual({
        stdout: "session-dir",
        exitCode: 0,
      });

      const outside = await invoke({
        ...resolveWorkspaceContext({ cwd: projectDir }),
        startupPath: outsideDir,
      });
      expect(JSON.parse(outside.content[0]?.text ?? "{}")).toEqual({
        stdout: "project-root",
        exitCode: 0,
      });
    },
  );
});
