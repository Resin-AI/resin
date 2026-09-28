/**
 * Caller-facing input names.
 *
 * A name says what role the value plays in the recorded job — the long flag it follows, the kind of
 * file a path names (`archive_path`, `checksum_path`), a date, a directory, a folder name that fills
 * one path segment — and never the recorded value itself: the input that held `alpha` is `folder`,
 * not `alpha`. Only fixed vocabulary and the command's own flag names can appear in a name. The
 * value's type (`number`, `text`) is the last resort.
 *
 * The device names an input from the value it recorded; the cloud, which only sees private
 * references, names one from the recorded plan where the plan shows it. Both use this vocabulary.
 */

import type { ProgramToken } from "./program-tokens.js";

/** Where one input's value sits in the recorded plan, and what the recording held there. */
export interface InputSite {
  /** The long flag (`--region`) the whole value follows, if any. */
  flag?: string;
  /** The recorded value at the site; read only to classify its role. */
  value?: string;
  /** The whole program token the value is part of, when it is only a span of it. */
  token?: string;
  /** [start, end) of the value inside `token`. */
  span?: { start: number; end: number };
  /** A harness-tool argument name the whole value is passed as. */
  argument?: string;
  /** The shell command the whole token sits in, when the value is a shell word. */
  command?: CommandSite;
}

/** Where a shell word sits in its simple command, read from the recorded program's tokens. */
export interface CommandSite {
  /** The executable's basename (`tar` for `/usr/bin/tar`). */
  name: string;
  /** The option whose value the word is (`-C`, `--directory`), if any. */
  option?: string;
  /** The word's 1-based position among the command's operands, if it is one. */
  operand?: number;
  /** How many operands the command has. */
  operands: number;
  /** The options that appear before the word. */
  before: readonly string[];
  /** The word is the target of an output redirection (`> sums.sha256`). */
  redirect?: true;
}

/** A well-formed input name. */
export const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/u;

/** Names chosen from the value's type alone, which say nothing about its role. */
export const VALUE_TYPE_INPUT_NAME = /^(text|path|number|value)(_\d+)?$/u;

const EXTENSION_ROLES: ReadonlyArray<[RegExp, string]> = [
  [/\.(sql|dump|pgdump|bak)(\.(gz|bz2|xz|zst))?$/iu, "dump_path"],
  [/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tar|zip|7z|rar|gz|bz2|xz|zst)$/iu, "archive_path"],
  [/\.(sha(1|224|256|384|512)(sum)?|md5(sum)?|sum|checksum)$/iu, "checksum_path"],
  [/\.(db|sqlite3?)$/iu, "database_path"],
  [/\.(log)$/iu, "log_path"],
  [/\.(json|ya?ml|toml|ini|conf|cfg|env)$/iu, "config_path"],
  [/\.(csv|tsv|parquet|xlsx?)$/iu, "data_path"],
  [/\.(md|txt|rst|html?|pdf)$/iu, "document_path"],
  [/\.(png|jpe?g|gif|svg|webp)$/iu, "image_path"],
];

function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase()
    .slice(0, 32)
    .replace(/_+$/u, "");
}

/** The value fills one whole `/`-separated segment of a path token (`backups/{folder}/…`). */
function fillsPathSegment(site: InputSite): boolean {
  if (site.token === undefined || site.span === undefined || !site.token.includes("/")) {
    return false;
  }
  const before = site.span.start === 0 ? "/" : site.token[site.span.start - 1];
  const after = site.span.end === site.token.length ? "/" : site.token[site.span.end];
  return before === "/" && after === "/";
}

type Role = { name: string; rank: number };

function siteRole(site: InputSite): Role {
  if (site.flag !== undefined) {
    const name = snake(site.flag);
    if (INPUT_NAME.test(name)) return { name, rank: 0 };
  }
  // The command says what a whole word is for; a span is only part of the word it names.
  const command = site.span === undefined ? site.command : undefined;
  const commandRole = command === undefined ? undefined : commandSiteRole(command, site.value);
  if (commandRole !== undefined) return { name: commandRole, rank: 1 };
  if (site.argument !== undefined) {
    const name = snake(site.argument);
    if (INPUT_NAME.test(name) && name !== "value" && name !== "input") return { name, rank: 1 };
  }
  const value = site.value;
  if (value !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}$|^\d{4}\d{2}\d{2}$/u.test(value)) return { name: "date", rank: 2 };
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:?\d{2}/u.test(value)) return { name: "timestamp", rank: 2 };
    if (REVISION_RANGE.test(value)) return { name: "revision_range", rank: 2 };
    const base = value.replace(/\/+$/u, "").split("/").at(-1) ?? "";
    for (const [pattern, name] of EXTENSION_ROLES) {
      if (pattern.test(base)) return { name, rank: 3 };
    }
    if (value.includes("/")) {
      return /\.[A-Za-z0-9]{1,8}$/u.test(base)
        ? { name: "file_path", rank: 4 }
        : { name: "directory", rank: 4 };
    }
    if (fillsPathSegment(site)) return { name: "folder", rank: 5 };
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/u.test(value)) return { name: "file_name", rank: 6 };
    if (/^-?\d+(\.\d+)?$/u.test(value)) return { name: "number", rank: 7 };
  }
  return { name: "text", rank: 8 };
}

/** The role every site of one input agrees best on: the most specific one any site shows. */
export function inputRoleName(sites: readonly InputSite[]): string {
  let best: Role = { name: "text", rank: 9 };
  for (const site of sites) {
    const role = siteRole(site);
    if (role.rank < best.rank) best = role;
  }
  // A folder is recognised from any site where it fills a path segment, even when another site
  // passes it whole (`tar -C data {folder}`).
  if (best.rank > 5 && sites.some(fillsPathSegment)) return "folder";
  return best.name;
}

/** `base`, or `base_2`, `base_3`, … — the first not in `used`, which it is added to. */
export function uniqueInputName(base: string, used: Set<string>): string {
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

/** A `git`-style revision range (`v0.1..HEAD`, `main...topic`, `HEAD~3..`). */
const REVISION_RANGE =
  /^[\w./~^@{}-]*[\w~^@{}]\.\.\.?(?:[\w~^@{}][\w./~^@{}-]*)?$|^\.\.\.?[\w~^@{}][\w./~^@{}-]*$/u;

/**
 * Long flags that switch behaviour and take no value, so the word after them is not theirs:
 * `git log --oneline v0.1..HEAD` binds a revision range, not a `oneline`.
 */
const BOOLEAN_FLAGS: Readonly<Record<string, true>> = {
  all: true,
  amend: true,
  cached: true,
  check: true,
  color: true,
  decorate: true,
  "dry-run": true,
  force: true,
  graph: true,
  help: true,
  "ignore-case": true,
  json: true,
  list: true,
  long: true,
  merges: true,
  "name-only": true,
  "name-status": true,
  numstat: true,
  oneline: true,
  patch: true,
  porcelain: true,
  quiet: true,
  recursive: true,
  reverse: true,
  short: true,
  silent: true,
  stat: true,
  summary: true,
  verbose: true,
  version: true,
  yes: true,
};

/** Short flags whose value's role is known (`head -n 5` binds a count). */
const SHORT_FLAG_ROLES: Readonly<Record<string, string>> = { n: "count" };

function flagWord(token: ProgramToken | undefined): string | undefined {
  return token?.kind === "word" && token.raw.startsWith("-") ? token.raw : undefined;
}

/**
 * The flag whose value the token at `index` is, named for use as a role: a long flag unless it is a
 * boolean switch — a known one, a `--no-…` negation, or one the program elsewhere follows directly
 * with another flag or nothing — or a short flag with a known value role.
 */
export function valueFlag(tokens: readonly ProgramToken[], index: number): string | undefined {
  const raw = index > 0 ? flagWord(tokens[index - 1]) : undefined;
  if (raw === undefined) return undefined;
  const short = /^-([A-Za-z])$/u.exec(raw)?.[1];
  if (short !== undefined) return SHORT_FLAG_ROLES[short];
  const long = /^--([A-Za-z][A-Za-z0-9-]*)$/u.exec(raw)?.[1];
  if (long === undefined || BOOLEAN_FLAGS[long] === true || long.startsWith("no-"))
    return undefined;
  const switchElsewhere = tokens.some(
    (token, at) =>
      at !== index - 1 &&
      token.kind === "word" &&
      token.raw === raw &&
      (at + 1 === tokens.length ||
        tokens[at + 1]?.kind !== "word" ||
        flagWord(tokens[at + 1]) !== undefined),
  );
  return switchElsewhere ? undefined : long;
}

const SHELL_SEPARATORS: Readonly<Record<string, true>> = {
  "&&": true,
  "||": true,
  ";": true,
  "|": true,
  "|&": true,
  "(": true,
  ")": true,
  "&": true,
  "\n": true,
};

/** Short options that take the next word as their value, per command. */
const VALUE_OPTIONS: Readonly<Record<string, string>> = {
  tar: "CfTXbK",
  mkdir: "m",
  cp: "tS",
  mv: "tS",
};

const CHECKSUM_COMMANDS: Readonly<Record<string, true>> = {
  md5sum: true,
  sha1sum: true,
  sha224sum: true,
  sha256sum: true,
  sha384sum: true,
  sha512sum: true,
  b2sum: true,
  cksum: true,
};

/**
 * The role a command's own semantics give a word. Only clear cases: a directory `mkdir` creates,
 * the directory `tar -C` changes to and the member it then archives, the file a checksum command
 * checks, the source and destination of a copy or move, and a redirect written as a checksum file.
 */
function commandSiteRole(command: CommandSite, value: string | undefined): string | undefined {
  const { name, option, operand, operands, before } = command;
  if (command.redirect) {
    return value !== undefined && /\.(sha(1|224|256|384|512)(sum)?|md5(sum)?)$/iu.test(value)
      ? "checksum_path"
      : undefined;
  }
  if (name === "mkdir" && operand !== undefined) return "directory";
  if (name === "tar") {
    if (option === "-C" || option === "--directory") return "directory";
    if (operand !== undefined && before.some((word) => word === "-C" || word === "--directory")) {
      return "folder";
    }
    // Creating an archive, an operand with no file extension is a directory it archives.
    const creating = before.some(
      (word) => word === "--create" || /^-[A-Za-z]*c[A-Za-z]*$/u.test(word),
    );
    if (
      creating &&
      operand !== undefined &&
      value !== undefined &&
      !/\.[A-Za-z0-9]{1,8}$/u.test(value)
    ) {
      return value.includes("/") ? "directory" : "folder";
    }
    return undefined;
  }
  if (CHECKSUM_COMMANDS[name] === true && operand !== undefined) {
    return before.some((word) => word === "--check" || /^-[A-Za-z]*c[A-Za-z]*$/u.test(word))
      ? "checksum_path"
      : undefined;
  }
  if (name === "cp" || name === "mv") {
    if (option === "-t" || option === "--target-directory") return "destination_path";
    if (operand === undefined || operands < 2) return undefined;
    if (before.some((word) => word === "-t" || word.startsWith("--target-directory"))) {
      return "source_path";
    }
    return operand === operands ? "destination_path" : "source_path";
  }
  return undefined;
}

/**
 * Where the shell word at `index` sits in its simple command: the command's name, the option it is
 * the value of or its operand position, and the options before it. `undefined` for the command word
 * itself, an assignment, an operator, or a word outside any command.
 */
export function shellCommandSite(
  tokens: readonly ProgramToken[],
  index: number,
): CommandSite | undefined {
  if (tokens[index]?.kind === "operator") return undefined;
  let start = index;
  while (start > 0 && SHELL_SEPARATORS[tokens[start - 1]!.raw] !== true) start -= 1;
  let end = index;
  while (end + 1 < tokens.length && SHELL_SEPARATORS[tokens[end + 1]!.raw] !== true) end += 1;
  let at = start;
  while (at <= end && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[at]!.raw)) at += 1;
  const commandWord = tokens[at];
  if (at >= index || commandWord === undefined || typeof commandWord.value !== "string") {
    return undefined;
  }
  const name = commandWord.value.split("/").at(-1) ?? commandWord.value;
  const valueOptions = VALUE_OPTIONS[name] ?? "";
  const before: string[] = [];
  const operandIndexes: number[] = [];
  let found: { option?: string; redirect?: true; before: string[] } | undefined;
  let endOfOptions = false;
  for (let position = at + 1; position <= end; position += 1) {
    const token = tokens[position]!;
    if (token.kind === "operator") {
      // A redirection's target is the next word; it is neither an option nor an operand.
      if (/^\d*(>|>>|>\||&>)$/u.test(token.raw) && position + 1 <= end) {
        if (position + 1 === index) found = { redirect: true, before: [...before] };
        position += 1;
      } else if (/^\d*</u.test(token.raw)) {
        position += 1;
      }
      continue;
    }
    const raw = token.raw;
    if (!endOfOptions && raw === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && raw.startsWith("-") && raw.length > 1) {
      if (position === index) return undefined;
      before.push(raw);
      const long = /^--([A-Za-z][A-Za-z0-9-]*)$/u.exec(raw)?.[1];
      const takesValue =
        long !== undefined
          ? (name === "tar" && (long === "directory" || long === "file")) ||
            ((name === "cp" || name === "mv") && long === "target-directory")
          : !raw.startsWith("--") && valueOptions.includes(raw.at(-1)!);
      if (takesValue && position + 1 <= end) {
        const option = long === undefined ? `-${raw.at(-1)}` : raw;
        if (position + 1 === index) found = { option, before: [...before] };
        position += 1;
      }
      continue;
    }
    if (position === index) found = { before: [...before] };
    operandIndexes.push(position);
  }
  if (found === undefined) return undefined;
  const operand = operandIndexes.indexOf(index);
  return {
    name,
    operands: operandIndexes.length,
    before: found.before,
    ...(found.option === undefined ? {} : { option: found.option }),
    ...(operand < 0 || found.option !== undefined || found.redirect
      ? {}
      : { operand: operand + 1 }),
    ...(found.redirect ? { redirect: true as const } : {}),
  };
}
