// Serializable memory-source contracts shared between main and renderer.
// Never contains pointers, raw memory, helper paths, or secrets.

import type { MemoryReasonCode, MemoryStateName } from '../sources/memory/types'

export type { MemoryReasonCode, MemoryStateName }

export interface MemoryStatusDto {
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

export interface MemoryLiveHeroDto {
  heroKey: number
  slot: number | null
  level: number | null
  xpSoFar: number | null
}

export interface MemoryLiveDto {
  observedAtMs: number
  gameVersion: string | null
  gameFingerprint: string | null
  stageKey: number | null
  difficulty: number | null
  run: {
    startedAtMs: number | null
    elapsedMs: number | null
    xpSoFar: number | null
    goldSoFar: number | null
    damage: number | null
    dps: number | null
    mobsKilled: number | null
    mobsTotal: number | null
  }
  heroes: MemoryLiveHeroDto[]
}
