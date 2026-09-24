import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { CheckpointRepository, computeCheckpointKey } from '../repositories/CheckpointRepository'
import { runMigrations } from '../migrations'
import { makeCheckpoint, migratedMemoryDb, tempDbPath } from './helpers'

describe('CheckpointRepository', () => {
  it('inserts a new checkpoint exactly once', () => {
    const repo = new CheckpointRepository(migratedMemoryDb())
    const checkpoint = makeCheckpoint()
    expect(repo.insertCheckpoint(checkpoint, 1_000)).toEqual({ inserted: true })
    expect(repo.count()).toBe(1)
    expect(repo.getLastPersistedAt()).toBe(1_000)
  })

  it('deduplicates the same logical checkpoint (immediate repeat and simulated restart)', () => {
    // simulated restart: a NEW database connection to the SAME file
    const dbPath = tempDbPath()
    const first = new DatabaseSync(dbPath)
    runMigrations(first)
    const repoA = new CheckpointRepository(first)
    const checkpoint = makeCheckpoint()

    expect(repoA.insertCheckpoint(checkpoint, 1_000)).toEqual({ inserted: true })
    expect(repoA.insertCheckpoint(checkpoint, 2_000)).toEqual({ inserted: false }) // same session repeat
    first.close()

    const second = new DatabaseSync(dbPath)
    const repoB = new CheckpointRepository(second)
    expect(repoB.insertCheckpoint(checkpoint, 3_000)).toEqual({ inserted: false }) // after restart
    expect(repoB.count()).toBe(1) // still exactly one row
    expect(repoB.hasCheckpoint(checkpoint)).toBe(true)
    second.close()
  })

  it('treats genuinely different source state as a different checkpoint', () => {
    const repo = new CheckpointRepository(migratedMemoryDb())
    const a = makeCheckpoint()
    const b = makeCheckpoint({ observedAtMs: a.observedAtMs + 90_000, playTimeSeconds: 66_400 })
    expect(computeCheckpointKey(a)).not.toBe(computeCheckpointKey(b))
    expect(repo.insertCheckpoint(a, 1_000)).toEqual({ inserted: true })
    expect(repo.insertCheckpoint(b, 2_000)).toEqual({ inserted: true })
    expect(repo.count()).toBe(2)
  })

  it('excludes machine-local timing from the identity (same save observed later)', () => {
    const a = makeCheckpoint()
    const reobserved = makeCheckpoint({
      // mtime/polled moved (new file write of identical content? hypothetical) — identity
      // must depend only on SOURCE state
      fileMtimeMs: a.fileMtimeMs + 5_000,
      polledAtMs: a.polledAtMs + 120_000,
    })
    expect(computeCheckpointKey(a)).toBe(computeCheckpointKey(reobserved))
  })

  it('JSON snapshots are versioned and round-trip with nulls intact', () => {
    const db = migratedMemoryDb()
    const repo = new CheckpointRepository(db)
    const checkpoint = makeCheckpoint() // includes null-slot box entry + null hero fields
    repo.insertCheckpoint(checkpoint, 1_000)

    const row = db
      .prepare('SELECT * FROM save_checkpoints')
      .get() as Record<string, unknown>
    const party = JSON.parse(String(row['arranged_party_json']))
    expect(party.version).toBe(1)
    expect(party.heroKeys).toEqual([401, 301, 201])
    expect(party.petKey).toBeNull()

    const heroSnapshot = JSON.parse(String(row['hero_checkpoint_json']))
    expect(heroSnapshot.version).toBe(1)
    expect(heroSnapshot.heroes[0].equippedItemIds).toEqual(['9007199254740993', '18446744073709551615'])
    expect(heroSnapshot.heroes[1].withinLevelXp).toBeNull()

    const buildContext = JSON.parse(String(row['build_context_json']))
    expect(buildContext.version).toBe(1)
    expect(buildContext.heroLevels['201']).toEqual({ start: 37, end: 37 })

    const boxSummary = JSON.parse(String(row['box_summary_json']))
    expect(boxSummary.version).toBe(1)
    expect(boxSummary.entries[1]).toEqual({ type: null, uniqueId: null, quantity: null })
    expect(boxSummary.totalsByType).toEqual({ '1': 2 })

    // nullable columns survive the round trip as SQL NULL
    expect(row['current_stage_wave']).toBe(3)
  })

  it('stores no checkpoints when boxes are absent (box_summary_json NULL)', () => {
    const db = migratedMemoryDb()
    const repo = new CheckpointRepository(db)
    repo.insertCheckpoint(makeCheckpoint({ boxes: null }), 1_000)
    const row = db.prepare('SELECT box_summary_json FROM save_checkpoints').get() as Record<string, unknown>
    expect(row['box_summary_json']).toBeNull()
  })
})
