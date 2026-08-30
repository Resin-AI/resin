import {
  type CapabilityManifest,
  CommandCapabilitySchema,
  FsCapabilitySchema,
  NetCapabilitySchema,
  SecretCapabilitySchema,
  type ToolManifest,
} from "@resin/contracts";
import ts from "typescript";
import type {
  StaticAnalysisFinding,
  StaticAnalysisResult,
  StaticAnalyzerOptions,
} from "./types.js";

/**
 * Standard allowlist of import module specifiers.
 */
const DEFAULT_ALLOWED_IMPORT_SPECIFIERS = {
  "@resin/runtime": true,
  zod: true,
  "node:path": true,
  path: true,
  "node:crypto": true,
  crypto: true,
  "node:util": true,
  util: true,
  "node:buffer": true,
  buffer: true,
} as const;

/**
 * Patterns for forbidden imports.
 */
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /^node:fs(\/.*)?$/,
  /^fs(\/.*)?$/,
  /^node:child_process(\/.*)?$/,
  /^child_process(\/.*)?$/,
  /^node:net(\/.*)?$/,
  /^net(\/.*)?$/,
  /^node:http(\/.*)?$/,
  /^http(\/.*)?$/,
  /^node:https(\/.*)?$/,
  /^https(\/.*)?$/,
  /^node:tls(\/.*)?$/,
  /^tls(\/.*)?$/,
  /^node:dns(\/.*)?$/,
  /^dns(\/.*)?$/,
  /^node:cluster(\/.*)?$/,
  /^cluster(\/.*)?$/,
  /^node:worker_threads(\/.*)?$/,
  /^worker_threads(\/.*)?$/,
  /^node:v8(\/.*)?$/,
  /^v8(\/.*)?$/,
  /^node:vm(\/.*)?$/,
  /^vm(\/.*)?$/,
  /^node:dgram(\/.*)?$/,
  /^dgram(\/.*)?$/,
  /^node:readline(\/.*)?$/,
  /^readline(\/.*)?$/,
  /^node:repl(\/.*)?$/,
  /^repl(\/.*)?$/,
  /^node:inspector(\/.*)?$/,
  /^inspector(\/.*)?$/,
  /^node:os(\/.*)?$/,
  /^os(\/.*)?$/,
  /^node:process(\/.*)?$/,
  /^process(\/.*)?$/,
];

/**
 * Supported runtimes for tools.
 */
const SUPPORTED_RUNTIMES = {
  deno: true,
  "deno-sandboxed": true,
  node: true,
  "node-vm": true,
} as const;

export interface SourceLocation {
  line: number;
  column: number;
}

/**
 * AST-level static analyzer for candidate tool source code.
 */
export function staticAnalyzeCandidate(
  sourceCode: string,
  manifest?: ToolManifest,
  options: StaticAnalyzerOptions = {},
): StaticAnalysisResult {
  const findings: StaticAnalysisFinding[] = [];
  const detectedImports: string[] = [];
  let hasDynamicImports = false;
  let hasRawHostApis = false;

  const allowedImports: Readonly<Record<string, boolean>> = options.allowedImports
    ? Object.fromEntries(options.allowedImports.map((i) => [i, true as const]))
    : DEFAULT_ALLOWED_IMPORT_SPECIFIERS;

  // Track inferred broker usage
  const inferredCapabilities: Partial<CapabilityManifest> = {};

  const sourceFile = ts.createSourceFile("candidate.ts", sourceCode, ts.ScriptTarget.Latest, true);

  function getLineCol(node: ts.Node): SourceLocation {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: pos.line + 1, column: pos.character + 1 };
  }

  function addFinding(
    severity: StaticAnalysisFinding["severity"],
    category: StaticAnalysisFinding["category"],
    message: string,
    node: ts.Node,
    fixHint?: string,
  ) {
    const { line, column } = getLineCol(node);
    findings.push({
      severity,
      category,
      message,
      line,
      column,
      nodeText: node.getText(sourceFile).slice(0, 100),
      fixHint,
    });
  }

  function checkImportSpecifier(specifier: string, node: ts.Node) {
    detectedImports.push(specifier);

    // Check relative path escape
    if (specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith("./")) {
      addFinding(
        "error",
        "relative_path_escape",
        `Relative import '${specifier}' escapes tool root or references external filesystem.`,
        node,
        "Bundle all helper logic within the tool file or standard packages.",
      );
      return;
    }

    // Check forbidden imports
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(specifier)) {
        addFinding(
          "error",
          "forbidden_import",
          `Forbidden host module import '${specifier}'. Worker sandbox isolates direct host I/O.`,
          node,
          "Use context.broker for mediated access.",
        );
        return;
      }
    }

    // Check allowlist
    if (!allowedImports[specifier]) {
      addFinding(
        "error",
        "nondeterministic_dependency",
        `Unauthorized import dependency '${specifier}'. Only pinned SDK packages are permitted.`,
        node,
        "Remove unauthorized dependency.",
      );
    }
  }

  function visit(node: ts.Node) {
    // 1. Static Import Declarations
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        checkImportSpecifier(node.moduleSpecifier.text, node);
      }
    }

    // 2. Export Declarations with module specifier
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        checkImportSpecifier(node.moduleSpecifier.text, node);
      }
    }

    // 3. Dynamic Import Calls
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      hasDynamicImports = true;
      addFinding(
        "error",
        "dynamic_import_escape",
        "Dynamic import() is forbidden in tool candidates to prevent sandbox escapes.",
        node,
        "Use top-level static imports from allowed modules.",
      );
    }

    // 4. Eval and Function Constructor Calls
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      if (exprText === "eval") {
        hasDynamicImports = true;
        addFinding(
          "error",
          "dynamic_import_escape",
          "Direct eval() execution is strictly forbidden.",
          node,
          "Use direct typed computations.",
        );
      } else if (exprText === "Function" || exprText === "new Function") {
        hasDynamicImports = true;
        addFinding(
          "error",
          "dynamic_import_escape",
          "Function constructor code generation is strictly forbidden.",
          node,
          "Use standard function declarations.",
        );
      } else if (exprText === "fetch") {
        hasRawHostApis = true;
        addFinding(
          "error",
          "forbidden_api",
          "Global fetch() without broker mediation is forbidden.",
          node,
          "Use context.broker.net.fetch() for audited network access.",
        );
      }
    }

    // 5. New Expression (e.g. new Function, new Worker, new WebSocket)
    if (ts.isNewExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      if (exprText === "Function") {
        hasDynamicImports = true;
        addFinding(
          "error",
          "dynamic_import_escape",
          "Function constructor is strictly forbidden.",
          node,
        );
      } else if (
        exprText === "Worker" ||
        exprText === "SharedWorker" ||
        exprText === "WebSocket" ||
        exprText === "XMLHttpRequest"
      ) {
        hasRawHostApis = true;
        addFinding(
          "error",
          "forbidden_api",
          `Raw host API 'new ${exprText}' is forbidden in sandbox.`,
          node,
        );
      }
    }

    // 6. Global Escape & Process/Deno inspection
    if (ts.isIdentifier(node)) {
      const idText = node.text;
      // Ensure it's not a property name in an object literal or declaration
      const parent = node.parent;
      const isPropAccess = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;

      if (!isPropAccess && !isDeclaration) {
        if (idText === "Deno") {
          hasRawHostApis = true;
          addFinding(
            "error",
            "forbidden_api",
            "Direct access to 'Deno' global host runtime is forbidden.",
            node,
            "Use context.broker for mediated access.",
          );
        } else if (idText === "process") {
          hasRawHostApis = true;
          addFinding(
            "error",
            "forbidden_api",
            "Direct access to 'process' host runtime is forbidden.",
            node,
            "Use context.broker for mediated access.",
          );
        }
      }
    }

    // 7. Property Access for globalThis, window, global, or context.brokers
    if (ts.isPropertyAccessExpression(node)) {
      const fullText = node.getText(sourceFile);

      // Global property escapes
      if (
        fullText.startsWith("globalThis.") ||
        fullText.startsWith("window.") ||
        fullText.startsWith("global.")
      ) {
        const propName = node.name.text;
        if (
          propName === "process" ||
          propName === "Deno" ||
          propName === "eval" ||
          propName === "Function" ||
          propName === "fetch"
        ) {
          hasRawHostApis = true;
          addFinding(
            "error",
            "forbidden_api",
            `Global object escape via '${fullText}' is forbidden.`,
            node,
          );
        }
      }
      if (/(?:context\.)?brokers?(?:\.|\?\.)fs/.test(fullText)) {
        inferredCapabilities.fs = FsCapabilitySchema.parse({
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          maxFileSizeBytes: 10 * 1024 * 1024,
        });
      }
      if (/(?:context\.)?brokers?(?:\.|\?\.)(?:cmd|command)/.test(fullText)) {
        inferredCapabilities.command = CommandCapabilitySchema.parse({
          allowedCommands: [],
          allowedBinaries: [],
          allowShellExecution: false,
        });
      }
      if (/(?:context\.)?brokers?(?:\.|\?\.)(?:net|network)/.test(fullText)) {
        inferredCapabilities.net = NetCapabilitySchema.parse({
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowLocalhost: false,
          allowOutbound: true,
        });
      }
      if (/(?:context\.)?brokers?(?:\.|\?\.)(?:secret|secrets)/.test(fullText)) {
        inferredCapabilities.secrets = SecretCapabilitySchema.parse({
          allowedSecretNames: [],
        });
      }
    }

    // 8. Element Access Escape (e.g. globalThis["eval"] or this["process"])
    if (ts.isElementAccessExpression(node)) {
      const objText = node.expression.getText(sourceFile);
      const argText = node.argumentExpression.getText(sourceFile).replace(/['"]/g, "");
      if (
        (objText === "globalThis" ||
          objText === "window" ||
          objText === "global" ||
          objText === "this") &&
        (argText === "eval" ||
          argText === "Function" ||
          argText === "process" ||
          argText === "Deno")
      ) {
        hasDynamicImports = true;
        addFinding(
          "error",
          "dynamic_import_escape",
          `Element access escape '${objText}["${argText}"]' is forbidden.`,
          node,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (manifest) {
    const declaredCaps: Partial<CapabilityManifest> = manifest.capabilities ?? {};
    if (inferredCapabilities.fs && !declaredCaps.fs) {
      findings.push({
        severity: "error",
        category: "undeclared_capability",
        message:
          "Tool source references context.broker.fs but manifest does not declare 'fs' capability.",
        fixHint: "Declare required filesystem capability in manifest.",
      });
    }

    if (inferredCapabilities.command && !declaredCaps.command) {
      findings.push({
        severity: "error",
        category: "undeclared_capability",
        message:
          "Tool source references context.broker.cmd but manifest does not declare 'cmd' capability.",
        fixHint: "Declare required command capability in manifest.",
      });
    }

    if (inferredCapabilities.net && !declaredCaps.net) {
      findings.push({
        severity: "error",
        category: "undeclared_capability",
        message:
          "Tool source references context.broker.net but manifest does not declare 'net' capability.",
        fixHint: "Declare required network capability in manifest.",
      });
    }

    if (inferredCapabilities.secrets) {
      const hasSecretsCapability =
        declaredCaps.secrets &&
        ((declaredCaps.secrets.allowedSecretNames?.length ?? 0) > 0 ||
          (declaredCaps.secrets.allowedPrefixes?.length ?? 0) > 0);
      if (!hasSecretsCapability) {
        findings.push({
          severity: "error",
          category: "undeclared_capability",
          message:
            "Tool source references context.broker.secrets but manifest does not allowlist any secret names or prefixes.",
          fixHint: "Declare required secret names or prefixes in manifest capabilities.",
        });
      }
    }

    const runtime = manifest.runtime?.runtime;
    if (runtime && !(runtime in SUPPORTED_RUNTIMES)) {
      findings.push({
        severity: "error",
        category: "unsupported_runtime",
        message: `Manifest specifies unsupported runtime '${runtime}'. Supported runtimes: deno, deno-sandboxed, node.`,
        fixHint: "Set manifest runtime to 'deno'.",
      });
    }
  }

  const hasErrors = findings.some((f) => f.severity === "error");

  return {
    passed: !hasErrors,
    findings,
    inferredCapabilities,
    detectedImports,
    hasDynamicImports,
    hasRawHostApis,
  };
}

/**
 * Pinned AST static analyzer instance.
 */
export class CandidateStaticAnalyzer {
  constructor(private readonly defaultOptions: StaticAnalyzerOptions = {}) {}

  analyze(
    sourceCode: string,
    manifest?: ToolManifest,
    options?: StaticAnalyzerOptions,
  ): StaticAnalysisResult {
    return staticAnalyzeCandidate(sourceCode, manifest, {
      ...this.defaultOptions,
      ...options,
    });
  }
}
