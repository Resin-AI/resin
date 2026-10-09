import { stepRunsClause } from "../step-runs.js";
import type { SuggestTool } from "./index-file.js";
import type { CommandMatch } from "./match.js";

/** Harnesses whose hooks call `resin suggest`; each is told how to call `invoke_tool` its own way. */
export type SuggestHarness = "claude-code" | "omp";

export const SUGGEST_HARNESSES: readonly SuggestHarness[] = ["claude-code", "omp"];

export function isSuggestHarness(value: string): value is SuggestHarness {
  return (SUGGEST_HARNESSES as readonly string[]).includes(value);
}

/** Required inputs shown in a call example; optional ones run their recorded or default value. */
const SHOWN_INPUTS = 3;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

/**
 * A ready `invoke_tool` argument for `tool`: its required inputs as `"…"` placeholders, and each
 * input in `off` (an optional step's toggle) set to false so that step is skipped.
 */
export function callExample(tool: SuggestTool, off: readonly string[] = []): string {
  const required = tool.inputs
    .filter((input) => input.required && INPUT_NAME.test(input.name))
    .slice(0, SHOWN_INPUTS)
    .map((input): [string, string | boolean] => [input.name, "…"]);
  const toggles = off
    .filter((name) => INPUT_NAME.test(name))
    .map((name): [string, string | boolean] => [name, false]);
  return JSON.stringify({
    name: tool.name,
    parameters: Object.fromEntries([...required, ...toggles]),
  });
}

/** How `harness` passes `call` to Resin's `invoke_tool`. */
export function invokeHow(harness: SuggestHarness, call: string): string {
  return harness === "omp"
    ? `write ${call} to xd://mcp__resin_invoke_tool`
    : `call mcp__resin__invoke_tool with ${call}`;
}

function quoted(phrases: readonly string[]): string {
  return phrases.map((phrase) => `\`${phrase}\``).join(", ");
}

/**
 * The short reminder shown with a command's result when a learned tool is a close fit for it.
 * Harnesses deliver it after the command ran, so it speaks to the next time. A tool that also
 * runs steps besides the matched commands says so (`Runs: …`), so calling it surprises no one.
 */
export function renderSuggestion(match: CommandMatch, harness: SuggestHarness): string {
  const call = callExample(match.tool, match.skip);
  const covered = quoted(match.covered);
  const clause = stepRunsClause(covered, match.tool.runs);
  return `Resin, next time: learned tool ${match.tool.name} runs ${covered}; ${invokeHow(harness, call)}.${clause === undefined ? "" : ` ${clause}`}`;
}
