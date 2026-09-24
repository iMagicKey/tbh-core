// Serializable contracts for the Save checkpoint source, shared between main and renderer.
// These types cross IPC; they must never contain secrets (no ES3 password, ever).

/** Lifecycle state of the save source. */
export type SaveSourceStateName =
  | 'discovering'
  | 'healthy'
  | 'stale'
  | 'degraded'
  | 'error'
  | 'disconnected'

/**
 * Machine-readable reason codes. UI localization maps these to human strings;
 * parser logic never embeds user-facing English.
 */
export type SaveReasonCode =
  | 'SAVE_NOT_FOUND'
  | 'SAVE_FOUND'
  | 'SAVE_UNREADABLE'
  | 'GAME_INSTALL_NOT_FOUND'
  | 'PASSWORD_NOT_FOUND'
  | 'PASSWORD_INVALID'
  | 'GAME_ASSET_UNREADABLE'
  | 'DECRYPT_FAILED'
  | 'MID_WRITE'
  | 'PARSE_FAILED'
  | 'STALE_CHECKPOINT'
  | 'STOPPED'
  /** Final safety net for genuinely unexpected failures — never a replacement for typed codes. */
  | 'SOURCE_INTERNAL_ERROR'

/** How the current ES3 password was obtained (the value itself never leaves main). */
export type PasswordProvenance = 'manual' | 'game_asset' | 'none'

export interface SaveSourceStatus {
  state: SaveSourceStateName
  reasonCode: SaveReasonCode
  /** Sanitized technical detail (no secrets, no password). */
  detail: string | null
  savePath: string | null
  gameInstallPath: string | null
  passwordProvenance: PasswordProvenance
  lastAttemptAt: number | null
  lastSuccessfulReadAt: number | null
  lastError: { code: SaveReasonCode; detail: string | null } | null
}

/** Compact, renderer-facing summary of the latest good checkpoint. */
export interface SaveSummaryDto {
  state: SaveSourceStateName
  reasonCode: SaveReasonCode
  detail: string | null
  savePath: string | null
  saveVersion: string | null
  lastCheckpointAt: number | null
  currentStageKey: number | null
  currentStageWave: number | null
  walletGold: number | null
  combatGoldEarned: number | null
  playTimeSeconds: number | null
  heroCount: number | null
  passwordProvenance: PasswordProvenance
}
