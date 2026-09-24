// BuildRepository — canonical build identity storage.
//
// The fingerprint CALCULATION arrives in a later phase (Phase A contract:
// hero level is CONTEXT, not identity). Stored canonical_json is versioned
// inside the payload itself ({ version: N, ... }) and preserved byte-exact.

import type { DatabaseSync } from 'node:sqlite'

export interface BuildRecord {
  id: string
  fingerprintVersion: number
  canonicalJson: string
  createdAtMs: number
  friendlyLabel: string | null
}

export class BuildRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert if new; no-op when the id already exists (identity is the id). */
  insertBuild(input: Omit<BuildRecord, 'friendlyLabel'> & { friendlyLabel?: string | null }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO builds (id, fingerprint_version, canonical_json, created_at_ms, friendly_label)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        input.id,
        input.fingerprintVersion,
        input.canonicalJson,
        input.createdAtMs,
        input.friendlyLabel ?? null,
      )
    return Number(result.changes) > 0
  }

  getBuild(id: string): BuildRecord | null {
    const row = this.db
      .prepare('SELECT * FROM builds WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row['id']),
      fingerprintVersion: Number(row['fingerprint_version']),
      canonicalJson: String(row['canonical_json']), // exact bytes preserved
      createdAtMs: Number(row['created_at_ms']),
      friendlyLabel: (row['friendly_label'] as string | null) ?? null,
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM builds').get() as { c: number }
    return Number(row.c)
  }
}
