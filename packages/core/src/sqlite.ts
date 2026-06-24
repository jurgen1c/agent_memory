export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
  close(): void;
}

export async function openSqliteDatabase(databasePath: string): Promise<SqliteDatabase> {
  if (isBunRuntime()) {
    return openBunSqliteDatabase(databasePath);
  }

  return openNodeSqliteDatabase(databasePath);
}

async function openBunSqliteDatabase(databasePath: string): Promise<SqliteDatabase> {
  const sqlite = await import("bun:sqlite");
  const database = new sqlite.Database(databasePath);

  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    run(sql: string, params: unknown[] = []): void {
      database.query(sql).run(...params);
    },
    all<T>(sql: string, params: unknown[] = []): T[] {
      return database.query(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: unknown[] = []): T | null {
      return (database.query(sql).get(...params) as T | null) ?? null;
    },
    close(): void {
      database.close();
    }
  };
}

async function openNodeSqliteDatabase(databasePath: string): Promise<SqliteDatabase> {
  const sqlite = await import("node:sqlite");
  const DatabaseSync = sqlite.DatabaseSync as new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): void;
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
    };
    close(): void;
  };
  const database = new DatabaseSync(databasePath);

  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    run(sql: string, params: unknown[] = []): void {
      database.prepare(sql).run(...params);
    },
    all<T>(sql: string, params: unknown[] = []): T[] {
      return database.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: unknown[] = []): T | null {
      return (database.prepare(sql).get(...params) as T | null) ?? null;
    },
    close(): void {
      database.close();
    }
  };
}

function isBunRuntime(): boolean {
  return Boolean((globalThis as { Bun?: unknown }).Bun);
}
