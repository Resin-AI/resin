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
