/**
 * `for_each` on a learned tool, driven through the real gateway router, cloud invocation router,
 * and local executor: each value runs the recorded program on the host, in order.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InvocationRecord, ToolManifest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_PROCESS_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTool } from "../src/protocol/types.js";
import { LocalArtifactExecutor } from "../src/proxy/local-executor.js";
import { CloudInvocationRouter } from "../src/proxy/router.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { computeManifestDigest } from "../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../src/router.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../src/workspace-resolver.js";

const PROGRAM = "mkdir gamma && echo gamma >> order.log";
const RUNTIME = {
  runtime: "recorded-workflow" as const,
  memoryLimitMb: 64,
  timeoutMs: 10_000,
  cpuLimitPercent: 100,
  maxOutputSizeBytes: 65_536,
};

describe("for_each on learned tools", () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "for-each-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A learned "release" tool whose recorded program creates the project dir and logs its name. */
  async function setup(
    parameters: ToolManifest["parameters"] = {
      type: "object",
      properties: { project: { type: "string" } },
      additionalProperties: false,
    },
  ) {
    const cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    const context: WorkspaceContext = resolveWorkspaceContext({ cwd: workspaceDir });
    const privateValues = new InMemoryPrivateValueStore();
    privateValues.set("private:sess:0", PROGRAM, { workspaceId: context.workspaceId });
    const manifestBase = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "release_project",
      version: "1.0.0",
      description: "release one project",
      parameters,
      runtime: RUNTIME,
      capabilities: {
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https" as const],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
        command: {
          allowShellExecution: true,
          allowedCommands: [],
          allowedBinaries: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
        secrets: {
          allowedSecretNames: [],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxConcurrentExecutions: 4,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      },
      limits: {
        timeoutMs: 30000,
        maxOutputBytes: 1048576,
        maxMemoryBytes: 134217728,
        maxConcurrentInvocations: 4,
      },
      metadata: {},
      scope: "workspace" as const,
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const manifest = {
      ...manifestBase,
      digest: computeManifestDigest(manifestBase as ToolManifest),
    } as ToolManifest;
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_release",
      inputs: [{ name: "project", type: "string", recordedDefault: true }],
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
                template: {
                  type: "program",
                  language: "shell",
                  source: { type: "private", reference: "private:sess:0" },
                  holes: [
                    { token: 1, binding: { type: "input", name: "project" } },
                    { token: 4, binding: { type: "input", name: "project" } },
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
    const staging = await cache.createStagingDirectory(artifactDigest);
    fs.mkdirSync(path.join(staging, "src"), { recursive: true });
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest), "utf8");
    fs.writeFileSync(path.join(staging, "src", "index.ts"), entrypoint, "utf8");
    await cache.commitStagingDirectory(staging, artifactDigest, {
      digest: artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: archive.length,
      entrypoint: "src/index.ts",
      verified: true,
    });

    const localExecutor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
      recordedWorkflowAdapters: () => [createProcessAdapter({ cwd: workspaceDir })],
    });
    const records: InvocationRecord[] = [];
    const registry = new ToolRegistry({
      onInvocationRecorded: async (record) => {
        records.push(record);
      },
    });
    await registry.registerTool({
      toolId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest,
      manifestDigest: manifest.digest,
      artifactDigest,
      scope: "workspace",
      status: "active",
      workspaceId: context.workspaceId,
      parameters: manifest.parameters,
    });
    const router = createRegistryGatewayRouter(
      registry,
      new CloudInvocationRouter({ localExecutor }),
    );
    // The workspace's own lock pins the learned tool to the cached artifact.
    const lockPath = context.lockPath as string;
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.tools = {
      [manifest.name]: {
        toolId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifestDigest: manifest.digest,
        artifactDigest,
        status: "active",
      },
    };
    fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");
    return { router, context, records };
  }

  const orderLog = () => fs.readFileSync(path.join(workspaceDir, "order.log"), "utf8");
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((item) => item.text ?? "").join("\n");

  it("lists for_each only for learned tools with a text input and no real for_each input", async () => {
    const listedSchema = async (parameters: ToolManifest["parameters"]) => {
      const { router, context } = await setup(parameters);
      const tools: McpTool[] = await router.listTools(context);
      return tools.find((tool) => tool.name === "release_project")?.inputSchema;
    };
    const withText = await listedSchema({
      type: "object",
      properties: { project: { type: "string" } },
      additionalProperties: false,
    });
    expect(Object.keys(withText?.properties ?? {})).toEqual(["project", "for_each"]);
    expect(withText?.additionalProperties).toBe(false);

    const numbersOnly = {
      type: "object" as const,
      properties: { count: { type: "number" } },
      additionalProperties: false,
    };
    expect(await listedSchema(numbersOnly)).toEqual(numbersOnly);

    const realForEach = {
      type: "object" as const,
      properties: { project: { type: "string" }, for_each: { type: "string" } },
    };
    expect(await listedSchema(realForEach)).toEqual(realForEach);
  });

  it("runs the tool once per value, in order, with real effects and per-run accounting", async () => {
    const { router, context, records } = await setup();
    const result = await router.callTool(context, "release_project", {
      for_each: { project: ["gamma", "alpha"] },
    });
    expect(result.isError, text(result)).toBeFalsy();
    expect(orderLog()).toBe("gamma\nalpha\n");
    expect(fs.statSync(path.join(workspaceDir, "gamma")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(workspaceDir, "alpha")).isDirectory()).toBe(true);
    expect(text(result).indexOf("[project=gamma]")).toBeLessThan(
      text(result).indexOf("[project=alpha]"),
    );

    // Two single calls in a fresh workspace leave the same ledger.
    const repeatedRecords = records.map(
      ({ toolId, toolVersion, status, inputDigest, outputDigest }) => ({
        toolId,
        toolVersion,
        status,
        inputDigest,
        outputDigest,
      }),
    );
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const single = await setup();
    await single.router.callTool(single.context, "release_project", { project: "gamma" });
    await single.router.callTool(single.context, "release_project", { project: "alpha" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(repeatedRecords).toHaveLength(2);
    expect(
      single.records.map(({ toolId, toolVersion, status, inputDigest, outputDigest }) => ({
        toolId,
        toolVersion,
        status,
        inputDigest,
        outputDigest,
      })),
    ).toEqual(repeatedRecords);
  });

  it("stops at the first failing value and does not run the rest", async () => {
    const { router, context, records } = await setup();
    fs.mkdirSync(path.join(workspaceDir, "beta"));
    const result = await router.callTool(context, "release_project", {
      for_each: { project: ["gamma", "beta", "alpha"] },
    });
    expect(result.isError).toBe(true);
    expect(orderLog()).toBe("gamma\n");
    expect(fs.existsSync(path.join(workspaceDir, "alpha"))).toBe(false);
    expect(text(result)).toContain("project=beta failed");
    expect(text(result)).toContain("not run: project=alpha");
    await new Promise((resolve) => setImmediate(resolve));
    expect(records.map((record) => record.status)).toEqual(["success", "error"]);
  });

  it("runs through invoke_tool the same way", async () => {
    const { router, context } = await setup();
    const result = await router.callTool(context, "invoke_tool", {
      name: "release_project",
      arguments: { for_each: { project: ["gamma", "alpha"] } },
    });
    expect(result.isError, text(result)).toBeFalsy();
    expect(orderLog()).toBe("gamma\nalpha\n");
  });

  it.each([
    ["an unknown input", { for_each: { other: ["a", "b"] } }],
    ["one value", { for_each: { project: ["gamma"] } }],
    [
      "more than twenty values",
      { for_each: { project: Array.from({ length: 21 }, (_, i) => `p${i}`) } },
    ],
    ["non-string values", { for_each: { project: ["gamma", 7] } }],
    ["two inputs", { for_each: { project: ["gamma", "alpha"], other: ["a", "b"] } }],
    ["a conflicting direct value", { project: "beta", for_each: { project: ["gamma", "alpha"] } }],
    ["a non-object for_each", { for_each: ["gamma", "alpha"] }],
  ])("rejects %s without running anything", async (_label, args) => {
    const { router, context, records } = await setup();
    for (const call of [
      () => router.callTool(context, "release_project", args as never),
      () =>
        router.callTool(context, "invoke_tool", {
          name: "release_project",
          arguments: args as never,
        }),
    ]) {
      const result = await call();
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Invalid for_each");
    }
    expect(fs.existsSync(path.join(workspaceDir, "order.log"))).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(records).toEqual([]);
  });
});
