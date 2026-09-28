import { execFileSync } from "node:child_process";
import { type ShellInvocation, shellProgramInvocation } from "@resin/runtime";

function posixShell(command: string): ShellInvocation {
  return shellProgramInvocation({ dialect: "sh" }, command, {
    platform: process.platform,
    env: process.env,
  });
}

/**
 * Whether this device has the POSIX shell a recorded sh program replays in: `/bin/sh` on POSIX
 * hosts, Git for Windows' bash on Windows (a Windows host without Git cannot record one).
 */
export const posixShellAvailable: boolean = (() => {
  try {
    posixShell(":");
    return true;
  } catch {
    return false;
  }
})();

/**
 * Runs `command` as the author did, in the same POSIX shell a replay of the recording runs it in,
 * and returns what it printed.
 */
export function runPosixShell(
  command: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): string {
  const invocation = posixShell(command);
  const env = options.env ?? process.env;
  // Windows reads environment names case-insensitively: a replaced name goes in every spelling.
  const replaced = Object.keys(invocation.setEnv ?? {}).map((name) => name.toLowerCase());
  return execFileSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter(([name]) => !replaced.includes(name.toLowerCase())),
      ),
      ...invocation.setEnv,
    },
  });
}
