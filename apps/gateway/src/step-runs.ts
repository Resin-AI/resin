/**
 * What a learned tool runs, as every surface describing it to an agent says. Each recorded step
 * has a label read from this machine's plan: a shell step the command names its program runs
 * (`stylua`, `selene`), an MCP call `<server>.<tool>` (`robloxstudio.solo_playtest`), a harness
 * tool call that tool's name. A purpose that names every label is served as it is; otherwise it
 * gains a `Runs: …` clause. A tool described as linting Lua files once also started a Studio
 * playtest and ran a recorded server script, and the agent calling it was never told.
 *
 * Labels are names only, never recorded arguments. This module imports nothing, so the
 * command-suggestion hook can use it without loading the gateway.
 */

/** Most label groups a summary names; any past them are counted. */
const MAX_SHOWN_GROUPS = 12;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

/** Whether `text` names `label` as a word, ignoring case; an MCP label is named by its tool too. */
function names(text: string, label: string): boolean {
  const dot = label.lastIndexOf(".");
  const candidates = dot > 0 && dot < label.length - 1 ? [label, label.slice(dot + 1)] : [label];
  return candidates.some((candidate) =>
    new RegExp(
      `(?<![A-Za-z0-9_.-])${candidate.replace(REGEX_SPECIAL, "\\$&")}(?![A-Za-z0-9_-])`,
      "iu",
    ).test(text),
  );
}

/**
 * The labels in run order, a run of the same label collapsed as `label xN`, and at most
 * {@link MAX_SHOWN_GROUPS} of them: `stylua, selene, robloxstudio.solo_playtest x2`.
 */
export function stepRunsSummary(runs: readonly string[]): string {
  const groups: { label: string; count: number }[] = [];
  for (const label of runs) {
    const last = groups.at(-1);
    if (last?.label === label) last.count += 1;
    else groups.push({ label, count: 1 });
  }
  const shown = groups
    .slice(0, MAX_SHOWN_GROUPS)
    .map(({ label, count }) => (count === 1 ? label : `${label} x${count}`));
  const hidden = groups.slice(MAX_SHOWN_GROUPS).reduce((sum, group) => sum + group.count, 0);
  return hidden === 0 ? shown.join(", ") : `${shown.join(", ")}, +${hidden} more steps`;
}

/**
 * The `Runs: …` clause `text` needs to say every step a tool runs, or undefined when it already
 * names each label (or the steps are unknown).
 */
export function stepRunsClause(
  text: string,
  runs: readonly string[] | undefined,
): string | undefined {
  if (runs === undefined || runs.length === 0) return undefined;
  if (runs.every((label) => names(text, label))) return undefined;
  return `Runs: ${stepRunsSummary(runs)}.`;
}

/** `text` followed by its {@link stepRunsClause}, when it needs one. */
export function withStepRuns(text: string, runs: readonly string[] | undefined): string {
  const clause = stepRunsClause(text, runs);
  if (clause === undefined) return text;
  const trimmed = text.trimEnd();
  if (trimmed === "") return clause;
  return `${trimmed}${/[.!?…]$/u.test(trimmed) ? "" : "."} ${clause}`;
}
