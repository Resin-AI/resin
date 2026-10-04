/**
 * The commands learned tools run, named the way an agent would type them (`vitest`,
 * `gh pr checks`, `stylua`). Agents are told to search learned tools before running a job by hand,
 * but decide a job is "just a command" and never search; naming the commands the workspace's tools
 * cover lets an agent see, before it types one, that a learned tool already runs it.
 *
 * Derived only from recorded program text resolved on this machine, and only shown to the local
 * agent: it is never uploaded.
 */

import type { RegistryTool } from "../registry/types.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

/** The commands a learned tool runs, resolved on this machine (none when it runs no program). */
export type LocalToolCommands = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => string[];

/**
 * Words that run the command after them, and the shell keywords that precede a command
 * (`for …; do gh issue view …`): the command after them is the one worth naming.
 */
const WRAPPERS: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "time",
    "timeout",
    "sudo",
    "env",
    "nice",
    "nohup",
    "exec",
    "command",
    "xargs",
    "stdbuf",
    "npx",
    "bunx",
    "pnpx",
    "do",
    "then",
    "else",
    "!",
    "{",
  ].map((word) => [word, true as const]),
);

/** Package-manager subcommands that run the program named next (`pnpm exec vitest` is `vitest`). */
const RUNS_NEXT_PROGRAM: Readonly<Record<string, true>> = {
  "pnpm exec": true,
  "pnpm dlx": true,
  "yarn exec": true,
  "yarn dlx": true,
  "npm exec": true,
  "bun x": true,
  "uv run": true,
  "poetry run": true,
};

/**
 * Shell plumbing and builtins: present in nearly every recorded program, so naming them would say
 * nothing about what a tool is for.
 */
const PLUMBING: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "cd",
    "pushd",
    "popd",
    "echo",
    "printf",
    "cat",
    "head",
    "tail",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "awk",
    "sed",
    "sort",
    "uniq",
    "wc",
    "tr",
    "cut",
    "tee",
    "sleep",
    "true",
    "false",
    "test",
    "[",
    "[[",
    "ls",
    "pwd",
    "for",
    "done",
    "if",
    "elif",
    "fi",
    "while",
    "until",
    "case",
    "esac",
    "in",
    "set",
    "export",
    "read",
    "local",
    "return",
    "break",
    "continue",
    "exit",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "touch",
    "date",
    "seq",
    "jq",
    "wait",
    "source",
    "column",
    "basename",
    "dirname",
    "realpath",
    "which",
    "find",
    "xxd",
  ].map((name) => [name, true as const]),
);

/** CLIs whose first words after the program name say what it does (`gh pr checks`, `git push`). */
const SUBCOMMAND_WORDS: Readonly<Record<string, number>> = {
  gh: 2,
  aws: 2,
  gcloud: 2,
  git: 1,
  npm: 1,
  pnpm: 1,
  yarn: 1,
  bun: 1,
  cargo: 1,
  go: 1,
  docker: 1,
  kubectl: 1,
  uv: 1,
  poetry: 1,
  deno: 1,
  make: 1,
  terraform: 1,
  lune: 1,
  rokit: 1,
  rojo: 1,
  omp: 1,
  resin: 1,
};

/** Interpreters whose script operand is what the command runs (`python3 scripts/manifest.py`). */
const SCRIPT_RUNNERS: Readonly<Record<string, true>> = {
  python: true,
  python3: true,
  node: true,
  bash: true,
  sh: true,
  zsh: true,
  tsx: true,
  "ts-node": true,
};

/** A subcommand word: plain lowercase-ish text, not a number, flag, path or placeholder. */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9:_-]*$/u;
/** A script operand: a path ending in a file extension, with no placeholder or expansion. */
const SCRIPT = /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/u;
/** A program name worth naming. */
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * The words of each simple command in a shell program, quotes removed. Pipes, lists, subshells and
 * command substitutions separate commands outside quotes; a redirection (`2>&1`, `> out.txt`) and
 * its target belong to no command.
 */
function simpleCommands(program: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let quoted = false;
  let skipTarget = false;
  const endWord = () => {
    if (word.length > 0 || quoted) {
      if (skipTarget) skipTarget = false;
      else words.push(word);
    }
    word = "";
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
    skipTarget = false;
  };
  for (let at = 0; at < program.length; at += 1) {
    const char = program[at]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === ">" || char === "<") {
      // A file-descriptor number before the operator is part of it, not a word.
      if (/^\d+$/u.test(word)) word = "";
      endWord();
      if (program[at + 1] === ">" || program[at + 1] === "|") at += 1;
      const duplicate = /^&\d+|^&-/u.exec(program.slice(at + 1));
      if (duplicate) at += duplicate[0].length;
      else skipTarget = true;
    } else if (char === "&" && program[at + 1] === ">") {
      endWord();
      at += program[at + 2] === ">" ? 2 : 1;
      skipTarget = true;
    } else if (char === "$" && program[at + 1] === "(") {
      endCommand();
      at += 1;
    } else if ("|&;\n()`".includes(char)) {
      endCommand();
    } else if (/\s/u.test(char)) {
      endWord();
    } else {
      word += char;
    }
  }
  endCommand();
  return commands;
}

/** The command an agent would recognise in one simple command, or undefined for plumbing. */
function commandPhrase(words: readonly string[]): string | undefined {
  let at = 0;
  for (;;) {
    while (at < words.length && ASSIGNMENT.test(words[at]!)) at += 1;
    const word = words[at];
    if (word === undefined || WRAPPERS[word] !== true) break;
    at += 1;
    // A wrapper's own options and arguments (`timeout 600`, `stdbuf -oL`) come before the command.
    while (at < words.length && (words[at]!.startsWith("-") || /^\d+[smhd]?$/u.test(words[at]!))) {
      at += 1;
    }
  }
  const program = words[at];
  if (program === undefined) return undefined;
  const name = program.split("/").at(-1) ?? program;
  if (!PROGRAM.test(name) || PLUMBING[name] === true) return undefined;
  const phrase = [name];
  let next = at + 1;
  const wanted = SUBCOMMAND_WORDS[name] ?? 0;
  while (phrase.length - 1 < wanted && next < words.length && SUBCOMMAND.test(words[next]!)) {
    phrase.push(words[next]!);
    next += 1;
  }
  if (RUNS_NEXT_PROGRAM[phrase.join(" ")] === true) return commandPhrase(words.slice(next));
  if (SCRIPT_RUNNERS[name] === true) {
    // What runs is the module or script it names (`python3 -m pytest`, `python3 scripts/x.py`);
    // `python3 -c` names neither.
    while (next < words.length && words[next]!.startsWith("-")) {
      if (words[next] === "-m" && SUBCOMMAND.test(words[next + 1] ?? "")) {
        return `${name} -m ${words[next + 1]}`;
      }
      next += 1;
    }
    const script = words[next];
    return script !== undefined && SCRIPT.test(script) ? `${name} ${script}` : undefined;
  }
  return phrase.join(" ");
}

/** The distinct commands one recorded shell program runs, in the order it runs them. */
export function programCommands(program: string): string[] {
  const commands: string[] = [];
  for (const words of simpleCommands(program)) {
    const phrase = commandPhrase(words);
    if (phrase !== undefined && !commands.includes(phrase)) commands.push(phrase);
  }
  return commands;
}

/** How many commands, at most, a summary names; a longer list stops being read. */
export const LEARNED_COMMANDS_LIMIT = 12;

/**
 * The commands a workspace's learned tools run, most widely covered first: each tool's commands
 * count once, and ties keep the order the tools were listed in.
 */
export function summarizeLearnedCommands(
  perTool: ReadonlyArray<readonly string[]>,
  limit = LEARNED_COMMANDS_LIMIT,
): string[] {
  const counts = new Map<string, number>();
  for (const commands of perTool) {
    for (const command of new Set(commands)) counts.set(command, (counts.get(command) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([command]) => command);
}
