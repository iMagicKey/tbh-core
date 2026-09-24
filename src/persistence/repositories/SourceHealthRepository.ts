// SourceHealthRepository — meaningful source-health transitions only.
//
// A transition is persisted when state or reason_code CHANGES relative to the
// last stored event for that source_kind; consecutive identical snapshots are
// suppressed (no per-poll spam). Details are sanitized (user profile path
// masked) and never contain secrets.

import os from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { SaveSourceStatus } from '../../shared/save-source'

export type SourceKind = 'save' | 'memory' | 'player_log'

export interface HealthTransitionInput {
  state: string
  reasonCode: string
  detail?: string | null
  lastSuccessAtMs?: number | null
}

/** Mask the user's profile path so stored details don't embed private paths. */
export function sanitizeDetail(detail: string | null | undefined): string | null {
  if (!detail) return null
  const profile = process.env['USERPROFILE'] ?? os.homedir()
  if (profile && profile.length > 2) {
    return detail.split(profile).join('<profile>')
  }
  return detail
}

export class SourceHealthRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Record a transition unless it repeats the last stored state+reason for the
   * source. Returns whether an event was actually written.
   */
  recordTransition(sourceKind: SourceKind, input: HealthTransitionInput, recordedAtMs: number): boolean {
    const last = this.db
      .prepare(
        'SELECT state, reason_code FROM source_health_events WHERE source_kind = ? ORDER BY id DESC LIMIT 1',
      )
      .get(sourceKind) as { state: string; reason_code: string } | undefined
    if (last && last.state === input.state && last.reason_code === input.reasonCode) {
      return false
    }
    this.db
      .prepare(
        `INSERT INTO source_health_events
          (source_kind, recorded_at_ms, state, reason_code, detail, last_success_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceKind,
        recordedAtMs,
        input.state,
        input.reasonCode,
        sanitizeDetail(input.detail),
        input.lastSuccessAtMs ?? null,
      )
    return true
  }

  /** Adapter from the live save-source status snapshot. */
  recordSaveSourceTransition(status: SaveSourceStatus, recordedAtMs: number): boolean {
    return this.recordTransition(
      'save',
      {
        state: status.state,
        reasonCode: status.reasonCode,
        detail: status.detail,
        lastSuccessAtMs: status.lastSuccessfulReadAt,
      },
      recordedAtMs,
    )
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM source_health_events').get() as { c: number }
    return Number(row.c)
  }
}
