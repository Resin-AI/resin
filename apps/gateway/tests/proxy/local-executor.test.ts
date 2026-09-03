import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { ArtifactCache, encodeDeterministicTar } from "@resin/runtime";
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
  limits?: ToolManifest["limits"];
  scope?: ToolManifest["scope"];
}

describe("LocalArtifactExecutor", () => {
  let tempDir: string;
  let cacheDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-exec-test-"));
    cacheDir = path.join(tempDir, "artifacts");
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    cache = new ArtifactCache({ cacheDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  async function installBundleToCache(
    manifestInput: TestManifestInput,
    sourceCode: string,
    options: { corruptMetadata?: boolean } = {},
  ): Promise<{ artifactDigest: string; manifestDigest: string; manifest: ToolManifest }> {
    const manifestWithDefaults = {
      capabilities: {},
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-09-02T00:00:00.000Z",
      ...manifestInput,
    };
    const manifestDigest = computeManifestDigest(manifestWithDefaults as ToolManifest);
    const fullManifest = { ...manifestWithDefaults, digest: manifestDigest } as ToolManifest;

    const { archive: plainTar } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(fullManifest) },
      { path: "src/index.ts", content: sourceCode },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(plainTar).digest("hex");

    const stagingDir = await cache.createStagingDirectory(artifactDigest);
    const targetManifest = path.join(stagingDir, "manifest.json");
    const targetSource = path.join(stagingDir, "src/index.ts");
    fs.mkdirSync(path.dirname(targetSource), { recursive: true });
    fs.writeFileSync(targetManifest, JSON.stringify(fullManifest), "utf8");
    fs.writeFileSync(targetSource, sourceCode, "utf8");

    await cache.commitStagingDirectory(stagingDir, artifactDigest, {
      digest: options.corruptMetadata ? "corrupted-digest" : artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: plainTar.length,
      entrypoint: "src/index.ts",
      verified: true,
    });

    return { artifactDigest, manifestDigest, manifest: fullManifest };
  }

  it("canExecute verifies presence, manifest and version in cache", async () => {
    const toolId = "test-calc-tool-001";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "calc_tool",
      version: "1.0.0",
      description: "Calculator",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const { artifactDigest } = await installBundleToCache(
      manifestBase,
      "export default async (ctx) => ({ sum: ctx.input.a + ctx.input.b });",
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    // Valid entry
    expect(
      executor.canExecute({
        toolId,
        version: "1.0.0",
        artifactDigest,
      }),
    ).toBe(true);

    // Missing artifact digest
    expect(
      executor.canExecute({
        toolId,
        version: "1.0.0",
        artifactDigest: "nonexistent-digest-12345",
      }),
    ).toBe(false);

    // Mismatched toolId
    expect(
      executor.canExecute({
        toolId: "different-tool-id",
        version: "1.0.0",
        artifactDigest,
      }),
    ).toBe(false);

    // Mismatched version
    expect(
      executor.canExecute({
        toolId,
        version: "2.0.0",
        artifactDigest,
      }),
    ).toBe(false);
  });

  it("executes tiny bundle fixture and returns output as MCP CallToolResult", async () => {
    const toolId = "test-add-tool-002";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "adder",
      version: "1.0.0",
      description: "Adds numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const { artifactDigest, manifestDigest, manifest } = await installBundleToCache(
      manifestBase,
      "export default async (ctx) => ({ result: ctx.input.a + ctx.input.b });",
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    const result = await executor.execute({
      entry: {
        toolId,
        name: "adder",
        version: "1.0.0",
        artifactDigest,
        manifestDigest,
      },
      manifest,
      parameters: { a: 15, b: 27 },
      context: ws,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe("text");
    const parsedOutput = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsedOutput).toEqual({ result: 42 });
  });

  it("executes bundle with standard filesystem broker rooted at workspace directory", async () => {
    const toolId = "test-fs-tool-003";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "fs_writer",
      version: "1.0.0",
      description: "Writes workspace file",
      parameters: {
        type: "object",
        properties: { filename: { type: "string" }, message: { type: "string" } },
        required: ["filename", "message"],
      },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const { artifactDigest, manifestDigest, manifest } = await installBundleToCache(
      manifestBase,
      `export default async (ctx) => {
        await ctx.fs.writeFile(ctx.input.filename, ctx.input.message);
        const readBack = await ctx.fs.readFile(ctx.input.filename);
        return { written: readBack };
      };`,
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    const result = await executor.execute({
      entry: {
        toolId,
        name: "fs_writer",
        version: "1.0.0",
        artifactDigest,
        manifestDigest,
      },
      manifest,
      parameters: { filename: "hello.txt", message: "local-artifact-broker-works" },
      context: ws,
    });
    expect(result.isError).toBeFalsy();
    const parsedOutput = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsedOutput).toEqual({ written: "local-artifact-broker-works" });

    // Verify file actually exists in workspace root on host disk
    const onDisk = fs.readFileSync(path.join(workspaceDir, "hello.txt"), "utf8");
    expect(onDisk).toBe("local-artifact-broker-works");
  });

  it("fails closed on manifest digest mismatch", async () => {
    const toolId = "test-tampered-tool-004";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "safe_tool",
      version: "1.0.0",
      description: "Safe tool",
      parameters: { type: "object", properties: {} },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const { artifactDigest, manifest } = await installBundleToCache(
      manifestBase,
      "export default async () => ({ status: 'ok' });",
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    // Provided manifestDigest does not match actual manifest
    const result = await executor.execute({
      entry: {
        toolId,
        name: "safe_tool",
        version: "1.0.0",
        artifactDigest,
        manifestDigest: "0".repeat(64), // Mismatch!
      },
      manifest,
      parameters: {},
      context: ws,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Manifest digest mismatch");
  });

  it("enforces timeout limits", async () => {
    const toolId = "test-timeout-tool-005";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "slow_tool",
      version: "1.0.0",
      description: "Slow tool",
      parameters: { type: "object", properties: {} },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      limits: { timeoutMs: 150 },
    };

    // Note: Deno executes in a separate OS child process whose wall-clock timeout cannot be simulated with host fake timers.
    const { artifactDigest, manifestDigest, manifest } = await installBundleToCache(
      manifestBase,
      "export default async () => { const end = Date.now() + 5000; while (Date.now() < end) {} return { done: true }; };",
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    const result = await executor.execute({
      entry: {
        toolId,
        name: "slow_tool",
        version: "1.0.0",
        artifactDigest,
        manifestDigest,
      },
      manifest,
      parameters: {},
      context: ws,
      timeoutMs: 150,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/timed out/i);
  });

  it("executes bundle importing only @resin/runtime successfully", async () => {
    const toolId = "test-runtime-shim-tool-006";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "shim_user",
      version: "1.0.0",
      description: "Uses @resin/runtime shim",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const sourceCode = `
import { defineTool, type ToolContext } from "@resin/runtime";

export default defineTool(async (context: ToolContext<{ name: string }>) => {
  return { greeting: "Hello, " + context.input.name + "!" };
});
`;

    const { artifactDigest, manifestDigest, manifest } = await installBundleToCache(
      manifestBase,
      sourceCode,
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    const result = await executor.execute({
      entry: {
        toolId,
        name: "shim_user",
        version: "1.0.0",
        artifactDigest,
        manifestDigest,
      },
      manifest,
      parameters: { name: "Resin" },
      context: ws,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(result.content[0]?.type).toBe("text");
    const parsedOutput = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsedOutput).toEqual({ greeting: "Hello, Resin!" });
  });

  it("fails closed when bundle imports unsupported bare specifier zod", async () => {
    const toolId = "test-zod-forbidden-tool-007";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "zod_user",
      version: "1.0.0",
      description: "Attempts to import zod",
      parameters: {
        type: "object",
        properties: { val: { type: "string" } },
        required: ["val"],
      },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const sourceCode = `
import { defineTool } from "@resin/runtime";
import { z } from "zod";

export default defineTool(async (context: { input: { val: string } }) => {
  const schema = z.string();
  return { result: schema.parse(context.input.val) };
});
`;

    const { artifactDigest, manifestDigest, manifest } = await installBundleToCache(
      manifestBase,
      sourceCode,
    );

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    const result = await executor.execute({
      entry: {
        toolId,
        name: "zod_user",
        version: "1.0.0",
        artifactDigest,
        manifestDigest,
      },
      manifest,
      parameters: { val: "test" },
      context: ws,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("zod");
  });

  it("spawns resolved Deno binary directly without creating shell shims outside scratch directory", async () => {
    const toolId = "test-no-shim-008";
    const manifestBase: TestManifestInput = {
      id: toolId,
      name: "no_shim_tool",
      version: "1.0.0",
      description: "Verifies no shell shim is written to tmpdir",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      runtime: {
        runtime: "deno",
        entrypoint: "src/index.ts",
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
    };

    const { artifactDigest, manifestDigest, manifest } = await installBundleToCache(
      manifestBase,
      "export default async (ctx: { input: { text: string } }) => ({ echoed: ctx.input.text });",
    );

    const tmpdirShimBefore = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("resin-deno-shim-"));

    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      allowDevKeys: true,
    });

    const ws = resolveWorkspaceContext({ cwd: workspaceDir });

    const result = await executor.execute({
      entry: {
        toolId,
        name: "no_shim_tool",
        version: "1.0.0",
        artifactDigest,
        manifestDigest,
      },
      manifest,
      parameters: { text: "direct-deno-execution" },
      context: ws,
    });

    expect(result.isError).toBeFalsy();
    const parsedOutput = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsedOutput).toEqual({ echoed: "direct-deno-execution" });

    const tmpdirShimAfter = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("resin-deno-shim-"));
    expect(tmpdirShimAfter.length).toBe(tmpdirShimBefore.length);
  });
});
