import {
  CapabilityManifestSchema,
  type InvocationRecord,
  InvocationRecordSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import type {
  ToolInvocationRequest,
  ToolInvocationRouter,
} from "../../src/meta/router-contract.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const raw = {
    id: overrides?.id ?? "tool_validator",
    name: overrides?.name ?? "validate_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Tool with strict schemas",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 100, description: "Item count" },
          mode: { type: "string", enum: ["fast", "safe"], description: "Execution mode" },
          tag: { type: "string", minLength: 3, description: "Tag name" },
        },
        required: ["count", "mode"],
      },
    ),
    runtime: ToolRuntimeRequirementSchema.parse({
      runtime: "builtin",
    }),
    capabilities: CapabilityManifestSchema.parse(overrides?.capabilities ?? {}),
    limits: ToolLimitConfigSchema.parse(overrides?.limits ?? { timeoutMs: 1000 }),
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T00:00:00.000Z",
  };

  return {
    ...raw,
    digest: computeManifestDigest(raw),
  };
}

function makeContext(workspaceId = "ws-invoke", sessionId?: string): WorkspaceContext {
  return {
    workspaceId,
    canonicalRoot: `/workspaces/${workspaceId}`,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
    sessionId,
    harnessId: "test-harness",
  };
}

describe("invoke_tool Meta-Tool", () => {
  it("validates required parameters strictly against manifest schema", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    const mockRouter: ToolInvocationRouter = {
      async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "OK" }] };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter);
    const context = makeContext("ws-invoke");

    // Missing 'count' and 'mode'
    const resMissing = await handler(context, {
      toolId: "tool_validator",
      parameters: {},
    });
    expect(resMissing.isError).toBe(true);
    expect(resMissing.content[0].text).toContain("Parameter validation failed");
    expect(resMissing.content[0].text).toContain("Missing required parameter 'count'");
    expect(resMissing.content[0].text).toContain("Missing required parameter 'mode'");
  });

  it("validates parameter types, enums, and bounds strictly", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    const mockRouter: ToolInvocationRouter = {
      async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "OK" }] };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter);
    const context = makeContext("ws-invoke");

    // Type mismatch (count is string instead of integer)
    const resType = await handler(context, {
      toolId: "tool_validator",
      parameters: { count: "not-a-number", mode: "fast" },
    });
    expect(resType.isError).toBe(true);
    expect(resType.content[0].text).toContain("must be an integer");

    // Enum violation (mode is 'invalid')
    const resEnum = await handler(context, {
      toolId: "tool_validator",
      parameters: { count: 10, mode: "turbo" },
    });
    expect(resEnum.isError).toBe(true);
    expect(resEnum.content[0].text).toContain("must be one of");

    // Bounds violation (count is 500, maximum is 100)
    const resBounds = await handler(context, {
      toolId: "tool_validator",
      parameters: { count: 500, mode: "fast" },
    });
    expect(resBounds.isError).toBe(true);
    expect(resBounds.content[0].text).toContain("must be <= 100");

    // MinLength violation (tag is 1 char, minLength is 3)
    const resLength = await handler(context, {
      toolId: "tool_validator",
      parameters: { count: 5, mode: "fast", tag: "a" },
    });
    expect(resLength.isError).toBe(true);
    expect(resLength.content[0].text).toContain("must be at least 3 characters");
  });

  it("dispatches valid invocation to ToolInvocationRouter preserving workspace context", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    let capturedRequest: ToolInvocationRequest | undefined;
    const mockRouter: ToolInvocationRouter = {
      async invoke(req: ToolInvocationRequest): Promise<CallToolResult> {
        capturedRequest = req;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ executed: true, receivedCount: req.parameters.count }),
            },
          ],
        };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter);
    const context = makeContext("ws-invoke", "session-xyz");

    const res = await handler(context, {
      name: "validate_tool",
      parameters: { count: 42, mode: "safe" },
    });

    expect(res.isError).toBeFalsy();
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.toolId).toBe("tool_validator");
    expect(capturedRequest?.name).toBe("validate_tool");
    expect(capturedRequest?.context.workspaceId).toBe("ws-invoke");
    expect(capturedRequest?.context.sessionId).toBe("session-xyz");
    expect(capturedRequest?.context.harnessId).toBe("test-harness");
    expect(capturedRequest?.parameters).toEqual({ count: 42, mode: "safe" });
  });

  it("handles execution timeout and aborts downstream request", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ limits: { timeoutMs: 10 } });
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    // Integration test deliberately checking real platform timeout cancellation
    const slowRouter: ToolInvocationRouter = {
      async invoke(req: ToolInvocationRequest): Promise<CallToolResult> {
        await new Promise<void>((resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new Error("Aborted by timeout"));
          });
        });
        return { content: [{ type: "text", text: "Done" }] };
      },
    };

    const handler = createInvokeToolHandler(registry, slowRouter);
    const context = makeContext("ws-invoke");

    const res = await handler(context, {
      toolId: "tool_validator",
      parameters: { count: 10, mode: "fast" },
      timeout_ms: 10,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("timed out after 10ms");
  });

  it("handles caller cancellation via parent AbortSignal cleanly", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    const abortController = new AbortController();
    abortController.abort(); // Pre-aborted signal

    const cancellableRouter: ToolInvocationRouter = {
      async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "Done" }] };
      },
    };

    const handler = createInvokeToolHandler(registry, cancellableRouter);
    const context = makeContext("ws-invoke");

    const res = await handler(
      context,
      {
        toolId: "tool_validator",
        parameters: { count: 10, mode: "fast" },
      },
      { signal: abortController.signal },
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("was cancelled");
  });

  it("rejects invoking disabled tools", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ id: "tool_disabled", name: "disabled_tool" });
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });
    await registry.disableTool("tool_disabled", "ws-invoke");

    const mockRouter: ToolInvocationRouter = {
      async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "OK" }] };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter);
    const context = makeContext("ws-invoke");

    const res = await handler(context, {
      toolId: "tool_disabled",
      parameters: { count: 1, mode: "fast" },
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("is disabled in workspace");
  });

  it("invokes onInvocationRecorded hook with a schema-valid record on success", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    const { promise, resolve } = Promise.withResolvers<InvocationRecord>();
    const onInvocationRecorded = async (record: InvocationRecord) => {
      resolve(record);
    };
    const mockRouter: ToolInvocationRouter = {
      async invoke(req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: `Success: ${req.parameters.count}` }] };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter, { onInvocationRecorded });
    const context = makeContext("ws-invoke", "session-xyz");

    const res = await handler(context, {
      name: "validate_tool",
      parameters: { count: 42, mode: "safe" },
    });

    expect(res.isError).toBeFalsy();
    const capturedRecord = await promise;
    expect(capturedRecord).toBeDefined();
    const validated = InvocationRecordSchema.parse(capturedRecord);
    expect(validated.status).toBe("success");
    expect(validated.toolId).toBe("tool_validator");
    expect(validated.toolVersion).toBe("1.0.0");
    expect(validated.sessionId).toBe("session-xyz");
    expect(validated.workspaceId).toBe("ws-invoke");
    expect(validated.durationMs).toBeGreaterThanOrEqual(0);
    expect(validated.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("invokes onInvocationRecorded hook with a schema-valid record on error", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    const { promise, resolve } = Promise.withResolvers<InvocationRecord>();
    const onInvocationRecorded = async (record: InvocationRecord) => {
      resolve(record);
    };
    const mockRouter: ToolInvocationRouter = {
      async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
        throw new Error("Target service unavailable");
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter, undefined, onInvocationRecorded);
    const context = makeContext("ws-invoke", "session-abc");

    const res = await handler(context, {
      name: "validate_tool",
      parameters: { count: 10, mode: "fast" },
    });

    expect(res.isError).toBe(true);
    const capturedRecord = await promise;
    expect(capturedRecord).toBeDefined();
    const validated = InvocationRecordSchema.parse(capturedRecord);
    expect(validated.status).toBe("error");
    expect(validated.toolId).toBe("tool_validator");
    expect(validated.sessionId).toBe("session-abc");
    expect(validated.errorDetails).toBeDefined();
    expect(validated.errorDetails?.message).toContain("Target service unavailable");
  });

  it("does not call onInvocationRecorded for system meta-tools", async () => {
    const registry = new ToolRegistry();

    let capturedRecord: InvocationRecord | undefined;
    const onInvocationRecorded = async (record: InvocationRecord) => {
      capturedRecord = record;
    };

    const mockRouter: ToolInvocationRouter = {
      async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "OK" }] };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter, { onInvocationRecorded });
    const context = makeContext("ws-invoke");

    // Invoke search_tools through invoke_tool
    await handler(context, {
      name: "search_tools",
      parameters: {},
    });

    // Allow any microtasks to drain
    await Promise.resolve();
    expect(capturedRecord).toBeUndefined();
  });

  it("does not alter tool result when onInvocationRecorded throws", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest();
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-invoke" });

    const onInvocationRecorded = async () => {
      throw new Error("Telemetry recording crashed");
    };

    const mockRouter: ToolInvocationRouter = {
      async invoke(req: ToolInvocationRequest): Promise<CallToolResult> {
        return { content: [{ type: "text", text: `Success: ${req.parameters.count}` }] };
      },
    };

    const handler = createInvokeToolHandler(registry, mockRouter, { onInvocationRecorded });
    const context = makeContext("ws-invoke");

    const res = await handler(context, {
      name: "validate_tool",
      parameters: { count: 5, mode: "fast" },
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("Success: 5");
  });
});
