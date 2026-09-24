// MemorySource-facing types (main side). Serializable renderer DTOs live in
// src/shared/memory-source.ts.

import type { HelperLive, HelperRun, HelperRunRejected } from './protocol'

export type MemoryStateName =
  | 'disconnected'
  | 'detecting'
  | 'healthy'
  | 'degraded'
  | 'unsupported_game_version'
  | 'calibration_failed'

export type MemoryReasonCode =
  | 'OK'
  | 'STOPPED'
  | 'GAME_NOT_RUNNING'
  | 'PROCESS_OPEN_FAILED'
  | 'GAME_VERSION_UNREADABLE'
  | 'UNSUPPORTED_FINGERPRINT'
  | 'GAME_ASSEMBLY_NOT_FOUND'
  | 'PROFILE_LOAD_FAILED'
  | 'CLASS_RESOLUTION_FAILED'
  | 'LOG_LIST_UNREADABLE'
  | 'GOLD_VALIDATION_FAILED'
  | 'XP_VALIDATION_FAILED'
  | 'STAGE_UNAVAILABLE'
  | 'DEAD_READ_WATCHDOG'
  | 'HELPER_MISSING'
  | 'HELPER_CRASHED'
  | 'HELPER_PROTOCOL_MISMATCH'
  | 'HELPER_OUTPUT_INVALID'

export interface MemorySourceStatus {
  state: MemoryStateName
  reasonCode: MemoryReasonCode
  detail: string | null
  gameVersion: string | null
  gameFingerprint: string | null
  profileId: string | null
  readerVersion: string | null
  healthEpoch: string | null
  lastMessageAt: number | null
  lastRejectedRunReason: { code: string; detail: string | null } | null
}

export type LiveSnapshot = HelperLive
export type CompletedRunEvent = HelperRun
export type RunRejectedEvent = HelperRunRejected
