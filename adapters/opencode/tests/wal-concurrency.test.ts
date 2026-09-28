import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OpencodeSessionEventSource, OpencodeSqliteStore } from "../src/index.js";
import { drain, exportedSchemas } from "./helpers.js";

const SESSION = "ses_walwriter0000000000000001";
const COMMITS = 400;

/**
 * Writer that behaves like OpenCode: WAL journal, one short IMMEDIATE transaction per event,
 * periodic passive checkpoints. `busy_timeout = 0` makes any lock held by the reader fail a
 * commit immediately instead of waiting. Like OpenCode, it holds its connection open before the
 * reader arrives, and says `ready` once it does: a reader opening the database while no other
 * connection has it rebuilds the WAL index, which briefly locks out a connection being set up
 * then. That is connection setup, not a commit.
 */
const WRITER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 0");
process.stdout.write("ready\\n");
const sid = ${JSON.stringify(SESSION)};
const insert = db.prepare("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)");
const bump = db.prepare("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?");
process.stdin.once("data", () => {
for (let i = 1; i <= ${COMMITS}; i++) {
  db.exec("BEGIN IMMEDIATE");
  const id = String(i).padStart(6, "0");
  const part = { id: "prt_" + id, sessionID: sid, messageID: "msg_1", type: "tool", tool: "bash",
    callID: "call_" + id, state: { status: "completed", input: { command: "echo " + i },
    output: String(i), metadata: { exit: 0 }, time: { start: 1000 + i, end: 1001 + i } } };
  insert.run("evt_" + id, sid, i + 1, "message.part.updated.1", JSON.stringify({ sessionID: sid, part }));
  bump.run(i + 1, sid);
  db.exec("COMMIT");
  if (i % 50 === 0) db.exec("PRAGMA wal_checkpoint(PASSIVE)");
}
db.close();
process.stdin.destroy();
});
`;

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function createStore(dbPath: string): void {
  const schemas = exportedSchemas();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  for (const table of ["project", "session", "message", "part", "event_sequence", "event"]) {
    db.exec(schemas[table]!);
  }
  db.prepare(
    "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('p', '/w', 1, 1, '[]')",
  ).run();
  db.prepare(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', 's', '/w', 't', '1.18.32', 1, 1)",
  ).run(SESSION);
  db.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 0)").run(SESSION);
  const info = { id: SESSION, directory: "/w", time: { created: 1, updated: 1 } };
  const message = { id: "msg_1", sessionID: SESSION, role: "assistant", time: { created: 1 } };
  const insert = db.prepare(
    "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(
    "evt_a",
    SESSION,
    0,
    "session.created.1",
    JSON.stringify({ sessionID: SESSION, info }),
  );
  insert.run(
    "evt_b",
    SESSION,
    1,
    "message.updated.1",
    JSON.stringify({ sessionID: SESSION, info: message }),
  );
  db.close();
}

describe("reading OpenCode's SQLite store next to a live WAL writer", () => {
  it("never blocks the writer and delivers every committed event exactly once", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-opencode-wal-"));
    const dbPath = path.join(dir, "opencode.db");
    createStore(dbPath);
    const store = new OpencodeSqliteStore(dbPath);
    const source = new OpencodeSessionEventSource(store, {
      sessionId: SESSION,
      workspaceId: "w",
      harnessId: "opencode",
      transcriptPath: dbPath,
      status: "active",
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
      metadata: {},
    });

    const writer = spawn(process.execPath, ["-e", WRITER, dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
    writer.stdout.once("data", () => onReady());
    let stderr = "";
    writer.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const { promise: exited, resolve: onExit } = Promise.withResolvers<number | null>();
    let done = false;
    writer.on("exit", (code) => {
      done = true;
      onExit(code);
    });

    const records: RawHarnessRecord[] = [];
    await Promise.race([ready, exited]);
    // Commits start only once the reader is polling.
    records.push(...(await source.readNext(1000)));
    writer.stdin.write("go\n");
    let readsDuringWrites = 0;
    while (!done) {
      records.push(...(await source.readNext(1000)));
      readsDuringWrites++;
      const { promise: tick, resolve: next } = Promise.withResolvers<void>();
      setImmediate(next);
      await tick;
    }
    expect(await exited, stderr).toBe(0);
    records.push(...(await drain(source, 1000)));

    // The reader polled while commits were landing, and saw them incrementally.
    expect(readsDuringWrites).toBeGreaterThan(5);
    const calls = records.filter((r) => r.recordType === "tool_call");
    const results = records.filter((r) => r.recordType === "tool_result");
    expect(calls).toHaveLength(COMMITS);
    expect(results).toHaveLength(COMMITS);
    expect(new Set(records.map((r) => r.recordId)).size).toBe(records.length);
    expect(calls.map((r) => r.cursor.offset)).toEqual(
      Array.from({ length: COMMITS }, (_, i) => i + 2),
    );

    // Between polls the reader holds no snapshot: a full checkpoint is not blocked by it.
    const checkpoint = new DatabaseSync(dbPath);
    const checkpointResult = checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    checkpoint.close();
    expect(checkpointResult).toMatchObject({ busy: 0 });

    // Opening read-only never created or modified schema.
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      verify.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get(),
    ).toMatchObject({ c: 6 });
    verify.close();
    await source.close();
  }, 60_000);
});
