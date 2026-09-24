// DatabaseManager — SQLite lifecycle: open, configure, migrate, status, close.
//
// Uses Electron/Node's built-in `node:sqlite` (DatabaseSync) — no third-party
// SQLite package (runtime verified on Electron 44 / embedded Node 24.21).
//
// Failure semantics: opening/migrating failures NEVER throw out of open() —
// the manager enters the 'error' state with the cause recorded; callers keep
// running (the app must degrade, not crash).

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { currentSchemaVersion, runMigrations } from './migrations'
import type { DatabaseStateName } from '../shared/database'

export const DATABASE_FILENAME = 'tbh-core.sqlite3'

export interface DatabaseManagerStatus {
  state: DatabaseStateName
  schemaVersion: number | null
  databasePath: string | null
  lastErrorCode: string | null
  lastErrorDetail: string | null
  pragmas: Record<string, string>
}

export class DatabaseManager {
  private db: DatabaseSync | null = null
  private state: DatabaseStateName = 'uninitialized'
  private schemaVersion: number | null = null
  private databasePath: string | null = null
  private lastErrorCode: string | null = null
  private lastErrorDetail: string | null = null
  private pragmas: Record<string, string> = {}

  /**
   * Open (or create) the database and run pending migrations.
   * NEVER throws: on failure the manager is left in the 'error' state.
   */
  open(databasePath: string): boolean {
    this.state = 'opening'
    this.databasePath = databasePath
    try {
      this.db = new DatabaseSync(databasePath)
      this.applyPragmas()
      runMigrations(this.db)
      this.schemaVersion = currentSchemaVersion(this.db)
      this.state = 'healthy'
      return true
    } catch (error) {
      this.recordError(error)
      this.db = null
      return false
    }
  }

  private applyPragmas(): void {
    if (!this.db) return
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // record the EFFECTIVE values (WAL degrades to 'memory' on :memory: databases)
    for (const pragma of ['foreign_keys', 'journal_mode', 'synchronous', 'busy_timeout']) {
      const row = this.db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
      this.pragmas[pragma] = row ? String(Object.values(row)[0]) : 'unknown'
    }
  }

  private recordError(error: unknown): void {
    this.state = 'error'
    this.lastErrorCode = error instanceof Error ? error.name : 'UnknownError'
    this.lastErrorDetail = error instanceof Error ? error.message : String(error)
  }

  /** The live connection, or null when unavailable (callers must handle null). */
  getDatabase(): DatabaseSync | null {
    return this.db
  }

  /** Mark degraded (e.g. a persistence write failed) without dropping the connection. */
  markDegraded(error: unknown): void {
    if (this.state === 'healthy') this.state = 'degraded'
    this.lastErrorCode = error instanceof Error ? error.name : 'UnknownError'
    this.lastErrorDetail = error instanceof Error ? error.message : String(error)
  }

  /** Restore healthy after a successful write following a degraded period. */
  markHealthy(): void {
    if (this.state === 'degraded') {
      this.state = 'healthy'
      this.lastErrorCode = null
      this.lastErrorDetail = null
    }
  }

  getStatus(): DatabaseManagerStatus {
    return {
      state: this.state,
      schemaVersion: this.schemaVersion,
      databasePath: this.databasePath,
      lastErrorCode: this.lastErrorCode,
      lastErrorDetail: this.lastErrorDetail,
      pragmas: { ...this.pragmas },
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // closing a broken connection — the state transition below is what matters
      }
      this.db = null
    }
    if (this.state !== 'error') this.state = 'closed'
  }

  /** Basename only — safe for renderer diagnostics (no full user path). */
  get filename(): string | null {
    return this.databasePath ? path.basename(this.databasePath) : null
  }
}
