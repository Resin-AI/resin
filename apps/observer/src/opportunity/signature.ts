import {
  type EpisodeSignature,
  type NormalizedCommandExecEvent,
  type NormalizedFileEditEvent,
  type NormalizedToolCallEvent,
  hashCanonicalContent,
} from "@resin/contracts";
import {
  extractShapeArgumentProfile,
  hasParameterShapeEnvelope,
  parseParameterShapeEnvelope,
} from "./parameter-shape.js";
import type { Episode, OpportunityDataValue, SemanticOperation, ToolClass } from "./types.js";

export { extractShapeArgumentProfile, hasParameterShapeEnvelope, parseParameterShapeEnvelope };

export type { SemanticOperation };

/** Literal engine revision of the structural signature extractor. */
export const SIGNATURE_ENGINE_VERSION = "1.0.0";

function getValueTypeName(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  const tag = Object.prototype.toString.call(val);
  if (tag === "[object String]") return "string";
  if (tag === "[object Number]") return "number";
  if (tag === "[object Boolean]") return "boolean";
  if (tag === "[object BigInt]") return "bigint";
  if (tag === "[object Symbol]") return "symbol";
  if (tag === "[object Function]") return "function";
  if (tag === "[object Array]") return "array";
  if (tag === "[object Object]") return "object";
  return "object";
}

/**
 * Normalizes file paths to generic semantic aliases.
 */
export function normalizePathAlias(rawPath: string): string {
  if (!rawPath || Object.prototype.toString.call(rawPath) !== "[object String]") return "$PATH";
  const cleaned = rawPath.replace(/\\/g, "/").trim();

  // Test files
  if (
    /\.(test|spec)\.[a-zA-Z0-9]+$/.test(cleaned) ||
    /\/tests?\//.test(cleaned) ||
    /\/__tests__\//.test(cleaned) ||
    cleaned.startsWith("test_")
  ) {
    return "$TEST_FILE";
  }

  // Configuration files
  if (
    /(package\.json|tsconfig.*\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|\.env.*|.*config\.[a-zA-Z0-9]+)$/.test(
      cleaned,
    )
  ) {
    return "$CONFIG_FILE";
  }

  // Temporary paths
  if (/(^|\/)(tmp|temp|\.tmp)(\/|$)/.test(cleaned)) {
    return "$TMP_DIR";
  }

  // Build / output directories
  if (/(^|\/)(dist|build|target|out|\.next|\.turbo)(\/|$)/.test(cleaned)) {
    return "$BUILD_DIR";
  }

  // Documentation files
  if (
    /\.(md|mdx|rst)$/i.test(cleaned) ||
    /(^|\/)(docs?|documentation)(\/|$)/.test(cleaned) ||
    /\.txt$/i.test(cleaned)
  ) {
    return "$DOC_FILE";
  }

  // Source files
  if (
    /(^|\/)(src|lib|app|pkg|internal|components|routes)(\/|$)/.test(cleaned) ||
    /\.(ts|tsx|js|jsx|rs|go|py|java|c|cpp|h|hpp|rb|php|swift|kt)$/i.test(cleaned)
  ) {
    return "$SRC_FILE";
  }

  return "$PATH";
}

/**
 * Normalizes a tool name into a canonical lowercase identifier.
 */
export function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Normalizes executable path to base name (e.g. ./target/debug/ox -> ox).
 */
export function extractExecutableName(rawExe: string): string {
  if (!rawExe) return "cmd";
  const portable = rawExe.replace(/\\/g, "/");
  const base = portable.slice(portable.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat|sh)$/i, "").toLowerCase() || "cmd";
}

/**
 * Splits a command string into argv tokens while respecting quotes and escapes.
 */
export function tokenizeCommandLine(cmd: string): string[] {
  const trimmed = cmd.trim();
  if (!trimmed) return [];
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escaped) {
      current += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Matches a shell redirection token: `>`, `>>`, `<`, `2>`, `2>&1`, `>&2`, `&>`,
 * `>/path`, `2>/dev/null`, etc. Redirections alter output routing, not workflow
 * intent, so they are excluded from both the command profile and the argument
 * profile to keep otherwise-identical commands on one signature.
 */
const SHELL_REDIRECTION = /^(?:\d*>>?|\d*<|&>|>&|\d*>&\d+).*$/;

/**
 * Normalizes an observed command into a stable, non-shell command profile.
 * Paths are reduced to semantic aliases while executable, subcommand, and flags remain exact.
 */

export function normalizeCommandProfile(rawCommand: string): string {
  const normalized = rawCommand
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return "";

  return (
    normalized
      .split(" ")
      .slice(0, 32)
      // Drop shell redirections (2>&1, >file, >>log, <in, 2>/dev/null, &>) — they
      // alter output routing, not the workflow's intent, and would otherwise split
      // otherwise-identical commands into distinct signatures.
      .filter((part) => !SHELL_REDIRECTION.test(part))
      .map((part, index) => {
        if (index === 0) {
          const portable = part.replace(/\\/g, "/");
          return portable.slice(portable.lastIndexOf("/") + 1).toLowerCase();
        }
        if (part.startsWith("-")) return part;
        if (
          part.includes("/") ||
          /\.(?:ts|tsx|js|jsx|json|md|yaml|yml|rs|toml|py|sh|sql|proto|graphql)$/i.test(part)
        ) {
          return normalizePathAlias(part);
        }
        return part;
      })
      .join(" ")
  );
}

/**
 * Command executables that carry no workflow signal: pure output, inspection,
 * diagnostics, and shell plumbing. These are the ops an agent interleaves between
 * the real work (echo separators, ls/cat/head/tail viewers, grep/sed/awk filters,
 * pgrep/pkill/stat/test diagnostics, and shell control-flow keywords). They are
 * excluded from the signature's structural arrays so run-to-run agent noise does
 * not fragment clustering — the signature reflects the workflow, not the agent's
 * incidental command stream.
 */
const LOW_SIGNAL_COMMANDS: Readonly<Record<string, true>> = Object.fromEntries(
  [
    // pure output / formatting
    "echo",
    "printf",
    "yes",
    // inspection / viewers
    "cat",
    "ls",
    "dir",
    "pwd",
    "head",
    "tail",
    "wc",
    "less",
    "more",
    "tree",
    // text filters / readers
    "grep",
    "egrep",
    "fgrep",
    "sed",
    "awk",
    "cut",
    "tr",
    "sort",
    "uniq",
    "comm",
    "diff",
    "jq",
    "tee",
    // diagnostics / process inspection
    "pgrep",
    "pkill",
    "ps",
    "stat",
    "file",
    "which",
    "whereis",
    "type",
    "printenv",
    "uname",
    "hostname",
    "whoami",
    "id",
    "date",
    "uptime",
    "df",
    "du",
    "free",
    "nproc",
    "arch",
    // shell plumbing / control flow
    "cd",
    "test",
    "[",
    "[[",
    "true",
    "false",
    "set",
    "export",
    "unset",
    "read",
    "wait",
    "sleep",
    "clear",
    "history",
    "jobs",
    "bg",
    "fg",
    "kill",
    "trap",
    "shift",
    "for",
    "while",
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "do",
    "done",
    "case",
    "esac",
    "function",
    "return",
    "exit",
    "break",
    "continue",
    "in",
    "select",
    "until",
    // tokenization artifacts (NOT real shell interpreters — `bash -c …`/`sh deploy.sh`
    // wrap real work and must stay in the signature)
    "_str",
    "_arg",
    "_path",
    "_cmd",
  ].map((name) => [name, true]),
);

/**
 * Non-shell tool names that carry no workflow signal: pure reads and listings.
 * A read/glob/grep tool call pads a workflow that also performs real work; it is
 * excluded from the signature so the read does not fragment clustering.
 */
const LOW_SIGNAL_TOOLS: Readonly<Record<string, true>> = Object.fromEntries(
  ["read", "glob", "grep", "list", "ls", "find", "search", "view", "cat", "stat"].map((name) => [
    name,
    true,
  ]),
);

/**
 * Splits a composite shell command string into individual simple commands.
 * Splits on shell control operators (`&&`, `||`, `;`, `|`) so that evidence
 * like `git log --oneline -5 && git status --porcelain` yields one profile
 * per simple command instead of a single lossy verbatim composite.
 */
export const splitCompositeCommands = splitCompositeCommand;

export function splitCompositeCommand(rawCommand: string): string[] {
  const cleaned = rawCommand.replace(/[\r\n\0]/g, " ");
  // Quote-aware split on shell control operators (&&, ||, ;, |) so operators
  // inside single/double quotes (e.g. grep "a|b") do not split the command.
  const segments: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === ";") {
        segments.push(current);
        current = "";
        continue;
      }
      if (ch === "|" && cleaned[i + 1] === "|") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      if (ch === "&" && cleaned[i + 1] === "&") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      if (ch === "|") {
        segments.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * Classifies a tool or command into a high-level ToolClass.
 */
export function classifyToolOrCommand(name: string, commandText?: string): ToolClass {
  const lowerName = name.toLowerCase();

  // 1. File Read
  if (
    lowerName.includes("read") ||
    lowerName.includes("view") ||
    lowerName === "cat" ||
    lowerName === "head" ||
    lowerName === "tail" ||
    lowerName === "file_read"
  ) {
    return "file_read";
  }

  // 2. File Edit
  if (
    lowerName.includes("edit") ||
    lowerName.includes("write") ||
    lowerName.includes("patch") ||
    lowerName.includes("replace") ||
    lowerName.includes("sed") ||
    lowerName === "file_edit"
  ) {
    return "file_edit";
  }

  // 3. Search / Grep / Glob
  if (
    lowerName.includes("grep") ||
    lowerName.includes("glob") ||
    lowerName.includes("find") ||
    lowerName.includes("search") ||
    lowerName === "rg" ||
    lowerName === "ripgrep" ||
    lowerName === "ag"
  ) {
    return "search";
  }

  // 4. Test Runner / Linters
  if (
    lowerName.includes("test") ||
    lowerName.includes("vitest") ||
    lowerName.includes("jest") ||
    lowerName.includes("pytest") ||
    lowerName.includes("lint") ||
    lowerName.includes("clippy") ||
    (commandText &&
      /\b(vitest|jest|pytest|cargo test|pnpm test|npm test|go test|ox test|bun test|deno test|ctest|rspec|playwright test|ox lint|ox check|eslint|cargo clippy|clippy|ruff|flake8|mypy|biome check)\b/i.test(
        commandText,
      ))
  ) {
    return "test_runner";
  }

  // 5. Build Tools / Compilers
  if (
    lowerName.includes("build") ||
    lowerName.includes("compile") ||
    lowerName.includes("tsc") ||
    (commandText &&
      /\b(pnpm build|npm run build|cargo build|make|webpack|vite build|tsc|ox build|bun build|ninja|cmake|gradle|mvn)\b/i.test(
        commandText,
      ))
  ) {
    return "build_tool";
  }

  // 6. VCS (Git)
  if (
    lowerName.includes("git") ||
    lowerName.includes("vcs") ||
    (commandText && /\b(git|hg|svn|jj)\b/i.test(commandText))
  ) {
    return "vcs";
  }

  // 7. Package Managers
  if (
    lowerName.includes("npm") ||
    lowerName.includes("pnpm") ||
    lowerName.includes("yarn") ||
    lowerName.includes("cargo") ||
    lowerName.includes("pip") ||
    (commandText &&
      /\b(pnpm add|pnpm i|npm install|cargo add|pip install|yarn add|bun add)\b/i.test(commandText))
  ) {
    return "package_manager";
  }

  // 8. Subagent / Task Delegation
  if (
    lowerName.includes("agent") ||
    lowerName.includes("subagent") ||
    lowerName.includes("task") ||
    lowerName.includes("delegate")
  ) {
    return "subagent";
  }

  // 9. Browser / GUI automation
  if (
    lowerName.includes("browser") ||
    lowerName.includes("playwright") ||
    lowerName.includes("puppeteer") ||
    lowerName.includes("chromium")
  ) {
    return "browser";
  }

  // 10. Shell Exec
  if (
    lowerName === "bash" ||
    lowerName === "sh" ||
    lowerName === "exec" ||
    lowerName === "command_exec" ||
    lowerName === "shell" ||
    lowerName === "terminal" ||
    lowerName === "exec_command"
  ) {
    return "shell_exec";
  }

  return "general";
}
/**
 * Extracts a deterministic argument profile from tool parameters or command args.
 * Shell redirection tokens are dropped so output-routing differences do not split
 * otherwise-identical commands into distinct signatures.
 */
function extractArgumentProfile(
  args: OpportunityDataValue | Record<string, OpportunityDataValue> | unknown[] | null | undefined,
): string {
  if (args === null || args === undefined) return "nil";
  if (hasParameterShapeEnvelope(args)) {
    const shape = parseParameterShapeEnvelope(args);
    return shape ? extractShapeArgumentProfile(shape) : "nil";
  }
  if (Object.prototype.toString.call(args) !== "[object Object]" && !Array.isArray(args)) {
    return getValueTypeName(args);
  }
  if (Array.isArray(args)) {
    const elementTypes = args
      .filter((item) => !(typeof item === "string" && SHELL_REDIRECTION.test(item)))
      .slice(0, 5)
      .map((item) => {
        if (Object.prototype.toString.call(item) === "[object String]") {
          const str = String(item);
          if (str.startsWith("-")) return str; // Preserve flags like -v, --cached
          return normalizePathAlias(str);
        }
        return getValueTypeName(item);
      });
    return `[${elementTypes.join(",")}]`;
  }

  const profile: Record<string, string> = {};
  const entries = Object.entries(args as Record<string, OpportunityDataValue>).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [key, val] of entries) {
    if (val === null || val === undefined) {
      profile[key] = "null";
    } else if (Object.prototype.toString.call(val) === "[object String]") {
      const str = String(val);
      if (key.toLowerCase().includes("path") || key.toLowerCase().includes("file")) {
        profile[key] = normalizePathAlias(str);
      } else if (str.startsWith("-")) {
        profile[key] = str;
      } else {
        profile[key] = "string";
      }
    } else if (Array.isArray(val)) {
      profile[key] = "array";
    } else if (Object.prototype.toString.call(val) === "[object Object]") {
      profile[key] = "object";
    } else {
      profile[key] = getValueTypeName(val);
    }
  }

  return hashCanonicalContent(profile);
}

/**
 * Deterministic structural feature extractor for Workflow Episodes.
 */
export class SignatureExtractor {
  /**
   * Extracts a deterministic EpisodeSignature from an Episode.
   */
  extractSignature(episode: Episode): EpisodeSignature {
    const operationSequence: string[] = [];
    const toolClasses: ToolClass[] = [];
    const commandPatterns: string[] = [];
    const normalizedPaths: Set<string> = new Set();
    const argumentSchemaHashes: string[] = [];
    const semanticOperations: SemanticOperation[] = [];

    for (const evt of episode.events) {
      if (evt.type === "tool_call") {
        const toolEvt = evt as NormalizedToolCallEvent;
        const normName = normalizeToolName(toolEvt.toolName);
        const toolObj = toolEvt as unknown as Record<string, unknown>;
        let resolvedAction = normName;
        if (typeof toolObj.action === "string" && toolObj.action.trim().length > 0) {
          const rawAct = toolObj.action.trim();
          resolvedAction = normalizeToolName(rawAct).slice(0, 64) || normName;
        }

        let rawCommand: OpportunityDataValue | undefined = undefined;
        if (
          !hasParameterShapeEnvelope(toolEvt.parameters) &&
          toolEvt.parameters &&
          Object.prototype.toString.call(toolEvt.parameters) === "[object Object]"
        ) {
          const params = toolEvt.parameters as Record<string, OpportunityDataValue>;
          rawCommand = params.command ?? params.cmd ?? params.executable;
        }
        const commandText =
          Object.prototype.toString.call(rawCommand) === "[object String]"
            ? String(rawCommand)
            : undefined;

        const isShellTool =
          normName === "bash" ||
          normName === "sh" ||
          normName === "exec" ||
          normName === "command_exec" ||
          normName === "shell" ||
          normName === "terminal" ||
          normName === "exec_command";

        if (commandText) {
          const segments = splitCompositeCommand(commandText);
          if (segments.length > 0) {
            for (let segIdx = 0; segIdx < segments.length; segIdx++) {
              const segment = segments[segIdx];
              const tokens = tokenizeCommandLine(segment);
              const segExecutable = tokens[0] || (isShellTool ? "cmd" : toolEvt.toolName);
              const segArgs = tokens.slice(1);
              const segNormCmd = normalizeToolName(extractExecutableName(segExecutable));
              const commandProfile = normalizeCommandProfile(segment);
              const lowSignal = isShellTool
                ? LOW_SIGNAL_COMMANDS[segNormCmd] === true
                : LOW_SIGNAL_TOOLS[normName] === true;
              if (commandProfile && !lowSignal) commandPatterns.push(commandProfile);

              const cls = classifyToolOrCommand(segExecutable, segment);
              if (!lowSignal) toolClasses.push(cls);

              const op = isShellTool ? `command:${segNormCmd}` : `tool:${normName}`;
              if (!lowSignal) operationSequence.push(op);

              const rawParams = toolEvt.parameters as
                | Record<string, OpportunityDataValue>
                | undefined;
              const segArgProfile = extractArgumentProfile(
                segArgs.length > 0 ? segArgs : rawParams,
              );
              if (!lowSignal) argumentSchemaHashes.push(segArgProfile);

              for (const t of segArgs) {
                if (t.includes("/") || /\.(ts|tsx|js|jsx|json|md|yaml|yml|rs|toml|py)$/i.test(t)) {
                  normalizedPaths.add(normalizePathAlias(t));
                }
              }

              const rawEvtId =
                ("eventId" in toolEvt ? toolEvt.eventId : undefined) ??
                ("id" in toolEvt ? String(toolEvt.id) : undefined);

              const semOp: SemanticOperation = {
                operationClass: cls,
                intent: segExecutable,
                commandProfile: commandProfile,
                commandProfiles: [commandProfile],
                eventIds: rawEvtId ? [rawEvtId] : [],
                profileIds: [`prof_${segIdx}`],
                id: `op_${semanticOperations.length}`,
                order: semanticOperations.length,
                operation: op,
                toolClass: cls,
                commandPattern: commandProfile,
                argumentSchemaHash: segArgProfile,
                rawEventId: rawEvtId,
                rawProfileId: `prof_${segIdx}`,
                executable: segExecutable,
                args: segArgs,
                rawCommand: segment,
                analysisOnly: true,
                lowSignal,
              };
              if (!isShellTool) {
                semOp.action = resolvedAction;
              }
              semanticOperations.push(semOp);
            }
          } else {
            const lowSignal = isShellTool
              ? LOW_SIGNAL_COMMANDS[normName] === true
              : LOW_SIGNAL_TOOLS[normName] === true;
            const op = `tool:${normName}`;
            if (!lowSignal) operationSequence.push(op);
            const cls = classifyToolOrCommand(toolEvt.toolName, commandText);
            if (!lowSignal) toolClasses.push(cls);
            const rawParams = toolEvt.parameters as
              | Record<string, OpportunityDataValue>
              | undefined;
            const argHash = extractArgumentProfile(rawParams);
            if (!lowSignal) argumentSchemaHashes.push(argHash);

            const rawEvtId =
              ("eventId" in toolEvt ? toolEvt.eventId : undefined) ??
              ("id" in toolEvt ? String(toolEvt.id) : undefined);

            const semOp: SemanticOperation = {
              operationClass: cls,
              intent: toolEvt.toolName,
              commandProfile: commandText,
              commandProfiles: commandText ? [commandText] : [],
              eventIds: rawEvtId ? [rawEvtId] : [],
              profileIds: ["prof_0"],
              id: `op_${semanticOperations.length}`,
              order: semanticOperations.length,
              operation: op,
              toolClass: cls,
              commandPattern: commandText,
              argumentSchemaHash: argHash,
              rawEventId: rawEvtId,
              rawProfileId: "prof_0",
              lowSignal,
              rawCommand: commandText,
              analysisOnly: true,
            };
            if (!isShellTool) {
              semOp.action = resolvedAction;
            }
            semanticOperations.push(semOp);
          }
        } else {
          const lowSignal = isShellTool
            ? LOW_SIGNAL_COMMANDS[normName] === true
            : LOW_SIGNAL_TOOLS[normName] === true;
          const op = `tool:${normName}`;
          if (!lowSignal) operationSequence.push(op);

          const cls = classifyToolOrCommand(toolEvt.toolName);
          if (!lowSignal) toolClasses.push(cls);

          const rawParams = toolEvt.parameters as Record<string, OpportunityDataValue> | undefined;
          const isEnvelope = hasParameterShapeEnvelope(rawParams);
          const parsedShape = parseParameterShapeEnvelope(rawParams);
          const argHash = parsedShape
            ? extractShapeArgumentProfile(parsedShape)
            : isEnvelope
              ? "nil"
              : extractArgumentProfile(rawParams);
          if (!lowSignal) argumentSchemaHashes.push(argHash);

          let pathFound: string | undefined = undefined;
          if (
            !isEnvelope &&
            toolEvt.parameters &&
            Object.prototype.toString.call(toolEvt.parameters) === "[object Object]"
          ) {
            for (const [k, v] of Object.entries(toolEvt.parameters)) {
              if (
                Object.prototype.toString.call(v) === "[object String]" &&
                (k.toLowerCase().includes("path") || k.toLowerCase().includes("file"))
              ) {
                const normPath = normalizePathAlias(String(v));
                normalizedPaths.add(normPath);
                if (!pathFound) pathFound = normPath;
              }
            }
          }

          const rawEvtId =
            ("eventId" in toolEvt ? toolEvt.eventId : undefined) ??
            ("id" in toolEvt ? String(toolEvt.id) : undefined);

          const semOp: SemanticOperation = {
            operationClass: cls,
            intent: toolEvt.toolName,
            eventIds: rawEvtId ? [rawEvtId] : [],
            profileIds: ["prof_0"],
            id: `op_${semanticOperations.length}`,
            order: semanticOperations.length,
            operation: op,
            toolClass: cls,
            normalizedPath: pathFound,
            argumentSchemaHash: argHash,
            rawEventId: rawEvtId,
            rawProfileId: "prof_0",
            executable: toolEvt.toolName,
            paths: pathFound ? [pathFound] : [],
            lowSignal,
            analysisOnly: true,
          };
          if (parsedShape) {
            semOp.parameterShape = parsedShape;
          }
          if (!isShellTool) {
            semOp.action = resolvedAction;
          }
          semanticOperations.push(semOp);
        }
      } else if (evt.type === "command_exec") {
        const cmdEvt = evt as NormalizedCommandExecEvent;
        const cmdSegments = splitCompositeCommand(cmdEvt.command);

        if (cmdSegments.length > 1) {
          for (let segIdx = 0; segIdx < cmdSegments.length; segIdx++) {
            const segment = cmdSegments[segIdx];
            const tokens = tokenizeCommandLine(segment);
            const segExecutable = tokens[0] || cmdEvt.command.split(" ")[0] || "cmd";
            const segArgs = tokens.slice(1);
            const normCmd = normalizeToolName(extractExecutableName(segExecutable));
            const lowSignal = LOW_SIGNAL_COMMANDS[normCmd] === true;
            const op = `command:${normCmd}`;
            if (!lowSignal) operationSequence.push(op);

            const cls = classifyToolOrCommand(segExecutable, segment);
            if (!lowSignal) toolClasses.push(cls);

            const commandProfile = normalizeCommandProfile(segment);
            if (commandProfile && !lowSignal) commandPatterns.push(commandProfile);

            const segArgProfile = extractArgumentProfile(segArgs);
            if (!lowSignal) argumentSchemaHashes.push(segArgProfile);

            for (const t of segArgs) {
              if (t.includes("/") || /\.(ts|tsx|js|jsx|json|md|yaml|yml|rs|toml|py)$/i.test(t)) {
                normalizedPaths.add(normalizePathAlias(t));
              }
            }

            const rawEvtId =
              ("eventId" in cmdEvt ? cmdEvt.eventId : undefined) ??
              ("id" in cmdEvt ? String(cmdEvt.id) : undefined);

            semanticOperations.push({
              operationClass: cls,
              intent: segExecutable,
              commandProfile: commandProfile,
              commandProfiles: [commandProfile],
              eventIds: rawEvtId ? [rawEvtId] : [],
              profileIds: [`prof_${segIdx}`],
              id: `op_${semanticOperations.length}`,
              order: semanticOperations.length,
              operation: op,
              toolClass: cls,
              commandPattern: commandProfile,
              argumentSchemaHash: segArgProfile,
              rawEventId: rawEvtId,
              rawProfileId: `prof_${segIdx}`,
              executable: segExecutable,
              args: segArgs,
              rawCommand: segment,
              lowSignal,
              analysisOnly: true,
            });
          }
        } else {
          const fullCmd = [cmdEvt.command, ...(cmdEvt.args ?? [])].filter(Boolean).join(" ");
          const fullSegments = splitCompositeCommand(fullCmd);

          if (fullSegments.length > 1) {
            for (let segIdx = 0; segIdx < fullSegments.length; segIdx++) {
              const segment = fullSegments[segIdx];
              const tokens = tokenizeCommandLine(segment);
              const segExecutable = tokens[0] || cmdEvt.command || "cmd";
              const segArgs = tokens.slice(1);
              const normCmd = normalizeToolName(extractExecutableName(segExecutable));
              const lowSignal = LOW_SIGNAL_COMMANDS[normCmd] === true;
              const op = `command:${normCmd}`;
              if (!lowSignal) operationSequence.push(op);

              const cls = classifyToolOrCommand(segExecutable, segment);
              if (!lowSignal) toolClasses.push(cls);

              const commandProfile = normalizeCommandProfile(segment);
              if (commandProfile && !lowSignal) commandPatterns.push(commandProfile);

              const segArgProfile = extractArgumentProfile(segArgs);
              if (!lowSignal) argumentSchemaHashes.push(segArgProfile);

              for (const t of segArgs) {
                if (t.includes("/") || /\.(ts|tsx|js|jsx|json|md|yaml|yml|rs|toml|py)$/i.test(t)) {
                  normalizedPaths.add(normalizePathAlias(t));
                }
              }

              const rawEvtId =
                ("eventId" in cmdEvt ? cmdEvt.eventId : undefined) ??
                ("id" in cmdEvt ? String(cmdEvt.id) : undefined);

              semanticOperations.push({
                operationClass: cls,
                intent: segExecutable,
                commandProfile: commandProfile,
                commandProfiles: [commandProfile],
                eventIds: rawEvtId ? [rawEvtId] : [],
                profileIds: [`prof_${segIdx}`],
                id: `op_${semanticOperations.length}`,
                order: semanticOperations.length,
                operation: op,
                toolClass: cls,
                commandPattern: commandProfile,
                argumentSchemaHash: segArgProfile,
                rawEventId: rawEvtId,
                rawProfileId: `prof_${segIdx}`,
                executable: segExecutable,
                args: segArgs,
                rawCommand: segment,
                lowSignal,
                analysisOnly: true,
              });
            }
          } else {
            const tokens = tokenizeCommandLine(cmdEvt.command);
            const tokenExecutable = tokens[0] || cmdEvt.command.split(" ")[0] || "cmd";
            const tokenArgs = tokens.slice(1);
            const recordedArgs =
              Array.isArray(cmdEvt.args) && cmdEvt.args.length > 0 ? cmdEvt.args : tokenArgs;
            const cmdName = tokenExecutable;
            const normCmd = normalizeToolName(extractExecutableName(cmdName));
            const lowSignal = LOW_SIGNAL_COMMANDS[normCmd] === true;
            const op = `command:${normCmd}`;
            if (!lowSignal) operationSequence.push(op);
            const cls = classifyToolOrCommand(cmdName, cmdEvt.command);
            if (!lowSignal) toolClasses.push(cls);
            const commandProfile = normalizeCommandProfile(
              recordedArgs && recordedArgs.length > 0
                ? `${cmdName} ${recordedArgs.join(" ")}`
                : cmdEvt.command,
            );
            if (commandProfile && !lowSignal) commandPatterns.push(commandProfile);
            const argHash = extractArgumentProfile(recordedArgs);
            if (!lowSignal) argumentSchemaHashes.push(argHash);

            if (recordedArgs) {
              for (const a of recordedArgs) {
                if (a.includes("/") || /\.(ts|tsx|js|jsx|json|md|yaml|yml|rs|toml|py)$/i.test(a)) {
                  normalizedPaths.add(normalizePathAlias(a));
                }
              }
            }

            const rawEvtId =
              ("eventId" in cmdEvt ? cmdEvt.eventId : undefined) ??
              ("id" in cmdEvt ? String(cmdEvt.id) : undefined);

            semanticOperations.push({
              operationClass: cls,
              intent: cmdName,
              commandProfile: commandProfile,
              commandProfiles: [commandProfile],
              eventIds: rawEvtId ? [rawEvtId] : [],
              profileIds: ["prof_0"],
              id: `op_${semanticOperations.length}`,
              order: semanticOperations.length,
              operation: op,
              toolClass: cls,
              commandPattern: commandProfile,
              argumentSchemaHash: argHash,
              rawEventId: rawEvtId,
              rawProfileId: "prof_0",
              executable: cmdName,
              args: recordedArgs ?? [],
              rawCommand: cmdEvt.command,
              lowSignal,
              analysisOnly: true,
            });
          }
        }

        if (cmdEvt.cwd) {
          normalizedPaths.add(normalizePathAlias(cmdEvt.cwd));
        }
      } else if (evt.type === "file_edit") {
        const editEvt = evt as NormalizedFileEditEvent;
        const normPath = normalizePathAlias(editEvt.filePath);
        const op = `edit:${normPath}`;
        operationSequence.push(op);
        toolClasses.push("file_edit");
        normalizedPaths.add(normPath);
        const argHash = extractArgumentProfile({
          path: normPath,
          type: editEvt.operation,
        });
        argumentSchemaHashes.push(argHash);

        const rawEvtId =
          ("eventId" in editEvt ? editEvt.eventId : undefined) ??
          ("id" in editEvt ? String(editEvt.id) : undefined);

        semanticOperations.push({
          operationClass: "file_edit",
          intent: "edit_file",
          commandProfile: `edit ${normPath}`,
          commandProfiles: [`edit ${normPath}`],
          eventIds: rawEvtId ? [rawEvtId] : [],
          profileIds: ["prof_0"],
          id: `op_${semanticOperations.length}`,
          order: semanticOperations.length,
          operation: op,
          toolClass: "file_edit",
          commandPattern: `edit ${normPath}`,
          normalizedPath: normPath,
          argumentSchemaHash: argHash,
          rawEventId: rawEvtId,
          rawProfileId: "prof_0",
          executable: "edit",
          paths: [normPath],
          lowSignal: false,
          analysisOnly: true,
        });
      }
    }

    // Compute structural hash deterministically over canonical representation
    const structuralDescriptor = {
      ops: operationSequence,
      classes: toolClasses,
      commands: commandPatterns,
      args: argumentSchemaHashes,
    };
    const structuralHash = hashCanonicalContent(structuralDescriptor);

    const signatureId = `sig_${structuralHash.slice(0, 16)}`;

    return {
      signatureId,
      structuralHash,
      operations: operationSequence,
      toolClasses,
      commandPatterns,
      normalizedPaths: Array.from(normalizedPaths),
      argumentSchemaHashes,
      semanticOperations,
      stepCount: episode.metrics.stepCount,
      durationMs: episode.metrics.totalDurationMs,
      tokenCount: episode.metrics.totalTokens,
      retryCount: episode.metrics.retryCount,
      estimatedCostUsd: episode.metrics.estimatedCostUsd,
    };
  }
}

/**
 * Convenience function to extract an EpisodeSignature from an Episode.
 */
export function extractEpisodeSignature(episode: Episode): EpisodeSignature {
  const extractor = new SignatureExtractor();
  return extractor.extractSignature(episode);
}
