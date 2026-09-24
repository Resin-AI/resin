/**
 * Running a recorded program through the family of runtime its record names.
 *
 * A recorded program is evidence about one execution: the text that ran and the way it was handed
 * to the system. Reuse therefore means running that text again the same way — a shell program keeps
 * its operators, pipes, redirections and exit status, a language program reaches its interpreter
 * through the recorded transport (argv for ordinary runs; stdin for bounded Python composites and
 * JavaScript Eval) —
 * and never re-quoting, tokenizing or otherwise reconstructing it. The recorded `argv` stays evidence
 * and is never executed.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { parse } from "@babel/parser";
import {
  MAX_WORKFLOW_PYTHON_REPLAY_BYTES,
  MAX_WORKFLOW_PYTHON_SOURCE_BYTES,
  type WorkflowJsonValue,
  type WorkflowRecordedProgram,
  validateWorkflowProgramSourceInterface,
  validateWorkflowPythonState,
} from "@resin/contracts";
import type { RecordedCallRequest } from "./recorded-workflow.js";
import { RESIN_PROGRAM_LANGUAGES } from "./runtime-families.js";

export interface RecordedProgramRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw stdout for ordinary programs, rendered text for Eval, or authored content for Codex exec. */
  value: WorkflowJsonValue;
}

export interface ProgramRunnerOptions {
  /** Directory the program runs in. Defaults to the process cwd. */
  cwd?: string;
  /** Hard wall-clock bound; the child is killed and the run fails when exceeded. */
  timeoutMs?: number;
  /** Cap on captured stdout or source-interface-specific authored output bytes. */
  maxOutputBytes?: number;
  /** Extra environment; PATH is always inherited. */
  env?: Record<string, string>;
  /**
   * Hand the program ONLY the environment it was given, never the process's own.
   *
   * A replay is not the daemon: a recorded program has no business reading the operator's
   * credentials, tokens or proxy configuration out of the environment, and inheriting them would
   * make a validation run as powerful as the daemon itself. PATH is always provided, because a
   * program text naming an interpreter needs one to be found.
   */
  isolateEnvironment?: boolean;
  /** Resolves private Python setup-cell source in the owning workspace. */
  resolvePrivate?: (
    reference: string,
    access?: { workspaceId?: string },
  ) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  /** Workspace scope forwarded to the private setup resolver. */
  access?: { workspaceId?: string };
  /** Overridable for tests. */
  platform?: NodeJS.Platform;
}

/** Long enough for a real build or install, short enough that a hung program cannot pin a run. */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
/** Share of the byte budget kept from the start of a stream; the rest is kept from the end. */
const HEAD_SHARE = 0.5;
/** Bounded PATH probe: enough directories for a normal host, never an unbounded filesystem walk. */
const MAX_PATH_ENTRIES = 256;
/** Fixed Python transport driver; composite replay source travels over stdin, not argv. */
const PYTHON_STDIN_DRIVER =
  "import sys\nexec(compile(sys.stdin.read(), '<resin-python>', 'exec'), {'__name__': '__main__'})";

/** JavaScript Eval result and observed console output travel over stdin and inherited fd 3. */
const JAVASCRIPT_EVAL_STDIN_DRIVER = [
  "const __resin_fs = require('node:fs');",
  "const __resin_util = require('node:util');",
  "const __resin_payload = JSON.parse(__resin_fs.readFileSync(0, 'utf8'));",
  "const __resin_write = __resin_fs.writeSync.bind(__resin_fs);",
  "let __resin_channelBytes = 0;",
  "let __resin_outputBytes = 0;",
  "let __resin_stderrKind = 'e';",
  "function __resin_emit(event) {",
  "  const frame = JSON.stringify(event) + '\\n';",
  "  const bytes = Buffer.byteLength(frame, 'utf8');",
  "  if (__resin_channelBytes + bytes > __resin_payload.maxEventBytes) {",
  "    throw new Error('JavaScript Eval replay result channel exceeded its byte bound');",
  "  }",
  "  __resin_write(3, frame, __resin_channelBytes, 'utf8');",
  "  __resin_channelBytes += bytes;",
  "}",
  "function __resin_recordWrite(kind, chunk, encoding) {",
  "  const data = Buffer.isBuffer(chunk)",
  "    ? chunk",
  "    : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');",
  "  if (data.length === 0) return;",
  "  const prefixBytes = kind === 'e' ? 8 : kind === 'w' ? 7 : 0;",
  "  __resin_outputBytes += prefixBytes + data.length;",
  "  if (__resin_outputBytes > __resin_payload.maxOutputBytes) {",
  "    throw new Error('JavaScript Eval replay output exceeded its byte bound');",
  "  }",
  "  __resin_emit({ k: kind, v: data.toString('utf8') });",
  "}",
  "const __resin_stdoutWrite = process.stdout.write.bind(process.stdout);",
  "const __resin_stderrWrite = process.stderr.write.bind(process.stderr);",
  "process.stdout.write = function(chunk, encoding, callback) {",
  "  __resin_recordWrite('o', chunk, encoding);",
  "  return __resin_stdoutWrite(chunk, encoding, callback);",
  "};",
  "process.stderr.write = function(chunk, encoding, callback) {",
  "  __resin_recordWrite(__resin_stderrKind, chunk, encoding);",
  "  return __resin_stderrWrite(chunk, encoding, callback);",
  "};",
  "function __resin_consoleText(args) {",
  "  return args.map((value) => typeof value === 'string'",
  "    ? value",
  "    : __resin_util.inspect(value, { depth: 6, colors: false, breakLength: 120 })).join(' ');",
  "}",
  "function __resin_consoleWrite(stream, kind, args) {",
  "  let text = __resin_consoleText(args);",
  "  if (!text.endsWith('\\n')) text += '\\n';",
  "  if (stream === 'o') {",
  "    process.stdout.write(text);",
  "    return;",
  "  }",
  "  const previousKind = __resin_stderrKind;",
  "  __resin_stderrKind = kind;",
  "  try {",
  "    process.stderr.write(text);",
  "  } finally {",
  "    __resin_stderrKind = previousKind;",
  "  }",
  "}",
  "globalThis.console.log = (...args) => { __resin_consoleWrite('o', 'o', args); };",
  "globalThis.console.info = (...args) => { __resin_consoleWrite('o', 'o', args); };",
  "globalThis.console.debug = (...args) => { __resin_consoleWrite('o', 'o', args); };",
  "globalThis.console.error = (...args) => { __resin_consoleWrite('e', 'e', args); };",
  "globalThis.console.warn = (...args) => { __resin_consoleWrite('e', 'w', args); };",
  "function __resin_display(value) {",
  "  if (value === undefined) return { h: false, v: '' };",
  "  if (value === null || typeof value !== 'object') {",
  "    return { h: true, v: String(value) };",
  "  }",
  "  let cloned;",
  "  try {",
  "    cloned = structuredClone(value);",
  "  } catch {",
  "    return { h: true, v: Object.prototype.toString.call(value) };",
  "  }",
  "  let rendered;",
  "  try {",
  "    rendered = JSON.stringify(cloned, null, 2);",
  "  } catch {",
  "    rendered = String(cloned);",
  "  }",
  "  if (typeof rendered !== 'string') rendered = String(cloned);",
  "  return { h: true, v: 'display[1]:\\n' + rendered };",
  "}",
  "(async function() {",
  "  let completion;",
  "  if (__resin_payload.mode === 'async') {",
  "    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;",
  "    completion = await new AsyncFunction(__resin_payload.source)();",
  "  } else {",
  "    completion = await (0, eval)(__resin_payload.source);",
  "  }",
  "  const display = __resin_display(completion);",
  "  __resin_outputBytes += Buffer.byteLength(display.v, 'utf8');",
  "  if (__resin_outputBytes > __resin_payload.maxOutputBytes) {",
  "    throw new Error('JavaScript Eval replay output exceeded its byte bound');",
  "  }",
  "  __resin_emit({ d: true, h: display.h, v: display.v });",
  "})();",
].join("\n");

/** Native Codex exec is a fresh JavaScript module with a private text-content result channel. */
const CODEX_EXEC_STDIN_DRIVER = [
  "const __resin_fs = require('node:fs');",
  "const __resin_vm = require('node:vm');",
  "const __resin_payload = JSON.parse(__resin_fs.readFileSync(0, 'utf8'));",
  "function __resin_failOnUnhandled() {",
  "  process.exit(1);",
  "}",
  "process.on('unhandledRejection', __resin_failOnUnhandled);",
  "process.on('uncaughtException', __resin_failOnUnhandled);",
  "async function __resin_run() {",
  "  const sandbox = Object.create(null);",
  "  sandbox.console = undefined;",
  "  const context = __resin_vm.createContext(sandbox, {",
  "    codeGeneration: { strings: false, wasm: false },",
  "  });",
  "  const setupSource = [",
  "    '(() => {',",
  "    '  const maxOutputBytes = ' + JSON.stringify(__resin_payload.maxOutputBytes) + ';',",
  "    '  const maxItems = ' + JSON.stringify(__resin_payload.maxItems) + ';',",
  "    '  const outputs = [];',",
  "    '  const stringify = JSON.stringify;',",
  "    '  const create = Object.create;',",
  "    '  const setPrototypeOf = Object.setPrototypeOf;',",
  "    '  const defineProperty = Object.defineProperty;',",
  "    '  const charCodeAt = String.prototype.charCodeAt;',",
  "    '  const apply = Reflect.apply;',",
  "    '  setPrototypeOf(outputs, null);',",
  "    '  let outputBytes = 0;',",
  "    '  let failed = false;',",
  "    '  const nativePromiseThen = Promise.prototype.then;',",
  "    '  defineProperty(Promise.prototype, \"then\", {',",
  "    '    get: () => nativePromiseThen,',",
  "    '    set: () => {',",
  "    '      failed = true;',",
  "    '      throw new TypeError(\"Codex exec replay does not support Promise intrinsic mutation\");',",
  "    '    },',",
  "    '    enumerable: false,',",
  "    '    configurable: false',",
  "    '  });',",
  "    '  Object.freeze(Promise.prototype);',",
  "    '  Object.freeze(Promise);',",
  "    '  const stackHook = Object.getOwnPropertyDescriptor(Error, \"prepareStackTrace\");',",
  "    '  if (stackHook !== undefined && !stackHook.configurable) throw new TypeError(\"Codex exec replay cannot disable Error.prepareStackTrace\");',",
  "    '  defineProperty(Error, \"prepareStackTrace\", {',",
  "    '    get: () => undefined,',",
  "    '    set: () => {',",
  "    '      failed = true;',",
  "    '      throw new TypeError(\"Codex exec replay does not support Error.prepareStackTrace\");',",
  "    '    },',",
  "    '    enumerable: false,',",
  "    '    configurable: false',",
  "    '  });',",
  "    '  Object.freeze(Error.prototype);',",
  "    '  Object.freeze(Error);',",
  "    '  function text(value) {',",
  "    '    let textValue;',",
  "    '    if (typeof value === \"string\") textValue = value;',",
  "    '    else {',",
  "    '      try { textValue = stringify(value); } catch { return; }',",
  "    '      if (typeof textValue !== \"string\") return;',",
  "    '    }',",
  "    '    let bytes = 0;',",
  "    '    const budget = maxOutputBytes - outputBytes;',",
  "    '    for (let index = 0; index < textValue.length; index += 1) {',",
  "    '      const code = apply(charCodeAt, textValue, [index]);',",
  "    '      if (code <= 0x7f) bytes += 1;',",
  "    '      else if (code <= 0x7ff) bytes += 2;',",
  "    '      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < textValue.length) {',",
  "    '        const next = apply(charCodeAt, textValue, [index + 1]);',",
  "    '        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }',",
  "    '        else bytes += 3;',",
  "    '      } else bytes += 3;',",
  "    '      if (bytes > budget) { failed = true; throw new RangeError(\"Codex exec replay exceeded its output byte bound\"); }',",
  "    '    }',",
  "    '    if (outputs.length >= maxItems) { failed = true; throw new RangeError(\"Codex exec replay exceeded its content item bound\"); }',",
  "    '    const item = create(null);',",
  "    '    item.type = \"input_text\";',",
  "    '    item.text = textValue;',",
  "    '    outputs[outputs.length] = item;',",
  "    '    outputBytes += bytes;',",
  "    '  }',",
  "    '  defineProperty(globalThis, \"text\", { value: text, enumerable: false, writable: false, configurable: false });',",
  '    \'  defineProperty(globalThis, "__resin_codex_exec_result__", { value: () => { if (failed) throw new RangeError("Codex exec replay exceeded its output bounds"); return stringify(outputs); }, enumerable: false, writable: false, configurable: false });\',',
  "    '})();',",
  '  ].join("\\n");',
  "  new __resin_vm.Script(setupSource, { filename: '<resin-codex-exec-runtime>' }).runInContext(context);",
  "  const module = new __resin_vm.SourceTextModule(__resin_payload.source, { context });",
  "  await module.link(async () => { throw new Error('Codex exec replay does not support imports'); });",
  "  await module.evaluate();",
  "  const contentJson = __resin_vm.runInContext('__resin_codex_exec_result__()', context);",
  "  const content = JSON.parse(contentJson);",
  "  const frame = JSON.stringify({ complete: true, content });",
  "  const frameBytes = Buffer.from(frame, 'utf8');",
  "  if (frameBytes.length > __resin_payload.maxEventBytes) {",
  "    throw new Error('Codex exec replay result channel exceeded its byte bound');",
  "  }",
  "  let offset = 0;",
  "  while (offset < frameBytes.length) {",
  "    offset += __resin_fs.writeSync(3, frameBytes, offset, frameBytes.length - offset, offset);",
  "  }",
  "}",
  "__resin_run().catch(() => {",
  "  process.stderr.write('Codex exec replay failed\\n');",
  "  process.exitCode = 1;",
  "});",
].join("\n");

interface ChildInvocation {
  command: string;
  args: string[];
  input?: string;
  privateResultFd?: number;
}

interface PreparedJavaScriptEval {
  source: string;
  mode: "sync" | "async";
}

interface JavaScriptEvalOutputBounds {
  output: number;
  events: number;
}

interface CodexExecOutputBounds {
  output: number;
  events: number;
  items: number;
}

const MAX_CODEX_EXEC_OUTPUT_ITEMS = 4_096;

const JAVASCRIPT_FUNCTION_NODES: Readonly<Record<string, true>> = {
  ArrowFunctionExpression: true,
  ClassMethod: true,
  ClassPrivateMethod: true,
  FunctionDeclaration: true,
  FunctionExpression: true,
  ObjectMethod: true,
};

function hasTopLevelJavaScriptAsyncControl(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasTopLevelJavaScriptAsyncControl);
  if (typeof node !== "object" || node === null) return false;
  const record = node as Record<string, unknown>;
  if (typeof record.type !== "string" || JAVASCRIPT_FUNCTION_NODES[record.type] === true) {
    return false;
  }
  if (
    record.type === "ReturnStatement" ||
    record.type === "AwaitExpression" ||
    (record.type === "ForOfStatement" && record.await === true)
  ) {
    return true;
  }
  return Object.values(record).some(hasTopLevelJavaScriptAsyncControl);
}

interface JavaScriptSourceEdit {
  start: number;
  end: number;
  replacement: string;
}

function applyJavaScriptSourceEdits(source: string, edits: JavaScriptSourceEdit[]): string {
  edits.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > source.length) {
      throw new Error("recorded JavaScript Eval replay found overlapping source edits");
    }
    parts.push(source.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function lowerJavaScriptImport(declaration: {
  source: { value: unknown };
  specifiers: readonly {
    type: string;
    local: { name: string };
    imported?: { type: string; name?: string; value?: string };
  }[];
}): string {
  const metadata = declaration as typeof declaration & {
    attributes?: unknown;
    assertions?: unknown;
    importKind?: unknown;
  };
  if (
    (typeof metadata.importKind === "string" && metadata.importKind !== "value") ||
    (Array.isArray(metadata.attributes) && metadata.attributes.length > 0) ||
    (Array.isArray(metadata.assertions) && metadata.assertions.length > 0)
  ) {
    throw new Error(
      "recorded JavaScript Eval replay does not support import attributes or type imports",
    );
  }
  if (typeof declaration.source.value !== "string") {
    throw new Error("recorded JavaScript Eval replay requires a string import specifier");
  }
  // The recorded module specifier is only known at replay time, so static imports cannot represent it.
  const moduleExpression = `await import(${JSON.stringify(declaration.source.value)})`;
  const namespaceSpecifier = declaration.specifiers.find(
    (specifier) => specifier.type === "ImportNamespaceSpecifier",
  );
  const defaultSpecifier = declaration.specifiers.find(
    (specifier) => specifier.type === "ImportDefaultSpecifier",
  );
  const namedSpecifiers = declaration.specifiers.filter(
    (specifier) => specifier.type === "ImportSpecifier",
  );
  const supportedSpecifierCount =
    namedSpecifiers.length +
    (namespaceSpecifier === undefined ? 0 : 1) +
    (defaultSpecifier === undefined ? 0 : 1);
  if (supportedSpecifierCount !== declaration.specifiers.length) {
    throw new Error("recorded JavaScript Eval replay encountered an unsupported import binding");
  }
  const propertyBindings = namedSpecifiers.map((specifier) => {
    const imported = specifier.imported;
    const name =
      imported?.type === "Identifier"
        ? imported.name
        : imported?.type === "StringLiteral"
          ? imported.value
          : undefined;
    if (typeof name !== "string") {
      throw new Error("recorded JavaScript Eval replay encountered an unsupported import binding");
    }
    return `${JSON.stringify(name)}: ${specifier.local.name}`;
  });
  if (namespaceSpecifier !== undefined) {
    const bindings = [`const ${namespaceSpecifier.local.name} = ${moduleExpression};`];
    if (defaultSpecifier !== undefined) {
      bindings.push(
        `const ${defaultSpecifier.local.name} = ${namespaceSpecifier.local.name}.default;`,
      );
    }
    if (propertyBindings.length > 0) {
      bindings.push(`const { ${propertyBindings.join(", ")} } = ${namespaceSpecifier.local.name};`);
    }
    return bindings.join("\n");
  }
  if (defaultSpecifier !== undefined) {
    propertyBindings.unshift(`"default": ${defaultSpecifier.local.name}`);
  }
  if (propertyBindings.length === 0) return `${moduleExpression};`;
  return `const { ${propertyBindings.join(", ")} } = ${moduleExpression};`;
}

function prepareJavaScriptEval(source: string): PreparedJavaScriptEval {
  const syntax = parse(source, {
    sourceType: "unambiguous",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const body = syntax.program.body;
  if (body.some((statement) => statement.type.startsWith("Export"))) {
    throw new Error("recorded JavaScript Eval replay does not support static exports");
  }
  const imports = body.filter(
    (statement): statement is Extract<(typeof body)[number], { type: "ImportDeclaration" }> =>
      statement.type === "ImportDeclaration",
  );
  const isAsync = imports.length > 0 || hasTopLevelJavaScriptAsyncControl(syntax.program);
  if (!isAsync) return { source, mode: "sync" };
  const edits: JavaScriptSourceEdit[] = [];
  for (const declaration of imports) {
    if (typeof declaration.start !== "number" || typeof declaration.end !== "number") {
      throw new Error("recorded JavaScript Eval replay could not locate an import declaration");
    }
    edits.push({
      start: declaration.start,
      end: declaration.end,
      replacement: lowerJavaScriptImport(declaration),
    });
  }

  let finalStatementIndex = body.length - 1;
  while (finalStatementIndex >= 0 && body[finalStatementIndex]?.type === "EmptyStatement") {
    finalStatementIndex -= 1;
  }
  const finalStatement = body[finalStatementIndex];
  if (finalStatement?.type === "ExpressionStatement") {
    const expression = finalStatement.expression;
    if (
      typeof expression.start !== "number" ||
      typeof expression.end !== "number" ||
      typeof finalStatement.start !== "number" ||
      typeof finalStatement.end !== "number"
    ) {
      throw new Error("recorded JavaScript Eval replay could not locate its final expression");
    }
    edits.push({
      start: finalStatement.start,
      end: finalStatement.end,
      replacement: `return (${source.slice(expression.start, expression.end)});`,
    });
  }
  return { source: applyJavaScriptSourceEdits(source, edits), mode: "async" };
}

function hasUnsupportedCodexExecImport(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasUnsupportedCodexExecImport);
  if (typeof node !== "object" || node === null) return false;
  const record = node as Record<string, unknown>;
  if (record.type === "ImportDeclaration" || record.type === "ImportExpression") return true;
  if (record.type === "Import") return true;
  if (record.type === "MetaProperty") {
    const meta = record.meta;
    const property = record.property;
    if (
      typeof meta === "object" &&
      meta !== null &&
      "name" in meta &&
      typeof property === "object" &&
      property !== null &&
      "name" in property &&
      meta.name === "import" &&
      property.name === "meta"
    ) {
      return true;
    }
  }
  if (record.type === "CallExpression") {
    const callee = record.callee;
    if (
      typeof callee === "object" &&
      callee !== null &&
      "type" in callee &&
      callee.type === "Import"
    ) {
      return true;
    }
  }
  return Object.values(record).some(hasUnsupportedCodexExecImport);
}

function assertCodexExecHasNoImports(source: string): void {
  const syntax = parse(source, {
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });
  if (hasUnsupportedCodexExecImport(syntax.program)) {
    throw new Error("recorded Codex exec replay does not support imports or import.meta");
  }
}

function javascriptEvalOutputBounds(maxOutputBytes: number): JavaScriptEvalOutputBounds {
  const output = Math.floor(maxOutputBytes);
  const events = output * 24 + 128;
  if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(events)) {
    throw new Error(
      "JavaScript Eval replay output limit must be a finite non-negative safe integer",
    );
  }
  return { output, events };
}

function codexExecOutputBounds(maxOutputBytes: number): CodexExecOutputBounds {
  const output = Math.floor(maxOutputBytes);
  const items = Math.max(1, Math.min(MAX_CODEX_EXEC_OUTPUT_ITEMS, output));
  // JSON escaping uses at most six bytes per input byte; each content item adds bounded structure.
  const events = output * 6 + items * 64 + 256;
  if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(events)) {
    throw new Error("Codex exec replay output limit must be a finite non-negative safe integer");
  }
  return { output, events, items };
}

interface CapturedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function isRecordedProgram(value: unknown): value is WorkflowRecordedProgram {
  return typeof value === "object" && value !== null;
}

/**
 * Keeps a head-and-tail window of a stream: the start says how the program began, the end says why
 * it failed, and the middle is what nobody reads.
 */
class BoundedOutput {
  private readonly headLimit: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private omittedBytes = 0;

  constructor(private readonly limit: number) {
    this.headLimit = Math.max(0, Math.floor(limit * HEAD_SHARE));
  }

  write(chunk: Buffer): void {
    let rest = chunk;
    const headRoom = this.headLimit - this.head.length;
    if (headRoom > 0) {
      this.head = Buffer.concat([this.head, rest.subarray(0, headRoom)]);
      rest = rest.subarray(headRoom);
    }
    if (rest.length === 0) return;
    const tailLimit = this.limit - this.headLimit;
    if (tailLimit === 0) {
      this.omittedBytes += rest.length;
      return;
    }
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > tailLimit) {
      const drop = this.tail.length - tailLimit;
      this.tail = this.tail.subarray(drop);
      this.omittedBytes += drop;
    }
  }

  get truncated(): boolean {
    return this.omittedBytes > 0;
  }

  get omitted(): number {
    return this.omittedBytes;
  }

  text(): string {
    return this.head.toString("utf8") + this.tail.toString("utf8");
  }
}

/**
 * Resolves an interpreter on PATH without spawning it. A probe that ran the interpreter to see
 * whether it exists would execute the recorded source twice; the record is executed exactly once.
 */
function resolveInterpreter(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const searchPath = env.PATH ?? env.Path ?? "";
  const directories = searchPath.split(delimiter).filter((entry) => entry.length > 0);
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const name of names) {
    for (const extension of extensions) {
      const candidateName = `${name}${extension}`;
      for (const directory of directories.slice(0, MAX_PATH_ENTRIES)) {
        const candidate = join(directory, candidateName);
        try {
          accessSync(candidate, fsConstants.X_OK);
          return candidate;
        } catch {
          // Not here; keep looking along PATH.
        }
      }
    }
  }
  return undefined;
}

function invocationFor(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions,
  env: NodeJS.ProcessEnv,
  input?: string,
  privateResultFd?: number,
): ChildInvocation {
  const platform = options.platform ?? process.platform;
  const source = program.source;
  switch (program.kind) {
    case "shell":
      // The platform shell runs the whole text: `&&`, `||`, pipes and redirections are what the
      // recorded call did, and exit status is the program's exit status.
      return platform === "win32"
        ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", source] }
        : { command: "/bin/sh", args: ["-c", source] };
    case "python": {
      const interpreter = resolveInterpreter(["python3", "python"], env, platform);
      if (!interpreter) {
        throw new Error("no python interpreter is resolvable on PATH (looked for python3, python)");
      }
      if (program.sourceInterface === "python-eval") {
        return {
          command: interpreter,
          args: ["-c", PYTHON_STDIN_DRIVER],
          input: source,
        };
      }
      return input === undefined
        ? { command: interpreter, args: ["-c", source] }
        : { command: interpreter, args: ["-c", PYTHON_STDIN_DRIVER], input };
    }
    case "javascript":
    case "typescript":
      if (program.sourceInterface === "codex-exec") {
        if (input === undefined || privateResultFd === undefined) {
          throw new Error("Codex exec replay result channel was not prepared");
        }
        return {
          command: process.execPath,
          args: ["--experimental-vm-modules", "-e", CODEX_EXEC_STDIN_DRIVER],
          input,
          privateResultFd,
        };
      }
      if (program.sourceInterface === "javascript-eval") {
        if (input === undefined || privateResultFd === undefined) {
          throw new Error("JavaScript Eval replay result channel was not prepared");
        }
        return {
          command: process.execPath,
          args: ["-e", JAVASCRIPT_EVAL_STDIN_DRIVER],
          input,
          privateResultFd,
        };
      }
      // Ordinary programs and TypeScript records retain their existing process semantics.
      return { command: process.execPath, args: ["-e", source] };
    default: {
      const exhaustive: never = program.kind;
      throw new Error(`recorded program kind '${String(exhaustive)}' cannot be run`);
    }
  }
}

function assertRunnable(program: unknown): asserts program is WorkflowRecordedProgram {
  if (!isRecordedProgram(program)) {
    throw new Error("the record carries no program to run");
  }
  if (typeof program.kind !== "string" || !Object.hasOwn(RESIN_PROGRAM_LANGUAGES, program.kind)) {
    throw new Error(`the record names an unknown program kind '${String(program.kind)}'`);
  }
  if (typeof program.source !== "string") {
    throw new Error(`recorded ${program.kind} program source is not text`);
  }
  const interfaceErrors: string[] = [];
  validateWorkflowProgramSourceInterface(program, "recorded program", interfaceErrors);
  if (interfaceErrors.length > 0) throw new Error(interfaceErrors[0]);
  if (program.source.length === 0 && (program.argv?.length ?? 0) === 0) {
    throw new Error(
      "the record carries neither a program source nor an argv, so there is nothing to run",
    );
  }
}

/**
 * Rejects Python closure metadata before any child is started. The structural contract validator
 * catches these records during compilation; the runner repeats the safety boundary for direct
 * adapter callers so malformed state can never fall back to ambient interpreter state.
 */
function assertPythonState(program: WorkflowRecordedProgram, targetCallId?: string): void {
  if (program.pythonState === undefined) return;
  if (program.kind !== "python") {
    throw new Error("pythonState is only valid for Python programs");
  }
  const errors: string[] = [];
  validateWorkflowPythonState(
    program,
    "recorded Python pythonState",
    targetCallId,
    new Set<string>(),
    undefined,
    errors,
  );
  if (errors.length > 0) throw new Error(errors[0]);
  if (program.pythonState.status !== "closed") {
    throw new Error("recorded Python pythonState is unresolved");
  }
  if (program.pythonState.unresolvedReadCount !== 0) {
    throw new Error("recorded Python pythonState has unresolved reads");
  }
}

function composePythonReplaySource(setupSources: readonly string[], target: string): string {
  if (setupSources.length === 0) return target;
  const setup = setupSources
    .map(
      (source, index) =>
        `        __resin_exec(__resin_compile(${JSON.stringify(source)}, ${JSON.stringify(`<resin-python-setup-${index}>`)}, "exec"), __resin_namespace, __resin_namespace)`,
    )
    .join("\n");
  const targetExecution = `    __resin_exec(__resin_compile(${JSON.stringify(target)}, "<resin-python-target>", "exec"), __resin_namespace, __resin_namespace)`;
  return [
    "def __resin_run():",
    '    __resin_builtins = __import__("builtins")',
    '    __resin_contextlib = __import__("contextlib")',
    "    __resin_exec = __resin_builtins.exec",
    "    __resin_compile = __resin_builtins.compile",
    "    __resin_len = __resin_builtins.len",
    "    __resin_discard_type = __resin_builtins.type",
    "    __resin_namespace = {'__name__': '__main__', '__builtins__': __resin_builtins.__dict__}",
    "    __resin_discard = __resin_discard_type(",
    '        "_ResinDiscard",',
    "        (),",
    "        {",
    '            "write": lambda _self, data: __resin_len(data),',
    '            "flush": lambda _self: None,',
    "        },",
    "    )",
    "    with __resin_contextlib.redirect_stdout(__resin_discard()), __resin_contextlib.redirect_stderr(__resin_discard()):",
    setup,
    targetExecution,
    "__resin_run()",
  ].join("\n");
}

/**
 * Replays OMP's Python Eval source interface through the same interpreter, with a bounded,
 * private result file separating rendered output events from the child's real stdout/stderr.
 */
function composePythonEvalReplaySource(
  setupSources: readonly string[],
  target: string,
  outputPath: string,
  maxOutputBytes: number,
  maxEventBytes: number,
): string {
  const serializedSources = JSON.stringify(JSON.stringify([...setupSources, target]));
  return [
    "import ast as __resin_ast",
    "import builtins as __resin_builtins",
    "import contextlib as __resin_contextlib",
    "import __future__ as __resin_future",
    "import json as __resin_json",
    "import sys as __resin_sys",
    "",
    "def __resin_run():",
    `    __resin_sources = __resin_json.loads(${serializedSources})`,
    "    __resin_namespace = {'__name__': '__main__', '__builtins__': __resin_builtins.__dict__}",
    "    __resin_exec = __resin_builtins.exec",
    "    __resin_compile = __resin_builtins.compile",
    "    __resin_eval = __resin_builtins.eval",
    "    __resin_future_mask = 0",
    "    for __resin_feature in __resin_future.all_feature_names:",
    "        __resin_future_mask |= getattr(__resin_future, __resin_feature).compiler_flag",
    "    __resin_open = __resin_builtins.open",
    `    _resin_output_limit = ${String(maxOutputBytes)}`,
    `    _resin_event_limit = ${String(maxEventBytes)}`,
    "    _resin_output_bytes = 0",
    "    _resin_event_bytes = 0",
    "    __resin_original_stdout = __resin_sys.stdout",
    `    __resin_event_file = __resin_open(${JSON.stringify(outputPath)}, 'ab', buffering=0)`,
    "",
    "    def _resin_write_all(data):",
    "        view = memoryview(data)",
    "        while view:",
    "            written = __resin_event_file.write(view)",
    "            if written is None or written <= 0:",
    "                raise OSError('short write to private Python Eval result file')",
    "            view = view[written:]",
    "",
    "    def _resin_emit(kind, text):",
    "        nonlocal _resin_output_bytes, _resin_event_bytes",
    "        if kind == 'r':",
    "            _resin_output_bytes += len(text.encode('utf-8'))",
    "            if _resin_output_bytes > _resin_output_limit:",
    "                raise ValueError('Python Eval result exceeds the replay output bound')",
    "        frame = __resin_json.dumps({'k': kind, 'v': text}, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\\n'",
    "        _resin_event_bytes += len(frame)",
    "        if _resin_event_bytes > _resin_event_limit:",
    "            raise ValueError('Python Eval result events exceed the replay output bound')",
    "        _resin_write_all(frame)",
    "",
    "    def __resin_emit_done():",
    "        nonlocal _resin_event_bytes",
    "        frame = b'{\"d\":true}\\n'",
    "        _resin_event_bytes += len(frame)",
    "        if _resin_event_bytes > _resin_event_limit:",
    "            raise ValueError('Python Eval result events exceed the replay output bound')",
    "        _resin_write_all(frame)",
    "",
    "    class __ResinDiscard:",
    "        def write(self, _text):",
    "            return len(_text)",
    "        def flush(self):",
    "            return None",
    "",
    "    class _ResinBinaryOutput:",
    "        def __init__(self, owner):",
    "            self.owner = owner",
    "        def write(self, data):",
    "            written = self.owner.target.buffer.write(data)",
    "            self.owner.record(data.decode(self.owner.encoding, errors='replace'))",
    "            return written",
    "        def flush(self):",
    "            return self.owner.flush()",
    "",
    "    class _ResinStdout:",
    "        def __init__(self, target):",
    "            self.target = target",
    "            self.encoding = target.encoding",
    "            self.errors = target.errors",
    "            self.pending = bytearray()",
    "            self.buffer = _ResinBinaryOutput(self)",
    "        def record(self, text):",
    "            nonlocal _resin_output_bytes",
    "            if len(text) + _resin_output_bytes > _resin_output_limit:",
    "                raise ValueError('Python Eval output exceeds the replay output bound')",
    "            data = text.encode('utf-8')",
    "            if len(data) + _resin_output_bytes > _resin_output_limit:",
    "                raise ValueError('Python Eval output exceeds the replay output bound')",
    "            _resin_output_bytes += len(data)",
    "            start = 0",
    "            while start < len(data):",
    "                end = data.find(b'\\n', start)",
    "                stop = len(data) if end < 0 else end + 1",
    "                piece = data[start:stop]",
    "                if len(self.pending) + len(piece) > _resin_output_limit:",
    "                    raise ValueError('Python Eval output line exceeds the replay output bound')",
    "                self.pending.extend(piece)",
    "                if end >= 0:",
    "                    _resin_emit('s', self.pending.decode('utf-8'))",
    "                    self.pending.clear()",
    "                start = stop",
    "        def write(self, text):",
    "            written = self.target.write(text)",
    "            self.record(text)",
    "            return written",
    "        def flush(self):",
    "            if self.pending:",
    "                _resin_emit('s', self.pending.decode('utf-8'))",
    "                self.pending.clear()",
    "            return self.target.flush()",
    "        def isatty(self):",
    "            return self.target.isatty()",
    "        def fileno(self):",
    "            return self.target.fileno()",
    "        def writable(self):",
    "            return self.target.writable()",
    "",
    "    __resin_discard = __ResinDiscard()",
    "    for __resin_index, __resin_source in enumerate(__resin_sources[:-1]):",
    "        with __resin_contextlib.redirect_stdout(__resin_discard), __resin_contextlib.redirect_stderr(__resin_discard):",
    "            __resin_exec(__resin_compile(__resin_source, '<resin-python-setup-' + str(__resin_index) + '>', 'exec'), __resin_namespace, __resin_namespace)",
    "",
    "    __resin_tree = __resin_ast.parse(__resin_sources[-1], '<resin-python-target>', 'exec')",
    "    __resin_body = __resin_tree.body",
    "    __resin_has_result = bool(__resin_body and isinstance(__resin_body[-1], __resin_ast.Expr))",
    "    __resin_expression = __resin_body[-1] if __resin_has_result else None",
    "    if __resin_has_result:",
    "        __resin_tree.body = __resin_body[:-1]",
    "    __resin_ast.fix_missing_locations(__resin_tree)",
    "    __resin_prefix_code = __resin_compile(__resin_tree, '<resin-python-target>', 'exec', dont_inherit=True)",
    "    __resin_stdout = _ResinStdout(__resin_original_stdout)",
    "    try:",
    "        with __resin_contextlib.redirect_stdout(__resin_stdout):",
    "            __resin_exec(__resin_prefix_code, __resin_namespace, __resin_namespace)",
    "            if __resin_has_result:",
    "                __resin_expression_tree = __resin_ast.Expression(body=__resin_expression.value)",
    "                __resin_ast.fix_missing_locations(__resin_expression_tree)",
    "                __resin_future_flags = __resin_prefix_code.co_flags & __resin_future_mask",
    "                __resin_expression_code = __resin_compile(__resin_expression_tree, '<resin-python-result>', 'eval', flags=__resin_future_flags, dont_inherit=True)",
    "                __resin_result = __resin_eval(__resin_expression_code, __resin_namespace, __resin_namespace)",
    "                if __resin_result is not None:",
    "                    _resin_emit('r', repr(__resin_result) + '\\n')",
    "            __resin_stdout.flush()",
    "    finally:",
    "        try:",
    "            __resin_emit_done()",
    "        finally:",
    "            __resin_event_file.close()",
    "",
    "__resin_run()",
  ].join("\n");
}

interface PythonEvalOutputBounds {
  output: number;
  events: number;
}

function pythonEvalOutputBounds(maxOutputBytes: number): PythonEvalOutputBounds {
  const output = Math.floor(maxOutputBytes);
  const events = output * 24 + 64;
  if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(events)) {
    throw new Error("Python Eval replay output limit must be a finite non-negative safe integer");
  }
  return { output, events };
}

async function preparePythonReplaySource(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions,
  targetCallId?: string,
  pythonEvalOutputPath?: string,
): Promise<string> {
  assertPythonState(program, targetCallId);
  const state = program.pythonState;
  const pythonEval = program.sourceInterface === "python-eval";
  const composeEval = (setupSources: readonly string[]): string => {
    if (pythonEvalOutputPath === undefined) {
      throw new Error("Python Eval replay result file was not prepared");
    }
    const bounds = pythonEvalOutputBounds(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    return composePythonEvalReplaySource(
      setupSources,
      program.source,
      pythonEvalOutputPath,
      bounds.output,
      bounds.events,
    );
  };
  if (state === undefined || state.setup.length === 0) {
    if (!pythonEval) return program.source;
    const targetBytes = Buffer.byteLength(program.source, "utf8");
    if (targetBytes > MAX_WORKFLOW_PYTHON_SOURCE_BYTES) {
      throw new Error(
        `recorded Python target source exceeds ${MAX_WORKFLOW_PYTHON_SOURCE_BYTES} bytes`,
      );
    }
    const composed = composeEval([]);
    if (Buffer.byteLength(composed, "utf8") > MAX_WORKFLOW_PYTHON_REPLAY_BYTES) {
      throw new Error(
        `composed Python replay source exceeds ${MAX_WORKFLOW_PYTHON_REPLAY_BYTES} bytes`,
      );
    }
    return composed;
  }
  const targetBytes = Buffer.byteLength(program.source, "utf8");
  if (targetBytes > MAX_WORKFLOW_PYTHON_SOURCE_BYTES) {
    throw new Error(
      `recorded Python target source exceeds ${MAX_WORKFLOW_PYTHON_SOURCE_BYTES} bytes`,
    );
  }
  let rawBytes = targetBytes;
  if (options.resolvePrivate === undefined) {
    throw new Error("recorded Python setup requires a private source resolver");
  }
  const setupSources: string[] = [];
  for (const descriptor of state.setup) {
    const source = await options.resolvePrivate(descriptor.reference, options.access);
    if (typeof source !== "string") {
      throw new Error(
        `recorded Python setup reference '${descriptor.reference}' did not resolve to source text`,
      );
    }
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (sourceBytes > MAX_WORKFLOW_PYTHON_SOURCE_BYTES) {
      throw new Error(
        `recorded Python setup source '${descriptor.reference}' exceeds ${MAX_WORKFLOW_PYTHON_SOURCE_BYTES} bytes`,
      );
    }
    rawBytes += sourceBytes;
    if (rawBytes > MAX_WORKFLOW_PYTHON_REPLAY_BYTES) {
      throw new Error(
        `recorded Python replay sources exceed ${MAX_WORKFLOW_PYTHON_REPLAY_BYTES} bytes before composition`,
      );
    }
    setupSources.push(source);
  }
  const composed = pythonEval
    ? composeEval(setupSources)
    : composePythonReplaySource(setupSources, program.source);
  const composedBytes = Buffer.byteLength(composed, "utf8");
  if (composedBytes > MAX_WORKFLOW_PYTHON_REPLAY_BYTES) {
    throw new Error(
      `composed Python replay source exceeds ${MAX_WORKFLOW_PYTHON_REPLAY_BYTES} bytes`,
    );
  }
  return composed;
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // A cmd.exe child is not the root of a process group, so walk the tree explicitly first.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // No process group for this child; kill the child itself.
    child.kill("SIGKILL");
  }
}

function runChild(
  invocation: ChildInvocation,
  options: ProgramRunnerOptions,
  env: NodeJS.ProcessEnv,
): Promise<CapturedRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new BoundedOutput(maxOutputBytes);
  const stderr = new BoundedOutput(maxOutputBytes);
  const cwd = options.cwd ?? process.cwd();

  return new Promise<CapturedRun>((resolve, reject) => {
    const stdio: SpawnOptions["stdio"] =
      invocation.privateResultFd === undefined
        ? [invocation.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
        : [
            invocation.input === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
            invocation.privateResultFd,
          ];
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio,
      windowsHide: true,
      // Own process group on POSIX, so the time budget can end the whole tree, not just the shell.
      detached: process.platform !== "win32",
    });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      killProcessTree(child);
      reject(new Error(`recorded program exceeded its ${timeoutMs}ms time budget and was killed`));
    }, timeoutMs);

    const finish = (run: CapturedRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.write(chunk);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `recorded program could not be started (${invocation.command}): ${error.message}`,
        ),
      );
    });
    if (invocation.input !== undefined && child.stdin !== null) {
      // The interpreter may exit before consuming all source; EPIPE is a normal transport race.
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(invocation.input, "utf8");
      } catch {
        // The close/error handlers below report the child outcome.
      }
    }
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const diagnostics: string[] = [];
      if (stdout.truncated) diagnostics.push(`[stdout truncated: ${stdout.omitted} bytes omitted]`);
      if (stderr.truncated) diagnostics.push(`[stderr truncated: ${stderr.omitted} bytes omitted]`);
      if (signal) diagnostics.push(`[terminated by signal ${signal}]`);
      const stderrText =
        stderr.text() + (diagnostics.length > 0 ? `\n${diagnostics.join("\n")}\n` : "");
      finish({
        exitCode: code ?? 1,
        stdout: stdout.text(),
        stderr: stderrText,
      });
    });
  });
}

/**
 * Validates the bounded private event stream produced by the Python Eval wrapper, then applies the
 * result text projection used by that source interface.
 */
function pythonEvalResultValue(output: string): WorkflowJsonValue {
  const resultEvents: string[] = [];
  let complete = false;
  let hasResult = false;
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error("recorded Python Eval replay produced an invalid output event");
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      throw new Error("recorded Python Eval replay produced an invalid output event");
    }
    const event = frame as Record<string, unknown>;
    if (complete) {
      throw new Error("recorded Python Eval replay produced data after its completion event");
    }
    if (Object.keys(event).length === 1 && event.d === true) {
      complete = true;
      continue;
    }
    if (
      Object.keys(event).length !== 2 ||
      typeof event.k !== "string" ||
      typeof event.v !== "string" ||
      (event.k !== "s" && event.k !== "r")
    ) {
      throw new Error("recorded Python Eval replay produced an invalid output text event");
    }
    if (event.k === "r") {
      if (hasResult) {
        throw new Error("recorded Python Eval replay produced multiple result events");
      }
      hasResult = true;
    }
    resultEvents.push(event.v);
  }
  if (!complete) {
    throw new Error("recorded Python Eval replay did not complete its output");
  }
  return resultEvents.join("").trim();
}

/**
 * Validates the bounded private event stream produced by the JavaScript Eval driver and projects
 * its stdout, console diagnostics, and final completion into the replay value.
 */
function javascriptEvalResultValue(output: string, maxOutputBytes: number): WorkflowJsonValue {
  const resultParts: string[] = [];
  let outputBytes = 0;
  let complete = false;
  const append = (text: string): void => {
    outputBytes += Buffer.byteLength(text, "utf8");
    if (outputBytes > maxOutputBytes) {
      throw new Error("recorded JavaScript Eval replay exceeded its output byte bound");
    }
    resultParts.push(text);
  };

  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error("recorded JavaScript Eval replay produced an invalid output event");
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      throw new Error("recorded JavaScript Eval replay produced an invalid output event");
    }
    const event = frame as Record<string, unknown>;
    if (complete) {
      throw new Error("recorded JavaScript Eval replay produced data after its completion event");
    }
    if (
      Object.keys(event).length === 2 &&
      typeof event.k === "string" &&
      typeof event.v === "string" &&
      (event.k === "o" || event.k === "e" || event.k === "w")
    ) {
      append(
        event.k === "e" ? `[error] ${event.v}` : event.k === "w" ? `[warn] ${event.v}` : event.v,
      );
      continue;
    }
    if (
      Object.keys(event).length !== 3 ||
      event.d !== true ||
      typeof event.h !== "boolean" ||
      typeof event.v !== "string" ||
      (!event.h && event.v !== "")
    ) {
      throw new Error("recorded JavaScript Eval replay produced an invalid completion event");
    }
    complete = true;
    append(event.v);
  }
  if (!complete) {
    throw new Error("recorded JavaScript Eval replay did not complete its output");
  }
  return resultParts.join("").trim();
}

/** Validates the complete private result channel and preserves each authored text item separately. */
function codexExecResultValue(output: string, bounds: CodexExecOutputBounds): WorkflowJsonValue {
  let frame: unknown;
  try {
    frame = JSON.parse(output);
  } catch {
    throw new Error("recorded Codex exec replay produced an invalid output result");
  }
  if (
    typeof frame !== "object" ||
    frame === null ||
    Array.isArray(frame) ||
    Object.keys(frame).length !== 2
  ) {
    throw new Error("recorded Codex exec replay produced an invalid output result");
  }
  const result = frame as Record<string, unknown>;
  if (result.complete !== true || !Array.isArray(result.content)) {
    throw new Error("recorded Codex exec replay did not complete its output");
  }
  if (result.content.length > bounds.items) {
    throw new Error("recorded Codex exec replay exceeded its content item bound");
  }
  let outputBytes = 0;
  for (const item of result.content) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      Object.keys(item).length !== 2
    ) {
      throw new Error("recorded Codex exec replay produced an invalid content item");
    }
    const content = item as Record<string, unknown>;
    if (content.type !== "input_text" || typeof content.text !== "string") {
      throw new Error("recorded Codex exec replay produced an invalid text content item");
    }
    outputBytes += Buffer.byteLength(content.text, "utf8");
    if (outputBytes > bounds.output) {
      throw new Error("recorded Codex exec replay exceeded its output byte bound");
    }
  }
  return result.content as WorkflowJsonValue;
}

/**
 * Runs a recorded program exactly once, through the family its record names. Shell programs keep
 * shell semantics. Python state replay sends composed source through stdin; JavaScript Eval and
 * Codex exec send their source through bounded stdin/private-result channels. Ordinary programs
 * receive their source as an argument. A non-zero exit code is left for the caller to
 * refuse: this function never invents a value for a program that failed.
 */
export async function runRecordedProgram(
  program: WorkflowRecordedProgram,
  options: ProgramRunnerOptions = {},
  targetCallId?: string,
): Promise<RecordedProgramRun> {
  assertRunnable(program);
  if (program.sourceInterface === "codex-exec") {
    assertCodexExecHasNoImports(program.source);
  }
  const isPythonEval = program.sourceInterface === "python-eval";
  const isJavaScriptEval = program.sourceInterface === "javascript-eval";
  const isCodexExec = program.sourceInterface === "codex-exec";
  const javascriptEval = isJavaScriptEval ? prepareJavaScriptEval(program.source) : undefined;
  let outputDirectory: string | undefined;
  let outputFile: FileHandle | undefined;
  let codexExecBounds: CodexExecOutputBounds | undefined;
  try {
    let outputPath: string | undefined;
    let outputBounds:
      | PythonEvalOutputBounds
      | JavaScriptEvalOutputBounds
      | CodexExecOutputBounds
      | undefined;
    if (isPythonEval) {
      outputBounds = pythonEvalOutputBounds(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      outputDirectory = await mkdtemp(join(tmpdir(), "resin-python-eval-"));
      outputPath = join(outputDirectory, "events.jsonl");
      outputFile = await open(outputPath, "wx+", 0o600);
    } else if (isJavaScriptEval) {
      outputBounds = javascriptEvalOutputBounds(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      outputDirectory = await mkdtemp(join(tmpdir(), "resin-javascript-eval-"));
      outputPath = join(outputDirectory, "events.jsonl");
      outputFile = await open(outputPath, "wx+", 0o600);
    } else if (isCodexExec) {
      codexExecBounds = codexExecOutputBounds(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      outputBounds = codexExecBounds;
      outputDirectory = await mkdtemp(join(tmpdir(), "resin-codex-exec-"));
      outputPath = join(outputDirectory, "result.json");
      outputFile = await open(outputPath, "wx+", 0o600);
    }
    const source =
      program.kind === "python"
        ? await preparePythonReplaySource(program, options, targetCallId, outputPath)
        : program.source;
    const runnable = source === program.source ? program : { ...program, source };
    const env: NodeJS.ProcessEnv = options.isolateEnvironment
      ? { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env }
      : { ...process.env, ...options.env };
    const pythonReplayInput =
      runnable.kind === "python" && runnable.pythonState !== undefined ? source : undefined;
    const javascriptReplayInput =
      javascriptEval === undefined || outputBounds === undefined
        ? undefined
        : JSON.stringify({
            source: javascriptEval.source,
            mode: javascriptEval.mode,
            maxOutputBytes: outputBounds.output,
            maxEventBytes: outputBounds.events,
          });
    if (isJavaScriptEval && (javascriptReplayInput === undefined || outputFile === undefined)) {
      throw new Error("recorded JavaScript Eval replay result channel was not prepared");
    }
    const codexExecReplayInput =
      codexExecBounds === undefined
        ? undefined
        : JSON.stringify({
            source: program.source,
            maxOutputBytes: codexExecBounds.output,
            maxEventBytes: codexExecBounds.events,
            maxItems: codexExecBounds.items,
          });
    if (isCodexExec && (codexExecReplayInput === undefined || outputFile === undefined)) {
      throw new Error("recorded Codex exec replay result channel was not prepared");
    }
    // The VM driver is trusted Node code, but source-module text must not be preloaded into it.
    const childEnv = isCodexExec ? { ...env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "1" } : env;
    const invocation = invocationFor(
      runnable,
      options,
      childEnv,
      isCodexExec
        ? codexExecReplayInput
        : isJavaScriptEval
          ? javascriptReplayInput
          : pythonReplayInput,
      isJavaScriptEval || isCodexExec ? outputFile?.fd : undefined,
    );
    const captured = await runChild(invocation, options, childEnv);
    let value: WorkflowJsonValue = captured.stdout;
    if (isPythonEval && captured.exitCode === 0) {
      if (outputFile === undefined || outputBounds === undefined) {
        throw new Error("recorded Python Eval replay did not preserve its complete output");
      }
      const outputStat = await outputFile.stat();
      if (outputStat.size > outputBounds.events) {
        throw new Error("recorded Python Eval replay exceeded its output event bound");
      }
      value = pythonEvalResultValue(await outputFile.readFile({ encoding: "utf8" }));
    }
    if (isJavaScriptEval && captured.exitCode === 0) {
      if (outputPath === undefined || outputBounds === undefined || outputFile === undefined) {
        throw new Error("recorded JavaScript Eval replay did not preserve its complete output");
      }
      const outputStat = await outputFile.stat();
      if (outputStat.size > outputBounds.events) {
        throw new Error("recorded JavaScript Eval replay exceeded its output event bound");
      }
      value = javascriptEvalResultValue(
        await outputFile.readFile({ encoding: "utf8" }),
        outputBounds.output,
      );
    }
    if (isCodexExec && captured.exitCode === 0) {
      if (outputFile === undefined || codexExecBounds === undefined) {
        throw new Error("recorded Codex exec replay did not preserve its complete output");
      }
      const outputStat = await outputFile.stat();
      if (outputStat.size > codexExecBounds.events) {
        throw new Error("recorded Codex exec replay exceeded its result event bound");
      }
      value = codexExecResultValue(
        await outputFile.readFile({ encoding: "utf8" }),
        codexExecBounds,
      );
    }
    return {
      exitCode: captured.exitCode,
      stdout: captured.stdout,
      stderr: captured.stderr,
      value,
    };
  } finally {
    try {
      await outputFile?.close();
    } finally {
      if (outputDirectory !== undefined) {
        await rm(outputDirectory, { recursive: true, force: true });
      }
    }
  }
}

/** The tail of a failure message, bounded so a noisy program cannot flood a step's error. */
function stderrTail(stderr: string, limit = 800): string {
  const text = stderr.trim();
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - limit)}`;
}

/**
 * The program text a recorded call must run. When the record says the program arrived as a tool
 * argument, the value resolved for that argument *is* the program: that is what lets a resolved
 * private leaf or a promoted input reach the program on a re-run.
 */
function programTextFor(
  program: WorkflowRecordedProgram,
  args: Record<string, WorkflowJsonValue>,
): string {
  const argumentName = program.argument;
  if (argumentName !== undefined && Object.hasOwn(args, argumentName)) {
    const carried = args[argumentName];
    if (typeof carried === "string") return carried;
  }
  return program.source;
}

/**
 * Runs the program a recorded call names and returns its value. Both program families share this:
 * they differ in how the observer recorded the call, not in what running it again means. A failure
 * — a missing program, an unrunnable record, a non-zero exit status — throws with the step id so
 * the executor records the step as failed instead of passing a fabricated value on.
 */
export async function runRecordedCall(
  request: RecordedCallRequest,
  options: ProgramRunnerOptions = {},
): Promise<WorkflowJsonValue> {
  const { step } = request;
  const program = step.callable.program;
  if (!program) {
    throw new Error(
      `step '${step.id}' cannot run: the record carries no program for callable '${step.callable.name}'`,
    );
  }
  const source = programTextFor(program, request.arguments);
  if (source.length === 0) {
    throw new Error(
      `step '${step.id}' cannot run: the record carries no program text for callable '${step.callable.name}'`,
    );
  }
  const replayOptions: ProgramRunnerOptions = {
    ...options,
    ...(options.resolvePrivate === undefined && request.resolvePrivate
      ? { resolvePrivate: request.resolvePrivate }
      : {}),
    ...(options.access === undefined && request.access ? { access: request.access } : {}),
  };
  const run = await runRecordedProgram({ ...program, source }, replayOptions, step.callId);
  if (run.exitCode !== 0) {
    const tail = stderrTail(run.stderr);
    const detail = tail.length > 0 ? `: ${tail}` : " (no stderr)";
    throw new Error(
      `step '${step.id}' failed: recorded ${program.kind} program exited with code ${run.exitCode}${detail}`,
    );
  }
  return run.value;
}
