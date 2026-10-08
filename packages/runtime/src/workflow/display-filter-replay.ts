/**
 * Running a display-filter step with its filters applied: for a recording check, or for a caller
 * who switched the filter on through its input. A version-2 step's (`splitDisplayFilters`)
 * program runs without its cut filters, wrapped so that each cut pipeline's stdout lands between
 * two marker strings carrying a per-run random nonce; its stdout is then cut at the markers, and
 * each bracketed chunk is piped through the filter dropped from that pipeline, stage by stage
 * (`displayFilterStages`).
 *
 * Only marker wrappers are inserted, at the exact offsets of each cut pipeline: `{ M b0; KEPT;
 * M e0; }`, where `M` is a shell function defined on the program's first line (so line numbers do
 * not move) that prints the marker and returns the exit status it was called with. The pipeline's
 * own stages run as they do in the command, `$?` reaches them unchanged, and the group exits with
 * the kept stages' status, so `&&`, `||` and `$?` after it see what the command alone would.
 */

import { randomBytes } from "node:crypto";
import type { DisplayFilterCut } from "@resin/contracts";

const NONCE = /^[0-9a-f]{32}$/;

/** A fresh nonce for one replay's markers: no program output can predict it. */
export function displayFilterNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The prefix every marker of the replay using `nonce` starts with. */
function markerPrefix(nonce: string): string {
  return `<<RESIN-DISPLAY-FILTER-${nonce}-`;
}

/** The marker printed before (`b`) or after (`e`) the output of cut `index`. */
function marker(nonce: string, edge: "b" | "e", index: number): string {
  return `${markerPrefix(nonce)}${edge}${index}>>`;
}

/**
 * `text` (the rendered program `cuts` were split from) with every cut removed and every cut
 * pipeline's kept stages bracketed by markers. The cuts' text is never part of the program.
 */
export function instrumentDisplayFilters(
  text: string,
  cuts: readonly DisplayFilterCut[],
  nonce: string,
): string {
  if (!NONCE.test(nonce)) throw new Error("a display-filter marker nonce must be 32 hex digits");
  const mark = `resin_display_filter_${nonce}`;
  let program = `${mark}() { ${mark}_status=$?; printf '%s' "${markerPrefix(nonce)}$1>>"; return $${mark}_status; }; `;
  let from = 0;
  for (const [index, cut] of cuts.entries()) {
    if (cut.pipelineStart < from || cut.start < cut.pipelineStart || cut.end < cut.start) {
      throw new Error("display-filter cuts must be ordered offsets into the program");
    }
    program += `${text.slice(from, cut.pipelineStart)}{ ${mark} b${index}; ${text.slice(cut.pipelineStart, cut.start)}; ${mark} e${index}; }`;
    from = cut.end;
  }
  return program + text.slice(from);
}

/** One piece of a marked replay's stdout: verbatim text, or the bracketed output of cut `cut`. */
export interface DisplayFilterChunk {
  text: string;
  cut?: number;
}

/**
 * The stdout of an `instrumentDisplayFilters` program cut at its markers, markers removed, or
 * undefined when the markers are not well formed: a cut whose output began but never ended, or a
 * marker of this nonce left anywhere else. A cut whose pipeline never ran (`false && A | grep x`)
 * has no chunk.
 */
export function displayFilterChunks(
  stdout: string,
  nonce: string,
  count: number,
): DisplayFilterChunk[] | undefined {
  const chunks: DisplayFilterChunk[] = [];
  let position = 0;
  for (let index = 0; index < count; index += 1) {
    const begin = marker(nonce, "b", index);
    const opened = stdout.indexOf(begin, position);
    if (opened === -1) continue;
    const end = marker(nonce, "e", index);
    const closed = stdout.indexOf(end, opened + begin.length);
    if (closed === -1) return undefined;
    chunks.push({ text: stdout.slice(position, opened) });
    chunks.push({ text: stdout.slice(opened + begin.length, closed), cut: index });
    position = closed + end.length;
  }
  chunks.push({ text: stdout.slice(position) });
  const prefix = markerPrefix(nonce);
  return chunks.some((chunk) => chunk.text.includes(prefix)) ? undefined : chunks;
}

/** `stdout` of a marked replay with its markers removed, for an error message. */
export function withoutDisplayFilterMarkers(stdout: string, nonce: string): string {
  return stdout.replace(new RegExp(`${markerPrefix(nonce)}[be][0-9]+>>`, "g"), "");
}

/** One stage of a dropped display filter: its text, and its command word with quotes removed. */
export interface DisplayFilterStage {
  source: string;
  command: string;
}

/**
 * The stages of a display filter cut from a recorded program (`splitDisplayFilter`'s `filter` or a
 * `DisplayFilterCut.filter`), split at its top-level `|`. Its words are in version 1's grammar
 * (plain characters, `'...'`, and `"..."` that never escapes a quote); between them a version-2
 * filter may also hold line breaks, line continuations and `#` comments, which stay in the stage
 * text for the shell to read. Throws on a text no splitter produced (an unclosed quote, an empty
 * stage).
 */
export function displayFilterStages(filter: string): DisplayFilterStage[] {
  const malformed = (): Error =>
    new Error(`display filter \`${filter}\` is not a pipeline of commands`);
  const stages: DisplayFilterStage[] = [];
  let start = 0;
  let command: string | undefined;
  let word: string | undefined;
  const endWord = (): void => {
    if (word !== undefined && command === undefined) command = word;
    word = undefined;
  };
  const endStage = (end: number): void => {
    endWord();
    const source = filter.slice(start, end).trim();
    if (command === undefined || source.length === 0) throw malformed();
    stages.push({ source, command });
    command = undefined;
    start = end + 1;
  };
  for (let index = 0; index < filter.length; index += 1) {
    const char = filter[index]!;
    if (char === "'" || char === '"') {
      const close = filter.indexOf(char, index + 1);
      if (close === -1) throw malformed();
      word = (word ?? "") + filter.slice(index + 1, close);
      index = close;
    } else if (char === "\\" && filter[index + 1] === "\n") {
      endWord();
      index += 1;
    } else if (char === " " || char === "\t" || char === "\n") {
      endWord();
    } else if (char === "#" && word === undefined) {
      const newline = filter.indexOf("\n", index);
      index = newline === -1 ? filter.length : newline;
    } else if (char === "|") {
      endStage(index);
    } else {
      word = (word ?? "") + char;
    }
  }
  endStage(filter.length);
  return stages;
}
