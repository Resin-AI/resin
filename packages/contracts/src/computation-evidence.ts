import { z } from "zod";
import {
  canonicalJsonStringify,
  descriptorSafeCanonicalJsonStringify,
  hashCanonicalContent,
} from "./canonical.js";
import { IdentifierSchema } from "./common.js";

/**
 * Computation Semantic Evidence Contract (analysis-only).
 *
 * This module freezes the serialization boundary for a *semantic* representation of an
 * agent-authored computation: an ordered algorithm AST plus a versioned dependency closure and
 * observation record. It is deliberately NOT an API-name/count bag, and it carries no authority:
 * evidence never grants filesystem/command/network/secret capability, and captured programs are
 * untrusted DATA that must never be executed during extraction.
 *
 * Privacy posture (mirrors the existing parameter-shape / committed-metadata posture in this
 * package): the IR contains no raw source, prompt, transcript or result text, no arbitrary literal
 * values or defaults, no raw local/function identifiers and no absolute private paths. Every string
 * in a program is one of:
 *   - a canonical anonymous id (`n0`, `sym1`, `slot2`, `def3`, `scope4`),
 *   - a finite vocabulary token (node kind, operator, canonical API, constant, reason code),
 *   - a bounded safe structural field key (see `ComputationFieldKeySchema`), or
 *   - a SHA-256 digest.
 * Non-finite literal payloads are `literal` nodes carrying a `slot`; dynamic or unsafe object keys
 * become `pair.fieldSlot`/`member.fieldSlot`. Their VALUES never appear in the IR.
 *
 * Canonical form (parsers MUST emit it; the validator enforces it):
 *   - `nodes` are the canonical pre-order of the program from `roots` in order, where the
 *     sub-expressions of a node are `children` in order, then `nodeFields` (table order), then
 *     `keywordArgs[].value` in order. Node ids are positions: `nodes[i].id === "n" + i`.
 *   - `symbols`, `slots` and `definitions` are positional too (`sym<i>`, `slot<i>`, `def<i>`)
 *     and `definitions[i].scope` is `"scope" + (i + 1)`; module scope is `"scope0"`.
 *   - a definition's `nameSymbol` is bound in the scope that lexically encloses its function node,
 *     while `definitions[i].scope` is the body scope its parameters live in.
 * Both orderings are load-bearing: operator order, branch/body order and argument order change the
 * program digest. Renaming is consistent-only: a capture that introduces bindings in the same order
 * under different private names shares a digest, which is what makes naming (including eval-like
 * naming) irrelevant to algorithm identity.
 *
 * Graph rules:
 *   - AST child edges MUST be acyclic AND single-parented: the canonical pre-order form is a tree, so a
 *     node referenced from two parents (or from a root twice) is rejected rather than silently
 *     duplicated. `computationChildRefs` is the canonical ordered-child step shared by builders,
 *     validators and traversals.
 *   - def/use dependencies MAY be recursive, including mutual recursion (for example a recursive
 *     typed-JSON decoder). Recursion must be *resolved*: a definition lists exactly the definition
 *     symbols its own scope reads, itself included when it is directly recursive, so mutual recursion
 *     is materialized and downstream consumers never need private kernel state. Hidden or unresolved
 *     dynamic state (`unsupported_hidden_state`), duplicate definition symbols, undeclared captures
 *     and unreferenced definition symbols are rejected instead. A definition symbol is bound before
 *     its body is walked, so a recursive body resolves its own name.
 */

/** Frozen version of the computation IR carried by evidence envelopes. */
export const COMPUTATION_IR_VERSION = "1.0.0" as const;

/** Metadata key under which evidence travels on a normalized session event. */
export const RESIN_COMPUTATION_EVIDENCE_KEY = "resinComputationEvidenceV1" as const;

/**
 * Pinned contract limits. Exceeding a pinned limit is a rejection, never a silent prefix: a parser
 * that cannot fit signals an explicit `unsupported` reason and sets `complete` false.
 */
export const COMPUTATION_IR_LIMITS = {
  /** Maximum canonical serialized size of a program, and of a full evidence envelope. */
  serializedBytes: 32768,
  nodes: 512,
  symbols: 256,
  slots: 64,
  definitions: 32,
  /** Also bounds envelope `dependencies` and `corrections` entries. */
  dependencies: 64,
  /** Maximum AST child-edge depth from a root. def/use recursion is not depth-limited here. */
  nesting: 64,
  /** Bounds only the ESTIMATED authoring-size metrics; never model usage or savings. */
  sourceLines: 100000,
  sourceBytes: 4194304,
} as const;

/**
 * Structural hard caps are a denial-of-service guard for direct (in-process) schema callers: they
 * exist so a wildly oversized payload cannot be fully materialized before rejection. Untrusted input
 * never reaches them because `readComputationEvidence` rejects on canonical bytes first.
 */
const HARD_LIMIT_FACTOR = 4;

/**
 * Stable machine-readable codes prefixed onto `ComputationProgramV1Schema` issue messages.
 * Consumers match the code prefix, not the human-readable remainder.
 */
export const COMPUTATION_VALIDATION_CODES = {
  CANONICAL_ID: "CANONICAL_ID",
  CHILD_ARITY: "CHILD_ARITY",
  CROSS_REF: "CROSS_REF",
  NODE_CYCLE: "NODE_CYCLE",
  NODE_ORDER: "NODE_ORDER",
  NESTING_LIMIT: "NESTING_LIMIT",
  LIMIT_NODES: "LIMIT_NODES",
  LIMIT_SYMBOLS: "LIMIT_SYMBOLS",
  LIMIT_SLOTS: "LIMIT_SLOTS",
  LIMIT_DEFINITIONS: "LIMIT_DEFINITIONS",
  LIMIT_DEPENDENCIES: "LIMIT_DEPENDENCIES",
  LIMIT_SERIALIZED_BYTES: "LIMIT_SERIALIZED_BYTES",
  FIELD_FORM: "FIELD_FORM",
  SYMBOL_SCOPE: "SYMBOL_SCOPE",
  SYMBOL_DECLARATION: "SYMBOL_DECLARATION",
  ORPHAN_SYMBOL: "ORPHAN_SYMBOL",
  ORPHAN_SLOT: "ORPHAN_SLOT",
  DEFINITION_CLOSURE: "DEFINITION_CLOSURE",
  CAPTURE_MISMATCH: "CAPTURE_MISMATCH",
  DEPENDENCY_MISMATCH: "DEPENDENCY_MISMATCH",
  OUTPUT_INVALID: "OUTPUT_INVALID",
  UNSUPPORTED_CONSISTENCY: "UNSUPPORTED_CONSISTENCY",
  SERIALIZATION: "SERIALIZATION",
} as const;

export type ComputationValidationCode =
  (typeof COMPUTATION_VALIDATION_CODES)[keyof typeof COMPUTATION_VALIDATION_CODES];

// ============================================================================
// Finite vocabularies
// ============================================================================

export const COMPUTATION_LANGUAGES = ["python", "javascript", "typescript"] as const;
export type ComputationLanguage = (typeof COMPUTATION_LANGUAGES)[number];

export const COMPUTATION_NODE_KINDS = [
  "program",
  "block",
  "function",
  "parameters",
  "parameter",
  "return",
  "assign",
  "declare",
  "identifier",
  "literal",
  "member",
  "index",
  "call",
  "new",
  "array",
  "tuple",
  "object",
  "pair",
  "lambda",
  "binary",
  "unary",
  "compare",
  "boolean",
  "conditional",
  "if",
  "for",
  "while",
  "try",
  "catch",
  "finally",
  "throw",
  "assert",
  "import",
  "await",
  "break",
  "continue",
  "expression",
  "comprehension",
  "for_clause",
  "if_clause",
  "slice",
  "spread",
  "template",
  "with",
  "yield",
  "unsupported",
] as const;
export type ComputationNodeKind = (typeof COMPUTATION_NODE_KINDS)[number];

/**
 * Node kinds that represent a genuine transform, control-flow or dataflow operation. Together with
 * `COMPUTATION_TRANSFORM_APIS` these are the structural minimum for substantiveness: a program made
 * only of calls, declarations, reads/writes or identity plumbing is never substantive, no matter how
 * many nodes it has. Opportunity *value* ranking is deliberately a later, stricter concern.
 */
export const COMPUTATION_TRANSFORM_NODE_KINDS = [
  "assert",
  "binary",
  "boolean",
  "compare",
  "comprehension",
  "conditional",
  "for",
  "if",
  "slice",
  "template",
  "try",
  "unary",
  "while",
] as const;

/**
 * Node kinds that can carry a binding (declaration site) rather than reading an enclosing scope.
 * Every other symbol use must resolve to a declaration in its own or an enclosing scope, or be an
 * `external`/`import` symbol.
 *
 * `identifier` is included because a binding target is an identifier node: the target of `assign`,
 * `for`, `for_clause` and `with` is `children[0]`, and that identifier introduces the binding.
 */
export const COMPUTATION_SYMBOL_DECLARATION_NODE_KINDS = [
  "catch",
  "declare",
  "function",
  "identifier",
  "import",
  "lambda",
  "parameter",
] as const;

/**
 * Kinds whose OWN `symbol` field is a binding. Deliberately narrower than
 * `COMPUTATION_SYMBOL_DECLARATION_NODE_KINDS`: an `identifier` binds only when it is a binding TARGET
 * (`assign`/`for`/`for_clause`/`with` `children[0]`), which the target rule below handles, so a plain
 * identifier is a read.
 */
const SYMBOL_FIELD_BINDING_NODE_KINDS: Record<string, true> = {
  catch: true,
  declare: true,
  function: true,
  import: true,
  lambda: true,
  parameter: true,
};

const TRANSFORM_NODE_KINDS: Record<string, true> = Object.fromEntries(
  COMPUTATION_TRANSFORM_NODE_KINDS.map((kind) => [kind, true] as const),
);

export const COMPUTATION_BINARY_OPERATORS = [
  "add",
  "and",
  "bit_and",
  "bit_or",
  "bit_xor",
  "coalesce",
  "concat",
  "div",
  "floor_div",
  "matmul",
  "mod",
  "mul",
  "or",
  "pow",
  "shift_left",
  "shift_right",
  "sub",
] as const;
export type ComputationBinaryOperator = (typeof COMPUTATION_BINARY_OPERATORS)[number];

export const COMPUTATION_UNARY_OPERATORS = ["bit_not", "negate", "not", "positive"] as const;
export type ComputationUnaryOperator = (typeof COMPUTATION_UNARY_OPERATORS)[number];

export const COMPUTATION_COMPARE_OPERATORS = [
  "eq",
  "ge",
  "gt",
  "in",
  "is",
  "is_not",
  "le",
  "lt",
  "ne",
  "not_in",
] as const;
export type ComputationCompareOperator = (typeof COMPUTATION_COMPARE_OPERATORS)[number];

/** Short-circuit operators for the n-ary `boolean` node; operand order is the children order. */
export const COMPUTATION_BOOLEAN_OPERATORS = ["and", "coalesce", "or"] as const;
export type ComputationBooleanOperator = (typeof COMPUTATION_BOOLEAN_OPERATORS)[number];

export const COMPUTATION_ASSIGN_OPERATORS = [
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
] as const;
export type ComputationAssignOperator = (typeof COMPUTATION_ASSIGN_OPERATORS)[number];

/**
 * Finite semantic constants. Booleans, `null`, the empty string and the arithmetic identities are
 * representable; any other literal payload (numbers other than 0/1, non-empty strings, bytes,
 * containers with values) is a `literal` node carrying a `slot` instead, so its value never leaves
 * the device while the ALGORITHM still distinguishes e.g. a 0 seed from a 1 seed.
 */
export const COMPUTATION_CONSTANTS = [
  "empty_string",
  "false",
  "null",
  "one",
  "true",
  "zero",
] as const;
export type ComputationConstant = (typeof COMPUTATION_CONSTANTS)[number];

export const COMPUTATION_DECLARE_KINDS = ["const", "global", "let", "local", "var"] as const;
export type ComputationDeclareKind = (typeof COMPUTATION_DECLARE_KINDS)[number];

export const COMPUTATION_PARAMETER_KINDS = [
  "destructured",
  "keyword_only",
  "positional",
  "rest_keyword",
  "rest_positional",
] as const;
export type ComputationParameterKind = (typeof COMPUTATION_PARAMETER_KINDS)[number];

export const COMPUTATION_DEFINITION_KINDS = [
  "async_function",
  "function",
  "generator_function",
  "method",
] as const;
export type ComputationDefinitionKind = (typeof COMPUTATION_DEFINITION_KINDS)[number];

export const COMPUTATION_COMPREHENSION_KINDS = ["dict", "generator", "list", "set"] as const;
export type ComputationComprehensionKind = (typeof COMPUTATION_COMPREHENSION_KINDS)[number];

export const COMPUTATION_SPREAD_KINDS = ["iterable", "mapping"] as const;
export type ComputationSpreadKind = (typeof COMPUTATION_SPREAD_KINDS)[number];

export const COMPUTATION_TEMPLATE_KINDS = ["format", "fstring", "template_literal"] as const;
export type ComputationTemplateKind = (typeof COMPUTATION_TEMPLATE_KINDS)[number];

export const COMPUTATION_WITH_KINDS = ["async_with", "using", "with"] as const;
export type ComputationWithKind = (typeof COMPUTATION_WITH_KINDS)[number];

export const COMPUTATION_SLICE_PARTS = ["lower", "upper", "step"] as const;
export type ComputationSlicePart = (typeof COMPUTATION_SLICE_PARTS)[number];

export const COMPUTATION_SYMBOL_KINDS = [
  "definition",
  "external",
  "import",
  "local",
  "parameter",
] as const;
export type ComputationSymbolKind = (typeof COMPUTATION_SYMBOL_KINDS)[number];

export const COMPUTATION_SLOT_KINDS = [
  "array",
  "boolean",
  "bytes",
  "function",
  "null",
  "number",
  "object",
  "string",
  "unknown",
] as const;
export type ComputationSlotKind = (typeof COMPUTATION_SLOT_KINDS)[number];

export const COMPUTATION_SLOT_ROLES = [
  "dynamic",
  "field_key",
  "free_variable",
  "literal",
  "path",
] as const;
export type ComputationSlotRole = (typeof COMPUTATION_SLOT_ROLES)[number];

export const COMPUTATION_ORIGIN_KINDS = [
  "authored_file",
  "heredoc",
  "inline",
  "referenced_file",
] as const;
export type ComputationOriginKind = (typeof COMPUTATION_ORIGIN_KINDS)[number];

export const COMPUTATION_OBSERVATION_KINDS = ["definition", "invocation"] as const;
export type ComputationObservationKind = (typeof COMPUTATION_OBSERVATION_KINDS)[number];

export const COMPUTATION_OBSERVATION_STATUSES = ["error", "pending", "success"] as const;
export type ComputationObservationStatus = (typeof COMPUTATION_OBSERVATION_STATUSES)[number];

export const COMPUTATION_OUTPUT_SHAPES = [
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
  "tuple",
  "unknown",
] as const;
export type ComputationOutputShape = (typeof COMPUTATION_OUTPUT_SHAPES)[number];

/** Explicit reason codes for every reduction of a program; a non-substantive program always has one. */
export const COMPUTATION_UNSUPPORTED_REASONS = [
  "incomplete_parse",
  "limit_definition",
  "limit_depth",
  "limit_dependencies",
  "limit_nodes",
  "limit_serialized_bytes",
  "limit_slots",
  "limit_symbols",
  "unsupported_api",
  "unsupported_construct",
  "unsupported_dynamic_key",
  "unsupported_external_input",
  "unsupported_hidden_state",
  "unsupported_language",
  "unsupported_mutable_capture",
  "unsupported_operator",
  "unsupported_reflection",
] as const;
export type ComputationUnsupportedReason = (typeof COMPUTATION_UNSUPPORTED_REASONS)[number];

/**
 * Canonical, language-neutral API vocabulary. Arbitrary external or dynamic calls are NOT members: a
 * parser must emit an `unsupported` node (`unsupported_api`) instead. This vocabulary is never an
 * authority grant; the receiver of a method-style API travels in `call.receiver`.
 *
 * Sorted alphabetically for review; the sort order carries no semantics.
 */
export const COMPUTATION_APIS = [
  "clock.monotonic",
  "clock.now",
  "collection.all",
  "collection.any",
  "collection.append",
  "collection.count",
  "collection.delete",
  "collection.entries",
  "collection.extend",
  "collection.filter",
  "collection.find",
  "collection.get",
  "collection.group_by",
  "collection.has",
  "collection.includes",
  "collection.items",
  "collection.join",
  "collection.keys",
  "collection.map",
  "collection.map_set",
  "collection.max",
  "collection.min",
  "collection.pop",
  "collection.reduce",
  "collection.reverse",
  "collection.set_add",
  "collection.slice",
  "collection.sort",
  "collection.sum",
  "collection.values",
  "collection.zip",
  "construct.array",
  "construct.date",
  "construct.error",
  "construct.map",
  "construct.object",
  "construct.set",
  "core.hash",
  "core.len",
  "core.print",
  "core.type_of",
  "fs.exists",
  "fs.read_json",
  "fs.read_text",
  "fs.write_text",
  "identity",
  "json.parse",
  "json.serialize",
  "number.abs",
  "number.ceil",
  "number.float",
  "number.floor",
  "number.format",
  "number.int",
  "number.is_finite",
  "number.max",
  "number.min",
  "number.parse",
  "number.round",
  "object.has_own",
  "path.basename",
  "path.dirname",
  "path.extname",
  "path.join",
  "path.normalize",
  "string.endswith",
  "string.find",
  "string.format",
  "string.join",
  "string.lower",
  "string.replace",
  "string.slice",
  "string.split",
  "string.startswith",
  "string.strip",
  "string.upper",
  "text.regex_findall",
  "text.regex_match",
  "text.regex_replace",
  "text.regex_search",
  "type.is_array",
  "type.is_instance",
] as const;
export type ComputationApi = (typeof COMPUTATION_APIS)[number];

/**
 * Canonical APIs that transform, validate or aggregate data. `print`, `identity`, raw file
 * reads/writes and `json.parse` are intentionally absent: wrapping one of those is not a computation.
 */
export const COMPUTATION_TRANSFORM_APIS = [
  "collection.all",
  "collection.any",
  "collection.count",
  "collection.delete",
  "collection.filter",
  "collection.find",
  "collection.group_by",
  "collection.join",
  "collection.map",
  "collection.max",
  "collection.min",
  "collection.pop",
  "collection.reduce",
  "collection.reverse",
  "collection.set_add",
  "collection.slice",
  "collection.sort",
  "collection.sum",
  "collection.zip",
  "core.hash",
  "json.serialize",
  "number.abs",
  "number.ceil",
  "number.float",
  "number.floor",
  "number.int",
  "number.max",
  "number.min",
  "number.parse",
  "number.round",
  "path.basename",
  "path.dirname",
  "path.extname",
  "path.join",
  "path.normalize",
  "string.format",
  "string.join",
  "string.lower",
  "string.replace",
  "string.slice",
  "string.split",
  "string.strip",
  "string.upper",
  "text.regex_findall",
  "text.regex_match",
  "text.regex_replace",
  "text.regex_search",
] as const;

const TRANSFORM_APIS: Record<string, true> = Object.fromEntries(
  COMPUTATION_TRANSFORM_APIS.map((api) => [api, true] as const),
);

/**
 * Constructor-eligible subset of the canonical vocabulary: a `new` node may only select one of these,
 * since a generic call spelled as construction would otherwise hide an arbitrary external function.
 */
export const COMPUTATION_CONSTRUCT_APIS = COMPUTATION_APIS.filter((api) =>
  api.startsWith("construct."),
);

const CONSTRUCT_APIS: Record<string, true> = Object.fromEntries(
  COMPUTATION_CONSTRUCT_APIS.map((api) => [api, true] as const),
);

/**
 * Normalized field keys that are NEVER preserved as structural names; they must become a `fieldSlot`
 * (role `field_key`) or an `unsupported` node. Mirrors the committed-metadata and component-parameter
 * posture already used in this package: credential-like names, prototype poison and raw-evidence
 * names. Field names are matched after normalization (case, `_`, `-` and `.` are not significant).
 */
export const COMPUTATION_UNSAFE_FIELD_KEYS = [
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "bearer",
  "childprocess",
  "completion",
  "completions",
  "constructor",
  "cookie",
  "cookies",
  "credentials",
  "execsync",
  "generatorhistory",
  "modelmessage",
  "modelmessages",
  "oauthtoken",
  "password",
  "passwd",
  "privatekey",
  "prompt",
  "prompts",
  "proto",
  "prototype",
  "rawcompletion",
  "rawprompt",
  "rawsource",
  "rawtranscript",
  "refreshtoken",
  "secret",
  "secrets",
  "sessiontoken",
  "source",
  "spawnsync",
  "systemprompt",
  "token",
  "tojson",
  "toolinvocationhistory",
  "transcript",
  "transcripts",
] as const;

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const UNSAFE_FIELD_KEY_LOOKUP: Record<string, true> = Object.fromEntries(
  COMPUTATION_UNSAFE_FIELD_KEYS.map((key) => [key, true] as const),
);

/**
 * Secret-like vocabulary rejected in ANY position of a field name, so an embedded secret is caught
 * (`user_api_key`, `authToken`, `sessionId`, `mySecret`) and not only an exact match.
 */
const UNSAFE_FIELD_SEGMENTS: Record<string, true> = {
  api: true,
  auth: true,
  authorization: true,
  bearer: true,
  cookie: true,
  cookies: true,
  credential: true,
  credentials: true,
  key: true,
  oauth: true,
  passwd: true,
  password: true,
  private: true,
  proto: true,
  secret: true,
  secrets: true,
  session: true,
  ssn: true,
  token: true,
};

/**
 * Credential-shaped prefixes rejected when they appear as a whole segment (`sk_live`, `xoxb_team`,
 * `pk_test`, `ghp_...`, `akia...`), without rejecting ordinary words that merely start with those
 * letters (`skillName`, `packageName`).
 */
const UNSAFE_FIELD_PREFIX_SEGMENTS: Record<string, true> = {
  akia: true,
  aws: true,
  ghp: true,
  ghr: true,
  ghs: true,
  gho: true,
  pk: true,
  sk: true,
  xoxa: true,
  xoxb: true,
  xoxp: true,
  xoxr: true,
  xoxs: true,
};

function fieldKeySegments(key: string): string[] {
  return key
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Bounded safe structural key predicate: shape-allowlisted, non-secret-like and prototype-safe.
 * A parser that encounters an unsafe key must emit `pair.fieldSlot`/`member.fieldSlot` instead.
 */
export function isSafeComputationFieldKey(key: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key)) {
    return false;
  }
  const normalized = normalizeFieldKey(key);
  if (
    normalized.length === 0 ||
    Object.prototype.hasOwnProperty.call(UNSAFE_FIELD_KEY_LOOKUP, normalized)
  ) {
    return false;
  }
  return fieldKeySegments(key).every(
    (segment) =>
      !Object.prototype.hasOwnProperty.call(UNSAFE_FIELD_SEGMENTS, segment) &&
      !Object.prototype.hasOwnProperty.call(UNSAFE_FIELD_PREFIX_SEGMENTS, segment),
  );
}

// ============================================================================
// Canonical anonymous ids, digests, safe keys
// ============================================================================

export const ComputationNodeIdSchema = z
  .string()
  .regex(/^n(?:0|[1-9][0-9]{0,3})$/, "Node id must be a canonical anonymous 'n<index>' id");
export type ComputationNodeId = z.infer<typeof ComputationNodeIdSchema>;

export const ComputationSymbolIdSchema = z
  .string()
  .regex(/^sym(?:0|[1-9][0-9]{0,3})$/, "Symbol id must be a canonical anonymous 'sym<index>' id");
export type ComputationSymbolId = z.infer<typeof ComputationSymbolIdSchema>;

export const ComputationSlotIdSchema = z
  .string()
  .regex(/^slot(?:0|[1-9][0-9]{0,3})$/, "Slot id must be a canonical anonymous 'slot<index>' id");
export type ComputationSlotId = z.infer<typeof ComputationSlotIdSchema>;

export const ComputationDefinitionIdSchema = z
  .string()
  .regex(
    /^def(?:0|[1-9][0-9]{0,3})$/,
    "Definition id must be a canonical anonymous 'def<index>' id",
  );
export type ComputationDefinitionId = z.infer<typeof ComputationDefinitionIdSchema>;

export const ComputationScopeIdSchema = z
  .string()
  .regex(
    /^scope(?:0|[1-9][0-9]{0,3})$/,
    "Scope id must be 'scope0' (module) or a definition scope 'scope<index>'",
  );
export type ComputationScopeId = z.infer<typeof ComputationScopeIdSchema>;

/** Canonical lowercase SHA-256 digest, without prefix. */
export const ComputationDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Digest must be 64 lowercase hex characters");
export type ComputationDigest = z.infer<typeof ComputationDigestSchema>;

export const ComputationFieldKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/,
    "Field key must be a bounded safe structural identifier",
  )
  .refine(
    isSafeComputationFieldKey,
    "Secret-like, prototype or raw-evidence field keys must be captured as a field slot instead",
  );
export type ComputationFieldKey = z.infer<typeof ComputationFieldKeySchema>;

/** Normalized relative path pattern only; never an absolute or private machine path. */
export const ComputationPathPatternSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_./*-]*$/,
    "Path pattern must be a normalized relative pattern (no leading '/', '~', '.', drive letter or backslash)",
  )
  .refine(
    (pattern) => !pattern.split("/").includes(".."),
    "Path pattern must not traverse parent directories",
  );
export type ComputationPathPattern = z.infer<typeof ComputationPathPatternSchema>;

// ============================================================================
// Ordered algorithm AST
// ============================================================================

/**
 * Node kinds that parser authors MUST NOT flatten and consumers MUST NOT treat as decoration.
 * Semantics documented here are the authoritative child-order contract for each kind.
 */
export const COMPUTATION_NODE_CHILD_SEMANTICS: Record<ComputationNodeKind, string> = {
  program: "ordered root statements/expressions",
  block: "ordered statements/expressions",
  function: "[parameters, body] — parameters before body",
  parameters: "ordered parameter nodes",
  parameter: "[default value?]",
  return: "[returned expression?]",
  assign: "[target, value] — multiple targets use a tuple target",
  declare: "[initializer?]",
  identifier: "no children",
  literal: "no children",
  member: "[object] — property name is `field` or `fieldSlot`",
  index: "[target, index...]",
  call: "[positional argument...] with keyword arguments ordered in keywordArgs",
  new: "[constructor argument...]",
  array: "ordered elements",
  tuple: "ordered elements",
  object: "ordered pair/spread children",
  pair: "[value] — key is `field` or `fieldSlot`",
  lambda: "[parameters, body] — parameters before body",
  binary: "[left, right]",
  unary: "[operand]",
  compare: "[operand...] with operators.length === children.length - 1 (chain order preserved)",
  boolean:
    "[operand...] with operators.length === children.length - 1 (short-circuit order preserved)",
  conditional: "[test, consequent, alternate]",
  if: "[test, then, else?]",
  for: "[target, iterable, body]",
  while: "[test, body]",
  try: "[body, catch..., finally?] — roles are the child kinds",
  catch: "[body]",
  finally: "[body]",
  throw: "[expression]",
  assert: "[test, message?]",
  import: "no children — module path and imported symbol are structural fields",
  await: "[expression]",
  break: "no children",
  continue: "no children",
  expression: "[expression] — statement-position grouping",
  comprehension: "[element, for_clause..., if_clause...] — clause order preserved",
  for_clause: "[target, iterable]",
  if_clause: "[test]",
  slice:
    "[target, bound...] — `slicePart` is the role of the FIRST bound child and roles continue in [lower, upper, step] order, so an omitted INTERIOR bound is an explicit null constant instead of being dropped (`lo:hi` and `lo::step` are not flattenable)",
  spread: "[argument]",
  template: "ordered interpolation/quasi children",
  with: "[resource, body] — kind given by `withKind`",
  yield: "[expression?]",
  unsupported: "retained children of the unsupported construct, if any",
};

/**
 * Fields abstracted away by the program digest. Everything else is retained verbatim, which keeps the
 * digest semantics-bearing: operators, ordered children, ordered keyword-argument names, control-flow
 * structure, finite constants (`zero`/`one`/`true`/`false`/`null`/`empty_string`), safe structural
 * field keys, and the slice/loop/with/comprehension/optional/async flags.
 *
 * Abstracted are a node's private `symbol` text (projected, see below), its slot payloads, and a data
 * path (`import.modulePath`, exactly like a literal payload). Finite binding keywords (`declKind`,
 * `paramKind`), operators, constants, safe keys and every control-flow flag are semantics, not
 * spelling, so they are retained. A node `symbol` is projected to the
 * definition ordinal it resolves to, or to its bounded kind/scope/ordinal; `slot`/`fieldSlot` are
 * projected to their ordinal plus the bounded slot kind/role. Equality, reuse and def/use
 * relationships therefore survive the digest, while raw identifiers and secret-like keys never do.
 */
const DIGEST_ABSTRACTED_FIELDS: Partial<Record<ComputationNodeKind, readonly string[]>> = {
  import: ["modulePath"],
};

/**
 * Per-kind structural shape consumed by parsers, the cross-reference validator, the canonical
 * traversal and the definition digest, so those cannot drift apart.
 */
export interface ComputationNodeFieldsV1 {
  /** Field names that must be present (beyond `id`, `kind` and `children`). */
  readonly required: readonly string[];
  /** Field names that may be present. */
  readonly optional: readonly string[];
  /** Fields holding a single node id, traversed after `children`. */
  readonly nodeFields: readonly string[];
  /** Fields holding `{name,value}` node-id pairs, traversed after `nodeFields`. */
  readonly keywordArgs: boolean;
}

/**
 * Authoritative per-kind field vocabulary: the node schemas, `ComputationNodeV1Shape` inference and
 * the program digest all derive from it, and `computeComputationProgramDigest` ignores exactly the
 * remaining fields of a kind. Parser authors must not infer fields by string inspection.
 */
export const COMPUTATION_NODE_FIELDS = {
  program: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  block: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  function: {
    required: ["symbol", "scope"],
    optional: ["defKind", "async", "generator"],
    nodeFields: [],
    keywordArgs: false,
  },
  parameters: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  parameter: { required: ["symbol"], optional: ["paramKind"], nodeFields: [], keywordArgs: false },
  return: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  assign: { required: [], optional: ["operator"], nodeFields: [], keywordArgs: false },
  declare: {
    required: ["symbol", "declKind"],
    optional: [],
    nodeFields: [],
    keywordArgs: false,
  },
  identifier: { required: ["symbol"], optional: [], nodeFields: [], keywordArgs: false },
  literal: {
    required: [],
    optional: ["constant", "slot"],
    nodeFields: [],
    keywordArgs: false,
  },
  member: {
    required: [],
    optional: ["field", "fieldSlot"],
    nodeFields: [],
    keywordArgs: false,
  },
  index: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  call: {
    required: [],
    optional: ["api", "symbol", "optional"],
    nodeFields: ["receiver"],
    keywordArgs: true,
  },
  new: { required: ["api"], optional: [], nodeFields: [], keywordArgs: true },
  array: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  tuple: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  object: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  pair: {
    required: [],
    optional: ["field", "fieldSlot"],
    nodeFields: [],
    keywordArgs: false,
  },
  lambda: {
    required: ["symbol", "scope"],
    optional: ["async"],
    nodeFields: [],
    keywordArgs: false,
  },
  binary: { required: ["operator"], optional: [], nodeFields: [], keywordArgs: false },
  unary: { required: ["operator"], optional: [], nodeFields: [], keywordArgs: false },
  compare: { required: ["operators"], optional: [], nodeFields: [], keywordArgs: false },
  boolean: { required: ["operators"], optional: [], nodeFields: [], keywordArgs: false },
  conditional: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  if: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  for: { required: [], optional: ["async"], nodeFields: [], keywordArgs: false },
  while: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  try: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  catch: { required: [], optional: ["symbol"], nodeFields: [], keywordArgs: false },
  finally: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  throw: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  assert: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  import: {
    required: ["modulePath", "symbol"],
    optional: [],
    nodeFields: [],
    keywordArgs: false,
  },
  await: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  break: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  continue: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  expression: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  comprehension: { required: ["compKind"], optional: [], nodeFields: [], keywordArgs: false },
  for_clause: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  if_clause: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  slice: { required: [], optional: ["slicePart"], nodeFields: [], keywordArgs: false },
  spread: { required: ["spreadKind"], optional: [], nodeFields: [], keywordArgs: false },
  template: { required: ["templateKind"], optional: [], nodeFields: [], keywordArgs: false },
  with: { required: ["withKind"], optional: [], nodeFields: [], keywordArgs: false },
  yield: { required: [], optional: [], nodeFields: [], keywordArgs: false },
  unsupported: {
    required: ["unsupportedReason"],
    optional: [],
    nodeFields: [],
    keywordArgs: false,
  },
} as const satisfies Record<ComputationNodeKind, ComputationNodeFieldsV1>;

/**
 * Field shape of the union `ComputationNodeV1`, derived from the vocabulary above. Consumers can
 * narrow by `kind` and read fields without guessing.
 */
export type ComputationNodeV1Shape<K extends ComputationNodeKind> = {
  readonly id: ComputationNodeId;
  readonly kind: K;
  readonly children: readonly ComputationNodeId[];
} & {
  readonly [P in (typeof COMPUTATION_NODE_FIELDS)[K]["required"][number]]: unknown;
} & {
  readonly [P in (typeof COMPUTATION_NODE_FIELDS)[K]["optional"][number]]?: unknown;
} & (K extends "call" | "new"
    ? { readonly keywordArgs?: readonly ComputationKeywordArg[] }
    : unknown);

/** Narrowing helper: the node type for one kind. */
export type ComputationNodeOfKind<K extends ComputationNodeKind> = Extract<
  ComputationNodeV1,
  { kind: K }
>;

const NodeIdList = z.array(ComputationNodeIdSchema);

function childrenOf(min: number, max: number) {
  return NodeIdList.min(min).max(max);
}

/**
 * Strict per-kind node builder. Fields declared here are the complete allowed key set: unknown keys,
 * raw identifiers, arbitrary values and escape-hatch properties are rejected by `.strict()`.
 */
function nodeOf<K extends ComputationNodeKind, T extends z.ZodRawShape>(
  kind: K,
  children: z.ZodArray<typeof ComputationNodeIdSchema>,
  fields: T,
) {
  return z
    .object({
      id: ComputationNodeIdSchema,
      kind: z.literal(kind),
      children,
      ...fields,
    })
    .strict();
}

// `key` is the one finite keyword-argument name that is also secret-adjacent vocabulary, so it is
// admitted here as an explicit literal rather than by relaxing `ComputationFieldKeySchema` (which
// keeps rejecting `key` everywhere a STRUCTURAL field key is claimed).
const KeywordArgNameSchema = z.union([z.literal("key"), ComputationFieldKeySchema]);

const KeywordArgSchema = z
  .object({ name: KeywordArgNameSchema, value: ComputationNodeIdSchema })
  .strict();
export type ComputationKeywordArg = z.infer<typeof KeywordArgSchema>;

const UNBOUNDED = COMPUTATION_IR_LIMITS.nodes;
const KeywordArgsSchema = z.array(KeywordArgSchema).max(COMPUTATION_IR_LIMITS.nodes);

export const ComputationProgramNodeSchema = nodeOf("program", childrenOf(0, UNBOUNDED), {});

export const ComputationBlockNodeSchema = nodeOf("block", childrenOf(0, UNBOUNDED), {});

export const ComputationFunctionNodeSchema = nodeOf("function", childrenOf(2, 2), {
  symbol: ComputationSymbolIdSchema,
  scope: ComputationScopeIdSchema,
  async: z.boolean().optional(),
  defKind: z.enum(COMPUTATION_DEFINITION_KINDS).optional(),
  generator: z.boolean().optional(),
});

export const ComputationParametersNodeSchema = nodeOf("parameters", childrenOf(0, UNBOUNDED), {});

export const ComputationParameterNodeSchema = nodeOf("parameter", childrenOf(0, 1), {
  symbol: ComputationSymbolIdSchema,
  paramKind: z.enum(COMPUTATION_PARAMETER_KINDS).optional(),
});

export const ComputationReturnNodeSchema = nodeOf("return", childrenOf(0, 1), {});

export const ComputationAssignNodeSchema = nodeOf("assign", childrenOf(2, 2), {
  operator: z.enum(COMPUTATION_ASSIGN_OPERATORS).optional(),
});

export const ComputationDeclareNodeSchema = nodeOf("declare", childrenOf(0, 1), {
  symbol: ComputationSymbolIdSchema,
  declKind: z.enum(COMPUTATION_DECLARE_KINDS),
});

export const ComputationIdentifierNodeSchema = nodeOf("identifier", childrenOf(0, 0), {
  symbol: ComputationSymbolIdSchema,
});

export const ComputationLiteralNodeSchema = nodeOf("literal", childrenOf(0, 0), {
  constant: z.enum(COMPUTATION_CONSTANTS).optional(),
  slot: ComputationSlotIdSchema.optional(),
});

export const ComputationMemberNodeSchema = nodeOf("member", childrenOf(1, 1), {
  field: ComputationFieldKeySchema.optional(),
  fieldSlot: ComputationSlotIdSchema.optional(),
});

export const ComputationIndexNodeSchema = nodeOf("index", childrenOf(2, UNBOUNDED), {});

export const ComputationCallNodeSchema = nodeOf("call", childrenOf(0, UNBOUNDED), {
  api: z.enum(COMPUTATION_APIS).optional(),
  symbol: ComputationSymbolIdSchema.optional(),
  receiver: ComputationNodeIdSchema.optional(),
  optional: z.boolean().optional(),
  keywordArgs: KeywordArgsSchema.optional(),
});

export const ComputationNewNodeSchema = nodeOf("new", childrenOf(0, UNBOUNDED), {
  api: z.enum(COMPUTATION_APIS),
  keywordArgs: KeywordArgsSchema.optional(),
});

export const ComputationArrayNodeSchema = nodeOf("array", childrenOf(0, UNBOUNDED), {});

export const ComputationTupleNodeSchema = nodeOf("tuple", childrenOf(0, UNBOUNDED), {});

export const ComputationObjectNodeSchema = nodeOf("object", childrenOf(0, UNBOUNDED), {});

export const ComputationPairNodeSchema = nodeOf("pair", childrenOf(1, 1), {
  field: ComputationFieldKeySchema.optional(),
  fieldSlot: ComputationSlotIdSchema.optional(),
});

export const ComputationLambdaNodeSchema = nodeOf("lambda", childrenOf(2, 2), {
  symbol: ComputationSymbolIdSchema,
  scope: ComputationScopeIdSchema,
  async: z.boolean().optional(),
});

export const ComputationBinaryNodeSchema = nodeOf("binary", childrenOf(2, 2), {
  operator: z.enum(COMPUTATION_BINARY_OPERATORS),
});

export const ComputationUnaryNodeSchema = nodeOf("unary", childrenOf(1, 1), {
  operator: z.enum(COMPUTATION_UNARY_OPERATORS),
});

export const ComputationCompareNodeSchema = nodeOf("compare", childrenOf(2, UNBOUNDED), {
  operators: z.array(z.enum(COMPUTATION_COMPARE_OPERATORS)).min(1).max(COMPUTATION_IR_LIMITS.nodes),
});

export const ComputationBooleanNodeSchema = nodeOf("boolean", childrenOf(2, UNBOUNDED), {
  operators: z.array(z.enum(COMPUTATION_BOOLEAN_OPERATORS)).min(1).max(COMPUTATION_IR_LIMITS.nodes),
});

export const ComputationConditionalNodeSchema = nodeOf("conditional", childrenOf(3, 3), {});

export const ComputationIfNodeSchema = nodeOf("if", childrenOf(2, 3), {});

export const ComputationForNodeSchema = nodeOf("for", childrenOf(3, 3), {
  async: z.boolean().optional(),
});

export const ComputationWhileNodeSchema = nodeOf("while", childrenOf(2, 2), {});

export const ComputationTryNodeSchema = nodeOf("try", childrenOf(1, UNBOUNDED), {});

export const ComputationCatchNodeSchema = nodeOf("catch", childrenOf(1, 1), {
  symbol: ComputationSymbolIdSchema.optional(),
});

export const ComputationFinallyNodeSchema = nodeOf("finally", childrenOf(1, 1), {});

export const ComputationThrowNodeSchema = nodeOf("throw", childrenOf(1, 1), {});

export const ComputationAssertNodeSchema = nodeOf("assert", childrenOf(1, 2), {});

export const ComputationImportNodeSchema = nodeOf("import", childrenOf(0, 0), {
  modulePath: ComputationPathPatternSchema,
  symbol: ComputationSymbolIdSchema,
});

export const ComputationAwaitNodeSchema = nodeOf("await", childrenOf(1, 1), {});

export const ComputationBreakNodeSchema = nodeOf("break", childrenOf(0, 0), {});

export const ComputationContinueNodeSchema = nodeOf("continue", childrenOf(0, 0), {});

export const ComputationExpressionNodeSchema = nodeOf("expression", childrenOf(1, 1), {});

export const ComputationComprehensionNodeSchema = nodeOf(
  "comprehension",
  childrenOf(2, UNBOUNDED),
  {
    compKind: z.enum(COMPUTATION_COMPREHENSION_KINDS),
  },
);

export const ComputationForClauseNodeSchema = nodeOf("for_clause", childrenOf(2, 2), {});

export const ComputationIfClauseNodeSchema = nodeOf("if_clause", childrenOf(1, 1), {});

export const ComputationSliceNodeSchema = nodeOf("slice", childrenOf(1, 4), {
  slicePart: z.enum(COMPUTATION_SLICE_PARTS).optional(),
});

export const ComputationSpreadNodeSchema = nodeOf("spread", childrenOf(1, 1), {
  spreadKind: z.enum(COMPUTATION_SPREAD_KINDS),
});

export const ComputationTemplateNodeSchema = nodeOf("template", childrenOf(0, UNBOUNDED), {
  templateKind: z.enum(COMPUTATION_TEMPLATE_KINDS),
});

export const ComputationWithNodeSchema = nodeOf("with", childrenOf(2, 2), {
  withKind: z.enum(COMPUTATION_WITH_KINDS),
});

export const ComputationYieldNodeSchema = nodeOf("yield", childrenOf(0, 1), {});

export const ComputationUnsupportedNodeSchema = nodeOf("unsupported", childrenOf(0, UNBOUNDED), {
  unsupportedReason: z.enum(COMPUTATION_UNSUPPORTED_REASONS),
});

/**
 * Complete discriminated union of ordered AST nodes. `kind` selects the strict field shape.
 */
export const ComputationNodeSchema = z.discriminatedUnion("kind", [
  ComputationProgramNodeSchema,
  ComputationBlockNodeSchema,
  ComputationFunctionNodeSchema,
  ComputationParametersNodeSchema,
  ComputationParameterNodeSchema,
  ComputationReturnNodeSchema,
  ComputationAssignNodeSchema,
  ComputationDeclareNodeSchema,
  ComputationIdentifierNodeSchema,
  ComputationLiteralNodeSchema,
  ComputationMemberNodeSchema,
  ComputationIndexNodeSchema,
  ComputationCallNodeSchema,
  ComputationNewNodeSchema,
  ComputationArrayNodeSchema,
  ComputationTupleNodeSchema,
  ComputationObjectNodeSchema,
  ComputationPairNodeSchema,
  ComputationLambdaNodeSchema,
  ComputationBinaryNodeSchema,
  ComputationUnaryNodeSchema,
  ComputationCompareNodeSchema,
  ComputationBooleanNodeSchema,
  ComputationConditionalNodeSchema,
  ComputationIfNodeSchema,
  ComputationForNodeSchema,
  ComputationWhileNodeSchema,
  ComputationTryNodeSchema,
  ComputationCatchNodeSchema,
  ComputationFinallyNodeSchema,
  ComputationThrowNodeSchema,
  ComputationAssertNodeSchema,
  ComputationImportNodeSchema,
  ComputationAwaitNodeSchema,
  ComputationBreakNodeSchema,
  ComputationContinueNodeSchema,
  ComputationExpressionNodeSchema,
  ComputationComprehensionNodeSchema,
  ComputationForClauseNodeSchema,
  ComputationIfClauseNodeSchema,
  ComputationSliceNodeSchema,
  ComputationSpreadNodeSchema,
  ComputationTemplateNodeSchema,
  ComputationWithNodeSchema,
  ComputationYieldNodeSchema,
  ComputationUnsupportedNodeSchema,
]);

export type ComputationNodeV1 = z.infer<typeof ComputationNodeSchema>;

// ============================================================================
// Symbols, slots, definitions, outputs, program
// ============================================================================

export const ComputationSymbolSchema = z
  .object({
    id: ComputationSymbolIdSchema,
    kind: z.enum(COMPUTATION_SYMBOL_KINDS),
    scope: ComputationScopeIdSchema,
    /** Definition node id that introduces the symbol (declaration site). */
    node: ComputationNodeIdSchema.optional(),
  })
  .strict();
export type ComputationSymbolV1 = z.infer<typeof ComputationSymbolSchema>;

export const ComputationSlotSchema = z
  .object({
    id: ComputationSlotIdSchema,
    kind: z.enum(COMPUTATION_SLOT_KINDS),
    role: z.enum(COMPUTATION_SLOT_ROLES),
  })
  .strict();
export type ComputationSlotV1 = z.infer<typeof ComputationSlotSchema>;

/**
 * Materialized dependency closure entry for one authored definition. `dependencies` lists the
 * definition symbols this definition uses, INCLUDING itself when it recurses, so mutual recursion is
 * fully resolved here and downstream consumers need no private kernel state.
 */
export const ComputationDefinitionSchema = z
  .object({
    id: ComputationDefinitionIdSchema,
    kind: z.enum(COMPUTATION_DEFINITION_KINDS),
    nameSymbol: ComputationSymbolIdSchema,
    parameters: z.array(ComputationSymbolIdSchema).max(COMPUTATION_IR_LIMITS.symbols),
    body: ComputationNodeIdSchema,
    dependencies: z.array(ComputationSymbolIdSchema).max(COMPUTATION_IR_LIMITS.definitions),
    /** True when the definition reaches itself through `dependencies` (possibly mutually). */
    recursive: z.boolean(),
    scope: ComputationScopeIdSchema,
    complete: z.boolean(),
    unsupportedReasons: z.array(z.enum(COMPUTATION_UNSUPPORTED_REASONS)).max(8),
  })
  .strict();
export type ComputationDefinitionV1 = z.infer<typeof ComputationDefinitionSchema>;

/** Bounded structural output shape only; output values never appear in the IR. */
export const ComputationOutputSchema = z
  .object({
    /** `return` or `yield` node id, or an `expression` node for an emitted value. */
    node: ComputationNodeIdSchema,
    shape: z.enum(COMPUTATION_OUTPUT_SHAPES),
    definitionId: ComputationDefinitionIdSchema.optional(),
  })
  .strict();
export type ComputationOutputV1 = z.infer<typeof ComputationOutputSchema>;

const ProgramBodyShape = {
  version: z.literal(COMPUTATION_IR_VERSION),
  language: z.enum(COMPUTATION_LANGUAGES),
  nodes: z.array(ComputationNodeSchema).max(COMPUTATION_IR_LIMITS.nodes * HARD_LIMIT_FACTOR),
  symbols: z.array(ComputationSymbolSchema).max(COMPUTATION_IR_LIMITS.symbols * HARD_LIMIT_FACTOR),
  slots: z.array(ComputationSlotSchema).max(COMPUTATION_IR_LIMITS.slots * HARD_LIMIT_FACTOR),
  definitions: z
    .array(ComputationDefinitionSchema)
    .max(COMPUTATION_IR_LIMITS.definitions * HARD_LIMIT_FACTOR),
  /** Ordered root node ids; the order is the program's top-level execution order. */
  roots: z
    .array(ComputationNodeIdSchema)
    .min(1)
    .max(COMPUTATION_IR_LIMITS.nodes * HARD_LIMIT_FACTOR),
  outputs: z.array(ComputationOutputSchema).max(COMPUTATION_IR_LIMITS.definitions + 1),
  /** False whenever any part of the authored computation could not be represented. */
  complete: z.boolean(),
  unsupportedReasons: z.array(z.enum(COMPUTATION_UNSUPPORTED_REASONS)).max(16),
};

/**
 * Structural cross-reference check for a program body, independent of Zod strictness. Runs on the
 * parsed value only; exceeding a pinned limit is a rejection, never a truncation.
 *
 * Checked here: canonical positional ids, AST child arity and acyclic child edges, nesting and size
 * limits, node field forms, cross-references, symbol scope-safety, the materialized def/use closure
 * (recursion and mutual recursion included), output shape references and unsupported-reason
 * consistency.
 */
function checkProgramStructure(program: {
  nodes: readonly ComputationNodeV1[];
  symbols: readonly ComputationSymbolV1[];
  slots: readonly ComputationSlotV1[];
  definitions: readonly ComputationDefinitionV1[];
  roots: readonly string[];
  outputs: readonly ComputationOutputV1[];
  complete: boolean;
  unsupportedReasons: readonly string[];
}): Array<{ path: readonly (string | number)[]; message: string }> {
  const issues: Array<{ path: readonly (string | number)[]; message: string }> = [];
  const report = (
    path: readonly (string | number)[],
    code: ComputationValidationCode,
    detail: string,
  ) => issues.push({ path, message: `${code}: ${detail}` });

  if (program.nodes.length > COMPUTATION_IR_LIMITS.nodes) {
    report(["nodes"], COMPUTATION_VALIDATION_CODES.LIMIT_NODES, "node limit exceeded");
  }
  if (program.symbols.length > COMPUTATION_IR_LIMITS.symbols) {
    report(["symbols"], COMPUTATION_VALIDATION_CODES.LIMIT_SYMBOLS, "symbol limit exceeded");
  }
  if (program.slots.length > COMPUTATION_IR_LIMITS.slots) {
    report(["slots"], COMPUTATION_VALIDATION_CODES.LIMIT_SLOTS, "slot limit exceeded");
  }
  if (program.definitions.length > COMPUTATION_IR_LIMITS.definitions) {
    report(
      ["definitions"],
      COMPUTATION_VALIDATION_CODES.LIMIT_DEFINITIONS,
      "definition limit exceeded",
    );
  }

  const nodeById = new Map<string, { index: number; value: ComputationNodeV1 }>();
  program.nodes.forEach((node, index) => {
    if (node.id !== `n${index}`) {
      report(
        ["nodes", index, "id"],
        COMPUTATION_VALIDATION_CODES.NODE_ORDER,
        `nodes must be in canonical pre-order with positional ids; expected 'n${index}'`,
      );
    }
    nodeById.set(node.id, { index, value: node });
  });

  const symbolById = new Map<string, ComputationSymbolV1>();
  program.symbols.forEach((symbol, index) => {
    if (symbol.id !== `sym${index}`) {
      report(
        ["symbols", index, "id"],
        COMPUTATION_VALIDATION_CODES.CANONICAL_ID,
        `symbols must be positional anonymous ids; expected 'sym${index}'`,
      );
    }
    symbolById.set(symbol.id, symbol);
  });

  const slotById = new Map<string, ComputationSlotV1>();
  program.slots.forEach((slot, index) => {
    if (slot.id !== `slot${index}`) {
      report(
        ["slots", index, "id"],
        COMPUTATION_VALIDATION_CODES.CANONICAL_ID,
        `slots must be positional anonymous ids; expected 'slot${index}'`,
      );
    }
    slotById.set(slot.id, slot);
  });

  const definitionIndexById = new Map<string, number>();
  const definitionBySymbol = new Map<string, ComputationDefinitionV1>();
  const definitionBodyIds = new Set<string>();
  program.definitions.forEach((definition, index) => {
    if (definition.id !== `def${index}`) {
      report(
        ["definitions", index, "id"],
        COMPUTATION_VALIDATION_CODES.CANONICAL_ID,
        `definitions must be positional anonymous ids; expected 'def${index}'`,
      );
    }
    if (definition.scope !== `scope${index + 1}`) {
      report(
        ["definitions", index, "scope"],
        COMPUTATION_VALIDATION_CODES.CANONICAL_ID,
        `definition scope must be 'scope${index + 1}'`,
      );
    }
    if (definitionBySymbol.has(definition.nameSymbol)) {
      report(
        ["definitions", index, "nameSymbol"],
        COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
        "each definition symbol may carry at most one definition record",
      );
    }
    definitionIndexById.set(definition.id, index);
    definitionBySymbol.set(definition.nameSymbol, definition);
    definitionBodyIds.add(definition.body);
  });

  /**
   * Nested scopes: a function/lambda that is NOT a definition body introduces one. Scope ids are
   * positional — `scope0` is the module, `scope1..scopeN` belong to `def0..def(N-1)`, and each
   * nested function takes `scope(N + k)` in canonical node order. That keeps them deterministic while
   * letting a real parser emit inline lambdas such as `sort(key=lambda row: ...)`.
   */
  const nestedScopeByNode = new Map<string, string>();
  for (const node of program.nodes) {
    if ((node.kind === "function" || node.kind === "lambda") && !definitionBodyIds.has(node.id)) {
      nestedScopeByNode.set(
        node.id,
        `scope${program.definitions.length + nestedScopeByNode.size + 1}`,
      );
    }
  }
  const definitionScopes = new Set(program.definitions.map((definition) => definition.scope));
  const knownScopes = new Set<string>([
    "scope0",
    ...definitionScopes,
    ...nestedScopeByNode.values(),
  ]);

  const referenceNode = (path: readonly (string | number)[], id: string) => {
    if (!nodeById.has(id)) {
      report(path, COMPUTATION_VALIDATION_CODES.CROSS_REF, `unknown node reference '${id}'`);
      return false;
    }
    return true;
  };

  const usedSymbols = new Set<string>();
  const usedSlots = new Set<string>();
  const declarationSites = new Map<string, string[]>();
  const readSites: Array<{ nodeId: string; symbolId: string }> = [];
  const enclosingScope = new Map<string, string>();

  /** Target expressions that introduce a binding, per `COMPUTATION_NODE_CHILD_SEMANTICS`. */
  const bindingTargetKinds: Record<string, true> = {
    assign: true,
    for: true,
    for_clause: true,
    with: true,
  };

  program.nodes.forEach((node, index) => {
    const nodePath = ["nodes", index] as const;
    const record = node as unknown as Record<string, unknown>;

    if (node.kind === "literal" && (node.constant === undefined) === (node.slot === undefined)) {
      // Exactly one representation: a finite constant or an anonymous slot, never both and never neither.
      report(
        [...nodePath, "constant"],
        COMPUTATION_VALIDATION_CODES.FIELD_FORM,
        "a literal node must carry exactly one of a finite constant or an anonymous slot",
      );
    }
    if (node.kind === "member" || node.kind === "pair") {
      if ((node.field === undefined) === (node.fieldSlot === undefined)) {
        report(
          [...nodePath, "field"],
          COMPUTATION_VALIDATION_CODES.FIELD_FORM,
          "exactly one of 'field' or 'fieldSlot' is required",
        );
      }
    }
    if (node.kind === "compare" || node.kind === "boolean") {
      if (node.operators.length !== node.children.length - 1) {
        report(
          [...nodePath, "operators"],
          COMPUTATION_VALIDATION_CODES.CHILD_ARITY,
          `expected ${node.children.length - 1} operator(s) for ${node.children.length} operand(s)`,
        );
      }
    }
    if (node.kind === "slice") {
      const boundCount = node.children.length - 1;
      if (boundCount > 0 && node.slicePart === undefined) {
        report(
          [...nodePath, "slicePart"],
          COMPUTATION_VALIDATION_CODES.FIELD_FORM,
          "a slice with bounds must declare 'slicePart'",
        );
      }
      if (node.slicePart !== undefined) {
        // Bound roles are contiguous from `slicePart` onward, and an omitted interior bound must be an
        // explicit node. So the bound count is bounded by the roles remaining from `slicePart`, which is
        // what keeps `lo:hi` (lower, upper) distinguishable from `lo::step` (lower, null, step).
        const remainingRoles =
          COMPUTATION_SLICE_PARTS.length - COMPUTATION_SLICE_PARTS.indexOf(node.slicePart);
        if (boundCount < 1 || boundCount > remainingRoles) {
          report(
            [...nodePath, "children"],
            COMPUTATION_VALIDATION_CODES.CHILD_ARITY,
            `slicePart '${node.slicePart}' allows 1..${remainingRoles} bound(s) after the target, received ${boundCount}`,
          );
        }
      }
    }
    if (node.kind === "call") {
      // A complete call is either a finite canonical API or a resolved authored helper. Anything else
      // (dynamic dispatch, a captured handle, an unresolved alias) must be an `unsupported` node.
      if ((node.api === undefined) === (node.symbol === undefined)) {
        report(
          [...nodePath, "api"],
          COMPUTATION_VALIDATION_CODES.FIELD_FORM,
          "a call must select exactly one of a finite canonical 'api' or a resolved definition 'symbol'",
        );
      }
      if (node.symbol !== undefined) {
        const callee = symbolById.get(node.symbol);
        if (
          callee === undefined ||
          callee.kind !== "definition" ||
          !definitionBySymbol.has(node.symbol)
        ) {
          report(
            [...nodePath, "symbol"],
            COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
            `call target '${node.symbol}' must be a materialized definition symbol (aliases resolve in the parser)`,
          );
        }
      }
    }
    if (node.kind === "new") {
      if (!Object.prototype.hasOwnProperty.call(CONSTRUCT_APIS, node.api)) {
        report(
          [...nodePath, "api"],
          COMPUTATION_VALIDATION_CODES.FIELD_FORM,
          `'new' must construct a 'construct.*' API, received '${node.api}'`,
        );
      }
    }
    if ((node.kind === "call" || node.kind === "new") && node.keywordArgs !== undefined) {
      const seenNames = new Set<string>();
      node.keywordArgs.forEach((arg, argIndex) => {
        if (seenNames.has(arg.name)) {
          report(
            [...nodePath, "keywordArgs", argIndex, "name"],
            COMPUTATION_VALIDATION_CODES.FIELD_FORM,
            `duplicate keyword argument name '${arg.name}'`,
          );
        }
        seenNames.add(arg.name);
      });
    }
    if (node.kind === "function" || node.kind === "lambda") {
      const isDefinitionBody = definitionBodyIds.has(node.id);
      const ownerIndex = Number(node.scope.slice("scope".length)) - 1;
      const claimedDefinition =
        Number.isInteger(ownerIndex) && ownerIndex >= 0
          ? program.definitions[ownerIndex]
          : undefined;
      if (isDefinitionBody) {
        const owner = program.definitions.find((definition) => definition.body === node.id);
        if (owner === undefined || owner.scope !== node.scope) {
          report(
            [...nodePath, "scope"],
            COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
            `definition body '${node.id}' must claim its definition scope '${owner?.scope ?? "unknown"}'`,
          );
        } else if (owner.nameSymbol !== node.symbol) {
          report(
            [...nodePath, "scope"],
            COMPUTATION_VALIDATION_CODES.CAPTURE_MISMATCH,
            `definition body '${node.id}' must declare the definition symbol '${owner.nameSymbol}'`,
          );
        }
      } else {
        const expectedScope = nestedScopeByNode.get(node.id);
        if (node.scope !== expectedScope) {
          report(
            [...nodePath, "scope"],
            COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
            `nested function scope must be '${expectedScope ?? "a definition scope"}'`,
          );
        }
        if (claimedDefinition !== undefined) {
          report(
            [...nodePath, "scope"],
            COMPUTATION_VALIDATION_CODES.CAPTURE_MISMATCH,
            `nested function '${node.id}' must not claim definition scope '${node.scope}'`,
          );
        }
      }
    }

    const isDeclarationKind = Object.prototype.hasOwnProperty.call(
      SYMBOL_FIELD_BINDING_NODE_KINDS,
      node.kind,
    );
    if (isDeclarationKind && typeof record.symbol === "string") {
      const sites = declarationSites.get(record.symbol) ?? [];
      sites.push(node.id);
      declarationSites.set(record.symbol, sites);
    }
    if (
      Object.prototype.hasOwnProperty.call(bindingTargetKinds, node.kind) &&
      node.children.length > 0
    ) {
      const target = nodeById.get(node.children[0])?.value;
      if (target !== undefined && target.kind === "identifier") {
        const sites = declarationSites.get(target.symbol) ?? [];
        sites.push(target.id);
        declarationSites.set(target.symbol, sites);
      }
    }

    for (const [field, value] of Object.entries(record)) {
      if (value === undefined) {
        continue;
      }
      if (field === "symbol") {
        if (typeof value === "string") {
          if (!symbolById.has(value)) {
            report(
              [...nodePath, field],
              COMPUTATION_VALIDATION_CODES.CROSS_REF,
              `unknown symbol reference '${value}'`,
            );
          } else if (!(declarationSites.get(value) ?? []).includes(node.id)) {
            // A read, not a binding: this is the site that makes the symbol live and that a
            // definition's dependency list must reflect.
            usedSymbols.add(value);
            readSites.push({ nodeId: node.id, symbolId: value });
          }
        }
        continue;
      }
      if (field === "slot" || field === "fieldSlot") {
        if (typeof value === "string") {
          if (slotById.has(value)) {
            usedSlots.add(value);
          } else {
            report(
              [...nodePath, field],
              COMPUTATION_VALIDATION_CODES.CROSS_REF,
              `unknown slot reference '${value}'`,
            );
          }
        }
      }
      if (field === "scope" && typeof value === "string" && !knownScopes.has(value)) {
        report(
          [...nodePath, field],
          COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
          `unknown scope '${value}'`,
        );
      }
    }

    node.children.forEach((child, childIndex) =>
      referenceNode([...nodePath, "children", childIndex], child),
    );
    for (const field of COMPUTATION_NODE_FIELDS[node.kind].nodeFields) {
      const value = record[field];
      if (typeof value === "string") {
        referenceNode([...nodePath, field], value);
      }
    }
    if ((node.kind === "call" || node.kind === "new") && node.keywordArgs !== undefined) {
      node.keywordArgs.forEach((arg, argIndex) => {
        referenceNode([...nodePath, "keywordArgs", argIndex, "value"], arg.value);
      });
    }
  });

  // Scope tree and node containment: scope0 is the module, definition scopes are owned by definition
  // bodies, and nested function/lambda nodes own their own scopes. Containment is child-edge based, so
  // it proves declaration placement rather than definition reachability.
  const scopeParent = new Map<string, string>();
  const parentOf = new Map<string, string>();
  const assignScope = (id: string, scope: string) => {
    enclosingScope.set(id, scope);
    const node = nodeById.get(id)?.value;
    if (node === undefined) {
      return;
    }
    const childScope = node.kind === "function" || node.kind === "lambda" ? node.scope : scope;
    if (childScope !== scope && !scopeParent.has(childScope)) {
      scopeParent.set(childScope, scope);
    }
    // The canonical pre-order form is a TREE: sharing one node between two parents would make the
    // positional ids and the canonical traversal ambiguous, so a second parent is rejected.
    for (const ref of computationChildRefs(node)) {
      const existingParent = parentOf.get(ref);
      if (existingParent !== undefined) {
        if (existingParent !== id) {
          report(
            ["nodes", nodeById.get(ref)?.index ?? 0, "id"],
            COMPUTATION_VALIDATION_CODES.CROSS_REF,
            `node '${ref}' is referenced from more than one parent; the canonical form is a tree`,
          );
        }
        continue;
      }
      parentOf.set(ref, id);
      assignScope(ref, childScope);
    }
  };
  for (const root of program.roots) {
    assignScope(root, "scope0");
  }

  const scopeChain = (scope: string): string[] => {
    const chain = [scope];
    let current = scope;
    while (current !== "scope0") {
      const parent = scopeParent.get(current);
      if (parent === undefined || chain.includes(parent)) {
        break;
      }
      chain.push(parent);
      current = parent;
    }
    return chain;
  };

  const BINDING_DECLARATION_KINDS: Record<string, readonly ComputationNodeKind[]> = {
    // A local is bound either by its own `declare`/`catch` node or by being the binding TARGET of an
    // `assign`/`for`/`for_clause`/`with`, which is always an `identifier` node (`children[0]`).
    // A nested function/lambda introduces its binding in the enclosing scope, so `function`/`lambda`
    // are legitimate binding sites for a local.
    local: ["identifier", "declare", "catch", "function", "lambda"],
    parameter: ["parameter"],
    definition: ["function", "lambda"],
    import: ["import"],
    external: [],
  };

  program.symbols.forEach((symbol, index) => {
    const symbolPath = ["symbols", index] as const;
    const sites = declarationSites.get(symbol.id) ?? [];
    const allowedKinds = BINDING_DECLARATION_KINDS[symbol.kind] ?? [];

    for (const siteId of sites) {
      const site = nodeById.get(siteId);
      if (site === undefined) {
        report(
          symbolPath,
          COMPUTATION_VALIDATION_CODES.CROSS_REF,
          `unknown symbol binding '${siteId}'`,
        );
        continue;
      }
      if (allowedKinds.length > 0 && !allowedKinds.includes(site.value.kind)) {
        report(
          [...symbolPath, "kind"],
          COMPUTATION_VALIDATION_CODES.SYMBOL_DECLARATION,
          `symbol '${symbol.id}' of kind '${symbol.kind}' cannot be bound by a '${site.value.kind}' node`,
        );
      }
      const siteScope = enclosingScope.get(siteId);
      if (siteScope !== undefined && siteScope !== symbol.scope) {
        report(
          [...symbolPath, "scope"],
          COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
          `symbol '${symbol.id}' is declared in '${siteScope}' but claims scope '${symbol.scope}'`,
        );
      }
    }

    if (symbol.node !== undefined) {
      if (!nodeById.has(symbol.node)) {
        report(
          [...symbolPath, "node"],
          COMPUTATION_VALIDATION_CODES.CROSS_REF,
          `unknown declaration node '${symbol.node}'`,
        );
      } else if (!sites.includes(symbol.node)) {
        report(
          [...symbolPath, "node"],
          COMPUTATION_VALIDATION_CODES.SYMBOL_DECLARATION,
          `declaration node '${symbol.node}' does not bind symbol '${symbol.id}'`,
        );
      }
    } else if (sites.length > 0) {
      report(
        [...symbolPath, "node"],
        COMPUTATION_VALIDATION_CODES.SYMBOL_DECLARATION,
        `symbol '${symbol.id}' is bound at ${sites[0]} but declares no declaration node`,
      );
    }

    if (symbol.kind === "external" && sites.length > 0) {
      report(
        [...symbolPath, "kind"],
        COMPUTATION_VALIDATION_CODES.SYMBOL_DECLARATION,
        `external symbol '${symbol.id}' must not be bound in the captured program`,
      );
    }
    if (symbol.kind === "parameter" && sites.length === 0) {
      report(
        [...symbolPath, "kind"],
        COMPUTATION_VALIDATION_CODES.SYMBOL_DECLARATION,
        `parameter symbol '${symbol.id}' has no 'parameter' declaration node`,
      );
    }
    if (symbol.kind === "local" && sites.length === 0) {
      // A local that is read but never bound anywhere is a capture of hidden kernel state.
      report(
        [...symbolPath, "kind"],
        COMPUTATION_VALIDATION_CODES.SYMBOL_DECLARATION,
        usedSymbols.has(symbol.id)
          ? `symbol '${symbol.id}' is read but never declared; undeclared captures are unsupported hidden state`
          : `symbol '${symbol.id}' is neither declared nor used`,
      );
    }
    if (symbol.kind === "external" && !usedSymbols.has(symbol.id)) {
      report(
        [...symbolPath, "kind"],
        COMPUTATION_VALIDATION_CODES.ORPHAN_SYMBOL,
        `external symbol '${symbol.id}' is never used`,
      );
    }
    if (symbol.kind === "definition" && !definitionBySymbol.has(symbol.id)) {
      report(
        [...symbolPath, "kind"],
        COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
        `definition symbol '${symbol.id}' has no definition record`,
      );
    }
    if (symbol.kind !== "definition" && definitionBySymbol.has(symbol.id)) {
      report(
        [...symbolPath, "kind"],
        COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
        `symbol '${symbol.id}' carries a definition record but is not of kind 'definition'`,
      );
    }
    if (symbol.kind === "local" || symbol.kind === "parameter") {
      if (!knownScopes.has(symbol.scope)) {
        report(
          [...symbolPath, "scope"],
          COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
          `unknown scope '${symbol.scope}'`,
        );
      }
      for (const { nodeId, symbolId } of readSites) {
        if (symbolId !== symbol.id) {
          continue;
        }
        const useScope = enclosingScope.get(nodeId);
        if (useScope === undefined) {
          continue;
        }
        if (!scopeChain(useScope).includes(symbol.scope)) {
          report(
            ["nodes", nodeById.get(nodeId)?.index ?? 0, "symbol"],
            COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
            `symbol '${symbol.id}' is read outside its scope '${symbol.scope}'`,
          );
        }
      }
    }
  });

  program.slots.forEach((slot, index) => {
    if (!usedSlots.has(slot.id)) {
      report(
        ["slots", index, "id"],
        COMPUTATION_VALIDATION_CODES.ORPHAN_SLOT,
        `slot '${slot.id}' is never used`,
      );
    }
  });

  program.definitions.forEach((definition, index) => {
    const definitionPath = ["definitions", index] as const;
    const nameSymbol = symbolById.get(definition.nameSymbol);
    if (nameSymbol === undefined) {
      report(
        [...definitionPath, "nameSymbol"],
        COMPUTATION_VALIDATION_CODES.CROSS_REF,
        `unknown definition symbol '${definition.nameSymbol}'`,
      );
    } else {
      if (nameSymbol.kind !== "definition") {
        report(
          [...definitionPath, "nameSymbol"],
          COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
          `definition '${definition.id}' must reference a symbol of kind 'definition'`,
        );
      }
      // A definition's NAME is bound in an enclosing scope (lexically where its function node sits),
      // while `definition.scope` is the body scope its parameters live in. Keeping them distinct is
      // what makes self/mutual recursion resolve without hidden state.
      if (!scopeChain(definition.scope).includes(nameSymbol.scope)) {
        report(
          [...definitionPath, "scope"],
          COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
          `definition '${definition.id}' name must be visible from its body scope '${definition.scope}'`,
        );
      }
    }
    const bodyNode = nodeById.get(definition.body);
    if (bodyNode === undefined) {
      report(
        [...definitionPath, "body"],
        COMPUTATION_VALIDATION_CODES.CROSS_REF,
        `unknown body node '${definition.body}'`,
      );
    } else if (bodyNode.value.kind !== "function" && bodyNode.value.kind !== "lambda") {
      report(
        [...definitionPath, "body"],
        COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
        `definition body '${definition.body}' must be a function or lambda node`,
      );
    } else if (bodyNode.value.symbol !== definition.nameSymbol) {
      report(
        [...definitionPath, "body"],
        COMPUTATION_VALIDATION_CODES.CAPTURE_MISMATCH,
        `definition body '${definition.body}' must declare symbol '${definition.nameSymbol}'`,
      );
    }
    if (!definition.complete && definition.unsupportedReasons.length === 0) {
      report(
        [...definitionPath, "unsupportedReasons"],
        COMPUTATION_VALIDATION_CODES.UNSUPPORTED_CONSISTENCY,
        "an incomplete definition must name at least one unsupported reason",
      );
    }
    definition.parameters.forEach((parameter, parameterIndex) => {
      const parameterSymbol = symbolById.get(parameter);
      if (parameterSymbol === undefined) {
        report(
          [...definitionPath, "parameters", parameterIndex],
          COMPUTATION_VALIDATION_CODES.CROSS_REF,
          `unknown parameter symbol '${parameter}'`,
        );
        return;
      }
      if (parameterSymbol.kind !== "parameter" || parameterSymbol.scope !== definition.scope) {
        report(
          [...definitionPath, "parameters", parameterIndex],
          COMPUTATION_VALIDATION_CODES.CAPTURE_MISMATCH,
          `parameter '${parameter}' must be a 'parameter' symbol in scope '${definition.scope}'`,
        );
      }
    });
    definition.dependencies.forEach((dependency, dependencyIndex) => {
      const dependencySymbol = symbolById.get(dependency);
      if (dependencySymbol === undefined) {
        report(
          [...definitionPath, "dependencies", dependencyIndex],
          COMPUTATION_VALIDATION_CODES.CROSS_REF,
          `unknown dependency symbol '${dependency}'`,
        );
        return;
      }
      if (dependencySymbol.kind !== "definition" || !definitionBySymbol.has(dependency)) {
        report(
          [...definitionPath, "dependencies", dependencyIndex],
          COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
          `dependency '${dependency}' is not a resolved definition symbol`,
        );
      }
    });
  });

  // def/use closure. A definition's `dependencies` must be exactly the definition symbols its own
  // scope directly reads, INCLUDING itself when it recurses, so recursion (and mutual recursion) is
  // materialized data rather than hidden state. Reachability is followed with a visited set, so a
  // recursive helper is never mistaken for a cycle or for unresolvable hidden state.
  const directDefinitionUses = new Map<string, Set<string>>();
  for (const { nodeId, symbolId } of readSites) {
    if (symbolById.get(symbolId)?.kind !== "definition") {
      continue;
    }
    const readScope = enclosingScope.get(nodeId);
    if (readScope === undefined) {
      continue;
    }
    // A read inside a nested lambda still belongs to the enclosing definition's closure.
    const owningScope = scopeChain(readScope).find((scope) => definitionScopes.has(scope));
    if (owningScope === undefined) {
      continue;
    }
    const uses = directDefinitionUses.get(owningScope) ?? new Set<string>();
    uses.add(symbolId);
    directDefinitionUses.set(owningScope, uses);
  }

  const resolvedDefinitionScopes = new Set<string>();
  program.definitions.forEach((definition, index) => {
    const definitionPath = ["definitions", index] as const;
    const nameSymbol = symbolById.get(definition.nameSymbol);
    if (
      nameSymbol !== undefined &&
      (nameSymbol.kind !== "definition" || !definitionBySymbol.has(definition.nameSymbol))
    ) {
      report(
        [...definitionPath, "nameSymbol"],
        COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
        `definition '${definition.id}' must name a resolvable 'definition' symbol`,
      );
    }
    // `dependencies` is the resolved def/use closure: exactly the DEFINITION symbols this
    // definition's own scope reads (itself included when it recurses). Free variables, parameters and
    // externals are inputs, not definitions, and are deliberately not listed here.
    const expected = directDefinitionUses.get(definition.scope) ?? new Set<string>();
    const declared = new Set(definition.dependencies);
    for (const dependency of expected) {
      if (!declared.has(dependency)) {
        report(
          [...definitionPath, "dependencies"],
          COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
          `definition '${definition.id}' must list the definition symbol '${dependency}' it reads`,
        );
      }
    }
    for (const dependency of definition.dependencies) {
      if (!expected.has(dependency)) {
        report(
          [...definitionPath, "dependencies"],
          COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
          `definition '${definition.id}' lists '${dependency}' but its own scope never reads it`,
        );
      }
    }
    // `recursive` is reachability metadata over the materialized dependency graph, NOT a direct self
    // edge: a definition is recursive when its own name is reachable from the definition symbols it
    // lists as dependencies, so mutual recursion counts. The walk is bounded by a visited set, so it
    // terminates even though the graph may contain cycles.
    const reachedSymbols = new Set<string>();
    const pendingSymbols = [...definition.dependencies];
    let reachesItself = false;
    while (pendingSymbols.length > 0 && !reachesItself) {
      const symbolId = pendingSymbols.pop()!;
      if (symbolId === definition.nameSymbol) {
        reachesItself = true;
        break;
      }
      if (reachedSymbols.has(symbolId)) {
        continue;
      }
      reachedSymbols.add(symbolId);
      // Unresolved dependency symbols are reported above; they simply contribute no further edges.
      pendingSymbols.push(...(definitionBySymbol.get(symbolId)?.dependencies ?? []));
    }
    if (definition.recursive !== reachesItself) {
      report(
        [...definitionPath, "recursive"],
        COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
        "'recursive' must equal whether the definition reaches itself through its materialized dependencies",
      );
    }
    resolvedDefinitionScopes.add(definition.scope);
  });

  // Every definition symbol used anywhere must resolve to a materialized definition record. The walk
  // uses a visited set, so recursion is traversed safely and finite by construction.
  const visitedDefinitionSymbols = new Set<string>();
  const pendingDefinitionSymbols = [...usedSymbols].filter(
    (symbolId) => symbolById.get(symbolId)?.kind === "definition",
  );
  while (pendingDefinitionSymbols.length > 0) {
    const symbolId = pendingDefinitionSymbols.pop()!;
    if (visitedDefinitionSymbols.has(symbolId)) {
      continue;
    }
    visitedDefinitionSymbols.add(symbolId);
    const definition = definitionBySymbol.get(symbolId);
    if (definition === undefined) {
      const symbolIndex = program.symbols.findIndex((symbol) => symbol.id === symbolId);
      report(
        ["symbols", symbolIndex, "kind"],
        COMPUTATION_VALIDATION_CODES.DEFINITION_CLOSURE,
        `used definition symbol '${symbolId}' has no materialized definition record`,
      );
      continue;
    }
    if (!resolvedDefinitionScopes.has(definition.scope)) {
      report(
        ["definitions", definitionIndexById.get(definition.id) ?? 0, "scope"],
        COMPUTATION_VALIDATION_CODES.SYMBOL_SCOPE,
        `definition '${definition.id}' scope '${definition.scope}' is not a definition scope`,
      );
    }
    pendingDefinitionSymbols.push(...definition.dependencies);
  }

  program.roots.forEach((root, index) => referenceNode(["roots", index], root));

  // AST child edges must be acyclic. def/use recursion is deliberately not part of this walk, so a
  // recursive helper is never rejected as a cycle.
  const nodeState = new Map<string, "visiting" | "done">();
  const walk = (id: string, stackDepth: number) => {
    const entry = nodeById.get(id);
    if (entry === undefined) {
      return;
    }
    if (stackDepth > COMPUTATION_IR_LIMITS.nesting) {
      report(
        ["nodes", entry.index, "children"],
        COMPUTATION_VALIDATION_CODES.NESTING_LIMIT,
        "AST nesting depth limit exceeded",
      );
      return;
    }
    const current = nodeState.get(id);
    if (current === "visiting") {
      report(
        ["nodes", entry.index, "children"],
        COMPUTATION_VALIDATION_CODES.NODE_CYCLE,
        `AST child cycle detected at '${id}'`,
      );
      return;
    }
    if (current === "done") {
      return;
    }
    nodeState.set(id, "visiting");
    for (const ref of computationChildRefs(entry.value)) {
      walk(ref, stackDepth + 1);
    }
    nodeState.set(id, "done");
  };
  for (const root of program.roots) walk(root, 1);

  // Every node must be reachable from an ordered root; an unreachable node is a truncated or
  // mistyped graph. The tree walk above already proved acyclicity and single parenting.
  program.nodes.forEach((node, index) => {
    if (!enclosingScope.has(node.id)) {
      report(
        ["nodes", index, "id"],
        COMPUTATION_VALIDATION_CODES.CROSS_REF,
        `node '${node.id}' is not reachable from any ordered root`,
      );
    }
  });

  program.outputs.forEach((output, index) => {
    const outputPath = ["outputs", index] as const;
    const entry = nodeById.get(output.node);
    if (entry === undefined) {
      report(
        [...outputPath, "node"],
        COMPUTATION_VALIDATION_CODES.CROSS_REF,
        `unknown output node '${output.node}'`,
      );
      return;
    }
    if (
      entry.value.kind !== "return" &&
      entry.value.kind !== "yield" &&
      entry.value.kind !== "expression"
    ) {
      report(
        [...outputPath, "node"],
        COMPUTATION_VALIDATION_CODES.OUTPUT_INVALID,
        `output node '${output.node}' must be a return, yield or expression node`,
      );
    }
    if (output.definitionId !== undefined && !definitionIndexById.has(output.definitionId)) {
      report(
        [...outputPath, "definitionId"],
        COMPUTATION_VALIDATION_CODES.CROSS_REF,
        `unknown definition '${output.definitionId}'`,
      );
    }
  });

  const unsupportedNodes = program.nodes.filter((node) => node.kind === "unsupported");
  if (unsupportedNodes.length > 0 && program.complete) {
    report(
      ["complete"],
      COMPUTATION_VALIDATION_CODES.UNSUPPORTED_CONSISTENCY,
      "a program containing an 'unsupported' node cannot claim to be complete",
    );
  }
  if (!program.complete && program.unsupportedReasons.length === 0) {
    report(
      ["unsupportedReasons"],
      COMPUTATION_VALIDATION_CODES.UNSUPPORTED_CONSISTENCY,
      "an incomplete program must name at least one unsupported reason",
    );
  }

  return issues;
}

export const ComputationProgramV1Schema = z
  .object(ProgramBodyShape)
  .strict()
  .superRefine((program, ctx) => {
    // A refinement must never throw on dirty input: when required fields failed to parse, report a
    // single structural failure instead of letting a cross-reference walk dereference undefined.
    let issues: Array<{ path: readonly (string | number)[]; message: string }>;
    try {
      issues = checkProgramStructure(program);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `${COMPUTATION_VALIDATION_CODES.CROSS_REF}: program structure could not be walked`,
      });
      return;
    }
    for (const issue of issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...issue.path], message: issue.message });
    }
  });

export type ComputationProgramV1 = z.infer<typeof ComputationProgramV1Schema>;

// ============================================================================
// Envelope
// ============================================================================

export const ComputationOriginSchema = z
  .object({
    kind: z.enum(COMPUTATION_ORIGIN_KINDS),
    /** Source event that carried the body; provenance only, excluded from the program digest. */
    sourceEventId: IdentifierSchema,
    /** Normalized relative path pattern; never raw file contents or an absolute private path. */
    pathPattern: ComputationPathPatternSchema.optional(),
  })
  .strict();
export type ComputationOriginV1 = z.infer<typeof ComputationOriginSchema>;

/**
 * Observation record. A definition-only observation, a pending call and a failed call are all NOT a
 * successful invocation: `isSubstantiveComputationEvidence` requires kind `invocation`, status
 * `success` and a result event id.
 */
export const ComputationObservationSchema = z
  .object({
    kind: z.enum(COMPUTATION_OBSERVATION_KINDS),
    status: z.enum(COMPUTATION_OBSERVATION_STATUSES),
    callEventId: IdentifierSchema,
    callId: IdentifierSchema.optional(),
    resultEventId: IdentifierSchema.optional(),
  })
  .strict();
export type ComputationObservationV1 = z.infer<typeof ComputationObservationSchema>;

export const ComputationDependencySchema = z
  .object({
    definitionId: ComputationDefinitionIdSchema,
    programDigest: ComputationDigestSchema,
    sourceEventId: IdentifierSchema,
  })
  .strict();
export type ComputationDependencyV1 = z.infer<typeof ComputationDependencySchema>;

/** A correction supersedes an earlier definition/program; stale helpers are never silently revived. */
export const ComputationCorrectionSchema = z
  .object({
    supersedesDefinitionId: ComputationDefinitionIdSchema,
    supersededProgramDigest: ComputationDigestSchema,
  })
  .strict();
export type ComputationCorrectionV1 = z.infer<typeof ComputationCorrectionSchema>;

/** Bounded source/structural size counts for ESTIMATED authoring work only. */
export const ComputationMetricsSchema = z
  .object({
    sourceLines: z.number().int().nonnegative().max(COMPUTATION_IR_LIMITS.sourceLines),
    sourceBytes: z.number().int().nonnegative().max(COMPUTATION_IR_LIMITS.sourceBytes),
    nodeCount: z.number().int().nonnegative(),
    symbolCount: z.number().int().nonnegative(),
    slotCount: z.number().int().nonnegative(),
    definitionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ComputationMetricsV1 = z.infer<typeof ComputationMetricsSchema>;

const EnvelopeBodyShape = {
  version: z.literal(COMPUTATION_IR_VERSION),
  evidenceId: ComputationDigestSchema,
  program: ComputationProgramV1Schema,
  programDigest: ComputationDigestSchema,
  origin: ComputationOriginSchema,
  observation: ComputationObservationSchema,
  dependencies: z
    .array(ComputationDependencySchema)
    .max(COMPUTATION_IR_LIMITS.dependencies * HARD_LIMIT_FACTOR),
  corrections: z
    .array(ComputationCorrectionSchema)
    .max(COMPUTATION_IR_LIMITS.dependencies * HARD_LIMIT_FACTOR),
  metrics: ComputationMetricsSchema,
  /** Structural marker: this contract is evidence for analysis only and grants no authority. */
  analysisOnly: z.literal(true),
};

const METRIC_COUNT_FIELDS = [
  ["nodeCount", "nodes"],
  ["symbolCount", "symbols"],
  ["slotCount", "slots"],
  ["definitionCount", "definitions"],
] as const;

function checkEnvelopeStructure(envelope: {
  program: ComputationProgramV1;
  dependencies: readonly ComputationDependencyV1[];
  corrections: readonly ComputationCorrectionV1[];
  metrics: ComputationMetricsV1;
}): Array<{ path: readonly (string | number)[]; message: string }> {
  const issues: Array<{ path: readonly (string | number)[]; message: string }> = [];
  const report = (
    path: readonly (string | number)[],
    code: ComputationValidationCode,
    detail: string,
  ) => issues.push({ path, message: `${code}: ${detail}` });

  if (envelope.dependencies.length > COMPUTATION_IR_LIMITS.dependencies) {
    report(
      ["dependencies"],
      COMPUTATION_VALIDATION_CODES.LIMIT_DEPENDENCIES,
      "dependency limit exceeded",
    );
  }
  if (envelope.corrections.length > COMPUTATION_IR_LIMITS.dependencies) {
    report(
      ["corrections"],
      COMPUTATION_VALIDATION_CODES.LIMIT_DEPENDENCIES,
      "correction limit exceeded",
    );
  }

  const definitionIds = new Set(envelope.program.definitions.map((definition) => definition.id));
  const seenDependencies = new Set<string>();
  envelope.dependencies.forEach((dependency, index) => {
    if (!definitionIds.has(dependency.definitionId)) {
      report(
        ["dependencies", index, "definitionId"],
        COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
        `dependency '${dependency.definitionId}' is not materialized in the program closure`,
      );
    }
    if (seenDependencies.has(dependency.definitionId)) {
      report(
        ["dependencies", index, "definitionId"],
        COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
        `duplicate dependency '${dependency.definitionId}'`,
      );
    }
    seenDependencies.add(dependency.definitionId);
  });

  const seenCorrections = new Set<string>();
  envelope.corrections.forEach((correction, index) => {
    const key = `${correction.supersedesDefinitionId}:${correction.supersededProgramDigest}`;
    if (seenCorrections.has(key)) {
      report(
        ["corrections", index],
        COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
        "duplicate correction entry",
      );
    }
    seenCorrections.add(key);
  });

  for (const [metricField, collectionField] of METRIC_COUNT_FIELDS) {
    const declared = envelope.metrics[metricField];
    const actual = envelope.program[collectionField].length;
    if (declared !== actual) {
      report(
        ["metrics", metricField],
        COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH,
        `metric '${metricField}' must equal the program ${collectionField} length (${actual})`,
      );
    }
  }

  return issues;
}

/**
 * Strict versioned evidence envelope. `programDigest` and `evidenceId` are re-verified on every
 * parse, so a tampered body cannot pass as a valid evidence record.
 */
export const ResinComputationEvidenceV1Schema = z
  .object(EnvelopeBodyShape)
  .strict()
  .superRefine((envelope, ctx) => {
    // Same fail-closed rule as the program refinement: a digest can only be re-verified on a body
    // that parsed cleanly, and any structural surprise is a rejection rather than a thrown error.
    try {
      const { evidenceId, ...body } = envelope;
      if (envelope.programDigest !== computeComputationProgramDigest(envelope.program)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["programDigest"],
          message: `${COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH}: programDigest does not match the program body`,
        });
      }
      if (evidenceId !== computeComputationEvidenceDigest(body)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceId"],
          message: `${COMPUTATION_VALIDATION_CODES.DEPENDENCY_MISMATCH}: evidenceId does not match the bounded evidence body`,
        });
      }
      for (const issue of checkEnvelopeStructure(envelope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...issue.path],
          message: issue.message,
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `${COMPUTATION_VALIDATION_CODES.SERIALIZATION}: evidence body could not be canonicalized`,
      });
    }
  });

export type ResinComputationEvidenceV1 = z.infer<typeof ResinComputationEvidenceV1Schema>;

/** Evidence body without its self-referential id; the hash input for `evidenceId`. */
export type ComputationEvidenceBody = Omit<ResinComputationEvidenceV1, "evidenceId">;

// ============================================================================
// Canonical traversal, digests and reader
// ============================================================================

function orderedKeywordArgs(node: ComputationNodeV1): readonly ComputationKeywordArg[] {
  if (node.kind !== "call" && node.kind !== "new") {
    return [];
  }
  return node.keywordArgs ?? [];
}

/**
 * Ordered node references of one node: `children`, then the node-kind `nodeFields`, then
 * `keywordArgs[].value`. This is the canonical traversal step, so a builder assigning pre-order
 * anonymous ids and any consumer walking the captured algorithm agree by construction.
 */
export function computationChildRefs(node: ComputationNodeV1): ComputationNodeId[] {
  const refs = [...node.children];
  for (const field of COMPUTATION_NODE_FIELDS[node.kind].nodeFields) {
    const value = node[field as keyof typeof node];
    if (typeof value === "string") {
      refs.push(value);
    }
  }
  for (const arg of orderedKeywordArgs(node)) {
    refs.push(arg.value);
  }
  return refs;
}

/**
 * Canonical algorithm identity of a program: ordered roots, the flat ordered node sequence with
 * ordered children and ordered keyword arguments, anonymous def/use and slot-equality relationships,
 * finite operators/constants/keys/API ids, the resolved definition closure and bounded output records.
 *
 * The projection is flat and linear: it never re-expands a shared node or a definition body, so a
 * pathological DAG-shaped program cannot make the digest super-linear.
 *
 * Anonymous ids enter the projection as their PINNED POSITIONAL ORDINALS (`sym<i>`, `slot<i>`,
 * `scope<i>`, `def<i>`), never as raw text. Ordinal assignment is part of the positional contract:
 * definition, parameter and local symbols are numbered in binding-introduction order (definition
 * order, then parameter order, then declaration order), and free/external symbols and slots after
 * them in first-reference order over the canonical flat node order.
 *
 * Consequences, both intended:
 *   - Identifiers are renaming-invariant, so a renamed capture and a differently-named alias of the
 *     same algorithm share a digest, and operand/branch/key order stays observable for every symbol
 *     or slot whose ordinal is anchored independently of its uses.
 *   - Two programs that differ only by consistently renaming their anonymous free inputs (for
 *     example `a - b` versus `b - a` where neither `a` nor `b` is bound) are isomorphic up to
 *     renaming and therefore share a digest. Bound operands distinguish; unbound permutations do not.
 *     Slot equality is still ordinal equality, so reusing one slot at two positions differs from
 *     using two slots.
 *
 * Excluded are provenance/session ids, source offsets, local identifiers, declaration keywords, data
 * paths and arbitrary literal payloads. Retained are operator identity, operand/branch order,
 * ordered keyword-argument names, control-flow structure, finite constants, safe structural key
 * selection, bounded slot kind/role and the definition closure.
 */
function projectProgramForDigest(program: ComputationProgramV1): Record<string, unknown> {
  const symbolById = new Map<string, ComputationSymbolV1>();
  const symbolOrdinal = new Map<string, number>();
  program.symbols.forEach((symbol, index) => {
    symbolById.set(symbol.id, symbol);
    symbolOrdinal.set(symbol.id, index);
  });
  const slotById = new Map<string, ComputationSlotV1>();
  const slotOrdinal = new Map<string, number>();
  program.slots.forEach((slot, index) => {
    slotById.set(slot.id, slot);
    slotOrdinal.set(slot.id, index);
  });
  const definitionBySymbol = new Map<string, ComputationDefinitionV1>();
  const definitionOrdinal = new Map<string, number>();
  program.definitions.forEach((definition, index) => {
    definitionBySymbol.set(definition.nameSymbol, definition);
    definitionOrdinal.set(definition.id, index);
  });
  const kindByNode = new Map<string, ComputationNodeKind>();
  for (const node of program.nodes) kindByNode.set(node.id, node.kind);

  // Anonymous ids project as their pinned positional ordinal plus bounded kind/scope metadata.
  const ordinalOfSymbol = (symbolId: string): number | null => symbolOrdinal.get(symbolId) ?? null;
  const ordinalOfSlot = (slotId: string): number | null => slotOrdinal.get(slotId) ?? null;
  const ordinalOfScope = (scopeId: string): number | null =>
    scopeId === "scope0" ? 0 : Number(scopeId.slice("scope".length));

  const symbolProjection = (symbolId: string): Record<string, unknown> => {
    const symbol = symbolById.get(symbolId);
    if (symbol === undefined) {
      return { ordinal: null, unresolved: true };
    }
    return {
      ordinal: ordinalOfSymbol(symbolId),
      kind: symbol.kind,
      scope: ordinalOfScope(symbol.scope),
      resolved: definitionBySymbol.has(symbolId),
    };
  };

  const slotProjection = (slotId: string): Record<string, unknown> => {
    const slot = slotById.get(slotId);
    return { ordinal: ordinalOfSlot(slotId), kind: slot?.kind ?? null, role: slot?.role ?? null };
  };

  const projectNode = (node: ComputationNodeV1): Record<string, unknown> => {
    const abstracted = new Set<string>([
      "id",
      "definitionId",
      "symbol",
      "slot",
      "fieldSlot",
      "children",
      "receiver",
      "keywordArgs",
    ]);
    for (const field of DIGEST_ABSTRACTED_FIELDS[node.kind] ?? []) {
      abstracted.add(field);
    }
    const projection: Record<string, unknown> = { kind: node.kind };
    for (const [field, value] of Object.entries(node)) {
      if (abstracted.has(field)) {
        continue;
      }
      projection[field] = value;
    }
    projection.children = [...node.children];
    if ("receiver" in node) {
      projection.receiver = node.receiver ?? null;
    }
    if ("keywordArgs" in node) {
      const args = orderedKeywordArgs(node);
      projection.keywordArgs =
        args.length === 0 ? null : args.map((arg) => ({ name: arg.name, value: arg.value }));
    }
    if ("symbol" in node && typeof node.symbol === "string") {
      projection.symbol = symbolProjection(node.symbol);
    }
    if ("fieldSlot" in node && typeof node.fieldSlot === "string") {
      projection.fieldSlot = slotProjection(node.fieldSlot);
    }
    if ("slot" in node && typeof node.slot === "string") {
      projection.slot = slotProjection(node.slot);
    }
    return projection;
  };

  // Definition records are positional (`def<i>`), and a dependency listing is a SET of definition
  // identities: the order in which a parser happened to collect edges must not change the digest.
  const definitions = program.definitions.map((definition) => ({
    symbol: ordinalOfSymbol(definition.nameSymbol),
    kind: definition.kind,
    parameters: definition.parameters.map((parameter) => ordinalOfSymbol(parameter)),
    dependencies: definition.dependencies
      .map((dependency) => ordinalOfSymbol(dependency))
      .sort((left, right) => (left ?? -1) - (right ?? -1)),
    body: definition.body,
    recursive: definition.recursive,
    complete: definition.complete,
    unsupportedReasons: [...definition.unsupportedReasons],
  }));

  return {
    version: program.version,
    language: program.language,
    rootKinds: program.roots.map((root) => kindByNode.get(root) ?? null),
    nodes: program.nodes.map(projectNode),
    definitions,
    slots: program.slots.map((slot) => ({ kind: slot.kind, role: slot.role })),
    outputs: program.outputs.map((output) => ({
      node: output.node,
      shape: output.shape,
      definition:
        output.definitionId === undefined
          ? null
          : (definitionOrdinal.get(output.definitionId) ?? null),
    })),
    complete: program.complete,
    unsupportedReasons: [...program.unsupportedReasons],
  };
}

/**
 * Canonical algorithm identity of a program. Deterministic, idempotent and independent of local
 * naming, literal payloads and capture provenance: see `projectProgramForDigest`.
 */
export function computeComputationProgramDigest(program: ComputationProgramV1): string {
  if (typeof program !== "object" || program === null) {
    throw new TypeError("program must be an object");
  }
  return hashCanonicalContent(projectProgramForDigest(program));
}

/**
 * Digest of a full bounded evidence body, excluding `evidenceId` itself. Provenance (origin,
 * observation, dependency source events, corrections, metrics) is included here, unlike the program
 * digest, so two captures of the same algorithm remain distinguishable as separate observations.
 */
export function computeComputationEvidenceDigest(body: ComputationEvidenceBody): string {
  if (typeof body !== "object" || body === null) {
    throw new TypeError("evidence body must be an object");
  }
  return hashCanonicalContent(body);
}

/** Canonical serialized form of a program under the pinned byte limit. */
export function serializeComputationProgram(program: ComputationProgramV1): string {
  return canonicalJsonStringify(program);
}

/**
 * Fail-closed reader for untrusted evidence metadata.
 *
 * Order of operations (never relaxed): descriptor-safe canonical serialization of the untrusted
 * value first, then the pinned serialized-byte limit, then the strict bounded schema (including
 * digest re-verification and cross-reference checks). Any failure returns `undefined`, so partial,
 * oversized, non-JSON, getter-poisoned or tampered evidence can never be partially admitted.
 */
export function readComputationEvidence(value: unknown): ResinComputationEvidenceV1 | undefined {
  const serialized = descriptorSafeCanonicalJsonStringify(value, {
    maxDepth: COMPUTATION_IR_LIMITS.nesting + 8,
    maxNodes: 20_000,
  });
  if (serialized === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(serialized, "utf8") > COMPUTATION_IR_LIMITS.serializedBytes) {
    return undefined;
  }
  const parsed = ResinComputationEvidenceV1Schema.safeParse(JSON.parse(serialized));
  return parsed.success ? parsed.data : undefined;
}

// ============================================================================
// Substantiveness
// ============================================================================

const SUBSTANTIVE_MIN_NODES = 3;

/**
 * Minimum evidence for structural review: a bounded, COMPLETE, parse-successful program produced by
 * an observed SUCCESSFUL invocation that actually transformed data and emitted a structural output.
 *
 * Substantive requires at least one genuine transform/control/dataflow operation — a
 * `COMPUTATION_TRANSFORM_NODE_KINDS` node or a `COMPUTATION_TRANSFORM_APIS` call — plus at least one
 * output record. A definition is NOT required, so a plain sequence of inline expressions qualifies,
 * while `print(...)`, a bare file read, `json.parse` wrapping, `len(x)` plumbing, an identity call or
 * a program made only of declarations never does, regardless of node count. A definition-only capture
 * is rejected by the observation-kind check. Nothing here keys off a model/tool/eval *name*, and
 * opportunity value ranking remains a later, stricter concern.
 *
 * As a hard invariant this returns false whenever the program is incomplete, names an unsupported
 * reason, or carries an `unsupported` node.
 */
export function isSubstantiveComputationEvidence(value: unknown): boolean {
  const evidence = readComputationEvidence(value);
  if (evidence === undefined) {
    return false;
  }
  const { program } = evidence;
  if (!program.complete || program.unsupportedReasons.length > 0) {
    return false;
  }
  if (program.nodes.some((node) => node.kind === "unsupported")) {
    return false;
  }
  for (const definition of program.definitions) {
    if (!definition.complete || definition.unsupportedReasons.length > 0) {
      return false;
    }
  }
  const { observation } = evidence;
  if (observation.kind !== "invocation" || observation.status !== "success") {
    return false;
  }
  if (observation.resultEventId === undefined) {
    return false;
  }
  if (program.nodes.length < SUBSTANTIVE_MIN_NODES || program.outputs.length === 0) {
    return false;
  }
  return program.nodes.some(
    (node) =>
      Object.prototype.hasOwnProperty.call(TRANSFORM_NODE_KINDS, node.kind) ||
      (node.kind === "call" &&
        node.api !== undefined &&
        Object.prototype.hasOwnProperty.call(TRANSFORM_APIS, node.api)),
  );
}
