// Stand-in for `node:sqlite` under Vitest (see real-home-guard.ts). Named builtin exports are
// bound when `node:sqlite` loads and `syncBuiltinESMExports` does not refresh them, so
// `import { DatabaseSync } from "node:sqlite"` resolves here and gets the guarded constructor the
// setup installed on the module object.
import sqlite from "node:sqlite";

export default sqlite;
export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
export const constants = sqlite.constants;
export const backup = sqlite.backup;
