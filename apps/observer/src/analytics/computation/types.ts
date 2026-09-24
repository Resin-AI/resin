import type {
  ComputationDefinitionKind,
  ComputationLanguage,
  ComputationNodeKind,
  ComputationOriginKind,
  ComputationOutputShape,
  ComputationProgramV1,
  ComputationSlotKind,
  ComputationSlotRole,
  ComputationSymbolKind,
  ComputationUnsupportedReason,
} from "@resin/contracts";
import type { NormalizedToolCallEvent } from "@resin/contracts";

// `ComputationLanguage` is the one contract type consumers import from this module; every other
// contract type stays an internal import so this module adds no second name surface for it.
export type { ComputationLanguage };

/**
 * Private, never-projected model shared by the language visitors, the semantic builder and the
 * observer-only recorder.
 *
 * Everything in this module is device-local bookkeeping. Raw identifiers, source positions and
 * literal payloads live here (and only here) so that the builder can allocate canonical anonymous
 * ids and drop every unsafe string before a program becomes evidence. Nothing in this module is
 * serialized: the wire shape is `ComputationProgramV1` from `@resin/contracts`.
 *
 * `DraftNode.fields` carries *only* schema-known finite semantic values, safe structural keys, or
 * object references to draft symbols/slots/nodes/scopes:
 *
 *   - a finite enum value (operator, declare kind, parameter kind, definition kind, comprehension
 *     kind, spread kind, template kind, with kind, slice part, constant, canonical API, reason code),
 *   - a boolean flag (`async`, `generator`, `optional`),
 *   - a safe structural key string (the builder re-checks it, converting an unsafe key into a slot),
 *   - a `DraftSymbol` (symbol / declaration reference),
 *   - a `DraftSlot` (anonymous literal or field-key slot),
 *   - a `DraftNode` (`receiver`, and `keywordArgs[].value`),
 *   - `{ name, value }[]` for `keywordArgs`.
 *
 * The builder rejects unknown field names, unsafe keys, invalid enum values and arity/shape
 * violations, and rewrites the offending node into an `unsupported` node instead of copying anything
 * through. It never mutates the draft and never throws.
 */

// ============================================================================
// Draft AST
// ============================================================================

/**
 * One AST occurrence. A draft node is single-parented by construction (it is nested in exactly one
 * `children` array), which is what lets the builder emit the canonical pre-order tree the wire
 * contract validates. Every AST occurrence must be a fresh draft node; only symbols and typed slots
 * are shared by reference.
 */
export interface DraftNode {
  readonly kind: ComputationNodeKind;
  readonly children: readonly DraftNode[];
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * A lexical binding. `key` and `scope` are private bookkeeping identifiers: the builder renumbers
 * both positionally and never copies them to the wire. `scope` is an opaque private key naming the
 * scope that lexically ENCLOSES the binding — for a definition that is the scope its callable name
 * is declared in, not the scope of its own parameters/body.
 */
export interface DraftSymbol {
  readonly key: string;
  readonly kind: ComputationSymbolKind;
  readonly scope: string;
  /** Declaration node that introduces this symbol, when the visitor already knows it. */
  readonly declaration?: DraftNode;
}

/**
 * A typed, valueless input. Repeated references may pass the same `key` to share one wire slot,
 * which is how repeated literal payloads keep their local equality relationship without any value
 * ever reaching the wire.
 */
export interface DraftSlot {
  readonly key: string;
  readonly kind: ComputationSlotKind;
  readonly role: ComputationSlotRole;
}

/**
 * One authored callable.
 *
 * `body` is the `function`/`lambda` draft node ITSELF, not its inner block: that node owns
 * `[parameters, body]`. The builder takes the enclosing scope from wherever the node is attached, so
 * a nested definition is resolved by position, and `scope` stays private bookkeeping.
 *
 * `dependencies` and `complete` are advisory: the builder materializes the real dependency closure
 * from what each definition's own scope reads (itself included when it recurses) and derives
 * `recursive` by reachability, so a visitor never has to compute SCCs.
 */
export interface DraftDefinition {
  readonly key: string;
  readonly kind: ComputationDefinitionKind;
  readonly nameSymbol: DraftSymbol;
  readonly parameters: readonly DraftSymbol[];
  readonly body: DraftNode;
  readonly dependencies?: readonly DraftSymbol[];
  readonly scope?: string;
  readonly complete?: boolean;
  readonly unsupportedReasons?: readonly ComputationUnsupportedReason[];
}

/** Structural output reference: a `return`/`yield`/`expression` node plus a bounded shape. */
export interface DraftOutput {
  readonly node: DraftNode;
  readonly shape: ComputationOutputShape;
  /** Private key of the definition the output belongs to, when it is not a module-level output. */
  readonly definitionKey?: string;
}

export interface ComputationProgramBuildInput {
  readonly language: ComputationLanguage;
  readonly roots: readonly DraftNode[];
  readonly definitions?: readonly DraftDefinition[];
  readonly outputs?: readonly DraftOutput[];
  readonly unsupportedReasons?: readonly ComputationUnsupportedReason[];
}

export interface ComputationProgramDraft {
  readonly program: ComputationProgramV1;
  /**
   * `definitionKeys[i]` is the private `DraftDefinition.key` behind `program.definitions[i]`, so a
   * caller can attribute a materialized wire definition without relying on array-order arithmetic.
   */
  readonly definitionKeys: readonly string[];
}

// ============================================================================
// Draft factories
// ============================================================================

/** Private fallback scope key; the builder numbers real scopes positionally. */
export const MODULE_SCOPE_KEY = "module";

/** Trivial draft constructors. Plain object literals are equally valid; these only reduce noise. */
export function draftSymbol(
  key: string,
  kind: ComputationSymbolKind,
  scope: string = MODULE_SCOPE_KEY,
  declaration?: DraftNode,
): DraftSymbol {
  return declaration === undefined ? { key, kind, scope } : { key, kind, scope, declaration };
}

export function draftSlot(
  key: string,
  kind: ComputationSlotKind,
  role: ComputationSlotRole = "literal",
): DraftSlot {
  return { key, kind, role };
}

// ============================================================================
// Local (never projected) parse records
// ============================================================================

/**
 * A definition the visitor authored in the source it was handed. `name`/`source`/`references` stay
 * on the device: the recorder keeps them to resolve later cells and to digest corrected versions.
 */
export interface LocalComputationDefinition {
  name: string;
  source: string;
  references: string[];
  writtenNames: string[];
  sourceEventId?: string;
  programDigest?: string;
}

export interface LocalComputationImport {
  names: string[];
  source: string;
  sourceEventId?: string;
}

/** A previously observed authored/read file body. Strictly a private recorder cache entry. */
export interface LocalComputationModule {
  path: string;
  source: string;
  language: ComputationLanguage;
  sourceEventId?: string;
  programDigest?: string;
}

/**
 * Parser-local context. `definitions`/`imports` are already-observed helper closures, `modules` is
 * the bounded in-memory map of authored/read files, and `sourcePath` is the file the source came
 * from. Nothing here is read from disk, and nothing here is projected.
 */
export interface ComputationParseContext {
  definitions?: readonly LocalComputationDefinition[];
  imports?: readonly LocalComputationImport[];
  modules?: readonly LocalComputationModule[];
  sourcePath?: string;
  /** Adapter-established native builtins, never inferred from a JavaScript callee name. */
  sourceInterface?: "codex-exec";
}

/**
 * Private provenance of one MATERIALIZED canonical definition.
 *
 * A parse result exposes only `program` + `local`, so a wire definition id cannot be attributed from
 * `local.definitions` (authored-in-this-source only) or from context insertion order. A visitor that
 * built its drafts with `buildComputationProgramWithKeyMap` therefore reports the mapping it alone
 * knows: the canonical `def<i>` id, the private name/key behind it, and — for an inlined helper
 * selected out of the parse context — the originating observed source event and program digest.
 * A definition authored in the current source omits both provenance fields and is attributed by the
 * recorder to the current frame instead. This is local bookkeeping and never a wire field.
 */
export interface LocalComputationDefinitionBinding {
  definitionId: string;
  name: string;
  sourceEventId?: string;
  programDigest?: string;
}

export interface ComputationParseLocal {
  definitions: LocalComputationDefinition[];
  imports: LocalComputationImport[];
  referencedNames: string[];
  /**
   * Names read from the persistent module closure, including names resolved through an observed
   * helper/import. This is private parser bookkeeping; raw names never enter the wire program.
   */
  requiredNames?: string[];
  writtenNames: string[];
  hasInvocation: boolean;
  /** True when the source mutates state the parser could not represent (reset/invalidations). */
  invalidatesState: boolean;
  /**
   * Bounded provenance for the definitions materialized into `program`. Optional for backward
   * compatibility: absent means the caller may only rely on `local.definitions`.
   */
  definitionBindings?: LocalComputationDefinitionBinding[];
}

export interface ComputationParseResult {
  program: ComputationProgramV1;
  local: ComputationParseLocal;
}

/** Dispatcher input for `parseComputationSource`. */
export interface ComputationParseSourceInput {
  language: ComputationLanguage;
  source: string;
  context?: ComputationParseContext;
}

// ============================================================================
// Source framing
// ============================================================================

export const COMPUTATION_EXECUTION_SCOPES = ["persistent", "isolated", "file_observation"] as const;
export type ComputationExecutionScope = (typeof COMPUTATION_EXECUTION_SCOPES)[number];

export const COMPUTATION_FILE_ACTIONS = ["write", "read", "execute"] as const;
export type ComputationFileAction = (typeof COMPUTATION_FILE_ACTIONS)[number];

export const COMPUTATION_FRAME_REJECTION_REASONS = [
  "truncated_source",
  "oversize_source",
  "unresolved_file",
  "partial_edit",
  "ambiguous_shell",
  "unknown_dialect",
] as const;
export type ComputationFrameRejectionReason = (typeof COMPUTATION_FRAME_REJECTION_REASONS)[number];

/**
 * One bounded piece of source observed in a normalized event.
 *
 * `executionScope` is the load-bearing distinction: only a known persistent eval kernel shares
 * session+language kernel state, a `python -c`/`node -e`/heredoc process is isolated per invocation,
 * and a file body is an observation that never executes anything.
 */
export interface ComputationSourceFrame {
  language: ComputationLanguage;
  source: string;
  originKind: ComputationOriginKind;
  executionScope: ComputationExecutionScope;
  /** Native output semantics established by the source adapter. */
  sourceInterface?: "codex-exec";
  /** Event that carried the body; provenance only, never model evidence by itself. */
  sourceEventId: string;
  path?: string;
  /**
   * Reserved for a frame that terminates/resets the persistent kernel for its session+language.
   * Source framing never sets it: an isolated interpreter process is a fresh kernel, not a reset of
   * the persistent one, so clearing persistent state stays with the recorder's own event handling.
   */
  reset?: boolean;
  fileAction?: ComputationFileAction;
  /**
   * Set on a fail-closed frame: the source could not be used, and the recorder must invalidate
   * rather than analyze. `source` is empty whenever a reason is present.
   */
  rejectionReason?: ComputationFrameRejectionReason;
}

export interface ComputationSourceFrameOptions {
  /** Bounded in-memory map of already observed authored/read files (never a disk read). */
  knownFiles?: ReadonlyMap<string, LocalComputationModule>;
  /** Matching call event, needed to pair a result-carried body with its tool identity. */
  relatedCall?: NormalizedToolCallEvent;
}

/** Canonical eval tools whose code argument shares a persistent session+language kernel. */
export const COMPUTATION_EVAL_TOOL_NAMES = [
  "eval",
  "python",
  "js",
  "javascript",
  "typescript",
] as const;

/**
 * Normalization truncation marker. The live redactor replaces an over-long string with a prefix plus
 * `... [TRUNCATED <n> chars]` and records `truncation:<fieldPath>` in `redaction.scrubbedPatterns`.
 * A normalized prefix is NOT the authored source, so framing rejects it rather than analyzing a
 * program the agent never wrote.
 */
export const COMPUTATION_TRUNCATION_MARKER = /\.\.\. \[TRUNCATED \d+ chars\]/;
export const COMPUTATION_TRUNCATION_SCRUB_PREFIX = "truncation:";

/**
 * True when the event carries normalization truncation evidence for any field. A truncated value is
 * never treated as usable source, even when the surviving prefix happens to parse.
 */
export function hasComputationTruncationEvidence(
  scrubbedPatterns: readonly string[] | undefined,
): boolean {
  if (!Array.isArray(scrubbedPatterns)) {
    return false;
  }
  return scrubbedPatterns.some(
    (pattern) =>
      typeof pattern === "string" && pattern.startsWith(COMPUTATION_TRUNCATION_SCRUB_PREFIX),
  );
}
