import { createRequire } from "node:module";
import type { parse as babelParse } from "@babel/parser";

type Parse = typeof babelParse;
let cachedParse: Parse | undefined;

/** Keep the optional code-mode parser out of the standalone installer helper bundle. */
function parseCode(source: string) {
  if (cachedParse === undefined) {
    const parser = createRequire(import.meta.url)("@babel/parser") as { parse: Parse };
    cachedParse = parser.parse;
  }
  return cachedParse(source, { sourceType: "script", allowAwaitOutsideFunction: true });
}

export interface SingleCommandOutput {
  cmd: string;
  workdir?: string;
}

/**
 * Only the audited two-statement expression is eligible; this does not execute JavaScript. With
 * `shellOptions`, a literal `shell` name and `login` flag are accepted too: they choose the shell
 * the command runs in (which only the native command item then proves), not what the cell prints.
 */
export function extractSingleCommandOutput(
  source: string,
  { shellOptions = false }: { shellOptions?: boolean } = {},
): SingleCommandOutput | undefined {
  if (source.length > 32_768) return undefined;
  try {
    const ast = parseCode(source);
    const [declaration, print] = ast.program.body;
    if (
      ast.program.body.length !== 2 ||
      declaration?.type !== "VariableDeclaration" ||
      !["const", "let"].includes(declaration.kind) ||
      declaration.declarations.length !== 1 ||
      print?.type !== "ExpressionStatement"
    )
      return undefined;
    const binding = declaration.declarations[0];
    if (binding.id.type !== "Identifier" || binding.init?.type !== "AwaitExpression")
      return undefined;
    const invocation = binding.init.argument;
    if (
      invocation.type !== "CallExpression" ||
      invocation.arguments.length !== 1 ||
      invocation.callee.type !== "MemberExpression" ||
      invocation.callee.computed ||
      invocation.callee.object.type !== "Identifier" ||
      invocation.callee.object.name !== "tools" ||
      invocation.callee.property.type !== "Identifier" ||
      invocation.callee.property.name !== "exec_command"
    )
      return undefined;
    const options = invocation.arguments[0];
    if (options.type !== "ObjectExpression") return undefined;
    let cmd: string | undefined;
    let workdir: string | undefined;
    const seen = new Set<string>();
    for (const property of options.properties) {
      if (property.type !== "ObjectProperty" || property.computed || property.shorthand)
        return undefined;
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "StringLiteral"
            ? property.key.value
            : undefined;
      if (!key || seen.has(key)) return undefined;
      seen.add(key);
      if (key === "cmd" || key === "workdir") {
        if (property.value.type !== "StringLiteral") return undefined;
        if (key === "cmd") cmd = property.value.value;
        else workdir = property.value.value;
      } else if (key === "yield_time_ms" || key === "max_output_tokens") {
        if (
          property.value.type !== "NumericLiteral" ||
          !Number.isSafeInteger(property.value.value) ||
          property.value.value < 0
        )
          return undefined;
      } else if (shellOptions && key === "shell") {
        if (property.value.type !== "StringLiteral") return undefined;
      } else if (shellOptions && key === "login") {
        if (property.value.type !== "BooleanLiteral") return undefined;
      } else return undefined;
    }
    if (cmd === undefined) return undefined;
    const expression = print.expression;
    if (
      expression.type !== "CallExpression" ||
      expression.arguments.length !== 1 ||
      expression.callee.type !== "Identifier" ||
      expression.callee.name !== "text"
    )
      return undefined;
    const printed = expression.arguments[0];
    if (
      printed.type !== "MemberExpression" ||
      printed.computed ||
      printed.object.type !== "Identifier" ||
      printed.object.name !== binding.id.name ||
      printed.property.type !== "Identifier" ||
      printed.property.name !== "output"
    )
      return undefined;
    return workdir === undefined ? { cmd } : { cmd, workdir };
  } catch {
    return undefined;
  }
}

/**
 * A cell whose only effect is one `tools.apply_patch` call with literal patch text, optionally
 * printed: `text(await tools.apply_patch("…"))`. Its effect is recorded by the native `FileChange`
 * items it produces, so the cell itself is not the replayable call.
 */
export function isApplyPatchOnlyCell(source: string): boolean {
  if (source.length > 1_048_576) return false;
  try {
    const body = parseCode(source).program.body;
    const [statement] = body;
    if (body.length !== 1 || statement?.type !== "ExpressionStatement") return false;
    let awaited = statement.expression;
    if (
      awaited.type === "CallExpression" &&
      awaited.callee.type === "Identifier" &&
      awaited.callee.name === "text" &&
      awaited.arguments.length === 1 &&
      awaited.arguments[0]!.type === "AwaitExpression"
    ) {
      awaited = awaited.arguments[0];
    }
    if (awaited.type !== "AwaitExpression") return false;
    const call = awaited.argument;
    if (
      call.type !== "CallExpression" ||
      call.arguments.length !== 1 ||
      call.callee.type !== "MemberExpression" ||
      call.callee.computed ||
      call.callee.object.type !== "Identifier" ||
      call.callee.object.name !== "tools" ||
      call.callee.property.type !== "Identifier" ||
      call.callee.property.name !== "apply_patch"
    )
      return false;
    const patch = call.arguments[0]!;
    return (
      patch.type === "StringLiteral" ||
      (patch.type === "TemplateLiteral" && patch.expressions.length === 0)
    );
  } catch {
    return false;
  }
}

/** An unsupported cell is unsafe unless its entire AST proves a synchronous, non-command form. */
export function hasUnresolvedCodeModeEffects(source: string): boolean {
  if (source.length > 32_768) return true;
  try {
    const body = parseCode(source).program.body;
    if (body.length === 1 && body[0]?.type === "ExpressionStatement") {
      const call = body[0].expression;
      if (
        call.type === "CallExpression" &&
        call.callee.type === "Identifier" &&
        call.callee.name === "text" &&
        call.arguments.length === 1 &&
        call.arguments[0].type === "StringLiteral"
      )
        return false;
    }
    if (
      body.length !== 2 ||
      body[0]?.type !== "VariableDeclaration" ||
      body[0].kind !== "const" ||
      body[0].declarations.length !== 1 ||
      body[1]?.type !== "ExpressionStatement"
    )
      return true;
    const binding = body[0].declarations[0];
    if (binding.id.type !== "Identifier" || binding.init?.type !== "StringLiteral") return true;
    const print = body[1].expression;
    if (
      print.type !== "CallExpression" ||
      print.callee.type !== "Identifier" ||
      print.callee.name !== "text" ||
      print.arguments.length !== 1
    )
      return true;
    const awaited = print.arguments[0];
    if (awaited.type !== "AwaitExpression" || awaited.argument.type !== "CallExpression")
      return true;
    const patch = awaited.argument;
    if (
      patch.arguments.length !== 1 ||
      patch.arguments[0].type !== "Identifier" ||
      patch.arguments[0].name !== binding.id.name ||
      patch.callee.type !== "MemberExpression" ||
      patch.callee.computed ||
      patch.callee.object.type !== "Identifier" ||
      patch.callee.object.name !== "tools" ||
      patch.callee.property.type !== "Identifier" ||
      patch.callee.property.name !== "apply_patch"
    )
      return true;
    return false;
  } catch {
    return true;
  }
}

type AstNode = { type: string; [key: string]: unknown };

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function isNamed(node: unknown, name: string): boolean {
  return isAstNode(node) && node.type === "Identifier" && node.name === name;
}

/** `<object>.<property>` with a plain, non-computed property name. */
function memberName(node: unknown): { object: unknown; property: string } | undefined {
  if (!isAstNode(node) || node.type !== "MemberExpression" || node.computed) return undefined;
  const property = node.property;
  return isAstNode(property) && property.type === "Identifier"
    ? { object: node.object, property: property.name as string }
    : undefined;
}

const PURE_CALLBACK_METHODS: Record<string, true> = {
  filter: true,
  map: true,
  forEach: true,
  some: true,
  every: true,
  find: true,
};
const PURE_METHODS: Record<string, true> = {
  ...PURE_CALLBACK_METHODS,
  join: true,
  slice: true,
  includes: true,
  startsWith: true,
  endsWith: true,
  trim: true,
  toLowerCase: true,
  toUpperCase: true,
  test: true,
};

function mentionsTools(node: AstNode): boolean {
  if (node.type === "Identifier" && node.name === "tools") return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
    if (Array.isArray(value)) {
      if (value.some((child) => isAstNode(child) && mentionsTools(child))) return true;
    } else if (isAstNode(value) && mentionsTools(value)) return true;
  }
  return false;
}

function containsType(node: AstNode, type: string): boolean {
  if (node.type === type) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
    if (Array.isArray(value)) {
      if (value.some((child) => isAstNode(child) && containsType(child, type))) return true;
    } else if (isAstNode(value) && containsType(value, type)) return true;
  }
  return false;
}

/**
 * A cell whose every command call has settled once the cell reports `Script completed`, so none of
 * its commands can start afterwards. Each `tools.<name>(…)` call must be awaited directly, be an
 * element of the array literal a directly awaited settlement receives, or be the whole body of a
 * synchronous arrow passed to `<array>.map` whose result a directly awaited settlement receives.
 * A settlement is `Promise.allSettled(…)`, or `Promise.all(…)` in a cell without `try`: an uncaught
 * rejection fails the cell, so `Script completed` means every element fulfilled. The only other
 * functions allowed are such `map`/`forEach` callbacks on a `const` bound to an array literal or to
 * that awaited settlement, and synchronous callbacks that never mention `tools` passed to a pure
 * array method (`ALL_TOOLS.filter(t => …)`): with no `tools` reference, even a deferred callback
 * cannot start a command. Nothing can defer, alias `tools`, or construct objects, and the only calls
 * are `text`, `String`, `tools.*`, settlements, `Promise.resolve`, callback-free
 * `JSON.stringify`/`JSON.parse`, and the pure methods below. Anything else is not proven.
 */
export function settlesBeforeCompletion(source: string): boolean {
  if (source.length > 32_768) return false;
  let program: AstNode;
  try {
    program = parseCode(source).program as unknown as AstNode;
  } catch {
    return false;
  }
  // `try` can swallow a `Promise.all` rejection while its other commands still run.
  const catches = containsType(program, "TryStatement");
  const arrays = new Set<string>();
  const settled = new Set<string>();
  const constants = new Set<string>();
  for (const statement of program.body as AstNode[]) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declarator of statement.declarations as AstNode[]) {
      const id = declarator.id;
      if (!isAstNode(id) || id.type !== "Identifier") continue;
      const name = id.name as string;
      if (constants.has(name)) return false;
      constants.add(name);
      const init = declarator.init;
      if (isAstNode(init) && init.type === "ArrayExpression") arrays.add(name);
      if (isAstNode(init) && init.type === "AwaitExpression" && isSettlement(init.argument))
        settled.add(name);
    }
  }
  function isSettlement(node: unknown): boolean {
    if (
      !isAstNode(node) ||
      node.type !== "CallExpression" ||
      (node.arguments as unknown[]).length !== 1
    )
      return false;
    const callee = memberName(node.callee);
    return (
      (callee?.property === "allSettled" || (callee?.property === "all" && !catches)) &&
      isNamed(callee.object, "Promise")
    );
  }
  const isCallbackReceiver = (node: unknown, method: string): boolean =>
    (isAstNode(node) && node.type === "ArrayExpression") ||
    (isAstNode(node) &&
      node.type === "Identifier" &&
      (arrays.has(node.name as string) ||
        (method === "forEach" && settled.has(node.name as string))));
  /** A synchronous array callback: `<array>.map(arrow)` or `<array>.forEach(arrow)`. */
  const isArrayCallback = (arrow: AstNode, parent: AstNode | undefined): boolean => {
    if (arrow.async || arrow.generator || parent?.type !== "CallExpression") return false;
    const args = parent.arguments as unknown[];
    const callee = memberName(parent.callee);
    return (
      args.length === 1 &&
      args[0] === arrow &&
      callee !== undefined &&
      (callee.property === "map" || callee.property === "forEach") &&
      isCallbackReceiver(callee.object, callee.property)
    );
  };
  /** A synchronous callback without any `tools` reference, passed alone to a pure array method. */
  const isPureCallback = (arrow: AstNode, parent: AstNode | undefined): boolean => {
    if (arrow.async || arrow.generator || parent?.type !== "CallExpression") return false;
    const args = parent.arguments as unknown[];
    const callee = memberName(parent.callee);
    return (
      args.length === 1 &&
      args[0] === arrow &&
      callee !== undefined &&
      Object.hasOwn(PURE_CALLBACK_METHODS, callee.property) &&
      !mentionsTools(arrow)
    );
  };
  let proven = true;
  const visit = (node: AstNode, parents: AstNode[]): void => {
    if (!proven) return;
    const parent = parents[parents.length - 1];
    switch (node.type) {
      case "ArrowFunctionExpression":
        if (!isArrayCallback(node, parent) && !isPureCallback(node, parent)) proven = false;
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ObjectMethod":
      case "ClassDeclaration":
      case "ClassExpression":
      case "NewExpression":
      case "TaggedTemplateExpression":
      case "Import":
      case "ImportExpression":
      case "YieldExpression":
      case "OptionalCallExpression":
      case "OptionalMemberExpression":
        proven = false;
        break;
      case "AssignmentExpression":
      case "UpdateExpression": {
        const target = node.type === "AssignmentExpression" ? node.left : node.argument;
        if (
          !isAstNode(target) ||
          target.type !== "Identifier" ||
          constants.has(target.name as string)
        )
          proven = false;
        break;
      }
      case "Identifier": {
        if (node.name !== "tools") break;
        const member = parent !== undefined ? memberName(parent) : undefined;
        const call = parents[parents.length - 2];
        if (
          member === undefined ||
          parent!.object !== node ||
          call?.type !== "CallExpression" ||
          call.callee !== parent
        ) {
          // `tools` is only ever the object of a direct call; property keys are not references.
          if (
            !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
          )
            if (!(parent?.type === "ObjectProperty" && parent.key === node && !parent.computed))
              proven = false;
          break;
        }
        const holder = parents[parents.length - 3];
        if (holder?.type === "AwaitExpression" && holder.argument === call) break;
        // `await Promise.all([tools.x(…), …])`: an element of the settled array literal.
        const elementSettlement = parents[parents.length - 4];
        const elementAwaited = parents[parents.length - 5];
        if (
          holder?.type === "ArrayExpression" &&
          (holder.elements as unknown[]).includes(call) &&
          elementSettlement !== undefined &&
          isSettlement(elementSettlement) &&
          (elementSettlement.arguments as unknown[])[0] === holder &&
          elementAwaited?.type === "AwaitExpression" &&
          elementAwaited.argument === elementSettlement
        )
          break;
        // `<array>.map(cmd => tools.x(…))`, settled by a directly awaited settlement.
        const mapCall = parents[parents.length - 4];
        const settlement = parents[parents.length - 5];
        const awaited = parents[parents.length - 6];
        if (
          holder?.type === "ArrowFunctionExpression" &&
          holder.body === call &&
          memberName(mapCall?.callee)?.property === "map" &&
          settlement !== undefined &&
          isSettlement(settlement) &&
          (settlement.arguments as unknown[])[0] === mapCall &&
          awaited?.type === "AwaitExpression" &&
          awaited.argument === settlement
        )
          break;
        proven = false;
        break;
      }
      case "CallExpression": {
        const callee = node.callee;
        if (isNamed(callee, "text") || isNamed(callee, "String")) break;
        const member = memberName(callee);
        if (member !== undefined && isNamed(member.object, "tools")) break;
        if (isSettlement(node)) break;
        // `Promise.resolve(value)` starts nothing; its argument is checked like any other.
        if (member?.property === "resolve" && isNamed(member.object, "Promise")) break;
        // `JSON.stringify(result)` / `JSON.parse(text)` without a reviver or replacer callback.
        if (
          member !== undefined &&
          isNamed(member.object, "JSON") &&
          (member.property === "stringify" || member.property === "parse") &&
          (node.arguments as AstNode[]).every((arg) => arg.type !== "ArrowFunctionExpression")
        )
          break;
        if (member !== undefined && Object.hasOwn(PURE_METHODS, member.property)) {
          const args = node.arguments as AstNode[];
          if (
            args.every((arg) => arg.type !== "ArrowFunctionExpression") ||
            (Object.hasOwn(PURE_CALLBACK_METHODS, member.property) &&
              args.length === 1 &&
              args[0]!.type === "ArrowFunctionExpression")
          )
            break;
        }
        proven = false;
        break;
      }
    }
    if (!proven) return;
    const next = [...parents, node];
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isAstNode(child)) visit(child, next);
      } else if (isAstNode(value)) visit(value, next);
    }
  };
  visit(program, []);
  return proven;
}

/** Every `tools.<name>` member and whether `ALL_TOOLS` is read (not a property key) in a cell. */
function harnessReferences(
  node: AstNode,
  found: { tools: string[]; toolList: boolean },
  parent?: AstNode,
): void {
  if (
    node.type === "Identifier" &&
    node.name === "ALL_TOOLS" &&
    !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed) &&
    !(parent?.type === "ObjectProperty" && parent.key === node && !parent.computed)
  )
    found.toolList = true;
  const member = memberName(node);
  if (member !== undefined && isNamed(member.object, "tools")) found.tools.push(member.property);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) harnessReferences(child, found, node);
    } else if (isAstNode(value)) harnessReferences(value, found, node);
  }
}

/**
 * A cell that is transport, not a step: it reads the harness's tool list (`ALL_TOOLS`) and/or runs
 * `tools.exec_command`, and does nothing else a replay could repeat. Codex records every command
 * such a cell runs as its own native `CommandExecution` item, and those items are the calls; the
 * cell only printed what they and the tool list returned. Every command must settle before the
 * cell completes (`settlesBeforeCompletion`), and any other `tools.*` call (an MCP tool,
 * `apply_patch`, `write_stdin`, …) has effects no native command item records, so it is not
 * transport. A cell that touches neither the tool list nor a command (pure JavaScript) is not
 * transport either: its source is the computation.
 */
export function isNativeCommandCarrierCell(source: string): boolean {
  if (!settlesBeforeCompletion(source)) return false;
  let program: AstNode;
  try {
    program = parseCode(source).program as unknown as AstNode;
  } catch {
    return false;
  }
  const found = { tools: [] as string[], toolList: false };
  harnessReferences(program, found);
  if (found.tools.some((name) => name !== "exec_command")) return false;
  return found.tools.length > 0 || found.toolList;
}
