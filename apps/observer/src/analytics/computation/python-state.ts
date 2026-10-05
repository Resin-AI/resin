/**
 * What one persistent-kernel Python cell can do to the state later cells read.
 *
 * The recorder replays a Python cell by first replaying the earlier cells that bound the names it
 * reads (`WorkflowPythonState`). That is only faithful when every effect a cell has on the kernel is
 * attributable to names. This module classifies a cell's module-level effects into three kinds:
 *
 *  - **local**: writes into containers the cell itself created, which no earlier binding can reach
 *    (`days = defaultdict(dict)` … `days[day][src] = n`). They change nothing a later cell sees except
 *    through the names the cell binds, so they need no special handling;
 *  - **attributable**: in-place mutation of objects reachable from earlier bindings through a known
 *    container path (`rows.append(x)`, `seen[key] = v`, `for a in records: a["k"] = v`). The recorder
 *    can keep replay sound by treating the cell as a new version of every binding that may share
 *    those objects (see `ComputationParseLocal.mutatedNames`);
 *  - **opaque**: effects no name-level closure can describe: a call into unknown code, namespace
 *    reflection (`globals()`, `exec`, `setattr`), `global`/`nonlocal`, deleting a name, attribute
 *    writes on objects the cell does not own, and mutation of module or harness objects
 *    (`os.environ[k] = v`, `sys.path.append(p)`). Only these still invalidate the whole kernel model.
 *
 * Ownership is decided per container *depth*. A name the cell binds only ever to freshly constructed
 * containers is "owned"; its `taint` is the shallowest depth at which an object that might also be
 * reachable from earlier state could have been stored into it (by construction, item assignment or a
 * container method), counting the root container as depth 0. A write into the object at depth `d` is
 * local when `d < taint`: everything above the first possibly-foreign object was created by this
 * cell. For example `days = defaultdict(dict)` creates fresh dicts at depth 1 on demand, and
 * `days[day][src] = n` stores the possibly-foreign `n` at depth 2, so writes at depth 0 and 1 stay
 * local while a later `days[day][src].append(...)` (depth 2) would not be. The analysis is
 * flow-insensitive within the cell (every binding and every store counts wherever it appears, so a
 * loop back-edge cannot reintroduce an earlier object), and a name only qualifies after an
 * unconditional top-level fresh binding precedes the write in source order.
 *
 * Like the rest of the persistent-closure model, calls to observed helpers and non-container
 * methods are assumed not to mutate their arguments or earlier state; only the container mutators in
 * `PYTHON_MUTATING_METHODS` are treated as writes.
 *
 * Nothing here executes or resolves anything: identity questions (is `defaultdict` really
 * `collections.defaultdict`? is `hogql` an observed helper?) are answered by the host parser, which
 * owns the scope and import model.
 */

/** Structural view of a Lezer Python syntax node (`@lezer/common`'s `SyntaxNode` satisfies it). */
export interface PythonStateNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: PythonStateNode | null;
  readonly nextSibling: PythonStateNode | null;
}

/**
 * Callables whose result this analysis can describe: builtin and `collections` container
 * constructors, `sorted`, and the immutable scalar types (as `defaultdict` factories).
 */
export type PythonKnownCallable =
  | "Counter"
  | "OrderedDict"
  | "bool"
  | "bytes"
  | "defaultdict"
  | "deque"
  | "dict"
  | "float"
  | "frozenset"
  | "int"
  | "list"
  | "set"
  | "sorted"
  | "str"
  | "tuple";

/** How a name the cell reads but did not create was bound, as far as the host parser knows. */
export type PythonRootKind = "definition" | "module" | "prelude" | "value";

/** The parser facts this analysis needs; every answer must already account for shadowing. */
export interface PythonStateHost {
  text(node: PythonStateNode): string;
  /** The known callable `callee` provably names in this cell (a name or `collections.X`). */
  knownCallable(callee: PythonStateNode): PythonKnownCallable | undefined;
  /** Kind of a mutated root that this cell does not itself bind. */
  rootKind(name: string): PythonRootKind;
  /** True when `name` is a whole-module import alias (`import os`), so `name.f()` is a module function. */
  isModuleAlias(name: string): boolean;
  /** True when a module-level call to `name` may run code the parser has not seen. */
  isOpaqueCallee(name: string, call: PythonStateNode): boolean;
  /** True when `name` is `int`, `float` or `str` with builtin identity (an immutable update value). */
  isImmutableScalarCallee(name: string): boolean;
}

export interface PythonStateEffects {
  /** The cell may have effects no name-level replay closure can describe. */
  opaque: boolean;
  /** Earlier bindings whose reachable objects the cell mutates in place, in first-seen order. */
  mutatedRoots: string[];
  /**
   * A mutation reached earlier state through a name the cell bound to something it did not create
   * (a loop variable, an alias) or through a call result, so every earlier binding the cell reads
   * may be affected.
   */
  mutatesThroughAlias: boolean;
}

const INFINITE_DEPTH = Number.POSITIVE_INFINITY;

const DELIMITER_TOKENS: Readonly<Record<string, true>> = {
  "(": true,
  ")": true,
  "[": true,
  "]": true,
  "{": true,
  "}": true,
  Comment: true,
};

/** Known callables that return a new container (`sorted` returns a new list). */
const CONTAINER_CONSTRUCTORS: ReadonlySet<PythonKnownCallable> = new Set([
  "Counter",
  "OrderedDict",
  "defaultdict",
  "deque",
  "dict",
  "frozenset",
  "list",
  "set",
  "sorted",
  "tuple",
]);

/**
 * Container methods that store their arguments into the receiver, and how: an "element" method
 * stores the argument object itself (its last positional argument), a "contents" method stores
 * the elements or values of each argument.
 */
const STORING_METHODS: Readonly<Record<string, "contents" | "element">> = {
  add: "element",
  append: "element",
  appendleft: "element",
  extend: "contents",
  extendleft: "contents",
  insert: "element",
  intersection_update: "contents",
  setdefault: "element",
  subtract: "contents",
  symmetric_difference_update: "contents",
  update: "contents",
};

/** Methods that mutate their receiver in place (a superset of the storing methods). */
export const PYTHON_MUTATING_METHODS: Readonly<Record<string, true>> = {
  add: true,
  append: true,
  appendleft: true,
  clear: true,
  difference_update: true,
  discard: true,
  extend: true,
  extendleft: true,
  insert: true,
  intersection_update: true,
  pop: true,
  popitem: true,
  popleft: true,
  remove: true,
  reverse: true,
  rotate: true,
  setdefault: true,
  sort: true,
  subtract: true,
  symmetric_difference_update: true,
  update: true,
};

function children(node: PythonStateNode): PythonStateNode[] {
  const out: PythonStateNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    out.push(child);
  }
  return out;
}

/** Children between a node's delimiters, split at top-level commas. */
function commaGroups(node: PythonStateNode): PythonStateNode[][] {
  const groups: PythonStateNode[][] = [];
  let group: PythonStateNode[] = [];
  for (const child of children(node)) {
    if (DELIMITER_TOKENS[child.name] === true) continue;
    if (child.name === ",") {
      if (group.length > 0) groups.push(group);
      group = [];
      continue;
    }
    group.push(child);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function unwrap(node: PythonStateNode): PythonStateNode {
  if (node.name !== "ParenthesizedExpression") return node;
  const inner = commaGroups(node);
  return inner.length === 1 && inner[0]!.length === 1 ? unwrap(inner[0]![0]!) : node;
}

function isSubscript(member: PythonStateNode): boolean {
  return children(member).some((child) => child.name === "[");
}

function isSlice(member: PythonStateNode): boolean {
  return children(member).some((child) => child.name === ":");
}

function propertyName(host: PythonStateHost, member: PythonStateNode): string | undefined {
  const property = children(member).find((child) => child.name === "PropertyName");
  return property === undefined ? undefined : host.text(property);
}

/** Arguments of a call, by kind; an unparenthesized generator argument is reported on its own. */
interface CallArguments {
  positional: PythonStateNode[];
  keywords: PythonStateNode[];
  /** The element expression of a sole `f(x for x in y)` generator argument. */
  generatorElement?: PythonStateNode;
  /** A `*args` or `**kwargs` argument whose contents cannot be described. */
  unpacked: boolean;
}

function callArguments(call: PythonStateNode): CallArguments {
  const argList = children(call).find((child) => child.name === "ArgList");
  const result: CallArguments = { positional: [], keywords: [], unpacked: false };
  if (argList === undefined) return result;
  const parts = children(argList).filter((child) => DELIMITER_TOKENS[child.name] !== true);
  if (parts.some((child) => child.name === "for")) {
    result.generatorElement = parts[0];
    return result;
  }
  for (const group of commaGroups(argList)) {
    const first = group[0];
    if (first === undefined) continue;
    if (first.name === "*" || first.name === "**") {
      result.unpacked = true;
    } else if (group[1]?.name === "AssignOp") {
      if (group[2] !== undefined) result.keywords.push(group[2]);
    } else {
      result.positional.push(first);
    }
  }
  return result;
}

/**
 * How many levels of `node`'s value are known to be objects this cell created (or immutable):
 * 0 for anything that may be an existing object, `INFINITE_DEPTH` for an immutable scalar or an
 * empty fresh container. A fresh container holding possibly-foreign elements is 1.
 */
export function pythonValueOwnership(node: PythonStateNode, host: PythonStateHost): number {
  const value = unwrap(node);
  switch (value.name) {
    case "Number":
    case "String":
    case "FormatString":
    case "ContinuedString":
    case "Boolean":
    case "None":
    case "Ellipsis":
      return INFINITE_DEPTH;
    case "TupleExpression":
    case "ArrayExpression":
    case "SetExpression":
      return 1 + minimum(commaGroups(value).map((group) => elementOwnership(group, host)));
    case "DictionaryExpression":
      return 1 + minimum(commaGroups(value).map((group) => entryOwnership(group, host)));
    case "ArrayComprehensionExpression":
    case "SetComprehensionExpression":
    case "ComprehensionExpression": {
      const element = commaGroups(value)[0]?.[0];
      return element === undefined ? 0 : 1 + pythonValueOwnership(element, host);
    }
    case "DictionaryComprehensionExpression": {
      const parts = commaGroups(value)[0] ?? [];
      const colon = parts.findIndex((part) => part.name === ":");
      const entry = colon < 0 ? undefined : parts[colon + 1];
      return entry === undefined ? 0 : 1 + pythonValueOwnership(entry, host);
    }
    case "CallExpression":
      return constructedOwnership(value, host);
    default:
      return 0;
  }
}

/** Ownership of the elements or values a container value would contribute when copied. */
function contentsOwnership(node: PythonStateNode | undefined, host: PythonStateHost): number {
  if (node === undefined) return INFINITE_DEPTH;
  return Math.max(pythonValueOwnership(node, host) - 1, 0);
}

function elementOwnership(group: readonly PythonStateNode[], host: PythonStateHost): number {
  const first = group[0];
  if (first === undefined) return INFINITE_DEPTH;
  // A starred element splices elements of an existing iterable.
  return first.name === "*" ? 0 : pythonValueOwnership(first, host);
}

function entryOwnership(group: readonly PythonStateNode[], host: PythonStateHost): number {
  const first = group[0];
  if (first === undefined) return INFINITE_DEPTH;
  if (first.name === "**") return 0;
  const colon = group.findIndex((part) => part.name === ":");
  const value = colon < 0 ? undefined : group[colon + 1];
  return value === undefined ? 0 : pythonValueOwnership(value, host);
}

function minimum(values: readonly number[]): number {
  return values.reduce((least, value) => Math.min(least, value), INFINITE_DEPTH);
}

/** Ownership of a `defaultdict` factory's products: what each missing key is filled with. */
function factoryOwnership(node: PythonStateNode | undefined, host: PythonStateHost): number {
  if (node === undefined) return INFINITE_DEPTH;
  const factory = unwrap(node);
  if (factory.name === "None") return INFINITE_DEPTH;
  if (factory.name === "LambdaExpression") {
    const parts = children(factory);
    const params = parts.find((part) => part.name === "ParamList");
    if (params !== undefined && children(params).some((part) => part.name === "VariableName")) {
      return 0;
    }
    const colon = parts.findIndex((part) => part.name === ":");
    const body = colon < 0 ? undefined : parts[colon + 1];
    return body === undefined ? 0 : pythonValueOwnership(body, host);
  }
  if (factory.name === "VariableName" || factory.name === "MemberExpression") {
    // Every known callable called without arguments yields an empty container or an immutable value.
    return host.knownCallable(factory) === undefined ? 0 : INFINITE_DEPTH;
  }
  return 0;
}

function constructedOwnership(call: PythonStateNode, host: PythonStateHost): number {
  const callee = children(call)[0];
  const known = callee === undefined ? undefined : host.knownCallable(callee);
  if (known === undefined || !CONTAINER_CONSTRUCTORS.has(known)) return 0;
  const args = callArguments(call);
  if (args.unpacked) return 1;
  const keywordValues = minimum(args.keywords.map((value) => pythonValueOwnership(value, host)));
  if (args.generatorElement !== undefined) {
    // `Counter(x for x in xs)` counts its elements: its values are fresh integers.
    return known === "Counter"
      ? INFINITE_DEPTH
      : 1 + pythonValueOwnership(args.generatorElement, host);
  }
  const [first, second] = args.positional;
  switch (known) {
    case "defaultdict":
      return (
        1 + Math.min(factoryOwnership(first, host), contentsOwnership(second, host), keywordValues)
      );
    case "Counter": {
      // An iterable that is provably not a mapping is counted, not copied.
      const counted =
        first !== undefined &&
        [
          "ArrayExpression",
          "ArrayComprehensionExpression",
          "ComprehensionExpression",
          "SetExpression",
          "SetComprehensionExpression",
          "String",
          "TupleExpression",
        ].includes(unwrap(first).name);
      return 1 + Math.min(counted ? INFINITE_DEPTH : contentsOwnership(first, host), keywordValues);
    }
    case "dict":
    case "OrderedDict":
      return 1 + Math.min(contentsOwnership(first, host), keywordValues);
    default:
      // list/set/frozenset/tuple/deque/sorted copy the elements of one iterable; their keyword
      // arguments (`key=`, `reverse=`, `maxlen=`) are not stored.
      return 1 + contentsOwnership(first, host);
  }
}

/**
 * Where a mutated object sits: `depth` container steps below a named root, or somewhere this
 * analysis cannot follow (an attribute, an arbitrary call result).
 */
type AccessPath =
  | { kind: "path"; root: string; depth: number }
  | { kind: "opaque"; base: string | undefined; throughCall: boolean };

function accessPath(node: PythonStateNode, host: PythonStateHost): AccessPath {
  const value = unwrap(node);
  if (value.name === "VariableName") {
    return { kind: "path", root: host.text(value), depth: 0 };
  }
  if (value.name === "MemberExpression") {
    const object = children(value)[0];
    const inner: AccessPath =
      object === undefined
        ? { kind: "opaque", base: undefined, throughCall: true }
        : accessPath(object, host);
    if (isSubscript(value)) {
      // A slice read is a copy; following it as an element keeps the analysis conservative.
      return inner.kind === "path" ? { ...inner, depth: inner.depth + 1 } : inner;
    }
    return inner.kind === "path" ? { kind: "opaque", base: inner.root, throughCall: false } : inner;
  }
  if (value.name === "CallExpression") {
    const callee = children(value)[0];
    if (callee?.name === "MemberExpression" && !isSubscript(callee)) {
      const receiver = children(callee)[0];
      const inner: AccessPath =
        receiver === undefined
          ? { kind: "opaque", base: undefined, throughCall: true }
          : accessPath(receiver, host);
      const method = propertyName(host, callee);
      const args = callArguments(value);
      // `d.setdefault(k, v)` and `d.get(k)` return the element stored under `k` (or the fresh default).
      const elementAccess =
        method === "setdefault" ||
        (method === "get" &&
          (args.positional[1] === undefined ||
            pythonValueOwnership(args.positional[1], host) >= 1));
      if (inner.kind === "path" && elementAccess) {
        return { ...inner, depth: inner.depth + 1 };
      }
      return {
        kind: "opaque",
        base: inner.kind === "path" ? inner.root : inner.base,
        throughCall: true,
      };
    }
    return {
      kind: "opaque",
      base: callee?.name === "VariableName" ? host.text(callee) : undefined,
      throughCall: true,
    };
  }
  return { kind: "opaque", base: undefined, throughCall: true };
}

/** Variable and container-element targets of one assignment target, through tuple/list unpacking. */
function targetLeaves(node: PythonStateNode): PythonStateNode[] {
  if (node.name === "VariableName" || node.name === "MemberExpression") return [node];
  if (
    node.name === "TupleExpression" ||
    node.name === "ArrayExpression" ||
    node.name === "ParenthesizedExpression"
  ) {
    return commaGroups(node).flatMap((group) => group.flatMap(targetLeaves));
  }
  return [];
}

/** Target leaves and the value nodes of an assignment, split by `=`. */
function assignmentParts(statement: PythonStateNode): {
  targets: PythonStateNode[][];
  value: PythonStateNode[];
} {
  const segments: PythonStateNode[][] = [[]];
  for (const child of children(statement)) {
    if (child.name === "AssignOp") {
      segments.push([]);
      continue;
    }
    if (child.name === "," || child.name === "Comment" || child.name === "TypeDef") continue;
    segments[segments.length - 1]!.push(child);
  }
  const value = segments.pop() ?? [];
  return { targets: segments.map((segment) => segment.flatMap(targetLeaves)), value };
}

function forTargets(statement: PythonStateNode): PythonStateNode[] {
  const parts = children(statement);
  const inIndex = parts.findIndex((child) => child.name === "in");
  return parts
    .slice(0, inIndex < 0 ? 0 : inIndex)
    .filter((child) => child.name !== "for" && child.name !== "async" && child.name !== ",")
    .flatMap(targetLeaves);
}

function asTargets(statement: PythonStateNode): PythonStateNode[] {
  const parts = children(statement);
  return parts.flatMap((child, index) =>
    child.name === "as" && parts[index + 1]?.name === "VariableName" ? [parts[index + 1]!] : [],
  );
}

function updateParts(statement: PythonStateNode): {
  target: PythonStateNode | undefined;
  value: PythonStateNode[];
} {
  const parts = children(statement).filter((child) => child.name !== "Comment");
  const operator = parts.findIndex((child) => child.name === "UpdateOp");
  return {
    target: operator === 1 ? parts[0] : undefined,
    value: operator < 0 ? [] : parts.slice(operator + 1).filter((child) => child.name !== ","),
  };
}

function ownershipOfValue(nodes: readonly PythonStateNode[], host: PythonStateHost): number {
  if (nodes.length === 1) return pythonValueOwnership(nodes[0]!, host);
  // `x = a, b` builds a fresh tuple of its elements.
  return nodes.length === 0
    ? 0
    : 1 + minimum(nodes.map((node) => pythonValueOwnership(node, host)));
}

function contentsOfValue(nodes: readonly PythonStateNode[], host: PythonStateHost): number {
  return Math.max(ownershipOfValue(nodes, host) - 1, 0);
}

/** Flow-insensitive facts about the names the cell binds at module level. */
interface CellBindings {
  /** Every module-level name the cell binds, other than by import (the host classifies imports). */
  bound: Set<string>;
  /** Names some binding gives a value that is not a fresh container. */
  notOwned: Set<string>;
  /** Shallowest depth at which a possibly-foreign object may have been stored, per name. */
  taint: Map<string, number>;
}

function isModuleLevelBoundary(node: PythonStateNode): boolean {
  return node.name === "FunctionDefinition" || node.name === "LambdaExpression";
}

/** First pass: every module-level binding and every store into a container, wherever it is. */
function scanBindings(top: PythonStateNode, host: PythonStateHost): CellBindings {
  const facts: CellBindings = { bound: new Set(), notOwned: new Set(), taint: new Map() };
  const lower = (root: string, depth: number): void => {
    facts.taint.set(root, Math.min(facts.taint.get(root) ?? INFINITE_DEPTH, depth));
  };
  const bind = (name: string, ownership: number): void => {
    facts.bound.add(name);
    if (ownership >= 1) lower(name, ownership);
    else facts.notOwned.add(name);
  };
  /** A value stored as the element at `depth` below the root of `path`. */
  const store = (path: AccessPath, depth: number, ownership: number): void => {
    if (path.kind === "path") lower(path.root, depth + ownership);
  };
  const visit = (node: PythonStateNode): void => {
    if (isModuleLevelBoundary(node)) {
      if (node.name === "FunctionDefinition") {
        const name = children(node).find((child) => child.name === "VariableName");
        if (name !== undefined) bind(host.text(name), 0);
      }
      return;
    }
    switch (node.name) {
      case "AssignStatement": {
        const { targets, value } = assignmentParts(node);
        const single = targets.length === 1 && targets[0]!.length === 1;
        // A chained or unpacking assignment shares or splits one value: nothing it stores is owned.
        const ownership = single ? ownershipOfValue(value, host) : 0;
        for (const leaf of targets.flat()) {
          if (leaf.name === "VariableName") {
            bind(host.text(leaf), ownership);
          } else {
            const object = children(leaf)[0];
            if (object !== undefined && isSubscript(leaf)) {
              const path = accessPath(object, host);
              const depth = path.kind === "path" ? path.depth + 1 : 0;
              // A slice assignment stores the value's elements rather than the value.
              store(path, depth, isSlice(leaf) ? contentsOfValue(value, host) : ownership);
            }
          }
        }
        break;
      }
      case "UpdateStatement": {
        const { target, value } = updateParts(node);
        if (target === undefined) break;
        // `x op= v` may extend `x` in place with v's elements, or rebind it to a new value.
        const contents = contentsOfValue(value, host);
        if (target.name === "VariableName") {
          facts.bound.add(host.text(target));
          store({ kind: "path", root: host.text(target), depth: 0 }, 1, contents);
        } else if (target.name === "MemberExpression" && isSubscript(target)) {
          const object = children(target)[0];
          const path = object === undefined ? undefined : accessPath(object, host);
          if (path?.kind === "path") store(path, path.depth + 2, contents);
        }
        break;
      }
      case "ForStatement":
        for (const leaf of forTargets(node)) {
          if (leaf.name === "VariableName") bind(host.text(leaf), 0);
          else {
            const object = children(leaf)[0];
            const path = object === undefined ? undefined : accessPath(object, host);
            if (path?.kind === "path") store(path, path.depth + 1, 0);
          }
        }
        break;
      case "WithStatement":
      case "TryStatement":
        for (const leaf of asTargets(node)) bind(host.text(leaf), 0);
        break;
      case "NamedExpression": {
        const target = children(node)[0];
        if (target?.name === "VariableName") bind(host.text(target), 0);
        break;
      }
      case "ClassDefinition": {
        const name = children(node).find((child) => child.name === "VariableName");
        if (name !== undefined) bind(host.text(name), 0);
        break;
      }
      case "DeleteStatement":
        for (const leaf of commaGroups(node).flat().flatMap(targetLeaves)) {
          if (leaf.name === "VariableName") bind(host.text(leaf), 0);
        }
        break;
      case "CallExpression": {
        const callee = children(node)[0];
        const method = callee?.name === "MemberExpression" ? propertyName(host, callee) : undefined;
        const mode = method === undefined ? undefined : STORING_METHODS[method];
        const receiver = callee === undefined ? undefined : children(callee)[0];
        if (mode !== undefined && receiver !== undefined && !isSubscript(callee!)) {
          const path = accessPath(receiver, host);
          if (path.kind === "path") {
            const args = callArguments(node);
            const depth = path.depth + 1;
            if (args.unpacked) store(path, depth, 0);
            if (args.generatorElement !== undefined) {
              store(
                path,
                depth,
                mode === "contents"
                  ? pythonValueOwnership(args.generatorElement, host)
                  : 1 + pythonValueOwnership(args.generatorElement, host),
              );
            }
            const stored = mode === "element" ? args.positional.slice(-1) : args.positional;
            for (const value of stored) {
              store(
                path,
                depth,
                mode === "element"
                  ? pythonValueOwnership(value, host)
                  : contentsOwnership(value, host),
              );
            }
            for (const value of args.keywords)
              store(path, depth, pythonValueOwnership(value, host));
          }
        }
        break;
      }
      default:
        break;
    }
    for (const child of children(node)) visit(child);
  };
  visit(top);
  return facts;
}

/**
 * Classify one cell's module-level effects on kernel state. Function and lambda bodies are not
 * module-level code; a `global`/`nonlocal` or `del` inside them still makes the cell opaque because
 * calling the function later changes bindings the parser cannot see.
 */
export function analyzePythonStateEffects(
  top: PythonStateNode,
  host: PythonStateHost,
): PythonStateEffects {
  const facts = scanBindings(top, host);
  const effects: PythonStateEffects = {
    opaque: false,
    mutatedRoots: [],
    mutatesThroughAlias: false,
  };
  /** Names currently bound, by an unconditional top-level statement, to a fresh container. */
  const fresh = new Set<string>();
  /** Names currently bound, by an unconditional top-level statement, to an immutable value. */
  const immutable = new Set<string>();

  const owns = (root: string, depth: number): boolean =>
    fresh.has(root) &&
    !facts.notOwned.has(root) &&
    (depth === 0 || depth < (facts.taint.get(root) ?? INFINITE_DEPTH));

  const attribute = (root: string): void => {
    const kind = host.rootKind(root);
    if (kind !== "value") {
      effects.opaque = true;
    } else if (facts.bound.has(root)) {
      effects.mutatesThroughAlias = true;
    } else if (!effects.mutatedRoots.includes(root)) {
      effects.mutatedRoots.push(root);
    }
  };

  /** An in-place change of the object at `depth` below the root of `path`. */
  const mutate = (path: AccessPath, depth: number): void => {
    if (path.kind === "path") {
      if (!owns(path.root, depth)) attribute(path.root);
      return;
    }
    const kind = path.base === undefined ? "value" : host.rootKind(path.base);
    if (kind === "module" || kind === "prelude" || (kind === "definition" && !path.throughCall)) {
      // Module, harness and function-object state is shared beyond any binding the recorder tracks.
      effects.opaque = true;
    } else {
      effects.mutatesThroughAlias = true;
    }
  };

  /** An item write (`target` is `x[...]`) or attribute write (`x.attr`) into `target`'s object. */
  const write = (target: PythonStateNode, inPlace: boolean): void => {
    const object = children(target)[0];
    if (object === undefined) {
      effects.opaque = true;
      return;
    }
    const path = accessPath(object, host);
    const depth = path.kind === "path" ? path.depth : 0;
    if (isSubscript(target)) {
      mutate(path, inPlace ? depth + 1 : depth);
    } else if (path.kind !== "path" || !owns(path.root, inPlace ? depth + 1 : depth)) {
      // Setting an attribute may run a property setter on an object of unknown type.
      effects.opaque = true;
    }
  };

  const isImmutableUpdateValue = (nodes: readonly PythonStateNode[]): boolean => {
    if (nodes.length !== 1) return false;
    const value = unwrap(nodes[0]!);
    if (["Number", "String", "Boolean", "None", "TupleExpression"].includes(value.name)) {
      return true;
    }
    if (value.name === "VariableName") return immutable.has(host.text(value));
    const callee = value.name === "CallExpression" ? children(value)[0] : undefined;
    return callee?.name === "VariableName" && host.isImmutableScalarCallee(host.text(callee));
  };

  const rebind = (statement: PythonStateNode, topLevel: boolean): void => {
    const { targets, value } = assignmentParts(statement);
    const direct =
      topLevel &&
      targets.length === 1 &&
      targets[0]!.length === 1 &&
      targets[0]![0]!.name === "VariableName";
    const isFresh = direct && ownershipOfValue(value, host) >= 1;
    const isImmutable = direct && !isFresh && isImmutableUpdateValue(value);
    for (const leaf of targets.flat()) {
      if (leaf.name !== "VariableName") continue;
      const name = host.text(leaf);
      fresh.delete(name);
      immutable.delete(name);
      if (isFresh) fresh.add(name);
      else if (isImmutable) immutable.add(name);
    }
  };

  const visit = (node: PythonStateNode, functionDepth: number, bodyDepth: number): void => {
    if (node.name === "ScopeStatement") {
      effects.opaque = true;
    }
    if (node.name === "DeleteStatement") {
      if (functionDepth > 0) {
        effects.opaque = true;
      } else {
        for (const leaf of commaGroups(node).flat().flatMap(targetLeaves)) {
          // Deleting a name changes bindings; deleting an item mutates its container.
          if (leaf.name === "VariableName") effects.opaque = true;
          else write(leaf, false);
        }
      }
    }
    if (functionDepth === 0) {
      switch (node.name) {
        case "AssignStatement":
          rebind(node, bodyDepth === 0);
          for (const leaf of assignmentParts(node).targets.flat()) {
            if (leaf.name === "MemberExpression") write(leaf, false);
          }
          break;
        case "UpdateStatement": {
          const { target, value } = updateParts(node);
          if (target?.name === "VariableName") {
            const name = host.text(target);
            if (!fresh.has(name) && !immutable.has(name)) {
              // Read-modify-write of an earlier binding: possibly in place (`rows += [x]`).
              attribute(name);
            }
          } else if (target?.name === "MemberExpression") {
            write(target, !isImmutableUpdateValue(value));
          } else {
            effects.opaque = true;
          }
          break;
        }
        case "ForStatement":
          for (const leaf of forTargets(node)) {
            if (leaf.name === "VariableName") {
              fresh.delete(host.text(leaf));
              immutable.delete(host.text(leaf));
            } else {
              write(leaf, false);
            }
          }
          break;
        case "CallExpression": {
          const callee = children(node)[0];
          if (callee?.name === "VariableName") {
            if (host.isOpaqueCallee(host.text(callee), node)) effects.opaque = true;
          } else if (callee?.name === "MemberExpression" && !isSubscript(callee)) {
            const method = propertyName(host, callee);
            const receiver = children(callee)[0];
            const moduleFunction =
              receiver?.name === "VariableName" &&
              !facts.bound.has(host.text(receiver)) &&
              host.isModuleAlias(host.text(receiver));
            if (
              method !== undefined &&
              PYTHON_MUTATING_METHODS[method] === true &&
              receiver !== undefined &&
              !moduleFunction
            ) {
              const path = accessPath(receiver, host);
              mutate(path, path.kind === "path" ? path.depth : 0);
            }
          }
          break;
        }
        default:
          break;
      }
    }
    const nextFunctionDepth = functionDepth + (isModuleLevelBoundary(node) ? 1 : 0);
    const nextBodyDepth = bodyDepth + (node.name === "Body" ? 1 : 0);
    for (const child of children(node)) visit(child, nextFunctionDepth, nextBodyDepth);
  };
  visit(top, 0, 0);
  return effects;
}
