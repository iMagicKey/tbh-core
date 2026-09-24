import { describe, expect, it } from 'vitest'
import {
  SourceHealthRepository,
  sanitizeDetail,
} from '../repositories/SourceHealthRepository'
import { SessionRepository } from '../repositories/SessionRepository'
import { BuildRepository } from '../repositories/BuildRepository'
import {
  RunConflictError,
  RunRepository,
  type RunInput,
} from '../repositories/RunRepository'
import { migratedMemoryDb } from './helpers'

describe('SourceHealthRepository', () => {
  it('stores transitions and suppresses consecutive identical state+reason', () => {
    const repo = new SourceHealthRepository(migratedMemoryDb())
    expect(repo.recordTransition('save', { state: 'healthy', reasonCode: 'SAVE_FOUND' }, 1_000)).toBe(true)
    expect(repo.recordTransition('save', { state: 'healthy', reasonCode: 'SAVE_FOUND' }, 2_000)).toBe(false) // spam
    expect(repo.recordTransition('save', { state: 'healthy', reasonCode: 'SAVE_FOUND' }, 3_000)).toBe(false)
    expect(repo.recordTransition('save', { state: 'stale', reasonCode: 'STALE_CHECKPOINT' }, 4_000)).toBe(true)
    expect(repo.recordTransition('save', { state: 'stale', reasonCode: 'STALE_CHECKPOINT' }, 5_000)).toBe(false)
    expect(repo.recordTransition('save', { state: 'healthy', reasonCode: 'SAVE_FOUND' }, 6_000)).toBe(true)
    expect(repo.count()).toBe(3)
  })

  it('keeps source kinds independent (future memory/player_log)', () => {
    const repo = new SourceHealthRepository(migratedMemoryDb())
    repo.recordTransition('save', { state: 'healthy', reasonCode: 'SAVE_FOUND' }, 1_000)
    expect(repo.recordTransition('memory', { state: 'healthy', reasonCode: 'X' }, 2_000)).toBe(true)
    expect(repo.count()).toBe(2)
  })

  it('sanitizes filesystem paths in details', () => {
    const profile = process.env['USERPROFILE'] ?? ''
    const sanitized = sanitizeDetail(`save file not found: ${profile}\\AppData\\LocalLow\\x\\y.es3`)
    expect(sanitized).not.toContain(profile)
    expect(sanitized).toContain('<profile>')
    expect(sanitizeDetail(null)).toBeNull()
  })
})

describe('SessionRepository', () => {
  it('creates, reads, closes, and finds open sessions', () => {
    const repo = new SessionRepository(migratedMemoryDb())
    repo.createSession({
      id: 's1',
      startedAtMs: 1_000,
      startReason: 'manual',
      gameVersion: '1.2.8',
      gameFingerprint: null,
      appVersion: '0.0.1',
      createdAtMs: 1_000,
    })
    expect(repo.count()).toBe(1)

    const open = repo.getOpenSession()
    expect(open?.id).toBe('s1')
    expect(open?.endedAtMs).toBeNull()
    expect(open?.gameVersion).toBe('1.2.8')

    expect(repo.closeSession('s1', 90_000, 'user-stop')).toBe(true)
    expect(repo.closeSession('s1', 95_000, 'again')).toBe(false) // already closed
    expect(repo.getOpenSession()).toBeNull()

    const closed = repo.getSession('s1')
    expect(closed?.endedAtMs).toBe(90_000)
    expect(closed?.endReason).toBe('user-stop')
    expect(repo.listSessions(10)).toHaveLength(1)
  })
})

describe('BuildRepository', () => {
  it('inserts once and preserves canonical_json byte-exactly', () => {
    const repo = new BuildRepository(migratedMemoryDb())
    const canonical = JSON.stringify({ version: 1, partyHeroKeys: [201, 301], equipped: {} })
    expect(repo.insertBuild({ id: 'b1', fingerprintVersion: 1, canonicalJson: canonical, createdAtMs: 1_000 })).toBe(true)
    expect(repo.insertBuild({ id: 'b1', fingerprintVersion: 1, canonicalJson: canonical, createdAtMs: 2_000 })).toBe(false)

    const stored = repo.getBuild('b1')
    expect(stored?.canonicalJson).toBe(canonical) // exact bytes
    expect(stored?.friendlyLabel).toBeNull()
    expect(repo.count()).toBe(1)
  })
})

function makeRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    id: '1760000000000',
    sessionId: null,
    buildId: null,
    stageKey: 2205,
    difficulty: 2,
    startedAtMs: 1_760_000_000_000,
    endedAtMs: 1_760_000_020_000,
    durationMs: 20_000,
    officialClearTimeMs: 21_000,
    outcome: 'success',
    captureQuality: 'complete',
    xpValue: 100_000.5,
    xpSource: 'live',
    xpConfidence: 'exact',
    goldValue: 49_318,
    goldSource: 'live',
    goldConfidence: 'exact',
    damage: 1_000_000,
    averageDps: 50_000,
    mobsKilled: 92,
    mobsTotal: 93,
    gameVersion: '1.2.8',
    gameFingerprint: '1.2.8-0x6ab23e8a-0x6b47000',
    sourceHealthEpoch: null,
    reconciliationStatus: 'consistent',
    heroes: [
      { heroKey: 201, levelStart: 37, levelEnd: 37, xpGained: 40_000, slot: 2 },
      { heroKey: 301, levelStart: 37, levelEnd: 38, xpGained: 60_000.5, slot: 1 },
    ],
    createdAtMs: 1_760_000_020_100,
    ...overrides,
  }
}

describe('RunRepository', () => {
  it('inserts a run with hero rows transactionally and reads them back', () => {
    const repo = new RunRepository(migratedMemoryDb())
    expect(repo.insertRun(makeRun())).toEqual({ inserted: true })
    const stored = repo.getRun(makeRun().id)
    expect(stored?.stageKey).toBe(2205)
    expect(stored?.xpValue).toBe(100_000.5)
    expect(stored?.heroes).toHaveLength(2)
    expect(stored?.heroes[1]).toEqual({ heroKey: 301, levelStart: 37, levelEnd: 38, xpGained: 60_000.5, slot: 1 })
  })

  it('identical duplicate id is a no-op; conflicting duplicate id throws', () => {
    const repo = new RunRepository(migratedMemoryDb())
    const run = makeRun()
    repo.insertRun(run)
    expect(repo.insertRun(makeRun())).toEqual({ inserted: false }) // logically identical
    expect(repo.count()).toBe(1)

    const conflicting = makeRun({ goldValue: 999 })
    expect(() => repo.insertRun(conflicting)).toThrowError(RunConflictError)
    expect(repo.count()).toBe(1) // unchanged
  })

  it('hero-order differences do not conflict (canonical hero comparison)', () => {
    const repo = new RunRepository(migratedMemoryDb())
    const run = makeRun()
    repo.insertRun(run)
    const reordered = makeRun({ heroes: [...run.heroes].reverse() })
    expect(repo.insertRun(reordered)).toEqual({ inserted: false })
  })

  it('a failing hero insert rolls back the whole run (atomicity)', () => {
    const repo = new RunRepository(migratedMemoryDb())
    const run = makeRun({
      heroes: [
        { heroKey: 201, levelStart: 1, levelEnd: 1, xpGained: 1, slot: 0 },
        { heroKey: 201, levelStart: 2, levelEnd: 2, xpGained: 2, slot: 0 }, // UNIQUE(run,hero,slot) violation
      ],
    })
    expect(() => repo.insertRun(run)).toThrowError()
    expect(repo.count()).toBe(0) // run row rolled back — no partial data
  })

  it('queries: by stage, by session, recent order', () => {
    const db = migratedMemoryDb()
    const repo = new RunRepository(db)
    // session rows must exist before runs can reference them (FK)
    new SessionRepository(db).createSession({
      id: 's1',
      startedAtMs: 1,
      appVersion: '0.0.1',
      createdAtMs: 1,
    })
    repo.insertRun(makeRun({ id: 'a', stageKey: 1, endedAtMs: 100 }))
    repo.insertRun(makeRun({ id: 'b', stageKey: 2, endedAtMs: 300 }))
    repo.insertRun(makeRun({ id: 'c', stageKey: 1, endedAtMs: 200, sessionId: 's1' }))
    repo.insertRun(makeRun({ id: 'd', stageKey: 1, endedAtMs: 400 }))

    expect(repo.listRunsByStage(1).map((r) => r.id)).toEqual(['d', 'c', 'a']) // ended DESC
    expect(repo.listRunsBySession('s1').map((r) => r.id)).toEqual(['c'])
    expect(repo.listRecentRuns(3).map((r) => r.id)).toEqual(['d', 'b', 'c'])
  })

  it('null slot is stored via the -1 sentinel and survives the round trip', () => {
    const repo = new RunRepository(migratedMemoryDb())
    repo.insertRun(makeRun({ heroes: [{ heroKey: 201, levelStart: null, levelEnd: null, xpGained: null, slot: null }] }))
    const stored = repo.getRun(makeRun().id)
    expect(stored?.heroes[0]).toEqual({ heroKey: 201, levelStart: null, levelEnd: null, xpGained: null, slot: -1 })
  })
})
