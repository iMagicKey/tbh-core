// CheckpointRepository — persistence of normalized SaveCheckpoints.
//
// Identity: a deterministic SHA-256 `checkpoint_key` over canonical stable
// SOURCE-state fields (never poll time, never an autoincrement alone), so a
// restart of TBH Core re-observing the SAME save is a no-op, not a duplicate.
//
// Stored payloads are normalized/versioned JSON snapshots ({version: 1, ...}) —
// never the raw decrypted save, never secrets.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SaveCheckpoint } from '../../sources/save/types'

export interface JsonSnapshotVersion1 {
  version: 1
}

export interface PartySnapshotV1 extends JsonSnapshotVersion1 {
  heroKeys: number[]
  petKey: number | null
}

export interface HeroCheckpointV1 extends JsonSnapshotVersion1 {
  heroes: Array<{
    heroKey: number | null
    level: number | null
    withinLevelXp: number | null
    unlocked: boolean | null
    equippedItemIds: string[]
    equippedSkillKeys: number[]
  }>
}

export interface BuildContextSnapshotV1 extends JsonSnapshotVersion1 {
  heroLevels: Record<string, { start?: number; end?: number }>
}

export interface BoxSummarySnapshotV1 extends JsonSnapshotVersion1 {
  entries: Array<{ type: number | null; uniqueId: string | null; quantity: number | null }>
  totalsByType: Record<string, number>
}

export interface InsertCheckpointResult {
  inserted: boolean
}

/**
 * Deterministic checkpoint identity: SHA-256 over the canonical stable source
 * state. Ingredients: observed time + its source, save version, playTime,
 * stage identity, wallet/cumulative counters, and the arranged-party snapshot
 * (same save moment with a different party is a different logical checkpoint).
 * polledAtMs / fileMtimeMs are deliberately EXCLUDED (machine-local timing).
 */
export function computeCheckpointKey(checkpoint: SaveCheckpoint): string {
  const parts = [
    String(checkpoint.observedAtMs),
    checkpoint.observedTimeSource,
    checkpoint.saveVersion ?? '',
    num(checkpoint.playTimeSeconds),
    num(checkpoint.currentStageKey),
    num(checkpoint.currentStageWave),
    num(checkpoint.maxCompletedStage),
    num(checkpoint.walletGold),
    num(checkpoint.aggregates.combatGoldEarned),
    num(checkpoint.aggregates.stageClears),
    num(checkpoint.aggregates.stageFails),
    JSON.stringify(buildPartySnapshot(checkpoint)),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

function buildPartySnapshot(checkpoint: SaveCheckpoint): PartySnapshotV1 {
  return { version: 1, heroKeys: [...checkpoint.arrangedHeroKeys], petKey: checkpoint.arrangedPetKey }
}

function buildHeroSnapshot(checkpoint: SaveCheckpoint): HeroCheckpointV1 {
  return {
    version: 1,
    heroes: checkpoint.heroes.map((hero) => ({
      heroKey: hero.heroKey,
      level: hero.level,
      withinLevelXp: hero.withinLevelXp,
      unlocked: hero.unlocked,
      equippedItemIds: [...hero.equippedItemIds],
      equippedSkillKeys: [...hero.equippedSkillKeys],
    })),
  }
}

function buildBuildContextSnapshot(checkpoint: SaveCheckpoint): BuildContextSnapshotV1 {
  // hero level CONTEXT for future build epochs (Phase A: level is not build identity)
  const heroLevels: BuildContextSnapshotV1['heroLevels'] = {}
  for (const hero of checkpoint.heroes) {
    if (hero.heroKey !== null && hero.level !== null) {
      heroLevels[String(hero.heroKey)] = { start: hero.level, end: hero.level }
    }
  }
  return { version: 1, heroLevels }
}

function buildBoxSummarySnapshot(checkpoint: SaveCheckpoint): BoxSummarySnapshotV1 | null {
  if (!checkpoint.boxes) return null
  const totalsByType: Record<string, number> = {}
  for (const entry of checkpoint.boxes.entries) {
    if (entry.type !== null && entry.quantity !== null) {
      const key = String(entry.type)
      totalsByType[key] = (totalsByType[key] ?? 0) + entry.quantity
    }
  }
  return { version: 1, entries: checkpoint.boxes.entries.map((e) => ({ ...e })), totalsByType }
}

function jsonString(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value)
}

export class CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert if new; no-op when the checkpoint_key is already known. */
  insertCheckpoint(checkpoint: SaveCheckpoint, persistedAtMs: number): InsertCheckpointResult {
    const key = computeCheckpointKey(checkpoint)
    const result = this.db
      .prepare(
        `INSERT INTO save_checkpoints (
          checkpoint_key, observed_at_ms, observed_time_source, file_mtime_ms, polled_at_ms,
          save_version, play_time_seconds, current_stage_key, current_stage_wave,
          max_completed_stage, wallet_gold, combat_gold_earned, stage_clears, stage_fails,
          arranged_party_json, hero_checkpoint_json, build_context_json, box_summary_json,
          persisted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (checkpoint_key) DO NOTHING`,
      )
      .run(
        key,
        checkpoint.observedAtMs,
        checkpoint.observedTimeSource,
        checkpoint.fileMtimeMs,
        checkpoint.polledAtMs,
        checkpoint.saveVersion,
        checkpoint.playTimeSeconds,
        checkpoint.currentStageKey,
        checkpoint.currentStageWave,
        checkpoint.maxCompletedStage,
        checkpoint.walletGold,
        checkpoint.aggregates.combatGoldEarned,
        checkpoint.aggregates.stageClears,
        checkpoint.aggregates.stageFails,
        jsonString(buildPartySnapshot(checkpoint)),
        jsonString(buildHeroSnapshot(checkpoint)),
        jsonString(buildBuildContextSnapshot(checkpoint)),
        jsonString(buildBoxSummarySnapshot(checkpoint)),
        persistedAtMs,
      )
    return { inserted: Number(result.changes) > 0 }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM save_checkpoints').get() as { c: number }
    return Number(row.c)
  }

  getLastPersistedAt(): number | null {
    const row = this.db
      .prepare('SELECT MAX(persisted_at_ms) AS t FROM save_checkpoints')
      .get() as { t: number | null }
    return row.t === null ? null : Number(row.t)
  }

  /** Whether this exact checkpoint is already persisted (diagnostics/tests). */
  hasCheckpoint(checkpoint: SaveCheckpoint): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM save_checkpoints WHERE checkpoint_key = ?')
      .get(computeCheckpointKey(checkpoint)) as { x: number } | undefined
    return row !== undefined
  }
}
