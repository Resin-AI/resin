import { describe, expect, it } from "vitest";
import {
  COMPUTATION_APIS,
  COMPUTATION_CONSTANTS,
  COMPUTATION_CONSTRUCT_APIS,
  COMPUTATION_IR_LIMITS,
  COMPUTATION_IR_VERSION,
  COMPUTATION_TRANSFORM_APIS,
  type ComputationDefinitionKind,
  type ComputationDefinitionV1,
  type ComputationLanguage,
  type ComputationNodeId,
  type ComputationNodeKind,
  type ComputationNodeV1,
  type ComputationOutputShape,
  type ComputationOutputV1,
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  type ComputationSlotKind,
  type ComputationSlotRole,
  type ComputationSlotV1,
  type ComputationSymbolKind,
  type ComputationSymbolV1,
  type ComputationUnsupportedReason,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
  ResinComputationEvidenceV1Schema,
  computeComputationEvidenceDigest,
  computeComputationProgramDigest,
  isSafeComputationFieldKey,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
  serializeComputationProgram,
} from "../src/computation-evidence.js";

// ============================================================================
// Test-only program builder
//
// Assigns anonymous ids in the canonical traversal order (children, then node-kind node fields, then
// keyword arguments) and resolves bindings scope-aware, exactly like a real Python/JS parser must.
// Fixtures therefore describe algorithms, not id bookkeeping, and a builder bug cannot masquerade as
// a contract bug.
// ============================================================================

type NodeSpec = {
  kind: ComputationNodeKind;
  children?: NodeSpec[];
  /** Binding name for this node; never serialized as raw text. */
  symbol?: string;
  /** Declaration site (created in the current scope) rather than a read. */
  declares?: boolean;
  slot?: string;
  fieldSlot?: string;
  field?: string;
  receiver?: NodeSpec;
  keywordArgs?: Array<{ name: string; value: NodeSpec }>;
  /** For `assign`/`for`/`for_clause`: binds this name in the current scope as child 0. */
  target?: string;
  output?: { shape: ComputationOutputShape; definition?: string };
} & Record<string, unknown>;

type DefinitionSpec = {
  name: string;
  kind?: ComputationDefinitionKind;
  parameters: string[];
  body: NodeSpec;
  /** Definition-symbol names this definition reads; defaults to the discovered use set. */
  dependencies?: string[];
  complete?: boolean;
  unsupportedReasons?: ComputationUnsupportedReason[];
};

type ProgramSpec = {
  language?: ComputationLanguage;
  complete?: boolean;
  unsupportedReasons?: ComputationUnsupportedReason[];
  slots?: Record<string, { kind: ComputationSlotKind; role: ComputationSlotRole }>;
  roots: NodeSpec[];
  definitions?: DefinitionSpec[];
};

/**
 * Test builder's record of one authored definition. It is the SAME shape the walker receives as its
 * `owner`, so parameter/body access cannot drift between the two: the definition text lives at
 * `spec`, and the function node id walked for it is recorded at `bodyNodeId`.
 */
type DefinitionEntry = {
  index: number;
  scope: string;
  nameSymbol: string;
  parameterIds: string[];
  spec: DefinitionSpec;
  /** Function node id walked for this definition; the definition's `body` is that node's child 1. */
  bodyNodeId: ComputationNodeId | undefined;
};

const DECLARATION_NODE_KINDS = new Set<ComputationNodeKind>([
  "parameter",
  "declare",
  "import",
  "catch",
]);
/** Kinds whose `children[0]` is a binding TARGET, per the contract's own target rule. */
const BINDING_TARGET_KINDS = new Set<ComputationNodeKind>(["assign", "for", "for_clause", "with"]);

function buildProgram(spec: ProgramSpec): ComputationProgramV1 {
  const nodes: ComputationNodeV1[] = [];
  const outputs: ComputationOutputV1[] = [];
  const symbols: ComputationSymbolV1[] = [];
  const symbolName: string[] = [];
  const symbolNodes = new Map<string, string>();
  const newSymbol = (name: string, kind: ComputationSymbolKind, scope: string): string => {
    const id = `sym${symbols.length}`;
    symbols.push({ id, kind, scope });
    symbolName.push(name);
    return id;
  };

  const definitions = new Map<string, DefinitionEntry>();
  const paramsByScope = new Map<string, string>();
  const localsByScope = new Map<string, string>();
  const importsByName = new Map<string, string>();
  const externalsByName = new Map<string, string>();

  (spec.definitions ?? []).forEach((definition, index) => {
    // Parameter symbols are bound by walking the `parameters` node below, exactly as a parser would.
    definitions.set(definition.name, {
      index,
      scope: `scope${index + 1}`,
      nameSymbol: newSymbol(definition.name, "definition", "scope0"),
      parameterIds: [],
      spec: definition,
      bodyNodeId: undefined,
    });
  });

  const nestedScopes: string[] = [];
  /** Lexical parent of each nested function scope, so a nested lambda still sees outer bindings. */
  const nestedScopeParent = new Map<string, string>();
  const slots: ComputationSlotV1[] = [];
  const slotIds = new Map<string, string>();
  const slotIdFor = (name: string): string => {
    const declared = spec.slots?.[name];
    if (declared === undefined) {
      throw new Error(`test slot '${name}' is not declared in the program spec`);
    }
    let id = slotIds.get(name);
    if (id === undefined) {
      id = `slot${slots.length}`;
      slotIds.set(name, id);
      slots.push({ id, kind: declared.kind, role: declared.role });
    }
    return id;
  };

  // Scope chain mirrors the contract's lexical nesting: `scope0` (module) is the root, each
  // definition scope `scope<i+1>` is owned by that definition's function node, and each nested
  // function/lambda owns `scope(N + k)` in canonical node order. A nested lambda therefore sees the
  // enclosing definition's parameters and locals, not a fabricated `scope0`-only chain.
  const scopeChain = (scope: string): string[] => {
    const chain = [scope];
    let current = scope;
    while (current !== "scope0") {
      // Every non-module scope is lexically contained by its recorded nested parent, or by the
      // module when it is a definition scope (contract: `scopeParent(defScope) === "scope0"`).
      const parent = nestedScopeParent.get(current) ?? "scope0";
      if (chain.includes(parent)) {
        break;
      }
      chain.push(parent);
      current = parent;
    }
    return chain;
  };

  const definitionUses = new Map<string, string[]>();
  const definitionScopes = new Set([...definitions.values()].map((entry) => entry.scope));
  /**
   * The definition scope a read belongs to: a read inside a nested lambda still belongs to the
   * enclosing definition's closure, exactly as the contract's `owningScope` walk requires.
   */
  const owningDefinitionScope = (scope: string): string | undefined =>
    scopeChain(scope).find((candidate) => definitionScopes.has(candidate));
  const registerUse = (scope: string, symbolId: string) => {
    const owner = owningDefinitionScope(scope) ?? scope;
    const uses = definitionUses.get(owner) ?? [];
    if (!uses.includes(symbolId)) {
      uses.push(symbolId);
      definitionUses.set(owner, uses);
    }
  };

  const readSymbol = (name: string, scope: string): string => {
    for (const candidate of scopeChain(scope)) {
      const parameter = paramsByScope.get(`${candidate}::${name}`);
      if (parameter !== undefined) {
        return parameter;
      }
      const local = localsByScope.get(`${candidate}::${name}`);
      if (local !== undefined) {
        return local;
      }
    }
    const definition = definitions.get(name);
    if (definition !== undefined) {
      return definition.nameSymbol;
    }
    const imported = importsByName.get(name);
    if (imported !== undefined) {
      return imported;
    }
    const existing = externalsByName.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const id = newSymbol(name, "external", "scope0");
    externalsByName.set(name, id);
    return id;
  };

  /**
   * Appends one node in canonical pre-order and RETURNS THE STORED RECORD, not just its id: ids are
   * positions, so every later fill (`children`, `symbol`, `scope`, `receiver`, `keywordArgs`) must
   * land on the object the program actually holds. Cloning here would silently desynchronize the
   * stored nodes from the walked ones.
   */
  const pushNode = (
    node: Record<string, unknown>,
  ): { id: ComputationNodeId; record: Record<string, unknown> } => {
    const id = `n${nodes.length}` as ComputationNodeId;
    const record = { id, ...node };
    nodes.push(record as unknown as ComputationNodeV1);
    return { id, record };
  };

  /** Stored node for an id; ids are positions, so the array IS the source of truth. */
  const storedNode = (id: ComputationNodeId): Record<string, unknown> =>
    nodes[Number(id.slice(1))] as unknown as Record<string, unknown>;
  const storedSymbol = (id: ComputationNodeId): string => storedNode(id).symbol as string;
  const storedChildIds = (id: ComputationNodeId): ComputationNodeId[] =>
    storedNode(id).children as ComputationNodeId[];

  const emitOutput = (nodeSpec: NodeSpec, id: ComputationNodeId) => {
    if (nodeSpec.output === undefined) {
      return;
    }
    outputs.push({
      node: id,
      shape: nodeSpec.output.shape,
      ...(nodeSpec.output.definition === undefined
        ? {}
        : { definitionId: `def${definitions.get(nodeSpec.output.definition)?.index ?? 0}` }),
    });
  };

  const bindSymbol = (name: string, kind: ComputationSymbolKind, scope: string, nodeId: string) => {
    const id = newSymbol(name, kind, scope);
    if (kind === "parameter") {
      paramsByScope.set(`${scope}::${name}`, id);
    } else if (kind === "local") {
      localsByScope.set(`${scope}::${name}`, id);
    } else if (kind === "import") {
      importsByName.set(name, id);
    }
    symbolNodes.set(id, nodeId);
    return id;
  };

  // Loop targets are hoisted before their enclosing comprehension/for body is walked, so the element
  // expression resolves the loop variable exactly as a real parser's scope pass would.
  const targetSymbolBySpec = new Map<NodeSpec, string>();
  const hoistTargets = (nodeSpec: NodeSpec, activeScope: string) => {
    if (nodeSpec.kind !== "comprehension" && nodeSpec.kind !== "for") {
      return;
    }
    for (const child of nodeSpec.children ?? []) {
      if (child.kind !== "for_clause" && child.kind !== "for") {
        continue;
      }
      if (child.target === undefined || targetSymbolBySpec.has(child)) {
        continue;
      }
      const symbolId = newSymbol(child.target, "local", activeScope);
      localsByScope.set(`${activeScope}::${child.target}`, symbolId);
      targetSymbolBySpec.set(child, symbolId);
    }
  };

  /** Expression node walked with symbol resolution. */
  const walk = (
    nodeSpec: NodeSpec,
    scope: string,
    options: { owner?: DefinitionEntry } = {},
  ): ComputationNodeId => {
    const isFunction = nodeSpec.kind === "function" || nodeSpec.kind === "lambda";
    const activeScope = isFunction && options.owner !== undefined ? options.owner.scope : scope;
    const node: Record<string, unknown> = { kind: nodeSpec.kind };

    for (const [field, value] of Object.entries(nodeSpec)) {
      if (
        value === undefined ||
        field === "kind" ||
        field === "children" ||
        field === "symbol" ||
        field === "declares" ||
        field === "receiver" ||
        field === "keywordArgs" ||
        field === "target" ||
        field === "output"
      ) {
        continue;
      }
      node[field] = value;
    }
    if (nodeSpec.fieldSlot !== undefined) {
      node.fieldSlot = slotIdFor(nodeSpec.fieldSlot);
    }
    if (nodeSpec.slot !== undefined) {
      node.slot = slotIdFor(nodeSpec.slot);
    }

    if (isFunction && options.owner === undefined) {
      // Nested function/lambda: it owns a nested scope and binds its own name in the enclosing scope,
      // exactly as the contract's positional nested-scope rule requires.
      if (nodeSpec.symbol === undefined) {
        throw new Error("test nested function node needs a 'symbol'");
      }
      const nestedScope = `scope${definitions.size + nestedScopes.length + 1}`;
      nestedScopes.push(nestedScope);
      // Lexical parent, so the nested body resolves outer parameters/locals instead of fabricating
      // external inputs for them.
      nestedScopeParent.set(nestedScope, activeScope);
      node.scope = nestedScope;
      const { id, record } = pushNode(node);
      record.symbol = bindSymbol(nodeSpec.symbol, "local", activeScope, id);
      const [parametersSpec, bodySpec] = nodeSpec.children ?? [];
      if (parametersSpec === undefined || bodySpec === undefined) {
        throw new Error(`test nested '${nodeSpec.kind}' needs [parameters, body] children`);
      }
      const parametersId = walk(parametersSpec, nestedScope);
      const bodyId = walk(bodySpec, nestedScope);
      record.children = [parametersId, bodyId];
      emitOutput(nodeSpec, id);
      return id;
    }

    if (isFunction) {
      const owner = options.owner!;
      node.symbol = owner.nameSymbol;
      node.scope = owner.scope;
      const { id, record } = pushNode(node);
      // The function node itself binds the definition name and IS the definition's body node.
      symbolNodes.set(owner.nameSymbol, id);
      owner.bodyNodeId = id;
      const parametersId = walk(
        {
          kind: "parameters",
          children: owner.spec.parameters.map((parameter) => ({
            kind: "parameter" as ComputationNodeKind,
            symbol: parameter,
            declares: true,
          })),
        },
        owner.scope,
      );
      // Bind the definition's parameter list in declaration order, read from the STORED nodes.
      owner.parameterIds = storedChildIds(parametersId).map(storedSymbol);
      const bodyId = walk(owner.spec.body, owner.scope);
      record.children = [parametersId, bodyId];
      emitOutput(nodeSpec, id);
      return id;
    }

    if (nodeSpec.declares === true) {
      // A declaration site: the identifier itself introduces the binding.
      const { id, record } = pushNode(node);
      record.children = [];
      record.symbol = bindSymbol(
        nodeSpec.symbol ?? "",
        nodeSpec.kind === "parameter" ? "parameter" : "local",
        activeScope,
        id,
      );
      emitOutput(nodeSpec, id);
      return id;
    }

    // Leaf read. Restricted to `identifier`: every other kind carrying `symbol` is either a
    // declaration site or owns `receiver`/`keywordArgs`/children, so short-circuiting here would drop
    // those fields or misclassify a binding as a read.
    if (nodeSpec.kind === "identifier" && nodeSpec.symbol !== undefined) {
      const { id, record } = pushNode(node);
      record.children = [];
      const symbolId = readSymbol(nodeSpec.symbol, activeScope);
      record.symbol = symbolId;
      registerUse(activeScope, symbolId);
      emitOutput(nodeSpec, id);
      return id;
    }

    hoistTargets(nodeSpec, activeScope);
    const { id, record } = pushNode(node);
    const childIds: ComputationNodeId[] = [];
    if (nodeSpec.target !== undefined && BINDING_TARGET_KINDS.has(nodeSpec.kind)) {
      // A comprehension/for hoists its clause targets, so the loop variable is bound before the
      // element expression is walked; otherwise the target is bound here.
      const hoisted = targetSymbolBySpec.get(nodeSpec);
      if (hoisted === undefined) {
        childIds.push(
          walk({ kind: "identifier", symbol: nodeSpec.target, declares: true }, activeScope),
        );
      } else {
        const { id: bindingId, record: bindingRecord } = pushNode({
          kind: "identifier",
          children: [],
        });
        bindingRecord.symbol = hoisted;
        symbolNodes.set(hoisted, bindingId);
        childIds.push(bindingId);
      }
    }
    for (const child of nodeSpec.children ?? []) {
      childIds.push(walk(child, activeScope));
    }
    record.children = childIds;
    if (nodeSpec.symbol !== undefined) {
      if (DECLARATION_NODE_KINDS.has(nodeSpec.kind)) {
        let kind: ComputationSymbolKind = "local";
        if (nodeSpec.kind === "import") {
          kind = "import";
        } else if (nodeSpec.kind === "parameter") {
          kind = "parameter";
        }
        record.symbol = bindSymbol(nodeSpec.symbol, kind, activeScope, id);
      } else {
        const symbolId = readSymbol(nodeSpec.symbol, activeScope);
        record.symbol = symbolId;
        registerUse(activeScope, symbolId);
      }
    }
    if (nodeSpec.receiver !== undefined) {
      record.receiver = walk(nodeSpec.receiver, activeScope);
    }
    if (nodeSpec.keywordArgs !== undefined) {
      record.keywordArgs = nodeSpec.keywordArgs.map((argument) => ({
        name: argument.name,
        value: walk(argument.value, activeScope),
      }));
    }
    emitOutput(nodeSpec, id);
    return id;
  };

  const roots = spec.roots.map((rootSpec) => {
    if (rootSpec.kind === "function" || rootSpec.kind === "lambda") {
      const owner = definitions.get(rootSpec.symbol ?? "");
      if (owner === undefined) {
        throw new Error(`test root function '${rootSpec.symbol}' has no definition spec`);
      }
      return walk(rootSpec, "scope0", { owner });
    }
    return walk(rootSpec, "scope0");
  });

  const definitionRecords: ComputationDefinitionV1[] = (spec.definitions ?? []).map(
    (definition, index) => {
      const entry = definitions.get(definition.name)!;
      const isDefinitionName = (symbolId: string): boolean => {
        const name = symbolName[Number(symbolId.slice(3))];
        return definitions.has(name);
      };
      const dependencyNames =
        definition.dependencies ??
        (definitionUses.get(entry.scope) ?? [])
          .filter(isDefinitionName)
          .map((symbolId) => symbolName[Number(symbolId.slice(3))]);
      const dependencies = dependencyNames.map((name) => {
        const matched = definitions.get(name);
        if (matched !== undefined) {
          return matched.nameSymbol;
        }
        const external = externalsByName.get(name);
        if (external === undefined) {
          throw new Error(
            `test dependency '${name}' of '${definition.name}' is not a known symbol`,
          );
        }
        return external;
      });
      // NO synthesized edges: `dependencies` stays the exact direct def/use edges the body reads. A
      // mutual helper therefore lists its partner and nothing else; `recursive` is never encoded by
      // inventing a self edge.
      if (entry.bodyNodeId === undefined) {
        throw new Error(
          `test definition '${definition.name}' was never walked; add a matching root function node`,
        );
      }
      return {
        id: `def${index}`,
        kind: definition.kind ?? "function",
        nameSymbol: entry.nameSymbol,
        parameters: entry.parameterIds,
        // The definition's body IS its walked function/lambda node.
        body: entry.bodyNodeId,
        dependencies,
        recursive: false,
        scope: entry.scope,
        complete: definition.complete ?? true,
        unsupportedReasons: definition.unsupportedReasons ?? [],
      };
    },
  );

  // `recursive` is reachability metadata over the materialized dependency graph, NOT a direct self
  // edge: a definition is recursive when its own name is reachable from the symbols it lists, so
  // every member of a mutual cycle is recursive. Reachability is bounded by a visited set and the
  // direct dependency lists are read as-is, so no edge is added to make the flag true.
  const dependenciesByName = new Map(
    definitionRecords.map((record) => [record.nameSymbol, record.dependencies] as const),
  );
  for (const record of definitionRecords) {
    const visited = new Set<string>();
    const pending = [...record.dependencies];
    while (pending.length > 0) {
      const symbolId = pending.pop()!;
      if (symbolId === record.nameSymbol) {
        record.recursive = true;
        break;
      }
      if (visited.has(symbolId)) {
        continue;
      }
      visited.add(symbolId);
      pending.push(...(dependenciesByName.get(symbolId) ?? []));
    }
  }

  return {
    version: COMPUTATION_IR_VERSION,
    language: spec.language ?? "python",
    nodes,
    symbols: symbols.map((symbol) => {
      const node = symbolNodes.get(symbol.id);
      return node === undefined || node === "" ? symbol : { ...symbol, node };
    }),
    slots,
    definitions: definitionRecords,
    roots,
    outputs,
    complete: spec.complete ?? true,
    unsupportedReasons: spec.unsupportedReasons ?? [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildEvidence(
  spec: ProgramSpec,
  overrides: Partial<Omit<ResinComputationEvidenceV1, "evidenceId">> = {},
): ResinComputationEvidenceV1 {
  const program = buildProgram(spec);
  const body = {
    version: COMPUTATION_IR_VERSION,
    program,
    programDigest: computeComputationProgramDigest(program),
    origin: { kind: "inline", sourceEventId: "evt_source_1" },
    observation: {
      kind: "invocation",
      status: "success",
      callEventId: "evt_call_1",
      resultEventId: "evt_result_1",
    },
    dependencies: [],
    corrections: [],
    metrics: {
      sourceLines: 12,
      sourceBytes: 240,
      nodeCount: program.nodes.length,
      symbolCount: program.symbols.length,
      slotCount: program.slots.length,
      definitionCount: program.definitions.length,
    },
    analysisOnly: true,
    ...overrides,
  } satisfies Omit<ResinComputationEvidenceV1, "evidenceId">;
  return { evidenceId: computeComputationEvidenceDigest(body), ...body };
}

function reseal(evidence: ResinComputationEvidenceV1): ResinComputationEvidenceV1 {
  const { evidenceId: _discarded, ...body } = evidence;
  return { evidenceId: computeComputationEvidenceDigest(body), ...body };
}

/** Reseals evidence after its program changed, so only the intended check can fail. */
function resealProgram(
  evidence: ResinComputationEvidenceV1,
  program: ComputationProgramV1,
): ResinComputationEvidenceV1 {
  return reseal({
    ...evidence,
    program,
    programDigest: computeComputationProgramDigest(program),
    metrics: {
      ...evidence.metrics,
      nodeCount: program.nodes.length,
      symbolCount: program.symbols.length,
      slotCount: program.slots.length,
      definitionCount: program.definitions.length,
    },
  });
}

/**
 * Renames names consistently across a spec by substituting the serialized text, so symbol
 * ordinals (binding-introduction order, then free-symbol reference order) are preserved.
 */
function renameSpec(spec: ProgramSpec, renames: Record<string, string>): ProgramSpec {
  let text = JSON.stringify(spec);
  for (const [from, to] of Object.entries(renames)) {
    text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  }
  return JSON.parse(text) as ProgramSpec;
}

function expectProgramRejected(program: ComputationProgramV1, code: string): void {
  const result = ComputationProgramV1Schema.safeParse(program);
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues ?? [])).toContain(code);
}

/**
 * Sanity gate for the test-only builder: a positive fixture must be a canonical COMPLETE program, so
 * a builder defect (nodes missing `children`/`symbol`, dropped def/use edges, an unwalked definition)
 * fails here instead of masquerading as a contract failure downstream. Negative fixtures deliberately
 * violate one invariant, so they are asserted directly rather than through this helper.
 */
function expectCanonicalProgram(program: ComputationProgramV1): void {
  for (const [index, node] of program.nodes.entries()) {
    expect(node.id).toBe(`n${index}`);
    expect(Array.isArray(node.children)).toBe(true);
  }
  for (const [index, symbol] of program.symbols.entries()) {
    expect(symbol.id).toBe(`sym${index}`);
  }
  for (const [index, definition] of program.definitions.entries()) {
    expect(definition.id).toBe(`def${index}`);
    expect(definition.scope).toBe(`scope${index + 1}`);
    // A definition body must be the walked function/lambda node that declares its name symbol.
    const body = program.nodes.find((node) => node.id === definition.body);
    expect(body?.kind === "function" || body?.kind === "lambda").toBe(true);
    expect(body !== undefined && "symbol" in body ? body.symbol : undefined).toBe(
      definition.nameSymbol,
    );
  }
  const result = ComputationProgramV1Schema.safeParse(program);
  expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
}

// ============================================================================
// Fixture algorithms (synthetic data only)
// ============================================================================

/** Orchestrator with an authored helper: `sum(row[amount] * factor for row in rows)`. */
function pipelineSpec(): ProgramSpec {
  return {
    slots: {
      amountKey: { kind: "string", role: "field_key" },
      factor: { kind: "number", role: "literal" },
    },
    definitions: [
      {
        name: "scaleRows",
        parameters: ["rows"],
        body: {
          kind: "return",
          output: { shape: "array", definition: "scaleRows" },
          children: [
            {
              kind: "comprehension",
              compKind: "list",
              children: [
                {
                  kind: "binary",
                  operator: "mul",
                  children: [
                    {
                      kind: "member",
                      fieldSlot: "amountKey",
                      children: [{ kind: "identifier", symbol: "row" }],
                    },
                    { kind: "literal", slot: "factor" },
                  ],
                },
                {
                  kind: "for_clause",
                  target: "row",
                  children: [{ kind: "identifier", symbol: "rows" }],
                },
              ],
            },
          ],
        },
      },
    ],
    roots: [
      { kind: "function", symbol: "scaleRows" },
      {
        kind: "expression",
        output: { shape: "number" },
        children: [
          {
            kind: "call",
            api: "collection.sum",
            children: [
              {
                kind: "call",
                symbol: "scaleRows",
                children: [{ kind: "identifier", symbol: "rows" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Inline record validation: keeps rows whose required key is present and positive. */
function validationSpec(): ProgramSpec {
  return {
    slots: { requiredKey: { kind: "string", role: "field_key" } },
    roots: [
      {
        kind: "expression",
        output: { shape: "array" },
        children: [
          {
            kind: "comprehension",
            compKind: "list",
            children: [
              {
                kind: "conditional",
                children: [
                  {
                    kind: "boolean",
                    operators: ["and"],
                    children: [
                      {
                        kind: "compare",
                        operators: ["ne"],
                        children: [
                          {
                            kind: "member",
                            fieldSlot: "requiredKey",
                            children: [{ kind: "identifier", symbol: "row" }],
                          },
                          { kind: "literal", constant: "null" },
                        ],
                      },
                      {
                        kind: "compare",
                        operators: ["gt"],
                        children: [
                          { kind: "identifier", symbol: "row" },
                          { kind: "literal", constant: "zero" },
                        ],
                      },
                    ],
                  },
                  { kind: "assert", children: [{ kind: "identifier", symbol: "row" }] },
                  { kind: "throw", children: [{ kind: "literal", constant: "empty_string" }] },
                ],
              },
              {
                kind: "for_clause",
                target: "row",
                children: [{ kind: "identifier", symbol: "rows" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Recursive helper: `walk(node)` descending one level at a time. */
function recursiveSpec(): ProgramSpec {
  return {
    definitions: [
      {
        name: "walk",
        parameters: ["node"],
        body: {
          kind: "return",
          output: { shape: "unknown", definition: "walk" },
          children: [
            {
              kind: "conditional",
              children: [
                {
                  kind: "compare",
                  operators: ["eq"],
                  children: [
                    { kind: "identifier", symbol: "node" },
                    { kind: "literal", constant: "null" },
                  ],
                },
                { kind: "literal", constant: "null" },
                {
                  kind: "call",
                  symbol: "walk",
                  children: [
                    {
                      kind: "member",
                      field: "child",
                      children: [{ kind: "identifier", symbol: "node" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    roots: [
      { kind: "function", symbol: "walk" },
      {
        kind: "expression",
        output: { shape: "unknown" },
        children: [
          { kind: "call", symbol: "walk", children: [{ kind: "identifier", symbol: "node" }] },
        ],
      },
    ],
  };
}

/** Mutually recursive helpers: `isEven`/`isOdd`. */
function mutualRecursionSpec(): ProgramSpec {
  const parityBody = (callee: string, calleeResult: string): NodeSpec => ({
    kind: "return",
    children: [
      {
        kind: "conditional",
        children: [
          {
            kind: "compare",
            operators: ["eq"],
            children: [
              { kind: "identifier", symbol: "value" },
              { kind: "literal", constant: "zero" },
            ],
          },
          { kind: "literal", constant: "true" },
          {
            kind: "call",
            symbol: callee,
            children: [
              {
                kind: "binary",
                operator: "sub",
                children: [
                  { kind: "identifier", symbol: "value" },
                  { kind: "literal", constant: "one" },
                ],
              },
            ],
          },
        ],
      },
    ],
    output: { shape: "boolean", definition: calleeResult },
  });
  return {
    definitions: [
      {
        name: "isEven",
        parameters: ["value"],
        dependencies: ["isOdd"],
        body: parityBody("isOdd", "isEven"),
      },
      {
        name: "isOdd",
        parameters: ["value"],
        dependencies: ["isEven"],
        body: parityBody("isEven", "isOdd"),
      },
    ],
    roots: [
      { kind: "function", symbol: "isEven" },
      { kind: "function", symbol: "isOdd" },
      {
        kind: "expression",
        output: { shape: "boolean" },
        children: [
          { kind: "call", symbol: "isEven", children: [{ kind: "literal", constant: "one" }] },
        ],
      },
    ],
  };
}

describe("computation evidence contracts", () => {
  describe("ordered algorithm preservation", () => {
    it("distinguishes canonical callable references from other callbacks and invocations", () => {
      const mapped = (api: string, kind: "api_reference" | "call" = "api_reference") =>
        buildProgram({
          roots: [
            {
              kind: "expression",
              output: { shape: "array" },
              children: [
                {
                  kind: "call",
                  api: "collection.map",
                  children: [
                    { kind, api },
                    { kind: "array", children: [{ kind: "literal", constant: "one" }] },
                  ],
                },
              ],
            },
          ],
        });
      const reference = mapped("number.abs");
      expectCanonicalProgram(reference);
      const digest = computeComputationProgramDigest(reference);
      expect(digest).not.toBe(computeComputationProgramDigest(mapped("number.round")));
      expect(digest).not.toBe(computeComputationProgramDigest(mapped("number.abs", "call")));
    });

    it("distinguishes arithmetic operators and bound operand order", () => {
      const combine = (operator: string, swap = false): ProgramSpec => ({
        definitions: [
          {
            name: "combine",
            parameters: ["left", "right"],
            body: {
              kind: "return",
              output: { shape: "number", definition: "combine" },
              children: [
                {
                  kind: "binary",
                  operator,
                  children: [
                    { kind: "identifier", symbol: swap ? "right" : "left" },
                    { kind: "identifier", symbol: swap ? "left" : "right" },
                  ],
                },
              ],
            },
          },
        ],
        roots: [
          { kind: "function", symbol: "combine" },
          {
            kind: "expression",
            output: { shape: "number" },
            children: [
              {
                kind: "call",
                symbol: "combine",
                children: [
                  { kind: "literal", constant: "one" },
                  { kind: "literal", constant: "zero" },
                ],
              },
            ],
          },
        ],
      });
      const add = computeComputationProgramDigest(buildProgram(combine("add")));
      expect(add).not.toBe(computeComputationProgramDigest(buildProgram(combine("sub"))));
      expect(add).not.toBe(computeComputationProgramDigest(buildProgram(combine("add", true))));
      expect(add).toBe(computeComputationProgramDigest(buildProgram(combine("add"))));
    });

    it("distinguishes ordered pipeline stages rather than counting operations", () => {
      const pipeline = (order: readonly ("sort" | "map" | "filter")[]): ProgramSpec => {
        let current: NodeSpec = { kind: "identifier", symbol: "rows" };
        for (const stage of order) {
          current = { kind: "call", api: `collection.${stage}`, children: [current] };
        }
        return {
          roots: [
            {
              kind: "expression",
              output: { shape: "number" },
              children: [{ kind: "call", api: "collection.sum", children: [current] }],
            },
          ],
        };
      };
      const sortedFirst = computeComputationProgramDigest(
        buildProgram(pipeline(["sort", "map", "filter"])),
      );
      expect(sortedFirst).not.toBe(
        computeComputationProgramDigest(buildProgram(pipeline(["map", "sort", "filter"]))),
      );
      expect(sortedFirst).not.toBe(
        computeComputationProgramDigest(buildProgram(pipeline(["sort", "filter", "map"]))),
      );
      expect(sortedFirst).toBe(
        computeComputationProgramDigest(buildProgram(pipeline(["sort", "map", "filter"]))),
      );
    });

    it("preserves ordered keyword arguments, control flow and comparison direction", () => {
      const call = (keywordArgs: Array<{ name: string; value: NodeSpec }>): ProgramSpec => ({
        roots: [
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "call",
                api: "collection.sort",
                keywordArgs,
                children: [{ kind: "identifier", symbol: "rows" }],
              },
            ],
          },
        ],
      });
      const keyFirst = computeComputationProgramDigest(
        buildProgram(
          call([
            { name: "key", value: { kind: "identifier", symbol: "total" } },
            { name: "reverse", value: { kind: "literal", constant: "false" } },
          ]),
        ),
      );
      expect(keyFirst).not.toBe(
        computeComputationProgramDigest(
          buildProgram(
            call([
              { name: "reverse", value: { kind: "literal", constant: "false" } },
              { name: "key", value: { kind: "identifier", symbol: "total" } },
            ]),
          ),
        ),
      );
      expect(keyFirst).not.toBe(
        computeComputationProgramDigest(
          buildProgram(
            call([
              { name: "key", value: { kind: "literal", constant: "null" } },
              { name: "reverse", value: { kind: "literal", constant: "false" } },
            ]),
          ),
        ),
      );

      // Repeated keyword names are not a bag: the same name twice is rejected, distinct names are not.
      const duplicateNames = buildProgram(
        call([
          { name: "key", value: { kind: "literal", constant: "null" } },
          { name: "key", value: { kind: "literal", constant: "zero" } },
        ]),
      );
      expect(ComputationProgramV1Schema.safeParse(duplicateNames).success).toBe(false);

      const branch = (swap: boolean): ProgramSpec => ({
        roots: [
          {
            kind: "if",
            children: [
              {
                kind: "compare",
                operators: [swap ? "lt" : "gt"],
                children: [
                  { kind: "identifier", symbol: "left" },
                  { kind: "identifier", symbol: "right" },
                ],
              },
              { kind: "return", children: [{ kind: "literal", constant: "one" }] },
              { kind: "return", children: [{ kind: "literal", constant: "zero" }] },
            ],
          },
        ],
      });
      expect(computeComputationProgramDigest(buildProgram(branch(false)))).not.toBe(
        computeComputationProgramDigest(buildProgram(branch(true))),
      );

      const loops = (kind: "for" | "while"): ProgramSpec =>
        kind === "for"
          ? {
              roots: [
                {
                  kind: "for",
                  target: "row",
                  children: [
                    { kind: "identifier", symbol: "rows" },
                    {
                      kind: "block",
                      children: [
                        { kind: "assert", children: [{ kind: "identifier", symbol: "row" }] },
                      ],
                    },
                  ],
                },
              ],
            }
          : {
              roots: [
                {
                  kind: "while",
                  children: [
                    { kind: "literal", constant: "true" },
                    { kind: "block", children: [{ kind: "break" }] },
                  ],
                },
              ],
            };
      expect(computeComputationProgramDigest(buildProgram(loops("for")))).not.toBe(
        computeComputationProgramDigest(buildProgram(loops("while"))),
      );

      const boolean = (operator: string): ProgramSpec => ({
        roots: [
          {
            kind: "expression",
            output: { shape: "boolean" },
            children: [
              {
                kind: "boolean",
                operators: [operator],
                children: [
                  { kind: "identifier", symbol: "a" },
                  { kind: "identifier", symbol: "b" },
                ],
              },
            ],
          },
        ],
      });
      expect(computeComputationProgramDigest(buildProgram(boolean("and")))).not.toBe(
        computeComputationProgramDigest(buildProgram(boolean("or"))),
      );
    });

    it("preserves finite constants, structural key selection and slot equality", () => {
      const constant = (value: string): ProgramSpec => ({
        roots: [
          {
            kind: "expression",
            output: { shape: "number" },
            children: [{ kind: "literal", constant: value }],
          },
        ],
      });
      const digests = new Map(
        COMPUTATION_CONSTANTS.map((value) => [
          value,
          computeComputationProgramDigest(buildProgram(constant(value))),
        ]),
      );
      expect(digests.get("zero")).not.toBe(digests.get("one"));
      expect(digests.get("true")).not.toBe(digests.get("false"));
      expect(new Set(digests.values()).size).toBe(COMPUTATION_CONSTANTS.length);
      for (const value of COMPUTATION_CONSTANTS) {
        expect(ComputationProgramV1Schema.safeParse(buildProgram(constant(value))).success).toBe(
          true,
        );
      }

      const keyed = (amountSlot: string, dstSlot: string): ProgramSpec => ({
        slots: {
          amountKey: { kind: "string", role: "field_key" },
          dstKey: { kind: "string", role: "field_key" },
        },
        roots: [
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "array",
                children: [
                  {
                    kind: "member",
                    field: "owner",
                    children: [{ kind: "identifier", symbol: "row" }],
                  },
                  {
                    kind: "member",
                    fieldSlot: amountSlot,
                    children: [{ kind: "identifier", symbol: "row" }],
                  },
                  {
                    kind: "member",
                    fieldSlot: dstSlot,
                    children: [{ kind: "identifier", symbol: "row" }],
                  },
                ],
              },
            ],
          },
        ],
      });
      const amountFirst = computeComputationProgramDigest(
        buildProgram(keyed("amountKey", "dstKey")),
      );
      const dstFirst = computeComputationProgramDigest(buildProgram(keyed("dstKey", "amountKey")));
      // Which PRIVATE key string a slot denotes is not algorithm structure: slot identities are
      // positional, so both specs read "the first key, then a second distinct key".
      expect(amountFirst).toBe(dstFirst);
      // The same key selection is stable across rebuilds, while reusing ONE slot at both keyed
      // positions differs from two distinct slots (slot equality is ordinal equality).
      expect(amountFirst).toBe(
        computeComputationProgramDigest(buildProgram(keyed("amountKey", "dstKey"))),
      );
      const reused: ProgramSpec = {
        slots: { amountKey: { kind: "string", role: "field_key" } },
        roots: [
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "array",
                children: [
                  {
                    kind: "member",
                    field: "owner",
                    children: [{ kind: "identifier", symbol: "row" }],
                  },
                  {
                    kind: "member",
                    fieldSlot: "amountKey",
                    children: [{ kind: "identifier", symbol: "row" }],
                  },
                  {
                    kind: "member",
                    fieldSlot: "amountKey",
                    children: [{ kind: "identifier", symbol: "row" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(computeComputationProgramDigest(buildProgram(reused))).not.toBe(amountFirst);
      // Same positions, same key slots, different safe key name is also a selection change.
      const structural: ProgramSpec = {
        roots: [
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [
              { kind: "member", field: "owner", children: [{ kind: "identifier", symbol: "row" }] },
            ],
          },
        ],
      };
      const otherField = clone(structural);
      (otherField.roots[0].children![0] as NodeSpec).field = "total";
      expect(computeComputationProgramDigest(buildProgram(structural))).not.toBe(
        computeComputationProgramDigest(buildProgram(otherField)),
      );
    });

    it("shares the digest for renamed anonymous-equivalent graphs", () => {
      const digest = computeComputationProgramDigest(buildProgram(pipelineSpec()));

      const descriptive = renameSpec(pipelineSpec(), {
        scaleRows: "evaluateRows",
        rows: "records",
        row: "entry",
        factor: "multiplier",
      });
      expect(computeComputationProgramDigest(buildProgram(descriptive))).toBe(digest);

      // An eval-like name is not distinguished from a descriptive one: naming is not the algorithm.
      // (`pipelineSpec` has one helper whose only dependency-free body is the comprehension itself.)
      const evalNamed = renameSpec(pipelineSpec(), {
        scaleRows: "eval",
        rows: "data",
        row: "v",
        factor: "f",
      });
      expect(computeComputationProgramDigest(buildProgram(evalNamed))).toBe(digest);

      // But the ordered body is load-bearing: swapping the binary operator changes the digest.
      const altered = clone(pipelineSpec());
      const body = altered.definitions![0].body;
      const comprehension = body.children![0];
      const binary = comprehension.children![0];
      binary.operator = "add";
      expect(computeComputationProgramDigest(buildProgram(altered))).not.toBe(digest);

      // Renaming must not be able to hide a genuine structure change either.
      const renamedAndAltered = renameSpec(altered, {
        scaleRows: "evaluateRows",
        rows: "records",
        row: "entry",
      });
      expect(computeComputationProgramDigest(buildProgram(renamedAndAltered))).not.toBe(digest);
    });

    it("captures an inline lambda with its own nested scope and an outer capture", () => {
      const spec: ProgramSpec = {
        slots: { amountKey: { kind: "string", role: "field_key" } },
        definitions: [
          {
            name: "topRows",
            parameters: ["rows"],
            body: {
              kind: "return",
              output: { shape: "array", definition: "topRows" },
              children: [
                {
                  kind: "call",
                  api: "collection.sort",
                  children: [{ kind: "identifier", symbol: "rows" }],
                  keywordArgs: [
                    {
                      name: "key",
                      value: {
                        kind: "lambda",
                        symbol: "rankOf",
                        children: [
                          {
                            kind: "parameters",
                            children: [{ kind: "parameter", symbol: "row", declares: true }],
                          },
                          {
                            kind: "member",
                            fieldSlot: "amountKey",
                            children: [{ kind: "identifier", symbol: "row" }],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
        roots: [
          { kind: "function", symbol: "topRows" },
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "call",
                symbol: "topRows",
                children: [{ kind: "identifier", symbol: "rows" }],
              },
            ],
          },
        ],
      };
      const program = buildProgram(spec);
      expectCanonicalProgram(program);

      const nestedLambda = program.nodes.find(
        (node) => node.kind === "lambda" && node.id !== program.definitions[0].body,
      );
      expect(nestedLambda).toBeDefined();
      if (nestedLambda === undefined) {
        throw new Error("expected a captured nested lambda");
      }
      // The nested lambda owns a scope distinct from the definition scope and from the module.
      expect(nestedLambda.kind === "lambda" && nestedLambda.scope).not.toBe(
        program.definitions[0].scope,
      );
      expect(nestedLambda.kind === "lambda" && nestedLambda.scope).not.toBe("scope0");
      // Its parameter is scoped to that nested lambda, and the definition dependency set is unaffected.
      const nestedScope = nestedLambda.kind === "lambda" ? nestedLambda.scope : "";
      const nestedParameter = program.symbols.find(
        (symbol) => symbol.kind === "parameter" && symbol.scope === nestedScope,
      );
      expect(nestedParameter).toBeDefined();
      expect(program.definitions[0].dependencies).toEqual([]);
      expect(isSubstantiveComputationEvidence(buildEvidence(spec))).toBe(true);

      // A nested lambda that is missing its parameters/body pair is malformed.
      const malformed = clone(program);
      (
        malformed.nodes.find((node) => node.id === nestedLambda.id) as { children: string[] }
      ).children = [nestedLambda.children[0]];
      // One child violates the `[parameters, body]` arity in the bounded schema.
      expect(ComputationProgramV1Schema.safeParse(malformed).success).toBe(false);
    });

    it("keeps def/use edges load-bearing and dependency listing order irrelevant", () => {
      const withHelper = computeComputationProgramDigest(buildProgram(pipelineSpec()));
      const inlined: ProgramSpec = {
        slots: pipelineSpec().slots,
        roots: [
          {
            kind: "expression",
            output: { shape: "number" },
            children: [
              {
                kind: "call",
                api: "collection.sum",
                children: [
                  {
                    kind: "comprehension",
                    compKind: "list",
                    children: [
                      {
                        kind: "binary",
                        operator: "mul",
                        children: [
                          {
                            kind: "member",
                            fieldSlot: "amountKey",
                            children: [{ kind: "identifier", symbol: "row" }],
                          },
                          { kind: "literal", slot: "factor" },
                        ],
                      },
                      {
                        kind: "for_clause",
                        target: "row",
                        children: [{ kind: "identifier", symbol: "rows" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(computeComputationProgramDigest(buildProgram(inlined))).not.toBe(withHelper);

      // A definition reading two helpers: the dependency LISTING order is not part of the algorithm.
      const chained = (order: readonly string[]): ProgramSpec => ({
        slots: {
          amountKey: { kind: "string", role: "field_key" },
          factor: { kind: "number", role: "literal" },
        },
        definitions: [
          {
            name: "scale",
            parameters: ["rows"],
            body: {
              kind: "return",
              output: { shape: "array", definition: "scale" },
              children: [
                {
                  kind: "comprehension",
                  compKind: "list",
                  children: [
                    {
                      kind: "binary",
                      operator: "mul",
                      children: [
                        {
                          kind: "member",
                          fieldSlot: "amountKey",
                          children: [{ kind: "identifier", symbol: "row" }],
                        },
                        { kind: "literal", slot: "factor" },
                      ],
                    },
                    {
                      kind: "for_clause",
                      target: "row",
                      children: [{ kind: "identifier", symbol: "rows" }],
                    },
                  ],
                },
              ],
            },
          },
          {
            name: "pick",
            parameters: ["rows"],
            body: {
              kind: "return",
              output: { shape: "array", definition: "pick" },
              children: [
                {
                  kind: "comprehension",
                  compKind: "list",
                  children: [
                    {
                      kind: "member",
                      fieldSlot: "amountKey",
                      children: [{ kind: "identifier", symbol: "row" }],
                    },
                    {
                      kind: "for_clause",
                      target: "row",
                      children: [{ kind: "identifier", symbol: "rows" }],
                    },
                  ],
                },
              ],
            },
          },
          {
            name: "combine",
            parameters: ["rows"],
            dependencies: order,
            body: {
              kind: "return",
              output: { shape: "array", definition: "combine" },
              children: [
                {
                  kind: "array",
                  children: [
                    {
                      kind: "call",
                      symbol: "scale",
                      children: [{ kind: "identifier", symbol: "rows" }],
                    },
                    {
                      kind: "call",
                      symbol: "pick",
                      children: [{ kind: "identifier", symbol: "rows" }],
                    },
                  ],
                },
              ],
            },
          },
        ],
        roots: [
          { kind: "function", symbol: "scale" },
          { kind: "function", symbol: "pick" },
          { kind: "function", symbol: "combine" },
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "call",
                symbol: "combine",
                children: [{ kind: "identifier", symbol: "rows" }],
              },
            ],
          },
        ],
      });
      const listed = computeComputationProgramDigest(buildProgram(chained(["scale", "pick"])));
      expect(listed).toBe(
        computeComputationProgramDigest(buildProgram(chained(["pick", "scale"]))),
      );
      expect(listed).not.toBe(withHelper);
    });
  });

  describe("recursion and dependency closure", () => {
    it("accepts a resolved recursive helper and records the self edge", () => {
      const program = buildProgram(recursiveSpec());
      expectCanonicalProgram(program);
      expect(program.definitions[0].recursive).toBe(true);
      expect(program.definitions[0].dependencies).toEqual([program.definitions[0].nameSymbol]);
      expect(isSubstantiveComputationEvidence(buildEvidence(recursiveSpec()))).toBe(true);
    });

    it("accepts mutually recursive definitions and rejects a broken cycle declaration", () => {
      const program = buildProgram(mutualRecursionSpec());
      expectCanonicalProgram(program);
      // Mutual recursion is a cycle through the materialized graph: each definition reaches itself via
      // its partner, so BOTH are recursive even though neither reads its own name directly.
      expect(program.definitions.map((definition) => definition.recursive)).toEqual([true, true]);
      // The dependency lists stay the exact direct edges: partner only, no synthetic self edge.
      expect(program.definitions[0].dependencies).toEqual([program.definitions[1].nameSymbol]);
      expect(program.definitions[1].dependencies).toEqual([program.definitions[0].nameSymbol]);

      // Denying the cycle the graph actually contains is rejected.
      const falseRecursion = clone(program);
      falseRecursion.definitions[0].recursive = false;
      expectProgramRejected(falseRecursion, "DEPENDENCY_MISMATCH");

      // Claiming a self edge that the body never reads is rejected.
      const selfEdgeClaim = clone(program);
      selfEdgeClaim.definitions[0].recursive = true;
      selfEdgeClaim.definitions[0].dependencies = [
        selfEdgeClaim.definitions[0].nameSymbol,
        ...selfEdgeClaim.definitions[0].dependencies,
      ];
      expectProgramRejected(selfEdgeClaim, "DEPENDENCY_MISMATCH");

      // Dropping the cross-definition edge is rejected too.
      const brokenCycle = clone(program);
      brokenCycle.definitions[0].dependencies = [];
      expectProgramRejected(brokenCycle, "DEPENDENCY_MISMATCH");
    });

    it("rejects unresolved definition symbols, undeclared captures and wrong scope claims", () => {
      const program = buildProgram(pipelineSpec());

      const unresolved = clone(program);
      unresolved.definitions = [];
      expectProgramRejected(unresolved, "DEFINITION_CLOSURE");

      const orphan = clone(program);
      orphan.symbols.push({
        id: `sym${orphan.symbols.length}`,
        kind: "external",
        scope: "scope0",
      });
      expectProgramRejected(orphan, "ORPHAN_SYMBOL");

      // A local that is neither bound nor read is a dangling declaration record.
      const unusedLocal = clone(program);
      unusedLocal.symbols.push({
        id: `sym${unusedLocal.symbols.length}`,
        kind: "local",
        scope: "scope0",
      });
      expectProgramRejected(unusedLocal, "SYMBOL_DECLARATION");

      // A local that is read but never bound is hidden state captured from outside the program.
      const hiddenState = clone(program);
      const hiddenId = `sym${hiddenState.symbols.length}`;
      hiddenState.symbols.push({ id: hiddenId, kind: "local", scope: "scope0" });
      const readNode = hiddenState.nodes.find((node) => node.kind === "identifier")!;
      (readNode as { symbol: string }).symbol = hiddenId;
      expectProgramRejected(hiddenState, "SYMBOL_DECLARATION");

      const wrongScope = clone(program);
      wrongScope.symbols = wrongScope.symbols.map((symbol) =>
        symbol.kind === "parameter" ? { ...symbol, scope: "scope0" as const } : symbol,
      );
      expectProgramRejected(wrongScope, "SYMBOL_SCOPE");
    });

    it("rejects a missing, extra or non-definition dependency edge", () => {
      const program = buildProgram(mutualRecursionSpec());

      const missing = clone(program);
      missing.definitions[0].dependencies = [];
      expectProgramRejected(missing, "DEPENDENCY_MISMATCH");

      const extra = clone(program);
      const parameterSymbol = program.symbols.find((symbol) => symbol.kind === "parameter")!;
      extra.definitions[0].dependencies = [
        ...extra.definitions[0].dependencies,
        parameterSymbol.id,
      ];
      expectProgramRejected(extra, "DEPENDENCY_MISMATCH");

      const nonDefinition = clone(program);
      nonDefinition.symbols = nonDefinition.symbols.map((symbol) =>
        symbol.kind === "definition" ? { ...symbol, kind: "external" as const } : symbol,
      );
      expectProgramRejected(nonDefinition, "DEFINITION_CLOSURE");

      // A definition that reads nothing may legitimately list nothing.
      expect(ComputationProgramV1Schema.safeParse(buildProgram(pipelineSpec())).success).toBe(true);
      expect(buildProgram(pipelineSpec()).definitions[0].dependencies).toEqual([]);
    });
  });

  describe("malformed graphs and limits", () => {
    it("rejects dangling references, child cycles and unreachable nodes", () => {
      const program = buildProgram(pipelineSpec());

      const danglingRoot = clone(program);
      danglingRoot.roots = ["n999"];
      expectProgramRejected(danglingRoot, "CROSS_REF");

      const danglingChild = clone(program);
      const callIndex = danglingChild.nodes.findIndex((node) => node.kind === "call");
      (danglingChild.nodes[callIndex] as { children: string[] }).children = ["n900"];
      expectProgramRejected(danglingChild, "CROSS_REF");

      const cyclic: ComputationProgramV1 = {
        ...clone(program),
        nodes: [
          { id: "n0", kind: "block", children: ["n1"] },
          { id: "n1", kind: "block", children: ["n0"] },
        ] as ComputationNodeV1[],
        symbols: [],
        definitions: [],
        outputs: [],
        roots: ["n0"],
      };
      expectProgramRejected(cyclic, "NODE_CYCLE");

      const unreachable = clone(program);
      unreachable.nodes.push({
        ...clone(unreachable.nodes[unreachable.nodes.length - 1]),
        id: `n${unreachable.nodes.length}`,
      } as ComputationNodeV1);
      expectProgramRejected(unreachable, "CROSS_REF");
    });

    it("rejects wrong child arity, unknown scope and non-canonical ids", () => {
      const program = buildProgram(pipelineSpec());

      const arity = clone(program);
      const binaryIndex = arity.nodes.findIndex((node) => node.kind === "binary");
      (arity.nodes[binaryIndex] as { children: string[] }).children = ["n0"];
      // Fewer children than the kind allows is a bounded-schema failure, not a silently accepted node.
      expect(ComputationProgramV1Schema.safeParse(arity).success).toBe(false);

      const compareProgram = buildProgram({
        roots: [
          {
            kind: "expression",
            output: { shape: "boolean" },
            children: [
              {
                kind: "compare",
                operators: ["gt"],
                children: [
                  { kind: "identifier", symbol: "a" },
                  { kind: "identifier", symbol: "b" },
                ],
              },
            ],
          },
        ],
      });
      expect(ComputationProgramV1Schema.safeParse(compareProgram).success).toBe(true);
      const tampered = clone(compareProgram);
      (
        tampered.nodes.find((node) => node.kind === "compare") as { operators: string[] }
      ).operators = ["gt", "lt"];
      expectProgramRejected(tampered, "CHILD_ARITY");

      const scope = clone(program);
      (scope.nodes[0] as { scope: string }).scope = "scope9";
      expectProgramRejected(scope, "SYMBOL_SCOPE");

      const ids = clone(program);
      // A shape-valid id at the wrong position is an order violation, not a format error.
      ids.nodes[0] = { ...ids.nodes[0], id: `n${program.nodes.length - 1}` } as ComputationNodeV1;
      expectProgramRejected(ids, "NODE_ORDER");
    });

    it("rejects programs over the pinned node and nesting limits", () => {
      const many = clone(buildProgram(pipelineSpec()));
      const template = many.nodes[many.nodes.length - 1];
      while (many.nodes.length <= COMPUTATION_IR_LIMITS.nodes) {
        many.nodes.push({
          ...clone(template),
          id: `n${many.nodes.length}`,
        } as ComputationNodeV1);
      }
      expectProgramRejected(many, "LIMIT_NODES");

      let deepInner: NodeSpec = { kind: "identifier", symbol: "value" };
      for (let depth = 0; depth <= COMPUTATION_IR_LIMITS.nesting + 1; depth += 1) {
        deepInner = { kind: "expression", children: [deepInner] };
      }
      const deep = buildProgram({
        roots: [{ kind: "expression", output: { shape: "unknown" }, children: [deepInner] }],
      });
      expect(COMPUTATION_IR_LIMITS.nesting).toBe(64);
      expectProgramRejected(deep, "NESTING_LIMIT");
    });

    it("rejects slots past the pinned slot limit and orphan slots", () => {
      const slotCount = COMPUTATION_IR_LIMITS.slots + 1;
      const spec: ProgramSpec = {
        slots: Object.fromEntries(
          Array.from({ length: slotCount }, (_, index) => [
            `key${index}`,
            { kind: "string" as const, role: "field_key" as const },
          ]),
        ),
        roots: [
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "array",
                children: Array.from({ length: slotCount }, (_, index) => ({
                  kind: "member" as const,
                  fieldSlot: `key${index}`,
                  children: [{ kind: "identifier", symbol: "row" }],
                })),
              },
            ],
          },
        ],
      };
      expectProgramRejected(buildProgram(spec), "LIMIT_SLOTS");

      const single: ProgramSpec = {
        slots: { key: { kind: "string", role: "field_key" } },
        roots: [
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [{ kind: "literal", slot: "key" }],
          },
        ],
      };
      const orphaned = clone(buildProgram(single));
      orphaned.slots.push({ id: "slot1", kind: "string", role: "field_key" });
      expectProgramRejected(orphaned, "ORPHAN_SLOT");

      // A literal must carry exactly one representation: a finite constant or an anonymous slot.
      const ambiguousLiteral = clone(buildProgram(single));
      (
        ambiguousLiteral.nodes.find((node) => node.kind === "literal") as { constant?: string }
      ).constant = "zero";
      expectProgramRejected(ambiguousLiteral, "FIELD_FORM");

      // Neither representation is a malformed literal.
      const bareLiteral = clone(buildProgram(single));
      const literalNode = bareLiteral.nodes.find((node) => node.kind === "literal")!;
      delete (literalNode as { slot?: string }).slot;
      expectProgramRejected(bareLiteral, "FIELD_FORM");
    });

    it("rejects a call that is not exactly one canonical api or resolved definition", () => {
      const call = (value: NodeSpec): ProgramSpec => ({
        roots: [{ kind: "expression", output: { shape: "unknown" }, children: [value] }],
      });

      // Neither selector: a dynamic dispatch could hide any external function.
      expectProgramRejected(
        buildProgram(call({ kind: "call", children: [{ kind: "identifier", symbol: "rows" }] })),
        "FIELD_FORM",
      );
      // Both selectors: ambiguous authority.
      expectProgramRejected(
        buildProgram(
          call({
            kind: "call",
            api: "collection.map",
            symbol: "rows",
            children: [{ kind: "identifier", symbol: "rows" }],
          }),
        ),
        "FIELD_FORM",
      );
      // A finite API alone is a complete call.
      expect(
        ComputationProgramV1Schema.safeParse(
          buildProgram(
            call({
              kind: "call",
              api: "collection.map",
              children: [{ kind: "identifier", symbol: "rows" }],
            }),
          ),
        ).success,
      ).toBe(true);

      // An unresolved external callee is not a complete call.
      expectProgramRejected(
        buildProgram(
          call({
            kind: "call",
            symbol: "dynamicFn",
            children: [{ kind: "literal", constant: "one" }],
          }),
        ),
        "DEFINITION_CLOSURE",
      );

      // A captured handle or callback parameter is not a callable definition either.
      const parameterCalled: ProgramSpec = {
        definitions: [
          {
            name: "applyAll",
            parameters: ["rows", "handler"],
            body: {
              kind: "return",
              output: { shape: "unknown", definition: "applyAll" },
              children: [
                {
                  kind: "call",
                  symbol: "handler",
                  children: [{ kind: "identifier", symbol: "rows" }],
                },
              ],
            },
          },
        ],
        roots: [
          { kind: "function", symbol: "applyAll" },
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [
              {
                kind: "call",
                symbol: "applyAll",
                children: [
                  { kind: "identifier", symbol: "rows" },
                  { kind: "literal", constant: "null" },
                ],
              },
            ],
          },
        ],
      };
      expectProgramRejected(buildProgram(parameterCalled), "DEFINITION_CLOSURE");

      // A local declared function value is equally unsupported as a callee.
      const localCalled: ProgramSpec = {
        roots: [
          {
            kind: "declare",
            declKind: "const",
            symbol: "transform",
            children: [{ kind: "literal", constant: "null" }],
          },
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [
              {
                kind: "call",
                symbol: "transform",
                children: [{ kind: "literal", constant: "one" }],
              },
            ],
          },
        ],
      };
      expectProgramRejected(buildProgram(localCalled), "DEFINITION_CLOSURE");
    });

    it("requires construction to use a construct API", () => {
      const construct = (api: string): ProgramSpec => ({
        roots: [
          {
            kind: "expression",
            output: { shape: "object" },
            children: [{ kind: "new", api, children: [{ kind: "literal", constant: "one" }] }],
          },
        ],
      });
      expect(
        ComputationProgramV1Schema.safeParse(buildProgram(construct("construct.map"))).success,
      ).toBe(true);
      expectProgramRejected(buildProgram(construct("collection.map")), "FIELD_FORM");
      expectProgramRejected(buildProgram(construct("json.parse")), "FIELD_FORM");
      expect(COMPUTATION_CONSTRUCT_APIS.every((api) => api.startsWith("construct."))).toBe(true);
      expect(COMPUTATION_CONSTRUCT_APIS).toContain("construct.error");
    });

    it("keeps slice bound roles addressable so lo:hi and lo::step cannot be flattened", () => {
      const bound = (): NodeSpec => ({ kind: "literal", constant: "null" });
      const slice = (slicePart: string | undefined, bounds: number): ProgramSpec => ({
        roots: [
          {
            kind: "expression",
            output: { shape: "array" },
            children: [
              {
                kind: "slice",
                ...(slicePart === undefined ? {} : { slicePart }),
                children: [
                  { kind: "identifier", symbol: "rows" },
                  ...Array.from({ length: bounds }, () => bound()),
                ],
              },
            ],
          },
        ],
      });

      // `lo:hi` (lower, upper) and `lo::step` (lower, <explicit null>, step) are both legal and differ.
      const loHi = buildProgram(slice("lower", 2));
      const loStep = buildProgram(slice("lower", 3));
      expect(ComputationProgramV1Schema.safeParse(loHi).success).toBe(true);
      expect(ComputationProgramV1Schema.safeParse(loStep).success).toBe(true);
      expect(computeComputationProgramDigest(loHi)).not.toBe(
        computeComputationProgramDigest(loStep),
      );

      // Roles continue from `slicePart`, so the legal bound counts are lower<=3, upper<=2, step<=1:
      // `:hi:step` has no lower bound, and `::step` has neither lower nor upper.
      expect(ComputationProgramV1Schema.safeParse(buildProgram(slice("upper", 2))).success).toBe(
        true,
      );
      expectProgramRejected(buildProgram(slice("upper", 3)), "CHILD_ARITY");
      expect(ComputationProgramV1Schema.safeParse(buildProgram(slice("step", 1))).success).toBe(
        true,
      );
      expectProgramRejected(buildProgram(slice("step", 2)), "CHILD_ARITY");
      // Bounds without any declared role cannot be interpreted.
      expectProgramRejected(buildProgram(slice(undefined, 1)), "FIELD_FORM");
      // A bare target with no bounds is a plain copy and needs no role.
      expect(ComputationProgramV1Schema.safeParse(buildProgram(slice(undefined, 0))).success).toBe(
        true,
      );
    });

    it("rejects a program that claims completeness alongside an unsupported node", () => {
      const spec: ProgramSpec = {
        roots: [
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [
              {
                kind: "call",
                api: "collection.map",
                children: [
                  {
                    kind: "unsupported",
                    unsupportedReason: "unsupported_construct",
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };
      expectProgramRejected(buildProgram(spec), "UNSUPPORTED_CONSISTENCY");

      const consistent: ProgramSpec = {
        ...spec,
        complete: false,
        unsupportedReasons: ["unsupported_construct"],
      };
      const program = buildProgram(consistent);
      expect(ComputationProgramV1Schema.safeParse(program).success).toBe(true);
      expect(isSubstantiveComputationEvidence(buildEvidence(consistent))).toBe(false);
    });

    it("rejects invalid output records", () => {
      const program = clone(buildProgram(pipelineSpec()));
      const nonOutputNode = program.nodes.find((node) => node.kind === "binary")!;
      program.outputs = [{ node: nonOutputNode.id, shape: "number" }];
      expectProgramRejected(program, "OUTPUT_INVALID");

      const unknownDefinition = clone(buildProgram(pipelineSpec()));
      unknownDefinition.outputs = [
        { node: unknownDefinition.roots[0], shape: "array", definitionId: "def7" },
      ];
      expectProgramRejected(unknownDefinition, "CROSS_REF");
    });

    it("pins the serialized byte limit and rejects oversize evidence", () => {
      expect(COMPUTATION_IR_LIMITS.serializedBytes).toBe(65536);
      const evidence = buildEvidence(pipelineSpec());
      expect(serializeComputationProgram(evidence.program).length).toBeLessThan(
        COMPUTATION_IR_LIMITS.serializedBytes,
      );
      const oversize = clone(evidence) as ResinComputationEvidenceV1 & { padding?: string };
      oversize.padding = "a".repeat(COMPUTATION_IR_LIMITS.serializedBytes);
      expect(readComputationEvidence(oversize)).toBeUndefined();
    });
  });

  describe("privacy boundaries and injection resistance", () => {
    it("rejects raw callable names and invocation arguments on API references", () => {
      const reference = buildProgram({
        roots: [{ kind: "api_reference", api: "number.abs" }],
      });
      const rawName = clone(reference);
      Object.assign(rawName.nodes[0]!, { api: "private_callback" });
      expect(ComputationProgramV1Schema.safeParse(rawName).success).toBe(false);

      const invocation = clone(reference);
      Object.assign(invocation.nodes[0]!, { children: ["n0"] });
      expect(ComputationProgramV1Schema.safeParse(invocation).success).toBe(false);

      const hiddenSource = clone(reference);
      Object.assign(hiddenSource.nodes[0]!, { source: "private callback implementation" });
      expect(ComputationProgramV1Schema.safeParse(hiddenSource).success).toBe(false);
    });

    it("rejects arbitrary, dynamic and generic-eval APIs and unknown node properties", () => {
      for (const api of ["eval", "subprocess.run", "child_process.exec", "os.system", "fetch"]) {
        const program = clone(buildProgram(pipelineSpec()));
        const call = program.nodes.find(
          (node) => node.kind === "call" && node.api === "collection.sum",
        )!;
        (call as { api: string }).api = api;
        // Only the finite canonical API vocabulary is admissible; anything else is rejected outright.
        const result = ComputationProgramV1Schema.safeParse(program);
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues ?? [])).toContain(api);
      }

      const rawSource = clone(buildProgram(pipelineSpec()));
      (rawSource.nodes[0] as unknown as Record<string, unknown>).rawSource = "import os";
      expectProgramRejected(rawSource, "rawSource");

      const rawValue = clone(buildProgram(pipelineSpec()));
      const memberNode = rawValue.nodes.find((node) => node.kind === "member")!;
      (memberNode as unknown as Record<string, unknown>).value = "AKIAIOSFODNN7EXAMPLE";
      expectProgramRejected(rawValue, "value");

      const unvalidatedLiteral = clone(buildProgram(pipelineSpec()));
      (unvalidatedLiteral.nodes[0] as unknown as Record<string, unknown>).rawPayload = {
        anything: true,
      };
      expectProgramRejected(unvalidatedLiteral, "rawPayload");

      const escapeHatch = clone(buildProgram(pipelineSpec()));
      (escapeHatch as unknown as Record<string, unknown>).raw = { anything: true };
      expectProgramRejected(escapeHatch, "raw");

      const slotPayload = clone(buildProgram(pipelineSpec()));
      slotPayload.slots = slotPayload.slots.map((slot) => ({ ...slot })) as ComputationSlotV1[];
      (slotPayload.slots[0] as unknown as Record<string, unknown>).value = "amount";
      expectProgramRejected(slotPayload, "value");
    });

    it("rejects secret-like, prototype and raw-evidence field keys", () => {
      for (const unsafeKey of [
        "user_api_key",
        "authToken",
        "session_id",
        "privateKey",
        "sk_live_abcdef",
        "xoxb_team_token",
        "mySecret",
        "__proto__",
        "constructor",
        "rawSource",
        "prompt",
        "access_token",
        "toJSON",
        "password_hash",
      ]) {
        expect(isSafeComputationFieldKey(unsafeKey)).toBe(false);
        const program = buildProgram({
          roots: [
            {
              kind: "expression",
              output: { shape: "unknown" },
              children: [
                {
                  kind: "member",
                  field: unsafeKey,
                  children: [{ kind: "identifier", symbol: "row" }],
                },
              ],
            },
          ],
        });
        expect(ComputationProgramV1Schema.safeParse(program).success).toBe(false);
      }

      for (const safeKey of [
        "owner_id",
        "total_cents",
        "rowCount",
        "skillName",
        "package_name",
        "items",
        "amount",
      ]) {
        expect(isSafeComputationFieldKey(safeKey)).toBe(true);
      }

      const unsafePair = buildProgram({
        roots: [
          {
            kind: "expression",
            output: { shape: "object" },
            children: [
              {
                kind: "object",
                children: [
                  {
                    kind: "pair",
                    field: "apiKey",
                    children: [{ kind: "literal", constant: "null" }],
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(ComputationProgramV1Schema.safeParse(unsafePair).success).toBe(false);
    });

    it("keeps secret-like keys anonymous through the field-slot escape hatch", () => {
      const spec: ProgramSpec = {
        slots: { key: { kind: "string", role: "field_key" } },
        roots: [
          {
            kind: "expression",
            output: { shape: "object" },
            children: [
              {
                kind: "object",
                children: [
                  {
                    kind: "pair",
                    fieldSlot: "key",
                    children: [{ kind: "literal", constant: "null" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const program = buildProgram(spec);
      expect(ComputationProgramV1Schema.safeParse(program).success).toBe(true);
      const serialized = serializeComputationProgram(program);
      expect(serialized).not.toContain("api_key");
      expect(serialized).toContain('"role":"field_key"');
      // A member/pair must choose exactly one of field or fieldSlot.
      const ambiguous = clone(program);
      const pairNode = ambiguous.nodes.find((node) => node.kind === "pair")!;
      (pairNode as unknown as Record<string, unknown>).field = "owner";
      expectProgramRejected(ambiguous, "FIELD_FORM");
    });

    it("rejects non-JSON, accessor-poisoned and prototype-shaped evidence payloads", () => {
      const evidence = buildEvidence(pipelineSpec());
      expect(readComputationEvidence(evidence)).toBeDefined();
      expect(readComputationEvidence(new Map([["a", 1]]))).toBeUndefined();
      expect(readComputationEvidence("not evidence")).toBeUndefined();
      expect(readComputationEvidence(null)).toBeUndefined();
      expect(readComputationEvidence([evidence])).toBeUndefined();
      expect(readComputationEvidence({ ...evidence, analysisOnly: false })).toBeUndefined();

      const poisoned: Record<string, unknown> = { ...evidence };
      Object.defineProperty(poisoned, "origin", {
        enumerable: true,
        get: () => {
          throw new Error("poison getter");
        },
      });
      expect(readComputationEvidence(poisoned)).toBeUndefined();

      const classInstance = Object.create({ prototype_field: 1 });
      classInstance.version = evidence.version;
      expect(readComputationEvidence(classInstance)).toBeUndefined();
    });

    it("rejects absolute, private and machine-specific origin paths", () => {
      for (const pathPattern of [
        "/home/dev/scripts/join.py",
        "~/scripts/join.py",
        "scripts/../secrets.json",
        "C:/Users/dev/x.py",
        "\\\\server\\share\\x.py",
      ]) {
        const evidence = buildEvidence(pipelineSpec(), {
          origin: { kind: "authored_file", sourceEventId: "evt_source_1", pathPattern },
        });
        expect(readComputationEvidence(evidence)).toBeUndefined();
      }
      const relative = buildEvidence(pipelineSpec(), {
        origin: {
          kind: "authored_file",
          sourceEventId: "evt_source_1",
          pathPattern: "scripts/join_records.py",
        },
      });
      expect(readComputationEvidence(relative)).toBeDefined();
    });
  });

  describe("observations and substantiveness", () => {
    it("does not mistake a callable reference for an observed computation", () => {
      const reference = buildEvidence({
        roots: [
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [{ kind: "api_reference", api: "number.abs" }],
          },
        ],
      });
      expect(ResinComputationEvidenceV1Schema.safeParse(reference).success).toBe(true);
      expect(isSubstantiveComputationEvidence(reference)).toBe(false);
    });

    it("requires a successful observed invocation with a meaningful computation", () => {
      expect(isSubstantiveComputationEvidence(buildEvidence(pipelineSpec()))).toBe(true);
      expect(isSubstantiveComputationEvidence(buildEvidence(validationSpec()))).toBe(true);
      expect(isSubstantiveComputationEvidence(buildEvidence(recursiveSpec()))).toBe(true);

      expect(
        isSubstantiveComputationEvidence(
          buildEvidence(pipelineSpec(), {
            observation: {
              kind: "definition",
              status: "success",
              callEventId: "evt_call_1",
              resultEventId: "evt_result_1",
            },
          }),
        ),
      ).toBe(false);
      expect(
        isSubstantiveComputationEvidence(
          buildEvidence(pipelineSpec(), {
            observation: { kind: "invocation", status: "pending", callEventId: "evt_call_1" },
          }),
        ),
      ).toBe(false);
      expect(
        isSubstantiveComputationEvidence(
          buildEvidence(pipelineSpec(), {
            observation: {
              kind: "invocation",
              status: "error",
              callEventId: "evt_call_1",
              resultEventId: "evt_result_1",
            },
          }),
        ),
      ).toBe(false);
      expect(
        isSubstantiveComputationEvidence(
          buildEvidence(pipelineSpec(), {
            observation: { kind: "invocation", status: "success", callEventId: "evt_call_1" },
          }),
        ),
      ).toBe(false);
      expect(isSubstantiveComputationEvidence(undefined)).toBe(false);
      expect(isSubstantiveComputationEvidence({ resinComputationEvidenceV1: "x" })).toBe(false);
    });

    it("never treats an incomplete or explicitly unsupported program as substantive", () => {
      const complete = buildEvidence(pipelineSpec());

      const incompleteProgram = clone(complete.program);
      incompleteProgram.complete = false;
      incompleteProgram.unsupportedReasons = ["unsupported_api"];
      const incomplete = resealProgram(clone(complete), incompleteProgram);
      expect(readComputationEvidence(incomplete)).toBeDefined();
      expect(isSubstantiveComputationEvidence(incomplete)).toBe(false);

      const unsupportedProgram = clone(complete.program);
      const unsupportedNodeId = `n${unsupportedProgram.nodes.length}` as ComputationNodeId;
      unsupportedProgram.nodes.push({
        id: unsupportedNodeId,
        kind: "unsupported",
        children: [],
        unsupportedReason: "unsupported_construct",
      } as ComputationNodeV1);
      unsupportedProgram.roots = [...unsupportedProgram.roots, unsupportedNodeId];
      // An `unsupported` node can never sit in a program that claims to be complete.
      unsupportedProgram.complete = false;
      unsupportedProgram.unsupportedReasons = ["unsupported_construct"];
      const unsupported = resealProgram(clone(complete), unsupportedProgram);
      expect(readComputationEvidence(unsupported)).toBeDefined();
      expect(isSubstantiveComputationEvidence(unsupported)).toBe(false);

      // A definition that is itself incomplete also blocks substantiveness.
      const incompleteDefinition = clone(complete.program);
      incompleteDefinition.definitions[0].complete = false;
      incompleteDefinition.definitions[0].unsupportedReasons = ["unsupported_mutable_capture"];
      const definitionEvidence = resealProgram(clone(complete), incompleteDefinition);
      expect(isSubstantiveComputationEvidence(definitionEvidence)).toBe(false);

      // An incomplete program with no reason code is internally inconsistent.
      const reasonlessProgram = clone(complete.program);
      reasonlessProgram.complete = false;
      expectProgramRejected(reasonlessProgram, "UNSUPPORTED_CONSISTENCY");
    });

    it("does not count print, bare file reads, json wrapping or identity as computation", () => {
      const printOnly: ProgramSpec = {
        roots: [
          {
            kind: "expression",
            output: { shape: "null" },
            children: [
              {
                kind: "call",
                api: "core.print",
                children: [{ kind: "identifier", symbol: "records" }],
              },
            ],
          },
        ],
      };
      const readAndParse: ProgramSpec = {
        slots: { path: { kind: "string", role: "path" } },
        roots: [
          {
            kind: "expression",
            output: { shape: "object" },
            children: [
              {
                kind: "call",
                api: "json.parse",
                children: [
                  {
                    kind: "call",
                    api: "fs.read_text",
                    children: [{ kind: "literal", slot: "path" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const writeOnly: ProgramSpec = {
        slots: { path: { kind: "string", role: "path" } },
        roots: [
          {
            kind: "expression",
            output: { shape: "null" },
            children: [
              {
                kind: "call",
                api: "fs.write_text",
                children: [
                  { kind: "literal", slot: "path" },
                  { kind: "identifier", symbol: "records" },
                ],
              },
            ],
          },
        ],
      };
      const identityCall: ProgramSpec = {
        roots: [
          {
            kind: "expression",
            output: { shape: "unknown" },
            children: [
              {
                kind: "call",
                api: "identity",
                children: [{ kind: "identifier", symbol: "records" }],
              },
            ],
          },
        ],
      };
      const declarationsOnly: ProgramSpec = {
        roots: [
          {
            kind: "declare",
            declKind: "const",
            symbol: "records",
            children: [{ kind: "identifier", symbol: "input_rows" }],
          },
        ],
      };
      for (const spec of [printOnly, readAndParse, writeOnly, identityCall, declarationsOnly]) {
        expect(ComputationProgramV1Schema.safeParse(buildProgram(spec)).success).toBe(true);
        expect(isSubstantiveComputationEvidence(buildEvidence(spec))).toBe(false);
      }
      // The transform vocabulary is exactly the structural minimum; plumbing APIs are excluded.
      expect(COMPUTATION_TRANSFORM_APIS).toContain("collection.group_by");
      expect(COMPUTATION_TRANSFORM_APIS).toContain("collection.reduce");
      expect(COMPUTATION_TRANSFORM_APIS).not.toContain("core.print");
      expect(COMPUTATION_TRANSFORM_APIS).not.toContain("fs.read_text");
      expect(COMPUTATION_TRANSFORM_APIS).not.toContain("json.parse");
      expect(COMPUTATION_TRANSFORM_APIS).not.toContain("identity");
    });

    it("accepts inline multi-statement compute without any authored definition", () => {
      const spec = validationSpec();
      const evidence = buildEvidence(spec);
      expect(evidence.program.definitions).toEqual([]);
      expect(evidence.program.symbols.every((symbol) => symbol.kind !== "definition")).toBe(true);
      expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
    });
  });

  describe("envelope digests, dependencies and idempotent reads", () => {
    it("is idempotent and re-verifies both digests", () => {
      const evidence = buildEvidence(pipelineSpec(), {
        dependencies: [
          {
            definitionId: "def0",
            programDigest: computeComputationProgramDigest(buildProgram(pipelineSpec())),
            sourceEventId: "evt_helper_1",
          },
        ],
        corrections: [{ supersedesDefinitionId: "def0", supersededProgramDigest: "a".repeat(64) }],
      });
      const first = readComputationEvidence(evidence);
      expect(first).toBeDefined();
      expect(first).toEqual(evidence);
      expect(readComputationEvidence(first)).toEqual(evidence);
      expect(ResinComputationEvidenceV1Schema.safeParse(evidence).success).toBe(true);

      const badProgramDigest = clone(evidence);
      badProgramDigest.programDigest = "b".repeat(64);
      expect(readComputationEvidence(badProgramDigest)).toBeUndefined();

      const badEvidenceId = clone(evidence);
      badEvidenceId.evidenceId = "c".repeat(64);
      expect(readComputationEvidence(badEvidenceId)).toBeUndefined();

      const badMetrics = clone(evidence);
      badMetrics.metrics.nodeCount = 1;
      expect(readComputationEvidence(badMetrics)).toBeUndefined();

      const badVersion = clone(evidence);
      (badVersion as unknown as { version: string }).version = "2.0.0";
      expect(readComputationEvidence(badVersion)).toBeUndefined();

      const badLanguage = clone(evidence);
      (badLanguage.program as unknown as { language: string }).language = "ruby";
      expect(readComputationEvidence(badLanguage)).toBeUndefined();

      const tamperedProgram = clone(evidence);
      const binary = tamperedProgram.program.nodes.find((node) => node.kind === "binary")!;
      (binary as { operator: string }).operator = "div";
      expect(readComputationEvidence(tamperedProgram)).toBeUndefined();
    });

    it("excludes provenance and literal payloads from the program digest but not the evidence digest", () => {
      const base = buildEvidence(pipelineSpec());
      const other = buildEvidence(pipelineSpec(), {
        origin: { kind: "heredoc", sourceEventId: "evt_source_9" },
        observation: {
          kind: "invocation",
          status: "success",
          callEventId: "evt_call_9",
          callId: "call_9",
          resultEventId: "evt_result_9",
        },
        metrics: {
          sourceLines: 40,
          sourceBytes: 800,
          nodeCount: base.program.nodes.length,
          symbolCount: base.program.symbols.length,
          slotCount: base.program.slots.length,
          definitionCount: base.program.definitions.length,
        },
      });
      expect(other.programDigest).toBe(base.programDigest);
      expect(other.evidenceId).not.toBe(base.evidenceId);

      // A literal carries no payload slot to vary: the wire format has nowhere to put a value. Slot
      // kind/role are bounded metadata and stay part of the identity, so a number-vs-string input
      // slot is genuinely a different program.
      const serialized = serializeComputationProgram(base.program);
      expect(serialized).toContain('"role":"field_key"');
      expect(serialized).not.toContain("amount");
      // Literal payloads have no wire representation at all: no field can carry a value.
      expect(serialized).not.toContain('"value"');
      expect(base.program.nodes.some((node) => "value" in node)).toBe(false);
      const rekindedSlot = buildEvidence({
        ...pipelineSpec(),
        slots: {
          amountKey: { kind: "string", role: "field_key" },
          factor: { kind: "string", role: "literal" },
        },
      });
      expect(rekindedSlot.programDigest).not.toBe(base.programDigest);
      expect(base.program.slots.map((slot) => [slot.kind, slot.role])).toEqual([
        ["string", "field_key"],
        ["number", "literal"],
      ]);
    });

    it("rejects duplicate, unmaterialized and over-limit dependencies and corrections", () => {
      const helperDigest = computeComputationProgramDigest(buildProgram(pipelineSpec()));
      expect(
        readComputationEvidence(
          buildEvidence(pipelineSpec(), {
            dependencies: [
              { definitionId: "def0", programDigest: helperDigest, sourceEventId: "evt_helper_1" },
              { definitionId: "def0", programDigest: helperDigest, sourceEventId: "evt_helper_2" },
            ],
          }),
        ),
      ).toBeUndefined();
      expect(
        readComputationEvidence(
          buildEvidence(pipelineSpec(), {
            dependencies: [
              { definitionId: "def7", programDigest: helperDigest, sourceEventId: "evt_helper_1" },
            ],
          }),
        ),
      ).toBeUndefined();
      expect(
        readComputationEvidence(
          buildEvidence(pipelineSpec(), {
            corrections: [
              { supersedesDefinitionId: "def0", supersededProgramDigest: "d".repeat(64) },
              { supersedesDefinitionId: "def0", supersededProgramDigest: "d".repeat(64) },
            ],
          }),
        ),
      ).toBeUndefined();
      expect(
        readComputationEvidence(
          buildEvidence(pipelineSpec(), {
            dependencies: Array.from(
              { length: COMPUTATION_IR_LIMITS.dependencies + 1 },
              (_, index) => ({
                definitionId: "def0",
                programDigest: helperDigest,
                sourceEventId: `evt_helper_${index}`,
              }),
            ),
          }),
        ),
      ).toBeUndefined();
    });

    it("hands off a versioned, analysis-only envelope under the metadata key", () => {
      const program = buildProgram(pipelineSpec());
      const evidence = buildEvidence(pipelineSpec());
      expect(COMPUTATION_IR_VERSION).toBe("1.0.0");
      expect(RESIN_COMPUTATION_EVIDENCE_KEY).toBe("resinComputationEvidenceV1");
      expect(program.version).toBe(COMPUTATION_IR_VERSION);
      expect(evidence.programDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.evidenceId).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.analysisOnly).toBe(true);
      expect(Object.keys(evidence)).not.toContain("source");
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("scaleRows");
      expect(serialized).not.toContain("amountKey");
      expect(serialized).not.toContain('"value"');
      // Symbols stay anonymous but keep their resolved def/use relationships.
      expect(evidence.program.symbols.map((symbol) => symbol.kind)).toContain("definition");
      expect(COMPUTATION_IR_LIMITS.nodes).toBe(512);
      expect(COMPUTATION_IR_LIMITS.symbols).toBe(256);
      expect(COMPUTATION_IR_LIMITS.slots).toBe(64);
      expect(COMPUTATION_IR_LIMITS.definitions).toBe(32);
      expect(COMPUTATION_IR_LIMITS.dependencies).toBe(64);
    });

    it("keeps program size linear for a shared-DAG shaped program", () => {
      const shared: NodeSpec = {
        kind: "binary",
        operator: "add",
        children: [
          { kind: "literal", constant: "one" },
          { kind: "literal", constant: "one" },
        ],
      };
      const wide: ProgramSpec = {
        roots: [
          {
            kind: "expression",
            output: { shape: "number" },
            children: [
              {
                kind: "array",
                children: Array.from({ length: 48 }, () => ({
                  ...shared,
                  children: [...shared.children!],
                })),
              },
            ],
          },
        ],
      };
      const program = buildProgram(wide);
      // Flat projection: the digest is one pass over the ordered node list, never a re-expansion of
      // shared sub-trees, so a wide shared-DAG program stays well inside the pinned node limit.
      expect(computeComputationProgramDigest(program)).toMatch(/^[a-f0-9]{64}$/);
      expect(program.nodes.length).toBe(1 + 1 + 48 * 3);
      expect(program.nodes.length).toBeLessThan(COMPUTATION_IR_LIMITS.nodes);
    });
  });

  describe("approved finite api vocabulary additions", () => {
    /**
     * The exact names approved for the native-algorithm capture phase. Some exist because a real
     * Python/JS construct needs a finite name (`str(x)`, `dict.setdefault`, `str.rsplit`, `clock.parse`,
     * `re.compile`/`pattern.test`, an explicitly read-only file handle, `csv.parse_records`); each is a
     * bounded canonical API, never an authority grant or a generic escape hatch.
     */
    const APPROVED_API_ADDITIONS = [
      "clock.parse",
      "collection.dict_setdefault",
      "collection.iterator",
      "collection.next",
      "collection.range",
      "core.to_string",
      "csv.parse_records",
      "fs.close",
      "fs.open_read",
      "fs.read_line",
      "fs.read_lines",
      "number.is_integer",
      "number.to_fixed",
      "string.isalpha",
      "string.lstrip",
      "string.rsplit",
      "string.rstrip",
      "text.regex_compile",
      "text.regex_test",
    ] as const;

    /** Minimal valid program whose only operation is one call to `api`. */
    const callSpec = (api: string): ProgramSpec => ({
      roots: [
        {
          kind: "expression",
          output: { shape: "unknown" },
          children: [{ kind: "call", api, children: [{ kind: "identifier", symbol: "value" }] }],
        },
      ],
    });

    it("accepts each approved addition in a canonical minimal program", () => {
      for (const api of APPROVED_API_ADDITIONS) {
        expect(COMPUTATION_APIS).toContain(api);
        expectCanonicalProgram(buildProgram(callSpec(api)));
      }
      // Every transform-classified name must exist in the canonical vocabulary: a name classified as
      // a transform without being admissible would silently never count as computation.
      for (const api of COMPUTATION_TRANSFORM_APIS) {
        expect(COMPUTATION_APIS).toContain(api);
      }
      expect(COMPUTATION_CONSTRUCT_APIS.every((api) => COMPUTATION_APIS.includes(api))).toBe(true);
    });

    it("rejects unlisted api names shaped like the approved additions", () => {
      for (const api of [
        "collection.iter_next",
        "csv.parse_rows",
        "fs.open_append",
        "fs.read_char",
        "number.to_precision",
        "string.capitalize",
        "text.regex_exec",
        "clock.format",
      ]) {
        const result = ComputationProgramV1Schema.safeParse(buildProgram(callSpec(api)));
        expect(result.success).toBe(false);
        // The rejected name is reported, so an unsupported call is never silently dropped.
        expect(JSON.stringify(result.error?.issues ?? [])).toContain(api);
      }
    });

    it("classifies the additions by their real operation, not by namespace", () => {
      // Genuine value transforms count as computation evidence: string reshaping (split/strip family),
      // numeric rounding, time parsing and dict-shaped retention.
      for (const api of [
        "clock.parse",
        "collection.dict_setdefault",
        "core.to_string",
        "number.to_fixed",
        "string.lstrip",
        "string.rsplit",
        "string.rstrip",
      ]) {
        expect(isSubstantiveComputationEvidence(buildEvidence(callSpec(api)))).toBe(true);
      }
      // Raw file I/O, iterator producers, regex CONSTRUCTION and boolean/record predicates are not
      // transforms: a read-only handle, an iterator, a compiled pattern or a yes/no test is an input or
      // a query (like `json.parse`, `fs.read_text`, `string.startswith` and `number.is_finite`), so
      // wrapping one is never the computation itself.
      for (const api of [
        "collection.iterator",
        "collection.next",
        "collection.range",
        "csv.parse_records",
        "fs.close",
        "fs.open_read",
        "fs.read_line",
        "fs.read_lines",
        "number.is_integer",
        "string.isalpha",
        "text.regex_compile",
        "text.regex_test",
      ]) {
        expect(isSubstantiveComputationEvidence(buildEvidence(callSpec(api)))).toBe(false);
      }
    });
  });
});
