import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface PatchHunk {
  /** 1-based first line of the hunk in the file before the edit (the line after which, when empty). */
  oldStart: number;
  /** Context and removed lines: what the file must contain where the hunk applies. */
  before: string[];
  /** Context and added lines: what replaces `before`. */
  after: string[];
}

interface ParsedPatch {
  operation: "create" | "update" | "delete";
  path: string;
  hunks: PatchHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

/** Reads one file's unified diff. Anything but the exact shape it describes is refused. */
function parsePatch(source: string): ParsedPatch {
  if (!source.endsWith("\n")) throw new Error("the recorded patch is not complete");
  const lines = source.slice(0, -1).split("\n");
  const from = lines[0]?.startsWith("--- ") ? lines[0].slice(4) : undefined;
  const to = lines[1]?.startsWith("+++ ") ? lines[1].slice(4) : undefined;
  if (from === undefined || to === undefined) {
    throw new Error("the recorded patch has no file header");
  }
  let operation: ParsedPatch["operation"];
  let path: string;
  if (from === "/dev/null" && to !== "/dev/null") {
    operation = "create";
    path = to;
  } else if (to === "/dev/null" && from !== "/dev/null") {
    operation = "delete";
    path = from;
  } else if (from === to) {
    operation = "update";
    path = from;
  } else {
    throw new Error("the recorded patch renames a file, which is not supported");
  }
  if (path.length === 0) throw new Error("the recorded patch names no file");
  const hunks: PatchHunk[] = [];
  let index = 2;
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index]!);
    if (header === null) throw new Error("the recorded patch has a malformed hunk header");
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const hunk: PatchHunk = { oldStart: Number(header[1]), before: [], after: [] };
    index += 1;
    while (hunk.before.length < oldCount || hunk.after.length < newCount) {
      const line = lines[index];
      if (line === undefined) throw new Error("the recorded patch ends inside a hunk");
      const text = line.slice(1);
      if (line.startsWith(" ")) {
        hunk.before.push(text);
        hunk.after.push(text);
      } else if (line.startsWith("-")) {
        hunk.before.push(text);
      } else if (line.startsWith("+")) {
        hunk.after.push(text);
      } else {
        throw new Error("the recorded patch has a line that is not context, removal or addition");
      }
      index += 1;
    }
    if (hunk.before.length !== oldCount || hunk.after.length !== newCount) {
      throw new Error("the recorded patch's hunk does not match its line counts");
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) throw new Error("the recorded patch has no hunks");
  if (operation !== "update") {
    const [only] = hunks;
    if (hunks.length !== 1 || (operation === "create" ? only!.before : only!.after).length !== 0) {
      throw new Error(`the recorded ${operation} patch must hold the whole file in one hunk`);
    }
  }
  return { operation, path, hunks };
}

function matchesAt(lines: readonly string[], expected: readonly string[], at: number): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  return expected.every((line, offset) => lines[at + offset] === line);
}

/** Applies every hunk at its stated line, or else at the one other place its lines appear. */
function applyHunks(content: string, hunks: readonly PatchHunk[]): string {
  const trailingNewline = content.length === 0 || content.endsWith("\n");
  const lines = content.length === 0 ? [] : content.split("\n");
  if (trailingNewline && lines.length > 0) lines.pop();
  let delta = 0;
  let cursor = 0;
  for (const hunk of hunks) {
    const origin = hunk.before.length === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const stated = origin + delta;
    let at = stated;
    if (stated < cursor || !matchesAt(lines, hunk.before, stated)) {
      if (hunk.before.length === 0) {
        throw new Error("the recorded patch's insertion point no longer exists");
      }
      const found: number[] = [];
      for (let candidate = cursor; candidate + hunk.before.length <= lines.length; candidate++) {
        if (matchesAt(lines, hunk.before, candidate)) found.push(candidate);
      }
      if (found.length !== 1) {
        throw new Error(
          found.length === 0
            ? "the recorded patch's context does not match the file"
            : "the recorded patch's context matches more than one place in the file",
        );
      }
      at = found[0]!;
    }
    lines.splice(at, hunk.before.length, ...hunk.after);
    delta = at - origin + hunk.after.length - hunk.before.length;
    cursor = at + hunk.after.length;
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The real path a patch may touch: its existing ancestors (and the file itself, when it exists)
 * resolved through symlinks, refused unless it lies strictly inside the real root. The returned path
 * is what gets written, so the check and the write cannot disagree.
 */
async function confinedTarget(root: string, path: string): Promise<string> {
  const realRoot = await realpath(root);
  const lexical = resolve(realRoot, path);
  const missing: string[] = [];
  let existing = lexical;
  while (!(await exists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  const target = join(await realpath(existing), ...missing);
  const inside = relative(realRoot, target);
  if (
    inside.length === 0 ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error("the recorded patch edits a file outside the step's working directory");
  }
  return target;
}

async function writeAtomically(target: string, content: string, mode?: number): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.resin-${randomBytes(6).toString("hex")}`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx" });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Applies one file's recorded unified diff in-process, confined to `root`. An update must find
 * every hunk's context exactly; a create needs a file that does not exist; a delete needs the file
 * to hold exactly what the patch removes. Any mismatch throws: nothing is approximated.
 */
export async function applyRecordedPatch(source: string, root: string): Promise<void> {
  const patch = parsePatch(source);
  const target = await confinedTarget(root, patch.path);
  if (patch.operation === "create") {
    if (await exists(target)) throw new Error("the recorded patch creates a file that exists");
    await mkdir(dirname(target), { recursive: true });
    await writeAtomically(target, applyHunks("", patch.hunks));
    return;
  }
  const current = await stat(target);
  if (!current.isFile()) throw new Error("the recorded patch edits something that is not a file");
  const content = await readFile(target, "utf8");
  if (patch.operation === "delete") {
    const removed = patch.hunks[0]!.before;
    if (content !== (removed.length === 0 ? "" : `${removed.join("\n")}\n`)) {
      throw new Error("the file differs from what the recorded patch deletes");
    }
    await unlink(target);
    return;
  }
  await writeAtomically(target, applyHunks(content, patch.hunks), current.mode & 0o7777);
}
