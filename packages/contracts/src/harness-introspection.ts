import { type ProgramLanguage, type ProgramToken, tokenizeProgram } from "./program-tokens.js";

/**
 * Programs that read Resin's or an agent harness's own state are never user work: a tool learned
 * from one describes the observer, not the job, and derails the agent that later calls it. These
 * are the signals that make a recorded program such an introspection. Each is a program, path or
 * tool-namespace signal, never the bare word "resin", so project data that mentions it still learns.
 */

/** Resin's MCP tool namespace as harnesses expose it: `mcp__resin__` (Codex, Claude) or `mcp__resin_` (OMP). */
const RESIN_TOOL_NAMESPACE = /\bmcp__resin_/;

/** Resin's and the harnesses' home state trees (`~/.resin`, `~/.codex`, `~/.omp`, `~/.claude`, `~/.claude.json`). */
const HARNESS_HOME_STATE =
  /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s'"`]+|\/Users\/[^/\s'"`]+|\/root)\/\.(?:resin|codex|omp|claude)(?:\.json)?(?![\w.-])/;

/** The variable that relocates Resin's home state tree. */
const RESIN_HOME_VARIABLE = /\$\{?RESIN_HOME\b/;

/** Executables that are Resin itself. */
const RESIN_EXECUTABLES: Readonly<Record<string, true>> = {
  resin: true,
  "resin-daemon": true,
  "resin-mcp": true,
};

/** Harness CLIs whose `mcp` subcommand lists or edits the harness's MCP tool registry. */
const HARNESS_EXECUTABLES: Readonly<Record<string, true>> = {
  codex: true,
  claude: true,
  omp: true,
};

/** Words that run the next word as the program: the program is past them, never them. */
const COMMAND_WRAPPERS: Readonly<Record<string, true>> = {
  sudo: true,
  env: true,
  exec: true,
  command: true,
  nohup: true,
  time: true,
  timeout: true,
  xargs: true,
  npx: true,
  bunx: true,
};

const COMMAND_SEPARATORS: Readonly<Record<string, true>> = {
  ";": true,
  "&&": true,
  "||": true,
  "|": true,
  "&": true,
  "(": true,
  ")": true,
  ";;": true,
};
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The simple commands of a shell program, as their word tokens; undefined when it does not tokenize. */
function simpleCommands(source: string): ProgramToken[][] | undefined {
  let tokens: ProgramToken[];
  try {
    tokens = tokenizeProgram("shell", source);
  } catch {
    return undefined;
  }
  const commands: ProgramToken[][] = [];
  let current: ProgramToken[] = [];
  let previousEnd = 0;
  for (const token of tokens) {
    const newline = source.slice(previousEnd, token.start).includes("\n");
    previousEnd = token.end;
    if (newline || (token.kind === "operator" && Object.hasOwn(COMMAND_SEPARATORS, token.raw))) {
      if (current.length > 0) commands.push(current);
      current = [];
      if (token.kind === "operator") continue;
    }
    current.push(token);
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

/** Whether one simple command runs Resin, or lists a harness's MCP tools. */
function commandIntrospects(words: readonly ProgramToken[]): boolean {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (SHELL_ASSIGNMENT.test(word.raw) || (index > 0 && word.raw.startsWith("-"))) {
      index += 1;
      continue;
    }
    // Only a plain word names a program; quoting or expansion in it is never guessed through.
    if (word.kind !== "word" || word.value !== word.raw) return false;
    const name = word.raw.slice(word.raw.lastIndexOf("/") + 1);
    if (Object.hasOwn(COMMAND_WRAPPERS, name)) {
      index += 1;
      // `timeout 5 resin …`: the duration is the wrapper's, not the program.
      if (name === "timeout" && /^[0-9.]+[smhd]?$/.test(words[index]?.raw ?? "")) index += 1;
      continue;
    }
    if (Object.hasOwn(RESIN_EXECUTABLES, name)) return true;
    if (!Object.hasOwn(HARNESS_EXECUTABLES, name)) return false;
    const subcommand = words.slice(index + 1).find((next) => !next.raw.startsWith("-"));
    return subcommand?.raw === "mcp";
  }
  return false;
}

/**
 * Whether a recorded program introspects Resin or the agent harness: it names Resin's MCP tool
 * namespace, reads Resin's or a harness's home state, runs the `resin` CLI, or lists a harness's
 * MCP tools. `language` is the program's language; only a shell program has command positions.
 */
export function isHarnessIntrospectionProgram(
  source: string,
  language: ProgramLanguage = "shell",
): boolean {
  if (language === "patch") return false;
  if (
    RESIN_TOOL_NAMESPACE.test(source) ||
    HARNESS_HOME_STATE.test(source) ||
    RESIN_HOME_VARIABLE.test(source)
  ) {
    return true;
  }
  if (language !== "shell") return false;
  return simpleCommands(source)?.some(commandIntrospects) ?? false;
}
