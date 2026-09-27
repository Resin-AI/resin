#!/usr/bin/env node
/**
 * Pre-pass run before scripts/harness-fixtures/scrub.mjs on Copilot CLI captures.
 *
 * Copilot writes provider-opaque identifiers and per-account state the shared scrubber does not
 * know about: base64 response ids, encrypted reasoning, quota snapshots, and full prompt copies
 * (system prompt and compaction request messages). None of it is decoded by the adapter, so the
 * values are replaced with placeholders; keys, record order and every decoded field are kept.
 *
 * Usage: node prepare.mjs <input.jsonl> <output.jsonl>
 */
import fs from "node:fs";

const OPAQUE = "<scrubbed:opaque>";
const OMITTED = "<omitted:prompt-copy>";
const OPAQUE_KEYS = new Set([
  "reasoningOpaque",
  "apiCallId",
  "api_id",
  "model_call_id",
  "gen_ai.response.id",
  "gen_ai.request.previous_response.id",
  "enduser.pseudo.id",
  "quotaSnapshots",
  "copilotUsage",
  "promptCacheBreakState",
]);
const PROMPT_COPY_KEYS = new Set([
  "requestMessages",
  "messages",
  "responseChunk",
  "response",
  "contentBlocks",
]);

function walk(value, key) {
  if (key !== undefined && OPAQUE_KEYS.has(key)) return OPAQUE;
  if (key !== undefined && PROMPT_COPY_KEYS.has(key)) return OMITTED;
  if (Array.isArray(value)) return value.map((item) => walk(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: prepare.mjs <input.jsonl> <output.jsonl>");
  process.exit(2);
}
const lines = fs
  .readFileSync(input, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    const record = walk(JSON.parse(line));
    if (record.type === "system.message" && record.data) record.data.content = OMITTED;
    return JSON.stringify(record);
  });
fs.writeFileSync(output, `${lines.join("\n")}\n`);
