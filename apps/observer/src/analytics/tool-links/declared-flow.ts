import { posix } from "node:path";
import { parser as pythonParser } from "@lezer/python";
import type {
  NormalizedSessionEvent,
  NormalizedToolCallEvent,
  ToolLinkContentKind,
  ToolLinkInputName,
  ToolLinkOperation,
  ToolLinkResourceKind,
} from "@resin/contracts";
import { decodePythonStringLiteral, parsePythonImportText } from "../computation/python-api.js";
import { extractComputationSourceFrames } from "../computation/source-frames.js";

/**
 * Declared data-flow extraction: what an observed invocation DECLARED it would read and write.
 *
 * This module is private, on-device analysis. It reads observed events and, for a script frame, the
 * authored source — never a filesystem, never a subprocess, and it never executes anything it sees.
 * Its output (`DeclaredFlow`) carries only PRIVATE resource identities plus finite vocabulary; the
 * recorder that owns it turns those identities into per-scope ordinals, and only ordinals travel.
 *
 * What is recognized is deliberately narrow, because a wrong data-flow statement is worse than a
 * missing one:
 *   - `gh issue view` / `gh issue edit` command lines (the declared issue, `--body-file`, and stdout
 *     / stdin redirection), parsed from tokens, never from a shell evaluation;
 *   - file tools whose declared arguments carry exactly one path (`read`, `write`, `edit`);
 *   - Python script frames (an eval cell or an inline interpreter invocation) using
 *     `pathlib.Path(...).read_text()/write_text()` and `open(...)` with a STATIC literal path, where
 *     the receiver is a `Path` constructed in the same frame or a name bound to one, following the
 *     same import/alias vocabulary the computation parser uses.
 *
 * A `file.transform` is claimed only with PROOF that the written payload derives from the value that
 * was read — through assignment, aliasing, `replace`/`strip`-style methods and `+` concatenation —
 * so an unrelated constant write after a read is never presented as a transform. A read and a write
 * in one program are not a data flow by co-occurrence.
 *
 * Everything else omits the flow: dynamic receivers (`Path(x) / name`, `os.environ[...]`, an
 * f-string path, a rebound or shadowed `Path`), an unresolvable `open` mode, an untracked write
 * payload, code that only appears inside a string, a file operation inside a function/lambda/
 * comprehension body or inside conditional control flow, an unsupported language, a chained or
 * substituted shell command, a multi-path patch. An omitted flow produces no carrier, and a
 * recognized file operation whose path cannot be resolved makes the WHOLE frame's flow ambiguous
 * rather than reporting a partial (and therefore misleading) read/write set.
 */

/** Private identity of one declared resource. Compared locally, never projected, never logged. */
export interface DeclaredResource {
  readonly kind: ToolLinkResourceKind;
  /** Equality key derived from the declared value; it never leaves the device. */
  readonly identity: string;
}

export interface DeclaredInput {
  readonly name: ToolLinkInputName;
  readonly resource: DeclaredResource;
}

export interface DeclaredFlow {
  readonly operation: ToolLinkOperation;
  readonly reads: readonly DeclaredResource[];
  readonly writes: readonly DeclaredResource[];
  readonly inputs: readonly DeclaredInput[];
  readonly contentKinds: readonly ToolLinkContentKind[];
  /**
   * True when the flow was recovered from an INTERPRETER PROGRAM frame, so the result text is that
   * program's own output and a traceback in it means the program failed. A command whose output is
   * fetched data (an issue body, a redirected file) or a data tool (a file read) never sets this:
   * content that merely quotes a traceback is not that call's outcome.
   */
  readonly programOutput: boolean;
}

// ============================================================================
// Shared bounded readers
// ============================================================================

function parametersOf(call: NormalizedToolCallEvent): Readonly<Record<string, unknown>> {
  const parameters: unknown = call.parameters;
  return typeof parameters === "object" && parameters !== null
    ? (parameters as Readonly<Record<string, unknown>>)
    : {};
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 262_144
    ? value
    : undefined;
}

function firstBoundedString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const text = boundedString(value);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

/** Checklist markers as a SHAPE fact. The marker text itself is never carried. */
const CHECKLIST_MARKER = /^[ \t]*[-*+] \[[ xX]\]/m;

const MARKDOWN_CHECKLIST: readonly ToolLinkContentKind[] = ["markdown_checklist"];

/** Content-shape facts of one observed piece of text; the text itself is never carried. */
export function declaredContentKindsOfText(
  text: string | undefined,
): readonly ToolLinkContentKind[] {
  return text !== undefined && CHECKLIST_MARKER.test(text) ? MARKDOWN_CHECKLIST : [];
}

/** An absolute declared path: POSIX, UNC, or a Windows drive path. */
const ABSOLUTE_PATH = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;

/**
 * Identity spelling of a declared path, or `undefined` when this recorder cannot bound it.
 *
 * An absolute path is its own identity. A RELATIVE path is only resolvable against a working
 * directory the capture actually witnessed on the event; without one, two same-spelled relative
 * paths in different directories would silently become one resource, so the path is omitted instead.
 */
function resolveDeclaredPath(rawPath: string, cwd: string | undefined): string | undefined {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const collapsed = posix.normalize(trimmed.replace(/\/{2,}/g, "/"));
  const stripTrailing = (value: string): string =>
    value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (ABSOLUTE_PATH.test(collapsed)) {
    return stripTrailing(collapsed);
  }
  const witnessed = cwd?.trim();
  if (witnessed === undefined || witnessed.length === 0) {
    return undefined;
  }
  return stripTrailing(posix.normalize(`${witnessed.replace(/\\/g, "/")}/${collapsed}`));
}

function fileResource(rawPath: string, cwd: string | undefined): DeclaredResource | undefined {
  const spelling = resolveDeclaredPath(rawPath, cwd);
  return spelling === undefined ? undefined : { kind: "file", identity: `file\u0000${spelling}` };
}

/**
 * The issue a `gh issue …` command names. Without an explicit `--repo` it is identified by the
 * repository the command runs in — the observed working directory when the event carries one. Two
 * spellings that cannot be related stay unrelated (a lost link), and two repositories are never
 * merged into one resource.
 */
function issueResource(
  rawRef: string,
  repo: string | undefined,
  cwd: string | undefined,
): DeclaredResource | undefined {
  const digits = rawRef.startsWith("#") ? rawRef.slice(1) : rawRef;
  if (!/^[0-9]{1,12}$/.test(digits)) {
    return undefined;
  }
  return {
    kind: "github_issue",
    identity: `github_issue\u0000${repo ?? cwd ?? ""}\u0000${digits}`,
  };
}

// ============================================================================
// Shell command lines
// ============================================================================

interface DeclaredRedirect {
  readonly read: boolean;
  readonly target: string;
}

interface CommandLine {
  readonly tokens: readonly string[];
  readonly redirects: readonly DeclaredRedirect[];
}

/**
 * Bounded, non-evaluating tokenizer for ONE simple command line. Quotes are honored and redirections
 * are captured, but any shell CONTROL FLOW makes the whole line unparseable: a pipe, `&&`, `||`, `;`,
 * `&`, a second line, an expansion or a substitution. A chained command may never execute the part
 * that appears to declare a flow (`true || gh issue edit …` exits 0 without editing anything), so no
 * flow is claimed from such a line at all.
 */
function tokenizeCommand(command: string): CommandLine | undefined {
  const tokens: string[] = [];
  const redirects: DeclaredRedirect[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  /** Set while a `>` (stdout) redirection is waiting for its target token. */
  let pendingWrite: boolean | undefined;
  let comment = false;
  /** Set once the line's single command has ended, so a later command is refused. */
  let ended = false;

  const commitToken = (): void => {
    if (!started) {
      return;
    }
    if (pendingWrite !== undefined) {
      redirects.push({ read: !pendingWrite, target: current });
      pendingWrite = undefined;
    } else {
      tokens.push(current);
    }
    current = "";
    started = false;
  };
  const hasContent = (): boolean =>
    started || tokens.length > 0 || redirects.length > 0 || pendingWrite !== undefined;

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (comment) {
      if (char === "\n") {
        comment = false;
        if (hasContent()) {
          ended = true;
        }
      }
      continue;
    }
    if (ended && char !== "\n" && !/\s/.test(char)) {
      // A second command (or its redirection) after the first one ended.
      return undefined;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index++;
        current += command[index]!;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === "\n") {
      commitToken();
      if (pendingWrite !== undefined) {
        return undefined;
      }
      if (hasContent()) {
        ended = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" || char === "$" || char === "`") {
      // Escapes and expansions hide a token's real value: an unresolved target is never guessed.
      return undefined;
    }
    if (char === "#" && !started) {
      comment = true;
      continue;
    }
    if (char === ">" || char === "<") {
      if (command[index + 1] === char || command[index + 1] === "&") {
        // A duplicated or appended descriptor has no single declared target.
        return undefined;
      }
      commitToken();
      if (pendingWrite !== undefined) {
        return undefined;
      }
      pendingWrite = char === ">";
      continue;
    }
    if (/[0-9]/.test(char) && (command[index + 1] === ">" || command[index + 1] === "<")) {
      if (command[index + 2] === "&") {
        return undefined;
      }
      commitToken();
      if (pendingWrite !== undefined) {
        return undefined;
      }
      pendingWrite = command[index + 1] === ">";
      index++;
      continue;
    }
    if (char === "|" || char === "&" || char === ";") {
      return undefined;
    }
    if (/\s/.test(char)) {
      commitToken();
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== undefined) {
    return undefined;
  }
  commitToken();
  if (pendingWrite !== undefined) {
    return undefined;
  }
  return { tokens, redirects };
}

/** `--flag value` pairs whose value is data, never the issue reference. */
const GH_VALUE_FLAGS: Readonly<Record<string, true>> = {
  "-R": true,
  "--repo": true,
  "--json": true,
  "--jq": true,
  "-q": true,
  "--template": true,
  "-b": true,
  "--body": true,
  "-F": true,
  "--body-file": true,
  "-t": true,
  "--title": true,
  "-m": true,
  "--milestone": true,
  "-a": true,
  "--assignee": true,
  "-l": true,
  "--label": true,
  "-c": true,
  "--comment": true,
  "--add-label": true,
  "--remove-label": true,
  "--add-assignee": true,
  "--remove-assignee": true,
  "--add-project": true,
  "--remove-project": true,
  "--add-blocked-by": true,
  "--remove-blocked-by": true,
  "--add-blocking": true,
  "--remove-blocking": true,
  "--dedupe-by": true,
  "--duplicate-of": true,
  "--remove-milestone": true,
  "--reason": true,
  "--state": true,
  "--limit": true,
  "-L": true,
  "--search": true,
  "--author": true,
  "--mention": true,
};

interface GhIssueCommand {
  readonly subcommand: "edit" | "view";
  readonly issueRef: string;
  readonly repo?: string;
  readonly bodyFile?: string;
  readonly inlineBody?: string;
}

/**
 * `gh issue view|edit` recognition from tokens only. A shape the token walk cannot account for (a
 * missing reference, a second bare argument, a value flag without its value) yields no command
 * rather than a guessed one; an unknown flag is read as the boolean flag it looks like.
 */
function parseGhIssueCommand(tokens: readonly string[]): GhIssueCommand | undefined {
  if (tokens[0] !== "gh") {
    return undefined;
  }
  const issueIndex = tokens.indexOf("issue", 1);
  if (issueIndex < 0) {
    return undefined;
  }
  const subcommand = tokens[issueIndex + 1];
  if (subcommand !== "view" && subcommand !== "edit") {
    return undefined;
  }
  let issueRef: string | undefined;
  let repo: string | undefined;
  let bodyFile: string | undefined;
  let inlineBody: string | undefined;

  for (let index = issueIndex + 2; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      const equalsIndex = token.indexOf("=");
      const flag = equalsIndex < 0 ? token : token.slice(0, equalsIndex);
      if (GH_VALUE_FLAGS[flag] !== true) {
        continue;
      }
      const value = equalsIndex < 0 ? tokens[++index] : token.slice(equalsIndex + 1);
      if (value === undefined) {
        return undefined;
      }
      if (flag === "--repo" || flag === "-R") {
        repo = value;
      } else if ((flag === "--body-file" || flag === "-F") && value !== "-") {
        bodyFile = value;
      } else if (flag === "--body" || flag === "-b") {
        inlineBody = value;
      }
      continue;
    }
    if (issueRef !== undefined) {
      return undefined;
    }
    issueRef = token;
  }
  if (issueRef === undefined) {
    return undefined;
  }
  return {
    subcommand,
    issueRef,
    ...(repo === undefined ? {} : { repo }),
    ...(bodyFile === undefined ? {} : { bodyFile }),
    ...(inlineBody === undefined ? {} : { inlineBody }),
  };
}

/** Declared flow of a `gh issue view|edit` segment, including its redirections. */
function ghIssueFlow(
  command: GhIssueCommand,
  redirects: readonly DeclaredRedirect[],
  cwd: string | undefined,
): DeclaredFlow | undefined {
  const issue = issueResource(command.issueRef, command.repo, cwd);
  if (issue === undefined) {
    return undefined;
  }
  const readRedirects = redirects.filter((redirect) => redirect.read);
  const writeRedirects = redirects.filter((redirect) => !redirect.read);
  const writeTargets: DeclaredResource[] = [];
  for (const redirect of writeRedirects) {
    const resource = fileResource(redirect.target, cwd);
    if (resource === undefined) {
      // A relative redirect target with no witnessed working directory cannot be bounded.
      return undefined;
    }
    writeTargets.push(resource);
  }
  const readTargets: DeclaredResource[] = [];
  for (const redirect of readRedirects) {
    const resource = fileResource(redirect.target, cwd);
    if (resource === undefined) {
      return undefined;
    }
    readTargets.push(resource);
  }
  const bodyFile = command.bodyFile === undefined ? undefined : fileResource(command.bodyFile, cwd);
  if (command.bodyFile !== undefined && bodyFile === undefined) {
    return undefined;
  }

  if (command.subcommand === "view") {
    const inputs: DeclaredInput[] = [{ name: "subject", resource: issue }];
    if (writeTargets[0] !== undefined) {
      inputs.push({ name: "target", resource: writeTargets[0] });
    }
    return {
      operation: "github.issue.read",
      reads: [issue, ...readTargets],
      writes: writeTargets,
      inputs,
      contentKinds: [],
      programOutput: false,
    };
  }

  const inputs: DeclaredInput[] = [{ name: "subject", resource: issue }];
  if (bodyFile !== undefined) {
    inputs.push({ name: "changes", resource: bodyFile });
  }
  return {
    operation: "github.issue.update",
    reads: [...(bodyFile === undefined ? [] : [bodyFile]), ...readTargets],
    writes: [issue, ...writeTargets],
    inputs,
    // An inline body is authored text, not a resource: only its SHAPE is observable.
    contentKinds: declaredContentKindsOfText(command.inlineBody),
    programOutput: false,
  };
}

function declaredFlowOfCommand(command: string, cwd?: string): DeclaredFlow | undefined {
  const line = tokenizeCommand(command);
  if (line === undefined) {
    return undefined;
  }
  const parsed = parseGhIssueCommand(line.tokens);
  if (parsed !== undefined) {
    return ghIssueFlow(parsed, line.redirects, cwd);
  }
  const fileReads: DeclaredResource[] = [];
  const fileWrites: DeclaredResource[] = [];
  for (const redirect of line.redirects) {
    const resource = fileResource(redirect.target, cwd);
    if (resource === undefined) {
      // A relative target with no witnessed working directory cannot be bounded.
      return undefined;
    }
    (redirect.read ? fileReads : fileWrites).push(resource);
  }
  if (fileReads.length === 0 && fileWrites.length === 0) {
    // A command with no declared resource is not a data flow, whatever it does at runtime.
    return undefined;
  }
  const inputs: DeclaredInput[] = [];
  if (fileReads[0] !== undefined) {
    inputs.push({ name: "source", resource: fileReads[0] });
  }
  if (fileWrites[0] !== undefined) {
    inputs.push({ name: "target", resource: fileWrites[0] });
  }
  return {
    operation: "command.exec",
    reads: fileReads,
    writes: fileWrites,
    inputs,
    contentKinds: [],
    programOutput: false,
  };
}

// ============================================================================
// File tools
// ============================================================================

const FILE_READ_TOOLS: Readonly<Record<string, true>> = {
  read: true,
  read_file: true,
  readfile: true,
  view_file: true,
  cat_file: true,
};

const FILE_WRITE_TOOLS: Readonly<Record<string, true>> = {
  write: true,
  write_file: true,
  writefile: true,
  create_file: true,
  save_file: true,
};

const FILE_EDIT_TOOLS: Readonly<Record<string, true>> = {
  edit: true,
  edit_file: true,
  multiedit: true,
  str_replace: true,
  replace_in_file: true,
};

function declaredPathArgument(parameters: Readonly<Record<string, unknown>>): string | undefined {
  return firstBoundedString(
    parameters.path,
    parameters.filePath,
    parameters.file_path,
    parameters.targetPath,
    parameters.file,
  );
}

/** Declared flow of a file tool whose declared arguments name exactly one path. */
function declaredFlowOfFileTool(
  toolName: string,
  parameters: Readonly<Record<string, unknown>>,
  cwd: string | undefined,
): DeclaredFlow | undefined {
  const tool = toolName.trim().toLowerCase();
  const rawPath = declaredPathArgument(parameters);
  if (rawPath === undefined) {
    return undefined;
  }
  const resource = fileResource(rawPath, cwd);
  if (resource === undefined) {
    return undefined;
  }
  const content = firstBoundedString(
    parameters.content,
    parameters.text,
    parameters.body,
    parameters.new_string,
    parameters.newString,
    parameters.newText,
  );
  if (FILE_READ_TOOLS[tool] === true) {
    return {
      operation: "file.read",
      reads: [resource],
      writes: [],
      inputs: [{ name: "subject", resource }],
      contentKinds: [],
      programOutput: false,
    };
  }
  if (FILE_WRITE_TOOLS[tool] === true) {
    return {
      operation: "file.write",
      reads: [],
      writes: [resource],
      inputs: [{ name: "target", resource }],
      contentKinds: declaredContentKindsOfText(content),
      programOutput: false,
    };
  }
  if (FILE_EDIT_TOOLS[tool] === true) {
    // An edit reads the previous body and writes the next one: one resource, both roles.
    return {
      operation: "file.transform",
      reads: [resource],
      writes: [resource],
      inputs: [
        { name: "source", resource },
        { name: "target", resource },
      ],
      contentKinds: declaredContentKindsOfText(content),
      programOutput: false,
    };
  }
  return undefined;
}

// ============================================================================
// Python script frames
// ============================================================================

interface PyNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: PyNode | null;
  readonly nextSibling: PyNode | null;
}

/** A statically resolved Python value, or an explicit refusal to resolve one. */
type PyValue =
  | { readonly kind: "path" | "string"; readonly value: string }
  | { readonly kind: "unknown" };

const PYTHON_NODE_BUDGET = 4_096;
const PYTHON_MAX_SOURCE_LENGTH = 131_072;
/** Longest literal a name may track; a longer string is never a usable path or a tracked value. */
const PYTHON_MAX_LITERAL_LENGTH = 4_096;

const PYTHON_PATH_READ_METHODS: Readonly<Record<string, true>> = {
  read_text: true,
  read_bytes: true,
};
const PYTHON_PATH_WRITE_METHODS: Readonly<Record<string, true>> = {
  write_text: true,
  write_bytes: true,
};

/** Python `open` modes that are provably read-only; an unresolvable mode is never claimed. */
const PYTHON_READ_ONLY_MODES: Readonly<Record<string, true>> = {
  r: true,
  rb: true,
  rt: true,
  br: true,
  tr: true,
};

/**
 * String methods the walk accepts as producing a value DERIVED from their receiver (or, for `join`
 * and `format`, from their arguments). Everything else — indexing, slicing, iteration, a helper call,
 * an f-string — is not tracked, so a payload that depends on it stays unproven.
 */
const PYTHON_DERIVING_METHODS: Readonly<Record<string, true>> = {
  capitalize: true,
  expandtabs: true,
  format: true,
  join: true,
  lower: true,
  lstrip: true,
  removeprefix: true,
  removesuffix: true,
  replace: true,
  rstrip: true,
  strip: true,
  title: true,
  upper: true,
};

/** Statement kinds whose body may not run, or may run in an order this walk cannot prove. */
const PYTHON_CONDITIONAL_STATEMENTS: Readonly<Record<string, true>> = {
  ConditionalExpression: true,
  ForStatement: true,
  IfStatement: true,
  TryStatement: true,
  WhileStatement: true,
};

interface PythonScriptFlow {
  readonly status: "flow" | "none" | "ambiguous";
  readonly flow?: DeclaredFlow;
}

const AMBIGUOUS_SCRIPT: PythonScriptFlow = { status: "ambiguous" };
const UNKNOWN_VALUE: PyValue = { kind: "unknown" };
const EMPTY_ORIGINS: ReadonlySet<string> = new Set<string>();

function pyChildNamed(node: PyNode, name: string): PyNode | undefined {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return undefined;
}

/** Comma-separated argument groups, with the punctuation the tree carries for them removed. */
function pyArgumentGroups(argList: PyNode): PyNode[][] {
  const groups: PyNode[][] = [];
  let group: PyNode[] = [];
  for (let child = argList.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "(" || child.name === ")" || child.name === "Comment") {
      continue;
    }
    if (child.name === ",") {
      if (group.length > 0) {
        groups.push(group);
      }
      group = [];
      continue;
    }
    group.push(child);
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups;
}

/**
 * Static VALUE of one string literal, decoded with the parser's closed escape decoder: an escaped
 * newline in a normal literal is a real line start, while the same text in a raw literal is not.
 * `undefined` for anything the decoder does not define exactly (an f-string, a bytes literal, a raw
 * literal whose closing quote may be escaped, an unknown escape), so no caller ever reasons about an
 * approximated value.
 */
function pyStringLiteral(source: string, node: PyNode): string | undefined {
  return decodePythonStringLiteral(source.slice(node.from, node.to));
}

/** One write whose payload was traced back to the read values it was produced from. */
interface DerivedWrite {
  readonly resource: DeclaredResource;
  /** Private identities of the read resources this payload was derived from. */
  readonly origins: ReadonlySet<string>;
}

/**
 * Static analysis of one Python frame's declared file operations, using the same syntax tree and the
 * same import/alias vocabulary as the computation parser.
 *
 * Two properties are load-bearing, and both are proven rather than assumed:
 *   - a name binding follows source order, which is the order straight-line module code runs in, and
 *     anything that could rebind a tracked name (an assignment to another value, a loop/`with`
 *     target, a parameter, a `del`, a shadowed `Path` alias) drops it;
 *   - a written payload counts as DERIVED only when it flows from a value this frame actually read,
 *     through assignment, aliasing, `replace`/`strip`-style methods and `+` concatenation. A write of
 *     a constant, of an untracked expression, or of a value whose origin is unknown stays unproven,
 *     and an unproven write is never presented as a transform.
 *
 * A file operation inside a function/lambda/comprehension body (which may run later, in another
 * scope) or inside conditional control flow (which may not run at all) makes the whole frame
 * ambiguous: it is omitted rather than reported with a guessed execution order.
 */
function analyzePythonScript(source: string, cwd: string | undefined): PythonScriptFlow {
  if (source.length > PYTHON_MAX_SOURCE_LENGTH) {
    return AMBIGUOUS_SCRIPT;
  }
  let topNode: PyNode;
  try {
    topNode = (pythonParser.parse(source) as unknown as { topNode: PyNode }).topNode;
  } catch {
    return AMBIGUOUS_SCRIPT;
  }

  const bindings = new Map<string, PyValue>();
  const origins = new Map<string, ReadonlySet<string>>();
  const pathConstructorNames = new Set<string>();
  const pathModuleAliases = new Set<string>();
  const reads: DeclaredResource[] = [];
  const derivedWrites: DerivedWrite[] = [];
  const structuralWrites: DeclaredResource[] = [];
  let ambiguous = false;
  let checklist = false;
  let visited = 0;

  const textOf = (node: PyNode): string => source.slice(node.from, node.to);

  const unionOrigins = (
    left: ReadonlySet<string> | undefined,
    right: ReadonlySet<string> | undefined,
  ): ReadonlySet<string> | undefined => {
    if (left === undefined) {
      return right;
    }
    if (right === undefined || right.size === 0) {
      return left;
    }
    if (left.size === 0) {
      return right;
    }
    const merged = new Set(left);
    for (const identity of right) {
      merged.add(identity);
    }
    return merged;
  };

  const isPathConstructor = (callee: PyNode): boolean => {
    if (callee.name === "VariableName") {
      return pathConstructorNames.has(textOf(callee));
    }
    if (callee.name !== "MemberExpression") {
      return false;
    }
    const base = callee.firstChild;
    const property = pyChildNamed(callee, "PropertyName");
    return (
      base !== null &&
      property !== undefined &&
      base.name === "VariableName" &&
      pathModuleAliases.has(textOf(base)) &&
      textOf(property) === "Path"
    );
  };

  const staticValueOf = (node: PyNode): PyValue => {
    switch (node.name) {
      case "String": {
        const literal = pyStringLiteral(source, node);
        return literal === undefined || literal.length > PYTHON_MAX_LITERAL_LENGTH
          ? UNKNOWN_VALUE
          : { kind: "string", value: literal };
      }
      case "FormatString":
        // An interpolated literal is not a static value.
        return UNKNOWN_VALUE;
      case "ParenthesizedExpression": {
        const inner = node.firstChild;
        return inner === null ? UNKNOWN_VALUE : staticValueOf(inner);
      }
      case "VariableName":
        return bindings.get(textOf(node)) ?? UNKNOWN_VALUE;
      case "CallExpression": {
        const callee = node.firstChild;
        if (callee === null || !isPathConstructor(callee)) {
          return UNKNOWN_VALUE;
        }
        const args = pyChildNamed(node, "ArgList");
        const groups = args === undefined ? [] : pyArgumentGroups(args);
        // A constructor needs exactly ONE argument, spelled by exactly one literal: several adjacent
        // literals and several argument groups (which pathlib rejects at runtime) are never joined,
        // and a later argument is never silently ignored.
        if (groups.length !== 1 || groups[0]!.length !== 1) {
          return UNKNOWN_VALUE;
        }
        const resolved = staticValueOf(groups[0]![0]!);
        return resolved.kind === "unknown"
          ? UNKNOWN_VALUE
          : { kind: "path", value: resolved.value };
      }
      default:
        return UNKNOWN_VALUE;
    }
  };

  /** `open` mode of one call: read-only, writing, or unresolved. */
  const modeOfCall = (groups: readonly PyNode[][], positionalIndex: number): PyValue => {
    let modeNode: PyNode | undefined = groups[positionalIndex]?.[0];
    for (const group of groups) {
      const first = group[0];
      if (first?.name === "VariableName" && textOf(first) === "mode" && group[1] !== undefined) {
        modeNode = group[2];
        break;
      }
    }
    if (modeNode === undefined) {
      // Python's default text mode is read-only.
      return { kind: "string", value: "r" };
    }
    return staticValueOf(modeNode);
  };

  /** The read resource of a call that reads a file, or undefined for any other call. */
  const readResourceOf = (node: PyNode): DeclaredResource | undefined => {
    const callee = node.firstChild;
    if (callee === null) {
      return undefined;
    }
    const property = pyChildNamed(callee, "PropertyName");
    const method = property === undefined ? undefined : textOf(property);
    const readsPath = method !== undefined && PYTHON_PATH_READ_METHODS[method] === true;
    const opensPath = method === "open";
    if (!readsPath && !opensPath) {
      return undefined;
    }
    const receiver = staticValueOf(callee.firstChild ?? node);
    if (receiver.kind !== "path") {
      return undefined;
    }
    if (opensPath) {
      const args = pyChildNamed(node, "ArgList");
      const mode = modeOfCall(args === undefined ? [] : pyArgumentGroups(args), 0);
      if (
        mode.kind !== "string" ||
        PYTHON_READ_ONLY_MODES[mode.value.trim().toLowerCase()] !== true
      ) {
        return undefined;
      }
    }
    return fileResource(receiver.value, cwd);
  };

  /**
   * Private identities of the read values one expression is derived from. An empty set is a proven
   * constant and `undefined` is an expression this walk does not track: neither is a derivation.
   */
  const originsOf = (node: PyNode): ReadonlySet<string> | undefined => {
    switch (node.name) {
      case "String":
      case "FormatString":
      case "Number":
      case "True":
      case "False":
      case "None":
        return EMPTY_ORIGINS;
      case "ParenthesizedExpression": {
        const inner = node.firstChild;
        return inner === null ? undefined : originsOf(inner);
      }
      case "VariableName":
        return origins.get(textOf(node));
      case "BinaryExpression": {
        const left = node.firstChild;
        const operator = left?.nextSibling ?? null;
        const right = operator?.nextSibling ?? null;
        if (left === null || operator === null || right === null) {
          return undefined;
        }
        // Arithmetic operators arrive wrapped (`ArithOp` around the token); only `+` concatenation
        // carries a value through. `or`/`and`, comparisons and the other arithmetic operators select
        // or compute something this walk cannot follow, so they prove nothing.
        if (operator.name !== "ArithOp" || textOf(operator) !== "+") {
          return undefined;
        }
        return unionOrigins(originsOf(left), originsOf(right));
      }
      case "CallExpression": {
        const callee = node.firstChild;
        if (callee === null) {
          return undefined;
        }
        const readResource = readResourceOf(node);
        if (readResource !== undefined) {
          return new Set([readResource.identity]);
        }
        const property = pyChildNamed(callee, "PropertyName");
        if (property === undefined || PYTHON_DERIVING_METHODS[textOf(property)] !== true) {
          return undefined;
        }
        const args = pyChildNamed(node, "ArgList");
        const groups = args === undefined ? [] : pyArgumentGroups(args);
        let result = originsOf(callee.firstChild ?? node);
        for (const group of groups) {
          const value = group[0];
          if (value !== undefined) {
            result = unionOrigins(result, originsOf(value));
          }
        }
        return result;
      }
      default:
        return undefined;
    }
  };

  const classifyMode = (mode: PyValue): "read" | "write" | "unknown" => {
    if (mode.kind !== "string") {
      return "unknown";
    }
    const normalized = mode.value.trim().toLowerCase().replace("+", "");
    if (PYTHON_READ_ONLY_MODES[normalized] === true) {
      return "read";
    }
    return /[wax]/.test(normalized) ? "write" : "unknown";
  };

  const recordRead = (rawPath: string | undefined): void => {
    const resource = rawPath === undefined ? undefined : fileResource(rawPath, cwd);
    if (resource === undefined) {
      // An unresolved receiver, or a relative path with no witnessed working directory.
      ambiguous = true;
      return;
    }
    reads.push(resource);
  };

  const recordWrite = (
    rawPath: string | undefined,
    payload: ReadonlySet<string> | undefined,
  ): void => {
    const resource = rawPath === undefined ? undefined : fileResource(rawPath, cwd);
    if (resource === undefined) {
      ambiguous = true;
      return;
    }
    if (payload !== undefined && payload.size > 0) {
      derivedWrites.push({ resource, origins: payload });
      return;
    }
    // A constant or untracked payload: the write is real, but it is not a derivation.
    structuralWrites.push(resource);
  };

  const shadow = (name: string): void => {
    bindings.set(name, UNKNOWN_VALUE);
    origins.delete(name);
    pathConstructorNames.delete(name);
    pathModuleAliases.delete(name);
  };

  const visit = (node: PyNode, inNestedScope: boolean, inConditionalFlow: boolean): void => {
    if (visited++ > PYTHON_NODE_BUDGET) {
      ambiguous = true;
      return;
    }
    const nested =
      inNestedScope ||
      node.name === "FunctionDefinition" ||
      node.name === "LambdaExpression" ||
      node.name === "ComprehensionExpression" ||
      node.name === "ArrayComprehensionExpression" ||
      node.name === "DictionaryComprehensionExpression";
    const conditional = inConditionalFlow || PYTHON_CONDITIONAL_STATEMENTS[node.name] === true;

    if (node.name === "ImportStatement") {
      const binding = parsePythonImportText(textOf(node));
      if (binding !== undefined) {
        for (const name of binding.names) {
          if (nested || conditional) {
            // An import that may not run (or runs in another scope) must not make a local name a
            // pathlib alias: at most it invalidates the alias the outer scope had.
            pathConstructorNames.delete(name);
            pathModuleAliases.delete(name);
            continue;
          }
          if (binding.module !== "pathlib") {
            continue;
          }
          if (binding.kind === "module") {
            pathModuleAliases.add(name);
          } else if (binding.members[name] === "Path") {
            pathConstructorNames.add(name);
          }
        }
      }
    }

    if (node.name === "String") {
      // A decoded value, so an escaped newline is a real line start and a raw literal is not.
      const literal = pyStringLiteral(source, node);
      if (literal !== undefined && CHECKLIST_MARKER.test(literal)) {
        checklist = true;
      }
    }

    if (node.name === "AssignStatement") {
      const operator = pyChildNamed(node, "AssignOp");
      const names: string[] = [];
      for (
        let child = node.firstChild;
        child !== null && child !== operator;
        child = child.nextSibling
      ) {
        if (child.name === "VariableName") {
          names.push(textOf(child));
        }
      }
      const value = operator === undefined ? null : operator.nextSibling;
      const resolved = value === null ? UNKNOWN_VALUE : staticValueOf(value);
      const valueOrigins = value === null ? undefined : originsOf(value);
      for (const name of names) {
        if (nested || conditional) {
          // A binding made by code that may never run (or runs in another scope) must not silently
          // rewrite an outer name: at most it invalidates it, so no later read claims this value.
          shadow(name);
          continue;
        }
        shadow(name);
        bindings.set(name, resolved);
        if (valueOrigins !== undefined) {
          origins.set(name, valueOrigins);
        }
      }
    }

    if (node.name === "ForStatement") {
      for (let child = node.firstChild; child !== null; child = child.nextSibling) {
        if (child.name === "in" || child.name === "Body") {
          break;
        }
        if (child.name === "VariableName") {
          shadow(textOf(child));
        }
      }
    }

    if (node.name === "WithStatement") {
      let afterAs = false;
      for (let child = node.firstChild; child !== null; child = child.nextSibling) {
        if (child.name === "as") {
          afterAs = true;
          continue;
        }
        if (child.name === ":" || child.name === "Body") {
          break;
        }
        if (afterAs && child.name === "VariableName") {
          // A bound file handle (or any other bound object) is not a tracked value.
          shadow(textOf(child));
        }
      }
    }

    if (node.name === "DeleteStatement") {
      for (let child = node.firstChild; child !== null; child = child.nextSibling) {
        if (child.name !== "VariableName") {
          continue;
        }
        const name = textOf(child);
        if (nested || conditional) {
          // A `del` that may not run invalidates the name instead of applying its effect.
          shadow(name);
          continue;
        }
        bindings.delete(name);
        origins.delete(name);
      }
    }

    if (node.name === "CallExpression") {
      const callee = node.firstChild;
      const args = pyChildNamed(node, "ArgList");
      const groups = args === undefined ? [] : pyArgumentGroups(args);
      const property = callee === null ? undefined : pyChildNamed(callee, "PropertyName");
      const method = property === undefined ? undefined : textOf(property);
      const readsPath = method !== undefined && PYTHON_PATH_READ_METHODS[method] === true;
      const writesPath = method !== undefined && PYTHON_PATH_WRITE_METHODS[method] === true;
      const opensPath = method === "open";

      if (readsPath || writesPath || opensPath) {
        if (nested || conditional) {
          ambiguous = true;
        } else {
          const receiver = staticValueOf(callee?.firstChild ?? node);
          if (receiver.kind === "unknown") {
            // An unresolved receiver could be any file: this frame's flow is not bounded.
            ambiguous = true;
          } else if (receiver.kind === "path") {
            if (readsPath) {
              recordRead(receiver.value);
            } else if (writesPath) {
              const payload = groups[0]?.[0];
              recordWrite(receiver.value, payload === undefined ? undefined : originsOf(payload));
            }
            // A `Path.open(...)` handle is neither tracked nor claimed.
          }
        }
      } else if (
        callee !== null &&
        callee.name === "VariableName" &&
        textOf(callee) === "open" &&
        !bindings.has("open")
      ) {
        if (nested || conditional) {
          ambiguous = true;
        } else {
          const target = groups[0];
          if (target === undefined || target.length !== 1) {
            // The path argument is missing, or is several literals this walk does not join.
            ambiguous = true;
          }
          const resolved =
            target === undefined || target.length !== 1 ? UNKNOWN_VALUE : staticValueOf(target[0]!);
          const rawPath = resolved.kind === "unknown" ? undefined : resolved.value;
          const mode = classifyMode(modeOfCall(groups, 1));
          if (mode === "unknown") {
            ambiguous = true;
          } else if (mode === "read") {
            recordRead(rawPath);
          } else {
            // A handle's payload is not tracked, so `open(..., "w")` stays a structural write.
            recordWrite(rawPath, undefined);
          }
        }
      }
    }

    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      visit(child, nested, conditional);
    }
  };

  visit(topNode, false, false);

  if (ambiguous) {
    return AMBIGUOUS_SCRIPT;
  }
  const distinct = (resources: readonly DeclaredResource[]): DeclaredResource[] => {
    const seen = new Set<string>();
    const result: DeclaredResource[] = [];
    for (const resource of resources) {
      if (seen.has(resource.identity)) {
        continue;
      }
      seen.add(resource.identity);
      result.push(resource);
    }
    return result;
  };

  const distinctReads = distinct(reads);
  if (derivedWrites.length > 0) {
    // A proven transform: the written payload is a value this frame read, so the two resources are
    // connected by the data flow and not merely by appearing in one program.
    const sourceIdentities = new Set<string>();
    for (const write of derivedWrites) {
      for (const identity of write.origins) {
        sourceIdentities.add(identity);
      }
    }
    const transformReads = distinctReads.filter((resource) =>
      sourceIdentities.has(resource.identity),
    );
    const transformWrites = distinct(derivedWrites.map((write) => write.resource));
    if (transformReads.length > 0 && transformWrites.length > 0) {
      return {
        status: "flow",
        flow: {
          operation: "file.transform",
          reads: transformReads,
          writes: transformWrites,
          inputs: [
            { name: "source", resource: transformReads[0]! },
            { name: "target", resource: transformWrites[0]! },
          ],
          contentKinds: checklist ? MARKDOWN_CHECKLIST : [],
          programOutput: true,
        },
      };
    }
  }
  if (distinctReads.length > 0) {
    return {
      status: "flow",
      flow: {
        operation: "file.read",
        reads: distinctReads,
        writes: [],
        inputs: [{ name: "subject", resource: distinctReads[0]! }],
        contentKinds: checklist ? MARKDOWN_CHECKLIST : [],
        programOutput: true,
      },
    };
  }
  const distinctWrites = distinct(structuralWrites);
  if (distinctWrites.length > 0) {
    return {
      status: "flow",
      flow: {
        operation: "file.write",
        reads: [],
        writes: distinctWrites,
        inputs: [{ name: "target", resource: distinctWrites[0]! }],
        contentKinds: checklist ? MARKDOWN_CHECKLIST : [],
        programOutput: true,
      },
    };
  }
  return { status: "none" };
}

/** Declared flow of the script frame an event carries, when exactly one frame is usable. */
function declaredFlowOfScriptFrames(
  event: NormalizedSessionEvent,
  cwd: string | undefined,
): DeclaredFlow | undefined {
  const frames = extractComputationSourceFrames(event, {}).filter(
    (frame) => frame.rejectionReason === undefined && frame.executionScope !== "file_observation",
  );
  if (frames.length !== 1) {
    // No authored program, or more than one: no single declared flow can be attributed.
    return undefined;
  }
  const frame = frames[0]!;
  if (frame.language !== "python" || frame.source.length === 0) {
    return undefined;
  }
  const analysis = analyzePythonScript(frame.source, cwd);
  return analysis.status === "flow" ? analysis.flow : undefined;
}

/**
 * Declared flow of one observed tool call, or undefined when the call declares nothing that can be
 * stated without guessing. A script frame wins over the command line it was recovered from, because
 * the frame is the authored program and the surrounding line adds no resolvable resource.
 */
export function declaredFlowOfToolCall(call: NormalizedToolCallEvent): DeclaredFlow | undefined {
  // A tool call witnesses no working directory, so its relative paths stay unresolvable.
  const scriptFlow = declaredFlowOfScriptFrames(call, undefined);
  if (scriptFlow !== undefined) {
    return scriptFlow;
  }
  const parameters = parametersOf(call);
  const fileTool = declaredFlowOfFileTool(call.toolName, parameters, undefined);
  if (fileTool !== undefined) {
    return fileTool;
  }
  const command = firstBoundedString(parameters.command, parameters.cmd);
  return command === undefined ? undefined : declaredFlowOfCommand(command);
}

/**
 * Declared flow of a self-contained `command_exec` event. Such an event observes a command and its
 * exit code together, so it is the only place where a command's own outcome is in scope.
 */
export function declaredFlowOfCommandExec(event: NormalizedSessionEvent): DeclaredFlow | undefined {
  if (event.type !== "command_exec") {
    return undefined;
  }
  const scriptFlow = declaredFlowOfScriptFrames(event, event.cwd);
  if (scriptFlow !== undefined) {
    return scriptFlow;
  }
  return declaredFlowOfCommand(event.command, event.cwd);
}
