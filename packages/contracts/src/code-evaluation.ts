/**
 * Which words of a recorded shell program reach a second parser, shared by the POSIX and PowerShell
 * tokenizers so both refuse the same things.
 *
 * A bound value is rendered as data for the shell that reads the recorded text. A command that
 * parses its arguments again — `eval`, `Invoke-Expression`, `ssh host …`, `cmd /c …`,
 * `pwsh -Command …`, a code runner's `-c` string — turns that data back into code, so a value there
 * is never bindable:
 *
 * - An **evaluator** re-parses every argument (or runs one it builds from them, or redefines what a
 *   later command name means). Every token of a program that runs one is unbindable: a value can
 *   reach it through a variable, an alias or a function the program defined.
 * - A **code runner**'s code flag (`python -c`, `bash -lc`, `node -e`, `perl -ne`, …) makes the next
 *   word code. That word is unbindable, and so is every assignment in the program, which the code
 *   can read.
 *
 * This decides the words of the recorded text itself. Where the code a command runs is a known
 * program written as one literal quoted word — a python or node `-c`/`-e` string, a POSIX shell's
 * `-c` string, an `ssh` command's single remote command word — `embeddedPrograms` (in
 * `program-tokens.ts`) reads that program with its own grammar, and a value is bound to one of its
 * tokens only by rendering it as data for that program first and then for the quoted word.
 */

/** A command's name without its directory, a PowerShell module qualifier, case or extension. */
export function commandBaseName(text: string): string {
  const base = text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/u, "");
}

/**
 * Commands that re-parse their arguments as code, in any shell: POSIX `eval`, `trap` and remote or
 * repeating runners that join their arguments into one command line, and the Windows shells, whose
 * whole remaining command line is one program (`cmd /c`, `/k`, `powershell -Command`, and
 * `powershell`'s positional command).
 */
const SHELL_EVALUATORS: ReadonlySet<string> = new Set([
  "eval",
  "trap",
  "ssh",
  "watch",
  "parallel",
  "wsl",
  "cmd",
  "powershell",
  "pwsh",
]);

/**
 * PowerShell's code sinks and their aliases: expression and script-block evaluators, jobs and
 * processes started from a string command line, compiled type definitions, event actions, and
 * commands that redefine what a later command name runs (aliases).
 */
const POWERSHELL_EVALUATORS: ReadonlySet<string> = new Set([
  "invoke-expression",
  "iex",
  "invoke-command",
  "icm",
  "start-job",
  "sajb",
  "start-threadjob",
  "start-process",
  "saps",
  "start",
  "add-type",
  "new-module",
  "nmo",
  "invoke-wmimethod",
  "iwmi",
  "invoke-cimmethod",
  "register-scheduledjob",
  "new-scheduledtaskaction",
  "register-objectevent",
  "register-engineevent",
  "register-wmievent",
  "set-psbreakpoint",
  "sbp",
  "set-alias",
  "sal",
  "new-alias",
  "nal",
  "import-alias",
  "ipal",
]);

/**
 * PowerShell drive paths through which a command (`New-Item`, `Set-Item`, …) defines a function or
 * an alias, which a later command name then runs.
 */
const DEFINING_DRIVE = /^(?:[a-z.]+\\)?(?:function|alias):/iu;

/**
 * Programs whose code flag's argument is source code they run: shells, script interpreters, stream
 * editors, database clients, and the POSIX runners of a command string (`su -c`, `flock -c`).
 */
const CODE_RUNNER =
  /^(?:(?:ba|z|da|k|mk|a|c|tc|fi)?sh|busybox|python(?:[0-9.]*)?|py|pypy[0-9.]*|node(?:js)?|deno|bun|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|lua[0-9.]*|luajit|rscript|tclsh[0-9.]*|osascript|g?sed|[gmn]?awk|psql|mysql|mariadb|sqlite3|duckdb|clickhouse(?:-client)?|mongo(?:sh)?|redis-cli|jshell|groovy|scala|julia|elixir|erl|swift|su|runuser|flock|script)$/u;

/**
 * A code runner's flag whose next word is code: `-c`, `-e`, `-p` and combined short flags ending in
 * one (`-lc`, `-Bc`, `-ne`, `-pe`), or a long code option.
 */
const CODE_FLAG = /^(?:-[A-Za-z]*[cep]|--eval|--command|--exec|--execute)$/u;

export type ShellGrammarFamily = "posix" | "powershell";

/** Whether a word is a command that re-parses its arguments as code, in the given grammar. */
export function isEvaluatorWord(word: string, family: ShellGrammarFamily): boolean {
  // A batch file runs in cmd.exe, which parses its arguments again.
  if (/\.(?:cmd|bat)$/iu.test(word)) return true;
  const base = commandBaseName(word);
  if (SHELL_EVALUATORS.has(base)) return true;
  if (family !== "powershell") return false;
  const qualified = base.includes("\\") ? base.slice(base.lastIndexOf("\\") + 1) : base;
  return POWERSHELL_EVALUATORS.has(qualified) || DEFINING_DRIVE.test(word);
}

/** Whether a PowerShell word names a function or alias path a command would define (`function:x`). */
export function isDefiningPowerShellPath(word: string): boolean {
  return DEFINING_DRIVE.test(word);
}

/**
 * PowerShell commands that evaluate a script-block argument in-process, once per pipeline object, as
 * a predicate (`Where-Object`, `where`, `?`), a projection (`ForEach-Object`, `foreach`, `%`) or a
 * sort or group key (`Sort-Object`, `sort`, `Group-Object`, `group`), and use its result as data.
 * Nothing else is on the list: every other command that takes a block may run it elsewhere, later
 * or as a new program (`Invoke-Command`, `Start-Job`, `Register-*Event -Action`, `& { }`, …).
 * `Select-Object` is absent because its calculated properties are hashtables. Names match exactly
 * (a module-qualified cmdlet aside): `where.exe` and `sort.exe` are native programs.
 */
const POWERSHELL_BLOCK_FILTERS: ReadonlySet<string> = new Set([
  "where-object",
  "where",
  "?",
  "foreach-object",
  "foreach",
  "%",
  "sort-object",
  "sort",
  "group-object",
  "group",
  "microsoft.powershell.core\\where-object",
  "microsoft.powershell.core\\foreach-object",
  "microsoft.powershell.utility\\sort-object",
  "microsoft.powershell.utility\\group-object",
]);

/**
 * Whether a PowerShell command evaluates a script-block argument in-process as a filter,
 * projection or key (see {@link POWERSHELL_BLOCK_FILTERS}), so a literal inside it can be data.
 */
export function isPowerShellBlockFilterWord(word: string): boolean {
  return POWERSHELL_BLOCK_FILTERS.has(word.toLowerCase());
}

/** Whether a word names a program whose code flag's argument is source code. */
export function isCodeRunnerWord(word: string): boolean {
  return CODE_RUNNER.test(commandBaseName(word));
}

/** Whether a word is a code runner's code flag. */
export function isCodeFlagWord(word: string): boolean {
  return CODE_FLAG.test(word);
}

/**
 * The POSIX wrapper forms that hand a whole command line to a shell: `sudo -s`/`-i`/`--shell`/
 * `--login` and `env -S`/`--split-string`, given the words of one simple command.
 */
export function posixWrapperEvaluates(words: readonly string[]): boolean {
  for (let index = 0; index < words.length; index += 1) {
    const base = commandBaseName(words[index]!);
    if (base !== "sudo" && base !== "env") continue;
    for (const option of words.slice(index + 1)) {
      if (!option.startsWith("-")) break;
      if (
        base === "sudo" &&
        (/^-[A-Za-z]*[si]/u.test(option) || /^--(?:shell|login)$/u.test(option))
      )
        return true;
      if (base === "env" && (/^-[A-Za-z]*S/u.test(option) || option.startsWith("--split-string")))
        return true;
    }
  }
  return false;
}

/** POSIX wrappers that run the rest of their command line as a command, with their value options. */
const POSIX_WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nohup: new Set(),
  time: new Set(["-f", "-o"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  setsid: new Set(),
  command: new Set(),
  exec: new Set(["-a"]),
  builtin: new Set(),
  xargs: new Set(["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a"]),
};

/**
 * The words of one POSIX simple command that stand in command position: its first word after any
 * assignments and, while that is a wrapper (`sudo`, `env`, `timeout 5`, `xargs -n1`, …), the word
 * the wrapper runs.
 */
export function posixCommandWords(words: readonly string[]): string[] {
  const commands: string[] = [];
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]!)) index += 1;
  while (index < words.length) {
    const word = words[index]!;
    commands.push(word);
    const valueOptions = POSIX_WRAPPERS[commandBaseName(word)];
    if (valueOptions === undefined) break;
    index += 1;
    while (index < words.length) {
      const next = words[index]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(next)) index += 1;
      else if (valueOptions.has(next)) index += 2;
      else if (next.startsWith("-")) index += 1;
      else if (commandBaseName(word) === "timeout" && /^[0-9.]+[smhd]?$/u.test(next)) index += 1;
      else break;
    }
  }
  return commands;
}
