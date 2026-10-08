/**
 * Matches a shell command an agent is about to run against the learned tools offered in its
 * repository. Both sides are reduced to command phrases with the same grammar the gateway uses to
 * name what a learned tool runs (`programCommands`: `vitest`, `gh pr checks`,
 * `python3 scripts/build.py`), so a match means the agent is about to run by hand a command a
 * tool's recorded steps already run.
 *
 * Deliberately conservative: a suggestion that does not fit costs the agent a turn, so a command
 * matches only when every command phrase in it is one the tool runs, and at least one of them names
 * a specific job. Bare CLI names (`git`, `pnpm` with an unknown script), script launchers whose
 * script is unknown (`pnpm run`), read-only lookups (`git status`, `gh pr view`) and `--help` /
 * `--version` probes never match: a learned tool does not replace a quick look.
 */
import { hasSubcommandVocabulary, programCommands } from "../meta/learned-commands.js";
import type { SuggestTool } from "./index-file.js";

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
  /** The tool's other commands, which calling it also runs. */
  readonly alsoRuns: readonly string[];
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

/**
 * The learned tool that covers `command`, or undefined. With several, the one closest to the command
 * wins (fewest commands of its own beyond it), then the first by name, so the result is independent
 * of listing order.
 */
export function matchCommand(
  command: string,
  tools: readonly SuggestTool[],
): CommandMatch | undefined {
  if (command.length === 0 || command.length > MAX_SUGGEST_COMMAND_LENGTH) return undefined;
  if (PROBE_FLAG.test(command)) return undefined;
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
    const candidate: CommandMatch = {
      tool,
      covered: phrases,
      alsoRuns: tool.commands.filter((phrase) => !phrases.includes(phrase)),
    };
    if (best === undefined || ranksAbove(candidate, best)) best = candidate;
  }
  return best;
}

function ranksAbove(a: CommandMatch, b: CommandMatch): boolean {
  if (a.alsoRuns.length !== b.alsoRuns.length) return a.alsoRuns.length < b.alsoRuns.length;
  return a.tool.name < b.tool.name;
}
