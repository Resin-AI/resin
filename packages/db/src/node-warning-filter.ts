/**
 * Silences Node's `ExperimentalWarning` for `node:sqlite` and nothing else.
 *
 * Import this module before anything that loads `node:sqlite`: ESM evaluates imports in order, and
 * Node emits the warning when the builtin is first loaded. Node's default printer is the `warning`
 * listener registered at bootstrap; it is detached here and still receives every other warning, so
 * they print exactly as Node would print them.
 */
import process from "node:process";

export function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message);
}

const FILTER_INSTALLED = Symbol.for("resin.sqliteWarningFilterInstalled");

export function installSqliteWarningFilter(): void {
  const state = process as unknown as Record<symbol, boolean | undefined>;
  if (state[FILTER_INSTALLED]) return;
  state[FILTER_INSTALLED] = true;
  const defaultListeners = process.listeners("warning");
  for (const listener of defaultListeners) process.removeListener("warning", listener);
  process.on("warning", (warning) => {
    if (isSqliteExperimentalWarning(warning)) return;
    for (const listener of defaultListeners) listener.call(process, warning);
  });
}

installSqliteWarningFilter();
