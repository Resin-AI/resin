/**
 * Deno entrypoint that runs one derivation in Pyodide. It is never imported by Node: the derivation
 * runner starts it as `deno run <this file> <pyodide directory> <pyodide.mjs URL>` with read access
 * to that directory
 * alone, writes the request to stdin, and reads the single result line tagged with the request's
 * nonce from stdout. The nonce stays in this module's scope, which Python cannot reach, so a
 * derivation cannot forge the result line; anything else it prints is ignored.
 */

interface DenoRuntime {
  args: string[];
  stdin: { readable: ReadableStream<Uint8Array> };
  stdout: { writeSync(data: Uint8Array): number };
  exit(code: number): never;
}
interface PyodideRuntime {
  registerJsModule(name: string, module: object): void;
  globals: { get(name: string): (...args: unknown[]) => unknown };
  runPython(code: string): unknown;
}
declare const Deno: DenoRuntime;

interface DerivationRequest {
  nonce: string;
  source: string;
  modules: string[];
  optionalModules: string[];
  maxOutputBytes: number;
}

const WRAPPER = `
import ast as _ast
import builtins as _builtins
import json as _json
import sys as _sys
import __future__ as _future

def _resin_run(source, allowed, optional, limit, refuse):
    real_import = _builtins.__import__
    for name in allowed:
        real_import(name)
    for name in optional:
        try:
            real_import(name)
        except Exception:
            pass
    modules = _sys.modules
    importable = frozenset(n for n in list(allowed) + list(optional) if n in modules)
    packages = tuple(n + '.' for n in optional if n in importable)

    def derivation_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0 or not (name in importable or (name.startswith(packages) and name in modules)):
            refuse('import ' + str(name))
            raise ImportError('derivation refused: import ' + str(name))
        return real_import(name, globals, locals, fromlist, level)

    builtins = dict(_builtins.__dict__)
    builtins['__import__'] = derivation_import
    namespace = {'__name__': '__main__', '__builtins__': builtins}
    tree = _ast.parse(source, '<resin-derivation>', 'exec')
    body = tree.body
    last = body[-1] if body and isinstance(body[-1], _ast.Expr) else None
    if last is not None:
        tree.body = body[:-1]
    _ast.fix_missing_locations(tree)
    body_code = compile(tree, '<resin-derivation>', 'exec', dont_inherit=True)
    mask = 0
    for feature in _future.all_feature_names:
        mask |= getattr(_future, feature).compiler_flag
    exec(body_code, namespace, namespace)
    if last is None:
        return None
    expression = _ast.Expression(body=last.value)
    _ast.fix_missing_locations(expression)
    code = compile(expression, '<resin-derivation-result>', 'eval', flags=body_code.co_flags & mask, dont_inherit=True)
    result = eval(code, namespace, namespace)
    if result is None:
        return None
    text = _json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(text.encode('utf-8')) > limit:
        raise ValueError('the derivation result exceeds its output bound')
    return text
`;

// Captured before any derivation code runs: Python reaches this isolate's globals through
// Pyodide's JavaScript bridge, and must not be able to redefine how the result is reported.
const encode = TextEncoder.prototype.encode.bind(new TextEncoder());
const stringify = JSON.stringify;
const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
const exit = Deno.exit.bind(Deno);
const subarray = Function.prototype.call.bind(Uint8Array.prototype.subarray) as (
  bytes: Uint8Array,
  start: number,
) => Uint8Array;
const request = JSON.parse(await new Response(Deno.stdin.readable).text()) as DerivationRequest;
const { nonce } = request;
const emit = (frame: object): never => {
  const line = encode(`${nonce}${stringify(frame)}\n`);
  for (let offset = 0; offset < line.length; ) {
    offset += writeSync(subarray(line, offset));
  }
  return exit(0);
};

let refused: string | undefined;
try {
  const [indexURL, moduleURL] = Deno.args as [string, string];
  // The pinned Pyodide lives wherever the runner found it, so its module URL is only known here.
  const { loadPyodide } = (await import(moduleURL)) as {
    loadPyodide(options: object): Promise<PyodideRuntime>;
  };
  const discard = { batched: () => {} };
  const pyodide = await loadPyodide({
    indexURL,
    stdout: discard.batched,
    stderr: discard.batched,
    packages: [],
  });
  pyodide.runPython(WRAPPER);
  const run = pyodide.globals.get("_resin_run");
  const result = run(
    request.source,
    request.modules,
    request.optionalModules,
    request.maxOutputBytes,
    (what: string) => {
      refused ??= what;
    },
  );
  if (refused !== undefined) emit({ error: `derivation refused: ${refused}` });
  emit({ result: typeof result === "string" ? result : null });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ error: refused !== undefined ? `derivation refused: ${refused}` : message });
}
export {};
