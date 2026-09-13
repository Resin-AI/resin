import {
  type ComputationLanguage,
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationProgramDigest,
  serializeComputationProgram,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  buildComputationProgram,
  buildComputationProgramWithKeyMap,
  draftField,
  draftLiteral,
  draftNode,
} from "../../../src/analytics/computation/builder.js";
import {
  type DraftDefinition,
  type DraftNode,
  type DraftSymbol,
  MODULE_SCOPE_KEY,
} from "../../../src/analytics/computation/types.js";

const CANARY_LITERAL = "CANARY_LITERAL_VALUE_9f31";
const CANARY_SYMBOL = "CANARY_SYMBOL_NAME_2c58";

function symbol(
  key: string,
  kind: DraftSymbol["kind"] = "local",
  scope: string = MODULE_SCOPE_KEY,
): DraftSymbol {
  return { key, kind, scope };
}

/** Every built program must satisfy the shipped strict wire contract. */
function expectValid(program: ComputationProgramV1): void {
  const parsed = ComputationProgramV1Schema.safeParse(program);
  expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 5) ?? [])).toBe(true);
  for (const [index, node] of program.nodes.entries()) {
    expect(node.id).toBe(`n${index}`);
  }
  for (const [index, item] of program.symbols.entries()) {
    expect(item.id).toBe(`sym${index}`);
  }
  for (const [index, slot] of program.slots.entries()) {
    expect(slot.id).toBe(`slot${index}`);
  }
  for (const [index, definition] of program.definitions.entries()) {
    expect(definition.id).toBe(`def${index}`);
    expect(definition.scope).toBe(`scope${index + 1}`);
  }
}

/**
 * `def stable(value): return value.map(item => stable(item))`
 *
 * The recursive read happens inside an inline callback, so the definition's closure must still record
 * itself: an indirect call is recursion, not a lost reference.
 */
function recursiveCallbackProgram(): {
  program: ComputationProgramV1;
  definition: DraftDefinition;
} {
  const defSym = symbol("stable", "definition");
  const valueParam = symbol("stable.value", "parameter", "stable");
  const callbackParam = symbol("stable.callback.item", "parameter", "stable.callback");
  const callbackSym = symbol("stable.callback", "local", "stable");

  const callback = draftNode(
    "lambda",
    [
      draftNode("parameters", [draftNode("parameter", [], { symbol: callbackParam })]),
      draftNode("expression", [
        draftNode("call", [draftNode("identifier", [], { symbol: callbackParam })], {
          symbol: defSym,
        }),
      ]),
    ],
    { symbol: callbackSym, scope: "stable.callback" },
  );

  const body = draftNode("block", [
    draftNode("return", [
      draftNode("call", [draftNode("identifier", [], { symbol: valueParam })], {
        api: "collection.map",
        receiver: callback,
      }),
    ]),
  ]);

  const callable = draftNode(
    "function",
    [draftNode("parameters", [draftNode("parameter", [], { symbol: valueParam })]), body],
    { symbol: defSym, scope: "stable", defKind: "function" },
  );

  const definition: DraftDefinition = {
    key: "stable",
    kind: "function",
    nameSymbol: defSym,
    parameters: [valueParam],
    body: callable,
    dependencies: [],
    scope: "stable",
    complete: true,
    unsupportedReasons: [],
  };

  return {
    program: buildComputationProgram({
      language: "python",
      roots: [callable],
      definitions: [definition],
    }),
    definition,
  };
}

describe("buildComputationProgram", () => {
  it("emits the canonical positional form and passes the strict wire contract", () => {
    const { program } = recursiveCallbackProgram();
    expectValid(program);
    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(program.roots).toEqual(["n0"]);
    expect(program.definitions).toHaveLength(1);
  });

  it("materializes recursion that only occurs inside an inline callback", () => {
    const { program } = recursiveCallbackProgram();
    const [definition] = program.definitions;
    expect(definition?.id).toBe("def0");
    expect(definition?.recursive).toBe(true);
    expect(definition?.dependencies).toContain(definition?.nameSymbol);
    expect(definition?.parameters).toHaveLength(1);
    // The inline callback owns a nested scope after the definition scopes.
    const nested = program.nodes.filter(
      (node) =>
        (node.kind === "function" || node.kind === "lambda") && node.id !== definition?.body,
    );
    expect(nested).toHaveLength(1);
    expect(nested[0]?.kind === "lambda" ? nested[0].scope : undefined).toBe("scope2");
  });

  it("is deterministic and drives the contract digest", () => {
    const first = recursiveCallbackProgram().program;
    const second = recursiveCallbackProgram().program;
    expect(serializeComputationProgram(first)).toBe(serializeComputationProgram(second));
    expect(computeComputationProgramDigest(first)).toBe(computeComputationProgramDigest(second));
    expect(computeComputationProgramDigest(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the digest invariant under private renaming but sensitive to operators", () => {
    const build = (name: string, operator: string): ComputationProgramV1 => {
      const param = symbol(`${name}.left`, "parameter", name);
      const callable = draftNode(
        "function",
        [
          draftNode("parameters", [draftNode("parameter", [], { symbol: param })]),
          draftNode("block", [
            draftNode("return", [
              draftNode(
                "binary",
                [draftNode("identifier", [], { symbol: param }), draftLiteral(2, `${name}.seed`)],
                { operator },
              ),
            ]),
          ]),
        ],
        { symbol: symbol(name, "definition"), scope: name },
      );
      return buildComputationProgram({
        language: "python",
        roots: [callable],
        definitions: [
          {
            key: name,
            kind: "function",
            nameSymbol: symbol(name, "definition"),
            parameters: [param],
            body: callable,
            scope: name,
            complete: true,
            unsupportedReasons: [],
          },
        ],
      });
    };

    const renamed = build("alpha", "mul");
    const other = build("beta", "mul");
    expect(computeComputationProgramDigest(renamed)).toBe(computeComputationProgramDigest(other));

    const differentOperator = build("alpha", "add");
    expect(computeComputationProgramDigest(differentOperator)).not.toBe(
      computeComputationProgramDigest(renamed),
    );
  });

  it("aliases repeated literal keys to one slot and keeps distinct payloads distinct", () => {
    const buildShared = (keys: readonly string[]): ComputationProgramV1 => {
      const param = symbol("p", "parameter", "f");
      const callable = draftNode(
        "function",
        [
          draftNode("parameters", [draftNode("parameter", [], { symbol: param })]),
          draftNode("block", [
            draftNode("return", [
              draftNode(
                "array",
                keys.map((key, index) => draftLiteral(index === 0 ? 7 : 9, key)),
              ),
            ]),
          ]),
        ],
        { symbol: symbol("f", "definition"), scope: "f" },
      );
      return buildComputationProgram({
        language: "python",
        roots: [callable],
        definitions: [
          {
            key: "f",
            kind: "function",
            nameSymbol: symbol("f", "definition"),
            parameters: [param],
            body: callable,
            scope: "f",
            complete: true,
            unsupportedReasons: [],
          },
        ],
      });
    };

    const aliased = buildShared(["shared", "shared"]);
    expectValid(aliased);
    expect(aliased.slots).toHaveLength(1);
    const literals = aliased.nodes.filter((node) => node.kind === "literal");
    expect(literals).toHaveLength(2);
    expect(literals[0]?.kind === "literal" ? literals[0].slot : undefined).toBe(
      literals[1]?.kind === "literal" ? literals[1].slot : undefined,
    );

    const distinct = buildShared(["left", "right"]);
    expectValid(distinct);
    expect(distinct.slots).toHaveLength(2);
    expect(computeComputationProgramDigest(distinct)).not.toBe(
      computeComputationProgramDigest(aliased),
    );
  });

  it("keeps payloads, private names and unsafe field keys off the wire", () => {
    const defSym = symbol(CANARY_SYMBOL, "definition");
    const unsafeSnake = "user_api_key";
    const unsafeCaps = "API_KEY";
    // Both spellings are secret-like: the snake form is caught by the contract's segment predicate,
    // the ALL-CAPS form by the normalized whole-key check beside it.
    const body = draftNode("block", [
      draftNode("return", [
        draftNode(
          "member",
          [draftNode("member", [draftLiteral(0, "seed")], draftField(unsafeCaps, unsafeCaps))],
          draftField(unsafeSnake, unsafeSnake),
        ),
      ]),
    ]);
    const callable = draftNode("function", [draftNode("parameters", []), body], {
      symbol: defSym,
      scope: defSym.key,
    });
    const program = buildComputationProgram({
      language: "javascript",
      roots: [callable, draftLiteral(CANARY_LITERAL, CANARY_LITERAL)],
      definitions: [
        {
          key: defSym.key,
          kind: "function",
          nameSymbol: defSym,
          parameters: [],
          body: callable,
          scope: defSym.key,
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });

    expectValid(program);
    const serialized = serializeComputationProgram(program);
    expect(serialized).not.toContain(CANARY_LITERAL);
    expect(serialized).not.toContain(CANARY_SYMBOL);
    expect(serialized).not.toContain(unsafeSnake);
    expect(serialized).not.toContain(unsafeCaps);
    expect(program.slots.map((slot) => slot.role).sort()).toEqual([
      "field_key",
      "field_key",
      "literal",
    ]);
  });

  it("keeps an unreachable definition out of the program and reports its unresolved read", () => {
    const helperSym = symbol("helper", "definition");
    const helperCallable = draftNode(
      "function",
      [
        draftNode("parameters", []),
        draftNode("block", [draftNode("return", [draftLiteral(1, "one")])]),
      ],
      { symbol: helperSym, scope: "helper" },
    );
    const caller = draftNode("expression", [draftNode("call", [], { symbol: helperSym })]);

    const dropped = buildComputationProgram({
      language: "python",
      roots: [draftNode("expression", [draftLiteral(1, "one")])],
      definitions: [
        {
          key: "helper",
          kind: "function",
          nameSymbol: helperSym,
          parameters: [],
          body: helperCallable,
          scope: "helper",
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });
    expectValid(dropped);
    expect(dropped.definitions).toHaveLength(0);
    expect(dropped.complete).toBe(true);

    const unresolved = buildComputationProgram({
      language: "python",
      roots: [caller],
      definitions: [
        {
          key: "helper",
          kind: "function",
          nameSymbol: helperSym,
          parameters: [],
          body: helperCallable,
          scope: "helper",
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });
    expectValid(unresolved);
    expect(unresolved.complete).toBe(false);
    expect(unresolved.unsupportedReasons).toContain("unsupported_mutable_capture");
    expect(unresolved.nodes.some((node) => node.kind === "unsupported")).toBe(true);
  });

  it("describes the canonical def/use closure of mutually recursive helpers", () => {
    const nameA = symbol("walk_a", "definition");
    const nameB = symbol("walk_b", "definition");
    const paramA = symbol("walk_a.records", "parameter", "walk_a");
    const paramB = symbol("walk_b.records", "parameter", "walk_b");

    const callable = (
      name: string,
      own: DraftSymbol,
      param: DraftSymbol,
      other: DraftSymbol,
    ): DraftNode =>
      draftNode(
        "function",
        [
          draftNode("parameters", [draftNode("parameter", [], { symbol: param })]),
          draftNode("block", [
            draftNode("return", [
              draftNode("call", [draftNode("identifier", [], { symbol: param })], {
                symbol: other,
              }),
            ]),
          ]),
        ],
        { symbol: own, scope: name },
      );

    const bodyA = callable("walk_a", nameA, paramA, nameB);
    const bodyB = callable("walk_b", nameB, paramB, nameA);
    const program = buildComputationProgram({
      language: "python",
      roots: [bodyA, bodyB],
      definitions: [
        {
          key: "walk_a",
          kind: "function",
          nameSymbol: nameA,
          parameters: [paramA],
          body: bodyA,
          scope: "walk_a",
          complete: true,
          unsupportedReasons: [],
        },
        {
          key: "walk_b",
          kind: "function",
          nameSymbol: nameB,
          parameters: [paramB],
          body: bodyB,
          scope: "walk_b",
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });

    expectValid(program);
    expect(program.definitions).toHaveLength(2);
    for (const definition of program.definitions) {
      expect(definition.recursive).toBe(true);
      expect(definition.dependencies).toHaveLength(1);
    }
    expect(program.definitions[0]?.dependencies).toEqual([program.definitions[1]?.nameSymbol]);
    expect(program.definitions[1]?.dependencies).toEqual([program.definitions[0]?.nameSymbol]);
  });

  it("reports an unresolved definition symbol as unsupported instead of fabricating a helper", () => {
    const defSym = symbol("missing_helper", "definition");
    const program = buildComputationProgram({
      language: "javascript",
      roots: [draftNode("expression", [draftNode("call", [], { symbol: defSym })])],
      definitions: [
        {
          key: defSym.key,
          kind: "function",
          nameSymbol: defSym,
          parameters: [],
          body: draftNode("function", [
            draftNode("parameters", []),
            draftNode("block", [draftNode("return", [draftLiteral(1, "one")])]),
          ]),
          scope: defSym.key,
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });
    expectValid(program);
    expect(program.complete).toBe(false);
    expect(program.nodes.some((node) => node.kind === "unsupported")).toBe(true);
  });

  it("fails closed on an unknown language without throwing", () => {
    const program = buildComputationProgram({
      // SAFETY: the runtime guard for an unsupported language is exactly what this case exercises.
      language: "ruby" as unknown as ComputationLanguage,
      roots: [draftNode("block", [])],
    });
    expectValid(program);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toEqual(["unsupported_language"]);
  });

  it("degrades a call that names neither an API nor a resolved helper", () => {
    const program = buildComputationProgram({
      language: "python",
      roots: [draftNode("expression", [draftNode("call", [], {})])],
    });
    expectValid(program);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_api");
  });

  it("degrades an unknown API instead of emitting it", () => {
    const program = buildComputationProgram({
      language: "python",
      roots: [
        draftNode("expression", [
          draftNode("call", [draftLiteral(1, "one")], { api: "totally.unknown" }),
        ]),
      ],
    });
    expectValid(program);
    expect(program.unsupportedReasons).toContain("unsupported_api");
  });

  it("bounds a shared draft node rather than emitting a shared wire node", () => {
    const shared = draftNode("block", [draftLiteral(1, "one")]);
    const program = buildComputationProgram({
      language: "python",
      roots: [draftNode("block", [shared]), draftNode("block", [shared])],
    });
    expectValid(program);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_construct");
  });

  it("fails closed at the nesting limit without exceeding the node budget", () => {
    let nested = draftNode("block", [draftLiteral(1, "one")]);
    for (let index = 0; index < 70; index++) {
      nested = draftNode("block", [nested]);
    }
    const program = buildComputationProgram({ language: "python", roots: [nested] });
    expectValid(program);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("limit_depth");
    expect(program.nodes.length).toBeLessThanOrEqual(512);
  });

  it("exposes the materialized definition key for each wire definition", () => {
    const defSym = symbol("only", "definition");
    const callable = draftNode(
      "function",
      [
        draftNode("parameters", []),
        draftNode("block", [draftNode("return", [draftLiteral(1, "one")])]),
      ],
      { symbol: defSym, scope: "only" },
    );
    const draft = buildComputationProgramWithKeyMap({
      language: "python",
      roots: [callable],
      definitions: [
        {
          key: "only",
          kind: "function",
          nameSymbol: defSym,
          parameters: [],
          body: callable,
          scope: "only",
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });
    expect(draft.definitionKeys).toEqual(["only"]);
    expect(draft.program.definitions).toHaveLength(1);
    expectValid(draft.program);
  });

  it("marks an incomplete definition incomplete on the wire with a reason", () => {
    const defSym = symbol("partial", "definition");
    const callable = draftNode(
      "function",
      [
        draftNode("parameters", []),
        draftNode("block", [draftNode("return", [draftLiteral(1, "one")])]),
      ],
      { symbol: defSym, scope: "partial" },
    );
    const program = buildComputationProgram({
      language: "python",
      roots: [callable],
      definitions: [
        {
          key: "partial",
          kind: "function",
          nameSymbol: defSym,
          parameters: [],
          body: callable,
          scope: "partial",
          complete: false,
          unsupportedReasons: ["unsupported_api"],
        },
      ],
    });
    expectValid(program);
    expect(program.definitions[0]?.complete).toBe(false);
    expect(program.definitions[0]?.unsupportedReasons).toEqual(["unsupported_api"]);
    expect(program.complete).toBe(false);
  });

  it("emits comparison, boolean and safe structural field shapes", () => {
    const defSym = symbol("classify", "definition");
    const recordParam = symbol("classify.record", "parameter", "classify");
    const body = draftNode("block", [
      draftNode("return", [
        draftNode(
          "boolean",
          [
            draftNode(
              "compare",
              [
                draftNode("member", [draftNode("identifier", [], { symbol: recordParam })], {
                  field: "score",
                }),
                draftLiteral(0, "seed"),
              ],
              { operators: ["gt"] },
            ),
            draftNode("call", [draftNode("identifier", [], { symbol: recordParam })], {
              api: "type.is_array",
            }),
          ],
          { operators: ["or"] },
        ),
      ]),
    ]);
    const callable = draftNode(
      "function",
      [draftNode("parameters", [draftNode("parameter", [], { symbol: recordParam })]), body],
      { symbol: defSym, scope: "classify" },
    );
    const program = buildComputationProgram({
      language: "javascript",
      roots: [callable],
      definitions: [
        {
          key: "classify",
          kind: "function",
          nameSymbol: defSym,
          parameters: [recordParam],
          body: callable,
          scope: "classify",
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });

    expectValid(program);
    expect(program.complete).toBe(true);
    const comparison = program.nodes.find((node) => node.kind === "compare");
    expect(comparison?.kind === "compare" ? comparison.operators : undefined).toEqual(["gt"]);
    const boolean = program.nodes.find((node) => node.kind === "boolean");
    expect(boolean?.kind === "boolean" ? boolean.operators : undefined).toEqual(["or"]);
    const member = program.nodes.find((node) => node.kind === "member");
    expect(member?.kind === "member" ? member.field : undefined).toBe("score");
  });

  it("binds a loop target and an assignment target as local declaration sites", () => {
    const defSym = symbol("count_rows", "definition");
    const rowsParam = symbol("count_rows.rows", "parameter", "count_rows");
    const rowSym = symbol("count_rows.row", "local", "count_rows");
    const countSym = symbol("count_rows.count", "local", "count_rows");
    const body = draftNode("block", [
      draftNode("declare", [draftLiteral(0, "zero")], { symbol: countSym, declKind: "local" }),
      draftNode("for", [
        draftNode("identifier", [], { symbol: rowSym }),
        draftNode("identifier", [], { symbol: rowsParam }),
        draftNode("block", [
          draftNode("assign", [
            draftNode("identifier", [], { symbol: countSym }),
            draftNode(
              "binary",
              [draftNode("identifier", [], { symbol: countSym }), draftLiteral(1, "one")],
              { operator: "add" },
            ),
          ]),
        ]),
      ]),
      draftNode("return", [draftNode("identifier", [], { symbol: countSym })]),
    ]);
    const callable = draftNode(
      "function",
      [draftNode("parameters", [draftNode("parameter", [], { symbol: rowsParam })]), body],
      { symbol: defSym, scope: "count_rows" },
    );
    const program = buildComputationProgram({
      language: "javascript",
      roots: [callable],
      definitions: [
        {
          key: "count_rows",
          kind: "function",
          nameSymbol: defSym,
          parameters: [rowsParam],
          body: callable,
          scope: "count_rows",
          complete: true,
          unsupportedReasons: [],
        },
      ],
    });

    expectValid(program);
    expect(program.complete).toBe(true);
    expect(program.nodes.some((node) => node.kind === "for")).toBe(true);
    // The loop variable has no `declare` node: the target identifier is its declaration site.
    const loopTarget = program.nodes.find((node) => node.kind === "for");
    const targetId = loopTarget?.kind === "for" ? loopTarget.children[0] : undefined;
    const target = program.nodes.find((node) => node.id === targetId);
    expect(target?.kind).toBe("identifier");
    const targetSymbol = target?.kind === "identifier" ? target.symbol : undefined;
    const declared = program.symbols.find((item) => item.id === targetSymbol);
    expect(declared?.kind).toBe("local");
    expect(declared?.node).toBe(targetId);
  });

  it("keeps the node budget and reports the limit instead of a silent prefix", () => {
    const many = draftNode(
      "block",
      Array.from({ length: 600 }, (_unused, index) => draftLiteral(1, `literal-${index}`)),
    );
    const program = buildComputationProgram({ language: "python", roots: [many] });
    expectValid(program);
    expect(program.nodes.length).toBeLessThanOrEqual(512);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("limit_nodes");
  });

  it("maps ordered outputs onto their return node and definition", () => {
    const defSym = symbol("emit", "definition");
    const returnNode = draftNode("return", [draftLiteral(1, "one")]);
    const blockNode = draftNode("block", [returnNode]);
    const callable = draftNode("function", [draftNode("parameters", []), blockNode], {
      symbol: defSym,
      scope: "emit",
    });
    const program = buildComputationProgram({
      language: "python",
      roots: [callable],
      definitions: [
        {
          key: "emit",
          kind: "function",
          nameSymbol: defSym,
          parameters: [],
          body: callable,
          scope: "emit",
          complete: true,
          unsupportedReasons: [],
        },
      ],
      outputs: [
        { node: returnNode, shape: "array", definitionKey: "emit" },
        // A block is not an output node, so no output shape is invented for it.
        { node: blockNode, shape: "object" },
      ],
    });

    expectValid(program);
    expect(program.outputs).toHaveLength(1);
    expect(program.outputs[0]?.shape).toBe("array");
    expect(program.outputs[0]?.definitionId).toBe("def0");
    const emitted = program.nodes.find((node) => node.id === program.outputs[0]?.node);
    expect(emitted?.kind).toBe("return");
  });
});
