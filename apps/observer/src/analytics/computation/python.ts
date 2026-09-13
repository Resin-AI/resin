import { parser as pythonParser } from "@lezer/python";
import {
  COMPUTATION_IR_LIMITS,
  type ComputationConstant,
  type ComputationOutputShape,
  type ComputationUnsupportedReason,
  isSafeComputationFieldKey,
} from "@resin/contracts";
import { buildComputationProgramWithKeyMap, draftField, draftNode } from "./builder.js";
import {
  type PythonApiName,
  isPythonNamespaceMutatorName,
  isPythonReadOnlyOpenMode,
  isPythonReflectionName,
  parsePythonImportText,
  pythonBuiltinApi,
  pythonConstructorApi,
  pythonFileHandleApi,
  pythonMethodApi,
  pythonModuleApi,
} from "./python-api.js";
import { draftSlot, draftSymbol } from "./types.js";
import type {
  ComputationParseContext,
  ComputationParseResult,
  DraftNode,
  DraftSymbol,
  LocalComputationModule,
} from "./types.js";

/**
 * Python computation parser.
 *
 * A native Python source frame is read with the `@lezer/python` syntax tree (pure JS, no child
 * process, and no execution of anything) and turned into two things:
 *
 *  - a strict, privacy-safe `ComputationProgramV1` built exclusively through the shared draft
 *    builder (this module never assigns a canonical wire id), and
 *  - private local bookkeeping (`ComputationParseResult.local`) holding the source text, the raw
 *    names and the definition provenance the wire program deliberately does not carry.
 *
 * The analysis is real def/use analysis over the parsed tree: module/function/lambda scopes, ordered
 * parameters with defaults, stable symbols across one lexical binding (so an accumulator update is
 * not a new variable), destructuring targets materialized one binding each, comprehension shadowing,
 * inline lambda callbacks whose reads belong to the enclosing definition's closure, direct and mutual
 * recursion, and a statically selected closure of the observed definitions this frame actually uses
 * (transitive and cycle-safe).
 *
 * Everything else fails closed with an `unsupported` node and an explicit reason rather than a
 * guess: an unresolved callable, an unknown method, a dynamic key, reflection, a construct with no
 * IR shape, or an exceeded pinned limit. No raw name, module path, literal value or source offset
 * ever reaches the program, and nothing here reads the filesystem or spawns a process.
 */

// ============================================================================
// Syntax tree access
// ============================================================================

/**
 * Structural view of the Lezer syntax tree, declared locally so this module depends only on
 * `@lezer/python` (the declared dependency) rather than on its transitive type packages.
 * `@lezer/common`'s `SyntaxNode` satisfies it exactly.
 */
interface PyNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: PyNode | null;
  readonly nextSibling: PyNode | null;
  readonly type: { readonly isError: boolean };
}

interface PyTree {
  readonly topNode: PyNode;
}

/** Tokens the tree carries that are structure, never a statement or an expression. */
const PY_STRUCTURAL_TOKENS: Readonly<Record<string, true>> = {
  "(": true,
  ")": true,
  "[": true,
  "]": true,
  "{": true,
  "}": true,
  ",": true,
  ";": true,
  blankLine: true,
  blankLineStart: true,
  dedent: true,
  eof: true,
  indent: true,
  newline: true,
};

const PY_EXPRESSION_NAMES: Readonly<Record<string, true>> = {
  ArrayComprehensionExpression: true,
  ArrayExpression: true,
  AwaitExpression: true,
  BinaryExpression: true,
  Boolean: true,
  CallExpression: true,
  ComprehensionExpression: true,
  ConditionalExpression: true,
  DictionaryComprehensionExpression: true,
  DictionaryExpression: true,
  FormatString: true,
  LambdaExpression: true,
  MemberExpression: true,
  NamedExpression: true,
  None: true,
  Number: true,
  ParenthesizedExpression: true,
  SetComprehensionExpression: true,
  SetExpression: true,
  String: true,
  TupleExpression: true,
  UnaryExpression: true,
  VariableName: true,
  YieldExpression: true,
};

function pyChildren(node: PyNode): PyNode[] {
  const children: PyNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

function pyChild(node: PyNode, name: string): PyNode | undefined {
  for (const child of pyChildren(node)) {
    if (child.name === name) {
      return child;
    }
  }
  return undefined;
}

/** Children that can carry meaning, with structural punctuation and comments removed. */
function pyContentChildren(node: PyNode): PyNode[] {
  return pyChildren(node).filter(
    (child) => PY_STRUCTURAL_TOKENS[child.name] !== true && child.name !== "Comment",
  );
}

function pyConstant(constant: ComputationConstant): DraftNode {
  return draftNode("literal", [], { constant });
}

const PYTHON_TYPE_CONSTANTS: Readonly<Record<string, ComputationConstant>> = {
  str: "python_type_str",
  int: "python_type_int",
  float: "python_type_float",
  bool: "python_type_bool",
  list: "python_type_list",
  tuple: "python_type_tuple",
  dict: "python_type_dict",
  set: "python_type_set",
  object: "python_type_object",
};

/**
 * Append to a draft node's children after the node exists.
 *
 * A definition's binding has to create the function node first (its own symbol declares it), and a
 * parameter's default is only known once the parameter list has been walked, so those two places
 * append to an already-created node. The builder plans drafts after the visitor returns, so the
 * final `children` array is what it sees.
 */
function appendChildren(node: DraftNode, children: readonly DraftNode[]): void {
  (node.children as DraftNode[]).push(...children);
}

// ============================================================================
// Internal draft bookkeeping
// ============================================================================

type PyDefinitionKind = "async_function" | "function" | "generator_function" | "method";

type PySlotKind =
  | "array"
  | "boolean"
  | "bytes"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "unknown";

type PySlotRole = "dynamic" | "field_key" | "free_variable" | "literal" | "path";

interface PyScope {
  readonly key: string;
  readonly parent: PyScope | null;
  readonly kind: "function" | "lambda" | "module";
  /** Non-callable bindings introduced in this scope. */
  readonly locals: Map<string, DraftSymbol>;
  /** Callable bindings (`def` statements) introduced in this scope. */
  readonly defs: Map<string, PendingDefinition>;
  /** Nearest enclosing `def`; reads inside it become that definition's direct dependencies. */
  readonly owner: PendingDefinition | null;
}

/**
 * A definition under construction. Drafts are structurally typed, so the dependency list (only known
 * once the body exists) is filled in during body emission — which is what makes direct and mutual
 * recursion representable without a second canonicalisation pass.
 */
interface PendingDefinition {
  readonly key: string;
  readonly name: string;
  readonly nameSymbol: DraftSymbol;
  readonly body: DraftNode;
  readonly scope: string;
  readonly parameters: DraftSymbol[];
  readonly dependencies: DraftSymbol[];
  readonly dependencySet: Set<DraftSymbol>;
  readonly unsupportedReasons: ComputationUnsupportedReason[];
  readonly origin: "authored" | "helper";
  readonly sourceEventId?: string;
  readonly programDigest?: string;
  /** The scope the pre-scan built for this definition's parameters and locals. */
  scopeRef?: PyScope;
  kind: PyDefinitionKind;
  complete: boolean;
}

interface PyOutput {
  readonly node: DraftNode;
  readonly shape: ComputationOutputShape;
  readonly definitionKey?: string;
}

interface PyImportBinding {
  readonly module: string;
  /** `module` keeps the name a module alias; `member` resolves it to one module member. */
  readonly kind: "member" | "module";
  readonly member?: string;
}

interface PyDefinitionReport {
  readonly name: string;
  readonly source: string;
  readonly references: string[];
  readonly writtenNames: string[];
}

interface PyRootEntry {
  readonly node: DraftNode;
  /** A helper definition body, kept only when that definition is dependency-reachable. */
  readonly definition?: PendingDefinition;
}

/** Raised when a pinned hard limit is exceeded; the frame then fails closed as one bounded program. */
class PythonBudgetExceeded extends Error {
  readonly reason: ComputationUnsupportedReason;

  constructor(reason: ComputationUnsupportedReason) {
    super(reason);
    this.reason = reason;
  }
}

/** The recorder's per-frame guard; a larger frame is never parsed, it fails closed instead. */
const MAX_SOURCE_LENGTH = 262144;

/**
 * Runaway guards only: the builder owns the pinned node/symbol/slot/definition limits and degrades
 * or rejects on them. These ceilings exist so a pathological frame cannot make the visitor allocate
 * without bound, and they sit above the pinned limits so a program the builder would accept is never
 * discarded here.
 */
const NODE_RUNWAY = COMPUTATION_IR_LIMITS.nodes * 4;
const SYMBOL_RUNWAY = COMPUTATION_IR_LIMITS.symbols * 4;
const SLOT_RUNWAY = COMPUTATION_IR_LIMITS.slots * 4;
const DEFINITION_RUNWAY = COMPUTATION_IR_LIMITS.definitions * 4;

// ============================================================================
// Frame analyzer
// ============================================================================

class PythonFrameAnalyzer {
  private readonly context: ComputationParseContext | undefined;
  private readonly moduleScope: PyScope;
  private source: string;
  private tree: PyTree;
  /** 0 while the authored frame is emitted; raised for each materialized helper frame. */
  private frameId = 0;
  private scopeSequence = 0;
  private depth = 0;
  private nodeBudget = NODE_RUNWAY;
  private symbolBudget = SYMBOL_RUNWAY;
  private slotBudget = SLOT_RUNWAY;
  private definitionBudget = DEFINITION_RUNWAY;
  private readonly slotKeys = new Set<string>();

  private readonly roots: DraftNode[] = [];
  private readonly helperRoots: PyRootEntry[] = [];
  private readonly definitions: PendingDefinition[] = [];
  private readonly pendingBySymbol = new Map<DraftSymbol, PendingDefinition>();
  private readonly helperBodyByNode = new Map<DraftNode, PendingDefinition>();
  private readonly definitionByNode = new Map<number, PendingDefinition>();
  private readonly helperDefinitions = new Map<string, PendingDefinition>();
  private readonly helperTargetStack: { name: string; definition: PendingDefinition }[] = [];
  private readonly importBindings = new Map<string, PyImportBinding>();
  private readonly shadowFrames: Map<string, DraftSymbol>[] = [];
  private readonly definitionStack: PendingDefinition[] = [];
  private readonly authoredReads = new Set<DraftSymbol>();
  private readonly fileHandles = new Set<DraftSymbol>();
  private readonly localDefinitions: PyDefinitionReport[] = [];
  private readonly localImports: { names: string[]; source: string }[] = [];
  private readonly referencedNames: string[] = [];
  private readonly referencedNameSet = new Set<string>();
  private readonly writtenNames: string[] = [];
  private readonly writtenNameSet = new Set<string>();
  private readonly outputs: PyOutput[] = [];

  private hasInvocation = false;
  private invalidatesState = false;

  constructor(source: string, context: ComputationParseContext | undefined) {
    this.source = source;
    this.context = context;
    this.tree = { topNode: (pythonParser.parse(source) as unknown as PyTree).topNode };
    this.moduleScope = {
      defs: new Map(),
      key: "scope0",
      kind: "module",
      locals: new Map(),
      owner: null,
      parent: null,
    };
  }

  // --------------------------------------------------------------------------
  // Budgets and node construction
  // --------------------------------------------------------------------------

  private node(
    kind: DraftNode["kind"],
    children: readonly DraftNode[] = [],
    fields?: Record<string, unknown>,
  ): DraftNode {
    this.nodeBudget -= 1;
    if (this.nodeBudget < 0) {
      throw new PythonBudgetExceeded("limit_nodes");
    }
    return draftNode(kind, [...children], fields);
  }

  private symbol(
    key: string,
    kind: "definition" | "external" | "import" | "local" | "parameter",
    scope: string,
    declaration?: DraftNode,
  ): DraftSymbol {
    this.symbolBudget -= 1;
    if (this.symbolBudget < 0) {
      throw new PythonBudgetExceeded("limit_symbols");
    }
    return draftSymbol(key, kind, scope, declaration);
  }

  private literal(key: string, kind: PySlotKind, role: PySlotRole): DraftNode {
    if (!this.slotKeys.has(key)) {
      this.slotKeys.add(key);
      this.slotBudget -= 1;
      if (this.slotBudget < 0) {
        throw new PythonBudgetExceeded("limit_slots");
      }
    }
    return this.node("literal", [], { slot: draftSlot(key, kind, role) });
  }

  /** Every reduction is explicit: an `unsupported` node plus the reason on it and on its definition. */
  private unsupported(
    reason: ComputationUnsupportedReason,
    children: readonly DraftNode[] = [],
  ): DraftNode {
    const owner = this.definitionStack[this.definitionStack.length - 1];
    if (owner !== undefined) {
      owner.complete = false;
      if (!owner.unsupportedReasons.includes(reason) && owner.unsupportedReasons.length < 8) {
        owner.unsupportedReasons.push(reason);
      }
    }
    return this.node("unsupported", children, { unsupportedReason: reason });
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > COMPUTATION_IR_LIMITS.nesting) {
      throw new PythonBudgetExceeded("limit_depth");
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private text(node: PyNode): string {
    return this.source.slice(node.from, node.to);
  }

  private nextScopeKey(): string {
    this.scopeSequence += 1;
    return `sc${this.scopeSequence}`;
  }

  // --------------------------------------------------------------------------
  // Entry point
  // --------------------------------------------------------------------------

  analyze(): ComputationParseResult {
    if (this.hasErrorNode(this.tree.topNode, 0)) {
      return this.failClosedProgram("incomplete_parse");
    }
    this.collectContextImports();
    this.collectAuthoredReports();
    this.preScanContainer(this.tree.topNode, this.moduleScope);
    this.hasInvocation = this.detectInvocation();
    this.detectStateMutation();
    this.emitStatementsInto(this.tree.topNode, this.moduleScope, this.roots);
    const kept = this.selectDefinitions();
    const roots = [
      ...this.roots,
      ...this.helperRoots
        .filter((entry) => entry.definition === undefined || kept.has(entry.definition))
        .map((entry) => entry.node),
    ];
    const definitions = this.definitions.filter(
      (definition) => definition.origin === "authored" || kept.has(definition),
    );
    // An empty frame is a valid, empty program: it has no transform and no output, so it is simply
    // never substantive. The wire shape needs one root, hence the empty block.
    const built = this.buildProgram(
      roots.length === 0 ? [this.node("block", [])] : roots,
      definitions,
    );
    return {
      local: {
        definitionBindings: this.buildDefinitionBindings(built.definitionKeys),
        definitions: this.localDefinitions,
        hasInvocation: this.hasInvocation,
        imports: this.localImports,
        invalidatesState: this.invalidatesState,
        referencedNames: this.referencedNames,
        writtenNames: this.writtenNames,
      },
      program: built.program,
    };
  }

  /**
   * Hand the drafts to the builder, which owns ids, scope numbering, the materialized def/use
   * closure and the reason list: an explicit reason is passed only when the visitor itself reduced
   * the whole frame, and every other reduction is derived from the emitted `unsupported` nodes and
   * incomplete definitions.
   */
  private buildProgram(
    roots: readonly DraftNode[],
    definitions: readonly PendingDefinition[],
    unsupportedReasons: readonly ComputationUnsupportedReason[] = [],
  ): { program: ComputationParseResult["program"]; definitionKeys: readonly string[] } {
    const built = buildComputationProgramWithKeyMap({
      definitions: definitions.map((definition) => ({
        body: definition.body,
        complete: definition.complete,
        dependencies: definition.dependencies,
        key: definition.key,
        kind: definition.kind,
        nameSymbol: definition.nameSymbol,
        parameters: definition.parameters,
        scope: definition.scope,
        unsupportedReasons: definition.unsupportedReasons,
      })),
      language: "python",
      outputs: this.selectOutputs(definitions.length),
      roots: [...roots],
      unsupportedReasons: [...unsupportedReasons],
    });
    return { definitionKeys: built.definitionKeys, program: built.program };
  }

  /** Fail closed as one bounded program: never a partial prefix presented as complete. */
  failClosedProgram(reason: ComputationUnsupportedReason): ComputationParseResult {
    const built = this.buildProgram(
      [this.node("unsupported", [], { unsupportedReason: reason })],
      [],
      [reason],
    );
    return {
      local: {
        definitionBindings: [],
        definitions: [],
        hasInvocation: false,
        imports: [],
        invalidatesState: true,
        referencedNames: [],
        writtenNames: [],
      },
      program: built.program,
    };
  }

  private buildDefinitionBindings(definitionKeys: readonly string[]): {
    definitionId: string;
    name: string;
    sourceEventId?: string;
    programDigest?: string;
  }[] {
    const byKey = new Map<string, PendingDefinition>();
    for (const definition of this.definitions) {
      byKey.set(definition.key, definition);
    }
    const bindings: {
      definitionId: string;
      name: string;
      sourceEventId?: string;
      programDigest?: string;
    }[] = [];
    definitionKeys.forEach((key, index) => {
      const definition = byKey.get(key);
      if (definition === undefined) {
        return;
      }
      const binding: {
        definitionId: string;
        name: string;
        sourceEventId?: string;
        programDigest?: string;
      } = { definitionId: `def${index}`, name: definition.name };
      if (definition.sourceEventId !== undefined) {
        binding.sourceEventId = definition.sourceEventId;
      }
      if (definition.programDigest !== undefined) {
        binding.programDigest = definition.programDigest;
      }
      bindings.push(binding);
    });
    return bindings;
  }

  /**
   * Output records are a bounded summary (at most `definitions + 1`): the authored frame's emitted
   * value first, then one return per definition. Selecting fewer records never changes structure.
   */
  private selectOutputs(definitionCount: number): readonly PyOutput[] {
    const limit = definitionCount + 1;
    const moduleLevel = this.outputs.filter((output) => output.definitionKey === undefined);
    const perDefinition = new Map<string, PyOutput>();
    for (const output of this.outputs) {
      if (output.definitionKey !== undefined && !perDefinition.has(output.definitionKey)) {
        perDefinition.set(output.definitionKey, output);
      }
    }
    const selected: PyOutput[] = [];
    const seen = new Set<DraftNode>();
    for (const output of [...moduleLevel.slice(0, 1), ...perDefinition.values()]) {
      if (selected.length >= limit || seen.has(output.node)) {
        continue;
      }
      seen.add(output.node);
      selected.push(output);
    }
    return selected;
  }

  /**
   * Materialize only the closure this frame reaches: authored definitions plus the transitively read
   * observed helpers. An unused cached helper never joins the program, so it can neither inflate the
   * evidence nor make an unrelated invocation look substantive.
   */
  private selectDefinitions(): Set<PendingDefinition> {
    const kept = new Set<PendingDefinition>();
    const pending: PendingDefinition[] = [];
    for (const definition of this.definitions) {
      if (definition.origin === "authored") {
        kept.add(definition);
      }
    }
    for (const symbol of this.authoredReads) {
      const definition = this.pendingBySymbol.get(symbol);
      if (definition !== undefined) {
        pending.push(definition);
      }
    }
    while (pending.length > 0) {
      const definition = pending.pop() as PendingDefinition;
      if (kept.has(definition)) {
        continue;
      }
      kept.add(definition);
      for (const dependency of definition.dependencies) {
        const next = this.pendingBySymbol.get(dependency);
        if (next !== undefined) {
          pending.push(next);
        }
      }
    }
    return kept;
  }

  private hasErrorNode(node: PyNode, depth: number): boolean {
    if (node.type.isError) {
      return true;
    }
    if (depth > COMPUTATION_IR_LIMITS.nesting * 4) {
      return true;
    }
    for (const child of pyChildren(node)) {
      if (this.hasErrorNode(child, depth + 1)) {
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Private local bookkeeping
  // --------------------------------------------------------------------------

  private collectContextImports(): void {
    for (const entry of this.context?.imports ?? []) {
      const parsed = parsePythonImportText(entry.source);
      if (parsed === undefined) {
        continue;
      }
      for (const name of entry.names) {
        if (parsed.kind === "member") {
          this.importBindings.set(name, {
            kind: "member",
            member: parsed.members[name] ?? name,
            module: parsed.module,
          });
          continue;
        }
        const module = parsed.members[name] ?? parsed.module;
        this.importBindings.set(name, { kind: "module", member: module, module });
      }
    }
  }

  private collectAuthoredReports(): void {
    for (const statement of pyChildren(this.tree.topNode)) {
      if (statement.name !== "FunctionDefinition") {
        continue;
      }
      const nameNode = pyChild(statement, "VariableName");
      const params = pyChild(statement, "ParamList");
      const body = pyChild(statement, "Body");
      if (nameNode === undefined || params === undefined || body === undefined) {
        continue;
      }
      const bound = new Set<string>();
      for (const child of pyChildren(params)) {
        if (child.name === "VariableName") {
          bound.add(this.text(child));
        }
      }
      const references = new Set<string>();
      const written = new Set<string>();
      this.collectFreeNames(body, bound, references, written);
      this.localDefinitions.push({
        name: this.text(nameNode),
        references: [...references],
        source: this.text(statement),
        writtenNames: [...written],
      });
    }
  }

  /**
   * Names a definition reads that it does not bind itself, and names it binds. Both stay local: the
   * recorder uses them to resolve a definition it later observes through the private caches.
   */
  private collectFreeNames(
    node: PyNode,
    bound: Set<string>,
    references: Set<string>,
    written: Set<string>,
  ): void {
    for (const child of pyChildren(node)) {
      if (child.name === "FunctionDefinition" || child.name === "LambdaExpression") {
        continue;
      }
      if (child.name === "VariableName") {
        const name = this.text(child);
        if (!bound.has(name)) {
          references.add(name);
        }
        continue;
      }
      if (child.name === "AssignStatement" || child.name === "UpdateStatement") {
        for (const target of this.assignmentTargetsOf(child)) {
          for (const name of this.namesInTarget(target)) {
            written.add(name);
            bound.add(name);
          }
        }
      }
      this.collectFreeNames(child, bound, references, written);
    }
  }

  private namesInTarget(node: PyNode, into: Set<string> = new Set<string>()): Set<string> {
    if (node.name === "VariableName") {
      into.add(this.text(node));
      return into;
    }
    if (node.name === "TupleExpression" || node.name === "ArrayExpression") {
      for (const child of pyContentChildren(node)) {
        this.namesInTarget(child, into);
      }
    }
    return into;
  }

  private assignmentTargetsOf(statement: PyNode): PyNode[] {
    const children = pyChildren(statement);
    const equalsIndices: number[] = [];
    children.forEach((child, index) => {
      if (child.name === "AssignOp") {
        equalsIndices.push(index);
      }
    });
    if (equalsIndices.length === 0) {
      return [];
    }
    const targets: PyNode[] = [];
    let start = 0;
    for (const index of equalsIndices) {
      for (const child of children.slice(start, index)) {
        if (child.name !== "TypeDef" && child.name !== ":") {
          targets.push(child);
        }
      }
      start = index + 1;
    }
    return targets;
  }

  // --------------------------------------------------------------------------
  // Binding pre-scan
  // --------------------------------------------------------------------------

  private registerBinding(name: string, node: PyNode, scope: PyScope, callable: boolean): void {
    if (callable) {
      this.registerDefinition(name, node, node, scope);
      return;
    }
    if (scope.locals.has(name)) {
      return;
    }
    const target = this.node("identifier", []);
    const symbol = this.symbol(`local:${scope.key}:${name}`, "local", scope.key, target);
    (target.fields as Record<string, unknown>).symbol = symbol;
    scope.locals.set(name, symbol);
    if (scope.kind === "module" && this.frameId === 0 && !this.writtenNameSet.has(name)) {
      this.writtenNameSet.add(name);
      this.writtenNames.push(name);
    }
  }

  private registerDefinition(
    name: string,
    nameNode: PyNode,
    statement: PyNode,
    scope: PyScope,
  ): void {
    const target = this.helperTargetStack[this.helperTargetStack.length - 1];
    if (target !== undefined && target.name === name && scope.kind === "module") {
      // A materialized helper frame reuses the placeholder definition created for the caches, so its
      // symbol stays the one the call sites already reference.
      scope.defs.set(name, target.definition);
      this.definitionByNode.set(statement.from, target.definition);
      return;
    }
    if (scope.defs.has(name)) {
      // Rebinding one callable name is a redefinition: the earlier version is superseded, so the
      // recorder must treat previously cached bindings as invalidated.
      this.invalidatesState = true;
      return;
    }
    const key = `def:${statement.from}:${name}`;
    const scopeKey = this.nextScopeKey();
    const functionNode = this.node("function", [], {});
    const nameSymbol = this.symbol(key, "definition", scope.key, functionNode);
    (functionNode.fields as Record<string, unknown>).scope = scopeKey;
    (functionNode.fields as Record<string, unknown>).symbol = nameSymbol;
    const definition: PendingDefinition = {
      body: functionNode,
      complete: true,
      dependencies: [],
      dependencySet: new Set(),
      key,
      kind: "function",
      name,
      nameSymbol,
      origin: this.frameId === 0 ? "authored" : "helper",
      parameters: [],
      programDigest: undefined,
      scope: scopeKey,
      sourceEventId: undefined,
      unsupportedReasons: [],
    };
    scope.defs.set(name, definition);
    this.definitions.push(definition);
    this.pendingBySymbol.set(nameSymbol, definition);
    this.definitionByNode.set(statement.from, definition);
    if (definition.origin === "helper") {
      this.helperBodyByNode.set(functionNode, definition);
    }
    this.definitionBudget -= 1;
    if (this.definitionBudget < 0) {
      throw new PythonBudgetExceeded("limit_definition");
    }
    if (scope.kind === "module" && this.frameId === 0 && !this.writtenNameSet.has(name)) {
      this.writtenNameSet.add(name);
      this.writtenNames.push(name);
    }
  }

  private recordTargets(node: PyNode, scope: PyScope): void {
    if (node.name === "VariableName") {
      this.registerBinding(this.text(node), node, scope, false);
      return;
    }
    if (
      node.name === "TupleExpression" ||
      node.name === "ArrayExpression" ||
      node.name === "ParenthesizedExpression" ||
      node.name === "SetExpression"
    ) {
      for (const child of pyContentChildren(node)) {
        this.recordTargets(child, scope);
      }
    }
  }

  private preScanContainer(container: PyNode, scope: PyScope): void {
    if (container.name === "Body") {
      for (const statement of this.bodyStatements(container)) {
        this.preScanStatement(statement, scope);
      }
      return;
    }
    for (const statement of pyChildren(container)) {
      if (PY_STRUCTURAL_TOKENS[statement.name] === true || statement.name === "Comment") {
        continue;
      }
      this.preScanStatement(statement, scope);
    }
  }

  /**
   * Register the bindings one statement introduces in `scope`, then descend into every body it owns.
   *
   * This pass exists so a name read before its textual binding (a helper called above its `def`, a
   * loop variable used after the loop) still resolves to one stable symbol instead of becoming an
   * unexplained external input.
   */
  private preScanStatement(statement: PyNode, scope: PyScope): void {
    if (statement.name === "FunctionDefinition") {
      const nameNode = pyChild(statement, "VariableName");
      if (nameNode !== undefined) {
        this.registerDefinition(this.text(nameNode), nameNode, statement, scope);
      }
      const definition = this.definitionByNode.get(statement.from);
      const body = pyChild(statement, "Body");
      if (definition === undefined || body === undefined) {
        return;
      }
      const innerScope: PyScope = {
        defs: new Map(),
        key: definition.scope,
        kind: "function",
        locals: new Map(),
        owner: definition,
        parent: scope,
      };
      definition.scopeRef = innerScope;
      const params = pyChild(statement, "ParamList");
      if (params !== undefined) {
        this.registerParameters(params, innerScope);
      }
      this.preScanContainer(body, innerScope);
      definition.kind = this.definitionKindOf(statement, body);
      return;
    }
    switch (statement.name) {
      case "AssignStatement": {
        for (const target of this.assignmentTargetsOf(statement)) {
          this.recordTargets(target, scope);
        }
        break;
      }
      case "UpdateStatement": {
        const children = pyChildren(statement);
        const operatorIndex = children.findIndex((child) => child.name === "UpdateOp");
        for (const child of children.slice(0, operatorIndex < 0 ? 0 : operatorIndex)) {
          this.recordTargets(child, scope);
        }
        break;
      }
      case "ForStatement": {
        const children = pyChildren(statement);
        const inIndex = children.findIndex((child) => child.name === "in");
        for (const child of children.slice(0, inIndex < 0 ? 0 : inIndex)) {
          if (child.name !== "for" && child.name !== "async" && child.name !== ",") {
            this.recordTargets(child, scope);
          }
        }
        break;
      }
      case "WithStatement":
      case "TryStatement": {
        const children = pyChildren(statement);
        for (let index = 0; index < children.length; index += 1) {
          const target = children[index + 1];
          if (children[index].name === "as" && target?.name === "VariableName") {
            this.registerBinding(this.text(target), target, scope, false);
          }
        }
        break;
      }
      default:
        break;
    }
    for (const child of pyChildren(statement)) {
      if (child.name === "Body") {
        this.preScanContainer(child, scope);
      }
    }
  }

  private registerParameters(params: PyNode, scope: PyScope): void {
    for (const child of pyChildren(params)) {
      if (child.name !== "VariableName") {
        continue;
      }
      const name = this.text(child);
      if (scope.locals.has(name)) {
        continue;
      }
      const parameter = this.node("parameter", []);
      const symbol = this.symbol(`param:${scope.key}:${name}`, "parameter", scope.key, parameter);
      (parameter.fields as Record<string, unknown>).symbol = symbol;
      scope.locals.set(name, symbol);
    }
  }

  // --------------------------------------------------------------------------
  // Frame-level detection
  // --------------------------------------------------------------------------

  private detectInvocation(): boolean {
    for (const statement of pyChildren(this.tree.topNode)) {
      if (this.statementExecutesCall(statement)) {
        return true;
      }
    }
    return false;
  }

  /**
   * A top-level call is an invocation when it runs as the frame's own code. A `def` body only
   * authors a callable; assignment calls still execute, but their assigned value is not observable
   * output by itself.
   */
  private statementExecutesCall(statement: PyNode): boolean {
    switch (statement.name) {
      case "ImportStatement":
        return false;
      default:
        return this.containsCall(statement);
    }
  }

  private containsCall(node: PyNode): boolean {
    if (node.name === "FunctionDefinition" || node.name === "LambdaExpression") {
      return false;
    }
    if (node.name === "CallExpression") {
      return true;
    }
    for (const child of pyChildren(node)) {
      if (this.containsCall(child)) {
        return true;
      }
    }
    return false;
  }

  private detectStateMutation(): void {
    const visit = (node: PyNode): void => {
      if (node.name === "DeleteStatement" || node.name === "ScopeStatement") {
        this.invalidatesState = true;
      }
      if (node.name === "CallExpression") {
        const callee = pyChildren(node)[0];
        if (callee?.name === "VariableName" && isPythonNamespaceMutatorName(this.text(callee))) {
          this.invalidatesState = true;
        }
      }
      for (const child of pyChildren(node)) {
        visit(child);
      }
    };
    visit(this.tree.topNode);
  }

  // --------------------------------------------------------------------------
  // Statements
  // --------------------------------------------------------------------------

  private bodyStatements(body: PyNode): PyNode[] {
    const statements: PyNode[] = [];
    const collect = (node: PyNode): void => {
      for (const child of pyChildren(node)) {
        if (child.name === "StatementGroup") {
          collect(child);
          continue;
        }
        if (
          PY_STRUCTURAL_TOKENS[child.name] === true ||
          child.name === ":" ||
          child.name === "Comment"
        ) {
          continue;
        }
        statements.push(child);
      }
    };
    collect(body);
    return statements;
  }

  private emitStatementsInto(container: PyNode, scope: PyScope, into: DraftNode[]): void {
    const statements =
      container.name === "Body" ? this.bodyStatements(container) : pyChildren(container);
    for (const statement of statements) {
      if (PY_STRUCTURAL_TOKENS[statement.name] === true || statement.name === "Comment") {
        continue;
      }
      const emitted = this.emitStatement(statement, scope);
      if (emitted !== null) {
        into.push(emitted);
      }
    }
  }

  /** A single-statement body is that statement; anything longer is an ordered block. */
  private emitBody(body: PyNode | undefined, scope: PyScope): DraftNode {
    if (body === undefined) {
      return this.node("block", []);
    }
    const emitted: DraftNode[] = [];
    for (const statement of this.bodyStatements(body)) {
      const node = this.emitStatement(statement, scope);
      if (node !== null) {
        emitted.push(node);
      }
    }
    return emitted.length === 1 ? emitted[0] : this.node("block", emitted);
  }

  private emitStatement(statement: PyNode, scope: PyScope): DraftNode | null {
    this.enter();
    try {
      switch (statement.name) {
        case "FunctionDefinition":
          return this.emitFunctionDefinition(statement, scope);
        case "StatementGroup":
          return null;
        case "AssignStatement":
          return this.emitAssignment(statement, scope);
        case "UpdateStatement":
          return this.emitUpdate(statement, scope);
        case "ExpressionStatement":
          return this.emitExpressionStatement(statement, scope);
        case "ReturnStatement":
          return this.emitReturn(statement, scope);
        case "PassStatement":
          return null;
        case "ImportStatement":
          this.recordImport(statement);
          return null;
        case "IfStatement":
          return this.emitIf(statement, scope);
        case "WhileStatement":
          return this.emitWhile(statement, scope);
        case "ForStatement":
          return this.emitFor(statement, scope);
        case "TryStatement":
          return this.emitTry(statement, scope);
        case "WithStatement":
          return this.emitWith(statement, scope);
        case "AssertStatement": {
          const values = pyChildren(statement)
            .filter((child) => PY_EXPRESSION_NAMES[child.name] === true)
            .map((child) => this.emitExpression(child, scope));
          return this.node("assert", values.slice(0, 2));
        }
        case "RaiseStatement": {
          const values = pyChildren(statement)
            .filter((child) => PY_EXPRESSION_NAMES[child.name] === true)
            .map((child) => this.emitExpression(child, scope));
          if (values.length !== 1) {
            return this.unsupported("unsupported_construct", values);
          }
          return this.node("throw", values);
        }
        case "BreakStatement":
          return this.node("break");
        case "ContinueStatement":
          return this.node("continue");
        case "YieldStatement": {
          const yielded = pyChild(statement, "YieldExpression");
          if (yielded === undefined) {
            return this.node("yield", []);
          }
          const value = this.emitExpression(yielded, scope);
          const yieldNode = this.node("yield", [value]);
          if (scope.owner !== null) {
            this.outputs.push({
              definitionKey: scope.owner.key,
              node: yieldNode,
              shape: this.shapeOf(value),
            });
          }
          return yieldNode;
        }
        case "DeleteStatement":
          this.invalidatesState = true;
          return this.unsupported("unsupported_hidden_state");
        case "ScopeStatement":
          this.invalidatesState = true;
          return this.unsupported("unsupported_mutable_capture");
        case "ClassDefinition":
        case "DecoratedStatement":
        case "MatchStatement":
        case "TypeDefinition":
          return this.unsupported("unsupported_construct");
        case "PrintStatement":
          return this.unsupported("unsupported_language");
        default:
          return this.unsupported("unsupported_construct");
      }
    } finally {
      this.leave();
    }
  }

  private definitionKindOf(statement: PyNode, body: PyNode | undefined): PyDefinitionKind {
    if (pyChildren(statement).some((child) => child.name === "async")) {
      return "async_function";
    }
    if (body !== undefined && this.containsYield(body)) {
      return "generator_function";
    }
    return "function";
  }

  private containsYield(node: PyNode): boolean {
    if (node.name === "YieldStatement" || node.name === "YieldExpression") {
      return true;
    }
    if (node.name === "FunctionDefinition" || node.name === "LambdaExpression") {
      return false;
    }
    for (const child of pyChildren(node)) {
      if (this.containsYield(child)) {
        return true;
      }
    }
    return false;
  }

  private emitFunctionDefinition(statement: PyNode, scope: PyScope): DraftNode {
    const definition = this.definitionByNode.get(statement.from);
    const body = pyChild(statement, "Body");
    if (definition === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const innerScope: PyScope =
      definition.scopeRef ??
      ({
        defs: new Map(),
        key: definition.scope,
        kind: "function",
        locals: new Map(),
        owner: definition,
        parent: scope,
      } satisfies PyScope);
    const params = pyChild(statement, "ParamList");
    const parameterNodes: DraftNode[] = [];
    const parameterSymbols: DraftSymbol[] = [];
    if (params !== undefined) {
      for (const child of pyChildren(params)) {
        if (child.name !== "VariableName") {
          continue;
        }
        const symbol = innerScope.locals.get(this.text(child));
        if (symbol?.declaration !== undefined) {
          parameterNodes.push(symbol.declaration);
          parameterSymbols.push(symbol);
        }
      }
    }
    definition.parameters.push(...parameterSymbols);
    this.definitionStack.push(definition);
    let bodyDraft: DraftNode;
    try {
      bodyDraft = body === undefined ? this.node("block", []) : this.emitBody(body, innerScope);
    } finally {
      this.definitionStack.pop();
    }
    if (params !== undefined) {
      this.applyParameterDefaults(params, innerScope, parameterNodes);
    }
    appendChildren(definition.body, [this.node("parameters", parameterNodes), bodyDraft]);
    return definition.body;
  }

  /** Parameter defaults are evaluated in the definition's own scope, in source order. */
  private applyParameterDefaults(
    params: PyNode,
    scope: PyScope,
    parameterNodes: readonly DraftNode[],
  ): void {
    const children = pyChildren(params);
    let keywordOnly = false;
    let positionalIndex = 0;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.name === "*") {
        const next = children[index + 1];
        if (next?.name === "VariableName") {
          const symbol = scope.locals.get(this.text(next));
          if (symbol?.declaration !== undefined) {
            (symbol.declaration.fields as Record<string, unknown>).paramKind = "rest_positional";
          }
          index += 1;
          continue;
        }
        keywordOnly = true;
        continue;
      }
      if (child.name === "**") {
        const next = children[index + 1];
        if (next?.name === "VariableName") {
          const symbol = scope.locals.get(this.text(next));
          if (symbol?.declaration !== undefined) {
            (symbol.declaration.fields as Record<string, unknown>).paramKind = "rest_keyword";
          }
          index += 1;
        }
        continue;
      }
      if (child.name !== "VariableName") {
        continue;
      }
      const symbol = scope.locals.get(this.text(child));
      const parameterNode = parameterNodes[positionalIndex];
      positionalIndex += 1;
      if (symbol?.declaration !== undefined) {
        (symbol.declaration.fields as Record<string, unknown>).paramKind = keywordOnly
          ? "keyword_only"
          : "positional";
      }
      const assignOperator = children[index + 1];
      const defaultValue = children[index + 2];
      if (
        parameterNode !== undefined &&
        assignOperator?.name === "AssignOp" &&
        defaultValue !== undefined
      ) {
        appendChildren(parameterNode, [this.emitExpression(defaultValue, scope)]);
        index += 2;
      }
    }
  }

  private emitAssignment(statement: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(statement);
    const equalsIndices: number[] = [];
    children.forEach((child, index) => {
      if (child.name === "AssignOp") {
        equalsIndices.push(index);
      }
    });
    if (equalsIndices.length === 0) {
      // Annotation-only statement (`x: int`): a declaration with no initializer.
      const target = children[0];
      if (target?.name !== "VariableName") {
        return this.unsupported("unsupported_construct");
      }
      const symbol = this.lookupLocal(this.text(target), scope);
      if (symbol === undefined) {
        return this.unsupported("unsupported_construct");
      }
      return this.node("declare", [], { declKind: "local", symbol });
    }
    const segments: PyNode[][] = [];
    let start = 0;
    for (const index of equalsIndices) {
      segments.push(children.slice(start, index));
      start = index + 1;
    }
    const value = this.emitExpressionList(children.slice(start), scope);
    let current = value;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const targets = segments[index].filter(
        (child) => child.name !== "TypeDef" && child.name !== ":" && child.name !== "*",
      );
      current = this.emitAssignmentToTargets(targets, current, scope);
    }
    return current;
  }

  private emitAssignmentToTargets(
    targets: readonly PyNode[],
    value: DraftNode,
    scope: PyScope,
  ): DraftNode {
    if (targets.length === 0) {
      return value;
    }
    if (targets.length === 1 && targets[0].name === "VariableName") {
      const name = this.text(targets[0]);
      const existing = this.lookupLocal(name, scope);
      if (existing !== undefined) {
        return this.node("assign", [this.identifier(existing), value], { operator: "set" });
      }
      const symbol = this.createLocal(name, scope);
      return this.node("declare", [value], { declKind: "local", symbol });
    }
    if (targets.length === 1 && !this.isDestructuringPattern(targets[0])) {
      // A store into a place (`row["kind"] = ...`, `record.owner = ...`) keeps the place expression
      // and its reads; only a binding pattern is a destructuring target.
      return this.node("assign", [this.emitExpression(targets[0], scope), value], {
        operator: "set",
      });
    }
    const target =
      targets.length === 1
        ? this.emitDestructuringTarget(targets[0], scope)
        : this.node(
            "tuple",
            targets.map((item) => this.emitDestructuringTarget(item, scope)),
          );
    return this.node("assign", [target, value], { operator: "set" });
  }

  private isDestructuringPattern(node: PyNode): boolean {
    return (
      node.name === "VariableName" ||
      node.name === "TupleExpression" ||
      node.name === "ArrayExpression" ||
      node.name === "ParenthesizedExpression" ||
      node.name === "SetExpression"
    );
  }

  /** Destructuring materializes one binding per name instead of leaving unexplained external state. */
  private emitDestructuringTarget(target: PyNode, scope: PyScope): DraftNode {
    if (target.name === "VariableName") {
      const name = this.text(target);
      const symbol = scope.locals.get(name) ?? this.createLocal(name, scope);
      return this.node("declare", [], { declKind: "local", symbol });
    }
    if (
      target.name === "TupleExpression" ||
      target.name === "ArrayExpression" ||
      target.name === "ParenthesizedExpression" ||
      target.name === "SetExpression"
    ) {
      return this.node(
        "tuple",
        pyContentChildren(target)
          .filter((child) => child.name !== "*")
          .map((element) => this.emitDestructuringTarget(element, scope)),
      );
    }
    return this.unsupported("unsupported_construct");
  }

  private emitUpdate(statement: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(statement);
    const operatorIndex = children.findIndex((child) => child.name === "UpdateOp");
    if (operatorIndex < 1) {
      return this.unsupported("unsupported_construct");
    }
    const operator = this.updateOperatorOf(this.text(children[operatorIndex]));
    if (operator === undefined) {
      return this.unsupported("unsupported_operator");
    }
    const target = children[0];
    const value = this.emitExpressionList(children.slice(operatorIndex + 1), scope);
    const targetDraft =
      target.name === "VariableName"
        ? this.identifier(
            this.lookupLocal(this.text(target), scope) ??
              this.createLocal(this.text(target), scope),
          )
        : this.emitExpression(target, scope);
    return this.node("assign", [targetDraft, value], { operator });
  }

  private updateOperatorOf(
    token: string,
  ):
    | "add"
    | "bit_and"
    | "bit_or"
    | "bit_xor"
    | "div"
    | "floor_div"
    | "mod"
    | "mul"
    | "pow"
    | "shift_left"
    | "shift_right"
    | "sub"
    | undefined {
    switch (token) {
      case "+=":
        return "add";
      case "-=":
        return "sub";
      case "*=":
        return "mul";
      case "/=":
        return "div";
      case "//=":
        return "floor_div";
      case "%=":
        return "mod";
      case "**=":
        return "pow";
      case "&=":
        return "bit_and";
      case "|=":
        return "bit_or";
      case "^=":
        return "bit_xor";
      case "<<=":
        return "shift_left";
      case ">>=":
        return "shift_right";
      default:
        return undefined;
    }
  }

  private emitExpressionStatement(statement: PyNode, scope: PyScope): DraftNode {
    const values = pyContentChildren(statement);
    const expression =
      values.length === 1
        ? this.emitExpression(values[0], scope)
        : this.node(
            "tuple",
            values.map((value) => this.emitExpression(value, scope)),
          );
    if (this.frameId > 0) {
      return expression;
    }
    const wrapped = this.node("expression", [expression]);
    this.outputs.push({ node: wrapped, shape: this.shapeOf(expression) });
    return wrapped;
  }

  private emitReturn(statement: PyNode, scope: PyScope): DraftNode {
    const values = pyChildren(statement).filter(
      (child) => PY_EXPRESSION_NAMES[child.name] === true,
    );
    if (values.length === 0) {
      return this.node("return", []);
    }
    const value = this.emitExpressionList(values, scope);
    const returnNode = this.node("return", [value]);
    if (scope.owner !== null) {
      this.outputs.push({
        definitionKey: scope.owner.key,
        node: returnNode,
        shape: this.shapeOf(value),
      });
    }
    return returnNode;
  }

  private emitExpressionList(values: readonly PyNode[], scope: PyScope): DraftNode {
    if (values.length === 0) {
      return pyConstant("null");
    }
    if (values.length === 1) {
      return this.emitExpression(values[0], scope);
    }
    return this.node(
      "tuple",
      values.map((value) => this.emitExpression(value, scope)),
    );
  }

  private emitIf(statement: PyNode, scope: PyScope): DraftNode {
    const branches: { test?: PyNode; body?: PyNode }[] = [{}, {}];
    let current = 0;
    for (const child of pyChildren(statement)) {
      if (child.name === "if") {
        continue;
      }
      if (child.name === "elif" || child.name === "else") {
        current += 1;
        branches[current] = {};
        continue;
      }
      if (child.name === "Body") {
        branches[current].body = child;
        continue;
      }
      if (PY_STRUCTURAL_TOKENS[child.name] !== true) {
        branches[current].test = child;
      }
    }
    let node: DraftNode | undefined;
    for (let index = branches.length - 1; index >= 0; index -= 1) {
      const branch = branches[index];
      if (branch.test === undefined) {
        if (branch.body !== undefined) {
          node = this.emitBody(branch.body, scope);
        }
        continue;
      }
      const then = this.emitBody(branch.body, scope);
      const test = this.emitExpression(branch.test, scope);
      node =
        node === undefined ? this.node("if", [test, then]) : this.node("if", [test, then, node]);
    }
    return node ?? this.unsupported("unsupported_construct");
  }

  private emitWhile(statement: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(statement);
    if (children.some((child) => child.name === "else")) {
      return this.unsupported("unsupported_construct");
    }
    const test = children.find((child) => child.name !== "while" && child.name !== "Body");
    const body = pyChild(statement, "Body");
    if (test === undefined || body === undefined) {
      return this.unsupported("unsupported_construct");
    }
    return this.node("while", [this.emitExpression(test, scope), this.emitBody(body, scope)]);
  }

  private emitFor(statement: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(statement);
    if (children.some((child) => child.name === "else")) {
      return this.unsupported("unsupported_construct");
    }
    const header: PyNode[] = [];
    let body: PyNode | undefined;
    for (const child of children) {
      if (child.name === "Body") {
        body = child;
        continue;
      }
      header.push(child);
    }
    const inIndex = header.findIndex((child) => child.name === "in");
    if (inIndex < 0 || body === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const targets = header
      .slice(0, inIndex)
      .filter(
        (child) =>
          PY_STRUCTURAL_TOKENS[child.name] !== true &&
          child.name !== "for" &&
          child.name !== "async" &&
          child.name !== "*",
      );
    const iterables = header
      .slice(inIndex + 1)
      .filter((child) => PY_STRUCTURAL_TOKENS[child.name] !== true && child.name !== "*");
    const target =
      targets.length === 1
        ? this.emitLoopTarget(targets[0], scope)
        : this.node(
            "tuple",
            targets.map((item) => this.emitLoopTarget(item, scope)),
          );
    const fields: Record<string, unknown> = {};
    if (header.some((child) => child.name === "async")) {
      fields.async = true;
    }
    return this.node(
      "for",
      [target, this.emitExpressionList(iterables, scope), this.emitBody(body, scope)],
      fields,
    );
  }

  private emitLoopTarget(target: PyNode, scope: PyScope): DraftNode {
    if (target.name === "VariableName") {
      const name = this.text(target);
      return this.identifier(this.lookupLocal(name, scope) ?? this.createLocal(name, scope));
    }
    return this.emitDestructuringTarget(target, scope);
  }

  private emitTry(statement: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(statement);
    if (children.some((child) => child.name === "else")) {
      return this.unsupported("unsupported_construct");
    }
    const body = children[0];
    if (body?.name !== "Body") {
      return this.unsupported("unsupported_construct");
    }
    const parts: DraftNode[] = [this.emitBody(body, scope)];
    let index = 1;
    while (index < children.length) {
      const child = children[index];
      if (child.name === "except") {
        index += 1;
        let exceptionGroup = false;
        let symbol: DraftSymbol | undefined;
        while (index < children.length && children[index].name !== "Body") {
          const token = children[index];
          if (token.name === "*") {
            exceptionGroup = true;
          }
          if (token.name === "as") {
            const nameNode = children[index + 1];
            if (nameNode?.name === "VariableName") {
              const name = this.text(nameNode);
              symbol = this.lookupLocal(name, scope) ?? this.createLocal(name, scope);
            }
          }
          index += 1;
        }
        const catchBody = children[index];
        if (catchBody?.name !== "Body" || exceptionGroup) {
          return this.unsupported("unsupported_construct");
        }
        const catchDraft = this.emitBody(catchBody, scope);
        parts.push(
          symbol === undefined
            ? this.node("catch", [catchDraft])
            : this.node("catch", [catchDraft], { symbol }),
        );
        index += 1;
        continue;
      }
      if (child.name === "finally") {
        const finallyBody = children[index + 1];
        if (finallyBody?.name !== "Body") {
          return this.unsupported("unsupported_construct");
        }
        parts.push(this.node("finally", [this.emitBody(finallyBody, scope)]));
        index += 2;
        continue;
      }
      index += 1;
    }
    return this.node("try", parts);
  }

  private emitWith(statement: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(statement);
    const isAsync = children.some((child) => child.name === "async");
    const body = pyChild(statement, "Body");
    if (body === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const items: { resource?: PyNode; target?: PyNode }[] = [];
    let item: { resource?: PyNode; target?: PyNode } = {};
    for (const child of children) {
      if (child.name === "with" || child.name === "async" || child.name === "Body") {
        continue;
      }
      if (child.name === ",") {
        items.push(item);
        item = {};
        continue;
      }
      if (child.name === "as") {
        continue;
      }
      if (item.resource !== undefined && item.target === undefined) {
        item.target = child;
        continue;
      }
      item.resource = child;
    }
    items.push(item);
    let bodyDraft = this.emitBody(body, scope);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const entry = items[index];
      if (entry.resource === undefined) {
        continue;
      }
      const resource = this.emitExpression(entry.resource, scope);
      const resourceDraft =
        entry.target?.name === "VariableName"
          ? this.bindWithTarget(entry.target, resource, scope)
          : resource;
      bodyDraft = this.node("with", [resourceDraft, bodyDraft], {
        withKind: isAsync ? "async_with" : "with",
      });
    }
    return bodyDraft;
  }

  /**
   * `with <resource> as <name>` keeps the resource expression and its binding: the `assign` is the
   * with-node's resource child, and its target identifier is the declaration of the bound name. A
   * resolved read-only `open(...)` resource marks the binding as a local file handle so its read
   * methods lower to the finite file APIs instead of being guessed from the method name.
   */
  private bindWithTarget(target: PyNode, resource: DraftNode, scope: PyScope): DraftNode {
    const name = this.text(target);
    const symbol = this.lookupLocal(name, scope) ?? this.createLocal(name, scope);
    if (resource.kind === "call" && resource.fields?.api === "fs.open_read") {
      this.fileHandles.add(symbol);
    }
    return this.node("assign", [this.identifier(symbol), resource], { operator: "set" });
  }

  /**
   * Record one import statement's local bindings.
   *
   * A module import binds either the full dotted path under its alias (`import os.path as p`) or the
   * root segment (`import os.path`, `import json as _json`), and a `from` import binds each imported
   * member under its local name. Only the resolver table and the private import report see these
   * names; a module path never becomes a wire node.
   */
  private recordImport(statement: PyNode): void {
    const children = pyChildren(statement);
    if (children[0]?.name === "from") {
      this.recordFromImport(statement, children);
      return;
    }
    for (const group of this.splitGroups(children.slice(1))) {
      const asIndex = group.findIndex((child) => child.name === "as");
      const aliasNode = asIndex >= 0 ? group[asIndex + 1] : undefined;
      const dotted = group
        .filter((child) => child.name === "VariableName" && child !== aliasNode)
        .map((child) => this.text(child))
        .join(".");
      if (dotted.length === 0) {
        continue;
      }
      const alias = aliasNode?.name === "VariableName" ? this.text(aliasNode) : undefined;
      const bound = alias ?? dotted.split(".")[0];
      const module = alias === undefined ? dotted.split(".")[0] : dotted;
      this.importBindings.set(bound, { kind: "module", member: module, module });
      if (this.frameId === 0) {
        this.localImports.push({ names: [bound], source: this.text(statement) });
      }
    }
  }

  private recordFromImport(statement: PyNode, children: readonly PyNode[]): void {
    const importIndex = children.findIndex((child) => child.name === "import");
    if (importIndex < 1) {
      return;
    }
    const modulePath = children
      .slice(1, importIndex)
      .filter((child) => child.name === "VariableName")
      .map((child) => this.text(child))
      .join(".");
    if (modulePath.length === 0) {
      return;
    }
    const names: string[] = [];
    for (const group of this.splitGroups(children.slice(importIndex + 1))) {
      const asIndex = group.findIndex((child) => child.name === "as");
      const aliasNode = asIndex >= 0 ? group[asIndex + 1] : undefined;
      const memberNode = group.find(
        (child) => child.name === "VariableName" && child !== aliasNode,
      );
      if (memberNode === undefined) {
        continue;
      }
      const member = this.text(memberNode);
      const bound = aliasNode?.name === "VariableName" ? this.text(aliasNode) : member;
      names.push(bound);
      this.importBindings.set(bound, { kind: "member", member, module: modulePath });
    }
    if (this.frameId === 0 && names.length > 0) {
      this.localImports.push({ names, source: this.text(statement) });
    }
  }

  private splitGroups(children: readonly PyNode[]): PyNode[][] {
    const groups: PyNode[][] = [];
    let group: PyNode[] = [];
    for (const child of children) {
      if (child.name === "," || child.name === "(" || child.name === ")") {
        if (group.length > 0) {
          groups.push(group);
        }
        group = [];
        continue;
      }
      group.push(child);
    }
    if (group.length > 0) {
      groups.push(group);
    }
    return groups;
  }

  // --------------------------------------------------------------------------
  // Expressions
  // --------------------------------------------------------------------------

  private emitExpression(node: PyNode | undefined, scope: PyScope): DraftNode {
    if (node === undefined) {
      return this.unsupported("unsupported_construct");
    }
    this.enter();
    try {
      switch (node.name) {
        case "VariableName":
          return this.emitNameRead(node, scope);
        case "Number":
          return this.emitNumber(node);
        case "String":
          return this.emitString(node);
        case "Boolean":
          return this.text(node) === "True" ? pyConstant("true") : pyConstant("false");
        case "None":
          return pyConstant("null");
        case "FormatString":
          return this.emitTemplate(node, scope);
        case "ContinuedString":
          return this.emitContinuedString(node, scope);
        case "BinaryExpression":
          return this.emitBinary(node, scope);
        case "UnaryExpression":
          return this.emitUnary(node, scope);
        case "ConditionalExpression":
          return this.emitConditional(node, scope);
        case "LambdaExpression":
          return this.emitLambda(node, scope);
        case "ParenthesizedExpression": {
          const inner = pyContentChildren(node)[0];
          return inner === undefined
            ? this.unsupported("unsupported_construct")
            : this.emitExpression(inner, scope);
        }
        case "TupleExpression":
          return this.node(
            "tuple",
            pyContentChildren(node).map((child) => this.emitExpression(child, scope)),
          );
        case "ArrayExpression":
          return this.node(
            "array",
            pyContentChildren(node).map((child) => this.emitExpression(child, scope)),
          );
        case "DictionaryExpression":
          return this.emitDictionary(node, scope);
        case "SetExpression":
          return this.node(
            "new",
            pyContentChildren(node).map((child) => this.emitExpression(child, scope)),
            { api: "construct.set" },
          );
        case "CallExpression":
          return this.emitCall(node, scope);
        case "MemberExpression":
          return this.emitMember(node, scope);
        case "AwaitExpression": {
          const inner = pyContentChildren(node)[0];
          return inner === undefined
            ? this.unsupported("unsupported_construct")
            : this.node("await", [this.emitExpression(inner, scope)]);
        }
        case "YieldExpression": {
          const inner = pyContentChildren(node)[0];
          return inner === undefined
            ? this.node("yield", [])
            : this.node("yield", [this.emitExpression(inner, scope)]);
        }
        case "NamedExpression": {
          const children = pyContentChildren(node);
          const target = children[0];
          const valueNode = children[children.length - 1];
          if (target?.name !== "VariableName" || valueNode === undefined) {
            return this.unsupported("unsupported_construct");
          }
          const name = this.text(target);
          const symbol = this.lookupLocal(name, scope) ?? this.createLocal(name, scope);
          return this.node(
            "assign",
            [this.identifier(symbol), this.emitExpression(valueNode, scope)],
            {
              operator: "set",
            },
          );
        }
        case "ArrayComprehensionExpression":
          return this.emitComprehension(node, scope, "list");
        case "DictionaryComprehensionExpression":
          return this.emitComprehension(node, scope, "dict");
        case "SetComprehensionExpression":
          return this.emitComprehension(node, scope, "set");
        case "ComprehensionExpression":
          return this.emitComprehension(node, scope, "generator");
        default:
          return this.unsupported("unsupported_construct");
      }
    } finally {
      this.leave();
    }
  }

  private emitNumber(node: PyNode): DraftNode {
    const text = this.text(node).replace(/_/g, "");
    if (text === "0") {
      return pyConstant("zero");
    }
    if (text === "1") {
      return pyConstant("one");
    }
    return this.literal(`num:${text}`, "number", "literal");
  }

  private emitString(node: PyNode): DraftNode {
    const text = this.text(node);
    const bytes = /^[bB]/.test(text);
    const quote = text.replace(/^[a-zA-Z]{0,2}/, "");
    if (!bytes && (quote === '""' || quote === "''")) {
      return pyConstant("empty_string");
    }
    return this.literal(`str:${text}`, bytes ? "bytes" : "string", "literal");
  }

  private emitContinuedString(node: PyNode, scope: PyScope): DraftNode {
    const parts = pyContentChildren(node).map((child) => this.emitExpression(child, scope));
    if (parts.length === 0) {
      return pyConstant("empty_string");
    }
    let current = parts[0];
    for (let index = 1; index < parts.length; index += 1) {
      current = this.node("binary", [current, parts[index]], { operator: "concat" });
    }
    return current;
  }

  private emitTemplate(node: PyNode, scope: PyScope): DraftNode {
    const children: DraftNode[] = [];
    for (const child of pyChildren(node)) {
      if (child.name === "FormatReplacement") {
        if (pyChild(child, "FormatSpec") !== undefined) {
          return this.unsupported("unsupported_construct");
        }
        for (const part of pyContentChildren(child)) {
          if (PY_EXPRESSION_NAMES[part.name] === true) {
            children.push(this.emitExpression(part, scope));
          }
        }
        continue;
      }
      if (child.name === "stringContent") {
        children.push(this.literal(`fmt:${this.text(child)}`, "string", "literal"));
      }
    }
    return this.node("template", children, { templateKind: "fstring" });
  }

  /** Operand nodes and the (possibly multi-token) operator of a binary/comparison expression. */
  private binaryParts(node: PyNode): { operator: string; operands: PyNode[] } | undefined {
    const operands: PyNode[] = [];
    const operators: string[] = [];
    for (const child of pyChildren(node)) {
      if (PY_EXPRESSION_NAMES[child.name] === true) {
        operands.push(child);
        continue;
      }
      if (PY_STRUCTURAL_TOKENS[child.name] !== true && child.name !== "Comment") {
        operators.push(this.text(child));
      }
    }
    if (operands.length !== 2 || operators.length === 0) {
      return undefined;
    }
    return { operator: operators.join(" "), operands };
  }

  private emitBinary(node: PyNode, scope: PyScope): DraftNode {
    const parts = this.binaryParts(node);
    if (parts === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const [left, right] = parts.operands;
    if (this.compareOperatorOf(parts.operator) !== undefined) {
      return this.emitChain(node, scope, "compare");
    }
    if (this.booleanOperatorOf(parts.operator) !== undefined) {
      return this.emitChain(node, scope, "boolean");
    }
    const binary = this.binaryOperatorOf(parts.operator);
    if (binary === undefined) {
      return this.unsupported("unsupported_operator", [
        this.emitExpression(left, scope),
        this.emitExpression(right, scope),
      ]);
    }
    return this.node(
      "binary",
      [this.emitExpression(left, scope), this.emitExpression(right, scope)],
      { operator: binary },
    );
  }

  /**
   * Chained comparisons and short-circuit boolean operators are n-ary in the IR. The tree nests them
   * to the left, so a left-nested chain of one family flattens into a single ordered node; a
   * parenthesized subexpression is its own node and therefore stays a separate operand.
   */
  private emitChain(node: PyNode, scope: PyScope, family: "boolean" | "compare"): DraftNode {
    const parts = this.binaryParts(node);
    if (parts === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const [left, right] = parts.operands;
    const operator =
      family === "compare"
        ? this.compareOperatorOf(parts.operator)
        : this.booleanOperatorOf(parts.operator);
    if (operator === undefined) {
      return this.unsupported("unsupported_operator");
    }
    const leftParts = left.name === "BinaryExpression" ? this.binaryParts(left) : undefined;
    const sameFamily =
      leftParts !== undefined &&
      (family === "compare"
        ? this.compareOperatorOf(leftParts.operator) !== undefined
        : this.booleanOperatorOf(leftParts.operator) !== undefined);
    let children: DraftNode[];
    let operators: string[];
    if (sameFamily) {
      const nested = this.emitChain(left, scope, family);
      children = [...nested.children];
      operators = [...((nested.fields?.operators as string[]) ?? [])];
    } else {
      children = [this.emitExpression(left, scope)];
      operators = [];
    }
    children.push(this.emitExpression(right, scope));
    operators.push(operator);
    return this.node(family, children, { operators });
  }

  private compareOperatorOf(
    operator: string,
  ): "eq" | "ge" | "gt" | "in" | "is" | "is_not" | "le" | "lt" | "ne" | "not_in" | undefined {
    switch (operator) {
      case "==":
        return "eq";
      case "!=":
      case "<>":
        return "ne";
      case "<":
        return "lt";
      case "<=":
        return "le";
      case ">":
        return "gt";
      case ">=":
        return "ge";
      case "in":
        return "in";
      case "not in":
        return "not_in";
      case "is":
        return "is";
      case "is not":
        return "is_not";
      default:
        return undefined;
    }
  }

  private booleanOperatorOf(operator: string): "and" | "or" | undefined {
    if (operator === "and") {
      return "and";
    }
    if (operator === "or") {
      return "or";
    }
    return undefined;
  }

  private binaryOperatorOf(
    operator: string,
  ):
    | "add"
    | "bit_and"
    | "bit_or"
    | "bit_xor"
    | "div"
    | "floor_div"
    | "matmul"
    | "mod"
    | "mul"
    | "pow"
    | "shift_left"
    | "shift_right"
    | "sub"
    | undefined {
    switch (operator) {
      case "+":
        return "add";
      case "-":
        return "sub";
      case "*":
        return "mul";
      case "/":
        return "div";
      case "//":
        return "floor_div";
      case "%":
        return "mod";
      case "**":
        return "pow";
      case "@":
        return "matmul";
      case "<<":
        return "shift_left";
      case ">>":
        return "shift_right";
      case "&":
        return "bit_and";
      case "|":
        return "bit_or";
      case "^":
        return "bit_xor";
      default:
        return undefined;
    }
  }

  private emitUnary(node: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(node);
    const operand = children.find((child) => PY_EXPRESSION_NAMES[child.name] === true);
    const operatorToken = children.find(
      (child) => PY_EXPRESSION_NAMES[child.name] !== true && child.name !== "Comment",
    );
    const operator = operatorToken === undefined ? undefined : this.text(operatorToken);
    if (operand === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const mapped =
      operator === "not"
        ? ("not" as const)
        : operator === "~"
          ? ("bit_not" as const)
          : operator === "-"
            ? ("negate" as const)
            : operator === "+"
              ? ("positive" as const)
              : undefined;
    if (mapped === undefined) {
      return this.unsupported("unsupported_operator");
    }
    return this.node("unary", [this.emitExpression(operand, scope)], { operator: mapped });
  }

  private emitConditional(node: PyNode, scope: PyScope): DraftNode {
    const children = pyContentChildren(node);
    const ifIndex = children.findIndex((child) => child.name === "if");
    const elseIndex = children.findIndex((child) => child.name === "else");
    const consequent = ifIndex > 0 ? children[0] : undefined;
    const test = ifIndex >= 0 && elseIndex > ifIndex ? children[ifIndex + 1] : undefined;
    const alternate = elseIndex >= 0 ? children[elseIndex + 1] : undefined;
    if (consequent === undefined || test === undefined || alternate === undefined) {
      return this.unsupported("unsupported_construct");
    }
    return this.node("conditional", [
      this.emitExpression(test, scope),
      this.emitExpression(consequent, scope),
      this.emitExpression(alternate, scope),
    ]);
  }

  private emitDictionary(node: PyNode, scope: PyScope): DraftNode {
    const children = pyContentChildren(node);
    const pairs: DraftNode[] = [];
    let index = 0;
    while (index < children.length) {
      const key = children[index];
      if (key.name === "**") {
        const spread = children[index + 1];
        if (spread === undefined) {
          return this.unsupported("unsupported_construct");
        }
        pairs.push(
          this.node("spread", [this.emitExpression(spread, scope)], { spreadKind: "mapping" }),
        );
        index += 2;
        continue;
      }
      const colon = children[index + 1];
      const value = children[index + 2];
      if (colon?.name !== ":" || value === undefined) {
        return this.unsupported("unsupported_construct");
      }
      pairs.push(this.emitPair(key, value, scope));
      index += 3;
    }
    return this.node("object", pairs);
  }

  private emitPair(key: PyNode, value: PyNode, scope: PyScope): DraftNode {
    const keyText = key.name === "String" ? this.staticStringText(key) : undefined;
    if (keyText === undefined) {
      return this.unsupported("unsupported_dynamic_key", [this.emitExpression(value, scope)]);
    }
    return this.node("pair", [this.emitExpression(value, scope)], {
      ...draftField(keyText, `field:${keyText}`),
    });
  }

  /** The text of a plain (unprefixed, unescaped) string literal, or `undefined`. */
  private staticStringText(node: PyNode): string | undefined {
    const text = this.text(node);
    if (!/^(['"])([^\\'\n]*)\1$/.test(text)) {
      return undefined;
    }
    return text.slice(1, -1);
  }

  private emitMember(node: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(node);
    const base = children[0];
    const accessor = children[children.length - 1];
    if (base === undefined || accessor === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const openIndex = children.findIndex((child) => child.name === "[");
    if (openIndex >= 0) {
      return this.emitSubscript(
        children.slice(openIndex + 1),
        this.emitExpression(base, scope),
        scope,
      );
    }
    const property = children.find((child) => child.name === "PropertyName");
    if (property === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const propertyName = this.text(property);
    const alias =
      base.name === "VariableName" ? this.importBindings.get(this.text(base)) : undefined;
    if (alias !== undefined && alias.kind === "module") {
      // A recognized standard-library attribute read that is not a finite API call is data from
      // outside the captured program: an anonymous free variable, never a module name on the wire.
      if (alias.module === "sys" && propertyName === "argv") {
        return this.literal("free:sys.argv", "array", "free_variable");
      }
      return this.unsupported("unsupported_api");
    }
    return this.node("member", [this.emitExpression(base, scope)], {
      ...draftField(propertyName, `field:${propertyName}`),
    });
  }

  private emitSubscript(contents: readonly PyNode[], base: DraftNode, scope: PyScope): DraftNode {
    const children = contents.filter(
      (child) => child.name !== "]" && child.name !== "[" && child.name !== "Comment",
    );
    if (children.some((child) => child.name === ",")) {
      return this.unsupported("unsupported_construct", [base]);
    }
    const colons = children.filter((child) => child.name === ":").length;
    if (colons === 0) {
      const key = children[0];
      if (key === undefined) {
        return this.unsupported("unsupported_construct", [base]);
      }
      const keyText = key.name === "String" ? this.staticStringText(key) : undefined;
      if (keyText !== undefined) {
        // A static key is a structural selection: a safe key survives as a field name and an unsafe
        // one becomes a field slot rather than a retained value.
        return this.node("member", [base], { ...draftField(keyText, `field:${keyText}`) });
      }
      return this.node("index", [base, this.emitExpression(key, scope)]);
    }
    const bounds: (PyNode | null)[] = [null, null, null];
    let role = 0;
    for (const child of children) {
      if (child.name === ":") {
        role += 1;
        if (role > 2) {
          return this.unsupported("unsupported_construct", [base]);
        }
        continue;
      }
      if (bounds[role] !== null) {
        return this.unsupported("unsupported_construct", [base]);
      }
      bounds[role] = child;
    }
    const first = bounds.findIndex((bound) => bound !== null);
    if (first < 0) {
      return this.node("slice", [base]);
    }
    let last = first;
    for (let index = 2; index >= first; index -= 1) {
      if (bounds[index] !== null) {
        last = index;
        break;
      }
    }
    const roles = ["lower", "upper", "step"] as const;
    const emitted: DraftNode[] = [base];
    for (let index = first; index <= last; index += 1) {
      const bound = bounds[index];
      emitted.push(bound === null ? pyConstant("null") : this.emitExpression(bound, scope));
    }
    return this.node("slice", emitted, { slicePart: roles[first] });
  }

  // --------------------------------------------------------------------------
  // Calls
  // --------------------------------------------------------------------------

  private emitCall(node: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(node);
    const callee = children[0];
    const argList = children.find((child) => child.name === "ArgList");
    if (callee === undefined || argList === undefined) {
      return this.unsupported("unsupported_construct");
    }
    const args = this.emitArguments(argList, scope);
    if (args.keywordRejected) {
      return this.unsupported("unsupported_dynamic_key", [
        ...args.positional,
        ...args.keywordArgs.map((entry) => entry.value),
      ]);
    }
    const calleeName = callee.name === "VariableName" ? this.text(callee) : undefined;
    if (calleeName === "open") {
      if (!this.openModeIsReadOnly(argList)) {
        // Never claim an arbitrary open mode is a read-only resource.
        return this.unsupported("unsupported_api", args.positional);
      }
      return this.node("call", args.positional, { api: "fs.open_read" });
    }
    const resolution = this.resolveCallee(callee, scope);
    if (resolution.symbol !== undefined) {
      this.useDefinition(resolution.symbol);
      return this.node("call", args.positional, {
        symbol: resolution.symbol,
        ...(args.keywordArgs.length > 0 ? { keywordArgs: args.keywordArgs } : {}),
      });
    }
    if (resolution.api !== undefined) {
      const keywordFields = args.keywordArgs.length > 0 ? { keywordArgs: args.keywordArgs } : {};
      if (resolution.construct) {
        return this.node("new", args.positional, { api: resolution.api, ...keywordFields });
      }
      if (resolution.receiver !== undefined) {
        return this.node("call", args.positional, {
          api: resolution.api,
          receiver: resolution.receiver,
          ...keywordFields,
        });
      }
      return this.node("call", args.positional, { api: resolution.api, ...keywordFields });
    }
    const retained: DraftNode[] = [];
    if (resolution.receiver !== undefined) {
      retained.push(resolution.receiver);
    }
    if (resolution.retained !== undefined) {
      retained.push(resolution.retained);
    }
    return this.unsupported(resolution.reason ?? "unsupported_api", [
      ...retained,
      ...args.positional,
      ...args.keywordArgs.map((entry) => entry.value),
    ]);
  }

  private openModeIsReadOnly(argList: PyNode): boolean {
    const groups = this.argumentGroups(argList);
    const mode = groups[1]?.[0];
    if (mode === undefined) {
      return true;
    }
    const text = mode.name === "String" ? this.staticStringText(mode) : undefined;
    return text !== undefined && isPythonReadOnlyOpenMode(text);
  }

  private argumentGroups(argList: PyNode): PyNode[][] {
    const groups: PyNode[][] = [];
    let group: PyNode[] = [];
    for (const child of pyChildren(argList)) {
      if (child.name === "(" || child.name === ")" || child.name === "Comment") {
        continue;
      }
      if (child.name === ",") {
        if (group.length > 0) {
          groups.push(group);
        }
        group = [];
        continue;
      }
      group.push(child);
    }
    if (group.length > 0) {
      groups.push(group);
    }
    return groups;
  }

  private emitArguments(
    argList: PyNode,
    scope: PyScope,
  ): {
    keywordArgs: { name: string; value: DraftNode }[];
    keywordRejected: boolean;
    positional: DraftNode[];
  } {
    const positional: DraftNode[] = [];
    const keywordArgs: { name: string; value: DraftNode }[] = [];
    let keywordRejected = false;
    for (const entry of this.argumentGroups(argList)) {
      const first = entry[0];
      if (first === undefined) {
        continue;
      }
      if ((first.name === "*" || first.name === "**") && entry[1] !== undefined) {
        positional.push(
          this.node("spread", [this.emitExpression(entry[1], scope)], {
            spreadKind: first.name === "*" ? "iterable" : "mapping",
          }),
        );
        continue;
      }
      const isKeyword =
        first.name === "VariableName" &&
        entry[1]?.name === "AssignOp" &&
        (this.text(entry[1]) === "=" || this.text(entry[1]) === ":=") &&
        entry[2] !== undefined;
      if (isKeyword) {
        const name = this.text(first);
        if (name === "key" || isSafeComputationFieldKey(name)) {
          keywordArgs.push({ name, value: this.emitExpression(entry[2], scope) });
        } else {
          // A secret-like keyword name is not a bounded structural key, so the call fails closed
          // with its argument values retained instead of leaking the name.
          keywordRejected = true;
          positional.push(this.emitExpression(entry[2], scope));
        }
        continue;
      }
      const clauseIndex = entry.findIndex(
        (child) => child.name === "for" || child.name === "async",
      );
      if (clauseIndex > 0) {
        const element = this.emitExpression(first, scope);
        positional.push(
          this.node(
            "comprehension",
            [element, ...this.emitComprehensionClauses(entry, clauseIndex, scope)],
            {
              compKind: "generator",
            },
          ),
        );
        continue;
      }
      positional.push(this.emitExpression(first, scope));
    }
    return { keywordArgs, keywordRejected, positional };
  }

  private resolveCallee(
    callee: PyNode,
    scope: PyScope,
  ): {
    api?: PythonApiName;
    construct?: boolean;
    reason?: ComputationUnsupportedReason;
    receiver?: DraftNode;
    retained?: DraftNode;
    symbol?: DraftSymbol;
  } {
    if (callee.name === "VariableName") {
      return this.resolveNameCallee(this.text(callee), scope);
    }
    if (callee.name === "MemberExpression") {
      return this.resolveMemberCallee(callee, scope);
    }
    return { reason: "unsupported_api" };
  }

  private resolveNameCallee(
    name: string,
    scope: PyScope,
  ): {
    api?: PythonApiName;
    construct?: boolean;
    reason?: ComputationUnsupportedReason;
    retained?: DraftNode;
    symbol?: DraftSymbol;
  } {
    const bound = this.resolveBoundName(name, scope);
    if (bound !== undefined) {
      // Only a materialized definition is a resolvable callee; an alias, a parameter or an
      // accumulator holding something callable is dynamic dispatch and is never guessed.
      return bound.kind === "definition"
        ? { symbol: bound }
        : { reason: "unsupported_api", retained: this.identifier(bound) };
    }
    const imported = this.importBindings.get(name);
    if (imported !== undefined) {
      if (imported.kind === "module") {
        return { reason: "unsupported_api" };
      }
      const api = pythonModuleApi(imported.module, imported.member ?? name);
      if (api !== undefined) {
        return { api };
      }
      const helper = this.materializeModuleMember(imported.module, imported.member ?? name);
      return helper === undefined ? { reason: "unsupported_api" } : { symbol: helper.nameSymbol };
    }
    if (isPythonReflectionName(name)) {
      return { reason: "unsupported_reflection" };
    }
    const helper = this.materializeHelperDefinition(name);
    if (helper !== undefined) {
      return { symbol: helper.nameSymbol };
    }
    const constructionApi = pythonConstructorApi(name);
    if (constructionApi !== undefined) {
      return { api: constructionApi, construct: true };
    }
    const builtin = pythonBuiltinApi(name);
    if (builtin !== undefined) {
      return { api: builtin };
    }
    // An unresolved callable is hidden state: never a guessed API and never a data slot.
    return { reason: "unsupported_hidden_state" };
  }

  private resolveMemberCallee(
    callee: PyNode,
    scope: PyScope,
  ): {
    api?: PythonApiName;
    construct?: boolean;
    reason?: ComputationUnsupportedReason;
    receiver?: DraftNode;
    symbol?: DraftSymbol;
  } {
    const children = pyChildren(callee);
    const base = children[0];
    const property = children.find((child) => child.name === "PropertyName");
    if (base === undefined || property === undefined) {
      return { reason: "unsupported_construct" };
    }
    const member = this.text(property);
    const modulePath = this.dottedModuleName(base);
    if (modulePath !== undefined) {
      const direct = pythonModuleApi(modulePath, member);
      if (direct !== undefined) {
        return { api: direct };
      }
      if (modulePath === "builtins") {
        const constructionApi = pythonConstructorApi(member);
        if (constructionApi !== undefined) {
          return { api: constructionApi, construct: true };
        }
        const builtin = pythonBuiltinApi(member);
        if (builtin !== undefined) {
          return { api: builtin };
        }
      }
      const moduleMember = this.materializeModuleMember(modulePath, member);
      if (moduleMember !== undefined) {
        return { symbol: moduleMember.nameSymbol };
      }
      // A recognized module whose member is not a finite API fails closed, keeping the receiver read
      // so no nested computation is silently dropped.
      return { receiver: this.emitExpression(base, scope), reason: "unsupported_api" };
    }
    const baseSymbol =
      base.name === "VariableName" ? this.lookupLocal(this.text(base), scope) : undefined;
    const handleApi =
      baseSymbol !== undefined && this.fileHandles.has(baseSymbol)
        ? pythonFileHandleApi(member)
        : undefined;
    if (handleApi !== undefined) {
      return { api: handleApi, receiver: this.emitExpression(base, scope) };
    }
    const method = pythonMethodApi(member);
    if (method !== undefined) {
      return { api: method, receiver: this.emitExpression(base, scope) };
    }
    if (isPythonReflectionName(member)) {
      return { receiver: this.emitExpression(base, scope), reason: "unsupported_reflection" };
    }
    return { receiver: this.emitExpression(base, scope), reason: "unsupported_api" };
  }

  /** The dotted module path of an expression made only of module aliases, or `undefined`. */
  private dottedModuleName(node: PyNode): string | undefined {
    if (node.name === "VariableName") {
      const alias = this.importBindings.get(this.text(node));
      if (alias === undefined || alias.kind !== "module") {
        return undefined;
      }
      return alias.member ?? alias.module;
    }
    if (node.name === "MemberExpression") {
      const children = pyChildren(node);
      const base = children[0];
      const property = children.find((child) => child.name === "PropertyName");
      if (base === undefined || property === undefined) {
        return undefined;
      }
      const prefix = this.dottedModuleName(base);
      return prefix === undefined ? undefined : `${prefix}.${this.text(property)}`;
    }
    return undefined;
  }

  private emitNameRead(node: PyNode, scope: PyScope): DraftNode {
    const name = this.text(node);
    const bound = this.resolveBoundName(name, scope);
    if (bound !== undefined) {
      return this.identifier(bound);
    }
    const helper = this.materializeHelperDefinition(name);
    if (helper !== undefined) {
      return this.identifier(helper.nameSymbol);
    }
    const imported = this.importBindings.get(name);
    if (imported !== undefined || isPythonReflectionName(name)) {
      return this.unsupported("unsupported_api");
    }
    if (name === "__name__" || name === "__file__") {
      return this.literal(`free:${name}`, "string", "free_variable");
    }
    if (Object.hasOwn(PYTHON_TYPE_CONSTANTS, name)) {
      return pyConstant(PYTHON_TYPE_CONSTANTS[name]);
    }
    if (
      name === "open" ||
      pythonBuiltinApi(name) !== undefined ||
      pythonConstructorApi(name) !== undefined
    ) {
      return this.unsupported("unsupported_api");
    }
    if (this.frameId === 0 && !this.referencedNameSet.has(name)) {
      this.referencedNameSet.add(name);
      this.referencedNames.push(name);
    }
    // Cross-cell data stays an explicit typed free-variable slot, keyed so repeat reads share it.
    return this.literal(`free:${name}`, "unknown", "free_variable");
  }

  // --------------------------------------------------------------------------
  // Symbols, scopes and materialized helpers
  // --------------------------------------------------------------------------

  private identifier(symbol: DraftSymbol): DraftNode {
    this.useDefinition(symbol);
    return this.node("identifier", [], { symbol });
  }

  /**
   * Record that a definition symbol is read. A read in the authored frame seeds the materialized
   * closure; a read inside a definition becomes that definition's direct dependency, which is exactly
   * what the wire contract recomputes from the emitted read sites.
   */
  private useDefinition(symbol: DraftSymbol): void {
    if (symbol.kind !== "definition") {
      return;
    }
    if (this.frameId === 0) {
      this.authoredReads.add(symbol);
    }
    const owner = this.definitionStack[this.definitionStack.length - 1];
    if (owner === undefined) {
      return;
    }
    if (!owner.dependencySet.has(symbol)) {
      owner.dependencySet.add(symbol);
      owner.dependencies.push(symbol);
    }
  }

  /** Resolve a name to a binding: shadowing frames, then each enclosing scope's locals and defs. */
  private resolveBoundName(name: string, scope: PyScope): DraftSymbol | undefined {
    for (let index = this.shadowFrames.length - 1; index >= 0; index -= 1) {
      const shadowed = this.shadowFrames[index].get(name);
      if (shadowed !== undefined) {
        return shadowed;
      }
    }
    for (let current: PyScope | null = scope; current !== null; current = current.parent) {
      const local = current.locals.get(name);
      if (local !== undefined) {
        return local;
      }
      const definition = current.defs.get(name);
      if (definition !== undefined) {
        return definition.nameSymbol;
      }
    }
    return undefined;
  }

  private lookupLocal(name: string, scope: PyScope): DraftSymbol | undefined {
    for (let index = this.shadowFrames.length - 1; index >= 0; index -= 1) {
      const shadowed = this.shadowFrames[index].get(name);
      if (shadowed !== undefined) {
        return shadowed;
      }
    }
    for (let current: PyScope | null = scope; current !== null; current = current.parent) {
      const symbol = current.locals.get(name);
      if (symbol !== undefined) {
        return symbol;
      }
    }
    return undefined;
  }

  private createLocal(name: string, scope: PyScope): DraftSymbol {
    const existing = scope.locals.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const target = this.node("identifier", []);
    const symbol = this.symbol(`local:${scope.key}:${name}`, "local", scope.key, target);
    (target.fields as Record<string, unknown>).symbol = symbol;
    scope.locals.set(name, symbol);
    return symbol;
  }

  /**
   * Materialize one observed definition from the recorder's private caches, transitively and
   * cycle-safely. Only the reachable closure is ever emitted, so an unused cached helper cannot join
   * the program.
   */
  private materializeHelperDefinition(name: string): PendingDefinition | undefined {
    const memoKey = `definition:${name}`;
    const cached = this.helperDefinitions.get(memoKey);
    if (cached !== undefined) {
      return cached;
    }
    const entry = this.context?.definitions?.find((definition) => definition.name === name);
    if (entry === undefined || entry.source.length === 0) {
      return undefined;
    }
    return this.materializeDefinition(entry.source, name, memoKey, {
      programDigest: entry.programDigest,
      sourceEventId: entry.sourceEventId,
    });
  }

  private materializeModuleMember(
    modulePath: string,
    member: string,
  ): PendingDefinition | undefined {
    const module = this.findKnownModule(modulePath);
    if (module === undefined) {
      return undefined;
    }
    return this.materializeDefinition(module.source, member, `module:${module.path}:${member}`, {
      programDigest: module.programDigest,
      sourceEventId: module.sourceEventId,
    });
  }

  /**
   * Resolve an import specifier against the bounded in-memory known-file map only: an exact match of
   * the module path, its `.py` form, or (for a relative import) its path under `sourcePath`'s
   * directory. No disk access and no package crawling.
   */
  private findKnownModule(modulePath: string): LocalComputationModule | undefined {
    const modules = this.context?.modules ?? [];
    const dotted = modulePath.replace(/\./g, "/");
    const candidates = new Set<string>([modulePath, `${modulePath}.py`, `${dotted}.py`]);
    if (this.context?.sourcePath !== undefined && modulePath.startsWith(".")) {
      const directory = this.context.sourcePath.replace(/[^/]*$/, "");
      const relative = modulePath.replace(/^\.+/, "").replace(/\./g, "/");
      candidates.add(`${directory}${relative}.py`);
      candidates.add(`${directory}${relative}/__init__.py`);
    }
    for (const module of modules) {
      if (module.language === "python" && candidates.has(module.path)) {
        return module;
      }
    }
    return undefined;
  }

  private materializeDefinition(
    source: string,
    name: string,
    memoKey: string,
    provenance: { programDigest?: string; sourceEventId?: string },
  ): PendingDefinition | undefined {
    const placeholder = this.node("function", [], {});
    const scopeKey = this.nextScopeKey();
    const symbol = this.symbol(memoKey, "definition", this.moduleScope.key, placeholder);
    const definition: PendingDefinition = {
      body: placeholder,
      complete: true,
      dependencies: [],
      dependencySet: new Set(),
      key: memoKey,
      kind: "function",
      name,
      nameSymbol: symbol,
      origin: "helper",
      parameters: [],
      programDigest: provenance.programDigest,
      scope: scopeKey,
      sourceEventId: provenance.sourceEventId,
      unsupportedReasons: [],
    };
    (placeholder.fields as Record<string, unknown>).scope = scopeKey;
    (placeholder.fields as Record<string, unknown>).symbol = symbol;
    this.helperDefinitions.set(memoKey, definition);
    this.definitions.push(definition);
    this.pendingBySymbol.set(symbol, definition);
    this.definitionBudget -= 1;
    if (this.definitionBudget < 0) {
      throw new PythonBudgetExceeded("limit_definition");
    }
    const savedSource = this.source;
    const savedTree = this.tree;
    this.helperTargetStack.push({ definition, name });
    try {
      this.source = source;
      this.tree = { topNode: (pythonParser.parse(source) as unknown as PyTree).topNode };
      if (this.hasErrorNode(this.tree.topNode, 0)) {
        definition.complete = false;
        definition.unsupportedReasons.push("incomplete_parse");
        return definition;
      }
      this.frameId += 1;
      this.preScanContainer(this.tree.topNode, this.moduleScope);
      const statements: DraftNode[] = [];
      this.emitStatementsInto(this.tree.topNode, this.moduleScope, statements);
      for (const statement of statements) {
        this.helperRoots.push({
          definition: this.helperBodyByNode.get(statement),
          node: statement,
        });
      }
    } finally {
      this.frameId -= 1;
      this.source = savedSource;
      this.tree = savedTree;
      this.helperTargetStack.pop();
    }
    return definition;
  }

  // --------------------------------------------------------------------------
  // Comprehensions
  // --------------------------------------------------------------------------

  private emitComprehension(
    node: PyNode,
    scope: PyScope,
    compKind: "dict" | "generator" | "list" | "set",
  ): DraftNode {
    const children = pyContentChildren(node);
    const clauseStart = children.findIndex(
      (child) => child.name === "for" || child.name === "async",
    );
    if (clauseStart < 0) {
      return this.unsupported("unsupported_construct");
    }
    const shadow = new Map<string, DraftSymbol>();
    this.shadowFrames.push(shadow);
    try {
      let element: DraftNode;
      if (compKind === "dict") {
        const key = children[0];
        const colon = children.findIndex((child) => child.name === ":");
        const value = colon >= 0 ? children[colon + 1] : undefined;
        if (key === undefined || value === undefined) {
          return this.unsupported("unsupported_construct");
        }
        element = this.emitPair(key, value, scope);
      } else {
        const elementNode = children[0];
        if (elementNode === undefined) {
          return this.unsupported("unsupported_construct");
        }
        element = this.emitExpression(elementNode, scope);
      }
      return this.node(
        "comprehension",
        [element, ...this.emitComprehensionClauses(children, clauseStart, scope, shadow)],
        { compKind },
      );
    } finally {
      this.shadowFrames.pop();
    }
  }

  private emitComprehensionClauses(
    children: readonly PyNode[],
    startIndex: number,
    scope: PyScope,
    shadow?: Map<string, DraftSymbol>,
  ): DraftNode[] {
    const nodes: DraftNode[] = [];
    let index = startIndex;
    while (index < children.length) {
      const child = children[index];
      if (child.name === "async") {
        index += 1;
        continue;
      }
      if (child.name === "for") {
        index += 1;
        const targets: PyNode[] = [];
        while (
          index < children.length &&
          children[index].name !== "in" &&
          children[index].name !== "for" &&
          children[index].name !== "if"
        ) {
          const target = children[index];
          if (
            PY_STRUCTURAL_TOKENS[target.name] !== true &&
            target.name !== "*" &&
            target.name !== "async"
          ) {
            targets.push(target);
          }
          index += 1;
        }
        if (children[index]?.name !== "in") {
          return nodes;
        }
        index += 1;
        const iterable = children[index];
        index += 1;
        const target =
          targets.length === 1
            ? this.emitComprehensionTarget(targets[0], scope, shadow)
            : this.node(
                "tuple",
                targets.map((item) => this.emitComprehensionTarget(item, scope, shadow)),
              );
        nodes.push(
          this.node("for_clause", [
            target,
            iterable === undefined
              ? this.unsupported("unsupported_construct")
              : this.emitExpression(iterable, scope),
          ]),
        );
        continue;
      }
      if (child.name === "if") {
        index += 1;
        const test = children[index];
        index += 1;
        nodes.push(
          this.node("if_clause", [
            test === undefined
              ? this.unsupported("unsupported_construct")
              : this.emitExpression(test, scope),
          ]),
        );
        continue;
      }
      index += 1;
    }
    return nodes;
  }

  /**
   * Comprehension targets are a Python-3 shadowing scope. They reuse the enclosing wire scope (the IR
   * has no comprehension scope) but get their own private symbol, so a shadowing comprehension never
   * merges with an outer binding.
   */
  private emitComprehensionTarget(
    target: PyNode,
    scope: PyScope,
    shadow: Map<string, DraftSymbol> | undefined,
  ): DraftNode {
    if (target.name === "TupleExpression" || target.name === "ArrayExpression") {
      return this.node(
        "tuple",
        pyContentChildren(target).map((element) =>
          this.emitComprehensionTarget(element, scope, shadow),
        ),
      );
    }
    if (target.name !== "VariableName") {
      return this.unsupported("unsupported_construct");
    }
    const name = this.text(target);
    if (shadow === undefined) {
      return this.identifier(this.lookupLocal(name, scope) ?? this.createLocal(name, scope));
    }
    const existing = shadow.get(name);
    if (existing !== undefined) {
      return this.identifier(existing);
    }
    const identifier = this.node("identifier", []);
    const symbol = this.symbol(`shadow:${name}:${target.from}`, "local", scope.key, identifier);
    (identifier.fields as Record<string, unknown>).symbol = symbol;
    shadow.set(name, symbol);
    return identifier;
  }

  /**
   * An inline lambda is a nested scope bound by its own node: its parameters are parameters of that
   * scope, and its reads still belong to the enclosing definition's closure.
   */
  private emitLambda(node: PyNode, scope: PyScope): DraftNode {
    const children = pyChildren(node);
    const params = pyChild(node, "ParamList");
    const colonIndex = children.findIndex((child) => child.name === ":");
    const bodyNode = children
      .slice(colonIndex + 1)
      .find((child) => PY_EXPRESSION_NAMES[child.name] === true);
    const scopeKey = this.nextScopeKey();
    const lambdaNode = this.node("lambda", [], {});
    const nameSymbol = this.symbol(`lambda:${node.from}`, "local", scope.key, lambdaNode);
    (lambdaNode.fields as Record<string, unknown>).scope = scopeKey;
    (lambdaNode.fields as Record<string, unknown>).symbol = nameSymbol;
    const innerScope: PyScope = {
      defs: new Map(),
      key: scopeKey,
      kind: "lambda",
      locals: new Map(),
      owner: scope.owner,
      parent: scope,
    };
    const parameterNodes: DraftNode[] = [];
    if (params !== undefined) {
      for (const child of pyChildren(params)) {
        if (child.name !== "VariableName") {
          continue;
        }
        const name = this.text(child);
        if (innerScope.locals.has(name)) {
          continue;
        }
        const parameter = this.node("parameter", []);
        const symbol = this.symbol(
          `param:${innerScope.key}:${name}`,
          "parameter",
          innerScope.key,
          parameter,
        );
        (parameter.fields as Record<string, unknown>).symbol = symbol;
        innerScope.locals.set(name, symbol);
        parameterNodes.push(parameter);
      }
      this.applyParameterDefaults(params, innerScope, parameterNodes);
    }
    appendChildren(lambdaNode, [
      this.node("parameters", parameterNodes),
      bodyNode === undefined ? pyConstant("null") : this.emitExpression(bodyNode, innerScope),
    ]);
    return lambdaNode;
  }

  // --------------------------------------------------------------------------
  // Output shapes
  // --------------------------------------------------------------------------

  private shapeOf(node: DraftNode): ComputationOutputShape {
    switch (node.kind) {
      case "array":
        return "array";
      case "boolean":
      case "compare":
        return "boolean";
      case "conditional": {
        const alternate = node.children[node.children.length - 1];
        return alternate === undefined ? "unknown" : this.shapeOf(alternate);
      }
      case "literal": {
        const constant = node.fields?.constant;
        if (constant === "true" || constant === "false") {
          return "boolean";
        }
        if (constant === "null") {
          return "null";
        }
        if (constant === "empty_string") {
          return "string";
        }
        if (constant === "one" || constant === "zero") {
          return "number";
        }
        const slot = node.fields?.slot as { kind?: string } | undefined;
        switch (slot?.kind) {
          case "array":
            return "array";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "number":
            return "number";
          case "object":
            return "object";
          case "string":
            return "string";
          default:
            return "unknown";
        }
      }
      case "object":
        return "object";
      case "template":
        return "string";
      case "tuple":
        return "tuple";
      case "unary":
        return node.fields?.operator === "not" ? "boolean" : "number";
      default:
        return "unknown";
    }
  }
}

/**
 * Parse one Python source frame into a bounded, privacy-safe computation program plus the private
 * local bookkeeping the recorder needs to resolve later frames.
 */
export function parsePythonComputation(
  source: string,
  context?: ComputationParseContext,
): ComputationParseResult {
  if (typeof source !== "string" || source.length > MAX_SOURCE_LENGTH) {
    return new PythonFrameAnalyzer("", context).failClosedProgram("limit_serialized_bytes");
  }
  const analyzer = new PythonFrameAnalyzer(source, context);
  try {
    return analyzer.analyze();
  } catch (error) {
    if (error instanceof PythonBudgetExceeded) {
      return analyzer.failClosedProgram(error.reason);
    }
    return analyzer.failClosedProgram("unsupported_construct");
  }
}
