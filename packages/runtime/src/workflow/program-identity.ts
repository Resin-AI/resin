/**
 * Privacy-safe identities for replay-confirmed program templates.
 *
 * A program source is resolved only on the recording host. The returned identity carries hashes, not
 * source text or bound values. Rendering uses the same tokenizer and token renderer as execution, so
 * every non-hole byte remains part of the proof exactly as recorded.
 */

import {
  type ProgramToken,
  type ProgramTokenListValue,
  type ProgramTokenSpanValue,
  type RecordedWorkflow,
  type WorkflowJsonValue,
  type WorkflowProgramIdentity,
  type WorkflowStep,
  type WorkflowValuePath,
  type WorkflowValueTemplate,
  analyzeProgramSourceProjection,
  applyProgramTokenValues,
  embeddedPrograms,
  hashCanonical,
  segmentOriginal,
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
  step: WorkflowStep,
  argument: string,
  path: WorkflowValuePath,
  workspaceId: string | undefined,
  resolvePrivate: WorkflowProgramIdentityOptions["resolvePrivate"],
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowProgramIdentity | undefined> {
  const stepId = step.id;
  const projection = projectedProgramSource(template, `${stepId}.${argument}`);
  if (projection !== undefined && !declaredPrivateReferences.has(projection)) {
    throw new Error(`${stepId}.${argument} projected source reference is not declared`);
  }
  // A program without an applied hole is not a parameterized identity. In particular, a source that
  // was merely observed or proposed must not become an equivalence proof.
  if (template.holes.length === 0) return undefined;
  const resolved = await resolveProgramSource(template, projection, resolvePrivate);
  const source = projection === undefined ? resolved : segmentOriginal(step, argument, resolved);
  if (typeof source !== "string") return undefined;
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

  const sentinel = (token: ProgramToken | undefined, name: string) =>
    token?.kind === "number"
      ? 0
      : token?.kind === "boolean"
        ? false
        : token?.kind === "null"
          ? null
          : `__resin_program_hole_${name}__`;
  const values = new Map<number, string | number | boolean | null>();
  const embedded = new Map<number, Map<number, string | number | boolean | null>>();
  const programs = template.holes.some((hole) => hole.embedded !== undefined)
    ? embeddedPrograms(source)
    : [];
  const spans: ProgramTokenSpanValue[] = [];
  const lists: ProgramTokenListValue[] = [];
  for (const hole of template.holes) {
    if (hole.through !== undefined) {
      // A word list is one hole over its whole run: one sentinel word names both ends.
      lists.push({
        token: hole.token,
        through: hole.through,
        items: [`__resin_program_hole_${hole.token}_through_${hole.through}__`],
      });
      continue;
    }
    if (hole.span !== undefined) {
      // The span is part of the identity: the sentinel names the token and both offsets.
      const at = hole.embedded === undefined ? `${hole.token}` : `${hole.token}_${hole.embedded}`;
      spans.push({
        token: hole.token,
        ...(hole.embedded === undefined ? {} : { embedded: hole.embedded }),
        span: hole.span,
        value: `__resin_program_hole_${at}_${hole.span.start}_${hole.span.end}__`,
      });
      continue;
    }
    if (hole.embedded === undefined) {
      values.set(hole.token, sentinel(tokens[hole.token], String(hole.token)));
      continue;
    }
    // The embedded index is part of the identity: the sentinel names both addresses.
    const token = programs.find((program) => program.anchor === hole.token)?.tokens[hole.embedded];
    const program = embedded.get(hole.token) ?? new Map();
    program.set(hole.embedded, sentinel(token, `${hole.token}_${hole.embedded}`));
    embedded.set(hole.token, program);
  }
  const rendered = applyProgramTokenValues(
    source,
    tokens,
    values,
    template.language,
    embedded,
    spans,
    lists,
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
  step: WorkflowStep,
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
          step,
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
          step,
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
        step,
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
        step,
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
