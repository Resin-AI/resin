/**
 * Recorded defaults that name a moment in time.
 *
 * A learned tool may keep an input's recorded value when a caller omits it (`recordedDefault`).
 * That is right for a profile name or a directory, and wrong for a date: a cost query recorded
 * with `--time-period Start=2026-10-01,End=2026-10-05` would quietly report October's spend for
 * every later month. So an input whose recorded value is a date or a time is served, and enforced,
 * as required on this device. The recorded value is recognised locally and shown only as the plan
 * carries it (a private one as its placeholder); the plan and the catalog schema stay as published.
 */

import type { RegistryTool } from "../registry/types.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

/**
 * A learned tool's dated recorded-default inputs, each with its recorded value as it may be shown
 * (none for a tool that has no recorded plan).
 */
export type LocalToolDatedInputs = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => ReadonlyMap<string, string>;

/** How far an epoch timestamp may sit from now and still read as one, either way. */
const EPOCH_WINDOW_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * An ISO calendar date, alone or inside a larger value (`2026-10-01`, `2026-10-01T09:30:00Z`,
 * `Start=2026-10-01,End=2026-10-05`). Digits may not run on either side, so a longer number with
 * dashes in it is not mistaken for one.
 */
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu;

/** Epoch seconds (10 digits) or milliseconds (13 digits), and nothing else. */
const EPOCH = /^(?:\d{10}|\d{13})$/u;

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Whether a recorded value names a date or time, so reusing it later would silently answer for
 * the recorded moment rather than the current one: an ISO date or date-time, a value that embeds
 * one, or epoch seconds or milliseconds within ten years of `now`. Version numbers (`1.0.120`),
 * addresses (`10.0.0.1`) and plain counts (`30`) are not dates.
 */
export function isDatedValue(value: string, now: number = Date.now()): boolean {
  const trimmed = value.trim();
  for (const match of trimmed.matchAll(ISO_DATE)) {
    if (isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return true;
  }
  if (EPOCH.test(trimmed)) {
    const millis = trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed);
    return Math.abs(millis - now) <= EPOCH_WINDOW_MS;
  }
  return false;
}

/** The sentence a learned tool's input description uses to say omitting it reruns the recording. */
const OMIT_SENTENCE = /\s*Omit to use the recorded value\.?/gu;

/** What an agent is told about an input whose recorded value was a date. */
export function datedInputNote(recorded: string): string {
  return `Required: its recorded value (${recorded}) was a date, so pass the current one in the same form.`;
}

/**
 * The input schema with each dated input required and its description saying why, recorded value
 * shown as the example of the form. Inputs the schema does not declare are left alone; with none
 * dated, the schema is returned as is.
 */
export function requireDatedInputs<T extends object>(
  schema: T,
  dated: ReadonlyMap<string, string>,
): T {
  if (dated.size === 0) return schema;
  const shape = schema as { properties?: unknown; required?: unknown };
  const properties = shape.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return schema;
  }
  const declared = properties as Record<string, unknown>;
  const names = [...dated.keys()].filter((name) => Object.hasOwn(declared, name));
  if (names.length === 0) return schema;
  const nextProperties: Record<string, unknown> = { ...declared };
  for (const name of names) {
    const property = declared[name];
    if (property === null || typeof property !== "object" || Array.isArray(property)) continue;
    const existing = (property as { description?: unknown }).description;
    const kept = typeof existing === "string" ? existing.replace(OMIT_SENTENCE, "").trim() : "";
    const note = datedInputNote(dated.get(name) ?? "");
    nextProperties[name] = { ...property, description: kept ? `${kept} ${note}` : note };
  }
  const required = Array.isArray(shape.required)
    ? shape.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...schema,
    properties: nextProperties,
    required: [...required, ...names.filter((name) => !required.includes(name))],
  };
}

/**
 * Each recorded-default input's single recorded value that the plan itself carries (never a private,
 * dated or ambiguous one), for the input schema's `default` (none for a tool without a plan).
 */
export type LocalToolRecordedDefaults = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => ReadonlyMap<string, string>;

/**
 * The input schema with each declared input's recorded value as its JSON Schema `default`, read in
 * the input's declared type (a number, a boolean or a list where the recorded text is one). An
 * input that already has a default, or whose recorded text is not of its type, is left alone.
 */
export function withRecordedDefaults<T extends object>(
  schema: T,
  defaults: ReadonlyMap<string, string>,
): T {
  if (defaults.size === 0) return schema;
  const properties = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return schema;
  }
  const declared = properties as Record<string, unknown>;
  let nextProperties: Record<string, unknown> | undefined;
  for (const [name, recorded] of defaults) {
    const property = declared[name];
    if (property === null || typeof property !== "object" || Array.isArray(property)) continue;
    if (Object.hasOwn(property, "default")) continue;
    const type = (property as { type?: unknown }).type;
    let value: unknown = recorded;
    if (type === "number" || type === "integer") {
      value = recorded.trim() === "" ? Number.NaN : Number(recorded);
      if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) continue;
    } else if (type === "boolean") {
      if (recorded !== "true" && recorded !== "false") continue;
      value = recorded === "true";
    } else if (type === "array") {
      try {
        value = JSON.parse(recorded);
      } catch {
        continue;
      }
      if (!Array.isArray(value)) continue;
    } else if (type !== undefined && type !== "string") {
      continue;
    }
    nextProperties ??= { ...declared };
    nextProperties[name] = { ...property, default: value };
  }
  return nextProperties === undefined ? schema : { ...schema, properties: nextProperties };
}

/** The dated inputs a call left out, in the order given. */
export function missingDatedInputs(
  dated: ReadonlyMap<string, string>,
  parameters: Readonly<Record<string, unknown>>,
): string[] {
  return [...dated.keys()].filter(
    (name) => !Object.hasOwn(parameters, name) || parameters[name] === undefined,
  );
}

/** The refusal a call without a dated input gets: which input, why, and the form to pass. */
export function missingDatedInputsMessage(
  dated: ReadonlyMap<string, string>,
  missing: readonly string[],
): string {
  const each = missing.map((name) => `${name} (recorded: ${dated.get(name) ?? ""})`).join(", ");
  return `Missing required input${missing.length === 1 ? "" : "s"} ${each}: the recorded value was a date, so rerunning it would return results for that recorded date. Pass the current value in the same form and call again.`;
}
