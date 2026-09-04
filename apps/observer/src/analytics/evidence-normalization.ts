/**
 * Deterministic, value-free evidence normalization.
 *
 * The metadata-only projection historically dropped every command string and
 * parameter value, which left the cloud with only the *shape* of a session
 * (tool names, key names, exit codes). These helpers replace dropping with a
 * projection onto a finite, enumerable vocabulary so the cloud can recognise
 * *what kind* of work happened (which executables, which subcommands, which
 * flags, which file classes) without ever receiving user content.
 *
 * Guarantees:
 * - Every output token is either (a) an executable basename, (b) a bare
 *   lowercase subcommand word in one of the first two positional slots,
 *   (c) a flag name, (d) a shell operator or redirection from a fixed set, or
 *   (e) a typed placeholder (`$PATH`, `$SRC_FILE`, `$STR`, ...).
 * - Quoted strings, environment assignments, URLs, numbers, globs, paths and
 *   any positional argument after a flag collapse to placeholders.
 * - Path patterns keep only the last few segments, replace identifier-like
 *   segments with `*`, and never include the user's home directory.
 * - All outputs are length- and token-bounded.
 *
 * The placeholder vocabulary intentionally matches the cloud's path aliases so
 * device-produced profiles are stable inputs to clustering.
 */

export const MAX_PROFILE_TOKENS = 32;
export const MAX_PROFILE_LENGTH = 256;
export const MAX_PATH_PATTERN_LENGTH = 128;
export const MAX_PATH_SEGMENTS = 4;
export const MAX_SUBCOMMAND_SLOTS = 2;

const SHELL_OPERATORS: Record<string, true> = { "&&": true, "||": true, "|": true, ";": true };
const REDIRECTIONS: Record<string, true> = {
  ">": true,
  ">>": true,
  "<": true,
  "2>": true,
  "2>>": true,
  "2>&1": true,
  "&>": true,
  "1>": true,
};

const SHELL_WRAPPERS: Record<string, true> = {
  sudo: true,
  env: true,
  time: true,
  nohup: true,
  exec: true,
};

export const SHELL_TOOL_NAMES: Record<string, true> = {
  bash: true,
  sh: true,
  zsh: true,
  shell: true,
  exec: true,
  exec_command: true,
  execute_command: true,
  run_command: true,
  command_exec: true,
  terminal: true,
  run_terminal_cmd: true,
  run_shell_command: true,
};

export const COMMAND_PARAMETER_KEYS: readonly string[] = [
  "command",
  "cmd",
  "commandLine",
  "script",
];

export const PATH_PARAMETER_KEYS: readonly string[] = [
  "path",
  "file",
  "filePath",
  "file_path",
  "filename",
  "fileName",
  "target",
  "target_file",
  "targetFile",
  "directory",
  "dir",
  "cwd",
];

export type PathAlias =
  | "$TEST_FILE"
  | "$CONFIG_FILE"
  | "$TMP_DIR"
  | "$BUILD_DIR"
  | "$DOC_FILE"
  | "$SRC_FILE"
  | "$PATH";

const SOURCE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|c|cpp|h|hpp|rb|php|swift|kt|cs|lua|luau|scala|sh)$/i;
const DATA_EXTENSIONS =
  /\.(json|yaml|yml|toml|csv|xml|sql|proto|graphql|md|mdx|rst|txt|log|env|ini)$/i;

/**
 * Classify a path-like token into the cloud's alias vocabulary.
 * Mirrors resin-cloud `normalizePathAlias` so device and cloud agree.
 */
export function classifyPathAlias(rawPath: string): PathAlias {
  if (typeof rawPath !== "string" || rawPath.length === 0) return "$PATH";
  const cleaned = rawPath.replace(/\\/g, "/").trim();

  if (
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(cleaned) ||
    /(^|\/)tests?\//.test(cleaned) ||
    /(^|\/)__tests__\//.test(cleaned) ||
    /(^|\/)test_[^/]*$/.test(cleaned)
  ) {
    return "$TEST_FILE";
  }
  if (
    /(package\.json|tsconfig[^/]*\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|\.env[^/]*|[^/]*config\.[a-zA-Z0-9]+)$/.test(
      cleaned,
    )
  ) {
    return "$CONFIG_FILE";
  }
  if (/(^|\/)(tmp|temp|\.tmp)(\/|$)/.test(cleaned)) return "$TMP_DIR";
  if (/(^|\/)(dist|build|target|out|\.next|\.turbo)(\/|$)/.test(cleaned)) return "$BUILD_DIR";
  if (/\.(md|mdx|rst|txt)$/i.test(cleaned) || /(^|\/)(docs?|documentation)(\/|$)/.test(cleaned)) {
    return "$DOC_FILE";
  }
  if (
    /(^|\/)(src|lib|app|pkg|internal|components|routes)(\/|$)/.test(cleaned) ||
    SOURCE_EXTENSIONS.test(cleaned)
  ) {
    return "$SRC_FILE";
  }
  return "$PATH";
}

function looksLikePath(token: string): boolean {
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.startsWith("~") || token === "." || token === "..") return true;
  return SOURCE_EXTENSIONS.test(token) || DATA_EXTENSIONS.test(token);
}

const URL_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]+$/i;
const GLOB_TOKEN = /[*?[\]{}]/;
const NUMBER_TOKEN = /^[+-]?\d+(\.\d+)?$/;

/**
 * Executables whose leading positional words are subcommands worth keeping,
 * with the number of slots retained. Anything not listed keeps no positional
 * words at all, so `echo <secret>` or `cat <file>` never carry values.
 */
export const SUBCOMMAND_SLOTS_BY_EXECUTABLE: Record<string, number> = {
  git: 1,
  gh: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  npx: 1,
  pnpx: 1,
  bunx: 1,
  deno: 1,
  cargo: 1,
  rustup: 1,
  go: 1,
  docker: 2,
  "docker-compose": 1,
  podman: 2,
  kubectl: 2,
  helm: 1,
  terraform: 1,
  aws: 2,
  gcloud: 2,
  az: 2,
  pip: 1,
  pip3: 1,
  uv: 2,
  poetry: 1,
  pipx: 1,
  conda: 1,
  make: 1,
  just: 1,
  vitest: 1,
  turbo: 1,
  nx: 1,
  dotnet: 1,
  mvn: 1,
  gradle: 1,
  swift: 1,
  flutter: 1,
  bundle: 1,
  rails: 1,
  mix: 1,
  composer: 1,
  systemctl: 1,
  brew: 1,
  apt: 1,
  "apt-get": 1,
  resin: 2,
  rojo: 1,
  wally: 1,
};
const SUBCOMMAND_WORD = /^[a-z][a-z-]{0,18}[0-9]?$/;
const FLAG_TOKEN = /^-{1,2}[A-Za-z][\w-]*$/;
const FLAG_WITH_VALUE = /^(-{1,2}[A-Za-z][\w-]*)=(.*)$/s;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Typed placeholder for any positional value.
 */
export function placeholderFor(token: string): string {
  if (URL_TOKEN.test(token)) return "$URL";
  if (GLOB_TOKEN.test(token)) return "$GLOB";
  if (looksLikePath(token)) return classifyPathAlias(token);
  if (NUMBER_TOKEN.test(token)) return "$NUM";
  return "$STR";
}

/**
 * Quote-aware tokenizer that also splits out shell control operators and
 * redirections as their own tokens. Quoted regions become single tokens and
 * are flagged so they can never be mistaken for subcommand words.
 */
export function tokenizeShellLine(line: string): Array<{ text: string; quoted: boolean }> {
  const tokens: Array<{ text: string; quoted: boolean }> = [];
  let current = "";
  let quoted = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const flush = () => {
    if (current.length > 0 || quoted) {
      tokens.push({ text: current, quoted });
    }
    current = "";
    quoted = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (escaped) {
      current += c;
      escaped = false;
      continue;
    }
    if (c === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      quoted = true;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      quoted = true;
      continue;
    }
    if (inSingle || inDouble) {
      current += c;
      continue;
    }
    if (c === "\n") {
      // A newline outside quotes ends the simple command, like ';'.
      flush();
      if (tokens.length > 0 && SHELL_OPERATORS[tokens[tokens.length - 1]?.text ?? ""] !== true) {
        tokens.push({ text: ";", quoted: false });
      }
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    if (c === "#" && current.length === 0) {
      // Comment: skip to end of line.
      const nl = line.indexOf("\n", i);
      i = nl === -1 ? line.length : nl - 1;
      continue;
    }
    // Control operators.
    if (c === "&" && line[i + 1] === "&") {
      flush();
      tokens.push({ text: "&&", quoted: false });
      i++;
      continue;
    }
    if (c === "|") {
      flush();
      if (line[i + 1] === "|") {
        tokens.push({ text: "||", quoted: false });
        i++;
      } else {
        tokens.push({ text: "|", quoted: false });
      }
      continue;
    }
    if (c === ";") {
      flush();
      tokens.push({ text: ";", quoted: false });
      continue;
    }
    // Redirections: 2>&1, 2>>, 2>, &>, >>, >, <
    if (c === ">" || c === "<" || ((c === "2" || c === "1" || c === "&") && line[i + 1] === ">")) {
      const rest = line.slice(i);
      const m = rest.match(/^(2>&1|2>>|2>|1>|&>|>>|>|<)/);
      if (m) {
        // A leading digit may actually belong to the current token (e.g. "a2>b" is rare; treat conservatively).
        if ((c === "2" || c === "1") && current.length > 0) {
          current += c;
          continue;
        }
        flush();
        tokens.push({ text: m[1] as string, quoted: false });
        i += (m[1] as string).length - 1;
        continue;
      }
    }
    current += c;
  }
  flush();
  return tokens;
}

function normalizeExecutable(token: string): string {
  const portable = token.replace(/\\/g, "/");
  const base = portable.slice(portable.lastIndexOf("/") + 1);
  const stripped = base.replace(/\.(exe|cmd|bat|sh|mjs|cjs|js|py)$/i, "").toLowerCase();
  if (!stripped || !/^[a-z0-9_.+-]+$/.test(stripped)) return "$STR";
  return stripped.slice(0, 32);
}

/**
 * Produce a value-free command profile for a shell command line.
 *
 * Example: `git commit -m "fix auth" && pnpm test src/a.test.ts | tee out.log`
 *       -> `git commit -m $STR && pnpm test $TEST_FILE | tee $PATH`
 */
/**
 * Interpreters whose `-m <module>` argument names a tool, and the widely used
 * modules that are safe to keep literally. Any other module name is a project
 * identifier and stays `$STR`.
 */
const MODULE_FLAG_INTERPRETERS: Record<string, true> = {
  python: true,
  python3: true,
  py: true,
};

const WELL_KNOWN_PYTHON_MODULES: Record<string, true> = {
  unittest: true,
  pytest: true,
  pip: true,
  venv: true,
  "http.server": true,
  "json.tool": true,
  black: true,
  ruff: true,
  mypy: true,
  flake8: true,
  coverage: true,
  build: true,
  twine: true,
  pdb: true,
  timeit: true,
  doctest: true,
};

export function normalizeCommandProfile(rawCommand: unknown): string {
  if (typeof rawCommand !== "string") return "";
  const cleaned = rawCommand.replace(/\0/g, " ").replace(/\r/g, "").trim();
  if (!cleaned) return "";
  // Heredoc bodies and anything after a heredoc marker are dropped entirely.
  const heredocIndex = cleaned.search(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/);
  const script = heredocIndex >= 0 ? cleaned.slice(0, heredocIndex) : cleaned;

  const out: string[] = [];
  let atCommandStart = true;
  let subcommandSlots = 0;
  let subcommandBudget = 0;
  let seenFlag = false;
  let moduleFlagPending = false;
  let currentExecutable = "";

  const pushToken = (t: string): boolean => {
    if (out.length >= MAX_PROFILE_TOKENS) return false;
    out.push(t);
    return true;
  };

  const tokens = tokenizeShellLine(script);
  for (const tok of tokens) {
    const { text, quoted } = tok;
    if (!quoted && SHELL_OPERATORS[text] === true) {
      if (!pushToken(text)) break;
      atCommandStart = true;
      subcommandSlots = 0;
      seenFlag = false;
      moduleFlagPending = false;
      continue;
    }
    if (!quoted && REDIRECTIONS[text] === true) {
      if (!pushToken(text)) break;
      // The redirection target is a positional value; keep flag state.
      continue;
    }
    if (atCommandStart) {
      if (!quoted && ENV_ASSIGNMENT.test(text)) {
        // FOO=bar prefix assignments: keep the variable name only.
        const name = text.slice(0, text.indexOf("="));
        if (!pushToken(`${name}=$STR`)) break;
        continue;
      }
      const exe = quoted ? "$STR" : normalizeExecutable(text);
      if (!pushToken(exe)) break;
      atCommandStart = SHELL_WRAPPERS[exe] === true;
      subcommandSlots = 0;
      subcommandBudget = SUBCOMMAND_SLOTS_BY_EXECUTABLE[exe] ?? 0;
      seenFlag = false;
      moduleFlagPending = false;
      currentExecutable = exe;
      continue;
    }
    if (quoted) {
      moduleFlagPending = false;
      if (!pushToken("$STR")) break;
      continue;
    }
    if (moduleFlagPending) {
      // `python3 -m unittest …`: a well-known module names the tool being run.
      moduleFlagPending = false;
      if (WELL_KNOWN_PYTHON_MODULES[text] === true) {
        if (!pushToken(text)) break;
        continue;
      }
    }
    if (text === "-m" && MODULE_FLAG_INTERPRETERS[currentExecutable] === true) {
      moduleFlagPending = true;
    }
    const flagValue = text.match(FLAG_WITH_VALUE);
    if (flagValue) {
      seenFlag = true;
      const value = flagValue[2] ?? "";
      if (!pushToken(`${flagValue[1]}=${value.length > 0 ? placeholderFor(value) : "$STR"}`)) {
        break;
      }
      continue;
    }
    if (FLAG_TOKEN.test(text)) {
      seenFlag = true;
      if (!pushToken(text.slice(0, 48))) break;
      continue;
    }
    if (
      !seenFlag &&
      subcommandSlots < subcommandBudget &&
      SUBCOMMAND_WORD.test(text) &&
      !looksLikePath(text)
    ) {
      subcommandSlots++;
      if (!pushToken(text)) break;
      continue;
    }
    // Subcommands are contiguous leading words; the first value ends them.
    subcommandBudget = 0;
    if (!pushToken(placeholderFor(text))) break;
  }

  const profile = out.join(" ");
  return profile.length > MAX_PROFILE_LENGTH ? profile.slice(0, MAX_PROFILE_LENGTH) : profile;
}

const IDENTIFIER_SEGMENT =
  /^(?:[0-9a-f]{8,}|[0-9a-f-]{32,}|\d{4,}|\d{8}t\d{6}z?|v?\d+(\.\d+){1,3})$/i;

/**
 * Reduce a filesystem path to a bounded, identifier-free pattern.
 *
 * - Home-directory prefixes are removed (absolute paths become relative to the
 *   deepest few segments; the user is never named).
 * - Segments that look like hashes, UUIDs, timestamps, or version numbers
 *   become `*`.
 * - At most the last {@link MAX_PATH_SEGMENTS} segments survive; the file
 *   name itself is retained so the cloud can classify it.
 */
export function normalizePathPattern(rawPath: unknown, homeDir?: string): string {
  if (typeof rawPath !== "string") return "$PATH";
  let cleaned = rawPath.replace(/\\/g, "/").trim();
  if (!cleaned) return "$PATH";
  if (URL_TOKEN.test(cleaned)) return "$URL";
  if (homeDir && cleaned.startsWith(homeDir.replace(/\\/g, "/"))) {
    cleaned = cleaned.slice(homeDir.length);
  }
  cleaned = cleaned.replace(/^~/, "");
  const segments = cleaned.split("/").filter((s) => s.length > 0 && s !== ".");
  const absolute = cleaned.startsWith("/");
  const kept = segments.slice(-MAX_PATH_SEGMENTS).map((s) => {
    if (IDENTIFIER_SEGMENT.test(s)) return "*";
    if (s.length > 48) return "*";
    // Strip anything outside a conservative character set.
    return s.replace(/[^A-Za-z0-9._@+*-]/g, "_");
  });
  let pattern = kept.join("/");
  if (segments.length > MAX_PATH_SEGMENTS || (absolute && segments.length > 0)) {
    pattern = `…/${pattern}`;
  }
  if (pattern.length > MAX_PATH_PATTERN_LENGTH) {
    pattern = pattern.slice(pattern.length - MAX_PATH_PATTERN_LENGTH);
  }
  return pattern || "$PATH";
}

/**
 * Extract a path from a line-anchored edit payload header such as
 * `[src/foo.ts#A1B2]` (used by hashline-style edit tools). Returns undefined
 * when the payload does not start with such a header.
 */
export function extractAnchoredEditPath(payload: unknown): string | undefined {
  if (typeof payload !== "string") return undefined;
  const m = payload.match(/^\s*\[([^\]#\n]{1,512})#[0-9A-Fa-f]{3,8}\]/);
  return m ? (m[1] as string) : undefined;
}

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES[toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_")] === true;
}

export interface EnrichedParameterProjection {
  /** Parameters safe to ship verbatim (already normalized). */
  parameters: Record<string, string>;
  /** Fields that were normalized rather than dropped. */
  maskedFields: string[];
}

/**
 * Build the enriched parameter projection for a tool call, or return null
 * when the tool call carries nothing worth enriching (caller falls back to the
 * shape envelope).
 */
export function projectEnrichedToolParameters(
  toolName: string,
  rawParams: unknown,
  options: { homeDir?: string } = {},
): EnrichedParameterProjection | null {
  if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
    return null;
  }
  const params = rawParams as Record<string, unknown>;
  const out: Record<string, string> = {};
  const masked: string[] = [];

  if (isShellToolName(toolName)) {
    for (const key of COMMAND_PARAMETER_KEYS) {
      const value = params[key];
      if (typeof value === "string" && value.trim().length > 0) {
        const profile = normalizeCommandProfile(value);
        if (profile) {
          out.command = profile;
          masked.push(key);
          break;
        }
      }
    }
    const cwd = params.cwd;
    if (typeof cwd === "string" && cwd.length > 0) {
      out.cwd = normalizePathPattern(cwd, options.homeDir);
      masked.push("cwd");
    }
  }

  for (const key of PATH_PARAMETER_KEYS) {
    if (key === "cwd" && out.cwd !== undefined) continue;
    const value = params[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = normalizePathPattern(value, options.homeDir);
      masked.push(key);
    }
  }

  if (out.path === undefined && typeof params.input === "string") {
    const anchored = extractAnchoredEditPath(params.input);
    if (anchored) {
      out.path = normalizePathPattern(anchored, options.homeDir);
      masked.push("input");
    }
  }

  if (masked.length === 0) return null;
  return { parameters: out, maskedFields: masked };
}
