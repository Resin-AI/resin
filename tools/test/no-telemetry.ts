/**
 * Vitest setup: tests never send error reports or usage events.
 *
 * `vitest.config.ts` sets `DO_NOT_TRACK=1` in every test worker, so children that inherit the
 * environment are opted out. Many tests start installers, the CLI, the daemon or packaged
 * binaries with a constructed environment (`{ PATH, TMPDIR, ... }`) that drops it, and those
 * children would report to production. This setup wraps `node:child_process` so any explicit
 * `env` gets `DO_NOT_TRACK=1` too, unless the test set `DO_NOT_TRACK` or `RESIN_ERROR_REPORTING`
 * itself (the tests that exercise reporting do, against a loopback host).
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const OPT_OUT_KEYS = ["DO_NOT_TRACK", "RESIN_ERROR_REPORTING"];
const PATCHED = Symbol.for("resin.test.noTelemetryPatched");

function isOptions(value: unknown): value is { env?: NodeJS.ProcessEnv } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns `args` with `DO_NOT_TRACK=1` added to an explicit `env` option that lacks an opt-out. */
export function withTelemetryOptOut(args: readonly unknown[]): unknown[] {
  const next = [...args];
  for (let index = 1; index < next.length; index += 1) {
    const candidate = next[index];
    if (!isOptions(candidate)) continue;
    const env = candidate.env;
    if (env && !OPT_OUT_KEYS.some((key) => Object.hasOwn(env, key))) {
      next[index] = { ...candidate, env: { ...env, DO_NOT_TRACK: "1" } };
    }
    break;
  }
  return next;
}

type AnyFunction = (...args: unknown[]) => unknown;

function wrap(name: string): void {
  const original: unknown = Reflect.get(childProcess, name);
  if (typeof original !== "function") return;
  const target = original as AnyFunction;
  const wrapped: AnyFunction = (...args) => target(...withTelemetryOptOut(args));
  const custom: unknown = Reflect.get(target, promisify.custom);
  if (typeof custom === "function") {
    const customTarget = custom as AnyFunction;
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]) => customTarget(...withTelemetryOptOut(args)),
    });
  }
  Reflect.set(childProcess, name, wrapped);
}

if (!Reflect.get(childProcess, PATCHED)) {
  for (const name of [
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
    "fork",
  ]) {
    wrap(name);
  }
  Reflect.set(childProcess, PATCHED, true);
  // Named ESM imports (`import { spawn } from "node:child_process"`) see the wrappers too.
  syncBuiltinESMExports();
}
