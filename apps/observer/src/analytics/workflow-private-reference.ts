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
