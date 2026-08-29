import type { ToolManifest } from "@resin/contracts";
import type { CallToolResult } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { ToolCallOptions } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

/**
 * Request payload for dispatching a tool invocation.
 */
export interface ToolInvocationRequest {
  toolId: string;
  name: string;
  version: string;
  parameters: Record<string, unknown>;
  context: WorkspaceContext;
  manifest?: ToolManifest;
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number) => void;
  timeoutMs?: number;
}

/**
 * Contract for routing tool invocations to local Runtime workers,
 * cloud proxy, or local registry handlers.
 */
export interface ToolInvocationRouter {
  invoke(request: ToolInvocationRequest): Promise<CallToolResult>;
}

/**
 * Default router implementation that delegates to the tool's registered handler
 * in the ToolRegistry or produces a standard execution response.
 */
export class DefaultToolInvocationRouter implements ToolInvocationRouter {
  constructor(private readonly registry?: ToolRegistry) {}

  async invoke(request: ToolInvocationRequest): Promise<CallToolResult> {
    if (this.registry) {
      const tool = await this.registry.getTool(
        request.toolId,
        request.context.workspaceId,
        request.context.sessionId,
      );
      if (tool?.handler) {
        const options: ToolCallOptions = {
          signal: request.signal,
          onProgress: request.onProgress,
          timeoutMs: request.timeoutMs,
        };
        return tool.handler(request.context, request.parameters, options);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "executed",
            toolId: request.toolId,
            name: request.name,
            version: request.version,
            parameters: request.parameters,
          }),
        },
      ],
    };
  }
}
