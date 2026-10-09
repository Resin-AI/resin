import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import {
  CapabilityManifestSchema,
  type InvocationRecord,
  InvocationRecordSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { timeRecordedCall } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { failedToolResult } from "../../src/meta/invocation-failure.js";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import type {
  ToolInvocationRequest,
  ToolInvocationRouter,
} from "../../src/meta/router-contract.js";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import {
  type CallToolResult,
  type JsonRpcParams,
  RESIN_DISPLAY_TEXT_META,
  RESIN_OUTPUT_STEPS_META,
} from "../../src/protocol/types.js";
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
    // Each missing input with what it is, one complete call in both harness forms, and that the
    // same call can simply be repeated with them.
    const call = '{"name":"tool_validator","parameters":{"count":1,"mode":"fast"}}';
    expect(resMissing.content[0].text).toBe(
      [
        "Missing required inputs for tool 'tool_validator'; nothing ran:",
        "- count (integer): Item count",
        "- mode (string): Execution mode",
        "Repeat the call with them: replace each <placeholder> with your value. A complete call:",
        `- OMP: write ${call} to xd://mcp__resin_invoke_tool`,
        `- invoke_tool arguments: ${call}`,
        "Optional inputs you may also pass: tag.",
      ].join("\n"),
    );
    // The machine-readable failure stays: the reason, and the inputs the call left out.
    expect(resMissing._meta).toMatchObject({
      resinFailureReason: "validation_error",
      resinMissingInputs: ["count", "mode"],
    });

    // A value the caller did pass stays in the call to repeat; a string gets a placeholder.
    const partial = await handler(context, {
      name: "validate_tool",
      parameters: { count: 3 },
    });
    expect(partial.content[0].text).toContain(
      "Missing required input for tool 'validate_tool'; nothing ran:\n- mode (string): Execution mode\nRepeat the call with it:",
    );
    expect(partial.content[0].text).toContain(
      '- invoke_tool arguments: {"name":"validate_tool","parameters":{"count":3,"mode":"fast"}}',
    );

    // Any other problem is reported beside the missing inputs.
    const wrong = await handler(context, {
      toolId: "tool_validator",
      parameters: { count: "three" },
    });
    expect(wrong.content[0].text).toContain("- mode (string): Execution mode");
    expect(wrong.content[0].text).toMatch(/\nAlso: .*count/);
  });

  it("returns text output as text, one labeled section per step, not escaped JSON", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(makeManifest(), undefined, { workspaceId: "ws-invoke" });
    const invoke = async (value: unknown) =>
      createInvokeToolHandler(registry, {
        async invoke(): Promise<CallToolResult> {
          // A recorded workflow's result travels as JSON: a command's stdout is a string in it.
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        },
      })(makeContext("ws-invoke"), {
        toolId: "tool_validator",
        parameters: { count: 1, mode: "fast" },
      });

    const single = await invoke('{\n  "rows": [1, 2]\n}\n');
    const sequence = await invoke(["a.txt\nb.txt\n", "# Design\n"]);
    const silent = await invoke("");

    expect(single.content).toEqual([{ type: "text", text: '{\n  "rows": [1, 2]\n}\n' }]);
    expect(sequence.content).toEqual([
      { type: "text", text: "--- step 1/2 ---\na.txt\nb.txt\n\n--- step 2/2 ---\n# Design\n" },
    ]);
    // A command that printed nothing still reports that it ran.
    expect(silent.content).toEqual([{ type: "text", text: "(completed with no output)" }]);
  });

  it("labels each output with the plan step that produced it, not its position among outputs", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(makeManifest(), undefined, { workspaceId: "ws-invoke" });
    // A four-step deploy whose first step's output fed the second: steps 2-4 return outputs.
    const result = await createInvokeToolHandler(registry, {
      async invoke(): Promise<CallToolResult> {
        return {
          content: [
            { type: "text", text: JSON.stringify(["release is live", "smoke ok\n", "promoted\n"]) },
          ],
          _meta: { [RESIN_OUTPUT_STEPS_META]: { steps: [2, 3, 4], total: 4 } },
        };
      },
    })(makeContext("ws-invoke"), {
      toolId: "tool_validator",
      parameters: { count: 1, mode: "fast" },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "--- step 2/4 ---\nrelease is live\n--- step 3/4 ---\nsmoke ok\n\n--- step 4/4 ---\npromoted\n",
      },
    ]);
    // The numbering is Resin's own bookkeeping: it does not reach the client.
    expect(result._meta?.[RESIN_OUTPUT_STEPS_META]).toBeUndefined();
  });

  it("shows a result's display text in place of its content, dropping Resin's keys", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(makeManifest(), undefined, { workspaceId: "ws-invoke" });
    const result = await createInvokeToolHandler(registry, {
      async invoke(): Promise<CallToolResult> {
        return {
          content: [{ type: "text", text: JSON.stringify("c\n") }],
          _meta: { [RESIN_DISPLAY_TEXT_META]: "The program exited 0.\nOutput:\nc" },
        };
      },
    })(makeContext("ws-invoke"), {
      toolId: "tool_validator",
      parameters: { count: 1, mode: "fast" },
    });

    expect(result.content).toEqual([{ type: "text", text: "The program exited 0.\nOutput:\nc" }]);
    expect(result._meta).toBeUndefined();
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

  it("records how long the tool's recorded calls ran, apart from the rest of the call", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(makeManifest({ limits: { timeoutMs: 5000 } }), undefined, {
      workspaceId: "ws-invoke",
    });
    const records: InvocationRecord[] = [];
    let mode: "success" | "error" | "throw" | "nothing" = "success";
    const mockRouter: ToolInvocationRouter = {
      async invoke(): Promise<CallToolResult> {
        if (mode === "nothing") return failedToolResult("runtime_unavailable", "not here");
        // A recorded call, then Resin's own work after it (report building, presentation).
        await timeRecordedCall(() => sleep(120));
        await sleep(150);
        if (mode === "throw") throw new Error("lost after running");
        return mode === "error"
          ? failedToolResult("check_failed", "2 tests failed")
          : { content: [{ type: "text", text: "ok" }] };
      },
    };
    const handler = createInvokeToolHandler(registry, mockRouter, {
      onInvocationRecorded: async (record) => {
        records.push(record);
      },
    });
    const call = (parameters: Record<string, unknown>) =>
      handler(makeContext("ws-invoke", "session-exec"), { name: "validate_tool", parameters });

    const shown: CallToolResult[] = [];
    shown.push(await call({ count: 1, mode: "safe" }));
    mode = "error";
    shown.push(await call({ count: 1, mode: "safe" }));
    mode = "throw";
    shown.push(await call({ count: 1, mode: "safe" }));
    mode = "success";
    shown.push(await call({ count: { value: 1 }, mode: "safe" }));
    mode = "nothing";
    shown.push(await call({ count: 1, mode: "safe" }));
    await nextTurn();

    expect(records.map((record) => record.status)).toEqual([
      "success",
      "error",
      "error",
      "success",
      "error",
    ]);
    for (const record of records.slice(0, 4)) {
      InvocationRecordSchema.parse(record);
      expect(record.executionDurationMs).toBeGreaterThanOrEqual(115);
      expect(record.executionDurationMs).toBeLessThan(260);
      expect(record.durationMs).toBeGreaterThanOrEqual(265);
      expect(record.executionDurationMs).toBeLessThanOrEqual(record.durationMs);
    }
    // Nothing recorded ran, so no execution time is claimed.
    expect(records[4]).not.toHaveProperty("executionDurationMs");
    // The measurement travels outside the result: success, error, composed handle, and refused
    // results reach the caller with no trace of it.
    for (const result of shown) {
      expect(JSON.stringify(result)).not.toMatch(/executionDuration/i);
    }
    expect(JSON.parse(shown[3]!.content[0]!.text as string)).toMatchObject({ result: "ok" });
  });

  it("records why a call failed as a schema-valid reason, never only as error text", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(makeManifest(), undefined, { workspaceId: "ws-invoke" });
    const recordFor = async (
      invoke: ToolInvocationRouter["invoke"],
      parameters: Record<string, unknown> = { count: 10, mode: "fast" },
    ) => {
      const { promise, resolve } = Promise.withResolvers<InvocationRecord>();
      const handler = createInvokeToolHandler(registry, { invoke }, undefined, async (record) =>
        resolve(record),
      );
      const result = await handler(makeContext("ws-invoke", "session-reason"), {
        name: "validate_tool",
        parameters: parameters as JsonRpcParams,
      });
      expect(result.isError).toBe(true);
      return InvocationRecordSchema.parse(await promise);
    };
    const ok = async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: "OK" }] });

    const invalid = await recordFor(ok, { mode: "fast" });
    const reported = await recordFor(async () => ({
      isError: true,
      content: [{ type: "text", text: "exit 1" }],
    }));
    const missingArtifact = await recordFor(async () =>
      failedToolResult("runtime_unavailable", "Artifact directory does not exist"),
    );
    const unreachable = await recordFor(async () => {
      throw new McpProtocolError(MCP_ERROR_CODES.CONNECTION_CLOSED, "Cloud service is offline");
    });
    const timedOut = await recordFor(async () => {
      throw new McpProtocolError(MCP_ERROR_CODES.REQUEST_TIMEOUT, "timed out");
    });

    expect(
      [invalid, reported, missingArtifact, unreachable, timedOut].map((record) => [
        record.status,
        record.errorDetails?.reason,
      ]),
    ).toEqual([
      ["error", "validation_error"],
      ["error", "tool_error"],
      ["error", "runtime_unavailable"],
      ["error", "runtime_unavailable"],
      ["timeout", "timeout"],
    ]);
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
