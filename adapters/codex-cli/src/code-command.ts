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

/** Only the audited two-statement expression is eligible; this does not execute JavaScript. */
export function extractSingleCommandOutput(source: string): SingleCommandOutput | undefined {
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
