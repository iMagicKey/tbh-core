import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseManager } from '../DatabaseManager'
import { MigrationError, currentSchemaVersion, runMigrations } from '../migrations'
import { SessionRepository } from '../repositories/SessionRepository'
import { tempDbPath } from './helpers'

describe('DatabaseManager', () => {
  it('opens, migrates, and reports healthy with schema version', () => {
    const manager = new DatabaseManager()
    const ok = manager.open(tempDbPath())
    expect(ok).toBe(true)
    const status = manager.getStatus()
    expect(status.state).toBe('healthy')
    expect(status.schemaVersion).toBe(2)
    expect(status.databasePath).toBeTruthy()
    manager.close()
    expect(manager.getStatus().state).toBe('closed')
  })

  it('applies the documented pragmas (effective values recorded)', () => {
    const manager = new DatabaseManager()
    manager.open(tempDbPath())
    const pragmas = manager.getStatus().pragmas
    expect(pragmas['foreign_keys']).toBe('1')
    expect(pragmas['journal_mode']).toBe('wal') // file-backed db
    expect(pragmas['synchronous']).toBe('1') // NORMAL
    expect(pragmas['busy_timeout']).toBe('5000')
    manager.close()
  })

  it('reopening the same file does not re-run migration 001 (idempotent)', () => {
    const dbPath = tempDbPath()
    const first = new DatabaseManager()
    first.open(dbPath)
    const db = first.getDatabase()!
    const rowsBefore = db.prepare('SELECT COUNT(*) AS c, MAX(applied_at_ms) AS t FROM schema_migrations').get() as {
      c: number
      t: number
    }
    first.close()

    const second = new DatabaseManager()
    second.open(dbPath)
    const rowsAfter = second
      .getDatabase()!
      .prepare('SELECT COUNT(*) AS c, MAX(applied_at_ms) AS t FROM schema_migrations')
      .get() as { c: number; t: number }
    expect(rowsAfter.c).toBe(rowsBefore.c) // no additional applications
    expect(rowsAfter.t).toBe(rowsBefore.t) // and the ledger row was untouched
    second.close()
  })

  it('open failure degrades to the error state without throwing', () => {
    const manager = new DatabaseManager()
    // a path whose parent does not exist cannot be opened by SQLite
    const ok = manager.open('Z:\\definitely\\missing\\dir\\tbh.sqlite3')
    expect(ok).toBe(false)
    const status = manager.getStatus()
    expect(status.state).toBe('error')
    expect(status.lastErrorCode).toBeTruthy()
    expect(manager.getDatabase()).toBeNull()
  })

  it('post-construction failure closes the connection and preserves the ORIGINAL error', () => {
    const dbPath = tempDbPath()
    // sabotage: pre-create a schema_migrations table with the WRONG shape so the
    // migration runner fails AFTER the connection was constructed
    const saboteur = new DatabaseSync(dbPath)
    saboteur.exec('CREATE TABLE schema_migrations (wrong_column TEXT)')
    saboteur.close()

    const manager = new DatabaseManager()
    expect(manager.open(dbPath)).toBe(false)
    expect(manager.getStatus().state).toBe('error')
    // the ORIGINAL error (the sabotaged ledger: "no such column: version") is
    // preserved — not replaced by any cleanup artifact
    expect(manager.getStatus().lastErrorDetail ?? '').toContain('no such column: version')
    expect(manager.getDatabase()).toBeNull()

    // no lingering lock: a fresh connection to the same file opens fine
    const probe = new DatabaseSync(dbPath)
    probe.close()

    // recovery: another manager on a FRESH path works normally
    const recovered = new DatabaseManager()
    expect(recovered.open(tempDbPath())).toBe(true)
    expect(recovered.getStatus().state).toBe('healthy')
    recovered.close()
  })

  it('second open() on the same manager closes the previous connection first', () => {
    const manager = new DatabaseManager()
    const pathA = tempDbPath()
    const pathB = tempDbPath()
    expect(manager.open(pathA)).toBe(true)
    expect(manager.filename).toBe('test.sqlite3')
    expect(manager.getStatus().schemaVersion).toBe(2)

    // reopen on a different path: old connection closed, new one tracked
    expect(manager.open(pathB)).toBe(true)
    expect(manager.getStatus().state).toBe('healthy')
    expect(manager.getStatus().databasePath).toBe(pathB)
    // the new connection is fully usable
    const repo = new SessionRepository(manager.getDatabase()!)
    repo.createSession({ id: 's', startedAtMs: 1, appVersion: '0.0.1', createdAtMs: 1 })
    expect(repo.count()).toBe(1)
    manager.close()
  })

  it('filename exposes only the basename', () => {
    const manager = new DatabaseManager()
    manager.open(tempDbPath())
    expect(manager.filename).toBe('test.sqlite3')
    expect(manager.filename).not.toContain('Users')
    manager.close()
  })
})

describe('migration system', () => {
  it('rolls back a failing migration completely and records no version', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, []) // ledger only
    const failing = [
      {
        version: 99,
        name: 'failing',
        up: (exec: (sql: string) => void) => {
          exec('CREATE TABLE should_not_survive (id INTEGER)')
          throw new Error('synthetic failure mid-migration')
        },
      },
    ]
    expect(() => runMigrations(db, failing)).toThrowError(MigrationError)
    // the table created inside the failed migration is gone (transaction rolled back)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_survive'")
      .all()
    expect(tables).toHaveLength(0)
    // and the version was NOT recorded
    expect(currentSchemaVersion(db)).toBe(0)
    db.close()
  })

  it('never re-runs a recorded version', () => {
    const db = new DatabaseSync(':memory:')
    let ran = 0
    const migration = {
      version: 5,
      name: 'counted',
      up: () => {
        ran++
        // no-op SQL body
      },
    }
    expect(runMigrations(db, [migration])).toBe(1)
    expect(runMigrations(db, [migration])).toBe(0) // second run skips
    expect(ran).toBe(1)
    expect(currentSchemaVersion(db)).toBe(5)
    db.close()
  })
})
