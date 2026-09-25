/**
 * The tool-protocol runtime family: a callable re-made by name through the connection it was
 * recorded on.
 *
 * A recorded name is only reachable through something the host actually has: the connection the
 * record names — already open, or dialed on demand through the host's opener — or the host's own
 * tool router. When none of those is present the call is refused by name, and a connection that
 * could not be dialed fails the step: a tool that could not be reached is never answered from a
 * remembered value.
 */

import type { WorkflowJsonValue } from "@resin/contracts";
import type { McpToolConnection } from "./mcp-connection.js";
import type { RecordedCallRequest, RuntimeAdapter } from "./recorded-workflow.js";
import { RESIN_TOOL_PROTOCOL_RUNTIME } from "./runtime-families.js";

export interface ToolProtocolDispatchRequest {
  name: string;
  arguments: Record<string, WorkflowJsonValue>;
  connection?: string;
  stepId: string;
  signal?: AbortSignal;
}

export interface ToolProtocolAdapterOptions {
  /** Dispatch to a tool the host itself can reach (the host tool router). */
  dispatch?: (request: ToolProtocolDispatchRequest) => Promise<WorkflowJsonValue>;
  /** Resolve a named connection to a live protocol client the host configured. */
  connections?: Record<string, McpToolConnection>;
  /**
   * Opens a named connection on first use, for a host that does not keep them open already. A
   * failed dial is the step's failure: it never falls back to another way of reaching the callable.
   */
  openConnection?: (name: string, signal?: AbortSignal) => Promise<McpToolConnection | undefined>;
}

/** An MCP result that reports failure carries `isError`; it is a failure, not a value. */
function isErrorResult(value: WorkflowJsonValue): boolean {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && value.isError === true
  );
}

function unreachableReason(stepId: string, callableName: string, connection?: string): string {
  const contact =
    connection === undefined
      ? "the record names no connection"
      : `connection '${connection}' is not configured here`;
  return `step '${stepId}' cannot reach callable '${callableName}': ${contact}, and no tool dispatcher is configured`;
}

export function createToolProtocolAdapter(options: ToolProtocolAdapterOptions): RuntimeAdapter {
  return {
    runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
    async call(request: RecordedCallRequest): Promise<WorkflowJsonValue> {
      const { step } = request;
      const callable = step.callable;
      const recorded = callable.connection;
      const connection =
        recorded !== undefined &&
        options.connections &&
        Object.hasOwn(options.connections, recorded)
          ? options.connections[recorded]
          : undefined;
      if (connection) {
        // The connection owns the protocol's own error reporting; it throws rather than answering.
        return await connection.callTool(callable.name, request.arguments, request.signal);
      }
      if (recorded !== undefined && options.openConnection) {
        const dialed = await options.openConnection(recorded, request.signal);
        if (dialed) return await dialed.callTool(callable.name, request.arguments, request.signal);
      }
      if (options.dispatch) {
        const value = await options.dispatch({
          name: callable.name,
          arguments: request.arguments,
          ...(recorded !== undefined ? { connection: recorded } : {}),
          stepId: step.id,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (isErrorResult(value)) {
          throw new Error(
            `step '${step.id}' failed: tool '${callable.name}' answered with an error result`,
          );
        }
        return value;
      }
      throw new Error(unreachableReason(step.id, callable.name, recorded));
    },
  };
}
