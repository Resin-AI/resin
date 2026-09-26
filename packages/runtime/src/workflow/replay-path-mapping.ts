import { resolve } from "node:path";

const PRECEDING = " \t\n\r\"'`=(:,";
const FOLLOWING = "/ \t\n\r\"'`);,:";

/**
 * Rewrites whole-path occurrences of the recorded workspace root inside program text to the
 * disposable replay snapshot root.
 *
 * Safe because it is used only for validation replays: the real invocation runs in the real
 * workspace, where recorded absolute paths are already correct, so it never sees this mapping.
 * Without it, validation would read or write the live workspace instead of the snapshot.
 * Matches are boundary-aware (e.g. `/app` never matches `/application`, `/apps`, or the `/app`
 * segment of a URL) and the rewrite is purely textual and deterministic.
 */
export function mapRecordedWorkspaceRoot(
  text: string,
  recordedWorkspaceRoot: string,
  snapshotRoot: string,
): string {
  const from = resolve(recordedWorkspaceRoot);
  const to = resolve(snapshotRoot);
  if (from === to || from === "/" || text.length === 0) {
    return text;
  }
  let result = "";
  let cursor = 0;
  let index = text.indexOf(from);
  while (index !== -1) {
    const end = index + from.length;
    const before = index === 0 ? undefined : text[index - 1];
    const after = end === text.length ? undefined : text[end];
    if (
      (before === undefined || PRECEDING.includes(before)) &&
      (after === undefined || FOLLOWING.includes(after))
    ) {
      result += text.slice(cursor, index) + to;
      cursor = end;
      index = text.indexOf(from, end);
    } else {
      index = text.indexOf(from, index + 1);
    }
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}
