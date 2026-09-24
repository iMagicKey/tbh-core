// Migration 002 — memory-run provenance columns.
//
// Adds reader_version + memory_profile_id to runs so every memory-captured run
// carries the helper reader version and compatibility profile it was read
// under (game fingerprint already existed since 001). History from 001 is never
// rewritten; migration 001 stays untouched.

import type { Migration } from './index'

const SQL = `
ALTER TABLE runs ADD COLUMN reader_version TEXT;
ALTER TABLE runs ADD COLUMN memory_profile_id TEXT;
`

export const migration002: Migration = {
  version: 2,
  name: 'memory-run-provenance',
  up: (exec: (sql: string) => void) => {
    exec(SQL)
  },
}
