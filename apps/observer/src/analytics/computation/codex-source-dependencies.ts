import vm from "node:vm";
import ts from "typescript";

// Match the standalone runner's fresh VM global namespace, not this Node process's globals.
// The runner deliberately overrides console with undefined and installs the text result channel.
const ISOLATED_GLOBALS: ReadonlySet<string> = (() => {
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox.console = undefined;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const names = vm.runInContext("Object.getOwnPropertyNames(globalThis)", context) as string[];
  return new Set([...names.filter((name) => name !== "console"), "text"]);
})();

function isRead(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier)
  )
    return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return !("name" in parent && parent.name === identifier);
}

/** Check lexical reads with TypeScript's binder, without resolving files or host ambient types. */
export function isClosedCodexSource(source: string): boolean {
  const filename = "/isolated-codex-source.js";
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  };
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === filename ? file : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => name === filename,
    readFile: (name) => (name === filename ? source : undefined),
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([filename], options, host);
  if (program.getSyntacticDiagnostics(file).length > 0) return false;
  const checker = program.getTypeChecker();
  let closed = true;
  const isSourceBinding = (symbol: ts.Symbol | undefined): boolean =>
    symbol?.declarations?.some((declaration) => declaration.getSourceFile() === file) === true;
  const isExternalGlobalThis = (node: ts.Expression): boolean =>
    ts.isIdentifier(node) &&
    node.text === "globalThis" &&
    !isSourceBinding(checker.getSymbolAtLocation(node));
  const visit = (node: ts.Node): void => {
    if (!closed) return;
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      ts.isMetaProperty(node) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      closed = false;
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        isExternalGlobalThis(node.expression) &&
        !ISOLATED_GLOBALS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        isExternalGlobalThis(node.expression) &&
        (!ts.isStringLiteral(node.argumentExpression) ||
          !ISOLATED_GLOBALS.has(node.argumentExpression.text)))
    ) {
      closed = false;
      return;
    }
    if (ts.isIdentifier(node) && isRead(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (!isSourceBinding(symbol) && !ISOLATED_GLOBALS.has(node.text)) {
        closed = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return closed;
}
