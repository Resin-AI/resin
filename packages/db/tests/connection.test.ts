import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDatabaseConnection } from "../src/connection.js";

describe("LocalDatabaseConnection", () => {
  it("opens and closes an in-memory database cleanly", () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    expect(conn.isOpen()).toBe(false);
    expect(conn.getLocation()).toBe(":memory:");

    conn.open();
    expect(conn.isOpen()).toBe(true);

    const fk = conn.get<{ foreign_keys: number }>("PRAGMA foreign_keys;");
    expect(fk?.foreign_keys).toBe(1);

    const timeout = conn.get<{ timeout: number }>("PRAGMA busy_timeout;");
    expect(timeout?.timeout).toBe(5000);

    const integrity = conn.integrityCheck();
    expect(integrity.ok).toBe(true);
    expect(integrity.details).toEqual(["ok"]);

    conn.close();
    expect(conn.isOpen()).toBe(false);
  });

  it("opens a disk-backed database with WAL mode and directory creation", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "te-db-conn-"));
    const dbPath = path.join(tmpDir, "nested", "store.sqlite");

    const conn = new LocalDatabaseConnection({ path: dbPath });
    conn.open();
    expect(conn.isOpen()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const journal = conn.get<{ journal_mode: string }>("PRAGMA journal_mode;");
    expect(journal?.journal_mode.toLowerCase()).toBe("wal");

    conn.close();
    expect(conn.isOpen()).toBe(false);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes statements, prepares and runs parameterized queries", () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    conn.exec(`
      CREATE TABLE test_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
    `);

    // Positional run
    const res1 = conn.run("INSERT INTO test_users (id, name, age, active) VALUES (?, ?, ?, ?);", [
      "u1",
      "Alice",
      30,
      true,
    ]);
    expect(res1.changes).toBe(1);

    // Named object run
    const res2 = conn.run(
      "INSERT INTO test_users (id, name, age, active) VALUES (:id, :name, :age, :active);",
      { ":id": "u2", ":name": "Bob", ":age": 25, ":active": false },
    );
    expect(res2.changes).toBe(1);

    // get
    const u1 = conn.get<{ id: string; name: string; age: number; active: number }>(
      "SELECT * FROM test_users WHERE id = ?;",
      ["u1"],
    );
    expect(u1).toEqual({ id: "u1", name: "Alice", age: 30, active: 1 });

    // all
    const allUsers = conn.all<{ id: string; name: string }>(
      "SELECT id, name FROM test_users ORDER BY id ASC;",
    );
    expect(allUsers).toHaveLength(2);
    expect(allUsers[0].name).toBe("Alice");
    expect(allUsers[1].name).toBe("Bob");

    conn.close();
  });

  it("handles atomic transactions and nested savepoints with rollback on error", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    conn.exec("CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT NOT NULL);");

    // Successful transaction
    await conn.transaction(async (tx) => {
      tx.run("INSERT INTO items (id, val) VALUES (?, ?);", ["1", "first"]);
      tx.run("INSERT INTO items (id, val) VALUES (?, ?);", ["2", "second"]);
    });

    expect(conn.all("SELECT * FROM items;")).toHaveLength(2);

    // Failed transaction rolls back
    await expect(
      conn.transaction(async (tx) => {
        tx.run("INSERT INTO items (id, val) VALUES (?, ?);", ["3", "third"]);
        throw new Error("Simulated failure inside transaction");
      }),
    ).rejects.toThrow("Simulated failure inside transaction");

    expect(conn.all("SELECT * FROM items;")).toHaveLength(2);
    expect(conn.get("SELECT * FROM items WHERE id = '3';")).toBeNull();

    // Nested savepoint rollback preserves outer transaction
    await conn.transaction(async (outerTx) => {
      outerTx.run("INSERT INTO items (id, val) VALUES (?, ?);", ["4", "outer"]);

      try {
        await outerTx.transaction(async (innerTx) => {
          innerTx.run("INSERT INTO items (id, val) VALUES (?, ?);", ["5", "inner"]);
          throw new Error("Inner savepoint failure");
        });
      } catch {
        // Handled inner error
      }

      outerTx.run("INSERT INTO items (id, val) VALUES (?, ?);", ["6", "outer_after"]);
    });

    const rows = conn.all<{ id: string }>("SELECT id FROM items ORDER BY id ASC;");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids).toContain("4");
    expect(ids).toContain("6");
    expect(ids).not.toContain("5");

    conn.close();
  });
});
