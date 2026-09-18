/**
 * The interface an agent (or any calling program) uses to compose recorded work.
 *
 * A call returns a *handle* for its result. When the next call needs a value from it — the whole
 * result or a nested field — the caller passes the handle instead of copying the value. The session
 * resolves handles locally immediately before dispatching, so tool servers receive ordinary JSON and
 * need no Resin-specific changes, and it reports the references each call used so the recorder can
 * preserve the connection rather than a snapshot of the value.
 */

import type { WorkflowJsonValue, WorkflowValuePath } from "@resin/contracts";
import { type ReferenceUse, WorkflowReferenceScope } from "./reference-invocation.js";

/** What the agent receives instead of a bare value. */
export interface ResultHandle {
  readonly handle: string;
}

/** An argument the agent passes: a plain value, or a handle into an earlier result. */
export type AgentArgument =
  | { value: WorkflowJsonValue }
  | { reference: ResultHandle; path?: WorkflowValuePath };

export interface AgentCallOutcome {
  /** The value the tool returned, for the agent's own use. */
  result: WorkflowJsonValue;
  /** The handle to pass wherever this result is needed later. */
  handle: ResultHandle;
  /** The references this call consumed, with the nested field each addressed. */
  references: ReferenceUse[];
}

export class AgentToolSession {
  private readonly scope: WorkflowReferenceScope;
  private callCounter = 0;
  private readonly usage: ReferenceUse[] = [];

  constructor(
    private readonly sessionId: string,
    /** Dispatches to the original tool over its own connection: plain JSON, unchanged. */
    private readonly dispatch: (
      toolName: string,
      args: Record<string, WorkflowJsonValue>,
    ) => Promise<WorkflowJsonValue>,
  ) {
    this.scope = new WorkflowReferenceScope(sessionId);
  }

  /** Every reference this session's calls consumed, in order. */
  referencesUsed(): ReadonlyArray<ReferenceUse> {
    return this.usage.map((use) => ({ ...use, path: [...use.path] }));
  }

  async call(toolName: string, args: Record<string, AgentArgument>): Promise<AgentCallOutcome> {
    const callId = `call_${++this.callCounter}`;
    const resolved: Record<string, WorkflowJsonValue> = {};
    const references: ReferenceUse[] = [];
    for (const [argument, entry] of Object.entries(args)) {
      if ("value" in entry) {
        resolved[argument] = entry.value;
        continue;
      }
      const path = entry.path ?? [];
      resolved[argument] = this.scope.resolve(entry.reference.handle, path);
      const use: ReferenceUse = { callId, argument, reference: entry.reference.handle, path };
      references.push(use);
      this.usage.push(use);
      this.scope.recordUse(use);
    }
    const result = await this.dispatch(toolName, resolved);
    return {
      result,
      handle: { handle: this.scope.registerResult(callId, result) },
      references,
    };
  }

  /**
   * The record the shared capture path consumes: per call, which argument used which reference at
   * which field. A call whose arguments were all plain values contributes no connections.
   */
  recordedCalls(): Array<{
    callId: string;
    references: Record<string, { reference: string; path: WorkflowValuePath }>;
  }> {
    const byCall = new Map<
      string,
      Record<string, { reference: string; path: WorkflowValuePath }>
    >();
    for (const use of this.usage) {
      const entry = byCall.get(use.callId) ?? {};
      entry[use.argument] = { reference: use.reference, path: [...use.path] };
      byCall.set(use.callId, entry);
    }
    return [...byCall.entries()].map(([callId, references]) => ({ callId, references }));
  }
}
