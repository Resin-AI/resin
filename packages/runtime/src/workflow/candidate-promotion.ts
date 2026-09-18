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

/** The template a step's argument resolves through, or undefined when it is not a template. */
function templateOf(
  plan: RecordedWorkflow,
  stepId: string,
  argumentName: string,
): WorkflowValueTemplate | undefined {
  const step = plan.steps.find((entry) => entry.id === stepId);
  const argument = step?.arguments.find((entry) => entry.name === argumentName);
  return argument?.source.kind === "template" ? argument.source.template : undefined;
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

/**
 * Applies accepted candidates to a plan.
 *
 * A candidate that cannot be placed — an argument this step does not have, a path that addresses no
 * leaf — is left out rather than approximated: the recording stands where the promotion does not
 * apply, which is the behaviour the user actually performed.
 */
export function applyAcceptedBindings(
  plan: RecordedWorkflow,
  accepted: readonly WorkflowBindingCandidate[],
): RecordedWorkflow {
  if (accepted.length === 0) return plan;
  const next = JSON.parse(JSON.stringify(plan)) as RecordedWorkflow;
  const inputs = new Map(next.inputs.map((input) => [input.name, input]));
  for (const candidate of accepted) {
    const step = next.steps.find((entry) => entry.id === candidate.stepId);
    const argument = step?.arguments.find((entry) => entry.name === candidate.argument);
    if (argument === undefined || step === undefined) continue;
    const template = templateOf(next, candidate.stepId, candidate.argument);
    // A token binding names a position inside the program the step's own record holds in that
    // argument, so it binds the recorded text into a program template rather than walking a path
    // through a value.
    const isTokenBinding = candidate.path[0] === "tokens";
    const program = isTokenBinding ? step.callable.program : undefined;
    if (isTokenBinding && program?.argument !== candidate.argument) continue;
    if (!isTokenBinding && template === undefined) continue;
    let leaf: WorkflowValueTemplate;
    if (candidate.proposed.kind === "result") {
      leaf = { type: "result", stepId: candidate.proposed.stepId, path: candidate.proposed.path };
    } else {
      leaf = { type: "input", name: candidate.proposed.name };
      inputs.set(candidate.proposed.name, {
        name: candidate.proposed.name,
        type: candidate.proposed.type,
      });
    }
    let replaced: WorkflowValueTemplate | undefined;
    if (isTokenBinding) {
      const token = candidate.path[1];
      if (program === undefined) continue;
      if (typeof token !== "number" || !Number.isInteger(token) || token < 0) continue;
      replaced = bindProgramToken(
        template ?? sourceAsTemplate(argument.source),
        program.kind,
        token,
        leaf,
      );
    } else {
      replaced = withLeafAt(template as WorkflowValueTemplate, candidate.path, leaf);
    }
    if (replaced === undefined) continue;
    argument.source = { kind: "template", template: replaced };
  }
  next.inputs = [...inputs.values()];
  return next;
}
