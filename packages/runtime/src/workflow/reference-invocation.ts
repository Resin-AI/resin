/**
 * Reference-aware invocation.
 *
 * A dispatcher that receives plain JSON cannot know which earlier result supplied a value, so the
 * connection has to be carried by the caller: each actual result is assigned a scoped reference, and
 * a later call may name that reference (or a nested field of it) instead of embedding the value.
 * References are resolved locally immediately before the original tool is invoked, and what is
 * recorded is the reference — never only the resolved value.
 *
 * This is the mechanism a reference-aware agent or program uses. Historical recordings of plain JSON
 * arguments cannot be retrofitted: they carry no references to preserve.
 */

import type { WorkflowJsonValue, WorkflowValuePath } from "@resin/contracts";

/** One argument value: either a concrete value or a reference into an earlier result. */
export type ReferenceArgument =
  | { kind: "value"; value: WorkflowJsonValue }
  | { kind: "reference"; reference: string; path?: WorkflowValuePath };

/** One recorded use of a reference: which call used it, for which argument, and at which field. */
export interface ReferenceUse {
  callId: string;
  argument: string;
  reference: string;
  path: WorkflowValuePath;
}

export class WorkflowReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowReferenceError";
  }
}

function readPath(
  value: WorkflowJsonValue,
  path: WorkflowValuePath,
): WorkflowJsonValue | undefined {
  let current: WorkflowJsonValue | undefined = value;
  for (const part of path) {
    if (current === undefined || current === null) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, WorkflowJsonValue>)[part];
  }
  return current;
}

/**
 * The live scope of a recording: results are registered here as they are produced, references are
 * resolved here just before a call, and the use of each reference is recorded here.
 */
export class WorkflowReferenceScope {
  private readonly values = new Map<string, WorkflowJsonValue>();
  private readonly usage: ReferenceUse[] = [];

  constructor(private readonly scopeId: string) {}

  /** Records that a call consumed a reference at a given field. */
  recordUse(use: ReferenceUse): void {
    this.usage.push(use);
  }

  /** Registers an actual result and returns the reference later calls use for it. */
  registerResult(callId: string, result: WorkflowJsonValue): string {
    const reference = `ref:${this.scopeId}:${callId}`;
    this.values.set(reference, result);
    return reference;
  }

  /** Resolves a reference locally. Throws when it names nothing in this recording. */
  resolve(reference: string, path: WorkflowValuePath = []): WorkflowJsonValue {
    if (!this.values.has(reference)) {
      throw new WorkflowReferenceError(`reference '${reference}' does not name a recorded result`);
    }
    const value = readPath(this.values.get(reference) as WorkflowJsonValue, path);
    if (value === undefined) {
      throw new WorkflowReferenceError(
        `reference '${reference}' has no value at path ${JSON.stringify(path)}`,
      );
    }
    return value;
  }

  /**
   * The references used so far, in order, with the nested field each one addressed: this is what the
   * recording preserves instead of the values, and it is enough to rebuild the binding.
   */
  referencesUsed(): ReadonlyArray<ReferenceUse> {
    return this.usage.map((use) => ({ ...use, path: [...use.path] }));
  }
}

export interface ReferenceInvocationRequest {
  callId: string;
  /** Arguments as the caller built them: values, references, or a mix. */
  arguments: Record<string, ReferenceArgument>;
}

/**
 * Resolves the caller's references and invokes the original callable.
 *
 * Resolution happens here, immediately before the call, so the tool receives the fresh value while
 * the record keeps the reference. A reference that cannot be resolved fails the call explicitly
 * rather than invoking the tool with something invented.
 */
export async function invokeWithReferences(
  scope: WorkflowReferenceScope,
  request: ReferenceInvocationRequest,
  invoke: (callId: string, args: Record<string, WorkflowJsonValue>) => Promise<WorkflowJsonValue>,
): Promise<{ result: WorkflowJsonValue; reference: string; referencesUsed: ReferenceUse[] }> {
  const args: Record<string, WorkflowJsonValue> = {};
  const used: ReferenceUse[] = [];
  for (const [name, argument] of Object.entries(request.arguments)) {
    if (argument.kind === "value") {
      args[name] = argument.value;
      continue;
    }
    const path = argument.path ?? [];
    args[name] = scope.resolve(argument.reference, path);
    const use: ReferenceUse = {
      callId: request.callId,
      argument: name,
      reference: argument.reference,
      path,
    };
    used.push(use);
    scope.recordUse(use);
  }
  const result = await invoke(request.callId, args);
  return { result, reference: scope.registerResult(request.callId, result), referencesUsed: used };
}
