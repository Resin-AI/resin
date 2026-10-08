import type { SuggestTool } from "./index-file.js";
import type { CommandMatch } from "./match.js";

/** Harnesses whose hooks call `resin suggest`; each is told how to call `invoke_tool` its own way. */
export type SuggestHarness = "claude-code" | "omp";

export const SUGGEST_HARNESSES: readonly SuggestHarness[] = ["claude-code", "omp"];

export function isSuggestHarness(value: string): value is SuggestHarness {
  return (SUGGEST_HARNESSES as readonly string[]).includes(value);
}

/** Inputs shown in the call example; the rest reuse recorded values when omitted. */
const SHOWN_INPUTS = 3;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

function exampleArguments(tool: SuggestTool): string {
  const inputs = [...tool.inputs]
    .filter((input) => INPUT_NAME.test(input.name))
    .sort((a, b) => Number(b.required) - Number(a.required))
    .slice(0, SHOWN_INPUTS);
  const parameters = Object.fromEntries(inputs.map((input) => [input.name, "…"]));
  return JSON.stringify({ name: tool.name, parameters });
}

function quoted(phrases: readonly string[]): string {
  return phrases.map((phrase) => `\`${phrase}\``).join(", ");
}

/** The one line an agent is shown before running a command a learned tool covers. */
export function renderSuggestion(match: CommandMatch, harness: SuggestHarness): string {
  const call = exampleArguments(match.tool);
  const how =
    harness === "omp"
      ? `write ${call} to xd://mcp__resin_invoke_tool`
      : `call mcp__resin__invoke_tool with ${call}`;
  const also = match.alsoRuns.length === 0 ? "" : ` (it also runs ${quoted(match.alsoRuns)})`;
  return `Resin: learned tool ${match.tool.name} covers this command (${quoted(match.covered)})${also}; instead of running it by hand, ${how}, filling in your values (omitted inputs reuse recorded values). Ignore this if the tool does not fit your task.`;
}
