import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BrokerRequestHandlerFn,
  type ToolContext,
  ToolRuntime,
  defineTool,
} from "../../src/worker/index.js";

describe("ToolRuntime and DeterministicWorkerSandbox", () => {
  const runtime = new ToolRuntime({ mode: "in-process" });

  it("executes pure compute tool returning schema-valid output", async () => {
    const manifest = {
      id: "calculator",
      name: "Calculator",
      version: "1.0.0",
      description: "Performs basic math",
      parameters: {
        type: "object" as const,
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          op: { type: "string" },
        },
        required: ["a", "b", "op"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          result: { type: "number" },
        },
        required: ["result"],
        additionalProperties: false,
      },
      runtime: {
        runtime: "builtin" as const,
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      capabilities: {},
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const handler = defineTool(async (ctx: ToolContext<{ a: number; b: number; op: string }>) => {
      const { a, b, op } = ctx.input;
      if (op === "+") return { result: a + b };
      if (op === "*") return { result: a * b };
      throw new Error(`Unsupported op: ${op}`);
    });

    const res = await runtime.executeTool(manifest, handler, { a: 10, b: 25, op: "+" });

    expect(res.status).toBe("success");
    expect(res.output).toEqual({ result: 35 });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails input validation when required parameters are missing", async () => {
    const manifest = {
      id: "strict-tool",
      name: "Strict Tool",
      version: "1.0.0",
      description: "Requires specific input",
      parameters: {
        type: "object" as const,
        properties: {
          target: { type: "string" },
        },
        required: ["target"],
        additionalProperties: false,
      },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const handler = defineTool(async (ctx: ToolContext<{ target: string }>) => {
      return { msg: ctx.input.target };
    });

    const res = await runtime.executeTool(manifest, handler, {});
    expect(res.status).toBe("validation_error");
    expect(res.error?.message).toContain("Input validation failed");
  });

  it("fails output validation when tool returns schema-violating output", async () => {
    const manifest = {
      id: "bad-output-tool",
      name: "Bad Output Tool",
      version: "1.0.0",
      description: "Returns wrong shape",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
        additionalProperties: true,
      },
      outputSchema: {
        type: "object",
        properties: {
          score: { type: "number" },
        },
        required: ["score"],
        additionalProperties: false,
      },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    // Tool returns a string instead of number
    const handler = defineTool(async () => {
      return { score: "not-a-number" };
    });

    const res = await runtime.executeTool(manifest, handler, {});
    expect(res.status).toBe("validation_error");
    expect(res.error?.message).toContain("Output validation failed");
  });

  it("enforces wall-clock timeout and terminates hung operations", async () => {
    const manifest = {
      id: "slow-tool",
      name: "Slow Tool",
      version: "1.0.0",
      description: "Hangs indefinitely",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
        additionalProperties: true,
      },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };
    // Integration test deliberately exercising real timer behavior against the platform clock to verify timeout enforcement.
    const slowHandler = defineTool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { done: true };
    });
    const res = await runtime.executeTool(manifest, slowHandler, {}, { timeoutMs: 50 });
    expect(res.status).toBe("timeout");
    expect(res.error?.type).toBe("timeout");
    expect(res.error?.message).toContain("timed out");
  });

  it("captures logs and progress events during execution", async () => {
    const manifest = {
      id: "logging-tool",
      name: "Logging Tool",
      version: "1.0.0",
      description: "Logs messages and emits progress",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
        additionalProperties: true,
      },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const handler = defineTool(async (ctx: ToolContext) => {
      await ctx.progress(10, "Starting up", "init");
      await ctx.logger.info("Initializing run", { step: 1 });
      await ctx.progress(90, "Finishing", "final");
      return { completed: true };
    });

    const res = await runtime.executeTool(manifest, handler, {});
    expect(res.status).toBe("success");
    expect(res.progress).toHaveLength(2);
    expect(res.progress[0]?.percentage).toBe(10);
    expect(res.progress[1]?.percentage).toBe(90);
    expect(res.logs).toHaveLength(1);
    expect(res.logs[0]?.level).toBe("info");
    expect(res.logs[0]?.message).toBe("Initializing run");
  });

  it("handles deterministic broker requests with fake broker and fixtures", async () => {
    const manifest = {
      id: "brokered-tool",
      name: "Brokered Tool",
      version: "1.0.0",
      description: "Uses broker clients",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
        additionalProperties: true,
      },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const fakeDb = new Map<string, string>();
    fakeDb.set("config.json", JSON.stringify({ mode: "production" }));

    const brokerHandler: BrokerRequestHandlerFn = async (service, action, payload) => {
      if (service === "fs" && action === "readFile") {
        const p = String(payload?.path ?? "");
        if (!fakeDb.has(p)) throw new Error("File not found");
        return { content: fakeDb.get(p) ?? "", encoding: "utf-8" };
      }
      throw new Error(`Unhandled ${service}.${action}`);
    };

    const handler = defineTool(async (ctx: ToolContext) => {
      const configStr = await ctx.broker.fs.readFile("config.json");
      const config = JSON.parse(String(configStr));
      const tokenRef = ctx.broker.secret.createReference("AUTH_TOKEN");
      return { mode: config.mode, tokenRef: tokenRef.name };
    });

    const res = await runtime.executeTool(manifest, handler, {}, { brokerHandler });
    expect(res.status).toBe("success");
    expect(res.output).toEqual({ mode: "production", tokenRef: "AUTH_TOKEN" });
  });

  it("executes inline JavaScript source code bundle in sandbox", async () => {
    const manifest = {
      id: "inline-bundle-tool",
      name: "Inline Bundle Tool",
      version: "1.0.0",
      description: "Inline code execution",
      parameters: {
        type: "object" as const,
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { doubled: { type: "number" } },
        required: ["doubled"],
      },
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      createdAt: new Date().toISOString(),
    };

    const inlineScript = `
      module.exports = async function(ctx) {
        return { doubled: ctx.input.value * 2 };
      };
    `;

    const res = await runtime.executeTool(manifest, inlineScript, { value: 21 });
    expect(res.status).toBe("success");
    expect(res.output).toEqual({ doubled: 42 });
  });
});
