import type { ComputationApi } from "@resin/contracts";

/**
 * Finite Python-callable vocabulary for the computation parser.
 *
 * Every table maps one *ordinary* Python spelling onto a canonical `COMPUTATION_APIS` member. The
 * tables are deliberately finite and closed: a `python*Api` lookup returning `undefined` means the
 * parser must fail closed with an `unsupported` node instead of guessing, so a dynamic, private or
 * merely similar-looking callable can never be laundered into the canonical evidence vocabulary.
 * Aliasing two materially different operations is forbidden, which is why e.g. `str.index` (raises)
 * and `os.path.splitext` (returns a pair) stay unmapped while `str.find` and `os.path.basename` map.
 *
 * No value ever travels through this module: it only returns canonical API names. Python spellings
 * remain in the parser's private local bookkeeping and never reach the wire program.
 */

/**
 * Canonical API names this module can return.
 *
 * `string.isalpha` is the Main-approved vocabulary addition for `str.isalpha()` (added to
 * `COMPUTATION_APIS` by the contract owner); listing it here keeps the mapping complete once the
 * canonical vocabulary carries it, without pretending the operation is something else.
 */
export type PythonApiName = ComputationApi | "string.isalpha";

/** Python builtins that are a plain function call with a canonical transform/utility meaning. */
const PYTHON_BUILTIN_APIS: Readonly<Record<string, PythonApiName>> = {
  abs: "number.abs",
  all: "collection.all",
  any: "collection.any",
  filter: "collection.filter",
  float: "number.float",
  hash: "core.hash",
  int: "number.int",
  isinstance: "type.is_instance",
  iter: "collection.iterator",
  len: "core.len",
  map: "collection.map",
  max: "number.max",
  min: "number.min",
  next: "collection.next",
  print: "core.print",
  range: "collection.range",
  reversed: "collection.reverse",
  round: "number.round",
  sorted: "collection.sort",
  str: "core.to_string",
  sum: "collection.sum",
  type: "core.type_of",
  zip: "collection.zip",
};

/**
 * Builtins that CONSTRUCT a value. They are lowered to a `new` node, so the canonical vocabulary's
 * constructor-eligible subset is what a Python constructor call can select.
 */
const PYTHON_CONSTRUCTOR_APIS: Readonly<Record<string, PythonApiName>> = {
  dict: "construct.map",
  list: "construct.array",
  object: "construct.object",
  set: "construct.set",
};

/**
 * Methods with one canonical meaning across the builtin container/string types that carry them.
 * A method spelled differently for a different operation (`str.index` vs `str.find`,
 * `dict.update` vs `list.extend`) is intentionally absent so the call fails closed, and the file
 * handle read methods are absent too: they are only lowered for a handle this frame itself resolved
 * from a read-only `open(...)`.
 */
const PYTHON_METHOD_APIS: Readonly<Record<string, PythonApiName>> = {
  add: "collection.set_add",
  append: "collection.append",
  count: "collection.count",
  endswith: "string.endswith",
  extend: "collection.extend",
  find: "string.find",
  format: "string.format",
  get: "collection.get",
  is_integer: "number.is_integer",
  isalpha: "string.isalpha",
  items: "collection.items",
  join: "string.join",
  keys: "collection.keys",
  lower: "string.lower",
  lstrip: "string.lstrip",
  pop: "collection.pop",
  replace: "string.replace",
  reverse: "collection.reverse",
  rsplit: "string.rsplit",
  rstrip: "string.rstrip",
  setdefault: "collection.dict_setdefault",
  sort: "collection.sort",
  split: "string.split",
  startswith: "string.startswith",
  strip: "string.strip",
  upper: "string.upper",
  values: "collection.values",
};

/**
 * Read semantics of one resolved, read-only local file resource. Only a handle this frame itself
 * bound from a verified read-only `open(...)` may use these; an unresolved or cross-cell handle
 * stays unsupported, and no arbitrary mode is ever claimed as read-only.
 */
const PYTHON_FILE_HANDLE_APIS: Readonly<Record<string, PythonApiName>> = {
  close: "fs.close",
  read: "fs.read_text",
  readline: "fs.read_line",
  readlines: "fs.read_lines",
};

/** Canonical static methods on builtin types, emitted only when builtin identity is unshadowed. */
const PYTHON_BUILTIN_MEMBER_APIS: Readonly<
  Record<string, Readonly<Record<string, PythonApiName>>>
> = {
  bytes: {
    fromhex: "bytes.from_hex",
  },
};

/** A finite static method on a known builtin type, or `undefined` if none is cataloged. */
export function pythonBuiltinMemberApi(
  typeName: string,
  member: string,
): PythonApiName | undefined {
  return PYTHON_BUILTIN_MEMBER_APIS[typeName]?.[member];
}

/** True when the builtin type has statically modeled methods. */
export function isPythonBuiltinType(name: string): boolean {
  return Object.hasOwn(PYTHON_BUILTIN_MEMBER_APIS, name);
}

/**
 * Members of recognized standard-library modules whose meaning is exactly one canonical API.
 * Only these modules are recognized at all; an unrecognized module never contributes a wire node,
 * so a private module path cannot leak through the program.
 */
const PYTHON_MODULE_APIS: Readonly<Record<string, Readonly<Record<string, PythonApiName>>>> = {
  pathlib: {
    Path: "construct.path",
  },
  builtins: PYTHON_BUILTIN_APIS,
  collections: {
    OrderedDict: "construct.map",
  },
  csv: {
    DictReader: "csv.parse_records",
    reader: "csv.parse_records",
  },
  datetime: {
    fromisoformat: "clock.parse",
    now: "clock.now",
    utcnow: "clock.now",
  },
  functools: {
    reduce: "collection.reduce",
  },
  itertools: {
    groupby: "collection.group_by",
  },
  json: {
    dumps: "json.serialize",
    load: "fs.read_json",
    loads: "json.parse",
  },
  math: {
    ceil: "number.ceil",
    fabs: "number.abs",
    floor: "number.floor",
    isfinite: "number.is_finite",
  },
  "os.path": {
    basename: "path.basename",
    dirname: "path.dirname",
    exists: "fs.exists",
    join: "path.join",
    normalize: "path.normalize",
  },
  re: {
    compile: "text.regex_compile",
    findall: "text.regex_findall",
    fullmatch: "text.regex_test",
    match: "text.regex_match",
    search: "text.regex_search",
    sub: "text.regex_replace",
  },
  time: {
    monotonic: "clock.monotonic",
    perf_counter: "clock.monotonic",
    time: "clock.now",
  },
};

/**
 * Reflection and dynamic-evaluation builtins. They are never a finite API: a call must become an
 * `unsupported` node so no dynamic behaviour is guessed.
 */
const PYTHON_REFLECTION_NAMES: Readonly<Record<string, true>> = {
  __import__: true,
  breakpoint: true,
  compile: true,
  delattr: true,
  dir: true,
  eval: true,
  exec: true,
  getattr: true,
  globals: true,
  hasattr: true,
  input: true,
  locals: true,
  memoryview: true,
  setattr: true,
  super: true,
  vars: true,
};

/**
 * Names whose call mutates interpreter/module state the parser cannot model. A frame containing one
 * is not a pure additive definition set, so the recorder must treat previously cached bindings as
 * invalidated.
 */
const PYTHON_NAMESPACE_MUTATOR_NAMES: Readonly<Record<string, true>> = {
  __import__: true,
  compile: true,
  delattr: true,
  eval: true,
  exec: true,
  globals: true,
  locals: true,
  setattr: true,
  vars: true,
};

/** Python `open` modes that are unambiguously read-only. Anything else is never claimed as a read. */
const PYTHON_READ_ONLY_OPEN_MODES: Readonly<Record<string, true>> = {
  r: true,
  rb: true,
  rt: true,
};

/** Builtin function spelling to canonical API, or `undefined` when it is not a finite operation. */
export function pythonBuiltinApi(name: string): PythonApiName | undefined {
  return PYTHON_BUILTIN_APIS[name];
}

/** Builtin constructor spelling to a `construct.*` canonical API, or `undefined`. */
export function pythonConstructorApi(name: string): PythonApiName | undefined {
  return PYTHON_CONSTRUCTOR_APIS[name];
}

/** Method spelling to canonical API, or `undefined` when the operation has no finite meaning. */
export function pythonMethodApi(name: string): PythonApiName | undefined {
  return PYTHON_METHOD_APIS[name];
}

/** Read API of one resolved read-only file handle, or `undefined` for any other method. */
export function pythonFileHandleApi(name: string): PythonApiName | undefined {
  return PYTHON_FILE_HANDLE_APIS[name];
}

/** Recognized standard-library member to canonical API, or `undefined`. */
export function pythonModuleApi(modulePath: string, member: string): PythonApiName | undefined {
  return PYTHON_MODULE_APIS[modulePath]?.[member];
}

/** True when the spelling is a recognized standard-library module. */
export function isPythonModule(modulePath: string): boolean {
  return Object.prototype.hasOwnProperty.call(PYTHON_MODULE_APIS, modulePath);
}

/** True when the builtin performs reflection or dynamic evaluation. */
export function isPythonReflectionName(name: string): boolean {
  return PYTHON_REFLECTION_NAMES[name] === true;
}

/** True when the builtin can mutate module/interpreter state the parser cannot represent. */
export function isPythonNamespaceMutatorName(name: string): boolean {
  return PYTHON_NAMESPACE_MUTATOR_NAMES[name] === true;
}

/** True only for an `open(...)` mode that is provably read-only. */
export function isPythonReadOnlyOpenMode(mode: string): boolean {
  return PYTHON_READ_ONLY_OPEN_MODES[mode.trim().toLowerCase()] === true;
}

/**
 * How one previously observed import statement binds its local names.
 *
 * `kind: "module"` means every bound name is a module alias (`import json as _json`, `import os.path`);
 * `kind: "member"` means the names are imported members of one module (`from json import loads`).
 * `members` maps a bound local name back to the member it was imported from, so an aliased member
 * still resolves to the member it names.
 */
export interface PythonImportBinding {
  readonly module: string;
  readonly kind: "member" | "module";
  readonly names: readonly string[];
  readonly members: Readonly<Record<string, string>>;
}

function splitImportList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse one previously observed `import`/`from` statement text into its local bindings.
 *
 * This is used only for `context.imports` entries, which arrive as source text; the parser reads
 * its own frame's imports from the syntax tree. Anything that does not match an ordinary bounded
 * import form returns `undefined` so the caller fails closed.
 */
export function parsePythonImportText(source: string): PythonImportBinding | undefined {
  const text = source.trim().replace(/\s+/g, " ");
  const fromMatch = /^from ([A-Za-z_][A-Za-z0-9_.]*) import (.+)$/.exec(text);
  if (fromMatch !== null) {
    const module = fromMatch[1];
    const names: string[] = [];
    const members: Record<string, string> = {};
    for (const part of splitImportList(fromMatch[2])) {
      if (part === "*") {
        return undefined;
      }
      const aliased = /^([A-Za-z_][A-Za-z0-9_]*)(?: as ([A-Za-z_][A-Za-z0-9_]*))?$/.exec(part);
      if (aliased === null) {
        return undefined;
      }
      const bound = aliased[2] ?? aliased[1];
      names.push(bound);
      members[bound] = aliased[1];
    }
    return names.length === 0 ? undefined : { kind: "member", module, names, members };
  }
  const importMatch = /^import (.+)$/.exec(text);
  if (importMatch === null) {
    return undefined;
  }
  const names: string[] = [];
  const members: Record<string, string> = {};
  for (const part of splitImportList(importMatch[1])) {
    const aliased = /^([A-Za-z_][A-Za-z0-9_.]*)(?: as ([A-Za-z_][A-Za-z0-9_]*))?$/.exec(part);
    if (aliased === null) {
      return undefined;
    }
    const modulePath = aliased[1];
    const bound = aliased[2] ?? modulePath.split(".")[0];
    names.push(bound);
    members[bound] = modulePath;
  }
  return names.length === 0 ? undefined : { module: names[0], kind: "module", names, members };
}

/** The single-character escapes whose value Python defines exactly. */
const PYTHON_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** Prefixes whose literal is a plain or unicode TEXT value (raw ones skip escape processing). */
const PYTHON_TEXT_PREFIXES: Readonly<Record<string, { raw: boolean }>> = {
  "": { raw: false },
  u: { raw: false },
  r: { raw: true },
  ru: { raw: true },
  ur: { raw: true },
};

/** True when the delimiter occurs inside the body without being escaped by a backslash run. */
function containsUnescapedDelimiter(body: string, delimiter: string): boolean {
  if (delimiter.length === 0) {
    return false;
  }
  for (let index = 0; index + delimiter.length <= body.length; index++) {
    if (!body.startsWith(delimiter, index)) {
      continue;
    }
    let backslashes = 0;
    for (let back = index - 1; back >= 0 && body[back] === "\\"; back--) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return true;
    }
  }
  return false;
}

function decodePythonEscapes(body: string): string | undefined {
  if (!body.includes("\\")) {
    return body;
  }
  let decoded = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) {
      return undefined;
    }
    if (escaped === "\n") {
      // A line continuation inside a literal contributes nothing.
      index += 1;
      continue;
    }
    const simple = PYTHON_SIMPLE_ESCAPES[escaped];
    if (simple !== undefined) {
      decoded += simple;
      index += 1;
      continue;
    }
    if (escaped === "x" || escaped === "u" || escaped === "U") {
      const width = escaped === "x" ? 2 : escaped === "u" ? 4 : 8;
      const digits = body.slice(index + 2, index + 2 + width);
      if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) {
        return undefined;
      }
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) {
        return undefined;
      }
      decoded += String.fromCodePoint(codePoint);
      index += 1 + width;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1))?.[0];
      if (octal === undefined) {
        return undefined;
      }
      decoded += String.fromCodePoint(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    // An escape this decoder does not fully define (`\N{...}`, an escaped space, an unknown letter)
    // is refused: a caller must never reason about an approximated value.
    return undefined;
  }
  return decoded;
}

/**
 * Decode one Python string literal's VALUE with a closed escape set, without evaluating anything.
 *
 * The literal kind is decided by its prefix: a plain or `u` literal has its escapes decoded, a raw
 * (`r`/`ur`/`ru`) literal keeps every backslash as written, and every other prefix (bytes,
 * f-string, anything unknown) returns `undefined` because its value is not a static text value. An
 * escape this decoder does not define exactly — `\N{...}`, an escaped space, an unknown letter, a
 * truncated `\x`/`\u`/`\U` — also returns `undefined`, so no caller ever sees an approximated string.
 */
export function decodePythonStringLiteral(text: string): string | undefined {
  const match = /^([A-Za-z]{0,2})("""|'''|"|')([\s\S]*)\2$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const prefix = (match[1] ?? "").toLowerCase();
  const body = match[3] ?? "";
  if (containsUnescapedDelimiter(body, match[2] ?? "")) {
    // The text is not one literal (`'a' 'b'` is implicit concatenation): refuse rather than
    // decode a value the interpreter never produced.
    return undefined;
  }
  const kind = PYTHON_TEXT_PREFIXES[prefix];
  if (kind === undefined) {
    return undefined;
  }
  if (!kind.raw) {
    return decodePythonEscapes(body);
  }
  // A raw literal keeps its backslashes, but an odd trailing run would mean the closing quote was
  // escaped and the literal does not end where it looks like it does.
  const trailing = /\\+$/.exec(body)?.[0].length ?? 0;
  return trailing % 2 === 1 ? undefined : body;
}
