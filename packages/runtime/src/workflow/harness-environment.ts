import { readFileSync } from "node:fs";

/**
 * The environment an agent harness ran its own shell commands with, as far as the process that
 * launched this one still holds it.
 *
 * A harness starts an MCP server with a short allow-list of its variables (`PATH`, `HOME`, …), but
 * runs the commands it records with the whole container environment: an image's `ENV PYTHONPATH=…`
 * or `LD_LIBRARY_PATH=…` reaches a recorded `python3 -c 'import FreeCAD'` and not a replay of it,
 * which then fails wherever the recording succeeded. A recorded shell program is replayed with those
 * variables again, the ones this process was not given, read from the ancestors that launched it
 * (`/proc/<pid>/environ`, Linux only).
 *
 * Variables that look like credentials, and the harness's and Resin's own, are never carried over:
 * the replay gets what the image configured, not what the harness was authorized with.
 */

/** Ancestors read: the launcher chain between the harness and this process is short. */
const MAX_ANCESTORS = 6;

/** Names that may carry a secret, wherever they appear in the name. */
const SECRET_NAME =
  /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS$|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT_PASS|DSN|CONNECTION|_URL$|_URI$|BEARER|SIGNATURE|SALT/i;
/** The harness's and Resin's own variables, and ones that make a shell run code or load a library. */
const FOREIGN_NAME =
  /^(?:CODEX_|RESIN_|OPENAI_|ANTHROPIC_|NODE_OPTIONS$|_$|SHLVL$|OLDPWD$|LD_PRELOAD$|LD_AUDIT$|BASH_ENV$|ENV$|PROMPT_COMMAND$|PS4$|IFS$|SHELLOPTS$|BASHOPTS$|BASH_FUNC_)/i;
/** Values shaped like credentials, under any name: URLs with userinfo and well-known token forms. */
const SECRET_VALUE =
  /:\/\/[^\s/:@]+:[^\s/@]+@|^(?:sk-|ghp_|gho_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.|-----BEGIN )/;

function withheld(name: string, value: string): boolean {
  return SECRET_NAME.test(name) || FOREIGN_NAME.test(name) || SECRET_VALUE.test(value);
}

export interface ProcessTableReader {
  /** The NUL-separated environment of a process, or undefined when it cannot be read. */
  environment(pid: number): string | undefined;
  /** The parent of a process, or undefined when it has none or cannot be read. */
  parent(pid: number): number | undefined;
}

const procfs: ProcessTableReader = {
  environment(pid) {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      return undefined;
    }
  },
  parent(pid) {
    try {
      // `pid (comm) state ppid …`: comm may hold spaces and parentheses, so read from its last `)`.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return Number.isInteger(parent) && parent > 1 ? parent : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * The variables the launching processes hold that `own` lacks, nearest ancestor first, without the
 * withheld names. Empty off Linux, or when no ancestor's environment can be read.
 */
export function inheritedHarnessEnvironment(
  own: NodeJS.ProcessEnv = process.env,
  options: {
    pid?: number;
    platform?: NodeJS.Platform;
    processes?: ProcessTableReader;
  } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return {};
  const processes = options.processes ?? procfs;
  const recovered: Record<string, string> = {};
  let pid: number | undefined = options.pid ?? process.ppid;
  for (let depth = 0; pid !== undefined && depth < MAX_ANCESTORS; depth += 1) {
    const text = processes.environment(pid);
    if (text !== undefined) {
      for (const entry of text.split("\0")) {
        const equals = entry.indexOf("=");
        if (equals <= 0) continue;
        const name = entry.slice(0, equals);
        if (withheld(name, entry.slice(equals + 1)) || own[name] !== undefined || name in recovered)
          continue;
        recovered[name] = entry.slice(equals + 1);
      }
    }
    pid = processes.parent(pid);
  }
  return recovered;
}

/** Variables that name who the harness's own login shell ran as. */
const LOGIN_IDENTITY = ["HOME", "USER", "LOGNAME"] as const;

/**
 * The login identity of the harness that launched this process, from the nearest ancestor that
 * holds each variable, whatever this process was given.
 *
 * A launcher may hand the MCP server another `HOME` (a private data directory), but a recorded
 * command ran as the harness's own user, in a login shell that read that user's profile: the
 * profile an image uses to activate its environment (a conda `testbed`) sits under the harness's
 * `HOME`. Replaying it under the server's `HOME` reads no profile, and `python` is not the
 * interpreter the command ran with. Empty off Linux, or when no ancestor's environment can be read.
 */
export function harnessLoginIdentity(
  options: {
    pid?: number;
    platform?: NodeJS.Platform;
    processes?: ProcessTableReader;
  } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return {};
  const processes = options.processes ?? procfs;
  const identity: Record<string, string> = {};
  let pid: number | undefined = options.pid ?? process.ppid;
  for (let depth = 0; pid !== undefined && depth < MAX_ANCESTORS; depth += 1) {
    const text = processes.environment(pid);
    if (text !== undefined) {
      for (const entry of text.split("\0")) {
        const equals = entry.indexOf("=");
        if (equals <= 0) continue;
        const name = entry.slice(0, equals);
        if ((LOGIN_IDENTITY as readonly string[]).includes(name) && !(name in identity)) {
          identity[name] = entry.slice(equals + 1);
        }
      }
    }
    pid = processes.parent(pid);
  }
  return identity;
}
