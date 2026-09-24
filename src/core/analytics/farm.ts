import type { CompletedRun } from '../../shared/contracts'

export interface FarmSummary {
  runs: number
  successfulRuns: number
  successRate: number
  totalXp: number
  totalGold: number
  activeSeconds: number
  xpPerHour: number
  goldPerHour: number
  runsPerHour: number
}

export function summarizeRuns(runs: CompletedRun[]): FarmSummary {
  const successful = runs.filter((run) => run.outcome === 'clear')
  const activeSeconds = successful.reduce((sum, run) => sum + run.durationMs / 1000, 0)
  const totalXp = successful.reduce((sum, run) => sum + run.xpGain, 0)
  const totalGold = successful.reduce((sum, run) => sum + run.goldGain, 0)
  const hours = activeSeconds / 3600

  return {
    runs: runs.length,
    successfulRuns: successful.length,
    successRate: runs.length === 0 ? 0 : successful.length / runs.length,
    totalXp,
    totalGold,
    activeSeconds,
    xpPerHour: hours === 0 ? 0 : totalXp / hours,
    goldPerHour: hours === 0 ? 0 : totalGold / hours,
    runsPerHour: hours === 0 ? 0 : successful.length / hours,
  }
}
