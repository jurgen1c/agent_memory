import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS, openSqliteDatabase } from "../../packages/core/src/sqlite";

describe("SQLite adapter", () => {
  test("sets a busy timeout on opened connections", async () => {
    const databasePath = tempDatabasePath();
    const database = await openSqliteDatabase(databasePath);

    try {
      const timeout = database.get<{ timeout: number }>("PRAGMA busy_timeout");

      expect(timeout?.timeout).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      database.close();
    }
  });

  test("supports read-only connections for retrieval commands", async () => {
    const databasePath = tempDatabasePath();
    const writable = await openSqliteDatabase(databasePath);

    try {
      writable.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      writable.run("INSERT INTO items (name) VALUES (?)", ["existing"]);
    } finally {
      writable.close();
    }

    const readonly = await openSqliteDatabase(databasePath, { readonly: true });

    try {
      expect(readonly.get<{ name: string }>("SELECT name FROM items")?.name).toBe("existing");
      expect(() => readonly.run("INSERT INTO items (name) VALUES (?)", ["blocked"])).toThrow();
    } finally {
      readonly.close();
    }
  });
});

function tempDatabasePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-sqlite-")), "memory.sqlite");
}
