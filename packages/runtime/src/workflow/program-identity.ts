/**
 * Privacy-safe identities for replay-confirmed program templates.
 *
 * A program source is resolved only on the recording host. The returned identity carries hashes, not
 * source text or bound values. Rendering uses the same tokenizer and token renderer as execution, so
 * every non-hole byte remains part of the proof exactly as recorded.
 */

import {
  type RecordedWorkflow,
  type WorkflowJsonValue,
  type WorkflowProgramIdentity,
  type WorkflowValuePath,
  type WorkflowValueTemplate,
  applyProgramTokenValues,
  hashCanonical,
  tokenizeProgram,
} from "@resin/contracts";

export interface WorkflowProgramIdentityOptions {
  plan: RecordedWorkflow;
  /** Workspace scope for the private source; omitted scopes hash as null. */
  workspaceId?: string;
  /** Resolves private source references in the recording's owning workspace. */
  resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
}

/** Resolve only source shapes that are safe to attest without inventing executable equivalence. */
async function resolveProgramSource(
  source: WorkflowValueTemplate,
  resolvePrivate: WorkflowProgramIdentityOptions["resolvePrivate"],
): Promise<string | undefined> {
  if (source.type === "literal") {
    return typeof source.value === "string" ? source.value : undefined;
  }
  if (source.type !== "private" || resolvePrivate === undefined) return undefined;
  const value = await resolvePrivate(source.reference);
  return typeof value === "string" ? value : undefined;
}

async function identityForProgram(
  template: Extract<WorkflowValueTemplate, { type: "program" }>,
  stepId: string,
  argument: string,
  path: WorkflowValuePath,
  workspaceId: string | undefined,
  resolvePrivate: WorkflowProgramIdentityOptions["resolvePrivate"],
): Promise<WorkflowProgramIdentity | undefined> {
  // A program without an applied hole is not a parameterized identity. In particular, a source that
  // was merely observed or proposed must not become an equivalence proof.
  if (template.holes.length === 0) return undefined;
  const source = await resolveProgramSource(template.source, resolvePrivate);
  if (source === undefined) return undefined;

  const values = new Map<number, string>();
  for (const hole of template.holes) {
    values.set(hole.token, `__resin_program_hole_${hole.token}__`);
  }
  const rendered = applyProgramTokenValues(
    source,
    tokenizeProgram(template.language, source),
    values,
  );
  return {
    stepId,
    argument,
    path: [...path],
    templateDigest: hashCanonical(template),
    sourceDigest: hashCanonical({
      kind: "recorded-program-source-v1",
      workspaceId: workspaceId ?? null,
      language: template.language,
      source: rendered,
    }),
  };
}

async function collectTemplatePrograms(
  template: WorkflowValueTemplate,
  stepId: string,
  argument: string,
  path: WorkflowValuePath,
  workspaceId: string | undefined,
  resolvePrivate: WorkflowProgramIdentityOptions["resolvePrivate"],
  identities: WorkflowProgramIdentity[],
): Promise<void> {
  switch (template.type) {
    case "object":
      for (const [key, entry] of Object.entries(template.entries)) {
        await collectTemplatePrograms(
          entry,
          stepId,
          argument,
          [...path, key],
          workspaceId,
          resolvePrivate,
          identities,
        );
      }
      return;
    case "array":
      for (const [index, entry] of template.items.entries()) {
        await collectTemplatePrograms(
          entry,
          stepId,
          argument,
          [...path, index],
          workspaceId,
          resolvePrivate,
          identities,
        );
      }
      return;
    case "program": {
      const identity = await identityForProgram(
        template,
        stepId,
        argument,
        path,
        workspaceId,
        resolvePrivate,
      );
      if (identity !== undefined) identities.push(identity);
      return;
    }
    default:
      return;
  }
}

/**
 * Computes identities from the final, replay-confirmed plan.
 *
 * Callers MUST pass the plan returned by confirmation, never the proposal plan. Consequently every
 * hole traversed here is an applied executable hole; refused or dropped candidates cannot be hidden
 * behind a source identity.
 */
export async function computeWorkflowProgramIdentities(
  params: WorkflowProgramIdentityOptions,
): Promise<WorkflowProgramIdentity[]> {
  const identities: WorkflowProgramIdentity[] = [];
  for (const step of params.plan.steps) {
    for (const argument of step.arguments) {
      if (argument.source.kind !== "template") continue;
      await collectTemplatePrograms(
        argument.source.template,
        step.id,
        argument.name,
        [],
        params.workspaceId,
        params.resolvePrivate,
        identities,
      );
    }
  }
  return identities;
}
