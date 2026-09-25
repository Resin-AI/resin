/**
 * Privacy-safe identities for replay-confirmed program templates.
 *
 * A program source is resolved only on the recording host. The returned identity carries hashes, not
 * source text or bound values. Rendering uses the same tokenizer and token renderer as execution, so
 * every non-hole byte remains part of the proof exactly as recorded.
 */

import {
  type ProgramToken,
  type RecordedWorkflow,
  type WorkflowJsonValue,
  type WorkflowProgramIdentity,
  type WorkflowValuePath,
  type WorkflowValueTemplate,
  analyzeProgramSourceProjection,
  applyProgramTokenValues,
  hashCanonical,
  tokenizeProgram,
  validateWorkflowProgramProjection,
} from "@resin/contracts";

export interface WorkflowProgramIdentityOptions {
  plan: RecordedWorkflow;
  /** Workspace scope for the private source; omitted scopes hash as null. */
  workspaceId?: string;
  /** Resolves private source references in the recording's owning workspace. */
  resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
}

function projectedProgramSource(
  template: Extract<WorkflowValueTemplate, { type: "program" }>,
  path: string,
): string | undefined {
  const hasReference = Object.prototype.hasOwnProperty.call(template, "sourceReference");
  const hasProtectedTokens = Object.prototype.hasOwnProperty.call(template, "protectedTokens");
  if (!hasReference && !hasProtectedTokens) return undefined;
  const errors: string[] = [];
  validateWorkflowProgramProjection(template, path, errors);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (typeof template.sourceReference !== "string") {
    throw new Error(`${path} projected program source reference is malformed`);
  }
  return template.sourceReference;
}

/** Resolve only source shapes that are safe to attest without inventing executable equivalence. */
async function resolveProgramSource(
  template: Extract<WorkflowValueTemplate, { type: "program" }>,
  projection: string | undefined,
  resolvePrivate: WorkflowProgramIdentityOptions["resolvePrivate"],
): Promise<string | undefined> {
  if (projection !== undefined) {
    if (resolvePrivate === undefined) return undefined;
    const value = await resolvePrivate(projection);
    return typeof value === "string" ? value : undefined;
  }
  const source = template.source;
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
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowProgramIdentity | undefined> {
  const projection = projectedProgramSource(template, `${stepId}.${argument}`);
  if (projection !== undefined && !declaredPrivateReferences.has(projection)) {
    throw new Error(`${stepId}.${argument} projected source reference is not declared`);
  }
  // A program without an applied hole is not a parameterized identity. In particular, a source that
  // was merely observed or proposed must not become an equivalence proof.
  if (template.holes.length === 0) return undefined;
  const source = await resolveProgramSource(template, projection, resolvePrivate);
  if (source === undefined) return undefined;
  let tokens: ProgramToken[];
  if (projection === undefined) {
    tokens = tokenizeProgram(template.language, source);
  } else {
    const sanitizedSource = template.source;
    if (
      sanitizedSource.type !== "literal" ||
      typeof sanitizedSource.value !== "string" ||
      template.protectedTokens === undefined
    ) {
      throw new Error(`${stepId}.${argument} projected program metadata is malformed`);
    }
    tokens = analyzeProgramSourceProjection(
      template.language,
      source,
      sanitizedSource.value,
      template.protectedTokens,
    ).tokens;
  }

  const values = new Map<number, string | number | boolean | null>();
  for (const hole of template.holes) {
    const token = tokens[hole.token];
    if (token?.kind === "number") values.set(hole.token, 0);
    else if (token?.kind === "boolean") values.set(hole.token, false);
    else if (token?.kind === "null") values.set(hole.token, null);
    else values.set(hole.token, `__resin_program_hole_${hole.token}__`);
  }
  const rendered = applyProgramTokenValues(source, tokens, values, template.language);
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
  declaredPrivateReferences: ReadonlySet<string>,
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
          declaredPrivateReferences,
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
          declaredPrivateReferences,
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
        declaredPrivateReferences,
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
  const declaredPrivateReferences = new Set(params.plan.privateReferences ?? []);
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
        declaredPrivateReferences,
        identities,
      );
    }
  }
  return identities;
}
