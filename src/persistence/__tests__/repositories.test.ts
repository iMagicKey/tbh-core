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
  canonicalSlot,
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

  it('duplicate with null hero slot is a no-op, NOT a conflict (canonical slot)', () => {
    const repo = new RunRepository(migratedMemoryDb())
    const run = makeRun({
      heroes: [
        { heroKey: 201, levelStart: 37, levelEnd: 37, xpGained: 1_000, slot: null },
        { heroKey: 301, levelStart: 37, levelEnd: 38, xpGained: 2_000, slot: null },
      ],
    })
    expect(repo.insertRun(run)).toEqual({ inserted: true })
    // identical input again — stored rows carry the -1 sentinel, the incoming hash
    // canonicalizes null the same way, so this must dedupe instead of conflicting
    expect(repo.insertRun(makeRun({ heroes: [...run.heroes] }))).toEqual({ inserted: false })
    // and the -1-express form of the same logical payload also dedupes
    expect(
      repo.insertRun(
        makeRun({
          heroes: run.heroes.map((hero) => ({ ...hero, slot: -1 })),
        }),
      ),
    ).toEqual({ inserted: false })
  })

  it('same run id with a genuinely different hero slot conflicts', () => {
    const repo = new RunRepository(migratedMemoryDb())
    const run = makeRun({
      heroes: [{ heroKey: 201, levelStart: 37, levelEnd: 37, xpGained: 1_000, slot: null }],
    })
    repo.insertRun(run)
    const differentSlot = makeRun({
      heroes: [{ heroKey: 201, levelStart: 37, levelEnd: 37, xpGained: 1_000, slot: 2 }],
    })
    expect(() => repo.insertRun(differentSlot)).toThrowError(RunConflictError)
  })

  it('hero rows require identity: heroKey is a required number; canonicalSlot is total', () => {
    // the RunHeroInput type forbids null heroKey; a row without identity is not persisted.
    expect(canonicalSlot(null)).toBe(-1)
    expect(canonicalSlot(2)).toBe(2)
    expect(canonicalSlot(-1)).toBe(-1)
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

  it('queries: by stage, by session, recent order — with HYDRATED hero rows', () => {
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

    const byStage = repo.listRunsByStage(1)
    expect(byStage.map((r) => r.id)).toEqual(['d', 'c', 'a']) // ended DESC
    // RunRecord lists are TRUTHFUL: hero rows are present, not silently empty
    expect(byStage.every((r) => r.heroes.length === 2)).toBe(true)
    expect(byStage[0].heroes.map((h) => h.heroKey).sort()).toEqual([201, 301])

    const bySession = repo.listRunsBySession('s1')
    expect(bySession.map((r) => r.id)).toEqual(['c'])
    expect(bySession[0].heroes).toHaveLength(2)

    const recent = repo.listRecentRuns(3)
    expect(recent.map((r) => r.id)).toEqual(['d', 'b', 'c'])
    expect(recent.every((r) => r.heroes.length === 2)).toBe(true)

    // a run with genuinely zero heroes reports zero (not undefined/hidden)
    repo.insertRun(makeRun({ id: 'e', stageKey: 9, endedAtMs: 500, heroes: [] }))
    expect(repo.listRunsByStage(9)[0].heroes).toEqual([])
  })

  it('null slot is stored via the -1 sentinel and survives the round trip', () => {
    const repo = new RunRepository(migratedMemoryDb())
    repo.insertRun(makeRun({ heroes: [{ heroKey: 201, levelStart: null, levelEnd: null, xpGained: null, slot: null }] }))
    const stored = repo.getRun(makeRun().id)
    expect(stored?.heroes[0]).toEqual({ heroKey: 201, levelStart: null, levelEnd: null, xpGained: null, slot: -1 })
  })
})
