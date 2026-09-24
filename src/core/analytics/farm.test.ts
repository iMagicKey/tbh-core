import { describe, expect, it } from 'vitest'
import { summarizeRuns } from './farm'
import type { CompletedRun } from '../../shared/contracts'

const run = (overrides: Partial<CompletedRun>): CompletedRun => ({
  id: crypto.randomUUID(),
  stage: 100,
  difficulty: 'normal',
  startedAt: 0,
  endedAt: 30_000,
  durationMs: 30_000,
  outcome: 'clear',
  xpGain: 100,
  goldGain: 50,
  ...overrides,
})

describe('summarizeRuns', () => {
  it('uses total rewards divided by total active time rather than averaging per-run rates', () => {
    const summary = summarizeRuns([
      run({ durationMs: 30_000, xpGain: 100, goldGain: 50 }),
      run({ durationMs: 90_000, xpGain: 100, goldGain: 150 }),
    ])

    expect(summary.xpPerHour).toBeCloseTo(6000)
    expect(summary.goldPerHour).toBeCloseTo(6000)
    expect(summary.runsPerHour).toBeCloseTo(60)
  })

  it('excludes failed runs from farming rewards but keeps them in success rate', () => {
    const summary = summarizeRuns([
      run({ outcome: 'clear' }),
      run({ outcome: 'fail', xpGain: 999, goldGain: 999 }),
    ])

    expect(summary.successfulRuns).toBe(1)
    expect(summary.successRate).toBe(0.5)
    expect(summary.totalXp).toBe(100)
    expect(summary.totalGold).toBe(50)
  })
})
