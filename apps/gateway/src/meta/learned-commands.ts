/**
 * The commands learned tools run, named the way an agent would type them (`vitest`,
 * `gh pr checks`, `stylua`). Agents are told to search learned tools before running a job by hand,
 * but decide a job is "just a command" and never search; naming the commands the workspace's tools
 * cover lets an agent see, before it types one, that a learned tool already runs it.
 *
 * Derived only from the projected program text (private values never resolved into it), named
 * from a fixed grammar of program names and known subcommands, and only shown to the local agent:
 * it is never uploaded.
 */

import type { RegistryTool } from "../registry/types.js";
import type { SuggestStep } from "../suggest/index-file.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

/** The commands a learned tool runs, resolved on this machine (none when it runs no program). */
export type LocalToolCommands = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => string[];

/** What each of a learned tool's recorded steps runs; undefined when its plan is not cached. */
export type LocalToolSteps = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => SuggestStep[] | undefined;

/** Flags and options a wrapper accepts before the command it runs. */
interface WrapperGrammar {
  /** Options that take no argument. */
  readonly flags?: readonly string[];
  /** Options whose argument is the next word, or attached (`-uNAME`, `--user=NAME`). */
  readonly options?: readonly string[];
  /** Operands before the command (`timeout 600 …`). */
  readonly operands?: number;
  /** Options after which no command runs, or one runs from a string (`command -v`, `env -S`). */
  readonly stops?: readonly string[];
  /** Whether `-10`-style numeric options are accepted (`nice -10`). */
  readonly numeric?: boolean;
}

/**
 * Words that run the command after them: that command is the one worth naming. Each wrapper's own
 * options are skipped by its grammar, so an option's argument (`sudo -u NAME`) is never taken for
 * the command; an option the grammar does not know names nothing rather than guess.
 */
const WRAPPERS: Readonly<Record<string, WrapperGrammar>> = {
  time: {
    flags: ["-p", "-a", "-v", "-q", "--portability", "--append", "--verbose", "--quiet"],
    options: ["-f", "-o", "--format", "--output"],
  },
  timeout: {
    flags: ["-v", "--verbose", "--preserve-status", "--foreground"],
    options: ["-s", "-k", "--signal", "--kill-after"],
    operands: 1,
  },
  sudo: {
    flags: [
      "-A",
      "-b",
      "-E",
      "-H",
      "-n",
      "-P",
      "-S",
      "-k",
      "-B",
      "-N",
      "--askpass",
      "--background",
      "--preserve-env",
      "--set-home",
      "--non-interactive",
      "--preserve-groups",
      "--stdin",
      "--reset-timestamp",
      "--bell",
      "--no-update",
    ],
    options: [
      "-u",
      "-g",
      "-h",
      "-p",
      "-C",
      "-r",
      "-t",
      "-U",
      "-D",
      "-R",
      "-T",
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--close-from",
      "--role",
      "--type",
      "--other-user",
      "--chdir",
      "--chroot",
      "--command-timeout",
    ],
    stops: [
      "-e",
      "-i",
      "-s",
      "-l",
      "-v",
      "-K",
      "-V",
      "--edit",
      "--login",
      "--shell",
      "--list",
      "--validate",
      "--remove-timestamp",
      "--version",
      "--help",
    ],
  },
  env: {
    flags: ["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"],
    options: ["-u", "-C", "--unset", "--chdir"],
    stops: ["-S", "--split-string"],
  },
  nice: { options: ["-n", "--adjustment"], numeric: true },
  nohup: {},
  exec: { flags: ["-c", "-l"], options: ["-a"] },
  command: { flags: ["-p"], stops: ["-v", "-V"] },
  xargs: {
    flags: [
      "-0",
      "-r",
      "-t",
      "-p",
      "-x",
      "-o",
      "--null",
      "--no-run-if-empty",
      "--verbose",
      "--interactive",
      "--exit",
      "--open-tty",
    ],
    options: [
      "-I",
      "-n",
      "-P",
      "-L",
      "-s",
      "-d",
      "-E",
      "-a",
      "--max-args",
      "--max-procs",
      "--max-lines",
      "--max-chars",
      "--delimiter",
      "--arg-file",
      "--replace",
      "--eof",
      "--process-slot-var",
    ],
  },
  stdbuf: { options: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  npx: {
    flags: [
      "-y",
      "-q",
      "--yes",
      "--no",
      "--quiet",
      "--no-install",
      "--ignore-existing",
      "--prefer-offline",
      "--prefer-online",
    ],
    options: ["-p", "--package", "--registry", "--cache", "--userconfig"],
    stops: ["-c", "--call"],
  },
  bunx: { flags: ["--bun", "--silent", "--verbose", "--no-install"], options: ["-p", "--package"] },
  pnpx: { flags: ["--silent", "-s"], options: ["--package"] },
};

/** Shell keywords a command follows (`for …; do gh issue view …`); they take no options. */
const KEYWORDS_BEFORE_COMMAND: Readonly<Record<string, true>> = Object.fromEntries(
  ["do", "then", "else", "!", "{"].map((word) => [word, true as const]),
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

type Vocabulary = Readonly<Record<string, true>>;

const words = (text: string): Vocabulary =>
  Object.fromEntries(text.split(" ").map((word) => [word, true as const]));

const PACKAGE_MANAGER_SUBCOMMANDS = words(
  "install i ci add remove rm uninstall run test t build lint check typecheck format fmt dev start exec dlx x publish pack outdated update upgrade up audit why list ls init create link unlink version rebuild prune dedupe patch store workspace workspaces recursive preview serve deploy clean cache config info view whoami login",
);
const MAKE_TARGETS = words(
  "all build test check lint format fmt clean install dev run release deploy docs ci typecheck bench coverage setup generate help",
);
const GH_GROUPS = words(
  "pr issue run workflow api release repo auth secret variable label search cache gist project ruleset status codespace extension alias config browse ssh-key gpg-key attestation org",
);
const GH_ACTIONS = words(
  "list view create checks merge diff edit close reopen comment status checkout review ready watch rerun cancel download delete run enable disable upload clone fork sync set login logout token refresh develop lock unlock pin unpin transfer prs issues repos commits code archive rename deploy-key update-branch revert",
);
const AWS_SERVICES = words(
  "s3 s3api ec2 lambda dynamodb cloudformation logs sts iam ecr ecs sqs sns ssm secretsmanager cloudwatch rds route53 apigateway apigatewayv2 cloudfront kms events stepfunctions ses sesv2 acm elbv2 autoscaling eks codebuild organizations sso configure budgets ce scheduler xray athena glue kinesis firehose",
);
/** An AWS operation: an action verb, then lowercase hyphenated words (`describe-stacks`). */
const AWS_OPERATION =
  /^(?:cp|ls|sync|mv|mb|rb|presign|website|wait|(?:describe|get|list|put|create|delete|update|start|stop|invoke|tail|filter|batch|send|receive|publish|query|scan|tag|untag|attach|detach|run|deploy|validate|set|import|export|restore|enable|disable|register|deregister|modify|reboot|terminate|associate|disassociate|test|lookup|head|copy|upload|download|login|assume|sign|decrypt|encrypt|generate|rotate|cancel|execute|search|add|remove|reset)(?:-[a-z0-9]+)*)$/u;
const GCLOUD_GROUPS = words(
  "compute run functions storage projects config auth container sql iam logging builds app secrets pubsub artifacts services scheduler",
);
const GCLOUD_ACTIONS = words(
  "instances services revisions jobs buckets clusters list describe create delete deploy update set get login read submit logs execute get-credentials versions",
);

/**
 * CLIs whose first words after the program name say what it does (`gh pr checks`, `git push`):
 * each level's known words. A word outside the vocabulary (a branch, a script, a value) ends the
 * phrase, so only the CLI's own words are ever named.
 */
const SUBCOMMANDS: Readonly<Record<string, ReadonlyArray<Vocabulary | RegExp>>> = {
  gh: [GH_GROUPS, GH_ACTIONS],
  aws: [AWS_SERVICES, AWS_OPERATION],
  gcloud: [GCLOUD_GROUPS, GCLOUD_ACTIONS],
  git: [
    words(
      "add am apply bisect blame branch checkout cherry-pick clean clone commit config describe diff fetch grep init log ls-files ls-remote merge merge-base mv pull push rebase reflog remote reset restore revert rev-list rev-parse rm show stash status submodule switch tag worktree cat-file for-each-ref shortlog sparse-checkout notes gc lfs range-diff format-patch update-index symbolic-ref",
    ),
  ],
  npm: [PACKAGE_MANAGER_SUBCOMMANDS],
  pnpm: [PACKAGE_MANAGER_SUBCOMMANDS],
  yarn: [PACKAGE_MANAGER_SUBCOMMANDS],
  bun: [PACKAGE_MANAGER_SUBCOMMANDS],
  cargo: [
    words(
      "build b test t run r check c clippy fmt doc bench install publish update add remove tree nextest clean fix metadata search",
    ),
  ],
  go: [words("build test run vet fmt mod generate install get work tool clean list env version")],
  docker: [
    words(
      "build run compose ps push pull exec images logs stop start restart rm rmi tag login buildx inspect network volume system container image",
    ),
  ],
  kubectl: [
    words(
      "get apply describe logs delete exec rollout port-forward create edit scale top config patch label annotate wait diff",
    ),
  ],
  uv: [words("run pip sync lock add remove venv tool python build publish init tree export")],
  poetry: [words("install run add remove lock update build publish show shell check env")],
  deno: [words("run test task fmt lint check compile bench install cache info doc publish add")],
  make: [MAKE_TARGETS],
  terraform: [
    words(
      "init plan apply destroy validate fmt output state import workspace providers show refresh graph console taint untaint",
    ),
  ],
  lune: [words("run setup build")],
  rokit: [words("install add update list self-update trust init authenticate")],
  rojo: [words("serve build sourcemap syncback init upload plugin fmt-project")],
  omp: [
    words(
      "models plugin config agents setup stats commit install login ssh skill ps gc find search share bench",
    ),
  ],
  resin: [
    words(
      "init login status service mcp privacy feedback control doctor repair upgrade uninstall version help",
    ),
  ],
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

/**
 * A script operand: a relative path of plain segments ending in a source extension. No absolute or
 * home path, no `..`, no placeholder or expansion.
 */
const SCRIPT =
  /^(?:\.\/)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/){0,4}[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:py|js|mjs|cjs|ts|mts|cts|sh|bash|zsh|rb|pl|lua|luau)$/u;
/** A Python module run with `-m` (`pytest`, `http.server`). */
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
/** An executable's basename worth naming. */
const PROGRAM = /^[A-Za-z][A-Za-z0-9._+-]{0,39}$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** One shell word: its text with quotes removed, and whether any of it was quoted or escaped. */
interface Word {
  readonly text: string;
  readonly quoted: boolean;
}

/**
 * The words of each simple command in a shell program, quotes removed. Pipes, lists, subshells and
 * command substitutions separate commands outside quotes; a redirection (`2>&1`, `> out.txt`) and
 * its target belong to no command; a here-document's body is data, never a command, and is
 * skipped through its delimiter line.
 */
function simpleCommands(program: string): Word[][] {
  const commands: Word[][] = [];
  let current: Word[] = [];
  let word = "";
  let quote: string | undefined;
  let quoted = false;
  let skipTarget = false;
  /** Here-documents opened on the current line, whose bodies start after it. */
  let heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const endWord = () => {
    if (word.length > 0 || quoted) {
      if (skipTarget) skipTarget = false;
      else current.push({ text: word, quoted });
    }
    word = "";
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (current.length > 0) commands.push(current);
    current = [];
    skipTarget = false;
  };
  /** The delimiter word after `<<`/`<<-`, quotes removed; returns where it ends. */
  const readDelimiter = (from: number): { delimiter: string; end: number } => {
    let at = from;
    while (program[at] === " " || program[at] === "\t") at += 1;
    let delimiter = "";
    let open: string | undefined;
    for (; at < program.length; at += 1) {
      const char = program[at]!;
      if (open !== undefined) {
        if (char === open) open = undefined;
        else delimiter += char;
      } else if (char === "'" || char === '"') open = char;
      else if (char === "\\") {
        if (at + 1 < program.length) delimiter += program[(at += 1)]!;
      } else if (/[\s|&;<>()`]/u.test(char)) break;
      else delimiter += char;
    }
    return { delimiter, end: at };
  };
  /** Skips the bodies of the line's here-documents, starting at `from`; returns where they end. */
  const skipHeredocBodies = (from: number): number => {
    let at = from;
    for (const { delimiter, stripTabs } of heredocs) {
      for (;;) {
        if (at >= program.length) return program.length;
        const newline = program.indexOf("\n", at);
        const lineEnd = newline < 0 ? program.length : newline;
        let line = program.slice(at, lineEnd);
        if (stripTabs) line = line.replace(/^\t+/u, "");
        at = lineEnd + 1;
        if (line === delimiter) break;
      }
    }
    heredocs = [];
    return at;
  };
  for (let at = 0; at < program.length; at += 1) {
    const char = program[at]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === "\\" && at + 1 < program.length)
        word += program[(at += 1)]!;
      else word += char;
      continue;
    }
    if (char === "\\") {
      // A line continuation joins lines; any other escaped character is part of a quoted word.
      if (program[at + 1] === "\n") at += 1;
      else if (at + 1 < program.length) {
        word += program[(at += 1)]!;
        quoted = true;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === "<" && program[at + 1] === "<" && program[at + 2] !== "<") {
      // A here-document: its body, on the lines after this one, is data.
      endWord();
      const stripTabs = program[at + 2] === "-";
      const { delimiter, end } = readDelimiter(at + (stripTabs ? 3 : 2));
      heredocs.push({ delimiter, stripTabs });
      at = end - 1;
    } else if (char === ">" || char === "<") {
      // A file-descriptor number before the operator is part of it, not a word.
      if (!quoted && /^\d+$/u.test(word)) word = "";
      endWord();
      // `<<<` is a here-string: the word after it is data, like any redirection target.
      if (char === "<" && program[at + 1] === "<") at += 2;
      else if (program[at + 1] === ">" || program[at + 1] === "|") at += 1;
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
    } else if (char === "\n") {
      endCommand();
      if (heredocs.length > 0) at = skipHeredocBodies(at + 1) - 1;
    } else if ("|&;()`".includes(char)) {
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

/** Where a wrapper's command starts, or undefined when no command can be named after it. */
function afterWrapper(
  words: readonly Word[],
  start: number,
  grammar: WrapperGrammar,
): number | undefined {
  let at = start;
  let operands = grammar.operands ?? 0;
  while (at < words.length) {
    const { text, quoted } = words[at]!;
    if (quoted) return operands > 0 ? undefined : at;
    if (text === "--") return at + 1;
    if (!text.startsWith("-") || text === "-") {
      if (operands === 0) return at;
      operands -= 1;
      at += 1;
      continue;
    }
    if (grammar.numeric === true && /^-\d+$/u.test(text)) {
      at += 1;
      continue;
    }
    const name = text.startsWith("--") ? text.split("=")[0]! : text.slice(0, 2);
    if (grammar.stops?.includes(name)) return undefined;
    if (grammar.flags?.includes(text) || (grammar.flags?.includes(name) && text.includes("="))) {
      at += 1;
    } else if (grammar.options?.includes(name)) {
      // `-uNAME` and `--user=NAME` carry their argument; `-u NAME` takes the next word.
      at += text === name ? 2 : 1;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** Whether a subcommand word is in a CLI's vocabulary at one level. */
function known(level: Vocabulary | RegExp, word: Word): boolean {
  if (word.quoted) return false;
  return level instanceof RegExp
    ? level.test(word.text)
    : Object.hasOwn(level, word.text) && level[word.text] === true;
}

/** The command an agent would recognise in one simple command, or undefined for plumbing. */
function commandPhrase(words: readonly Word[]): string | undefined {
  let at = 0;
  for (;;) {
    while (at < words.length && !words[at]!.quoted && ASSIGNMENT.test(words[at]!.text)) at += 1;
    const word = words[at];
    if (word === undefined || word.quoted) break;
    if (Object.hasOwn(KEYWORDS_BEFORE_COMMAND, word.text)) {
      at += 1;
      continue;
    }
    const grammar = Object.hasOwn(WRAPPERS, word.text) ? WRAPPERS[word.text] : undefined;
    if (grammar === undefined) break;
    const next = afterWrapper(words, at + 1, grammar);
    if (next === undefined) return undefined;
    at = next;
  }
  const program = words[at];
  if (program === undefined || program.quoted) return undefined;
  const name = program.text.split("/").at(-1) ?? program.text;
  if (!PROGRAM.test(name) || Object.hasOwn(PLUMBING, name)) return undefined;
  const phrase = [name];
  let next = at + 1;
  const levels = Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name]! : [];
  for (const level of levels) {
    const word = words[next];
    if (word === undefined || !known(level, word)) break;
    phrase.push(word.text);
    next += 1;
  }
  if (Object.hasOwn(RUNS_NEXT_PROGRAM, phrase.join(" "))) return commandPhrase(words.slice(next));
  if (Object.hasOwn(SCRIPT_RUNNERS, name)) {
    // What runs is the module or script it names (`python3 -m pytest`, `python3 scripts/x.py`);
    // `python3 -c` names neither.
    while (next < words.length && !words[next]!.quoted && words[next]!.text.startsWith("-")) {
      const module = words[next + 1];
      if (
        words[next]!.text === "-m" &&
        module !== undefined &&
        !module.quoted &&
        MODULE.test(module.text)
      ) {
        return `${name} -m ${module.text}`;
      }
      next += 1;
    }
    const script = words[next];
    return script !== undefined && !script.quoted && SCRIPT.test(script.text)
      ? `${name} ${script.text.replace(/^\.\//u, "")}`
      : undefined;
  }
  return phrase.join(" ");
}

/**
 * Whether a command names a private value: it contains one, or one of its words is one. Values
 * too short to be told from ordinary words are matched as whole words only.
 */
function namesPrivateValue(command: string, privateValues: readonly string[]): boolean {
  const lower = command.toLowerCase();
  const commandWords = lower.split(/[\s/.]+/u);
  return privateValues.some((value) => {
    const needle = value.trim().toLowerCase();
    if (needle.length === 0) return false;
    return needle.length >= 4 ? lower.includes(needle) : commandWords.includes(needle);
  });
}

/**
 * The distinct commands one recorded shell program runs, in the order it runs them. Give it the
 * projected program text — never one with private values resolved into it; any command that still
 * names one of `privateValues` is dropped.
 */
export function programCommands(program: string, privateValues: readonly string[] = []): string[] {
  const commands: string[] = [];
  for (const words of simpleCommands(program)) {
    const phrase = commandPhrase(words);
    if (
      phrase !== undefined &&
      !commands.includes(phrase) &&
      !namesPrivateValue(phrase, privateValues)
    ) {
      commands.push(phrase);
    }
  }
  return commands;
}

/**
 * Whether `program` is a CLI whose subcommands say what it does (`gh`, `git`, `pnpm`): a command
 * phrase that is only its name ran a subcommand outside the known vocabulary, so it names no job.
 */
export function hasSubcommandVocabulary(program: string): boolean {
  return Object.hasOwn(SUBCOMMANDS, program);
}

/** Plumbing that changes files: a step running one is never a cheap extra. */
const WRITES_FILES: Readonly<Record<string, true>> = Object.fromEntries(
  ["rm", "mv", "cp", "mkdir", "touch", "tee", "ln", "chmod", "rsync", "dd", "truncate"].map(
    (name) => [name, true as const],
  ),
);

/**
 * Whether a shell program runs plumbing that changes files (`rm`, `cp`, `mkdir`, `sed -i`), which
 * {@link programCommands} does not name. Redirections are not considered.
 */
export function programWritesFiles(program: string): boolean {
  for (const words of simpleCommands(program)) {
    const first = words.find((word) => !ASSIGNMENT.test(word.text));
    if (first === undefined || first.quoted) continue;
    const name = first.text.split("/").at(-1) ?? first.text;
    if (Object.hasOwn(WRITES_FILES, name)) return true;
    if (name === "sed" && words.some((word) => /^-[a-zA-Z]*i/u.test(word.text))) return true;
  }
  return false;
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
