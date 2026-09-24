// SessionRepository — foundation for farming sessions (no lifecycle logic yet;
// the session manager arrives with the run/memory phase).

import type { DatabaseSync } from 'node:sqlite'

export interface SessionRecord {
  id: string
  startedAtMs: number
  endedAtMs: number | null
  startReason: string | null
  endReason: string | null
  gameVersion: string | null
  gameFingerprint: string | null
  appVersion: string
  createdAtMs: number
}

export interface CreateSessionInput {
  id: string
  startedAtMs: number
  startReason?: string | null
  gameVersion?: string | null
  gameFingerprint?: string | null
  appVersion: string
  createdAtMs: number
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  createSession(input: CreateSessionInput): void {
    this.db
      .prepare(
        `INSERT INTO sessions
          (id, started_at_ms, ended_at_ms, start_reason, end_reason, game_version,
           game_fingerprint, app_version, created_at_ms)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.startedAtMs,
        input.startReason ?? null,
        input.gameVersion ?? null,
        input.gameFingerprint ?? null,
        input.appVersion,
        input.createdAtMs,
      )
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? this.toRecord(row) : null
  }

  closeSession(id: string, endedAtMs: number, endReason: string | null): boolean {
    const result = this.db
      .prepare('UPDATE sessions SET ended_at_ms = ?, end_reason = ? WHERE id = ? AND ended_at_ms IS NULL')
      .run(endedAtMs, endReason, id)
    return Number(result.changes) > 0
  }

  getOpenSession(): SessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE ended_at_ms IS NULL ORDER BY started_at_ms DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined
    return row ? this.toRecord(row) : null
  }

  listSessions(limit: number): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at_ms DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>
    return rows.map((row) => this.toRecord(row))
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }
    return Number(row.c)
  }

  private toRecord(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row['id']),
      startedAtMs: Number(row['started_at_ms']),
      endedAtMs: row['ended_at_ms'] === null ? null : Number(row['ended_at_ms']),
      startReason: (row['start_reason'] as string | null) ?? null,
      endReason: (row['end_reason'] as string | null) ?? null,
      gameVersion: (row['game_version'] as string | null) ?? null,
      gameFingerprint: (row['game_fingerprint'] as string | null) ?? null,
      appVersion: String(row['app_version']),
      createdAtMs: Number(row['created_at_ms']),
    }
  }
}
