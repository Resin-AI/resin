/**
 * What a confirmed input's recorded values named in the workspace: the entry names of one directory
 * (`services/billing`, `services/search` → names under `services/`), or paths under one directory
 * (`sources/a.json`, `sources/b.json` → paths under `sources/`).
 *
 * Read on the device, against the directory each value was recorded in. Only the common directory
 * and the kind of entry leave the device; the values never do.
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { type WorkflowInputForm, isWorkflowInputFormDirectory } from "@resin/contracts";

/** One recorded value of the input, and the directory the call that used it ran in. */
export interface RecordedInputValue {
  value: string;
  /** Absolute working directory of the recorded call. */
  base: string;
}

/** How deep below a working directory the directory holding named entries is looked for. */
const MAX_NAME_DEPTH = 3;
/** Directories read while looking, per working directory: the search never walks a large tree. */
const MAX_DIRECTORIES_READ = 400;
/** Directories never looked into: tool state and dependency trees, not the project's own names. */
const SKIPPED_DIRECTORIES: Readonly<Record<string, true>> = {
  node_modules: true,
  __pycache__: true,
  target: true,
  dist: true,
  build: true,
  venv: true,
};
const MAX_VALUE_LENGTH = 255;

type EntryKind = "directory" | "file" | "other";

/**
 * The form every recorded value shares; undefined when they share none, when a value is not a
 * plain relative name or path, or when the directory holding them is ambiguous.
 */
export async function recordedInputForm(
  values: readonly RecordedInputValue[],
): Promise<WorkflowInputForm | undefined> {
  if (values.length === 0) return undefined;
  if (
    values.some(
      ({ value, base }) =>
        value.length === 0 ||
        value.length > MAX_VALUE_LENGTH ||
        value.includes("\\") ||
        [...value].some((character) => character.charCodeAt(0) < 0x20) ||
        !path.isAbsolute(base),
    )
  ) {
    return undefined;
  }
  const form = values.every(({ value }) => !value.includes("/"))
    ? await nameForm(values)
    : values.every(({ value }) => value.includes("/"))
      ? await pathForm(values)
      : undefined;
  return form !== undefined && isWorkflowInputFormDirectory(form.directory) ? form : undefined;
}

/**
 * The shallowest directory below every value's working directory that holds an entry named by
 * each value recorded there; undefined when two directories at that depth both do.
 */
async function nameForm(
  values: readonly RecordedInputValue[],
): Promise<WorkflowInputForm | undefined> {
  if (values.some(({ value }) => value === "." || value === "..")) return undefined;
  const byBase = new Map<string, Set<string>>();
  for (const { value, base } of values) {
    const names = byBase.get(base) ?? new Set<string>();
    names.add(value);
    byBase.set(base, names);
  }
  // Relative directory → the kinds of the entries it holds for the values, in every working directory.
  let common: Map<string, Set<EntryKind>> | undefined;
  for (const [base, names] of byBase) {
    const here = await directoriesHolding(base, names);
    if (common === undefined) {
      common = here;
      continue;
    }
    for (const [directory, kinds] of common) {
      const other = here.get(directory);
      if (other === undefined) common.delete(directory);
      else for (const kind of other) kinds.add(kind);
    }
  }
  if (common === undefined || common.size === 0) return undefined;
  const depth = (directory: string) => (directory === "." ? 0 : directory.split("/").length);
  const shallowest = Math.min(...[...common.keys()].map(depth));
  const found = [...common].filter(([directory]) => depth(directory) === shallowest);
  if (found.length !== 1) return undefined;
  const [directory, kinds] = found[0]!;
  return { value: "name", directory, ...entryOf(kinds) };
}

/**
 * Every directory, `.` included, at most {@link MAX_NAME_DEPTH} below `base`, holding an entry for
 * each of `names`, with the kinds of those entries. Hidden and dependency directories are skipped.
 */
async function directoriesHolding(
  base: string,
  names: ReadonlySet<string>,
): Promise<Map<string, Set<EntryKind>>> {
  const holding = new Map<string, Set<EntryKind>>();
  const queue: Array<{ relative: string; depth: number }> = [{ relative: ".", depth: 0 }];
  let read = 0;
  while (queue.length > 0 && read < MAX_DIRECTORIES_READ) {
    const { relative, depth } = queue.shift()!;
    read += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(base, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    const kinds = new Set<EntryKind>();
    let all = true;
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry === undefined) {
        all = false;
        break;
      }
      kinds.add(entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other");
    }
    if (all) holding.set(relative, kinds);
    if (depth >= MAX_NAME_DEPTH) continue;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        Object.hasOwn(SKIPPED_DIRECTORIES, entry.name)
      ) {
        continue;
      }
      queue.push({
        relative: relative === "." ? entry.name : `${relative}/${entry.name}`,
        depth: depth + 1,
      });
    }
  }
  return holding;
}

/**
 * The deepest directory every value's path lies under, when each value is an existing relative
 * path (or an absolute one inside its working directory) and they share one below `.`.
 */
async function pathForm(
  values: readonly RecordedInputValue[],
): Promise<WorkflowInputForm | undefined> {
  const kinds = new Set<EntryKind>();
  let shared: string[] | undefined;
  for (const { value, base } of values) {
    const relative = path.posix.normalize(
      path.isAbsolute(value) ? path.relative(base, value).split(path.sep).join("/") : value,
    );
    if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative)) {
      return undefined;
    }
    let stats: Stats;
    try {
      stats = await lstat(path.join(base, relative));
    } catch {
      return undefined;
    }
    kinds.add(stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other");
    const parent = path.posix.dirname(relative.replace(/\/+$/u, ""));
    const segments = parent === "." ? [] : parent.split("/");
    if (shared === undefined) {
      shared = segments;
      continue;
    }
    let length = 0;
    while (length < shared.length && shared[length] === segments[length]) length += 1;
    shared = shared.slice(0, length);
  }
  if (shared === undefined || shared.length === 0) return undefined;
  return { value: "path", directory: shared.join("/"), ...entryOf(kinds) };
}

function entryOf(kinds: ReadonlySet<EntryKind>): Pick<WorkflowInputForm, "entry"> {
  if (kinds.size !== 1) return {};
  const [kind] = kinds;
  return kind === "other" ? {} : { entry: kind! };
}
