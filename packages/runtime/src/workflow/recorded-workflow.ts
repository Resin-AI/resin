/**
 * Invocation of recorded calls through their own runtime.
 *
 * Adapters implement communication or execution for one runtime family — a protocol reached over a
 * connection, a program run on the host, a broker. The registry is keyed by the family the record
 * names, never by the tool, application or task: a callable discovered after this code was written
 * is callable as soon as its runtime family has an adapter, and a workflow that uses it needs no
 * change here.
 */

import {
  analyzeProgramSourceProjection,
  applyProgramTokenValues,
  extractPrintedValue,
  parseExtractLocator,
  programNotLearnableReason,
  programTokenValueAt,
  projectedEmbeddedTokenIsBindable,
  recordedProgramLanguage,
  segmentOriginal,
  tokenizeProgram,
  validateWorkflowProgramProjection,
  workflowListInputProblem,
  workflowSinkStepIds,
} from "@resin/contracts";
import type {
  ProgramToken,
  ProgramTokenListValue,
  ProgramTokenSpanValue,
  RecordedWorkflow,
  WorkflowJsonValue,
  WorkflowListInput,
  WorkflowStep,
  WorkflowValuePath,
  WorkflowValueTemplate,
} from "@resin/contracts";

/** One call, with the callable the record names and the arguments resolved for it. */
export interface RecordedCallRequest {
  step: WorkflowStep;
  arguments: Record<string, WorkflowJsonValue>;
  /** Local private-reference resolver used by composite Python setup cells. */
  resolvePrivate?: (
    reference: string,
    access?: { workspaceId?: string },
  ) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  /** Workspace scope forwarded to the private resolver. */
  access?: { workspaceId?: string };
  /** Cancels owned I/O; adapter calls must settle after abort before replay cleanup. */
  signal?: AbortSignal;
  /**
   * Replay confirmation only: a step marked `displayFilter` pipes its command's output through the
   * display filter it drops, so its result compares with what the recording printed.
   */
  applyDisplayFilter?: boolean;
}

/**
 * A runtime adapter: it talks to or runs the callable. It never decides whether a workflow is
 * supported.
 */
export interface RuntimeAdapter {
  /** The runtime family this adapter serves, matching `step.callable.runtime`. */
  readonly runtime: string;
  call(request: RecordedCallRequest): Promise<WorkflowJsonValue>;
}

export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.runtime)) {
      throw new Error(`runtime adapter already registered for '${adapter.runtime}'`);
    }
    this.adapters.set(adapter.runtime, adapter);
  }

  has(runtime: string): boolean {
    return this.adapters.has(runtime);
  }

  /** The adapter for a callable, or undefined when its runtime family is not reachable here. */
  resolve(step: WorkflowStep): RuntimeAdapter | undefined {
    return this.adapters.get(step.callable.runtime);
  }
}

export interface RecordedWorkflowExecutionOptions {
  inputs: Record<string, WorkflowJsonValue>;
  adapters: RuntimeAdapterRegistry;
  /** Stops subsequent steps and forwards cancellation to every adapter call. */
  signal?: AbortSignal;
  /** The workspace this invocation runs in, checked before any private reference resolves. */
  access?: { workspaceId?: string };
  /**
   * Private resources are resolved here, at execution time; they are never part of the plan.
   * The access context names the workspace the invocation runs in so the host can refuse a
   * reference recorded elsewhere, instead of treating the reference string as a capability.
   */
  resolvePrivate?: (
    reference: string,
    access?: { workspaceId?: string },
  ) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  /** Reported when a required adapter or binding is missing, instead of pretending to succeed. */
  onUnavailable?: (step: WorkflowStep, reason: string) => void;
  /**
   * Set only by replays that compare results with a recording (`binding-validation.ts`): see
   * `RecordedCallRequest.applyDisplayFilter`. An invocation never sets it, so a caller gets the
   * command's whole output.
   */
  applyDisplayFilters?: boolean;
}

export type RecordedStepOutcome =
  | { stepId: string; status: "completed"; result: WorkflowJsonValue }
  | { stepId: string; status: "failed"; error: string }
  | { stepId: string; status: "skipped"; reason: string }
  /** An optional step the caller turned off through its toggle input; never ran. */
  | { stepId: string; status: "omitted"; input: string };

export type RecordedWorkflowExecution = {
  status: "completed" | "failed";
  steps: RecordedStepOutcome[];
  /** The last completed step's result. */
  result: WorkflowJsonValue | undefined;
  error?: string;
};

export class WorkflowBindingError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    public readonly argument: string,
  ) {
    super(message);
    this.name = "WorkflowBindingError";
  }
}

/** Execution options with the word-list inputs the workflow declares, by name. */
type ResolutionOptions = RecordedWorkflowExecutionOptions & {
  listInputs: ReadonlyMap<string, WorkflowListInput>;
};

function matchesWorkflowInputType(
  value: unknown,
  type: RecordedWorkflow["inputs"][number]["type"],
): value is WorkflowJsonValue {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  return false;
}

function copyWorkflowJsonValue(value: WorkflowJsonValue): WorkflowJsonValue {
  return value !== null && typeof value === "object"
    ? (JSON.parse(JSON.stringify(value)) as WorkflowJsonValue)
    : value;
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

/** Validate projection metadata before trusting it to select the executable source. */
function projectedProgramSource(
  template: Extract<WorkflowValueTemplate, { type: "program" }>,
  stepId: string,
  argumentName: string,
): string | undefined {
  const hasReference = Object.prototype.hasOwnProperty.call(template, "sourceReference");
  const hasProtectedTokens = Object.prototype.hasOwnProperty.call(template, "protectedTokens");
  if (!hasReference && !hasProtectedTokens) return undefined;
  const errors: string[] = [];
  validateWorkflowProgramProjection(template, `${stepId}.${argumentName}`, errors);
  if (errors.length > 0) {
    throw new WorkflowBindingError(errors.join("; "), stepId, argumentName);
  }
  if (typeof template.sourceReference !== "string") {
    throw new WorkflowBindingError(
      "the projected program source reference is malformed",
      stepId,
      argumentName,
    );
  }
  return template.sourceReference;
}

/**
 * The whole original text a program template runs. A projected literal is only a bounded,
 * secret-redacted view; its original is the execution authority and must resolve locally.
 */
async function originalProgramText(
  template: Extract<WorkflowValueTemplate, { type: "program" }>,
  step: WorkflowStep,
  argumentName: string,
  options: RecordedWorkflowExecutionOptions,
  declaredPrivateReferences: ReadonlySet<string>,
  resolveLeaf: (leaf: WorkflowValueTemplate) => Promise<WorkflowJsonValue>,
): Promise<string> {
  const projection = projectedProgramSource(template, step.id, argumentName);
  if (projection !== undefined && !declaredPrivateReferences.has(projection)) {
    throw new WorkflowBindingError(
      "the projected program source reference is not declared by the workflow",
      step.id,
      argumentName,
    );
  }
  if (projection !== undefined) {
    if (!options.resolvePrivate) {
      throw new WorkflowBindingError(
        "the original program source reference cannot be resolved in this environment",
        step.id,
        argumentName,
      );
    }
    const original = await options.resolvePrivate(projection, options.access);
    if (typeof original !== "string") {
      throw new WorkflowBindingError(
        "the original program source reference did not resolve to program text",
        step.id,
        argumentName,
      );
    }
    // A segment step runs its own command of the recorded chain, never the whole chain.
    const segment = segmentOriginal(step, argumentName, original);
    if (typeof segment !== "string") {
      throw new WorkflowBindingError(
        "the original program is not the recorded chain this segment was split from",
        step.id,
        argumentName,
      );
    }
    return segment;
  }
  const sourceText = await resolveLeaf(template.source);
  if (typeof sourceText !== "string") {
    throw new WorkflowBindingError(
      "the recorded program did not resolve to program text",
      step.id,
      argumentName,
    );
  }
  return sourceText;
}

/**
 * The value the recording used for an omitted recorded-default input, read at the input's first
 * hole in a recorded (non-derivation) program step — the token an omitted input keeps there.
 * Undefined when no recorded step binds the input or its token is not safely readable.
 */
async function recordedInputValue(
  workflow: RecordedWorkflow,
  input: RecordedWorkflow["inputs"][number],
  options: ResolutionOptions,
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowJsonValue | undefined> {
  for (const step of workflow.steps) {
    if (step.origin === "derivation") continue;
    for (const argument of step.arguments) {
      if (argument.source.kind !== "template" || argument.source.template.type !== "program") {
        continue;
      }
      const template = argument.source.template;
      const hole = template.holes.find(
        (each) => each.binding.type === "input" && each.binding.name === input.name,
      );
      if (hole === undefined) continue;
      const resolveLeaf = async (leaf: WorkflowValueTemplate): Promise<WorkflowJsonValue> =>
        buildTemplate(leaf, step, argument.name, options, new Map(), declaredPrivateReferences);
      let text: string;
      try {
        text = await originalProgramText(
          template,
          step,
          argument.name,
          options,
          declaredPrivateReferences,
          resolveLeaf,
        );
      } catch {
        // An unreadable recording supplies nothing; the derivation then reports the input missing.
        return undefined;
      }
      const value = programTokenValueAt(template.language, text, {
        token: hole.token,
        ...(hole.embedded === undefined ? {} : { embedded: hole.embedded }),
        ...(hole.span === undefined ? {} : { span: hole.span }),
      });
      return value !== undefined && matchesWorkflowInputType(value, input.type) ? value : undefined;
    }
  }
  return undefined;
}

/** Builds a recursively constructed argument: every leaf keeps its own source. */
async function buildTemplate(
  template: WorkflowValueTemplate,
  step: WorkflowStep,
  argumentName: string,
  options: ResolutionOptions,
  results: Map<string, WorkflowJsonValue>,
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowJsonValue> {
  const resolveLeaf = async (leaf: WorkflowValueTemplate): Promise<WorkflowJsonValue> =>
    buildTemplate(leaf, step, argumentName, options, results, declaredPrivateReferences);
  switch (template.type) {
    case "literal":
      return template.value;
    case "input": {
      if (!Object.hasOwn(options.inputs, template.name)) {
        throw new WorkflowBindingError(
          `input '${template.name}' was not supplied`,
          step.id,
          argumentName,
        );
      }
      return options.inputs[template.name] as WorkflowJsonValue;
    }
    case "result": {
      if (!results.has(template.stepId)) {
        throw new WorkflowBindingError(
          `step '${template.stepId}' has no result in this invocation; it did not complete`,
          step.id,
          argumentName,
        );
      }
      const value = readPath(results.get(template.stepId) as WorkflowJsonValue, template.path);
      if (value === undefined) {
        throw new WorkflowBindingError(
          `step '${template.stepId}' returned no value at path ${JSON.stringify(template.path)}`,
          step.id,
          argumentName,
        );
      }
      return value;
    }
    case "private": {
      if (!options.resolvePrivate) {
        throw new WorkflowBindingError(
          `private reference '${template.reference}' cannot be resolved in this environment`,
          step.id,
          argumentName,
        );
      }
      return await options.resolvePrivate(template.reference, options.access);
    }
    case "extract": {
      const produced = results.get(template.stepId);
      if (typeof produced !== "string") {
        throw new WorkflowBindingError(
          `step '${template.stepId}' printed no text in this invocation to extract a value from`,
          step.id,
          argumentName,
        );
      }
      if (!declaredPrivateReferences.has(template.locator) || !options.resolvePrivate) {
        throw new WorkflowBindingError(
          "the extract locator cannot be resolved in this environment",
          step.id,
          argumentName,
        );
      }
      const locatorText = await options.resolvePrivate(template.locator, options.access);
      const locator =
        typeof locatorText === "string" ? parseExtractLocator(locatorText) : undefined;
      if (locator === undefined) {
        throw new WorkflowBindingError("the extract locator is malformed", step.id, argumentName);
      }
      const value = extractPrintedValue(produced, locator);
      if (value === undefined) {
        throw new WorkflowBindingError(
          `step '${template.stepId}' did not print the value this argument extracts`,
          step.id,
          argumentName,
        );
      }
      return value;
    }
    case "unresolved":
      throw new WorkflowBindingError(
        `the origin of this value was not recorded (${template.reason}); re-record the call or supply it as an input`,
        step.id,
        argumentName,
      );
    case "object": {
      const built: Record<string, WorkflowJsonValue> = {};
      for (const [key, entry] of Object.entries(template.entries)) {
        built[key] = await resolveLeaf(entry);
      }
      return built;
    }
    case "array": {
      const built: WorkflowJsonValue[] = [];
      for (const item of template.items) built.push(await resolveLeaf(item));
      return built;
    }
    case "text": {
      let built = "";
      for (const part of template.parts) {
        const value = await resolveLeaf(part);
        if (typeof value !== "string") {
          throw new WorkflowBindingError(
            "a composed text argument has a part that is not a string",
            step.id,
            argumentName,
          );
        }
        built += value;
      }
      return built;
    }
    case "program": {
      // The program the step records is read in its own shell dialect: a template in another
      // grammar would render its values with another shell's quoting, and a program Resin never
      // tokenizes (cmd.exe, an unproven dialect) takes no template at all.
      const recorded = step.callable.program;
      if (recorded?.kind === "shell" && recorded.argument === argumentName) {
        const expected = recordedProgramLanguage(recorded);
        if (expected === undefined) {
          throw new WorkflowBindingError(
            programNotLearnableReason(recorded) ?? "the recorded shell program is not learnable",
            step.id,
            argumentName,
          );
        }
        if (template.language !== expected) {
          throw new WorkflowBindingError(
            "the program template is written in another shell dialect than its recorded program",
            step.id,
            argumentName,
          );
        }
      }
      const text = await originalProgramText(
        template,
        step,
        argumentName,
        options,
        declaredPrivateReferences,
        resolveLeaf,
      );
      const projection = projectedProgramSource(template, step.id, argumentName);
      let tokens: ProgramToken[] | undefined;
      if (projection !== undefined) {
        const sanitizedSource = template.source;
        if (
          sanitizedSource.type !== "literal" ||
          typeof sanitizedSource.value !== "string" ||
          template.protectedTokens === undefined
        ) {
          throw new WorkflowBindingError(
            "the projected program metadata is malformed",
            step.id,
            argumentName,
          );
        }
        tokens = analyzeProgramSourceProjection(
          template.language,
          text,
          sanitizedSource.value,
          template.protectedTokens,
        ).tokens;
      }
      const values = new Map<number, string | number | boolean | null>();
      const embedded = new Map<number, Map<number, string | number | boolean | null>>();
      const spans: ProgramTokenSpanValue[] = [];
      const lists: ProgramTokenListValue[] = [];
      for (const hole of template.holes) {
        // An omitted recorded-default input leaves the token exactly as the recording ran it. A
        // derivation's tokens were never recorded; its omitted recorded-default inputs were
        // supplied from the recording before it ran.
        if (
          hole.binding.type === "input" &&
          !Object.hasOwn(options.inputs, hole.binding.name) &&
          step.origin !== "derivation"
        ) {
          continue;
        }
        const bound = await resolveLeaf(hole.binding);
        if (hole.through !== undefined) {
          // A word list: each item becomes one shell word in place of the recorded run.
          const list =
            hole.binding.type === "input" ? options.listInputs.get(hole.binding.name) : undefined;
          if (hole.binding.type !== "input" || list === undefined) {
            throw new WorkflowBindingError(
              "a word-list hole must bind a word-list input",
              step.id,
              argumentName,
            );
          }
          const problem = workflowListInputProblem(hole.binding.name, list, bound);
          if (problem !== undefined) {
            throw new WorkflowBindingError(problem, step.id, argumentName);
          }
          lists.push({
            token: hole.token,
            through: hole.through,
            items: bound as string[],
            ...(list.optionItems === true ? { optionItems: true } : {}),
          });
          continue;
        }
        if (hole.span !== undefined) {
          if (typeof bound !== "string" && typeof bound !== "number") {
            throw new WorkflowBindingError(
              "a span hole needs a string or number value",
              step.id,
              argumentName,
            );
          }
          spans.push({
            token: hole.token,
            ...(hole.embedded === undefined ? {} : { embedded: hole.embedded }),
            span: hole.span,
            value: bound,
          });
          continue;
        }
        const value =
          typeof bound === "string" ||
          typeof bound === "number" ||
          typeof bound === "boolean" ||
          bound === null
            ? bound
            : JSON.stringify(bound);
        if (hole.embedded === undefined) {
          values.set(hole.token, value);
        } else {
          const program = embedded.get(hole.token) ?? new Map();
          program.set(hole.embedded, value);
          embedded.set(hole.token, program);
        }
      }
      const shellTokens = tokens ?? tokenizeProgram(template.language, text);
      if (template.protectedTokens !== undefined) {
        // A secret the recording redacted is never replaced by, or folded into, a caller's list.
        const covered = template.protectedTokens;
        if (
          lists.some((list) =>
            covered.some((index) => list.token <= index && index <= list.through),
          )
        ) {
          throw new WorkflowBindingError(
            "a word list covers a protected token",
            step.id,
            argumentName,
          );
        }
        // A projected program runs from its private original: an embedded hole may replace only a
        // token the sanitized projection showed verbatim, never one a secret sits in or touches.
        const sanitized = template.source.type === "literal" ? template.source.value : undefined;
        const addresses = [
          ...[...embedded].flatMap(([anchor, each]) =>
            [...each.keys()].map((index) => [anchor, index] as const),
          ),
          ...spans.flatMap((span) =>
            span.embedded === undefined ? [] : [[span.token, span.embedded] as const],
          ),
        ];
        for (const [anchor, index] of addresses) {
          if (
            typeof sanitized !== "string" ||
            !projectedEmbeddedTokenIsBindable(
              text,
              sanitized,
              template.protectedTokens,
              anchor,
              index,
            )
          ) {
            throw new WorkflowBindingError(
              "an embedded program hole touches a protected token",
              step.id,
              argumentName,
            );
          }
        }
      }
      return applyProgramTokenValues(
        text,
        shellTokens,
        values,
        template.language,
        embedded,
        spans,
        lists,
      );
    }
    default: {
      const exhaustive: never = template;
      throw new WorkflowBindingError(
        `unsupported template node ${JSON.stringify(exhaustive)}`,
        step.id,
        argumentName,
      );
    }
  }
}

async function resolveArgument(
  step: WorkflowStep,
  argumentName: string,
  source: WorkflowStep["arguments"][number]["source"],
  options: ResolutionOptions,
  results: Map<string, WorkflowJsonValue>,
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowJsonValue> {
  switch (source.kind) {
    case "literal":
      return source.value;
    case "input": {
      if (!Object.hasOwn(options.inputs, source.name)) {
        throw new WorkflowBindingError(
          `input '${source.name}' was not supplied`,
          step.id,
          argumentName,
        );
      }
      return options.inputs[source.name] as WorkflowJsonValue;
    }
    case "result": {
      if (!results.has(source.stepId)) {
        throw new WorkflowBindingError(
          `step '${source.stepId}' has no result in this invocation; it did not complete`,
          step.id,
          argumentName,
        );
      }
      const value = readPath(results.get(source.stepId) as WorkflowJsonValue, source.path);
      if (value === undefined) {
        throw new WorkflowBindingError(
          `step '${source.stepId}' returned no value at path ${JSON.stringify(source.path)}`,
          step.id,
          argumentName,
        );
      }
      return value;
    }
    case "private": {
      if (!options.resolvePrivate) {
        throw new WorkflowBindingError(
          `private reference '${source.reference}' cannot be resolved in this environment`,
          step.id,
          argumentName,
        );
      }
      return await options.resolvePrivate(source.reference, options.access);
    }
    case "unresolved":
      throw new WorkflowBindingError(
        `the origin of this value was not recorded (${source.reason}); re-record the call or supply it as an input`,
        step.id,
        argumentName,
      );
    case "template":
      return await buildTemplate(
        source.template,
        step,
        argumentName,
        options,
        results,
        declaredPrivateReferences,
      );
    default: {
      const exhaustive: never = source;
      throw new WorkflowBindingError(
        `unsupported value source ${JSON.stringify(exhaustive)}`,
        step.id,
        argumentName,
      );
    }
  }
}

/**
 * Runs a recorded workflow: each step's arguments are resolved from this invocation's inputs, the
 * results this invocation produced, and locally resolved private references — never from recorded
 * values — and the recorded order and failure behavior are preserved.
 */
export async function executeRecordedWorkflow(
  workflow: RecordedWorkflow,
  options: RecordedWorkflowExecutionOptions,
): Promise<RecordedWorkflowExecution> {
  const suppliedNames = new Set(Object.keys(options.inputs));
  const declaredNames = new Set(workflow.inputs.map((input) => input.name));
  for (const name of suppliedNames) {
    if (!declaredNames.has(name)) throw new TypeError(`unknown workflow input '${name}'`);
  }

  const inputs: Record<string, WorkflowJsonValue> = Object.create(null);
  const listInputs = new Map<string, WorkflowListInput>();
  for (const input of workflow.inputs) {
    if (input.list !== undefined) listInputs.set(input.name, input.list);
    const listProblem = (value: unknown): string | undefined =>
      input.list === undefined
        ? undefined
        : workflowListInputProblem(input.name, input.list, value);
    if (Object.hasOwn(options.inputs, input.name)) {
      const value = options.inputs[input.name];
      if (!matchesWorkflowInputType(value, input.type)) {
        throw new TypeError(`workflow input '${input.name}' must be a ${input.type}`);
      }
      const problem = listProblem(value);
      if (problem !== undefined) throw new TypeError(problem);
      inputs[input.name] = value;
    } else if (Object.hasOwn(input, "default")) {
      if (!matchesWorkflowInputType(input.default, input.type)) {
        throw new TypeError(
          `workflow input '${input.name}' has a default incompatible with ${input.type}`,
        );
      }
      const problem = listProblem(input.default);
      if (problem !== undefined) throw new TypeError(`${problem} (its default)`);
      inputs[input.name] = copyWorkflowJsonValue(input.default);
    } else if (input.recordedDefault !== true) {
      throw new TypeError(`missing required workflow input '${input.name}'`);
    }
  }
  const executionOptions: ResolutionOptions = { ...options, inputs, listInputs };
  // A derivation reads an omitted recorded-default input as the value the recording used.
  const derivationInputs: Record<string, WorkflowJsonValue> = Object.create(null);
  Object.assign(derivationInputs, inputs);
  const derivationReads = new Set<string>();
  for (const step of workflow.steps) {
    if (step.origin !== "derivation") continue;
    for (const argument of step.arguments) {
      if (argument.source.kind !== "template" || argument.source.template.type !== "program") {
        continue;
      }
      for (const hole of argument.source.template.holes) {
        if (hole.binding.type === "input") derivationReads.add(hole.binding.name);
      }
    }
  }
  const declaredPrivateReferences = new Set(workflow.privateReferences ?? []);
  for (const input of workflow.inputs) {
    if (
      input.recordedDefault !== true ||
      Object.hasOwn(inputs, input.name) ||
      !derivationReads.has(input.name)
    ) {
      continue;
    }
    const recorded = await recordedInputValue(
      workflow,
      input,
      executionOptions,
      declaredPrivateReferences,
    );
    if (recorded !== undefined) derivationInputs[input.name] = recorded;
  }
  const derivationOptions: ResolutionOptions = { ...options, inputs: derivationInputs, listInputs };
  const outcomes: RecordedStepOutcome[] = [];
  const results = new Map<string, WorkflowJsonValue>();
  const state = new Map<string, "completed" | "failed" | "skipped" | "omitted">();
  let aborted = false;

  for (const step of workflow.steps) {
    if (options.signal?.aborted) aborted = true;
    if (aborted) {
      state.set(step.id, "skipped");
      outcomes.push({ stepId: step.id, status: "skipped", reason: "an earlier step failed" });
      continue;
    }
    // A caller-omitted optional step never produces a result any step reads (the contract forbids
    // it), so it releases its ordering dependents rather than blocking them.
    const blockedBy = step.dependsOn.find((dependency) => {
      const status = state.get(dependency);
      return status !== "completed" && status !== "omitted";
    });
    if (blockedBy) {
      state.set(step.id, "skipped");
      outcomes.push({
        stepId: step.id,
        status: "skipped",
        reason: `dependency '${blockedBy}' did not complete`,
      });
      continue;
    }
    if (step.optional !== undefined && inputs[step.optional.input] === false) {
      state.set(step.id, "omitted");
      outcomes.push({ stepId: step.id, status: "omitted", input: step.optional.input });
      continue;
    }

    const adapter = executionOptions.adapters.resolve(step);
    if (!adapter) {
      const reason = `no adapter for runtime '${step.callable.runtime}'`;
      executionOptions.onUnavailable?.(step, reason);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: reason });
      if (step.failurePolicy.onError === "abort") aborted = true;
      continue;
    }

    let args: Record<string, WorkflowJsonValue>;
    try {
      args = {};
      for (const argument of step.arguments) {
        args[argument.name] = await resolveArgument(
          step,
          argument.name,
          argument.source,
          step.origin === "derivation" ? derivationOptions : executionOptions,
          results,
          declaredPrivateReferences,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: message });
      if (step.failurePolicy.onError === "abort") aborted = true;
      continue;
    }

    try {
      const result = await adapter.call({
        step,
        arguments: args,
        ...(options.resolvePrivate ? { resolvePrivate: options.resolvePrivate } : {}),
        ...(options.access ? { access: options.access } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.applyDisplayFilters === true ? { applyDisplayFilter: true } : {}),
      });
      results.set(step.id, result);
      state.set(step.id, "completed");
      outcomes.push({ stepId: step.id, status: "completed", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: message });
      if (step.failurePolicy.onError === "abort") aborted = true;
    }
  }

  const failure = outcomes.find((outcome) => outcome.status === "failed");
  const lastCompleted = [...outcomes].reverse().find((outcome) => outcome.status === "completed");
  // A run of independent steps returns every output it produced, in recorded order; a chain, the
  // result its last step produced.
  const sinks = workflowSinkStepIds(workflow);
  const outcomeOf = new Map(outcomes.map((outcome) => [outcome.stepId, outcome]));
  const result =
    sinks.length > 1
      ? sinks.map((stepId) => {
          const outcome = outcomeOf.get(stepId);
          return outcome?.status === "completed" ? outcome.result : null;
        })
      : lastCompleted?.status === "completed"
        ? lastCompleted.result
        : undefined;
  return {
    status: failure ? "failed" : "completed",
    steps: outcomes,
    result,
    ...(failure?.status === "failed" ? { error: failure.error } : {}),
  };
}

/**
 * The input schema of a recorded workflow. An input with a default, or one that defaults to the
 * recorded token, is optional; every other input is required.
 */
export function recordedWorkflowInputSchema(workflow: RecordedWorkflow): Record<string, unknown> {
  const JSON_SCHEMA_TYPES: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    object: "object",
    array: "array",
  };
  const properties: Record<string, unknown> = {};
  for (const input of workflow.inputs) {
    const recordedDefault = input.recordedDefault ? "Omit to use the recorded value." : undefined;
    const described = input.description ?? recordedDefault;
    const list = input.list;
    const description =
      list === undefined
        ? described
        : [
            "A list of words: each item is passed to the command as one separate argument.",
            described,
          ]
            .filter((part) => part !== undefined)
            .join(" ");
    properties[input.name] = {
      type: JSON_SCHEMA_TYPES[input.type] ?? "string",
      ...(list === undefined
        ? {}
        : {
            items: {
              type: "string",
              minLength: 1,
              // An option-like item is refused unless the recording passed one here.
              ...(list.optionItems === true ? {} : { pattern: "^[^-]" }),
            },
            minItems: list.minItems,
          }),
      ...(description ? { description } : {}),
      ...(Object.hasOwn(input, "default") ? { default: input.default } : {}),
    };
  }
  return {
    type: "object",
    properties,
    required: workflow.inputs
      .filter((input) => !Object.hasOwn(input, "default") && input.recordedDefault !== true)
      .map((input) => input.name),
    additionalProperties: false,
  };
}
