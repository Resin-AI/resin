import { type ProgramLanguage, type ProgramToken, tokenizeProgram } from "./program-tokens.js";

/**
 * Programs that read Resin's or an agent harness's own state are never user work: a tool learned
 * from one describes the observer, not the job, and derails the agent that later calls it. These
 * are the signals that make a recorded program such an introspection. Each is a program, path or
 * tool-namespace signal, never the bare word "resin", so project data that mentions it still learns.
 *
 * The tool-namespace signal is deliberately unanchored: any program naming `mcp__resin_` is about
 * Resin's own tools, which includes greps over Resin's own source. Work on Resin itself is not
 * something Resin learns.
 */

/** Resin's MCP tool namespace as harnesses expose it: `mcp__resin__` (Codex, Claude) or `mcp__resin_` (OMP). */
const RESIN_TOOL_NAMESPACE = /\bmcp__resin_/;

/** A home directory as POSIX shells, cmd.exe and PowerShell spell it, or as normalization aliases it. */
const HOME =
  /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:HOME|\/home\/[^/\\\s'"`]+|\/Users\/[^/\\\s'"`]+|\/root|[A-Za-z]:[\\/]+Users[\\/]+[^/\\\s'"`]+)/
    .source;

/** Resin's and the harnesses' home state trees (`~/.resin`, `~/.codex`, `~/.omp`, `~/.claude`, `~/.claude.json`). */
const HARNESS_HOME_STATE = new RegExp(
  `${HOME}[\\\\/]+\\.(?:resin|codex|omp|claude)(?:\\.json)?(?![\\w.-])`,
  "i",
);

/** The variable that relocates Resin's home state tree, in POSIX, cmd.exe and PowerShell form. */
const RESIN_HOME_VARIABLE = /\$\{?RESIN_HOME\b|%RESIN_HOME%|\$env:RESIN_HOME\b/i;

/**
 * Executables that are Resin itself, matched only as a bare command name. A path to one is either
 * under Resin's home tree (a home-state signal) or a project's own binary, which stays learnable.
 */
const RESIN_EXECUTABLES: Readonly<Record<string, true>> = {
  resin: true,
  "resin.exe": true,
  "resin-daemon": true,
  "resin-mcp": true,
};

/** Harness CLIs whose `mcp` subcommand lists or edits the harness's MCP tool registry. */
const HARNESS_EXECUTABLES: Readonly<Record<string, true>> = {
  codex: true,
  claude: true,
  omp: true,
};

/** Global harness flags that consume the next word, so it is never mistaken for the subcommand. */
const HARNESS_VALUE_FLAGS: Readonly<Record<string, true>> = {
  "-c": true,
  "--config": true,
  "-m": true,
  "--model": true,
  "-p": true,
  "--profile": true,
  "-C": true,
  "--cd": true,
  "-s": true,
  "--sandbox": true,
  "-a": true,
  "--ask-for-approval": true,
  "-i": true,
  "--image": true,
  "--add-dir": true,
  "--enable": true,
  "--disable": true,
  "--settings": true,
  "--mcp-config": true,
  "--permission-mode": true,
  "--session-id": true,
  "-r": true,
  "--resume": true,
  "--output-format": true,
  "--input-format": true,
  "--allowedTools": true,
  "--disallowedTools": true,
  "--append-system-prompt": true,
  "--system-prompt": true,
  "--fallback-model": true,
  "--agents": true,
  "--setting-sources": true,
};

/**
 * Words that run the rest of the command as the program, with the flags of each that consume the
 * next word. `npx` is not one: `npx resin` runs the public npm package of that name, not Resin.
 */
const COMMAND_WRAPPERS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  sudo: { "-u": true, "-g": true, "-h": true, "-p": true, "-C": true, "-D": true, "-U": true },
  env: { "-u": true, "--unset": true, "-C": true, "--chdir": true, "-S": true },
  exec: { "-a": true },
  command: {},
  nohup: {},
  time: { "-f": true, "-o": true },
  timeout: { "-s": true, "--signal": true, "-k": true, "--kill-after": true },
  xargs: { "-I": true, "-n": true, "-P": true, "-d": true, "-E": true, "-L": true, "-s": true },
  yarn: {},
};

/** Package-runner forms whose second word hands the rest to the named program. */
const RUNNER_SUBCOMMANDS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  pnpm: { exec: true, dlx: true },
  bun: { x: true },
};

/** Shells whose `-c` string is itself a shell program. */
const SHELLS: Readonly<Record<string, true>> = { sh: true, bash: true, zsh: true, dash: true };

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
/** Nested `sh -c` levels followed before giving up; real commands nest one or two. */
const MAX_SHELL_DEPTH = 4;

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

/** The literal text of a word or quoted string, when the tokenizer established it. */
function literalText(token: ProgramToken | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (typeof token.value === "string") return token.value;
  if (token.kind === "string" && token.raw.startsWith("'") && token.raw.endsWith("'")) {
    return token.raw.slice(1, -1);
  }
  return undefined;
}

/** Whether one simple command runs Resin, or lists a harness's MCP tools. */
function commandIntrospects(words: readonly ProgramToken[], depth: number): boolean {
  let index = 0;
  while (index < words.length && SHELL_ASSIGNMENT.test(words[index]!.raw)) index += 1;
  while (index < words.length) {
    const word = words[index]!;
    // Only a plain word names a program; quoting or expansion in it is never guessed through.
    if (word.kind !== "word" || word.value !== word.raw) return false;
    const name = word.raw.slice(
      Math.max(word.raw.lastIndexOf("/"), word.raw.lastIndexOf("\\")) + 1,
    );
    const wrapperFlags = COMMAND_WRAPPERS[name];
    if (wrapperFlags !== undefined) {
      index += 1;
      while (index < words.length) {
        const raw = words[index]!.raw;
        if (SHELL_ASSIGNMENT.test(raw)) index += 1;
        else if (Object.hasOwn(wrapperFlags, raw)) index += 2;
        else if (raw.startsWith("-")) index += 1;
        // `timeout 5 resin …`: the duration is the wrapper's, not the program.
        else if (name === "timeout" && /^[0-9.]+[smhd]?$/.test(raw)) index += 1;
        else break;
      }
      continue;
    }
    const runner = RUNNER_SUBCOMMANDS[name];
    if (runner !== undefined) {
      if (!Object.hasOwn(runner, words[index + 1]?.raw ?? "")) return false;
      index += 2;
      while (index < words.length && words[index]!.raw.startsWith("-")) index += 1;
      continue;
    }
    if (Object.hasOwn(SHELLS, name)) {
      if (depth >= MAX_SHELL_DEPTH) return false;
      const flag = words
        .slice(index + 1)
        .findIndex((next) => /^-[A-Za-z]*c[A-Za-z]*$/.test(next.raw));
      const script = flag === -1 ? undefined : literalText(words[index + 2 + flag]);
      return script !== undefined && shellIntrospects(script, depth + 1);
    }
    if (word.raw === name && Object.hasOwn(RESIN_EXECUTABLES, name)) return true;
    if (!Object.hasOwn(HARNESS_EXECUTABLES, name)) return false;
    for (let next = index + 1; next < words.length; next += 1) {
      const raw = words[next]!.raw;
      if (Object.hasOwn(HARNESS_VALUE_FLAGS, raw)) next += 1;
      else if (!raw.startsWith("-")) return raw === "mcp";
    }
    return false;
  }
  return false;
}

function shellIntrospects(source: string, depth: number): boolean {
  return simpleCommands(source)?.some((words) => commandIntrospects(words, depth)) ?? false;
}

/**
 * Whether text names Resin's MCP tool namespace or Resin's or a harness's home state. This holds
 * for any text, program or output, and is the part of the rule that needs no command structure.
 */
export function referencesHarnessState(text: string): boolean {
  return (
    RESIN_TOOL_NAMESPACE.test(text) ||
    HARNESS_HOME_STATE.test(text) ||
    RESIN_HOME_VARIABLE.test(text)
  );
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
  if (referencesHarnessState(source)) return true;
  return language === "shell" && shellIntrospects(source, 0);
}

/** Resin's own discovery meta tools; `invoke_tool` is the invocation surface and stays recorded. */
const RESIN_DISCOVERY_TOOLS: Readonly<Record<string, true>> = {
  search_tools: true,
  get_tool_schema: true,
  manage_tools: true,
};

/**
 * Whether a tool call is a call to one of Resin's own discovery meta tools, however the harness
 * names it: `mcp__resin__<tool>` (Codex, Claude), `mcp__resin_<tool>` (OMP), `resin__<tool>`
 * (Grok), `resin_<tool>` (OpenCode), `resin-<tool>`, or the bare name with connection `resin`
 * (Copilot) or no reported connection (Cursor names MCP calls without their server). Claude Code's
 * built-in `ToolSearch`, which loads deferred MCP tools (Resin's guidance has it search `resin`), is
 * the same discovery. Listing Resin's catalog is not the user's work; recorded as a step, it varies
 * run to run and keeps repeated runs apart.
 */
export function isResinDiscoveryToolCall(toolName: string, connection?: string): boolean {
  if (toolName === "ToolSearch" && connection === undefined) return true;
  const bare = /^(?:mcp__resin__?|resin__|resin[_-])(.+)$/.exec(toolName)?.[1];
  if (bare !== undefined) return Object.hasOwn(RESIN_DISCOVERY_TOOLS, bare);
  return (
    Object.hasOwn(RESIN_DISCOVERY_TOOLS, toolName) &&
    (connection === undefined || connection === "resin")
  );
}
