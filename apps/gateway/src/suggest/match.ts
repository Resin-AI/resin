/**
 * Matches a shell command an agent ran against the learned tools offered in its repository. Both
 * sides are reduced to command phrases with the same grammar the gateway uses to name what a
 * learned tool runs (`programCommands`: `vitest`, `gh pr checks`, `python3 scripts/build.py`), so
 * a match means a tool's recorded steps already run the command's program and subcommand. A word
 * elsewhere in the command (a path, a `jq` filter, an argument) never matches.
 *
 * Only close fits match: a suggestion that does not fit costs the agent a turn, and a tool that
 * runs more than the agent asked for costs it time or fails on a step it never wanted. So a
 * command matches only when
 * - every command phrase in it is one the tool runs, and at least one names a specific job;
 * - every other step the tool would run is either optional (and turned off in the call example)
 *   or cheap and non-mutating: a read-only lookup that changes no file;
 * - it is not a loop, a stress-test or a background job (`for … in $(seq …)`, `while`, `&`).
 *
 * Bare CLI names (`git`, `pnpm` with an unknown script), script launchers whose script is unknown
 * (`pnpm run`), read-only lookups (`git status`, `gh pr view`) and `--help` / `--version` probes
 * never match: a learned tool does not replace a quick look.
 */
import { hasSubcommandVocabulary, programCommands } from "../meta/learned-commands.js";
import type { SuggestStep, SuggestTool } from "./index-file.js";

/** Phrases that run a script or task the grammar cannot name, so they identify no job. */
const OPAQUE_LAUNCHERS: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "npm run",
    "pnpm run",
    "yarn run",
    "bun run",
    "deno run",
    "deno task",
    "npm exec",
    "pnpm exec",
    "pnpm dlx",
    "yarn exec",
    "yarn dlx",
    "bun x",
    "npm x",
    "go run",
    "docker run",
    "docker exec",
    "kubectl exec",
    "lune run",
  ].map((phrase) => [phrase, true as const]),
);

/** Read-only lookups an agent runs to look at state; a learned tool does not replace them. */
const READ_ONLY: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git rev-parse",
    "git rev-list",
    "git remote",
    "git ls-files",
    "git ls-remote",
    "git blame",
    "git describe",
    "git config",
    "git shortlog",
    "git reflog",
    "git cat-file",
    "git for-each-ref",
    "git merge-base",
    "git grep",
    "git worktree",
    "git stash",
    "gh pr view",
    "gh pr list",
    "gh pr diff",
    "gh pr status",
    "gh issue view",
    "gh issue list",
    "gh repo view",
    "gh auth status",
    "gh auth",
    "gh status",
    "gh run view",
    "gh run list",
    "gh run watch",
    "gh workflow view",
    "gh workflow list",
    "gh release view",
    "gh release list",
    "gh search",
    "gh browse",
    "docker ps",
    "docker images",
    "docker logs",
    "docker inspect",
    "kubectl get",
    "kubectl describe",
    "kubectl logs",
    "kubectl config",
    "npm ls",
    "npm list",
    "npm view",
    "npm info",
    "npm why",
    "npm outdated",
    "npm whoami",
    "npm config",
    "pnpm ls",
    "pnpm list",
    "pnpm view",
    "pnpm info",
    "pnpm why",
    "pnpm outdated",
    "pnpm config",
    "yarn list",
    "yarn info",
    "yarn why",
    "yarn config",
    "cargo tree",
    "cargo metadata",
    "cargo search",
    "go env",
    "go version",
    "go list",
    "uv tree",
    "poetry show",
    "terraform output",
    "terraform show",
    "terraform providers",
    "terraform graph",
    "gcloud config",
    "omp stats",
    "resin status",
    "resin version",
    "resin help",
  ].map((phrase) => [phrase, true as const]),
);

/** Flags whose presence makes the command a help or version probe. */
const PROBE_FLAG = /(?:^|\s)(?:--help|--version|-h|-V)(?=\s|$)/u;

/** Commands longer than this are not matched: a pasted script is not a command to replace. */
export const MAX_SUGGEST_COMMAND_LENGTH = 4_000;

export interface CommandMatch {
  readonly tool: SuggestTool;
  /** The command's phrases the tool runs, in the command's order. */
  readonly covered: readonly string[];
  /** The tool's other commands that calling it as suggested also runs (all cheap lookups). */
  readonly alsoRuns: readonly string[];
  /** Toggle inputs of the optional steps the command does not need: the call sets them false. */
  readonly skip: readonly string[];
}

/** Whether a command phrase names a job a learned tool could do instead. */
export function isDistinctivePhrase(phrase: string): boolean {
  if (Object.hasOwn(READ_ONLY, phrase) || Object.hasOwn(OPAQUE_LAUNCHERS, phrase)) return false;
  if (!phrase.includes(" ") && hasSubcommandVocabulary(phrase)) return false;
  // `aws <service>` and `gcloud <group>` without an operation name no job.
  const words = phrase.split(" ");
  if ((words[0] === "aws" || words[0] === "gcloud") && words.length < 3) return false;
  return true;
}

/** Whether an AWS operation phrase only reads (`aws logs describe-log-groups`). */
function isReadOnlyAwsOperation(phrase: string): boolean {
  const words = phrase.split(" ");
  return (
    words[0] === "aws" &&
    words.length === 3 &&
    /^(?:describe|list|get|head|lookup)-/u.test(words[2] ?? "")
  );
}

/** Whether running a phrase as an extra step is cheap and changes nothing: a read-only lookup. */
export function isCheapLookup(phrase: string): boolean {
  return Object.hasOwn(READ_ONLY, phrase) || isReadOnlyAwsOperation(phrase);
}

/** The command with quoted text blanked, so only its shell syntax is inspected. */
function shellSyntax(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, (quoted) => " ".repeat(quoted.length));
}

/** A loop keyword in command position. */
const LOOP_KEYWORD = /(?:^|[;&|({\n]|\bdo|\bthen)\s*(?:for|while|until|select)\s/u;
/** A lone `&`: not `&&`, nor part of a redirection (`2>&1`, `&>`, `|&`, `<&`). */
const BACKGROUND = /(?:^|[^&>|<])&(?![&>])/u;
/** A `seq` counter, the stress-test loop's usual driver. */
const SEQ = /(?:^|[;&|({\n`]|\$\()\s*seq\s/u;

/**
 * Whether a command repeats or backgrounds work (`for i in $(seq 20); do …; done`, `while …`,
 * `cmd &`): a stress test or a watcher is not a job a learned tool replays once.
 */
export function isLoopOrBackground(command: string): boolean {
  const syntax = shellSyntax(command);
  return LOOP_KEYWORD.test(syntax) || BACKGROUND.test(syntax) || SEQ.test(syntax);
}

interface Fit {
  readonly alsoRuns: readonly string[];
  readonly skip: readonly string[];
}

/**
 * How closely a tool fits a command whose phrases it all runs: undefined when calling it would
 * also run work the command did not ask for.
 */
function closeFit(tool: SuggestTool, phrases: readonly string[]): Fit | undefined {
  const extra = (phrase: string) => !phrases.includes(phrase);
  if (tool.steps === undefined) {
    // Without per-step detail only the tool's other commands are known; each must be a lookup.
    const alsoRuns = tool.commands.filter(extra);
    return alsoRuns.every(isCheapLookup) ? { alsoRuns, skip: [] } : undefined;
  }
  const alsoRuns: string[] = [];
  const skip: string[] = [];
  let covers = false;
  for (const step of tool.steps) {
    const own = step.commands.filter(extra);
    if (step.commands.some((phrase) => phrases.includes(phrase))) {
      covers = true;
      // A step running the command's job may also run lookups, nothing more.
      if (!own.every(isCheapLookup)) return undefined;
      alsoRuns.push(...own);
      continue;
    }
    if (step.optional !== undefined) {
      if (!skip.includes(step.optional)) skip.push(step.optional);
      continue;
    }
    if (!isCheapStep(step)) return undefined;
    alsoRuns.push(...own);
  }
  if (!covers) return undefined;
  return { alsoRuns: [...new Set(alsoRuns)], skip };
}

function isCheapStep(step: SuggestStep): boolean {
  return step.writes !== true && step.commands.every(isCheapLookup);
}

/**
 * The learned tool that is a close fit for `command`, or undefined. With several, the one closest
 * to the command wins (fewest extra commands, then fewest skipped steps), then the first by name,
 * so the result is independent of listing order.
 */
export function matchCommand(
  command: string,
  tools: readonly SuggestTool[],
): CommandMatch | undefined {
  if (command.length === 0 || command.length > MAX_SUGGEST_COMMAND_LENGTH) return undefined;
  if (PROBE_FLAG.test(command)) return undefined;
  if (isLoopOrBackground(command)) return undefined;
  const phrases = programCommands(command);
  if (phrases.length === 0) return undefined;
  if (!phrases.some((phrase) => isDistinctivePhrase(phrase) && !isReadOnlyAwsOperation(phrase))) {
    return undefined;
  }
  let best: CommandMatch | undefined;
  for (const tool of tools) {
    if (tool.commands.length === 0) continue;
    // Every command phrase the agent runs must be one the tool runs; plumbing is not a phrase.
    if (!phrases.every((phrase) => tool.commands.includes(phrase))) continue;
    const fit = closeFit(tool, phrases);
    if (fit === undefined) continue;
    const candidate: CommandMatch = { tool, covered: phrases, ...fit };
    if (best === undefined || ranksAbove(candidate, best)) best = candidate;
  }
  return best;
}

function ranksAbove(a: CommandMatch, b: CommandMatch): boolean {
  if (a.alsoRuns.length !== b.alsoRuns.length) return a.alsoRuns.length < b.alsoRuns.length;
  if (a.skip.length !== b.skip.length) return a.skip.length < b.skip.length;
  return a.tool.name < b.tool.name;
}
