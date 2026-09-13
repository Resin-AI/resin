import {
  COMPUTATION_APIS,
  COMPUTATION_BINARY_OPERATORS,
  COMPUTATION_BOOLEAN_OPERATORS,
  COMPUTATION_COMPARE_OPERATORS,
  COMPUTATION_COMPREHENSION_KINDS,
  COMPUTATION_CONSTANTS,
  COMPUTATION_DECLARE_KINDS,
  COMPUTATION_DEFINITION_KINDS,
  COMPUTATION_IR_LIMITS,
  COMPUTATION_IR_VERSION,
  COMPUTATION_NODE_FIELDS,
  COMPUTATION_PARAMETER_KINDS,
  COMPUTATION_SLICE_PARTS,
  COMPUTATION_SPREAD_KINDS,
  COMPUTATION_TEMPLATE_KINDS,
  COMPUTATION_UNARY_OPERATORS,
  COMPUTATION_UNSAFE_FIELD_KEYS,
  COMPUTATION_UNSUPPORTED_REASONS,
  COMPUTATION_WITH_KINDS,
  type ComputationApi,
  type ComputationAssignOperator,
  type ComputationBinaryOperator,
  type ComputationBooleanOperator,
  type ComputationCompareOperator,
  type ComputationComprehensionKind,
  type ComputationConstant,
  type ComputationDeclareKind,
  type ComputationDefinitionKind,
  type ComputationLanguage,
  type ComputationNodeKind,
  type ComputationNodeV1,
  type ComputationOutputV1,
  type ComputationParameterKind,
  type ComputationProgramV1,
  type ComputationSlicePart,
  type ComputationSlotKind,
  type ComputationSlotRole,
  type ComputationSlotV1,
  type ComputationSpreadKind,
  type ComputationSymbolKind,
  type ComputationSymbolV1,
  type ComputationTemplateKind,
  type ComputationUnaryOperator,
  type ComputationUnsupportedReason,
  type ComputationWithKind,
  isSafeComputationFieldKey,
} from "@resin/contracts";
import {
  type ComputationProgramBuildInput,
  type ComputationProgramDraft,
  type DraftDefinition,
  type DraftNode,
  type DraftSlot,
  type DraftSymbol,
  MODULE_SCOPE_KEY,
} from "./types.js";

/**
 * Semantic builder: the only place canonical wire ids are assigned.
 *
 * Language visitors emit private recursive drafts; this module flattens them into the canonical
 * positional form the wire contract validates:
 *
 *   - `nodes` are the pre-order traversal of `roots` in order, where a node's ordered references are
 *     its `children`, then its node-kind `nodeFields` (only `call.receiver`), then
 *     `keywordArgs[].value`. `nodes[i].id` is `"n" + i`.
 *   - `symbols`, `slots` and `definitions` are positional (`sym<i>`, `slot<i>`, `def<i>`) and
 *     `definitions[i].scope` is `"scope" + (i + 1)`; module scope is `scope0`. Nested callable scopes
 *     take `scope(N + k)` after the definition scopes, in canonical node order.
 *   - a definition's `nameSymbol` is bound in the scope lexically enclosing its callable node, while
 *     `definitions[i].scope` is the body scope its parameters live in.
 *
 * Everything the wire contract can check is derived here rather than trusted from the visitor: kinds,
 * child arity, operators, APIs, field forms, symbol resolution by lexical scope, declaration sites,
 * the materialized def/use closure and the recursion flags. A draft that cannot be represented
 * becomes an `unsupported` node with an explicit reason; an input that cannot be built at all becomes
 * a bounded incomplete fallback program. This module never throws, never mutates a draft, and never
 * copies a raw identifier, source string, unsafe field key or literal value onto the wire.
 *
 * Degradation is reachability-safe: degrading a node keeps its former descendants as `children`, and
 * because the canonical reference order for a node is `children` then `receiver` then keyword
 * arguments, the flat pre-order is unchanged. No node is ever emitted unreachable and no ordered
 * reference is ever dropped.
 */

// ============================================================================
// Contract vocabularies
// ============================================================================

const NODE_LIMIT = COMPUTATION_IR_LIMITS.nodes;
const SYMBOL_LIMIT = COMPUTATION_IR_LIMITS.symbols;
const SLOT_LIMIT = COMPUTATION_IR_LIMITS.slots;
const DEFINITION_LIMIT = COMPUTATION_IR_LIMITS.definitions;
const NESTING_LIMIT = COMPUTATION_IR_LIMITS.nesting;
const OUTPUT_LIMIT = COMPUTATION_IR_LIMITS.definitions + 1;
const MAX_DEFINITION_REASONS = 8;
const MAX_PROGRAM_REASONS = 16;

type FiniteLookup<Value extends string> = Readonly<Record<Value, true>>;

function lookup<const Values extends readonly string[]>(
  values: Values,
): FiniteLookup<Values[number]> {
  const table: Record<string, true> = {};
  for (const value of values) {
    table[value] = true;
  }
  return table as FiniteLookup<Values[number]>;
}

const ASSIGN_OPERATORS = lookup([
  "add",
  "and",
  "bit_and",
  "bit_or",
  "bit_xor",
  "coalesce",
  "div",
  "floor_div",
  "mod",
  "mul",
  "or",
  "pow",
  "set",
  "shift_left",
  "shift_right",
  "sub",
]);
const BINARY_OPERATORS = lookup(COMPUTATION_BINARY_OPERATORS);
const UNARY_OPERATORS = lookup(COMPUTATION_UNARY_OPERATORS);
const COMPARE_OPERATORS = lookup(COMPUTATION_COMPARE_OPERATORS);
const BOOLEAN_OPERATORS = lookup(COMPUTATION_BOOLEAN_OPERATORS);
const CONSTANTS = lookup(COMPUTATION_CONSTANTS);
const DECLARE_KINDS = lookup(COMPUTATION_DECLARE_KINDS);
const PARAMETER_KINDS = lookup(COMPUTATION_PARAMETER_KINDS);
const DEFINITION_KINDS = lookup(COMPUTATION_DEFINITION_KINDS);
const COMPREHENSION_KINDS = lookup(COMPUTATION_COMPREHENSION_KINDS);
const SPREAD_KINDS = lookup(COMPUTATION_SPREAD_KINDS);
const TEMPLATE_KINDS = lookup(COMPUTATION_TEMPLATE_KINDS);
const WITH_KINDS = lookup(COMPUTATION_WITH_KINDS);
const SLICE_PARTS = lookup(COMPUTATION_SLICE_PARTS);
const CONSTRUCT_APIS = lookup(
  COMPUTATION_APIS.filter((api): api is ComputationApi => api.startsWith("construct.")),
);
const SLOT_KINDS = lookup([
  "array",
  "boolean",
  "bytes",
  "function",
  "null",
  "number",
  "object",
  "string",
  "unknown",
]);
const SLOT_ROLES = lookup(["dynamic", "field_key", "free_variable", "literal", "path"]);
const API_LOOKUP = lookup(COMPUTATION_APIS);
const REASON_LOOKUP = lookup(COMPUTATION_UNSUPPORTED_REASONS);
/**
 * Field keys whose punctuation/case-stripped form is itself a contract-listed unsafe key. The
 * contract's segment predicate splits camel case, so an ALL-CAPS `API_KEY` would otherwise decay into
 * single letters and pass; comparing the whole normalized key against the same exported vocabulary
 * closes that without inventing a second list.
 */
const UNSAFE_KEYS_NORMALIZED = lookup(COMPUTATION_UNSAFE_FIELD_KEYS);

function isSafeWireFieldKey(key: string): boolean {
  if (!isSafeComputationFieldKey(key)) {
    return false;
  }
  return !has(UNSAFE_KEYS_NORMALIZED, key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function has<Value extends string>(table: FiniteLookup<Value>, value: unknown): value is Value {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

/** `[min, max]` wire child arity per kind, checked before a node is planned. */
const CHILD_ARITY: Readonly<Record<ComputationNodeKind, readonly [number, number]>> = {
  program: [0, NODE_LIMIT],
  block: [0, NODE_LIMIT],
  function: [2, 2],
  parameters: [0, NODE_LIMIT],
  parameter: [0, 1],
  return: [0, 1],
  assign: [2, 2],
  declare: [0, 1],
  identifier: [0, 0],
  literal: [0, 0],
  member: [1, 1],
  index: [2, NODE_LIMIT],
  call: [0, NODE_LIMIT],
  new: [0, NODE_LIMIT],
  array: [0, NODE_LIMIT],
  tuple: [0, NODE_LIMIT],
  object: [0, NODE_LIMIT],
  pair: [1, 1],
  lambda: [2, 2],
  binary: [2, 2],
  unary: [1, 1],
  compare: [2, NODE_LIMIT],
  boolean: [2, NODE_LIMIT],
  conditional: [3, 3],
  if: [2, 3],
  for: [3, 3],
  while: [2, 2],
  try: [1, NODE_LIMIT],
  catch: [1, 1],
  finally: [1, 1],
  throw: [1, 1],
  assert: [1, 2],
  import: [0, 0],
  await: [1, 1],
  break: [0, 0],
  continue: [0, 0],
  expression: [1, 1],
  comprehension: [2, NODE_LIMIT],
  for_clause: [2, 2],
  if_clause: [1, 1],
  slice: [1, 4],
  spread: [1, 1],
  template: [0, NODE_LIMIT],
  with: [2, 2],
  yield: [0, 1],
  unsupported: [0, NODE_LIMIT],
};

/** Kinds whose `children[0]` identifier introduces a binding rather than reading one. */
const BINDING_TARGET_KINDS: Readonly<Record<string, true>> = {
  assign: true,
  for: true,
  for_clause: true,
  with: true,
};

// ============================================================================
// Public draft helpers
// ============================================================================

/**
 * Bounded private identity for a literal payload. Equal payloads must share one anonymous slot while
 * distinct payloads stay distinguishable, so a seed of `2` and a seed of `3` remain different
 * algorithms even though neither value reaches the wire.
 */
export function draftLiteralKey(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "number":
      return `number:${String(value)}`;
    case "boolean":
      return `boolean:${String(value)}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "string":
      return `string:${value}`;
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    default:
      break;
  }
  return `object:${stableDraftKey(value, 0)}`;
}

/** Deterministic, depth- and breadth-bounded structural key of an arbitrary literal payload. */
function stableDraftKey(value: unknown, depth: number): string {
  if (depth > 6) {
    return "…";
  }
  if (Array.isArray(value)) {
    return `[${value
      .slice(0, 32)
      .map((item) => stableDraftKey(item, depth + 1))
      .join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().slice(0, 32);
    return `{${keys.map((key) => `${key}:${stableDraftKey(record[key], depth + 1)}`).join(",")}}`;
  }
  return draftLiteralKey(value);
}

const LITERAL_KEY_MARKER = Symbol.for("resin.computation.literalKey");

function finiteConstant(value: unknown): ComputationConstant | undefined {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (value === "") {
    return "empty_string";
  }
  if (value === 0) {
    return "zero";
  }
  if (value === 1) {
    return "one";
  }
  return undefined;
}

function slotKindOf(value: unknown): ComputationSlotKind {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "function":
      return "function";
    default:
      break;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value instanceof Uint8Array) {
    return "bytes";
  }
  return typeof value === "object" ? "object" : "unknown";
}

/**
 * A literal occurrence. Finite semantic constants (`0`, `1`, `true`, `false`, `null`, `""`) carry a
 * constant token; every other payload becomes a typed anonymous slot keyed by `key`, so equal
 * payloads alias one slot and the payload itself never reaches the wire.
 */
export function draftLiteral(
  value: unknown,
  key: string,
  role: ComputationSlotRole = "literal",
): DraftNode {
  const constant = finiteConstant(value);
  if (constant !== undefined) {
    return { kind: "literal", children: [], fields: { constant } };
  }
  const node: DraftNode = {
    kind: "literal",
    children: [],
    fields: { slot: { key, kind: slotKindOf(value), role } satisfies DraftSlot },
  };
  // The private key travels beside the node, so repeated payloads alias one slot without the value
  // ever being retained on the draft itself.
  Object.defineProperty(node, LITERAL_KEY_MARKER, {
    value: key,
    enumerable: false,
    configurable: true,
  });
  return node;
}

/**
 * Structural field key or field slot. A secret-like, prototype or malformed key never becomes a
 * `field`: it becomes a `fieldSlot` (role `field_key`) so the key text is not retained either.
 */
export function draftField(
  key: string,
  slotKey: string,
): { field: string } | { fieldSlot: DraftSlot } {
  if (typeof key === "string" && isSafeWireFieldKey(key)) {
    return { field: key };
  }
  return { fieldSlot: { key: slotKey, kind: "string", role: "field_key" } };
}

/** Construct one draft node. `fields` accepts only the value forms documented in `types.ts`. */
export function draftNode(
  kind: ComputationNodeKind,
  children: readonly DraftNode[] = [],
  fields: Readonly<Record<string, unknown>> = {},
): DraftNode {
  return { kind, children, fields };
}

// ============================================================================
// Plan
// ============================================================================

interface DefinitionEntry {
  readonly key: string;
  readonly serial: number;
  readonly kind: ComputationDefinitionKind;
  readonly nameKey: string;
  readonly body: DraftNode;
  readonly declaredComplete: boolean;
  readonly declaredReasons: readonly ComputationUnsupportedReason[];
}

interface PlanNode {
  kind: ComputationNodeKind;
  unsupportedReason?: ComputationUnsupportedReason;
  readonly children: PlanNode[];
  receiver?: PlanNode;
  keywordArgs: Array<{ name: string; value: PlanNode }>;
  /** Private key of the scope this node sits in. */
  readonly scopeKey: string;
  /** Private key of the scope this node owns, when it is a callable. */
  ownScopeKey?: string;
  operator?: ComputationAssignOperator | ComputationBinaryOperator | ComputationUnaryOperator;
  operators?: Array<ComputationCompareOperator | ComputationBooleanOperator>;
  constant?: ComputationConstant;
  slotRef?: SlotRef;
  fieldName?: string;
  fieldSlotRef?: SlotRef;
  api?: ComputationApi;
  defKind?: ComputationDefinitionKind;
  paramKind?: ComputationParameterKind;
  declKind?: ComputationDeclareKind;
  compKind?: ComputationComprehensionKind;
  spreadKind?: ComputationSpreadKind;
  templateKind?: ComputationTemplateKind;
  withKind?: ComputationWithKind;
  slicePart?: ComputationSlicePart;
  isAsync?: boolean;
  generator?: boolean;
  optional?: boolean;
  modulePath?: string;
  /** Definition whose body this node is, when it is a materialized callable. */
  definition?: DefinitionEntry;
  /** Private key this node binds. */
  bindingKey?: string;
  /** Private key this node reads. */
  readKey?: string;
  /** True when this identifier node is a binding target rather than a read. */
  targetBinding?: boolean;
  // Resolution results.
  group?: SymbolGroup;
  emittedId?: string;
  emittedScope?: string;
  slotId?: string;
  /** Contract limit exceeded for this node's slot demand, detected before ids are assigned. */
  slotOverflow?: boolean;
}

interface SlotRef {
  readonly key: string;
  readonly kind: ComputationSlotKind;
  readonly role: ComputationSlotRole;
}

interface SymbolGroup {
  readonly key: string;
  readonly scopeKey: string;
  readonly kind: ComputationSymbolKind;
  readonly sites: PlanNode[];
  readonly definition?: DefinitionEntry;
  id?: string;
}

interface BuildContext {
  planned: number;
  nestedSerial: number;
  readonly placed: Set<DraftNode>;
  readonly byBody: Map<DraftNode, DefinitionEntry>;
  readonly planByDraft: Map<DraftNode, PlanNode>;
  readonly scopeParent: Map<string, string>;
  readonly reasons: ComputationUnsupportedReason[];
}

function addReason(
  reasons: ComputationUnsupportedReason[],
  reason: ComputationUnsupportedReason,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function isDraftNodeShape(value: unknown): value is DraftNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DraftNode).kind === "string" &&
    Array.isArray((value as DraftNode).children)
  );
}

function isDraftSlotShape(value: unknown): value is DraftSlot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DraftSlot).key === "string" &&
    has(SLOT_KINDS, (value as DraftSlot).kind) &&
    has(SLOT_ROLES, (value as DraftSlot).role)
  );
}

function isDraftSymbolShape(value: unknown): value is DraftSymbol {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DraftSymbol).key === "string" &&
    typeof (value as DraftSymbol).kind === "string"
  );
}

function sanitizeReasons(
  reasons: readonly ComputationUnsupportedReason[] | undefined,
): ComputationUnsupportedReason[] {
  const out: ComputationUnsupportedReason[] = [];
  for (const reason of reasons ?? []) {
    if (has(REASON_LOOKUP, reason) && !out.includes(reason)) {
      out.push(reason);
    }
  }
  return out;
}

function isSafeModulePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 128 &&
    /^[A-Za-z0-9_][A-Za-z0-9_./*-]*$/.test(path) &&
    !path.split("/").includes("..")
  );
}

function isKeywordName(name: string): boolean {
  // `key` is the one finite keyword-argument name the wire admits as a literal, so it stays allowed
  // as an argument NAME even though it can never be a structural field key.
  return name === "key" || isSafeWireFieldKey(name);
}

function normalizeDefinitions(
  input: ComputationProgramBuildInput,
  reasons: ComputationUnsupportedReason[],
): DefinitionEntry[] {
  const entries: DefinitionEntry[] = [];
  const bodies = new Set<DraftNode>();
  let serial = 0;
  for (const draft of input.definitions ?? []) {
    if (draft === undefined) {
      serial++;
      addReason(reasons, "unsupported_construct");
      continue;
    }
    const body = draft.body;
    const nameKey = draft.nameSymbol.key;
    const usable =
      isDraftNodeShape(body) &&
      (body.kind === "function" || body.kind === "lambda") &&
      !bodies.has(body);
    if (!usable) {
      // A definition record without a callable body cannot name a definition symbol; an unused one
      // is dropped, a referenced one degrades at its call site.
      addReason(reasons, "unsupported_construct");
      serial++;
      continue;
    }
    bodies.add(body);
    entries.push({
      key: typeof draft.key === "string" && draft.key.length > 0 ? draft.key : nameKey,
      serial: serial++,
      kind: has(DEFINITION_KINDS, draft.kind) ? draft.kind : "function",
      nameKey,
      body,
      declaredComplete: draft.complete !== false,
      declaredReasons: sanitizeReasons(draft.unsupportedReasons),
    });
  }
  return entries;
}

function readDeclaredReason(draft: DraftNode): ComputationUnsupportedReason | undefined {
  if (draft.kind !== "unsupported") {
    return undefined;
  }
  const reason = draft.fields?.unsupportedReason;
  return has(REASON_LOOKUP, reason) ? reason : "unsupported_construct";
}

/**
 * Plan one draft node and its descendants.
 *
 * Hard structural rejections (shared node, node/depth budget, unknown kind, malformed child) stop
 * recursion: there is nothing meaningful to place underneath. Everything else plans its children
 * first and only then degrades, which keeps a definition nested under an unsupported construct
 * materializable.
 */
function planNode(
  draft: DraftNode,
  scopeKey: string,
  depth: number,
  context: BuildContext,
): PlanNode {
  const hardDegrade = (reason: ComputationUnsupportedReason): PlanNode => {
    context.planned++;
    addReason(context.reasons, reason);
    return {
      kind: "unsupported",
      unsupportedReason: reason,
      children: [],
      keywordArgs: [],
      scopeKey,
    };
  };

  if (context.placed.has(draft)) {
    // The canonical wire form is a tree, so a shared draft node cannot be emitted twice.
    return hardDegrade("unsupported_construct");
  }
  if (context.planned >= NODE_LIMIT) {
    // Defensive: callers stop placing once the budget is spent, so this only fires for a direct call.
    return hardDegrade("limit_nodes");
  }
  if (depth >= NESTING_LIMIT) {
    // A node at the nesting bound may exist, but nothing deeper may: the subtree is dropped so the
    // emitted tree never exceeds the contract's depth limit.
    return hardDegrade("limit_depth");
  }
  if (!Object.prototype.hasOwnProperty.call(CHILD_ARITY, draft.kind)) {
    return hardDegrade("unsupported_construct");
  }
  for (const child of draft.children) {
    if (!isDraftNodeShape(child)) {
      return hardDegrade("unsupported_construct");
    }
  }

  const declaredReason = readDeclaredReason(draft);
  if (declaredReason !== undefined) {
    const node = hardDegrade(declaredReason);
    context.placed.add(draft);
    context.planByDraft.set(draft, node);
    return node;
  }

  context.placed.add(draft);
  context.planned++;

  const definition = context.byBody.get(draft);
  const isCallable = draft.kind === "function" || draft.kind === "lambda";
  const node: PlanNode = {
    kind: draft.kind,
    children: [],
    keywordArgs: [],
    scopeKey,
  };
  if (isCallable) {
    node.definition = definition;
    node.ownScopeKey =
      definition !== undefined ? `def:${definition.serial}` : `nested:${context.nestedSerial++}`;
    if (!context.scopeParent.has(node.ownScopeKey)) {
      context.scopeParent.set(node.ownScopeKey, scopeKey);
    }
  }
  const childScope = node.ownScopeKey ?? scopeKey;

  const childrenAreBindingTargets = Object.prototype.hasOwnProperty.call(
    BINDING_TARGET_KINDS,
    draft.kind,
  );
  // Placement stops the moment the node budget is spent: the parent degrades instead of emitting a
  // node per remaining child, so the flat node array can never exceed the contract limit.
  let budgetSpent = false;
  const place = (child: DraftNode): PlanNode | undefined => {
    if (context.planned >= NODE_LIMIT) {
      budgetSpent = true;
      return undefined;
    }
    return planNode(child, childScope, depth + 1, context);
  };

  draft.children.forEach((child, index) => {
    if (budgetSpent) {
      return;
    }
    const planned = place(child);
    if (planned === undefined) {
      return;
    }
    if (index === 0 && childrenAreBindingTargets && planned.readKey !== undefined) {
      // `assign`/`for`/`for_clause`/`with` children[0] is a binding target: the identifier node is a
      // declaration site, not a read.
      planned.targetBinding = true;
    }
    node.children.push(planned);
  });
  const receiver = draft.fields?.receiver;
  if (!budgetSpent && isDraftNodeShape(receiver)) {
    node.receiver = place(receiver);
  }
  const keywordArgs = draft.fields?.keywordArgs;
  if (!budgetSpent && Array.isArray(keywordArgs)) {
    for (const arg of keywordArgs) {
      if (budgetSpent) {
        break;
      }
      if (typeof arg !== "object" || arg === null) {
        continue;
      }
      const name = (arg as { name?: unknown }).name;
      const value = (arg as { value?: unknown }).value;
      if (typeof name !== "string" || !isKeywordName(name) || !isDraftNodeShape(value)) {
        continue;
      }
      if (node.keywordArgs.some((existing) => existing.name === name)) {
        continue;
      }
      const planned = place(value);
      if (planned !== undefined) {
        node.keywordArgs.push({ name, value: planned });
      }
    }
  }
  if (budgetSpent) {
    return degrade(node, "limit_nodes", context.reasons);
  }

  const arity = CHILD_ARITY[draft.kind];
  if (draft.children.length < arity[0] || draft.children.length > arity[1]) {
    return degrade(node, "unsupported_construct", context.reasons);
  }
  if (isCallable && draft.children[0]?.kind !== "parameters") {
    // A callable's first child is its parameter list; without it the parameters cannot be bound and
    // the definition could never be materialized.
    return degrade(node, "unsupported_construct", context.reasons);
  }
  const fieldFailure = applyFields(node, draft);
  if (fieldFailure !== undefined) {
    return degrade(node, fieldFailure, context.reasons);
  }

  context.planByDraft.set(draft, node);
  return node;
}

/**
 * Degrade a planned node, keeping its former descendants reachable as `children`.
 *
 * `orderedRefs` for the pre-degradation kind is `children + receiver + keywordArgs`, which is exactly
 * the child order after degradation, so the canonical pre-order is preserved.
 */
function degrade(
  node: PlanNode,
  reason: ComputationUnsupportedReason,
  reasons: ComputationUnsupportedReason[],
): PlanNode {
  const refs = orderedRefs(node);
  node.kind = "unsupported";
  node.unsupportedReason = reason;
  node.children.length = 0;
  node.children.push(...refs);
  node.receiver = undefined;
  node.keywordArgs = [];
  node.operator = undefined;
  node.operators = undefined;
  node.constant = undefined;
  node.slotRef = undefined;
  node.fieldName = undefined;
  node.fieldSlotRef = undefined;
  node.api = undefined;
  node.modulePath = undefined;
  node.definition = undefined;
  node.ownScopeKey = undefined;
  node.bindingKey = undefined;
  node.readKey = undefined;
  node.targetBinding = undefined;
  node.slotOverflow = undefined;
  addReason(reasons, reason);
  return node;
}

/** Validate and copy the finite semantic fields a kind may carry. */
function applyFields(node: PlanNode, draft: DraftNode): ComputationUnsupportedReason | undefined {
  const fields = draft.fields ?? {};
  switch (draft.kind) {
    case "function":
    case "lambda": {
      if (!isDraftSymbolShape(fields.symbol)) {
        return "unsupported_mutable_capture";
      }
      node.bindingKey = fields.symbol.key;
      if (fields.defKind !== undefined) {
        if (!has(DEFINITION_KINDS, fields.defKind)) {
          return "unsupported_construct";
        }
        node.defKind = fields.defKind;
      }
      if (fields.async === true) {
        node.isAsync = true;
      }
      if (fields.generator === true) {
        node.generator = true;
      }
      return undefined;
    }
    case "parameter": {
      if (!isDraftSymbolShape(fields.symbol)) {
        return "unsupported_mutable_capture";
      }
      node.bindingKey = fields.symbol.key;
      if (fields.paramKind !== undefined) {
        if (!has(PARAMETER_KINDS, fields.paramKind)) {
          return "unsupported_construct";
        }
        node.paramKind = fields.paramKind;
      }
      return undefined;
    }
    case "declare": {
      if (!isDraftSymbolShape(fields.symbol)) {
        return "unsupported_mutable_capture";
      }
      node.bindingKey = fields.symbol.key;
      if (fields.declKind === undefined) {
        node.declKind = "let";
        return undefined;
      }
      if (!has(DECLARE_KINDS, fields.declKind)) {
        return "unsupported_construct";
      }
      node.declKind = fields.declKind;
      return undefined;
    }
    case "identifier": {
      if (!isDraftSymbolShape(fields.symbol)) {
        return "unsupported_mutable_capture";
      }
      node.readKey = fields.symbol.key;
      return undefined;
    }
    case "literal": {
      const hasConstant = fields.constant !== undefined;
      const hasSlot = fields.slot !== undefined;
      if (hasConstant === hasSlot) {
        return "unsupported_construct";
      }
      if (hasConstant) {
        if (!has(CONSTANTS, fields.constant)) {
          return "unsupported_construct";
        }
        node.constant = fields.constant;
        return undefined;
      }
      if (!isDraftSlotShape(fields.slot)) {
        return "unsupported_construct";
      }
      node.slotRef = {
        key: `lit\u0000${fields.slot.key}`,
        kind: fields.slot.kind,
        role: fields.slot.role,
      };
      return undefined;
    }
    case "member":
    case "pair": {
      const hasField = fields.field !== undefined;
      const hasSlot = fields.fieldSlot !== undefined;
      if (hasField === hasSlot) {
        return "unsupported_dynamic_key";
      }
      if (hasField) {
        if (typeof fields.field !== "string" || !isSafeWireFieldKey(fields.field)) {
          return "unsupported_dynamic_key";
        }
        node.fieldName = fields.field;
        return undefined;
      }
      if (!isDraftSlotShape(fields.fieldSlot)) {
        return "unsupported_dynamic_key";
      }
      // The wire role is always `field_key`: a caller cannot relabel a key as a value input.
      node.fieldSlotRef = {
        key: `fld\u0000${fields.fieldSlot.key}`,
        kind: fields.fieldSlot.kind,
        role: "field_key",
      };
      return undefined;
    }
    case "call": {
      const hasApi = fields.api !== undefined;
      const hasSymbol = fields.symbol !== undefined;
      if (hasApi === hasSymbol) {
        return "unsupported_api";
      }
      if (hasApi) {
        if (!has(API_LOOKUP, fields.api)) {
          return "unsupported_api";
        }
        node.api = fields.api;
      } else {
        if (!isDraftSymbolShape(fields.symbol)) {
          return "unsupported_mutable_capture";
        }
        node.readKey = fields.symbol.key;
      }
      if (fields.optional === true) {
        node.optional = true;
      }
      return undefined;
    }
    case "new": {
      if (!has(CONSTRUCT_APIS, fields.api)) {
        return "unsupported_api";
      }
      node.api = fields.api;
      return undefined;
    }
    case "assign": {
      if (fields.operator === undefined) {
        return undefined;
      }
      if (!has(ASSIGN_OPERATORS, fields.operator)) {
        return "unsupported_operator";
      }
      node.operator = fields.operator;
      return undefined;
    }
    case "binary": {
      if (!has(BINARY_OPERATORS, fields.operator)) {
        return "unsupported_operator";
      }
      node.operator = fields.operator;
      return undefined;
    }
    case "unary": {
      if (!has(UNARY_OPERATORS, fields.operator)) {
        return "unsupported_operator";
      }
      node.operator = fields.operator;
      return undefined;
    }
    case "compare": {
      const operators = fields.operators;
      if (!Array.isArray(operators) || operators.length !== draft.children.length - 1) {
        return "unsupported_operator";
      }
      const parsedOperators: ComputationCompareOperator[] = [];
      for (const operator of operators) {
        if (!has(COMPARE_OPERATORS, operator)) {
          return "unsupported_operator";
        }
        parsedOperators.push(operator);
      }
      node.operators = parsedOperators;
      return undefined;
    }
    case "boolean": {
      const operators = fields.operators;
      if (!Array.isArray(operators) || operators.length !== draft.children.length - 1) {
        return "unsupported_operator";
      }
      const parsedOperators: ComputationBooleanOperator[] = [];
      for (const operator of operators) {
        if (!has(BOOLEAN_OPERATORS, operator)) {
          return "unsupported_operator";
        }
        parsedOperators.push(operator);
      }
      node.operators = parsedOperators;
      return undefined;
    }
    case "for": {
      if (fields.async === true) {
        node.isAsync = true;
      }
      return undefined;
    }
    case "catch": {
      if (fields.symbol === undefined) {
        return undefined;
      }
      if (!isDraftSymbolShape(fields.symbol)) {
        return "unsupported_mutable_capture";
      }
      node.bindingKey = fields.symbol.key;
      return undefined;
    }
    case "import": {
      if (!isDraftSymbolShape(fields.symbol) || typeof fields.modulePath !== "string") {
        return "unsupported_construct";
      }
      if (!isSafeModulePath(fields.modulePath)) {
        return "unsupported_construct";
      }
      node.bindingKey = fields.symbol.key;
      node.modulePath = fields.modulePath;
      return undefined;
    }
    case "comprehension": {
      if (!has(COMPREHENSION_KINDS, fields.compKind)) {
        return "unsupported_construct";
      }
      node.compKind = fields.compKind;
      return undefined;
    }
    case "spread": {
      if (!has(SPREAD_KINDS, fields.spreadKind)) {
        return "unsupported_construct";
      }
      node.spreadKind = fields.spreadKind;
      return undefined;
    }
    case "template": {
      if (!has(TEMPLATE_KINDS, fields.templateKind)) {
        return "unsupported_construct";
      }
      node.templateKind = fields.templateKind;
      return undefined;
    }
    case "with": {
      if (!has(WITH_KINDS, fields.withKind)) {
        return "unsupported_construct";
      }
      node.withKind = fields.withKind;
      return undefined;
    }
    case "slice": {
      const boundCount = draft.children.length - 1;
      if (boundCount <= 0) {
        return undefined;
      }
      const slicePart = fields.slicePart;
      if (!has(SLICE_PARTS, slicePart)) {
        return "unsupported_construct";
      }
      const start = COMPUTATION_SLICE_PARTS.indexOf(slicePart);
      if (boundCount > COMPUTATION_SLICE_PARTS.length - start) {
        return "unsupported_construct";
      }
      node.slicePart = slicePart;
      return undefined;
    }
    default:
      return undefined;
  }
}

// ============================================================================
// Traversal
// ============================================================================

/** Ordered references of a node, in the same order `computationChildRefs` uses. */
function orderedRefs(node: PlanNode): readonly PlanNode[] {
  const refs: PlanNode[] = [...node.children];
  for (const field of COMPUTATION_NODE_FIELDS[node.kind].nodeFields) {
    if (field === "receiver" && node.receiver !== undefined) {
      refs.push(node.receiver);
    }
  }
  for (const arg of node.keywordArgs) {
    refs.push(arg.value);
  }
  return refs;
}

/** Canonical pre-order traversal: the exact order wire node ids are assigned in. */
function preOrder(roots: readonly PlanNode[]): PlanNode[] {
  const ordered: PlanNode[] = [];
  const stack: PlanNode[] = [];
  for (let index = roots.length - 1; index >= 0; index--) {
    stack.push(roots[index]!);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    ordered.push(node);
    const refs = orderedRefs(node);
    for (let index = refs.length - 1; index >= 0; index--) {
      stack.push(refs[index]!);
    }
  }
  return ordered;
}

// ============================================================================
// Symbols
// ============================================================================

/** Index of a group's earliest declaration site in the canonical pre-order. */
function firstSiteIndex(group: SymbolGroup, siteOrder: ReadonlyMap<PlanNode, number>): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const site of group.sites) {
    const index = siteOrder.get(site);
    if (index !== undefined && index < best) {
      best = index;
    }
  }
  return best;
}

function declarationKindOf(node: PlanNode): ComputationSymbolKind {
  if (node.kind === "function" || node.kind === "lambda") {
    return node.definition !== undefined ? "definition" : "local";
  }
  if (node.kind === "parameter") {
    return "parameter";
  }
  if (node.kind === "import") {
    return "import";
  }
  return "local";
}

/** Definition-symbol groups, keyed by `nameKey\u0000scopeKey`, kept apart from local bindings. */
function definitionGroupKey(key: string, scopeKey: string): string {
  return `d\u0000${key}\u0000${scopeKey}`;
}

function localGroupKey(key: string, scopeKey: string): string {
  return `l\u0000${key}\u0000${scopeKey}`;
}

interface SymbolResolution {
  readonly defGroups: Map<string, SymbolGroup>;
  readonly localGroups: Map<string, SymbolGroup>;
  readonly externals: Map<string, SymbolGroup>;
  /** Every resolved group; the wire symbol array is a deterministic ordering of these. */
  readonly groups: () => SymbolGroup[];
  readonly chainOf: (scopeKey: string) => readonly string[];
  /** Definition scope key owning a scope, or undefined for module level. */
  readonly definitionOwnerOf: (scopeKey: string) => string | undefined;
}

function resolveSymbols(
  ordered: readonly PlanNode[],
  materializedByBody: ReadonlyMap<DraftNode, DefinitionEntry>,
  definitionNames: ReadonlySet<string>,
  context: BuildContext,
): SymbolResolution {
  const chainCache = new Map<string, readonly string[]>();
  const chainOf = (scopeKey: string): readonly string[] => {
    const cached = chainCache.get(scopeKey);
    if (cached !== undefined) {
      return cached;
    }
    const chain: string[] = [scopeKey];
    const seen = new Set<string>([scopeKey]);
    let current = scopeKey;
    while (current !== MODULE_SCOPE_KEY) {
      const parent = context.scopeParent.get(current);
      if (parent === undefined || seen.has(parent)) {
        break;
      }
      chain.push(parent);
      seen.add(parent);
      current = parent;
    }
    chainCache.set(scopeKey, chain);
    return chain;
  };
  const definitionOwnerOf = (scopeKey: string): string | undefined => {
    for (const scope of chainOf(scopeKey)) {
      if (scope.startsWith("def:")) {
        return scope;
      }
    }
    return undefined;
  };

  const defGroups = new Map<string, SymbolGroup>();
  const localGroups = new Map<string, SymbolGroup>();
  const externals = new Map<string, SymbolGroup>();

  const ensure = (
    table: Map<string, SymbolGroup>,
    id: string,
    key: string,
    scopeKey: string,
    kind: ComputationSymbolKind,
    definition?: DefinitionEntry,
  ): SymbolGroup => {
    const existing = table.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created: SymbolGroup =
      definition === undefined
        ? { key, scopeKey, kind, sites: [] }
        : { key, scopeKey, kind, sites: [], definition };
    table.set(id, created);
    return created;
  };

  // Declaration sites. A callable's own binding is declared in the scope it sits in, which is what
  // makes a definition name visible from its body scope.
  for (const node of ordered) {
    if (node.kind === "unsupported") {
      continue;
    }
    if (node.definition !== undefined && (node.kind === "function" || node.kind === "lambda")) {
      const bodyEntry = materializedByBody.get(node.definition.body);
      if (bodyEntry === undefined) {
        continue;
      }
      const group =
        defGroups.get(definitionGroupKey(node.definition.nameKey, node.scopeKey)) ??
        ensure(
          defGroups,
          definitionGroupKey(node.definition.nameKey, node.scopeKey),
          node.definition.nameKey,
          node.scopeKey,
          "definition",
          node.definition,
        );
      group.sites.push(node);
      node.group = group;
      continue;
    }
    if (node.bindingKey === undefined) {
      if (node.targetBinding === true && node.readKey !== undefined) {
        const group = ensure(
          localGroups,
          localGroupKey(node.readKey, node.scopeKey),
          node.readKey,
          node.scopeKey,
          "local",
        );
        group.sites.push(node);
        node.group = group;
      }
      continue;
    }
    const group = ensure(
      localGroups,
      localGroupKey(node.bindingKey, node.scopeKey),
      node.bindingKey,
      node.scopeKey,
      declarationKindOf(node),
    );
    group.sites.push(node);
    node.group = group;
  }

  // Reads.
  for (const node of ordered) {
    if (node.kind === "unsupported") {
      continue;
    }
    if (node.targetBinding === true && node.group !== undefined) {
      continue;
    }
    if (node.readKey === undefined) {
      continue;
    }
    let target: SymbolGroup | undefined;
    for (const scope of chainOf(node.scopeKey)) {
      target = defGroups.get(definitionGroupKey(node.readKey, scope));
      if (target !== undefined) {
        break;
      }
    }
    if (target === undefined) {
      for (const scope of chainOf(node.scopeKey)) {
        target = localGroups.get(localGroupKey(node.readKey, scope));
        if (target !== undefined) {
          break;
        }
      }
    }
    if (target === undefined) {
      if (definitionNames.has(node.readKey)) {
        // The visitor reported a definition with this name that was never attached here. Treating it
        // as a free input would fabricate the helper's type, so the read fails closed instead.
        degrade(node, "unsupported_mutable_capture", context.reasons);
        continue;
      }
      target =
        externals.get(node.readKey) ??
        (() => {
          const created: SymbolGroup = {
            key: node.readKey!,
            scopeKey: MODULE_SCOPE_KEY,
            kind: "external",
            sites: [],
          };
          externals.set(node.readKey!, created);
          return created;
        })();
    }
    node.group = target;
  }

  // A `call` bound to a definition symbol must reach a materialized definition; a call through an
  // alias, a temporary or a dynamically reassigned callee is dynamic dispatch and is unsupported.
  for (const node of ordered) {
    if (node.kind !== "call" || node.api !== undefined || node.readKey === undefined) {
      continue;
    }
    if (node.group?.kind !== "definition") {
      degrade(node, "unsupported_mutable_capture", context.reasons);
    }
  }

  return {
    defGroups,
    localGroups,
    externals,
    groups: () => [...defGroups.values(), ...localGroups.values(), ...externals.values()],
    chainOf,
    definitionOwnerOf,
  };
}

// ============================================================================
// Emission
// ============================================================================

interface EmitState {
  readonly nodes: ComputationNodeV1[];
  readonly slots: ComputationSlotV1[];
  readonly slotIdByKey: Map<string, string>;
  readonly definitionScopeBySerial: Map<number, string>;
  readonly nestedScopeByKey: Map<string, string>;
  readonly wireScopeByKey: Map<string, string>;
}

function wireScopeOfKey(scopeKey: string, state: EmitState, fallback: string): string {
  if (scopeKey === MODULE_SCOPE_KEY) {
    return "scope0";
  }
  return state.wireScopeByKey.get(scopeKey) ?? fallback;
}

function buildWireNode(node: PlanNode): ComputationNodeV1 {
  const id = node.emittedId ?? "n0";
  const childIds = node.children.map((child) => child.emittedId ?? "n0");
  const [first = "n0", second = "n0", third = "n0"] = childIds;
  const symbol = node.group?.id ?? "sym0";

  if (node.kind === "unsupported") {
    return {
      id,
      kind: "unsupported",
      children: childIds,
      unsupportedReason: node.unsupportedReason ?? "unsupported_construct",
    };
  }

  const keywordArgs =
    node.keywordArgs.length === 0
      ? undefined
      : node.keywordArgs.map((arg) => ({ name: arg.name, value: arg.value.emittedId ?? "n0" }));
  const receiverId = node.receiver?.emittedId;

  switch (node.kind) {
    case "program":
    case "block":
    case "parameters":
    case "array":
    case "tuple":
    case "object":
    case "break":
    case "continue":
      return { id, kind: node.kind, children: childIds };
    case "function":
      return {
        id,
        kind: "function",
        children: childIds,
        symbol,
        scope: node.emittedScope ?? "scope0",
        ...(node.defKind === undefined ? {} : { defKind: node.defKind }),
        ...(node.isAsync === true ? { async: true } : {}),
        ...(node.generator === true ? { generator: true } : {}),
      };
    case "lambda":
      return {
        id,
        kind: "lambda",
        children: childIds,
        symbol,
        scope: node.emittedScope ?? "scope0",
        ...(node.isAsync === true ? { async: true } : {}),
      };
    case "parameter":
      return {
        id,
        kind: "parameter",
        children: childIds,
        symbol,
        ...(node.paramKind === undefined ? {} : { paramKind: node.paramKind }),
      };
    case "return":
    case "await":
    case "expression":
    case "throw":
    case "finally":
      return { id, kind: node.kind, children: childIds };
    case "yield":
      return { id, kind: "yield", children: childIds };
    case "assert":
      return { id, kind: "assert", children: childIds };
    case "declare":
      return {
        id,
        kind: "declare",
        children: childIds,
        symbol,
        declKind: node.declKind ?? "let",
      };
    case "identifier":
      return { id, kind: "identifier", children: [], symbol };
    case "literal":
      return node.constant === undefined
        ? { id, kind: "literal", children: [], slot: node.slotId ?? "slot0" }
        : { id, kind: "literal", children: [], constant: node.constant };
    case "member":
      return node.fieldName === undefined
        ? { id, kind: "member", children: [first], fieldSlot: node.slotId ?? "slot0" }
        : { id, kind: "member", children: [first], field: node.fieldName };
    case "pair":
      return node.fieldName === undefined
        ? { id, kind: "pair", children: [first], fieldSlot: node.slotId ?? "slot0" }
        : { id, kind: "pair", children: [first], field: node.fieldName };
    case "index":
      return { id, kind: "index", children: childIds };
    case "call":
      return node.api === undefined
        ? {
            id,
            kind: "call",
            children: childIds,
            symbol,
            ...(receiverId === undefined ? {} : { receiver: receiverId }),
            ...(keywordArgs === undefined ? {} : { keywordArgs }),
            ...(node.optional === true ? { optional: true } : {}),
          }
        : {
            id,
            kind: "call",
            children: childIds,
            api: node.api,
            ...(receiverId === undefined ? {} : { receiver: receiverId }),
            ...(keywordArgs === undefined ? {} : { keywordArgs }),
            ...(node.optional === true ? { optional: true } : {}),
          };
    case "new":
      return {
        id,
        kind: "new",
        children: childIds,
        api: node.api ?? "construct.object",
        ...(keywordArgs === undefined ? {} : { keywordArgs }),
      };
    case "assign": {
      const operator = node.operator;
      return {
        id,
        kind: "assign",
        children: [first, second],
        ...(operator !== undefined && has(ASSIGN_OPERATORS, operator) ? { operator } : {}),
      };
    }
    case "binary": {
      const operator = node.operator;
      return {
        id,
        kind: "binary",
        children: [first, second],
        operator: operator !== undefined && has(BINARY_OPERATORS, operator) ? operator : "add",
      };
    }
    case "unary": {
      const operator = node.operator;
      return {
        id,
        kind: "unary",
        children: [first],
        operator: operator !== undefined && has(UNARY_OPERATORS, operator) ? operator : "not",
      };
    }
    case "compare": {
      const rawOperators = node.operators;
      const operators: ComputationCompareOperator[] =
        rawOperators === undefined
          ? ["eq"]
          : rawOperators.every((op): op is ComputationCompareOperator => has(COMPARE_OPERATORS, op))
            ? rawOperators
            : ["eq"];
      return { id, kind: "compare", children: childIds, operators };
    }
    case "boolean": {
      const rawOperators = node.operators;
      const operators: ComputationBooleanOperator[] =
        rawOperators === undefined
          ? ["and"]
          : rawOperators.every((op): op is ComputationBooleanOperator => has(BOOLEAN_OPERATORS, op))
            ? rawOperators
            : ["and"];
      return { id, kind: "boolean", children: childIds, operators };
    }
    case "conditional":
      return { id, kind: "conditional", children: [first, second, third] };
    case "if":
      return { id, kind: "if", children: childIds };
    case "for":
      return {
        id,
        kind: "for",
        children: [first, second, third],
        ...(node.isAsync === true ? { async: true } : {}),
      };
    case "while":
      return { id, kind: "while", children: [first, second] };
    case "try":
      return { id, kind: "try", children: childIds };
    case "catch":
      return node.bindingKey === undefined
        ? { id, kind: "catch", children: [first] }
        : { id, kind: "catch", children: [first], symbol };
    case "import":
      return {
        id,
        kind: "import",
        children: [],
        modulePath: node.modulePath ?? "module",
        symbol,
      };
    case "comprehension":
      return { id, kind: "comprehension", children: childIds, compKind: node.compKind ?? "list" };
    case "for_clause":
      return { id, kind: "for_clause", children: [first, second] };
    case "if_clause":
      return { id, kind: "if_clause", children: [first] };
    case "slice":
      return node.slicePart === undefined
        ? { id, kind: "slice", children: [first] }
        : { id, kind: "slice", children: childIds, slicePart: node.slicePart };
    case "spread":
      return { id, kind: "spread", children: [first], spreadKind: node.spreadKind ?? "iterable" };
    case "template":
      return {
        id,
        kind: "template",
        children: childIds,
        templateKind: node.templateKind ?? "template_literal",
      };
    case "with":
      return { id, kind: "with", children: [first, second], withKind: node.withKind ?? "with" };
    default:
      return {
        id,
        kind: "unsupported",
        children: childIds,
        unsupportedReason: "unsupported_construct",
      };
  }
}

function ordinalOfSymbol(symbolId: string): number {
  const parsed = Number(symbolId.slice("sym".length));
  return Number.isFinite(parsed) ? parsed : -1;
}

function reachesItself(
  nameSymbol: string,
  dependencies: readonly string[],
  depsByDefinitionSymbol: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>();
  const pending = [...dependencies];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === nameSymbol) {
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    pending.push(...(depsByDefinitionSymbol.get(current) ?? []));
  }
  return false;
}

function collectSubtreeReasons(node: PlanNode): ComputationUnsupportedReason[] {
  const reasons: ComputationUnsupportedReason[] = [];
  for (const inner of preOrder([node])) {
    if (inner.kind === "unsupported" && inner.unsupportedReason !== undefined) {
      addReason(reasons, inner.unsupportedReason);
    }
  }
  return reasons;
}

// ============================================================================
// Build
// ============================================================================

/**
 * Flatten drafts into the canonical wire program. Never throws: unsupported input becomes a bounded
 * incomplete program with an explicit reason.
 */
export function buildComputationProgram(input: ComputationProgramBuildInput): ComputationProgramV1 {
  return buildComputationProgramWithKeyMap(input).program;
}

/** As `buildComputationProgram`, but also returns the private definition keys in wire order. */
export function buildComputationProgramWithKeyMap(
  input: ComputationProgramBuildInput,
): ComputationProgramDraft {
  try {
    return build(input);
  } catch {
    // A structurally hostile draft (getters that throw, absurd nesting) still yields a bounded,
    // explicitly incomplete program rather than an exception inside the recorder.
    return incompleteProgram(readLanguage(input), "incomplete_parse");
  }
}

function readLanguage(input: ComputationProgramBuildInput | null | undefined): ComputationLanguage {
  const language = input?.language;
  return language === "python" || language === "javascript" || language === "typescript"
    ? language
    : "python";
}

/**
 * A bounded incomplete fallback program: one `unsupported` root, an explicit reason, and the smallest
 * shape the wire contract accepts. Callers get `complete: false` rather than a throw or a silently
 * complete prefix.
 */
function incompleteProgram(
  language: ComputationLanguage,
  reason: ComputationUnsupportedReason,
): ComputationProgramDraft {
  return {
    program: {
      version: COMPUTATION_IR_VERSION,
      language,
      nodes: [{ id: "n0", kind: "unsupported", children: [], unsupportedReason: reason }],
      symbols: [],
      slots: [],
      definitions: [],
      roots: ["n0"],
      outputs: [],
      complete: false,
      unsupportedReasons: [reason],
    },
    definitionKeys: [],
  };
}

function build(input: ComputationProgramBuildInput): ComputationProgramDraft {
  const language = readLanguage(input);
  if (
    input === null ||
    input === undefined ||
    (input.language !== "python" &&
      input.language !== "javascript" &&
      input.language !== "typescript")
  ) {
    return incompleteProgram(language, "unsupported_language");
  }

  const reasons = sanitizeReasons(input.unsupportedReasons);
  const entries = normalizeDefinitions(input, reasons);
  const byBody = new Map<DraftNode, DefinitionEntry>();
  for (const entry of entries) {
    if (!byBody.has(entry.body)) {
      byBody.set(entry.body, entry);
    }
  }
  const definitionNames = new Set(entries.map((entry) => entry.nameKey));

  const context: BuildContext = {
    planned: 0,
    nestedSerial: 0,
    placed: new Set<DraftNode>(),
    byBody,
    planByDraft: new Map<DraftNode, PlanNode>(),
    scopeParent: new Map<string, string>(),
    reasons,
  };

  const roots: PlanNode[] = [];
  for (const root of input.roots ?? []) {
    if (!isDraftNodeShape(root)) {
      addReason(reasons, "unsupported_construct");
      continue;
    }
    if (context.planned >= NODE_LIMIT) {
      addReason(reasons, "limit_nodes");
      break;
    }
    roots.push(planNode(root, MODULE_SCOPE_KEY, 1, context));
  }
  if (roots.length === 0) {
    return incompleteProgram(language, reasons[0] ?? "incomplete_parse");
  }

  // Materialized definitions: a definition counts only when its callable body node is actually in the
  // emitted tree, so an unused helper the visitor passed is dropped rather than given evidence.
  const materialized: Array<{ entry: DefinitionEntry; node: PlanNode }> = [];
  const seenDefinitions = new Set<DefinitionEntry>();
  for (const node of preOrder(roots)) {
    const entry = node.definition;
    if (entry === undefined || node.kind === "unsupported" || seenDefinitions.has(entry)) {
      continue;
    }
    seenDefinitions.add(entry);
    materialized.push({ entry, node });
  }
  if (materialized.length > DEFINITION_LIMIT) {
    return incompleteProgram(language, "limit_definition");
  }
  const materializedByBody = new Map<DraftNode, DefinitionEntry>();
  for (const item of materialized) {
    materializedByBody.set(item.entry.body, item.entry);
  }

  // Slot budget in first-reference pre-order, resolved before ids exist so an over-limit node
  // degrades without leaving an orphan slot behind.
  const state: EmitState = {
    nodes: [],
    slots: [],
    slotIdByKey: new Map(),
    definitionScopeBySerial: new Map(),
    nestedScopeByKey: new Map(),
    wireScopeByKey: new Map(),
  };
  materialized.forEach((item, index) => {
    state.definitionScopeBySerial.set(item.entry.serial, `scope${index + 1}`);
    state.wireScopeByKey.set(`def:${item.entry.serial}`, `scope${index + 1}`);
  });

  const overLimit: PlanNode[] = [];
  for (const node of preOrder(roots)) {
    const slot = node.slotRef ?? node.fieldSlotRef;
    if (slot === undefined || node.kind === "unsupported") {
      continue;
    }
    const existing = state.slotIdByKey.get(slot.key);
    if (existing !== undefined) {
      node.slotId = existing;
      continue;
    }
    if (state.slots.length >= SLOT_LIMIT) {
      overLimit.push(node);
      continue;
    }
    const id = `slot${state.slots.length}`;
    state.slots.push({ id, kind: slot.kind, role: slot.role });
    state.slotIdByKey.set(slot.key, id);
    node.slotId = id;
  }
  for (const node of overLimit) {
    degrade(node, "limit_slots", reasons);
  }

  const resolution = resolveSymbols(preOrder(roots), materializedByBody, definitionNames, context);

  const ordered = preOrder(roots);

  // Symbol ids: definition names, then parameters, then other bindings in declaration order, then
  // free (external) symbols in first-reference order. This is the pinned positional convention the
  // contract's digest relies on for renaming invariance.
  const groups: SymbolGroup[] = [];
  const seenGroups = new Set<SymbolGroup>();
  const push = (group: SymbolGroup | undefined): void => {
    if (group !== undefined && !seenGroups.has(group)) {
      seenGroups.add(group);
      groups.push(group);
    }
  };

  for (const item of materialized) {
    push(resolution.defGroups.get(definitionGroupKey(item.entry.nameKey, item.node.scopeKey)));
  }
  for (const item of materialized) {
    const bodyPlan = context.planByDraft.get(item.entry.body);
    const parametersNode = bodyPlan?.children[0];
    if (parametersNode === undefined) {
      continue;
    }
    for (const parameter of parametersNode.children) {
      push(parameter.group);
    }
  }
  // Every remaining group - a nested callable's own binding, a nested parameter, a declared local, an
  // import - in declaration order, then free (external) symbols in first-reference order. Skipping
  // any group here would leave a symbol-bearing node without an id.
  const siteOrder = new Map<PlanNode, number>();
  ordered.forEach((node, index) => siteOrder.set(node, index));
  const remaining = resolution
    .groups()
    .filter((group) => group.kind !== "external" && !seenGroups.has(group));
  remaining.sort(
    (left, right) => firstSiteIndex(left, siteOrder) - firstSiteIndex(right, siteOrder),
  );
  for (const group of remaining) {
    push(group);
  }
  const externals = resolution.groups().filter((group) => group.kind === "external");
  externals.sort(
    (left, right) => firstSiteIndex(left, siteOrder) - firstSiteIndex(right, siteOrder),
  );
  for (const group of externals) {
    push(group);
  }
  if (groups.length > SYMBOL_LIMIT) {
    return incompleteProgram(language, "limit_symbols");
  }
  groups.forEach((group, index) => {
    group.id = `sym${index}`;
  });

  // Canonical positions: node ids and nested callable scopes, in the order the validator derives.
  // Ids are assigned for the whole tree first, because a node references its descendants.
  for (const [index, node] of ordered.entries()) {
    node.emittedId = `n${index}`;
    if (node.definition !== undefined) {
      node.emittedScope = state.definitionScopeBySerial.get(node.definition.serial) ?? "scope0";
    } else if (
      (node.kind === "function" || node.kind === "lambda") &&
      node.ownScopeKey !== undefined
    ) {
      const scope = `scope${materialized.length + state.nestedScopeByKey.size + 1}`;
      node.emittedScope = scope;
      state.nestedScopeByKey.set(node.ownScopeKey, scope);
      state.wireScopeByKey.set(node.ownScopeKey, scope);
    }
  }
  const nodes: ComputationNodeV1[] = ordered.map((node) => buildWireNode(node));

  const symbols: ComputationSymbolV1[] = groups.map((group) => {
    const site = group.sites[0];
    const wireScope =
      group.kind === "external"
        ? "scope0"
        : site === undefined
          ? "scope0"
          : wireScopeOfKey(site.scopeKey, state, "scope0");
    return site === undefined || site.emittedId === undefined
      ? { id: group.id ?? "sym0", kind: group.kind, scope: wireScope }
      : { id: group.id ?? "sym0", kind: group.kind, scope: wireScope, node: site.emittedId };
  });

  // Materialized def/use closure: exactly the definition symbols each definition's own scope reads,
  // a read inside a nested lambda counting toward the enclosing definition.
  const depsByDefinitionId = new Map<string, Set<string>>();
  for (const node of ordered) {
    if (node.kind === "unsupported" || node.group?.kind !== "definition") {
      continue;
    }
    if (node.bindingKey !== undefined || node.targetBinding === true) {
      continue;
    }
    const owner = resolution.definitionOwnerOf(node.scopeKey);
    if (owner === undefined) {
      continue;
    }
    const bucket = depsByDefinitionId.get(owner) ?? new Set<string>();
    bucket.add(node.group.id ?? "sym0");
    depsByDefinitionId.set(owner, bucket);
  }

  const definitions: ComputationProgramV1["definitions"] = [];
  const definitionKeys: string[] = [];
  const dependenciesByDefinitionSymbol = new Map<string, string[]>();
  for (const item of materialized) {
    const group = resolution.defGroups.get(
      definitionGroupKey(item.entry.nameKey, item.node.scopeKey),
    );
    const dependencies = [
      ...(depsByDefinitionId.get(`def:${item.entry.serial}`) ?? new Set<string>()),
    ].sort((left, right) => ordinalOfSymbol(left) - ordinalOfSymbol(right));
    if (group?.id !== undefined) {
      dependenciesByDefinitionSymbol.set(group.id, dependencies);
    }
  }

  materialized.forEach((item, index) => {
    const bodyPlan = context.planByDraft.get(item.entry.body);
    const group = resolution.defGroups.get(
      definitionGroupKey(item.entry.nameKey, item.node.scopeKey),
    );
    const declared = [
      ...item.entry.declaredReasons,
      ...(bodyPlan === undefined ? [] : collectSubtreeReasons(bodyPlan)),
    ];
    const complete = item.entry.declaredComplete && declared.length === 0;
    definitions.push({
      id: `def${index}`,
      kind: item.entry.kind,
      nameSymbol: group?.id ?? "sym0",
      parameters: (bodyPlan?.children[0]?.children ?? [])
        .filter((parameter) => parameter.kind === "parameter")
        .map((parameter) => parameter.group?.id ?? "sym0"),
      body: item.node.emittedId ?? "n0",
      dependencies:
        group?.id === undefined ? [] : (dependenciesByDefinitionSymbol.get(group.id) ?? []),
      recursive:
        group?.id === undefined
          ? false
          : reachesItself(
              group.id,
              dependenciesByDefinitionSymbol.get(group.id) ?? [],
              dependenciesByDefinitionSymbol,
            ),
      scope: state.definitionScopeBySerial.get(item.entry.serial) ?? `scope${index + 1}`,
      complete,
      unsupportedReasons: complete ? [] : declared.slice(0, MAX_DEFINITION_REASONS),
    });
    definitionKeys.push(item.entry.key);
  });
  const outputs: ComputationOutputV1[] = [];
  for (const output of input.outputs ?? []) {
    if (outputs.length >= OUTPUT_LIMIT) {
      break;
    }
    if (output === undefined || !isDraftNodeShape(output.node)) {
      continue;
    }
    const target = context.planByDraft.get(output.node);
    if (target === undefined || target.emittedId === undefined) {
      continue;
    }
    if (target.kind !== "return" && target.kind !== "yield" && target.kind !== "expression") {
      continue;
    }
    const shape = output.shape;
    if (
      shape !== "array" &&
      shape !== "boolean" &&
      shape !== "null" &&
      shape !== "number" &&
      shape !== "object" &&
      shape !== "string" &&
      shape !== "tuple" &&
      shape !== "unknown"
    ) {
      continue;
    }
    const record: ComputationOutputV1 = { node: target.emittedId, shape };
    if (output.definitionKey !== undefined) {
      const index = definitionKeys.indexOf(output.definitionKey);
      if (index >= 0) {
        (record as { definitionId?: string }).definitionId = `def${index}`;
      }
    }
    outputs.push(record);
  }

  for (const node of nodes) {
    if (node.kind === "unsupported" && node.unsupportedReason !== undefined) {
      addReason(reasons, node.unsupportedReason);
    }
  }
  // A program is complete only when no construct degraded, no reason was declared, and every
  // materialized definition is itself complete: an incomplete helper still makes the program
  // incomplete, which is what keeps a partially represented algorithm out of substantiveness.
  const allDefinitionsComplete = definitions.every((definition) => definition.complete);
  const complete =
    allDefinitionsComplete &&
    !nodes.some((node) => node.kind === "unsupported") &&
    reasons.length === 0;
  if (!complete && reasons.length === 0) {
    for (const definition of definitions) {
      for (const reason of definition.unsupportedReasons) {
        addReason(reasons, reason);
      }
    }
    if (reasons.length === 0) {
      addReason(reasons, "incomplete_parse");
    }
  }

  const program: ComputationProgramV1 = {
    version: COMPUTATION_IR_VERSION,
    language,
    nodes,
    symbols,
    slots: state.slots,
    definitions,
    roots: roots.map((root) => root.emittedId ?? "n0"),
    outputs,
    complete,
    unsupportedReasons: complete ? [] : reasons.slice(0, MAX_PROGRAM_REASONS),
  };

  return { program, definitionKeys };
}
