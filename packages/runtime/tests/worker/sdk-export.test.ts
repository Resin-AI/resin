import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/worker/sdk.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(currentDir, "../..");

/**
 * Honest build prerequisite check following repo build-test conventions.
 * Verifies that required built SDK distribution artifacts exist before executing
 * export and resolution tests. Main runs full workspace build during verification.
 */
function assertBuiltArtifactsPrerequisite(): void {
  const distSdkJs = path.join(runtimeDir, "dist/worker/sdk.js");
  const distSdkDts = path.join(runtimeDir, "dist/worker/sdk.d.ts");

  if (!fs.existsSync(distSdkJs) || !fs.existsSync(distSdkDts)) {
    throw new Error(
      "Missing required built SDK distribution artifacts in packages/runtime/dist/worker. Run workspace build ('pnpm turbo run build' or 'pnpm --filter @resin/runtime build') before running package export tests.",
    );
  }
}

describe("@resin/runtime/sdk subpath export and lightweight SDK suite", () => {
  beforeAll(() => {
    assertBuiltArtifactsPrerequisite();
  });

  describe("package export metadata", () => {
    it("defines '.' and './sdk' export conditions preserving root barrel and mapping SDK dist files", () => {
      const pkgJsonPath = path.join(runtimeDir, "package.json");
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

      expect(pkgJson.exports).toBeDefined();
      expect(pkgJson.exports["."]).toEqual({
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      });

      expect(pkgJson.exports["./sdk"]).toEqual({
        types: "./dist/worker/sdk.d.ts",
        import: "./dist/worker/sdk.js",
        default: "./dist/worker/sdk.js",
      });
    });

    it("verifies target SDK dist files and declarations exist on disk", () => {
      const distJs = path.join(runtimeDir, "dist/worker/sdk.js");
      const distDts = path.join(runtimeDir, "dist/worker/sdk.d.ts");

      expect(fs.existsSync(distJs)).toBe(true);
      expect(fs.existsSync(distDts)).toBe(true);
      expect(fs.statSync(distJs).size).toBeGreaterThan(0);
      expect(fs.statSync(distDts).size).toBeGreaterThan(0);
    });
  });

  describe("consumer resolution and SDK runtime behavior via public subpath", () => {
    it("resolves and exposes all 3 SDK values and helpers from @resin/runtime/sdk", async () => {
      // Dynamic import intentionally exercises package export resolution after assertBuiltArtifactsPrerequisite
      const sdk = await import("@resin/runtime/sdk");

      // 3 primary SDK values
      expect(typeof sdk.defineTool).toBe("function");
      expect(typeof sdk.createToolContext).toBe("function");
      expect(typeof sdk.DefaultToolBrokerClient).toBe("function");

      // Re-exported contract and secret helpers
      expect(typeof sdk.createSecretReference).toBe("function");
      expect(typeof sdk.createOpaqueSecretRef).toBe("function");
      expect(typeof sdk.isSecretReference).toBe("function");
      expect(typeof sdk.formatSecretTemplate).toBe("function");
      expect(typeof sdk.bearerToken).toBe("function");
      expect(typeof sdk.querySecret).toBe("function");
      expect(typeof sdk.stdinSecret).toBe("function");
      expect(typeof sdk.envSecret).toBe("function");
    });

    it("defineTool wraps handlers, adapts legacy definitions, and rejects invalid inputs", async () => {
      // Dynamic import intentionally exercises package export resolution after assertBuiltArtifactsPrerequisite
      const { defineTool } = await import("@resin/runtime/sdk");

      interface NumberInput {
        multiplier: number;
      }

      // Standard handler
      const handler = defineTool(async (ctx: ToolContext<NumberInput>) => {
        return ctx.input.multiplier * 3;
      });
      expect(typeof handler).toBe("function");
      const mockContext = { input: { multiplier: 7 } } as ToolContext<NumberInput>;
      const result = await handler(mockContext);
      expect(result).toBe(21);

      // Legacy object definition
      interface NameInput {
        name: string;
      }
      const legacy = defineTool({
        handler: (input: NameInput) => `hello-${input.name}`,
      });
      expect(typeof legacy).toBe("function");
      const mockLegacyContext = { input: { name: "resin" } } as ToolContext<NameInput>;
      const legacyResult = await legacy(mockLegacyContext);
      expect(legacyResult).toBe("hello-resin");

      // Rejects non-callable definitions
      const invalidNull = null as unknown as Parameters<typeof defineTool>[0];
      const invalidEmpty = {} as unknown as Parameters<typeof defineTool>[0];
      expect(() => defineTool(invalidNull)).toThrow(TypeError);
      expect(() => defineTool(invalidEmpty)).toThrow(TypeError);
    });

    it("createToolContext generates execution context with logger, progress, and brokers", async () => {
      // Dynamic import intentionally exercises package export resolution after assertBuiltArtifactsPrerequisite
      const { createToolContext } = await import("@resin/runtime/sdk");

      const progressRecords: Array<{ percent: number; message?: string; stage?: string }> = [];
      const logRecords: Array<{ level: string; message: string; data?: unknown }> = [];

      const ctx = createToolContext({
        input: { key: "test-value" },
        invocationId: "inv-test-export-1",
        workspaceRoot: "/test/workspace",
        scratchDir: "/tmp/scratch-export",
        metadata: { tag: "sdk-export-test" },
        onProgress: async (percent, message, stage) => {
          progressRecords.push({ percent, message, stage });
        },
        onLog: async (level, message, data) => {
          logRecords.push({ level, message, data });
        },
      });

      expect(ctx.input).toEqual({ key: "test-value" });
      expect(ctx.invocationId).toBe("inv-test-export-1");
      expect(ctx.workspaceRoot).toBe("/test/workspace");
      expect(ctx.scratchDir).toBe("/tmp/scratch-export");
      expect(ctx.metadata).toEqual({ tag: "sdk-export-test" });

      await ctx.progress(50, "Halfway done", "stage-run");
      expect(progressRecords).toEqual([
        { percent: 50, message: "Halfway done", stage: "stage-run" },
      ]);

      await ctx.logger.info("Informational message", { extra: 123 });
      expect(logRecords).toEqual([
        { level: "info", message: "Informational message", data: { extra: 123 } },
      ]);

      expect(ctx.broker).toBeDefined();
      expect(ctx.fs).toBeDefined();
      expect(ctx.net).toBeDefined();
      expect(ctx.cmd).toBeDefined();
      expect(ctx.secret).toBeDefined();
    });

    it("DefaultToolBrokerClient routes service operations through the request handler", async () => {
      // Dynamic import intentionally exercises package export resolution after assertBuiltArtifactsPrerequisite
      const { DefaultToolBrokerClient } = await import("@resin/runtime/sdk");

      const requests: Array<{ service: string; action: string; payload: unknown }> = [];
      const broker = new DefaultToolBrokerClient(async (service, action, payload) => {
        requests.push({ service, action, payload });
        if (service === "fs" && action === "readFile") {
          return { content: "mock-file-content" };
        }
        if (service === "fs" && action === "exists") {
          return { exists: true };
        }
        return null;
      });

      expect(broker.fs).toBeDefined();
      expect(broker.net).toBeDefined();
      expect(broker.cmd).toBeDefined();
      expect(broker.secret).toBeDefined();

      const exists = await broker.fs.exists("test.txt");
      expect(exists).toBe(true);

      const content = await broker.fs.readFile("test.txt", "utf-8");
      expect(content).toBe("mock-file-content");

      expect(requests).toEqual([
        { service: "fs", action: "exists", payload: { path: "test.txt" } },
        { service: "fs", action: "readFile", payload: { path: "test.txt", encoding: "utf-8" } },
      ]);
    });

    it("maintains backward compatibility with root barrel exports and ABI", async () => {
      // Dynamic import intentionally exercises package export resolution after assertBuiltArtifactsPrerequisite
      const root = await import("@resin/runtime");
      const sdk = await import("@resin/runtime/sdk");

      expect(root.defineTool).toBe(sdk.defineTool);
      expect(root.createToolContext).toBe(sdk.createToolContext);
      expect(root.DefaultToolBrokerClient).toBe(sdk.DefaultToolBrokerClient);
    });
  });

  describe("ToolContext generic declarations and type checking via @resin/runtime/sdk", () => {
    it("accepts strongly typed and inferred handlers through published SDK declarations", () => {
      const fileName = fileURLToPath(new URL("./typed-subpath-consumer.mts", import.meta.url));
      const source = `
        import {
          defineTool,
          createToolContext,
          DefaultToolBrokerClient,
          type ToolContext,
          type ToolHandler,
        } from "@resin/runtime/sdk";

        interface ToolInput {
          filePath: string;
          threshold?: number;
        }

        interface ToolOutput {
          matched: boolean;
          count: number;
        }

        export const typed: ToolHandler<ToolInput, ToolOutput> = defineTool(
          async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
            await context.logger.info("Checking file", { path: context.input.filePath });
            const exists = await context.broker.fs.exists(context.input.filePath);
            return {
              matched: exists,
              count: (context.input.threshold ?? 0) + 1,
            };
          },
        );

        export const inferred = defineTool<ToolInput, string>(async (context) => {
          return context.input.filePath;
        });

        export const context: ToolContext<ToolInput> = createToolContext<ToolInput>({
          input: { filePath: "/test/file.txt" },
          invocationId: "inv-typed-1",
          workspaceRoot: "/test/workspace",
        });

        export const broker = new DefaultToolBrokerClient(async () => ({ exists: true }));
      `;

      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: [],
      };

      const host = ts.createCompilerHost(options);
      const getSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (filePath, languageVersion, onError, shouldCreateNewSourceFile) =>
        filePath === fileName
          ? ts.createSourceFile(filePath, source, languageVersion, true)
          : getSourceFile(filePath, languageVersion, onError, shouldCreateNewSourceFile);

      const program = ts.createProgram([fileName], options, host);
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

      expect(errors).toEqual([]);
    });

    it("enforces generic type boundaries and rejects non-existent input fields", () => {
      const fileName = fileURLToPath(new URL("./invalid-subpath-consumer.mts", import.meta.url));
      const source = `
        import { defineTool, type ToolContext } from "@resin/runtime/sdk";

        interface StrictInput {
          validField: string;
        }

        export const bad = defineTool(async (context: ToolContext<StrictInput>) => {
          return context.input.nonExistentField;
        });
      `;

      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: [],
      };

      const host = ts.createCompilerHost(options);
      const getSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (filePath, languageVersion, onError, shouldCreateNewSourceFile) =>
        filePath === fileName
          ? ts.createSourceFile(filePath, source, languageVersion, true)
          : getSourceFile(filePath, languageVersion, onError, shouldCreateNewSourceFile);

      const program = ts.createProgram([fileName], options, host);
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((err) => err.includes("nonExistentField"))).toBe(true);
    });
  });

  describe("esbuild metafile regression for lightweight SDK consumer", () => {
    it("bundles a consumer of all 3 SDK values without retaining typescript or observer/adapters/compiler modules", async () => {
      const consumerCode = `
        import {
          defineTool,
          createToolContext,
          DefaultToolBrokerClient,
        } from "@resin/runtime/sdk";

        export const tool = defineTool(async (context) => {
          await context.logger.info("Executing consumer tool");
          const exists = await context.broker.fs.exists(context.input.targetPath);
          return { found: exists, root: context.workspaceRoot };
        });

        export const ctx = createToolContext({
          input: { targetPath: "/workspace/project" },
          invocationId: "inv-consumer-1",
          workspaceRoot: "/workspace/project",
        });

        export const broker = new DefaultToolBrokerClient(async () => ({ exists: true }));
      `;

      const result = await esbuild.build({
        stdin: {
          contents: consumerCode,
          resolveDir: runtimeDir,
          loader: "ts",
          sourcefile: "sdk-consumer.ts",
        },
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        write: false,
        metafile: true,
        treeShaking: true,
      });

      expect(result.metafile).toBeDefined();
      const metafile = result.metafile!;
      const inputKeys = Object.keys(metafile.inputs);

      // Verify no heavy compiler, observer, adapter, or verifier modules are retained
      const hasTypeScript = inputKeys.some(
        (key) => key.includes("typescript") || key.includes("tsserver") || key.includes("/tsc/"),
      );
      expect(hasTypeScript).toBe(false);

      const hasObserver = inputKeys.some(
        (key) => key.includes("@resin/observer") || key.includes("/observer/"),
      );
      expect(hasObserver).toBe(false);

      const hasAdapters = inputKeys.some(
        (key) => key.includes("@resin/adapter") || key.includes("/adapters/"),
      );
      expect(hasAdapters).toBe(false);

      const hasCompilerOrVerifier = inputKeys.some(
        (key) =>
          key.includes("verifier") || key.includes("compiler.ts") || key.includes("compiler.js"),
      );
      expect(hasCompilerOrVerifier).toBe(false);

      // Verify sensible small bundle ceiling: SDK consumer bundle must be under 512 KiB (measured ~234 KiB / 240,047 bytes)
      // (the root barrel retains the ~10.6 MB TypeScript compiler)
      const outputs = Object.values(metafile.outputs);
      expect(outputs.length).toBeGreaterThan(0);
      const totalBundleBytes = outputs.reduce((sum, out) => sum + out.bytes, 0);

      expect(totalBundleBytes).toBeLessThan(512 * 1024);
      expect(totalBundleBytes).toBeGreaterThan(0);
    });
  });
});
