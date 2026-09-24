export type DataSource = 'memory' | 'save' | 'player-log' | 'derived' | 'estimated'
export type Confidence = 'exact' | 'verified' | 'checkpoint' | 'derived' | 'estimated' | 'conflict' | 'unavailable'

export interface Observation<T> {
  metric: string
  value: T
  source: DataSource
  confidence: Confidence
  timestamp: number
}

export type RunOutcome = 'clear' | 'fail' | 'abandon' | 'restart'

export interface CompletedRun {
  id: string
  stage: number
  difficulty: string
  startedAt: number
  endedAt: number
  durationMs: number
  outcome: RunOutcome
  xpGain: number
  goldGain: number
  damage?: number
  avgDps?: number
  mobs?: number
  buildFingerprint?: string
}
