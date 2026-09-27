import * as path from "node:path";
import type { ConfigFsBridge } from "./config.js";

/** Marker comments delimiting the block Resin owns inside a user-owned instruction file. */
export interface ManagedBlockMarkers {
  readonly start: string;
  readonly end: string;
}

export type ManagedBlockAction = "created" | "updated" | "unchanged" | "removed";

export interface ManagedBlockResult {
  readonly path: string;
  readonly action: ManagedBlockAction;
}

export interface ManagedBlockEdit {
  readonly action: ManagedBlockAction;
  /** Next file content; `null` means the file holds nothing but the removed block and should be deleted. */
  readonly content: string | null;
}

/**
 * Computes the next content of an instruction file after installing (`body` is a string) or
 * removing (`body` is null) the marker-delimited block. The rendered block is
 * `${start}\n${body}\n${end}`; `body` is embedded verbatim. Content outside the markers is
 * preserved byte for byte on upsert; removal joins the surrounding content with one blank line.
 * Only a complete block (start marker followed by end marker) is recognized.
 */
export function editManagedBlock(
  current: string | null,
  markers: ManagedBlockMarkers,
  body: string | null,
): ManagedBlockEdit {
  const start = current === null ? -1 : current.indexOf(markers.start);
  const end = start === -1 || current === null ? -1 : current.indexOf(markers.end, start);
  const parts =
    current !== null && end !== -1
      ? { before: current.slice(0, start), after: current.slice(end + markers.end.length) }
      : null;

  if (body === null) {
    if (current === null || parts === null) {
      return { action: "unchanged", content: current };
    }
    const before = parts.before.replace(/\n*$/, "");
    const after = parts.after.replace(/^\n*/, "");
    const remaining = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    if (remaining.trim().length === 0) {
      return { action: "removed", content: null };
    }
    return { action: "removed", content: remaining.endsWith("\n") ? remaining : `${remaining}\n` };
  }

  const block = `${markers.start}\n${body}\n${markers.end}`;
  let next: string;
  if (current === null || current.trim().length === 0) {
    next = `${block}\n`;
  } else if (parts === null) {
    next = `${current.replace(/\n*$/, "")}\n\n${block}\n`;
  } else {
    next = `${parts.before}${block}${parts.after}`;
  }
  if (next === current) {
    return { action: "unchanged", content: current };
  }
  return { action: current === null ? "created" : "updated", content: next };
}

/**
 * Installs (`body` is a string) or removes (`body` is null) Resin's managed block in an
 * instruction file through `fs`. Idempotent; with `dryRun`, reports the action without writing.
 */
export async function applyManagedBlock(
  fs: ConfigFsBridge,
  filePath: string,
  markers: ManagedBlockMarkers,
  body: string | null,
  options: { dryRun?: boolean } = {},
): Promise<ManagedBlockResult> {
  const edit = editManagedBlock(await fs.readFile(filePath), markers, body);
  if (edit.action !== "unchanged" && !options.dryRun) {
    if (edit.content === null) {
      await fs.unlink(filePath);
    } else {
      await fs.mkdirp(path.dirname(filePath));
      await fs.writeFile(filePath, edit.content);
    }
  }
  return { path: filePath, action: edit.action };
}
