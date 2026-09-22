import { parse } from "@babel/parser";

/**
 * Artifact module specifiers the runtime can provide without an artifact-local dependency tree.
 *
 * Keep this list deliberately small: the gateway and verifier both consume it as the compatibility
 * contract for source artifacts.
 */
export const SUPPORTED_ARTIFACT_IMPORTS = Object.freeze(["@resin/runtime"] as const);

const SUPPORTED_ARTIFACT_IMPORTS_RECORD: Readonly<Record<string, true>> = Object.fromEntries(
  SUPPORTED_ARTIFACT_IMPORTS.map((specifier) => [specifier, true]),
);
const MAX_REACHABLE_ARTIFACT_FILES = 1_000;
const SUPPORTED_ARTIFACT_SOURCE_EXTENSIONS: Readonly<Record<string, true>> = {
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".ts": true,
  ".tsx": true,
};

export interface InspectArtifactImportsInput {
  entrypoint: string;
  files: ReadonlyMap<string, string>;
}

export interface InspectArtifactImportsResult {
  passed: boolean;
  errors: string[];
}

interface NormalizedPathResult {
  path?: string;
  error?: string;
}

function normalizeBundlePath(rawPath: unknown, label: string): NormalizedPathResult {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { error: `${label} must be a non-empty bundle-relative path.` };
  }
  if (rawPath.includes("\0")) {
    return { error: `${label} '${rawPath}' contains a NUL byte.` };
  }
  if (rawPath.includes("\\")) {
    return {
      error: `${label} '${rawPath}' must use slash-separated bundle paths; backslashes are not allowed.`,
    };
  }
  if (rawPath.startsWith("/")) {
    return { error: `${label} '${rawPath}' must stay within the artifact root.` };
  }

  const segments: string[] = [];
  for (const segment of rawPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return { error: `${label} '${rawPath}' escapes the artifact root.` };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return { error: `${label} '${rawPath}' must identify a file inside the artifact root.` };
  }

  return { path: segments.join("/") };
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

type BabelNode = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBabelNode(value: unknown): value is BabelNode {
  return isRecord(value) && typeof value.type === "string";
}

function literalSpecifier(node: unknown): string | undefined {
  if (!isBabelNode(node)) return undefined;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type !== "TemplateLiteral" || !Array.isArray(node.expressions)) return undefined;
  if (node.expressions.length !== 0 || !Array.isArray(node.quasis) || node.quasis.length !== 1) {
    return undefined;
  }
  const quasi = node.quasis[0];
  if (!isBabelNode(quasi) || !isRecord(quasi.value)) return undefined;
  return typeof quasi.value.cooked === "string" ? quasi.value.cooked : undefined;
}

function sourceLocation(error: unknown): string {
  if (!isRecord(error) || !isRecord(error.loc)) return "";
  const line = error.loc.line;
  const column = error.loc.column;
  if (typeof line !== "number" || typeof column !== "number") return "";
  return ` at line ${line}, column ${column + 1}`;
}

function formatDiagnostic(fileName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to parse artifact file '${fileName}'${sourceLocation(error)}: ${message}`;
}

function getArtifactSourceExtension(bundlePath: string): string {
  const lastSlash = bundlePath.lastIndexOf("/");
  const lastDot = bundlePath.lastIndexOf(".");
  return lastDot > lastSlash ? bundlePath.slice(lastDot) : "";
}

function isSupportedArtifactSourcePath(bundlePath: string): boolean {
  return Boolean(SUPPORTED_ARTIFACT_SOURCE_EXTENSIONS[getArtifactSourceExtension(bundlePath)]);
}

function packageMetadataErrors(bundlePath: string, source: string): string[] {
  if (bundlePath !== "package.json" && !bundlePath.endsWith("/package.json")) return [];

  let metadata: unknown;
  try {
    metadata = JSON.parse(source);
  } catch (error) {
    return [
      `Failed to parse artifact package metadata '${bundlePath}': ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return [`Artifact package metadata '${bundlePath}' must be a JSON object.`];
  }

  const type = "type" in metadata ? metadata.type : undefined;
  if (type === "commonjs") {
    return [
      `Artifact package metadata '${bundlePath}' declares type 'commonjs'; CommonJS artifacts are unsupported.`,
    ];
  }
  if (type !== undefined && type !== "module") {
    return [`Artifact package metadata '${bundlePath}' has unsupported type '${String(type)}'.`];
  }
  return [];
}
function bindingContainsRequire(node: unknown): boolean {
  if (!isBabelNode(node)) return false;
  if (node.type === "Identifier") return node.name === "require";
  if (node.type === "AssignmentPattern" || node.type === "RestElement") {
    return bindingContainsRequire(node.left ?? node.argument);
  }
  if (node.type === "TSParameterProperty") return bindingContainsRequire(node.parameter);
  if (node.type === "ArrayPattern") {
    return Array.isArray(node.elements) && node.elements.some(bindingContainsRequire);
  }
  if (node.type === "ObjectPattern") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some((property) => {
        if (!isBabelNode(property)) return false;
        if (property.type === "RestElement") return bindingContainsRequire(property.argument);
        return property.type === "ObjectProperty" && bindingContainsRequire(property.value);
      })
    );
  }
  return false;
}

function declarationBindsRequire(node: unknown): boolean {
  if (!isBabelNode(node)) return false;
  if (node.type === "VariableDeclaration") {
    return (
      Array.isArray(node.declarations) &&
      node.declarations.some(
        (declaration) => isBabelNode(declaration) && bindingContainsRequire(declaration.id),
      )
    );
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return isBabelNode(node.id) && node.id.type === "Identifier" && node.id.name === "require";
  }
  if (node.type === "ImportDeclaration") {
    return (
      Array.isArray(node.specifiers) &&
      node.specifiers.some(
        (specifier) =>
          isBabelNode(specifier) &&
          isBabelNode(specifier.local) &&
          specifier.local.type === "Identifier" &&
          specifier.local.name === "require",
      )
    );
  }
  if (node.type === "TSImportEqualsDeclaration") {
    return isBabelNode(node.id) && node.id.type === "Identifier" && node.id.name === "require";
  }
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    return declarationBindsRequire(node.declaration);
  }
  return false;
}

function scopeBindsRequire(scope: BabelNode): boolean {
  if (
    scope.type === "FunctionDeclaration" ||
    scope.type === "FunctionExpression" ||
    scope.type === "ArrowFunctionExpression"
  ) {
    if (isBabelNode(scope.id) && scope.id.type === "Identifier" && scope.id.name === "require") {
      return true;
    }
    return (
      Array.isArray(scope.params) &&
      scope.params.some((parameter) => bindingContainsRequire(parameter))
    );
  }
  if (scope.type === "CatchClause") return bindingContainsRequire(scope.param);
  if (
    scope.type === "Program" ||
    scope.type === "BlockStatement" ||
    scope.type === "TSModuleBlock" ||
    scope.type === "StaticBlock"
  ) {
    return Array.isArray(scope.body) && scope.body.some(declarationBindsRequire);
  }
  return false;
}

function isRequireScope(node: BabelNode): boolean {
  return (
    node.type === "Program" ||
    node.type === "BlockStatement" ||
    node.type === "TSModuleBlock" ||
    node.type === "StaticBlock" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "CatchClause"
  );
}

/**
 * Inspects the reachable source graph of a bundle without reading from the host filesystem.
 *
 * The caller supplies the bundle-relative file map so path resolution cannot escape an artifact
 * root. Relative imports must name an exact supported source file in that map; supported bare
 * imports are leaves. Every other dependency shape is rejected before an execution host starts.
 */
export function inspectArtifactImports(
  input: InspectArtifactImportsInput,
): InspectArtifactImportsResult {
  const errors = new Set<string>();
  const files = new Map<string, string>();

  const addError = (error: string): void => {
    errors.add(error);
  };

  for (const [rawPath, source] of input.files) {
    const normalized = normalizeBundlePath(rawPath, "Artifact file path");
    if (!normalized.path) {
      addError(normalized.error ?? `Artifact file path '${String(rawPath)}' is invalid.`);
      continue;
    }
    if (files.has(normalized.path)) {
      addError(`Artifact contains duplicate file path '${normalized.path}'.`);
      continue;
    }
    if (typeof source !== "string") {
      addError(`Artifact file '${normalized.path}' must contain source text.`);
      continue;
    }
    files.set(normalized.path, source);
    for (const error of packageMetadataErrors(normalized.path, source)) addError(error);
  }

  const normalizedEntrypoint = normalizeBundlePath(input.entrypoint, "Artifact entrypoint");
  if (!normalizedEntrypoint.path) {
    addError(normalizedEntrypoint.error ?? "Artifact entrypoint is invalid.");
    return { passed: false, errors: [...errors].sort() };
  }

  if (!isSupportedArtifactSourcePath(normalizedEntrypoint.path)) {
    addError(
      `Artifact entrypoint '${normalizedEntrypoint.path}' must use a supported source extension (.ts, .tsx, .js, .jsx, or .mjs).`,
    );
    return { passed: false, errors: [...errors].sort() };
  }

  if (!files.has(normalizedEntrypoint.path)) {
    addError(`Artifact entrypoint '${normalizedEntrypoint.path}' is missing from the artifact.`);
    return { passed: false, errors: [...errors].sort() };
  }

  const queuedFiles: string[] = [normalizedEntrypoint.path];
  const visitedFiles = new Set<string>();

  const inspectSpecifier = (fromFile: string, specifier: string): void => {
    if (
      specifier.startsWith("/") ||
      specifier.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(specifier)
    ) {
      addError(`Import '${specifier}' from '${fromFile}' escapes the artifact root.`);
      return;
    }
    if (specifier.length === 0) {
      addError(`Empty import specifier in artifact file '${fromFile}'.`);
      return;
    }

    if (isRelativeSpecifier(specifier)) {
      if (/[?#%]/.test(specifier) || specifier.includes("\\") || specifier.includes("\0")) {
        addError(
          `Relative import '${specifier}' from '${fromFile}' uses unsupported URL syntax or an invalid path; exact bundle-relative source paths are required.`,
        );
        return;
      }

      const baseDirectory = fromFile.includes("/")
        ? fromFile.slice(0, fromFile.lastIndexOf("/"))
        : "";
      const joinedPath = baseDirectory ? `${baseDirectory}/${specifier}` : specifier;
      const normalizedTarget = normalizeBundlePath(
        joinedPath,
        `Relative import '${specifier}' from '${fromFile}'`,
      );
      if (!normalizedTarget.path) {
        addError(
          normalizedTarget.error ?? `Relative import '${specifier}' from '${fromFile}' is invalid.`,
        );
        return;
      }

      const target = normalizedTarget.path;
      if (!isSupportedArtifactSourcePath(target)) {
        addError(
          `Relative import '${specifier}' from '${fromFile}' targets unsupported non-code file '${target}'. Only source files with .ts, .tsx, .js, .jsx, or .mjs extensions are supported.`,
        );
        return;
      }
      if (!files.has(target)) {
        addError(
          `Relative import '${specifier}' from '${fromFile}' is missing from the artifact (resolved path '${target}').`,
        );
        return;
      }
      if (!visitedFiles.has(target) && !queuedFiles.includes(target)) queuedFiles.push(target);
      return;
    }

    if (!SUPPORTED_ARTIFACT_IMPORTS_RECORD[specifier]) {
      addError(
        `Unsupported artifact import '${specifier}' in '${fromFile}'. Only '@resin/runtime' is supported.`,
      );
    }
  };

  while (queuedFiles.length > 0) {
    const currentFile = queuedFiles.shift();
    if (!currentFile || visitedFiles.has(currentFile)) continue;
    if (visitedFiles.size >= MAX_REACHABLE_ARTIFACT_FILES) {
      addError(
        `Artifact import graph exceeds the maximum of ${MAX_REACHABLE_ARTIFACT_FILES} reachable files.`,
      );
      break;
    }
    visitedFiles.add(currentFile);

    const source = files.get(currentFile);
    if (source === undefined) {
      addError(`Artifact import graph references missing file '${currentFile}'.`);
      continue;
    }

    const parserPlugins: Array<"jsx" | "typescript"> = currentFile.endsWith(".tsx")
      ? ["typescript", "jsx"]
      : currentFile.endsWith(".jsx")
        ? ["jsx"]
        : currentFile.endsWith(".ts")
          ? ["typescript"]
          : [];

    let sourceFile: { program: unknown };
    try {
      sourceFile = parse(source, {
        sourceType: "module",
        sourceFilename: currentFile,
        plugins: parserPlugins,
        createImportExpressions: true,
      });
    } catch (error) {
      addError(formatDiagnostic(currentFile, error));
      continue;
    }

    const visit = (node: unknown, scopeStack: readonly boolean[]): void => {
      if (!isBabelNode(node)) return;
      const nextScopeStack = isRequireScope(node)
        ? [...scopeStack, scopeBindsRequire(node)]
        : scopeStack;

      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        const specifier = literalSpecifier(node.source);
        if (specifier !== undefined) inspectSpecifier(currentFile, specifier);
      }

      if (node.type === "TSImportType") {
        const specifier = literalSpecifier(node.argument);
        if (specifier !== undefined) inspectSpecifier(currentFile, specifier);
      }

      if (node.type === "TSImportEqualsDeclaration") {
        addError(
          `TypeScript import-equals declaration in '${currentFile}' is unsupported; use static ESM imports.`,
        );
      }

      if (node.type === "ImportExpression") {
        const specifier = literalSpecifier(node.source);
        if (specifier === undefined) {
          addError(
            `Non-literal dynamic import in '${currentFile}' is unsupported; use a string literal import specifier.`,
          );
        } else {
          inspectSpecifier(currentFile, specifier);
        }
      }

      if (
        node.type === "CallExpression" &&
        isBabelNode(node.callee) &&
        node.callee.type === "Import"
      ) {
        const argument = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
        const specifier = literalSpecifier(argument);
        if (specifier === undefined) {
          addError(
            `Non-literal dynamic import in '${currentFile}' is unsupported; use a string literal import specifier.`,
          );
        } else {
          inspectSpecifier(currentFile, specifier);
        }
      }

      if (
        node.type === "CallExpression" &&
        isBabelNode(node.callee) &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        !nextScopeStack.some(Boolean)
      ) {
        addError(`CommonJS require() in '${currentFile}' is unsupported; use static ESM imports.`);
      }

      for (const [key, value] of Object.entries(node)) {
        if (
          key === "loc" ||
          key === "start" ||
          key === "end" ||
          key === "extra" ||
          key === "comments" ||
          key === "tokens"
        ) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const child of value) visit(child, nextScopeStack);
        } else {
          visit(value, nextScopeStack);
        }
      }
    };

    visit(sourceFile.program, []);
  }

  return {
    passed: errors.size === 0,
    errors: [...errors].sort(),
  };
}
