import { isSafetyGateBypassTool } from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { ToolInvocationRouter } from "./meta/router-contract.js";
import { MCP_ERROR_CODES, McpProtocolError } from "./protocol/errors.js";
import type { CallToolResult, McpTool, McpToolInput } from "./protocol/types.js";
import { CanaryRouter } from "./registry/canary-router.js";
import {
  type CatalogSnapshotRecord,
  type ToolRegistry,
  type ToolRepoLike,
  createEvolvedToolHandler,
  extractToolRepo,
} from "./registry/index.js";
import type { WorkspaceContext } from "./workspace-resolver.js";

export interface ToolCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
  timeoutMs?: number;
}

export type ToolHandler = (
  context: WorkspaceContext,
  params: Record<string, unknown>,
  options?: ToolCallOptions,
) => Promise<CallToolResult>;

export interface GatewayRouter {
  listTools(context: WorkspaceContext): Promise<McpTool[]>;
  callTool(
    context: WorkspaceContext,
    name: string,
    params: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<CallToolResult>;
  onToolListChanged?(listener: () => void): () => void;
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

/**
 * Dynamic GatewayRouter implementation backed by a ToolRegistry.
 */
export class RegistryGatewayRouter implements GatewayRouter {
  private readonly registry: ToolRegistry;
  private readonly canaryRouter: CanaryRouter;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeEvents?: () => void;
  private safetyGateEvaluator?: SafetyGateEvaluator;

  constructor(
    registry: ToolRegistry,
    invocationRouter?: ToolInvocationRouter,
    safetyGateEvaluator?: SafetyGateEvaluator,
    canaryRouter?: CanaryRouter,
  ) {
    this.registry = registry;
    this.canaryRouter =
      canaryRouter ??
      new CanaryRouter({
        registry: this.registry,
        userControls: this.registry.controls,
      });
    this.safetyGateEvaluator = safetyGateEvaluator ?? registry.getSafetyGateEvaluator();
    if (safetyGateEvaluator) {
      this.registry.setSafetyGateEvaluator(safetyGateEvaluator);
    }

    if (invocationRouter) {
      this.registry.setInvocationRouter(invocationRouter);
    }
    this.unsubscribeEvents = this.registry.events.onCatalogChanged(() => {
      this.triggerToolListChanged();
    });
  }

  setSafetyGateEvaluator(evaluator: SafetyGateEvaluator): void {
    this.safetyGateEvaluator = evaluator;
    this.registry.setSafetyGateEvaluator(evaluator);
  }
  getSafetyGateEvaluator(): SafetyGateEvaluator | undefined {
    return this.safetyGateEvaluator;
  }
  async listTools(context: WorkspaceContext): Promise<McpTool[]> {
    const snapshot = await this.registry.resolveCatalog(context.workspaceId, context.sessionId);
    const mcpTools: McpTool[] = [];
    const record = snapshot as CatalogSnapshotRecord;

    if (record.entries && Object.keys(record.entries).length > 0) {
      for (const entry of Object.values(record.entries)) {
        const schema = toMcpInputSchema(entry.parameters ?? entry.manifest?.parameters);
        mcpTools.push({
          name: entry.exposedName,
          description: entry.description || entry.manifest?.description || `Tool ${entry.name}`,
          inputSchema: schema,
        });
      }
    } else {
      for (const summary of Object.values(snapshot.tools)) {
        const tool = await this.registry.getTool(
          summary.toolId,
          context.workspaceId,
          context.sessionId,
        );
        if (tool) {
          const schema = toMcpInputSchema(tool.parameters ?? tool.manifest?.parameters);
          mcpTools.push({
            name: tool.exposedName || tool.name,
            description: tool.description || tool.manifest?.description || `Tool ${tool.name}`,
            inputSchema: schema,
          });
        }
      }
    }
    return mcpTools;
  }
  async callTool(
    context: WorkspaceContext,
    name: string,
    params: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    const tool = await this.registry.getTool(name, context.workspaceId, context.sessionId);

    if (!tool) {
      throw new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, `Tool '${name}' not found`);
    }

    const isToolDisabled = await this.registry.controls.isToolDisabled(
      context.workspaceId,
      tool.toolId,
    );
    if (tool.isDisabled || isToolDisabled) {
      throw new McpProtocolError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `Tool '${name}' is disabled in this workspace`,
      );
    }
    // Enforce production safety gate on non-system tools
    if (
      this.safetyGateEvaluator &&
      !tool.isSystem &&
      !isSafetyGateBypassTool(name) &&
      !isSafetyGateBypassTool(tool.toolId)
    ) {
      const gateCheck = this.safetyGateEvaluator.canExecuteTool(
        tool.toolId,
        tool.name,
        Boolean(tool.isSystem),
      );
      if (!gateCheck.allowed && gateCheck.refusal) {
        return {
          isError: true,
          content: gateCheck.refusal.content,
          _meta: { refusal: gateCheck.refusal },
        };
      }
    }

    // Enforce canary execution if candidate active on non-system tools
    const canary = this.canaryRouter.getCanary(tool.toolId, context.workspaceId);
    if (canary && !tool.isSystem) {
      const invocationRequest = {
        toolId: tool.toolId,
        name: tool.name,
        version: tool.version,
        parameters: params,
        context,
        manifest: tool.manifest,
        signal: options?.signal,
        onProgress: options?.onProgress,
        timeoutMs: options?.timeoutMs,
      };

      return await this.canaryRouter.executeWithCanary(
        invocationRequest,
        async (targetVersion: string) => {
          const targetTool =
            this.registry.getToolVersion(tool.toolId, targetVersion) ??
            this.registry.getToolVersion(name, targetVersion) ??
            (targetVersion === tool.version ? tool : undefined);

          if (targetTool?.handler) {
            return await targetTool.handler(context, params, options);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "executed",
                  tool: targetTool?.name ?? tool.name,
                  version: targetVersion,
                  params,
                }),
              },
            ],
          };
        },
      );
    }

    if (tool.handler) {
      return tool.handler(context, params, options);
    }

    // Default fallback output
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "executed",
            tool: tool.name,
            version: tool.version,
            params,
          }),
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

  triggerToolListChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  getCanaryRouter(): CanaryRouter {
    return this.canaryRouter;
  }

  destroy(): void {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
    }
    this.listeners.clear();
  }
  async refresh(workspaceId?: string): Promise<number> {
    const count = await this.registry.refresh(workspaceId);
    this.triggerToolListChanged();
    return count;
  }
}

/**
 * Creates a GatewayRouter backed by a ToolRegistry.
 */
export function createRegistryGatewayRouter(
  registry: ToolRegistry,
  invocationRouter?: ToolInvocationRouter,
  safetyGateEvaluator?: SafetyGateEvaluator,
  canaryRouter?: CanaryRouter,
): RegistryGatewayRouter {
  return new RegistryGatewayRouter(registry, invocationRouter, safetyGateEvaluator, canaryRouter);
}
