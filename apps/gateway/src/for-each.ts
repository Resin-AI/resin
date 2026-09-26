/**
 * List inputs for learned tools: `for_each: {"<input>": [v1, v2, ...]}` runs the whole tool once
 * per value, in order, through the same call path a single call takes, and stops at the first
 * failing run.
 */
import type { CallToolResult, JsonRpcParams, McpToolInput } from "./protocol/types.js";

export const FOR_EACH_ARGUMENT = "for_each";
export const FOR_EACH_MIN_VALUES = 2;
export const FOR_EACH_MAX_VALUES = 20;

export const FOR_EACH_DESCRIPTION_SENTENCE =
  'To repeat this tool for several values of one input, call it once with `for_each: {"<input name>": [v1, v2, ...]}`.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** Inputs whose declared type is exactly `string`; only these can be repeated. */
function stringInputNames(schema: unknown): string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(([, property]) => isRecord(property) && property.type === "string")
    .map(([name]) => name);
}

/** A schema offers `for_each` when it has a string input and no real input of that name. */
export function offersForEach(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, FOR_EACH_ARGUMENT)) {
    return false;
  }
  return stringInputNames(schema).length > 0;
}

export function withForEachInput(schema: McpToolInput): McpToolInput {
  if (!offersForEach(schema)) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [FOR_EACH_ARGUMENT]: {
        type: "object",
        description:
          'Run the whole tool once per value: {"<input name>": [v1, v2, ...]} (one input, 2-20 values, runs in order, stops at the first failure).',
        minProperties: 1,
        maxProperties: 1,
        additionalProperties: {
          type: "array",
          minItems: FOR_EACH_MIN_VALUES,
          maxItems: FOR_EACH_MAX_VALUES,
          items: { type: "string" },
        },
      },
    },
  };
}

export function withForEachSentence(description: string): string {
  return description.includes(FOR_EACH_ARGUMENT)
    ? description
    : `${description}\n\n${FOR_EACH_DESCRIPTION_SENTENCE}`;
}

export type ForEachPlan =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "runs"; input: string; values: string[]; runs: JsonRpcParams[] };

/**
 * Reads `for_each` out of a call's arguments. Absent (or the tool has a real `for_each` input):
 * `none`, and the arguments go through untouched. Anything malformed is `invalid`; nothing runs.
 */
export function planForEach(schema: unknown, args: JsonRpcParams): ForEachPlan {
  if (!Object.hasOwn(args, FOR_EACH_ARGUMENT) || !offersForEach(schema)) return { kind: "none" };
  const { [FOR_EACH_ARGUMENT]: spec, ...rest } = args;
  const invalid = (message: string): ForEachPlan => ({
    kind: "invalid",
    message: `Invalid for_each: ${message}`,
  });
  if (!isRecord(spec)) return invalid('expected an object {"<input name>": [values...]}.');
  const keys = Object.keys(spec);
  if (keys.length !== 1) return invalid(`name exactly one input (got ${keys.length}).`);
  const input = keys[0] as string;
  const strings = stringInputNames(schema);
  if (!strings.includes(input)) {
    return invalid(
      `'${input}' is not a text input of this tool (text inputs: ${strings.join(", ")}).`,
    );
  }
  if (Object.hasOwn(rest, input)) {
    return invalid(`'${input}' is also given directly; give its values only in for_each.`);
  }
  const values = spec[input];
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    return invalid(`'${input}' must be a list of strings.`);
  }
  if (values.length < FOR_EACH_MIN_VALUES || values.length > FOR_EACH_MAX_VALUES) {
    return invalid(
      `'${input}' must list ${FOR_EACH_MIN_VALUES} to ${FOR_EACH_MAX_VALUES} values (got ${values.length}).`,
    );
  }
  const typed = values as string[];
  return {
    kind: "runs",
    input,
    values: typed,
    runs: typed.map((value) => ({ ...rest, [input]: value })),
  };
}

export function invalidForEachResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function runText(result: CallToolResult): string {
  const texts = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text);
  return texts.length > 0 ? texts.join("\n") : "(completed with no output)";
}

/**
 * Runs each planned call in order and combines the results. A run that returns an error or throws
 * ends the loop; the combined result is an error that names the failing item and the skipped ones.
 */
export async function runForEach(
  plan: Extract<ForEachPlan, { kind: "runs" }>,
  runOnce: (args: JsonRpcParams) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const sections: string[] = [];
  for (const [index, args] of plan.runs.entries()) {
    const label = `[${plan.input}=${plan.values[index]}]`;
    let result: CallToolResult;
    try {
      result = await runOnce(args);
    } catch (error) {
      result = invalidForEachResult(error instanceof Error ? error.message : String(error));
    }
    sections.push(`${label}\n${runText(result)}`);
    if (result.isError) {
      const skipped = plan.values.slice(index + 1);
      sections.push(
        `for_each stopped: ${plan.input}=${plan.values[index]} failed${
          skipped.length > 0
            ? `; not run: ${skipped.map((value) => `${plan.input}=${value}`).join(", ")}.`
            : "."
        }`,
      );
      return { isError: true, content: [{ type: "text", text: sections.join("\n\n") }] };
    }
  }
  return { content: [{ type: "text", text: sections.join("\n\n") }] };
}
