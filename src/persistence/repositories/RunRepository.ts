// RunRepository — query-friendly completed-run persistence (Phase A contracts).
//
// Mostly unused until MemorySource lands. Insertion is transactional with the
// per-hero child rows. Duplicate run id semantics (documented behavior):
//   * same id + logically identical payload → no-op ({ inserted: false });
//   * same id + different payload → typed RunConflictError (never a silent
//     overwrite, never duplicate child rows).
//
// Canonicalization invariants:
//   * hero slot: ONE representation everywhere (hash, insert, stored rows,
//     record rebuild) — canonicalSlot(slot) = slot ?? -1;
//   * heroKey is REQUIRED (SQL: INTEGER NOT NULL): a hero row without identity
//     is not persisted — capture-quality diagnostics represent the miss instead.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface RunHeroInput {
  /** Hero identity is required — unknown heroes are simply not persisted. */
  heroKey: number
  levelStart: number | null
  levelEnd: number | null
  xpGained: number | null
  /** Formation slot; null canonicalizes to the -1 sentinel. */
  slot: number | null
}

export interface RunHeroRecord {
  heroKey: number
  levelStart: number | null
  levelEnd: number | null
  xpGained: number | null
  /** Canonical slot (-1 when the input slot was null). */
  slot: number
}

export interface RunInput {
  id: string
  sessionId: string | null
  buildId: string | null
  stageKey: number
  difficulty: number | null
  startedAtMs: number
  endedAtMs: number
  durationMs: number
  officialClearTimeMs: number | null
  outcome: string
  captureQuality: string
  xpValue: number | null
  xpSource: string | null
  xpConfidence: string | null
  goldValue: number | null
  goldSource: string | null
  goldConfidence: string | null
  damage: number | null
  averageDps: number | null
  mobsKilled: number | null
  mobsTotal: number | null
  gameVersion: string | null
  gameFingerprint: string | null
  sourceHealthEpoch: string | null
  reconciliationStatus: string | null
  heroes: RunHeroInput[]
  createdAtMs: number
}

export interface RunRecord extends Omit<RunInput, 'heroes'> {
  heroes: RunHeroRecord[]
}

export class RunConflictError extends Error {
  constructor(
    public readonly runId: string,
  ) {
    super(`run id '${runId}' already exists with different content`)
    this.name = 'RunConflictError'
  }
}

/** The single canonical hero-slot representation used across persistence identity. */
export function canonicalSlot(slot: number | null): number {
  return slot ?? -1
}

/**
 * Canonical content hash of a run payload (id + all queryable fields + heroes,
 * canonicalized). Two logically identical payloads hash equally — the basis of the
 * duplicate no-op; any difference conflicts.
 */
export function computeRunContentHash(input: RunInput): string {
  const parts = [
    input.id,
    input.sessionId ?? '',
    input.buildId ?? '',
    String(input.stageKey),
    String(input.difficulty ?? ''),
    String(input.startedAtMs),
    String(input.endedAtMs),
    String(input.durationMs),
    String(input.officialClearTimeMs ?? ''),
    input.outcome,
    input.captureQuality,
    String(input.xpValue ?? ''),
    input.xpSource ?? '',
    input.xpConfidence ?? '',
    String(input.goldValue ?? ''),
    input.goldSource ?? '',
    input.goldConfidence ?? '',
    String(input.damage ?? ''),
    String(input.averageDps ?? ''),
    String(input.mobsKilled ?? ''),
    String(input.mobsTotal ?? ''),
    input.gameVersion ?? '',
    input.gameFingerprint ?? '',
    input.sourceHealthEpoch ?? '',
    input.reconciliationStatus ?? '',
    ...[...input.heroes]
      .sort((a, b) => a.heroKey - b.heroKey || canonicalSlot(a.slot) - canonicalSlot(b.slot))
      .map(
        (hero) =>
          `${hero.heroKey}:${hero.levelStart ?? ''}:${hero.levelEnd ?? ''}:${hero.xpGained ?? ''}:${canonicalSlot(hero.slot)}`,
      ),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Insert a run with its hero rows in ONE transaction.
   * Identical duplicate id → no-op; conflicting duplicate id → RunConflictError.
   */
  insertRun(input: RunInput): { inserted: boolean } {
    const existing = this.getRun(input.id)
    if (existing) {
      if (computeRunContentHash(input) === computeRunContentHash(this.recordToInput(existing))) {
        return { inserted: false }
      }
      throw new RunConflictError(input.id)
    }

    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT INTO runs (
            id, session_id, build_id, stage_key, difficulty, started_at_ms, ended_at_ms,
            duration_ms, official_clear_time_ms, outcome, capture_quality,
            xp_value, xp_source, xp_confidence, gold_value, gold_source, gold_confidence,
            damage, average_dps, mobs_killed, mobs_total, game_version, game_fingerprint,
            source_health_epoch, reconciliation_status, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          input.buildId,
          input.stageKey,
          input.difficulty,
          input.startedAtMs,
          input.endedAtMs,
          input.durationMs,
          input.officialClearTimeMs,
          input.outcome,
          input.captureQuality,
          input.xpValue,
          input.xpSource,
          input.xpConfidence,
          input.goldValue,
          input.goldSource,
          input.goldConfidence,
          input.damage,
          input.averageDps,
          input.mobsKilled,
          input.mobsTotal,
          input.gameVersion,
          input.gameFingerprint,
          input.sourceHealthEpoch,
          input.reconciliationStatus,
          input.createdAtMs,
        )
      const insertHero = this.db.prepare(
        `INSERT INTO run_heroes (run_id, hero_key, level_start, level_end, xp_gained, slot)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const hero of input.heroes) {
        insertHero.run(
          input.id,
          hero.heroKey,
          hero.levelStart,
          hero.levelEnd,
          hero.xpGained,
          canonicalSlot(hero.slot),
        )
      }
      this.db.exec('COMMIT')
      return { inserted: true }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // connection already rolled back
      }
      throw error
    }
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const heroes = (
      this.db
        .prepare('SELECT * FROM run_heroes WHERE run_id = ? ORDER BY hero_key, slot')
        .all(id) as Array<Record<string, unknown>>
    ).map(this.rowToHero)
    return { ...this.rowToRun(row), heroes }
  }

  /** Recent runs, most recent first — FULL records with hydrated hero rows. */
  listRecentRuns(limit: number): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY ended_at_ms DESC, id DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>
    return this.hydrate(rows)
  }

  /** Runs of a stage, most recent first — FULL records with hydrated hero rows. */
  listRunsByStage(stageKey: number, limit = 100): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE stage_key = ? ORDER BY ended_at_ms DESC, id DESC LIMIT ?')
      .all(stageKey, limit) as Array<Record<string, unknown>>
    return this.hydrate(rows)
  }

  /** Runs of a session, most recent first — FULL records with hydrated hero rows. */
  listRunsBySession(sessionId: string, limit = 100): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY ended_at_ms DESC, id DESC LIMIT ?')
      .all(sessionId, limit) as Array<Record<string, unknown>>
    return this.hydrate(rows)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }
    return Number(row.c)
  }

  /** Hydrate hero rows for a batch of run rows in ONE additional query (no N+1). */
  private hydrate(rows: Array<Record<string, unknown>>): RunRecord[] {
    if (rows.length === 0) return []
    const ids = rows.map((row) => String(row['id']))
    const placeholders = ids.map(() => '?').join(', ')
    const heroRows = this.db
      .prepare(`SELECT * FROM run_heroes WHERE run_id IN (${placeholders}) ORDER BY run_id, hero_key, slot`)
      .all(...ids) as Array<Record<string, unknown>>
    const heroesByRun = new Map<string, RunHeroRecord[]>()
    for (const heroRow of heroRows) {
      const runId = String(heroRow['run_id'])
      const list = heroesByRun.get(runId) ?? []
      list.push(this.rowToHero(heroRow))
      heroesByRun.set(runId, list)
    }
    return rows.map((row) => ({
      ...this.rowToRun(row),
      heroes: heroesByRun.get(String(row['id'])) ?? [],
    }))
  }

  private rowToHero(row: Record<string, unknown>): RunHeroRecord {
    return {
      heroKey: Number(row['hero_key']),
      levelStart: row['level_start'] === null ? null : Number(row['level_start']),
      levelEnd: row['level_end'] === null ? null : Number(row['level_end']),
      xpGained: row['xp_gained'] === null ? null : Number(row['xp_gained']),
      slot: Number(row['slot']), // already canonical (-1 sentinel) in storage
    }
  }

  private rowToRun(row: Record<string, unknown>): Omit<RunRecord, 'heroes'> {
    return {
      id: String(row['id']),
      sessionId: (row['session_id'] as string | null) ?? null,
      buildId: (row['build_id'] as string | null) ?? null,
      stageKey: Number(row['stage_key']),
      difficulty: row['difficulty'] === null ? null : Number(row['difficulty']),
      startedAtMs: Number(row['started_at_ms']),
      endedAtMs: Number(row['ended_at_ms']),
      durationMs: Number(row['duration_ms']),
      officialClearTimeMs: row['official_clear_time_ms'] === null ? null : Number(row['official_clear_time_ms']),
      outcome: String(row['outcome']),
      captureQuality: String(row['capture_quality']),
      xpValue: row['xp_value'] === null ? null : Number(row['xp_value']),
      xpSource: (row['xp_source'] as string | null) ?? null,
      xpConfidence: (row['xp_confidence'] as string | null) ?? null,
      goldValue: row['gold_value'] === null ? null : Number(row['gold_value']),
      goldSource: (row['gold_source'] as string | null) ?? null,
      goldConfidence: (row['gold_confidence'] as string | null) ?? null,
      damage: row['damage'] === null ? null : Number(row['damage']),
      averageDps: row['average_dps'] === null ? null : Number(row['average_dps']),
      mobsKilled: row['mobs_killed'] === null ? null : Number(row['mobs_killed']),
      mobsTotal: row['mobs_total'] === null ? null : Number(row['mobs_total']),
      gameVersion: (row['game_version'] as string | null) ?? null,
      gameFingerprint: (row['game_fingerprint'] as string | null) ?? null,
      sourceHealthEpoch: (row['source_health_epoch'] as string | null) ?? null,
      reconciliationStatus: (row['reconciliation_status'] as string | null) ?? null,
      createdAtMs: Number(row['created_at_ms']),
    }
  }

  private recordToInput(record: RunRecord): RunInput {
    return { ...record, createdAtMs: record.createdAtMs }
  }
}
