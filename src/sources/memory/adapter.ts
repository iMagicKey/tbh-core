// adapter.ts — helper run events -> persistence RunInput (+ provenance).

import type { RunInput } from '../../persistence/repositories/RunRepository'
import type { CompletedRunEvent } from './types'

export function toRunInput(run: CompletedRunEvent, createdAtMs: number): RunInput {
  return {
    id: run.id,
    sessionId: null,
    buildId: null,
    stageKey: run.stageKey,
    difficulty: run.difficulty,
    startedAtMs: run.startedAtMs,
    endedAtMs: run.endedAtMs,
    durationMs: run.durationMs,
    officialClearTimeMs: run.officialClearTimeMs,
    outcome: run.outcome,
    captureQuality: run.captureQuality,
    xpValue: run.xpValue,
    xpSource: run.xpSource,
    xpConfidence: run.xpConfidence,
    goldValue: run.goldValue,
    goldSource: run.goldSource,
    goldConfidence: run.goldConfidence,
    damage: run.damage,
    averageDps: run.averageDps,
    mobsKilled: run.mobsKilled,
    mobsTotal: run.mobsTotal,
    gameVersion: run.gameVersion,
    gameFingerprint: run.gameFingerprint,
    sourceHealthEpoch: run.sourceHealthEpoch,
    reconciliationStatus: null, // reconciliation is Phase E — never pretend it ran
    heroes: run.heroes.map((hero) => ({
      heroKey: hero.heroKey,
      levelStart: hero.levelStart,
      levelEnd: hero.levelEnd,
      xpGained: hero.xpGained,
      slot: hero.slot,
    })),
    createdAtMs,
    readerVersion: run.readerVersion,
    memoryProfileId: run.profileId,
  }
}
