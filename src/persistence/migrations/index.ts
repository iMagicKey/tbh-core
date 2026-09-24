// Deterministic migration system (no external framework).
//
// Contract:
//   * migrations are an ordered, append-only list exported from this module;
//   * each unapplied migration runs inside its own transaction:
//       BEGIN → migration SQL → record version in schema_migrations → COMMIT;
//   * a failing migration rolls back completely and the version is NOT recorded;
//   * recorded versions are never re-run (idempotent after success);
//   * later migrations are appended with the next version number — history is
//     never rewritten.
//
// Migrations live in source-controlled TypeScript so they reliably package
// inside the Electron bundle (no loose .sql files).

import type { DatabaseSync } from 'node:sqlite'
import { migration001 } from './001-initial'
import { migration002 } from './002-memory-run-provenance'

export interface Migration {
  version: number
  name: string
  /** Runs inside a transaction; receives db.exec bound to the open database. */
  up: (exec: (sql: string) => void) => void
}

export const MIGRATIONS: readonly Migration[] = [migration001, migration002]

export class MigrationError extends Error {
  constructor(
    public readonly version: number,
    public readonly cause: unknown,
  ) {
    super(`migration ${version} failed: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = 'MigrationError'
  }
}

/** Ensure the ledger exists (outside any migration transaction). */
function ensureLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )
  `)
}

function appliedVersions(db: DatabaseSync): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  return new Set(rows.map((row) => Number(row.version)))
}

/**
 * Apply every not-yet-recorded migration in ascending version order.
 * Throws MigrationError on the first failure (after rollback); already-applied
 * versions are skipped forever.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  ensureLedger(db)
  const applied = appliedVersions(db)
  const ordered = [...migrations].sort((a, b) => a.version - b.version)

  let ran = 0
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue
    try {
      db.exec('BEGIN')
      migration.up((sql: string) => db.exec(sql))
      db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now())
      db.exec('COMMIT')
      ran++
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // connection already rolled back / broken — nothing further to clean
      }
      throw new MigrationError(migration.version, error)
    }
  }
  return ran
}

/** Highest applied schema version (0 = none). */
export function currentSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
    return row?.v ? Number(row.v) : 0
  } catch {
    return 0
  }
}
