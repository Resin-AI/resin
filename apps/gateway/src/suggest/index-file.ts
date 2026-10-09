/**
 * The command-suggestion index: for each repository (by its device-independent identity), the
 * learned tools the gateway offers there and the commands each one runs. Written by `resin mcp`
 * whenever it lists a connection's catalog; read by the per-command suggestion hook, which must not
 * load the gateway. It holds only what the local agent is already shown (tool names, the command
 * phrases a tool's recorded programs run, input names) and never leaves this machine.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COMMAND_SUGGEST_INDEX_VERSION = 1;
/** Repositories kept in the index; the least recently listed are dropped first. */
export const COMMAND_SUGGEST_INDEX_MAX_REPOSITORIES = 200;
/** Tools kept per repository. */
export const COMMAND_SUGGEST_INDEX_MAX_TOOLS = 200;

export interface SuggestToolInput {
  readonly name: string;
  readonly required: boolean;
}

/** What one recorded step of a learned tool runs. */
export interface SuggestStep {
  /** Command phrases the step's program runs; empty for plumbing, edits and harness calls. */
  readonly commands: readonly string[];
  /** The boolean input that turns the step off, when it is optional. */
  readonly optional?: string;
  /** Present when the step changes files (an edit, a write, `rm`/`cp`/`mkdir`, an opaque script). */
  readonly writes?: true;
}

export interface SuggestTool {
  /** The name the agent invokes it by. */
  readonly name: string;
  /** Command phrases its recorded programs run (`vitest`, `gh pr checks`), in run order. */
  readonly commands: readonly string[];
  readonly inputs: readonly SuggestToolInput[];
  /** Its one-line purpose, as the agent is shown it in the catalog. */
  readonly purpose?: string;
  /** What each recorded step runs, when this machine knows its plan. */
  readonly steps?: readonly SuggestStep[];
  /**
   * What each recorded step runs, in plan order (see `ToolProfile.runs`): a suggestion naming the
   * tool adds `Runs: …` when its text leaves one unnamed.
   */
  readonly runs?: readonly string[];
}

/** Longest purpose kept in the index. */
export const SUGGEST_PURPOSE_MAX_CHARS = 200;
/** Most steps kept per tool. */
const MAX_STEPS = 100;

function parseStep(value: unknown): SuggestStep | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const commands = "commands" in value ? value.commands : undefined;
  const optional = "optional" in value ? value.optional : undefined;
  const writes = "writes" in value ? value.writes : undefined;
  if (!Array.isArray(commands)) return undefined;
  return {
    commands: commands.filter(
      (command): command is string => typeof command === "string" && command.length > 0,
    ),
    ...(typeof optional === "string" && optional.length > 0 ? { optional } : {}),
    ...(writes === true ? { writes: true as const } : {}),
  };
}

/** A purpose as one bounded line. */
export function oneLinePurpose(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length === 0) return undefined;
  return line.length > SUGGEST_PURPOSE_MAX_CHARS
    ? `${line.slice(0, SUGGEST_PURPOSE_MAX_CHARS - 1).trimEnd()}…`
    : line;
}

export interface SuggestRepositoryEntry {
  readonly updatedAt: string;
  readonly tools: readonly SuggestTool[];
}

export interface CommandSuggestIndex {
  readonly version: typeof COMMAND_SUGGEST_INDEX_VERSION;
  readonly repositories: Readonly<Record<string, SuggestRepositoryEntry>>;
}

export interface CommandSuggestPathOptions {
  readonly resinHome?: string;
  readonly stateDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resin's state directory, resolved like `@resin/observer`'s `resolvePaths` without loading it:
 * `stateDir`, else `$RESIN_STATE_DIR`, else `<resin home>/state`.
 */
export function resolveSuggestStateDir(options: CommandSuggestPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(options.stateDir) ?? nonEmpty(env.RESIN_STATE_DIR);
  if (explicit !== undefined) return path.resolve(explicit);
  const userHome = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE) ?? os.homedir();
  const resinHome =
    nonEmpty(options.resinHome) ?? nonEmpty(env.RESIN_HOME) ?? path.join(userHome, ".resin");
  return path.join(path.resolve(resinHome), "state");
}

/** Directory holding the index, the opt-out marker and per-session suppression state. */
export function resolveCommandSuggestDir(options: CommandSuggestPathOptions = {}): string {
  return path.join(resolveSuggestStateDir(options), "command-suggest");
}

export function commandSuggestIndexPath(dir: string): string {
  return path.join(dir, "index.json");
}

/** Present when the user turned suggestions off with `resin suggest --disable`. */
export function commandSuggestDisabledPath(dir: string): string {
  return path.join(dir, "disabled");
}

const REPOSITORY_ID = /^[0-9a-f]{64}$/u;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;

function parseTool(value: unknown): SuggestTool | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const name = "name" in value ? value.name : undefined;
  const commands = "commands" in value ? value.commands : undefined;
  const inputs = "inputs" in value ? value.inputs : undefined;
  if (typeof name !== "string" || !TOOL_NAME.test(name) || !Array.isArray(commands)) {
    return undefined;
  }
  const parsedCommands = commands.filter(
    (command): command is string => typeof command === "string" && command.length > 0,
  );
  const parsedInputs: SuggestToolInput[] = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (typeof input !== "object" || input === null) continue;
    const inputName = "name" in input ? input.name : undefined;
    const required = "required" in input ? input.required : undefined;
    if (typeof inputName === "string" && inputName.length > 0) {
      parsedInputs.push({ name: inputName, required: required === true });
    }
  }
  const purpose = "purpose" in value && typeof value.purpose === "string" ? value.purpose : "";
  const shownPurpose = oneLinePurpose(purpose);
  const steps = "steps" in value && Array.isArray(value.steps) ? value.steps : undefined;
  const runs =
    "runs" in value && Array.isArray(value.runs)
      ? value.runs
          .slice(0, MAX_STEPS)
          .filter((label): label is string => typeof label === "string" && label.length > 0)
      : [];
  const parsedSteps = steps?.slice(0, MAX_STEPS).flatMap((step) => {
    const parsed = parseStep(step);
    return parsed === undefined ? [] : [parsed];
  });
  return {
    name,
    commands: parsedCommands,
    inputs: parsedInputs,
    ...(shownPurpose === undefined ? {} : { purpose: shownPurpose }),
    ...(parsedSteps === undefined ? {} : { steps: parsedSteps }),
    ...(runs.length === 0 ? {} : { runs }),
  };
}

/** Parses index text; anything malformed reads as an empty index. */
export function parseCommandSuggestIndex(text: string | undefined): CommandSuggestIndex {
  const empty: CommandSuggestIndex = { version: COMMAND_SUGGEST_INDEX_VERSION, repositories: {} };
  if (text === undefined) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const version = "version" in parsed ? parsed.version : undefined;
  const repositories = "repositories" in parsed ? parsed.repositories : undefined;
  if (version !== COMMAND_SUGGEST_INDEX_VERSION || typeof repositories !== "object") return empty;
  if (repositories === null || Array.isArray(repositories)) return empty;
  const result: Record<string, SuggestRepositoryEntry> = {};
  for (const [id, entry] of Object.entries(repositories)) {
    if (!REPOSITORY_ID.test(id) || typeof entry !== "object" || entry === null) continue;
    const updatedAt = "updatedAt" in entry ? entry.updatedAt : undefined;
    const tools = "tools" in entry ? entry.tools : undefined;
    if (typeof updatedAt !== "string" || !Array.isArray(tools)) continue;
    result[id] = {
      updatedAt,
      tools: tools.flatMap((tool) => {
        const parsedTool = parseTool(tool);
        return parsedTool === undefined ? [] : [parsedTool];
      }),
    };
  }
  return { version: COMMAND_SUGGEST_INDEX_VERSION, repositories: result };
}

function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** The tools indexed for one repository, or undefined when it was never listed. */
export function readRepositoryTools(
  dir: string,
  repositoryId: string,
): readonly SuggestTool[] | undefined {
  const index = parseCommandSuggestIndex(readText(commandSuggestIndexPath(dir)));
  return Object.hasOwn(index.repositories, repositoryId)
    ? index.repositories[repositoryId]?.tools
    : undefined;
}

function sameTools(a: readonly SuggestTool[], b: readonly SuggestTool[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Writes `content` to `filePath` through a private temp file and a rename. */
export function writePrivateFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Replaces one repository's tools in the index; resolves false when they were already current.
 * Concurrent writers may each drop the other's update, which the next listing repairs.
 */
export function writeRepositoryTools(
  dir: string,
  repositoryId: string,
  tools: readonly SuggestTool[],
  now: Date = new Date(),
): boolean {
  if (!REPOSITORY_ID.test(repositoryId)) return false;
  const indexPath = commandSuggestIndexPath(dir);
  const current = parseCommandSuggestIndex(readText(indexPath));
  const previous = Object.hasOwn(current.repositories, repositoryId)
    ? current.repositories[repositoryId]
    : undefined;
  const bounded = tools.slice(0, COMMAND_SUGGEST_INDEX_MAX_TOOLS);
  if (previous !== undefined && sameTools(previous.tools, bounded)) return false;
  const repositories = Object.entries({
    ...current.repositories,
    [repositoryId]: { updatedAt: now.toISOString(), tools: bounded },
  })
    .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, COMMAND_SUGGEST_INDEX_MAX_REPOSITORIES);
  const next: CommandSuggestIndex = {
    version: COMMAND_SUGGEST_INDEX_VERSION,
    repositories: Object.fromEntries(repositories),
  };
  writePrivateFileAtomic(indexPath, `${JSON.stringify(next)}\n`);
  return true;
}
