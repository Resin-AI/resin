import { randomUUID } from "node:crypto";
import {
  type InvocationRecord,
  type SafetyGateRefusal,
  type ToolParameterSchema,
  hashCanonicalContent,
  isSafetyGateBypassTool,
} from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { ToolInvocationRouter } from "./meta/router-contract.js";
import { MCP_ERROR_CODES, McpProtocolError } from "./protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcParamValue,
  JsonRpcParams,
  McpTool,
  McpToolInput,
} from "./protocol/types.js";
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
  params: JsonRpcParams,
  options?: ToolCallOptions,
) => Promise<CallToolResult>;

export interface GatewayRouter {
  listTools(context: WorkspaceContext): Promise<McpTool[]>;
  callTool(
    context: WorkspaceContext,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult>;
  onToolListChanged?(listener: () => void): () => void;
}
function isParamsObject<TInput>(value: TInput): value is TInput & JsonRpcParams {
  return Boolean(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function formatRefusalMeta(refusal: SafetyGateRefusal): JsonRpcParams {
  const contentList: readonly JsonRpcParamValue[] = refusal.content.map((c) => ({
    type: c.type,
    text: c.text,
  }));
  const unmetList: readonly JsonRpcParamValue[] = refusal.unmetGates;
  const result: JsonRpcParams = {
    isError: refusal.isError,
    refusalCode: refusal.refusalCode,
    refusalReason: refusal.refusalReason,
    remediation: refusal.remediation,
    unmetGates: unmetList,
    evaluatedAt: refusal.evaluatedAt,
    content: contentList,
  };
  if (refusal.details) {
    const detailsRecord: Record<string, JsonRpcParamValue> = {};
    for (const [key, value] of Object.entries(refusal.details)) {
      if (
        Object.prototype.toString.call(value) === "[object String]" ||
        Object.prototype.toString.call(value) === "[object Number]" ||
        Object.prototype.toString.call(value) === "[object Boolean]" ||
        value === null ||
        value === undefined
      ) {
        detailsRecord[key] = String(value);
      }
    }
    result.details = detailsRecord;
  }
  return result;
}

function toMcpInputSchema(rawSchema?: JsonRpcParams | ToolParameterSchema): McpToolInput {
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
  return result;
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
  private readonly invocationRouter?: ToolInvocationRouter;

  constructor(
    registry: ToolRegistry,
    invocationRouter?: ToolInvocationRouter,
    safetyGateEvaluator?: SafetyGateEvaluator,
    canaryRouter?: CanaryRouter,
  ) {
    this.registry = registry;
    this.invocationRouter = invocationRouter;
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
    const record = "entries" in snapshot ? snapshot : undefined;
    if (record && record.entries && Object.keys(record.entries).length > 0) {
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
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
    const tool = await this.registry.getTool(name, context.workspaceId, context.sessionId);

    if (!tool) {
      throw new McpProtocolError(MCP_ERROR_CODES.TOOL_NOT_FOUND, `Tool '${name}' not found`);
    }

    // Harnesses call evolved tools by name, not through invoke_tool. Record those
    // calls the same way, or the invocation ledger (and every saving computed
    // from it) only ever sees the meta-tool path.
    const recorder = tool.isSystem ? undefined : this.registry.getInvocationRecorder();
    const startedAtMs = Date.now();
    const executed = await this.executeTool(context, tool, name, params, options);
    if (recorder) {
      const record: InvocationRecord = {
        invocationId: `inv_${randomUUID().replace(/-/g, "")}`,
        sessionId: context.sessionId ?? `ses_standalone_${context.workspaceId}`,
        workspaceId: context.workspaceId,
        toolId: tool.toolId,
        toolVersion: /^\d+\.\d+\.\d+/.test(tool.version) ? tool.version : "1.0.0",
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAtMs),
        status: executed.isError ? "error" : "success",
        inputDigest: hashCanonicalContent(params),
        outputDigest: hashCanonicalContent(executed),
      };
      void recorder(record).catch(() => {
        // Recording never fails the call; the uploader reconciles from what was written.
      });
    }
    return executed;
  }

  private async executeTool(
    context: WorkspaceContext,
    tool: NonNullable<Awaited<ReturnType<ToolRegistry["getTool"]>>>,
    name: string,
    params: JsonRpcParams,
    options?: ToolCallOptions,
  ): Promise<CallToolResult> {
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
          _meta: { refusal: formatRefusalMeta(gateCheck.refusal) },
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

    // Published tools must use the verified local artifact executor, which
    // supplies capability grants and brokers. The raw-source compatibility
    // handler has no authority to perform filesystem/command/network effects.
    if (!tool.isSystem && this.invocationRouter) {
      return this.invocationRouter.invoke({
        toolId: tool.toolId,
        name: tool.name,
        version: tool.version,
        manifest: tool.manifest,
        parameters: params,
        context,
        signal: options?.signal,
        onProgress: options?.onProgress,
        timeoutMs: options?.timeoutMs,
      });
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
