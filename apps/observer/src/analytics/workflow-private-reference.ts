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
