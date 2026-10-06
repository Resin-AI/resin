import { createHash } from "node:crypto";
import type { PrivateValueRepresentation } from "./private-value-store.js";

export type WorkflowPrivateReferenceNamespace = "value" | "demonstration";

/** The stable identity used by the local workflow recorder for V2 private values. */
export function workflowPrivateReference(
  namespace: WorkflowPrivateReferenceNamespace,
  workspaceId: string | undefined,
  representation: PrivateValueRepresentation,
  parts: readonly unknown[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([workspaceId ?? null, representation, ...parts]))
    .digest("hex");
  return `private:v2:${namespace}:${digest}`;
}

/** Demonstration slot holding a recorded call's callable and argument names. */
export const WORKFLOW_CALL_IDENTITY_SLOT = "callable:v1";
/**
 * The shell dialect a later record proved for a call recorded with an unproven one: the executable
 * a Codex command's end event names. Kept apart from the call's identity, which never changes.
 */
export const WORKFLOW_CALL_DIALECT_SLOT = "shell-dialect:v1";
/**
 * Set once a later record of such a call disagreed with the one that proved its dialect: the proof
 * is revoked, whatever the dialect slot holds.
 */
export const WORKFLOW_CALL_DIALECT_CONFLICT_SLOT = "shell-dialect-conflict:v1";

/**
 * Set once a call received a second, different result: the first result stays stored, immutable,
 * but is no baseline for the call any more. Nothing clears it.
 */
export const WORKFLOW_CALL_RESULT_CONFLICT_SLOT = "result-conflict:v1";

/**
 * Demonstration slot holding where the recorder placed a call among the calls it recorded,
 * `{epoch, index}`. Written once, the first time the call is recorded, and never uploaded.
 */
export const WORKFLOW_CALL_ORDER_SLOT = "order:v1";

/**
 * Demonstration slot holding the exit status a recorded shell call reported, as a number: kept only
 * where the harness establishes it (a native command's exit code; an OMP bash call, whose tool
 * reports an error for any non-zero exit, is 0 when it did not). Never any output.
 */
export const WORKFLOW_CALL_EXIT_CODE_SLOT = "exit-code:v1";

/**
 * Demonstration slot holding the argument positions the call's upload kept private, as
 * `[{argument, path}]`, computed from the carrier the recorder emitted. A validation check compares
 * those positions only with values the device supplies; a call without this slot is treated as
 * private in every string leaf.
 */
export const WORKFLOW_CALL_PRIVATE_POSITIONS_SLOT = "private-positions:v1";

/**
 * Demonstration slot holding whether the output a call's upload carried (its redacted view) had
 * secret redaction applied: `true` when any redaction placeholder replaced part of it. A recorded
 * result without this slot is treated as redacted.
 */
export const WORKFLOW_CALL_RESULT_REDACTED_SLOT = "result-redacted:v1";

/** Demonstration slot holding one whole recorded argument of a call. */
export function workflowCallArgumentSlot(argument: string): string {
  return `argument:${argument}`;
}

/**
 * Demonstration slot set (to `true`) once the recorder judged, over the whole execution it recorded
 * a call in, which of the call's argument positions carry a value an earlier call printed (see
 * {@link workflowCallDependencySlot}). Absent for a call recorded before the recorder kept that
 * judgement.
 */
export const WORKFLOW_CALL_DEPENDENCIES_SLOT = "dependencies:v1";

/**
 * Demonstration slot set (to `true`) for one argument position of a call the recorder judged to
 * carry a value an earlier call of its execution printed: the value first appeared in that output,
 * not in anything the session held before it.
 */
export function workflowCallDependencySlot(
  argument: string,
  path: ReadonlyArray<string | number>,
): string {
  return `dependency:v1:${JSON.stringify([argument, path])}`;
}

/** Demonstration slots a recorded call's result may be kept under, with their comparison. */
export const WORKFLOW_CALL_RESULT_SLOTS: ReadonlyArray<{
  slot: string;
  comparison?: "text-trim";
}> = [
  { slot: "result" },
  { slot: "native-result:v1:exact" },
  { slot: "native-result:v1:text-trim", comparison: "text-trim" },
];
