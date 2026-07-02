export type SqliteValue = string | number | bigint | boolean | null | Uint8Array;

export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, params?: SqliteValue[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: SqliteValue[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: SqliteValue[]): T | null;
  close(): void;
}

export interface OpenSqliteDatabaseOptions {
  readonly?: boolean;
  busyTimeoutMs?: number;
}

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export async function openSqliteDatabase(databasePath: string, options: OpenSqliteDatabaseOptions = {}): Promise<SqliteDatabase> {
  if (isBunRuntime()) {
    return openBunSqliteDatabase(databasePath, options);
  }

  return openNodeSqliteDatabase(databasePath, options);
}

async function openBunSqliteDatabase(databasePath: string, options: OpenSqliteDatabaseOptions): Promise<SqliteDatabase> {
  const sqlite = await import("bun:sqlite");
  const database = options.readonly ? new sqlite.Database(databasePath, { readonly: true }) : new sqlite.Database(databasePath);

  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs(options)}`);

  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    run(sql: string, params: SqliteValue[] = []): void {
      database.query(sql).run(...params);
    },
    all<T>(sql: string, params: SqliteValue[] = []): T[] {
      return database.query(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: SqliteValue[] = []): T | null {
      return (database.query(sql).get(...params) as T | null) ?? null;
    },
    close(): void {
      database.close();
    }
  };
}

async function openNodeSqliteDatabase(databasePath: string, options: OpenSqliteDatabaseOptions): Promise<SqliteDatabase> {
  const sqlite = await import("node:sqlite");
  const DatabaseSync = sqlite.DatabaseSync as new (
    path: string,
    options?: {
      readOnly?: boolean;
      timeout?: number;
    }
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: SqliteValue[]): void;
      all(...params: SqliteValue[]): unknown[];
      get(...params: SqliteValue[]): unknown;
    };
    close(): void;
  };
  const database = new DatabaseSync(databasePath, {
    readOnly: options.readonly ?? false,
    timeout: busyTimeoutMs(options)
  });

  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    run(sql: string, params: SqliteValue[] = []): void {
      database.prepare(sql).run(...params);
    },
    all<T>(sql: string, params: SqliteValue[] = []): T[] {
      return database.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: SqliteValue[] = []): T | null {
      return (database.prepare(sql).get(...params) as T | null) ?? null;
    },
    close(): void {
      database.close();
    }
  };
}

function busyTimeoutMs(options: OpenSqliteDatabaseOptions): number {
  return options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
}

function isBunRuntime(): boolean {
  return Boolean((globalThis as { Bun?: unknown }).Bun);
}
