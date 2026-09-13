import {
  COMPUTATION_IR_LIMITS,
  type ComputationAssignOperator,
  type ComputationBinaryOperator,
  type ComputationBooleanOperator,
  type ComputationCompareOperator,
  type ComputationConstant,
  type ComputationOutputShape,
  type ComputationUnaryOperator,
  type ComputationUnsupportedReason,
} from "@resin/contracts";
import ts from "typescript";
import { buildComputationProgramWithKeyMap, draftField, draftNode } from "./builder.js";
import {
  builtinModuleMemberApi,
  constructorApi,
  globalFunctionApi,
  instanceCallApi,
  isKnownGlobalNamespace,
  normalizeBuiltinModule,
  regexArgumentMethodApi,
  regexMethodApi,
  staticCallApi,
} from "./javascript-api.js";
import { MODULE_SCOPE_KEY, draftSlot, draftSymbol } from "./types.js";
import type {
  ComputationParseContext,
  ComputationParseLocal,
  ComputationParseResult,
  DraftNode,
  DraftSlot,
  DraftSymbol,
  LocalComputationModule,
} from "./types.js";

/**
 * JavaScript / TypeScript computation parser.
 *
 * A native JS/TS source frame is read with the TypeScript compiler's own AST (runtime-pure
 * JavaScript: no program creation, no type checking, no disk access, no child process and no
 * execution of anything) and turned into two things:
 *
 *  - a strict, privacy-safe `ComputationProgramV1` built exclusively through the shared draft
 *    builder (this module never assigns a canonical wire id), and
 *  - private local bookkeeping (`ComputationParseResult.local`) holding the source text, the raw
 *    names and the definition provenance the wire program deliberately does not carry.
 *
 * The analysis is real def/use analysis over the parsed tree: module / callable / block scopes,
 * ordered parameters with defaults, stable symbols across one lexical binding (an accumulator update
 * reuses its binding instead of inventing a new variable), destructuring targets materialized one
 * binding each, inline callbacks whose reads stay in the enclosing definition's closure, direct and
 * mutual recursion, immutable local aliases resolved to their definition symbol, C-style loops
 * lowered to an explicit initializer plus a `while` whose body keeps the update, and a statically
 * selected closure of the observed helper definitions/modules this frame actually reaches
 * (transitive and cycle-safe, resolved only against the bounded in-memory parse context).
 *
 * Everything else fails closed with an `unsupported` node and an explicit reason rather than a
 * guess: an unresolved or reassigned callee, an unknown method, reflection, a dynamic import, a
 * construct with no IR shape, or an exceeded pinned limit. No raw name, module path, literal value
 * or source offset ever reaches the program, nothing here reads the filesystem, and a regex literal
 * keeps its pattern and its flags as typed inputs instead of being aliased to a plain string.
 */

// ============================================================================
// Private bookkeeping
// ============================================================================

/** The recorder's per-frame guard; a larger frame is never parsed, it fails closed instead. */
const MAX_SOURCE_LENGTH = 262144;

/**
 * Runaway guards only: the builder owns the pinned node/symbol/slot/definition limits and degrades or
 * rejects on them. These ceilings exist so a pathological frame cannot make the visitor allocate
 * without bound, and they sit above the pinned limits so a program the builder would accept is never
 * discarded here.
 */
const NODE_RUNWAY = COMPUTATION_IR_LIMITS.nodes * 4;
const SYMBOL_RUNWAY = COMPUTATION_IR_LIMITS.symbols * 4;
const SLOT_RUNWAY = COMPUTATION_IR_LIMITS.slots * 4;
const DEFINITION_RUNWAY = COMPUTATION_IR_LIMITS.definitions * 4;
/** Bounded syntactic nesting for the binding pre-scan. */
const MAX_PRESCAN_DEPTH = COMPUTATION_IR_LIMITS.nesting * 4;
/** Bounded nesting of inlined observed helper sources. */
const MAX_HELPER_DEPTH = 8;

type JsLanguage = "javascript" | "typescript";
type JsDefinitionKind = "async_function" | "function" | "generator_function" | "method";
type JsDeclareKind = "const" | "let" | "var";

type TypeScriptSourceFile = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

function parseDiagnosticsOf(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  const parser = ts as typeof ts & {
    getPreParseDiagnostics?: (sourceFile: ts.SourceFile) => readonly ts.Diagnostic[];
  };
  return parser.getPreParseDiagnostics?.(sf) ?? (sf as TypeScriptSourceFile).parseDiagnostics ?? [];
}

type JsSlotKind =
  | "array"
  | "boolean"
  | "bytes"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "unknown";

type JsSlotRole = "dynamic" | "field_key" | "free_variable" | "literal" | "path";

/** One private lexical scope. `key` is device-local bookkeeping and never reaches the wire. */
interface JsScope {
  readonly key: string;
  readonly parent: JsScope | null;
  readonly kind: "block" | "function" | "module";
  /** Non-callable bindings introduced in this scope. */
  readonly locals: Map<string, DraftSymbol>;
  /** Callable bindings declared in this scope (function declarations and `const` callables). */
  readonly defs: Map<string, PendingDefinition>;
  /** Names bound by a form this parser cannot represent as a callable (class/enum/namespace). */
  readonly opaque: Set<string>;
  /** Nearest enclosing definition; reads inside it become that definition's direct dependencies. */
  owner: PendingDefinition | null;
}

/**
 * A definition under construction. Drafts are structurally typed, so the dependency list (only known
 * once the body exists) is filled in during body emission, which is what makes direct and mutual
 * recursion representable without a second canonicalisation pass.
 */
interface PendingDefinition {
  readonly key: string;
  readonly name: string;
  readonly nameSymbol: DraftSymbol;
  readonly body: DraftNode;
  readonly parameters: DraftSymbol[];
  readonly dependencies: DraftSymbol[];
  readonly dependencySet: Set<DraftSymbol>;
  readonly unsupportedReasons: ComputationUnsupportedReason[];
  readonly origin: "authored" | "helper";
  /** The inlined observed source this helper came from, so its data roots travel with it. */
  readonly unitKey?: string;
  sourceEventId?: string;
  programDigest?: string;
  kind: JsDefinitionKind;
  complete: boolean;
}

/** One callable's prepared private state: built once during the binding pre-scan. */
interface CallablePlan {
  readonly scope: JsScope;
  readonly bodyScope?: JsScope;
  readonly parameterNodes: DraftNode[];
  readonly destructuredParameters: { pattern: ts.BindingName; symbol: DraftSymbol }[];
  readonly defaults: { node: DraftNode; initializer: ts.Expression }[];
  readonly definition?: PendingDefinition;
}

/** One inlined observed helper source and the top-level callables it declares. */
interface HelperUnit {
  readonly definitions: Map<string, PendingDefinition>;
}
interface JsOutput {
  readonly node: DraftNode;
  readonly shape: ComputationOutputShape;
  readonly definitionKey?: string;
}

interface JsImportBinding {
  readonly module: string;
  /** `module` keeps the name a namespace object; `member` resolves it to one module member. */
  readonly kind: "member" | "module";
  readonly member?: string;
}

interface JsDefinitionReport {
  readonly name: string;
  readonly source: string;
  readonly references: string[];
  readonly writtenNames: string[];
}

interface JsRootEntry {
  readonly node: DraftNode;
  /** A callable body node, kept only when its definition is dependency-reachable. */
  readonly definition?: PendingDefinition;
  /** The inlined observed source this node came from, for whole-unit inclusion of its data roots. */
  readonly unitKey?: string;
}

/** Raised when a pinned hard limit is exceeded; the frame then fails closed as one bounded program. */
class JsBudgetExceeded extends Error {
  readonly reason: ComputationUnsupportedReason;

  constructor(reason: ComputationUnsupportedReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Names whose invocation or value is reflection and dynamic evaluation. */
const REFLECTION_NAMES: Readonly<Record<string, true>> = {
  Function: true,
  Reflect: true,
  eval: true,
};

/** Assignment roots that mutate state outside the modeled frame. */
const GLOBAL_MUTATION_ROOTS: Readonly<Record<string, true>> = {
  exports: true,
  global: true,
  globalThis: true,
  module: true,
  process: true,
};

function jsConstant(constant: ComputationConstant): DraftNode {
  return draftNode("literal", [], { constant });
}

const TYPEOF_CONSTANTS: Readonly<Record<string, ComputationConstant>> = {
  string: "type_name_string",
  number: "type_name_number",
  boolean: "type_name_boolean",
  object: "type_name_object",
  undefined: "type_name_undefined",
  function: "type_name_function",
  symbol: "type_name_symbol",
  bigint: "type_name_bigint",
};

/**
 * Append to a draft node's children after the node exists.
 *
 * A callable's binding has to create its own node first (that node declares the definition symbol),
 * and a parameter list is only complete once its parameters are walked, so both append to an
 * already-created node. The builder plans drafts after the visitor returns, so the final `children`
 * array is what it sees.
 */
function appendChildren(node: DraftNode, children: readonly DraftNode[]): void {
  (node.children as DraftNode[]).push(...children);
}

/** True for a statement with no runtime effect. */
function isPureTypeStatement(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

function declareKindOf(list: ts.VariableDeclarationList): JsDeclareKind {
  if ((list.flags & ts.NodeFlags.Const) !== 0) {
    return "const";
  }
  return (list.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

/** Definition kind of a callable declaration, from its own syntax rather than from a guess. */
function definitionKindOf(
  node: ts.FunctionLikeDeclaration,
  fallback: JsDefinitionKind,
): JsDefinitionKind {
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
    return "async_function";
  }
  if (ts.isFunctionDeclaration(node) && node.asteriskToken !== undefined) {
    return "generator_function";
  }
  return fallback;
}

/** Names a binding pattern introduces, in source order (`{a: {b}}` introduces `b` only). */
function bindingNames(pattern: ts.BindingName, into: string[] = []): string[] {
  if (ts.isIdentifier(pattern)) {
    into.push(pattern.text);
    return into;
  }
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    bindingNames(element.name, into);
  }
  return into;
}

/** The specifier of a bare one-argument `require("...")` call, or `undefined`. */
function requireSpecifier(call: ts.CallExpression): string | undefined {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "require") {
    return undefined;
  }
  const argument = call.arguments[0];
  return call.arguments.length === 1 && argument !== undefined && ts.isStringLiteral(argument)
    ? argument.text
    : undefined;
}

/** The bounded structural key of a static property name, or `undefined` for a computed key. */
function staticKeyText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** The text of a plain string-literal member selection, or `undefined` for a computed key. */
function staticStringKeyText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** Assignment operators: `=`, the arithmetic forms and the logical-assignment forms. */
function assignmentOperatorOf(kind: ts.SyntaxKind): ComputationAssignOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.EqualsToken:
      return "set";
    case ts.SyntaxKind.PlusEqualsToken:
      return "add";
    case ts.SyntaxKind.MinusEqualsToken:
      return "sub";
    case ts.SyntaxKind.AsteriskEqualsToken:
      return "mul";
    case ts.SyntaxKind.SlashEqualsToken:
      return "div";
    case ts.SyntaxKind.PercentEqualsToken:
      return "mod";
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      return "pow";
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return "shift_left";
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return "shift_right";
    case ts.SyntaxKind.AmpersandEqualsToken:
      return "bit_and";
    case ts.SyntaxKind.BarEqualsToken:
      return "bit_or";
    case ts.SyntaxKind.CaretEqualsToken:
      return "bit_xor";
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
      return "and";
    case ts.SyntaxKind.BarBarEqualsToken:
      return "or";
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return "coalesce";
    default:
      return undefined;
  }
}

function binaryOperatorOf(kind: ts.SyntaxKind): ComputationBinaryOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
      return "add";
    case ts.SyntaxKind.MinusToken:
      return "sub";
    case ts.SyntaxKind.AsteriskToken:
      return "mul";
    case ts.SyntaxKind.SlashToken:
      return "div";
    case ts.SyntaxKind.PercentToken:
      return "mod";
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return "pow";
    case ts.SyntaxKind.LessThanLessThanToken:
      return "shift_left";
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return "shift_right";
    case ts.SyntaxKind.AmpersandToken:
      return "bit_and";
    case ts.SyntaxKind.BarToken:
      return "bit_or";
    case ts.SyntaxKind.CaretToken:
      return "bit_xor";
    default:
      return undefined;
  }
}

function compareOperatorOf(kind: ts.SyntaxKind): ComputationCompareOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return "eq";
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return "ne";
    case ts.SyntaxKind.LessThanToken:
      return "lt";
    case ts.SyntaxKind.LessThanEqualsToken:
      return "le";
    case ts.SyntaxKind.GreaterThanToken:
      return "gt";
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return "ge";
    case ts.SyntaxKind.InKeyword:
      return "in";
    case ts.SyntaxKind.InstanceOfKeyword:
      return "is";
    default:
      return undefined;
  }
}

function prefixOperatorOf(kind: ts.SyntaxKind): ComputationUnaryOperator | undefined {
  switch (kind) {
    case ts.SyntaxKind.ExclamationToken:
      return "not";
    case ts.SyntaxKind.MinusToken:
      return "negate";
    case ts.SyntaxKind.PlusToken:
      return "positive";
    case ts.SyntaxKind.TildeToken:
      return "bit_not";
    default:
      return undefined;
  }
}

/** Names assigned through a destructuring `[...]`/`{...}` assignment target. */
function bindingNamesOfTarget(target: ts.Expression): string[] {
  if (ts.isIdentifier(target)) {
    return [target.text];
  }
  if (ts.isParenthesizedExpression(target)) {
    return bindingNamesOfTarget(target.expression);
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) => bindingNamesOfTarget(element));
  }
  if (ts.isObjectLiteralExpression(target)) {
    const names: string[] = [];
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        names.push(property.name.text);
      } else if (ts.isPropertyAssignment(property)) {
        names.push(...bindingNamesOfTarget(property.initializer));
      }
    }
    return names;
  }
  return [];
}

function rootIdentifierOf(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

// ============================================================================
// Frame analyzer
// ============================================================================

class JavaScriptFrameAnalyzer {
  private readonly context: ComputationParseContext | undefined;
  private readonly language: JsLanguage;
  private readonly moduleScope: JsScope;
  private source: string;
  private sf: ts.SourceFile;
  /** 0 while the authored frame is emitted; raised for each inlined helper frame. */
  private frameId = 0;
  private helperDepth = 0;
  private scopeSequence = 0;
  private depth = 0;
  private scanDepth = 0;
  private nodeBudget = NODE_RUNWAY;
  private symbolBudget = SYMBOL_RUNWAY;
  private slotBudget = SLOT_RUNWAY;
  private definitionBudget = DEFINITION_RUNWAY;
  /** The path relative specifiers inside the frame being emitted resolve against. */
  private activeSourcePath: string | undefined;

  private readonly slotKeys = new Set<string>();
  private readonly roots: DraftNode[] = [];
  private readonly helperRoots: JsRootEntry[] = [];
  private readonly unitKeyStack: string[] = [];
  private readonly definitions: PendingDefinition[] = [];
  private readonly pendingBySymbol = new Map<DraftSymbol, PendingDefinition>();
  private readonly definitionByCallable = new Map<ts.Node, PendingDefinition>();
  private readonly callablePlans = new Map<ts.Node, CallablePlan>();
  private readonly emittedCallables = new Set<ts.Node>();
  private readonly bodyByNode = new Map<DraftNode, PendingDefinition>();
  private readonly helperUnits = new Map<string, HelperUnit>();
  private readonly importBindings = new Map<string, JsImportBinding>();
  private readonly immutableAliases = new Map<DraftSymbol, DraftSymbol>();
  private readonly scopeByNode = new Map<ts.Node, JsScope>();
  private readonly definitionStack: PendingDefinition[] = [];
  private readonly authoredReads = new Set<DraftSymbol>();
  private readonly helperReads = new Set<DraftSymbol>();
  private readonly localDefinitions: JsDefinitionReport[] = [];
  private readonly localImports: { names: string[]; source: string }[] = [];
  private readonly referencedNames: string[] = [];
  private readonly referencedNameSet = new Set<string>();
  private readonly writtenNames: string[] = [];
  private readonly writtenNameSet = new Set<string>();
  private readonly outputs: JsOutput[] = [];
  private keySequence = 0;

  private hasInvocation = false;
  private invalidatesState = false;

  constructor(source: string, context: ComputationParseContext | undefined, language: JsLanguage) {
    this.source = source;
    this.context = context;
    this.language = language;
    this.activeSourcePath = context?.sourcePath;
    this.sf = this.parseSource(source);
    this.moduleScope = {
      defs: new Map(),
      key: MODULE_SCOPE_KEY,
      kind: "module",
      locals: new Map(),
      opaque: new Set(),
      owner: null,
      parent: null,
    };
  }

  /** Parse one frame without building a program: no type checking, no disk access, no execution. */
  private parseSource(source: string): ts.SourceFile {
    return ts.createSourceFile(
      this.language === "typescript" ? "frame.ts" : "frame.mjs",
      source,
      ts.ScriptTarget.Latest,
      false,
      this.language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
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
      throw new JsBudgetExceeded("limit_nodes");
    }
    return fields === undefined
      ? draftNode(kind, [...children])
      : draftNode(kind, [...children], fields);
  }

  private symbol(
    key: string,
    kind: "definition" | "external" | "import" | "local" | "parameter",
    scope: string,
    declaration?: DraftNode,
  ): DraftSymbol {
    this.symbolBudget -= 1;
    if (this.symbolBudget < 0) {
      throw new JsBudgetExceeded("limit_symbols");
    }
    return draftSymbol(key, kind, scope, declaration);
  }

  private literal(key: string, kind: JsSlotKind, role: JsSlotRole): DraftNode {
    if (!this.slotKeys.has(key)) {
      this.slotKeys.add(key);
      this.slotBudget -= 1;
      if (this.slotBudget < 0) {
        throw new JsBudgetExceeded("limit_slots");
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
      throw new JsBudgetExceeded("limit_depth");
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private text(node: ts.Node): string {
    return this.source.slice(node.getStart(this.sf), node.end);
  }

  private nextScopeKey(): string {
    this.scopeSequence += 1;
    return `sc${this.scopeSequence}`;
  }

  private nextKey(prefix: string): string {
    this.keySequence += 1;
    return `${prefix}:${this.keySequence}`;
  }

  private newScope(
    kind: JsScope["kind"],
    parent: JsScope,
    owner: PendingDefinition | null,
  ): JsScope {
    return {
      defs: new Map(),
      key: this.nextScopeKey(),
      kind,
      locals: new Map(),
      opaque: new Set(),
      owner: owner ?? parent.owner,
      parent,
    };
  }

  /** A binding introduced at the frame's own top level (never inside a nested callable). */
  private isFrameModuleScope(scope: JsScope): boolean {
    let current: JsScope | null = scope;
    while (current !== null && current.kind === "block") {
      current = current.parent;
    }
    return current !== null && current.kind === "module" && current === this.moduleScope;
  }

  private noteWrittenName(name: string, scope: JsScope): void {
    if (this.frameId !== 0 || !this.isFrameModuleScope(scope) || this.writtenNameSet.has(name)) {
      return;
    }
    this.writtenNameSet.add(name);
    this.writtenNames.push(name);
  }

  // --------------------------------------------------------------------------
  // Entry point
  // --------------------------------------------------------------------------

  analyze(): ComputationParseResult {
    if (parseDiagnosticsOf(this.sf).length > 0) {
      return this.failClosedProgram("incomplete_parse");
    }
    this.collectContextImports();
    this.collectAuthoredReports();
    this.preScanStatements(this.sf.statements, this.moduleScope);
    this.hasInvocation = this.detectInvocation();
    this.detectStateMutation();
    this.emitStatementsInto(this.sf.statements, this.moduleScope, this.roots);
    this.noteRebinding();
    const kept = this.selectDefinitions();
    // A helper unit's callables are included per reachable definition, but a non-callable top-level
    // statement of a used unit must travel with it: it is the declaration site of the symbols that
    // unit's bodies read, and an unreachable declaration node would orphan those symbols.
    const keptUnits = new Set<string>();
    for (const definition of kept) {
      if (definition.unitKey !== undefined) {
        keptUnits.add(definition.unitKey);
      }
    }
    const roots = [
      ...this.roots,
      ...this.helperRoots
        .filter((entry) =>
          entry.definition === undefined
            ? entry.unitKey === undefined || keptUnits.has(entry.unitKey)
            : kept.has(entry.definition),
        )
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
   * Hand the drafts to the builder, which owns ids, scope numbering, the materialized def/use closure
   * and the reason list: an explicit reason is passed only when the visitor itself reduced the whole
   * frame, and every other reduction is derived from the emitted `unsupported` nodes and incomplete
   * definitions.
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
        unsupportedReasons: definition.unsupportedReasons,
      })),
      language: this.language,
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

  /**
   * Private provenance for every MATERIALIZED wire definition, attributed through the builder's own
   * key map rather than by array-order arithmetic: a definition authored in this frame omits
   * provenance, while an inlined observed helper carries the event and digest it came from.
   */
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
   * value first, then one return/yield per definition. Selecting fewer records never changes
   * structure.
   */
  private selectOutputs(definitionCount: number): readonly JsOutput[] {
    const limit = definitionCount + 1;
    const moduleLevel = this.outputs.filter((output) => output.definitionKey === undefined);
    const perDefinition = new Map<string, JsOutput>();
    for (const output of this.outputs) {
      if (output.definitionKey !== undefined && !perDefinition.has(output.definitionKey)) {
        perDefinition.set(output.definitionKey, output);
      }
    }
    const selected: JsOutput[] = [];
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
    for (const symbol of [...this.authoredReads, ...this.helperReads]) {
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

  private noteRebinding(): void {
    for (const name of this.writtenNames) {
      if (this.context?.definitions?.some((entry) => entry.name === name) === true) {
        this.invalidatesState = true;
      }
      for (const imported of this.context?.imports ?? []) {
        if (imported.names.includes(name)) {
          this.invalidatesState = true;
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Private local bookkeeping
  // --------------------------------------------------------------------------

  private collectContextImports(): void {
    for (const entry of this.context?.imports ?? []) {
      for (const name of entry.names) {
        this.importBindings.set(name, { kind: "member", member: name, module: entry.source });
      }
    }
  }

  private collectAuthoredReports(): void {
    for (const statement of this.sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        this.reportDefinition(statement.name.text, statement, statement);
        continue;
      }
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || initializer === undefined) {
          continue;
        }
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          this.reportDefinition(declaration.name.text, declaration, initializer);
        }
      }
    }
  }

  private reportDefinition(
    name: string,
    declaration: ts.Node,
    callable: ts.FunctionLikeDeclaration,
  ): void {
    const bound = new Set<string>();
    for (const parameter of callable.parameters) {
      for (const parameterName of bindingNames(parameter.name)) {
        bound.add(parameterName);
      }
    }
    const references = new Set<string>();
    const written = new Set<string>();
    this.collectFreeNames(callable, bound, references, written);
    this.localDefinitions.push({
      name,
      references: [...references],
      source: this.text(declaration),
      writtenNames: [...written],
    });
  }

  /**
   * Names a definition reads that it does not bind itself, and names it binds. Both stay local: the
   * recorder uses them to resolve a definition it later observes through the private caches.
   */
  private collectFreeNames(
    node: ts.Node,
    bound: Set<string>,
    references: Set<string>,
    written: Set<string>,
  ): void {
    if (ts.isIdentifier(node)) {
      if (!bound.has(node.text)) {
        references.add(node.text);
      }
      return;
    }
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) {
        bound.add(name);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperatorOf(node.operatorToken.kind) !== undefined
    ) {
      for (const name of bindingNamesOfTarget(node.left)) {
        written.add(name);
        bound.add(name);
      }
    }
    ts.forEachChild(node, (child) => {
      if (ts.isFunctionLike(child)) {
        return;
      }
      this.collectFreeNames(child, bound, references, written);
    });
  }

  private detectInvocation(): boolean {
    for (const statement of this.sf.statements) {
      if (this.statementExecutesCall(statement)) {
        return true;
      }
    }
    return false;
  }

  /**
   * A top-level call is an invocation when it runs as the frame's own code. A function body only
   * authors a callable and a variable initializer only binds a value, so neither makes a
   * definition-only cell look like an invocation.
   */
  private statementExecutesCall(statement: ts.Statement): boolean {
    if (
      ts.isVariableStatement(statement) ||
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      isPureTypeStatement(statement)
    ) {
      return false;
    }
    return this.containsCall(statement);
  }

  private containsCall(node: ts.Node): boolean {
    if (ts.isFunctionLike(node)) {
      return false;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && this.containsCall(child)) {
        found = true;
      }
    });
    return found;
  }

  private detectStateMutation(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isDeleteExpression(node)) {
        this.invalidatesState = true;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (REFLECTION_NAMES[node.expression.text] === true) {
          this.invalidatesState = true;
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        assignmentOperatorOf(node.operatorToken.kind) !== undefined
      ) {
        const root = rootIdentifierOf(node.left);
        if (root !== undefined && GLOBAL_MUTATION_ROOTS[root] === true) {
          this.invalidatesState = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  // --------------------------------------------------------------------------
  // Binding pre-scan
  // --------------------------------------------------------------------------

  private preScanStatements(statements: readonly ts.Statement[], scope: JsScope): void {
    this.scanDepth += 1;
    try {
      if (this.scanDepth > MAX_PRESCAN_DEPTH) {
        throw new JsBudgetExceeded("limit_depth");
      }
      for (const statement of statements) {
        this.preScanStatement(statement, scope);
      }
    } finally {
      this.scanDepth -= 1;
    }
  }

  private preScanStatement(statement: ts.Statement, scope: JsScope): void {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name !== undefined && statement.body !== undefined) {
        const definition = this.registerCallableDefinition(
          statement.name.text,
          statement,
          scope,
          "function",
        );
        this.prepareCallable(statement, scope, definition);
      }
      return;
    }
    if (ts.isImportDeclaration(statement)) {
      this.registerImportBindings(statement, scope);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      this.preScanVariableDeclarationList(statement.declarationList, scope);
      return;
    }
    if (
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name !== undefined && ts.isIdentifier(statement.name)) {
        scope.opaque.add(statement.name.text);
      }
      return;
    }
    if (isPureTypeStatement(statement)) {
      return;
    }
    this.preScanNestedStatement(statement, scope);
  }

  private preScanNestedStatement(statement: ts.Statement, scope: JsScope): void {
    if (ts.isBlock(statement)) {
      const blockScope = this.newScope("block", scope, scope.owner);
      this.scopeByNode.set(statement, blockScope);
      this.preScanStatements(statement.statements, blockScope);
      return;
    }
    if (ts.isIfStatement(statement)) {
      this.preScanNestedStatement(statement.thenStatement, scope);
      if (statement.elseStatement !== undefined) {
        this.preScanNestedStatement(statement.elseStatement, scope);
      }
      return;
    }
    if (ts.isForStatement(statement)) {
      const loopScope = this.newScope("block", scope, scope.owner);
      this.scopeByNode.set(statement, loopScope);
      const initializer = statement.initializer;
      if (initializer !== undefined && ts.isVariableDeclarationList(initializer)) {
        this.preScanVariableDeclarationList(initializer, loopScope);
      }
      this.preScanNestedStatement(statement.statement, loopScope);
      return;
    }
    if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      const loopScope = this.newScope("block", scope, scope.owner);
      this.scopeByNode.set(statement, loopScope);
      if (ts.isVariableDeclarationList(statement.initializer)) {
        this.preScanVariableDeclarationList(statement.initializer, loopScope);
      }
      this.preScanNestedStatement(statement.statement, loopScope);
      return;
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      this.preScanNestedStatement(statement.statement, scope);
      return;
    }
    if (ts.isTryStatement(statement)) {
      this.preScanNestedStatement(statement.tryBlock, scope);
      const catchClause = statement.catchClause;
      if (catchClause !== undefined) {
        const catchScope = this.newScope("block", scope, scope.owner);
        this.scopeByNode.set(catchClause, catchScope);
        const declaration = catchClause.variableDeclaration;
        if (declaration !== undefined) {
          for (const name of bindingNames(declaration.name)) {
            this.registerLocal(name, catchScope);
          }
        }
        this.preScanStatements(catchClause.block.statements, catchScope);
      }
      if (statement.finallyBlock !== undefined) {
        this.preScanNestedStatement(statement.finallyBlock, scope);
      }
      return;
    }
    if (ts.isSwitchStatement(statement)) {
      for (const clause of statement.caseBlock.clauses) {
        this.preScanStatements(clause.statements, scope);
      }
      return;
    }
    if (ts.isLabeledStatement(statement) || ts.isWithStatement(statement)) {
      this.preScanNestedStatement(statement.statement, scope);
    }
  }

  private preScanVariableDeclarationList(list: ts.VariableDeclarationList, scope: JsScope): void {
    const declKind = declareKindOf(list);
    for (const declaration of list.declarations) {
      const initializer = declaration.initializer;
      if (ts.isIdentifier(declaration.name)) {
        if (
          declKind === "const" &&
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          const definition = this.registerCallableDefinition(
            declaration.name.text,
            initializer,
            scope,
            "function",
            "const",
          );
          this.prepareCallable(initializer, scope, definition);
          continue;
        }
        this.registerLocal(declaration.name.text, scope);
        continue;
      }
      for (const name of bindingNames(declaration.name)) {
        this.registerLocal(name, scope);
      }
    }
  }

  private registerLocal(name: string, scope: JsScope): DraftSymbol {
    const existing = scope.locals.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const target = this.node("identifier", []);
    const symbol = this.symbol(`local:${scope.key}:${name}`, "local", scope.key, target);
    (target.fields as Record<string, unknown>).symbol = symbol;
    scope.locals.set(name, symbol);
    this.noteWrittenName(name, scope);
    return symbol;
  }

  /**
   * Register one callable binding.
   *
   * A function declaration binds a definition symbol directly. A `const f = () => ...` keeps a local
   * alias declaration AND a distinct definition symbol owned by the lambda node, so one definition
   * symbol is never declared through two different node kinds while reads of the immutable alias
   * still resolve to that definition. A `let`/`var` callable keeps only its mutable local, so a call
   * through it stays dynamic dispatch and is never guessed.
   */
  private registerCallableDefinition(
    name: string,
    callable: ts.FunctionLikeDeclaration,
    scope: JsScope,
    fallbackKind: JsDefinitionKind,
    declKind?: JsDeclareKind,
  ): PendingDefinition {
    const existing = this.definitionByCallable.get(callable);
    if (existing !== undefined) {
      return existing;
    }
    const previous = scope.defs.get(name);
    if (previous !== undefined) {
      // The same callable name declared twice: the earlier binding stays authoritative for this
      // frame, and the recorder treats the redefinition as an invalidation.
      if (this.frameId === 0) {
        this.invalidatesState = true;
      }
      this.definitionByCallable.set(callable, previous);
      return previous;
    }
    const kind = definitionKindOf(callable, fallbackKind);
    const key = this.nextKey(`def:${callable.getStart(this.sf)}`);
    const callableKind = ts.isFunctionDeclaration(callable) ? "function" : "lambda";
    const unitKey = this.unitKeyStack[this.unitKeyStack.length - 1];
    const functionNode = this.node(callableKind, [], {
      symbol: undefined,
      ...(kind === "async_function" ? { async: true } : {}),
      ...(kind === "generator_function" ? { generator: true } : {}),
      ...(callableKind === "function" ? { defKind: kind } : {}),
    });
    const nameSymbol = this.symbol(key, "definition", scope.key, functionNode);
    (functionNode.fields as Record<string, unknown>).symbol = nameSymbol;
    const definition: PendingDefinition = {
      body: functionNode,
      complete: true,
      dependencies: [],
      dependencySet: new Set(),
      key,
      kind,
      name,
      nameSymbol,
      origin: this.frameId === 0 ? "authored" : "helper",
      parameters: [],
      unsupportedReasons: [],
      ...(unitKey === undefined ? {} : { unitKey }),
    };
    this.definitionByCallable.set(callable, definition);
    this.bodyByNode.set(functionNode, definition);
    scope.defs.set(name, definition);
    this.definitions.push(definition);
    this.pendingBySymbol.set(nameSymbol, definition);
    this.definitionBudget -= 1;
    if (this.definitionBudget < 0) {
      throw new JsBudgetExceeded("limit_definition");
    }
    if (declKind === "const") {
      const aliasTarget = this.node("identifier", []);
      const alias = this.symbol(`alias:${scope.key}:${name}`, "local", scope.key, aliasTarget);
      (aliasTarget.fields as Record<string, unknown>).symbol = alias;
      scope.locals.set(name, alias);
      this.immutableAliases.set(alias, nameSymbol);
    } else {
      scope.locals.set(name, nameSymbol);
    }
    this.noteWrittenName(name, scope);
    return definition;
  }

  /**
   * Build one callable's private scopes exactly once: its parameter bindings, its body block scope
   * and the pre-scan of its body, so every name inside it resolves before it is emitted.
   */
  private prepareCallable(
    callable: ts.FunctionLikeDeclaration,
    parent: JsScope,
    definition: PendingDefinition | undefined,
  ): CallablePlan {
    const existing = this.callablePlans.get(callable);
    if (existing !== undefined) {
      return existing;
    }
    const scope = this.newScope("function", parent, definition ?? null);
    const body = callable.body;
    const bodyScope =
      body !== undefined && ts.isBlock(body)
        ? this.newScope("block", scope, scope.owner)
        : undefined;
    const plan: CallablePlan = {
      bodyScope,
      defaults: [],
      definition,
      destructuredParameters: [],
      parameterNodes: [],
      scope,
    };
    this.callablePlans.set(callable, plan);
    if (bodyScope !== undefined) {
      this.scopeByNode.set(body as ts.Block, bodyScope);
    }
    this.registerParameters(callable, plan);
    if (bodyScope !== undefined && body !== undefined && ts.isBlock(body)) {
      this.preScanStatements(body.statements, bodyScope);
    }
    return plan;
  }

  private registerParameters(callable: ts.FunctionLikeDeclaration, plan: CallablePlan): void {
    const { scope, definition } = plan;
    for (const parameter of callable.parameters) {
      const parameterNode = this.node("parameter", [], {});
      const key = ts.isIdentifier(parameter.name)
        ? `param:${scope.key}:${parameter.name.text}`
        : `param:${scope.key}:${this.nextKey("pattern")}`;
      const symbol = this.symbol(key, "parameter", scope.key, parameterNode);
      (parameterNode.fields as Record<string, unknown>).symbol = symbol;
      (parameterNode.fields as Record<string, unknown>).paramKind =
        parameter.dotDotDotToken !== undefined
          ? "rest_positional"
          : ts.isIdentifier(parameter.name)
            ? "positional"
            : "destructured";
      plan.parameterNodes.push(parameterNode);
      if (parameter.initializer !== undefined) {
        plan.defaults.push({ initializer: parameter.initializer, node: parameterNode });
      }
      if (definition !== undefined) {
        definition.parameters.push(symbol);
      }
      if (ts.isIdentifier(parameter.name)) {
        scope.locals.set(parameter.name.text, symbol);
        continue;
      }
      plan.destructuredParameters.push({ pattern: parameter.name, symbol });
      // The destructured names are bound by the parameter, but they are read in the body scope, so
      // they must be registered there or the prologue would invent a second binding for them.
      const bindingScope = plan.bodyScope ?? scope;
      for (const name of bindingNames(parameter.name)) {
        this.registerLocal(name, bindingScope);
      }
    }
  }

  private registerImportBindings(declaration: ts.ImportDeclaration, scope: JsScope): void {
    const specifier = declaration.moduleSpecifier;
    const clause = declaration.importClause;
    if (!ts.isStringLiteral(specifier) || clause === undefined || clause.isTypeOnly) {
      return;
    }
    const module = specifier.text;
    const names: string[] = [];
    if (clause.name !== undefined) {
      this.importBindings.set(clause.name.text, { kind: "member", member: "default", module });
      names.push(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      this.importBindings.set(bindings.name.text, { kind: "module", member: module, module });
      names.push(bindings.name.text);
    } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const local = element.name.text;
        this.importBindings.set(local, {
          kind: "member",
          member: (element.propertyName ?? element.name).text,
          module,
        });
        names.push(local);
      }
    }
    for (const name of names) {
      this.noteWrittenName(name, scope);
    }
    if (this.frameId === 0 && names.length > 0) {
      this.localImports.push({ names, source: module });
    }
  }

  // --------------------------------------------------------------------------
  // Statements
  // --------------------------------------------------------------------------

  private emitStatementsInto(
    statements: readonly ts.Statement[],
    scope: JsScope,
    into: DraftNode[],
  ): void {
    for (const statement of statements) {
      const emitted = this.emitStatement(statement, scope);
      if (emitted !== null) {
        into.push(emitted);
      }
    }
  }

  /** A single-statement body is that statement; anything longer is an ordered block. */
  private emitBody(statements: readonly ts.Statement[], scope: JsScope): DraftNode {
    const emitted: DraftNode[] = [];
    this.emitStatementsInto(statements, scope, emitted);
    return emitted.length === 1 ? emitted[0] : this.node("block", emitted);
  }

  private emitNestedStatement(statement: ts.Statement, scope: JsScope): DraftNode {
    if (ts.isBlock(statement)) {
      return this.emitBody(statement.statements, this.scopeByNode.get(statement) ?? scope);
    }
    const emitted = this.emitStatement(statement, scope);
    return emitted ?? this.node("block", []);
  }

  private emitStatement(statement: ts.Statement, scope: JsScope): DraftNode | null {
    if (ts.isFunctionDeclaration(statement)) {
      return this.emitFunctionDeclaration(statement, scope);
    }
    this.enter();
    try {
      if (ts.isBlock(statement)) {
        return this.emitBody(statement.statements, this.scopeByNode.get(statement) ?? scope);
      }
      if (ts.isVariableStatement(statement)) {
        const nodes = this.emitVariableDeclarationList(statement.declarationList, scope);
        if (nodes.length === 0) {
          return null;
        }
        return nodes.length === 1 ? nodes[0] : this.node("block", nodes);
      }
      if (ts.isExpressionStatement(statement)) {
        return this.emitExpressionStatement(statement.expression, scope);
      }
      if (ts.isReturnStatement(statement)) {
        return this.emitReturn(statement, scope);
      }
      if (ts.isIfStatement(statement)) {
        const alternate = statement.elseStatement;
        return this.node("if", [
          this.emitExpression(statement.expression, scope),
          this.emitNestedStatement(statement.thenStatement, scope),
          ...(alternate === undefined ? [] : [this.emitNestedStatement(alternate, scope)]),
        ]);
      }
      if (ts.isForStatement(statement)) {
        return this.emitForStatement(statement, scope);
      }
      if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
        return this.emitForInOfStatement(statement, scope);
      }
      if (ts.isWhileStatement(statement)) {
        return this.node("while", [
          this.emitExpression(statement.expression, scope),
          this.emitNestedStatement(statement.statement, scope),
        ]);
      }
      if (ts.isDoStatement(statement)) {
        // A do/while body runs before its test, which the IR cannot express without emitting the body
        // twice (and one draft node is not a tree), so this form fails closed.
        return this.unsupported("unsupported_construct", [
          this.emitExpression(statement.expression, scope),
          this.emitNestedStatement(statement.statement, scope),
        ]);
      }
      if (ts.isTryStatement(statement)) {
        return this.emitTryStatement(statement, scope);
      }
      if (ts.isThrowStatement(statement)) {
        return statement.expression === undefined
          ? this.unsupported("unsupported_construct")
          : this.node("throw", [this.emitExpression(statement.expression, scope)]);
      }
      if (ts.isBreakStatement(statement)) {
        return statement.label === undefined
          ? this.node("break")
          : this.unsupported("unsupported_construct");
      }
      if (ts.isContinueStatement(statement)) {
        return statement.label === undefined
          ? this.node("continue")
          : this.unsupported("unsupported_construct");
      }
      if (ts.isSwitchStatement(statement)) {
        return this.unsupported("unsupported_construct", [
          this.emitExpression(statement.expression, scope),
          ...statement.caseBlock.clauses.map((clause) => this.emitBody(clause.statements, scope)),
        ]);
      }
      if (ts.isLabeledStatement(statement) || ts.isWithStatement(statement)) {
        return this.unsupported("unsupported_construct", [
          this.emitNestedStatement(statement.statement, scope),
        ]);
      }
      if (
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isDebuggerStatement(statement) ||
        ts.isEmptyStatement(statement) ||
        isPureTypeStatement(statement)
      ) {
        return null;
      }
      if (ts.isExportAssignment(statement)) {
        return this.emitExpressionStatement(statement.expression, scope);
      }
      if (ts.isImportEqualsDeclaration(statement)) {
        return this.unsupported("unsupported_api");
      }
      return this.unsupported("unsupported_construct");
    } finally {
      this.leave();
    }
  }

  private emitFunctionDeclaration(
    statement: ts.FunctionDeclaration,
    scope: JsScope,
  ): DraftNode | null {
    if (statement.body === undefined) {
      // An overload signature authors no runtime callable, so it contributes no node.
      return null;
    }
    const definition = this.definitionByCallable.get(statement);
    if (definition === undefined) {
      return this.unsupported("unsupported_construct");
    }
    return this.emitCallable(statement, this.prepareCallable(statement, scope, definition));
  }

  private emitCallable(callable: ts.FunctionLikeDeclaration, plan: CallablePlan): DraftNode {
    const definition = plan.definition;
    if (
      this.emittedCallables.has(callable) ||
      (definition !== undefined && definition.body.children.length > 0)
    ) {
      // One callable node owns at most one definition body: a re-visit or a re-declaration of the
      // same name fails closed rather than appending a second parameter/body pair to that node
      // (which would leave a callable with the wrong child arity).
      return this.unsupported("unsupported_construct");
    }
    this.emittedCallables.add(callable);
    const scope = plan.bodyScope ?? plan.scope;
    for (const entry of plan.defaults) {
      appendChildren(entry.node, [this.emitExpression(entry.initializer, plan.scope)]);
    }
    const prologue = plan.destructuredParameters.map((entry) =>
      this.node(
        "assign",
        [
          this.emitBindingTarget(entry.pattern, scope, "const"),
          this.node("identifier", [], { symbol: entry.symbol }),
        ],
        { operator: "set" },
      ),
    );
    const pushed = definition !== undefined;
    if (definition !== undefined) {
      this.definitionStack.push(definition);
    }
    let bodyDraft: DraftNode;
    try {
      bodyDraft = this.emitCallableBody(callable, plan, prologue);
    } finally {
      if (pushed) {
        this.definitionStack.pop();
      }
    }
    if (definition === undefined) {
      return bodyDraft;
    }
    appendChildren(definition.body, [this.node("parameters", plan.parameterNodes), bodyDraft]);
    return definition.body;
  }

  private emitCallableBody(
    callable: ts.FunctionLikeDeclaration,
    plan: CallablePlan,
    prologue: readonly DraftNode[],
  ): DraftNode {
    const body = callable.body;
    if (ts.isArrowFunction(callable) && body !== undefined && !ts.isBlock(body)) {
      if (prologue.length > 0) {
        // A destructured parameter needs a statement prologue, which an expression body cannot hold.
        return this.unsupported("unsupported_construct", [this.emitExpression(body, plan.scope)]);
      }
      return this.emitExpression(body, plan.scope);
    }
    const scope = plan.bodyScope ?? plan.scope;
    const emitted: DraftNode[] = [...prologue];
    if (body !== undefined && ts.isBlock(body)) {
      this.emitStatementsInto(body.statements, scope, emitted);
    }
    // A single-statement body is that statement, exactly as the wire semantics allow
    // (`function`/`lambda` children are `[parameters, body]`); only a real sequence becomes a block.
    return emitted.length === 1 ? emitted[0] : this.node("block", emitted);
  }

  private emitVariableDeclarationList(
    list: ts.VariableDeclarationList,
    scope: JsScope,
  ): DraftNode[] {
    const declKind = declareKindOf(list);
    const emitted: DraftNode[] = [];
    for (const declaration of list.declarations) {
      const node = this.emitVariableDeclaration(declaration, scope, declKind);
      if (node !== null) {
        emitted.push(node);
      }
    }
    return emitted;
  }

  private emitVariableDeclaration(
    declaration: ts.VariableDeclaration,
    scope: JsScope,
    declKind: JsDeclareKind,
  ): DraftNode | null {
    const initializer = declaration.initializer;
    if (!ts.isIdentifier(declaration.name)) {
      if (initializer === undefined) {
        return this.unsupported("unsupported_construct");
      }
      return this.node(
        "assign",
        [
          this.emitBindingTarget(declaration.name, scope, declKind),
          this.emitExpression(initializer, scope),
        ],
        { operator: "set" },
      );
    }
    const symbol =
      scope.locals.get(declaration.name.text) ?? this.registerLocal(declaration.name.text, scope);
    if (initializer === undefined) {
      return this.node("declare", [], { declKind, symbol });
    }
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      const definition = this.definitionByCallable.get(initializer);
      const value =
        definition === undefined
          ? this.emitInlineCallable(initializer, scope)
          : this.emitCallable(initializer, this.prepareCallable(initializer, scope, definition));
      return this.node("declare", [value], { declKind, symbol });
    }
    return this.node("declare", [this.emitExpression(initializer, scope)], { declKind, symbol });
  }

  /** A module handle is a nonserializable private value, so only its type survives as an input. */
  private moduleHandleRead(specifier: string): DraftNode {
    const module = normalizeBuiltinModule(specifier);
    return module === undefined
      ? this.literal(`free:module:${specifier}`, "unknown", "free_variable")
      : this.literal(`free:module:${module}`, "object", "free_variable");
  }

  private emitExpressionStatement(expression: ts.Expression, scope: JsScope): DraftNode {
    const update =
      ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)
        ? this.emitUpdateStatement(expression, scope)
        : undefined;
    const value = update ?? this.emitExpression(expression, scope);
    if (this.frameId !== 0 || !this.isFrameModuleScope(scope)) {
      // Only the frame's own top-level statements are emitted values; a statement inside a body is
      // already an ordered child of its block, so wrapping it would add a node without meaning.
      return value;
    }
    const wrapped = this.node("expression", [value]);
    this.outputs.push({ node: wrapped, shape: this.shapeOf(value) });
    return wrapped;
  }

  private emitReturn(statement: ts.ReturnStatement, scope: JsScope): DraftNode {
    if (statement.expression === undefined) {
      return this.node("return", []);
    }
    const value = this.emitExpression(statement.expression, scope);
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

  private emitTryStatement(statement: ts.TryStatement, scope: JsScope): DraftNode {
    const parts: DraftNode[] = [this.emitNestedStatement(statement.tryBlock, scope)];
    const catchClause = statement.catchClause;
    if (catchClause !== undefined) {
      const catchScope = this.scopeByNode.get(catchClause) ?? scope;
      const body = this.emitBody(catchClause.block.statements, catchScope);
      const declaration = catchClause.variableDeclaration;
      if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
        const symbol =
          catchScope.locals.get(declaration.name.text) ??
          this.registerLocal(declaration.name.text, catchScope);
        parts.push(this.node("catch", [body], { symbol }));
      } else {
        parts.push(this.node("catch", [body]));
      }
    }
    if (statement.finallyBlock !== undefined) {
      parts.push(this.node("finally", [this.emitNestedStatement(statement.finallyBlock, scope)]));
    }
    return this.node("try", parts);
  }

  /**
   * C-style loops lower to an explicit initializer plus a `while` whose body ends with the update, so
   * initializer, test and increment all survive. `continue` would skip that trailing update, so a
   * loop whose own level contains `continue` fails closed instead of silently changing the algorithm.
   */
  private emitForStatement(statement: ts.ForStatement, scope: JsScope): DraftNode {
    const loopScope = this.scopeByNode.get(statement) ?? scope;
    if (this.hasOwnLevelContinue(statement.statement)) {
      return this.unsupported("unsupported_construct", [
        this.emitNestedStatement(statement.statement, loopScope),
      ]);
    }
    const parts: DraftNode[] = [];
    const initializer = statement.initializer;
    if (initializer !== undefined) {
      if (ts.isVariableDeclarationList(initializer)) {
        parts.push(...this.emitVariableDeclarationList(initializer, loopScope));
      } else {
        parts.push(
          this.emitUpdateStatement(initializer, loopScope) ??
            this.emitExpression(initializer, loopScope),
        );
      }
    }
    const test =
      statement.condition === undefined
        ? jsConstant("true")
        : this.emitExpression(statement.condition, loopScope);
    const bodyNodes: DraftNode[] = [];
    const body = statement.statement;
    if (ts.isBlock(body)) {
      this.emitStatementsInto(body.statements, this.scopeByNode.get(body) ?? loopScope, bodyNodes);
    } else {
      const emitted = this.emitStatement(body, loopScope);
      if (emitted !== null) {
        bodyNodes.push(emitted);
      }
    }
    const incrementor = statement.incrementor;
    if (incrementor !== undefined) {
      bodyNodes.push(
        this.emitUpdateStatement(incrementor, loopScope) ??
          this.emitExpression(incrementor, loopScope),
      );
    }
    parts.push(this.node("while", [test, this.node("block", bodyNodes)]));
    return parts.length === 1 ? parts[0] : this.node("block", parts);
  }

  private emitForInOfStatement(
    statement: ts.ForInStatement | ts.ForOfStatement,
    scope: JsScope,
  ): DraftNode {
    const loopScope = this.scopeByNode.get(statement) ?? scope;
    const initializer = statement.initializer;
    if (ts.isVariableDeclarationList(initializer) && initializer.declarations.length === 0) {
      return this.unsupported("unsupported_construct");
    }
    const target = ts.isVariableDeclarationList(initializer)
      ? this.emitBindingTarget(
          (initializer.declarations[0] as ts.VariableDeclaration).name,
          loopScope,
          declareKindOf(initializer),
        )
      : this.emitAssignmentPlace(initializer, loopScope);
    const fields: Record<string, unknown> =
      ts.isForOfStatement(statement) && statement.awaitModifier !== undefined
        ? { async: true }
        : {};
    return this.node(
      "for",
      [
        target,
        this.emitExpression(statement.expression, loopScope),
        this.emitNestedStatement(statement.statement, loopScope),
      ],
      fields,
    );
  }

  /**
   * A standalone increment/decrement lowers to an assignment by one, the statement-position form. A
   * value-producing update cannot keep its old value in the IR, so it fails closed there.
   */
  private emitUpdateStatement(expression: ts.Expression, scope: JsScope): DraftNode | undefined {
    if (!ts.isPostfixUnaryExpression(expression) && !ts.isPrefixUnaryExpression(expression)) {
      return undefined;
    }
    const kind = expression.operator;
    if (kind !== ts.SyntaxKind.PlusPlusToken && kind !== ts.SyntaxKind.MinusMinusToken) {
      return undefined;
    }
    const target = expression.operand;
    if (
      ts.isIdentifier(target) ||
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    ) {
      return this.node("assign", [this.emitAssignmentPlace(target, scope), jsConstant("one")], {
        operator: kind === ts.SyntaxKind.PlusPlusToken ? "add" : "sub",
      });
    }
    return this.unsupported("unsupported_construct", [this.emitExpression(target, scope)]);
  }

  /** True when `continue` targets this loop's own level (an inner loop owns its own `continue`). */
  private hasOwnLevelContinue(node: ts.Node): boolean {
    if (ts.isFunctionLike(node)) {
      return false;
    }
    if (ts.isContinueStatement(node)) {
      return true;
    }
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      return false;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && this.hasOwnLevelContinue(child)) {
        found = true;
      }
    });
    return found;
  }

  // --------------------------------------------------------------------------
  // Binding targets
  // --------------------------------------------------------------------------

  /**
   * Materialize every binding a pattern introduces instead of leaving unexplained external state:
   * each name becomes a `declare` node, the declaration site a later read resolves to.
   */
  private emitBindingTarget(
    pattern: ts.BindingName,
    scope: JsScope,
    declKind: JsDeclareKind,
  ): DraftNode {
    if (ts.isIdentifier(pattern)) {
      const symbol = scope.locals.get(pattern.text) ?? this.registerLocal(pattern.text, scope);
      return this.node("declare", [], { declKind, symbol });
    }
    if (ts.isObjectBindingPattern(pattern)) {
      const pairs: DraftNode[] = [];
      for (const element of pattern.elements) {
        const target = this.emitBindingTarget(element.name, scope, declKind);
        if (element.dotDotDotToken !== undefined) {
          pairs.push(this.node("spread", [target], { spreadKind: "mapping" }));
          continue;
        }
        const key = element.propertyName ?? element.name;
        const keyText = staticKeyText(key);
        pairs.push(
          this.node(
            "pair",
            [target],
            keyText === undefined
              ? { fieldSlot: this.dynamicKeySlot(key) }
              : { ...draftField(keyText, `field:${keyText}`) },
          ),
        );
      }
      return this.node("object", pairs);
    }
    const elements: DraftNode[] = [];
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      elements.push(this.emitBindingTarget(element.name, scope, declKind));
    }
    return this.node("array", elements);
  }

  /**
   * A dynamic/computed key is a typed input, never a retained raw key: it becomes a field-key slot so
   * the algorithm still records that a key was selected dynamically without carrying its text.
   */
  private dynamicKeySlot(node: ts.Node): DraftSlot {
    return draftSlot(`dyn:${node.getStart(this.sf)}:${this.nextKey("key")}`, "string", "field_key");
  }

  private identifier(symbol: DraftSymbol): DraftNode {
    this.useDefinition(symbol);
    return this.node("identifier", [], { symbol });
  }

  /**
   * Record that a definition symbol is read. A read in the authored frame seeds the materialized
   * closure, and a read inside a callable becomes that definition's direct dependency, which is what
   * the wire contract recomputes from the emitted read sites — including a read inside an inline
   * callback, which stays in the enclosing definition's closure.
   */
  private useDefinition(symbol: DraftSymbol): void {
    if (symbol.kind !== "definition") {
      return;
    }
    if (this.frameId === 0) {
      this.authoredReads.add(symbol);
    } else {
      this.helperReads.add(symbol);
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

  /** Destination of an assignment that is not a binding declaration (`row[key] = ...`). */
  private emitAssignmentPlace(expression: ts.Expression, scope: JsScope): DraftNode {
    if (ts.isIdentifier(expression)) {
      return this.identifier(
        scope.locals.get(expression.text) ?? this.registerLocal(expression.text, scope),
      );
    }
    return this.emitExpression(expression, scope);
  }

  // --------------------------------------------------------------------------
  // Expressions
  // --------------------------------------------------------------------------

  private emitExpression(node: ts.Expression | undefined, scope: JsScope): DraftNode {
    if (node === undefined) {
      return this.unsupported("unsupported_construct");
    }
    this.enter();
    try {
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isPartiallyEmittedExpression(node)
      ) {
        return this.emitExpression(node.expression, scope);
      }
      if (ts.isIdentifier(node)) {
        return this.emitNameRead(node.text, scope);
      }
      if (node.kind === ts.SyntaxKind.TrueKeyword) {
        return jsConstant("true");
      }
      if (node.kind === ts.SyntaxKind.FalseKeyword) {
        return jsConstant("false");
      }
      if (node.kind === ts.SyntaxKind.NullKeyword) {
        return jsConstant("null");
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        return this.literal("free:this", "object", "free_variable");
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text.length === 0
          ? jsConstant("empty_string")
          : this.literal(`str:${node.text}`, "string", "literal");
      }
      if (ts.isNumericLiteral(node)) {
        if (node.text === "0") {
          return jsConstant("zero");
        }
        return node.text === "1"
          ? jsConstant("one")
          : this.literal(`num:${node.text}`, "number", "literal");
      }
      if (ts.isBigIntLiteral(node)) {
        return this.literal(`bigint:${node.text}`, "number", "literal");
      }
      if (ts.isRegularExpressionLiteral(node)) {
        return this.emitRegularExpression(node);
      }
      if (ts.isTemplateExpression(node)) {
        return this.emitTemplate(node, scope);
      }
      if (ts.isArrayLiteralExpression(node)) {
        return this.node(
          "array",
          node.elements.map((element) =>
            ts.isSpreadElement(element)
              ? this.node("spread", [this.emitExpression(element.expression, scope)], {
                  spreadKind: "iterable",
                })
              : this.emitExpression(element, scope),
          ),
        );
      }
      if (ts.isObjectLiteralExpression(node)) {
        return this.emitObjectLiteral(node, scope);
      }
      if (ts.isPropertyAccessExpression(node)) {
        return this.emitMemberRead(node, scope);
      }
      if (ts.isElementAccessExpression(node)) {
        return this.emitElementAccess(node, scope);
      }
      if (ts.isCallExpression(node)) {
        return this.emitCall(node, scope);
      }
      if (ts.isNewExpression(node)) {
        return this.emitNew(node, scope);
      }
      if (ts.isBinaryExpression(node)) {
        return this.emitBinary(node, scope);
      }
      if (ts.isPrefixUnaryExpression(node)) {
        return this.emitPrefixUnary(node, scope);
      }
      if (ts.isPostfixUnaryExpression(node)) {
        // A value-producing update cannot preserve its old value: fail closed rather than reorder.
        return this.unsupported("unsupported_construct", [
          this.emitExpression(node.operand, scope),
        ]);
      }
      if (ts.isConditionalExpression(node)) {
        return this.node("conditional", [
          this.emitExpression(node.condition, scope),
          this.emitExpression(node.whenTrue, scope),
          this.emitExpression(node.whenFalse, scope),
        ]);
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return this.emitInlineCallable(node, scope);
      }
      if (ts.isAwaitExpression(node)) {
        return this.node("await", [this.emitExpression(node.expression, scope)]);
      }
      if (ts.isYieldExpression(node)) {
        const value =
          node.expression === undefined ? undefined : this.emitExpression(node.expression, scope);
        const yieldNode =
          value === undefined ? this.node("yield", []) : this.node("yield", [value]);
        if (value !== undefined && scope.owner !== null) {
          this.outputs.push({
            definitionKey: scope.owner.key,
            node: yieldNode,
            shape: this.shapeOf(value),
          });
        }
        return yieldNode;
      }
      if (ts.isTypeOfExpression(node)) {
        return this.node("call", [this.emitExpression(node.expression, scope)], {
          api: "core.type_of",
        });
      }
      if (ts.isDeleteExpression(node)) {
        this.invalidatesState = true;
        return this.unsupported("unsupported_hidden_state", [
          this.emitExpression(node.expression, scope),
        ]);
      }
      if (ts.isSpreadElement(node)) {
        return this.node("spread", [this.emitExpression(node.expression, scope)], {
          spreadKind: "iterable",
        });
      }
      if (ts.isTaggedTemplateExpression(node)) {
        return this.unsupported("unsupported_construct", [
          this.emitExpression(node.template, scope),
        ]);
      }
      return this.unsupported("unsupported_construct");
    } finally {
      this.leave();
    }
  }

  /**
   * A regex literal keeps its pattern and its flags as two typed inputs, so a flags change is an
   * algorithm change and the pattern never collapses into an ordinary string.
   */
  private emitRegularExpression(node: ts.RegularExpressionLiteral): DraftNode {
    const text = this.text(node);
    const lastSlash = text.lastIndexOf("/");
    const pattern = text.slice(1, lastSlash);
    const flags = text.slice(lastSlash + 1);
    return this.node(
      "call",
      [
        this.literal(`re:${pattern}`, "string", "literal"),
        flags.length === 0
          ? jsConstant("empty_string")
          : this.literal(`reflags:${flags}`, "string", "literal"),
      ],
      { api: "text.regex_compile" },
    );
  }

  private emitTemplate(node: ts.TemplateExpression, scope: JsScope): DraftNode {
    const children: DraftNode[] = [this.templateChunk(node.head.text)];
    for (const span of node.templateSpans) {
      children.push(this.emitExpression(span.expression, scope));
      children.push(this.templateChunk(span.literal.text));
    }
    return this.node("template", children, { templateKind: "template_literal" });
  }

  private templateChunk(text: string): DraftNode {
    return text.length === 0
      ? jsConstant("empty_string")
      : this.literal(`tpl:${text}`, "string", "literal");
  }

  private emitObjectLiteral(node: ts.ObjectLiteralExpression, scope: JsScope): DraftNode {
    const pairs: DraftNode[] = [];
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        pairs.push(
          this.node("spread", [this.emitExpression(property.expression, scope)], {
            spreadKind: "mapping",
          }),
        );
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const name = property.name.text;
        pairs.push(
          this.node("pair", [this.emitNameRead(name, scope)], {
            ...draftField(name, `field:${name}`),
          }),
        );
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        pairs.push(
          this.objectPair(property.name, this.emitExpression(property.initializer, scope)),
        );
        continue;
      }
      if (
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        pairs.push(this.objectPair(property.name, this.emitInlineCallable(property, scope)));
        continue;
      }
      pairs.push(this.unsupported("unsupported_construct"));
    }
    return this.node("object", pairs);
  }

  private objectPair(key: ts.Node, value: DraftNode): DraftNode {
    const keyText = staticKeyText(key);
    return this.node(
      "pair",
      [value],
      keyText === undefined
        ? { fieldSlot: this.dynamicKeySlot(key) }
        : { ...draftField(keyText, `field:${keyText}`) },
    );
  }

  private emitMemberRead(node: ts.PropertyAccessExpression, scope: JsScope): DraftNode {
    const base = node.expression;
    const name = node.name.text;
    // A local binding always wins over a same-named global namespace or module alias.
    if (ts.isIdentifier(base) && this.resolveBoundName(base.text, scope) === undefined) {
      if (base.text === "process" && name === "argv") {
        return this.literal("free:process.argv", "array", "free_variable");
      }
      if (this.importBindings.has(base.text) || isKnownGlobalNamespace(base.text)) {
        // A recognized namespace attribute read that is not a finite API call is data from outside
        // the captured program, never a module or namespace name on the wire.
        return this.unsupported("unsupported_api");
      }
    }
    if (ts.isCallExpression(base)) {
      const specifier = requireSpecifier(base);
      if (specifier !== undefined) {
        return this.moduleHandleRead(specifier);
      }
    }
    return this.node("member", [this.emitExpression(base, scope)], {
      ...draftField(name, `field:${name}`),
    });
  }

  private emitElementAccess(node: ts.ElementAccessExpression, scope: JsScope): DraftNode {
    const argument = node.argumentExpression;
    const keyText = argument === undefined ? undefined : staticStringKeyText(argument);
    if (keyText !== undefined) {
      // A static string key is a structural selection: a safe key survives as a field name and an
      // unsafe one becomes a field slot rather than a retained value.
      return this.node("member", [this.emitExpression(node.expression, scope)], {
        ...draftField(keyText, `field:${keyText}`),
      });
    }
    if (argument === undefined) {
      return this.unsupported("unsupported_construct", [
        this.emitExpression(node.expression, scope),
      ]);
    }
    return this.node("index", [
      this.emitExpression(node.expression, scope),
      this.emitExpression(argument, scope),
    ]);
  }

  private emitNew(node: ts.NewExpression, scope: JsScope): DraftNode {
    const args = (node.arguments ?? []).map((argument) =>
      ts.isSpreadElement(argument)
        ? this.node("spread", [this.emitExpression(argument.expression, scope)], {
            spreadKind: "iterable",
          })
        : this.emitExpression(argument, scope),
    );
    const api = ts.isIdentifier(node.expression) ? constructorApi(node.expression.text) : undefined;
    return api === undefined
      ? this.unsupported("unsupported_api", args)
      : this.node("new", args, { api });
  }

  private emitBinary(node: ts.BinaryExpression, scope: JsScope): DraftNode {
    const kind = node.operatorToken.kind;
    const assignment = assignmentOperatorOf(kind);
    if (assignment !== undefined) {
      return this.node(
        "assign",
        [this.emitAssignmentPlace(node.left, scope), this.emitExpression(node.right, scope)],
        { operator: assignment },
      );
    }
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return this.emitLogicalChain(node, scope, kind);
    }
    if (compareOperatorOf(kind) !== undefined) {
      return this.emitComparison(node, scope);
    }
    const operator = binaryOperatorOf(kind);
    if (operator === undefined) {
      return this.unsupported("unsupported_operator", [
        this.emitExpression(node.left, scope),
        this.emitExpression(node.right, scope),
      ]);
    }
    return this.node(
      "binary",
      [this.emitExpression(node.left, scope), this.emitExpression(node.right, scope)],
      { operator },
    );
  }

  /**
   * JavaScript comparisons remain binary: `a < b < c` compares a Boolean to c, unlike a Python
   * chained comparison. Only a literal compared directly with typeof denotes an intrinsic type name.
   */
  private emitComparison(node: ts.BinaryExpression, scope: JsScope): DraftNode {
    const operator = compareOperatorOf(node.operatorToken.kind);
    if (operator === undefined) {
      return this.unsupported("unsupported_construct", [
        this.emitExpression(node.left, scope),
        this.emitExpression(node.right, scope),
      ]);
    }
    let left = node.left;
    let right = node.right;
    while (ts.isParenthesizedExpression(left)) {
      left = left.expression;
    }
    while (ts.isParenthesizedExpression(right)) {
      right = right.expression;
    }
    const equality =
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const leftType =
      equality &&
      ts.isTypeOfExpression(right) &&
      ts.isStringLiteral(left) &&
      Object.hasOwn(TYPEOF_CONSTANTS, left.text)
        ? TYPEOF_CONSTANTS[left.text]
        : undefined;
    const rightType =
      equality &&
      ts.isTypeOfExpression(left) &&
      ts.isStringLiteral(right) &&
      Object.hasOwn(TYPEOF_CONSTANTS, right.text)
        ? TYPEOF_CONSTANTS[right.text]
        : undefined;
    return this.node(
      "compare",
      [
        leftType === undefined ? this.emitExpression(node.left, scope) : jsConstant(leftType),
        rightType === undefined ? this.emitExpression(node.right, scope) : jsConstant(rightType),
      ],
      { operators: [operator] },
    );
  }

  private emitLogicalChain(
    node: ts.BinaryExpression,
    scope: JsScope,
    kind: ts.SyntaxKind,
  ): DraftNode {
    const operator: ComputationBooleanOperator =
      kind === ts.SyntaxKind.QuestionQuestionToken
        ? "coalesce"
        : kind === ts.SyntaxKind.AmpersandAmpersandToken
          ? "and"
          : "or";
    const left =
      ts.isBinaryExpression(node.left) && node.left.operatorToken.kind === kind
        ? this.emitLogicalChain(node.left, scope, kind)
        : undefined;
    const children =
      left === undefined ? [this.emitExpression(node.left, scope)] : [...left.children];
    const operators: ComputationBooleanOperator[] =
      left === undefined
        ? []
        : [...((left.fields?.operators as ComputationBooleanOperator[]) ?? [])];
    children.push(this.emitExpression(node.right, scope));
    operators.push(operator);
    return this.node("boolean", children, { operators });
  }

  private emitPrefixUnary(node: ts.PrefixUnaryExpression, scope: JsScope): DraftNode {
    const operator = prefixOperatorOf(node.operator);
    if (operator === undefined) {
      // Increment/decrement in a value position cannot preserve its old value: fail closed.
      return this.unsupported("unsupported_construct", [this.emitExpression(node.operand, scope)]);
    }
    return this.node("unary", [this.emitExpression(node.operand, scope)], { operator });
  }

  private emitNameRead(name: string, scope: JsScope): DraftNode {
    const bound = this.resolveBoundName(name, scope);
    if (bound !== undefined) {
      return this.identifier(this.immutableAliases.get(bound) ?? bound);
    }
    if (this.importBindings.has(name)) {
      return this.unsupported("unsupported_api");
    }
    if (name === "undefined") {
      const observedHelper = this.materializeHelperDefinition(name);
      return observedHelper === undefined
        ? jsConstant("intrinsic_undefined")
        : this.identifier(observedHelper);
    }
    if (REFLECTION_NAMES[name] === true) {
      return this.unsupported("unsupported_reflection");
    }
    if (
      isKnownGlobalNamespace(name) ||
      globalFunctionApi(name) !== undefined ||
      constructorApi(name) !== undefined
    ) {
      return this.unsupported("unsupported_api");
    }
    if (this.isOpaqueName(name, scope)) {
      return this.unsupported("unsupported_hidden_state");
    }
    const helper = this.materializeHelperDefinition(name);
    if (helper !== undefined) {
      return this.identifier(helper);
    }
    if (this.frameId === 0 && !this.referencedNameSet.has(name)) {
      this.referencedNameSet.add(name);
      this.referencedNames.push(name);
    }
    // Cross-cell data stays an explicit typed free-variable slot, keyed so repeat reads share it.
    return this.literal(`free:${name}`, "unknown", "free_variable");
  }

  /** Resolve a name to a binding: each enclosing scope's locals, then its declared callables. */
  private resolveBoundName(name: string, scope: JsScope): DraftSymbol | undefined {
    let current: JsScope | null = scope;
    while (current !== null) {
      const local = current.locals.get(name);
      if (local !== undefined) {
        return local;
      }
      if (current.defs.has(name)) {
        // The callable's own definition symbol, not a duplicated local binding: one callable, one
        // declaration site, so calling a recursive helper always records a real read.
        return current.defs.get(name)?.nameSymbol;
      }
      if (current.opaque.has(name)) {
        // A class/enum/namespace binding is not representable as portable data.
        return undefined;
      }
      current = current.parent;
    }
    return undefined;
  }

  private isOpaqueName(name: string, scope: JsScope): boolean {
    let current: JsScope | null = scope;
    while (current !== null) {
      if (current.opaque.has(name)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private emitCall(node: ts.CallExpression, scope: JsScope): DraftNode {
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      this.invalidatesState = true;
      return this.unsupported("unsupported_api");
    }
    const args = node.arguments.map((argument) =>
      ts.isSpreadElement(argument)
        ? this.node("spread", [this.emitExpression(argument.expression, scope)], {
            spreadKind: "iterable",
          })
        : this.emitExpression(argument, scope),
    );
    const optional = node.questionDotToken !== undefined;
    if (ts.isIdentifier(callee)) {
      const carried = requireSpecifier(node);
      if (carried !== undefined) {
        return this.moduleHandleRead(carried);
      }
      return this.emitNameCallee(callee.text, args, scope, optional);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      return this.emitMemberCallee(callee, args, scope, optional);
    }
    return this.unsupported("unsupported_mutable_capture", [
      this.emitExpression(callee, scope),
      ...args,
    ]);
  }

  private emitNameCallee(
    name: string,
    args: readonly DraftNode[],
    scope: JsScope,
    optional: boolean,
  ): DraftNode {
    const bound = this.resolveBoundName(name, scope);
    if (bound !== undefined) {
      // Only a resolved definition (or an immutable local alias of one) is a static callee; a
      // reassigned, parameter or accumulator callee is dynamic dispatch and is never guessed.
      const target = bound.kind === "definition" ? bound : this.immutableAliases.get(bound);
      return target === undefined
        ? this.unsupported("unsupported_mutable_capture", [this.identifier(bound), ...args])
        : this.definitionCall(target, args, this.callFields({ symbol: target }, optional));
    }
    const imported = this.importBindings.get(name);
    if (imported !== undefined) {
      if (imported.member !== undefined) {
        const api = builtinModuleMemberApi(imported.module, imported.member);
        if (api !== undefined) {
          return this.node("call", args, this.callFields({ api }, optional));
        }
        const helper = this.materializeModuleMember(imported.module, imported.member);
        if (helper !== undefined) {
          return this.definitionCall(helper, args, this.callFields({ symbol: helper }, optional));
        }
      }
      return this.unsupported("unsupported_api", args);
    }
    if (REFLECTION_NAMES[name] === true) {
      return this.unsupported("unsupported_reflection", args);
    }
    if (this.isOpaqueName(name, scope)) {
      return this.unsupported("unsupported_hidden_state", args);
    }
    const helper = this.materializeHelperDefinition(name);
    if (helper !== undefined) {
      return this.definitionCall(helper, args, this.callFields({ symbol: helper }, optional));
    }
    const builtin = globalFunctionApi(name);
    if (builtin !== undefined) {
      return this.node("call", args, this.callFields({ api: builtin }, optional));
    }
    if (isKnownGlobalNamespace(name) || constructorApi(name) !== undefined) {
      return this.unsupported("unsupported_api", args);
    }
    // An unresolved callable is hidden state: never a guessed API and never a data slot.
    return this.unsupported("unsupported_hidden_state", args);
  }

  private callFields(fields: Record<string, unknown>, optional: boolean): Record<string, unknown> {
    return optional ? { ...fields, optional: true } : fields;
  }

  /**
   * A call whose callee resolved to a definition. The read is recorded exactly like an identifier
   * read, which is what makes the definition reachable: without it the closure selection would drop
   * the definition, the builder would degrade this call, and the `complete` program would be
   * rejected for an orphaned symbol.
   */
  private definitionCall(
    symbol: DraftSymbol,
    args: readonly DraftNode[],
    fields: Record<string, unknown>,
  ): DraftNode {
    this.useDefinition(symbol);
    return this.node("call", args, fields);
  }

  private emitBunFileRead(
    callee: ts.PropertyAccessExpression,
    args: readonly DraftNode[],
    scope: JsScope,
    optional: boolean,
  ): DraftNode | undefined {
    const method = callee.name.text;
    if (method !== "text" && method !== "json") {
      return undefined;
    }
    if (optional || args.length !== 0 || callee.questionDotToken !== undefined) {
      return undefined;
    }
    const fileCall = callee.expression;
    if (!ts.isCallExpression(fileCall) || fileCall.questionDotToken !== undefined) {
      return undefined;
    }
    const fileCallee = fileCall.expression;
    if (
      !ts.isPropertyAccessExpression(fileCallee) ||
      fileCallee.questionDotToken !== undefined ||
      fileCallee.name.text !== "file" ||
      !ts.isIdentifier(fileCallee.expression) ||
      fileCallee.expression.text !== "Bun" ||
      this.resolveBoundName("Bun", scope) !== undefined ||
      this.importBindings.has("Bun") ||
      this.isOpaqueName("Bun", scope)
    ) {
      return undefined;
    }
    const fileArgs = fileCall.arguments;
    if (fileArgs.length !== 1 || ts.isSpreadElement(fileArgs[0])) {
      return undefined;
    }
    const read = this.node("call", [this.emitExpression(fileArgs[0], scope)], {
      api: "fs.read_text",
    });
    return method === "text" ? read : this.node("call", [read], { api: "json.parse" });
  }

  private emitObjectHasOwnPropertyCall(
    callee: ts.PropertyAccessExpression,
    args: readonly DraftNode[],
    scope: JsScope,
    optional: boolean,
  ): DraftNode | undefined {
    if (
      optional ||
      callee.questionDotToken !== undefined ||
      callee.name.text !== "call" ||
      args.length !== 2 ||
      args.some((arg) => arg.kind === "spread")
    ) {
      return undefined;
    }
    const hasOwn = callee.expression;
    if (
      !ts.isPropertyAccessExpression(hasOwn) ||
      hasOwn.questionDotToken !== undefined ||
      hasOwn.name.text !== "hasOwnProperty"
    ) {
      return undefined;
    }
    const prototype = hasOwn.expression;
    if (
      !ts.isPropertyAccessExpression(prototype) ||
      prototype.questionDotToken !== undefined ||
      prototype.name.text !== "prototype" ||
      !ts.isIdentifier(prototype.expression) ||
      prototype.expression.text !== "Object" ||
      this.resolveBoundName("Object", scope) !== undefined ||
      this.importBindings.has("Object") ||
      this.isOpaqueName("Object", scope)
    ) {
      return undefined;
    }
    return this.node("call", args, { api: "object.has_own" });
  }

  private emitMemberCallee(
    callee: ts.PropertyAccessExpression,
    args: readonly DraftNode[],
    scope: JsScope,
    optional: boolean,
  ): DraftNode {
    const bunFileRead = this.emitBunFileRead(callee, args, scope, optional);
    if (bunFileRead !== undefined) {
      return bunFileRead;
    }
    const hasOwnPropertyCall = this.emitObjectHasOwnPropertyCall(callee, args, scope, optional);
    if (hasOwnPropertyCall !== undefined) {
      return hasOwnPropertyCall;
    }
    const base = callee.expression;
    const member = callee.name.text;
    // A local binding always wins over a same-named global namespace or module alias.
    if (ts.isIdentifier(base) && this.resolveBoundName(base.text, scope) === undefined) {
      const imported = this.importBindings.get(base.text);
      if (imported !== undefined && imported.kind === "module") {
        const api = builtinModuleMemberApi(imported.module, member);
        if (api !== undefined) {
          return this.node("call", args, this.callFields({ api }, optional));
        }
        const helper = this.materializeModuleMember(imported.module, member);
        if (helper !== undefined) {
          return this.definitionCall(helper, args, this.callFields({ symbol: helper }, optional));
        }
        return this.unsupported("unsupported_api", args);
      }
      if (isKnownGlobalNamespace(base.text)) {
        const api = staticCallApi(`${base.text}.${member}`);
        return api === undefined
          ? this.unsupported("unsupported_api", args)
          : this.node("call", args, this.callFields({ api }, optional));
      }
    }
    const receiver = this.emitExpression(base, scope);
    const regexMethod = regexMethodApi(member);
    if (regexMethod !== undefined) {
      return this.node("call", args, this.callFields({ api: regexMethod, receiver }, optional));
    }
    const regexArgumentMethod = regexArgumentMethodApi(member);
    if (regexArgumentMethod !== undefined) {
      return this.node(
        "call",
        args,
        this.callFields({ api: regexArgumentMethod, receiver }, optional),
      );
    }
    const api = instanceCallApi(member);
    if (api !== undefined) {
      return this.node("call", args, this.callFields({ api, receiver }, optional));
    }
    return this.unsupported(
      REFLECTION_NAMES[member] === true ? "unsupported_reflection" : "unsupported_api",
      [receiver, ...args],
    );
  }

  /**
   * An inline callback is a nested callable that is NOT a definition: its own symbol is local, and
   * reads inside it stay in the enclosing definition's closure, which is what keeps indirect
   * recursion (a helper calling itself from inside a `map` callback) materialized honestly.
   */
  private emitInlineCallable(
    callable: ts.FunctionLikeDeclaration,
    scope: JsScope,
    defKind?: JsDefinitionKind,
  ): DraftNode {
    const plan = this.prepareCallable(callable, scope, undefined);
    const callableKind = ts.isArrowFunction(callable) ? "lambda" : "function";
    const async = hasModifier(callable, ts.SyntaxKind.AsyncKeyword);
    const generator = ts.isFunctionExpression(callable) && callable.asteriskToken !== undefined;
    const owner = this.node(callableKind, [], {
      symbol: undefined,
      ...(async ? { async: true } : {}),
      ...(generator ? { generator: true } : {}),
      ...(callableKind === "function"
        ? { defKind: defKind ?? (ts.isMethodDeclaration(callable) ? "method" : "function") }
        : {}),
    });
    const nameSymbol = this.symbol(
      this.nextKey(`lambda:${callable.getStart(this.sf)}`),
      "local",
      scope.key,
      owner,
    );
    (owner.fields as Record<string, unknown>).symbol = nameSymbol;
    const prologue: DraftNode[] = [];
    for (const entry of plan.destructuredParameters) {
      prologue.push(
        this.node(
          "assign",
          [
            this.emitBindingTarget(entry.pattern, plan.bodyScope ?? plan.scope, "const"),
            this.node("identifier", [], { symbol: entry.symbol }),
          ],
          { operator: "set" },
        ),
      );
    }
    for (const entry of plan.defaults) {
      appendChildren(entry.node, [this.emitExpression(entry.initializer, plan.scope)]);
    }
    const body = this.emitCallableBody(callable, plan, prologue);
    appendChildren(owner, [this.node("parameters", plan.parameterNodes), body]);
    return owner;
  }

  // --------------------------------------------------------------------------
  // Inlined observed helpers (parse context only)
  // --------------------------------------------------------------------------

  private materializeHelperDefinition(name: string): DraftSymbol | undefined {
    const definitions = this.context?.definitions;
    if (definitions === undefined) {
      return undefined;
    }
    for (let index = 0; index < definitions.length; index += 1) {
      const entry = definitions[index];
      if (entry.name !== name || entry.source.length === 0) {
        continue;
      }
      const unit = this.helperUnit(`context:${index}`, entry.source, {
        programDigest: entry.programDigest,
        sourceEventId: entry.sourceEventId,
      });
      return unit?.definitions.get(name)?.nameSymbol;
    }
    return undefined;
  }

  private materializeModuleMember(modulePath: string, member: string): DraftSymbol | undefined {
    const module = this.findKnownModule(modulePath);
    if (module === undefined) {
      return undefined;
    }
    const unit = this.helperUnit(`module:${module.path}`, module.source, {
      programDigest: module.programDigest,
      sourceEventId: module.sourceEventId,
    });
    return unit?.definitions.get(member)?.nameSymbol;
  }

  /**
   * Resolve an import specifier against the bounded in-memory known-file map only: an exact match of
   * the specifier, or (for a relative specifier) its path under the emitting frame's directory. No
   * disk access, no traversal and no package crawling; an unresolvable specifier simply fails closed.
   */
  private findKnownModule(specifier: string): LocalComputationModule | undefined {
    if (specifier.startsWith("node:") || !specifier.startsWith(".")) {
      return undefined;
    }
    const modules = this.context?.modules ?? [];
    const relative = specifier.replace(/^\.+\//, "");
    const candidates = new Set<string>([specifier, relative]);
    const sourcePath = this.activeSourcePath;
    if (sourcePath !== undefined) {
      candidates.add(`${sourcePath.replace(/[^/]*$/, "")}${relative}`);
    }
    for (const module of modules) {
      if (module.language !== "python" && candidates.has(module.path)) {
        return module;
      }
    }
    return undefined;
  }

  /**
   * Inline one observed source exactly once, into its own private root scope so it can neither leak
   * names into the frame nor be shadowed by it, and record the top-level callables it declares.
   * Nothing here reads disk: only the parse context's already-observed definitions and known files.
   */
  private helperUnit(
    unitKey: string,
    source: string,
    provenance: { programDigest?: string; sourceEventId?: string },
    sourcePath?: string,
  ): HelperUnit | undefined {
    const cached = this.helperUnits.get(unitKey);
    if (cached !== undefined) {
      return cached;
    }
    if (this.helperDepth >= MAX_HELPER_DEPTH) {
      throw new JsBudgetExceeded("limit_definition");
    }
    const savedSource = this.source;
    const savedSf = this.sf;
    const savedPath = this.activeSourcePath;
    const savedImports = new Map(this.importBindings);
    const unitScope = this.newScope("module", this.moduleScope, null);
    const unit: HelperUnit = { definitions: new Map() };
    this.helperUnits.set(unitKey, unit);
    this.helperDepth += 1;
    try {
      this.source = source;
      this.sf = this.parseSource(source);
      if (parseDiagnosticsOf(this.sf).length > 0) {
        return undefined;
      }
      this.activeSourcePath = sourcePath;
      this.frameId += 1;
      this.unitKeyStack.push(unitKey);
      try {
        this.preScanStatements(this.sf.statements, unitScope);
        const statements: DraftNode[] = [];
        this.emitStatementsInto(this.sf.statements, unitScope, statements);
        for (const [name, definition] of unitScope.defs) {
          unit.definitions.set(name, definition);
        }
        for (const definition of unit.definitions.values()) {
          this.bindProvenance(definition, provenance);
        }
        for (const statement of statements) {
          const owner = this.bodyByNode.get(statement);
          if (owner !== undefined) {
            this.bindProvenance(owner, provenance);
          }
          this.helperRoots.push({ definition: owner, node: statement, unitKey });
        }
        return unit;
      } finally {
        this.unitKeyStack.pop();
      }
    } finally {
      this.frameId -= 1;
      this.activeSourcePath = savedPath;
      this.source = savedSource;
      this.sf = savedSf;
      this.importBindings.clear();
      for (const [key, value] of savedImports) {
        this.importBindings.set(key, value);
      }
      this.helperDepth -= 1;
    }
  }

  /** Stamp an inlined observed definition with the event and digest of the source it came from. */
  private bindProvenance(
    definition: PendingDefinition,
    provenance: { programDigest?: string; sourceEventId?: string },
  ): void {
    definition.sourceEventId = provenance.sourceEventId;
    definition.programDigest = provenance.programDigest;
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

// ============================================================================
// Public entry points
// ============================================================================

/**
 * Parse one JavaScript or TypeScript source frame into a bounded, privacy-safe computation program
 * plus the private local bookkeeping the recorder needs to resolve later frames.
 */
export function parseJavaScriptComputation(
  source: string,
  context?: ComputationParseContext,
  language: JsLanguage = "javascript",
): ComputationParseResult {
  const resolved: JsLanguage = language === "typescript" ? "typescript" : "javascript";
  if (typeof source !== "string" || source.length > MAX_SOURCE_LENGTH) {
    const analyzer = new JavaScriptFrameAnalyzer("", context, resolved);
    return analyzer.failClosedProgram("limit_serialized_bytes");
  }
  const analyzer = new JavaScriptFrameAnalyzer(source, context, resolved);
  try {
    return analyzer.analyze();
  } catch (error) {
    if (error instanceof JsBudgetExceeded) {
      return analyzer.failClosedProgram(error.reason);
    }
    return analyzer.failClosedProgram("unsupported_construct");
  }
}

/**
 * The private local report of the same analysis, for callers that only need this frame's authored
 * definitions, imports and referenced names rather than a wire program.
 */
export function parseJavaScriptDefinitions(
  source: string,
  context?: ComputationParseContext,
  language: JsLanguage = "javascript",
): ComputationParseLocal {
  return parseJavaScriptComputation(source, context, language).local;
}
