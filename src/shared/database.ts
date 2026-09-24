// Serializable database diagnostics contracts shared between main and renderer.
// Never contains SQL, raw rows, or file contents — counts and status only.

export type DatabaseStateName =
  | 'uninitialized'
  | 'opening'
  | 'healthy'
  | 'degraded'
  | 'error'
  | 'closed'

export interface DatabaseStatusDto {
  state: DatabaseStateName
  schemaVersion: number | null
  /** Database file basename (never a full user path). */
  databaseFilename: string | null
  lastWriteAt: number | null
  lastErrorCode: string | null
  lastErrorDetail: string | null
}

export interface DatabaseStatsDto {
  checkpointCount: number
  healthEventCount: number
  runCount: number
  sessionCount: number
  buildCount: number
}
