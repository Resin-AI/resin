import { type ToolVersion, isSafetyGateBypassTool } from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import type { CallToolResult, McpTool, McpToolInput } from "../../src/protocol/types.js";
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

export interface RegisteredTool {
  tool: McpTool;
  handler: ToolHandler;
  workspaceId?: string;
  isSystem?: boolean;
}

export interface FakeGatewayRouterOptions {
  db?: unknown;
  toolRepo?: unknown;
  safetyGateEvaluator?: SafetyGateEvaluator;
  autoHydrate?: boolean;
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
    } else if (optionsOrEvaluator && typeof optionsOrEvaluator === "object") {
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
            text: `Echo: ${typeof params.message === "string" ? params.message : JSON.stringify(params)}`,
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

    // 3. Fail tool (for testing error handling & redaction)
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
        const msg =
          typeof params.errorMessage === "string"
            ? params.errorMessage
            : "Intentional tool failure";
        if (params.isToolResultError) {
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
        }
        throw new Error(msg);
      },
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
        const durationMs = typeof params.durationMs === "number" ? params.durationMs : 300;
        const steps = typeof params.steps === "number" ? params.steps : 3;
        const stepDelay = Math.max(10, Math.floor(durationMs / steps));

        for (let i = 1; i <= steps; i++) {
          if (options?.signal?.aborted) {
            throw new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Operation cancelled by client");
          }

          const { promise, resolve, reject } = withResolvers<void>();
          const timeout = setTimeout(() => {
            cleanup();
            resolve();
          }, stepDelay);

          const onAbort = () => {
            cleanup();
            reject(
              new McpProtocolError(MCP_ERROR_CODES.CANCELLED, "Operation cancelled by client"),
            );
          };

          const cleanup = () => {
            clearTimeout(timeout);
            options?.signal?.removeEventListener("abort", onAbort);
          };

          options?.signal?.addEventListener("abort", onAbort);
          await promise;

          options?.onProgress?.(i, steps);
        }

        return {
          content: [
            {
              type: "text",
              text: `Completed ${steps} steps in ${durationMs}ms`,
            },
          ],
        };
      },
    );
  }

  registerTool(tool: McpTool, handler: ToolHandler, workspaceId?: string): void {
    const key = workspaceId ? `${workspaceId}:${tool.name}` : tool.name;
    this.tools.set(key, { tool, handler, workspaceId });
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
    if (this.toolRepo && (!this.tools.size || this.hydrationPromise)) {
      await this.loadFromStore();
    }
    const result: McpTool[] = [];
    for (const entry of this.tools.values()) {
      if (!entry.workspaceId || entry.workspaceId === context.workspaceId) {
        result.push(entry.tool);
      }
    }
    return result;
  }

  async callTool(
    context: WorkspaceContext,
    name: string,
    params: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    // Check workspace-specific first, then global
    const wsKey = `${context.workspaceId}:${name}`;
    const entry = this.tools.get(wsKey) ?? this.tools.get(name);

    if (!entry) {
      throw new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, `Tool '${name}' not found`);
    }
    if (this.safetyGateEvaluator && !entry.isSystem && !isSafetyGateBypassTool(name)) {
      const gateCheck = this.safetyGateEvaluator.canExecuteTool(
        name,
        name,
        Boolean(entry.isSystem),
      );
      if (!gateCheck.allowed && gateCheck.refusal) {
        return {
          isError: true,
          content: gateCheck.refusal.content,
          _meta: { refusal: gateCheck.refusal },
        };
      }
    }

    const delay = this.delays.get(name);
    if (delay && delay > 0) {
      const { promise, resolve } = withResolvers<void>();
      setTimeout(resolve, delay);
      await promise;
    }

    return entry.handler(context, params, options);
  }

  onToolListChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  triggerToolListChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }
  getToolRepo(): ToolRepoLike | null {
    return this.toolRepo;
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
        if (typeof repo.listManifests === "function") {
          const manifests = await repo.listManifests();
          for (const manifest of manifests) {
            const toolId = manifest.id;
            let versionObj: ToolVersion | null = null;
            if (typeof repo.getToolVersion === "function") {
              try {
                versionObj = await repo.getToolVersion(toolId, manifest.version);
              } catch {
                // Ignore
              }
            }
            if (versionObj) {
              if (
                versionObj.status === "deprecated" ||
                (versionObj.status as string) === "revoked" ||
                (versionObj.status as string) === "quarantined"
              ) {
                continue;
              }
              const handler = createEvolvedToolHandler(versionObj);
              const inputSchema = toMcpInputSchema(
                manifest.parameters && typeof manifest.parameters === "object"
                  ? (manifest.parameters as Record<string, unknown>)
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
              const inputSchema = toMcpInputSchema(
                manifest.parameters && typeof manifest.parameters === "object"
                  ? (manifest.parameters as Record<string, unknown>)
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

function toMcpInputSchema(rawSchema?: Record<string, unknown>): McpToolInput {
  if (!rawSchema || typeof rawSchema !== "object") {
    return { type: "object", properties: {} };
  }
  const properties =
    rawSchema.properties && typeof rawSchema.properties === "object"
      ? (rawSchema.properties as Record<string, unknown>)
      : undefined;
  const required = Array.isArray(rawSchema.required) ? (rawSchema.required as string[]) : undefined;
  const additionalProperties =
    typeof rawSchema.additionalProperties === "boolean" ||
    (rawSchema.additionalProperties && typeof rawSchema.additionalProperties === "object")
      ? (rawSchema.additionalProperties as boolean | Record<string, unknown>)
      : undefined;
  const description = typeof rawSchema.description === "string" ? rawSchema.description : undefined;

  return {
    type: "object",
    properties,
    required,
    additionalProperties,
    description,
  };
}
