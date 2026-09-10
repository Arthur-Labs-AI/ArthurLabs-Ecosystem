import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';
import { RuntimePersistenceError } from './errors.js';

export interface SentryDatabaseOptions {
  readonly dataRoot: string;
  readonly databasePath?: string;
}

export class SentryDatabase {
  readonly path: string;
  readonly connection: DatabaseSyncType;

  constructor(options: SentryDatabaseOptions) {
    this.path = options.databasePath ?? resolve(options.dataRoot, 'sentry.db');
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      const { DatabaseSync } = createRequire(import.meta.url)(
        'node:sqlite',
      ) as typeof import('node:sqlite');
      this.connection = new DatabaseSync(this.path);
      this.connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      this.migrate();
    } catch (cause) {
      throw new RuntimePersistenceError('DATABASE_ERROR', 'Unable to initialize Sentry database', {
        cause,
      });
    }
  }

  private migrate(): void {
    this.connection.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;',
    );
    const appliedRows = this.connection
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.connection.exec('BEGIN IMMEDIATE');
      try {
        this.connection.exec(migration.sql);
        this.connection
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.connection.exec('COMMIT');
      } catch (cause) {
        this.connection.exec('ROLLBACK');
        throw cause;
      }
    }
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (cause) {
      this.connection.exec('ROLLBACK');
      throw new RuntimePersistenceError('DATABASE_ERROR', 'Sentry database transaction failed', {
        cause,
      });
    }
  }

  close(): void {
    this.connection.close();
  }
}
