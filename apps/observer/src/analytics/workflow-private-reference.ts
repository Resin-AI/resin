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

/** Demonstration slot holding one whole recorded argument of a call. */
export function workflowCallArgumentSlot(argument: string): string {
  return `argument:${argument}`;
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
