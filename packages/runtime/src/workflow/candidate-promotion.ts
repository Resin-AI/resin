/**
 * Writing the bindings a replay confirmed into the plan a caller will invoke.
 *
 * The plan is the only artifact a client executes, so a confirmed binding has to become part of it
 * rather than of a side channel: the step carries the binding, the workflow declares the input, and
 * nothing else about the recording changes. A candidate that was not confirmed is simply absent, and
 * the step keeps the value the user actually passed.
 */

import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowValuePath,
  type WorkflowValueSource,
  type WorkflowValueTemplate,
  bindProgramToken,
  hashCanonical,
} from "@resin/contracts";

/** The template a recorded source resolves through, so a binding can be placed inside it. */
export function sourceAsTemplate(source: WorkflowValueSource): WorkflowValueTemplate {
  switch (source.kind) {
    case "literal":
      return { type: "literal", value: source.value };
    case "input":
      return { type: "input", name: source.name };
    case "result":
      return { type: "result", stepId: source.stepId, path: [...source.path] };
    case "private":
      return { type: "private", reference: source.reference };
    case "unresolved":
      return { type: "unresolved", reason: source.reason };
    case "template":
      return source.template;
  }
}

/** Expand a literal so validated paths inside arrays and objects are addressable. */
function literalAsTemplate(
  value: WorkflowValueTemplate & { type: "literal" },
): WorkflowValueTemplate {
  const expand = (item: typeof value.value): WorkflowValueTemplate => {
    if (Array.isArray(item)) return { type: "array", items: item.map(expand) };
    if (item !== null && typeof item === "object") {
      return {
        type: "object",
        entries: Object.fromEntries(
          Object.entries(item).map(([key, entry]) => [key, expand(entry)]),
        ),
      };
    }
    return { type: "literal", value: item };
  };
  return expand(value.value);
}

/** Canonical identity for a candidate, excluding its diagnostic reason and evidence. */
function candidateIdentity(candidate: WorkflowBindingCandidate): string {
  return hashCanonical({
    stepId: candidate.stepId,
    argument: candidate.argument,
    path: candidate.path,
    proposed: candidate.proposed,
  });
}

/** Replaces the template at `path`, rebuilding the spine so nothing else in the plan is touched. */
function withLeafAt(
  template: WorkflowValueTemplate,
  path: WorkflowValuePath,
  leaf: WorkflowValueTemplate,
): WorkflowValueTemplate | undefined {
  if (path.length === 0) return leaf;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    if (template.type !== "array") return undefined;
    const item = template.items[head];
    if (item === undefined) return undefined;
    const replaced = withLeafAt(item, rest, leaf);
    if (replaced === undefined) return undefined;
    const items = [...template.items];
    items[head] = replaced;
    return { type: "array", items };
  }
  if (typeof head !== "string" || template.type !== "object") return undefined;
  const entry = template.entries[head];
  if (entry === undefined) return undefined;
  const replaced = withLeafAt(entry, rest, leaf);
  if (replaced === undefined) return undefined;
  return { type: "object", entries: { ...template.entries, [head]: replaced } };
}

/** Apply exactly one confirmed proposal, refusing invalid or unsafe placements atomically. */
export function applyConfirmedWorkflowBinding(
  plan: RecordedWorkflow,
  candidate: WorkflowBindingCandidate,
): RecordedWorkflow | undefined {
  const stepIndex = plan.steps.findIndex((step) => step.id === candidate.stepId);
  if (stepIndex < 0) return undefined;
  const step = plan.steps[stepIndex]!;
  const argumentIndex = step.arguments.findIndex(
    (argument) => argument.name === candidate.argument,
  );
  if (argumentIndex < 0) return undefined;
  const argument = step.arguments[argumentIndex]!;
  const proposed = candidate.proposed;
  if (proposed.kind === "result") {
    const producer = plan.steps.findIndex((entry) => entry.id === proposed.stepId);
    if (producer < 0 || producer >= stepIndex) return undefined;
  } else {
    const existing = plan.inputs.find((input) => input.name === proposed.name);
    if (existing !== undefined && existing.type !== proposed.type) return undefined;
  }
  const isToken = candidate.path[0] === "tokens";
  if (
    !isToken &&
    candidate.path.length === 0 &&
    step.callable.program?.argument === candidate.argument
  ) {
    return undefined;
  }
  const leaf: WorkflowValueTemplate =
    proposed.kind === "result"
      ? { type: "result", stepId: proposed.stepId, path: [...proposed.path] }
      : { type: "input", name: proposed.name };
  const source = sourceAsTemplate(argument.source);
  const template = source.type === "literal" && !isToken ? literalAsTemplate(source) : source;
  let replaced: WorkflowValueTemplate | undefined;
  if (isToken) {
    const token = candidate.path[1];
    const program = step.callable.program;
    if (
      candidate.path.length !== 2 ||
      program?.argument !== candidate.argument ||
      typeof token !== "number" ||
      !Number.isInteger(token) ||
      token < 0
    )
      return undefined;
    replaced = bindProgramToken(source, program.kind, token, leaf);
  } else {
    replaced = withLeafAt(template, candidate.path, leaf);
  }
  if (replaced === undefined) return undefined;
  const steps = [...plan.steps];
  const args = [...step.arguments];
  args[argumentIndex] = {
    ...argument,
    source: { kind: "template", template: replaced },
    provenance: { standing: "derived", rule: "replay-confirmed" },
  };
  steps[stepIndex] = { ...step, arguments: args };
  const inputs =
    proposed.kind === "input" && !plan.inputs.some((input) => input.name === proposed.name)
      ? [...plan.inputs, { name: proposed.name, type: proposed.type }]
      : plan.inputs;
  const candidates = plan.candidates?.filter(
    (entry) => candidateIdentity(entry) !== candidateIdentity(candidate),
  );
  return { ...plan, steps, inputs, ...(candidates === undefined ? {} : { candidates }) };
}

/** Apply only caller-confirmed candidates; rejected proposals remain recorded as proposals. */
export function applyAcceptedBindings(
  plan: RecordedWorkflow,
  accepted: readonly WorkflowBindingCandidate[],
): RecordedWorkflow {
  let current = plan;
  for (const candidate of accepted) {
    current = applyConfirmedWorkflowBinding(current, candidate) ?? current;
  }
  return current;
}
