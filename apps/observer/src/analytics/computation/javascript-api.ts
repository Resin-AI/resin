import type { ComputationApi } from "@resin/contracts";

/**
 * Finite canonical API vocabulary for JavaScript/TypeScript source.
 *
 * These tables are the ONLY bridge from real JavaScript syntax to the language-neutral
 * `COMPUTATION_APIS` vocabulary: a call that is not resolvable through them is emitted as an
 * `unsupported` node instead of being guessed. Nothing here is an authority grant, and no table
 * carries a source-level identifier beyond the finite spelling of a standard library entry point.
 *
 * The grammar is intentionally conservative: a method is mapped by name alone, because the IR has no
 * static types. The receiver travels in `call.receiver`, so a consumer can still see which value the
 * method was invoked on, and equal names that mean different things across collection/string
 * receivers (for example `collection.filter` and `string.replace`) stay distinct in the vocabulary.
 */

/** `instance.method(...)` — method names invoked on an arbitrary receiver. */
export const JAVASCRIPT_INSTANCE_CALL_APIS: Readonly<Record<string, ComputationApi>> = {
  all: "collection.all",
  any: "collection.any",
  add: "collection.set_add",
  concat: "collection.extend",
  count: "collection.count",
  delete: "collection.delete",
  endsWith: "string.endswith",
  entries: "collection.entries",
  every: "collection.all",
  filter: "collection.filter",
  find: "collection.find",
  get: "collection.get",
  has: "collection.has",
  includes: "collection.includes",
  join: "collection.join",
  keys: "collection.keys",
  lower: "string.lower",
  map: "collection.map",
  max: "collection.max",
  min: "collection.min",
  pop: "collection.pop",
  push: "collection.append",
  reduce: "collection.reduce",
  replace: "string.replace",
  replaceAll: "string.replace",
  reverse: "collection.reverse",
  set: "collection.map_set",
  slice: "collection.slice",
  some: "collection.any",
  sort: "collection.sort",
  split: "string.split",
  startsWith: "string.startswith",
  substring: "string.slice",
  substr: "string.slice",
  toFixed: "number.to_fixed",
  toISOString: "clock.iso_format",
  toLowerCase: "string.lower",
  toString: "core.to_string" as ComputationApi,
  toUpperCase: "string.upper",
  trim: "string.strip",
  trimEnd: "string.rstrip",
  trimStart: "string.lstrip",
  values: "collection.values",
};

/** Methods that are only meaningful on a regular-expression receiver; handled explicitly. */
export const JAVASCRIPT_REGEX_METHOD_APIS: Readonly<Record<string, ComputationApi>> = {
  exec: "text.regex_search",
  test: "text.regex_test",
};

/** String methods whose regular-expression overload is still the same finite API. */
export const JAVASCRIPT_REGEX_ARGUMENT_METHOD_APIS: Readonly<Record<string, ComputationApi>> = {
  match: "text.regex_match",
  matchAll: "text.regex_match",
  search: "text.regex_search",
};

/** `Namespace.member(...)` — a call through a finite standard namespace. */
export const JAVASCRIPT_STATIC_CALL_APIS: Readonly<Record<string, ComputationApi>> = {
  "Array.isArray": "type.is_array",
  "Date.now": "clock.now",
  "Date.parse": "clock.parse",
  "JSON.parse": "json.parse",
  "JSON.stringify": "json.serialize",
  "Math.abs": "number.abs",
  "Math.ceil": "number.ceil",
  "Math.floor": "number.floor",
  "Math.max": "number.max",
  "Math.min": "number.min",
  "Math.round": "number.round",
  "Number.isFinite": "number.is_finite",
  "Number.isInteger": "number.is_integer",
  "Number.parseFloat": "number.parse",
  "Number.parseInt": "number.parse",
  "Object.entries": "collection.entries",
  "Object.hasOwn": "object.has_own",
  "Object.keys": "collection.keys",
  "Object.values": "collection.values",
  "console.debug": "core.print",
  "console.error": "core.print",
  "console.info": "core.print",
  "console.log": "core.print",
  "console.warn": "core.print",
};

/** Bare global conversion/parsing functions. */
export const JAVASCRIPT_GLOBAL_FUNCTION_APIS: Readonly<Record<string, ComputationApi>> = {
  Number: "number.parse",
  String: "core.to_string",
  parseFloat: "number.parse",
  parseInt: "number.parse",
};

/** `new Name(...)` — only constructor-shaped canonical APIs are constructible. */
export const JAVASCRIPT_CONSTRUCTOR_APIS: Readonly<Record<string, ComputationApi>> = {
  Array: "construct.array",
  Date: "construct.date",
  Error: "construct.error",
  Map: "construct.map",
  Object: "construct.object",
  Set: "construct.set",
};

/** Standard namespaces that are readable as finite externals rather than unresolved data. */
export const JAVASCRIPT_GLOBAL_NAMESPACES: readonly string[] = [
  "Array",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "Reflect",
  "Set",
  "String",
  "console",
  "globalThis",
  "process",
];

const GLOBAL_NAMESPACE_LOOKUP: Readonly<Record<string, true>> = Object.fromEntries(
  JAVASCRIPT_GLOBAL_NAMESPACES.map((name) => [name, true] as const),
);

/**
 * Standard modules whose finite member functions map onto canonical APIs. `node:`-prefixed and bare
 * spellings both normalize here, and an unknown member of a known module stays unsupported rather
 * than being guessed.
 */
export const JAVASCRIPT_BUILTIN_MODULE_APIS: Readonly<
  Record<string, Readonly<Record<string, ComputationApi>>>
> = {
  crypto: {
    createHash: "core.hash",
    randomUUID: "core.hash",
  },
  fs: {
    existsSync: "fs.exists",
    readFileSync: "fs.read_text",
    readdirSync: "fs.read_lines",
    writeFileSync: "fs.write_text",
  },
  "fs/promises": {
    readFile: "fs.read_text",
    writeFile: "fs.write_text",
  },
  path: {
    basename: "path.basename",
    dirname: "path.dirname",
    extname: "path.extname",
    join: "path.join",
    normalize: "path.normalize",
    resolve: "path.join",
  },
};

/**
 * Normalizes a module specifier to its finite standard-module key, or `undefined` when the module is
 * not a recognized standard library (`node:fs` and `fs` both normalize to `fs`).
 */
export function normalizeBuiltinModule(specifier: string): string | undefined {
  const trimmed = specifier.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return undefined;
  }
  const bare = trimmed.startsWith("node:") ? trimmed.slice("node:".length) : trimmed;
  if (bare.startsWith("@") || bare.includes("/") === false) {
    return Object.prototype.hasOwnProperty.call(JAVASCRIPT_BUILTIN_MODULE_APIS, bare)
      ? bare
      : undefined;
  }
  // Scoped/subpath module specifiers are not part of the finite table.
  return Object.prototype.hasOwnProperty.call(JAVASCRIPT_BUILTIN_MODULE_APIS, bare)
    ? bare
    : undefined;
}

/** Finite member APIs of a recognized standard module, or `undefined` when it is not recognized. */
export function builtinModuleApis(
  specifier: string,
): Readonly<Record<string, ComputationApi>> | undefined {
  const key = normalizeBuiltinModule(specifier);
  return key === undefined ? undefined : JAVASCRIPT_BUILTIN_MODULE_APIS[key];
}

/** Finite member API of a standard module, or `undefined` when the member is not recognized. */
export function builtinModuleMemberApi(
  specifier: string,
  member: string,
): ComputationApi | undefined {
  const apis = builtinModuleApis(specifier);
  return apis === undefined ? undefined : apis[member];
}

/** `Namespace.member` static call API, or `undefined` when it is not a finite standard call. */
export function staticCallApi(qualifiedName: string): ComputationApi | undefined {
  return JAVASCRIPT_STATIC_CALL_APIS[qualifiedName];
}

/** Instance-style method API, or `undefined` when the method is not in the finite vocabulary. */
export function instanceCallApi(methodName: string): ComputationApi | undefined {
  return JAVASCRIPT_INSTANCE_CALL_APIS[methodName];
}

/** Regular-expression-only method API (`regex.test(...)`, `regex.exec(...)`). */
export function regexMethodApi(methodName: string): ComputationApi | undefined {
  return JAVASCRIPT_REGEX_METHOD_APIS[methodName];
}

/** String method API whose argument may be a regular expression (`text.match(...)`, `text.search(...)`). */
export function regexArgumentMethodApi(methodName: string): ComputationApi | undefined {
  return JAVASCRIPT_REGEX_ARGUMENT_METHOD_APIS[methodName];
}

/** Bare global function API (`parseInt`, `String`, ...), or `undefined`. */
export function globalFunctionApi(name: string): ComputationApi | undefined {
  return JAVASCRIPT_GLOBAL_FUNCTION_APIS[name];
}

/** Constructor API for `new Name(...)`, or `undefined` when construction is not finite. */
export function constructorApi(name: string): ComputationApi | undefined {
  return JAVASCRIPT_CONSTRUCTOR_APIS[name];
}

/** True for a finite standard namespace whose reads are modeled as externals, not as data slots. */
export function isKnownGlobalNamespace(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GLOBAL_NAMESPACE_LOOKUP, name);
}
