#!/usr/bin/env node
/**
 * Exports the transcript tables of an OpenCode SQLite store to JSON Lines so a recorded
 * capture can be scrubbed and committed; tests rebuild the database from the export.
 *
 * Only transcript tables are exported (never account, credential, or share tables). JSON
 * columns (`data`) are parsed so the scrubber walks them structurally.
 *
 * Usage: node export-db.mjs <opencode.db> <out.jsonl>
 */
import fs from "node:fs";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const TABLES = ["project", "session", "message", "part", "event_sequence", "event"];
const JSON_COLUMNS = new Set(["data"]);

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node export-db.mjs <opencode.db> <out.jsonl>");
  process.exit(2);
}

const db = new DatabaseSync(input, { readOnly: true });
const lines = [];
for (const table of TABLES) {
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!schema) continue;
  lines.push(JSON.stringify({ table, schema: schema.sql }));
  const order = table === "event" ? "aggregate_id, seq" : "rowid";
  for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all()) {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = JSON_COLUMNS.has(key) && typeof value === "string" ? JSON.parse(value) : value;
    }
    lines.push(JSON.stringify({ table, row: out }));
  }
}
db.close();
fs.writeFileSync(output, `${lines.join("\n")}\n`);
