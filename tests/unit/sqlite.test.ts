import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createNodeSqliteDatabase,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  openSqliteDatabase,
  type NodeDatabaseSyncConstructor,
  type SqliteValue
} from "../../packages/core/src/sqlite";

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

  test("maps the Node DatabaseSync API to the shared adapter contract", () => {
    const calls: Array<{ operation: string; sql?: string; params?: SqliteValue[] }> = [];
    let opened: { path: string; options?: { readOnly?: boolean; timeout?: number } } | undefined;
    const DatabaseSync = class {
      constructor(databasePath: string, options?: { readOnly?: boolean; timeout?: number }) {
        opened = { path: databasePath, options };
      }

      exec(sql: string): void {
        calls.push({ operation: "exec", sql });
      }

      prepare(sql: string) {
        return {
          run: (...params: SqliteValue[]) => calls.push({ operation: "run", sql, params }),
          all: (...params: SqliteValue[]) => {
            calls.push({ operation: "all", sql, params });
            return [{ name: "node-compatible" }];
          },
          get: (...params: SqliteValue[]) => {
            calls.push({ operation: "get", sql, params });
            return undefined;
          }
        };
      }

      close(): void {
        calls.push({ operation: "close" });
      }
    } as NodeDatabaseSyncConstructor;
    const databasePath = tempDatabasePath();
    const database = createNodeSqliteDatabase(DatabaseSync, databasePath, { readonly: true, busyTimeoutMs: 250 });

    try {
      database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      database.run("INSERT INTO items (name) VALUES (?)", ["node-compatible"]);
      expect(database.all<{ name: string }>("SELECT name FROM items")).toEqual([{ name: "node-compatible" }]);
      expect(database.get("SELECT name FROM items WHERE id = ?", [999])).toBeNull();
    } finally {
      database.close();
    }

    expect(opened).toEqual({ path: databasePath, options: { readOnly: true, timeout: 250 } });
    expect(calls).toEqual([
      { operation: "exec", sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" },
      { operation: "run", sql: "INSERT INTO items (name) VALUES (?)", params: ["node-compatible"] },
      { operation: "all", sql: "SELECT name FROM items", params: [] },
      { operation: "get", sql: "SELECT name FROM items WHERE id = ?", params: [999] },
      { operation: "close" }
    ]);
  });
});

function tempDatabasePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-sqlite-")), "memory.sqlite");
}
