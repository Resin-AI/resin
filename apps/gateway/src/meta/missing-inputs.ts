/**
 * The refusal a learned-tool call gets when it leaves out required inputs. It is written so the
 * agent repeats the call instead of falling back to doing the job by hand: it names each missing
 * input with what it is, shows one complete call (in OMP's `xd://` write form and as plain
 * `invoke_tool` arguments) with a placeholder for each missing value, and says that nothing ran.
 */

import type { CallToolResult } from "../protocol/types.js";
import { FAILURE_REASON_META_KEY } from "./invocation-failure.js";

/** `_meta` key on a missing-input refusal listing the inputs the call left out, in schema order. */
export const MISSING_INPUTS_META_KEY = "resinMissingInputs";

/** The longest description quoted for one input. */
const DESCRIPTION_CHARS = 300;
/** The longest supplied value echoed back into the example call; longer ones get a placeholder. */
const ECHOED_VALUE_CHARS = 200;

type Schema = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Schema | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function propertiesOf(schema: unknown): Schema {
  return asRecord(asRecord(schema)?.properties) ?? {};
}

/** The required input names a schema declares, in its own order. */
export function requiredInputs(schema: unknown): string[] {
  const required = asRecord(schema)?.required;
  return Array.isArray(required)
    ? required.filter((name): name is string => typeof name === "string")
    : [];
}

/** The required inputs `parameters` leaves out (absent or `undefined`), in schema order. */
export function missingRequiredInputs(
  schema: unknown,
  parameters: Readonly<Record<string, unknown>> | undefined,
): string[] {
  return requiredInputs(schema).filter(
    (name) => parameters === undefined || parameters[name] === undefined,
  );
}

/** A value of the input's declared type that marks where the caller's own value goes. */
function placeholder(name: string, property: Schema | undefined): unknown {
  const enumerated = property?.enum;
  if (Array.isArray(enumerated) && enumerated.length > 0) return enumerated[0];
  switch (property?.type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [`<${name} item>`];
    case "object":
      return {};
    default:
      return `<${name}>`;
  }
}

function describe(name: string, property: Schema | undefined): string {
  const type = typeof property?.type === "string" ? ` (${property.type})` : "";
  const raw = typeof property?.description === "string" ? property.description.trim() : "";
  const text =
    raw.length === 0
      ? "no description"
      : raw.length > DESCRIPTION_CHARS
        ? `${raw.slice(0, DESCRIPTION_CHARS)}…`
        : raw;
  return `- ${name}${type}: ${text}`;
}

/**
 * The refusal text for a call to `toolName` that left out `missing`: each missing input with its
 * description, one complete example call in both harness forms, and that the call can simply be
 * repeated. The example keeps the values the caller did pass (short ones) and fills every other
 * required input with a typed placeholder.
 */
export function missingInputsMessage(
  toolName: string,
  schema: unknown,
  parameters: Readonly<Record<string, unknown>> | undefined,
  missing: readonly string[],
): string {
  const properties = propertiesOf(schema);
  const required = requiredInputs(schema);
  const example: Record<string, unknown> = {};
  for (const name of required) {
    const supplied = parameters?.[name];
    const echoed =
      supplied !== undefined && !missing.includes(name) ? JSON.stringify(supplied) : undefined;
    example[name] =
      echoed !== undefined && echoed.length <= ECHOED_VALUE_CHARS
        ? supplied
        : placeholder(name, asRecord(properties[name]));
  }
  // Optional inputs the caller already passed stay in the call it is told to repeat.
  for (const [name, value] of Object.entries(parameters ?? {})) {
    if (Object.hasOwn(example, name) || value === undefined || !Object.hasOwn(properties, name)) {
      continue;
    }
    const echoed = JSON.stringify(value);
    if (echoed !== undefined && echoed.length <= ECHOED_VALUE_CHARS) example[name] = value;
  }
  const call = JSON.stringify({ name: toolName, parameters: example });
  const optional = Object.keys(properties).filter(
    (name) => !required.includes(name) && !Object.hasOwn(example, name),
  );
  const plural = missing.length === 1 ? "" : "s";
  return [
    `Missing required input${plural} for tool '${toolName}'; nothing ran:`,
    ...missing.map((name) => describe(name, asRecord(properties[name]))),
    `Repeat the call with ${missing.length === 1 ? "it" : "them"}: replace each <placeholder> with your value. A complete call:`,
    `- OMP: write ${call} to xd://mcp__resin_invoke_tool`,
    `- invoke_tool arguments: ${call}`,
    ...(optional.length === 0
      ? []
      : [`Optional inputs you may also pass: ${optional.join(", ")}.`]),
  ].join("\n");
}

/** A `validation_error` result for a call that left out `missing`, naming them in `_meta` too. */
export function missingInputsResult(
  toolName: string,
  schema: unknown,
  parameters: Readonly<Record<string, unknown>> | undefined,
  missing: readonly string[],
  extraErrors: readonly string[] = [],
): CallToolResult {
  const message = missingInputsMessage(toolName, schema, parameters, missing);
  const text = extraErrors.length === 0 ? message : `${message}\nAlso: ${extraErrors.join("; ")}.`;
  return {
    isError: true,
    content: [{ type: "text", text }],
    _meta: {
      [FAILURE_REASON_META_KEY]: "validation_error",
      [MISSING_INPUTS_META_KEY]: [...missing],
    },
  };
}
