import { type ToolVersion, isSafetyGateBypassTool } from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcParams,
  McpTool,
  McpToolInput,
} from "../../src/protocol/types.js";
import {
  type CatalogSnapshotRecord,
  type ToolRegistry,
  type ToolRepoLike,
  createEvolvedToolHandler,
  extractToolRepo,
} from "../../src/registry/index.js";
import type { GatewayRouter, ToolCallOptions, ToolHandler } from "../../src/router.js";
import { withResolvers } from "../../src/utils/deferred.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

export interface FakeGatewayRouterOptions {
  safetyGateEvaluator?: SafetyGateEvaluator;
  db?: unknown;
  toolRepo?: ToolRepoLike;
  autoHydrate?: boolean;
}

interface RegisteredTool {
  tool: McpTool;
  handler?: ToolHandler;
  workspaceId?: string;
}

/**
 * Fake in-memory GatewayRouter implementation for testing and development.
 */
export class FakeGatewayRouter implements GatewayRouter {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly listeners = new Set<() => void>();
  private readonly delays = new Map<string, number>();
  private safetyGateEvaluator?: SafetyGateEvaluator;
  private readonly toolRepo: ToolRepoLike | null = null;
  private hydrationPromise?: Promise<number>;

  constructor(optionsOrEvaluator?: SafetyGateEvaluator | FakeGatewayRouterOptions) {
    if (optionsOrEvaluator && "canExecuteTool" in optionsOrEvaluator) {
      this.safetyGateEvaluator = optionsOrEvaluator;
    } else if (optionsOrEvaluator && optionsOrEvaluator instanceof Object) {
      this.safetyGateEvaluator = optionsOrEvaluator.safetyGateEvaluator;
      this.toolRepo = extractToolRepo(optionsOrEvaluator.db ?? optionsOrEvaluator.toolRepo);
      if (this.toolRepo && optionsOrEvaluator.autoHydrate !== false) {
        void this.loadFromStore();
      }
    }
    this.registerDefaultTools();
  }

  setSafetyGateEvaluator(evaluator: SafetyGateEvaluator): void {
    this.safetyGateEvaluator = evaluator;
  }

  private registerDefaultTools(): void {
    // 1. Echo tool
    this.registerTool(
      {
        name: "echo",
        description: "Echoes back provided parameters",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message to echo back" },
          },
          required: ["message"],
        },
      },
      async (_ctx, params) => ({
        content: [
          {
            type: "text",
            text:
              Object.prototype.toString.call(params.message) === "[object String]"
                ? `Echo: ${String(params.message)}`
                : `Echo: ${JSON.stringify(params)}`,
          },
        ],
      }),
    );

    // 2. Workspace info tool
    this.registerTool(
      {
        name: "workspace_info",
        description: "Returns active workspace context info",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      async (ctx) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workspaceId: ctx.workspaceId,
                canonicalRoot: ctx.canonicalRoot,
                name: ctx.name,
                source: ctx.source,
                rootsCount: ctx.roots.length,
                gitRoot: ctx.gitRoot,
                harnessId: ctx.harnessId,
              },
              null,
              2,
            ),
          },
        ],
      }),
    );

    // 2. Intentional failure tool
    this.registerTool(
      {
        name: "fail_tool",
        description: "Intentionally throws an error with provided message",
        inputSchema: {
          type: "object",
          properties: {
            errorMessage: { type: "string" },
            isToolResultError: { type: "boolean" },
          },
        },
      },
      async (_ctx, params) => {
        const msg = params.errorMessage ? String(params.errorMessage) : "Intentional tool failure";
        if (params.isToolResultError) {
          return {
            isError: true,
            content: [{ type: "text", text: msg }],
          };
        }
        throw new Error(msg);
      },
    );

    // 3. Resin Echo (standard fixture tool)
    this.registerTool(
      {
        name: "resin_echo",
        description: "Echoes back provided parameters with extra metadata",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
        },
      },
      async (_ctx, params) => ({
        content: [
          {
            type: "text",
            text: `Resin Echo: ${params.message ? String(params.message) : ""}`,
          },
        ],
      }),
    );

    // 4. Slow tool (for testing progress and cancellation)
    this.registerTool(
      {
        name: "slow_tool",
        description: "Asynchronous tool that delays and supports progress and cancellation",
        inputSchema: {
          type: "object",
          properties: {
            durationMs: { type: "number" },
            steps: { type: "number" },
          },
        },
      },
      async (_ctx, params, options) => {
        const durationMs = Number(params.durationMs) || 1000;
        const steps = Number(params.steps) || 5;
        const stepDelay = durationMs / steps;

        for (let i = 1; i <= steps; i++) {
          if (options?.signal?.aborted) {
            throw new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Operation cancelled by client");
          }

          const { promise, resolve, reject } = withResolvers<void>();
          const timeout = setTimeout(() => {
            cleanup();
            resolve();
          }, stepDelay);

          const abortHandler = () => {
            clearTimeout(timeout);
            cleanup();
            reject(
              new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Operation cancelled by client"),
            );
          };

          const cleanup = () => {
            options?.signal?.removeEventListener("abort", abortHandler);
          };

          options?.signal?.addEventListener("abort", abortHandler);
          await promise;

          if (options?.onProgress) {
            options.onProgress(i, steps);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Completed slow execution in ${durationMs}ms over ${steps} steps`,
            },
          ],
        };
      },
    );
  }

  registerTool(
    toolOrName: McpTool | string,
    handlerOrOptions?:
      | ToolHandler
      | {
          inputSchema?: McpToolInput;
          handler?: ToolHandler;
          description?: string;
          workspaceId?: string;
        },
    explicitHandlerOrWorkspaceId?: ToolHandler | string,
    workspaceId?: string,
  ): void {
    const isFn = handlerOrOptions instanceof Function;
    let handler: ToolHandler | undefined;
    let resolvedWorkspaceId: string | undefined;

    if (isFn) {
      handler = handlerOrOptions;
      if (Object.prototype.toString.call(explicitHandlerOrWorkspaceId) === "[object String]") {
        resolvedWorkspaceId = explicitHandlerOrWorkspaceId;
      } else if (workspaceId) {
        resolvedWorkspaceId = workspaceId;
      }
    } else {
      if (explicitHandlerOrWorkspaceId instanceof Function) {
        handler = explicitHandlerOrWorkspaceId;
      } else if (
        handlerOrOptions &&
        "handler" in handlerOrOptions &&
        handlerOrOptions.handler instanceof Function
      ) {
        handler = handlerOrOptions.handler;
      }
      resolvedWorkspaceId =
        workspaceId ??
        (handlerOrOptions && "workspaceId" in handlerOrOptions
          ? handlerOrOptions.workspaceId
          : undefined);
    }

    let tool: McpTool;
    let name: string;
    if (Object.prototype.toString.call(toolOrName) === "[object String]") {
      name = String(toolOrName);
      const opts =
        !isFn &&
        handlerOrOptions &&
        Object.prototype.toString.call(handlerOrOptions) === "[object Object]"
          ? handlerOrOptions
          : {};
      tool = {
        name,
        description: opts.description ?? `Fake Tool ${name}`,
        inputSchema: opts.inputSchema ?? { type: "object", properties: {} },
      };
      resolvedWorkspaceId = resolvedWorkspaceId ?? opts.workspaceId;
    } else {
      tool = toolOrName;
      name = toolOrName.name;
    }
    const key = resolvedWorkspaceId ? `${resolvedWorkspaceId}:${name}` : name;
    this.tools.set(key, { tool, handler, workspaceId: resolvedWorkspaceId });
    this.triggerToolListChanged();
  }
  unregisterTool(name: string, workspaceId?: string): boolean {
    const key = workspaceId ? `${workspaceId}:${name}` : name;
    const deleted = this.tools.delete(key);
    if (deleted) {
      this.triggerToolListChanged();
    }
    return deleted;
  }

  setToolDelay(name: string, delayMs: number): void {
    this.delays.set(name, delayMs);
  }

  async listTools(context: WorkspaceContext): Promise<McpTool[]> {
    if (this.toolRepo && !this.hydrationPromise) {
      await this.loadFromStore();
    } else if (this.hydrationPromise) {
      await this.hydrationPromise;
    }

    const result: McpTool[] = [];
    const seen = new Set<string>();

    for (const [key, reg] of this.tools.entries()) {
      if (reg.workspaceId && reg.workspaceId !== context.workspaceId) {
        continue;
      }
      if (!seen.has(reg.tool.name)) {
        seen.add(reg.tool.name);
        result.push(reg.tool);
      }
    }

    return result;
  }

  async callTool(
    context: WorkspaceContext,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    const wsKey = `${context.workspaceId}:${name}`;
    const registered = this.tools.get(wsKey) ?? this.tools.get(name);

    if (!registered) {
      throw new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, `Tool '${name}' not found`);
    }

    if (
      this.safetyGateEvaluator &&
      !isSafetyGateBypassTool(name) &&
      !this.safetyGateEvaluator.canExecuteTool(name, params)
    ) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.UNAUTHORIZED,
        `Safety gate blocked execution of tool '${name}'`,
      );
    }

    const delayMs = this.delays.get(name);
    if (delayMs && delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }

    if (registered.handler) {
      return registered.handler(context, params, options);
    }

    return {
      content: [
        {
          type: "text",
          text: `Executed ${name} with params: ${JSON.stringify(params)}`,
        },
      ],
    };
  }

  onToolListChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private triggerToolListChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener error
      }
    }
  }

  async loadFromStore(): Promise<number> {
    if (!this.toolRepo) {
      return 0;
    }
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }
    const repo = this.toolRepo;
    this.hydrationPromise = (async () => {
      let count = 0;
      try {
        if ("listManifests" in repo && repo.listManifests instanceof Function) {
          const manifests = await repo.listManifests();
          for (const manifest of manifests) {
            const toolId = manifest.id;
            let versionObj: ToolVersion | null = null;
            if ("getToolVersion" in repo && repo.getToolVersion instanceof Function) {
              try {
                versionObj = await repo.getToolVersion(toolId, manifest.version);
              } catch {
                // Ignore
              }
            }
            if (versionObj) {
              if (
                versionObj.status === "deprecated" ||
                versionObj.status === "revoked" ||
                versionObj.status === "disabled"
              ) {
                continue;
              }
              const handler = createEvolvedToolHandler(versionObj);
              // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
              const inputSchema = toMcpInputSchema(
                manifest.parameters && manifest.parameters instanceof Object
                  ? (manifest.parameters as JsonRpcParams)
                  : undefined,
              );
              this.registerTool(
                {
                  name: manifest.name,
                  description: manifest.description || `Tool ${manifest.name}`,
                  inputSchema,
                },
                handler,
              );
              count++;
            } else {
              const handler = createEvolvedToolHandler({ manifest });
              // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
              const inputSchema = toMcpInputSchema(
                manifest.parameters && manifest.parameters instanceof Object
                  ? (manifest.parameters as JsonRpcParams)
                  : undefined,
              );
              this.registerTool(
                {
                  name: manifest.name,
                  description: manifest.description || `Tool ${manifest.name}`,
                  inputSchema,
                },
                handler,
              );
              count++;
            }
          }
        }
      } catch {
        // Ignore
      } finally {
        this.hydrationPromise = undefined;
      }
      return count;
    })();

    return this.hydrationPromise;
  }

  async refresh(): Promise<number> {
    const count = await this.loadFromStore();
    this.triggerToolListChanged();
    return count;
  }
}
function isParamsObject(value: JsonRpcParamValue | undefined): value is JsonRpcParams {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function toMcpInputSchema(rawSchema?: JsonRpcParams): McpToolInput {
  if (!rawSchema || Object.prototype.toString.call(rawSchema) !== "[object Object]") {
    return { type: "object", properties: {} };
  }
  const properties = isParamsObject(rawSchema.properties) ? rawSchema.properties : undefined;
  const required = Array.isArray(rawSchema.required)
    ? rawSchema.required.filter(
        (item): item is string => Object.prototype.toString.call(item) === "[object String]",
      )
    : undefined;
  const additionalProperties =
    rawSchema.additionalProperties === true || rawSchema.additionalProperties === false
      ? rawSchema.additionalProperties
      : isParamsObject(rawSchema.additionalProperties)
        ? rawSchema.additionalProperties
        : undefined;
  const description =
    rawSchema.description &&
    Object.prototype.toString.call(rawSchema.description) === "[object String]"
      ? String(rawSchema.description)
      : undefined;

  const result: McpToolInput = {
    type: "object",
    properties: properties ?? {},
  };
  if (required !== undefined) {
    result.required = required;
  }
  if (additionalProperties !== undefined) {
    result.additionalProperties = additionalProperties;
  }
  if (description !== undefined) {
    result.description = description;
  }
  return result;
}
