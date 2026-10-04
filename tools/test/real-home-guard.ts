/**
 * Vitest setup: tests never write the real user's Resin home (`~/.resin`).
 *
 * `vitest.config.ts` points `HOME` at a throwaway directory, but code that resolves the home some
 * other way (`os.userInfo()`, a path cached before the override, an inherited `RESIN_HOME`, a
 * child started without `HOME`) would still reach the user's daemon state: catalog snapshots,
 * tools and invocations then show up in their real `state.db`. This setup resolves the real home
 * from the password database at worker start and:
 *
 * - wraps the path-taking `node:fs` mutators and `node:sqlite`'s `DatabaseSync` so a write or
 *   database open under a protected root throws, and fails the running test in `afterEach` even
 *   when the code under test swallowed the error;
 * - gives children started with an explicit `env` that names neither `HOME` nor `RESIN_HOME` the
 *   worker's `HOME`, so they do not fall back to the password-database home.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach } from "vitest";

const PATCHED = Symbol.for("resin.test.realHomeGuardPatched");

function protectedRoots(): string[] {
  const roots = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate?.trim()) return;
    const resolved = path.resolve(candidate);
    roots.add(resolved);
    try {
      roots.add(fs.realpathSync.native(resolved));
    } catch {
      // A root that does not exist yet is still protected by its resolved spelling.
    }
  };
  add(path.join(os.userInfo().homedir, ".resin"));
  // A RESIN_HOME inherited from the developer's shell is their installation too.
  add(process.env.RESIN_HOME);
  return [...roots];
}

/** The real user's Resin roots this worker refuses to write. */
export const REAL_RESIN_ROOTS: readonly string[] = protectedRoots();

const violations: string[] = [];

function toPathString(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (value.startsWith("file:")) {
      try {
        return fileURLToPath(new URL(value.split("?")[0] ?? value));
      } catch {
        return undefined;
      }
    }
    return value;
  }
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

/** Returns the protected root `candidate` falls under, if any. */
export function realResinRootFor(candidate: unknown): string | undefined {
  const raw = toPathString(candidate);
  if (raw === undefined || raw === "" || raw === ":memory:") return undefined;
  const resolved = path.resolve(raw);
  return REAL_RESIN_ROOTS.find(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
}

function guardError(operation: string, target: unknown): Error | undefined {
  if (realResinRootFor(target) === undefined) return undefined;
  const message = `Test touched the real user Resin home: ${operation} ${toPathString(target)}. Point HOME/RESIN_HOME (or pass an explicit path/store) at a temp directory.`;
  violations.push(message);
  return new Error(message);
}

/** Drains the violations recorded since the last call; the guard's own tests use it. */
export function takeRealHomeViolations(): string[] {
  return violations.splice(0);
}

const WRITE_FLAGS = /[wa+]/;
const WRITE_MODE_BITS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  fs.constants.O_APPEND;

function opensForWrite(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & WRITE_MODE_BITS) !== 0;
  return typeof flags === "string" && WRITE_FLAGS.test(flags);
}

type AnyFunction = (...args: unknown[]) => unknown;

/** Indexes of the path arguments each mutator writes through. */
const MUTATORS: Record<string, readonly number[]> = {
  appendFile: [0],
  chmod: [0],
  chown: [0],
  copyFile: [1],
  cp: [1],
  lchown: [0],
  link: [1],
  lutimes: [0],
  mkdir: [0],
  mkdtemp: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  symlink: [1],
  truncate: [0],
  unlink: [0],
  utimes: [0],
  writeFile: [0],
};

function violationFor(name: string, args: readonly unknown[]): Error | undefined {
  if (name === "open") {
    return opensForWrite(args[1] ?? "r") ? guardError(name, args[0]) : undefined;
  }
  if (name === "createWriteStream") {
    const options = args[1];
    const flags =
      options !== null && typeof options === "object" && "flags" in options ? options.flags : "w";
    return opensForWrite(flags ?? "w") ? guardError(name, args[0]) : undefined;
  }
  for (const index of MUTATORS[name] ?? []) {
    const error = guardError(name, args[index]);
    if (error) return error;
  }
  return undefined;
}

function wrapSync(target: object, name: string): void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== "function") return;
  const fn = original as AnyFunction;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const error = violationFor(name.replace(/Sync$/, ""), args);
    if (error) throw error;
    return fn.apply(this, args);
  };
  const custom: unknown = Reflect.get(fn, promisify.custom);
  if (typeof custom === "function") {
    Object.defineProperty(wrapped, promisify.custom, { value: custom });
  }
  Object.defineProperty(wrapped, "name", { value: name });
  Reflect.set(target, name, wrapped);
}

function wrapPromise(target: object, name: string): void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== "function") return;
  const fn = original as AnyFunction;
  Reflect.set(target, name, function (this: unknown, ...args: unknown[]) {
    const error = violationFor(name, args);
    if (error) return Promise.reject(error);
    return fn.apply(this, args);
  });
}

function wrapDatabaseSync(): void {
  // Fetched without an import so this file never caches a `node:sqlite` resolution for the
  // runner before the hook below exists.
  const sqlite = process.getBuiltinModule("node:sqlite");
  const Guarded = new Proxy(sqlite.DatabaseSync, {
    construct(target, args, newTarget) {
      const error = guardError("DatabaseSync", args[0]);
      if (error) throw error;
      return Reflect.construct(target, args, newTarget);
    },
  });
  Reflect.set(sqlite, "DatabaseSync", Guarded);
  // `syncBuiltinESMExports` does not refresh `node:sqlite`'s named exports, so later imports of
  // it resolve to a module that re-exports the patched module object.
  const shim = new URL("./guarded-sqlite.mjs", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:sqlite" && context.parentURL !== shim) {
        return { url: shim, format: "module", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

/** Returns `args` with the worker's `HOME` added to an explicit `env` that names no home. */
export function withIsolatedHome(args: readonly unknown[]): unknown[] {
  const next = [...args];
  const home = process.env.HOME;
  if (!home) return next;
  for (let index = 1; index < next.length; index += 1) {
    const candidate = next[index];
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const env: unknown = "env" in candidate ? candidate.env : undefined;
    if (
      env !== null &&
      typeof env === "object" &&
      !["HOME", "USERPROFILE", "RESIN_HOME"].some((key) => Object.hasOwn(env, key))
    ) {
      next[index] = { ...candidate, env: { ...env, HOME: home } };
    }
    break;
  }
  return next;
}

function wrapChild(name: string): void {
  const original: unknown = Reflect.get(childProcess, name);
  if (typeof original !== "function") return;
  const target = original as AnyFunction;
  const wrapped: AnyFunction = (...args) => target(...withIsolatedHome(args));
  const custom: unknown = Reflect.get(target, promisify.custom);
  if (typeof custom === "function") {
    const customTarget = custom as AnyFunction;
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]) => customTarget(...withIsolatedHome(args)),
    });
  }
  Reflect.set(childProcess, name, wrapped);
}

if (!Reflect.get(fs, PATCHED)) {
  for (const name of [...Object.keys(MUTATORS), "open", "createWriteStream"]) {
    wrapSync(fs, name);
    wrapSync(fs, `${name}Sync`);
    wrapPromise(fs.promises, name);
  }
  wrapDatabaseSync();
  for (const name of [
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
    "fork",
  ]) {
    wrapChild(name);
  }
  Reflect.set(fs, PATCHED, true);
  // Named ESM imports (`import { writeFileSync } from "node:fs"`) see the wrappers too.
  syncBuiltinESMExports();
}

afterEach(() => {
  const recorded = takeRealHomeViolations();
  if (recorded.length > 0) {
    throw new Error(`Real Resin home was touched during this test:\n${recorded.join("\n")}`);
  }
});
