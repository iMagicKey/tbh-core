import { describe, expect, it } from 'vitest'
import { toRunInput } from '../adapter'
import type { CompletedRunEvent } from '../types'

const run: CompletedRunEvent = {
  id: '1790000000000',
  stageKey: 2205,
  difficulty: 1,
  startedAtMs: 1_790_000_000_000,
  endedAtMs: 1_790_000_020_000,
  durationMs: 20_000,
  officialClearTimeMs: 21_000,
  outcome: 'success',
  captureQuality: 'complete',
  xpValue: 100_000.5,
  xpSource: 'live',
  xpConfidence: 'measured',
  goldValue: 49_318,
  goldSource: 'live',
  goldConfidence: 'measured',
  damage: 1_000_000,
  averageDps: 50_000,
  mobsKilled: 92,
  mobsTotal: 93,
  gameVersion: '1.2.8',
  gameFingerprint: '1.2.8-0x6ab23e8a-0x6b47000',
  readerVersion: '1.0.0',
  profileId: 'tbh-1.2.8-a',
  sourceHealthEpoch: 'memory:fp:1',
  reconciliationStatus: null,
  sessionId: null,
  buildId: null,
  heroes: [
    { heroKey: 201, slot: 2, levelStart: 37, levelEnd: 37, xpGained: 40_000 },
    { heroKey: 301, slot: null, levelStart: 37, levelEnd: 38, xpGained: 60_000.5 },
  ],
}

describe('toRunInput', () => {
  it('maps all fields with reader/profile provenance and honest nulls', () => {
    const input = toRunInput(run, 1_790_000_020_100)
    expect(input.id).toBe(run.id)
    expect(input.stageKey).toBe(2205)
    expect(input.outcome).toBe('success')
    expect(input.captureQuality).toBe('complete')
    expect(input.xpConfidence).toBe('measured')
    expect(input.goldConfidence).toBe('measured')
    expect(input.readerVersion).toBe('1.0.0')
    expect(input.memoryProfileId).toBe('tbh-1.2.8-a')
    expect(input.gameFingerprint).toBe('1.2.8-0x6ab23e8a-0x6b47000')
    expect(input.sourceHealthEpoch).toBe('memory:fp:1')
    expect(input.reconciliationStatus).toBeNull() // Phase E — never pretend
    expect(input.sessionId).toBeNull()
    expect(input.buildId).toBeNull()
    expect(input.heroes[1].slot).toBeNull()
  })

  it('unavailable metrics stay null (never zeroed)', () => {
    const degraded: CompletedRunEvent = {
      ...run,
      xpValue: null, xpSource: null, xpConfidence: null,
      goldValue: null, goldSource: null, goldConfidence: null,
      captureQuality: 'partial',
    }
    const input = toRunInput(degraded, 0)
    expect(input.xpValue).toBeNull()
    expect(input.goldValue).toBeNull()
    expect(input.captureQuality).toBe('partial')
  })

  it('partial/abandoned/fail outcomes map through', () => {
    for (const outcome of ['fail', 'abandoned'] as const) {
      const input = toRunInput({ ...run, outcome, officialClearTimeMs: null }, 0)
      expect(input.outcome).toBe(outcome)
      expect(input.officialClearTimeMs).toBeNull()
    }
  })
})
